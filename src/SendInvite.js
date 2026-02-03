// ==UserScript==
// @name         Linux.do 更新邀请码
// @name:en      Linux.do Send Invite
// @namespace    https://linux.do/
// @version      1.1
// @description  自动更新邀请码
// @description:en Auto-generate invites.
// @author       ChiGamma
// @license      Fair License
// @match        https://linux.do/*
// @match        https://cdk.linux.do/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const CONFIG = {
        // >>> Telegram Configuration <<<
        //     Target group ID (* required to enable)
        TELEGRAM_PUBLIC_ID: '', // example: '-1001234567890'
        //     Target private group ID (optional): you can use a private group to hide the bot address
        TELEGRAM_PRIVATE_ID: '', // example: '-1001234567890'
        //     Bot token (* required to enable)
        TELEGRAM_BOT_TOKEN: '', // example: '1234567890:ABCdef1234567890'

        // >>> CDK Configuration <<<
        //     CDK link (* required >0 to enable)
        CDK_MIN_SCORE: 0, // Minimum CDK score

        // >>> LDStore Configuration <<<
        //     Login Token (* required to enable)
        LDSTORE_TOKEN: '', // Bearer Token format: 'eyJ***.eyJ***.***'
        //     Store Product link (* required to enable)
        LDSTORE_PRODUCT_LINK: '' // example: 'https://ldst0re.qzz.io/product/1'
    };

    // --- Log Helper ---
    const Logger = {
        log: (msg) => console.log(`[SendInvite] ${msg}`),
        error: (msg, err) => console.error(`[SendInvite] ${msg}`, err || '')
    };

    // --- Services Status ---
    const Services = {
        TG: {
            get enabled() { return !!CONFIG.TELEGRAM_PUBLIC_ID && !!CONFIG.TELEGRAM_BOT_TOKEN; },
            get messageId() { return GM_getValue('TELEGRAM_LAST_ID', null); },
            set messageId(val) { GM_setValue('TELEGRAM_LAST_ID', val); }
        },
        CDK: {
            get enabled() { return CONFIG.CDK_MIN_SCORE > 0; }
        },
        LDS: {
            get enabled() { return !!CONFIG.LDSTORE_PRODUCT_LINK && !!CONFIG.LDSTORE_TOKEN; },
            get apiUrl() {
                const match = CONFIG.LDSTORE_PRODUCT_LINK.match(/product\/(\d+)/);
                return match ? `https://api.ldspro.qzz.io/api/shop/products/${match[1]}` : null;
            },
            get lastId() { return GM_getValue('LDSTORE_LAST_ID', null); },
            set lastId(val) { GM_setValue('LDSTORE_LAST_ID', val); }
        }
    };

    // --- CDK Bridge Logic (Run on cdk.linux.do) ---
    if (location.hostname === 'cdk.linux.do') {
        const ALLOWED_ORIGINS = ['https://linux.do'];
        window.addEventListener('message', async (e) => {
            if (!ALLOWED_ORIGINS.includes(e.origin) || e.data?.type !== 'ldsp-cdk-request') return;

            const { requestId, url, options } = e.data;
            try {
                const res = await fetch(url, { ...options, credentials: 'include' });
                let data;
                try { data = await res.json(); } catch { data = { _error: 'Parse Error' }; }

                window.parent?.postMessage({
                    type: 'ldsp-cdk-response',
                    requestId,
                    status: res.status,
                    data
                }, e.origin);
            } catch (err) {
                window.parent?.postMessage({
                    type: 'ldsp-cdk-response',
                    requestId,
                    status: 0,
                    data: { _error: 'Network Error' }
                }, e.origin);
            }
        });
        return;
    }

    // --- UI Helper ---
    const UI = {
        id: 'linuxdo-invite-status',
        show: (text, type = 'info') => {
            let el = document.getElementById(UI.id);
            if (!el) {
                el = document.createElement('div');
                el.id = UI.id;
                Object.assign(el.style, { position: 'fixed', top: '20px', right: '20px', padding: '12px 18px', borderRadius: '8px', color: '#fff', fontSize: '13px', zIndex: '9999', fontFamily: 'Segoe UI, sans-serif', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', transition: 'opacity 0.3s', maxWidth: '300px', wordBreak: 'break-all', pointerEvents: 'none' });
                document.body.appendChild(el);
            }
            el.style.backgroundColor = type === 'error' ? '#e74c3c' : (type === 'success' ? '#2ecc71' : '#3498db');
            el.textContent = text;
            el.style.opacity = '1';
            el.style.pointerEvents = 'auto';
            setTimeout(() => { el.style.opacity = '0'; el.style.pointerEvents = 'none'; }, 3000);
            Logger.log(`> ${text}`);
        }
    };

    // --- CDK Integration ---
    const CDK_HOST = 'https://cdk.linux.do';
    const CDK = {
        iframeId: 'linuxdo-invite-cdk-bridge',
        bridgeReady: false,

        init: () => {
            if (!Services.CDK.enabled || document.getElementById(CDK.iframeId)) return Promise.resolve();
            return new Promise((resolve) => {
                const iframe = document.createElement('iframe');
                iframe.id = CDK.iframeId;
                iframe.src = `${CDK_HOST}/project`;
                iframe.style.display = 'none';
                iframe.onload = () => {
                    CDK.bridgeReady = true;
                    Logger.log('CDK Bridge initialized.');
                    resolve();
                };
                iframe.onerror = () => {
                    Logger.error('CDK Bridge failed.');
                    resolve();
                };
                document.body.appendChild(iframe);
            });
        },

        request: (url, options = {}, responseValidator = null) => {
            return new Promise(async (resolve, reject) => {
                if (!CDK.bridgeReady) await new Promise(r => setTimeout(r, 1000));
                const iframe = document.getElementById(CDK.iframeId);
                if (!iframe) return reject('Bridge not found');

                const requestId = Date.now().toString(36) + Math.random().toString(36).substring(2);

                const handler = (e) => {
                    if (e.data?.type === 'ldsp-cdk-response' && e.data.requestId === requestId) {
                        if (responseValidator && !responseValidator(e.data.data)) return;
                        window.removeEventListener('message', handler);
                        e.data.status >= 200 && e.data.status < 300 ? resolve(e.data.data) : reject(e.data.data);
                    }
                };

                window.addEventListener('message', handler);
                setTimeout(() => { window.removeEventListener('message', handler); reject('Timeout'); }, 10000);

                iframe.contentWindow.postMessage({ type: 'ldsp-cdk-request', requestId, url, options }, CDK_HOST);
            });
        },

        process: async (code, startTimeIso, endTimeIso) => {
            if (!Services.CDK.enabled) return null;

            const payload = {
                name: `邀请码-${new Date().toLocaleString('zh-CN', {month: '2-digit', day: '2-digit'})}`,
                project_tags: ["邀请码"],
                start_time: startTimeIso,
                end_time: endTimeIso,
                minimum_trust_level: 1,
                allow_same_ip: false,
                risk_level: 100 - CONFIG.CDK_MIN_SCORE,
                distribution_type: 0,
                project_items: [code]
            };

            const check = (data) => data?.data?.projectId !== undefined;

            try {
                const res = await CDK.request(`${CDK_HOST}/api/v1/projects`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }, check);

                if (res?.data?.projectId) {
                    Logger.log(`CDK Project created: ${res.data.projectId}`);
                    return res.data.projectId;
                }
            } catch (e) {
                Logger.error('CDK Creation Error:', e);
            }
            return null;
        }
    };

    // --- LDStore Integration ---
    const LDStore = {
        api: (method, endpoint, data = null) => {
            return new Promise((resolve, reject) => {
                const apiUrl = Services.LDS.apiUrl;
                if (!apiUrl) return reject('Invalid product link');

                GM_xmlhttpRequest({
                    method: method,
                    url: `${apiUrl}${endpoint}`,
                    timeout: 5000,
                    headers: {
                        'accept': 'application/json',
                        'content-type': 'application/json',
                        'authorization': `Bearer ${CONFIG.LDSTORE_TOKEN}`
                    },
                    data: data ? JSON.stringify(data) : null,
                    onload: (res) => {
                        try { resolve(JSON.parse(res.responseText)); }
                        catch (e) {
                            Logger.error('JSON Parse Error', e);
                            reject('JSON Parse Error');
                        }
                    },
                    onerror: (e) => {
                        Logger.error('LDStore Error', e);
                        reject('LDStore Error');
                    }
                });
            });
        },

        process: async (code) => {
            if (!Services.LDS.enabled) return null;

            // Check for existing upload
            if (Services.LDS.lastId) return Services.LDS.lastId;

            try {
                const res = await LDStore.api('POST', '/cdk', { codes: [code] });

                if (!res.success) throw new Error(res.message || 'Upload failed');

                // Retrieve ID
                await new Promise(r => setTimeout(r, 10000));
                const listRes = await LDStore.api('GET', '/cdk?page=1');
                const item = listRes.data?.cdks?.find(i => i.code === code);

                if (item?.id) {
                    Services.LDS.lastId = item.id;
                    Logger.log(`LDStore Item ID: ${item.id}`);
                    return item.id;
                }
            } catch (e) {
                Logger.error('LDStore Error:', e);
            }
            return null;
        },

        clean: async (id) => {
            if (!Services.LDS.enabled || !id) return;
            try {
                await LDStore.api('DELETE', `/cdk/${id}`);
                Logger.log(`LDStore Cleaned ID: ${id}`);
                Services.LDS.lastId = null;
            } catch (e) {
                Logger.error('LDStore Cleanup Error', e);
            }
        }
    };

    // --- Telegram Integration ---
    const Telegram = {
        send: async (msg) => {
            if (!Services.TG.enabled) return;
            const api = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/`;

            const req = (endpoint, body) => new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST', url: api + endpoint,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify(body),
                    onload: r => r.status < 400 ? resolve(JSON.parse(r.responseText)) : reject(r.responseText),
                    onerror: reject
                });
            });

            try {
                let msgId;
                if (CONFIG.TELEGRAM_PRIVATE_ID) {
                    const priv = await req('sendMessage', {
                        chat_id: CONFIG.TELEGRAM_PRIVATE_ID, text: msg, parse_mode: 'HTML'
                    });
                    const fwd = await req('forwardMessage', {
                        chat_id: CONFIG.TELEGRAM_PUBLIC_ID, from_chat_id: CONFIG.TELEGRAM_PRIVATE_ID, message_id: priv.result.message_id
                    });
                    await req('deleteMessage', { chat_id: CONFIG.TELEGRAM_PRIVATE_ID, message_id: priv.result.message_id });
                    msgId = fwd.result.message_id;
                } else {
                    const res = await req('sendMessage', {
                        chat_id: CONFIG.TELEGRAM_PUBLIC_ID, text: msg, parse_mode: 'HTML'
                    });
                    msgId = res.result.message_id;
                }

                Services.TG.messageId = msgId;
                Logger.log('Telegram message sent.');
            } catch (e) {
                Logger.error('Telegram Send Error', e);
            }
        },

        clean: () => {
            const msgId = Services.TG.messageId;
            if (!Services.TG.enabled || !msgId) return;
            GM_xmlhttpRequest({
                method: "POST",
                url: `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/deleteMessage`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ chat_id: CONFIG.TELEGRAM_PUBLIC_ID, message_id: msgId }),
                onload: () => {
                    Services.TG.messageId = null;
                    Logger.log('Telegram message deleted.');
                }
            });
        }
    };

    // --- Main Logic ---
    async function run() {
        const now = Date.now();
        const nextRun = GM_getValue('EXPIRY_DATE', 0);
        const lastInvite = GM_getValue('INVITE_LINK', null);

        // Cleanup
        if (now >= nextRun) {
            Telegram.clean();
            LDStore.clean(Services.LDS.lastId);
        }

        let inviteLink = null;
        let expiry = null;

        // Fetch or Cache
        if (now < nextRun && lastInvite) {
            inviteLink = lastInvite;
            expiry = new Date(nextRun - 60000);
        } else {
            const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
            if (!csrf) {
                Logger.error("CSRF Token missing");
                return;
            }

            try {
                const formData = new URLSearchParams();
                formData.append('max_redemptions_allowed', '1');
                formData.append('expires_at', new Date(now + 86400000).toISOString().replace('T', ' ').substring(0, 19));

                const res = await fetch('https://linux.do/invites', {
                    method: 'POST',
                    headers: { 'Accept': 'application/json', 'X-CSRF-Token': csrf },
                    body: formData,
                    credentials: 'include'
                });
                const json = await res.json();

                if (json.link) {
                    inviteLink = json.link;
                    expiry = new Date(json.expires_at);
                    GM_setValue('INVITE_LINK', inviteLink);
                    GM_setValue('EXPIRY_DATE', expiry.getTime() + 60000);
                    Services.LDS.lastId = null;
                } else if (json.error_type === 'rate_limit') {
                    const wait = (json.extras.wait_seconds * 1000) + now;
                    GM_setValue('EXPIRY_DATE', wait);
                    UI.show(`Rate Limit: ${new Date(wait).toLocaleTimeString()}`, 'info');

                    try {
                        const username = JSON.parse(JSON.parse(document.getElementById('data-preloaded').dataset.preloaded).currentUser).username;
                        const pendingRes = await fetch(`https://linux.do/u/${username}/invited.json?filter=pending&offset=0`, {
                            headers: { 'Accept': 'application/json', 'X-CSRF-Token': csrf },
                            credentials: 'include'
                        });
                        const pendingJson = await pendingRes.json();
                        if (pendingJson.invites?.length > 0) {
                            const pending = pendingJson.invites[0];
                            inviteLink = pending.link;
                            expiry = new Date(pending.expires_at);
                            GM_setValue('INVITE_LINK', inviteLink);
                            Logger.log(`Using pending invite: ${inviteLink}`);
                        } else {
                            Logger.log('No pending invites found');
                            GM_setValue('INVITE_LINK', 'Comeback tomorrow!');
                        }
                    } catch (e) {
                        Logger.error('Failed to fetch pending invites', e);
                        GM_setValue('INVITE_LINK', 'Comeback tomorrow!');
                    }
                } else {
                    UI.show('Failed to generate invite', 'error');
                    Logger.error('API Error', json);
                    return;
                }
            } catch (e) {
                Logger.error('Fetch Error', e);
                UI.show('Network/Fetch Error', 'error');
                return;
            }
        }

        // Processing
        if (inviteLink && expiry) {
            UI.show(`Link: ${inviteLink.split('/').pop()}`, 'success');

            const dateStr = expiry.toLocaleString('zh-CN', {weekday: 'short', hour: '2-digit', minute:'2-digit'});
            let message = `邀请链接（${dateStr}前有效）：\n<code>${inviteLink}</code>`;

            // CDK
            if (Services.CDK.enabled) {
                const cdkId = await CDK.process(inviteLink, new Date().toISOString(), expiry.toISOString());
                if (cdkId) message += `\n<a href="${CDK_HOST}/receive/${cdkId}">CDK</a>`;
            }

            // LDStore
            if (Services.LDS.enabled) {
                await LDStore.process(inviteLink);
                if (Services.LDS.lastId) message += `\n<a href="${CONFIG.LDSTORE_PRODUCT_LINK}">LDStore</a>`;
            }

            // Telegram
            if (Services.TG.enabled) {
                Telegram.send(message);
            }

            GM_setClipboard(inviteLink);
        }
    }

    // --- Init ---
    function init() {
        Logger.log(`Init - CDK: ${Services.CDK.enabled}, LDS: ${Services.LDS.enabled}, TG: ${Services.TG.enabled}`);

        GM_registerMenuCommand("手动触发", run);

        if (Services.CDK.enabled) CDK.init();

        const scheduler = () => {
            const now = Date.now();
            const next = GM_getValue('EXPIRY_DATE', 0);
            if (now >= next) run();
        };

        setTimeout(scheduler, 20000);
        setInterval(scheduler, 60000);
    }

    window.addEventListener('load', init);
})();
