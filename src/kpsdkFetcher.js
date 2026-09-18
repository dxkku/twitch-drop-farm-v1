/**
 * kpsdkFetcher.js — Re-fetch KPSDK fp endpoint via rotating proxies
 *
 * When the browser gets a 429 from k.twitchcdn.net/.../fp, we re-fetch
 * the same URL from Node.js using a different residential proxy IP.
 * The clean 200 response body is then injected back into the browser
 * via CDP Fetch.fulfillRequest so KPSDK gets valid challenge data.
 */

const proxyManager = require('./proxyManager');
const { HttpsProxyAgent } = require('https-proxy-agent');

const MAX_PROXY_ATTEMPTS = 5;
const FETCH_TIMEOUT_MS = 15000;

/**
 * Fetch the KPSDK fp URL from a clean proxy IP.
 * Tries multiple rotating IPs until one returns 200.
 *
 * @param {string} url - The full fp URL (e.g. https://k.twitchcdn.net/[uuid]/1.2.490/fp?x-kpsdk-v=j-1.2.490)
 * @param {object} browserHeaders - Headers from the browser's original request (to match fingerprint)
 * @returns {Promise<{status: number, headers: object, body: string, base64Body: string, proxyAttempt: number}|null>}
 */
async function fetchFpFromProxy(url, browserHeaders) {
  // Build headers that match what the browser would send
  const headers = {
    'Accept': browserHeaders['accept'] || '*/*',
    'Accept-Language': browserHeaders['accept-language'] || 'en-US,en;q=0.9',
    'Accept-Encoding': browserHeaders['accept-encoding'] || 'gzip, deflate, br',
    'User-Agent': browserHeaders['user-agent'] || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'Referer': browserHeaders['referer'] || 'https://www.twitch.tv/',
    'Origin': browserHeaders['origin'] || 'https://www.twitch.tv',
    'Sec-Fetch-Dest': browserHeaders['sec-fetch-dest'] || 'script',
    'Sec-Fetch-Mode': browserHeaders['sec-fetch-mode'] || 'cors',
    'Sec-Fetch-Site': browserHeaders['sec-fetch-site'] || 'cross-site',
  };

  // Copy any x-kpsdk-* headers from the original request
  for (const [key, value] of Object.entries(browserHeaders)) {
    if (key.startsWith('x-kpsdk')) {
      headers[key] = value;
    }
  }

  for (let attempt = 1; attempt <= MAX_PROXY_ATTEMPTS; attempt++) {
    try {
      const agent = proxyManager.getRandomRotatingAgent();
      if (!agent) {
        console.log(`DEBUG [kpsdkFetcher] No proxy agent available, attempt ${attempt}`);
        // Try direct (no proxy) as last resort
        if (attempt === MAX_PROXY_ATTEMPTS) {
          return await fetchDirect(url, headers, attempt);
        }
        continue;
      }

      console.log(`DEBUG [kpsdkFetcher] Attempting fp fetch via rotating proxy, attempt ${attempt}/${MAX_PROXY_ATTEMPTS}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const resp = await fetch(url, {
        method: 'GET',
        headers,
        agent,
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeout);

      const bodyBuffer = await resp.arrayBuffer();
      const bodyText = Buffer.from(bodyBuffer).toString('utf-8');
      const base64Body = Buffer.from(bodyBuffer).toString('base64');

      console.log(`DEBUG [kpsdkFetcher] Attempt ${attempt}: status=${resp.status}, bodyLen=${bodyText.length}`);

      if (resp.status === 200) {
        console.log(`DEBUG [kpsdkFetcher] SUCCESS — got 200 from proxy on attempt ${attempt}`);
        // Convert response headers to a plain object
        const respHeaders = {};
        resp.headers.forEach((value, key) => {
          respHeaders[key] = value;
        });
        return {
          status: 200,
          headers: respHeaders,
          body: bodyText,
          base64Body,
          proxyAttempt: attempt,
        };
      }

      if (resp.status === 429) {
        console.log(`DEBUG [kpsdkFetcher] Attempt ${attempt} got 429, trying next IP...`);
        continue;
      }

      // Other status (403, 503, etc.) — log and continue
      console.log(`DEBUG [kpsdkFetcher] Attempt ${attempt} got unexpected status ${resp.status}`);
    } catch (err) {
      console.log(`DEBUG [kpsdkFetcher] Attempt ${attempt} error: ${err.message}`);
    }
  }

  // All proxy attempts failed — try direct as absolute last resort
  console.log(`DEBUG [kpsdkFetcher] All ${MAX_PROXY_ATTEMPTS} proxy attempts failed, trying direct...`);
  return await fetchDirect(url, headers, MAX_PROXY_ATTEMPTS + 1);
}

/**
 * Direct fetch without proxy (last resort).
 */
async function fetchDirect(url, headers, attempt) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const resp = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    const bodyBuffer = await resp.arrayBuffer();
    const bodyText = Buffer.from(bodyBuffer).toString('utf-8');
    const base64Body = Buffer.from(bodyBuffer).toString('base64');

    console.log(`DEBUG [kpsdkFetcher] Direct fetch: status=${resp.status}, bodyLen=${bodyText.length}`);

    if (resp.status === 200) {
      const respHeaders = {};
      resp.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });
      return {
        status: 200,
        headers: respHeaders,
        body: bodyText,
        base64Body,
        proxyAttempt: attempt,
      };
    }

    return null;
  } catch (err) {
    console.log(`DEBUG [kpsdkFetcher] Direct fetch error: ${err.message}`);
    return null;
  }
}

/**
 * Test whether any proxy IP can reach the fp endpoint with a 200.
 * Used by the diagnostic !testfp command.
 *
 * @param {string} [testUrl] - Optional fp URL to test. Uses a generic one if not provided.
 * @returns {Promise<{results: Array, anySuccess: boolean}>}
 */
async function testFpEndpoint(testUrl) {
  // Use a known fp URL pattern — the UUID changes per-site but the path structure is stable
  const url = testUrl || 'https://k.twitchcdn.net/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/fp';
  const results = [];

  const headers = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'Referer': 'https://www.twitch.tv/',
    'Origin': 'https://www.twitch.tv',
  };

  // Test rotating proxy IPs
  for (let i = 0; i < 5; i++) {
    try {
      const agent = proxyManager.getRandomRotatingAgent();
      const label = agent ? `proxy-${i + 1}` : `direct-${i + 1}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const resp = await fetch(url, {
        method: 'GET',
        headers,
        agent: agent || undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      results.push({ attempt: label, status: resp.status, ok: resp.status === 200 });
    } catch (err) {
      results.push({ attempt: `proxy-${i + 1}`, status: 'error', error: err.message, ok: false });
    }
  }

  // Also test direct (no proxy)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeout);
    results.push({ attempt: 'direct', status: resp.status, ok: resp.status === 200 });
  } catch (err) {
    results.push({ attempt: 'direct', status: 'error', error: err.message, ok: false });
  }

  return {
    results,
    anySuccess: results.some(r => r.ok),
  };
}

module.exports = { testFpEndpoint };
