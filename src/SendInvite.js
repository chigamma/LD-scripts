// ==UserScript==
// @name         Linux.do Send Invite
// @namespace    https://linux.do/
// @version      1.0
// @description  Auto-generate invites.
// @author       ChiGamma
// @match        https://linux.do/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const CONFIG = {
        TELEGRAM_BOT_TOKEN: 'null', // example: 1234567890:ABCdef1234567890
        TELEGRAM_CHAT_ID: 'null', // example: -1001234567890
        EXPIRY_DATE: 'null',
        INVITE_LINK: 'null' // example: https://linux.do/invites/1234567890
    };

    // --- UI Helper ---
    const UI = {
        id: 'linuxdo-invite-status',
        show: (text, type = 'info') => {
            let el = document.getElementById(UI.id);
            if (!el) {
                el = document.createElement('div');
                el.id = UI.id;
                Object.assign(el.style, {
                    position: 'fixed', top: '20px', right: '20px',
                    padding: '12px 18px', borderRadius: '8px',
                    color: '#fff', fontSize: '13px', zIndex: '9999',
                    fontFamily: 'Segoe UI, sans-serif',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                    transition: 'opacity 0.3s',
                    maxWidth: '300px', wordBreak: 'break-all'
                });
                document.body.appendChild(el);
            }
            el.style.backgroundColor = type === 'error' ? '#e74c3c' : (type === 'success' ? '#2ecc71' : '#3498db');
            el.textContent = text;
            el.style.opacity = '1';
            console.log(`[SendInvite] ${text}`);
        },
        hide: (delay = 5000) => {
            const el = document.getElementById(UI.id);
            if (el) setTimeout(() => { el.style.opacity = '0'; }, delay);
        }
    };

    // --- Telegram Sender ---
    function sendTelegram(message) {
        GM_xmlhttpRequest({
            method: "POST",
            url: `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                chat_id: CONFIG.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: "HTML",
                disable_web_page_preview: true
            }),
            onload: (res) => {
                if(res.status >= 400) console.error('[SendInvite] Telegram Error:', res.responseText);
                else console.log('[SendInvite] Telegram sent successfully.');
            },
            onerror: (err) => console.error('[SendInvite] Telegram Request Failed:', err)
        });
    }

    // --- Core Logic ---
    async function getInvite() {
        const nextRun = GM_getValue(CONFIG.EXPIRY_DATE, 0);
        const lastInvite = GM_getValue(CONFIG.INVITE_LINK, null);
        const now = Date.now();

        let inviteLink = null;
        let expiryDateObj = null;

        // ---------------------------------------------------------
        // 1. DETERMINE SOURCE
        // ---------------------------------------------------------
        if (now < nextRun && lastInvite) {
            // -- USE CACHE --
            inviteLink = lastInvite;
            expiryDateObj = new Date(nextRun - 60000);
        }
        else {
            // -- USE API --
            const csrfMeta = document.querySelector('meta[name="csrf-token"]');
            const csrfToken = csrfMeta ? csrfMeta.content : '';

            if (!csrfToken) {
                UI.show('Error: CSRF token not found.', 'error');
                UI.hide();
                return;
            }

            const requestExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
            const formData = new URLSearchParams();
            formData.append('max_redemptions_allowed', '1');
            formData.append('expires_at', requestExpiry);

            try {
                const response = await fetch('https://linux.do/invites', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-CSRF-Token': csrfToken,
                        'Accept': 'application/json'
                    },
                    credentials: 'include',
                    body: formData
                });

                const json = await response.json();

                if (response.ok && json.link) {
                    inviteLink = json.link;

                    if (json.expires_at) {
                        expiryDateObj = new Date(json.expires_at);

                        // Update Storage
                        GM_setValue(CONFIG.INVITE_LINK, inviteLink);
                        GM_setValue(CONFIG.EXPIRY_DATE, expiryDateObj.getTime() + 60000);
                    }
                } else {
                    if (json.error_type === 'rate_limit' && json.extras && json.extras.wait_seconds) {
                        const waitSeconds = json.extras.wait_seconds;
                        GM_setValue(CONFIG.EXPIRY_DATE, Date.now() + (waitSeconds * 1000));
                        UI.show(`Rate Limit: Wait ${(waitSeconds / 3600).toFixed(1)}h`, 'info');
                    } else {
                        UI.show(`API Error: ${JSON.stringify(json.errors || 'Unknown')}`, 'error');
                    }
                    UI.hide();
                    return;
                }
            } catch (e) {
                UI.show(`Network Error: ${e.message}`, 'error');
                UI.hide();
                return;
            }
        }

        // ---------------------------------------------------------
        // 2. FINALIZE: DISPLAY & SEND
        // ---------------------------------------------------------
        if (inviteLink) {
            UI.show(`Link Ready: ${inviteLink}`, 'success');

            const expiryStr = expiryDateObj ? expiryDateObj.toLocaleString('zh-CN', { hour12: false }) : 'Unknown';
            const message = `邀请链接：\n<code>${inviteLink}</code>\n有效期：\n${expiryStr}`;

            sendTelegram(message);
            UI.hide(6000);
        }
    }

    // --- Scheduler ---
    function init() {
        GM_registerMenuCommand("手动触发", () => getInvite());

        const nextRun = GM_getValue(CONFIG.EXPIRY_DATE, 0);
        const now = Date.now();

        if (now >= nextRun) {
            getInvite();
        } else {
            console.log(`[SendInvite] Idle. Next run: ${new Date(nextRun).toLocaleString()}`);
        }
    }

    window.addEventListener('load', init);
})();