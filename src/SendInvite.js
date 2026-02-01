// ==UserScript==
// @name         Linux.do Send Invite
// @namespace    https://linux.do/
// @version      1.0
// @description  Auto-generate invites.
// @author       ChiGamma
// @match        https://linux.do/*
// @match        https://cdk.linux.do/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const CONFIG = {
        TELEGRAM_BOT_TOKEN: '', // example: '1234567890:ABCdef1234567890'
        TELEGRAM_PRIVATE_ID: '', // example: '-1001234567890'
        TELEGRAM_PUBLIC_ID: '', // example: '-1001234567890'
        EXPIRY_DATE: 0,
        INVITE_LINK: '', // example: 'https://linux.do/invites/1234567890'
        LAST_MSG_ID: '',
        ENABLE_CDK: false
    };

    // --- CDK Bridge Logic (Run on cdk.linux.do) ---
    if (location.hostname === 'cdk.linux.do') {
        const ALLOWED_ORIGINS = ['https://linux.do'];
        window.addEventListener('message', async (e) => {
            if (!ALLOWED_ORIGINS.includes(e.origin) || e.data?.type !== 'ldsp-cdk-request') {
                return;
            }
            const { requestId, url, options } = e.data;
            console.log('[CDK Bridge] Received request:', requestId, 'Method:', options?.method, 'URL:', url);
            try {
                const fetchOptions = { ...options, credentials: 'include' };
                console.log('[CDK Bridge] Fetch options:', JSON.stringify(fetchOptions));
                const res = await fetch(url, fetchOptions);
                let data;
                try { data = await res.json(); } catch { data = { _error: '解析失败' }; }
                console.log('[CDK Bridge] Response status:', res.status, 'Data:', JSON.stringify(data));
                window.parent?.postMessage({ type: 'ldsp-cdk-response', requestId, status: res.status, data }, e.origin);
            } catch (err) {
                console.error('[CDK Bridge] Error:', err);
                window.parent?.postMessage({ type: 'ldsp-cdk-response', requestId, status: 0, data: { _error: '网络错误' } }, e.origin);
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
            setTimeout(() => {
                el.style.opacity = '0';
                el.style.pointerEvents = 'none';
            }, 3000);
            console.log(`[SendInvite] ${text}`);
        }
    };

    // --- CDK Client Helper ---
    const CDK = {
        iframeId: 'linuxdo-invite-cdk-bridge',
        bridgeReady: false,
        initBridge: () => {
            if (document.getElementById(CDK.iframeId)) return Promise.resolve();
            return new Promise((resolve) => {
                const iframe = document.createElement('iframe');
                iframe.id = CDK.iframeId;
                iframe.src = 'https://cdk.linux.do/project';
                iframe.style.display = 'none';
                iframe.onload = () => {
                    CDK.bridgeReady = true;
                    console.log('[SendInvite] CDK Bridge initialized successfully');
                    resolve();
                };
                iframe.onerror = () => {
                    console.error('[SendInvite] CDK Bridge failed to initialize');
                    resolve();
                };
                document.body.appendChild(iframe);
            });
        },
        request: (url, options = {}, responseValidator = null) => {
            return new Promise(async (resolve, reject) => {
                if (!CDK.bridgeReady) {
                    console.log('[SendInvite] CDK: Waiting for bridge to be ready...');
                    await new Promise(r => setTimeout(r, 1000));
                }

                const iframe = document.getElementById(CDK.iframeId);
                if (!iframe) return reject('Bridge not initialized');

                const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
                console.log('[SendInvite] CDK: Sending request', requestId, 'Method:', options.method);

                const handler = (e) => {
                    if (e.data?.type === 'ldsp-cdk-response' && e.data.requestId === requestId) {
                        console.log('[SendInvite] CDK: Received response for', requestId, 'Status:', e.data.status, 'Data:', JSON.stringify(e.data.data));

                        if (responseValidator && !responseValidator(e.data.data)) {
                            console.log('[SendInvite] CDK: Response does not match expected format, waiting for correct response...');
                            return;
                        }

                        window.removeEventListener('message', handler);
                        if (e.data.status >= 200 && e.data.status < 300) resolve(e.data.data);
                        else reject(e.data.data || `Status ${e.data.status}`);
                    }
                };
                window.addEventListener('message', handler);

                setTimeout(() => {
                    window.removeEventListener('message', handler);
                    reject('Request timeout');
                }, 10000);

                iframe.contentWindow.postMessage({ type: 'ldsp-cdk-request', requestId, url, options }, 'https://cdk.linux.do');
            });
        },
        createProject: async (inviteCode, startTimeIso, endTimeIso) => {
            const payload = {
                name: `邀请码-by-SendInvite-test`,
                project_tags: ["邀请码"],
                start_time: startTimeIso,
                end_time: endTimeIso,
                minimum_trust_level: 1,
                allow_same_ip: false,
                risk_level: 89,
                distribution_type: 0,
                project_items: [inviteCode]
            };

            const isCreateResponse = (data) => {
                return data?.data?.projectId !== undefined;
            };

            return CDK.request('https://cdk.linux.do/api/v1/projects', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                },
                body: JSON.stringify(payload)
            }, isCreateResponse);
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
                    GM_setValue(CONFIG.TG_LAST_ID, fwdRes.result.message_id);
                    console.log('[SendInvite] Telegram sent successfully.');
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
                GM_setValue(CONFIG.TG_LAST_ID, res.result.message_id);
                console.log('[SendInvite] Telegram sent successfully.');
            }).catch(err => console.error('[SendInvite] Telegram send failed:', err));
        }
    }

    // --- Core Logic ---
    async function getInvite() {
        const nextRun = GM_getValue(CONFIG.EXPIRY_DATE, 0);
        const lastInvite = GM_getValue(CONFIG.INVITE_LINK, null);
        const now = Date.now();
        const enableCdk = GM_getValue(CONFIG.ENABLE_CDK, false);

        // Cleanup expired message
        const tgLastId = GM_getValue(CONFIG.TG_LAST_ID, null);
        if (now >= nextRun && tgLastId) {
            GM_xmlhttpRequest({
                method: "POST",
                url: `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/deleteMessage`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ chat_id: CONFIG.TELEGRAM_PUBLIC_ID, message_id: tgLastId }),
                onload: () => GM_setValue(CONFIG.TG_LAST_ID, null)
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
        } else {
            // -- USE API --
            const csrfMeta = document.querySelector('meta[name="csrf-token"]');
            if (!csrfMeta) return;
            const requestExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

            try {
                const formData = new URLSearchParams();
                formData.append('max_redemptions_allowed', '1');
                formData.append('expires_at', requestExpiry);

                const response = await fetch('https://linux.do/invites', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-CSRF-Token': csrfMeta.content,
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
                        GM_setValue(CONFIG.INVITE_LINK, inviteLink);
                        GM_setValue(CONFIG.EXPIRY_DATE, expiryDateObj.getTime() + 60000);
                    }
                } else {
                    if (json.error_type === 'rate_limit' && json.extras) {
                         GM_setValue(CONFIG.EXPIRY_DATE, Date.now() + (json.extras.wait_seconds * 1000));
                         expiryDateObj = new Date(GM_getValue(CONFIG.EXPIRY_DATE));
                         UI.show(`Rate Limit: ${expiryDateObj.toLocaleString('zh-CN', {hour: '2-digit', minute:'2-digit'})}`, 'info');
                    }
                    return;
                }
            } catch (e) { console.error(e); return; }
        }

        // ---------------------------------------------------------
        // 2. FINALIZE: DISPLAY & SEND
        // ---------------------------------------------------------
        if (inviteLink && expiryDateObj) {
            UI.show(`Invite Ready: ${inviteLink.split('/').pop()}`, 'success');

            let message = `邀请链接：\n<code>${inviteLink}</code>\n有效期：\n${expiryDateObj.toLocaleString('zh-CN', {weekday: 'short', hour: '2-digit', minute:'2-digit'})}`;

            // 3. CDK Creation (If enabled and this is a fresh run or manual trigger)
            if (enableCdk) {
                const inviteCode = inviteLink.split('/').pop();
                try {
                    UI.show('Creating CDK Project...');
                    const startTime = new Date().toISOString();
                    const endTime = expiryDateObj.toISOString();

                    console.log('[SendInvite] CDK: Creating project with invite code:', inviteCode);
                    const cdkRes = await CDK.createProject(inviteCode, startTime, endTime);
                    console.log('[SendInvite] CDK: Response received:', JSON.stringify(cdkRes));

                    // Response format: { error_msg: "", data: { projectId: "..." } }
                    const projectId = cdkRes?.data?.projectId;
                    if (projectId) {
                        const cdkLink = `https://cdk.linux.do/receive/${projectId}`;
                        message += `\n\nCDK兑换链接：\n<code>${cdkLink}</code>`;
                        console.log('[SendInvite] CDK: Project created successfully, ID:', projectId);
                        UI.show('CDK Created successfully!', 'success');
                    } else {
                        console.warn('[SendInvite] CDK: Creation response missing projectId:', cdkRes);
                        UI.show('CDK: No project ID in response', 'error');
                    }
                } catch (err) {
                    console.error('[SendInvite] CDK Error:', err);
                    UI.show('CDK Creation Error: ' + (err?.message || err), 'error');
                }
            }

            sendTelegram(message);
        }
    }

    // --- Scheduler ---
    function init() {
        GM_registerMenuCommand(`CDK生成 (当前: ${GM_getValue(CONFIG.ENABLE_CDK, false) ? '开' : '关'})`, () => {
            const current = GM_getValue(CONFIG.ENABLE_CDK, false);
            GM_setValue(CONFIG.ENABLE_CDK, !current);
            alert(`CDK 生成已${!current ? '开启' : '关闭'}。请刷新页面生效。`);
        });
        GM_registerMenuCommand("手动触发", () => getInvite());

        CDK.initBridge();

        const checkAndRun = () => {
            const nextRun = GM_getValue(CONFIG.EXPIRY_DATE, 0);
            const now = Date.now();
            const tgLastId = GM_getValue(CONFIG.TG_LAST_ID, null);

            if (now >= nextRun) {
                getInvite();
            } else if (tgLastId && now >= nextRun) {
                getInvite();
            }
        };

        setTimeout(checkAndRun, 2000);
        setInterval(checkAndRun, 60000);
    }

    window.addEventListener('load', init);
})();
