'use strict';

/**
 * Twitch API — no browser needed.
 *
 * Watch-time is reported by POSTing base64-encoded "minute-watched" events
 * to Twitch's spade analytics endpoint, exactly as a real browser does.
 * Drops are queried and claimed via the GraphQL API.
 */

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

// ─── Constants ───────────────────────────────────────────────────────────────

const GQL_URL       = 'https://gql.twitch.tv/gql';
const CLIENT_ID     = 'ue6666qo983tsx6so1t0vnawi233wa';   // TV client — no Kasada
const CLIENT_VER    = 'ef928475-9403-42f2-8a34-55784bd08e16';
const TV_UA         = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1';
const BROWSER_UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// GQL persisted query hashes
const GQL = {
  IsStreamLive: {
    operationName: 'WithIsStreamLiveQuery',
    extensions: { persistedQuery: { version: 1, sha256Hash: '04e46329a6786ff3a81c01c50bfa5d725902507a0deb83b0edbf7abe7a3716ea' } },
  },
  StreamInfo: {
    operationName: 'VideoPlayerStreamInfoOverlayChannel',
    extensions: { persistedQuery: { version: 1, sha256Hash: '198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d' } },
  },
  GetUserId: {
    operationName: 'GetIDFromLogin',
    variables: { login: null },
    extensions: { persistedQuery: { version: 1, sha256Hash: '94e82a7b1e3c21e186daa73ee2afc4b8f23bade1fbbff6fe8ac133f50a2f58ca' } },
  },
  DropsDashboard: {
    operationName: 'ViewerDropsDashboard',
    variables: { fetchRewardCampaigns: true },
    extensions: { persistedQuery: { version: 1, sha256Hash: '5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619' } },
  },
  ClaimDrop: {
    operationName: 'DropsPage_ClaimDropRewards',
    extensions: { persistedQuery: { version: 1, sha256Hash: 'a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930' } },
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomDeviceId() {
  const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 32 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location, headers));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const buf = Buffer.from(body);
    const opts = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  { 'Content-Length': buf.length, ...headers },
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Extract the OAuth token from a cookies array (Puppeteer format).
 * The token lives in the cookie named "auth-token".
 */
function getAuthToken(cookies) {
  if (!Array.isArray(cookies)) return null;
  const c = cookies.find(c => c.name === 'auth-token');
  return c ? c.value : null;
}

// ─── GraphQL ─────────────────────────────────────────────────────────────────

/**
 * Make a GQL call (single op or array).
 * ids = { deviceId, sessionId } — generated once per account session.
 */
async function gqlRequest(token, operations, ids) {
  const body = JSON.stringify(operations);
  const res = await httpPost(GQL_URL, body, {
    'Authorization':      `OAuth ${token}`,
    'Client-Id':          CLIENT_ID,
    'Client-Session-Id':  ids.sessionId,
    'Client-Version':     CLIENT_VER,
    'User-Agent':         TV_UA,
    'X-Device-Id':        ids.deviceId,
    'Content-Type':       'application/json',
  });
  try { return JSON.parse(res.body); } catch { return null; }
}

// ─── Stream info ─────────────────────────────────────────────────────────────

/** Returns { channelId, broadcastId, gameId, gameName } or null if offline */
async function getStreamInfo(token, streamerLogin, ids) {
  const res = await gqlRequest(token, { ...GQL.StreamInfo, variables: { channel: streamerLogin } }, ids);
  try {
    const user   = res.data.user;
    const stream = user.stream;
    if (!stream) return null;
    return {
      channelId:   user.id,
      broadcastId: stream.id,
      gameId:      user.broadcastSettings?.game?.id   || null,
      gameName:    user.broadcastSettings?.game?.name || null,
    };
  } catch {
    return null;
  }
}

/** Get Twitch user ID (number string) from login name */
async function getUserId(token, login, ids) {
  const res = await gqlRequest(token, { ...GQL.GetUserId, variables: { login } }, ids);
  try { return res.data.user.id; } catch { return null; }
}

// ─── Spade (minute-watched) ───────────────────────────────────────────────────

const spadeCache = {};

/**
 * Extract the spade analytics URL from Twitch's settings JS.
 * Results are cached per-streamer since the URL changes rarely.
 */
async function getSpadeUrl(streamerLogin) {
  if (spadeCache[streamerLogin]) return spadeCache[streamerLogin];

  const html = await httpGet(`https://www.twitch.tv/${streamerLogin}`, { 'User-Agent': BROWSER_UA }).catch(() => '');
  const settingsMatch = html.match(/https:\/\/(?:static\.twitchcdn\.net|assets\.twitch\.tv)\/config\/settings[^"'<\s]+\.js/);
  if (!settingsMatch) return null;

  const settingsJs = await httpGet(settingsMatch[0], { 'User-Agent': BROWSER_UA }).catch(() => '');
  const spadeMatch = settingsJs.match(/"spade_url":"([^"]+)"/);
  if (!spadeMatch) return null;

  spadeCache[streamerLogin] = spadeMatch[1];
  return spadeMatch[1];
}

/**
 * POST a minute-watched event to the spade endpoint.
 * This is what Twitch uses to count watch time for drops.
 */
async function sendMinuteWatched(spadeUrl, { channelId, broadcastId, gameId, gameName, userId, streamerLogin }) {
  const payload = [{
    event: 'minute-watched',
    properties: {
      channel_id:   channelId,
      broadcast_id: broadcastId,
      player:       'site',
      user_id:      userId,
      live:         true,
      channel:      streamerLogin,
      ...(gameName ? { game: gameName } : {}),
      ...(gameId   ? { game_id: gameId } : {}),
    },
  }];
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  await httpPost(spadeUrl, `data=${encodeURIComponent(encoded)}`, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent':   BROWSER_UA,
  }).catch(() => {});
}

// ─── Drops ────────────────────────────────────────────────────────────────────

/**
 * Returns array of drop objects: { name, pct, minutesLeft, dropInstanceId, claimable, isClaimed }
 */
async function getDropsProgress(token, ids) {
  const res = await gqlRequest(token, GQL.DropsDashboard, ids);
  const drops = [];
  try {
    const campaigns = res.data.currentUser.dropCampaigns || [];
    for (const campaign of campaigns) {
      for (const drop of (campaign.drops || [])) {
        const self     = drop.self || {};
        const required = drop.requiredMinutesWatched || 0;
        const current  = self.currentMinutesWatched  || 0;
        const pct      = required > 0 ? Math.round((current / required) * 100) : 0;
        drops.push({
          name:           drop.name || campaign.name || 'Drop',
          pct,
          minutesLeft:    Math.max(0, required - current),
          dropInstanceId: self.dropInstanceID || null,
          claimable:      !!(self.dropInstanceID && !self.isClaimed && pct >= 100),
          isClaimed:      !!self.isClaimed,
        });
      }
    }
  } catch {}
  return drops;
}

/** Claim a drop. Returns true on success. */
async function claimDrop(token, dropInstanceId, ids) {
  const res = await gqlRequest(token, {
    ...GQL.ClaimDrop,
    variables: { input: { dropInstanceID: dropInstanceId } },
  }, ids);
  try {
    return res.data.claimDropRewards?.status === 'ELIGIBLE_FOR_ALL';
  } catch {
    return false;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getAuthToken,
  getStreamInfo,
  getUserId,
  getSpadeUrl,
  sendMinuteWatched,
  getDropsProgress,
  claimDrop,
  randomHex,
  randomDeviceId,
};
