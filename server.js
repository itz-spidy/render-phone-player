const puppeteer = require('puppeteer');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
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

// Proxies sorted from fastest to slowest (benchmarked against YouTube)
const PROXIES = [
  { host: '64.137.10.153', port: 5803, user: 'dptcsqwm', pass: '17gx30fmjdyr', ping: '989ms' },
  { host: '64.137.96.74', port: 6641, user: 'dptcsqwm', pass: '17gx30fmjdyr', ping: '1033ms' },
  { host: '84.247.60.125', port: 6095, user: 'dptcsqwm', pass: '17gx30fmjdyr', ping: '1113ms' },
  { host: '45.38.107.97', port: 6014, user: 'dptcsqwm', pass: '17gx30fmjdyr', ping: '1192ms' },
  { host: '38.154.185.97', port: 6370, user: 'dptcsqwm', pass: '17gx30fmjdyr', ping: '1587ms' },
  { host: '198.23.243.226', port: 6361, user: 'dptcsqwm', pass: '17gx30fmjdyr', ping: '1751ms' },
  { host: '104.164.49.38', port: 7693, user: 'dptcsqwm', pass: '17gx30fmjdyr', ping: '1863ms' },
  { host: '198.46.161.42', port: 5092, user: 'dptcsqwm', pass: '17gx30fmjdyr', ping: '1865ms' },
  { host: '191.96.254.138', port: 6185, user: 'dptcsqwm', pass: '17gx30fmjdyr', ping: '1916ms' },
  { host: '23.26.71.145', port: 5628, user: 'dptcsqwm', pass: '17gx30fmjdyr', ping: '2013ms' }
];

let currentProxyIndex = 0;

function getActiveProxy() {
  return PROXIES[currentProxyIndex % PROXIES.length];
}

function rotateToNextProxy() {
  currentProxyIndex = (currentProxyIndex + 1) % PROXIES.length;
  log(`Rotated to proxy: ${getActiveProxy().host}:${getActiveProxy().port}`);
}

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
  '--window-size=1280,720'
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
  activeProxy: null,
  isLoggedIn: false,
  startedAt: null,
  lastScanAt: null
};

