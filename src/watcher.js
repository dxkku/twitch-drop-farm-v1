const path = require('path');
const fs = require('fs');
const { startLocalProxy, resetLocalProxy } = require('./localProxy');

const PROXY_URL = process.env.PROXY_URL || null;

const activeWatchers = {};
let onWatcherStopCallback = null;
let onWatcherUpdateCallback = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function setOnWatcherStop(cb) { onWatcherStopCallback = cb; }
function setOnWatcherUpdate(cb) { onWatcherUpdateCallback = cb; }

const launching = {}; // accId -> streamer — being set up but not yet active

async function watchStream(accId, streamerName) {
  // Stop any existing watcher for this account
  if (activeWatchers[accId]) {
    await stopWatching(accId);
  }

  const acc = require('./state').accounts[accId];
  if (!acc) throw new Error('Account not found');
  
  const username = acc.twitchData?.username || acc.username;
  const password = acc.password;
  if (!username || !password) throw new Error('Account missing username or password');

  console.log(`DEBUG [watcher] Starting watch for ${username} on ${streamerName}`);
  launching[accId] = streamerName;

  // Shared proxy — stays alive across retries (same as twitchBot.js)
  let proxyPort = null;
  if (PROXY_URL) {
      proxyPort = await startLocalProxy();
    console.log(`DEBUG [watcher] using proxy via local port ${proxyPort}`);
    // Warm up proxy — make a test request to establish upstream connection
    try {
      const http = require('http');
      await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: 'www.google.com:443' });
        req.on('connect', () => { req.destroy(); resolve(); });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      console.log('DEBUG [watcher] proxy warmed up OK');
    } catch (e) {
      console.log('DEBUG [watcher] proxy warmup failed:', e.message, '— waiting more...');
      await sleep(5000);
    }
  }

  const IS_SERVER_W = process.platform === 'linux' || process.env.SERVER_MODE === '1';
  const stealthLauncherW = IS_SERVER_W ? require('./stealth/serverLauncher.js') : require('./stealth/index.js');
  const os = require('os');

  let browser, chromeProc;
  const tmpDir = path.join(os.tmpdir(), 'watcher_' + accId + '_' + Date.now());
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}

  const launched = await stealthLauncherW.launch({
    userDataDir: tmpDir,
    proxyPort: proxyPort || undefined,
    kpsdkDelay: 12000,
    windowSize: { width: 1280, height: 720 },
  });
  browser = launched.browser;
  chromeProc = launched.chromeProc;
  const page = launched.page;

  try {
    // Accept cookie banner (same as twitchBot.js — multi-language)
    async function acceptCookies() {
      try {
        const accepted = await page.evaluate(() => {
          const acceptTexts = ['accept', 'aceitar', 'aceptar', 'accepter', 'akzeptieren', 'accetta', 'kabul', '同意'];
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            const text = btn.textContent.trim().toLowerCase();
            if (acceptTexts.some(t => text.includes(t)) && !text.includes('all')) {
              btn.click();
              return text;
            }
          }
          return null;
        });
        if (accepted) console.log(`DEBUG [watcher] ${username}: accepted cookie banner: ${accepted}`);
      } catch(e) {}
    }

    // Patch chrome.runtime — KPSDK checks this on every page load
    const chromeRuntimePatch = () => {
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
    };
    await page.evaluateOnNewDocument(chromeRuntimePatch).catch(() => {});
    const { STEALTH_EVALS: _stealthEvals } = require('./stealth/index.js');
    await page.evaluateOnNewDocument(_stealthEvals).catch(() => {});
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
    await sleep(500);
    await page.evaluate(chromeRuntimePatch).catch(() => {});
    await acceptCookies();

    // ===== Cookie injection: skip login if cookies exist =====
    const savedCookies = acc.cookies;
    let loggedIn = false;
    if (savedCookies && savedCookies.length > 0) {
      console.log(`DEBUG [watcher] ${username}: injecting ${savedCookies.length} saved cookies...`);
      await page.setCookie(...savedCookies);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(5000);
      await acceptCookies();

      // Check if cookies worked — look for logged-in indicator
      loggedIn = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        // Welcome modal = logged in (multi-language)
        if (/welcome to the party|أهلاً بك معنا|bienvenido.*part|willkommen.*party|benvenuto.*festa|partiye hoş geldiniz|ようこそ|欢迎/.test(text)) return true;
        // Logged-in users have a profile picture or username in the top nav
        const userMenu = document.querySelector('[data-a-target="user-menu"]') ||
                         document.querySelector('[data-a-target="core-top-nav-avatar"]') ||
                         document.querySelector('button[data-a-target="profile-menu-trigger"]') ||
                         document.querySelector('[data-a-target="top-nav-container"] img[src*="profile"]') ||
                         document.querySelector('button[aria-label*="avatar"]') ||
                         document.querySelector('button[aria-label*="profil"]');
        if (userMenu) return true;
        // Check for Following/Feed tab (only visible when logged in)
        const followingTab = document.querySelector('[data-a-target="following-tab"]') ||
                            document.querySelector('a[data-a-target="top-nav-following"]');
        if (followingTab) return true;
        // Check for user menu by looking for profile-like images in top nav
        const topNav = document.querySelector('[data-a-target="top-nav-container"]') || document.querySelector('nav');
        if (topNav) {
          const imgs = topNav.querySelectorAll('img');
          for (const img of imgs) {
            const src = img.src || '';
            if (src.includes('profile') || src.includes('avatar') || src.includes('user')) return true;
          }
        }
        // Check if NO login/signup buttons visible (means logged in)
        const loginLinks = document.querySelectorAll('a[href*="/login"], a[href*="/signup"]');
        let loginVisible = false;
        for (const link of loginLinks) {
          if (link.offsetParent !== null || link.getBoundingClientRect().width > 0) {
            loginVisible = true;
            break;
          }
        }
        if (loginVisible) return false;
        // Check for user avatar
        const avatars = document.querySelectorAll('img[alt*="avatar"], img[alt*="profile"], img[alt*="profil"]');
        if (avatars.length > 0) return true;
        return false;
      });

      if (loggedIn) {
        console.log(`DEBUG [watcher] ${username}: cookies worked! Already logged in.`);
        // Dismiss "Welcome to the party" / "Choose some interests" modal (all languages)
        try {
          const dismissed = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
              const text = btn.textContent.trim().toLowerCase();
              if (btn.offsetParent !== null && (
                text.includes('close') || text.includes('fermer') || text.includes('cerrar') || 
                text.includes('schließen') || text.includes('chiudi') || text.includes('kapat') ||
                text.includes('閉じる') || text.includes('关闭') || text.includes('إغلاق')
              )) { btn.click(); return 'close'; }
            }
            for (const btn of buttons) {
              const text = btn.textContent.trim().toLowerCase();
              if (btn.offsetParent !== null && (
                text === 'skip' || text === 'done' || text === 'not now' || text === 'maybe later' ||
                text === 'passer' || text === 'ignorer' || text === 'terminé' || text === 'ahora no' ||
                text === 'omitir' || text === 'hecho' || text === 'überspringen' || text === 'fertig' ||
                text === 'salta' || text === 'fatto' || text === 'atla' || text === 'bitti' ||
                text === 'スキップ' || text === '完了' || text === '跳过' || text === '完成' ||
                text === 'تخطي' || text === 'إلغاء' || text === 'لاحقاً' || text === 'ليس الآن'
              )) { btn.click(); return 'skip'; }
            }
            return null;
          });
          
          // Always press Escape to close the welcome modal (it has no close button)
          await page.keyboard.press('Escape');
          await sleep(2000);
          
          // If still open, click outside the modal (top-left corner)
          const stillOpen = await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            return /welcome to the party|أهلاً بك معنا|bienvenido.*part|willkommen.*party|benvenuto.*festa|partiye hoş geldiniz|ようこそ|欢迎/.test(text);
          });
          if (stillOpen) {
            await page.mouse.click(10, 10);
            await sleep(2000);
          }
          // If STILL open, try clicking "Choose some interests" then Escape again
          const stillOpen2 = await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            return /welcome to the party|أهلاً بك معنا|bienvenido.*part|willkommen.*party|benvenuto.*festa|partiye hoş geldiniz|ようこそ|欢迎/.test(text);
          });
          if (stillOpen2) {
            // Click "Choose some interests" to go to next step
            await page.evaluate(() => {
              const buttons = document.querySelectorAll('button');
              for (const btn of buttons) {
                const text = btn.textContent.trim().toLowerCase();
                if (text.includes('choose some interest') || text.includes('intéress') || 
                    text.includes('interesse') || text.includes('ilgi') || text.includes('関心') || text.includes('兴趣') ||
                    text.includes('اهتمام')) {
                  btn.click(); return;
                }
              }
            });
            await sleep(2000);
            // Now press Escape or click Skip/Done on the interests page
            await page.keyboard.press('Escape');
            await sleep(1000);
            // Or click "Done"/"Skip" if interests page is shown
            await page.evaluate(() => {
              const buttons = document.querySelectorAll('button');
              for (const btn of buttons) {
                const text = btn.textContent.trim().toLowerCase();
                if (text === 'done' || text === 'skip' || text === 'finish' || text === 'complete' ||
                    text === 'terminé' || text === 'fertig' || text === 'bitti' || text === '完了') {
                  btn.click(); return;
                }
              }
            });
            await sleep(1000);
          }
          
          console.log(`DEBUG [watcher] ${username}: dismissed welcome modal`);
        } catch(e) { console.log(`DEBUG [watcher] ${username}: dismiss error: ${e.message}`); }
      } else {
        console.log(`DEBUG [watcher] ${username}: cookies didn't work, falling back to login...`);
      }
    }

    // ===== Normal login flow (only if cookies didn't work) =====
    if (!loggedIn) {
    // Wait for the login/signup buttons to render
    await sleep(3000);
    console.log(`DEBUG [watcher] ${username}: clicking Log In button on main page...`);
    const logInClicked = await page.evaluate(() => {
      // PRIORITY 1: Find by href (language-independent!)
      const loginLinks = document.querySelectorAll('a[href*="/login"]');
      for (const link of loginLinks) {
        if (link.offsetParent !== null || link.getBoundingClientRect().width > 0) {
          link.click();
          return link.textContent.trim().toLowerCase();
        }
      }
      // PRIORITY 2: Find by text (all languages including Thai)
      const all = document.querySelectorAll('a, button');
      for (const el of all) {
        const text = el.textContent.trim().toLowerCase();
        if (text === 'log in' || text === 'login' || text === 'oturum aç' ||
            text === 'se connecter' || text === 'entrar' || text === 'iniciar sesión' ||
            text === 'تسجيل الدخول' || text === 'تسجيل دخول' || text === 'connexion' ||
            text === 'anmelden' || text === 'accedi' || text === 'giriş yap' ||
            text === 'เข้าสู่ระบบ' || text === 'ล็อกอิน' || text === '로그인' || text === 'ログイン' || text === '登录') {
          el.click();
          return text;
        }
      }
      return null;
    });

    if (logInClicked) {
      console.log(`DEBUG [watcher] ${username}: clicked "${logInClicked}"`);
    } else {
      // NO fallback to /login — that triggers Kasada. Throw error instead.
      throw new Error('Log In button not found on twitch.tv main page (Kasada may have blocked)');
    }

    await sleep(5000);
    await acceptCookies();

    // Check if Kasada already blocked BEFORE trying to type
    const kasadaBlockedEarly = await page.evaluate(() => {
      const alerts = document.querySelectorAll('[role=alert]');
      for (const a of alerts) {
        const t = a.textContent || '';
        if (t.includes('not currently supported') || t.includes('nicht unterstützt') || 
            t.includes('non supporté') || t.includes('no compatible') || t.includes('ยังไม่รองรับ') ||
            t.includes('現在サポートされていません') || t.includes('desteklenmiyor')) {
          return true;
        }
      }
      return false;
    });
    if (kasadaBlockedEarly) {
      throw new Error('Browser not supported on login (Kasada blocked)');
    }

    // Wait for login form to render (React SPA)
    let usernameInput = null;
    for (let i = 0; i < 10; i++) {
      usernameInput = await page.$('#login-username');
      if (!usernameInput) usernameInput = await page.$('input[autocomplete="username"]');
      if (!usernameInput) usernameInput = await page.$('input[id*="login"][id*="username"]');
      // Fallback: find any text input on the page that's likely the username field
      if (!usernameInput) {
        usernameInput = await page.evaluateHandle(() => {
          const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
          for (const inp of inputs) {
            if (inp.id.includes('login') || inp.id.includes('username') || 
                inp.placeholder?.toLowerCase().includes('user') ||
                inp.getAttribute('aria-label')?.toLowerCase().includes('user')) {
              return inp;
            }
          }
          // If only one text input visible, it's probably the username
          const visible = [...inputs].filter(i => i.offsetParent !== null);
          return visible.length === 1 ? visible[0] : null;
        });
        if (usernameInput && !usernameInput.asElement()) usernameInput = null;
        else if (usernameInput?.asElement) usernameInput = usernameInput.asElement();
      }
      if (usernameInput) break;
      console.log(`DEBUG [watcher] ${username}: waiting for login form... (${i+1}/10)`);
      await sleep(2000);
    }

    if (!usernameInput) {
      // Log what inputs ARE on the page for debugging
      const pageInputs = await page.evaluate(() => {
        return [...document.querySelectorAll('input')].map(i => ({
          id: i.id, type: i.type, name: i.name, placeholder: i.placeholder,
          ariaLabel: i.getAttribute('aria-label')
        }));
      });
      console.log('DEBUG [watcher] inputs on login page:', JSON.stringify(pageInputs));
      throw new Error('Username input not found on login page');
    }

    // Type username
    await usernameInput.click();
    await sleep(300);
    await page.keyboard.type(username, { delay: 50 });
    console.log(`DEBUG [watcher] ${username}: typed username`);

    // Find and fill password field
    const passwordInput = await page.$('#password-input, input[type="password"]');
    if (passwordInput) {
      await passwordInput.click();
      await sleep(300);
      await page.keyboard.type(password, { delay: 50 });
      console.log(`DEBUG [watcher] ${username}: typed password`);
    } else {
      throw new Error('Password input not found on login page');
    }

    await sleep(1000);

    // ===== Click Login Button (with fallbacks) =====
    // Wait for submit button to be enabled (same pattern as twitchBot.js signup)
    await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 15000 })
      .catch(() => console.log(`DEBUG [watcher] ${username}: timeout waiting for enabled submit button`));

    // Try primary selector first, then find by text content
    let loginBtn = await page.$('button[data-a-target="passport-login-button"]');
    if (!loginBtn) {
      loginBtn = await page.evaluateHandle(() => {
        const buttons = document.querySelectorAll('button[type="submit"]');
        for (const btn of buttons) {
          const text = btn.textContent.trim().toLowerCase();
          if (text.includes('log in') || text.includes('sign in') || text.includes('entrar') || text.includes('connexion')) {
            return btn;
          }
          // If only one visible submit button, use that one
          if (buttons.length === 1) return btn;
        }
        // Fallback to first visible submit button
        for (const btn of buttons) {
          if (btn.offsetParent !== null) return btn;
        }
        return null;
      });
      if (loginBtn && !loginBtn.asElement()) loginBtn = null;
      else if (loginBtn?.asElement) loginBtn = loginBtn.asElement();
    }

    let loginButtonClicked = false;
    if (loginBtn) {
      const btnText = await page.evaluate(b => b.textContent.trim().toLowerCase(), loginBtn).catch(() => '?');
      await loginBtn.click();
      console.log(`DEBUG [watcher] ${username}: clicked login button ("${btnText}")`);
      loginButtonClicked = true;
    }

    // Wait for login to complete — detect all states in one pass
    console.log(`DEBUG [watcher] ${username}: waiting for login to process...`);
    let loginDone = false;
    let needsVerification = false;
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      
      // Single evaluation to get all state at once
      const state = await page.evaluate(() => {
        // Check for verification code inputs (6 small boxes)
        const inputs = document.querySelectorAll('input');
        const codeInputs = [...inputs].filter(inp => {
          const rect = inp.getBoundingClientRect();
          return rect.width > 0 && rect.width < 100 && rect.height > 0;
        });
        const hasCodeForm = codeInputs.length >= 6;
        
        // Check for login form (username/password)
        const hasLoginForm = !!document.querySelector('#login-username, input[autocomplete="username"]');
        
        // Check for Login/Signup nav links
        const links = document.querySelectorAll('a[href]');
        let hasLoginLink = false;
        for (const link of links) {
          if ((link.getAttribute('href') || '').includes('/login')) hasLoginLink = true;
        }
        
        // Check for error alerts
        const alerts = document.querySelectorAll('[role=alert]');
        const hasAlert = alerts.length > 0;
        
        return { hasCodeForm, hasLoginForm, hasLoginLink, hasAlert };
      });
      
      // State 1: Verification code form appeared → need to enter code
      if (state.hasCodeForm) {
        console.log(`DEBUG [watcher] ${username}: verification code form detected`);
        needsVerification = true;
        break;
      }
      
      // State 2: Error alert with TEXT + login form still visible → Kasada blocked
      if (state.hasAlert && state.hasLoginForm) {
        const alertTexts = [];
        const alerts = await page.$$('[role=alert]');
        for (const el of alerts) {
          const text = await page.evaluate(e => e.textContent.trim(), el).catch(() => '');
          if (text.length > 0) alertTexts.push(text);
        }
        // Only break if alerts have actual text (not empty loading spinners)
        if (alertTexts.length > 0) {
          console.log(`DEBUG [watcher] ${username}: error alerts on page:`, alertTexts.join(' | '));
          break;
        }
      }
      
      // State 3: Login form gone + Login nav links gone → truly logged in
      if (!state.hasLoginForm && !state.hasLoginLink) {
        console.log(`DEBUG [watcher] ${username}: login succeeded! (Login/SignUp buttons gone)`);
        loginDone = true;
        break;
      }
      
      // State 4: Login form gone but nav links still there → modal closed, check verification
      if (!state.hasLoginForm && i > 1) {
        console.log(`DEBUG [watcher] ${username}: login form gone, waiting for next state...`);
        // Wait one more cycle to see if verification form or avatar appears
      }

      // Try Enter key fallback after 8 seconds
      if (i === 3 && loginButtonClicked) {
        console.log(`DEBUG [watcher] ${username}: trying Enter key fallback...`);
        await page.keyboard.press('Enter');
      }
    }

    // Log page text for debugging failed login
    if (!loginDone && !needsVerification) {
      const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
      console.log(`DEBUG [watcher] ${username}: page text after login attempt:`, pageText.slice(0, 300));
      
      // If we didn't detect verification AND didn't log in → check for Kasada
      const hasAlertAndForm = await page.evaluate(() => {
        const alerts = document.querySelectorAll('[role=alert]');
        const loginForm = document.querySelector('#login-username, input[autocomplete="username"]');
        return alerts.length > 0 && !!loginForm;
      });
      if (hasAlertAndForm) {
        throw new Error('Browser not supported on login (Kasada blocked)');
      }
    }

    if (needsVerification) {
      console.log(`DEBUG [watcher] ${username}: login requires email verification code`);
      
      // Get the account's email to check IMAP
      const accEmail = acc.twitchData?.email || acc.email;
      console.log(`DEBUG [watcher] ${username}: checking IMAP for code sent to ${accEmail}`);
      
      try {
        const emailReader = require('./emailReader');
        const codeStartTime = Date.now();
        const code = await emailReader.waitForCode({ address: accEmail, type: 'imap', since: codeStartTime }, 90000);
        
        if (code) {
          console.log(`DEBUG [watcher] ${username}: got login verification code: ${code}`);
          
          // Find the first code input box and type digits
          const codeInput = await page.evaluateHandle(() => {
            const inputs = document.querySelectorAll('input');
            for (const inp of inputs) {
              if (inp.type === 'text' || inp.type === 'tel' || inp.type === 'number' || inp.type === '') {
                const rect = inp.getBoundingClientRect();
                if (rect.width > 0 && rect.width < 100) return inp;
              }
            }
            return null;
          });

          if (codeInput && codeInput.asElement()) {
            await codeInput.asElement().click();
            await sleep(500);
            // Type each digit — Twitch auto-advances to next box
            for (const digit of code.toString()) {
              await page.keyboard.type(digit);
              await sleep(200);
            }
            console.log(`DEBUG [watcher] ${username}: typed verification code`);
            await sleep(1000);

            // Click Submit button — or press Enter as backup
            const submitBtn = await page.evaluateHandle(() => {
              const buttons = document.querySelectorAll('button');
              for (const btn of buttons) {
                const text = btn.textContent.trim().toLowerCase();
                if (text === 'submit' || text === 'enviar' || text === 'envoyer' || text === 'absenden') {
                  return btn;
                }
              }
              return null;
            });
            if (submitBtn && submitBtn.asElement()) {
              await submitBtn.asElement().click();
              console.log(`DEBUG [watcher] ${username}: clicked submit on verification`);
            } else {
              // If no submit button found, try Enter
              await page.keyboard.press('Enter');
              console.log(`DEBUG [watcher] ${username}: pressed Enter for verification`);
            }
            
            // Poll for avatar or modal close after submitting code
            let codeAccepted = false;
            for (let i = 0; i < 15; i++) {
              await sleep(2000);
              // Check: Login/Signup buttons gone = logged in
              const loginGone = await page.evaluate(() => {
                const links = document.querySelectorAll('a[href]');
                for (const link of links) {
                  if ((link.getAttribute('href') || '').includes('/login')) return false;
                }
                return true;
              });
              if (loginGone) {
                console.log(`DEBUG [watcher] ${username}: verification accepted! (Login button gone)`);
                codeAccepted = true;
                loginDone = true;
                break;
              }
              // Check if verification form is gone (code inputs disappeared)
              const codeInputsGone = await page.evaluate(() => {
                const inputs = document.querySelectorAll('input');
                const small = [...inputs].filter(i => i.getBoundingClientRect().width > 0 && i.getBoundingClientRect().width < 100);
                return small.length < 6;
              });
              if (codeInputsGone) {
                console.log(`DEBUG [watcher] ${username}: verification form disappeared`);
                codeAccepted = true;
                break;
              }
            }
          }
        } else {
          console.log(`DEBUG [watcher] ${username}: no verification code found in email`);
        }
      } catch (e) {
        console.log(`DEBUG [watcher] ${username}: verification code error: ${e.message}`);
      }
    }
    } // end if (!loggedIn)

    // Final login check — preserve cookie-based loggedIn, only re-check if we weren't sure
    if (!loggedIn) {
      loggedIn = loginDone || await page.evaluate(() => {
        const links = document.querySelectorAll('a[href]');
        for (const link of links) {
          if ((link.getAttribute('href') || '').includes('/login') && 
              link.offsetParent !== null && link.getBoundingClientRect().width > 0) {
            return false;
          }
        }
        return true;
      });
    }
    console.log(`DEBUG [watcher] ${username}: post-login — logged in: ${loggedIn}`);

    if (!loggedIn) {
      console.log(`DEBUG [watcher] ${username}: login failed, will watch as guest (drops won't count)`);
    }

    // ── TAB 2: inventory page — opened once, stays open for the whole session ────
    let inventoryPage = null;
    if (loggedIn) {
      try {
        inventoryPage = await browser.newPage();
        await inventoryPage.evaluateOnNewDocument(chromeRuntimePatch).catch(() => {});
        const { STEALTH_EVALS } = require('./stealth/index.js');
        await inventoryPage.evaluateOnNewDocument(STEALTH_EVALS).catch(() => {});

        // Pre-watch drops check: is the RL campaign already connected for this account?
        // If drops/inventory shows RL items → connected, skip the follow step.
        // If not → follow rocketleague first so drops become eligible.
        console.log(`DEBUG [watcher] ${username}: checking drops/inventory for RL campaign...`);
        await inventoryPage.goto('https://www.twitch.tv/drops/inventory', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(4000);
        await inventoryPage.keyboard.press('Escape').catch(() => {});

        const dropsConnected = await inventoryPage.evaluate(() => {
          const text = (document.body?.innerText || '').toLowerCase();
          return text.includes('rocket league') || text.includes('rl world') || text.includes('rlcs');
        }).catch(() => false);

        console.log(`DEBUG [watcher] ${username}: RL drops connected: ${dropsConnected}`);

        if (!dropsConnected) {
          // Follow rocketleague so drops become available
          console.log(`DEBUG [watcher] ${username}: RL drops NOT connected — following rocketleague...`);
          await page.goto('https://www.twitch.tv/rocketleague', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(8000);

        // Dismiss welcome modal if it appears again
        const modalPresent = await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return /welcome to the party|أهلاً بك معنا|bienvenido.*part|willkommen.*party|benvenuto.*festa|partiye hoş geldiniz|ようこそ|欢迎|ласкаво просимо|добро пожаловать/i.test(text);
        });
        if (modalPresent) {
          console.log(`DEBUG [watcher] ${username}: dismissing welcome modal on rocketleague page`);
          await page.keyboard.press('Escape');
          await sleep(2000);
          // If still open, try clicking outside
          const stillOpen = await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            return /welcome to the party|ласкаво просимо|добро пожаловать/i.test(text);
          });
          if (stillOpen) {
            await page.mouse.click(10, 10);
            await sleep(2000);
          }
        }

        // Scroll down multiple times to find Follow button
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollBy(0, 400));
          await sleep(800);
        }

        const followResult = await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          // First check: unfollow = already following
          for (const btn of btns) {
            if (btn.offsetParent === null) continue;
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            const dataTarget = (btn.getAttribute('data-a-target') || '').toLowerCase();
            if (label.includes('unfollow') || label.includes('ne plus suivre') ||
                label.includes('dejar de seguir') || label.includes('takibi bırak') ||
                label.includes('отпоследвай') || label.includes('відписатися') ||
                label.includes('відстежувати') || label.includes('abonnierung') ||
                dataTarget === 'unfollow-button') return 'already_following';
          }
          // Second check: follow button
          for (const btn of btns) {
            if (btn.offsetParent === null) continue;
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            const text = btn.textContent.trim().toLowerCase();
            const dataTarget = (btn.getAttribute('data-a-target') || '').toLowerCase();
            if (label.includes('follow') || label.includes('suivre') || label.includes('seguir') ||
                label.includes('folgen') || label.includes('takip') || label.includes('フォロー') ||
                label.includes('последвай') || label.includes('підписатися') || label.includes('теглити') ||
                label.includes('تتبع') || label.includes('abonn') ||
                dataTarget === 'follow-button' ||
                text === 'follow' || text === 'suivre' || text === 'seguir' || text === 'takip et' ||
                text === 'следвай' || text === 'підписатися' || text === 'теглити' ||
                text === 'seguici' || text === 'seguen' || text === 'abonnieren') {
              btn.click();
              return 'followed';
            }
          }
          // Third check: body text says "Following"
          const bodyText = document.body.innerText;
          if (/following\s+rocketleague|se\s+aboni/i.test(bodyText)) return 'already_following';

          return 'not_found';
        });

        console.log(`DEBUG [watcher] ${username}: rocketleague follow: ${followResult}`);
        } else {
          console.log(`DEBUG [watcher] ${username}: RL drops already connected — skipping follow step`);
        }
      } catch(e) {
        console.log(`DEBUG [watcher] ${username}: inventory pre-check error: ${e.message}`);
      }
    }

    // ── TAB 1: navigate to streamer's channel ────────────────────────────────
    const cleanStreamer = streamerName.replace(/[^a-zA-Z0-9_]/g, '');
    console.log(`DEBUG [watcher] ${username}: navigating to ${cleanStreamer}...`);
    await page.goto(`https://www.twitch.tv/${cleanStreamer}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(5000);

    // ── TAB 2: navigate inventoryPage to drops/inventory for ongoing monitoring
    if (inventoryPage) {
      inventoryPage.goto('https://www.twitch.tv/drops/inventory', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }

    // Click "Start Watching" button if present (mature content warning)
    try {
      const startBtn = await page.evaluateHandle(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent.trim().toLowerCase();
          if (text.includes('start watching') || text.includes('comenzar') || text.includes('assistir')) {
            return btn;
          }
        }
        return null;
      });
      if (startBtn && startBtn.asElement()) {
        await startBtn.asElement().click();
        console.log(`DEBUG [watcher] ${username}: clicked Start Watching`);
        await sleep(2000);
      }
    } catch (e) {}

    // Mute video
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) { video.muted = true; video.volume = 0; }
    }).catch(() => {});

    // Set lowest quality to save bandwidth
    try {
      // Click settings gear
      const settingsBtn = await page.$('[data-a-target="player-settings-button"]');
      if (settingsBtn) {
        await settingsBtn.click();
        await sleep(1000);
        // Click quality option
        const qualityBtn = await page.$('[data-a-target="player-settings-menu-item-quality"]');
        if (qualityBtn) {
          await qualityBtn.click();
          await sleep(1000);
          // Click lowest quality (last radio button)
          const qualityOptions = await page.$$('input[data-a-target="tw-radio"]');
          if (qualityOptions.length > 0) {
            await qualityOptions[qualityOptions.length - 1].click();
            console.log(`DEBUG [watcher] ${username}: set to lowest quality`);
          }
        }
      }
    } catch (e) {}

    // Check for drops on this stream
    try {
      const dropsInfo = await page.evaluate(() => {
        const body = document.body.innerText;
        // Look for drops indicators (multi-language)
        const hasDrops = /drops?\s*enabled|drop.*enabled|dropabilitati|rewards?\s*enabled|belohnungen|drop\s*actif|ödül|Drops\s*Activés|Drops\s*Activos|مُمكّن|Drop\s*enabled/i.test(body);
        // Look for specific drop campaign text
        const dropMatch = body.match(/watch\s*(?:for|to)\s*([^.\n]{5,60})/i);
        // Look for RLCS
        const hasRLCS = /RLCS/i.test(body);
        // Look for drop progress or claim button
        const claimBtn = document.querySelector('[data-a-target="drops-click-to-claim"]') ||
                         document.querySelector('button[data-a-target*="drop"]');
        const claiming = claimBtn ? true : false;
        // Look for "Drops" tab or section
        const dropsTab = document.querySelector('[data-a-target="drops-tab"]') ||
                         document.querySelector('a[href*="drops"]');
        // Look for drop-related elements near the player (reward banner, drop icon)
        const dropsBanner = document.querySelector('[data-a-target="drops-campaign-card"]') ||
                            document.querySelector('[data-a-target*="drops"]') ||
                            document.querySelector('[aria-label*="drop" i]');
        return { hasDrops, hasRLCS, campaignName: dropMatch ? dropMatch[1] : null, claiming, hasDropsTab: !!dropsTab, hasDropsBanner: !!dropsBanner };
      });
      
      if (dropsInfo.hasDrops || dropsInfo.hasRLCS || dropsInfo.hasDropsBanner) {
        console.log(`DEBUG [watcher] ${username}: drops ENABLED on ${cleanStreamer} ✅`);
        if (dropsInfo.hasRLCS) console.log(`DEBUG [watcher] ${username}: RLCS campaign detected`);
        if (dropsInfo.campaignName) console.log(`DEBUG [watcher] ${username}: drop campaign: ${dropsInfo.campaignName}`);
        if (dropsInfo.claiming) console.log(`DEBUG [watcher] ${username}: drop ready to CLAIM! 🎉`);
      } else {
        // Drops may not show on stream page — they're tracked in inventory
        console.log(`DEBUG [watcher] ${username}: drops indicator not visible on stream (will check inventory)`);
      }
      
    } catch(e) {
      console.log(`DEBUG [watcher] ${username}: drops check error: ${e.message}`);
    }

    // Send "hi" in chat to verify login (only logged-in users can chat)
    if (loggedIn) {
      try {
        await sleep(3000); // Wait for chat to load
        
        // Scroll chat to bottom first
        await page.evaluate(() => {
          const chatContainer = document.querySelector('[data-a-target="chat-scrollable-area"]') ||
                                document.querySelector('[class*="chat-scroll"]') ||
                                document.querySelector('[class*="chat-content"]');
          if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
        });
        await sleep(500);

        // Find and click the chat input
        const chatInput = await page.evaluateHandle(() => {
          // Try common chat input selectors
          return document.querySelector('[data-a-target="chat-input"]') ||
                 document.querySelector('textarea[data-a-target="chat-input"]') ||
                 document.querySelector('div[data-a-target="chat-input"]') ||
                 document.querySelector('[aria-label*="chat" i]') ||
                 document.querySelector('[aria-label*="message" i]') ||
                 document.querySelector('[aria-label*="mesaj" i]') ||
                 document.querySelector('[aria-label*="ensagem" i]') ||
                 document.querySelector('[placeholder*="message" i]') ||
                 document.querySelector('[placeholder*="chat" i]');
        });
        
        if (chatInput && chatInput.asElement()) {
          await chatInput.asElement().click();
          await sleep(500);
          await chatInput.asElement().focus();
          await sleep(300);
          await page.keyboard.type('hi', { delay: 80 });
          await sleep(300);
          await page.keyboard.press('Enter');
          await sleep(500);
          console.log(`DEBUG [watcher] ${username}: sent "hi" in chat ✅`);
        } else {
          console.log(`DEBUG [watcher] ${username}: chat input not found`);
        }
      } catch (e) {
        console.log(`DEBUG [watcher] ${username}: failed to send chat message: ${e.message}`);
      }
    }

    // Store watcher
    const startedAt = Date.now();
    activeWatchers[accId] = { browser, chromeProc, page, inventoryPage, streamer: cleanStreamer, username, startedAt, lastDropsCheck: 0, closeDropPending: false };
    delete launching[accId];

    // Save startedAt to account for persistence across restarts
    const state = require('./state');
    if (state.accounts[accId]) {
      state.accounts[accId].watchStartedAt = startedAt;
      state.saveAccounts();
    }

    // Keep-alive check every 5 minutes
    let keepAliveCount = 0;
    const keepAlive = setInterval(async () => {
      try {
        if (!activeWatchers[accId]) {
          clearInterval(keepAlive);
          return;
        }
        await page.evaluate(() => document.title).catch(() => { throw new Error('page dead'); });

        // Watch time tracking
        const uptimeMs = Date.now() - activeWatchers[accId].startedAt;
        const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
        const mins = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
        console.log(`DEBUG [watcher] ${username}: watching ${cleanStreamer} for ${hours}h ${mins}m`);

        // Notify discord for channel rename
        if (onWatcherUpdateCallback) {
          onWatcherUpdateCallback(accId, username, cleanStreamer, hours, mins);
        }

        // Take screenshot every 30 minutes (every 6 checks)
        keepAliveCount++;
  
        // Log milestones every hour
        if (mins === 0 && hours > 0 && hours <= 5) {
          console.log(`DEBUG [watcher] ${username}: ⏱ ${hours}/5 hours watched ${hours >= 5 ? '(drops eligible!)' : ''}`);
        }

        // ── TAB 2 drops check (Tab 1 / page stays on stream the whole time) ───
        // Normal interval: 15 min. If a drop is close to done (≤90 min left): 5 min.
        const dropCheckInterval = activeWatchers[accId].closeDropPending ? 5 * 60 * 1000 : 15 * 60 * 1000;
        if (Date.now() - activeWatchers[accId].lastDropsCheck >= dropCheckInterval) {
          activeWatchers[accId].lastDropsCheck = Date.now();
          const invPage = activeWatchers[accId].inventoryPage;
          if (invPage) try {
            console.log(`DEBUG [watcher] ${username}: checking drops inventory (Tab 2)...`);
            await invPage.goto('https://www.twitch.tv/drops/inventory', { waitUntil: 'domcontentloaded', timeout: 45000 });
            await sleep(5000);

            // Dismiss any modal
            await invPage.keyboard.press('Escape').catch(() => {});
            await sleep(1000);

            // Scroll to find claim buttons
            for (let i = 0; i < 5; i++) {
              await invPage.evaluate(() => window.scrollBy(0, 300));
              await sleep(500);
            }

            // Find claim buttons
            const claimBtnTexts = await invPage.evaluate(() => {
              const btns = [];
              for (const btn of document.querySelectorAll('button')) {
                if (btn.offsetParent === null) continue;
                const t = btn.textContent.trim().toLowerCase();
                const tAr = btn.textContent.trim();
                const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                const dt = (btn.getAttribute('data-a-target') || '').toLowerCase();
                const isClaim = t === 'claim' || t === 'claim now' || t === 'claim drop' ||
                  dt === 'claim-button' || label.includes('claim') ||
                  tAr.includes('المطالبة') || tAr.includes('ادعاء');
                const isConn = t.includes('connect') || t.includes('conectar') || t.includes('connecter') || t.includes('اتصال');
                if (isClaim && !isConn) btns.push(btn.textContent.trim());
              }
              return btns;
            });
            console.log(`DEBUG [watcher] ${username}: found ${claimBtnTexts.length} claimable drop(s)`);

            // Click ONE AT A TIME via real mouse click (React ignores synthetic btn.click())
            let claimedCount = 0;
            for (let ci = 0; ci < claimBtnTexts.length; ci++) {
              const btnRect = await invPage.evaluate(() => {
                for (const btn of document.querySelectorAll('button')) {
                  const t = btn.textContent.trim().toLowerCase();
                  const tAr = btn.textContent.trim();
                  const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                  const dt = (btn.getAttribute('data-a-target') || '').toLowerCase();
                  const isClaim = t === 'claim' || t === 'claim now' || t === 'claim drop' ||
                    dt === 'claim-button' || label.includes('claim') ||
                    tAr.includes('المطالبة') || tAr.includes('ادعاء');
                  const isConn = t.includes('connect') || t.includes('conectar') || t.includes('connecter') || t.includes('اتصال');
                  if (isClaim && !isConn) {
                    btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                    const r = btn.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: btn.textContent.trim() };
                  }
                }
                return null;
              }).catch(() => null);

              if (!btnRect) { console.log(`DEBUG [watcher] ${username}: no claim button found on iteration ${ci + 1}`); break; }

              await sleep(500);
              await invPage.mouse.click(btnRect.x, btnRect.y);
              console.log(`DEBUG [watcher] ${username}: clicked "${btnRect.text}" at (${Math.round(btnRect.x)}, ${Math.round(btnRect.y)})`);
              await sleep(10000);

              await invPage.evaluate(() => {
                document.querySelectorAll('[data-a-target="alert-modal-close"], [aria-label="Close"], button[aria-label*="close" i]').forEach(b => b.click());
              }).catch(() => {});
              await sleep(1000);

              const result = await invPage.evaluate(() => {
                const body = document.body.innerText;
                return { hasError: /Drop was not claimed|لم يتم المطالبة|حدث خطأ|Error Occurred/i.test(body) };
              }).catch(() => ({ hasError: false }));

              if (result.hasError) {
                console.log(`DEBUG [watcher] ${username}: ❌ "${btnRect.text}" FAILED`);
                await invPage.evaluate(() => {
                  document.querySelectorAll('[data-a-target="alert-modal-close"], [aria-label="Close"], button[aria-label*="close" i]').forEach(b => b.click());
                }).catch(() => {});
                await sleep(1500);
                break;
              } else {
                claimedCount++;
                console.log(`DEBUG [watcher] ${username}: ✅ "${btnRect.text}" claimed`);
                await sleep(3000);
              }
            }

            if (claimedCount > 0) {
              const prev = activeWatchers[accId].dropsClaimed || 0;
              activeWatchers[accId].dropsClaimed = prev + claimedCount;
              const stateRef = require('./state');
              if (stateRef.accounts[accId]) {
                stateRef.accounts[accId].dropsClaimed = (stateRef.accounts[accId].dropsClaimed || 0) + claimedCount;
                stateRef.saveAccounts();
              }
              console.log(`DEBUG [watcher] ${username}: 🎁 claimed ${claimedCount} drop(s) — stopping so next account can take over`);
              clearInterval(keepAlive);
              await stopWatching(accId);
              return;
            }

            // Read drop progress — correct parse: "87% of 4 hours" → pct=87, totalHours=4
            const dropProgress = await invPage.evaluate(() => {
              const results = [];
              const items = document.querySelectorAll('[data-a-target="drops-dashboard-collection-item"], [class*="drop-item"], [class*="inventory"]');
              for (const item of items) {
                const text = item.innerText || item.textContent || '';
                const m = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of|de|von|van|з|من)\s*(\d+(?:\.\d+)?)\s*(?:hours?|h\b|hrs?|heures?|Stunden?|horas?|ساعات?)/i);
                if (m) {
                  const pct = parseFloat(m[1]);         // e.g. 87
                  const totalHours = parseFloat(m[2]);  // e.g. 4
                  const remainingMinutes = Math.round(totalHours * (1 - pct / 100) * 60);
                  const name = text.split('\n')[0].trim().slice(0, 40) || 'Drop';
                  results.push({ name, pct, totalHours, remainingMinutes });
                }
              }
              return results;
            }).catch(() => []);

            let hasCloseDrops = false;
            for (const dp of dropProgress) {
              const remaining = `${dp.remainingMinutes}min left`;
              if (dp.pct >= 100) {
                console.log(`DEBUG [watcher] ${username}: 🎁 ${dp.name} — ${dp.pct}% (READY!)`);
              } else {
                console.log(`DEBUG [watcher] ${username}: ⏱ ${dp.name} — ${dp.pct}% of ${dp.totalHours}h (${remaining})`);
                // Smart stay: if ≤90 min remaining, flag as close — check every 5 min, don't rotate
                if (dp.remainingMinutes <= 90) {
                  hasCloseDrops = true;
                  console.log(`DEBUG [watcher] ${username}: 🏁 ${dp.name} is close! Staying until it's done (${remaining})`);
                }
              }
            }
            activeWatchers[accId].closeDropPending = hasCloseDrops;

            // Tab 1 (page) never left the stream — no need to navigate back
          } catch (dropsErr) {
            console.log(`DEBUG [watcher] ${username}: drops check error: ${dropsErr.message}`);
          }
        }
      } catch (e) {
        console.log(`DEBUG [watcher] ${username}: connection lost, stopping`);
        clearInterval(keepAlive);
        await stopWatching(accId);
      }
    }, 5 * 60 * 1000); // Check every 5 minutes

    activeWatchers[accId].keepAliveInterval = keepAlive;

    return { started: true, streamer: cleanStreamer, account: username };
  } catch (err) {
    delete launching[accId];
    try { await browser.close(); } catch (e) {}
    if (chromeProc) try { chromeProc.kill(); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    throw err;
  }
}

