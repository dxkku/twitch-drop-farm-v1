require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const twitchBot = require('./twitchBot');
const twitchApi = require('./twitchApi');
const kpsdkFetcher = require('./kpsdkFetcher');
const { accounts, twitchSessions, saveAccounts } = require('./state');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 6767;
const API_KEY = process.env.API_KEY || 'dev-key';
const DOMAIN = process.env.DOMAIN || 'yourdomain.com';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_REDIRECT_URI = process.env.TWITCH_REDIRECT_URI || `http://localhost:${PORT}/api/twitch/callback`;
const axios = require('axios');

function generateEmail(prefix) {
  return `${prefix || uuidv4().slice(0, 8)}@${DOMAIN}`;
}

function generatePassword() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let pw = '';
  for (let i = 0; i < 18; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  return pw;
}

function auth(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

async function sendDiscord(data, type = 'account') {
  if (!DISCORD_WEBHOOK) return;
  try {
    let embed;
    if (type === 'account') {
      embed = {
        title: 'Account Created', color: 0x57F287,
        fields: [
          { name: 'Email', value: `\`${data.email}\``, inline: true },
          { name: 'Password', value: `||${data.password}||`, inline: true },
          { name: 'Twitch', value: data.username || 'N/A', inline: true },
          { name: 'DOB', value: data.dob || 'N/A', inline: true },
        ],
        timestamp: new Date().toISOString(),
      };
    } else if (type === 'drop') {
      embed = {
        title: 'Drop Claimed!', color: 0xFEE75C,
        fields: [
          { name: 'Account', value: data.email, inline: true },
          { name: 'Drop', value: data.dropName, inline: true },
          { name: 'Game', value: data.game || 'Unknown', inline: true },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    if (embed) await axios.post(DISCORD_WEBHOOK, { embeds: [embed] }).catch(() => {});
  } catch {}
}

app.post('/api/account/create', auth, async (req, res) => {
  const { prefix } = req.body || {};
  const email = generateEmail(prefix);
  const password = generatePassword();
  const id = `acc_${Date.now()}`;
  accounts[id] = { id, email, password, createdAt: new Date().toISOString(), twitchLinked: false, twitchData: null, dropsClaimed: 0, watching: null };
  saveAccounts();
  res.json({ success: true, account: { id, email, password, createdAt: accounts[id].createdAt } });
});

app.get('/api/accounts', auth, (req, res) => {
  res.json({ success: true, accounts: Object.values(accounts).map(a => ({ id: a.id, email: a.email, twitchLinked: a.twitchLinked, twitchUser: a.twitchData?.twitchUsername || null, dropsClaimed: a.dropsClaimed, watching: a.watching })) });
});

app.get('/api/account/:id', auth, (req, res) => {
  const acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  res.json({ success: true, account: acc });
});

app.post('/api/account/twitch-signup/:id', auth, async (req, res) => {
  const acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  res.json({ success: true, message: 'Twitch signup started' });
  const result = await twitchBot.createTwitchAccount(acc.password);
  if (result.success) {
    acc.twitchLinked = true;
    acc.twitchData = { username: result.username, ...result };
    saveAccounts();
    await sendDiscord({ ...acc, username: result.username }).catch(() => {});
  }
});

app.get('/api/twitch/auth-url', auth, (req, res) => {
  if (!TWITCH_CLIENT_ID) return res.status(400).json({ error: 'TWITCH_CLIENT_ID not configured' });
  const { accountId } = req.query;
  if (!accountId || !accounts[accountId]) return res.status(404).json({ error: 'Account not found' });
  const state = JSON.stringify({ accountId, csrf: crypto.randomBytes(16).toString('hex') });
  twitchSessions[accountId] = { state, createdAt: Date.now() };
  res.json({ success: true, authUrl: twitchApi.getOAuthUrl(TWITCH_CLIENT_ID, TWITCH_REDIRECT_URI, state) });
});

app.get('/api/twitch/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state');
  try {
    const { accountId } = JSON.parse(state);
    if (!twitchSessions[accountId]) return res.status(400).send('Invalid session');
    const tokenData = await twitchApi.exchangeCode(TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, code, TWITCH_REDIRECT_URI);
    const userInfo = await twitchApi.getUserInfo(tokenData.access_token, TWITCH_CLIENT_ID);
    const acc = accounts[accountId];
    if (acc) {
      acc.twitchLinked = true;
      acc.twitchData = { twitchId: userInfo.id, twitchUsername: userInfo.login, displayName: userInfo.display_name, accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token, expiresAt: Date.now() + tokenData.expires_in * 1000 };
    }
    res.send(`<script>window.close()</script><p>Twitch linked! Username: ${userInfo.login}</p>`);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

async function ensureToken(acc) {
  if (!acc?.twitchData?.accessToken) throw new Error('Twitch not linked');
  if (Date.now() > (acc.twitchData.expiresAt || 0)) {
    const refreshed = await twitchApi.refreshToken(TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, acc.twitchData.refreshToken);
    acc.twitchData.accessToken = refreshed.access_token;
    acc.twitchData.expiresAt = Date.now() + refreshed.expires_in * 1000;
    if (refreshed.refresh_token) acc.twitchData.refreshToken = refreshed.refresh_token;
  }
  return acc.twitchData.accessToken;
}

app.post('/api/drops/check/:id', auth, async (req, res) => {
  const acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  try {
    const token = await ensureToken(acc);
    const inventory = await twitchApi.getDropsInventory(token, TWITCH_CLIENT_ID);
    const drops = inventory.flatMap(d => (d.benefits || []).map(b => ({ dropId: b.id, name: b.name, status: b.status, game: d.game?.name })));
    res.json({ success: true, drops, account: acc.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drops/claim/:id', auth, async (req, res) => {
  const acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  try {
    const token = await ensureToken(acc);
    const inventory = await twitchApi.getDropsInventory(token, TWITCH_CLIENT_ID);
    const results = [];
    for (const drop of inventory) {
      for (const benefit of drop.benefits || []) {
        if (benefit.status === 'CLAIMED') continue;
        try {
          await twitchApi.claimDrop(token, TWITCH_CLIENT_ID, benefit.id);
          results.push({ dropId: benefit.id, name: benefit.name, game: drop.game?.name, status: 'claimed' });
          acc.dropsClaimed++;
          await sendDiscord({ email: acc.email, dropName: benefit.name, game: drop.game?.name }, 'drop').catch(() => {});
        } catch (e) {
          results.push({ dropId: benefit.id, name: benefit.name, status: 'failed', error: e.message });
        }
      }
    }
    res.json({ success: true, results, totalClaimed: acc.dropsClaimed, account: acc.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test-kpsdk', auth, async (req, res) => {
  try {
    const result = await kpsdkFetcher.testFpEndpoint(req.query.url);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    service: 'Twitch Drop Farmer',
    status: 'running', domain: DOMAIN,
    twitchConfigured: !!TWITCH_CLIENT_ID,
    discordBot: !!process.env.DISCORD_BOT_TOKEN,
    accounts: Object.keys(accounts).length,
    endpoints: { createAccount: 'POST /api/account/create', listAccounts: 'GET /api/accounts', getAccount: 'GET /api/account/:id', twitchSignup: 'POST /api/account/twitch-signup/:id', getAuthUrl: 'GET /api/twitch/auth-url?accountId=', checkDrops: 'POST /api/drops/check/:id', claimDrops: 'POST /api/drops/claim/:id', testKpsdk: 'GET /api/test-kpsdk' },
  });
});

app.listen(PORT, () => {
  console.log(`Twitch Drop Farmer running on port ${PORT}`);
  console.log(`Domain: ${DOMAIN}`);
  console.log(`Twitch API: ${TWITCH_CLIENT_ID ? 'Configured' : 'NOT configured'}`);
});

if (process.env.DISCORD_BOT_TOKEN) {
  try {
    const discordBot = require('./discordBot');
    discordBot.start(process.env.DISCORD_BOT_TOKEN);
  } catch (e) {
    console.error('Failed to start Discord bot:', e.message);
  }
}

process.on('SIGINT', () => { console.log('Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('Shutting down...'); process.exit(0); });

module.exports = { accounts, ensureToken, sendDiscord, generateEmail, generatePassword };
