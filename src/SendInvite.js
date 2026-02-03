// ==UserScript==
// @name         Linux.do Send Invite
// @namespace    https://linux.do/
// @version      1.1
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
        LAST_MSG_ID: null,
        ENABLE_CDK: false,
        ENABLE_LDSTORE: false,
        LDSTORE_TOKEN: '', // Bearer Token format: 'eyJ***.eyJ***.***'
        LDSTORE_PRODUCT_ID: '',
        LDSTORE_LAST_ID: null
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

    // --- CDK Client Helper (cdk.linux.do) ---
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

    // --- LDStore Integration Helper (ldst0re.qzz.io) ---
    const LDStore = {
        request: (method, endpoint, data = null) => {
            return new Promise((resolve, reject) => {
                if (!CONFIG.LDSTORE_TOKEN) {
                    reject('LDStore Token not configured');
                    return;
                }
                GM_xmlhttpRequest({
                    method: method,
                    url: `https://api.ldspro.qzz.io/api/shop/products/${CONFIG.LDSTORE_PRODUCT_ID}${endpoint}`,
                    headers: {
                        'accept': 'application/json',
                        'content-type': 'application/json',
                        'authorization': `Bearer ${CONFIG.LDSTORE_TOKEN}`
                    },
                    timeout: 10000,
                    data: data ? JSON.stringify(data) : null,
                    onload: (res) => {
                        try {
                            const json = JSON.parse(res.responseText);
                            resolve(json);
                        } catch (e) {
                            console.error('[LDStore] Parse Error:', res.responseText);
                            reject('JSON Parse Error');
                        }
                    },
                    onerror: (e) => {
                        console.error('[LDStore] Network Error:', e);
                        reject(e);
                    }
                });
            });
        },
        add: async (code) => {
            const res = await LDStore.request('POST', '/cdk', { codes: [code] });
            if (!res.success) throw new Error(res.data?.message || res.message || 'Upload failed');
            return res;
        },
        getId: async (code) => {
            const res = await LDStore.request('GET', '/cdk?page=1');
            if (!res.success || !res.data?.cdks) throw new Error('List failed');
            const item = res.data.cdks.find(i => i.code === code);
            return item ? item.id : null;
        },
        remove: async (id) => {
            return LDStore.request('DELETE', `/cdk/${id}`);
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
        const enableLdStore = GM_getValue(CONFIG.ENABLE_LDSTORE, false);

        const tgLastId = GM_getValue(CONFIG.TG_LAST_ID, null);
        if (now >= nextRun) {
            // Cleanup expired telegram message
            if (tgLastId) {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/deleteMessage`,
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify({ chat_id: CONFIG.TELEGRAM_PUBLIC_ID, message_id: tgLastId }),
                    onload: () => GM_setValue(CONFIG.TG_LAST_ID, null)
                });
            }

            // Cleanup expired LDStore CDK
            const ldLastId = GM_getValue(CONFIG.LDSTORE_LAST_ID, null);
            if (ldLastId) {
                console.log('[LDStore] Cleaning up expired CDK:', ldLastId);
                LDStore.remove(ldLastId)
                    .then(r => {
                        console.log('[LDStore] Removed:', r);
                        GM_setValue(CONFIG.LDSTORE_LAST_ID, null);
                    })
                    .catch(e => console.error('[LDStore] Remove failed:', e));
            }
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
                        GM_setValue(CONFIG.LDSTORE_LAST_ID, null);
                    }
                } else {
                    if (json.error_type === 'rate_limit' && json.extras) {
                         const waitMs = json.extras.wait_seconds * 1000;
                         const expiryTime = Date.now() + waitMs;
                         GM_setValue(CONFIG.EXPIRY_DATE, expiryTime);
                         expiryDateObj = new Date(expiryTime);
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

            const inviteCode = inviteLink.split('/').pop();

            // 3. CDK Creation (Internal)
            if (enableCdk) {
                try {
                    UI.show('Creating Internal CDK Project...');
                    const startTime = new Date().toISOString();
                    const endTime = expiryDateObj.toISOString();

                    console.log('[SendInvite] CDK: Creating project with invite code:', inviteCode);
                    const cdkRes = await CDK.createProject(inviteCode, startTime, endTime);

                    const projectId = cdkRes?.data?.projectId;
                    if (projectId) {
                        const cdkLink = `https://cdk.linux.do/receive/${projectId}`;
                        message += `\n\nCDK兑换链接：\n<code>${cdkLink}</code>`;
                        console.log('[SendInvite] CDK: Project created successfully, ID:', projectId);
                        UI.show('Internal CDK Created!', 'success');
                    } else {
                        UI.show('Internal CDK: No project ID', 'error');
                    }
                } catch (err) {
                    console.error('[SendInvite] CDK Error:', err);
                    UI.show('Internal CDK Error: ' + (err?.message || err), 'error');
                }
            }

            // 4. LDStore Integration
            const existingLdId = GM_getValue(CONFIG.LDSTORE_LAST_ID, null);
            if (enableLdStore && CONFIG.LDSTORE_TOKEN && !existingLdId) {
                try {
                    UI.show('Uploading to LDStore...');
                    console.log('[LDStore] Uploading code:', inviteLink);

                    await LDStore.add(inviteLink);

                    // Delay slightly to ensure indexing if necessary, though API is usually fast
                    await new Promise(r => setTimeout(r, 1000));

                    const cdkId = await LDStore.getId(inviteLink);
                    if (cdkId) {
                        GM_setValue(CONFIG.LDSTORE_LAST_ID, cdkId);
                        UI.show(`LDStore: Added ID ${cdkId}`, 'success');
                        console.log('[LDStore] Successfully added and retrieved ID:', cdkId);
                    } else {
                        console.warn('[LDStore] Upload successful but ID retrieval failed.');
                        UI.show('LDStore: ID Not Found', 'error');
                    }
                } catch (err) {
                    console.error('[LDStore] Error:', err);
                    UI.show('LDStore Error: ' + (err?.message || err), 'error');
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
            alert(`内部CDK生成已${!current ? '开启' : '关闭'}。请刷新页面生效。`);
        });

        GM_registerMenuCommand(`LDStore集成 (当前: ${GM_getValue(CONFIG.ENABLE_LDSTORE, false) ? '开' : '关'})`, () => {
            const current = GM_getValue(CONFIG.ENABLE_LDSTORE, false);
            GM_setValue(CONFIG.ENABLE_LDSTORE, !current);
            alert(`LDStore集成已${!current ? '开启' : '关闭'}。请刷新页面生效。`);
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