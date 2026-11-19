const http = require('http');
const net = require('net');
const url = require('url');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PROXY_PORT = 8080;
const VERCEL_API_URL = process.env.VERCEL_API_URL || 'https://vercel-browser-controller.vercel.app/api/url';
const SCAN_INTERVAL_MS = 60 * 1000;

// Internal memory logger
const logBuffer = [];
function log(...args) {
  const msg = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(msg);
  logBuffer.push(msg);
  if (logBuffer.length > 250) logBuffer.shift();
}

// Phone Tunnel Management & Shared Cluster Pool Mesh
const connectedPhones = new Map(); // phoneId -> { id, ws, name, ip, city, region, country, isp, location, connectedAt, isPeer }
const activeTunnels = new Map();   // tunnelId -> net.Socket
const peerTunnels = new Map();     // tunnelId -> WebSocket (peer node ws)
const clusterPeers = new Set();    // Set of WebSocket peers connected to our /cluster-tunnel
let peerClientWs = null;          // WebSocket client connection to peer node
let tunnelCounter = 0;
let activeSessionPhoneId = null;

const IS_NODE_2 = Boolean(
  process.env.RENDER_SERVICE_NAME === 'phone-hub-player-2' ||
  (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.includes('phone-hub-player-2')) ||
  (process.env.COOKIES_JSON && process.env.COOKIES_JSON.includes('A4G5gYteBpcylWPAO'))
);

function isDatacenter(p) {
  if (!p) return false;
  const s = `${p.isp || ''} ${p.name || ''} ${p.location || ''} ${p.country || ''}`.toLowerCase();
  return s.includes('railway') || s.includes('amazon') || s.includes('aws') || 
         s.includes('google') || s.includes('digitalocean') || s.includes('oracle') || 
         s.includes('azure') || s.includes('linode') || s.includes('hetzner') ||
         s.includes('singapore') || s.includes('linux-node') ||
         s.includes('datacenter') || s.includes('hosting') || s.includes('server');
}

function getRealSessionPhone() {
  const onlinePhones = Array.from(connectedPhones.values()).filter(p => !p.isPeer && p.ws && p.ws.readyState === 1);
  if (onlinePhones.length === 0) return null;
  const residential = onlinePhones.filter(p => !isDatacenter(p));
  return residential.length > 0 ? residential[0] : onlinePhones[0];
}

function getSessionPhone() {
  const onlinePhones = Array.from(connectedPhones.values()).filter(p => p.isPeer || (p.ws && p.ws.readyState === 1));
  if (onlinePhones.length === 0) return null;

  // 1. If currently pinned session phone is still online, USE IT (100% sticky)!
  if (activeSessionPhoneId) {
    const existing = onlinePhones.find(p => p.id === activeSessionPhoneId);
    if (existing) return existing;
  }

  // 2. Prefer local real residential phones over peer phones
  const localReal = onlinePhones.filter(p => !p.isPeer && !isDatacenter(p));
  const chosen = localReal.length > 0 ? localReal[0] : onlinePhones[0];

  activeSessionPhoneId = chosen.id;
  currentStatus.activePhoneUsed = chosen.name;
  log(`[Session Proxy] Pinned browser session to device: "${chosen.name}" (IP: ${chosen.ip}, Location: ${chosen.location}, ISP: ${chosen.isp})`);
  return chosen;
}

// 1. Internal HTTP & HTTPS CONNECT Proxy Server
// Puppeteer connects here -> traffic is piped over WebSocket to the pinned Phone -> Phone fetches from YouTube
const localProxyServer = http.createServer((req, res) => {
  const phone = getSessionPhone();
  if (!phone) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('No phones connected in pool.');
    return;
  }

  const reqUrl = url.parse(req.url);
  const tunnelId = 'tun_' + (++tunnelCounter) + '_' + Date.now();
  
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const fullBody = Buffer.concat(chunks).toString('base64');
    phone.ws.send(JSON.stringify({
      type: 'http_request',
      tunnelId,
      method: req.method,
      host: reqUrl.hostname,
      port: reqUrl.port || 80,
      path: reqUrl.path,
      headers: req.headers,
      body: fullBody
    }));
  });

  const responseHandler = (msg) => {
    if (msg.tunnelId === tunnelId && msg.type === 'http_response') {
      res.writeHead(msg.status, msg.headers);
      if (msg.body) {
        res.end(Buffer.from(msg.body, 'base64'));
      } else {
        res.end();
      }
      activeTunnels.delete(tunnelId);
    }
  };
  activeTunnels.set(tunnelId, { res, handler: responseHandler });
});

