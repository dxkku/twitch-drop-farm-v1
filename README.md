# Twitch Drop Farm Bot

Automated Twitch account creator, stream watcher, and drop farmer with Kasada bypass.

---

## Features

- **Account Creation** — Bypasses Kasada anti-bot with real Chrome browser
- **Local Mail Server** — Built-in SMTP server for instant email verification (no Gmail rate limiting)
- **Email Verification** — Auto-reads verification codes via IMAP or local mail
- **Drop Claiming** — Automatically claims available Twitch drops
- **Stream Watching** — Watches rocketleague, follows channel, sends "hi" in chat
- **Auto-Rotation** — When one account stops, next idle takes its place
- **Batch Mode** — Create 100s of accounts with safe pacing
- **Discord Control** — All commands via Discord bot with embeds

---

## Setup Requirements

| Requirement | Where to get |
|------------|-------------|
| Discord bot token | https://discord.com/developers/applications |
| Twitch API keys | https://dev.twitch.tv/console/apps |
| Email domains | Cloudflare (recommended) or Namecheap |
| Gmail app password (optional) | https://myaccount.google.com/apppasswords |
| Proxy (optional) | Any HTTP proxy (test with `!testproxy` first) |

---

## Quick Start

1. Fill in `.env` with your credentials
2. Set up email domains (see Email Domains section)
3. Run the bot: `node src/index.js`
4. In Discord: `!createfull 200 4 20 20`
5. Wait ~5 hours for completion
6. Start farming: `!watch all`
7. Claim drops: `!drops all` (every 2-3 hours)

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
| `!checkcookies [user\|all]` | Test/refresh cookies via browser |
| `!checkbanned [user\|all] [par]` | Check if accounts are banned |

### Watching & Drops

| Command | Description |
|---------|-------------|
| `!watch <user\|all>` | Start watching rocketleague |
| `!stop` | Stop all watching |
| `!drops <user\|all>` | Claim available drops |
| `!resetdrops` | Clear drop skip timestamps |
| `!status` | Show full farm status |

### Viewer Bot

| Command | Description |
|---------|-------------|
| `!viewbot <channel> <count>` | Add viewers to channel |
| `!stopviewbot` | Stop viewer bot |

### Utility

| Command | Description |
|---------|-------------|
| `!testproxy <url>` | Test if proxy is blocked by Kasada |
| `!help` | Show all commands |

---

## `!createfull` — Batch Account Creation

### Usage

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
- 200 accounts, 4 Chrome windows, 20 per batch, 20 min pause
- Total time: ~5 hours
- Safe for Kasada and domains

```
!createfull 100 4 20 15
```
- 100 accounts, ~2.5 hours

```
!createfull 50 2 10 10
```
- 50 accounts, ~1.5 hours (conservative)

### Safe Limits

- **Max per batch**: 20
- **Min pause**: 15 minutes
- Going above these risks getting proxy/domain flagged

### What Happens During Batch

1. Opens Chrome windows (parallel count)
2. Each window creates one account at a time
3. After batch finishes → waits pause minutes
4. Repeats until all accounts created
5. Final embed shows all accounts with pagination buttons

### Crash Protection

- If one account fails, it skips to the next
- One crash does NOT stop the whole batch

---

## Email — Local Mail Server (Recommended)

Built-in SMTP server eliminates Gmail rate limiting entirely.

### How It Works

```
Cloudflare Email Routing → VPS (port 25) → Bot reads locally
```

1. Bot creates account with `user@yourdomain.com`
2. Twitch sends verification code to that email
3. Cloudflare forwards email to your VPS IP (port 25)
4. Local SMTP server receives and extracts the code
5. Bot reads code instantly from memory — zero rate limiting

### Setup

1. In `.env` set:
```
USE_LOCAL_MAIL=1
SMTP_PORT=25
```

