'use strict';

/**
 * Server stealth launcher — Windows Server + Linux VPS.
 *
 * Same KPSDK late-CDP technique as the desktop launcher.
 * Chrome opens twitch.tv clean, KPSDK challenge runs undetected,
 * CDP connects after the delay.
 *
 * Extra vs desktop launcher:
 *  - Windows Server: broader Chrome paths, --disable-gpu for no-GPU servers
 *  - Linux: finds Chrome/Chromium, auto-starts Xvfb virtual display
 *  - Both: falls back to puppeteer's bundled Chromium if Chrome not installed
 *
 * WHY NOT --headless?
 *   Kasada KPSDK detects headless mode and returns 400 ("Browser not supported").
 *   Chrome MUST render in a real or virtual display.
 *   Windows Server → connect via RDP, then run node (uses RDP desktop).
 *   Linux → Xvfb is started automatically (install it first: apt install xvfb).
 */

const puppeteer = require('puppeteer');
const { spawn }  = require('child_process');
const net        = require('net');
const fs         = require('fs');
const { generateFingerprint } = require('./fingerprint');

const IS_LINUX = process.platform === 'linux';
const IS_WIN   = process.platform === 'win32';

// ─── Chrome detection ────────────────────────────────────────────────────────

function findSystemChrome() {
  const candidates = IS_WIN ? [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA  || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.PROGRAMFILES  || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env['PROGRAMFILES(X86)'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ] : [
    // Linux
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/local/bin/google-chrome',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
  ];

  for (const p of candidates.filter(Boolean)) {
    try { if (fs.existsSync(p)) return p; } catch(e) {}
  }
  return null;
}

function getChromePath() {
  const sys = findSystemChrome();
  if (sys) return sys;

  // Fall back to puppeteer's bundled Chromium
  try {
    const pup = require('puppeteer');
    const p = typeof pup.executablePath === 'function' ? pup.executablePath() : null;
    if (p && fs.existsSync(p)) {
      console.log(`DEBUG [server-stealth] No system Chrome — using puppeteer Chromium: ${p}`);
      return p;
    }
  } catch(e) {}

  const installCmd = IS_LINUX
    ? 'apt-get install -y google-chrome-stable\n  (add Google repo first: https://google.com/chrome)'
    : 'Download from https://www.google.com/chrome/\n  Or: set CHROME_PATH in .env';

  throw new Error(`Chrome not found.\nInstall it:\n  ${installCmd}\nOr run: npm install puppeteer`);
}

// ─── Xvfb virtual display (Linux only) ──────────────────────────────────────

let _xvfbProc    = null;
let _xvfbDisplay = null;

async function ensureDisplay() {
  if (!IS_LINUX) return {};

  // Already have a display (real X11, existing Xvfb, or DISPLAY set manually)
  if (process.env.DISPLAY) {
    console.log(`DEBUG [server-stealth] Using existing DISPLAY=${process.env.DISPLAY}`);
    return { DISPLAY: process.env.DISPLAY };
  }

  // Find a free display number
  let displayNum = 99;
  for (let d = 99; d <= 120; d++) {
    if (!fs.existsSync(`/tmp/.X${d}-lock`)) { displayNum = d; break; }
  }
  const display = `:${displayNum}`;

  console.log(`DEBUG [server-stealth] Starting Xvfb on display ${display}...`);

  await new Promise((resolve) => {
    _xvfbProc = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-ac', '+extension', 'GLX'], {
      stdio: 'ignore',
      detached: true,
    });
    _xvfbProc.unref();
    _xvfbProc.on('error', (err) => {
      const msg = err.code === 'ENOENT'
        ? 'Xvfb not installed. Run: apt-get install -y xvfb'
        : `Xvfb failed: ${err.message}`;
      console.log(`DEBUG [server-stealth] ${msg}`);
      _xvfbProc    = null;
      _xvfbDisplay = null;
      resolve();
    });
    setTimeout(resolve, 1200);
  });

  if (!_xvfbProc || _xvfbProc.exitCode !== null) {
    throw new Error(
      'Linux server has no display and Xvfb failed to start.\n' +
      'Fix: apt-get install -y xvfb\n' +
      'Or set DISPLAY manually before starting the bot.'
    );
  }

  _xvfbDisplay   = display;
  process.env.DISPLAY = display;
  console.log(`DEBUG [server-stealth] Xvfb ready on ${display}`);
  return { DISPLAY: display };
}

// Clean up Xvfb on exit
process.on('exit', () => {
  if (_xvfbProc) { try { _xvfbProc.kill(); } catch(e) {} }
});

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForDevTools(port, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) {
        try {
          const data = await resp.clone().json();
          console.log(`DEBUG [server-stealth] Chrome version: ${data.Browser || 'unknown'}`);
          const m = (data.Browser || '').match(/Chrome\/(\d+)\.(\d+\.\d+\.\d+)/);
          if (m) return { full: `${m[1]}.${m[2]}`, major: m[1] };
        } catch(e) {}
        return null;
      }
    } catch(e) {}
    await sleep(300);
  }
  throw new Error(`Chrome DevTools not ready on port ${port} after ${timeout}ms`);
}