// HTTPS CONNECT Tunnel Handling - STICKY to current session device!
localProxyServer.on('connect', (req, clientSocket, head) => {
  const phone = getSessionPhone();
  if (!phone) {
    clientSocket.write('HTTP/1.1 503 No Phone In Pool\r\n\r\n');
    clientSocket.end();
    return;
  }

  const { port, hostname } = url.parse(`//${req.url}`, false, true);
  const targetPort = port || 443;
  const tunnelId = 'tun_' + (++tunnelCounter) + '_' + Date.now();

  activeTunnels.set(tunnelId, clientSocket);

  // If this phone is borrowed from peer node via cluster mesh, route via peerClientWs:
  if (phone.isPeer) {
    if (peerClientWs && peerClientWs.readyState === 1) {
      peerClientWs.send(JSON.stringify({
        type: 'tcp_open',
        tunnelId,
        host: hostname,
        port: targetPort
      }));
    } else {
      clientSocket.write('HTTP/1.1 502 Bad Gateway - Shared Pool Disconnected\r\n\r\n');
      clientSocket.end();
      activeTunnels.delete(tunnelId);
      return;
    }

    clientSocket.on('data', chunk => {
      if (peerClientWs && peerClientWs.readyState === 1) {
        peerClientWs.send(JSON.stringify({
          type: 'tcp_data',
          tunnelId,
          data: chunk.toString('base64')
        }));
      }
    });

    clientSocket.on('close', () => {
      if (peerClientWs && peerClientWs.readyState === 1) {
        peerClientWs.send(JSON.stringify({ type: 'tcp_close', tunnelId }));
      }
      activeTunnels.delete(tunnelId);
    });

    clientSocket.on('error', () => {
      activeTunnels.delete(tunnelId);
    });
    return;
  }

  // Otherwise route directly to real local phone:
  phone.ws.send(JSON.stringify({
    type: 'tcp_open',
    tunnelId,
    host: hostname,
    port: targetPort
  }));

  clientSocket.on('data', chunk => {
    if (phone.ws && phone.ws.readyState === 1) {
      phone.ws.send(JSON.stringify({
        type: 'tcp_data',
        tunnelId,
        data: chunk.toString('base64')
      }));
    }
  });

  clientSocket.on('close', () => {
    if (phone.ws && phone.ws.readyState === 1) {
      phone.ws.send(JSON.stringify({ type: 'tcp_close', tunnelId }));
    }
    activeTunnels.delete(tunnelId);
  });

  clientSocket.on('error', () => {
    activeTunnels.delete(tunnelId);
  });
});

localProxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
  log(`Internal Proxy listening on 127.0.0.1:${PROXY_PORT}`);
});

// 2. HTTP Main Server & Multi-WebSocket Mesh Hub
const mainServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clusterWss = new WebSocketServer({ noServer: true });

mainServer.on('upgrade', (req, socket, head) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;
  if (pathname === '/phone-tunnel') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else if (pathname === '/cluster-tunnel') {
    clusterWss.handleUpgrade(req, socket, head, (ws) => {
      clusterWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

function broadcastRealPhones() {
  const realPhones = Array.from(connectedPhones.values())
    .filter(p => !p.isPeer && p.ws && p.ws.readyState === 1)
    .map(p => ({
      id: p.id,
      name: p.name,
      ip: p.ip,
      location: p.location,
      city: p.city,
      region: p.region,
      country: p.country,
      isp: p.isp,
      connectedAt: p.connectedAt
    }));

  const payload = JSON.stringify({ type: 'pool_sync', phones: realPhones });
  for (const peer of clusterPeers) {
    if (peer.readyState === 1) {
      try { peer.send(payload); } catch (_) {}
    }
  }
}

// Cluster Mesh Server: shares this node's phones with peer nodes
clusterWss.on('connection', (peerWs) => {
  log('[Cluster Mesh] Peer node connected to shared pool tunnel');
  clusterPeers.add(peerWs);
  broadcastRealPhones();

  peerWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'tcp_open') {
        const phone = getRealSessionPhone();
        if (!phone || !phone.ws || phone.ws.readyState !== 1) {
          try { peerWs.send(JSON.stringify({ type: 'tcp_error', tunnelId: msg.tunnelId, error: 'No phone in pool' })); } catch (_) {}
          return;
        }
        peerTunnels.set(msg.tunnelId, peerWs);
        phone.ws.send(JSON.stringify({
          type: 'tcp_open',
          tunnelId: msg.tunnelId,
          host: msg.host,
          port: msg.port
        }));
        return;
      }

      if (msg.type === 'tcp_data') {
        const phone = getRealSessionPhone();
        if (phone && phone.ws && phone.ws.readyState === 1) {
          phone.ws.send(JSON.stringify({
            type: 'tcp_data',
            tunnelId: msg.tunnelId,
            data: msg.data
          }));
        }
        return;
      }

      if (msg.type === 'tcp_close') {
        const phone = getRealSessionPhone();
        if (phone && phone.ws && phone.ws.readyState === 1) {
          phone.ws.send(JSON.stringify({ type: 'tcp_close', tunnelId: msg.tunnelId }));
        }
        peerTunnels.delete(msg.tunnelId);
        return;
      }
    } catch (e) {
      log('[Cluster Mesh] Peer message error:', e.message);
    }
  });

  peerWs.on('close', () => {
    log('[Cluster Mesh] Peer node disconnected from pool tunnel');
    clusterPeers.delete(peerWs);
    for (const [tunId, pWs] of peerTunnels.entries()) {
      if (pWs === peerWs) peerTunnels.delete(tunId);
    }
  });

  peerWs.on('error', () => {
    clusterPeers.delete(peerWs);
  });
});

