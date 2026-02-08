// ==UserScript==
// @name         LINUXDO 批量组邀请
// @namespace    linux.do_GroupInviter
// @version      4.1
// @description  100s获取队列，8-11s处理最多5人，支持错误列表和持久化
// @author       karx
// @match        https://linux.do/*
// @connect      research.dxde.de
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        groupId: "95", // 请替换为你的板块id
        apiBase: "https://research.dxde.de/api.php", // 请替换为你的网址
        fetchInterval: 300 * 1000, // 100 seconds for fetching queue
        processInterval: 8 * 1000, // 8 seconds base between each process request
        processLimit: 5, // max users to process per batch
        maxLogItems: 20,
        storageKey: "ld_group_invite_usernames", // localStorage key for persistence
        errorStorageKey: "ld_group_invite_errors" // localStorage key for error list
    };

    let fetchTimer = null;
    let processTimer = null;
    let isProcessing = false;
    let processLoopActive = false;

    // Helper: Wrapper for GM_xmlhttpRequest to mimic fetch-like behavior
    function gmFetch(url, options = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: url,
                headers: options.headers || {},
                data: options.body,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve({
                            json: () => Promise.resolve(JSON.parse(response.responseText)),
                            text: () => Promise.resolve(response.responseText),
                            ok: true,
                            status: response.status
                        });
                    } else {
                        resolve({
                            json: () => Promise.resolve(JSON.parse(response.responseText || "{}")),
                            text: () => Promise.resolve(response.responseText),
                            ok: false,
                            status: response.status
                        });
                    }
                },
                onerror: (err) => reject(err),
                ontimeout: (err) => reject(err)
            });
        });
    }

    // 1. 样式定义
    GM_addStyle(`
        #invite-panel {
            position: fixed !important; top: 120px !important; left: 10px !important; width: 320px !important;
            background: #ffffff !important; border: 2px solid #0088cc !important; border-radius: 12px !important;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3) !important; z-index: 2147483647 !important; padding: 15px !important;
            display: none; color: #333333 !important; font-family: sans-serif;
        }
        #invite-min-btn {
            position: fixed !important; top: 120px !important; left: 10px !important; width: 45px !important; height: 45px !important;
            background: #0088cc !important; color: white !important; border-radius: 50% !important; display: flex;
            align-items: center; justify-content: center; cursor: pointer; z-index: 2147483647 !important;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2) !important; font-size: 20px !important;
        }
        .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
        .panel-btn { width: 100%; padding: 8px; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; margin-bottom: 8px; font-size: 13px; }
        #btn-sync { background: #f39c12; color: white; }
        #btn-start { background: #0088cc; color: white; }
        #username-list { width: 100%; height: 50px; border: 1px solid #ccc; border-radius: 6px; padding: 5px; margin-bottom: 8px; font-size: 12px; resize: none; background: #fafafa; }
        #error-list { width: 100%; height: 40px; border: 1px solid #f87171; border-radius: 6px; padding: 5px; margin-bottom: 8px; font-size: 12px; resize: none; background: #fef2f2; color: #991b1b; }
        #status-msg { font-size: 11px; padding: 5px; border-radius: 4px; background: #f9f9f9; border: 1px solid #eee; color: #666; margin-bottom: 8px; }
        #invite-log { max-height: 120px; overflow-y: auto; font-size: 11px; background: #fcfcfc; border: 1px solid #f0f0f0; border-radius: 6px; padding: 5px; margin-top: 5px; }
        .log-item { margin-bottom: 4px; border-bottom: 1px dashed #eee; padding-bottom: 2px; line-height: 1.4; }
        .log-time { color: #0088cc; font-weight: bold; margin-right: 5px; }
        .log-names { color: #444; }
        .auto-mode-area { margin-bottom: 8px; padding: 8px; background: #f0fdf4; border-radius: 6px; border: 1px dashed #22c55e; font-size: 12px; }
        .close-icon { cursor: pointer; font-size: 18px; color: #999; padding: 0 5px; }
    `);

    function initUI() {
        if (document.getElementById('invite-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'invite-panel';
        panel.innerHTML = `
            <div class="panel-header">
                <span style="font-weight:bold; font-size:14px;">LD 组管助手 v4.0</span>
                <span class="close-icon" title="最小化">−</span>
            </div>

            <div class="auto-mode-area">
                <label style="cursor:pointer; display:flex; align-items:center; gap:5px; color:#166534;">
                    <input type="checkbox" id="auto-mode-switch" checked> 🤖 自动模式
                </label>
                <div id="next-check-msg" style="font-size:10px; color:#16a34a; margin-top:2px;">等待首次检查...</div>
            </div>

            <textarea id="username-list" placeholder="待处理名单 ..."></textarea>

            <div style="font-size:11px; color:#dc2626; margin-bottom:3px;">❌ 失败名单:</div>
            <textarea id="error-list" placeholder="处理失败的用户..."></textarea>

            <div id="status-msg">初始化完成</div>

            <div style="font-size:11px; font-weight:bold; color:#666; margin-bottom:3px;">📜 邀请成功日志 (最近):</div>
            <div id="invite-log">
                <div style="color:#ccc; text-align:center; padding-top:10px;">暂无历史记录</div>
            </div>

            <div style="display:flex; gap:5px; margin-top:10px;">
                <button id="btn-sync" class="panel-btn" style="flex:1;">同步</button>
                <button id="btn-start" class="panel-btn" style="flex:2;">手动补发</button>
            </div>
        `;
        document.body.appendChild(panel);

        const minBtn = document.createElement('div');
        minBtn.id = 'invite-min-btn';
        minBtn.innerHTML = '🚀';
        document.body.appendChild(minBtn);

        // Restore username-list from localStorage
        const savedUsernames = localStorage.getItem(CONFIG.storageKey);
        if (savedUsernames) {
            document.getElementById('username-list').value = savedUsernames;
        }

        // Restore error-list from localStorage
        const savedErrors = localStorage.getItem(CONFIG.errorStorageKey);
        if (savedErrors) {
            document.getElementById('error-list').value = savedErrors;
        }

        // Save username-list to localStorage on change
        document.getElementById('username-list').addEventListener('input', () => {
            saveUsernamesToStorage();
        });

        // Save error-list to localStorage on change
        document.getElementById('error-list').addEventListener('input', () => {
            saveErrorsToStorage();
        });

        // 绑定事件
        document.getElementById('btn-sync').onclick = () => fetchFromSrv(true);
        document.getElementById('btn-start').onclick = () => startInvite(true);
        document.getElementById('auto-mode-switch').onchange = toggleAutoMode;

        panel.querySelector('.close-icon').onclick = () => {
            panel.style.display = 'none';
            minBtn.style.display = 'flex';
        };
        minBtn.onclick = () => {
            minBtn.style.display = 'none';
            panel.style.display = 'block';
        };

        toggleAutoMode({ target: { checked: true } });
    }

    // 添加历史日志函数
    function pushToLog(usernames) {
        const logArea = document.getElementById('invite-log');
        if (!logArea || usernames.length === 0) return;

        // 如果是第一条记录，清除"暂无记录"提示
        if (logArea.innerText.includes("暂无历史记录")) logArea.innerHTML = "";

        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

        const logItem = document.createElement('div');
        logItem.className = 'log-item';
        logItem.innerHTML = `<span class="log-time">[${timeStr}]</span><span class="log-names">${usernames.join(', ')}</span>`;

        logArea.prepend(logItem); // 最新的放在最上面

        // 限制日志数量
        if (logArea.children.length > CONFIG.maxLogItems) {
            logArea.lastElementChild.remove();
        }
    }

    function setMsg(text, color = "#0056b3") {
        const msg = document.getElementById('status-msg');
        if (msg) {
            msg.innerText = text;
            msg.style.color = color;
        }
    }

    function saveUsernamesToStorage() {
        const listText = document.getElementById('username-list')?.value || '';
        localStorage.setItem(CONFIG.storageKey, listText);
    }

    function saveErrorsToStorage() {
        const listText = document.getElementById('error-list')?.value || '';
        localStorage.setItem(CONFIG.errorStorageKey, listText);
    }

    function addToErrorList(usernames) {
        const errorList = document.getElementById('error-list');
        if (!errorList || usernames.length === 0) return;
        const existingErrors = errorList.value.split('\n').map(n => n.trim()).filter(n => n);
        const newErrors = usernames.filter(u => !existingErrors.includes(u));
        const merged = [...existingErrors, ...newErrors];
        errorList.value = merged.join('\n');
        saveErrorsToStorage();
    }

    async function fetchFromSrv(isManual = false) {
        try {
            const res = await gmFetch(`${CONFIG.apiBase}?action=fetch_pending`);
            const data = await res.json();
            if (data.usernames && data.usernames.length > 0) {
                // Merge new usernames with existing ones (avoid duplicates)
                const existingText = document.getElementById('username-list').value;
                const existingUsernames = existingText.split('\n').map(n => n.trim()).filter(n => n);
                const newUsernames = data.usernames.filter(u => !existingUsernames.includes(u));
                const merged = [...existingUsernames, ...newUsernames];
                document.getElementById('username-list').value = merged.join('\n');
                saveUsernamesToStorage();
                if (isManual) setMsg(`📬 获取到 ${data.usernames.length} 个用户 (新增 ${newUsernames.length})`);
                return merged;
            }
            if (isManual) setMsg("📭 目前服务器没有新申请");
            return [];
        } catch (e) {
            console.error(e);
            setMsg("❌ 接口连接失败", "#d93025");
            return [];
        }
    }

    async function startInvite(isManual = false) {
        const listText = document.getElementById('username-list').value;
        const allUsernames = listText.split('\n').map(n => n.trim()).filter(n => n);
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content;

        if (!allUsernames.length) {
            if (isManual) setMsg("📭 没有待处理用户");
            return;
        }

        if (!csrf) {
            setMsg("❌ 未找到 CSRF Token，请刷新页面", "#d93025");
            return;
        }

        // Take only up to processLimit users
        const usernames = allUsernames.slice(0, CONFIG.processLimit);
        const remaining = allUsernames.slice(CONFIG.processLimit);

        if (isManual) setMsg(`正在处理 ${usernames.length} 位用户...`);

        try {
            const response = await fetch(`https://linux.do/groups/${CONFIG.groupId}/members.json`, {
                method: "PUT",
                headers: {
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "x-csrf-token": csrf,
                    "x-requested-with": "XMLHttpRequest"
                },
                credentials: 'include',
                body: `usernames=${encodeURIComponent(usernames.join(','))}&notify_users=true`
            });

            if (response.ok) {
                // Parse response to check for missing usernames
                let successUsernames = usernames;
                let missingUsernames = [];
                try {
                    const resData = await response.json();
                    if (resData.usernames && Array.isArray(resData.usernames)) {
                        // Find usernames we sent that are not in response
                        const returnedSet = new Set(resData.usernames.map(u => u.toLowerCase()));
                        missingUsernames = usernames.filter(u => !returnedSet.has(u.toLowerCase()));
                        successUsernames = usernames.filter(u => returnedSet.has(u.toLowerCase()));
                    }
                } catch (e) {
                    // If JSON parse fails, assume all succeeded
                }

                // Add missing usernames to error list
                if (missingUsernames.length > 0) {
                    addToErrorList(missingUsernames);
                }

                const successCount = successUsernames.length;
                const failCount = missingUsernames.length;
                if (failCount > 0) {
                    setMsg(`✅ 处理 ${successCount} 位, ❌ 失败 ${failCount} 位${remaining.length > 0 ? ` (剩余 ${remaining.length})` : ''}`, "#92400e");
                } else {
                    setMsg(`✅ 已处理 ${usernames.length} 位用户${remaining.length > 0 ? ` (剩余 ${remaining.length} 位)` : ''}`);
                }
                pushToLog(successUsernames.length > 0 ? successUsernames : usernames);

                // Update textarea with remaining users only on success
                document.getElementById('username-list').value = remaining.join('\n');
                saveUsernamesToStorage();
            } else {
                // Check if error is "already member" or 422 - treat as success (ignore batch)
                let isAlreadyMemberError = false;
                try {
                    const errorData = await response.json();
                    if (errorData.errors && errorData.errors.some(e => e.includes('已是此群组的成员'))) {
                        isAlreadyMemberError = true;
                    }
                } catch (e) {}

                if (response.status === 422 || isAlreadyMemberError) {
                    // 422 or already member - ignore batch, don't add to error list
                    setMsg(`ℹ️ ${usernames.length} 位用户已是成员或被跳过${remaining.length > 0 ? ` (剩余 ${remaining.length})` : ''}`, "#0369a1");
                    pushToLog(usernames);
                } else {
                    // Real error, move usernames to error list
                    addToErrorList(usernames);
                    setMsg(`⚠️ 处理异常 (${response.status})，已移至失败名单`, "#92400e");
                }
                document.getElementById('username-list').value = remaining.join('\n');
                saveUsernamesToStorage();
            }

            // Always POST to server as complete
            try {
                await gmFetch(`${CONFIG.apiBase}?action=mark_done`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `usernames=${encodeURIComponent(usernames.join(','))}`
                });
            } catch (e2) {
                console.error('Server mark_done error:', e2);
            }

        } catch (error) {
            console.error(error);
            // On network error, move usernames to error list
            addToErrorList(usernames);
            document.getElementById('username-list').value = remaining.join('\n');
            saveUsernamesToStorage();
            setMsg("❌ 网络异常，已移至失败名单", "#d93025");

            // Still try to POST to server
            try {
                await gmFetch(`${CONFIG.apiBase}?action=mark_done`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `usernames=${encodeURIComponent(usernames.join(','))}`
                });
            } catch (e2) {}
        }

        // Try to resolve digit-only IDs from error list
        await resolveDigitId();
    }

    // Function to resolve digit-only IDs from error list by querying linux.do search
    async function resolveDigitId() {
        const errorList = document.getElementById('error-list');
        if (!errorList) return;

        const errors = errorList.value.split('\n').map(n => n.trim()).filter(n => n);
        // Find first digit-only ID
        const digitId = errors.find(e => /^\d+$/.test(e));
        if (!digitId) return;

        try {
            const searchUrl = `https://linux.do/search?q=USER%3A${digitId}%20order%3Alatest_topic&page=1`;
            const response = await fetch(searchUrl, {
                headers: {
                    "x-requested-with": "XMLHttpRequest"
                }
            });
            if (!response.ok) return;

            const data = await response.json();
            // Get username from first post
            if (data.posts && data.posts.length > 0 && data.posts[0].username) {
                const username = data.posts[0].username;

                // Add username to username list
                const usernameList = document.getElementById('username-list');
                const existingUsernames = usernameList.value.split('\n').map(n => n.trim()).filter(n => n);
                if (!existingUsernames.includes(username)) {
                    existingUsernames.push(username);
                    usernameList.value = existingUsernames.join('\n');
                    saveUsernamesToStorage();
                }

                // Remove digit ID from error list
                const newErrors = errors.filter(e => e !== digitId);
                errorList.value = newErrors.join('\n');
                saveErrorsToStorage();

                console.log(`Resolved digit ID ${digitId} to username ${username}`);
            }
        } catch (e) {
            console.error('Error resolving digit ID:', e);
        }
    }


    async function fetchLoop() {
        await fetchFromSrv(false);
        updateStatusMsg();
    }

    async function processLoop() {
        if (isProcessing) {
            // Schedule next iteration if still active
            if (processLoopActive) {
                scheduleNextProcess();
            }
            return;
        }

        const listText = document.getElementById('username-list').value;
        const usernames = listText.split('\n').map(n => n.trim()).filter(n => n);

        if (usernames.length > 0) {
            isProcessing = true;
            await startInvite(false);
            isProcessing = false;
        }
        updateStatusMsg();

        // Schedule next iteration if still active
        if (processLoopActive) {
            scheduleNextProcess();
        }
    }

    function scheduleNextProcess() {
        // Add random bias of 0-3000ms to processInterval (8s + 0-3s = 8-11s)
        const randomBias = Math.floor(Math.random() * 3000);
        const delay = CONFIG.processInterval + randomBias;
        processTimer = setTimeout(processLoop, delay);
    }

    function updateStatusMsg() {
        const now = new Date();
        const nextFetch = new Date(now.getTime() + CONFIG.fetchInterval);
        const nextProcess = new Date(now.getTime() + CONFIG.processInterval);
        const msg = document.getElementById('next-check-msg');
        const listText = document.getElementById('username-list').value;
        const remaining = listText.split('\n').map(n => n.trim()).filter(n => n).length;
        if (msg) {
            msg.innerText = `获取: ${nextFetch.toLocaleTimeString()} | 处理: ${nextProcess.toLocaleTimeString()} | 队列: ${remaining}`;
        }
    }

    function toggleAutoMode(e) {
        const isEnabled = e.target.checked;
        const nextMsg = document.getElementById('next-check-msg');
        if (!nextMsg) return;

        if (isEnabled) {
            if (fetchTimer) clearInterval(fetchTimer);
            if (processTimer) {
                clearTimeout(processTimer);
                processTimer = null;
            }

            // Run fetch immediately, then every 100s
            fetchLoop();
            fetchTimer = setInterval(fetchLoop, CONFIG.fetchInterval);

            // Run process loop with random bias (8s + 0-3s)
            processLoopActive = true;
            scheduleNextProcess();

            nextMsg.style.color = "#16a34a";
        } else {
            if (fetchTimer) clearInterval(fetchTimer);
            if (processTimer) clearTimeout(processTimer);
            fetchTimer = null;
            processTimer = null;
            processLoopActive = false;
            nextMsg.innerText = "自动模式已停用";
            nextMsg.style.color = "#999";
        }
    }

    const observer = new MutationObserver(() => {
        if (document.body && !document.getElementById('invite-panel')) initUI();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

})();
