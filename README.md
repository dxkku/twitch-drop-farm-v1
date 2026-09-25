# Twitch Drop Farm Bot

> Built by **dxkku** and **Claude** :3
>
> 💬 **[Join the Discord](https://discord.gg/kq7Rh3AKZH)**

Automated Twitch account creator, stream watcher, and drop farmer with Kasada bypass.

---

> **⚠️ REQUIREMENT — Google Chrome must be installed**
> The bot launches real Chrome to bypass Kasada. Without it, nothing works.
> **[Download Google Chrome](https://www.google.com/chrome/)**

---

## Known Limitations

### Gmail Alias Rate Limit — ~6 Accounts per 24 Hours

**Problem:** Twitch tracks signups by the **base Gmail address**, not by alias. After creating approximately **6 accounts** using the same Gmail (e.g. `youremail+acc001@gmail.com`, `youremail+acc002@gmail.com`, etc.), Twitch suspends further signups from that base email for **~24 hours**.

The bot runs fine — but Twitch silently stops sending verification codes to any alias of that Gmail, so accounts will fail to verify after the 6th one.

**Manual workaround:** Use a different Gmail account for every ~5 accounts. Update `IMAP_USER` and `IMAP_PASS` in `.env` and restart.

> **⚠️ Automated multi-Gmail rotation (no manual steps needed) is available in the private version only.**
> [Join the Discord](https://discord.gg/kq7Rh3AKZH) for access.

---

## Features

- **Account Creation** — Bypasses Kasada anti-bot with real Chrome (late-CDP pattern)
- **Email Verification** — Auto-reads verification codes from Gmail via IMAP IDLE (instant)
- **Drop Claiming** — Automatically claims available Twitch drops
- **Stream Watching** — Watches streams, follows channel, sends chat messages
- **Auto-Rotation** — When one account stops watching, the next idle account takes over
- **Batch Mode** — Create hundreds of accounts with safe pacing
- **Discord Control** — All commands via Discord bot with live embeds

---

## Setup Requirements

| Requirement | Where to get |
|------------|-------------|
| **Google Chrome** | https://www.google.com/chrome/ — **required**, the bot launches Chrome to bypass Kasada |
| Discord bot token | https://discord.com/developers/applications |
| Gmail + App Password | https://myaccount.google.com/apppasswords |
| Smartproxy (optional) | Residential proxy with sticky sessions — format: `http://smart-user:pass@host:port` |

---

## Quick Start

1. Copy `.env.example` to `.env` and fill in your credentials
2. Set up Gmail IMAP (see Email Setup section below)
3. Run the bot: `node src/index.js`
4. In Discord: `!createfull 200 4 20 20`
5. Wait ~5 hours for completion
6. Start farming: `!watch all`

---

## Email Setup — Gmail (Recommended)

**Use Gmail (`gmail.com`) — it is the safest and most reliable choice.**

Custom domains (Cloudflare, Namecheap, etc.) can get blocklisted by Twitch over time.
Gmail is trusted by Twitch, never blocklisted, and delivers codes instantly via IMAP IDLE.

### Step 1 — Create a Gmail App Password

1. Go to your Google Account → **Security** → **2-Step Verification** → **App Passwords**
2. Create an App Password for "Mail"
3. Copy the 16-character password (use this, NOT your Google login password)

### Step 2 — Configure `.env`

```env
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=youremail@gmail.com
IMAP_PASS=xxxx xxxx xxxx xxxx
```

### Step 3 — Use Gmail Aliases for Each Account

Register each Twitch account with a unique Gmail alias — they all land in the same inbox:

```
youremail+acc001@gmail.com
youremail+acc002@gmail.com
youremail+acc003@gmail.com
```

The IMAP reader routes each verification code to the correct account automatically.

### Why Gmail and Not a Custom Domain

| | Gmail | Custom Domain |
|---|---|---|
| Twitch trust | ✅ Never blocked | ❌ Can get blocklisted |
| Code delivery | ⚡ IMAP IDLE — instant | Varies |
| Setup | Simple App Password | DNS + routing rules |
| Cost | Free | ~$8-12/year per domain |
| Reliability | Very stable | Depends on provider |

---

## Discord Commands

### Account Management

| Command | Description |
|---------|-------------|
| `!create <email> <password>` | Create one account manually |
| `!createfull [count] [par] [batch] [pause]` | Batch create accounts |
| `!accounts` | List all accounts |
| `!delete <user\|all>` | Delete accounts |
| `!cleanup` | Remove accounts without cookies |

### Cookie & Ban Check

| Command | Description |
|---------|-------------|
| `!checkcookies [user\|all]` | Test/refresh cookies via real browser |
| `!checkbanned [user\|all] [par]` | Check if accounts are banned on Twitch |

### Follow

| Command | Description |
|---------|-------------|
| `!follow <channel> [user\|count]` | Follow a channel (one account or all) |
| `!checkfollow [user\|all]` | Check which accounts follow the channel |

### Watching & Drops

| Command | Description |
|---------|-------------|
| `!watch <user\|all>` | Start watching stream |
| `!stop` | Stop all watching |
| `!drops <user\|all>` | Claim available drops |
| `!resetdrops` | Clear drop skip timestamps |
| `!status` | Show full farm status |

### Viewer Bot

| Command | Description |
|---------|-------------|
| `!viewbot <channel> <count>` | Add viewers to a channel |
| `!stopviewbot` | Stop viewer bot |

### Utility

| Command | Description |
|---------|-------------|
| `!testproxy <url>` | Test if proxy is blocked by Kasada |
| `!help` | Show all commands |

---

## `!createfull` — Batch Account Creation

```
!createfull [count] [parallel] [batch] [pause]
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| count | Total accounts to create | 5 |
| parallel | Chrome windows at once (max 15) | 2 |
| batch | Accounts per batch | 5 |
| pause | Minutes between batches | 30 |

### Examples

```
!createfull 200 4 20 20
```
200 accounts, 4 Chrome windows, 20 per batch, 20 min pause — ~5 hours total

```
!createfull 100 4 20 15
```
100 accounts — ~2.5 hours

```
!createfull 50 2 10 10
```
50 accounts — ~1.5 hours (conservative)

### Safe Limits

- **Max parallel**: 4-5 (more risks Kasada detection)
- **Max per batch**: 20
- **Min pause**: 15 minutes

---

## Drop Farming — Step by Step

### Step 1: Create Accounts

```
!createfull 200 4 20 20
```

### Step 2: Follow the Drop Channel

```
!follow rocketleague all
```

### Step 3: Check Cookies

```
!checkcookies all
```

Bad cookies get refreshed automatically.

### Step 4: Start Watching

```
!watch all
```

Auto-rotation keeps accounts cycling — when one claims a drop it stops and the next idle account starts.

### Step 5: Claim Drops

```
!drops all
```

Run every 2-3 hours.

### Step 6: Check Status

```
!status
```

---

## Proxy

### Format (Smartproxy sticky session)

```
PROXY_URL=http://smart-user:pass@gate.smartproxy.com:10000
```

The `smart-` prefix keeps the same IP for the entire signup session (required — Kasada detects IP changes mid-session).

### Testing

```
!testproxy http://smart-user:pass@gate.smartproxy.com:10000
```

- **PASSED** → safe to use
- **BLOCKED** → wait 3 hours, test again

### Notes

- Your server IP often works without a proxy — only add one if Kasada blocks your IP
- Static ISP proxies are NOT supported (Kasada blocks them)
- Rotating proxies without sticky sessions will fail

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Kasada blocks signup | Wait 3 hours, test again with `!testproxy` |
| Cookies expired | Run `!checkcookies all` to refresh |
| Account banned | Run `!checkbanned all` to remove banned accounts |
| Drops not claiming | Make sure `!watch all` is running first |
| IMAP not reading codes | Use App Password, not your Google login password |
| Verification code not arriving | Check Gmail spam folder, ensure IMAP is enabled in Gmail settings |
| Signups fail after ~6 accounts | Gmail alias rate limit hit — see Known Limitations at the top |

---

## File Structure

```
win3000/
├── src/
│   ├── index.js            — Main entry point
│   ├── discordBot.js       — All Discord commands
│   ├── twitchBot.js        — Account creation (signup flow)
│   ├── watcher.js          — Stream watching + drop claiming
│   ├── viewerBot.js        — Viewer bot
│   ├── emailReader.js      — Gmail IMAP code reader
│   ├── mailTm.js           — Temp mail fallback (mail.tm)
│   ├── localProxy.js       — Local proxy handler
│   ├── state.js            — Account storage
│   ├── twitchApi.js        — Twitch API calls
│   ├── kpsdkFetcher.js     — KPSDK fingerprint fetcher
│   ├── proxyManager.js     — Proxy management
│   └── stealth/
│       ├── index.js        — Chrome stealth launcher (late-CDP)
│       ├── serverLauncher.js — Server/VPS launcher
│       └── fingerprint.js  — Browser fingerprint generator
├── data/                   — Account database (auto-created, not in git)
├── .env                    — Your credentials (not in git)
├── .env.example            — Template — copy this to .env
└── package.json
```