// ==UserScript==
// @name         LINUXDO 批量组邀请
// @namespace    https://linux.do/
// @version      5.0
// @description  自动组邀请管理
// @author       ChiGamma
// @license      Fair License
// @match        https://linux.do/*
// @connect      research.dxde.de
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==
// fork from: https://linux.do/t/topic/1440614 by @karx

(function() {
    'use strict';

    // ==========================================================================
    // CONFIGURATION
    // ==========================================================================
    const CONFIG = {
        groupId: "0", // 目标版块对应群组 ID
        endpoints: {
            external: "https://example.com/api.php",
            internal: "https://linux.do/groups"
        },
        timing: {
            fetchInterval: 100 * 1000,     // 100秒获取一次队列
            processIntervalBase: 8 * 1000, // 8秒基础处理间隔
            processIntervalJitter: 3000    // +0-3秒随机抖动
        },
        batchSize: 5,
        limits: {
            maxLogEntries: 20
        },
        storageKeys: {
            queue: "ld_group_invite_queue",
            errors: "ld_group_invite_errors"
        }
    };

    // ==========================================================================
    // UTILITIES & LOGGING
    // ==========================================================================
    const Log = {
        state: (msg, color = "#666") => {
            const el = document.getElementById('status-msg');
            if (el) {
                el.innerText = msg;
                el.style.color = color;
            }
        },
        history: (usernames, success = true) => {
            const logArea = document.getElementById('invite-log');
            if (!logArea || !usernames.length) return;

            if (logArea.innerText.includes("暂无记录")) logArea.innerHTML = "";

            const now = new Date();
            const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
            const item = document.createElement('div');
            item.className = 'log-item';

            const icon = success ? '✅' : '⚠️';
            item.innerHTML = `<span class="log-time">[${timeStr}]</span> ${icon} <span class="log-names">${usernames.join(', ')}</span>`;

            logArea.prepend(item);
            if (logArea.children.length > CONFIG.limits.maxLogEntries) {
                logArea.lastElementChild.remove();
            }
        }
    };

    // ==========================================================================
    // DATA PERSISTENCE (ATOMIC HANDLING)
    // ==========================================================================
    const Storage = {
        read: (key) => {
            const val = localStorage.getItem(key);
            return val ? val.split('\n').map(s => s.trim()).filter(Boolean) : [];
        },
        write: (key, list) => {
            const cleanList = [...new Set(list)];
            localStorage.setItem(key, cleanList.join('\n'));
            Storage.syncUI(key, cleanList);
        },
        modify: (key, transformFn) => {
            const current = Storage.read(key);
            const next = transformFn(current);
            Storage.write(key, next);
            return next;
        },
        syncUI: (key, list) => {
            let elId = key === CONFIG.storageKeys.queue ? 'username-list' : 'error-list';
            const el = document.getElementById(elId);
            if (!el) return;

            const newValue = list.join('\n');
            if (document.activeElement === el) {
                if (el.value.trim() !== newValue) {
                    const start = el.selectionStart;
                    const end = el.selectionEnd;
                    el.value = newValue;
                    el.setSelectionRange(start, end);
                }
            } else {
                el.value = newValue;
            }

            if (key === CONFIG.storageKeys.queue) {
                const countEl = document.getElementById('queue-count');
                if (countEl) countEl.innerText = list.length;
            }
        }
    };

    // ==========================================================================
    // API LAYER
    // ==========================================================================
    const Api = {
        external: (params) => {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: params.method || 'GET',
                    url: `${CONFIG.endpoints.external}${params.query || ''}`,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    data: params.body,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            try { resolve(JSON.parse(res.responseText)); }
                            catch (e) { resolve(res.responseText); }
                        } else {
                            reject(new Error(`Ext API ${res.status}`));
                        }
                    },
                    onerror: reject,
                    ontimeout: reject
                });
            });
        },

        internal: async (url, options = {}) => {
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
            if (!csrfToken) throw new Error("CSRF Token missing");

            const response = await fetch(url, {
                ...options,
                headers: {
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "x-csrf-token": csrfToken,
                    "x-requested-with": "XMLHttpRequest",
                    ...options.headers
                },
                credentials: 'include'
            });

            const text = await response.text();
            let data = {};
            try { data = JSON.parse(text); } catch (e) {}

            return { ok: response.ok, status: response.status, data: data };
        }
    };

    // ==========================================================================
    // LOGIC MANAGER
    // ==========================================================================
    const Manager = {
        timers: { fetch: null, process: null },
        state: { isProcessing: false, autoMode: false },

        syncQueue: async (isManual = false) => {
            try {
                const data = await Api.external({ query: "?action=fetch_pending" });
                if (data.usernames && Array.isArray(data.usernames) && data.usernames.length > 0) {
                    Storage.modify(CONFIG.storageKeys.queue, (current) => {
                        const newItems = data.usernames.filter(u => !current.includes(u));
                        if (newItems.length > 0 && isManual) Log.state(`📬 新增 ${newItems.length} 位用户`, "#16a34a");
                        return [...current, ...newItems];
                    });
                } else if (isManual) {
                    Log.state("📭 远程队列为空", "#666");
                }
            } catch (e) {
                console.error("Sync Error:", e);
                if (isManual) Log.state("❌ 同步失败", "#dc2626");
            }
        },

        // Core Task Runner: Decides whether to Invite or Resolve Errors
        runTask: async (isManual = false) => {
            if (Manager.state.isProcessing) return;
            Manager.state.isProcessing = true;

            try {
                const queue = Storage.read(CONFIG.storageKeys.queue);

                // Priority 1: Invite Users
                if (queue.length > 0) {
                    await Manager.processBatch(queue, isManual);
                }
                // Priority 2: Resolve Errors (Only if Queue is empty)
                else {
                    const errors = Storage.read(CONFIG.storageKeys.errors);
                    const hasDigitId = errors.some(e => /^\d+$/.test(e));

                    if (hasDigitId) {
                        await Manager.resolveErrors(errors);
                    } else if (isManual) {
                        Log.state("📭 队列为空且无待修复ID", "#666");
                    }
                }
            } finally {
                Manager.state.isProcessing = false;
                if (Manager.state.autoMode) Manager.scheduleProcess();
            }
        },

        processBatch: async (queue, isManual) => {
            const batch = queue.slice(0, CONFIG.batchSize);

            if (isManual) Log.state(`正在处理 ${batch.length} 位用户...`, "#0369a1");

            // Optimistic Removal
            Storage.modify(CONFIG.storageKeys.queue, (list) => list.filter(u => !batch.includes(u)));

            let failedUsers = [];

            try {
                const res = await Api.internal(`${CONFIG.endpoints.internal}/${CONFIG.groupId}/members.json`, {
                    method: "PUT",
                    body: `usernames=${encodeURIComponent(batch.join(','))}&notify_users=true`
                });

                if (res.ok) {
                    const responseNames = (res.data.usernames || []).map(u => u.toLowerCase());
                    const successCount = batch.filter(u => responseNames.includes(u.toLowerCase())).length;
                    failedUsers = batch.filter(u => !responseNames.includes(u.toLowerCase()));
                    Log.state(`✅ 批次完成。成功: ${successCount}`, "#15803d");
                } else {
                    if (res.status === 422) {
                        Log.state(`ℹ️ 跳过 (已在组内或无效)`, "#0369a1");
                    } else {
                        Log.state(`⚠️ API 错误 ${res.status}`, "#b91c1c");
                        failedUsers = batch;
                    }
                }
            } catch (e) {
                console.error(e);
                Log.state("❌ 网络异常", "#b91c1c");
                failedUsers = batch;
            }

            // Handle Failures
            if (failedUsers.length > 0) {
                Storage.modify(CONFIG.storageKeys.errors, (list) => [...list, ...failedUsers]);
            }

            // Logging & Reporting
            Log.history(batch, failedUsers.length < batch.length);
            try {
                await Api.external({
                    method: 'POST',
                    query: "?action=mark_done",
                    body: `usernames=${encodeURIComponent(batch.join(','))}`
                });
            } catch(e) {}
        },

        resolveErrors: async (errors) => {
            const digitId = errors.find(e => /^\d+$/.test(e));
            if (!digitId) return;

            Log.state(`🔍 正在解析 ID: ${digitId}...`, "#d97706");

            try {
                const res = await Api.internal(`https://linux.do/search?q=USER%3A${digitId}%20order%3Alatest_topic&page=1`, {
                    headers: {
                        "accept": "application/json",
                    }
                });
                if (res.ok && res.data.posts && res.data.posts.length > 0) {
                    const username = res.data.posts[0].username;

                    // Add resolved name to Queue
                    Storage.modify(CONFIG.storageKeys.queue, (list) => {
                        return list.includes(username) ? list : [...list, username];
                    });

                    // Remove ID from Errors
                    Storage.modify(CONFIG.storageKeys.errors, (list) => {
                        return list.filter(e => e !== digitId);
                    });

                    Log.state(`✅ 解析成功: ${digitId} -> ${username}`, "#15803d");
                } else {
                    Log.state(`⚠️ 无法解析 ID: ${digitId}`, "#b91c1c");
                }
            } catch (e) {
                console.error("ID Resolution Error:", e);
                Log.state("❌ 解析请求失败", "#b91c1c");
            }
        },

        scheduleProcess: () => {
            if (Manager.timers.process) clearTimeout(Manager.timers.process);
            const delay = CONFIG.timing.processIntervalBase + Math.floor(Math.random() * CONFIG.timing.processIntervalJitter);
            Manager.timers.process = setTimeout(() => Manager.runTask(false), delay);
        },

        toggleAuto: (enable) => {
            Manager.state.autoMode = enable;
            const indicator = document.getElementById('next-check-msg');

            if (Manager.timers.fetch) clearInterval(Manager.timers.fetch);
            if (Manager.timers.process) clearTimeout(Manager.timers.process);

            if (enable) {
                if (indicator) {
                    indicator.innerText = "运行中...";
                    indicator.style.color = "#16a34a";
                }
                Manager.syncQueue(false);
                Manager.timers.fetch = setInterval(() => Manager.syncQueue(false), CONFIG.timing.fetchInterval);
                Manager.scheduleProcess();
            } else {
                if (indicator) {
                    indicator.innerText = "自动模式已关闭";
                    indicator.style.color = "#999";
                }
            }
        }
    };

    // ==========================================================================
    // UI INITIALIZATION
    // ==========================================================================
    function initUI() {
        if (document.getElementById('invite-panel')) return;

        GM_addStyle(`
            #invite-panel { position: fixed; top: 120px; left: 10px; width: 320px; background: #fff; border: 2px solid #0088cc; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); z-index: 99999; padding: 15px; color: #333; font-family: sans-serif; }
            #invite-min-btn { position: fixed; top: 120px; left: 10px; width: 45px; height: 45px; background: #0088cc; color: white; border-radius: 50%; display: none; align-items: center; justify-content: center; cursor: pointer; z-index: 99999; box-shadow: 0 4px 12px rgba(0,0,0,0.2); font-size: 20px; }
            .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid #eee; padding-bottom: 5px; font-weight: bold; }
            .panel-btn { width: 100%; padding: 8px; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; margin-bottom: 8px; font-size: 13px; color: white; }
            .inp-area { width: 100%; border: 1px solid #ccc; border-radius: 6px; padding: 5px; margin-bottom: 8px; font-size: 12px; resize: none; display: block; box-sizing: border-box; }
            #invite-log { max-height: 120px; overflow-y: auto; font-size: 11px; background: #fcfcfc; border: 1px solid #f0f0f0; border-radius: 6px; padding: 5px; margin-top: 5px; }
            .log-item { margin-bottom: 4px; border-bottom: 1px dashed #eee; padding-bottom: 2px; }
        `);

        const panel = document.createElement('div');
        panel.id = 'invite-panel';
        panel.innerHTML = `
            <div class="panel-header">
                <span>LD 组管助手 v4.3</span>
                <span style="cursor:pointer" id="pnl-min">−</span>
            </div>
            <div style="margin-bottom:8px; padding:8px; background:#f0fdf4; border-radius:6px; border:1px dashed #22c55e; font-size:12px;">
                <label style="cursor:pointer; display:flex; align-items:center; gap:5px; color:#166534;">
                    <input type="checkbox" id="auto-mode-switch" checked> 🤖 自动模式
                </label>
                <div style="display:flex; justify-content:space-between; margin-top:2px;">
                    <span id="next-check-msg" style="font-size:10px; color:#16a34a;">初始化中...</span>
                    <span style="font-size:10px; color:#666;">待处理: <b id="queue-count">0</b></span>
                </div>
            </div>
            <textarea id="username-list" class="inp-area" style="height:50px; background:#fafafa;" placeholder="待处理名单 (用户名)..."></textarea>
            <div style="font-size:11px; color:#dc2626; margin-bottom:3px;">❌ 失败名单:</div>
            <textarea id="error-list" class="inp-area" style="height:40px; background:#fef2f2; color:#991b1b;" placeholder="处理失败的用户/ID..."></textarea>
            <div id="status-msg" style="font-size:11px; padding:5px; border-radius:4px; background:#f9f9f9; border:1px solid #eee; color:#666; margin-bottom:8px;">就绪</div>
            <div style="font-size:11px; font-weight:bold; color:#666; margin-bottom:3px;">📜 历史记录:</div>
            <div id="invite-log"><div style="color:#ccc; text-align:center; padding-top:10px;">暂无记录</div></div>
            <div style="display:flex; gap:5px; margin-top:10px;">
                <button id="btn-sync" class="panel-btn" style="background:#f39c12; flex:1;">同步</button>
                <button id="btn-start" class="panel-btn" style="background:#0088cc; flex:2;">手动执行</button>
            </div>
        `;

        const minBtn = document.createElement('div');
        minBtn.id = 'invite-min-btn';
        minBtn.innerText = '🚀';

        document.body.append(panel, minBtn);

        // UI Event Listeners
        document.getElementById('pnl-min').onclick = () => { panel.style.display = 'none'; minBtn.style.display = 'flex'; };
        minBtn.onclick = () => { minBtn.style.display = 'none'; panel.style.display = 'block'; };
        document.getElementById('btn-sync').onclick = () => Manager.syncQueue(true);
        document.getElementById('btn-start').onclick = () => Manager.runTask(true);
        document.getElementById('auto-mode-switch').onchange = (e) => Manager.toggleAuto(e.target.checked);

        // Input Binding: Direct Write to Storage
        document.getElementById('username-list').addEventListener('input', (e) => {
            localStorage.setItem(CONFIG.storageKeys.queue, e.target.value.split('\n').map(s=>s.trim()).join('\n'));
            document.getElementById('queue-count').innerText = e.target.value.split('\n').filter(s=>s.trim()).length;
        });
        document.getElementById('error-list').addEventListener('input', (e) => {
            localStorage.setItem(CONFIG.storageKeys.errors, e.target.value.split('\n').map(s=>s.trim()).join('\n'));
        });

        // Initialize Data
        const savedQueue = Storage.read(CONFIG.storageKeys.queue);
        Storage.syncUI(CONFIG.storageKeys.queue, savedQueue);

        const savedErrors = Storage.read(CONFIG.storageKeys.errors);
        Storage.syncUI(CONFIG.storageKeys.errors, savedErrors);

        // Start
        Manager.toggleAuto(true);
    }

    const observer = new MutationObserver(() => {
        if (document.body && !document.getElementById('invite-panel')) initUI();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

})();