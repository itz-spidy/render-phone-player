const puppeteer = require('puppeteer');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

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
let playbackInterval = null;
let currentStatus = {
  playing: false,
  url: null,
  title: null,
  startedAt: null,
  currentTime: 0,
  duration: 0
};

app.get('/', async (req, res) => {
  let livePlayback = { ...currentStatus };

  if (currentPage && !currentPage.isClosed()) {
    try {
      const realTime = await currentPage.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { currentTime: Math.floor(v.currentTime), paused: v.paused, duration: Math.floor(v.duration || 0) } : null;
      });
      if (realTime) {
        livePlayback.currentTime = realTime.currentTime;
        livePlayback.playing = !realTime.paused;
        livePlayback.duration = realTime.duration;
      }
    } catch (e) {}
  }

  res.json({
    status: 'online',
    message: 'Render YouTube Player',
    currentPlayback: livePlayback
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Live visual proof screenshot endpoint
app.get('/screenshot', async (req, res) => {
  if (!currentPage || currentPage.isClosed()) {
    return res.status(404).send('No active browser playback session.');
  }

  try {
    const screenshot = await currentPage.screenshot({ type: 'jpeg', quality: 60 });
    res.set('Content-Type', 'image/jpeg');
    res.send(screenshot);
  } catch (err) {
    res.status(500).json({ error: 'Failed to capture screenshot: ' + err.message });
  }
});

// Playback Trigger
app.all('/play', async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl && req.body) targetUrl = req.body.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing "url" parameter.' });
  }

  console.log(`[API] Triggering playback for: ${targetUrl}`);

  try {
    if (playbackInterval) {
      clearInterval(playbackInterval);
      playbackInterval = null;
    }

    if (currentBrowser) {
      console.log('Releasing previous browser instance...');
      try { await currentBrowser.close(); } catch (e) {}
      currentBrowser = null;
      currentPage = null;
    }

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

    const cookies = sanitizeCookies(getCookies());
    if (cookies.length > 0) {
      await currentPage.setCookie(...cookies);
    }

    await currentPage.setRequestInterception(true);
    currentPage.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await currentPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    await currentPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, ytd-button-renderer'));
      for (const btn of buttons) {
        const txt = (btn.innerText || '').toLowerCase();
        if (txt.includes('accept') || txt.includes('agree') || txt.includes('reject') || txt.includes('dismiss')) {
          btn.click();
          break;
        }
      }
    }).catch(() => {});

    await currentPage.waitForSelector('video', { timeout: 8000 }).catch(() => {});

    const pageTitle = await currentPage.title();

    currentStatus = {
      playing: true,
      url: targetUrl,
      title: pageTitle,
      startedAt: new Date().toISOString(),
      currentTime: 0,
      duration: 0
    };

    // Auto-keepalive loop: continuously checks every 3 seconds to unpause and enforce 144p
    playbackInterval = setInterval(async () => {
      if (currentPage && !currentPage.isClosed()) {
        try {
          await currentPage.evaluate(() => {
            const v = document.querySelector('video');
            if (v) {
              v.muted = true;
              if (v.paused) v.play().catch(() => {});
            }
            const p = document.getElementById('movie_player');
            if (p && typeof p.setPlaybackQualityRange === 'function') {
              p.setPlaybackQualityRange('tiny', 'tiny');
            }
          });
        } catch (e) {}
      }
    }, 3000);

    return res.json({
      success: true,
      url: targetUrl,
      title: pageTitle,
      screenshotUrl: '/screenshot',
      message: 'Video launched. Continuous 144p playback monitor active.'
    });

  } catch (err) {
    console.error('Play error:', err);
    currentStatus.playing = false;
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Render Browser Player listening on port ${PORT}`);
});
