const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

const PROXY_URL = process.env.PROXY_URL || null;
const KPSDK_PROXY_URL = process.env.KPSDK_PROXY_URL || PROXY_URL;

/**
 * Parse a proxy URL into components.
 * Expected format: http://user:pass@host:port
 */
function parseProxy(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      host: parsed.hostname,
      port: parseInt(parsed.port) || 3120,
      protocol: parsed.protocol,
    };
  } catch (e) {
    console.error('proxyManager: failed to parse proxy URL:', e.message);
    return null;
  }
}

/**
 * Build a proxy URL from components, optionally with modifications.
 */
function buildProxyUrl(parsed, overrides = {}) {
  const user = overrides.username || parsed.username;
  const pass = overrides.password || parsed.password;
  const host = overrides.host || parsed.host;
  const port = overrides.port || parsed.port;
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

/**
 * Get the browser proxy URL (sticky session for consistent IP during signup).
 * Uses the PROXY_URL from .env as-is (which has `smart-` prefix for Smartproxy sticky sessions).
 */
function getBrowserProxyUrl() {
  return PROXY_URL;
}

/**
 * Get a rotating proxy URL for KPSDK fp endpoint.
 * Smartproxy: remove `smart-` prefix from username to get rotating IPs.
 * This gives a different IP per request, increasing chances of a non-rate-limited response.
 */
function getRotatingProxyUrl() {
  if (!KPSDK_PROXY_URL) return null;
  const parsed = parseProxy(KPSDK_PROXY_URL);
  if (!parsed) return null;

  // Smartproxy convention: `smart-` prefix = sticky session, without = rotating
  let rotatingUser = parsed.username;
  if (rotatingUser.startsWith('smart-')) {
    rotatingUser = rotatingUser.replace(/^smart-/, '');
  }

  return buildProxyUrl(parsed, { username: rotatingUser });
}

/**
 * Get an HTTPS proxy agent for the KPSDK fp interception.
 * Uses rotating proxy to get clean IPs.
 */
function getKpsdkAgent() {
  const url = getRotatingProxyUrl();
  if (!url) return null;
  return new HttpsProxyAgent(url);
}

/**
 * Get an HTTP proxy agent for non-TLS requests.
 */
function getKpsdkHttpAgent() {
  const url = getRotatingProxyUrl();
  if (!url) return null;
  return new HttpProxyAgent(url);
}

/**
 * Get proxy agents for a generic Node.js fetch call.
 * Returns { httpAgent, httpsAgent } or null if no proxy.
 */
function getFetchAgents() {
  const url = getRotatingProxyUrl();
  if (!url) return null;
  return {
    httpAgent: new HttpProxyAgent(url),
    httpsAgent: new HttpsProxyAgent(url),
  };
}

/**
 * Get a rotating proxy URL with a unique session ID.
 * Smartproxy: appending `-session-XXXX` to the username forces a new IP per connection.
 * Each call generates a different session ID, guaranteeing a fresh IP.
 */
function getRandomRotatingProxyUrl() {
  if (!KPSDK_PROXY_URL) return null;
  const parsed = parseProxy(KPSDK_PROXY_URL);
  if (!parsed) return null;

  // Remove `smart-` prefix and append a random session ID
  let user = parsed.username;
  if (user.startsWith('smart-')) {
    user = user.replace(/^smart-/, '');
  }
  // Remove any existing session suffix
  user = user.replace(/-session-\w+$/, '');
  // Add fresh session ID
  const sessionId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  user = `${user}-session-${sessionId}`;

  return buildProxyUrl(parsed, { username: user });
}

/**
 * Get an HTTPS proxy agent with a unique session ID (fresh IP per call).
 * Used by kpsdkFetcher to try multiple different IPs.
 */
function getRandomRotatingAgent() {
  const url = getRandomRotatingProxyUrl();
  if (!url) return null;
  return new HttpsProxyAgent(url);
}

module.exports = {
  parseProxy,
  getRotatingProxyUrl,
  getRandomRotatingProxyUrl,
  getRandomRotatingAgent,
};
