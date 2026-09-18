'use strict';

const puppeteer = require('puppeteer');
const { spawn }  = require('child_process');
const net        = require('net');
const { generateFingerprint } = require('./fingerprint');

function findChrome() {
  const fs = require('fs');
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PROGRAMFILES  + '\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch(e) {}
  }
  return null;
}

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

async function waitForDevTools(port, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) {
        try {
          const data = await resp.clone().json();
          console.log(`DEBUG [stealth] Real Chrome version: ${data.Browser || 'unknown'}`);
          // Parse "Chrome/152.0.7977.83" into { full, major } for fingerprint
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

/**
 * LATE CDP CONNECTION — the key technique against Kasada KPSDK.
 *
 * Chrome launches WITHOUT an active CDP session and navigates to twitch.tv.
 * KPSDK runs its full challenge against genuine, unmodified Chrome.
 * We only connect CDP AFTER the warm-up delay.
 *
 * CRITICAL: Do NOT set --user-agent at launch.
 * KPSDK reads navigator.userAgent and sends it in the challenge data to p.
 * Kasada's server cross-checks the UA against the actual Chrome fingerprint
 * (canvas, WebGL, etc.). If Chrome/152 is installed but UA says Chrome/131,
 * Kasada detects the mismatch and returns 400. Let Chrome use its real UA.
 */
async function launch(opts = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Real Chrome binary not found. Install Chrome or set CHROME_PATH.');

  const port  = await freePort();
  const delay = opts.kpsdkDelay !== undefined ? opts.kpsdkDelay : 10000;

  // Generate fingerprint early — needed for --window-size before Chrome spawns.
  const fp = generateFingerprint();

  // Chrome must be visible on Windows — hidden/minimized breaks CDP input events
  const args = [
    `--remote-debugging-port=${port}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--mute-audio',
    '--disable-breakpad',
    '--disable-sync',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--disable-features=IsolateOrigins,site-per-process',
    `--window-size=${opts.windowSize ? opts.windowSize.width : fp.screen.width},${opts.windowSize ? opts.windowSize.height : fp.screen.height}`,
  ];

  if (opts.userDataDir)   args.push(`--user-data-dir=${opts.userDataDir}`);
  if (opts.proxyPort)     args.push(`--proxy-server=http://127.0.0.1:${opts.proxyPort}`);
  if (opts.loadExtension) {
    args.push(`--load-extension=${opts.loadExtension}`);
    args.push(`--disable-extensions-except=${opts.loadExtension}`);
  }

  args.push('https://www.twitch.tv/');

  console.log(`DEBUG [stealth] Spawning Chrome on debug port ${port}, KPSDK delay=${delay}ms`);
  const chromeProc = spawn(chromePath, args, { stdio: 'ignore', detached: false });
  chromeProc.on('exit', code => console.log(`DEBUG [stealth] Chrome process exited (code=${code})`));

  const realChrome = await waitForDevTools(port);
  // Patch UA and sec-ch-ua to use the real installed Chrome version
  if (realChrome) {
    const { patchFp } = require('./fingerprint');
    if (patchFp) patchFp(fp, realChrome);
  }
  console.log(`DEBUG [stealth] Chrome DevTools ready on port ${port}`);

  console.log(`DEBUG [stealth] Waiting ${delay}ms for KPSDK to complete challenge...`);
  await sleep(delay);

  const browser = await puppeteer.connect({
    browserURL:      `http://127.0.0.1:${port}`,
    defaultViewport: { width: fp.screen.width, height: fp.screen.height },
    protocolTimeout: 15000,
  });
  console.log(`DEBUG [stealth] CDP connected after KPSDK delay`);

  const pages      = await browser.pages();
  const twitchPage = pages.find(p => p.url().includes('twitch.tv')) || pages[0];

  // Spoof WebGL renderer on all future navigations — prevents Twitch "browser not
  // currently supported" detection caused by SwiftShader being identified as a
  // non-hardware GPU renderer via WebGLRenderingContext.getParameter(37446).
  await twitchPage.evaluateOnNewDocument(() => {
    const spoof = (proto) => {
      try {
        const orig = proto.getParameter;
        proto.getParameter = function(p) {
          if (p === 37445) return 'Google Inc. (NVIDIA)';
          if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)';
          return Reflect.apply(orig, this, arguments);
        };
      } catch(e) {}
    };
    spoof(WebGLRenderingContext.prototype);
    try { spoof(WebGL2RenderingContext.prototype); } catch(e) {}
  }).catch(() => {});

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

module.exports = { launch, applyStealthToPage, newStealthPage, findChrome };
