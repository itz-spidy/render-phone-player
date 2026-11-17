const WebSocket = require('ws');
const net = require('net');

const SERVER_URL = process.argv[2] || process.env.RENDER_URL;
const PHONE_NAME = process.argv[3] || process.env.PHONE_NAME || ('Phone-' + Math.floor(Math.random() * 1000));

if (!SERVER_URL) {
  console.error('Usage: node phone_bridge.js <RENDER_WEBSOCKET_URL> [PHONE_NAME]');
  console.error('Example: node phone_bridge.js wss://my-app.onrender.com/phone-tunnel "Phone 1"');
  process.exit(1);
}

const activeSockets = new Map();

function connect() {
  console.log(`[Bridge] Connecting to Render Hub: ${SERVER_URL} as "${PHONE_NAME}"...`);
  const ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log(`[Bridge] Connected successfully! Registering as "${PHONE_NAME}"...`);
    ws.send(JSON.stringify({ type: 'register', name: PHONE_NAME }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'registered') {
        console.log(`[Bridge] Registered! Ready to route traffic 24/7.`);
        return;
      }

      if (msg.type === 'tcp_open') {
        const socket = net.connect(msg.port, msg.host, () => {
          ws.send(JSON.stringify({ type: 'tcp_connected', tunnelId: msg.tunnelId }));
        });

        socket.on('data', chunk => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'tcp_data',
              tunnelId: msg.tunnelId,
              data: chunk.toString('base64')
            }));
          }
        });

        socket.on('close', () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'tcp_close', tunnelId: msg.tunnelId }));
          }
          activeSockets.delete(msg.tunnelId);
        });

        socket.on('error', () => {
          activeSockets.delete(msg.tunnelId);
        });

        activeSockets.set(msg.tunnelId, socket);
      }

      if (msg.type === 'tcp_data') {
        const socket = activeSockets.get(msg.tunnelId);
        if (socket && !socket.destroyed) {
          socket.write(Buffer.from(msg.data, 'base64'));
        }
      }

      if (msg.type === 'tcp_close') {
        const socket = activeSockets.get(msg.tunnelId);
        if (socket) {
          socket.end();
          activeSockets.delete(msg.tunnelId);
        }
      }

    } catch (e) {
      console.error('Error handling message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[Bridge] Disconnected. Reconnecting in 3 seconds...');
    activeSockets.forEach(s => s.destroy());
    activeSockets.clear();
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.error('[Bridge] Connection error:', err.message);
    ws.close();
  });
}

connect();
