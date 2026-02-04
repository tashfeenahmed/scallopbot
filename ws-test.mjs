// Test WebSocket connection to ScallopBot
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3000/ws');

ws.on('open', () => {
  console.log('Connected to WebSocket');

  // Send a chat message asking to use agent-browser
  ws.send(JSON.stringify({
    type: 'chat',
    message: 'Use agent-browser to open https://example.com and tell me what the page says. Use the bash tool to run the agent-browser commands.'
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Received:', JSON.stringify(msg, null, 2));

  // Close after getting response
  if (msg.type === 'response' || msg.type === 'error') {
    setTimeout(() => {
      console.log('Test complete, closing...');
      ws.close();
      process.exit(0);
    }, 1000);
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('Disconnected');
});

// Timeout after 2 minutes
setTimeout(() => {
  console.log('Timeout - closing connection');
  ws.close();
  process.exit(1);
}, 120000);
