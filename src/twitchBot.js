const { spawn } = require('child_process');
const path = require('path');
const os   = require('os');
const emailReader = require('./emailReader');
const mailTm = require('./mailTm');
const { startLocalProxy, resetLocalProxy } = require('./localProxy');
const kpsdkFetcher = require('./kpsdkFetcher');

// Auto-detect server environments:
//  - Linux: always server (Linux desktops are rare for this use case)
//  - Windows Server: detected via os.version() containing "Server"
//  - Windows desktop: regular mode
//  - SERVER_MODE=1 in .env: manual override
const IS_SERVER = process.env.SERVER_MODE === '1' ||
  process.platform === 'linux' ||
  (process.platform === 'win32' && /server/i.test(os.version()));
console.log(`DEBUG [twitchBot] OS: ${os.version()} → ${IS_SERVER ? 'SERVER mode' : 'DESKTOP mode'}`);

const DOMAIN = process.env.DOMAIN || 'yourdomain.com';
const IMAP_ENABLED = process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS;
const USE_MAILTM = process.env.USE_MAILTM === '1';
const PROXY_URL = process.env.PROXY_URL || null;

function getSignupProxyMode() {
  return (PROXY_URL && !process.env.NO_SIGNUP_PROXY) ? 'proxy' : 'direct';
}

// User-Agent will be derived from the actual Chrome binary at runtime
// to avoid version mismatches that trigger 'browser not supported'.

