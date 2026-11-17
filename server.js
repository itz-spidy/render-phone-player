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
const SCAN_INTERVAL_MS = 60 * 1000; // Scan every 60 seconds

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
    console.error('Error loading cookies:', e.message);
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
  startedAt: null,
  lastScanAt: null
};

async function closeBrowserSession() {
  if (currentBrowser) {
    console.log('[Browser] Closing browser session to free resources...');
    try { await currentBrowser.close(); } catch (e) {}
    currentBrowser = null;
    currentPage = null;
    activePlayingUrl = null;
    currentStatus.state = 'idle';
    currentStatus.url = null;
    currentStatus.title = null;
    currentStatus.startedAt = null;
  }
}

async function startPlayback(targetUrl) {
  console.log(`[Playback] Launching browser for: ${targetUrl}`);
  await closeBrowserSession();

  try {
    currentBrowser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: MINIMAL_ARGS,
      defaultViewport: { width: 1280, height: 720 }
    });

    currentPage = await currentBrowser.newPage();
    await currentPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Set Cookies
    const cookies = sanitizeCookies(getCookies());
    if (cookies.length > 0) {
      await currentPage.setCookie(...cookies);
    }

    // Block images & fonts
    await currentPage.setRequestInterception(true);
    currentPage.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await currentPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

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

    await currentPage.waitForSelector('video', { timeout: 10000 }).catch(() => {});

    // Force 144p & play
    await currentPage.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.muted = true;
        v.play().catch(() => {});
      }
      const p = document.getElementById('movie_player');
      if (p && typeof p.setPlaybackQualityRange === 'function') {
        p.setPlaybackQualityRange('tiny', 'tiny');
      }
    }).catch(() => {});

    const title = await currentPage.title();

    activePlayingUrl = targetUrl;
    currentStatus = {
      state: 'playing',
      url: targetUrl,
      title: title,
      startedAt: new Date().toISOString(),
      lastScanAt: new Date().toISOString()
    };
    console.log(`[Playback] Verified playing at 144p: "${title}"`);

  } catch (err) {
    console.error('[Playback] Error starting playback:', err.message);
    await closeBrowserSession();
  }
}

// Ensure running video stays unpaused
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
        if (p && typeof p.setPlaybackQualityRange === 'function') {
          p.setPlaybackQualityRange('tiny', 'tiny');
        }
      });
    } catch (e) {}
  }
}

// Core Automatic Scan: checks Vercel API every 60 seconds
async function scanApiQueue() {
  currentStatus.lastScanAt = new Date().toISOString();
  console.log(`[Auto-Scan 60s] Checking API at: ${VERCEL_API_URL}`);

  try {
    const res = await fetch(VERCEL_API_URL, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      console.warn(`[Auto-Scan 60s] API returned status ${res.status}`);
      return;
    }

    const data = await res.json();
    const targetUrl = data && data.url ? data.url.trim() : null;

    if (!targetUrl) {
      // No URL present in API -> stay completely idle
      if (currentBrowser) {
        console.log('[Auto-Scan 60s] URL was removed/empty. Closing browser and going idle.');
        await closeBrowserSession();
      } else {
        console.log('[Auto-Scan 60s] No URL in API. Remaining IDLE.');
      }
      return;
    }

    // URL is present
    if (activePlayingUrl === targetUrl && currentBrowser) {
      console.log(`[Auto-Scan 60s] URL unchanged (${targetUrl}). Confirming playback is running...`);
      await keepVideoPlaying();
    } else {
      console.log(`[Auto-Scan 60s] New URL detected: ${targetUrl}. Starting playback.`);
      await startPlayback(targetUrl);
    }

  } catch (err) {
    console.error('[Auto-Scan 60s] Scan error:', err.message);
  }
}

// Start auto-scan loop
setInterval(scanApiQueue, SCAN_INTERVAL_MS);
// Initial scan on startup (after 5s delay)
setTimeout(scanApiQueue, 5000);

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

// Live visual screenshot endpoint
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
  console.log(`Render Auto-Player service running on port ${PORT}`);
});
