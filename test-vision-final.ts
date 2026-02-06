#!/usr/bin/env npx tsx
/**
 * Final Vision Test - Single and Multiple Images
 * Uses valid minimal PNG images
 */

import WebSocket from 'ws';

const WS_URL = 'ws://89.167.23.58:3000/ws';

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Valid minimal 1x1 pixel PNGs (these worked in the first test)
// Red pixel
const IMG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
// Blue pixel
const IMG_BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';
// Green pixel
const IMG_GREEN = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

async function sendMessage(
  ws: WebSocket,
  message: string,
  sessionId: string,
  attachments?: Array<{ type: 'image'; data: string; mimeType: string; filename?: string }>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 120000);

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
    ws.on('error', reject);
  });
}

async function main() {
  log('='.repeat(60));
  log('FINAL VISION TEST');
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

  // Fresh sessions
  const session1 = `vision-final-1-${Date.now()}`;
  const session2 = `vision-final-2-${Date.now()}`;

  let singlePassed = false;
  let multiPassed = false;

  try {
    // TEST 1: Single image
    log('\n--- TEST 1: Single Image ---');
    log('Sending 1 image...');

    const response1 = await sendMessage(
      ws,
      'I sent you an image. Can you see it? Describe what you see, even if it is just a color or dot.',
      session1,
      [{ type: 'image', data: IMG_RED, mimeType: 'image/png', filename: 'test.png' }]
    );

    log(`Response (first 350 chars):`);
    log(`"${response1.substring(0, 350)}"`);

    // Check if bot can see image
    singlePassed = !response1.toLowerCase().includes("can't see images") &&
                   !response1.toLowerCase().includes("cannot see images") &&
                   !response1.toLowerCase().includes("don't have vision") &&
                   response1.length > 20;

    log(`\nResult: ${singlePassed ? 'PASSED - Bot can see image' : 'FAILED - Bot cannot see image'}`);

    await new Promise(r => setTimeout(r, 3000));

    // TEST 2: Multiple images (fresh session)
    log('\n--- TEST 2: Multiple Images (3 images) ---');
    log('Sending 3 images...');

    const response2 = await sendMessage(
      ws,
      'I am sending you 3 different images. Can you see all 3? Describe each one.',
      session2,
      [
        { type: 'image', data: IMG_RED, mimeType: 'image/png', filename: 'img1.png' },
        { type: 'image', data: IMG_BLUE, mimeType: 'image/png', filename: 'img2.png' },
        { type: 'image', data: IMG_GREEN, mimeType: 'image/png', filename: 'img3.png' },
      ]
    );

    log(`Response (first 400 chars):`);
    log(`"${response2.substring(0, 400)}"`);

    multiPassed = !response2.toLowerCase().includes("can't see images") &&
                  !response2.toLowerCase().includes("cannot see images") &&
                  response2.length > 30;

    log(`\nResult: ${multiPassed ? 'PASSED - Bot can see multiple images' : 'FAILED'}`);

  } catch (error) {
    log(`\nERROR: ${error}`);
  } finally {
    ws.close();
  }

  // Final summary
  log('\n' + '='.repeat(60));
  log('FINAL RESULTS');
  log('='.repeat(60));
  log(`Single image:    ${singlePassed ? '✓ PASSED' : '✗ FAILED'}`);
  log(`Multiple images: ${multiPassed ? '✓ PASSED' : '✗ FAILED'}`);
  log('='.repeat(60));

  if (singlePassed && multiPassed) {
    log('\nVISION IS WORKING! Both single and multiple images supported.');
  } else if (singlePassed) {
    log('\nSingle images work. Multiple images may need review.');
  } else {
    log('\nVision may not be working properly. Check logs.');
  }
}

main().catch(console.error);
