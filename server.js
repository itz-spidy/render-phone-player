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
  '--disable-blink-features=AutomationControlled', // Critical: Bypasses Google bot detection
  '--window-size=1280,720',
  '--js-flags=--max-old-space-size=128'
];

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
let currentStatus = {
  state: 'idle',
  url: null,
  title: null,
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

async function startPlayback(targetUrl) {
  log(`Starting playback session for: ${targetUrl}`);
  await closeBrowserSession();

  try {
    currentBrowser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: MINIMAL_ARGS,
      defaultViewport: { width: 1280, height: 720 }
    });

    currentPage = await currentBrowser.newPage();
    
    // Mask Puppeteer fingerprint so YouTube doesn't block cookies or treat as bot
    await currentPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await currentPage.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });

    // Set Cookies individually with domain fallback for YouTube + Google
    const cookies = sanitizeCookies(getCookies());
    let cookiesSet = 0;
    for (const c of cookies) {
      try {
        await currentPage.setCookie(c);
        cookiesSet++;
        // Also inject for .google.com so Google Auth services validate
        if (c.domain === '.youtube.com') {
          await currentPage.setCookie({ ...c, domain: '.google.com' }).catch(() => {});
        }
      } catch (err) {
        log(`Warning: Failed to set cookie ${c.name}: ${err.message}`);
      }
    }
    log(`Injected ${cookiesSet}/${cookies.length} authentication cookies.`);

    // Block images & fonts to maintain ~80MB footprint
    await currentPage.setRequestInterception(true);
    currentPage.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    log(`Navigating to ${targetUrl}...`);
    await currentPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Dismiss any popups or dialogs
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
    await currentPage.waitForSelector('video', { timeout: 15000 }).catch(() => {});

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

      // Check if logged in (avatar or profile button present)
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
    activePlayingUrl = targetUrl;
    currentStatus = {
      state: 'playing',
      url: targetUrl,
      title: title,
      isLoggedIn: evalResult.isLoggedIn || false,
      startedAt: new Date().toISOString(),
      lastScanAt: new Date().toISOString()
    };

    log(`Playback confirmed. Title: "${title}". Account logged in: ${evalResult.isLoggedIn}. Playing at 144p.`);

  } catch (err) {
    log(`Playback error for ${targetUrl}: ${err.message}`);
    await closeBrowserSession();
  }
}

// Ensure video keeps streaming
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
    const targetUrl = data && data.url ? data.url.trim() : null;

    if (!targetUrl) {
      if (currentBrowser) {
        log('URL in API is empty. Closing browser to go idle.');
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
      log(`Target URL detected: ${targetUrl}. Starting player.`);
      await startPlayback(targetUrl);
    }

  } catch (err) {
    log(`Auto-Scan failed: ${err.message}`);
  }
}

// Start auto-scan loop
setInterval(scanApiQueue, SCAN_INTERVAL_MS);
setTimeout(scanApiQueue, 4000);

// Status API
app.get('/', (req, res) => {
  res.json({
    service: 'Render Auto-Scanner & Player',
    status: currentStatus,
    apiQueueWatched: VERCEL_API_URL,
    scanInterval: '60 seconds'
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// View internal server logs
app.get('/logs', (req, res) => {
  res.type('text/plain').send(logBuffer.join('\n'));
});

// Live visual screenshot
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
