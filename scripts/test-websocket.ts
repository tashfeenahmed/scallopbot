#!/usr/bin/env npx tsx
/**
 * WebSocket Conversation Test Script
 *
 * Tests the smartbot via WebSocket connection with real conversations.
 */

import WebSocket from 'ws';

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:3000/ws';
const API_KEY = process.env.API_KEY || '';

interface WSMessage {
  type: string;
  content?: string;
  error?: string;
  sessionId?: string;
  [key: string]: unknown;
}

class WebSocketTester {
  private ws: WebSocket | null = null;
  private messageQueue: WSMessage[] = [];
  private waitingResolve: ((msg: WSMessage) => void) | null = null;

  async connect(): Promise<void> {
    const url = API_KEY ? `${WS_URL}?apiKey=${API_KEY}` : WS_URL;

    return new Promise((resolve, reject) => {
      console.log(`\n📡 Connecting to ${WS_URL}...`);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log('✅ Connected!\n');
        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as WSMessage;

        if (this.waitingResolve) {
          this.waitingResolve(msg);
          this.waitingResolve = null;
        } else {
          this.messageQueue.push(msg);
        }
      });

      this.ws.on('error', (err) => {
        console.error('❌ WebSocket error:', err.message);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`\n🔌 Connection closed (code: ${code}, reason: ${reason.toString() || 'none'})`);
      });
    });
  }

  async waitForMessage(timeoutMs: number = 60000): Promise<WSMessage> {
    // Check queue first
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }

    // Wait for next message
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waitingResolve = null;
        reject(new Error('Timeout waiting for message'));
      }, timeoutMs);

      this.waitingResolve = (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      };
    });
  }

  async sendPing(): Promise<WSMessage> {
    console.log('🏓 Sending ping...');
    this.ws!.send(JSON.stringify({ type: 'ping' }));
    const response = await this.waitForMessage(5000);
    console.log(`   Response: ${response.type}`);
    return response;
  }

  async sendChat(message: string, sessionId?: string): Promise<WSMessage> {
    console.log(`💬 User: ${message}`);

    const payload: Record<string, unknown> = { type: 'chat', message };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    this.ws!.send(JSON.stringify(payload));

    // Wait for the actual response, consuming intermediate messages
    let response: WSMessage;
    const startTime = Date.now();
    const timeout = 120000; // 120s timeout for LLM responses

    while (true) {
      if (Date.now() - startTime > timeout) {
        throw new Error('Timeout waiting for response');
      }

      response = await this.waitForMessage(timeout - (Date.now() - startTime));

      // Log intermediate messages
      if (response.type === 'memory') {
        console.log(`   📚 Memory: ${response.action} (${response.count} items)`);
      } else if (response.type === 'thinking') {
        console.log(`   🧠 Thinking...`);
      } else if (response.type === 'skill_start') {
        console.log(`   🔧 Skill: ${response.skill} starting`);
      } else if (response.type === 'skill_complete') {
        console.log(`   ✓ Skill: ${response.skill} complete`);
      } else if (response.type === 'debug') {
        console.log(`   📍 ${response.message}`);
      }

      // Break on final response or error
      if (response.type === 'response' || response.type === 'error') {
        break;
      }
    }

    if (response.type === 'response') {
      console.log(`🤖 Bot: ${response.content}`);
    } else if (response.type === 'error') {
      console.log(`❌ Error: ${response.error}`);
    }

    return response;
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

async function runTests() {
  const tester = new WebSocketTester();
  let sessionId: string | undefined;
  let passed = 0;
  let failed = 0;

  const test = async (name: string, fn: () => Promise<boolean>) => {
    process.stdout.write(`\n📋 Test: ${name}\n`);
    try {
      const result = await fn();
      if (result) {
        console.log(`   ✅ PASSED\n`);
        passed++;
      } else {
        console.log(`   ❌ FAILED\n`);
        failed++;
      }
    } catch (err) {
      console.log(`   ❌ ERROR: ${(err as Error).message}\n`);
      failed++;
    }
  };

  try {
    await tester.connect();

    // Test 1: Ping/Pong
    await test('Ping/Pong', async () => {
      const response = await tester.sendPing();
      return response.type === 'pong';
    });

    // Test 2: Simple greeting
    await test('Simple Greeting', async () => {
      const response = await tester.sendChat('Hello! What can you do?');
      sessionId = response.sessionId;
      return response.type === 'response' &&
             typeof response.content === 'string' &&
             response.content.length > 0;
    });

    // Test 3: Session persistence (use same session)
    await test('Session Persistence', async () => {
      const response = await tester.sendChat('What did I just ask you?', sessionId);
      return response.type === 'response' &&
             typeof response.content === 'string' &&
             (response.content.toLowerCase().includes('hello') ||
              response.content.toLowerCase().includes('greeting') ||
              response.content.toLowerCase().includes('ask') ||
              response.content.toLowerCase().includes('do'));
    });

    // Test 4: Goal creation (testing new goal tracking)
    await test('Goal Tracking - Create Goal', async () => {
      const response = await tester.sendChat(
        'I want to set a goal to learn TypeScript this month. Can you help me track it?',
        sessionId
      );
      return response.type === 'response' &&
             typeof response.content === 'string' &&
             response.content.length > 0;
    });

    // Test 5: Ask about progress
    await test('Goal Tracking - Check Progress', async () => {
      const response = await tester.sendChat(
        'What goals do I have? Show my progress.',
        sessionId
      );
      return response.type === 'response' &&
             typeof response.content === 'string' &&
             response.content.length > 0;
    });

    // Test 6: Memory recall
    await test('Memory Recall', async () => {
      const response = await tester.sendChat(
        'Do you remember what goal I mentioned?',
        sessionId
      );
      return response.type === 'response' &&
             typeof response.content === 'string' &&
             (response.content.toLowerCase().includes('typescript') ||
              response.content.toLowerCase().includes('goal') ||
              response.content.toLowerCase().includes('learn'));
    });

    // Test 7: Error handling - missing message
    await test('Error Handling - Missing Message', async () => {
      tester['ws']!.send(JSON.stringify({ type: 'chat' }));
      const response = await tester.waitForMessage(5000);
      return response.type === 'error' &&
             response.error === 'Message is required';
    });

    // Test 8: Unknown message type
    await test('Error Handling - Unknown Type', async () => {
      tester['ws']!.send(JSON.stringify({ type: 'invalid_type' }));
      const response = await tester.waitForMessage(5000);
      return response.type === 'error' &&
             typeof response.error === 'string' &&
             response.error.includes('Unknown message type');
    });

  } finally {
    tester.close();
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

// Run if executed directly
runTests().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
