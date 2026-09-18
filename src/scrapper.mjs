import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const stealth = require('./stealth/index.js');

import { generateString } from './functions/stringGenerator.js';
import { clickButton, getSignUpButton } from './functions/buttons.js';
import getMailPageInfo from './functions/mailPageInfo.js';
import determineForm from './functions/forms.js';

const createAccount = async (
  nickname = null,
  password = null
) => {
  let returnData, browser = null, error = null;
  try {
    // Late-CDP: Chrome opens twitch.tv clean, KPSDK runs challenge undetected,
    // then we connect CDP after the delay and get the already-open Twitch page.
    const { browser: _browser, page: twitch, fingerprint } = await stealth.launch({
      kpsdkDelay: 12000,
    });
    browser = _browser;

    // Open temp-mail in a new tab
    const mailPage = await stealth.newStealthPage(browser, fingerprint);
    await mailPage.goto("https://temp-mail.org/en/10minutemail");

    let mailPageInfo = await getMailPageInfo(mailPage);
    if (!mailPageInfo) {
      error = {status: 400, data: {message: 'Mail not found', restart: false}};
      throw new Error("Mail not found");
    }
    const email = mailPageInfo.mailbox.trim();

    nickname = nickname ?? generateString(12);
    password = password ?? generateString(12) + 'aA1!';

    await twitch.bringToFront();

    const signUpButton = await getSignUpButton(twitch);
    await clickButton(signUpButton, "Sign Up");

    const form = await determineForm(twitch);
    await form.fill(twitch, nickname, password, email);

    await twitch.waitForSelector('button[type="submit"]:not([disabled])');
    const submit = await twitch.$('button[type="submit"]:not([disabled])');
    await clickButton(submit, "Form submit");

    await new Promise(r => setTimeout(r, 3000));

    const alertText = await twitch.evaluate(() => {
      const els = document.querySelectorAll('[role=alert]');
      return Array.from(els).map(e => e.textContent.trim().toLowerCase()).join(' ');
    });
    const isKasadaBlock = alertText.includes('browser not currently supported') ||
                          alertText.includes('browser is not currently supported') ||
                          alertText.includes('not currently supported');
    if (isKasadaBlock) {
      error = {status: 400, data: {message: 'Browser not supported', restart: true}};
      throw new Error("Browser not supported");
    }

    await mailPage.bringToFront();
    do {
      mailPageInfo = await getMailPageInfo(mailPage);
    } while (!mailPageInfo.messages[0] || !mailPageInfo.messages[0].subject)
    const verificationCode = await mailPageInfo.messages[0].subject.substring(0, 6);

    returnData = {status: 200, data: {nickname: nickname, password: password, verificationCode: verificationCode}};

  } catch (err) {
    console.error("An error occurred:", err);
  } finally {
    if (browser !== null) {
      await browser.close().catch(() => {});
    }
  }

  return error ? error : returnData;
};

export default createAccount;
