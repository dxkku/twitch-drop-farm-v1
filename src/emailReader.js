const axios = require('axios');
const { ImapFlow } = require('imapflow');
const dns = require('dns');

const IMAP_HOST = process.env.IMAP_HOST;
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993');
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;

const BASE = 'https://api.mail.tm';

const origLookup = dns.lookup;
dns.lookup = function(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  opts.family = 4;
  return origLookup.call(this, host, opts, cb);
};

// ─── Mail.tm (temp mail fallback) ───────────────────────────────────────────

async function createMailTmInbox() {
  const gen = await axios.get(`${BASE}/domains`);
  const domain = gen.data['hydra:member']?.[0]?.domain;
  if (!domain) throw new Error('No mail.tm domain');

  const local = Math.random().toString(36).slice(2, 12);
  const address = `${local}@${domain}`;
  const password = Math.random().toString(36).slice(2, 12);

  await axios.post(`${BASE}/accounts`, { address, password });
  const tokenRes = await axios.post(`${BASE}/token`, { address, password });

  return { address, token: tokenRes.data.token, id: tokenRes.data.id, type: 'mailtm' };
}

async function waitForMailTmCode(inbox, timeoutMs = 60000) {
  const interval = 3000;
  const attempts = Math.ceil(timeoutMs / interval);

  for (let i = 0; i < attempts; i++) {
    try {
      const msgRes = await axios.get(`${BASE}/messages`, {
        headers: { Authorization: `Bearer ${inbox.token}` },
      });
      const messages = msgRes.data['hydra:member'] || [];
      for (const msg of messages) {
        if (!msg.seen) {
          const detail = await axios.get(`${BASE}/messages/${msg.id}`, {
            headers: { Authorization: `Bearer ${inbox.token}` },
          });
          const content = (detail.data.html?.[0] || '') + (detail.data.text || '');
          const match = content.match(/\b(\d{5,6})\b/);
          if (match) {
            await axios.patch(`${BASE}/messages/${msg.id}`, { seen: true }, {
              headers: { Authorization: `Bearer ${inbox.token}`, 'Content-Type': 'application/json' },
            });
            return match[1];
          }
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('Verification code not received from Mail.tm within timeout');
}

// ─── IMAP ────────────────────────────────────────────────────────────────────

function makeImapClient() {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_PORT === 993,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
    socketTimeout: 60000,
    disableCompression: true,
    tls: { rejectUnauthorized: false },
    connTimeout: 30000,
  });
}

function extractCode(subject, body) {
  // Signup email (no-reply@twitch.tv): code is in subject — "070539 – Your Twitch Verification Code"
  const fromSubject = subject.match(/\b(\d{6})\b/);
  if (fromSubject) return fromSubject[1];

  if (!body) return null;

  // Login verification email: code is in body
  const patterns = [
    /(?:enter|input|use)(?: the)?(?: following)? code[:\s]*(\d{6})/i,
    /verification code[:\s]*(\d{6})/i,
    /login code[:\s]*(\d{6})/i,
    /code[:\s]*(\d{6})/i,
    /رمز التحقق[:\s]*(\d{6})/,
    /كود[:\s]*(\d{6})/,
  ];
  for (const pat of patterns) {
    const m = body.match(pat);
    if (m && m[1] !== '000000') return m[1];
  }

  // Spaced digits: "0 7 0 5 3 9"
  const spaced = body.match(/(?:^|\s)(\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d)(?:\s|$)/);
  if (spaced) return spaced[1].replace(/\s/g, '');

  // Last resort: any standalone 6-digit number
  const allSix = [...body.matchAll(/(?<!\d)(\d{6})(?!\d)/g)];
  for (const m of allSix) {
    if (m[1] !== '000000' && m[1] !== '199999' && m[1] !== '200000') return m[1];
  }

  return null;
}

/**
 * Wait for a Twitch verification code addressed to `toEmail`.
 *
 * Uses IMAP IDLE — the server pushes a notification the instant new mail
 * arrives, so there is no polling delay. We only wake up when Gmail tells
 * us something changed, then do a single targeted search.
 *
 * Fast path (signup): code is in the subject → envelope-only fetch, no body download.
 * Slow path (login):  code is in the body  → full source fetch only for those emails.
 */
async function waitForImapCode(toEmail, timeoutMs = 180000, sinceTimestamp) {
  const start   = Date.now();
  const sinceMs = sinceTimestamp || start;
  const seenUids = new Set();

  const client = makeImapClient();
  client.on('error', () => {});

  try {
    await client.connect();
    console.log(`DEBUG IMAP connected for ${toEmail}`);

    const lock = await client.getMailboxLock('INBOX');
    try {

      // ── core search: runs after initial connect and after every IDLE wakeup ──
      async function checkForCode() {
        // Gmail sets Delivered-To to the exact alias — most reliable
        let uids = await client.search(
          { unseen: true, header: ['Delivered-To', toEmail] },
          { uid: true }
        ).catch(() => []);

        // Fallback: TO field (non-Gmail or if Delivered-To not indexed)
        if (!uids.length) {
          uids = await client.search(
            { unseen: true, to: toEmail },
            { uid: true }
          ).catch(() => []);
        }

        const newUids = uids.filter(u => !seenUids.has(u));
        if (!newUids.length) return null;

        console.log(`DEBUG IMAP ${newUids.length} email(s) for ${toEmail}`);

        // Envelope-only fetch first (subject has the code for signup emails)
        const needsBody = [];
        for await (const msg of client.fetch(newUids, { envelope: true, internalDate: true }, { uid: true })) {
          seenUids.add(msg.uid);
          const subject = msg.envelope?.subject || '';
          const from    = msg.envelope?.from?.map(f => f.address).join(',') || '';
          const msgDate = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;

          if (msgDate > 0 && msgDate < sinceMs - 120000) continue;
          if (!/twitch/i.test(from) && !/twitch/i.test(subject)) continue;

          console.log(`DEBUG IMAP Twitch email: from="${from}" subject="${subject}"`);

          const m = subject.match(/\b(\d{6})\b/);
          if (m) {
            console.log(`DEBUG IMAP got code from subject: ${m[1]}`);
            try { await client.messageDelete(msg.uid, { uid: true }); } catch(e) {}
            return m[1];
          }
          needsBody.push(msg.uid);
        }

        // Body fetch only for emails where subject had no code (login codes)
        for (const uid of needsBody) {
          for await (const msg of client.fetch([uid], { envelope: true, source: true, internalDate: true }, { uid: true })) {
            const subject = msg.envelope?.subject || '';
            const raw     = msg.source ? msg.source.toString() : '';
            const bodyStart = raw.indexOf('\n\n');
            const rawBody   = bodyStart > -1 ? raw.slice(bodyStart + 2) : raw;
            const decoded   = rawBody
              .replace(/=\r?\n/g, '').replace(/=\n/g, '')
              .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
            const cleanBody = decoded
              .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const code = extractCode(subject, cleanBody);
            if (code) {
              console.log(`DEBUG IMAP got code from body: ${code}`);
              try { await client.messageDelete(msg.uid, { uid: true }); } catch(e) {}
              return code;
            }
          }
        }
        return null;
      }

      // Check immediately in case email already arrived
      const initial = await checkForCode();
      if (initial) return initial;

      console.log(`DEBUG IMAP watching ${toEmail} via IDLE (instant push)...`);

      // IDLE loop — Gmail server notifies us the instant new mail arrives
      while (Date.now() - start < timeoutMs) {
        const remaining = timeoutMs - (Date.now() - start);

        // Race: IDLE (server pushes EXISTS when new mail arrives) vs 20s heartbeat
        // Either way we exit and check — IDLE just means we wake up immediately
        await Promise.race([
          client.idle(),
          new Promise(r => setTimeout(r, Math.min(20000, remaining))),
        ]).catch(() => {});

        // client.search() auto-exits IDLE before sending the command
        const code = await checkForCode();
        if (code) return code;

        const elapsed = Math.round((Date.now() - start) / 1000);
        if (elapsed % 20 < 2) console.log(`DEBUG IMAP still waiting for ${toEmail} (${elapsed}s)`);
      }

    } finally {
      lock.release();
    }
  } catch(e) {
    console.log(`DEBUG IMAP error for ${toEmail}:`, e.message);
  } finally {
    try { await client.logout(); } catch(_) {}
  }

  throw new Error('Verification code not received via IMAP within timeout');
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function createInbox(email) {
  if (IMAP_HOST && IMAP_USER && IMAP_PASS) {
    return { address: email, type: 'imap' };
  }
  return createMailTmInbox();
}

async function waitForCode(inbox, timeoutMs) {
  if (inbox.type === 'imap') {
    return waitForImapCode(inbox.address, timeoutMs || 90000, inbox.since);
  }
  return waitForMailTmCode(inbox, timeoutMs || 60000);
}

module.exports = { createInbox, waitForCode };
