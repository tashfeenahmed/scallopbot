#!/usr/bin/env npx tsx
/**
 * Test Vision with embedded test images
 */

import WebSocket from 'ws';

const WS_URL = 'ws://89.167.23.58:3000/ws';

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// A small but visible 8x8 red square PNG (properly generated)
const RED_SQUARE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADklEQVQI12P4z8DAwMAAAAkABS8qQwYAAAAASUVORK5CYII=';

// A small 8x8 blue square PNG
const BLUE_SQUARE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADklEQVQI12NkYGD4z8AAAAkABSwqQwYAAAAASUVORK5CYII=';

async function sendMessage(
  ws: WebSocket,
  message: string,
  sessionId: string,
  attachments?: Array<{ type: 'image'; data: string; mimeType: string; filename?: string }>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout'));
    }, 120000);

    const messageHandler = (data: Buffer) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.type === 'response') {
          clearTimeout(timeout);
          ws.off('message', messageHandler);
          resolve(response.content || '');
        } else if (response.type === 'error') {
          clearTimeout(timeout);
          ws.off('message', messageHandler);
          reject(new Error(response.error));
        } else if (response.type === 'thinking') {
          log('  [Thinking...]');
        }
      } catch { }
    };

    ws.on('message', messageHandler);
    ws.send(JSON.stringify({ type: 'chat', sessionId, message, attachments }));
  });
}

async function waitForWebSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
  });
}

async function main() {
  log('='.repeat(60));
  log('VISION TEST v2');
  log('='.repeat(60));

  log('\nConnecting to WebSocket...');
  const ws = new WebSocket(WS_URL);

  try {
    await waitForWebSocket(ws);
    log('Connected!');
  } catch (error) {
    log(`Failed to connect: ${error}`);
    process.exit(1);
  }

  // Use fresh session for each test
  const sessionId1 = `vision-v2-single-${Date.now()}`;
  const sessionId2 = `vision-v2-multi-${Date.now()}`;

  try {
    // Test 1: Single image - ask about color
    log('\n--- TEST 1: Single Image (should see a small colored square) ---');

    const response1 = await sendMessage(
      ws,
      'I am sending you an image. Can you see it? What color is it? Just tell me the color.',
      sessionId1,
      [{
        type: 'image',
        data: RED_SQUARE_PNG,
        mimeType: 'image/png',
        filename: 'red_square.png'
      }]
    );

    log(`Response: "${response1.substring(0, 300)}"`);

    const canSeeImage = !response1.toLowerCase().includes("can't see") &&
                        !response1.toLowerCase().includes("cannot see") &&
                        !response1.toLowerCase().includes("don't have");
    log(`Can see image: ${canSeeImage ? 'YES' : 'NO'}`);

    await new Promise(r => setTimeout(r, 2000));

    // Test 2: Two images in new session
    log('\n--- TEST 2: Two Images (two colored squares) ---');

    const response2 = await sendMessage(
      ws,
      'I am sending 2 images. Can you see both? Tell me what you observe in each.',
      sessionId2,
      [
        { type: 'image', data: RED_SQUARE_PNG, mimeType: 'image/png', filename: 'image1.png' },
        { type: 'image', data: BLUE_SQUARE_PNG, mimeType: 'image/png', filename: 'image2.png' },
      ]
    );

    log(`Response: "${response2.substring(0, 400)}"`);

    const canSeeMultiple = !response2.toLowerCase().includes("can't see") &&
                           response2.length > 30;
    log(`Can see multiple: ${canSeeMultiple ? 'YES' : 'NO'}`);

    // Summary
    log('\n' + '='.repeat(60));
    log('TEST RESULTS');
    log('='.repeat(60));
    log(`Single image test: ${canSeeImage ? 'PASSED' : 'FAILED'}`);
    log(`Multiple images test: ${canSeeMultiple ? 'PASSED' : 'FAILED'}`);
    log('');
    log('Note: Small 8x8 pixel images may appear as solid colors or be hard to interpret.');

  } catch (error) {
    log(`ERROR: ${error}`);
  } finally {
    ws.close();
  }
}

main().catch(console.error);