function randomString(length, chars) {
  chars = chars || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function generateUsername() {
  const vowels = 'aeiou';
  const consonants = 'bcdfghjklmnpqrstvwxyz';
  const prefixes = ['x', 'ii', 'o', 'II', 'X', 'v2', ''];
  const seps = ['_', ''];
  const suffixes = ['TV', 'HD', 'GG', 'TTV', ''];

  function randomName() {
    const len = Math.floor(Math.random() * 22) + 4;
    let name = '';
    for (let i = 0; i < len; i++) {
      if (i === 0) {
        name += consonants[Math.floor(Math.random() * consonants.length)];
      } else if (vowels.includes(name[i - 1])) {
        name += consonants[Math.floor(Math.random() * consonants.length)];
      } else {
        name += vowels[Math.floor(Math.random() * vowels.length)];
      }
    }
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  const name = randomName();
  const prefix = Math.random() > 0.5 ? prefixes[Math.floor(Math.random() * prefixes.length)] : '';
  const suffix = Math.random() > 0.85 ? suffixes[Math.floor(Math.random() * suffixes.length)] : '';
  const num = Math.random() > 0.4 ? Math.floor(Math.random() * 9999 + 1) : '';
  const sep = seps[Math.floor(Math.random() * seps.length)];

  let result = prefix + name + sep + suffix + num;
  if (result.length > 25) result = prefix + name.slice(0, 10) + num;
  return result;
}
let domainCounter = 0;
function generateImapEmail() {
  const imapUser = process.env.IMAP_USER || '';
  const isGmail = imapUser.includes('@gmail.com');

  if (isGmail) {
    const baseEmail = imapUser.split('@')[0];
    const alias = randomString(10);
    const email = baseEmail + '+' + alias + '@gmail.com';
    domainCounter++;
    return { email, domain: 'gmail.com' };
  }

  const domains = DOMAIN.split(',').map(d => d.trim()).filter(Boolean);
  const domain = domains[domainCounter % domains.length];
  domainCounter++;
  return { email: randomString(10) + '@' + domain, domain };
}
function randomBirthday() {
  const y = Math.floor(Math.random() * (2005 - 1990) + 1990);
  // IMPORTANT: values must NOT be zero-padded. Twitch selects use '7' not '07'.
  return { month: String(Math.floor(Math.random() * 12) + 1), day: String(Math.floor(Math.random() * 28) + 1), year: String(y) };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }



async function puppeteerModeSignup(password) {
  const puppeteer = require('puppeteer');
  const username = generateUsername();
  const dob = randomBirthday();

  // Email setup — mail.tm or IMAP
  let emailDomain = null;
  let twitchEmail = null;
  let mailTmAccount = null;
  let emailPromise = null;

  if (USE_MAILTM) {
    mailTmAccount = await mailTm.createAccount();
    twitchEmail = mailTmAccount.address;
    emailDomain = mailTmAccount.domain;
    console.log(`DEBUG [signup] Using mail.tm: ${twitchEmail}`);
    // Start polling for verification code in background
    emailPromise = mailTm.waitForCode(mailTmAccount.address, mailTmAccount.password, 120000);
  } else if (IMAP_ENABLED) {
    const emailData = generateImapEmail();
    emailDomain = emailData?.domain || null;
    const inbox = emailData ? await emailReader.createInbox(emailData.email) : null;
    twitchEmail = inbox?.address || null;
    console.log(`DEBUG [signup] Using IMAP: ${twitchEmail}`);
    // Start IMAP polling in background — catch errors so bot doesn't crash
    emailPromise = emailReader.waitForCode({ address: twitchEmail, type: 'imap', since: Date.now() }, 180000).catch(e => {
      console.log(`DEBUG [signup] IMAP poll error: ${e.message}`);
      return null;
    });
  }

  const displayNum = Math.floor(Math.random() * 200 + 100);
  const display = ':' + displayNum;
  const tmpDir = path.join(__dirname, '../tmp_profiles/profile_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
  const userDataDir = tmpDir;
  try { require('fs').mkdirSync(path.join(__dirname, '../tmp_profiles'), { recursive: true }); } catch(e) {}

  let browser = null;
  let page = null;

  try {
    // Shared proxy — all parallel accounts use same port
    let proxyPort = null;
    if (PROXY_URL && !process.env.NO_SIGNUP_PROXY) {
      proxyPort = await startLocalProxy();
      console.log('DEBUG [createTwitchAccount] using proxy via local port', proxyPort);
    } else {
      console.log('DEBUG [createTwitchAccount] direct mode (no proxy)');
    }

    // Launch Chrome clean (no CDP) → KPSDK runs challenge undetected → then connect CDP
    const stealthLauncher = IS_SERVER
      ? require('./stealth/serverLauncher.js')
      : require('./stealth/index.js');
    console.log(`DEBUG [createTwitchAccount] launching with stealth module (${IS_SERVER ? 'server' : 'desktop'} mode)`);
    const { browser: _browser, page: _page, fingerprint, chromeProc } = await stealthLauncher.launch({
      proxyPort:   proxyPort || undefined,
      userDataDir,
      kpsdkDelay:  12000,  // 12s for KPSDK to complete its challenge clean
    });
    browser = _browser;
    page    = _page;

    // Chrome already navigated to twitch.tv during launch — wait for it to settle
    console.log('DEBUG waiting for twitch.tv to fully settle after late-CDP connect...');
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
    await sleep(500);

    // Patch chrome.runtime — Chrome 153 with CDP may leave window.chrome.runtime
    // undefined on regular pages. KPSDK checks for it at submit time and may flag
    // its absence as a sign of automation.
    await page.evaluate(() => {
      try {
        if (window.chrome && !window.chrome.runtime) {
          Object.defineProperty(window.chrome, 'runtime', {
            value: {
              id: undefined,
              connect: () => ({}),
              sendMessage: () => {},
              onMessage: { addListener: () => {}, removeListener: () => {} },
              onConnect:  { addListener: () => {}, removeListener: () => {} },
              getURL: (p) => 'chrome-extension://' + p,
            },
            writable: true,
            configurable: true,
          });
        }
      } catch(e) {}
    }).catch(() => {});
    
    // Accept cookie consent banner if present — CRITICAL for Kasada!
    // If cookies aren't accepted, KPSDK can't set its tracking cookies → invalid tokens → 5025
    try {
      const cookieAccepted = await page.evaluate(() => {
        // Look for cookie consent accept buttons
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent.trim().toLowerCase();
          if (text === 'accept' || text === 'accepter' || text === 'aceptar' || 
              text === 'akzeptieren' || text === 'aceitar' || text === 'kabul et' ||
              text === 'قبول' || text === '接受') {
            btn.click();
            return text;
          }
        }
        return null;
      });
      if (cookieAccepted) {
        console.log('DEBUG accepted cookie banner:', cookieAccepted);
        await sleep(300);
      }
    } catch(e) {}
    
    // ── Debug probe: check what automation signals are still visible after patches ──
    const automationProbe = await page.evaluate(() => {
      const signals = {};
      signals.webdriver         = navigator.webdriver;
      signals.webdriverType     = typeof navigator.webdriver;
      signals.pluginCount       = navigator.plugins.length;
      signals.chromeExists      = !!window.chrome;
      signals.chromeRuntime     = !!(window.chrome && window.chrome.runtime);
      signals.cdcProps          = Object.getOwnPropertyNames(window).filter(k => k.startsWith('cdc_'));
      signals.phantomjs         = !!(window.callPhantom || window._phantom);
      signals.buffer            = typeof window.Buffer !== 'undefined';
      signals.outerWidth        = window.outerWidth;
      signals.outerHeight       = window.outerHeight;
      signals.innerWidth        = window.innerWidth;
      signals.innerHeight       = window.innerHeight;
      signals.screenWidth       = screen.width;
      signals.screenHeight      = screen.height;
      signals.languages         = navigator.languages;
      signals.platform          = navigator.platform;
      signals.vendor            = navigator.vendor;
      signals.hardwareConcurrency = navigator.hardwareConcurrency;
      signals.deviceMemory      = navigator.deviceMemory;
      signals.ua                = navigator.userAgent.slice(0, 80);
      return signals;
    }).catch(e => ({ error: e.message }));
    console.log('DEBUG [automation-probe]', JSON.stringify(automationProbe, null, 2));

    // No warmup needed — KPSDK already ran during the pre-CDP delay in stealth launcher

    // Open Signup Modal naturally
    console.log('DEBUG clicking Sign Up button on main page...');
    const topSignUpBtn = await page.$('[data-a-target="signup-button"]');
    if (topSignUpBtn) {
      await topSignUpBtn.click();
      console.log('DEBUG opened signup modal');
    } else {
      console.log('DEBUG WARNING: Top signup button not found, navigating manually');
      await page.goto('https://www.twitch.tv/signup', { waitUntil: 'load', timeout: 90000 });
    }

    await sleep(500);

    const dom = {
      type: async (sel, val) => {
        await page.type(sel, val);
        await sleep(100);
      },
      click: (sel) => page.click(sel),
      select: async (idx, val) => {
        const selects = await page.$$('select');
        if (selects[idx]) { await selects[idx].select(val); await sleep(100); }
      },
      info: () => page.evaluate(() => ({
        url: location.href,
        bodyText: (document.body ? document.body.innerText : '').slice(0, 800),
        inputs: Array.from(document.querySelectorAll('input')).map(i => ({ id: i.id, type: i.type, val: i.value.slice(0, 10) })),
      })),
    };

    let info = await dom.info();
    console.log('DEBUG initial inputs:', JSON.stringify(info.inputs));
    
    // Only click toggle if it's currently asking for a phone number
    if (info.inputs.some(i => i.type === 'tel')) {
      const mailToggleButton = await page.$('[data-a-target="signup-phone-email-toggle"]');
      if (mailToggleButton) {
        console.log('DEBUG Clicking use email instead toggle...');
        await mailToggleButton.click();
        await sleep(500);
      }
    }

    // ===== Multi-step signup: email first =====
    // Wait for the email input to actually appear in the DOM
    await page.waitForSelector('#email-input, #signup-email, input[type="email"]', { timeout: 30000 })
      .catch(() => console.log('DEBUG timeout waiting for email input'));
    const emailInput = await page.$('#signup-email') || await page.$('#email-input') || await page.$('input[type="email"]');
    if (emailInput) {
      await emailInput.type(twitchEmail);
      await sleep(200);

      // Click Continue button if it exists and is for the email step
      let continueBtn = await page.$('[data-a-target="passport-signup-button"]');
      if (continueBtn) {
        const btnText = await page.evaluate(b => b.textContent.trim().toLowerCase(), continueBtn);
        if (!btnText.includes('sign') && !btnText.includes('تسجيل') && !btnText.includes('註冊')) {
          console.log('DEBUG Waiting for Continue button to be enabled...');
          await page.waitForFunction(() => {
            const btn = document.querySelector('[data-a-target="passport-signup-button"]');
            return btn && !btn.disabled;
          }, { timeout: 15000 }).catch(() => console.log('DEBUG timeout waiting for continue btn enabled'));

          console.log('DEBUG Clicking Continue for multi-step form');
          await continueBtn.click();
          await sleep(300);
          
          // Wait for password field to become visible
          await page.waitForFunction(() => {
            const pw = document.querySelector('#password-input') || document.querySelector('#signup-password');
            return pw && pw.offsetParent !== null; // visible
          }, { timeout: 15000 }).catch(() => console.log('DEBUG timeout waiting for password visibility'));
          
          info = await dom.info();
          console.log('DEBUG inputs after email step:', JSON.stringify(info.inputs));
        }
      }
    }

    // ===== Fill password =====
    let pwSelector = '#signup-password';
    if (!(await page.$(pwSelector))) pwSelector = '#password-input';
    if (!(await page.$(pwSelector))) pwSelector = 'input[name="password"]';
    if (!(await page.$(pwSelector))) pwSelector = 'input[type="password"]';
    const pwInput = await page.$(pwSelector);
    const twitchPassword = password || randomString(16, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*');
    if (pwInput) {
      await pwInput.type(twitchPassword);
      await sleep(200);
      console.log('DEBUG password filled, length:', twitchPassword.length);
    } else {
      console.log('DEBUG WARNING: password input not found!');
    }

    // ===== Fill username — retry up to 8 times if Twitch says "unavailable" =====
    const unInput = await page.$('#signup-username') || await page.$('input[name="username"]') || await page.$('input[autocomplete="username"]');
    if (unInput) {
      let usernameOk = false;
      for (let uAttempt = 0; uAttempt < 8; uAttempt++) {
        await unInput.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await unInput.type(username);
        await sleep(600);
        const unavailable = await page.evaluate(() => {
          const els = document.querySelectorAll('[role="alert"], [class*="form-error"], [class*="error-message"]');
          for (const el of els) {
            const t = el.textContent.toLowerCase();
            if (t.includes('unavailable') || t.includes('username is taken') || t.includes('already taken')) return true;
          }
          return false;
        }).catch(() => false);
        if (!unavailable) {
          usernameOk = true;
          console.log(`DEBUG username filled (attempt ${uAttempt + 1}): ${username}`);
          break;
        }
        console.log(`DEBUG username "${username}" unavailable — trying new one`);
        username = generateUsername();
      }
      if (!usernameOk) console.log('DEBUG WARNING: could not find an available username after 8 tries');
    } else {
      console.log('DEBUG WARNING: username input not found!');
    }

    // ===== Fill birthday =====
    await page.waitForSelector('select', { timeout: 15000 }).catch(() => {});
    
    const monthSelect = await page.$('[data-a-target="birthday-month-select"]');
    const daySelect = await page.$('[data-a-target="birthday-date-select"]');
    const yearSelect = await page.$('[data-a-target="birthday-year-select"]');
    
    if (monthSelect && daySelect && yearSelect) {
      await monthSelect.select(dob.month); await sleep(100);
      await daySelect.select(dob.day); await sleep(100);
      await yearSelect.select(dob.year); await sleep(100);
      console.log(`DEBUG birthday selects filled: ${dob.month}/${dob.day}/${dob.year}`);
    } else {
      const allSelects = await page.$$('select');
      console.log('DEBUG found', allSelects.length, 'select elements, using index fallback');
      if (allSelects.length >= 3) {
        for (const sel of allSelects) {
          const options = await sel.$$eval('option', opts => opts.map(o => o.value));
          if (options.includes('1990') || options.includes('2000')) {
            await sel.select(dob.year); 
          } else if (options.length > 20) {
            await sel.select(dob.day);
          } else {
            await sel.select(dob.month);
          }
          await sleep(200);
        }
        console.log(`DEBUG birthday selects filled (smart fallback): ${dob.month}/${dob.day}/${dob.year}`);
      } else {
        console.log('DEBUG WARNING: birthday selects not found!');
      }
    }

    // ===== Natural mouse movement — KPSDK monitors mouse events ============
    // Move mouse around the form in a human-like pattern before blur
    try {
      const vp = page.viewport() || { width: 1280, height: 720 };
      const cx = vp.width / 2, cy = vp.height / 2;
      // Curved path: start top-left area, move toward form center, small jitter
      const moves = [
        [cx - 200 + Math.random()*40, cy - 150 + Math.random()*30],
        [cx - 100 + Math.random()*30, cy - 80  + Math.random()*20],
        [cx +  50 + Math.random()*20, cy - 30  + Math.random()*20],
        [cx +  20 + Math.random()*15, cy + 40  + Math.random()*15],
        [cx -  30 + Math.random()*10, cy + 20  + Math.random()*10],
      ];
      for (const [x, y] of moves) {
        await page.mouse.move(x, y, { steps: 4 });
        await sleep(40 + Math.random() * 60);
      }
    } catch(e) {}

    // ===== Blur: click modal header (exactly like original scrapper) =====
    console.log('DEBUG clicking out of form to blur...');
    const randomText = await page.$('#modal-root-header');
    if (randomText) await randomText.click();

    // Brief wait for KPSDK to process mouse/blur events
    await sleep(1500);

    // ===== Click Signup Button =====
    console.log('DEBUG clicking signup button...');
    
    // Wait for submit button to be enabled
    await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 15000 })
      .catch(() => console.log('DEBUG timeout waiting for submit button'));

    let signupBtn = await page.$('[data-a-target="passport-signup-button"]');
    if (signupBtn) {
      const btnText = await page.evaluate(b => b.textContent.trim(), signupBtn);
      console.log('DEBUG found signup button:', btnText);
    }

    if (signupBtn) {
      // Debug: use CDP page.cookies() (sees ALL cookies, including HttpOnly)
      const allCookies = await page.cookies().catch(() => []);
      const kpCookies = allCookies.filter(c =>
        c.name.startsWith('x-kpsdk') || c.name.startsWith('kpsdk') || c.name.startsWith('__kp') || c.name.includes('kasada')
      );
      // Log ALL cookie names so we can see if Kasada renamed their cookies
      console.log(`DEBUG [kp-cookies-cdp] total=${allCookies.length} kpsdk=${kpCookies.length} allNames=[${allCookies.map(c=>c.name).join(',')}]`);
      if (kpCookies.length) console.log(`DEBUG [kp-cookies-kpsdk]`, JSON.stringify(kpCookies.map(c => ({ name: c.name, httpOnly: c.httpOnly, val: c.value.slice(0, 20) }))));

      // Also check JS-visible state
      const kpState = await page.evaluate(() => {
        return {
          kpsdkGlobal:  typeof window.__kp !== 'undefined' ? 'present' : 'missing',
          kpsdkGlobal2: typeof window.KP   !== 'undefined' ? 'present' : 'missing',
          webdriverNow: navigator.webdriver,
          kpsdkScripts: Array.from(document.querySelectorAll('script[src]'))
            .map(s => s.src)
            .filter(s => s.includes('kpsdk') || s.includes('k.twitchcdn') || s.includes('kasada'))
            .map(s => s.slice(0, 100)),
        };
      }).catch(e => ({ error: e.message }));
      console.log('DEBUG [kp-state-before-submit]', JSON.stringify(kpState));

      await signupBtn.click();
      console.log('DEBUG signup button clicked');
    } else {
      console.log('DEBUG WARNING: no signup button found!');
    }

    // ===== Wait for result: poll until form closes (success) or error appears (failure) =====
    // The signup button shows a loading spinner while Kasada processes. Instead of fixed waits,
    // we poll every 1 second for up to 30 seconds.
    let formStillOpen = true;
    let hasErrorAlert = false;
    let alertTexts = [];
    
    let hasAnyAlert = false;
    for (let wait = 0; wait < 30; wait += 1) {
      await sleep(1000);

      // Check if signup form is still visible
      formStillOpen = !!(await page.$('#signup-username') || await page.$('#password-input'));

      // Collect all non-empty alert texts
      const alerts = await page.$$('[role=alert]');
      alertTexts = [];
      for (const el of alerts) {
        const text = await page.evaluate(e => e.textContent.trim(), el).catch(() => '');
        if (text.length > 0) alertTexts.push(text);
      }
      hasAnyAlert = alertTexts.length > 0;
      const combinedAlerts = alertTexts.join(' ').toLowerCase();
      // Only treat as Kasada block if the text explicitly says so
      hasErrorAlert = combinedAlerts.includes('browser not currently supported') ||
                      combinedAlerts.includes('browser is not currently supported') ||
                      combinedAlerts.includes('not currently supported');

      if (!formStillOpen) {
        console.log(`DEBUG form closed after ${wait + 2}s — signup likely succeeded!`);
        break;
      }

      if (formStillOpen && hasErrorAlert) {
        console.log(`DEBUG form open + Kasada alert after ${wait + 2}s — Browser not supported`);
        break;
      }

      if (formStillOpen && hasAnyAlert) {
        console.log(`DEBUG form open + non-Kasada alert after ${wait + 2}s — form validation error`);
        break;
      }

      if (wait > 0 && wait % 5 === 0) {
        console.log(`DEBUG still waiting for result... ${wait}s elapsed, form=${formStillOpen ? 'open' : 'closed'}`);
      }
    }

    // Log any alerts found
    for (const t of alertTexts) {
      console.log('DEBUG [createTwitchAccount] Alert text:', t.slice(0, 150));
    }

    if (formStillOpen && hasErrorAlert) {
      console.log('DEBUG [createTwitchAccount] Kasada block — Browser not supported');
      return { success: false, username, email: twitchEmail, password: twitchPassword, error: 'Browser not supported', domain: emailDomain };
    }

    if (formStillOpen && hasAnyAlert) {
      const alertSummary = alertTexts.join('; ').slice(0, 200);
      console.log('DEBUG [createTwitchAccount] Form validation error:', alertSummary);
      return { success: false, username, email: twitchEmail, password: twitchPassword, error: 'Form error: ' + alertSummary };
    }

    if (formStillOpen) {
      console.log('DEBUG [createTwitchAccount] Signup form still visible after 30s, no error — treating as timeout');
      return { success: false, username, email: twitchEmail, password: twitchPassword, error: 'timeout - form stuck', consoleMsgs };
    }

    // No alert = account was likely created! Check for verification code input
    console.log('DEBUG No alert detected — checking for success...');
    const pageContent = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
    console.log('DEBUG page content after submit:', pageContent.slice(0, 200));

    // Wait for the background IMAP poller
    let code = await emailPromise;

    // Fallback: if background poll expired before email arrived, try once more for 90s
    if (!code && IMAP_ENABLED) {
      console.log('DEBUG [signup] Background IMAP timed out — starting fallback poll (90s)');
      code = await emailReader.waitForCode({ address: twitchEmail, type: 'imap', since: Date.now() - 120000 }, 90000)
        .catch(e => { console.log('DEBUG [signup] Fallback IMAP error:', e.message); return null; });
    }

    if (!code) {
      let cookies = null;
      try { cookies = await page.cookies(); } catch(e) {}
      return { success: false, username, email: twitchEmail, password: twitchPassword, error: 'No verification code received', cookies };
    }

    console.log('DEBUG got verification code:', code);
    const digits = code.replace(/\s/g, '').slice(0, 6);
    console.log('DEBUG code digits to type:', digits);

    // Fill the 6-digit verification boxes by clicking each box individually
    // and typing one digit with real keyboard events so React state updates correctly.
    try {
      await page.waitForSelector(
        '[data-a-target="passport-verification-code-modal"] input, input[maxlength="1"]',
        { timeout: 20000 }
      ).catch(() => {});
      await sleep(500);

      const inputs = await page.$$('[data-a-target="passport-verification-code-modal"] input').catch(() => []);
      const boxes = inputs.length >= 6 ? inputs : await page.$$('input[maxlength="1"]').catch(() => []);

      if (boxes.length >= 6) {
        for (let i = 0; i < 6; i++) {
          await boxes[i].click();
          await page.keyboard.type(digits[i] || '', { delay: 100 });
          await sleep(80);
        }
        console.log('DEBUG filled 6 verification boxes via click+type per box');
      } else {
        // Fallback: focus first box and type all digits (React auto-advances on keypress)
        const first = boxes[0] || await page.$('input[type="text"]').catch(() => null);
        if (first) await first.click();
        for (const d of digits) {
          await page.keyboard.type(d, { delay: 150 });
          await sleep(100);
        }
        console.log('DEBUG typed verification code via sequential keyboard fallback');
      }
    } catch(err) {
      console.log('DEBUG ERROR typing code:', err.message);
    }

    // Click Submit immediately

    // Click the Submit button
    const submitClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent.trim();
        const lower = text.toLowerCase();
        if (btn.offsetParent !== null && !btn.disabled &&
            (lower === 'submit' || lower === 'enviar' || lower === 'gönder' || lower === 'envoyer' || lower === 'absenden' || lower === 'submit now' || lower.includes('submit')) &&
            !lower.includes('resend') && !lower.includes('yeniden') && !lower.includes('back') && !lower.includes('voltar') && !lower.includes('geri')) {
          btn.click();
          return text;
        }
      }
      return null;
    });

    if (!submitClicked) {
      console.log('DEBUG submit button not found, pressing Enter');
      await page.keyboard.press('Enter');
    } else {
      console.log('DEBUG clicked submit button:', submitClicked);
    }
    await sleep(1500);

    // Verify the account was actually created
    await sleep(3000);
    const afterContent = await page.evaluate(() => document.body.innerText.slice(0, 1000)).catch(() => '');
    console.log('DEBUG after submit content:', afterContent.slice(0, 300));

    const afterLower = afterContent.toLowerCase();
    const stillOnVerification = afterLower.includes('verification code') ||
      afterLower.includes('enter your verification') ||
      afterLower.includes('verify');
    const hasError = afterLower.includes('incorrect') ||
      afterLower.includes('invalid') ||
      afterLower.includes('wrong code') ||
      afterLower.includes('expired') ||
      afterLower.includes('try again') ||
      afterLower.includes('error') ||
      afterLower.includes('not accepted');

    let cookies = null;
    try { cookies = await page.cookies(); } catch(e) {}

    if (stillOnVerification || hasError) {
      console.log('DEBUG [createTwitchAccount] Verification failed — still on verification or error detected');
      return { success: false, username, email: twitchEmail, password: twitchPassword, error: 'Verification code not accepted', cookies };
    }

    // Final check — make sure we're actually logged in (not just on some random page)
    const loggedIn = await page.evaluate(() => {
      const userMenu = document.querySelector('[data-a-target="user-menu"]') ||
                       document.querySelector('[data-a-target="core-top-nav-avatar"]') ||
                       document.querySelector('button[data-a-target="profile-menu-trigger"]');
      if (userMenu) return true;
      const loginLinks = document.querySelectorAll('a[href*="/login"], a[href*="/signup"]');
      for (const link of loginLinks) {
        if (link.offsetParent !== null || link.getBoundingClientRect().width > 0) return false;
      }
      return true;
    });

    if (!loggedIn) {
      console.log('DEBUG [createTwitchAccount] Not logged in after verification — account creation failed');
      return { success: false, username, email: twitchEmail, password: twitchPassword, error: 'Not logged in after verification', cookies };
    }

    const hasPfp = false;

    // Reload page to ensure cookies are fully set before saving.
    // Use 'load' not 'networkidle2' — Twitch keeps WebSocket connections open
    // permanently so networkidle2 always times out, leaving the page in a
    // partial state when page.cookies() runs.
    try {
      console.log('DEBUG [createTwitchAccount] Reloading page to refresh cookies...');
      await page.reload({ waitUntil: 'load', timeout: 20000 }).catch(() => {});
      await sleep(2000);
    } catch(e) {}

    // Extract cookies after reload — ensures fresh valid cookies
    try { cookies = await page.cookies(); } catch(e) {}
    console.log(`DEBUG [createTwitchAccount] Cookies saved: ${cookies ? cookies.length : 0} cookies`);

    return { success: true, username, email: twitchEmail, password: twitchPassword, cookies, domain: emailDomain, hasPfp };
  } catch (error) {
    console.log('puppeteerModeSignup error:', error.message);
    console.log('puppeteerModeSignup error stack:', error.stack);
    return { success: false, error: error.message };
  } finally {
    try { if (browser) browser.close(); } catch(e) {}
    // DO NOT close proxy — shared across retries
    // 1. Delete this account's own profile immediately.
    try { require('fs').rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    // 2. Age-based sweep: remove any profile older than 30 min.
    //    Active signups finish in <5 min so 30 min is always safe — we never
    //    touch a live directory even with many parallel accounts running.
    try {
      const fs = require('fs');
      const profileDir = path.join(__dirname, '../tmp_profiles');
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const name of fs.readdirSync(profileDir)) {
        if (!name.startsWith('profile_') && !name.startsWith('ban_') && !name.startsWith('drops_')) continue;
        const full = path.join(profileDir, name);
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
        } catch(e) {}
      }
    } catch(e) {}
  }
}

