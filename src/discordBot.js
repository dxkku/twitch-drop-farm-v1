const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { accounts, saveAccounts, findByUsername, getLinkedAccounts } = require('./state');
const { watchStream, stopWatching, getWatchers, isWatching, setOnWatcherStop, launching } = require('./watcher');
const { startApiWatching, stopApiWatching, stopAllApiWatching, getApiWatchers, isApiWatching } = require('./apiWatcher');
const { startViewing, stopViewing, getStatus: getViewerStatus, PROXY_SITES } = require('./viewerBot');
const { startLocalProxy, resetLocalProxy } = require('./localProxy');
const twitchApi = require('./twitchApi');
const twitchBot = require('./twitchBot');
const emailReader = require('./emailReader');

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const DOMAIN = process.env.DOMAIN || 'yourdomain.com';

const PROXY_URL = process.env.PROXY_URL || null;

// Find or create picdrops folder — works on PC and server
function getPicDropsDir() {
  const candidates = [
    path.join(__dirname, '..', 'picdrops'),
    path.join('E:\\win2000', 'picdrops'),
    path.join('C:\\Users\\Administrator\\Desktop\\win2000', 'picdrops'),
    path.join(process.cwd(), 'picdrops'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  // Not found anywhere — create next to the project
  const fallback = candidates[0];
  try { fs.mkdirSync(fallback, { recursive: true }); } catch(e) {}
  return fallback;
}
const PICDROPS_DIR = getPicDropsDir();
console.log('DEBUG picdrops directory:', PICDROPS_DIR);

function generatePassword() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let pw = '';
  for (let i = 0; i < 18; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  return pw;
}

async function followChannel(acc, channelName) {
  const os = require('os');
  const IS_SERVER_FC = process.platform === 'linux' || process.env.SERVER_MODE === '1';
  const stealthFC = IS_SERVER_FC ? require('./stealth/serverLauncher.js') : require('./stealth/index.js');

  let proxyPort = null;
  if (PROXY_URL) proxyPort = await startLocalProxy();

  const tmpDir = require('path').join(os.tmpdir(), 'follow_' + acc.id + '_' + Date.now());
  try { require('fs').mkdirSync(tmpDir, { recursive: true }); } catch(e) {}

  let browser = null, chromeProc = null;

  const stealthPatch = () => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch(e) {}
    try {
      if (window.chrome && !window.chrome.runtime) {
        Object.defineProperty(window.chrome, 'runtime', {
          value: { id: undefined, connect: () => ({}), sendMessage: () => {}, onMessage: { addListener: () => {}, removeListener: () => {} }, onConnect: { addListener: () => {}, removeListener: () => {} }, getURL: (p) => 'chrome-extension://' + p },
          writable: true, configurable: true,
        });
      }
    } catch(e) {}
    try { for (const key of Object.getOwnPropertyNames(window)) { if (key.startsWith('cdc_')) { try { delete window[key]; } catch(e) {} } } } catch(e) {}
  };

  try {
    const launched = await stealthFC.launch({
      userDataDir: tmpDir,
      proxyPort: proxyPort || undefined,
      kpsdkDelay: 12000,
      windowSize: { width: 1280, height: 720 },
    });
    browser = launched.browser;
    chromeProc = launched.chromeProc;
    const page = launched.page;

    await page.evaluateOnNewDocument(stealthPatch).catch(() => {});
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    await page.evaluate(stealthPatch).catch(() => {});

    // Set cookies then navigate to channel page (logged-in session needed for Follow button)
    const savedCookies = acc.cookies;
    if (savedCookies && savedCookies.length > 0) {
      await page.setCookie(...savedCookies);
    }

    await page.goto(`https://www.twitch.tv/${channelName}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 3000));
    await page.evaluate(stealthPatch).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));

    // Dismiss modals
    await page.keyboard.press('Escape').catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    await page.evaluate(() => {
      document.querySelectorAll('[data-a-target="modal-close-button"], [aria-label="Close"]').forEach(b => {
        if (b.getBoundingClientRect().width > 0) b.click();
      });
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    // Wait for the follow/unfollow button to appear (Twitch React hydration takes time)
    await page.waitForSelector(
      'button[data-a-target="follow-button"], button[data-a-target="unfollow-button"], button[aria-label*="ollow"], button[aria-label*="eguir"], button[aria-label*="uivre"]',
      { timeout: 15000 }
    ).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const result = await page.evaluate(() => {
      // First priority: Twitch's own data-a-target attributes (most reliable)
      const followBtn = document.querySelector('button[data-a-target="follow-button"]');
      if (followBtn) { followBtn.click(); return 'followed'; }
      const unfollowBtn = document.querySelector('button[data-a-target="unfollow-button"]');
      if (unfollowBtn) return 'already_following';

      // Fallback: scan all buttons by aria-label and text
      const btns = Array.from(document.querySelectorAll('button'));
      const followWords = ['follow','suivre','seguir','folgen','takip','フォロー','последвай','підписатися','теглити'];
      const unfollowWords = ['unfollow','ne plus suivre','dejar de seguir','takibi bırak'];

      for (const btn of btns) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (unfollowWords.some(w => label.includes(w))) return 'already_following';
      }
      for (const btn of btns) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        const text = btn.textContent.trim().toLowerCase();
        if (followWords.some(w => label.includes(w)) || followWords.includes(text)) {
          btn.click();
          return 'followed';
        }
      }
      return 'button_not_found';
    });

    return result;
  } finally {
    if (chromeProc && chromeProc.pid) {
      try { require('child_process').execSync(`taskkill /F /T /PID ${chromeProc.pid}`, { stdio: 'ignore' }); } catch {}
      try { chromeProc.kill(); } catch {}
    }
    if (browser) try { browser.disconnect(); } catch {}
    try { require('fs').rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
  }
}

// Auto-replace: when a watcher stops, start next idle account
let rotationStreamer = null;
let rotationQueue = [];       // queued stop events waiting for replacement
let rotationWorker = false;   // true while the worker loop is draining the queue
let autoReplaceCallback = null;

function setAutoReplaceCallback(cb) { autoReplaceCallback = cb; }

function autoReplace(streamer, accId) {
  if (autoReplaceCallback) autoReplaceCallback(streamer, accId);
}

function start(token) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

  // Auto-fill target — maintain this many accounts (set AUTOFILL_TARGET in .env)
  const autofillTarget = parseInt(process.env.AUTOFILL_TARGET) || 0;

  // Stale-message guard: ignore commands queued while bot was offline
  let botReadyAt = null;

  client.once('ready', async () => {
    botReadyAt = Date.now();
    console.log(`Discord bot logged in as ${client.user.tag}`);
    setOnWatcherStop(autoReplace);

    // Auto-replace implementation — queue-based so simultaneous stops are all handled
    async function drainRotationQueue() {
      if (rotationWorker) return;   // already running
      rotationWorker = true;
      try {
        while (rotationQueue.length > 0) {
          const { streamer } = rotationQueue.shift();

          const linked = getLinkedAccounts().filter(a => a.cookies && a.cookies.length > 0 && !isWatching(a.id));
          if (linked.length === 0) {
            console.log(`DEBUG [rotation] No idle accounts available`);
            continue;
          }

          const next = linked[0];
          const user = next.twitchData?.username || next.username;
          console.log(`DEBUG [rotation] Replacing with ${user} on ${streamer}`);

          let started = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await watchStream(next.id, streamer);
              next.watching = streamer;
              saveAccounts();
              console.log(`DEBUG [rotation] ${user} started watching ${streamer}`);
              started = true;
              break;
            } catch (e) {
              if (e.message.includes('Kasada') || e.message.includes('Browser not supported')) {
                console.log(`DEBUG [rotation] ${user}: Kasada blocked, skipping`);
                break;
              }
              if (attempt < 3) {
                console.log(`DEBUG [rotation] ${user} attempt ${attempt}/3 failed: ${e.message.slice(0, 60)}, retrying...`);
                await new Promise(r => setTimeout(r, 15000));
              } else {
                console.log(`DEBUG [rotation] ${user}: all attempts failed, moving on`);
              }
            }
          }
          // If this account also failed, immediately queue another replacement
          if (!started) {
            const moreIdle = getLinkedAccounts().filter(a => a.cookies && a.cookies.length > 0 && !isWatching(a.id));
            if (moreIdle.length > 0) rotationQueue.push({ streamer });
          }
        }
      } finally {
        rotationWorker = false;
      }
    }

    setAutoReplaceCallback((streamer, stoppedAccId) => {
      if (!rotationStreamer || rotationStreamer !== streamer) return;
      rotationQueue.push({ streamer, stoppedAccId });
      drainRotationQueue();  // fire-and-forget, worker serialises the replacements
    });
    // Clear stale watcher states from previous session (don't auto-resume)
    const state = require('./state');
    let cleared = 0;
    for (const [id, acc] of Object.entries(state.accounts)) {
      if (acc.watching || acc.watchStartedAt) {
        delete acc.watching;
        delete acc.watchStartedAt;
        cleared++;
      }
    }
    if (cleared > 0) state.saveAccounts();
    console.log(`Cleared ${cleared} stale watcher state(s) — use !watch to start`);

    // Auto-fill check — create new accounts if below target
    async function checkAutofill() {
      if (autofillTarget <= 0) return;
      const current = Object.values(accounts).length;
      const deficit = autofillTarget - current;
      if (deficit <= 0) return;

      if (current === 0) {
        console.log(`DEBUG [autofill] accounts.json missing or empty — creating ${autofillTarget} new accounts`);
      } else {
        console.log(`DEBUG [autofill] Below target: ${current}/${autofillTarget} — creating ${deficit} new accounts`);
      }

      for (let i = 0; i < deficit; i++) {
        try {
          const password = generatePassword();
          const result = await twitchBot.createTwitchAccount(password);
          if (result.success) {
            const id = `acc_${Date.now()}_${i}`;
            accounts[id] = {
              id,
              email: result.email,
              password: result.password || password,
              username: result.username,
              createdAt: new Date().toISOString(),
              twitchLinked: true,
              twitchData: { username: result.username, email: result.email },
              dropsClaimed: 0,
              watching: null,
              cookies: result.cookies || null,
            };
            saveAccounts();
            console.log(`DEBUG [autofill] Created ${result.username} (${i + 1}/${deficit})`);
          } else {
            console.log(`DEBUG [autofill] Failed: ${result.error}`);
          }
        } catch (e) {
          console.log(`DEBUG [autofill] Crashed: ${e.message}`);
        }
        if (i + 1 < deficit) await new Promise(r => setTimeout(r, 5000));
      }
      console.log(`DEBUG [autofill] Done. Total accounts: ${Object.values(accounts).length}`);
    }

    // Check autofill on startup (after 10s delay)
    setTimeout(checkAutofill, 10000);

    // Check autofill every 5 minutes
    setInterval(checkAutofill, 5 * 60 * 1000);

    // Live status updater in channel 1519530260721303733
    const LIVE_STATUS_CHANNEL_ID = '1519530260721303733';
    let liveStatusMsg = null;

    async function buildStatusEmbed() {
      const list = Object.values(accounts);
      const watchers = getWatchers();
      const linked = list.filter(a => a.twitchLinked);
      const launchingList = Object.entries(launching);
      const idle = list.length - watchers.length - launchingList.length;

      const fields = [];
      fields.push({
        name: '📊 Overview',
        value: `**Accounts:** ${list.length} total, ${linked.length} linked\n**Watching:** ${watchers.length} active, ${launchingList.length} launching, ${idle} idle\n**Proxy:** \`${twitchBot.getSignupProxyMode()}\`${autofillTarget > 0 ? `\n**Auto-Fill:** ${list.length}/${autofillTarget}` : ''}`,
        inline: false,
      });

      if (launchingList.length > 0) {
        const lines = launchingList.map(([accId, streamer]) => {
          const acc = accounts[accId];
          const user = acc?.twitchData?.username || acc?.username || accId;
          return `⏳ \`${user}\` → **${streamer}**`;
        });
        const launchFields = [];
        let buf = [];
        let bufLen = 0;
        for (const line of lines) {
          const needed = bufLen === 0 ? line.length : bufLen + 1 + line.length;
          if (needed > 1000) {
            launchFields.push({ name: '\u200b', value: buf.join('\n'), inline: false });
            buf = [line]; bufLen = line.length;
          } else { buf.push(line); bufLen = needed; }
        }
        if (buf.length) launchFields.push({ name: '🚀 Launching', value: buf.join('\n'), inline: false });
        fields.push(...launchFields);
      }

      if (watchers.length > 0) {
        const lines = watchers.map(w => {
          const acc = accounts[w.accountId];
          const user = acc?.twitchData?.username || acc?.username || w.accountId;
          const drops = w.dropsClaimed > 0 ? ` | 🎁 ${w.dropsClaimed} drops` : '';
          return `📺 \`${user}\` → **${w.streamer}** | ⏱ ${w.hoursWatched}h${drops}`;
        });
        const watchFields = [];
        let buf = [];
        let bufLen = 0;
        for (const line of lines) {
          const needed = bufLen === 0 ? line.length : bufLen + 1 + line.length;
          if (needed > 1000) {
            watchFields.push({ name: '\u200b', value: buf.join('\n'), inline: false });
            buf = [line]; bufLen = line.length;
          } else { buf.push(line); bufLen = needed; }
        }
        if (buf.length) watchFields.push({ name: '🟢 Active Watchers', value: buf.join('\n'), inline: false });
        fields.push(...watchFields);
      }

      if (launchingList.length === 0 && watchers.length === 0) {
        fields.push({ name: '🟢 Active Watchers', value: 'No active watchers. Use `!watch <streamer>` to start.', inline: false });
      }

      return new EmbedBuilder()
        .setColor(watchers.length > 0 ? 0x00FF00 : 0xFFAA00)
        .setTitle('🌾 Farm Status')
        .addFields(fields)
        .setFooter({ text: 'Auto-updates every 30s • Use !watch <streamer>' })
        .setTimestamp();
    }

    async function updateLiveStatus() {
      try {
        const guild = client.guilds.cache.first();
        if (!guild) return;
        const channel = guild.channels.cache.get(LIVE_STATUS_CHANNEL_ID);
        if (!channel) return;

        const embed = await buildStatusEmbed();
        if (liveStatusMsg) {
          await liveStatusMsg.edit({ embeds: [embed] }).catch(() => {});
        } else {
          liveStatusMsg = await channel.send({ embeds: [embed] }).catch(() => null);
        }
      } catch (e) {}
    }

    // Initial send
    await updateLiveStatus();
    // Update every 30 seconds
    setInterval(updateLiveStatus, 30000);
  });

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    if (!msg.content.startsWith('!')) return;
    // Drop any message sent before the bot came ready (stale queue from offline period)
    if (botReadyAt && msg.createdTimestamp < botReadyAt - 2000) return;

    const args = msg.content.slice(1).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    try {
      switch (cmd) {

        // ============================
        // !createfull [count] — Create Twitch accounts (full auto-signup)
        // ============================
        case 'createfull': {
          let count = parseInt(args[0]) || 1;
          const parallel = Math.min(parseInt(args[1]) || 3, 15);
          const batchSize = parseInt(args[2]) || 20;
          const pauseMinutes = args[3] !== undefined ? parseInt(args[3]) : 3;
          if (count < 1) return msg.channel.send('Count must be at least 1');

          const useBatch = count > batchSize;
          const totalBatches = useBatch ? Math.ceil(count / batchSize) : 1;

          const liveEmbed = new EmbedBuilder()
            .setColor(0x9146FF)
            .setTitle('🔨 Account Factory')
            .setDescription(
              `Creating **${count}** account(s) with **${parallel}** parallel...\n` +
              (useBatch ? `📦 **${totalBatches}** batches of ${batchSize}${pauseMinutes > 0 ? ` — **${pauseMinutes}min** pause between batches` : ' — no pause between batches'}` : `~1 min each.`)
            )
            .setTimestamp();
          const liveMsg = await msg.channel.send({ embeds: [liveEmbed] });

          let success = 0, fail = 0, running = 0, nextIdx = 0;
          const accountsCreated = [];
          const accountsFailed = [];
          const allDone = new Promise(r => { var check = () => { if (running === 0 && nextIdx >= count) r(); else setTimeout(check, 500); }; check(); });

          async function createOne(idx) {
            running++;
            liveEmbed.setColor(0xFFAA00)
              .setTitle(`🔨 Account Factory — [${success + fail}/${count}]`)
              .setDescription(`⏳ Working on account **${idx + 1}/${count}** (${parallel} parallel)...`)
              .setFields(
                { name: '✅ Created', value: `${success}`, inline: true },
                { name: '❌ Failed', value: `${fail}`, inline: true },
                { name: '⏳ Remaining', value: `${count - success - fail}`, inline: true },
              );
            if (accountsCreated.length > 0) {
              liveEmbed.addFields({
                name: 'Accounts',
                value: accountsCreated.slice(-10).map(a => `\`${a.user}\` → \`${a.email}\``).join('\n') + (accountsCreated.length > 10 ? `\n...and ${accountsCreated.length - 10} more` : ''),
              });
            }
            await liveMsg.edit({ embeds: [liveEmbed] }).catch(() => {});

            const password = generatePassword();
            let result = null;
            try {
              for (let retry = 0; retry <= 1; retry++) {
                result = await twitchBot.createTwitchAccount(password);
                if (result.success || !result.error?.includes('Browser not supported')) break;
                console.log(`DEBUG [createfull] Kasada blocked, retrying in 5s...`);
                await new Promise(r => setTimeout(r, 5000));
              }
              if (result.success) {
                success++;
                const id = `acc_${Date.now()}_${idx}`;
                accounts[id] = {
                  id,
                  email: result.email,
                  password: result.password || password,
                  username: result.username,
                  createdAt: new Date().toISOString(),
                  twitchLinked: true,
                  twitchData: { username: result.username, email: result.email },
                  dropsClaimed: 0,
                  watching: null,
                  cookies: result.cookies || null,
                  hasPfp: result.hasPfp || false,
                };
                saveAccounts();
                accountsCreated.push({ user: result.username, email: result.email, pass: result.password || password });
              } else {
                fail++;
                accountsFailed.push({ error: result.error || 'unknown' });
              }
            } catch(e) {
              fail++;
              accountsFailed.push({ error: e.message || 'crash' });
              console.log(`DEBUG [createfull] Account ${idx+1} crashed:`, e.message);
            }
            running--;
          }

          let batchCount = 0;
          while (nextIdx < count) {
            while (running < parallel && nextIdx < count) {
              const idx = nextIdx++;
              batchCount++;
              createOne(idx);
              await new Promise(r => setTimeout(r, 500));
            }
            await new Promise(r => setTimeout(r, 1000));

            // Batch pause: if we completed a batch and more remain, wait pauseMinutes (skip if 0)
            if (useBatch && batchCount >= batchSize && nextIdx < count) {
              const batchNum = Math.ceil(nextIdx / batchSize);
              batchCount = 0;
              if (pauseMinutes > 0) {
                const pauseMs = pauseMinutes * 60 * 1000;
                console.log(`DEBUG [createfull] Batch ${batchNum}/${totalBatches} done — pausing ${pauseMinutes}min`);

                // Countdown in embed
                const pauseEnd = Date.now() + pauseMs;
                const countdownInterval = setInterval(async () => {
                  const remaining = Math.max(0, pauseEnd - Date.now());
                  const mins = Math.floor(remaining / 60000);
                  const secs = Math.floor((remaining % 60000) / 1000);
                  liveEmbed
                    .setColor(0xFFAA00)
                    .setTitle(`🔨 Account Factory — Batch ${batchNum}/${totalBatches}`)
                    .setDescription(
                      `⏸️ **Pausing ${pauseMinutes}min** between batches to protect domains\n` +
                      `✅ **${success}** created | ❌ **${fail}** failed\n` +
                      `⏱️ Resuming in **${mins}m ${secs}s**\n` +
                      `📦 Next: ${count - nextIdx} accounts remaining`
                    )
                    .setFields([]);
                  await liveMsg.edit({ embeds: [liveEmbed] }).catch(() => {});
                }, 5000);

                await new Promise(r => setTimeout(r, pauseMs));
                clearInterval(countdownInterval);
              } else {
                console.log(`DEBUG [createfull] Batch ${batchNum}/${totalBatches} done — no pause (pauseMinutes=0)`);
              }
            }
          }

          await allDone;

          // Final embed
          const failList = accountsFailed.length > 0 ? `\n❌ **${accountsFailed.length}** failed` : '';
          liveEmbed
            .setColor(success > 0 ? 0x00FF00 : 0xFF0000)
            .setTitle('🏁 Account Factory — Complete')
            .setDescription(
              `✅ **${success}** created | ❌ **${fail}** failed | **${count}** total\n` +
              `Success rate: **${count > 0 ? Math.round(success / count * 100) : 0}%**` +
              failList
            )
            .setTimestamp();

          if (accountsCreated.length === 0) {
            await liveMsg.edit({ embeds: [liveEmbed] });
          } else {
            // Paginated accounts like !accounts
            const PAGE_SIZE = 50;
            const totalPages = Math.ceil(accountsCreated.length / PAGE_SIZE);
            let curPage = 1;

            function buildCreatePage(page) {
              const s = (page - 1) * PAGE_SIZE;
              const slice = accountsCreated.slice(s, s + PAGE_SIZE);
              const lines = slice.map(a => `\`${a.user}\` | \`${a.email}\` | \`${a.pass}\``);

              const fields = [];
              let fieldLines = [];
              let fieldLen = 0;
              for (const line of lines) {
                const needed = fieldLen === 0 ? line.length : fieldLen + 1 + line.length;
                if (needed > 1000) {
                  fields.push({ name: '\u200b', value: fieldLines.join('\n'), inline: false });
                  fieldLines = [line];
                  fieldLen = line.length;
                } else {
                  fieldLines.push(line);
                  fieldLen = needed;
                }
              }
              if (fieldLines.length) fields.push({ name: '\u200b', value: fieldLines.join('\n'), inline: false });

              liveEmbed.setFields(
                { name: `Page ${page}/${totalPages} (${s + 1}–${Math.min(s + PAGE_SIZE, accountsCreated.length)})`, value: '\u200b' },
                ...fields
              );
              return liveEmbed;
            }

            function buildCreateButtons(page) {
              return new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('cf_prev').setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
                new ButtonBuilder().setCustomId('cf_page').setLabel(`${page}/${totalPages}`).setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId('cf_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
              );
            }

            if (totalPages <= 1) {
              await liveMsg.edit({ embeds: [buildCreatePage(1)] });
            } else {
              await liveMsg.edit({ embeds: [buildCreatePage(1)], components: [buildCreateButtons(1)] });
              const collector = liveMsg.createMessageComponentCollector({ time: 300000 });
              collector.on('collect', async (interaction) => {
                if (interaction.user.id !== msg.author.id) return interaction.reply({ content: 'Not your button.', ephemeral: true });
                if (interaction.customId === 'cf_prev') curPage = Math.max(1, curPage - 1);
                else if (interaction.customId === 'cf_next') curPage = Math.min(totalPages, curPage + 1);
                else return;
                await interaction.update({ embeds: [buildCreatePage(curPage)], components: [buildCreateButtons(curPage)] });
              });
              collector.on('end', () => liveMsg.edit({ components: [] }).catch(() => {}));
            }
          }
          break;
        }

        // ============================
        // !accounts — List all accounts (compact, paginated with buttons)
        // ============================
        case 'accounts': {
          const list = Object.values(accounts);
          if (list.length === 0) return msg.channel.send('No accounts yet. Use `!createfull` to create one.');

          const watchers = getWatchers();
          const watchingIds = new Set(watchers.map(w => w.accId));
          const linked = list.filter(a => a.twitchLinked).length;
          const watching = list.filter(a => watchingIds.has(a.id)).length;
          const idle = list.length - watching;

          const PAGE_SIZE = 50;
          const totalPages = Math.ceil(list.length / PAGE_SIZE);
          let currentPage = parseInt(args[0]) || 1;
          if (currentPage < 1) currentPage = 1;
          if (currentPage > totalPages) currentPage = totalPages;

          function buildPage(page) {
            const start = (page - 1) * PAGE_SIZE;
            const slice = list.slice(start, start + PAGE_SIZE);
            const lines = slice.map(a => {
              const user = a.twitchData?.username || a.username || '❌';
              const s = a.watching ? '📺' : a.twitchLinked ? '✅' : '⚠️';
              return `${s}\`${user}\``;
            });
            const packed = [];
            for (let i = 0; i < lines.length; i += 4) packed.push(lines.slice(i, i + 4).join(' '));

            const fields = [];
            let fieldLines = [];
            let fieldLen = 0;
            for (const line of packed) {
              const needed = fieldLen === 0 ? line.length : fieldLen + 1 + line.length;
              if (needed > 1000) {
                fields.push({ name: '\u200b', value: fieldLines.join('\n'), inline: false });
                fieldLines = [line];
                fieldLen = line.length;
              } else {
                fieldLines.push(line);
                fieldLen = needed;
              }
            }
            if (fieldLines.length) fields.push({ name: '\u200b', value: fieldLines.join('\n'), inline: false });

            return {
              title: '📋 Accounts',
              color: 0x9146FF,
              description: `**${list.length}** total | **${watching}** watching | **${idle}** idle | **${linked}** linked`,
              fields: [
                { name: `Page ${page}/${totalPages} (${start + 1}–${Math.min(start + PAGE_SIZE, list.length)})`, value: '\u200b' },
                ...fields,
              ],
            };
          }

          function buildButtons(page) {
            return new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('acc_prev').setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
              new ButtonBuilder().setCustomId('acc_page').setLabel(`${page}/${totalPages}`).setStyle(ButtonStyle.Primary).setDisabled(true),
              new ButtonBuilder().setCustomId('acc_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
            );
          }

          if (totalPages <= 1) {
            return msg.channel.send({ embeds: [buildPage(currentPage)] });
          }

          const reply = await msg.channel.send({ embeds: [buildPage(currentPage)], components: [buildButtons(currentPage)] });
          const collector = reply.createMessageComponentCollector({ time: 120000 });
          collector.on('collect', async (interaction) => {
            if (interaction.user.id !== msg.author.id) return interaction.reply({ content: 'Not your button.', ephemeral: true });
            if (interaction.customId === 'acc_prev') currentPage = Math.max(1, currentPage - 1);
            else if (interaction.customId === 'acc_next') currentPage = Math.min(totalPages, currentPage + 1);
            else return;
            await interaction.update({ embeds: [buildPage(currentPage)], components: [buildButtons(currentPage)] });
          });
          collector.on('end', () => reply.edit({ components: [] }).catch(() => {}));
          break;
        }

        // ============================
        // !status — Farm status overview
        // ============================
        case 'status': {
          const embed = await buildStatusEmbed();
          await msg.channel.send({ embeds: [embed] });
          break;
        }

        // ============================
        // !follow <channel> [parallel|username] — Follow a channel
        //   !follow rocketleague       — all accounts, 3 at a time
        //   !follow rocketleague 10    — all accounts, 10 at a time
        //   !follow rocketleague user1 — single specific account
        // ============================
        case 'follow': {
          const channel = args[0];
          const secondArg = args[1];
          if (!channel) return msg.channel.send('Usage: `!follow <channel>` | `!follow <channel> <parallel>` | `!follow <channel> <username>`');

          const parsedNum = parseInt(secondArg);
          const isParallelCount = secondArg && !isNaN(parsedNum) && parsedNum > 0;
          const specificUser = (!isParallelCount && secondArg) ? secondArg : null;
          const parallel = isParallelCount ? Math.min(parsedNum, 20) : 3;

          if (specificUser) {
            // Single account
            const acc = findByUsername(specificUser);
            if (!acc) return msg.channel.send(`Account \`${specificUser}\` not found.`);
            await msg.channel.send(`⏳ Following \`${channel}\` with \`${specificUser}\`...`);
            try {
              const result = await followChannel(acc, channel);
              await msg.channel.send(`✅ \`${specificUser}\` ${result}`);
            } catch(e) {
              await msg.channel.send(`❌ \`${specificUser}\` follow failed: ${e.message}`);
            }
          } else {
            // All accounts — run `parallel` at a time with a concurrency queue
            const linked = getLinkedAccounts();
            if (linked.length === 0) return msg.channel.send('No accounts available. Use `!createfull` first.');

            const followEmbed = new EmbedBuilder()
              .setColor(0x9146FF)
              .setTitle(`💜 Follow \`${channel}\``)
              .setDescription(`Following with **${linked.length}** account(s) — **${parallel}** parallel...`)
              .setTimestamp();
            const liveMsg = await msg.channel.send({ embeds: [followEmbed] });

            let success = 0, alreadyFollowing = 0, failed = 0, completed = 0;

            // Concurrency queue: always keep `parallel` running at once
            const queue = [...linked];
            const running = [];
            while (queue.length > 0 || running.length > 0) {
              while (running.length < parallel && queue.length > 0) {
                const acc = queue.shift();
                const user = acc.twitchData?.username || acc.username;
                const p = followChannel(acc, channel)
                  .then(result => {
                    if (result === 'already_following') alreadyFollowing++;
                    else if (result === 'followed') success++;
                    else failed++;
                    console.log(`DEBUG [follow] ${user}: ${result}`);
                  })
                  .catch(e => {
                    failed++;
                    console.log(`DEBUG [follow] ${user}: failed — ${e.message.slice(0, 80)}`);
                  })
                  .finally(() => {
                    completed++;
                    running.splice(running.indexOf(p), 1);
                    followEmbed
                      .setColor(0xFFAA00)
                      .setTitle(`💜 Follow \`${channel}\` — [${completed}/${linked.length}]`)
                      .setDescription(`✅ ${success} followed | 💜 ${alreadyFollowing} already | ❌ ${failed} failed | ⏳ ${linked.length - completed} left`);
                    liveMsg.edit({ embeds: [followEmbed] }).catch(() => {});
                  });
                running.push(p);
              }
              if (running.length > 0) await Promise.race(running);
            }

            followEmbed
              .setColor(failed === linked.length ? 0xFF0000 : 0x00FF00)
              .setTitle(`💜 Follow \`${channel}\` — Done`)
              .setDescription(`✅ **${success}** followed | 💜 **${alreadyFollowing}** already following | ❌ **${failed}** failed\n**${linked.length}** account(s) checked`);
            await liveMsg.edit({ embeds: [followEmbed] });
          }
          break;
        }

        // ============================
        // !watch <streamer> [username|parallel] — Watch a stream (all accounts or specific one)
        // ============================
        case 'watch': {
          const streamer = args[0];
          const secondArg = args[1];
          const thirdArg = args[2];

          if (!streamer) return msg.channel.send('Usage: `!watch <streamer>` or `!watch <streamer> <parallel>` or `!watch <streamer> <username>`');

          // Check if second arg is a number (parallel count) or a username
          const parallelCount = parseInt(secondArg);
          const specificUser = isNaN(parallelCount) ? secondArg : null;
          const parallel = isNaN(parallelCount) ? 1 : Math.min(Math.max(parallelCount, 1), 50);

          if (specificUser) {
            // Watch with specific account
            const acc = findByUsername(specificUser);
            if (!acc) return msg.channel.send(`Account \`${specificUser}\` not found.`);
            if (!acc.cookies || acc.cookies.length === 0) return msg.channel.send(`❌ \`${specificUser}\` has no cookies. Account must be created with \`!createfull\` first.`);

            const watchMsg = await msg.channel.send({ embeds: [new EmbedBuilder().setColor(0xFFAA00).setTitle('📺 Watching').setDescription(`Starting \`${specificUser}\` on **${streamer}**...`).setTimestamp()] });
            for (let attempt = 1; attempt <= 5; attempt++) {
              try {
                await watchStream(acc.id, streamer);
                acc.watching = streamer;
                saveAccounts();
                await watchMsg.edit({ embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('📺 Watching').setDescription(`✅ \`${specificUser}\` now watching **${streamer}**`).setTimestamp()] }).catch(() => {});
                break;
              } catch (e) {
                if (e.message.includes('Kasada') || e.message.includes('Browser not supported')) {
                  await watchMsg.edit({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('❌ Failed').setDescription(`\`${specificUser}\` — Kasada blocked`).setTimestamp()] }).catch(() => {});
                  break;
                }
                if (attempt < 5) {
                  await new Promise(r => setTimeout(r, e.message.includes('Query limit') || e.message.includes('Fingerprint') ? 30000 : 15000));
                } else {
                  await watchMsg.edit({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('❌ Failed').setDescription(`\`${specificUser}\` — ${e.message.slice(0, 100)}`).setTimestamp()] }).catch(() => {});
                }
              }
            }
          } else {
            // Watch with ALL linked accounts — parallel mode
            const linked = getLinkedAccounts().filter(a => a.cookies && a.cookies.length > 0);
            if (linked.length === 0) return msg.channel.send('No accounts with cookies available. Use `!createfull` first.');

            const idle = linked.filter(a => !isWatching(a.id));
            const alreadyWatching = linked.length - idle.length;
            if (idle.length === 0) return msg.channel.send(`All ${linked.length} accounts are already watching.`);

            const watchEmbed = {
              title: `📺 Watching \`${streamer}\``,
              color: 0x9146FF,
              fields: [],
              description: '',
            };
            if (alreadyWatching > 0) watchEmbed.description = `⏭ Skipping ${alreadyWatching} already watching`;
            // Only start exactly parallel accounts — rotation handles replacements when one stops
            const toStart = idle.slice(0, parallel);
            watchEmbed.fields.push({ name: '🚀 Starting', value: `**${toStart.length}** account(s) launching (limit: ${parallel})...`, inline: false });

            const startMsg = await msg.channel.send({ embeds: [watchEmbed] });

            let success = 0;
            let failed = 0;
            const results = [];

            const batchPromises = toStart.map(async (acc) => {
              const user = acc.twitchData?.username || acc.username;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  await watchStream(acc.id, streamer);
                  acc.watching = streamer;
                  success++;
                  results.push(`✅ \`${user}\` started watching`);
                  return;
                } catch (e) {
                  if (e.message.includes('Kasada') || e.message.includes('Browser not supported')) {
                    failed++;
                    results.push(`❌ \`${user}\` — Kasada blocked`);
                    return;
                  }
                  if (attempt < 3) {
                    await new Promise(r => setTimeout(r, 15000));
                  } else {
                    failed++;
                    results.push(`❌ \`${user}\` — ${e.message.slice(0, 60)}`);
                  }
                }
              }
            });

            await Promise.all(batchPromises);

            watchEmbed.fields[0] = { name: '🚀 Launched', value: `${toStart.length} started | ✅ ${success} | ❌ ${failed}`, inline: false };
            if (results.length > 0) {
              watchEmbed.fields[1] = { name: 'Results', value: results.slice(-8).join('\n'), inline: false };
            }
            await startMsg.edit({ embeds: [watchEmbed] }).catch(() => {});
            saveAccounts();

            // Final embed
            watchEmbed.color = success > 0 ? 0x00FF00 : 0xFF0000;
            watchEmbed.fields = [
              { name: '📊 Summary', value: `✅ ${success} watching | ❌ ${failed} failed | 📺 **${streamer}**`, inline: false },
            ];
            if (results.length > 0) {
              const resBuf = [];
              let resLen = 0;
              for (const line of results) {
                const needed = resLen === 0 ? line.length : resLen + 1 + line.length;
                if (needed > 1000) {
                  watchEmbed.fields.push({ name: 'Results', value: resBuf.join('\n'), inline: false });
                  resBuf.length = 0; resLen = 0;
                }
                resBuf.push(line);
                resLen = resBuf.join('\n').length;
              }
              if (resBuf.length) watchEmbed.fields.push({ name: 'Results', value: resBuf.join('\n'), inline: false });
            }
            watchEmbed.fields.push({ name: '🔄 Auto-replace', value: 'ON — when an account stops, next idle account takes its place', inline: false });
            await startMsg.edit({ embeds: [watchEmbed] }).catch(() => {});
            rotationStreamer = streamer;
          }
          break;
        }

        // ============================
        // !stopwatch [username] — Stop watching (one or all)
        // ============================
        case 'stopwatch': {
          const specificUser = args[0];

          if (specificUser) {
            const acc = findByUsername(specificUser);
            if (!acc) return msg.channel.send(`Account \`${specificUser}\` not found.`);
            await stopWatching(acc.id);
            acc.watching = null;
            saveAccounts();
            await msg.channel.send(`⏹️ \`${specificUser}\` stopped watching.`);
          } else {
            // Stop all
            const watchers = getWatchers();
            for (const w of watchers) {
              await stopWatching(w.accountId);
              if (accounts[w.accountId]) accounts[w.accountId].watching = null;
            }
            saveAccounts();
            rotationStreamer = null;
            await msg.channel.send(`⏹️ Stopped all ${watchers.length} watchers. Auto-replace OFF.`);
          }
          break;
        }

        // ============================
        // !apiwatch <streamer> [all|username] — API-based watching (no browser)
        // !apiwatch rocketleague          → start all eligible accounts
        // !apiwatch rocketleague username → start one account
        // ============================
        case 'apiwatch': {
          const apStreamer = args[0];
          const apTarget   = args[1]; // optional: specific username

          if (!apStreamer) return msg.channel.send('Usage: `!apiwatch <streamer> [username]`');

          const apMsg = await msg.channel.send({ embeds: [
            new EmbedBuilder().setColor(0xFFAA00).setTitle('🌐 API Watch').setDescription(`Starting API watchers on **${apStreamer}**...`).setTimestamp()
          ]});

          if (apTarget) {
            // Single account
            const acc = findByUsername(apTarget);
            if (!acc) return apMsg.edit({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('❌ Not found').setDescription(`Account \`${apTarget}\` not found.`)] });
            const res = await startApiWatching(acc.id, apStreamer);
            const statusLine = res.started
              ? `✅ \`${apTarget}\` watching **${apStreamer}** via API`
              : `❌ \`${apTarget}\` failed: ${res.reason}`;
            await apMsg.edit({ embeds: [new EmbedBuilder().setColor(res.started ? 0x00FF00 : 0xFF0000).setTitle('🌐 API Watch').setDescription(statusLine).setTimestamp()] });
          } else {
            // All eligible accounts (have cookies, not already watching)
            const eligible = getLinkedAccounts().filter(a =>
              a.cookies && a.cookies.length > 6 &&
              !isWatching(a.id) && !isApiWatching(a.id)
            );

            if (eligible.length === 0) {
              return apMsg.edit({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🌐 API Watch').setDescription('No eligible accounts (need cookies, not already watching).').setTimestamp()] });
            }

            let apSuccess = 0, apFailed = 0, apSkipped = 0;
            const BATCH = 20; // launch in batches to avoid hammering GQL

            await apMsg.edit({ embeds: [new EmbedBuilder().setColor(0xFFAA00).setTitle('🌐 API Watch').setDescription(`Starting **${eligible.length}** accounts in batches of ${BATCH}...`).setTimestamp()] });

            for (let i = 0; i < eligible.length; i += BATCH) {
              const batch = eligible.slice(i, i + BATCH);
              await Promise.all(batch.map(async (acc) => {
                const res = await startApiWatching(acc.id, apStreamer);
                if (res.started) apSuccess++;
                else if (res.reason === 'stream_offline') apSkipped++;
                else apFailed++;
              }));
              // Small delay between batches
              if (i + BATCH < eligible.length) await new Promise(r => setTimeout(r, 2000));
            }

            await apMsg.edit({ embeds: [
              new EmbedBuilder()
                .setColor(apSuccess > 0 ? 0x00FF00 : 0xFF0000)
                .setTitle('🌐 API Watch — Done')
                .setDescription(
                  `✅ **${apSuccess}** started\n` +
                  `❌ **${apFailed}** failed (expired token / no auth)\n` +
                  `⏭️ **${apSkipped}** skipped (stream offline)`
                )
                .setFooter({ text: `Streamer: ${apStreamer} • No browsers used` })
                .setTimestamp()
            ]});
          }
          break;
        }

        // ============================
        // !stopapiwatch [username] — Stop API watchers
        // ============================
        case 'stopapiwatch': {
          const stopApTarget = args[0];
          if (stopApTarget) {
            const acc = findByUsername(stopApTarget);
            if (!acc) return msg.channel.send(`Account \`${stopApTarget}\` not found.`);
            const stopped = stopApiWatching(acc.id);
            await msg.channel.send(stopped ? `⏹️ \`${stopApTarget}\` API watcher stopped.` : `\`${stopApTarget}\` was not API watching.`);
          } else {
            const n = stopAllApiWatching();
            await msg.channel.send(`⏹️ Stopped **${n}** API watchers.`);
          }
          break;
        }

        // ============================
        // !apiwatchers — Show active API watchers
        // ============================
        case 'apiwatchers': {
          const aw = getApiWatchers();
          const entries = Object.values(aw);
          if (entries.length === 0) return msg.channel.send('No active API watchers.');
          const lines = entries.map(w => {
            const uptime = Math.round((Date.now() - w.startedAt) / 60000);
            return `🌐 \`${w.username}\` → ${w.streamer} (${uptime}m, ${w.minutesSent} events sent)`;
          });
          // Discord message limit: split if needed
          const chunks = [];
          let cur = `**API Watchers (${entries.length})**\n`;
          for (const line of lines) {
            if (cur.length + line.length + 1 > 1900) { chunks.push(cur); cur = ''; }
            cur += line + '\n';
          }
          if (cur) chunks.push(cur);
          for (const chunk of chunks) await msg.channel.send(chunk);
          break;
        }

        // ============================
        // !stoprotation — Disable auto-replace
        // ============================
        case 'stoprotation': {
          rotationStreamer = null;
          await msg.channel.send(`🔄 Auto-replace OFF.`);
          break;
        }

        // ============================
        // !watchers — Show active watchers
        // ============================
        case 'watchers': {
          const w = getWatchers();
          if (w.length === 0) return msg.channel.send('No active watchers.');
          const lines = w.map(x => {
            const acc = accounts[x.accountId];
            const user = acc?.twitchData?.username || acc?.username || x.accountId;
            return `📺 \`${user}\` → ${x.streamer} (${x.uptime})`;
          });
          await msg.channel.send(`**Watchers (${w.length})**\n${lines.join('\n')}`);
          break;
        }

        // ============================
        // !drops [username|all] — Check drops status
        // ============================
        case 'drops': {
          const specificUser = args[0];
          if (!specificUser) return msg.channel.send('Usage: `!drops <username>` or `!drops all`');

          let accountsToCheck = [];
          if (specificUser.toLowerCase() === 'all') {
            accountsToCheck = Object.values(accounts).filter(a => a.cookies && a.cookies.length > 0);
            // Skip accounts checked in the last 10 minutes (already claimed)
            const SKIP_MS = 10 * 60 * 1000;
            const skipped = accountsToCheck.filter(a => a.dropsCheckedAt && (Date.now() - a.dropsCheckedAt) < SKIP_MS);
            accountsToCheck = accountsToCheck.filter(a => !a.dropsCheckedAt || (Date.now() - a.dropsCheckedAt) >= SKIP_MS);
            if (accountsToCheck.length === 0) return msg.channel.send(`All accounts checked recently. Wait ${Math.round((SKIP_MS - (Date.now() - skipped[0]?.dropsCheckedAt)) / 60000)}min or use \`!drops <user>\` for a specific account.`);
            let msgText = `🔍 Checking drops for **${accountsToCheck.length}** accounts (2 at a time)`;
            if (skipped.length > 0) msgText += `\n⏭ Skipping ${skipped.length} recently checked`;
            await msg.channel.send(msgText);
          } else {
            const acc = findByUsername(specificUser);
            if (!acc) return msg.channel.send(`Account \`${specificUser}\` not found.`);
            if (!acc.cookies || acc.cookies.length === 0) return msg.channel.send(`❌ \`${specificUser}\` has no cookies.`);
            accountsToCheck = [acc];
            await msg.channel.send(`🔍 Checking drops for \`${specificUser}\`...`);
          }

          const { AttachmentBuilder } = require('discord.js');
          let summary = { total: 0, claimable: 0, watching: 0, noDrops: 0, errors: 0 };

          // Fast drops check function — with timeout protection
          async function checkDropsForAccount(acc, idx) {
            const user = acc.twitchData?.username || acc.username || acc.id;
            let browser = null;
            let screenshotPath = null;
            let tmpDir = null;
            const startTime = Date.now();
              const TIMEOUT_MS = 240000; // 4 minutes max per account
            try {
              const puppeteer = require('puppeteer');
              let proxyPort = null;
              if (PROXY_URL) proxyPort = await startLocalProxy();
              let launchArgs = ['--mute-audio', '--disable-blink-features=AutomationControlled'];
              if (proxyPort) launchArgs.push('--proxy-server=http://127.0.0.1:' + proxyPort);

              const chromePaths = [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                process.env.CHROME_PATH,
              ];
              let chromePath = null;
              for (const p of chromePaths) {
                if (p && fs.existsSync(p)) { chromePath = p; break; }
              }

              tmpDir = path.join(__dirname, '../tmp_profiles/drops_' + Date.now() + '_' + idx);
              try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}

              if (chromePath) {
                browser = await puppeteer.launch({
                  executablePath: chromePath, headless: true,
                  args: launchArgs.concat(['--user-data-dir=' + tmpDir]),
                  env: { ...process.env },
                });
              } else {
                const pwf = require('puppeteer-with-fingerprints');
                const plugin = pwf.plugin;
                const fingerprints = await plugin.fetch('', { tags: ['Microsoft Windows', 'Chrome'] });
                plugin.useFingerprint(fingerprints);
                browser = await plugin.launch({ args: launchArgs });
              }
              const page = await browser.newPage();

              // Fast login: inject cookies directly on drops page
              await page.goto('https://www.twitch.tv/', { waitUntil: 'domcontentloaded', timeout: 30000 });
              if (Date.now() - startTime > TIMEOUT_MS) throw new Error('timeout');
              await new Promise(r => setTimeout(r, 2000));
              await page.setCookie(...acc.cookies);
              await page.goto('https://www.twitch.tv/drops/inventory', { waitUntil: 'networkidle2', timeout: 45000 });
              await new Promise(r => setTimeout(r, 5000));

              // Check if logged in — detect "You must be logged in" or "Log In" button
              const notLoggedIn = await page.evaluate(() => {
                const body = document.body.innerText;
                return body.includes('must be logged in') || body.includes('You must log in') ||
                  body.includes('يجب تسجيل الدخول') || body.includes('Log In') && body.includes('Sign Up') &&
                  !body.includes('Inventory') && !body.includes('Drops');
              });
              if (notLoggedIn) {
                console.log(`DEBUG [!drops] ${user}: cookies expired — trying manual login`);
                const username = acc.twitchData?.username || acc.username;
                const password = acc.password;
                if (username && password) {
                  try {
                    // Go to login page
                    await page.goto('https://www.twitch.tv/login', { waitUntil: 'networkidle2', timeout: 30000 });
                    await new Promise(r => setTimeout(r, 3000));

                    // Fill username
                    const usernameInput = await page.$('input[name="username"], input[autocomplete="username"]');
                    if (!usernameInput) {
                      console.log(`DEBUG [!drops] ${user}: no username input found`);
                      summary.errors++;
                      return;
                    }
                    await usernameInput.click({ clickCount: 3 });
                    await usernameInput.type(username, { delay: 30 });
                    await new Promise(r => setTimeout(r, 500));

                    // Fill password
                    const passInput = await page.$('input[name="password"], input[type="password"]');
                    if (!passInput) {
                      console.log(`DEBUG [!drops] ${user}: no password input found`);
                      summary.errors++;
                      return;
                    }
                    await passInput.click({ clickCount: 3 });
                    await passInput.type(password, { delay: 30 });
                    await new Promise(r => setTimeout(r, 500));

                    // Click login button
                    await page.evaluate(() => {
                      const btns = document.querySelectorAll('button');
                      for (const btn of btns) {
                        const t = btn.textContent.trim().toLowerCase();
                        if (t === 'log in' || t === 'iniciar sesión' || t === 'iniciar sesion' ||
                            t === 'connexion' || t === 'anmelden' || t === 'giriş yap' ||
                            t === 'entrar' || t === 'accedi') {
                          btn.click(); return;
                        }
                      }
                    });
                    await new Promise(r => setTimeout(r, 5000));

                    // Handle ALL possible login steps in a loop
                    for (let step = 0; step < 5; step++) {
                      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
                      const pageUrl = page.url();
                      console.log(`DEBUG [!drops] ${user}: login step ${step}, url=${pageUrl.slice(0, 80)}`);

                      // Already logged in — on dashboard/home
                      if (!pageText.includes('Log in') && !pageText.includes('Iniciar sesión') &&
                          !pageText.includes('Anmelden') && (pageText.includes('Inventory') || pageText.includes('Drops') ||
                          pageUrl.includes('/drops') || pageUrl.includes('/settings'))) {
                        console.log(`DEBUG [!drops] ${user}: login success`);
                        break;
                      }

                      // Verification code needed (email/SMS/authenticator)
                      const needsCode = pageText.includes('Verify') || pageText.includes('Verification') ||
                        pageText.includes('Check your email') || pageText.includes('Check your phone') ||
                        pageText.includes('Enter the code') || pageText.includes('security code') ||
                        pageText.includes('التحقق') || pageText.includes('أدخل الرمز') ||
                        pageText.includes('Código') || pageText.includes('code') && pageText.includes('sent') ||
                        pageText.includes('Authenticator') || pageText.includes('Two-Factor');

                      if (needsCode) {
                        console.log(`DEBUG [!drops] ${user}: verification code needed`);

                        // Try to find any input field for the code
                        const codeInput = await page.$('input[name="authy_token"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="6"], input[name="code"], input[type="tel"]');
                        if (codeInput) {
                          // Wait for IMAP code
                          try {
                            const email = acc.email || `${username}@${DOMAIN.split(',')[0].trim()}`;
                            console.log(`DEBUG [!drops] ${user}: waiting for IMAP code on ${email}`);
                            const inbox = await emailReader.createInbox(email);
                            const code = await emailReader.waitForCode(inbox, 90000);
                            if (code) {
                              console.log(`DEBUG [!drops] ${user}: got code ${code}`);
                              await codeInput.click({ clickCount: 3 });
                              await codeInput.type(code, { delay: 50 });
                              await new Promise(r => setTimeout(r, 500));

                              // Click submit/verify/continue
                              await page.evaluate(() => {
                                const btns = document.querySelectorAll('button');
                                for (const btn of btns) {
                                  const t = btn.textContent.trim().toLowerCase();
                                  if (t.includes('submit') || t.includes('verify') || t.includes('confirm') ||
                                      t.includes('continue') || t.includes('next') || t.includes('log in') ||
                                      t.includes('entrar') || t.includes('enviar') || t.includes('verificar')) {
                                    btn.click(); return;
                                  }
                                }
                              });
                              await new Promise(r => setTimeout(r, 5000));
                              continue;
                            }
                          } catch (codeErr) {
                            console.log(`DEBUG [!drops] ${user}: IMAP code failed: ${codeErr.message}`);
                            summary.errors++;
                            return;
                          }
                        } else {
                          console.log(`DEBUG [!drops] ${user}: no code input found`);
                        }
                      }

                      // CAPTCHA detected
                      const hasCaptcha = pageText.includes('prove you') || pageText.includes('robot') ||
                        pageText.includes('captcha') || pageText.includes('I\'m not a robot') ||
                        pageText.includes('Human Verification') || pageText.includes('إنسان');
                      if (hasCaptcha) {
                        console.log(`DEBUG [!drops] ${user}: CAPTCHA detected — cannot solve, skipping`);
                        summary.errors++;
                        return;
                      }

                      // Wrong password / login error
                      const hasLoginError = pageText.includes('incorrect') || pageText.includes('Invalid') ||
                        pageText.includes('Wrong') || pageText.includes('incorrect password') ||
                        pageText.includes('كلمة المرور') || pageText.includes('حدث خطأ');
                      if (hasLoginError) {
                        console.log(`DEBUG [!drops] ${user}: login error — wrong credentials`);
                        summary.errors++;
                        return;
                      }

                      // Still on login page, try clicking login button again
                      const loginBtn = await page.$('button[data-a-target="login-button"], button[type="submit"]');
                      if (loginBtn) {
                        await loginBtn.click();
                        await new Promise(r => setTimeout(r, 5000));
                        continue;
                      }

                      // Wait and check again
                      await new Promise(r => setTimeout(r, 3000));
                    }

                    // Final check — are we logged in?
                    const finalCheck = await page.evaluate(() => {
                      const body = document.body.innerText;
                      return body.includes('must be logged in') || body.includes('Log In') && body.includes('Sign Up');
                    });
                    if (finalCheck) {
                      console.log(`DEBUG [!drops] ${user}: manual login failed after all steps`);
                      summary.errors++;
                      return;
                    }

                    // Reload page to ensure cookies are fully set, then save
                    await page.reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                    await new Promise(r => setTimeout(r, 3000));
                    const freshCookies = await page.cookies();
                    acc.cookies = freshCookies;
                    const { saveAccounts: saveAccs } = require('./state');
                    saveAccs();
                    console.log(`DEBUG [!drops] ${user}: manual login succeeded — saved ${freshCookies.length} fresh cookies`);

                    // Navigate to drops page
                    await page.goto('https://www.twitch.tv/drops/inventory', { waitUntil: 'networkidle2', timeout: 45000 });
                    await new Promise(r => setTimeout(r, 5000));
                  } catch (loginErr) {
                    console.log(`DEBUG [!drops] ${user}: login error: ${loginErr.message}`);
                    summary.errors++;
                    return;
                  }
                } else {
                  console.log(`DEBUG [!drops] ${user}: no username/password — skipping`);
                  summary.errors++;
                  return;
                }
              }

              // Accept cookie consent banner FIRST — covers the page
              await page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                  const text = btn.textContent.trim().toLowerCase();
                  if (text === 'accept' || text === 'accepter' || text === 'aceptar' ||
                      text === 'akzeptieren' || text === 'aceitar' || text === 'kabul et' ||
                      text === 'قبول') {
                    btn.click();
                    return;
                  }
                }
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 2000));

              // Close user menu if open + dismiss modal
              await page.keyboard.press('Escape').catch(() => {});
              await new Promise(r => setTimeout(r, 500));
              await page.keyboard.press('Escape').catch(() => {});
              await new Promise(r => setTimeout(r, 1000));

              // Close Whispers panel — it covers claim buttons on right side
              await page.evaluate(() => {
                document.querySelectorAll('[data-a-target="close-wisper"], [aria-label="Close whisper"], [aria-label="Close Whispers"]').forEach(b => b.click());
                // Also click X button near top-right whisper panel
                const closeBtns = document.querySelectorAll('button[aria-label="Close"]');
                closeBtns.forEach(b => {
                  const rect = b.getBoundingClientRect();
                  if (rect.x > 1200) b.click(); // Only close buttons on the right side (Whispers)
                });
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 1000));
              // Click somewhere neutral to close any open menus
              await page.mouse.click(600, 400).catch(() => {});
              await new Promise(r => setTimeout(r, 1000));

              // Dismiss ALL popups
              for (let d = 0; d < 3; d++) {
                await page.evaluate(() => {
                  document.querySelectorAll('[data-a-target="close-wisper"], [aria-label="Close whisper"], [aria-label="Close Whispers"]').forEach(b => b.click());
                  document.querySelectorAll('[data-a-target="tw-alert-banner"] button, [aria-label="Dismiss"]').forEach(b => b.click());
                  document.querySelectorAll('[data-a-target="modal-close-button"], [aria-label="Close"]').forEach(b => b.click());
                });
                await page.keyboard.press('Escape').catch(() => {});
                await new Promise(r => setTimeout(r, 500));
              }

              // Check URL — must be on drops page
              const currentUrl = page.url();
              const onDropsPage = currentUrl.includes('/drops/inventory') || currentUrl.includes('/drops?');
              console.log(`DEBUG [!drops] ${user}: onDropsPage=${onDropsPage}, url=${currentUrl}`);

              if (!onDropsPage) {
                // Not on drops page — try navigating again
                await page.goto('https://www.twitch.tv/drops/inventory', { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 5000));
              }

              // Wait for page content to load — try multiple selectors
              const pageLoaded = await page.evaluate(() => {
                const body = document.body.innerText;
                return body.includes('Drops') || body.includes('Inventory') || body.includes('Claim') || body.includes('المطالبة');
              });
              if (!pageLoaded) {
                console.log(`DEBUG [!drops] ${user}: page content not loaded, waiting more...`);
                await new Promise(r => setTimeout(r, 5000));
              }

              // Always save screenshot of drops inventory
              screenshotPath = path.join(PICDROPS_DIR, `${user}_drops.png`);
              await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

              // Dismiss any remaining error banner before looking for claims
              await page.evaluate(() => {
                document.querySelectorAll('[data-a-target="tw-alert-banner"] button, [aria-label="Dismiss"], [data-a-target="alert-modal-close"]').forEach(b => b.click());
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 1000));

              // Scroll to top first, then scroll down slowly to find all claim buttons
              await page.evaluate(() => window.scrollTo(0, 0));
              await new Promise(r => setTimeout(r, 500));
              for (let i = 0; i < 10; i++) {
                await page.evaluate(() => window.scrollBy(0, 400));
                await new Promise(r => setTimeout(r, 500));
              }
              // Scroll back to top
              await page.evaluate(() => window.scrollTo(0, 0));
              await new Promise(r => setTimeout(r, 500));

              // Check if account has "Connect" button (game not linked)
              const hasConnect = await page.evaluate(() => {
                for (const btn of document.querySelectorAll('button')) {
                  if (btn.offsetParent === null) continue;
                  const t = btn.textContent.trim().toLowerCase();
                  if (t.includes('connect') && !t.includes('claim')) return true;
                }
                return false;
              });

              // Click "Claim Now" ONE AT A TIME — clicking all at once causes "Drop was not claimed"
              const claimedInfo = { claimed: 0, claimedNames: [], failed: [], notConnected: hasConnect };
              const claimBtnTexts = await page.evaluate(() => {
                const btns = [];
                for (const btn of document.querySelectorAll('button')) {
                  if (btn.offsetParent === null) continue;
                  const t = btn.textContent.trim().toLowerCase();
                  const tAr = btn.textContent.trim(); // Arabic is case-sensitive
                  const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                  const dt = (btn.getAttribute('data-a-target') || '').toLowerCase();
                  const isClaim = t === 'claim' || t === 'claim now' || t === 'claim drop' ||
                    dt === 'claim-button' || label.includes('claim') ||
                    tAr.includes('المطالبة') || tAr.includes('ادعاء');
                  const isConnect = t.includes('connect') || t.includes('conectar') || t.includes('connecter') || t.includes('اتصال');
                  if (isClaim && !isConnect) {
                    btns.push(btn.textContent.trim());
                  }
                }
                return btns;
              });
              console.log(`DEBUG [!drops] ${user}: found ${claimBtnTexts.length} claimable drop(s)`);

              for (const btnText of claimBtnTexts) {
                // Timeout check
                if (Date.now() - startTime > TIMEOUT_MS) {
                  console.log(`DEBUG [!drops] ${user}: timeout — stopping claims`);
                  break;
                }
                // Check if error already appeared — dismiss it and stop
                const hasErr = await page.evaluate(() => {
                  const body = document.body.innerText;
                  return /Drop was not claimed|لم يتم المطالبة|حدث خطأ|Error Occurred/i.test(body);
                });
                if (hasErr) {
                  console.log(`DEBUG [!drops] ${user}: stopping — error already on page`);
                  await page.evaluate(() => {
                    document.querySelectorAll('[data-a-target="alert-modal-close"], [aria-label="Close"], button[aria-label*="close" i]').forEach(b => b.click());
                  }).catch(() => {});
                  await new Promise(r => setTimeout(r, 1000));
                  break;
                }
                // Click the first available claim button
                await page.evaluate(() => {
                  for (const btn of document.querySelectorAll('button')) {
                    if (btn.offsetParent === null) continue;
                    const t = btn.textContent.trim().toLowerCase();
                    const tAr = btn.textContent.trim();
                    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                    const dt = (btn.getAttribute('data-a-target') || '').toLowerCase();
                    const isClaim = t === 'claim' || t === 'claim now' || t === 'claim drop' ||
                      dt === 'claim-button' || label.includes('claim') ||
                      tAr.includes('المطالبة') || tAr.includes('ادعاء');
                    const isConnect = t.includes('connect') || t.includes('conectar') || t.includes('connecter') || t.includes('اتصال');
                    if (isClaim && !isConnect) {
                      btn.click();
                      return;
                    }
                  }
                });
                console.log(`DEBUG [!drops] ${user}: clicked "${btnText}"`);

                // Wait longer for claim to process — Twitch needs time
                await new Promise(r => setTimeout(r, 8000));

                // Dismiss any popups/modals
                await page.evaluate(() => {
                  document.querySelectorAll('[data-a-target="alert-modal-close"], [aria-label="Close"], button[aria-label*="close" i]').forEach(b => b.click());
                }).catch(() => {});
                await new Promise(r => setTimeout(r, 1000));

                // Check if claim succeeded
                const result = await page.evaluate(() => {
                  const body = document.body.innerText;
                  const hasError = /Drop was not claimed|لم يتم المطالبة|حدث خطأ|Error Occurred/i.test(body);
                  let claimBtnsStillThere = 0;
                  for (const btn of document.querySelectorAll('button')) {
                    if (btn.offsetParent === null) continue;
                    const t = btn.textContent.trim().toLowerCase();
                    const tAr = btn.textContent.trim();
                    const dt = (btn.getAttribute('data-a-target') || '').toLowerCase();
                    const isClaim = t === 'claim' || t === 'claim now' || t === 'claim drop' || dt === 'claim-button';
                    const isConnect = t.includes('connect');
                    if (isClaim && !isConnect) claimBtnsStillThere++;
                  }
                  return { hasError, claimBtnsStillThere };
                });

                if (result.hasError) {
                  console.log(`DEBUG [!drops] ${user}: ❌ "${btnText}" FAILED (error banner)`);
                  claimedInfo.failed.push(btnText);
                  // Dismiss error banner
                  await page.evaluate(() => {
                    document.querySelectorAll('[data-a-target="alert-modal-close"], [aria-label="Close"], button[aria-label*="close" i]').forEach(b => b.click());
                  }).catch(() => {});
                  await new Promise(r => setTimeout(r, 1500));
                  break; // Stop — further claims will also fail
                }

                // No error — claim succeeded
                claimedInfo.claimed++;
                claimedInfo.claimedNames.push(btnText);
                console.log(`DEBUG [!drops] ${user}: ✅ "${btnText}" claimed (${result.claimBtnsStillThere} claim btns remaining)`);
                await new Promise(r => setTimeout(r, 3000));

                // Reload drops page to get clean state before next claim
                if (claimBtnTexts.indexOf(btnText) < claimBtnTexts.length - 1) {
                  await page.goto('https://www.twitch.tv/drops/inventory', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                  await new Promise(r => setTimeout(r, 5000));
                  // Re-scroll to see all content
                  for (let i = 0; i < 5; i++) await page.evaluate(() => window.scrollBy(0, 300));
                  await new Promise(r => setTimeout(r, 1000));
                }
              }

              // Read drops progress after claiming
              const dropsInfo = await page.evaluate((isDropsPage) => {
                const body = document.body.innerText;
                const dropCards = document.querySelectorAll('[data-a-target="drops-dashboard-collection-item"]');
                const drops = [];
                const allBtns = document.querySelectorAll('button');

                for (const card of dropCards) {
                  const text = card.textContent.trim();
                  const claimBtn = card.querySelector('button');
                  const btnText = claimBtn ? claimBtn.textContent.trim().toLowerCase() : '';
                  const btnLabel = claimBtn ? (claimBtn.getAttribute('aria-label') || '').toLowerCase() : '';
                  const btnDt = claimBtn ? (claimBtn.getAttribute('data-a-target') || '').toLowerCase() : '';
                  const btnTextAr = claimBtn ? claimBtn.textContent.trim() : '';
                  const isConnecting = btnText.includes('connect') || btnText.includes('conectar') ||
                    btnLabel.includes('connect') || btnText.includes('connecter') || btnText.includes('اتصال') ||
                    btnTextAr.includes('اتصال');
                  const isClaimBtn = btnText === 'claim' || btnText === 'claim now' || btnText === 'claim drop' ||
                    btnLabel.includes('claim') || btnDt === 'claim-button' ||
                    btnTextAr.includes('المطالبة') || btnTextAr.includes('ادعاء');
                  const canClaim = claimBtn && claimBtn.offsetParent !== null && !isConnecting && isClaimBtn;

                  const progressMatch = text.match(/(\d+\.?\d*)\s*%\s*(?:of|de|von|dan|من|saat|ساعات?|horas?|heures?|Stunden?|ساعتين?)\s*(\d+\.?\d*)/i)
                    || text.match(/(\d+\.?\d*)\s*%\s*\/\s*(\d+)/i);
                  const arMatch = text.match(/(\d+\.?\d*)\s*%\s*من\s*(?:ساعة\s*و(?:ثلاثين|ثلاثون)\s*دقيقة|(ساعتين?|ساعات?\s*\d+))/i);
                  let prog = progressMatch;
                  if (!prog && arMatch) {
                    const pct = parseFloat(arMatch[1]);
                    if (/ثلاثين|ثلاثون/.test(text)) prog = { 1: String(pct), 2: '1.5' };
                    else {
                      const hMatch = text.match(/(\d+)\s*ساع/);
                      if (hMatch) prog = { 1: String(pct), 2: hMatch[1] };
                    }
                  }

                  const pctDone = prog ? Math.round((parseFloat(prog[1]) / parseFloat(prog[2])) * 100) : null;

                  drops.push({
                    name: text.slice(0, 150),
                    canClaim,
                    progress: prog ? { current: parseFloat(prog[1]), total: parseFloat(prog[2]), pct: pctDone } : null,
                  });
                }

                const hasNoDrops = /no drops|no hay drops|aucun drop|keine drops|لا توجد عناصر|não tienes itens|Todavía no tienes|لا توجد drops/i.test(body);
                const hasRLCS = isDropsPage && dropCards.length > 0 && /RLCS|Rocket League/i.test(body);
                const claimableDrops = drops.filter(d => d.canClaim);
                const inProgressDrops = drops.filter(d => !d.canClaim && d.progress);

                return { drops, hasNoDrops, hasRLCS, claimableDrops, inProgressDrops };
              }, onDropsPage);

              // Merge claimed info
              dropsInfo.claimed = claimedInfo.claimed;
              dropsInfo.claimedNames = claimedInfo.claimedNames;

              // Final screenshot
              await new Promise(r => setTimeout(r, 1000));
              await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

              summary.total++;
              if (dropsInfo.claimed > 0) summary.claimable += dropsInfo.claimed;
              else if (dropsInfo.claimableDrops.length > 0) summary.claimable++;
              else if (dropsInfo.inProgressDrops.length > 0 || dropsInfo.hasRLCS) summary.watching++;
              else summary.noDrops++;

              let line = '';
              if (!onDropsPage) {
                line = `⚠️ \`${user}\` — Redirected (not logged in?)`;
              } else if (claimedInfo.notConnected && dropsInfo.claimableDrops.length > 0) {
                line = `⚠️ \`${user}\` — 🔗 **Game not connected!** ${dropsInfo.claimableDrops.length} drop(s) ready but can't claim`;
              } else if (dropsInfo.claimed > 0) {
                line = `✅ \`${user}\` — 🎉 **CLAIMED ${dropsInfo.claimed}!**`;
              } else if (dropsInfo.claimableDrops.length > 0) {
                line = `✅ \`${user}\` — 🎁 **${dropsInfo.claimableDrops.length} READY TO CLAIM!**`;
              } else if (dropsInfo.inProgressDrops.length > 0) {
                const lines = dropsInfo.inProgressDrops.map(d => `${d.progress.pct}% of ${d.progress.total}h`);
                line = `✅ \`${user}\` — ⏱ ${lines.join(', ')}`;
              } else {
                line = `✅ \`${user}\` — ${dropsInfo.hasRLCS ? '🎮 RLCS active' : 'No drops'}`;
              }

              // Single account — full embed details
              if (accountsToCheck.length === 1) {
                const fields = [];
                if (!onDropsPage) {
                  fields.push({ name: '⚠️ Status', value: `Redirected to: ${currentUrl}\nNot logged in?`, inline: false });
                }
                if (claimedInfo.notConnected) {
                  fields.push({ name: '🔗 Game Not Connected', value: 'Account hasn\'t linked game platform.\nClaim will fail — connect game first.', inline: false });
                }
                if (dropsInfo.claimed > 0) {
                  const claimLines = dropsInfo.claimedNames;
                  const claimBuf = [];
                  let claimFieldLen = 0;
                  for (const name of claimLines) {
                    const needed = claimFieldLen === 0 ? name.length : claimFieldLen + 1 + name.length;
                    if (needed > 1000) {
                      fields.push({ name: fields.length === 0 ? '🎉 Claimed' : '\u200b', value: claimBuf.join('\n'), inline: false });
                      claimBuf.length = 0; claimFieldLen = 0;
                    }
                    claimBuf.push(name);
                    claimFieldLen = claimBuf.join('\n').length;
                  }
                  if (claimBuf.length) fields.push({ name: '🎉 Claimed', value: claimBuf.join('\n'), inline: false });
                }
                if (dropsInfo.drops.length > 0) {
                  for (const drop of dropsInfo.drops) {
                    let status = '';
                    if (drop.canClaim) status = '🎁 **READY TO CLAIM!**';
                    else if (drop.progress) status = `⏱ ${drop.progress.pct}% of ${drop.progress.total}h`;
                    else status = '👀 Watching...';
                    fields.push({ name: drop.name.slice(0, 40), value: status, inline: true });
                  }
                } else if (dropsInfo.hasRLCS) {
                  fields.push({ name: '🎮 Campaign', value: 'RLCS active', inline: false });
                } else if (dropsInfo.hasNoDrops) {
                  fields.push({ name: '📭 Drops', value: 'No drops available', inline: false });
                }
                const color = dropsInfo.claimed > 0 ? 0x00FF00 : dropsInfo.claimableDrops.length > 0 ? 0xFFAA00 : 0x9146FF;
                const embeds = [{
                  title: `🎁 Drops — \`${user}\``,
                  color,
                  fields,
                }];
                const attachments = [];
                if (screenshotPath) {
                  attachments.push(new AttachmentBuilder(screenshotPath));
                }
                await msg.channel.send({ embeds, files: attachments.length > 0 ? attachments : [] }).catch(() => {});
              } else {
                await msg.channel.send(line);
                if (screenshotPath) {
                  const attachment = new AttachmentBuilder(screenshotPath);
                  await msg.channel.send({ content: `📸 ${user}:`, files: [attachment] }).catch(() => {});
                }
              }
            } catch (e) {
              summary.errors++;
              if (accountsToCheck.length === 1) {
                await msg.channel.send(`❌ Error checking drops: ${e.message}`);
              } else {
                await msg.channel.send(`❌ \`${user}\`: ${e.message}`);
              }
            } finally {
              if (browser) try { await browser.close(); } catch {}
              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
              try { fs.unlinkSync(screenshotPath); } catch(e) {}
              const accObj = accounts[acc.id];
              if (accObj) {
                accObj.dropsCheckedAt = Date.now();
                saveAccounts();
              }
            }
          }

          // Run accounts in parallel (2 at a time)
          if (accountsToCheck.length === 1) {
            await checkDropsForAccount(accountsToCheck[0], 0);
          } else {
            const CONCURRENCY = 2;
            for (let i = 0; i < accountsToCheck.length; i += CONCURRENCY) {
              const batch = accountsToCheck.slice(i, i + CONCURRENCY);
              const results = await Promise.allSettled(batch.map((acc, j) => checkDropsForAccount(acc, i + j)));
              // Log any crashes
              results.forEach((r, idx) => {
                if (r.status === 'rejected') {
                  const u = batch[idx].twitchData?.username || batch[idx].username || '?';
                  console.log(`DEBUG [!drops] ${u}: crashed — ${r.reason?.message || r.reason}`);
                }
              });
              // Small delay between batches
              if (i + CONCURRENCY < accountsToCheck.length) {
                await new Promise(r => setTimeout(r, 3000));
              }
            }
          }

          // Summary for all accounts
          if (accountsToCheck.length > 1) {
            const dropsSummaryEmbed = {
              title: '📊 Drops Summary',
              color: summary.claimable > 0 ? 0x00FF00 : 0xFFAA00,
              fields: [
                { name: '📋 Checked', value: `${summary.total}`, inline: true },
                { name: '🎁 Claimable', value: `${summary.claimable}`, inline: true },
                { name: '⏱ Watching', value: `${summary.watching}`, inline: true },
                { name: '❌ Errors', value: `${summary.errors}`, inline: true },
              ],
              timestamp: new Date().toISOString(),
            };
            await msg.channel.send({ embeds: [dropsSummaryEmbed] });
          }
          break;
        }

        // ============================
        // !checkfollow [username|all] — Check if accounts follow rocketleague
        // ============================
        case 'checkfollow': {
          const specificUser = args[0];
          if (!specificUser) return msg.channel.send('Usage: `!checkfollow <username> [parallel]` or `!checkfollow all [parallel]`');
          const checkParallel = Math.min(parseInt(args[1]) || 2, 15);

          let accountsToCheck = [];
          if (specificUser.toLowerCase() === 'all') {
            accountsToCheck = Object.values(accounts).filter(a => a.cookies && a.cookies.length > 0);
            if (accountsToCheck.length === 0) return msg.channel.send('No accounts with cookies available.');
          } else {
            const acc = findByUsername(specificUser);
            if (!acc) return msg.channel.send(`Account \`${specificUser}\` not found.`);
            if (!acc.cookies || acc.cookies.length === 0) return msg.channel.send(`❌ \`${specificUser}\` has no cookies.`);
            accountsToCheck = [acc];
          }

          const startEmbed = new EmbedBuilder()
            .setColor(0x9146FF)
            .setTitle('🔍 Follow Check')
            .setDescription(`Checking rocketleague follow for **${accountsToCheck.length}** account(s) (${checkParallel} parallel)...`)
            .setTimestamp();
          const liveMsg = await msg.channel.send({ embeds: [startEmbed] });

          let summary = { following: 0, notFollowing: 0, errors: 0, autoFollowed: 0 };
          const puppeteer = require('puppeteer');
          const fs = require('fs');
          const chromePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.CHROME_PATH,
          ].filter(Boolean);
          let chromePath = null;
          for (const p of chromePaths) {
            if (fs.existsSync(p)) { chromePath = p; break; }
          }
          if (!chromePath) {
            return msg.channel.send('❌ Chrome not found on this machine. Set CHROME_PATH env variable.');
          }

          // Run accounts in parallel for speed
          const CONCURRENCY = checkParallel;
          let completed = 0;
          const total = accountsToCheck.length;

          async function checkOne(acc, idx) {
            const user = acc.twitchData?.username || acc.username || acc.id;
            let browser = null, chromeProc = null;
            let tmpDir = null;
            try {
              let proxyPort = null;
              if (PROXY_URL) proxyPort = await startLocalProxy();

              const os_cf = require('os');
              const IS_SERVER_CF = process.platform === 'linux' || process.env.SERVER_MODE === '1';
              const stealthCF = IS_SERVER_CF ? require('./stealth/serverLauncher.js') : require('./stealth/index.js');

              tmpDir = require('path').join(os_cf.tmpdir(), 'checkfollow_' + Date.now() + '_' + idx);
              try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}

              const cfLaunched = await stealthCF.launch({
                userDataDir: tmpDir,
                proxyPort: proxyPort || undefined,
                kpsdkDelay: 12000,
                windowSize: { width: 1280, height: 720 },
              });
              browser = cfLaunched.browser;
              chromeProc = cfLaunched.chromeProc;
              const page = cfLaunched.page;

              const stealthPatchCF = () => {
                try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch(e) {}
                try {
                  if (window.chrome && !window.chrome.runtime) {
                    Object.defineProperty(window.chrome, 'runtime', {
                      value: { id: undefined, connect: () => ({}), sendMessage: () => {}, onMessage: { addListener: () => {}, removeListener: () => {} }, onConnect: { addListener: () => {}, removeListener: () => {} }, getURL: (p) => 'chrome-extension://' + p },
                      writable: true, configurable: true,
                    });
                  }
                } catch(e) {}
                try { for (const key of Object.getOwnPropertyNames(window)) { if (key.startsWith('cdc_')) { try { delete window[key]; } catch(e) {} } } } catch(e) {}
              };

              await page.evaluateOnNewDocument(stealthPatchCF).catch(() => {});
              await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 1000));
              await page.evaluate(stealthPatchCF).catch(() => {});

              // Set cookies on twitch.tv (already loaded by stealth launcher)
              await page.setCookie(...acc.cookies);

              // Navigate to the channel page with cookies active
              await page.goto('https://www.twitch.tv/rocketleague', { waitUntil: 'domcontentloaded', timeout: 45000 });
              await new Promise(r => setTimeout(r, 3000));
              await page.evaluate(stealthPatchCF).catch(() => {});
              await new Promise(r => setTimeout(r, 8000));

              if (!page.url().includes('rocketleague')) {
                await page.goto('https://www.twitch.tv/rocketleague', { waitUntil: 'domcontentloaded', timeout: 45000 });
                await new Promise(r => setTimeout(r, 8000));
              }

              await page.waitForSelector('button[data-a-target="follow-button"], button[data-a-target="unfollow-button"], button[aria-label*="ollow"], button[aria-label*="seguir"]', { timeout: 20000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 3000));
              await page.evaluate(() => window.scrollTo(0, 0));

              let result = await page.evaluate(() => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                  if (btn.offsetParent === null) continue;
                  const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                  const dataTarget = (btn.getAttribute('data-a-target') || '').toLowerCase();
                  if (label.includes('unfollow') || dataTarget === 'unfollow-button') return { status: 'following' };
                  if ((label.includes('follow') && !label.includes('unfollow')) || dataTarget === 'follow-button') { btn.click(); return { status: 'clicked' }; }
                }
                return { status: 'unknown' };
              });

              if (result.status === 'following') {
                summary.following++;
              } else if (result.status === 'clicked') {
                await new Promise(r => setTimeout(r, 3000));
                const verified = await page.evaluate(() => {
                  for (const btn of document.querySelectorAll('button')) {
                    if (btn.offsetParent === null) continue;
                    if ((btn.getAttribute('aria-label') || '').toLowerCase().includes('unfollow') || (btn.getAttribute('data-a-target') || '') === 'unfollow-button') return true;
                  }
                  return false;
                });
                if (verified) { summary.autoFollowed++; console.log(`DEBUG [checkfollow] Auto-followed for ${user}`); }
                else summary.notFollowing++;
              } else summary.notFollowing++;

            } catch (e) {
              summary.errors++;
              console.log(`DEBUG [checkfollow] Error for ${user}:`, e.message);
            } finally {
              if (chromeProc && chromeProc.pid) {
                try { require('child_process').execSync(`taskkill /F /T /PID ${chromeProc.pid}`, { stdio: 'ignore' }); } catch {}
                try { chromeProc.kill(); } catch {}
              }
              if (browser) try { browser.disconnect(); } catch {}
              if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
            }

            completed++;
            startEmbed
              .setColor(0xFFAA00)
              .setTitle(`🔍 Follow Check — [${completed}/${total}]`)
              .setFields(
                { name: '📊', value: `✅ ${summary.following} | 🔄 ${summary.autoFollowed} | ❌ ${summary.notFollowing + summary.errors} | ⏳ ${total - completed} left`, inline: false },
              );
            await liveMsg.edit({ embeds: [startEmbed] }).catch(() => {});
          }

          // Run with concurrency limit
          const queue = accountsToCheck.map((a, i) => ({ acc: a, idx: i }));
          const running = [];
          while (queue.length > 0 || running.length > 0) {
            while (running.length < CONCURRENCY && queue.length > 0) {
              const { acc, idx } = queue.shift();
              const p = checkOne(acc, idx).then(() => { running.splice(running.indexOf(p), 1); });
              running.push(p);
            }
            if (running.length > 0) await Promise.race(running);
          }

          startEmbed
            .setColor(0x00FF00)
            .setTitle('🔍 Follow Check — Complete')
            .setDescription(
              `✅ **${summary.following}** already following | 🔄 **${summary.autoFollowed}** auto-followed | ❌ **${summary.notFollowing}** failed | ⚠️ **${summary.errors}** errors\n` +
              `**${accountsToCheck.length}** account(s) checked`
            )
            .setFields([])
            .setTimestamp();
          await liveMsg.edit({ embeds: [startEmbed] });
          break;
        }

        // ============================
        // !view <channel> [count] [proxy_index] — Send fake viewers via proxy sites
        // ============================
        case 'view': {
          const channel = args[0];
          if (!channel) return msg.channel.send('Usage: `!view <channel> [count] [proxy_index]`\nProxy sites: ' + PROXY_SITES.map((p, i) => `${i + 1}: ${p.replace('https://www.', '')}`).join(', '));
          const count = parseInt(args[1]) || 10;
          const proxyIdx = parseInt(args[2]) || 1;
          if (count > 50) return msg.channel.send('Max 50 viewers per command.');
          if (proxyIdx < 1 || proxyIdx > PROXY_SITES.length) return msg.channel.send(`Proxy index must be 1-${PROXY_SITES.length}`);

          await msg.channel.send(`⏳ Starting ${count} viewers for \`${channel}\` via proxy ${proxyIdx}...`);
          try {
            const result = await startViewing(channel, count, proxyIdx - 1);
            await msg.channel.send(`📺 **${result.viewers}** viewers now watching \`${result.channel}\``);
          } catch (e) {
            await msg.channel.send(`❌ ${e.message}`);
          }
          break;
        }

        // ============================
        // !stopview <channel> — Stop viewer bot for a channel
        // ============================
        case 'stopview': {
          const channel = args[0];
          if (!channel) return msg.channel.send('Usage: `!stopview <channel>`');
          const stopped = await stopViewing(channel);
          if (stopped) {
            await msg.channel.send(`⏹️ Stopped viewers for \`${channel}\``);
          } else {
            await msg.channel.send(`No active viewers for \`${channel}\``);
          }
          break;
        }

        // ============================
        // !viewers — Show active viewer bots
        // ============================
        case 'viewers': {
          const viewers = getViewerStatus();
          if (viewers.length === 0) return msg.channel.send('No active viewer bots.');
          const lines = viewers.map(v => `📺 \`${v.channel}\` — ${v.viewers} viewers${v.stopped ? ' (stopping)' : ''}`);
          await msg.channel.send(`**Viewer Bots (${viewers.length})**\n${lines.join('\n')}`);
          break;
        }

        // ============================
        // !delete <username> — Delete an account
        // ============================
        case 'delete': {
          const user = args[0];
          if (!user) return msg.channel.send('Usage: `!delete <username>`');
          const acc = findByUsername(user);
          if (!acc) return msg.channel.send(`Account \`${user}\` not found.`);
          await stopWatching(acc.id);
          delete accounts[acc.id];
          saveAccounts();
          await msg.channel.send(`🗑️ Deleted \`${user}\``);
          break;
        }

        // ============================
        // !resetdrops — Clear skip timestamps so all accounts are re-checked
        // ============================
        case 'resetdrops': {
          let cleared = 0;
          for (const acc of Object.values(accounts)) {
            if (acc.dropsCheckedAt) {
              delete acc.dropsCheckedAt;
              cleared++;
            }
          }
          saveAccounts();
          await msg.channel.send(`🔄 Reset drops check timestamps for ${cleared} account(s). All will be re-checked on next \`!drops all\`.`);
          break;
        }

        // ============================
        // !checkcookies [username|all] [parallel] — Test cookies, refresh if broken
        // ============================
        case 'checkcookies': {
          const specificUser = args[0];
          if (!specificUser) return msg.channel.send('Usage: `!checkcookies <username>` or `!checkcookies all [parallel]`');
          const ccParallel = Math.min(parseInt(args[1]) || 2, 15);

          let accountsToCheck = [];
          if (specificUser.toLowerCase() === 'all') {
            accountsToCheck = Object.values(accounts).filter(a => a.cookies && a.cookies.length > 0 && a.password);
            if (accountsToCheck.length === 0) return msg.channel.send('No accounts with cookies + password available.');
          } else {
            const acc = findByUsername(specificUser);
            if (!acc) return msg.channel.send(`Account \`${specificUser}\` not found.`);
            if (!acc.cookies || acc.cookies.length === 0) return msg.channel.send(`❌ \`${specificUser}\` has no cookies.`);
            if (!acc.password) return msg.channel.send(`❌ \`${specificUser}\` has no saved password.`);
            accountsToCheck = [acc];
          }

          const startEmbed = new EmbedBuilder()
            .setColor(0x9146FF)
            .setTitle('🔐 Cookie Check')
            .setDescription(`Testing cookies for **${accountsToCheck.length}** account(s) (${ccParallel} parallel)...`)
            .setTimestamp();
          const liveMsg = await msg.channel.send({ embeds: [startEmbed] });

          let summary = { working: 0, refreshed: 0, failed: 0 };
          const IS_SERVER_CC = process.platform === 'linux' || process.env.SERVER_MODE === '1';
          const stealthCC = IS_SERVER_CC ? require('./stealth/serverLauncher.js') : require('./stealth/index.js');

          function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

          async function checkCookiesOne(acc, idx) {
            const user = acc.twitchData?.username || acc.username || acc.id;
            const username = acc.twitchData?.username || acc.username;
            const password = acc.password;
            const MAX_RETRIES = 2;
            let lastError = '';

            for (let retry = 1; retry <= MAX_RETRIES; retry++) {
              let browser = null, chromeProc = null;
              let tmpDir = null;
              try {
              tmpDir = path.join(__dirname, '../tmp_profiles/ck_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).slice(2, 6));
              try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}
              const launched = await stealthCC.launch({
                userDataDir: tmpDir,
                windowSize: { width: 1280, height: 720 },
              });
              browser = launched.browser;
              chromeProc = launched.chromeProc;
              const page = launched.page;

              // Full stealth patch — runs before KPSDK on every CDP-connected page load
              const stealthPatch = () => {
                // navigator.webdriver: CDP sets this to true — Kasada's primary detection signal
                try {
                  Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined,
                    configurable: true,
                  });
                } catch(e) {}
                // chrome.runtime: CDP removes it, KPSDK flags the absence
                try {
                  if (window.chrome && !window.chrome.runtime) {
                    Object.defineProperty(window.chrome, 'runtime', {
                      value: {
                        id: undefined,
                        connect: () => ({}),
                        sendMessage: () => {},
                        onMessage: { addListener: () => {}, removeListener: () => {} },
                        onConnect:  { addListener: () => {}, removeListener: () => {} },
                        getURL: (p) => 'chrome-extension://' + p,
                      },
                      writable: true,
                      configurable: true,
                    });
                  }
                } catch(e) {}
                // Remove cdc_ properties injected by CDP that Kasada scans for
                try {
                  for (const key of Object.getOwnPropertyNames(window)) {
                    if (key.startsWith('cdc_')) { try { delete window[key]; } catch(e) {} }
                  }
                } catch(e) {}
              };
              await page.evaluateOnNewDocument(stealthPatch).catch(() => {});

              // Wait for twitch.tv to fully settle after late-CDP connect
              await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
              await sleepMs(1000);

              // Patch the already-loaded page too (evaluateOnNewDocument only runs on next loads)
              await page.evaluate(stealthPatch).catch(() => {});

              // Early Kasada check — retry if browser blocked
              const earlyBlock = await page.evaluate(() => {
                const t = document.body?.innerText?.toLowerCase() || '';
                return t.includes('browser not currently supported') || t.includes('browser is not currently supported');
              });
              if (earlyBlock) {
                lastError = 'Kasada blocked — browser not supported';
                console.log(`DEBUG [checkcookies] ${user}: Kasada blocked on first load (attempt ${retry}/${MAX_RETRIES})`);
                if (retry < MAX_RETRIES) {
                  await new Promise(r => setTimeout(r, 10000));
                  continue;
                }
                summary.failed++;
                return;
              }

              await page.setCookie(...acc.cookies);

              // Go to /login — valid cookies cause Twitch to redirect to homepage (= logged in).
              // This is one navigation instead of reload+check, reducing CDP-connected page loads.
              await page.goto('https://www.twitch.tv/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
              await sleepMs(3000);

              // Reapply stealth patch on the freshly loaded document
              await page.evaluate(stealthPatch).catch(() => {});

              // Accept any cookie banner
              await page.evaluate(() => {
                const btns = document.querySelectorAll('button');
                for (const b of btns) {
                  const t = b.textContent.trim().toLowerCase();
                  if (['accept','accepter','aceptar','akzeptieren','aceitar','kabul et','قبول','接受'].includes(t)) { b.click(); return; }
                }
              }).catch(() => {});
              await sleepMs(1000);

              // Detect Kasada block on /login
              const loginPageBlock = await page.evaluate(() => {
                const t = document.body?.innerText?.toLowerCase() || '';
                return t.includes('browser not currently supported') || t.includes('browser is not currently supported');
              }).catch(() => false);
              if (loginPageBlock) {
                lastError = 'Kasada blocked on login page';
                console.log(`DEBUG [checkcookies] ${user}: Kasada blocked on /login (attempt ${retry}/${MAX_RETRIES})`);
                if (retry < MAX_RETRIES) { await new Promise(r => setTimeout(r, 10000)); continue; }
                summary.failed++;
                return;
              }

              // If Twitch redirected us away from /login, cookies are valid and we're logged in
              const redirectedAway = !page.url().includes('/login');

              // Check if logged in
              const loggedIn = redirectedAway || await page.evaluate(() => {
                const userMenu = document.querySelector('[data-a-target="user-menu"]') ||
                                 document.querySelector('[data-a-target="core-top-nav-avatar"]') ||
                                 document.querySelector('button[data-a-target="profile-menu-trigger"]') ||
                                 document.querySelector('[data-a-target="top-nav-container"] img[src*="profile"]') ||
                                 document.querySelector('button[aria-label*="avatar"]') ||
                                 document.querySelector('button[aria-label*="profil"]');
                if (userMenu) return true;
                const followingTab = document.querySelector('[data-a-target="following-tab"]') ||
                                    document.querySelector('a[data-a-target="top-nav-following"]');
                if (followingTab) return true;
                const topNav = document.querySelector('[data-a-target="top-nav-container"]') || document.querySelector('nav');
                if (topNav) {
                  const imgs = topNav.querySelectorAll('img');
                  for (const img of imgs) {
                    const src = img.src || '';
                    if (src.includes('profile') || src.includes('avatar') || src.includes('user')) return true;
                  }
                }
                const loginLinks = document.querySelectorAll('a[href*="/login"], a[href*="/signup"]');
                for (const link of loginLinks) {
                  if (link.offsetParent !== null || link.getBoundingClientRect().width > 0) return false;
                }
                return false;
              });

              if (loggedIn) {
                console.log(`DEBUG [checkcookies] ${user}: cookies WORK`);
                summary.working++;
                return;
              }

              // Cookies didn't work — already on /login from the cookie check, proceed to fill credentials
              console.log(`DEBUG [checkcookies] ${user}: cookies BROKEN, filling login form...`);

              // Wait for username input
              let usernameInput = null;
              for (let i = 0; i < 15; i++) {
                usernameInput = await page.$('#login-username');
                if (!usernameInput) usernameInput = await page.$('input[autocomplete="username"]');
                if (!usernameInput) usernameInput = await page.$('input[id*="login"][id*="username"]');
                if (usernameInput) break;
                await sleepMs(2000);
              }
              if (!usernameInput) {
                summary.failed++;
                return;
              }

              // Type username
              await usernameInput.click();
              await sleepMs(300);
              await page.keyboard.type(username, { delay: 50 });

              // Type password
              const pwInput = await page.$('#password-input, input[type="password"]');
              if (!pwInput) { summary.failed++; return; }
              await pwInput.click();
              await sleepMs(300);
              await page.keyboard.type(password, { delay: 50 });
              await sleepMs(1000);

              // Click login button
              await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 15000 }).catch(() => {});
              let loginBtn = await page.$('button[data-a-target="passport-login-button"]');
              if (!loginBtn) {
                loginBtn = await page.evaluateHandle(() => {
                  const buttons = document.querySelectorAll('button[type="submit"]');
                  for (const btn of buttons) {
                    if (btn.offsetParent !== null) return btn;
                  }
                  return null;
                });
                if (loginBtn && !loginBtn.asElement()) loginBtn = null;
                else if (loginBtn?.asElement) loginBtn = loginBtn.asElement();
              }
              if (loginBtn) await loginBtn.click();

              // Wait for login to process
              await sleepMs(5000);

              // Check for "username does not exist" — account was never created, delete it
              const userNotExist = await page.evaluate(() => {
                const t = document.body?.innerText?.toLowerCase() || '';
                return t.includes('this username does not exist') ||
                       t.includes('username does not exist') ||
                       t.includes("ce nom d'utilisateur n'existe pas") ||
                       t.includes('este nombre de usuario no existe') ||
                       t.includes('dieser benutzername existiert nicht') ||
                       t.includes('questo nome utente non esiste');
              }).catch(() => false);
              if (userNotExist) {
                console.log(`DEBUG [checkcookies] ${user}: username does not exist on Twitch — deleting from DB`);
                delete accounts[acc.id];
                saveAccounts();
                summary.failed++;
                return;
              }

              // Check for verification code
              const hasCodeForm = await page.evaluate(() => {
                const inputs = document.querySelectorAll('input');
                const small = [...inputs].filter(i => {
                  const r = i.getBoundingClientRect();
                  return r.width > 0 && r.width < 100 && r.height > 0;
                });
                return small.length >= 6;
              });

              if (hasCodeForm) {
                // Need verification code from IMAP
                const accEmail = acc.twitchData?.email || acc.email;
                console.log(`DEBUG [checkcookies] ${user}: needs verification code for ${accEmail}`);
                try {
                  const emailReader = require('./emailReader');
                  const codeStart = Date.now();
                  const code = await emailReader.waitForCode({ address: accEmail, type: 'imap', since: codeStart }, 90000);
                  if (code) {
                    const codeInput = await page.evaluateHandle(() => {
                      const inputs = document.querySelectorAll('input');
                      for (const inp of inputs) {
                        if (inp.type === 'text' || inp.type === 'tel' || inp.type === 'number' || inp.type === '') {
                          const r = inp.getBoundingClientRect();
                          if (r.width > 0 && r.width < 100) return inp;
                        }
                      }
                      return null;
                    });
                    if (codeInput && codeInput.asElement()) {
                      const digits = code.toString();
                      const boxes = await page.$('[data-a-target="passport-verification-code-modal"] input').catch(() => []);
                      const allBoxes = boxes.length >= 6 ? boxes : await page.$('input[maxlength="1"]').catch(() => []);
                      if (allBoxes.length >= 6) {
                        for (let i = 0; i < 6; i++) {
                          await allBoxes[i].click();
                          await page.keyboard.type(digits[i] || '', { delay: 100 });
                          await sleepMs(80);
                        }
                      } else {
                        await codeInput.asElement().click();
                        for (const digit of digits) {
                          await page.keyboard.type(digit, { delay: 150 });
                          await sleepMs(100);
                        }
                      }
                      // Click submit
                      const submitBtn = await page.evaluateHandle(() => {
                        const buttons = document.querySelectorAll('button');
                        for (const btn of buttons) {
                          const t = btn.textContent.trim().toLowerCase();
                          if (t === 'submit' || t === 'enviar' || t === 'envoyer' || t === 'absenden') return btn;
                        }
                        return null;
                      });
                      if (submitBtn && submitBtn.asElement()) await submitBtn.asElement().click();
                      else await page.keyboard.press('Enter');

                      // Wait for verification to process
                      for (let w = 0; w < 15; w++) {
                        await sleepMs(2000);
                        const loginGone = await page.evaluate(() => {
                          const links = document.querySelectorAll('a[href]');
                          for (const link of links) {
                            if ((link.getAttribute('href') || '').includes('/login')) return false;
                          }
                          return true;
                        });
                        if (loginGone) break;
                      }
                    } else {
                      summary.failed++;
                      return;
                    }
                  } else {
                    console.log(`DEBUG [checkcookies] ${user}: no verification code received`);
                    summary.failed++;
                    return;
                  }
                } catch (e) {
                  console.log(`DEBUG [checkcookies] ${user}: verification error: ${e.message}`);
                  summary.failed++;
                  return;
                }
              }

              // Final login check
              await sleepMs(5000);
              const finalLoggedIn = await page.evaluate(() => {
                const userMenu = document.querySelector('[data-a-target="user-menu"]') ||
                                 document.querySelector('[data-a-target="core-top-nav-avatar"]') ||
                                 document.querySelector('button[data-a-target="profile-menu-trigger"]');
                if (userMenu) return true;
                const loginLinks = document.querySelectorAll('a[href*="/login"]');
                for (const link of loginLinks) {
                  if (link.offsetParent !== null || link.getBoundingClientRect().width > 0) return false;
                }
                return true;
              });

              if (!finalLoggedIn) {
                lastError = 'Login failed — wrong password or account suspended';
                console.log(`DEBUG [checkcookies] ${user}: login FAILED (attempt ${retry}/${MAX_RETRIES})`);
                if (retry < MAX_RETRIES) {
                  await new Promise(r => setTimeout(r, 10000));
                  continue;
                }
                // Cookies broken + login failed — check Twitch search before deleting.
                // If account doesn't exist on Twitch = banned → delete.
                // If account shows in search = alive but wrong password → keep, mark failed.
                console.log(`DEBUG [checkcookies] ${user}: checking Twitch search before deciding to delete`);
                let shouldDelete = false;
                try {
                  const searchUrl = `https://www.twitch.tv/search?term=${encodeURIComponent(username)}&type=channels`;
                  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                  await Promise.race([
                    page.waitForFunction(
                      () => {
                        const t = document.body ? document.body.innerText.toLowerCase() : '';
                        return t.includes('no results found') || t.includes('result') || t.length > 800;
                      },
                      { timeout: 12000 }
                    ).catch(() => {}),
                    sleepMs(12000),
                  ]);
                  const searchText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
                  const usernameLower = (username || '').toLowerCase();
                  const noResults = searchText.includes('no results found') || searchText.includes('no results') ||
                                    searchText.includes('aucun résultat') || searchText.includes('keine ergebnisse') ||
                                    searchText.includes('sin resultados');
                  const foundInResults = searchText.includes(usernameLower) &&
                                         !searchText.includes('no results found for ' + usernameLower);
                  console.log(`DEBUG [checkcookies] ${user}: search noResults=${noResults} found=${foundInResults}`);
                  if (noResults) {
                    // Account doesn't exist on Twitch = banned → safe to delete
                    shouldDelete = true;
                    console.log(`DEBUG [checkcookies] ${user}: BANNED (not on Twitch) — deleting`);
                  } else if (foundInResults) {
                    // Account exists but login failed = wrong password or verification needed
                    console.log(`DEBUG [checkcookies] ${user}: account EXISTS but login failed — keeping (wrong password?)`);
                  } else {
                    // Search inconclusive — keep the account to be safe
                    console.log(`DEBUG [checkcookies] ${user}: search unclear — keeping account`);
                  }
                } catch(e) {
                  console.log(`DEBUG [checkcookies] ${user}: search error: ${e.message} — keeping account`);
                }
                if (shouldDelete) {
                  delete accounts[acc.id];
                  saveAccounts();
                }
                summary.failed++;
                return;
              }

              // Login succeeded — reload page then save fresh cookies
              console.log(`DEBUG [checkcookies] ${user}: login succeeded, reloading page then saving cookies`);
              await page.reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 3000));
              const freshCookies = await page.cookies();
              acc.cookies = freshCookies;
              saveAccounts();
              summary.refreshed++;
              // Success — no need to retry
              break;

            } catch (e) {
              lastError = e.message;
              console.log(`DEBUG [checkcookies] Error for ${user} (attempt ${retry}/${MAX_RETRIES}):`, e.message);
              if (retry < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 10000));
                continue;
              }
              summary.failed++;
            } finally {
              if (chromeProc && chromeProc.pid) {
                try { require('child_process').execSync(`taskkill /F /T /PID ${chromeProc.pid}`, { stdio: 'ignore' }); } catch {}
                try { chromeProc.kill(); } catch {}
              }
              if (browser) try { browser.disconnect(); } catch {}
              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
            }
            } // end retry loop

            completed++;
            startEmbed
              .setColor(0xFFAA00)
              .setTitle(`🔐 Cookie Check — [${completed}/${total}]`)
              .setFields(
                { name: '📊', value: `✅ ${summary.working} | 🔄 ${summary.refreshed} | ❌ ${summary.failed} | ⏳ ${total - completed} left`, inline: false },
              );
            await liveMsg.edit({ embeds: [startEmbed] }).catch(() => {});
          }

          let completed = 0;
          const total = accountsToCheck.length;
          const queue = accountsToCheck.map((a, i) => ({ acc: a, idx: i }));
          const running = [];
          while (queue.length > 0 || running.length > 0) {
            while (running.length < ccParallel && queue.length > 0) {
              const { acc, idx } = queue.shift();
              const p = checkCookiesOne(acc, idx).then(() => { running.splice(running.indexOf(p), 1); });
              running.push(p);
            }
            if (running.length > 0) await Promise.race(running);
          }

          startEmbed
            .setColor(0x00FF00)
            .setTitle('🔐 Cookie Check — Complete')
            .setDescription(
              `✅ **${summary.working}** cookies working | 🔄 **${summary.refreshed}** refreshed (login + new cookies) | ❌ **${summary.failed}** failed\n` +
              `**${accountsToCheck.length}** account(s) checked`
            )
            .setFields([])
            .setTimestamp();
          await liveMsg.edit({ embeds: [startEmbed] });
          break;
        }

        // ============================
        // !login [parallel] — Login accounts that have ≤6 cookies (session not saved / account not created)
        // ============================
        case 'login': {
          const loginParallel = Math.min(parseInt(args[0]) || 2, 10);
          const IS_SERVER_LG = process.platform === 'linux' || process.env.SERVER_MODE === '1';
          const stealthLG = IS_SERVER_LG ? require('./stealth/serverLauncher.js') : require('./stealth/index.js');
          function sleepLg(ms) { return new Promise(r => setTimeout(r, ms)); }

          const toLogin = getLinkedAccounts().filter(a => !a.cookies || a.cookies.length <= 6);
          if (toLogin.length === 0) {
            return msg.channel.send('✅ No accounts with missing/broken sessions found (all have >6 cookies).');
          }

          const lgSummary = { loggedIn: 0, deleted: 0, failed: 0 };
          let lgCompleted = 0;
          const lgTotal = toLogin.length;

          const lgEmbed = new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle(`🔑 Login Fix — [0/${lgTotal}]`)
            .setDescription(`Found **${lgTotal}** account(s) with ≤6 cookies. Logging in...`)
            .setFields({ name: '📊', value: `✅ 0 logged in | 🗑️ 0 deleted | ❌ 0 failed | ⏳ ${lgTotal} left`, inline: false });
          const lgMsg = await msg.channel.send({ embeds: [lgEmbed] });

          async function loginOne(acc) {
            const username = acc.twitchData?.username || acc.username;
            const password = acc.password;
            if (!username || !password) { lgSummary.failed++; lgCompleted++; return; }

            const MAX_RETRIES = 2;
            for (let retry = 1; retry <= MAX_RETRIES; retry++) {
              let browser = null, chromeProc = null, tmpDir = null;
              try {
                tmpDir = require('path').join(require('os').tmpdir(), 'login_' + acc.id + '_' + Date.now());
                try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}

                const launched = await stealthLG.launch({ userDataDir: tmpDir, windowSize: { width: 1280, height: 720 } });
                browser = launched.browser;
                chromeProc = launched.chromeProc;
                const page = launched.page; // use the KPSDK warmup tab — no second tab

                // Wait for initial twitch.tv/ to finish loading
                await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
                await sleepLg(1000);

                // Spoof WebGL renderer imperatively on the live document so the patch persists
                // through any SPA navigation (React Router) to /login without a full page reload.
                // The evaluateOnNewDocument in stealth/index.js covers full page reloads.
                await page.evaluate(() => {
                  const spoof = (proto) => {
                    try {
                      const orig = proto.getParameter;
                      if (orig && orig.__lgSpoofed) return;
                      const fn = function(p) {
                        if (p === 37445) return 'Google Inc. (NVIDIA)';
                        if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)';
                        return Reflect.apply(orig, this, arguments);
                      };
                      fn.__lgSpoofed = true;
                      proto.getParameter = fn;
                    } catch(e) {}
                  };
                  spoof(WebGLRenderingContext.prototype);
                  try { spoof(WebGL2RenderingContext.prototype); } catch(e) {}
                  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch(e) {}
                }).catch(() => {});

                // ── Step 1: existence check (same as !checkbanned) ──────────────────
                // Navigate to the channel page first. If Twitch shows "time machine" or
                // "content is unavailable" the account was never created / was deleted.
                // Delete from DB and skip login entirely.
                await page.goto('https://www.twitch.tv/' + encodeURIComponent(username), {
                  waitUntil: 'networkidle2', timeout: 40000,
                });
                try {
                  await page.waitForFunction(
                    () => {
                      const t = (document.body?.innerText || '').toLowerCase();
                      return t.includes('violation of twitch') || t.includes('time machine') ||
                             t.includes('content is unavailable') || t.includes('is offline') ||
                             t.includes(' followers') || t.includes('turn on notifications');
                    },
                    { timeout: 30000 }
                  );
                } catch(e) { /* timeout — page unclear, proceed anyway */ }

                const channelText = await page.evaluate(
                  () => (document.body?.innerText || '').toLowerCase()
                ).catch(() => '');
                const notExists = channelText.includes('time machine') ||
                                  channelText.includes('content is unavailable');
                if (notExists) {
                  console.log(`DEBUG [login] ${username}: channel not found on Twitch — deleting`);
                  delete accounts[acc.id];
                  saveAccounts();
                  lgSummary.deleted++;
                  break; // exits retry loop; lgCompleted++ still runs below
                }
                console.log(`DEBUG [login] ${username}: channel exists — proceeding to login`);
                // ── Step 2: login ────────────────────────────────────────────────────

                await page.goto('https://www.twitch.tv/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
                await sleepLg(3000);

                // Dismiss cookie banner
                await page.evaluate(() => {
                  for (const b of document.querySelectorAll('button')) {
                    const t = b.textContent.trim().toLowerCase();
                    if (['accept','accepter','aceptar','akzeptieren','aceitar','kabul et'].includes(t)) { b.click(); return; }
                  }
                }).catch(() => {});
                await sleepLg(1000);

                // "browser not supported" banner is cosmetic — the login form still works.
                // We log it but do NOT bail out; we proceed and let the finalLoggedIn check decide.

                let usernameInput = null;
                for (let i = 0; i < 15; i++) {
                  usernameInput = await page.$('#login-username') || await page.$('input[autocomplete="username"]');
                  if (usernameInput) break;
                  await sleepLg(2000);
                }
                if (!usernameInput) { lgSummary.failed++; break; }

                await usernameInput.click();
                await sleepLg(300);
                await page.keyboard.type(username, { delay: 50 });

                const pwInput = await page.$('#password-input, input[type="password"]');
                if (!pwInput) { lgSummary.failed++; break; }
                await pwInput.click();
                await sleepLg(300);
                await page.keyboard.type(password, { delay: 50 });
                await sleepLg(1000);

                await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 15000 }).catch(() => {});
                let loginBtn = await page.$('button[data-a-target="passport-login-button"]');
                if (!loginBtn) {
                  const handle = await page.evaluateHandle(() => {
                    for (const btn of document.querySelectorAll('button[type="submit"]')) {
                      if (btn.offsetParent !== null) return btn;
                    }
                    return null;
                  });
                  if (handle && handle.asElement) loginBtn = handle.asElement();
                }
                if (loginBtn) await loginBtn.click();
                await sleepLg(5000);

                // Username does not exist → delete from DB
                const userNotExist = await page.evaluate(() => {
                  const t = document.body?.innerText?.toLowerCase() || '';
                  return t.includes('this username does not exist') || t.includes('username does not exist') ||
                         t.includes("ce nom d'utilisateur n'existe pas") || t.includes('este nombre de usuario no existe');
                }).catch(() => false);
                if (userNotExist) {
                  console.log(`DEBUG [login] ${username}: username does not exist — deleting`);
                  delete accounts[acc.id];
                  saveAccounts();
                  lgSummary.deleted++;
                  break;
                }

                // Verification code?
                const hasCodeForm = await page.evaluate(() => {
                  const small = [...document.querySelectorAll('input')].filter(i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.width < 100 && r.height > 0; });
                  return small.length >= 6;
                }).catch(() => false);

                if (hasCodeForm) {
                  const accEmail = acc.twitchData?.email || acc.email;
                  console.log(`DEBUG [login] ${username}: needs verification code for ${accEmail}`);
                  try {
                    const emailReader = require('./emailReader');
                    const code = await emailReader.waitForCode({ address: accEmail, type: 'imap', since: Date.now() }, 90000);
                    if (code) {
                      const boxes = await page.$$('[data-a-target="passport-verification-code-modal"] input, input[maxlength="1"]').catch(() => []);
                      if (boxes.length >= 6) {
                        for (let i = 0; i < 6; i++) {
                          await boxes[i].click();
                          await page.keyboard.type(code[i] || '', { delay: 100 });
                          await sleepLg(80);
                        }
                      } else {
                        const codeInput = await page.evaluateHandle(() => {
                          for (const inp of document.querySelectorAll('input')) {
                            const r = inp.getBoundingClientRect();
                            if (r.width > 0 && r.width < 100) return inp;
                          }
                          return null;
                        });
                        if (codeInput && codeInput.asElement && codeInput.asElement()) {
                          await codeInput.asElement().click();
                          for (const d of code.toString()) { await page.keyboard.type(d, { delay: 150 }); await sleepLg(100); }
                        }
                      }
                      const submitHandle = await page.evaluateHandle(() => {
                        for (const btn of document.querySelectorAll('button')) {
                          const t = btn.textContent.trim().toLowerCase();
                          if (['submit','enviar','envoyer','absenden'].includes(t)) return btn;
                        }
                        return null;
                      });
                      if (submitHandle && submitHandle.asElement && submitHandle.asElement()) await submitHandle.asElement().click();
                      else await page.keyboard.press('Enter');
                      await sleepLg(8000);
                    } else {
                      lgSummary.failed++;
                      break;
                    }
                  } catch(e) {
                    console.log(`DEBUG [login] ${username}: verification error:`, e.message);
                    lgSummary.failed++;
                    break;
                  }
                }

                // Final login check
                await sleepLg(4000);
                const finalLoggedIn = await page.evaluate(() => {
                  if (document.querySelector('[data-a-target="user-menu"], [data-a-target="core-top-nav-avatar"], button[data-a-target="profile-menu-trigger"]')) return true;
                  return !window.location.href.includes('/login');
                }).catch(() => false);

                if (!finalLoggedIn) {
                  if (retry < MAX_RETRIES) { await sleepLg(10000); continue; }
                  lgSummary.failed++;
                  break;
                }

                // Save fresh cookies
                await page.reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                await sleepLg(3000);
                const freshCookies = await page.cookies();
                acc.cookies = freshCookies;
                saveAccounts();
                console.log(`DEBUG [login] ${username}: success — saved ${freshCookies.length} cookies`);
                lgSummary.loggedIn++;
                break;

              } catch(e) {
                console.log(`DEBUG [login] ${username}: error (attempt ${retry}/${MAX_RETRIES}):`, e.message);
                if (retry >= MAX_RETRIES) lgSummary.failed++;
              } finally {
                if (chromeProc && chromeProc.pid) {
                  try { require('child_process').execSync(`taskkill /F /T /PID ${chromeProc.pid}`, { stdio: 'ignore' }); } catch {}
                  try { chromeProc.kill(); } catch {}
                }
                if (browser) try { browser.disconnect(); } catch {}
                if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
              }
            }

            lgCompleted++;
            lgEmbed
              .setTitle(`🔑 Login Fix — [${lgCompleted}/${lgTotal}]`)
              .setFields({ name: '📊', value: `✅ ${lgSummary.loggedIn} logged in | 🗑️ ${lgSummary.deleted} deleted | ❌ ${lgSummary.failed} failed | ⏳ ${lgTotal - lgCompleted} left`, inline: false });
            await lgMsg.edit({ embeds: [lgEmbed] }).catch(() => {});
          }

          // Concurrency queue
          const lgQueue = [...toLogin];
          const lgRunning = [];
          while (lgQueue.length > 0 || lgRunning.length > 0) {
            while (lgRunning.length < loginParallel && lgQueue.length > 0) {
              const acc = lgQueue.shift();
              const p = loginOne(acc).then(() => { lgRunning.splice(lgRunning.indexOf(p), 1); });
              lgRunning.push(p);
            }
            if (lgRunning.length > 0) await Promise.race(lgRunning);
          }

          lgEmbed
            .setColor(0x00FF00)
            .setTitle('🔑 Login Fix — Complete')
            .setDescription(
              `✅ **${lgSummary.loggedIn}** logged in & cookies saved\n` +
              `🗑️ **${lgSummary.deleted}** deleted (username not found on Twitch)\n` +
              `❌ **${lgSummary.failed}** failed\n\n` +
              `**${lgTotal}** account(s) processed`
            )
            .setFields([])
            .setTimestamp();
          await lgMsg.edit({ embeds: [lgEmbed] });
          break;
        }

        // ============================
        // !cleanup — Remove accounts without cookies
        // ============================
        case 'cleanup': {
          const all = Object.values(accounts);
          const noCookies = all.filter(a => !a.cookies || a.cookies.length === 0);
          const hasCookies = all.filter(a => a.cookies && a.cookies.length > 0);
          if (noCookies.length === 0) return msg.channel.send('All accounts have cookies. Nothing to clean up.');

          const embed = new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle('🧹 Cleanup Preview')
            .setDescription(
              `Found **${noCookies.length}** account(s) without cookies:\n` +
              noCookies.map(a => `\`${a.twitchData?.username || a.username || a.id}\``).join(', ') +
              `\n\n**${hasCookies.length}** account(s) with cookies will be kept.`
            )
            .setTimestamp();
          await msg.channel.send({ embeds: [embed] });

          // Remove accounts without cookies
          for (const acc of noCookies) {
            delete accounts[acc.id];
          }
          saveAccounts();

          const doneEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🧹 Cleanup Complete')
            .setDescription(`Removed **${noCookies.length}** account(s) without cookies.\n**${hasCookies.length}** account(s) remaining.`)
            .setTimestamp();
          await msg.channel.send({ embeds: [doneEmbed] });
          break;
        }

        // ============================
        // !checkbanned — Find and delete banned accounts
        // ============================
        case 'checkbanned': {
          const specificUser = args[0];
          const cbParallel = Math.min(parseInt(args[1]) || 2, 15);

          let accountsToCheck = [];
          if (specificUser && specificUser.toLowerCase() !== 'all') {
            const acc = findByUsername(specificUser);
            if (!acc) return msg.channel.send(`Account \`${specificUser}\` not found.`);
            accountsToCheck = [acc];
          } else {
            accountsToCheck = Object.values(accounts).filter(a => a.cookies && a.cookies.length > 0 && a.password);
            if (accountsToCheck.length === 0) return msg.channel.send('No accounts with cookies + password to check.');
          }

          const startEmbed = new EmbedBuilder()
            .setColor(0x9146FF)
            .setTitle('🚫 Ban Check')
            .setDescription(`Checking **${accountsToCheck.length}** account(s) via browser login (${cbParallel} parallel)...`)
            .setTimestamp();
          const liveMsg = await msg.channel.send({ embeds: [startEmbed] });

          let banned = 0, alive = 0, errors = 0, checked = 0;
          const IS_SERVER = process.platform === 'linux' || process.env.SERVER_MODE === '1';
          const stealthLauncher = IS_SERVER
            ? require('./stealth/serverLauncher.js')
            : require('./stealth/index.js');
          function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

          async function checkBanOne(acc, idx) {
            const user = acc.twitchData?.username || acc.username || acc.id;
            const username = acc.twitchData?.username || acc.username;

            if (!username) return 'error';

            let browser = null, chromeProc = null, tmpDir = null;
            try {
              tmpDir = require('path').join(__dirname, '../tmp_profiles/ban_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).slice(2, 6));
              try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}

              const launched = await stealthLauncher.launch({
                userDataDir: tmpDir,
                kpsdkDelay: 0,
                windowSize: { width: 1280, height: 720 },
              });
              browser = launched.browser;
              chromeProc = launched.chromeProc;
              const page = launched.page;

              // Navigate directly to the channel page — ban messages appear to anyone
              const channelUrl = 'https://www.twitch.tv/' + encodeURIComponent(username);
              await page.goto(channelUrl, { waitUntil: 'networkidle2', timeout: 40000 });

              // Wait for channel-page-specific content to render
              let pageLoaded = false;
              try {
                await page.waitForFunction(
                  () => {
                    const t = document.body ? document.body.innerText.toLowerCase() : '';
                    return t.includes('violation of twitch') ||
                           t.includes('time machine') ||
                           t.includes('content is unavailable') ||
                           t.includes('is offline') ||
                           t.includes(' followers') ||
                           t.includes('turn on notifications');
                  },
                  { timeout: 15000 }
                );
                pageLoaded = true;
              } catch(e) { /* timeout */ }

              const pageText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '').catch(() => '');
              console.log('DEBUG [checkbanned] ' + user + ': loaded=' + pageLoaded + ' sample: ' + pageText.slice(0, 200).split('\n').join(' '));

              const isBanned = pageText.includes('violation of twitch') ||
                               pageText.includes('community guidelines or terms of service');
              const isDeleted = pageText.includes('time machine') ||
                                pageText.includes('content is unavailable');

              if (isBanned) {
                console.log('DEBUG [checkbanned] ' + user + ': BANNED — community guidelines');
                return 'banned';
              }
              if (isDeleted) {
                console.log('DEBUG [checkbanned] ' + user + ': BANNED — channel does not exist');
                return 'banned';
              }
              if (!pageLoaded) {
                console.log('DEBUG [checkbanned] ' + user + ': page unclear — skipping');
                return 'error';
              }

              console.log('DEBUG [checkbanned] ' + user + ': ALIVE');
              return 'alive';

            } catch(e) {
              console.log('DEBUG [checkbanned] Error for ' + user + ':', e.message);
              return 'error';
            } finally {
              if (chromeProc && chromeProc.pid) {
                try { require('child_process').execSync(`taskkill /F /T /PID ${chromeProc.pid}`, { stdio: 'ignore' }); } catch {}
                try { chromeProc.kill(); } catch {}
              }
              if (browser) try { browser.disconnect(); } catch {}
              if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
            }
          }

                    const queue = accountsToCheck.map((a, i) => ({ acc: a, idx: i }));
          const running = [];
          while (queue.length > 0 || running.length > 0) {
            while (running.length < cbParallel && queue.length > 0) {
              const { acc, idx } = queue.shift();
              const p = checkBanOne(acc, idx).then(async (result) => {
                running.splice(running.indexOf(p), 1);
                const user = acc.twitchData?.username || acc.username || acc.id;
                if (result === 'banned') {
                  banned++;
                  delete accounts[acc.id];
                  saveAccounts();
                  console.log(`DEBUG [checkbanned] ${user}: BANNED — deleted from accounts.json`);
                } else if (result === 'alive') {
                  alive++;
                } else {
                  errors++;
                }
                checked++;
                startEmbed
                  .setColor(0xFFAA00)
                  .setTitle(`🚫 Ban Check — [${checked}/${accountsToCheck.length}]`)
                  .setFields(
                    { name: '📊', value: `✅ ${alive} alive | 🚫 ${banned} banned | ⚠️ ${errors} skipped | ⏳ ${accountsToCheck.length - checked} left`, inline: false },
                  );
                liveMsg.edit({ embeds: [startEmbed] }).catch(() => {});
              });
              running.push(p);
            }
            if (running.length > 0) await Promise.race(running);
          }

          if (banned > 0) saveAccounts();

          startEmbed
            .setColor(banned > 0 ? 0xFF0000 : 0x00FF00)
            .setTitle('🚫 Ban Check — Complete')
            .setDescription(
              `✅ **${alive}** alive | 🚫 **${banned}** banned (deleted) | ⚠️ **${errors}** skipped\n` +
              `**${accountsToCheck.length}** account(s) checked`
            )
            .setFields([])
            .setTimestamp();
          await liveMsg.edit({ embeds: [startEmbed] });
          break;
        }

        // ============================
        // !testproxy — Test if proxy is flagged by Kasada
        // ============================
        case 'testproxy': {
          const proxyUrl = args[0] || PROXY_URL;
          if (!proxyUrl) return msg.channel.send('Usage: `!testproxy <proxy_url>` or set PROXY_URL in .env');

          await msg.channel.send(`🔍 Testing proxy with Kasada...`);
          let browser = null;
          let tmpDir = null;

          try {
            const puppeteer = require('puppeteer');
            let chromePath = null;
            const chromePaths = [
              'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
              'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            ];
            for (const p of chromePaths) {
              if (fs.existsSync(p)) { chromePath = p; break; }
            }
            if (!chromePath) return msg.channel.send('❌ Chrome not found.');

            let proxyPort = null;
            if (proxyUrl.startsWith('http')) {
              proxyPort = await startLocalProxy(proxyUrl);
            }

            tmpDir = path.join(__dirname, '../tmp_profiles/testproxy_' + Date.now());
            try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}

            let launchArgs = [
              '--no-sandbox', '--disable-setuid-sandbox', '--no-first-run',
              '--no-default-browser-check', '--disable-sync', '--mute-audio',
              '--disable-blink-features=AutomationControlled',
              '--force-color-profile=srgb', '--metrics-recording-only',
            ];
            if (proxyPort) launchArgs.push('--proxy-server=http://127.0.0.1:' + proxyPort);

            browser = await puppeteer.launch({
              executablePath: chromePath, headless: true,
              args: launchArgs.concat(['--user-data-dir=' + tmpDir]),
              env: { ...process.env },
            });
            const page = await browser.newPage();

            await page.goto('https://www.twitch.tv/', { waitUntil: 'domcontentloaded', timeout: 45000 });
            await new Promise(r => setTimeout(r, 5000));

            const pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');

            const kasadaBlocked = pageText.includes('browser not currently supported') ||
                                  pageText.includes('not currently supported') ||
                                  pageText.includes('nicht unterstützt') ||
                                  pageText.includes('non supporté') ||
                                  pageText.includes('no compatible');

            if (kasadaBlocked) {
              await msg.channel.send(`🚫 **KASADA BLOCKED** — This proxy IP is flagged. Cannot use for signup.`);
            } else {
              await msg.channel.send(`✅ **KASADA PASSED** — This proxy IP is clean. Safe to use for signup.`);
            }
          } catch (e) {
            await msg.channel.send(`❌ Error: ${e.message}`);
          } finally {
            if (browser) try { await browser.close(); } catch {}
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
          }
          break;
        }

        // ============================
        // !link <epic_email> <epic_password> [username|all] — Link Epic Games account to Twitch account(s)
        // ============================
        case 'link': {
          const epicEmail = args[0];
          const epicPassword = args[1];
          const linkTarget = args[2];
          const rlWaitMinutes = Math.max(1, parseInt(args[3]) || 3);

          if (!epicEmail || !epicPassword) {
            return msg.channel.send('Usage: `!link <epic_email> <epic_password> [count|username|all] [waitMinutes]`');
          }

          const pool = Object.values(accounts).filter(a => a.cookies && a.cookies.length > 0 && !a.epicLinked);
          let accountsToLink = [];
          const countArg = linkTarget && /^\d+$/.test(linkTarget) ? parseInt(linkTarget) : null;

          if (countArg !== null) {
            // Number: link up to N unlinked accounts
            if (pool.length === 0) return msg.channel.send('No unlinked accounts available.');
            accountsToLink = pool.slice(0, countArg);
          } else if (!linkTarget) {
            // No arg: link just the first unlinked account
            if (pool.length === 0) return msg.channel.send('No unlinked accounts available.');
            accountsToLink = [pool[0]];
          } else if (linkTarget.toLowerCase() === 'all') {
            if (pool.length === 0) return msg.channel.send('No unlinked accounts available.');
            accountsToLink = pool;
          } else {
            // Username
            const acc = findByUsername(linkTarget);
            if (!acc) return msg.channel.send(`Account \`${linkTarget}\` not found.`);
            accountsToLink = [acc];
          }

          await msg.channel.send(`🔗 Linking Epic account \`${epicEmail}\` to **${accountsToLink.length}** Twitch account(s)...`);

          const IS_SERVER_L = process.platform === 'linux' || process.env.SERVER_MODE === '1';
          const stealthL = IS_SERVER_L
            ? require('./stealth/serverLauncher.js')
            : require('./stealth/index.js');

          let linked = 0, failed = 0;
          const results = [];

          for (const acc of accountsToLink) {
            const user = acc.twitchData?.username || acc.username || acc.id;
            let browser = null, chromeProc = null, tmpDir = null;
            try {
              tmpDir = require('path').join(__dirname, '../tmp_profiles/link_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
              try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}

              const launched = await stealthL.launch({
                userDataDir: tmpDir,
                kpsdkDelay: 0,
                windowSize: { width: 1280, height: 720 },
              });
              browser = launched.browser;
              chromeProc = launched.chromeProc;
              const page = launched.page;

              // Load Twitch session with cookies
              await page.goto('https://www.twitch.tv/', { waitUntil: 'domcontentloaded', timeout: 30000 });
              if (acc.cookies && acc.cookies.length > 0) {
                await page.setCookie(...acc.cookies);
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
              }
              await new Promise(r => setTimeout(r, 2000));

              // Go to Twitch connections page
              await page.goto('https://www.twitch.tv/settings/connections', { waitUntil: 'networkidle2', timeout: 40000 });
              await new Promise(r => setTimeout(r, 3000));

              // Check if Epic is already connected
              const alreadyLinked = await page.evaluate(() => {
                const t = document.body ? document.body.innerText : '';
                return /epic games/i.test(t) && /disconnect|connected/i.test(t);
              }).catch(() => false);

              if (alreadyLinked) {
                results.push(`✅ \`${user}\` — already linked`);
                acc.epicLinked = true;
                saveAccounts();
                linked++;
                continue;
              }

              // Click the Epic Games Connect button
              const connectClicked = await page.evaluate(() => {
                // Find the Epic Games section and its Connect button
                const allBtns = [...document.querySelectorAll('button, a')];
                for (const el of allBtns) {
                  const text = el.textContent.trim().toLowerCase();
                  const parent = el.closest('[class*="connection"], [class*="card"], section, li, div');
                  const parentText = parent ? parent.textContent.toLowerCase() : '';
                  if ((text === 'connect' || text === 'connect account') && parentText.includes('epic')) {
                    el.click();
                    return true;
                  }
                }
                // Fallback: any Connect button near Epic text on page
                const sections = [...document.querySelectorAll('*')].filter(el => el.childElementCount === 0 && /epic games/i.test(el.textContent));
                for (const sec of sections) {
                  let node = sec.parentElement;
                  for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
                    const btn = node.querySelector('button');
                    if (btn && /connect/i.test(btn.textContent)) { btn.click(); return true; }
                  }
                }
                return false;
              });

              if (!connectClicked) {
                results.push(`❌ \`${user}\` — Epic Games Connect button not found`);
                failed++;
                continue;
              }

              console.log(`DEBUG [link] ${user}: clicked Epic Connect`);
              await new Promise(r => setTimeout(r, 3000));

              // Wait for Epic login page (popup or redirect)
              // Epic OAuth usually opens in the same tab or a popup
              let epicPage = page;
              const pages = await browser.pages();
              for (const p of pages) {
                const url = p.url();
                if (url.includes('epicgames.com') || url.includes('epic')) {
                  epicPage = p;
                  break;
                }
              }

              // Wait for Epic login form
              await epicPage.waitForFunction(
                () => document.querySelector('input[name="email"], input[type="email"], #email') !== null ||
                      document.body.innerText.toLowerCase().includes('sign in') ||
                      document.body.innerText.toLowerCase().includes('log in'),
                { timeout: 20000 }
              ).catch(() => {});
              await new Promise(r => setTimeout(r, 1500));

              // Fill Epic email
              const emailInput = await epicPage.$('input[name="email"], input[type="email"], #email').catch(() => null);
              if (!emailInput) {
                results.push(`❌ \`${user}\` — Epic login form not found`);
                failed++;
                continue;
              }
              await emailInput.click({ clickCount: 3 });
              await epicPage.keyboard.type(epicEmail, { delay: 60 });
              await new Promise(r => setTimeout(r, 500));

              // Fill Epic password
              const passInput = await epicPage.$('input[name="password"], input[type="password"], #password').catch(() => null);
              if (passInput) {
                await passInput.click({ clickCount: 3 });
                await epicPage.keyboard.type(epicPassword, { delay: 60 });
              }
              await new Promise(r => setTimeout(r, 500));

              // Submit the Epic login form
              await epicPage.keyboard.press('Enter');
              await new Promise(r => setTimeout(r, 4000));

              // Handle 2FA or CAPTCHA notice
              const epicContent = await epicPage.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '').catch(() => '');
              if (epicContent.includes('two-factor') || epicContent.includes('2fa') || epicContent.includes('verify your email')) {
                results.push(`⚠️ \`${user}\` — Epic 2FA required, cannot auto-link`);
                failed++;
                continue;
              }

              // Wait for "Allow" / "Agree" / authorization button
              const authorized = await epicPage.waitForFunction(
                () => {
                  const btns = [...document.querySelectorAll('button, input[type="submit"]')];
                  const allow = btns.find(b => /allow|agree|authorize|accept|connect/i.test(b.textContent));
                  if (allow) { allow.click(); return true; }
                  return false;
                },
                { timeout: 15000 }
              ).then(() => true).catch(() => false);

              if (!authorized) {
                // Maybe it auto-authorized and redirected back
                await new Promise(r => setTimeout(r, 3000));
              }

              // Wait for redirect back to Twitch or confirmation
              await new Promise(r => setTimeout(r, 4000));
              const finalUrl = page.url();
              const finalContent = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');

              if (finalContent.toLowerCase().includes('disconnect') || finalUrl.includes('twitch.tv/settings/connections')) {
                acc.epicLinked = true;
                saveAccounts();
                linked++;
                console.log(`DEBUG [link] ${user}: Epic linked OK — getting exchange code`);
                await msg.channel.send(`✅ \`${user}\` linked to Epic — logging into launcher & launching Rocket League...`);

                const { spawn, execSync } = require('child_process');

                // --- Step 1: Get Epic exchange code from the logged-in browser session ---
                let exchangeCode = null;
                try {
                  // Use whichever page is still on epicgames.com, or open a new one
                  let exchPage = null;
                  const allPages = await browser.pages();
                  for (const p of allPages) {
                    if (p.url().includes('epicgames.com')) { exchPage = p; break; }
                  }
                  if (!exchPage) exchPage = await browser.newPage();
                  await exchPage.goto('https://www.epicgames.com/id/api/exchange/generate', { waitUntil: 'domcontentloaded', timeout: 15000 });
                  const exchJson = await exchPage.evaluate(() => {
                    try { return JSON.parse(document.body.innerText); } catch(e) { return null; }
                  }).catch(() => null);
                  exchangeCode = exchJson && exchJson.code ? exchJson.code : null;
                  console.log(`DEBUG [link] ${user}: exchange code obtained:`, exchangeCode ? 'yes' : 'no');
                } catch (exchErr) {
                  console.log(`DEBUG [link] ${user}: exchange code error:`, exchErr.message);
                }

                // --- Step 2: Find Epic Games Launcher executable ---
                const epicLauncherPaths = [
                  'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win32\\EpicGamesLauncher.exe',
                  'C:\\Program Files\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
                  'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
                ];
                const epicLauncherExe = epicLauncherPaths.find(p => { try { return fs.existsSync(p); } catch(e) { return false; } });

                // --- Step 3: Launch Epic Games Launcher logged in with exchange code ---
                if (epicLauncherExe && exchangeCode) {
                  try {
                    // Kill any existing launcher first so we start fresh with this account
                    try { execSync('taskkill /F /IM EpicGamesLauncher.exe', { stdio: 'ignore' }); } catch(e) {}
                    await new Promise(r => setTimeout(r, 3000));

                    spawn(epicLauncherExe, [
                      `-AUTH_LOGIN=${exchangeCode}`,
                      '-AUTH_TYPE=exchangecode',
                      '-epiclocale=en-US',
                      '-epicenv=Prod',
                      '-EpicPortal',
                    ], { detached: true, stdio: 'ignore' }).unref();
                    console.log(`DEBUG [link] ${user}: Epic launcher launched with exchange code`);

                    // Wait for launcher to fully start
                    await new Promise(r => setTimeout(r, 20000));
                  } catch(launchErr) {
                    console.log(`DEBUG [link] ${user}: launcher start error:`, launchErr.message);
                  }
                } else {
                  console.log(`DEBUG [link] ${user}: skipping launcher login — exe=${epicLauncherExe ? 'found' : 'NOT FOUND'} code=${exchangeCode ? 'ok' : 'MISSING'}`);
                  if (!epicLauncherExe) await msg.channel.send(`⚠️ \`${user}\` — Epic launcher not found, launching RL via URI instead`);
                }

                // --- Step 4: Launch Rocket League ---
                try {
                  spawn('cmd.exe', ['/c', 'start', '', 'com.epicgames.launcher://apps/Sugar?action=launch&silent=true'], {
                    detached: true, stdio: 'ignore',
                  }).unref();
                  console.log(`DEBUG [link] ${user}: Rocket League launch command sent`);
                } catch(rlErr) {
                  console.log(`DEBUG [link] ${user}: RL launch error:`, rlErr.message);
                }

                // --- Step 5: Wait for Rocket League window to appear (title screen) ---
                console.log(`DEBUG [link] ${user}: waiting for RL title screen...`);
                let rlTitleSeen = false;
                for (let i = 0; i < 60; i++) {
                  await new Promise(r => setTimeout(r, 5000));
                  try {
                    const winTitle = execSync(
                      'powershell -Command "Get-Process RocketLeague -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1 -ExpandProperty MainWindowTitle"',
                      { timeout: 5000 }
                    ).toString().trim();
                    if (winTitle.toLowerCase().includes('rocket league')) {
                      rlTitleSeen = true;
                      console.log(`DEBUG [link] ${user}: RL title screen detected: "${winTitle}"`);
                      break;
                    }
                  } catch(e) {}
                }

                if (!rlTitleSeen) {
                  console.log(`DEBUG [link] ${user}: RL title screen not detected after 5min, continuing anyway`);
                }

                // --- Step 6: Wait 10 seconds on the title screen, then close ---
                await new Promise(r => setTimeout(r, 10000));
                try {
                  execSync('taskkill /F /IM RocketLeague.exe', { stdio: 'ignore' });
                  console.log(`DEBUG [link] ${user}: Rocket League closed`);
                } catch(e) {}

                // Kill Epic launcher too so next account starts fresh
                try { execSync('taskkill /F /IM EpicGamesLauncher.exe', { stdio: 'ignore' }); } catch(e) {}

                // Cooldown before next account
                await new Promise(r => setTimeout(r, 30000));
                results.push(`✅ \`${user}\` — linked + RL launched & closed (title ${rlTitleSeen ? 'detected ✅' : 'not detected ⚠️'})`);
              } else {
                failed++;
                results.push(`❌ \`${user}\` — Link may have failed (check manually)`);
                console.log(`DEBUG [link] ${user}: uncertain result, url=${finalUrl}`);
              }
            } catch (e) {
              failed++;
              results.push(`❌ \`${user}\` — Error: ${e.message}`);
              console.log(`DEBUG [link] ${user}: error:`, e.message);
            } finally {
              if (chromeProc && chromeProc.pid) {
                try { require('child_process').execSync(`taskkill /F /T /PID ${chromeProc.pid}`, { stdio: 'ignore' }); } catch {}
                try { chromeProc.kill(); } catch {}
              }
              if (browser) try { browser.disconnect(); } catch {}
              if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
            }
          }

          const resultEmbed = new EmbedBuilder()
            .setColor(linked > 0 ? 0x00C805 : 0xFF0000)
            .setTitle('🔗 Epic Link Results')
            .setDescription(results.join('\n') || 'No results.')
            .addFields(
              { name: '✅ Linked', value: String(linked), inline: true },
              { name: '❌ Failed', value: String(failed), inline: true },
            );
          return msg.channel.send({ embeds: [resultEmbed] });
        }

        // ============================
        // !help — Show commands with clickable detail buttons
        // ============================
        case 'help': {
          const HELP_PAGES = {
            home: {
              embed: () => new EmbedBuilder()
                .setColor(0x9146FF)
                .setTitle('🤖 Twitch Farm Bot — Commands')
                .setDescription(
                  '**Your all-in-one Twitch automation system**\n\n' +
                  '> Click a category button below to see detailed usage for each command.\n\n' +
                  '🔨 **Accounts** — Create, list, delete accounts\n' +
                  '🔐 **Cookies & Bans** — Check sessions, detect bans\n' +
                  '📺 **Watching** — Start/stop stream watchers\n' +
                  '🎁 **Drops & Follows** — Manage drops and follows\n' +
                  '🔗 **Epic Link** — Link Epic Games to Twitch accounts\n' +
                  '👁️ **Viewer Bot** — Send fake viewers\n' +
                  '⚙️ **Utility** — Status, proxy tools'
                )
                .setFooter({ text: `${Object.keys(accounts).length} accounts loaded • Twitch Farm Bot` })
                .setTimestamp(),
              rows: () => [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('help_accounts').setLabel('🔨 Accounts').setStyle(ButtonStyle.Primary),
                  new ButtonBuilder().setCustomId('help_cookies').setLabel('🔐 Cookies & Bans').setStyle(ButtonStyle.Primary),
                  new ButtonBuilder().setCustomId('help_watching').setLabel('📺 Watching').setStyle(ButtonStyle.Primary),
                  new ButtonBuilder().setCustomId('help_drops').setLabel('🎁 Drops').setStyle(ButtonStyle.Primary),
                ),
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('help_epic').setLabel('🔗 Epic Link').setStyle(ButtonStyle.Success),
                  new ButtonBuilder().setCustomId('help_viewer').setLabel('👁️ Viewer Bot').setStyle(ButtonStyle.Danger),
                  new ButtonBuilder().setCustomId('help_utility').setLabel('⚙️ Utility').setStyle(ButtonStyle.Secondary),
                ),
              ],
            },
            accounts: {
              embed: () => new EmbedBuilder()
                .setColor(0x9146FF)
                .setTitle('🔨 Account Management')
                .setDescription('Create and manage your Twitch accounts.')
                .addFields(
                  { name: '`!createfull [count] [parallel] [batch] [pause]`',
                    value: 'Creates Twitch accounts automatically with email verification.\n' +
                           '• **count** — How many to create (default: 1)\n' +
                           '• **parallel** — How many run at the same time (default: 3, max: 15)\n' +
                           '• **batch** — Accounts per batch before pausing\n' +
                           '• **pause** — Minutes to pause between batches\n' +
                           '> 📌 `!createfull 100 5 10 5` = 100 accounts, 5 at a time, pause 5min every 10' },
                  { name: '`!accounts [page]`',
                    value: 'Lists all saved accounts — username, email, drop count, status.\n> 📌 `!accounts 2` to see page 2' },
                  { name: '`!delete <username>`',
                    value: 'Permanently removes an account from the database.\n> 📌 `!delete Janenuzima9521`' },
                  { name: '`!cleanup`',
                    value: 'Removes accounts with no cookies (accounts that failed login and are useless).' },
                )
                .setFooter({ text: '← Click 🏠 Home to go back' }),
              rows: () => [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_home').setLabel('🏠 Home').setStyle(ButtonStyle.Secondary),
              )],
            },
            cookies: {
              embed: () => new EmbedBuilder()
                .setColor(0xFF6B35)
                .setTitle('🔐 Cookies & Ban Detection')
                .setDescription('Keep accounts healthy — check sessions and detect bans.')
                .addFields(
                  { name: '`!checkcookies <username|all>`',
                    value: 'Opens each account in a real browser and tests if the session is still valid.\nIf cookies are broken it tries to re-login automatically.\n> 📌 `!checkcookies all`' },
                  { name: '`!checkbanned [username] [parallel]`',
                    value: 'Visits each account\'s Twitch channel page to check if it was banned or deleted.\nBanned accounts are **automatically removed** from the database.\n• **parallel** — How many to check at once (default: 2, max: 15)\n> 📌 `!checkbanned all 5` — check all, 5 at a time' },
                )
                .setFooter({ text: '← Click 🏠 Home to go back' }),
              rows: () => [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_home').setLabel('🏠 Home').setStyle(ButtonStyle.Secondary),
              )],
            },
            watching: {
              embed: () => new EmbedBuilder()
                .setColor(0x00B4D8)
                .setTitle('📺 Watching & Stream Farming')
                .setDescription('Control which streams your accounts watch to farm drops.')
                .addFields(
                  { name: '`!watch <streamer> [parallel|username]`',
                    value: 'Starts watching a streamer. Auto-rotates accounts when one stops.\n• **parallel** — Accounts watching at the same time\n• **username** — Watch with one specific account only\n> 📌 `!watch ninja 10` = 10 accounts watching ninja at once' },
                  { name: '`!stopwatch [username]`',
                    value: 'Stops watching. Leave blank to stop all, or specify one account.\n> 📌 `!stopwatch` or `!stopwatch Janenuzima9521`' },
                  { name: '`!stoprotation`',
                    value: 'Disables auto-replace — when an account stops, no new one takes over.' },
                  { name: '`!watchers`',
                    value: 'Shows all active watchers with streamer, account and drop count.' },
                )
                .setFooter({ text: '← Click 🏠 Home to go back' }),
              rows: () => [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_home').setLabel('🏠 Home').setStyle(ButtonStyle.Secondary),
              )],
            },
            drops: {
              embed: () => new EmbedBuilder()
                .setColor(0x06D6A0)
                .setTitle('🎁 Drops & Follows')
                .setDescription('Check drop progress and manage channel follows.')
                .addFields(
                  { name: '`!drops <username|all>`',
                    value: 'Shows the drop farming status for an account or all accounts.\n> 📌 `!drops all`' },
                  { name: '`!follow <channel> [username]`',
                    value: 'Makes one or all accounts follow a Twitch channel.\n> 📌 `!follow ninja` or `!follow ninja Janenuzima9521`' },
                  { name: '`!checkfollow <username|all>`',
                    value: 'Checks if accounts are following the required channel for drops.\n> 📌 `!checkfollow all`' },
                )
                .setFooter({ text: '← Click 🏠 Home to go back' }),
              rows: () => [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_home').setLabel('🏠 Home').setStyle(ButtonStyle.Secondary),
              )],
            },
            epic: {
              embed: () => new EmbedBuilder()
                .setColor(0xF5A623)
                .setTitle('🔗 Epic Games Linking')
                .setDescription('Link your Epic Games account to Twitch accounts so drops go to your Epic profile.')
                .addFields(
                  { name: '`!link <epic_email> <epic_password> [count|username|all] [waitMinutes]`',
                    value: 'Links your Epic Games account to Twitch accounts via the official OAuth flow.\n' +
                           'After each link: **automatically launches Rocket League**, waits the set time, then closes it before moving to the next account.\n\n' +
                           '• **count** — Link this many unlinked accounts\n' +
                           '• **username** — Link one specific Twitch account\n' +
                           '• **all** — Link every unlinked account\n' +
                           '• *(no arg)* — Link just the next 1 unlinked account\n' +
                           '• **waitMinutes** — Minutes to keep Rocket League open per account (default: 3)\n\n' +
                           '> 📌 `!link email@gmail.com Pass123 20` — link 20 accounts, 3min RL each\n' +
                           '> 📌 `!link email@gmail.com Pass123 all 5` — link all, 5min RL each\n\n' +
                           '⚠️ Already-linked accounts are skipped automatically.\n' +
                           '⚠️ If Epic has 2FA enabled the bot will skip that account.\n' +
                           '⚠️ Epic Games launcher must be installed and logged in.' },
                )
                .setFooter({ text: '← Click 🏠 Home to go back' }),
              rows: () => [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_home').setLabel('🏠 Home').setStyle(ButtonStyle.Secondary),
              )],
            },
            viewer: {
              embed: () => new EmbedBuilder()
                .setColor(0xFF4D6D)
                .setTitle('👁️ Viewer Bot')
                .setDescription('Send fake viewers to any Twitch channel.')
                .addFields(
                  { name: '`!view <channel> [count] [proxy]`',
                    value: 'Starts sending fake viewers to a channel.\n• **count** — Number of viewers to send (default: 1)\n• **proxy** — Optional proxy URL\n> 📌 `!view ninja 50`' },
                  { name: '`!stopview <channel>`',
                    value: 'Stops the viewer bot for a specific channel.\n> 📌 `!stopview ninja`' },
                  { name: '`!viewers`',
                    value: 'Shows all channels currently receiving fake viewers and their count.' },
                )
                .setFooter({ text: '← Click 🏠 Home to go back' }),
              rows: () => [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_home').setLabel('🏠 Home').setStyle(ButtonStyle.Secondary),
              )],
            },
            utility: {
              embed: () => new EmbedBuilder()
                .setColor(0x6C757D)
                .setTitle('⚙️ Utility & Tools')
                .setDescription('System tools and status commands.')
                .addFields(
                  { name: '`!status`',
                    value: 'Full overview: active watchers, viewer bots, account count, drops farmed.' },
                  { name: '`!resetdrops`',
                    value: 'Clears all drop skip timestamps so the bot tries to claim drops again on next cycle.' },
                  { name: '`!testproxy <url>`',
                    value: 'Tests whether a proxy is blocked by Kasada (Twitch\'s bot detection).\n> 📌 `!testproxy http://user:pass@1.2.3.4:8080`' },
                  { name: '`!help`',
                    value: 'Shows this interactive menu.' },
                )
                .setFooter({ text: '← Click 🏠 Home to go back' }),
              rows: () => [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_home').setLabel('🏠 Home').setStyle(ButtonStyle.Secondary),
              )],
            },
          };

          const homePage = HELP_PAGES.home;
          const helpMsg = await msg.channel.send({ embeds: [homePage.embed()], components: homePage.rows() });

          const collector = helpMsg.createMessageComponentCollector({ time: 5 * 60 * 1000 });
          collector.on('collect', async (interaction) => {
            if (interaction.user.id !== msg.author.id) {
              return interaction.reply({ content: 'This menu is not yours.', ephemeral: true });
            }
            const pageKey = interaction.customId.replace('help_', '');
            const page = HELP_PAGES[pageKey];
            if (!page) return;
            await interaction.update({ embeds: [page.embed()], components: page.rows() });
          });
          collector.on('end', () => { helpMsg.edit({ components: [] }).catch(() => {}); });
          break;
        }

      }
    } catch (err) {
      console.error('Discord cmd error:', err);
      await msg.channel.send(`Error: ${err.message}`).catch(() => {});
    }
  });

  client.login(token);
}

module.exports = { start };
