'use strict';

// Chrome builds — covers the realistic install base as of 2025-2026.
// Keep a spread of the last ~20 versions so the distribution looks like
// real users who update at different cadences.
const CHROME_BUILDS = [
  { full: '128.0.6613.120', major: '128' },
  { full: '129.0.6668.103', major: '129' },
  { full: '130.0.6723.117', major: '130' },
  { full: '131.0.6778.205', major: '131' },
  { full: '132.0.6834.160', major: '132' },
  { full: '133.0.6943.141', major: '133' },
  { full: '134.0.6998.117', major: '134' },
  { full: '135.0.7049.119', major: '135' },
  { full: '136.0.7103.113', major: '136' },
  { full: '137.0.7151.122', major: '137' },
  { full: '138.0.7204.100', major: '138' },
  { full: '139.0.7258.100', major: '139' },
  { full: '140.0.7296.79',  major: '140' },
  { full: '141.0.7345.86',  major: '141' },
  { full: '142.0.7395.57',  major: '142' },
  { full: '143.0.7428.112', major: '143' },
  { full: '144.0.7467.89',  major: '144' },
  { full: '145.0.7520.101', major: '145' },
  { full: '146.0.7567.83',  major: '146' },
  { full: '147.0.7614.71',  major: '147' },
  { full: '148.0.7659.54',  major: '148' },
];

// OS profiles — grouped by platform so we only pick profiles that match the
// actual OS running this process. Mixing OS profiles causes UA/platform
// mismatches that Kasada detects immediately (e.g. Win32 platform + Mac UA).
const OS_PROFILES = {
  win32: [
    // Windows 10 — by far the most common Twitch OS
    { os: 'Windows NT 10.0; Win64; x64', platform: 'Win32', secChUaPlatform: '"Windows"' },
    { os: 'Windows NT 10.0; Win64; x64', platform: 'Win32', secChUaPlatform: '"Windows"' },
    { os: 'Windows NT 10.0; Win64; x64', platform: 'Win32', secChUaPlatform: '"Windows"' },
    // Windows 11 shares the same NT 10.0 UA string; only sec-ch-ua-platform-version differs
    { os: 'Windows NT 10.0; Win64; x64', platform: 'Win32', secChUaPlatform: '"Windows"' },
    { os: 'Windows NT 10.0; Win64; x64', platform: 'Win32', secChUaPlatform: '"Windows"' },
  ],
  darwin: [
    { os: 'Macintosh; Intel Mac OS X 12_7_4', platform: 'MacIntel', secChUaPlatform: '"macOS"' },
    { os: 'Macintosh; Intel Mac OS X 13_6_7', platform: 'MacIntel', secChUaPlatform: '"macOS"' },
    { os: 'Macintosh; Intel Mac OS X 14_6_1', platform: 'MacIntel', secChUaPlatform: '"macOS"' },
    { os: 'Macintosh; Intel Mac OS X 15_1',   platform: 'MacIntel', secChUaPlatform: '"macOS"' },
  ],
  linux: [
    { os: 'X11; Linux x86_64',            platform: 'Linux x86_64', secChUaPlatform: '"Linux"' },
    { os: 'X11; CrOS x86_64 15117.111.0', platform: 'Linux x86_64', secChUaPlatform: '"Chrome OS"' },
  ],
};

const SCREEN_SIZES = [
  { width: 1920, height: 1080, avail: 1040 },
  { width: 1920, height: 1080, avail: 1050 },
  { width: 1920, height: 1200, avail: 1160 },
  { width: 2560, height: 1440, avail: 1400 },
  { width: 2560, height: 1440, avail: 1415 },
  { width: 2560, height: 1600, avail: 1560 },
  { width: 1680, height: 1050, avail: 1010 },
  { width: 1440, height: 900,  avail: 860  },
  { width: 1536, height: 864,  avail: 824  },
  { width: 1366, height: 768,  avail: 728  },
  { width: 1280, height: 1024, avail: 984  },
  { width: 1280, height: 800,  avail: 750  },
  { width: 2160, height: 1440, avail: 1400 },
  { width: 3840, height: 2160, avail: 2120 },
  { width: 1600, height: 900,  avail: 860  },
];

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Phoenix', 'America/Toronto',
  'America/Vancouver', 'America/Detroit', 'America/Indianapolis',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Warsaw', 'Europe/Stockholm',
  'America/Sao_Paulo', 'America/Bogota', 'America/Mexico_City',
  'America/Buenos_Aires', 'America/Lima',
  'Australia/Sydney', 'Australia/Melbourne',
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Dubai',
];