// ─── Main launch ─────────────────────────────────────────────────────────────

async function launch(opts = {}) {
  const chromePath  = getChromePath();
  const port  = await freePort();
  const delay = opts.kpsdkDelay !== undefined ? opts.kpsdkDelay : 14000;

  // Generate fingerprint early — needed for --window-size before Chrome spawns.
  // Chrome version fields get patched after DevTools reports the real version.
  const fp = generateFingerprint();

  // On Linux: ensure Xvfb is running before spawning Chrome
  const displayEnv = await ensureDisplay();

  const args = [
    `--remote-debugging-port=${port}`,
    '--disable-blink-features=AutomationControlled',

    // GPU flags — Linux VPS has no GPU so we must force software rendering.
    // Windows Server via RDP has a virtual display adapter with basic GPU support —
    // do NOT use --disable-gpu on Windows: it forces SwiftShader which makes the
    // Canvas/WebGL fingerprint look wrong to Kasada's server → 400.
    ...(IS_LINUX ? ['--disable-gpu', '--disable-software-rasterizer'] : []),
    '--enable-unsafe-swiftshader',  // WebGL fallback if no real GPU
    '--ignore-gpu-blocklist',
    '--force-color-profile=srgb',

    // CRITICAL: no --user-agent here.
    // KPSDK sends the UA to Kasada's p. endpoint and Kasada cross-checks it
    // against the real Chrome fingerprint. A mismatched version → 400.
    // Chrome's own real UA → fingerprint matches → Kasada accepts.

    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--mute-audio',
    '--disable-breakpad',
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-background-networking',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-translate',
    '--password-store=basic',

    `--window-size=${opts.windowSize ? opts.windowSize.width : fp.screen.width},${opts.windowSize ? opts.windowSize.height : fp.screen.height}`,
  ];

  if (opts.userDataDir)   args.push(`--user-data-dir=${opts.userDataDir}`);
  if (opts.proxyPort)     args.push(`--proxy-server=http://127.0.0.1:${opts.proxyPort}`);
  if (opts.loadExtension) {
    args.push(`--load-extension=${opts.loadExtension}`);
    args.push(`--disable-extensions-except=${opts.loadExtension}`);
  }

  args.push('https://www.twitch.tv/');

  const spawnEnv = { ...process.env, ...displayEnv };

  console.log(`DEBUG [server-stealth] Spawning Chrome on port ${port}, delay=${delay}ms`);
  const chromeProc = spawn(chromePath, args, {
    stdio: 'ignore',
    detached: false,
    env: spawnEnv,
  });
  chromeProc.on('exit', code => console.log(`DEBUG [server-stealth] Chrome exited (code=${code})`));
  chromeProc.on('error', err  => console.log(`DEBUG [server-stealth] Chrome error: ${err.message}`));

  const realChrome = await waitForDevTools(port);
  // Patch UA and sec-ch-ua to use the real installed Chrome version
  if (realChrome) {
    const { patchFp } = require('./fingerprint');
    if (patchFp) patchFp(fp, realChrome);
  }
  console.log(`DEBUG [server-stealth] Chrome DevTools ready on port ${port}`);

  console.log(`DEBUG [server-stealth] Waiting ${delay}ms for KPSDK challenge...`);
  await sleep(delay);

  const browser = await puppeteer.connect({
    browserURL:      `http://127.0.0.1:${port}`,
    defaultViewport: { width: fp.screen.width, height: fp.screen.height },
  });
  console.log(`DEBUG [server-stealth] CDP connected after KPSDK delay`);

  const pages      = await browser.pages();
  const twitchPage = pages.find(p => p.url().includes('twitch.tv')) || pages[0];

  return { browser, page: twitchPage, fingerprint: fp, chromeProc, debugPort: port };
}

async function applyStealthToPage(page, fp) {
  await page.setUserAgent(fp.userAgent).catch(() => {});
  await page.setExtraHTTPHeaders({
    'Accept-Language':    fp.acceptLanguage || 'en-US,en;q=0.9',
    'sec-ch-ua':          fp.secChUa,
    'sec-ch-ua-mobile':   fp.secChUaMobile,
    'sec-ch-ua-platform': fp.secChUaPlatform,
  }).catch(() => {});
}

async function newStealthPage(browser, fp) {
  const page = await browser.newPage();
  await applyStealthToPage(page, fp);
  return page;
}

module.exports = { launch, applyStealthToPage, newStealthPage };
