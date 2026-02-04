/**
 * SmartBot Web Chat Client
 * Vanilla JavaScript WebSocket client for the chat interface
 */

(function() {
  'use strict';

  // DOM Elements
  const messagesContainer = document.getElementById('messages');
  const chatForm = document.getElementById('chat-form');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const statusIndicator = document.getElementById('status');

  // State
  let ws = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;
  const baseReconnectDelay = 1000;
  let isWaitingForResponse = false;

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
    statusIndicator.textContent = status.charAt(0).toUpperCase() + status.slice(1);

    const isConnected = status === 'connected';
    messageInput.disabled = !isConnected || isWaitingForResponse;
    sendBtn.disabled = !isConnected || isWaitingForResponse;
  }

  /**
   * Add a message to the chat
   */
  function addMessage(content, type) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}`;
    messageEl.textContent = content;
    messagesContainer.appendChild(messageEl);
    scrollToBottom();
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
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
        addMessage('Connected to SmartBot', 'system');
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
          addMessage(`Disconnected. Reconnecting in ${delay / 1000}s...`, 'system');
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
          addMessage(data.content, 'assistant');
        }
        messageInput.focus();
        break;

      case 'chunk':
        // For streaming responses (future enhancement)
        if (data.content) {
          // Append to last assistant message or create new one
          let lastMessage = messagesContainer.querySelector('.message.assistant:last-of-type');
          if (!lastMessage || lastMessage.dataset.complete) {
            lastMessage = document.createElement('div');
            lastMessage.className = 'message assistant';
            messagesContainer.appendChild(lastMessage);
          }
          lastMessage.textContent += data.content;
          scrollToBottom();
        }
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

    // Show user message
    addMessage(message, 'user');

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
   * Periodic ping to keep connection alive
   */
  function startHeartbeat() {
    setInterval(function() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  // Initialize
  connect();
  startHeartbeat();

})();