2. In Cloudflare Email Routing:
   - Go to your domain → Email → Email Routing
   - Set Catch-All destination to `your-vps-ip:25`
   - Or create individual forwarding rules

3. Open port 25 on your VPS firewall (inbound TCP)

4. That's it — no Gmail needed, no rate limits, instant code delivery

### Benefits Over Gmail IMAP

| Feature | Gmail IMAP | Local Mail |
|---------|-----------|------------|
| Rate limiting | Yes (frequent disconnects) | None |
| Speed | 2-5 seconds | Instant |
| Parallel accounts | Limited (~5) | Unlimited |
| Dependencies | Gmail account + app password | None |
| Reliability | Can fail under load | 100% |

### Fallback to Gmail IMAP

If you prefer Gmail, set `USE_LOCAL_MAIL=0` (or leave it unset) and configure:
```
IMAP_HOST=imap.gmail.com
IMAP_USER=your-email@gmail.com
IMAP_PASS=your-app-password
```

---

### Before Using a Proxy

```
!testproxy http://user:pass@host:port
```

- **PASSED** → safe to use for signup
- **BLOCKED** → wait 3 hours → test again

### Important Notes

- Server IP works without proxy (no proxy needed for signup)
- Only use proxy if server IP gets flagged by Kasada
- Proxy-Cheap Static ISP is NOT supported (Kasada blocks it)
- Kasada blocks = wait 3 hours to unblock

---

## Drop Farming — Step by Step Workflow

### Step 1: Create Accounts

```
!createfull 200 4 20 20
```

Wait ~5 hours for completion.

### Step 2: Check Cookies

```
!checkcookies all
```

Accounts with bad cookies get refreshed automatically.

### Step 3: Check Bans

```
!checkbanned all
```

Only actually banned accounts are removed.

### Step 4: Start Watching

```
!watch all
```

All idle accounts start watching rocketleague. Auto-rotation keeps accounts cycling.

### Step 5: Claim Drops

```
!drops all
```

Run every 2-3 hours. Checks all accounts for available drops.

### Step 6: Check Status

```
!status
```

Shows how many watching, idle, errors, etc.

---

## Email Domains — How It Works

### The Process

1. Bot creates Twitch account with `email@yourdomain.com`
2. Twitch sends 6-digit verification code to that email
3. Your domain catches the email (catch-all forwarding)
4. Email forwards to your Gmail automatically
5. Bot reads code from Gmail via IMAP
6. Bot enters code → account verified → cookies saved

This all happens automatically — no manual work needed.

### Domain Rotation

The bot rotates between domains evenly:

```
Account 1 → mysite.com
Account 2 → mygame.net
Account 3 → gamemail.org
Account 4 → mysite.com
Account 5 → mygame.net
...and so on
```

---

## Email Domains — Cloudflare (Recommended)

Cloudflare is the **BEST** option for email forwarding:

- ✓ Easiest setup (5 minutes)
- ✓ Free Email Routing feature
- ✓ Clean dashboard, easy to manage
- ✓ Reliable — emails always arrive
- ✓ No limit on catch-all forwarding
- ✗ Domain costs ~$8-12/year (but worth it)

### Step-by-Step Setup

#### Step 1: Buy or Transfer a Domain

1. Go to https://dash.cloudflare.com
2. Click "Register Domain" or "Transfer Domain"
3. Buy a cheap .com domain (~$8-10/year)
4. Domain is ready in ~5 minutes

#### Step 2: Enable Email Routing

1. In Cloudflare dashboard → select your domain
2. Go to "Email" → "Email Routing"
3. Click "Enable Email Routing"
4. Cloudflare will set up MX records automatically

#### Step 3: Create Catch-All Rule

1. In Email Routing → go to "Catch-All Address"
2. Click "Create Catch-All Address"
3. Set destination to your Gmail address
4. Enable the rule

#### Step 4: Add Domain to .env

```
DOMAIN=yourdomain.com
```

