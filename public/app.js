/**
 * Scallopbot Web Chat Client
 * Telegram-style interface with markdown support and debug mode
 */

(function() {
  'use strict';

  // DOM Elements
  const messagesContainer = document.getElementById('messages');
  const chatContainer = document.querySelector('.chat-container');
  const chatForm = document.getElementById('chat-form');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const statusIndicator = document.getElementById('status');
  const debugToggle = document.getElementById('debug-mode');
  const creditsToggle = document.getElementById('credits-toggle');
  const creditsPanel = document.getElementById('credits-panel');

  // State
  let ws = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;
  const baseReconnectDelay = 1000;
  let isWaitingForResponse = false;
  let debugMode = false;

  // Configure marked for safe rendering
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false
    });
  }

  /**
   * Get WebSocket URL based on current location
   */
  function getWebSocketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  /**
   * Update connection status indicator
   */
  function setStatus(status) {
    statusIndicator.className = `status ${status}`;
    const statusText = {
      connected: 'online',
      connecting: 'connecting...',
      disconnected: 'offline'
    };
    statusIndicator.textContent = statusText[status] || status;

    const isConnected = status === 'connected';
    messageInput.disabled = !isConnected || isWaitingForResponse;
    sendBtn.disabled = !isConnected || isWaitingForResponse;
  }

  /**
   * Render markdown to HTML safely
   */
  function renderMarkdown(text) {
    if (typeof marked === 'undefined') {
      return escapeHtml(text);
    }
    try {
      return marked.parse(text);
    } catch (e) {
      console.error('Markdown parsing error:', e);
      return escapeHtml(text);
    }
  }

  /**
   * Escape HTML for safe display
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Add a message to the chat
   */
  function addMessage(content, type, isMarkdown = false) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}`;

    if (isMarkdown && (type === 'assistant' || type === 'user')) {
      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      contentDiv.innerHTML = renderMarkdown(content);
      messageEl.appendChild(contentDiv);
    } else {
      messageEl.textContent = content;
    }

    messagesContainer.appendChild(messageEl);
    scrollToBottom();
  }

  /**
   * Add a file download message to the chat
   * @param {string} filePath - Server path to the file
   * @param {string} [caption] - Optional caption
   */
  function addFileMessage(filePath, caption) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';

    const fileContainer = document.createElement('div');
    fileContainer.className = 'file-message';

    const fileName = filePath.split('/').pop() || 'file';

    const iconEl = document.createElement('span');
    iconEl.className = 'file-icon';
    iconEl.textContent = '\uD83D\uDCC4';

    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = fileName;

    const linkEl = document.createElement('a');
    linkEl.className = 'file-download';
    linkEl.href = '/api/files?path=' + encodeURIComponent(filePath);
    linkEl.download = fileName;
    linkEl.textContent = 'Download';
    linkEl.target = '_blank';

    fileContainer.appendChild(iconEl);
    fileContainer.appendChild(nameEl);
    fileContainer.appendChild(linkEl);
    messageEl.appendChild(fileContainer);

    if (caption) {
      const captionEl = document.createElement('div');
      captionEl.className = 'file-caption';
      captionEl.textContent = caption;
      messageEl.appendChild(captionEl);
    }

    messagesContainer.appendChild(messageEl);
    scrollToBottom();
  }

  /**
   * Add a debug message (skill call, internal work)
   * @param {string} label - Label for the debug message
   * @param {string|object} content - Content to display
   * @param {string} type - Type for styling: 'tool-start', 'tool-complete', 'tool-error', 'memory', 'thinking'
   */
  function addDebugMessage(label, content, type = 'default') {
    const messageEl = document.createElement('div');
    messageEl.className = `message debug debug-${type}`;

    const labelEl = document.createElement('div');
    labelEl.className = 'debug-label';
    labelEl.textContent = label;

    const contentEl = document.createElement('div');
    contentEl.className = 'debug-content';
    contentEl.textContent = typeof content === 'object' ? JSON.stringify(content, null, 2) : content;

    messageEl.appendChild(labelEl);
    messageEl.appendChild(contentEl);
    messagesContainer.appendChild(messageEl);

    if (debugMode) {
      scrollToBottom();
    }
  }

  /**
   * Add a memory debug message with expandable items
   * @param {string} action - Memory action (search, collect)
   * @param {string} summary - Summary text
   * @param {Array} items - Memory items to display
   */
  function addMemoryDebugMessage(action, summary, items) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message debug debug-memory';

    const headerEl = document.createElement('div');
    headerEl.className = 'debug-memory-header';

    const labelEl = document.createElement('div');
    labelEl.className = 'debug-label';
    labelEl.textContent = 'memory:' + action;

    const summaryEl = document.createElement('span');
    summaryEl.className = 'debug-memory-summary';
    summaryEl.textContent = summary;

    headerEl.appendChild(labelEl);
    headerEl.appendChild(summaryEl);

    // Add expand button if there are items
    if (items && items.length > 0) {
      const expandBtn = document.createElement('button');
      expandBtn.className = 'debug-expand-btn';
      expandBtn.textContent = '▶';
      expandBtn.title = 'Click to expand';

      const itemsEl = document.createElement('div');
      itemsEl.className = 'debug-memory-items collapsed';

      for (const item of items) {
        const itemEl = document.createElement('div');
        itemEl.className = `debug-memory-item debug-memory-item-${item.type}`;

        const typeTag = document.createElement('span');
        typeTag.className = 'debug-memory-type';
        typeTag.textContent = item.type;

        const contentEl = document.createElement('span');
        contentEl.className = 'debug-memory-content';
        contentEl.textContent = item.subject ? `[${item.subject}] ${item.content}` : item.content;

        itemEl.appendChild(typeTag);
        itemEl.appendChild(contentEl);
        itemsEl.appendChild(itemEl);
      }

      expandBtn.addEventListener('click', function() {
        const isCollapsed = itemsEl.classList.contains('collapsed');
        if (isCollapsed) {
          itemsEl.classList.remove('collapsed');
          expandBtn.textContent = '▼';
          expandBtn.title = 'Click to collapse';
        } else {
          itemsEl.classList.add('collapsed');
          expandBtn.textContent = '▶';
          expandBtn.title = 'Click to expand';
        }
        if (debugMode) {
          scrollToBottom();
        }
      });

      headerEl.appendChild(expandBtn);
      messageEl.appendChild(headerEl);
      messageEl.appendChild(itemsEl);
    } else {
      messageEl.appendChild(headerEl);
    }

    messagesContainer.appendChild(messageEl);

    if (debugMode) {
      scrollToBottom();
    }
  }

  /**
   * Show typing indicator
   */
  function showTypingIndicator() {
    const existingIndicator = document.querySelector('.typing-indicator');
    if (existingIndicator) return;

    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.innerHTML = '<span></span><span></span><span></span>';
    messagesContainer.appendChild(indicator);
    scrollToBottom();
  }

  /**
   * Hide typing indicator
   */
  function hideTypingIndicator() {
    const indicator = document.querySelector('.typing-indicator');
    if (indicator) {
      indicator.remove();
    }
  }

  /**
   * Scroll to bottom of messages
   */
  function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  /**
   * Toggle debug mode
   */
  function toggleDebugMode(enabled) {
    debugMode = enabled;
    if (enabled) {
      messagesContainer.classList.add('debug-enabled');
    } else {
      messagesContainer.classList.remove('debug-enabled');
    }
    scrollToBottom();
  }

  /**
   * Connect to WebSocket server
   */
  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      return;
    }

    setStatus('connecting');

    try {
      ws = new WebSocket(getWebSocketUrl());

      ws.onopen = function() {
        reconnectAttempts = 0;
        setStatus('connected');
        addMessage('Connected to Scallopbot', 'system');
      };

      ws.onmessage = function(event) {
        try {
          const data = JSON.parse(event.data);
          handleMessage(data);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };

      ws.onclose = function(event) {
        ws = null;
        setStatus('disconnected');
        hideTypingIndicator();
        isWaitingForResponse = false;

        // Auto-reconnect with exponential backoff
        if (reconnectAttempts < maxReconnectAttempts) {
          const delay = Math.min(baseReconnectDelay * Math.pow(2, reconnectAttempts), 30000);
          reconnectAttempts++;
          addMessage(`Reconnecting in ${Math.round(delay / 1000)}s...`, 'system');
          setTimeout(connect, delay);
        } else {
          addMessage('Connection lost. Please refresh the page.', 'error');
        }
      };

      ws.onerror = function(error) {
        console.error('WebSocket error:', error);
      };
    } catch (e) {
      console.error('Failed to create WebSocket:', e);
      setStatus('disconnected');
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  function handleMessage(data) {
    switch (data.type) {
      case 'response':
        hideTypingIndicator();
        isWaitingForResponse = false;
        messageInput.disabled = false;
        sendBtn.disabled = false;
        if (data.content) {
          addMessage(data.content, 'assistant', true);
        }
        messageInput.focus();
        fetchCredits();
        break;

      case 'chunk':
        // For streaming responses
        if (data.content) {
          let lastMessage = messagesContainer.querySelector('.message.assistant:last-of-type');
          if (!lastMessage || lastMessage.dataset.complete) {
            lastMessage = document.createElement('div');
            lastMessage.className = 'message assistant';
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            lastMessage.appendChild(contentDiv);
            messagesContainer.appendChild(lastMessage);
          }
          const contentDiv = lastMessage.querySelector('.message-content') || lastMessage;
          contentDiv.innerHTML = renderMarkdown(contentDiv.textContent + data.content);
          scrollToBottom();
        }
        break;

      case 'debug':
        addDebugMessage('debug', data.message || '...');
        break;

      case 'skill_start':
        addDebugMessage('tool:' + (data.skill || 'skill'), data.input || data.message || 'Starting...', 'tool-start');
        break;

      case 'skill_complete':
        addDebugMessage('tool:' + (data.skill || 'skill'), data.output || data.result || 'Complete', 'tool-complete');
        break;

      case 'skill_error':
        addDebugMessage('error:' + (data.skill || 'skill'), data.error || 'Unknown error', 'tool-error');
        break;

      case 'memory':
        addMemoryDebugMessage(data.action || 'search', data.message || `${data.count || 0} items`, data.items || []);
        break;

      case 'thinking':
        addDebugMessage('thinking', data.message || '...', 'thinking');
        break;

      case 'trigger':
        // Proactive message from server (e.g., reminder)
        hideTypingIndicator();
        if (data.content) {
          addMessage(data.content, 'assistant', true);
        }
        break;

      case 'file':
        // File download link
        addFileMessage(data.path, data.caption);
        break;

      case 'error':
        hideTypingIndicator();
        isWaitingForResponse = false;
        messageInput.disabled = false;
        sendBtn.disabled = false;
        addMessage(data.error || 'An error occurred', 'error');
        messageInput.focus();
        break;

      case 'pong':
        // Heartbeat response - no action needed
        break;

      default:
        console.log('Unknown message type:', data.type);
    }
  }

  /**
   * Send a chat message
   */
  function sendMessage(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addMessage('Not connected. Please wait...', 'error');
      return;
    }

    if (!message.trim()) {
      return;
    }

    // Show user message (no markdown for user messages to preserve formatting)
    addMessage(message, 'user', false);

    // Show typing indicator
    showTypingIndicator();
    isWaitingForResponse = true;
    messageInput.disabled = true;
    sendBtn.disabled = true;

    // Send to server
    ws.send(JSON.stringify({
      type: 'chat',
      message: message
    }));
  }

  /**
   * Handle form submission
   */
  chatForm.addEventListener('submit', function(e) {
    e.preventDefault();
    const message = messageInput.value.trim();
    if (message) {
      sendMessage(message);
      messageInput.value = '';
    }
  });

  /**
   * Handle keyboard shortcuts
   */
  messageInput.addEventListener('keydown', function(e) {
    // Submit on Enter (but not Shift+Enter)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.dispatchEvent(new Event('submit'));
    }
  });

  /**
   * Handle debug toggle
   */
  debugToggle.addEventListener('change', function() {
    toggleDebugMode(this.checked);
  });

  /**
   * Periodic ping to keep connection alive
   */
  function startHeartbeat() {
    setInterval(function() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  /**
   * Format a dollar amount
   */
  function formatCost(dollars) {
    return '$' + dollars.toFixed(4);
  }

  /**
   * Fetch and display credits/usage data
   */
  function fetchCredits() {
    fetch('/api/costs')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.enabled) {
          creditsToggle.style.display = 'none';
          return;
        }
        updateCreditsPanel(data);
      })
      .catch(function(err) {
        console.error('Failed to fetch costs:', err);
      });
  }

  /**
   * Update credits panel with data from API
   */
  function updateCreditsPanel(data) {
    // Daily
    document.getElementById('credits-daily-spent').textContent = formatCost(data.daily.spent);
    var dailyBar = document.getElementById('credits-daily-bar');
    if (data.daily.budget != null) {
      var dailyPct = Math.min((data.daily.spent / data.daily.budget) * 100, 100);
      document.getElementById('credits-daily-budget').textContent = 'of $' + data.daily.budget.toFixed(2) + ' budget';
      dailyBar.style.width = dailyPct + '%';
      dailyBar.className = 'credits-bar-fill' + (data.daily.exceeded ? ' exceeded' : data.daily.warning ? ' warning' : '');
    } else {
      document.getElementById('credits-daily-budget').textContent = 'no budget set';
      dailyBar.style.width = '0%';
    }

    // Monthly
    document.getElementById('credits-monthly-spent').textContent = formatCost(data.monthly.spent);
    var monthlyBar = document.getElementById('credits-monthly-bar');
    if (data.monthly.budget != null) {
      var monthlyPct = Math.min((data.monthly.spent / data.monthly.budget) * 100, 100);
      document.getElementById('credits-monthly-budget').textContent = 'of $' + data.monthly.budget.toFixed(2) + ' budget';
      monthlyBar.style.width = monthlyPct + '%';
      monthlyBar.className = 'credits-bar-fill' + (data.monthly.exceeded ? ' exceeded' : data.monthly.warning ? ' warning' : '');
    } else {
      document.getElementById('credits-monthly-budget').textContent = 'no budget set';
      monthlyBar.style.width = '0%';
    }

    // Requests
    document.getElementById('credits-total-requests').textContent = data.totalRequests;

    // Top models
    var modelsContainer = document.getElementById('credits-models');
    modelsContainer.innerHTML = '';
    if (data.topModels && data.topModels.length > 0) {
      for (var i = 0; i < data.topModels.length; i++) {
        var m = data.topModels[i];
        var tag = document.createElement('div');
        tag.className = 'credits-model-tag';
        tag.innerHTML =
          '<span class="credits-model-name">' + escapeHtml(m.model) + '</span>' +
          '<span class="credits-model-cost">' + formatCost(m.cost) + '</span>' +
          '<span class="credits-model-pct">(' + m.percentage + '%)</span>';
        modelsContainer.appendChild(tag);
      }
    }

    // Show badge dot when panel is closed and there's spend
    var badge = document.getElementById('credits-badge');
    if (data.daily.spent > 0 && creditsPanel.style.display === 'none') {
      badge.style.display = 'block';
    }
  }

  /**
   * Toggle credits panel visibility
   */
  creditsToggle.addEventListener('click', function() {
    var isVisible = creditsPanel.style.display !== 'none';
    creditsPanel.style.display = isVisible ? 'none' : 'block';
    creditsToggle.classList.toggle('active', !isVisible);
    document.getElementById('credits-badge').style.display = 'none';
    if (!isVisible) {
      fetchCredits();
    }
  });

  // Initialize
  connect();
  startHeartbeat();

  // Fetch credits on load and periodically
  fetchCredits();
  setInterval(fetchCredits, 30000);

})();
