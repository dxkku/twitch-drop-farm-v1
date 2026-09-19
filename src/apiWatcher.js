'use strict';

/**
 * API-based Twitch drop watcher.
 *
 * Runs all accounts simultaneously with zero Chrome instances.
 * Each account gets its own 60-second tick that POSTs a minute-watched
 * event to Twitch's spade endpoint — same signal a real browser sends.
 * Drops are checked every 5 minutes via GQL and claimed automatically.
 */

const {
  getAuthToken, getStreamInfo, getUserId,
  getSpadeUrl, sendMinuteWatched,
  getDropsProgress, claimDrop,
  randomHex, randomDeviceId,
} = require('./twitchApi');

const { accounts, saveAccounts } = require('./state');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// accId -> { minuteInterval, dropInterval, running, streamer, username, startedAt, ... }
const activeApiWatchers = {};

// ─── Per-account watcher ─────────────────────────────────────────────────────

async function startApiWatching(accId, streamerLogin, opts = {}) {
  if (activeApiWatchers[accId]) {
    console.log(`DEBUG [apiWatch] ${accId}: already running`);
    return { started: false, reason: 'already_running' };
  }

  const acc = accounts[accId];
  if (!acc) return { started: false, reason: 'account_not_found' };

  const token = getAuthToken(acc.cookies);
  if (!token) return { started: false, reason: 'no_auth_token' };

  const username = acc.twitchData?.username || acc.username || accId;
  const ids      = { deviceId: randomDeviceId(), sessionId: randomHex(16) };

  console.log(`DEBUG [apiWatch] ${username}: initialising for ${streamerLogin}...`);

  // ── 1. Verify token by getting own user ID ────────────────────────────────
  const userId = await getUserId(token, username, ids).catch(() => null);
  if (!userId) {
    console.log(`DEBUG [apiWatch] ${username}: failed to get userId — token may be expired`);
    return { started: false, reason: 'invalid_token' };
  }

  // ── 2. Get spade URL (cached per-streamer) ────────────────────────────────
  const spadeUrl = await getSpadeUrl(streamerLogin).catch(() => null);
  if (!spadeUrl) {
    console.log(`DEBUG [apiWatch] ${username}: could not get spade URL for ${streamerLogin}`);
    return { started: false, reason: 'no_spade_url' };
  }

  // ── 3. Get stream info (broadcast_id, channel_id, game) ──────────────────
  let streamInfo = await getStreamInfo(token, streamerLogin, ids).catch(() => null);
  if (!streamInfo) {
    console.log(`DEBUG [apiWatch] ${username}: ${streamerLogin} is offline or unreachable`);
    return { started: false, reason: 'stream_offline' };
  }

  console.log(`DEBUG [apiWatch] ${username}: stream OK — broadcastId=${streamInfo.broadcastId} game=${streamInfo.gameName}`);

  const state = {
    running:      true,
    streamer:     streamerLogin,
    username,
    userId,
    spadeUrl,
    streamInfo,
    ids,
    token,
    startedAt:    Date.now(),
    minutesSent:  0,
  };
  activeApiWatchers[accId] = state;

  acc.watching = streamerLogin;
  saveAccounts();

  // ── 4. Minute-watched loop (fires every 60 s) ─────────────────────────────
  state.minuteInterval = setInterval(async () => {
    if (!state.running) return;

    // Refresh stream info every 10 minutes (broadcast_id changes on stream restart)
    if (state.minutesSent > 0 && state.minutesSent % 10 === 0) {
      const fresh = await getStreamInfo(state.token, state.streamer, state.ids).catch(() => null);
      if (fresh) {
        state.streamInfo = fresh;
      } else {
        console.log(`DEBUG [apiWatch] ${username}: stream went offline — stopping`);
        stopApiWatching(accId);
        if (typeof opts.onStop === 'function') opts.onStop(accId, 'stream_offline');
        return;
      }
    }

    await sendMinuteWatched(state.spadeUrl, {
      ...state.streamInfo,
      userId:        state.userId,
      streamerLogin: state.streamer,
    }).catch(() => {});

    state.minutesSent++;
    console.log(`DEBUG [apiWatch] ${username}: ✅ minute-watched #${state.minutesSent}`);
  }, 60 * 1000);

  // ── 5. Drop check loop (every 5 min) ─────────────────────────────────────
  state.dropInterval = setInterval(async () => {
    if (!state.running) return;

    const drops = await getDropsProgress(state.token, state.ids).catch(() => []);
    if (drops.length === 0) {
      console.log(`DEBUG [apiWatch] ${username}: no drops found in dashboard`);
      return;
    }

    let allDone = true;

    for (const drop of drops) {
      if (drop.isClaimed) {
        console.log(`DEBUG [apiWatch] ${username}: ✅ ${drop.name} already claimed`);
        continue;
      }

      if (drop.claimable && drop.dropInstanceId) {
        console.log(`DEBUG [apiWatch] ${username}: 🎁 claiming ${drop.name}...`);
        const ok = await claimDrop(state.token, drop.dropInstanceId, state.ids).catch(() => false);
        console.log(`DEBUG [apiWatch] ${username}: claim ${drop.name} → ${ok ? 'success ✅' : 'failed ❌'}`);
        if (ok) {
          acc.dropsClaimed = (acc.dropsClaimed || 0) + 1;
          saveAccounts();
        }
        continue;
      }

      console.log(`DEBUG [apiWatch] ${username}: ⏱ ${drop.name} — ${drop.pct}% (${drop.minutesLeft} min left)`);
      allDone = false;
    }

    if (allDone && drops.length > 0) {
      console.log(`DEBUG [apiWatch] ${username}: 🏁 all drops claimed — stopping`);
      stopApiWatching(accId);
      if (typeof opts.onStop === 'function') opts.onStop(accId, 'all_claimed');
    }
  }, 5 * 60 * 1000);

  console.log(`DEBUG [apiWatch] ${username}: watching ${streamerLogin} via API ✅`);
  return { started: true, streamer: streamerLogin, account: username };
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

function stopApiWatching(accId) {
  const state = activeApiWatchers[accId];
  if (!state) return false;

  state.running = false;
  clearInterval(state.minuteInterval);
  clearInterval(state.dropInterval);
  delete activeApiWatchers[accId];

  const acc = accounts[accId];
  if (acc) { acc.watching = null; saveAccounts(); }

  console.log(`DEBUG [apiWatch] ${state.username}: stopped`);
  return true;
}

function stopAllApiWatching() {
  const ids = Object.keys(activeApiWatchers);
  ids.forEach(stopApiWatching);
  return ids.length;
}

// ─── Status ───────────────────────────────────────────────────────────────────

function getApiWatchers() { return { ...activeApiWatchers }; }
function isApiWatching(accId) { return !!activeApiWatchers[accId]; }

module.exports = {
  startApiWatching,
  stopApiWatching,
  stopAllApiWatching,
  getApiWatchers,
  isApiWatching,
};