Done! All emails to `any@yourdomain.com` → your Gmail.

---

## Why Use Multiple Domains

Using **2-4 domains** is STRONGLY recommended:

- More domains = less risk of getting flagged
- If one domain gets blacklisted, others still work
- Bot rotates between domains evenly
- Twitch can't pattern-match if you use diverse domains

### Example Setup (3 Domains)

```
DOMAIN=mysite.com,mygame.net,gamemail.org
```

### If a Domain Gets Flagged

1. Remove it from DOMAIN line
2. Replace with a new domain
3. Set up Cloudflare Email Routing again
4. Continue farming

---

## Email Domains — Other Options

Cloudflare is recommended, but other options exist:

### Namecheap (~$1-2/year for .xyz domains)

- Free email forwarding
- "Forward email" feature in domain settings
- Set catch-all to forward to your Gmail
- Cheaper but slightly more setup

### ForwardEmail (Free Service)

- Free email forwarding for any domain
- Need to add DNS records manually
- Good for existing domains without email

### Proton Mail (Paid)

- Custom domain support
- More private but complex setup

> **NOTE**: All options must support catch-all email forwarding.
> If your domain doesn't have catch-all, it won't work.
> Cloudflare has the simplest catch-all setup.

---

## Email Domains — Important Rules

1. Each domain **MUST** have catch-all forwarding enabled
2. All emails **MUST** forward to your Gmail (`IMAP_USER`)
3. Bot rotates between domains evenly
4. If a domain gets flagged → replace it immediately
5. Use 2-4 domains for best results
6. Never use more than 4 domains (overkill)
7. Each domain should look different (no similar names)
8. Use .com domains when possible (most trusted by Twitch)

---

## Configuration (.env)

```env
PORT=6767
API_KEY=your-secret-api-key-change-me

# Email domains (rotates evenly)
DOMAIN=yourdomain1.com,yourdomain2.com

# Discord bot
DISCORD_BOT_TOKEN=

# Local Mail Server (RECOMMENDED)
USE_LOCAL_MAIL=1
SMTP_PORT=25

# Gmail IMAP (optional — only if USE_LOCAL_MAIL=0)
# IMAP_USER=your-email@gmail.com
# IMAP_PASS=xxxx-xxxx-xxxx-xxxx

# Twitch API (for drop claiming)
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_REDIRECT_URI=http://YOUR_IP:6767/api/twitch/callback

# Proxy (optional — server IP works without)
# PROXY_URL=http://user:pass@host:port
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Proxy blocked by Kasada | Wait 3 hours, test again with `!testproxy` |
| Cookies expired | Run `!checkcookies all` to refresh |
| Account banned | Run `!checkbanned all` to remove |
| Drops not claiming | Make sure `!watch all` is running |
| IMAP not reading codes | Check Gmail app password, not regular password |
| Domain not receiving emails | Check Cloudflare Email Routing is enabled |

---

## File Structure

```
win2000/
├── src/
│   ├── index.js          — Main server + API
│   ├── discordBot.js     — Discord commands
│   ├── twitchBot.js      — Account creation (signup)
│   ├── watcher.js        — Stream watching + drops
│   ├── viewerBot.js      — Viewer bot
│   ├── emailReader.js    — Email reading (IMAP + local mail)
│   ├── localMail.js      — Built-in SMTP server (no Gmail needed)
│   ├── localProxy.js     — Local proxy handler
│   ├── state.js          — Account storage
│   ├── twitchApi.js      — Twitch API calls
│   ├── kpsdkFetcher.js   — KPSDK fingerprint fetcher
│   └── proxyManager.js   — Proxy management
├── extension/
│   ├── inject.js         — Chrome extension inject
│   └── content.js        — Content script
├── emails/               — Saved emails (auto-created)
├── .env                  — Configuration (fill this)
├── accounts.json         — Account data (auto-created)
└── package.json
```
