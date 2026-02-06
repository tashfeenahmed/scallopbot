#!/usr/bin/env npx tsx
/**
 * Test Vision Capabilities via WebSocket
 *
 * Tests single and multiple image processing
 */

import WebSocket from 'ws';

const WS_URL = 'ws://89.167.23.58:3000/ws';

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Create a simple test image (red square) as base64
function createTestImage(color: string = 'red'): string {
  // This is a minimal valid 10x10 PNG image
  // We'll use pre-made base64 test images for reliability
  const images: Record<string, string> = {
    // 1x1 red pixel PNG
    red: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    // 1x1 blue pixel PNG
    blue: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
    // 1x1 green pixel PNG
    green: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==',
  };
  return images[color] || images.red;
}

async function sendMessage(
  ws: WebSocket,
  message: string,
  sessionId: string,
  attachments?: Array<{ type: 'image'; data: string; mimeType: string; filename?: string }>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for response'));
    }, 120000);

    let responseText = '';

    const messageHandler = (data: Buffer) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.type === 'response') {
          clearTimeout(timeout);
          ws.off('message', messageHandler);
          responseText = response.content || '';
          resolve(responseText);
        } else if (response.type === 'error') {
          clearTimeout(timeout);
          ws.off('message', messageHandler);
          reject(new Error(response.error || 'Unknown error'));
        } else if (response.type === 'thinking') {
          log('  [Thinking...]');
        } else if (response.type === 'debug') {
          log(`  [Debug] ${response.message}`);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.on('message', messageHandler);

    const payload: any = { type: 'chat', sessionId, message };
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments;
    }

    ws.send(JSON.stringify(payload));
  });
}

async function waitForWebSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
  });
}

async function main() {
  log('='.repeat(60));
  log('VISION TEST - Single and Multiple Images');
  log('='.repeat(60));

  // Connect to WebSocket
  log('\nConnecting to WebSocket at ' + WS_URL);
  const ws = new WebSocket(WS_URL);

  try {
    await waitForWebSocket(ws);
    log('Connected!');
  } catch (error) {
    log(`Failed to connect: ${error}`);
    process.exit(1);
  }

  const sessionId = `vision-test-${Date.now()}`;

  try {
    // Test 1: Single image
    log('\n--- TEST 1: Single Image ---');
    log('Sending a single test image (red pixel)...');

    const singleImageResponse = await sendMessage(
      ws,
      'What do you see in this image? Describe it briefly.',
      sessionId,
      [{
        type: 'image',
        data: createTestImage('red'),
        mimeType: 'image/png',
        filename: 'test_red.png'
      }]
    );

    log(`Response: "${singleImageResponse.substring(0, 300)}..."`);

    // Check if the response indicates vision is working
    const hasVisionResponse = singleImageResponse.length > 20 &&
      !singleImageResponse.toLowerCase().includes("can't see") &&
      !singleImageResponse.toLowerCase().includes("cannot see") &&
      !singleImageResponse.toLowerCase().includes("don't have vision");

    log(`Vision working: ${hasVisionResponse ? 'YES' : 'NO'}`);

    // Wait a bit between tests
    await new Promise(r => setTimeout(r, 2000));

    // Test 2: Multiple images
    log('\n--- TEST 2: Multiple Images ---');
    log('Sending 3 test images (red, blue, green)...');

    const multiImageResponse = await sendMessage(
      ws,
      'I am sending you 3 images. Can you see them? Describe what you observe.',
      sessionId,
      [
        { type: 'image', data: createTestImage('red'), mimeType: 'image/png', filename: 'red.png' },
        { type: 'image', data: createTestImage('blue'), mimeType: 'image/png', filename: 'blue.png' },
        { type: 'image', data: createTestImage('green'), mimeType: 'image/png', filename: 'green.png' },
      ]
    );

    log(`Response: "${multiImageResponse.substring(0, 400)}..."`);

    const hasMultiVisionResponse = multiImageResponse.length > 20 &&
      !multiImageResponse.toLowerCase().includes("can't see") &&
      !multiImageResponse.toLowerCase().includes("cannot see");

    log(`Multi-image vision working: ${hasMultiVisionResponse ? 'YES' : 'NO'}`);

    // Summary
    log('\n' + '='.repeat(60));
    log('TEST SUMMARY');
    log('='.repeat(60));
    log(`Single image test: ${hasVisionResponse ? 'PASSED' : 'FAILED'}`);
    log(`Multiple images test: ${hasMultiVisionResponse ? 'PASSED' : 'FAILED'}`);

  } catch (error) {
    log(`ERROR: ${error}`);
  } finally {
    ws.close();
  }

  log('\nTest complete.');
}

main().catch(console.error);
