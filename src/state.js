const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

const accounts = {};
const twitchSessions = {};

// Load accounts from disk on startup
function loadAccounts() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      console.log('accounts.json not found — creating empty file');
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ACCOUNTS_FILE, '{}');
    }
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    for (const [key, val] of Object.entries(data)) {
      accounts[key] = val;
    }
    console.log(`Loaded ${Object.keys(accounts).length} accounts from disk`);
  } catch (e) {
    console.error('Failed to load accounts:', e.message);
  }
}

// Save accounts to disk
function saveAccounts() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  } catch (e) {
    console.error('Failed to save accounts:', e.message);
  }
}

// Find account by Twitch username (case-insensitive)
function findByUsername(username) {
  if (!username) return null;
  const lower = username.toLowerCase();
  return Object.values(accounts).find(a => {
    const u = a.twitchData?.username || a.twitchData?.twitchUsername;
    return u && u.toLowerCase() === lower;
  }) || null;
}

// Get all accounts with Twitch linked
function getLinkedAccounts() {
  return Object.values(accounts).filter(a => a.twitchLinked && a.twitchData?.username);
}

// Load on require
loadAccounts();

module.exports = { accounts, twitchSessions, saveAccounts, loadAccounts, findByUsername, getLinkedAccounts };