async function stopWatching(accId) {
  const w = activeWatchers[accId];
  if (!w) return false;
  const streamer = w.streamer;
  if (w.keepAliveInterval) clearInterval(w.keepAliveInterval);
  try { await w.browser.close(); } catch {}
  if (w.chromeProc) try { w.chromeProc.kill(); } catch {}
  try { fs.rmSync(path.join(__dirname, '../tmp_profiles/watcher_' + accId + '_*'), { recursive: true, force: true }); } catch(e) {}
  delete activeWatchers[accId];
  // Clear persistence
  const state = require('./state');
  if (state.accounts[accId]) {
    state.accounts[accId].watchStartedAt = null;
    state.accounts[accId].watching = null;
    state.saveAccounts();
  }
  console.log(`DEBUG [watcher] Stopped watching for ${w.username || accId}`);
  // Notify callback for auto-replace
  if (onWatcherStopCallback) {
    try { onWatcherStopCallback(streamer, accId); } catch (e) {}
  }
  return true;
}

function getWatcherIds() {
  return Object.keys(activeWatchers);
}

function isWatching(accId) {
  return !!activeWatchers[accId];
}

function getWatchers() {
  return Object.entries(activeWatchers).map(([id, w]) => {
    const uptimeMs = Date.now() - w.startedAt;
    const hours = (uptimeMs / (1000 * 60 * 60)).toFixed(1);
    return {
      accountId: id,
      streamer: w.streamer,
      username: w.username,
      watchingSince: new Date(w.startedAt).toISOString(),
      uptime: formatUptime(uptimeMs),
      hoursWatched: parseFloat(hours),
      dropsClaimed: w.dropsClaimed || 0,
    };
  });
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Resume watching for accounts that were watching before restart
async function resumeWatchers() {
  const state = require('./state');
  const accounts = state.accounts;
  let resumed = 0;
  for (const [id, acc] of Object.entries(accounts)) {
    if (acc.watching && acc.cookies && acc.cookies.length > 0 && !activeWatchers[id]) {
      console.log(`DEBUG [watcher] Resuming ${acc.twitchData?.username || acc.username} on ${acc.watching}...`);
      try {
        await watchStream(id, acc.watching);
        // Restore startedAt from saved time
        if (acc.watchStartedAt) {
          activeWatchers[id].startedAt = acc.watchStartedAt;
        }
        resumed++;
        console.log(`DEBUG [watcher] Resumed ${acc.twitchData?.username || acc.username} ✅`);
        await sleep(10000); // Delay between resumes
      } catch (e) {
        console.log(`DEBUG [watcher] Failed to resume ${acc.twitchData?.username || acc.username}: ${e.message}`);
        acc.watching = null;
        acc.watchStartedAt = null;
        state.saveAccounts();
      }
    }
  }
  if (resumed > 0) console.log(`DEBUG [watcher] Resumed ${resumed} watcher(s)`);
  return resumed;
}

module.exports = { watchStream, stopWatching, getWatchers, getWatcherIds, isWatching, setOnWatcherStop, setOnWatcherUpdate, resumeWatchers, launching };
