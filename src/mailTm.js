const https = require('https');

const BASE = 'https://api.mail.tm';

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let cachedDomains = null;

async function getDomains() {
  if (cachedDomains && Date.now() - cachedDomains.ts < 3600000) return cachedDomains.list;
  const res = await request('GET', '/domains');
  if (res.status !== 200) throw new Error('Failed to get domains: ' + JSON.stringify(res.data));
  // API returns plain array or hydra:member wrapped
  const list = Array.isArray(res.data) ? res.data : (res.data['hydra:member'] || []);
  const domains = list.map(d => d.domain).filter(Boolean);
  if (domains.length === 0) throw new Error('No mail.tm domains available');
  cachedDomains = { list: domains, ts: Date.now() };
  console.log(`DEBUG [mail.tm] Got ${domains.length} domains: ${domains.join(', ')}`);
  return domains;
}

async function createAccount() {
  const domains = await getDomains();

  // Retry up to 5 times if address is taken (422)
  for (let attempt = 1; attempt <= 5; attempt++) {
    const domain = domains[Math.floor(Math.random() * domains.length)];
    const username = randomString(12);
    const address = username + '@' + domain;
    const password = 'Tm' + randomString(16) + '!';

    console.log(`DEBUG [mail.tm] Creating account (attempt ${attempt}): ${address}`);
    const res = await request('POST', '/accounts', { address, password });

    if (res.status === 201 || res.status === 200) {
      console.log(`DEBUG [mail.tm] Created account: ${address}`);
      return { address, password, domain };
    }

    // 422 = address taken, retry
    if (res.status === 422) {
      console.log(`DEBUG [mail.tm] Address taken, retrying...`);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    // Other error
    throw new Error('Failed to create mail.tm account: status ' + res.status + ' — ' + JSON.stringify(res.data).slice(0, 200));
  }

  throw new Error('Failed to create mail.tm account after 5 attempts');
}

async function getToken(address, password) {
  const res = await request('POST', '/token', { address, password });
  if (res.status !== 200 || !res.data.token) {
    throw new Error('Failed to get mail.tm token: ' + JSON.stringify(res.data));
  }
  return res.data.token;
}

async function getMessages(token) {
  const res = await request('GET', '/messages', null, token);
  if (res.status !== 200) throw new Error('Failed to get messages: ' + JSON.stringify(res.data));
  const list = Array.isArray(res.data) ? res.data : (res.data['hydra:member'] || []);
  return list;
}

async function getMessage(messageId, token) {
  const res = await request('GET', '/messages/' + messageId, null, token);
  if (res.status !== 200) throw new Error('Failed to get message: ' + JSON.stringify(res.data));
  return res.data;
}

function extractTwitchCode(text) {
  if (!text) return null;
  // Try subject pattern first: "998994 – Your Twitch Verification Code"
  const subjectMatch = text.match(/(\d{6})\s*[–-]\s*Your Twitch/i);
  if (subjectMatch) return subjectMatch[1];
  // Try body: 6-digit code (space-separated HTML digits, or plain)
  const bodyMatch = text.match(/(?:^|\s)(\d{6})(?:\s|$)/m);
  if (bodyMatch) return bodyMatch[1];
  return null;
}

function randomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Wait for a Twitch verification code to arrive in the mail.tm inbox.
 * Polls every 3 seconds, up to 2 minutes.
 */
async function waitForCode(address, password, maxWaitMs = 120000) {
  const start = Date.now();
  let token = null;

  // Get token (retry a few times — account may need a moment)
  for (let i = 0; i < 10; i++) {
    try {
      token = await getToken(address, password);
      break;
    } catch (e) {
      console.log(`DEBUG [mail.tm] Token attempt ${i + 1}/10 failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (!token) throw new Error('Failed to get mail.tm token after 10 retries');

  // Poll for messages
  while (Date.now() - start < maxWaitMs) {
    try {
      const messages = await getMessages(token);
      for (const msg of messages) {
        // Look for Twitch verification emails
        const from = msg.from?.address || '';
        const subject = msg.subject || '';
        if (from.includes('twitch') || subject.includes('Twitch') || subject.includes('Verification')) {
          const full = await getMessage(msg.id, token);
          const text = (full.text || '') + ' ' + (full.subject || '');
          const code = extractTwitchCode(text);
          if (code) {
            console.log(`DEBUG [mail.tm] Got Twitch code: ${code} from ${from}`);
            return code;
          }
        }
      }
    } catch (e) {
      console.log(`DEBUG [mail.tm] Poll error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  return null;
}

module.exports = { getDomains, createAccount, getToken, getMessages, getMessage, waitForCode, extractTwitchCode };
