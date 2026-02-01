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
                    maxWidth: '300px', wordBreak: 'break-all',
                    pointerEvents: 'none'
                });
                document.body.appendChild(el);
            }
            el.style.backgroundColor = type === 'error' ? '#e74c3c' : (type === 'success' ? '#2ecc71' : '#3498db');
            el.textContent = text;
            el.style.opacity = '1';
            el.style.pointerEvents = 'auto';
            console.log(`[SendInvite] ${text}`);
        },
        hide: (delay = 5000) => {
            const el = document.getElementById(UI.id);
            if (el) setTimeout(() => {
                el.style.opacity = '0';
                el.style.pointerEvents = 'none';
            }, delay);
        }
    };

    // --- Telegram Sender ---
    function sendTelegram(message) {
        const apiBase = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/`;

        const request = (method, data) => {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: apiBase + method,
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify(data),
                    onload: (res) => {
                        if (res.status >= 400) {
                            console.error(`[SendInvite] Telegram Error (${method}):`, res.responseText);
                            reject(res);
                        } else {
                            resolve(JSON.parse(res.responseText));
                        }
                    },
                    onerror: reject
                });
            });
        };

        // Flow: Private -> Forward -> Public (if Private ID set), else Direct Public
        if (CONFIG.TELEGRAM_PRIVATE_ID) {
            // 1. Send to Private
            request('sendMessage', {
                chat_id: CONFIG.TELEGRAM_PRIVATE_ID,
                text: message,
                parse_mode: "HTML",
                disable_web_page_preview: true
            }).then(res => {
                const privMsgId = res.result.message_id;
                // 2. Forward to Public
                return request('forwardMessage', {
                    chat_id: CONFIG.TELEGRAM_PUBLIC_ID,
                    from_chat_id: CONFIG.TELEGRAM_PRIVATE_ID,
                    message_id: privMsgId
                }).then(fwdRes => {
                    // Store Public Message ID for later deletion
                    GM_setValue(CONFIG.LAST_MSG_ID, fwdRes.result.message_id);
                    console.log('[SendInvite] Message forwarded to public.');
                    // 3. Delete Private Message
                    return request('deleteMessage', {
                        chat_id: CONFIG.TELEGRAM_PRIVATE_ID,
                        message_id: privMsgId
                    });
                });
            }).catch(err => console.error('[SendInvite] Telegram send failed:', err));

        } else {
            // Direct Send
            request('sendMessage', {
                chat_id: CONFIG.TELEGRAM_PUBLIC_ID,
                text: message,
                parse_mode: "HTML",
                disable_web_page_preview: true
            }).then(res => {
                GM_setValue(CONFIG.LAST_MSG_ID, res.result.message_id);
                console.log('[SendInvite] Telegram sent successfully.');
            }).catch(err => console.error('[SendInvite] Telegram send failed:', err));
        }
    }

    // --- Core Logic ---
    async function getInvite() {
        const nextRun = GM_getValue(CONFIG.EXPIRY_DATE, 0);
        const lastInvite = GM_getValue(CONFIG.INVITE_LINK, null);
        const now = Date.now();

        // Check if we need to delete old message (expired)
        const lastMsgId = GM_getValue(CONFIG.LAST_MSG_ID, null);
        if (now >= nextRun && lastMsgId) {
            GM_xmlhttpRequest({
                method: "POST",
                url: `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/deleteMessage`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ chat_id: CONFIG.TELEGRAM_PUBLIC_ID, message_id: lastMsgId }),
                onload: () => {
                    console.log('[SendInvite] Expired message deleted.');
                    GM_setValue(CONFIG.LAST_MSG_ID, null); // Clear ID
                }
            });
        }

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
        else if (now >= nextRun) {
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
        if (inviteLink && expiryDateObj) {
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

        // Period check function
        const checkAndRun = () => {
            const nextRun = GM_getValue(CONFIG.EXPIRY_DATE, 0);
            const now = Date.now();

            const lastMsgId = GM_getValue(CONFIG.LAST_MSG_ID, null);
            if (now >= nextRun && lastMsgId) {
                getInvite();
            } else if (now >= nextRun) {
                getInvite();
            }
        };

        checkAndRun();
        setInterval(checkAndRun, 60000);
    }

    window.addEventListener('load', init);
})();