function handlePeerPoolSync(phones) {
  const hasLocalReal = Array.from(connectedPhones.values()).some(p => !p.isPeer && p.ws && p.ws.readyState === 1);
  if (hasLocalReal) return;

  for (const [id, p] of connectedPhones.entries()) {
    if (p.isPeer) connectedPhones.delete(id);
  }

  if (Array.isArray(phones) && phones.length > 0) {
    for (const p of phones) {
      connectedPhones.set('peer_' + p.id, {
        id: 'peer_' + p.id,
        isPeer: true,
        name: p.name + ' (Shared Cluster Pool)',
        ip: p.ip,
        location: p.location,
        city: p.city,
        region: p.region,
        country: p.country,
        isp: p.isp,
        connectedAt: p.connectedAt
      });
    }
    log(`[Cluster Mesh] Synced ${phones.length} phone(s) from shared cluster pool.`);

    const phone = getSessionPhone();
    if (phone && activePlayingUrl && (!currentBrowser || currentStatus.state === 'idle')) {
      log(`[Cluster Mesh] Phone available from shared pool! Triggering playback for: ${activePlayingUrl}`);
      startPlayback(activePlayingUrl).catch(() => {});
    }
  } else {
    if (activeSessionPhoneId && activeSessionPhoneId.startsWith('peer_')) {
      activeSessionPhoneId = null;
    }
  }
}

function connectToPeerPool() {
  const targetPeer = IS_NODE_2 
    ? 'wss://phone-hub-player.onrender.com/cluster-tunnel' 
    : 'wss://phone-hub-player-2.onrender.com/cluster-tunnel';

  try {
    peerClientWs = new WebSocket(targetPeer);
  } catch (err) {
    setTimeout(connectToPeerPool, 5000);
    return;
  }

  peerClientWs.on('open', () => {
    log(`[Cluster Mesh] Connected to shared pool master: ${targetPeer}`);
  });

  peerClientWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'pool_sync') {
        handlePeerPoolSync(msg.phones);
        return;
      }
      if (msg.type === 'tcp_connected') {
        const clientSocket = activeTunnels.get(msg.tunnelId);
        if (clientSocket && !clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
        return;
      }
      if (msg.type === 'tcp_data') {
        const clientSocket = activeTunnels.get(msg.tunnelId);
        if (clientSocket && !clientSocket.destroyed) {
          clientSocket.write(Buffer.from(msg.data, 'base64'));
        }
        return;
      }
      if (msg.type === 'tcp_close' || msg.type === 'tcp_error') {
        const clientSocket = activeTunnels.get(msg.tunnelId);
        if (clientSocket) {
          clientSocket.end();
          activeTunnels.delete(msg.tunnelId);
        }
        return;
      }
    } catch (_) {}
  });

  peerClientWs.on('close', () => {
    for (const [id, p] of connectedPhones.entries()) {
      if (p.isPeer) connectedPhones.delete(id);
    }
    setTimeout(connectToPeerPool, 4000);
  });

  peerClientWs.on('error', () => {
    try { peerClientWs.close(); } catch (_) {}
  });
}

function extractClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = forwarded.split(',');
    return parts[0].trim();
  }
  return req.socket.remoteAddress || 'Unknown';
}

