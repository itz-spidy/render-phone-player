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
const connectedPhones = new Map(); // phoneId -> { id, ws, name, ip, city, region, country, isp, location, connectedAt }
const activeTunnels = new Map();   // tunnelId -> net.Socket
let tunnelCounter = 0;
let activeSessionPhoneId = null;

function isDatacenter(p) {
  if (!p) return false;
  const s = `${p.isp || ''} ${p.name || ''} ${p.location || ''}`.toLowerCase();
  return s.includes('railway') || s.includes('amazon') || s.includes('aws') || 
         s.includes('google') || s.includes('digitalocean') || s.includes('oracle') || 
         s.includes('azure') || s.includes('linode') || s.includes('hetzner') ||
         s.includes('datacenter') || s.includes('hosting') || s.includes('server');
}

function getSessionPhone() {
  const onlinePhones = Array.from(connectedPhones.values()).filter(p => p.ws && p.ws.readyState === 1);
  if (onlinePhones.length === 0) return null;

  // 1. If currently pinned session phone is still online, USE IT (100% sticky)!
  if (activeSessionPhoneId) {
    const existing = onlinePhones.find(p => p.id === activeSessionPhoneId);
    if (existing) return existing;
  }

  // 2. Otherwise pick the best device: prefer residential/mobile over datacenter
  const residential = onlinePhones.filter(p => !isDatacenter(p));
  const chosen = residential.length > 0 ? residential[0] : onlinePhones[0];

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

          // If a residential phone connects and active proxy was empty or datacenter, switch to residential!
          if (!isDatacenter(p)) {
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
        }
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
    let rawDomain = c.domain || '.youtube.com';
    let cleanHost = rawDomain.replace(/^\./, '');
    let cookieUrl = `https://${cleanHost}`;

    const item = {
      name: c.name,
      value: c.value,
      url: cookieUrl,
      domain: rawDomain.startsWith('.') ? rawDomain : ('.' + rawDomain),
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

    // Inject Cookies
    const cookies = sanitizeCookies(getCookies());
    const hasSid = cookies.some(c => c.name === 'SID');
    const hasHsid = cookies.some(c => c.name === 'HSID');
    const hasLoginInfo = cookies.some(c => c.name === 'LOGIN_INFO');
    log(`[Auth] Injecting ${cookies.length} cookies. (SID: ${hasSid}, HSID: ${hasHsid}, LOGIN_INFO: ${hasLoginInfo})`);

    for (const c of cookies) {
      try {
        await currentPage.setCookie(c);
      } catch (err) {
        log(`[Cookie Error] Failed to set ${c.name} (${c.domain}): ${err.message}`);
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

      const avatar = document.querySelector('button#avatar-btn, #avatar-btn, ytd-masthead #avatar-btn, yt-img-shadow#avatar, ytd-topbar-menu-button-renderer img');
      const signInBtn = document.querySelector('a[href*="accounts.google.com/ServiceLogin"], ytd-button-renderer a[href*="signin"], #buttons ytd-button-renderer a');
      const isLoggedIn = !!avatar && !signInBtn;

      return {
        playStarted,
        isLoggedIn,
        hasAvatar: !!avatar,
        hasSignIn: !!signInBtn,
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
});
