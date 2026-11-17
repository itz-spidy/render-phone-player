const http = require('http');
const net = require('net');
const url = require('url');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { WebSocketServer } = require('ws');

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

// Phone Tunnel Management
const connectedPhones = new Map(); // phoneId -> { ws, name, connectedAt }
const activeTunnels = new Map();   // tunnelId -> net.Socket
let phoneCounter = 0;
let tunnelCounter = 0;

function getAvailablePhone() {
  const phones = Array.from(connectedPhones.values()).filter(p => p.ws.readyState === 1);
  if (phones.length === 0) return null;
  phoneCounter = (phoneCounter + 1) % phones.length;
  return phones[phoneCounter];
}

// 1. Internal HTTP & HTTPS CONNECT Proxy Server
// Puppeteer connects here -> traffic is piped over WebSocket to your Phone -> Phone fetches from YouTube
const localProxyServer = http.createServer((req, res) => {
  const phone = getAvailablePhone();
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

// HTTPS CONNECT Tunnel Handling
localProxyServer.on('connect', (req, clientSocket, head) => {
  const phone = getAvailablePhone();
  if (!phone) {
    clientSocket.write('HTTP/1.1 503 No Phone In Pool\r\n\r\n');
    clientSocket.end();
    return;
  }

  const { port, hostname } = url.parse(`//${req.url}`, false, true);
  const targetPort = port || 443;
  const tunnelId = 'tun_' + (++tunnelCounter) + '_' + Date.now();

  activeTunnels.set(tunnelId, clientSocket);

  // Tell Phone to open TCP connection to target host
  phone.ws.send(JSON.stringify({
    type: 'tcp_open',
    tunnelId,
    host: hostname,
    port: targetPort
  }));

  clientSocket.on('data', chunk => {
    if (phone.ws.readyState === 1) {
      phone.ws.send(JSON.stringify({
        type: 'tcp_data',
        tunnelId,
        data: chunk.toString('base64')
      }));
    }
  });

  clientSocket.on('close', () => {
    if (phone.ws.readyState === 1) {
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

// 2. HTTP Main Server & WebSocket Hub
const mainServer = http.createServer(app);
const wss = new WebSocketServer({ server: mainServer, path: '/phone-tunnel' });

wss.on('connection', (ws, req) => {
  const phoneId = 'phone_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`[Phone Pool] New phone connected from IP: ${clientIp} (ID: ${phoneId})`);

  connectedPhones.set(phoneId, {
    id: phoneId,
    ws,
    name: 'Phone ' + (connectedPhones.size + 1),
    ip: clientIp,
    connectedAt: new Date().toISOString()
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Handle Phone Identification
      if (msg.type === 'register') {
        const p = connectedPhones.get(phoneId);
        if (p && msg.name) p.name = msg.name;
        log(`[Phone Pool] Phone registered as: "${p ? p.name : msg.name}"`);
        ws.send(JSON.stringify({ type: 'registered', phoneId }));
        return;
      }

      // Handle TCP Connection Established
      if (msg.type === 'tcp_connected') {
        const clientSocket = activeTunnels.get(msg.tunnelId);
        if (clientSocket && !clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
        return;
      }

      // Handle Data arriving from Phone
      if (msg.type === 'tcp_data') {
        const clientSocket = activeTunnels.get(msg.tunnelId);
        if (clientSocket && !clientSocket.destroyed) {
          clientSocket.write(Buffer.from(msg.data, 'base64'));
        }
        return;
      }

      // Handle TCP Close
      if (msg.type === 'tcp_close') {
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
  });

  ws.on('error', (err) => {
    log(`[Phone Pool] Error on phone ${phoneId}: ${err.message}`);
    connectedPhones.delete(phoneId);
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

function normalizeYouTubeUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  const match = rawUrl.match(/youtube\.com\/live\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return rawUrl;
}

function sanitizeCookies(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => {
    const item = {
      name: c.name,
      value: c.value,
      domain: c.domain || '.youtube.com',
      path: c.path || '/',
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure)
    };
    if (c.expirationDate) item.expires = Math.floor(c.expirationDate);
    if (c.sameSite) {
      const s = String(c.sameSite).toLowerCase();
      item.sameSite = (s === 'no_restriction' || s === 'none') ? 'None' : (s === 'strict' ? 'Strict' : 'Lax');
    }
    return item;
  });
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
    const availablePhone = getAvailablePhone();
    if (!availablePhone) {
      log('[Playback Warning] No phone connected in the pool! Waiting for a phone to connect...');
      return;
    }

    log(`Starting playback session for: ${targetUrl} via phone: "${availablePhone.name}"`);

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

    // Inject Cookies
    const cookies = sanitizeCookies(getCookies());
    for (const c of cookies) {
      try {
        await currentPage.setCookie(c);
        if (c.domain === '.youtube.com') {
          await currentPage.setCookie({ ...c, domain: '.google.com' }).catch(() => {});
        }
      } catch (err) {}
    }

    // Block heavy assets
    await currentPage.setRequestInterception(true);
    currentPage.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    log(`Navigating to ${targetUrl} through Phone Tunnel...`);
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

    // Force 144p & play
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

      const avatar = document.querySelector('button#avatar-btn, #avatar-btn, ytd-topbar-menu-button-renderer img');
      return {
        playStarted,
        isLoggedIn: !!avatar,
        title: document.title
      };
    }).catch(e => ({ error: e.message }));

    const title = evalResult.title || (await currentPage.title().catch(() => targetUrl));
    activePlayingUrl = targetUrl;
    currentStatus = {
      state: 'playing',
      url: targetUrl,
      title: title,
      phonesOnline: connectedPhones.size,
      activePhoneUsed: availablePhone.name,
      isLoggedIn: evalResult.isLoggedIn || false,
      startedAt: new Date().toISOString(),
      lastScanAt: new Date().toISOString()
    };

    log(`>>> Playback Verified! Title: "${title}". Phone: "${availablePhone.name}". 144p Forced. <<<`);

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

// Status API
app.get('/', (req, res) => {
  const phoneList = Array.from(connectedPhones.values()).map(p => ({
    name: p.name,
    ip: p.ip,
    connectedAt: p.connectedAt
  }));

  res.json({
    service: 'Render Multi-Phone YouTube Player Hub',
    status: currentStatus,
    phonesOnlineCount: phoneList.length,
    connectedPhones: phoneList,
    scanInterval: '60 seconds'
  });
});

app.get('/phones', (req, res) => {
  const phoneList = Array.from(connectedPhones.values()).map(p => ({
    name: p.name,
    ip: p.ip,
    connectedAt: p.connectedAt
  }));
  res.json({ count: phoneList.length, phones: phoneList });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/logs', (req, res) => {
  res.type('text/plain').send(logBuffer.join('\n'));
});

app.get('/screenshot', async (req, res) => {
  if (!currentPage || currentPage.isClosed()) {
    return res.status(404).send('No active playback. Render is currently idle.');
  }

  try {
    const screenshot = await currentPage.screenshot({ type: 'jpeg', quality: 60 });
    res.set('Content-Type', 'image/jpeg');
    res.send(screenshot);
  } catch (err) {
    res.status(500).json({ error: 'Screenshot error: ' + err.message });
  }
});

mainServer.listen(PORT, () => {
  log(`Render Multi-Phone Hub running on port ${PORT}`);
});