async function lookupIp(ip) {
  if (!ip || ip === 'Unknown' || ip.startsWith('127.') || ip.startsWith('10.') || ip === '::1') return null;
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,isp,query`, {
      signal: AbortSignal.timeout(3500)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === 'success') {
      return {
        ip: data.query,
        country: data.country,
        countryCode: data.countryCode,
        region: data.regionName,
        city: data.city,
        isp: data.isp
      };
    }
  } catch (_) {}
  return null;
}

wss.on('connection', (ws, req) => {
  const phoneId = 'phone_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const clientIp = extractClientIp(req);
  log(`[Phone Pool] New phone connected from IP: ${clientIp} (ID: ${phoneId})`);

  const phoneRecord = {
    id: phoneId,
    ws,
    name: 'Phone ' + (connectedPhones.size + 1),
    ip: clientIp,
    city: 'Detecting...',
    region: '',
    country: '',
    isp: 'Detecting...',
    location: 'Detecting location...',
    connectedAt: new Date().toISOString()
  };

  connectedPhones.set(phoneId, phoneRecord);

  // Background lookup for client IP if not private
  lookupIp(clientIp).then(info => {
    if (info && phoneRecord.city === 'Detecting...') {
      phoneRecord.ip = info.ip || phoneRecord.ip;
      phoneRecord.city = info.city || '';
      phoneRecord.region = info.region || '';
      phoneRecord.country = info.country || '';
      phoneRecord.isp = info.isp || '';
      phoneRecord.location = [info.city, info.region, info.country].filter(Boolean).join(', ') || 'Unknown';

      // Disconnect immediately if datacenter or Singapore node
      if (isDatacenter(phoneRecord)) {
        log(`[Phone Pool] Rejected & disconnected datacenter/Singapore node: "${phoneRecord.name}" (${phoneRecord.ip}, ${phoneRecord.location})`);
        connectedPhones.delete(phoneId);
        try { ws.close(1008, 'Datacenter/Singapore nodes are blocked'); } catch (_) {}
        broadcastRealPhones();
      } else {
        broadcastRealPhones();
      }
    }
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Handle Phone Identification & Geolocation Info
      if (msg.type === 'register') {
        const p = connectedPhones.get(phoneId);
        if (p) {
          if (msg.name) p.name = msg.name;
          if (msg.ipInfo) {
            p.ip = msg.ipInfo.ip || p.ip;
            p.city = msg.ipInfo.city || '';
            p.region = msg.ipInfo.region || '';
            p.country = msg.ipInfo.country || '';
            p.isp = msg.ipInfo.isp || '';
            p.location = [p.city, p.region, p.country].filter(Boolean).join(', ') || 'Unknown';
          }
          log(`[Phone Pool] Phone registered: "${p.name}" (IP: ${p.ip}, Location: ${p.location}, ISP: ${p.isp})`);

          // Disconnect immediately if datacenter or Singapore node
          if (isDatacenter(p)) {
            log(`[Phone Pool] Rejected & disconnected datacenter/Singapore node: "${p.name}" (${p.ip}, ${p.location})`);
            connectedPhones.delete(phoneId);
            try { ws.close(1008, 'Datacenter/Singapore nodes are blocked'); } catch (_) {}
            broadcastRealPhones();
            return;
          }

          // Broadcast phone update to cluster peers
          broadcastRealPhones();

          // If a residential phone connects and active proxy was empty or datacenter, switch to residential!
          const curActive = connectedPhones.get(activeSessionPhoneId);
          if (!curActive || isDatacenter(curActive)) {
            log(`[Session Proxy] Mobile/Residential device "${p.name}" connected! Pinning session proxy to "${p.name}"...`);
            activeSessionPhoneId = p.id;
            currentStatus.activePhoneUsed = p.name;
            if (activePlayingUrl) {
              startPlayback(activePlayingUrl).catch(() => {});
            }
          }
        }
        ws.send(JSON.stringify({ type: 'registered', phoneId }));
        return;
      }

      // Handle TCP Connection Established
      if (msg.type === 'tcp_connected') {
        const peerWs = peerTunnels.get(msg.tunnelId);
        if (peerWs && peerWs.readyState === 1) {
          peerWs.send(JSON.stringify({ type: 'tcp_connected', tunnelId: msg.tunnelId }));
          return;
        }
        const clientSocket = activeTunnels.get(msg.tunnelId);
        if (clientSocket && !clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
        return;
      }

      // Handle Data arriving from Phone
      if (msg.type === 'tcp_data') {
        const peerWs = peerTunnels.get(msg.tunnelId);
        if (peerWs && peerWs.readyState === 1) {
          peerWs.send(JSON.stringify({ type: 'tcp_data', tunnelId: msg.tunnelId, data: msg.data }));
          return;
        }
        const clientSocket = activeTunnels.get(msg.tunnelId);
        if (clientSocket && !clientSocket.destroyed) {
          clientSocket.write(Buffer.from(msg.data, 'base64'));
        }
        return;
      }

      // Handle TCP Close
      if (msg.type === 'tcp_close') {
        const peerWs = peerTunnels.get(msg.tunnelId);
        if (peerWs && peerWs.readyState === 1) {
          peerWs.send(JSON.stringify({ type: 'tcp_close', tunnelId: msg.tunnelId }));
          peerTunnels.delete(msg.tunnelId);
          return;
        }
        const clientSocket = activeTunnels.get(msg.tunnelId);
        if (clientSocket) {
          clientSocket.end();
          activeTunnels.delete(msg.tunnelId);
        }
        return;
      }

    } catch (e) {
      log('WebSocket message parsing error:', e.message);
    }
  });

  ws.on('close', () => {
    log(`[Phone Pool] Phone disconnected (ID: ${phoneId})`);
    connectedPhones.delete(phoneId);
    broadcastRealPhones();
    if (activeSessionPhoneId === phoneId) {
      log(`[Session Proxy] Active phone disconnected! Failover to another device...`);
      activeSessionPhoneId = null;
      const nextPhone = getSessionPhone();
      if (nextPhone && activePlayingUrl) {
        log(`[Session Proxy] Failover to "${nextPhone.name}". Restarting playback...`);
        startPlayback(activePlayingUrl).catch(() => {});
      }
    }
  });

  ws.on('error', (err) => {
    log(`[Phone Pool] Error on phone ${phoneId}: ${err.message}`);
    connectedPhones.delete(phoneId);
    broadcastRealPhones();
  });
});

// Minimal Chromium flags
const MINIMAL_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--single-process',
  '--disable-extensions',
  '--disable-software-rasterizer',
  '--mute-audio',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--metrics-recording-only',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-blink-features=AutomationControlled',
  '--window-size=1280,720',
  `--proxy-server=http://127.0.0.1:${PROXY_PORT}` // Routes Chromium directly through the Phone Pool!
];

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyDJ349vwNR3MgXRGAzRRS3rQPgV0ETaBlo';

