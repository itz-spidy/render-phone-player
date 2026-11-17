const puppeteer = require('puppeteer');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Render free tier ultra-low RAM Chromium flags
const MINIMAL_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--single-process',
  '--disable-extensions',
  '--disable-software-rasterizer',
  '--mute-audio',                     // Critical: Disables audio decoding to save CPU/RAM
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--metrics-recording-only',
  '--autoplay-policy=no-user-gesture-required',
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
let currentStatus = {
  playing: false,
  url: null,
  title: null,
  startedAt: null
};

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Render Low-Resource YouTube Player is running',
    currentPlayback: currentStatus
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Main playback trigger: Accepts GET (/play?url=...) and POST ({ url: "..." })
app.all('/play', async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl && req.body) {
    targetUrl = req.body.url;
  }

  if (!targetUrl) {
    return res.status(400).json({
      error: 'Missing URL. Provide ?url=https://youtube.com/watch?... or JSON body { "url": "..." }'
    });
  }

  console.log(`[API] Received request to play: ${targetUrl}`);

  try {
    // 1. Close any running browser to prevent RAM accumulation
    if (currentBrowser) {
      console.log('Closing previous browser instance...');
      try { await currentBrowser.close(); } catch (e) {}
      currentBrowser = null;
      currentPage = null;
    }

    // 2. Launch Chromium with lowest resource flags
    currentBrowser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: MINIMAL_ARGS
    });

    currentPage = await currentBrowser.newPage();
    await currentPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // 3. Inject provided cookies
    const cookies = sanitizeCookies(getCookies());
    if (cookies.length > 0) {
      await currentPage.setCookie(...cookies);
      console.log(`Injected ${cookies.length} authentication cookies.`);
    }

    // 4. Block heavy image and font assets to maintain ~70MB footprint
    await currentPage.setRequestInterception(true);
    currentPage.on('request', (request) => {
      const type = request.resourceType();
      if (['image', 'font'].includes(type)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // 5. Navigate to YouTube video
    await currentPage.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    });

    // 6. Force lowest quality (144p / tiny) and trigger playback
    const playResult = await currentPage.evaluate(async () => {
      let qualitySet = false;
      let playTriggered = false;

      // Lock YouTube player to 144p (tiny)
      const player = document.getElementById('movie_player');
      if (player && typeof player.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange('tiny', 'tiny');
        if (typeof player.setPlaybackQuality === 'function') {
          player.setPlaybackQuality('tiny');
        }
        qualitySet = true;
      }

      // Unmute and play HTML5 video element
      const video = document.querySelector('video');
      if (video) {
        video.muted = true; // Must be muted for automatic background streaming
        try {
          await video.play();
          playTriggered = true;
        } catch (e) {}
      }

      // Also click the native play button if not playing
      const playBtn = document.querySelector('.ytp-play-button');
      if (playBtn && video && video.paused) {
        playBtn.click();
        playTriggered = true;
      }

      return {
        qualitySet,
        playTriggered,
        videoCurrentTime: video ? video.currentTime : 0,
        videoPaused: video ? video.paused : true
      };
    });

    const pageTitle = await currentPage.title();

    currentStatus = {
      playing: true,
      url: targetUrl,
      title: pageTitle,
      startedAt: new Date().toISOString(),
      lowestQualityForced: '144p (tiny)'
    };

    console.log(`[Success] Playing: ${pageTitle} at 144p`);

    return res.json({
      success: true,
      url: targetUrl,
      title: pageTitle,
      message: 'Video is now playing on lowest quality (144p) with cookies loaded.',
      playerDetails: playResult
    });

  } catch (err) {
    console.error('[Error] Playback failed:', err);
    if (currentBrowser) {
      try { await currentBrowser.close(); } catch (e) {}
      currentBrowser = null;
      currentPage = null;
    }
    currentStatus.playing = false;
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Render Browser Player listening on port ${PORT}`);
});
