const axios = require('axios');

function getOAuthUrl(clientId, redirectUri, state) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'user:read:email',
    state,
  });
  return `https://id.twitch.tv/oauth2/authorize?${p}`;
}

async function exchangeCode(clientId, clientSecret, code, redirectUri) {
  const p = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const { data } = await axios.post('https://id.twitch.tv/oauth2/token', p.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data;
}

async function refreshToken(clientId, clientSecret, refresh) {
  const p = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });
  const { data } = await axios.post('https://id.twitch.tv/oauth2/token', p.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data;
}

async function getUserInfo(accessToken, clientId) {
  const { data } = await axios.get('https://api.twitch.tv/helix/users', {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId },
  });
  return data.data?.[0];
}

async function getDropsInventory(accessToken, clientId) {
  const { data } = await axios.get('https://api.twitch.tv/helix/drops/inventory', {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId },
  });
  return data.data || [];
}

async function claimDrop(accessToken, clientId, dropId) {
  const { data } = await axios.post(
    'https://api.twitch.tv/helix/drops/claim',
    { claim_drop_id: dropId },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' } }
  );
  return data.data;
}

module.exports = { getOAuthUrl, exchangeCode, refreshToken, getUserInfo, getDropsInventory, claimDrop };
