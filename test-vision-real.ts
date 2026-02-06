#!/usr/bin/env npx tsx
/**
 * Test Vision with Real Images
 */

import WebSocket from 'ws';

const WS_URL = 'ws://89.167.23.58:3000/ws';

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function downloadImage(url: string): Promise<{ data: string; mimeType: string }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  return {
    data: buffer.toString('base64'),
    mimeType: contentType.split(';')[0],
  };
}

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
  log('VISION TEST - Real Images');
  log('='.repeat(60));

  // Sample image URLs (small test images)
  const testImages = {
    cat: 'https://placekitten.com/200/200',
    dog: 'https://placedog.net/200/200',
    nature: 'https://picsum.photos/200/200',
  };

  log('\nDownloading test images...');

  let catImage: { data: string; mimeType: string };
  let dogImage: { data: string; mimeType: string };

  try {
    catImage = await downloadImage(testImages.cat);
    log('  Downloaded cat image');
    dogImage = await downloadImage(testImages.nature);
    log('  Downloaded nature image');
  } catch (error) {
    log(`Failed to download images: ${error}`);
    process.exit(1);
  }

  log('\nConnecting to WebSocket...');
  const ws = new WebSocket(WS_URL);

  try {
    await waitForWebSocket(ws);
    log('Connected!');
  } catch (error) {
    log(`Failed to connect: ${error}`);
    process.exit(1);
  }

  const sessionId = `vision-real-${Date.now()}`;

  try {
    // Test 1: Single real image
    log('\n--- TEST 1: Single Real Image (Cat/Kitten) ---');

    const response1 = await sendMessage(
      ws,
      'What animal do you see in this image?',
      sessionId,
      [{
        type: 'image',
        data: catImage.data,
        mimeType: catImage.mimeType,
        filename: 'cat.jpg'
      }]
    );

    log(`Response: "${response1.substring(0, 400)}"`);
    const isCatRecognized = response1.toLowerCase().includes('cat') ||
                            response1.toLowerCase().includes('kitten');
    log(`Cat recognized: ${isCatRecognized ? 'YES' : 'NO'}`);

    await new Promise(r => setTimeout(r, 2000));

    // Test 2: Two images
    log('\n--- TEST 2: Two Images ---');

    const response2 = await sendMessage(
      ws,
      'I am sending 2 different images. Describe each one briefly.',
      sessionId,
      [
        { type: 'image', data: catImage.data, mimeType: catImage.mimeType, filename: 'image1.jpg' },
        { type: 'image', data: dogImage.data, mimeType: dogImage.mimeType, filename: 'image2.jpg' },
      ]
    );

    log(`Response: "${response2.substring(0, 500)}"`);
    const describesMultiple = response2.length > 50;
    log(`Multiple images described: ${describesMultiple ? 'YES' : 'NO'}`);

    // Summary
    log('\n' + '='.repeat(60));
    log('TEST RESULTS');
    log('='.repeat(60));
    log(`Single image (cat): ${isCatRecognized ? 'PASSED' : 'FAILED'}`);
    log(`Multiple images: ${describesMultiple ? 'PASSED' : 'NEEDS REVIEW'}`);

  } catch (error) {
    log(`ERROR: ${error}`);
  } finally {
    ws.close();
  }
}

main().catch(console.error);