/**
 * Retry wrapper — same logic as what worked at 4:21pm.
 * Kasada rejection is probabilistic, so we retry up to 5 times.
 */
async function createTwitchAccount(password, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`DEBUG [createTwitchAccount] Attempt ${attempt}/${maxRetries}`);
    const result = await puppeteerModeSignup(password);

    if (result.success) {
      console.log(`DEBUG [createTwitchAccount] SUCCESS on attempt ${attempt}`);
      return result;
    }

    // "Browser not supported" = Kasada rejection — fail fast
    if (result.error && result.error.includes('Browser not supported')) {
      console.log(`DEBUG [createTwitchAccount] Kasada rejected — failing fast`);
      return result;
    }

    // Fingerprint limit — wait longer for reset
    if (result.error && (result.error.includes('Query limit') || result.error.includes('Fingerprint'))) {
      if (attempt < maxRetries) {
        const waitSec = 30;
        console.log(`DEBUG [createTwitchAccount] Fingerprint limit, waiting ${waitSec}s... (${maxRetries - attempt} retries left)`);
        await sleep(waitSec * 1000);
        continue;
      }
    }

    // Other errors (network, proxy, etc.) — worth retrying
    if (attempt < maxRetries) {
      const waitSec = 10;
      console.log(`DEBUG [createTwitchAccount] Got "${result.error}", retrying in ${waitSec}s... (${maxRetries - attempt} retries left)`);
      await sleep(waitSec * 1000);
      continue;
    }

    return result;
  }
}

module.exports = { puppeteerModeSignup, createTwitchAccount, getSignupProxyMode };