function extractVideoId(rawUrl) {
  if (!rawUrl) return null;
  const m = rawUrl.match(/(?:watch\?v=|live\/|embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function fetchVideoDetails(videoId) {
  if (!videoId || !YOUTUBE_API_KEY) return null;
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`, {
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      const item = data.items[0];
      return {
        id: videoId,
        title: item.snippet ? item.snippet.title : null,
        channel: item.snippet ? item.snippet.channelTitle : null,
        thumbnail: item.snippet && item.snippet.thumbnails ? (item.snippet.thumbnails.medium || item.snippet.thumbnails.default).url : null,
        isLive: item.snippet ? item.snippet.liveBroadcastContent === 'live' : false
      };
    }
  } catch (_) {}
  return null;
}

function normalizeYouTubeUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  let url = rawUrl.trim();
  url = url.replace('https://m.youtube.com/', 'https://www.youtube.com/');
  url = url.replace('http://m.youtube.com/', 'https://www.youtube.com/');
  const match = url.match(/youtube\.com\/live\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return url;
}

function sanitizeCookies(raw) {
  if (!Array.isArray(raw)) return [];
  const list = [];
  for (const c of raw) {
    if (!c.name || !c.value) continue;
    let rawDomain = c.domain || '.youtube.com';
    let cleanDomain = rawDomain.startsWith('.') ? rawDomain : ('.' + rawDomain);

    const item = {
      name: c.name,
      value: c.value,
      domain: cleanDomain,
      path: c.path || '/',
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure)
    };
    if (c.expirationDate) item.expires = Math.floor(c.expirationDate);
    if (c.sameSite) {
      const s = String(c.sameSite).toLowerCase();
      if (s === 'no_restriction' || s === 'none') {
        item.sameSite = 'None';
        item.secure = true;
      } else if (s === 'strict') {
        item.sameSite = 'Strict';
      } else if (s === 'lax') {
        item.sameSite = 'Lax';
      }
    }
    list.push(item);

    // Also duplicate to .google.com so Google SSO recognizes the session
    if (cleanDomain.includes('youtube.com')) {
      list.push({ ...item, domain: '.google.com' });
    }
  }
  return list;
}

function getCookies() {
  try {
    if (process.env.COOKIES_JSON) return JSON.parse(process.env.COOKIES_JSON);
    const p = path.join(__dirname, 'cookies.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    log('Error loading cookies:', e.message);
  }
  return [];
}

let currentBrowser = null;
let currentPage = null;
let activePlayingUrl = null;
let isStarting = false;
let currentStatus = {
  state: 'idle',
  url: null,
  title: null,
  phonesOnline: 0,
  isLoggedIn: false,
  startedAt: null,
  lastScanAt: null
};

async function closeBrowserSession() {
  if (currentBrowser) {
    log('Closing browser session to free memory...');
    try { await currentBrowser.close(); } catch (e) {}
    currentBrowser = null;
    currentPage = null;
    activePlayingUrl = null;
    currentStatus.state = 'idle';
    currentStatus.url = null;
    currentStatus.title = null;
    currentStatus.isLoggedIn = false;
    currentStatus.startedAt = null;
  }
}

async function startPlayback(rawUrl) {
  if (isStarting) return;
  isStarting = true;

  const targetUrl = normalizeYouTubeUrl(rawUrl);
  activePlayingUrl = targetUrl;
  await closeBrowserSession();

  try {
    const availablePhone = getSessionPhone();
    if (!availablePhone) {
      log('[Playback Warning] No phone connected in the pool! Waiting for a phone to connect...');
      return;
    }

    activeSessionPhoneId = availablePhone.id;
    currentStatus.activePhoneUsed = availablePhone.name;

    log(`Starting playback session for: ${targetUrl} via phone: "${availablePhone.name}" (${availablePhone.ip})`);

    currentBrowser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: MINIMAL_ARGS,
      defaultViewport: { width: 1280, height: 720 }
    });

    currentPage = await currentBrowser.newPage();

    await currentPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await currentPage.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    // Inject Cookies via CDP Network.setCookies and page.setCookie
    const cookies = sanitizeCookies(getCookies());
    const hasSid = cookies.some(c => c.name === 'SID');
    const hasHsid = cookies.some(c => c.name === 'HSID');
    const hasLoginInfo = cookies.some(c => c.name === 'LOGIN_INFO');
    log(`[Auth] Injecting ${cookies.length} cookies. (SID: ${hasSid}, HSID: ${hasHsid}, LOGIN_INFO: ${hasLoginInfo})`);

    try {
      const cdpClient = await currentPage.target().createCDPSession();
      await cdpClient.send('Network.setCookies', { cookies });
      log(`[Auth] Injected ${cookies.length} cookies directly via CDP Network.setCookies.`);
    } catch (cdpErr) {
      log(`[Auth Warning] CDP failed: ${cdpErr.message}, falling back to page.setCookie...`);
      for (const c of cookies) {
        try {
          await currentPage.setCookie(c);
        } catch (err) {
          log(`[Cookie Error] Failed to set ${c.name} (${c.domain}): ${err.message}`);
        }
      }
    }

    // Block heavy assets (allow user profile avatar icons)
    await currentPage.setRequestInterception(true);
    currentPage.on('request', (req) => {
      const type = req.resourceType();
      const reqUrl = req.url();
      if (reqUrl.includes('yt3.ggpht.com') || reqUrl.includes('googleusercontent.com')) {
        return req.continue();
      }
      if (['image', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    log(`Navigating to ${targetUrl} through Phone Tunnel (${availablePhone.name})...`);
    try {
      await currentPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (navErr) {
      log(`Navigation note (${navErr.message}) - continuing...`);
    }

    // Dismiss popups
    await currentPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, ytd-button-renderer'));
      for (const btn of buttons) {
        const txt = (btn.innerText || '').toLowerCase();
        if (txt.includes('accept') || txt.includes('agree') || txt.includes('dismiss')) {
          btn.click();
          break;
        }
      }
    }).catch(() => {});

    await currentPage.waitForSelector('video', { timeout: 30000 }).catch(() => {});

    // Force 144p & play & detect login
    const evalResult = await currentPage.evaluate(() => {
      const largeBtn = document.querySelector('.ytp-large-play-button');
      if (largeBtn) largeBtn.click();
      const v = document.querySelector('video');
      let playStarted = false;
      if (v) {
        v.muted = true;
        v.play().catch(() => {});
        playStarted = !v.paused;
      }
      const p = document.getElementById('movie_player');
      if (p) {
        if (p.playVideo) p.playVideo();
        if (p.setPlaybackQualityRange) p.setPlaybackQualityRange('tiny', 'tiny');
      }

      const ytcfgLoggedIn = (typeof window.ytcfg !== 'undefined' && window.ytcfg.get) ? Boolean(window.ytcfg.get('LOGGED_IN')) : false;
      const avatar = document.querySelector('button#avatar-btn, #avatar-btn, ytd-masthead #avatar-btn, yt-img-shadow#avatar, ytd-topbar-menu-button-renderer img, img.yt-spec-avatar-shape__image, .yt-spec-avatar-shape');
      const signInBtn = document.querySelector('a[href*="accounts.google.com/ServiceLogin"], ytd-button-renderer a[href*="signin"], #buttons ytd-button-renderer a');
      const isLoggedIn = ytcfgLoggedIn || (!!avatar && !signInBtn);

      return {
        playStarted,
        isLoggedIn,
        ytcfgLoggedIn,
        hasAvatar: !!avatar,
        hasSignIn: !!signInBtn,
        title: document.title
      };
    }).catch(e => ({ error: e.message }));

    const videoId = extractVideoId(targetUrl);
    const videoMeta = await fetchVideoDetails(videoId);
    const title = (videoMeta && videoMeta.title) || evalResult.title || (await currentPage.title().catch(() => targetUrl));
    activePlayingUrl = targetUrl;
    currentStatus = {
      state: 'playing',
      url: targetUrl,
      title: title,
      videoDetails: videoMeta,
      phonesOnline: connectedPhones.size,
      activePhoneUsed: availablePhone.name,
      activeSessionPhoneId: availablePhone.id,
      isLoggedIn: Boolean(evalResult.isLoggedIn || evalResult.hasAvatar),
      startedAt: new Date().toISOString(),
      lastScanAt: new Date().toISOString()
    };

    log(`>>> Playback Verified! Title: "${title}". Phone: "${availablePhone.name}" (${availablePhone.ip}). LoggedIn: ${currentStatus.isLoggedIn}. 144p Forced. <<<`);

  } catch (err) {
    log(`Playback error: ${err.message}`);
    await closeBrowserSession();
  } finally {
    isStarting = false;
  }
}

async function keepVideoPlaying() {
  if (currentPage && !currentPage.isClosed()) {
    try {
      await currentPage.evaluate(() => {
        // Auto skip video ads
        const skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern, button.ytp-ad-skip-button-text, .ytp-ad-preview-container');
        if (skipBtn) skipBtn.click();

        // Dismiss overlay popups / promos
        const popups = document.querySelectorAll('tp-yt-paper-dialog button, ytd-button-renderer#dismiss-button');
        popups.forEach(b => b.click());

        const v = document.querySelector('video');
        if (v && v.paused) {
          v.muted = true;
          v.play().catch(() => {});
        }
        const p = document.getElementById('movie_player');
        if (p) {
          if (p.playVideo) p.playVideo();
          if (p.setPlaybackQualityRange) p.setPlaybackQualityRange('tiny', 'tiny');
        }
      });
      await currentPage.keyboard.press('k').catch(() => {});
    } catch (e) {}
  }
}

// 60-second scan loop
async function scanApiQueue() {
  currentStatus.lastScanAt = new Date().toISOString();
  currentStatus.phonesOnline = connectedPhones.size;
  const freshUrl = `${VERCEL_API_URL}?t=${Date.now()}`;

  try {
    const res = await fetch(freshUrl, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Accept': 'application/json' }
    });

    if (!res.ok) return;

    const data = await res.json();
    const rawTarget = data && data.url ? data.url.trim() : null;
    const targetUrl = normalizeYouTubeUrl(rawTarget);

    if (!targetUrl) {
      if (currentBrowser) {
        log('URL in API is empty. Closing browser to go idle.');
        await closeBrowserSession();
      }
      return;
    }

    if (activePlayingUrl === targetUrl && currentBrowser) {
      await keepVideoPlaying();
    } else {
      log(`Target URL detected: ${targetUrl}. Checking phone pool...`);
      await startPlayback(targetUrl);
    }

  } catch (err) {
    log(`Auto-Scan failed: ${err.message}`);
  }
}

setInterval(scanApiQueue, SCAN_INTERVAL_MS);
setTimeout(scanApiQueue, 4000);

app.use(express.static(path.join(__dirname, 'public')));

// Stream control endpoints
app.post('/api/stream', async (req, res) => {
  try {
    const rawUrl = req.body && req.body.url ? req.body.url.trim() : '';
    if (rawUrl) {
      await fetch(VERCEL_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawUrl })
      });
      setTimeout(scanApiQueue, 300);
      return res.json({ success: true, url: rawUrl });
    } else {
      await fetch(VERCEL_API_URL, { method: 'DELETE' });
      setTimeout(scanApiQueue, 300);
      return res.json({ success: true, url: null });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stream', async (req, res) => {
  try {
    await fetch(VERCEL_API_URL, { method: 'DELETE' });
    setTimeout(scanApiQueue, 300);
    res.json({ success: true, url: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Switch pinned device endpoint
app.post('/api/select-phone', async (req, res) => {
  const { phoneId } = req.body || {};
  if (!phoneId || !connectedPhones.has(phoneId)) {
    return res.status(404).json({ error: 'Device not found in pool' });
  }
  const chosen = connectedPhones.get(phoneId);
  activeSessionPhoneId = phoneId;
  currentStatus.activePhoneUsed = chosen.name;
  log(`[Device Switch] Manually pinned browser session to "${chosen.name}" (${chosen.ip})`);

  if (activePlayingUrl) {
    const url = activePlayingUrl;
    startPlayback(url).catch(() => {});
  }
  res.json({ success: true, activePhone: chosen.name, phoneId: chosen.id });
});

// JSON Status endpoint
app.get('/api/status', (req, res) => {
  const activePhone = getSessionPhone();
  const phoneList = Array.from(connectedPhones.values()).map(p => ({
    id: p.id,
    name: p.name,
    ip: p.ip,
    location: p.location,
    city: p.city,
    region: p.region,
    country: p.country,
    isp: p.isp,
    isDatacenter: isDatacenter(p),
    isActive: activeSessionPhoneId === p.id,
    connectedAt: p.connectedAt
  }));

  res.json({
    service: 'Render Multi-Phone YouTube Player Hub',
    status: currentStatus,
    activePlayingUrl,
    activeSessionPhoneId,
    activePhoneUsed: activePhone ? activePhone.name : null,
    phonesOnlineCount: phoneList.length,
    connectedPhones: phoneList,
    scanInterval: '60 seconds'
  });
});

// GUI and phone endpoints
app.get('/', (req, res) => {
  if (req.query.json === '1' || req.headers.accept === 'application/json') {
    return res.redirect('/api/status');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/phones', (req, res) => {
  if (req.query.json === '1' || req.headers.accept === 'application/json') {
    const activePhone = getSessionPhone();
    const phoneList = Array.from(connectedPhones.values()).map(p => ({
      id: p.id,
      name: p.name,
      ip: p.ip,
      location: p.location,
      city: p.city,
      region: p.region,
      country: p.country,
      isp: p.isp,
      isDatacenter: isDatacenter(p),
      isActive: activeSessionPhoneId === p.id,
      connectedAt: p.connectedAt
    }));
    return res.json({ count: phoneList.length, phones: phoneList });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Disconnect / kick a phone from the pool
app.delete('/api/phones/:id', (req, res) => {
  const { id } = req.params;
  if (!connectedPhones.has(id)) {
    return res.status(404).json({ error: 'Device not found in pool' });
  }
  const p = connectedPhones.get(id);
  log(`[Phone Pool] Kicking device "${p.name}" (${p.ip}) by user request.`);
  try { p.ws.close(1000, 'Kicked by user'); } catch(_) {}
  connectedPhones.delete(id);
  if (activeSessionPhoneId === id) {
    activeSessionPhoneId = null;
    const nextPhone = getSessionPhone();
    if (nextPhone && activePlayingUrl) {
      startPlayback(activePlayingUrl).catch(() => {});
    }
  }
  res.json({ success: true, removed: p.name });
});

app.get('/api/auth-debug', async (req, res) => {
  if (!currentPage || currentPage.isClosed()) {
    return res.json({ error: 'No page active' });
  }
  try {
    const info = await currentPage.evaluate(() => {
      const signInBtn = document.querySelector('a[href*="accounts.google.com/ServiceLogin"], ytd-button-renderer a[href*="signin"], #buttons ytd-button-renderer a');
      const avatarBtn = document.querySelector('button#avatar-btn, #avatar-btn, ytd-masthead #avatar-btn, yt-img-shadow#avatar, ytd-topbar-menu-button-renderer img');
      const masthead = document.querySelector('ytd-masthead') ? document.querySelector('ytd-masthead').innerText : 'No masthead';
      return {
        title: document.title,
        url: window.location.href,
        hasSignInButton: !!signInBtn,
        signInButtonText: signInBtn ? signInBtn.innerText : null,
        hasAvatarButton: !!avatarBtn,
        cookiesInDocument: document.cookie.split(';').map(s => s.trim().split('=')[0]),
        mastheadSnippet: masthead.slice(0, 300)
      };
    });
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/logs', (req, res) => {
  res.type('text/plain').send(logBuffer.join('\n'));
});

let isTakingScreenshot = false;
let lastScreenshotBuffer = null;
let lastScreenshotTime = 0;

app.get('/screenshot', async (req, res) => {
  if (!currentPage || currentPage.isClosed()) {
    return res.status(404).send('No active playback. Render is currently idle.');
  }

  const now = Date.now();
  if (lastScreenshotBuffer && (now - lastScreenshotTime < 2500)) {
    res.set('Content-Type', 'image/jpeg');
    return res.send(lastScreenshotBuffer);
  }

  if (isTakingScreenshot && lastScreenshotBuffer) {
    res.set('Content-Type', 'image/jpeg');
    return res.send(lastScreenshotBuffer);
  }

  try {
    isTakingScreenshot = true;
    const screenshot = await currentPage.screenshot({ type: 'jpeg', quality: 50 });
    lastScreenshotBuffer = screenshot;
    lastScreenshotTime = Date.now();
    res.set('Content-Type', 'image/jpeg');
    res.send(screenshot);
  } catch (err) {
    if (lastScreenshotBuffer) {
      res.set('Content-Type', 'image/jpeg');
      return res.send(lastScreenshotBuffer);
    }
    res.status(500).json({ error: 'Screenshot error: ' + err.message });
  } finally {
    isTakingScreenshot = false;
  }
});

mainServer.listen(PORT, () => {
  log(`Render Multi-Phone Hub running on port ${PORT}`);
  setTimeout(connectToPeerPool, 2500);
});
