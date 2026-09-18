// ==UserScript==
// @name         Twitch Bot Controller
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Controls browser via API polling
// @author       You
// @match        https://*.twitch.tv/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    const API = 'http://localhost:6767';
    const POLL_INTERVAL = 2000;
    let tabId = null;
    let cmdId = 0;
    const pending = {};

    // Override navigator.webdriver and other automation signals
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: false });
    Object.defineProperty(Navigator.prototype, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: false });
    Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['en-US', 'en'], configurable: false });
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32', configurable: false });
    Object.defineProperty(Navigator.prototype, 'vendor', { get: () => 'Google Inc.', configurable: false });
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, configurable: false });
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: false });

    async function poll() {
        try {
            const res = await fetch(`${API}/api/extension/next-cmd`);
            if (!res.ok) { setTimeout(poll, POLL_INTERVAL); return; }
            const cmd = await res.json();
            const result = await execute(cmd);
            await fetch(`${API}/api/extension/cmd-result`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: cmd.id, result }),
            });
        } catch (e) {
            // server might not be ready yet
        }
        setTimeout(poll, POLL_INTERVAL);
    }

    async function execute(cmd) {
        switch (cmd.action) {
            case 'getInfo':
                return {
                    url: location.href,
                    bodyText: (document.body?.innerText || '').slice(0, 1000),
                    inputs: Array.from(document.querySelectorAll('input')).map(i => ({ id: i.id, type: i.type, val: i.value.slice(0, 20) })),
                    buttons: Array.from(document.querySelectorAll('button')).map(b => ({ text: b.textContent.trim().slice(0, 50) })),
                    errors: Array.from(document.querySelectorAll('[data-a-target*="error"],[class*="error"],[role="alert"]')).map(e => e.textContent.trim()).filter(Boolean),
                };
            case 'type':
                const el = document.querySelector(cmd.selector);
                if (!el) return { error: 'not found' };
                el.focus(); el.value = '';
                for (const ch of cmd.value) {
                    el.value += ch;
                    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
                }
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true };
            case 'click':
                const btn = document.querySelector(cmd.selector);
                if (!btn) return { error: 'not found' };
                btn.click();
                return { ok: true };
            case 'select':
                const sels = document.querySelectorAll('select');
                if (!sels[cmd.index]) return { error: 'not found' };
                sels[cmd.index].value = cmd.value;
                sels[cmd.index].dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true };
            case 'eval':
                try { return { result: eval(cmd.code) }; } catch(e) { return { error: e.message }; }
            case 'wait':
                await new Promise(r => setTimeout(r, cmd.ms));
                return { ok: true };
            default:
                return { error: 'unknown: ' + cmd.action };
        }
    }

    // Start polling
    setTimeout(poll, 3000);
})();