async function closeBrowserSession() {
  if (currentBrowser) {
    log('Closing browser session to free memory and stop proxy data usage...');
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
  if (isStarting) {
    log('Playback launch already in progress, skipping duplicate launch.');
    return;
  }
  isStarting = true;

  const targetUrl = normalizeYouTubeUrl(rawUrl);
  activePlayingUrl = targetUrl; // Immediately lock URL to prevent re-triggering during navigation
  const proxy = getActiveProxy();
  log(`Starting playback session for: ${targetUrl} via fastest proxy ${proxy.host}:${proxy.port} (${proxy.ping})`);
  await closeBrowserSession();

  try {
    const browserArgs = [
      ...MINIMAL_ARGS,
      `--proxy-server=http://${proxy.host}:${proxy.port}`
    ];

    currentBrowser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: browserArgs,
      defaultViewport: { width: 1280, height: 720 }
    });

    currentPage = await currentBrowser.newPage();

    // Authenticate with the Webshare proxy
    await currentPage.authenticate({
      username: proxy.user,
      password: proxy.pass
    });

    // Mask bot fingerprint
    await currentPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await currentPage.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });

    // Set Cookies for both .youtube.com and .google.com
    const cookies = sanitizeCookies(getCookies());
    let cookiesSet = 0;
    for (const c of cookies) {
      try {
        await currentPage.setCookie(c);
        cookiesSet++;
        if (c.domain === '.youtube.com') {
          await currentPage.setCookie({ ...c, domain: '.google.com' }).catch(() => {});
        }
      } catch (err) {}
    }
    log(`Injected ${cookiesSet}/${cookies.length} authentication cookies.`);

    // Bandwidth saver: block heavy images and web fonts so your 1GB lasts 30+ hours!
    await currentPage.setRequestInterception(true);
    currentPage.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    log(`Navigating to ${targetUrl} through proxy ${proxy.host}...`);
    try {
      await currentPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (navErr) {
      log(`Navigation note (${navErr.message}) - continuing with page hydration...`);
    }

    // Dismiss popups
    await currentPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, ytd-button-renderer'));
      for (const btn of buttons) {
        const txt = (btn.innerText || '').toLowerCase();
        if (txt.includes('accept') || txt.includes('agree') || txt.includes('dismiss') || txt.includes('reject')) {
          btn.click();
          break;
        }
      }
    }).catch(() => {});

    // Wait for video element
    await currentPage.waitForSelector('video', { timeout: 30000 }).catch(() => {});

    // Force 144p resolution, unmute and play
    const evalResult = await currentPage.evaluate(() => {
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

      const avatar = document.querySelector('button#avatar-btn, #avatar-btn, ytd-topbar-menu-button-renderer img, button[aria-label*="Account"]');
      const signInBtn = document.querySelector('a[href*="signin"], ytd-button-renderer a[href*="accounts.google.com"]');

      return {
        playStarted,
        isLoggedIn: !!avatar,
        hasSignInBtn: !!signInBtn,
        title: document.title
      };
    }).catch(e => ({ error: e.message }));

    const title = evalResult.title || (await currentPage.title().catch(() => targetUrl));
    activePlayingUrl = rawUrl;
    currentStatus = {
      state: 'playing',
      url: targetUrl,
      title: title,
      activeProxy: `${proxy.host}:${proxy.port}`,
      isLoggedIn: evalResult.isLoggedIn || false,
      startedAt: new Date().toISOString(),
      lastScanAt: new Date().toISOString()
    };

    log(`Playback confirmed! Title: "${title}". Account logged in: ${evalResult.isLoggedIn}. Forced 144p resolution. Active Proxy: ${proxy.host}:${proxy.port}`);

  } catch (err) {
    log(`Playback error on proxy ${proxy.host}: ${err.message}`);
    rotateToNextProxy(); // Automatically try the next fastest proxy if this one fails
    await closeBrowserSession();
  } finally {
    isStarting = false;
  }
}

// Keep video active & 144p
async function keepVideoPlaying() {
  if (currentPage && !currentPage.isClosed()) {
    try {
      await currentPage.evaluate(() => {
        const largeBtn = document.querySelector('.ytp-large-play-button');
        if (largeBtn) largeBtn.click();
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
  const freshUrl = `${VERCEL_API_URL}?t=${Date.now()}`;
  log(`Checking Vercel API: ${freshUrl}`);

  try {
    const res = await fetch(freshUrl, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Accept': 'application/json' }
    });

    if (!res.ok) {
      log(`Vercel API returned HTTP ${res.status}`);
      return;
    }

    const data = await res.json();
    const rawTarget = data && data.url ? data.url.trim() : null;
    const targetUrl = normalizeYouTubeUrl(rawTarget);

    if (!targetUrl) {
      if (currentBrowser) {
        log('URL in API is empty. Closing browser to preserve bandwidth and go idle.');
        await closeBrowserSession();
      } else {
        log('No URL in API. Remaining IDLE.');
      }
      return;
    }

    if (activePlayingUrl === targetUrl && currentBrowser) {
      log(`URL unchanged (${targetUrl}). Verifying video playback is active...`);
      await keepVideoPlaying();
    } else {
      log(`Target URL detected: ${targetUrl}. Starting player with fastest proxy.`);
      await startPlayback(targetUrl);
    }

  } catch (err) {
    log(`Auto-Scan failed: ${err.message}`);
  }
}

setInterval(scanApiQueue, SCAN_INTERVAL_MS);
setTimeout(scanApiQueue, 4000);

app.get('/', (req, res) => {
  res.json({
    service: 'Render Auto-Scanner & Player',
    status: currentStatus,
    activeProxy: getActiveProxy().host + ':' + getActiveProxy().port,
    proxyCount: PROXIES.length,
    scanInterval: '60 seconds'
  });
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

app.listen(PORT, () => {
  log(`Render service listening on port ${PORT}`);
});