// English-heavy (Twitch audience) with some international variety
const LANGUAGE_SETS = [
  ['en-US', 'en'],
  ['en-US', 'en'],
  ['en-US', 'en'],
  ['en-US', 'en', 'en-GB'],
  ['en-US', 'en', 'fr'],
  ['en-GB', 'en'],
  ['en-CA', 'en', 'en-US'],
  ['en-AU', 'en', 'en-US'],
  ['fr-FR', 'fr', 'en-US', 'en'],
  ['de-DE', 'de', 'en-US', 'en'],
  ['es-ES', 'es', 'en-US', 'en'],
  ['es-MX', 'es', 'en-US', 'en'],
  ['pt-BR', 'pt', 'en-US', 'en'],
  ['tr-TR', 'tr', 'en-US', 'en'],
  ['ru-RU', 'ru', 'en'],
  ['pl-PL', 'pl', 'en-US', 'en'],
  ['ko-KR', 'ko', 'en-US', 'en'],
  ['ja-JP', 'ja', 'en-US', 'en'],
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Pick profiles that match the actual OS so UA and navigator.platform are consistent
const HOST_OS   = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const PROFILE_POOL = OS_PROFILES[HOST_OS] || OS_PROFILES.win32;

// Chrome's "GREASE" not-brand token — rotates per major version.
// This mimics the actual Chrome source: each slot maps to a different
// punctuation character chosen from a fixed list so it looks machine-generated.
const NOT_BRAND_TOKENS = [
  '"Not/A)Brand";v="8"',
  '"Not A;Brand";v="99"',
  '"Not_A Brand";v="8"',
  '"Not?A_Brand";v="24"',
  '"Not)A;Brand";v="99"',
  '"Not A(Brand";v="8"',
  '"NotA=Brand";v="24"',
  '"Not:A;Brand";v="99"',
];

function notBrand(major) {
  return NOT_BRAND_TOKENS[parseInt(major) % NOT_BRAND_TOKENS.length];
}

function generateFingerprint(realChrome) {
  // If the real installed Chrome version was detected, use it exactly.
  // Otherwise fall back to picking from the CHROME_BUILDS list.
  const chrome  = realChrome || pick(CHROME_BUILDS);
  const profile = pick(PROFILE_POOL);
  const screen  = pick(SCREEN_SIZES);
  const tz      = pick(TIMEZONES);
  const langs   = pick(LANGUAGE_SETS);
  const cores   = pick([4, 6, 8, 10, 12, 16, 20, 24]);
  const mem     = pick([4, 8, 16, 32]);

  const ua = `Mozilla/5.0 (${profile.os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.full} Safari/537.36`;

  // Real Chrome sends the "Not" brand first, then Chromium, then Google Chrome
  const secChUa = `${notBrand(chrome.major)}, "Chromium";v="${chrome.major}", "Google Chrome";v="${chrome.major}"`;

  // Accept-Language value built from the language set
  // First lang is q=1 (implicit), rest get descending q values
  const acceptLang = langs
    .map((l, i) => i === 0 ? l : `${l};q=${(1 - i * 0.1).toFixed(1)}`)
    .join(', ');

  return {
    userAgent: ua,
    platform: profile.platform,
    screen,
    chromeVersion: chrome,
    languages: langs,
    acceptLanguage: acceptLang,
    timezone: tz,
    hardwareConcurrency: cores,
    deviceMemory: mem,
    vendor: 'Google Inc.',
    secChUa,
    secChUaPlatform: profile.secChUaPlatform,
    secChUaMobile: '?0',
  };
}

// Patch an existing fingerprint with the real Chrome version detected at runtime.
// Called after DevTools reports the actual installed version.
function patchFp(fp, realChrome) {
  if (!realChrome || !fp) return;
  const profile = fp.userAgent.match(/\(([^)]+)\)/)?.[1] || 'Windows NT 10.0; Win64; x64';
  fp.userAgent     = `Mozilla/5.0 (${profile}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${realChrome.full} Safari/537.36`;
  fp.secChUa       = `${notBrand(realChrome.major)}, "Chromium";v="${realChrome.major}", "Google Chrome";v="${realChrome.major}"`;
  fp.chromeVersion = realChrome;
}

module.exports = { generateFingerprint, patchFp };
