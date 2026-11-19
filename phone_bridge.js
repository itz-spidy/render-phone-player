const WebSocket = require('ws');
const net = require('net');
const http = require('http');

// Default to BOTH Render Hub instances so phone feeds both in parallel
const DEFAULT_HUBS = [
  'wss://phone-hub-player.onrender.com/phone-tunnel',
  'wss://phone-hub-player-2.onrender.com/phone-tunnel'
];

let targetHubs = [];
let phoneName = process.env.PHONE_NAME || ('Phone-' + Math.floor(Math.random() * 1000));

// CLI Argument parsing:
// Usage:
//   node phone_bridge.js                                  -> connects to both Render hubs
//   node phone_bridge.js "Phone 1"                        -> connects to both Render hubs with name "Phone 1"
//   node phone_bridge.js wss://hub1...,wss://hub2...      -> connects to specified hubs
//   node phone_bridge.js wss://hub1... "Phone 1"          -> connects to specified hub with custom name
const arg2 = process.argv[2];
const arg3 = process.argv[3];

if (arg2) {
  if (arg2.startsWith('ws://') || arg2.startsWith('wss://') || arg2.startsWith('http://') || arg2.startsWith('https://')) {
    targetHubs = arg2.split(',').map(s => s.trim().replace(/^http/, 'ws'));
    if (arg3) phoneName = arg3;
  } else {
    // arg2 is phone name
    phoneName = arg2;
    targetHubs = [...DEFAULT_HUBS];
  }
} else {
  targetHubs = [...DEFAULT_HUBS];
}

console.log('====================================================');
console.log(`📱 Phone Bridge Multi-Hub Tunnel`);
console.log(`👤 Device Name: "${phoneName}"`);
console.log(`🌐 Target Hubs: ${targetHubs.length} endpoints`);
targetHubs.forEach((h, i) => console.log(`   [Node ${i + 1}] ${h}`));
console.log('====================================================');

let cachedIpInfo = null;
let lastIpFetch = 0;

function fetchIpInfo() {
  const now = Date.now();
  if (cachedIpInfo && (now - lastIpFetch < 60000)) {
    return Promise.resolve(cachedIpInfo);
  }
  return new Promise((resolve) => {
    const req = http.get('http://ip-api.com/json', { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.status === 'success') {
            cachedIpInfo = {
              ip: parsed.query,
              country: parsed.country,
              countryCode: parsed.countryCode,
              city: parsed.city,
              region: parsed.regionName,
              isp: parsed.isp
            };
            lastIpFetch = Date.now();
            resolve(cachedIpInfo);
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

function startHubClient(hubUrl, nodeIndex) {
  const tag = `[Node ${nodeIndex + 1}]`;
  const activeSockets = new Map();
  let reconnectTimer = null;

  function connect() {
    console.log(`${tag} Connecting to ${hubUrl}...`);
    let ws;
    try {
      ws = new WebSocket(hubUrl);
    } catch (err) {
      console.error(`${tag} Socket init failed:`, err.message);
      scheduleReconnect();
      return;
    }

    ws.on('open', async () => {
      console.log(`${tag} Connected successfully! Registering "${phoneName}"...`);
      const ipInfo = await fetchIpInfo();
      if (ipInfo) {
        console.log(`${tag} IP: ${ipInfo.ip} | Location: ${ipInfo.city}, ${ipInfo.country} (${ipInfo.isp})`);
      }

      ws.send(JSON.stringify({
        type: 'register',
        name: phoneName,
        ipInfo: ipInfo || null
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);

        if (msg.type === 'registered') {
          console.log(`${tag} Registered! Routing active 24/7.`);
          return;
        }

        if (msg.type === 'tcp_open') {
          const socket = net.connect(msg.port, msg.host, () => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'tcp_connected', tunnelId: msg.tunnelId }));
            }
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
        console.error(`${tag} Message error:`, e.message);
      }
    });

    ws.on('close', () => {
      console.log(`${tag} Disconnected. Reconnecting in 3s...`);
      activeSockets.forEach(s => s.destroy());
      activeSockets.clear();
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error(`${tag} Error:`, err.message);
      ws.close();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  }

  connect();
}

// Start client connections to all target hubs simultaneously
targetHubs.forEach((hubUrl, idx) => {
  startHubClient(hubUrl, idx);
});
