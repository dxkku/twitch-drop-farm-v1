const puppeteer = require('puppeteer');

const PROXY_SITES = [
  'https://www.blockaway.net',
  'https://www.croxyproxy.com',
  'https://www.croxyproxy.rocks',
  'https://www.croxy.network',
  'https://www.croxy.org',
  'https://www.youtubeunblocked.live',
  'https://www.croxyproxy.net',
];

const activeViewers = {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startViewing(channelName, viewerCount, proxyIndex = 0) {
  if (activeViewers[channelName]) {
    throw new Error(`Already viewing ${channelName}. Stop it first.`);
  }

  const proxyUrl = PROXY_SITES[proxyIndex % PROXY_SITES.length];
  console.log(`DEBUG [viewerBot] Starting ${viewerCount} viewers for ${channelName} via ${proxyUrl}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
    ],
  });

  const state = { browser, tabs: [], channelName, stopped: false };
  activeViewers[channelName] = state;

  async function openViewerTab(i) {
    if (state.stopped) return null;
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 720 });

      await page.goto(proxyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000 + Math.random() * 3000);

      const urlBox = await page.$('#url');
      if (urlBox) {
        await urlBox.type(`www.twitch.tv/${channelName}`, { delay: 30 + Math.random() * 50 });
        await sleep(500);
        await page.keyboard.press('Enter');
        console.log(`DEBUG [viewerBot] Tab ${i + 1}/${viewerCount} opened for ${channelName}`);
      } else {
        console.log(`DEBUG [viewerBot] Tab ${i + 1}: URL box not found on proxy site`);
      }
      return page;
    } catch (err) {
      console.log(`DEBUG [viewerBot] Tab ${i + 1} error: ${err.message}`);
      return null;
    }
  }

  const batchSize = 5;
  for (let i = 0; i < viewerCount; i += batchSize) {
    if (state.stopped) break;
    const batch = [];
    for (let j = i; j < Math.min(i + batchSize, viewerCount); j++) {
      batch.push(openViewerTab(j));
    }
    const pages = await Promise.all(batch);
    for (const page of pages) {
      if (page) state.tabs.push(page);
    }
    await sleep(3000 + Math.random() * 5000);
  }

  console.log(`DEBUG [viewerBot] ${state.tabs.length} viewer tabs open for ${channelName}`);

  state.keepAlive = setInterval(async () => {
    if (state.stopped) { clearInterval(state.keepAlive); return; }
    for (const page of state.tabs) {
      try {
        await page.evaluate(() => document.title);
      } catch {
        console.log(`DEBUG [viewerBot] Dead tab detected for ${channelName}`);
      }
    }
  }, 60000);

  return { channel: channelName, viewers: state.tabs.length };
}

async function stopViewing(channelName) {
  const state = activeViewers[channelName];
  if (!state) return false;

  state.stopped = true;
  if (state.keepAlive) clearInterval(state.keepAlive);

  try { await state.browser.close(); } catch {}

  delete activeViewers[channelName];
  console.log(`DEBUG [viewerBot] Stopped ${channelName} (${state.tabs.length} tabs closed)`);
  return true;
}

function getStatus() {
  return Object.entries(activeViewers).map(([ch, s]) => ({
    channel: ch,
    viewers: s.tabs.length,
    stopped: s.stopped,
  }));
}

module.exports = { startViewing, stopViewing, getStatus, PROXY_SITES };
