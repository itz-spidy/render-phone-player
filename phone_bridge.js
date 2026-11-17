const WebSocket = require('ws');
const net = require('net');
const http = require('http');

const SERVER_URL = process.argv[2] || process.env.RENDER_URL;
const PHONE_NAME = process.argv[3] || process.env.PHONE_NAME || ('Phone-' + Math.floor(Math.random() * 1000));

if (!SERVER_URL) {
  console.error('Usage: node phone_bridge.js <RENDER_WEBSOCKET_URL> [PHONE_NAME]');
  console.error('Example: node phone_bridge.js wss://my-app.onrender.com/phone-tunnel "Phone 1"');
  process.exit(1);
}

function fetchIpInfo() {
  return new Promise((resolve) => {
    const req = http.get('http://ip-api.com/json', { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.status === 'success') {
            resolve({
              ip: parsed.query,
              country: parsed.country,
              countryCode: parsed.countryCode,
              city: parsed.city,
              region: parsed.regionName,
              isp: parsed.isp
            });
            return;
          }
        } catch (_) {}
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const activeSockets = new Map();

function connect() {
  console.log(`[Bridge] Connecting to Render Hub: ${SERVER_URL} as "${PHONE_NAME}"...`);
  const ws = new WebSocket(SERVER_URL);

  ws.on('open', async () => {
    console.log(`[Bridge] Connected successfully! Detecting public IP & location...`);
    const ipInfo = await fetchIpInfo();
    if (ipInfo) {
      console.log(`[Bridge] IP: ${ipInfo.ip} | Location: ${ipInfo.city}, ${ipInfo.country} (${ipInfo.isp})`);
    } else {
      console.log(`[Bridge] Location check skipped/timed out; Render will detect IP.`);
    }

    console.log(`[Bridge] Registering as "${PHONE_NAME}"...`);
    ws.send(JSON.stringify({
      type: 'register',
      name: PHONE_NAME,
      ipInfo: ipInfo || null
    }));
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
