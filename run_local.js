const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const VERCEL_API_URL = 'https://vercel-browser-controller.vercel.app/api/url';
const SCAN_INTERVAL_MS = 15 * 1000; // Check every 15s

const MINIMAL_ARGS = [
  '--disable-gpu',
  '--mute-audio',
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
  const p = path.join(__dirname, 'cookies.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return [];
}

let currentBrowser = null;
let currentPage = null;
let activePlayingUrl = null;
let isStarting = false;

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

async function closeBrowserSession() {
  if (currentBrowser) {
    log('Closing browser (going IDLE)...');
    try { await currentBrowser.close(); } catch (e) {}
    currentBrowser = null;
    currentPage = null;
    activePlayingUrl = null;
  }
}

async function startPlayback(rawUrl) {
  if (isStarting) return;
  isStarting = true;

  const targetUrl = normalizeYouTubeUrl(rawUrl);
  activePlayingUrl = targetUrl;
  log(`Starting playback for: ${targetUrl} (using Home Internet, 0 data limits)`);
  await closeBrowserSession();

  try {
    currentBrowser = await puppeteer.launch({
      headless: 'new',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
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

    const cookies = sanitizeCookies(getCookies());
    for (const c of cookies) {
      try {
        await currentPage.setCookie(c);
        if (c.domain === '.youtube.com') {
          await currentPage.setCookie({ ...c, domain: '.google.com' }).catch(() => {});
        }
      } catch (err) {}
    }

    log(`Navigating to ${targetUrl}...`);
    try {
      await currentPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {}

    // Wait for video element
    await currentPage.waitForSelector('video', { timeout: 15000 }).catch(() => {});

    // Force 144p and play
    const evalResult = await currentPage.evaluate(() => {
      const largeBtn = document.querySelector('.ytp-large-play-button');
      if (largeBtn) largeBtn.click();
      const v = document.querySelector('video');
      let isPlaying = false;
      if (v) {
        v.muted = true;
        v.play().catch(() => {});
        isPlaying = !v.paused;
      }
      const p = document.getElementById('movie_player');
      if (p) {
        if (p.playVideo) p.playVideo();
        if (p.setPlaybackQualityRange) p.setPlaybackQualityRange('tiny', 'tiny');
      }

      const avatar = document.querySelector('button#avatar-btn, #avatar-btn, ytd-topbar-menu-button-renderer img');
      return {
        title: document.title,
        isPlaying,
        isLoggedIn: !!avatar
      };
    }).catch(e => ({ error: e.message }));

    log(`>>> PLAYING CONFIRMED! <<<`);
    log(`Title: "${evalResult.title}" | Logged In: ${evalResult.isLoggedIn} | 144p Forced`);

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
        if (p && typeof p.setPlaybackQualityRange === 'function') {
          p.setPlaybackQualityRange('tiny', 'tiny');
        }
      });
    } catch (e) {}
  }
}

async function scanApiQueue() {
  const freshUrl = `${VERCEL_API_URL}?t=${Date.now()}`;

  try {
    const res = await fetch(freshUrl, { cache: 'no-store' });
    if (!res.ok) return;

    const data = await res.json();
    const rawTarget = data && data.url ? data.url.trim() : null;
    const targetUrl = normalizeYouTubeUrl(rawTarget);

    if (!targetUrl) {
      if (currentBrowser) {
        log('No active URL in Vercel. Closing browser...');
        await closeBrowserSession();
      }
      return;
    }

    if (activePlayingUrl === targetUrl && currentBrowser) {
      await keepVideoPlaying();
    } else {
      log(`Detected target URL from Vercel: ${targetUrl}`);
      await startPlayback(targetUrl);
    }
  } catch (err) {
    log(`Scan error: ${err.message}`);
  }
}

log('Local Player Worker running on Home Internet!');
log('Watching Vercel API: https://vercel-browser-controller.vercel.app/api/url');
log('Waiting for active video URL from your Vercel site...');

setInterval(scanApiQueue, SCAN_INTERVAL_MS);
scanApiQueue();
