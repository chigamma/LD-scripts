// ==UserScript==
// @name         LinuxDo追觅
// @namespace    https://linux.do/
// @version      3.3
// @description  在网页上实时监控 Linux.do 活动。
// @author       ChiGamma
// @license      Fair License
// @match        https://linux.do/*
// @connect      linux.do
// @icon         https://linux.do/uploads/default/original/3X/9/d/9dd4973138ccd78e8907865261d7b14d45a96d1c.png
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        window.focus
// ==/UserScript==
// Fork from 2025-08-06-v21-cross-origin by @NullUser.

(function () {
    'use strict';

    // 防止在 iframe 中运行 (如广告框)
    if (window.top !== window.self) return;
    // Initialization Guard
    if (window.ld_seeking_init_done) return;
    window.ld_seeking_init_done = true;

    // --- 配置 ---
    const CONFIG = {
        MAX_USERS: 5,
        SIDEBAR_WIDTH: '270px',
        REFRESH_INTERVAL_MS: 60 * 1000,
        LOG_LIMIT_PER_USER: 10,
        HOST: 'https://linux.do',
        MAX_RETRIES: 2,
        RETRY_DELAY_MS: 2000,
        ERROR_BACKOFF_MS: 5 * 60 * 1000,
        THROTTLE_MS: 500
    };
    const nameColors = [
        // 用户自己主题色
        "#ffd700",
        // 关注用户主题色
        "#00d4ff", "#ff6b6b", "#4d5ef7", "#c77dff", "#00ff88", "#f87eca"
    ];

    // --- 类别定义 ---
    const categoryColors = {
        '开发调优': '#32c3c3', '国产替代': '#D12C25', '资源荟萃': '#12A89D',
        '网盘资源': '#16b176', '文档共建': '#9cb6c4', '跳蚤市场': '#ED207B',
        '非我莫属': '#a8c6fe', '读书成诗': '#e0d900', '扬帆起航': '#ff9838',
        '前沿快讯': '#BB8FCE', '网络记忆': '#F7941D', '福利羊毛': '#E45735',
        '搞七捻三': '#3AB54A', '社区孵化': '#ffbb00', '运营反馈': '#808281',
        '深海幽域': '#45B7D1', '积分乐园': '#fcca44', '未分区':   '#9e9e9e',
    };

    const categoryMap = new Map();
    const category_dict = {
        "开发调优": [4, 20, 31, 88], "国产替代": [98, 99, 100, 101], "资源荟萃": [14, 83, 84, 85],
        '网盘资源': [94, 95, 96, 97], "文档共建": [42, 75, 76, 77], "跳蚤市场": [10, 13, 81, 82],
        "非我莫属": [27, 72, 73, 74], "读书成诗": [32, 69, 70, 71], "扬帆起航": [46, 66, 67, 68],
        "前沿快讯": [34, 78, 79, 80], "网络记忆": [92], "福利羊毛": [36, 60, 61, 62],
        "搞七捻三": [11, 35, 89, 21], "社区孵化": [102, 103, 104, 105], "运营反馈": [2, 15, 16, 27],
        "深海幽域": [45, 57, 58, 59], "积分乐园": [106, 107, 108, 109],
    };
    for (const name in category_dict) category_dict[name].forEach(id => categoryMap.set(id, name));

    // --- 状态管理 (使用 GM_getValue 实现跨域持久化) ---
    // 注意：GM_getValue 是按域名存储的，要在所有网站共享数据很难（除非用云端）。
    // 这里的策略是：配置仅保存在当前域名下。
    // 如果需要全网同步配置，需要更复杂的技术（如 iframe 通信），这里暂保持单站独立配置，但代码结构支持扩展。
    function loadConfig() {
        try { return JSON.parse(GM_getValue('ld_v21_config', '{}')); }
        catch { return {}; }
    }

    function getSelfUser() {
        try {
            const preloaded = document.getElementById('data-preloaded');
            if (preloaded) {
                const data = JSON.parse(preloaded.dataset.preloaded);
                if (data.currentUser) {
                    return JSON.parse(data.currentUser).username;
                }
            }
        } catch (e) {}
        return null;
    }

    const saved = loadConfig();
    const pushedIds = new Set();

    const State = {
        users: saved.users || [],
        lastIds: saved.lastIds || {},
        multipliers: {},
        enableSysNotify: saved.enableSysNotify !== false,
        enableDanmaku: saved.enableDanmaku !== false,
        data: {},
        // isCollapsed: GM_getValue('ld_is_collapsed', true), // 默认收起
        isCollapsed: sessionStorage.getItem('ld_is_collapsed') !== 'false', // 默认收起，每个tab独立
        isProcessing: false,
        hiddenUsers: new Set(saved.hiddenUsers || []),
        selfUser: getSelfUser(),
        nextFetchTime: {},
        userProfiles: {},
        isLeader: false,
    };

    // --- Time & Schedule Logic ---
    function formatTimeAgo(isoTime) {
        if (!isoTime) return '--';
        const diff = Date.now() - new Date(isoTime).getTime();
        if (diff < 0) return '0m0s';
        const secs = Math.floor(diff / 1000);
        const mins = Math.floor(secs / 60);
        const hours = Math.floor(mins / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d${hours % 24}h`;
        if (hours > 0) return `${hours}h${mins % 60}m`;
        if (mins > 0) return `${mins}m${secs % 60}s`;
        return `${secs}s`;
    }

    function getTimeAgoColor(isoTime, userColor) {
        if (!isoTime) return '#666';
        const diff = Date.now() - new Date(isoTime).getTime();
        const maxTime = 1 * 60 * 60 * 1000;
        const ratio = Math.min(1, Math.max(0, diff / maxTime));

        const hex = userColor.replace('#', '');
        const r1 = parseInt(hex.substr(0, 2), 16);
        const g1 = parseInt(hex.substr(2, 2), 16);
        const b1 = parseInt(hex.substr(4, 2), 16);
        const r2 = 204, g2 = 204, b2 = 204;

        const r = Math.round(r1 + (r2 - r1) * ratio);
        const g = Math.round(g1 + (g2 - g1) * ratio);
        const b = Math.round(b1 + (b2 - b1) * ratio);

        return `rgb(${r},${g},${b})`;
    }

    function getUserColor(username) {
        const idx = State.users.indexOf(username);
        return nameColors[1 + idx % nameColors.length];
    }

    function getIntervalMultiplier(lastSeenAt) {
        const collapsedMult = State.isCollapsed ? 2 : 1;
        if (!lastSeenAt) return 20 * collapsedMult;
        const diff = Date.now() - new Date(lastSeenAt).getTime();
        const minutes = diff / (1000 * 60);
        if (minutes < 2) return 1 * collapsedMult;
        if (minutes < 10) return 1.5 * collapsedMult;
        if (minutes < 20) return 2 * collapsedMult;
        if (minutes < 30) return 3 * collapsedMult;
        if (minutes < 60) return 4 * collapsedMult;
        if (minutes < 120) return 5 * collapsedMult;
        if (minutes < 720) return 10 * collapsedMult;
        return 20 * collapsedMult;
    }

    function getUserCycleDuration(username) {
        const mult = State.multipliers[username] || 1;
        return CONFIG.REFRESH_INTERVAL_MS * mult;
    }

    // --- Cross-Tab BroadcastChannel ---
    const CHANNEL_NAME = 'ld_seeking_channel';
    const channel = new BroadcastChannel(CHANNEL_NAME);
    let leaderCheckTimeout = null;
    let pendingLeadershipTimer = null;

    function saveConfig() {
        const store = {
            users: State.users,
            lastIds: State.lastIds,
            enableSysNotify: State.enableSysNotify,
            enableDanmaku: State.enableDanmaku,
            hiddenUsers: Array.from(State.hiddenUsers)
        };
        GM_setValue('ld_v21_config', JSON.stringify(store));
    }

    function broadcastState() {
        channel.postMessage({
            type: 'data_update',
            data: State.data,
            lastIds: State.lastIds,
            hiddenUsers: Array.from(State.hiddenUsers),
            nextFetchTime: State.nextFetchTime,
            multipliers: State.multipliers,
            userProfiles: State.userProfiles,
            users: State.users
        });
    }

    // --- 核心网络层 ---
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function safeFetch(url, timeout = 30000, retryCount = 0) {
        return new Promise(async (resolve, reject) => {
            const isSameOrigin = url.startsWith(CONFIG.HOST) || url.startsWith('/');
            const headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.53 Safari/537.36",
                "Accept": "application/json",
                "Discourse-Present": "true"
            };

            if (isSameOrigin) {
                // Native Fetch Implementation for Same-Origin
                const controller = new AbortController();
                const id = setTimeout(() => controller.abort(), timeout);

                try {
                    const response = await fetch(url, {
                        method: 'GET',
                        signal: controller.signal
                    });
                    clearTimeout(id);

                    if (response.ok) {
                        try {
                            const data = await response.json();
                            resolve(data);
                        } catch (e) {
                            reject(new Error("JSON Parse Error"));
                        }
                    } else {
                        if ((response.status >= 500 || response.status === 429) && retryCount < CONFIG.MAX_RETRIES) {
                            const delay = CONFIG.RETRY_DELAY_MS * (retryCount + 1);
                            await wait(delay);
                            resolve(safeFetch(url, timeout, retryCount + 1));
                        } else {
                            const err = new Error(`Status ${response.status}`);
                            err.status = response.status;
                            reject(err);
                        }
                    }
                } catch (err) {
                    clearTimeout(id);
                    if (retryCount < CONFIG.MAX_RETRIES && err.name !== 'AbortError') {
                        const delay = CONFIG.RETRY_DELAY_MS * (retryCount + 1);
                        await wait(delay);
                        resolve(safeFetch(url, timeout, retryCount + 1));
                    } else {
                        reject(err.name === 'AbortError' ? new Error("Timeout") : err);
                    }
                }
            } else {
                // GM_xmlhttpRequest Implementation for Cross-Origin
                GM_xmlhttpRequest({
                    method: "GET",
                    url: url,
                    timeout: timeout,
                    headers: headers,
                    onload: async (response) => {
                        if (response.status >= 200 && response.status < 300) {
                            try { resolve(JSON.parse(response.responseText)); }
                            catch (e) { reject(new Error("JSON Parse Error")); }
                        } else if ((response.status >= 500 || response.status === 429) && retryCount < CONFIG.MAX_RETRIES) {
                            const delay = CONFIG.RETRY_DELAY_MS * (retryCount + 1);
                            await wait(delay);
                            resolve(safeFetch(url, timeout, retryCount + 1));
                        } else {
                            const err = new Error(`Status ${response.status}`);
                            err.status = response.status;
                            reject(err);
                        }
                    },
                    ontimeout: async () => {
                        if (retryCount < CONFIG.MAX_RETRIES) {
                            await wait(CONFIG.RETRY_DELAY_MS * (retryCount + 1));
                            resolve(safeFetch(url, timeout, retryCount + 1));
                        } else {
                            reject(new Error("Timeout"));
                        }
                    },
                    onerror: (err) => reject(err)
                });
            }
        });
    }

    // --- 样式 ---
    const css = `
        :host { all: initial; font-family: system-ui, -apple-system, sans-serif; font-size: 14px; z-index: 2147483647; position: fixed; top: 0; left: 0; pointer-events: none; width: 100vw; height: 100vh; }

        /* 侧边栏容器 */
        #ld-sidebar { position: fixed; top: 0; left: 0; width: ${CONFIG.SIDEBAR_WIDTH}; height: 100vh; background: rgba(18, 18, 18, 0.95); backdrop-filter: blur(10px); border-right: 1px solid rgba(255, 255, 255, 0.1); display: flex; flex-direction: column; color: #eee; box-shadow: 5px 0 25px rgba(0,0,0,0.5); transition: transform 0.3s cubic-bezier(0.2, 0, 0, 1); pointer-events: auto; overflow: visible; }
        #ld-sidebar.collapsed { transform: translateX(-${CONFIG.SIDEBAR_WIDTH}); }
        #ld-toggle-ball { position: absolute; right: -24px; top: 50vh; width: 24px; height: 48px; background: #222; border: 1px solid rgba(255,255,255,0.2); border-left: none; border-radius: 0 100px 100px 0; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #ffd700; box-shadow: 2px 0 10px rgba(0,0,0,0.3); pointer-events: auto; transition: 0.2s; }
        #ld-toggle-ball:hover { width: 32px; background: #333; }

        /* 头部 */
        .sb-header { padding: 8px; background: rgba(18, 18, 18, 0.98); flex-shrink: 0; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .sb-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .sb-title { font-weight: 800; font-size: 14px; color: #fff; display: flex; align-items: center; gap: 8px; }
        .sb-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; transition: 0.3s; }
        .sb-status-dot.leader { background: #00ff88; box-shadow: 0 0 8px #00ff88; }
        .sb-status-dot.follower { background: #00d4ff; box-shadow: 0 0 8px #00d4ff; }
        .sb-status-dot.loading { background: #ffd700; animation: pulse 1s infinite; }

        .sb-tools { display: flex; gap: 6px; }
        .sb-icon-btn { background: transparent; border: none; color: #888; cursor: pointer; font-size: 14px; padding: 4px; border-radius: 4px; transition: 0.2s; }
        .sb-icon-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
        .sb-icon-btn.active { color: #ffd700; background: rgba(0, 212, 255, 0.1); }

        /* 用户列表 */
        .sb-input-group { display: flex; gap: 5px; margin-bottom: 6px; }
        .sb-input { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 10px; border-radius: 6px; outline: none; font-size: 11px; }
        .sb-input:focus { border-color: #ffd700; }
        .sb-btn-add { background: #ffd700; color: #000; border: none; border-radius: 6px; width: 20.5px; padding: 1px; cursor: pointer; font-weight: bold; }

        .sb-tags { display: block; margin-top: 5px; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; overflow: hidden; }
        .sb-user-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 2px; background: rgba(255,255,255,0.03); border-bottom: 1px solid rgba(255,255,255,0.05); border-left: 3px solid #989898; }
        .sb-user-row:last-child { border-bottom: none; }
        .sb-user-row:hover { background: rgba(255,255,255,0.08); }
        .sb-user-row.active { background: rgba(255, 215, 0, 0.1); border-left: 3px solid #ffd700; }

        .sb-del { font-size: 12px; color: #666; cursor: pointer; margin: 0 2pt 1px 6px; line-height: 1; }
        .sb-del:hover { color: #ff5555; }
        .sb-timer-circle { flex-shrink: 0; margin: 1px 6px 0 2px; }
        .sb-timer-circle:hover { opacity: 0.8; }

        .sb-user-name { font-size: 11px; color: #ccc; cursor: pointer; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sb-user-name.disabled { color: #666; }
        .sb-user-row.active .sb-user-name { color: #ffd700; font-weight: 600; }
        .sb-user-activity { font-size: 9px; color: #888; display: flex; gap: 2px; margin: 0 6px; flex-shrink: 0; }
        .sb-user-activity span { white-space: nowrap; width: 36px; text-align: right; font-family: monospace; }

        /* 卡片列表 */
        .sb-list { flex: 1; padding: 8px; background: transparent; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #444 transparent; }
        .sb-list::-webkit-scrollbar { width: 4px; }
        .sb-list::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }

        .sb-card { display: flex; flex-direction: column; gap: 3px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 8px 6px 8px; margin-bottom: 6px; text-decoration: none; color: inherit; transition: 0.2s; position: relative; overflow: hidden; }
        .sb-card:hover { transform: translateX(4px); background: rgba(255,255,255,0.06); border-color: #ffd700; }

        .sb-card-head { display: flex; align-items: flex-start; gap: 8px; font-size: 11px; color: #666; }
        .sb-avatar { width: 36px; height: 36px; border-radius: 50%; background: #333; object-fit: cover; flex-shrink: 0; }
        .sb-avatar-sm { width: 18px; height: 18px; border-radius: 50%; background: #333; object-fit: cover; }
        .sb-card-info { display: flex; flex-direction: column; gap: 2px; overflow: hidden; flex: 1; }
        .sb-user-box { display: flex; align-items: center; gap: 2px; color: #ccc; font-weight: 600; flex-wrap: nowrap; white-space: nowrap; line-height: 0.9; }
        .sb-user-box .svg-icon, .dm-user .svg-icon { width: 12px; height: 12px; fill: #888; vertical-align: middle; margin: 0 4px; }
        .sb-user-box .action-emoji, .dm-user .action-emoji { width: 14px; height: 14px; vertical-align: middle; margin: 0 4px; }

        .sb-card-title { font-size: 12px; font-weight: 600; color: #eee; line-height: 1.4; }
        .sb-card-excerpt { font-size: 10px; color: #999; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 2px; }
        .sb-card-excerpt-cited { font-size: 10px; color: #999; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; border-left: 2px solid #333; padding-left: 6px; margin-top: 2px; }
        .sb-card-img { width: 100%; height: 100px; object-fit: cover; border-radius: 4px; margin-top: 4px; border: 1px solid #333; }
        .sb-card-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; }
        .sb-badge { font-size: 9px; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.1); }
        .sb-action { font-size: 10px; color: #555; }
        .sb-timestr { font-size: 10px; color: #555; }

        /* 弹幕 */
        .dm-container { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; pointer-events: none; overflow: hidden; z-index: 10; }
        .dm-item { position: absolute; left: 100vw; display: flex; flex-direction: column; gap: 4px; background: rgba(30, 30, 30, 0.9); border: 1px solid #444; padding: 10px 15px; border-radius: 30px; color: #fff; box-shadow: 0 4px 15px rgba(0,0,0,0.5); max-width: 500px; min-width: 260px; pointer-events: auto; cursor: pointer; will-change: transform; animation: dm-fly 12s linear forwards; backdrop-filter: blur(5px); overflow: hidden; }
        .dm-item:hover { z-index: 20; background: #222; border-color: #ffd700; animation-play-state: paused; }
        .dm-top { display: flex; align-items: flex-start; gap: 8px; }
        .dm-avatar { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; background: #333; }
        .dm-info { display: flex; flex-direction: column; overflow: hidden; flex: 1; }
        .dm-user { font-size: 12px; color: #ccc; font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 2px; flex-wrap: nowrap; white-space: nowrap; line-height: 0.9; }
        .dm-title { font-size: 13px; font-weight: 600; color: #eee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dm-excerpt { font-size: 11px; color: #888; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3; }
        .dm-excerpt-cited { font-size: 11px; color: #888; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3; border-left: 2px solid #333; padding-left: 6px; }

        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes dm-fly { from { transform: translateX(0); } to { transform: translateX(-140vw); } }
        @keyframes dm-pop { 0% { opacity: 1; transform: scale(1.2); } 100% { opacity: 0; transform: scale(0.8) translateY(-30px); } }

        .dm-icon-pop { position: absolute; pointer-events: none; animation: dm-pop 3s ease-out forwards; }
        .dm-icon-pop .svg-icon { width: 100px; height: 100px; fill: #fa6c8d; filter: drop-shadow(0 4px 20px rgba(250,108,141,0.6)); }
        .dm-icon-pop .action-emoji { width: 100px; height: 100px; filter: drop-shadow(0 4px 20px rgba(255,255,255,0.4)); }

        /* 调试日志 */
        .sb-console { height: 20px; background: #000; border-top: 1px solid #333; padding: 5px; font-family: monospace; font-size: 10px; overflow-y: auto; color: #666; }
        .log-ok { color: #0f0; } .log-err { color: #f55; }
    `;

    // --- 逻辑处理 ---
    async function fetchUser(username, isInitial = false) {
        const timeout = Math.floor(getUserCycleDuration(username) / 3);
        try {
            const profileJson = await safeFetch(`${CONFIG.HOST}/u/${username}.json`, timeout);
            if (!profileJson || !profileJson.user) return [];

            const newLastSeen = profileJson.user.last_seen_at;
            const newLastPosted = profileJson.user.last_posted_at;
            const oldProfile = State.userProfiles[username];

            State.multipliers[username] = getIntervalMultiplier(newLastSeen);
            const hasChanged = !oldProfile || oldProfile.last_seen_at !== newLastSeen;

            State.userProfiles[username] = { last_posted_at: newLastPosted, last_seen_at: newLastSeen };

            if (!isInitial && !hasChanged && State.data[username]?.length > 0) {
               log(`[${username}] dormant.`, 'info');
               return 'SKIPPED';
            }

            await wait(CONFIG.THROTTLE_MS);
            const [jsonActions, jsonReactions] = await Promise.all([
                safeFetch(`${CONFIG.HOST}/user_actions.json?offset=0&limit=${CONFIG.LOG_LIMIT_PER_USER}&username=${username}&filter=1,4,5`, timeout),
                safeFetch(`${CONFIG.HOST}/discourse-reactions/posts/reactions.json?username=${username}`, timeout)
            ]);

            const actions = (jsonActions.user_actions || []).map(action => {
                if (action.action_type === 1) {
                    return { ...action, username: action.acting_username, name: action.acting_name, user_id: action.acting_user_id, avatar_template: action.acting_avatar_template, acting_username: action.username, acting_name: action.name, acting_user_id: action.user_id, acting_avatar_template: action.avatar_template };
                }
                return action;
            });

            const reactions = (jsonReactions || []).map(r => ({
                id: r.id, post_id: r.post_id, created_at: r.created_at,
                username: r.user?.username || '', name: r.user?.name || '', user_id: r.user_id, avatar_template: r.user?.avatar_template || '',
                acting_username: r.post?.user?.username || r.post?.username || '', acting_name: r.post?.user?.name || r.post?.name || '', acting_user_id: r.post?.user_id || '', acting_avatar_template: r.post?.user?.avatar_template || r.post?.avatar_template || '',
                topic_id: r.post?.topic_id, post_number: r.post?.post_number, title: r.post?.topic_title || r.post?.topic?.title || '', excerpt: r.post?.excerpt || '', category_id: r.post?.category_id,
                action_type: r.reaction?.reaction_value || 'reaction', reaction_value: r.reaction?.reaction_value
            }));

            return [...actions, ...reactions].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, CONFIG.LOG_LIMIT_PER_USER);
        } catch (e) {
            log(`[${username}]: ${e.message}`, 'error');
            return e.status === 429 ? 'RATE_LIMIT' : 'ERROR';
        }
    }

    function getUniqueId(action) {
        if (action.id) return action.id;
        if (action.topic_id && action.post_number) return `${action.topic_id}_${action.post_number}`;
        return `ts_${Date.now()}`;
    }

    function cleanHtml(html) {
        if (!html) return "";
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        tmp.querySelectorAll('img').forEach(img => {
            if (img.classList.contains('emoji')) img.replaceWith(img.alt);
            else img.remove();
        });
        return (tmp.textContent || tmp.innerText || "").replace(/\s+/g, ' ').trim();
    }

    function extractImg(html) {
        if (!html) return null;
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        const img = tmp.querySelector('img:not(.emoji)');
        if (!img) return null;
        let src = img.src;
        if (src.startsWith('/')) src = CONFIG.HOST + src;
        if (!src.startsWith('http')) {
             const rawSrc = img.getAttribute('src');
             if (rawSrc && rawSrc.startsWith('/')) return CONFIG.HOST + rawSrc;
        }
        return src;
    }

    function getActionIcon(actionType) {
        const ACTION_ICONS = {
            reply: '<svg class="fa d-icon d-icon-reply svg-icon svg-string" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 512 512"><path d="M8.309 189.836L184.313 37.851C199.719 24.546 224 35.347 224 56.015v80.053c160.629 1.839 288 34.032 288 186.258 0 61.441-39.581 122.309-83.333 154.132-13.653 9.931-33.111-2.533-28.077-18.631 45.344-145.012-21.507-183.51-176.59-185.742V360c0 20.7-24.3 31.453-39.687 18.164l-176.004-152c-11.071-9.562-11.086-26.753 0-36.328z"/></svg>',
            post: '<svg class="fa d-icon d-icon-pencil svg-icon svg-string" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 512 512"><path d="M497.9 142.1l-46.1 46.1c-4.7 4.7-12.3 4.7-17 0l-111-111c-4.7-4.7-4.7-12.3 0-17l46.1-46.1c18.7-18.7 49.1-18.7 67.9 0l60.1 60.1c18.8 18.7 18.8 49.1 0 67.9zM284.2 99.8L21.6 362.4.4 483.9c-2.9 16.4 11.4 30.6 27.8 27.8l121.5-21.3 262.6-262.6c4.7-4.7 4.7-12.3 0-17l-111-111c-4.8-4.7-12.4-4.7-17.1 0zM88 424h48v36.3l-64.5 11.3-31.1-31.1L51.7 376H88v48z"/></svg>',
            like: '<svg class="fa d-icon d-icon-d-heart svg-icon svg-string" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 640 640"><path fill="#fa6c8d" d="M305 151.1L320 171.8L335 151.1C360 116.5 400.2 96 442.9 96C516.4 96 576 155.6 576 229.1L576 231.7C576 343.9 436.1 474.2 363.1 529.9C350.7 539.3 335.5 544 320 544C304.5 544 289.2 539.4 276.9 529.9C203.9 474.2 64 343.9 64 231.7L64 229.1C64 155.6 123.6 96 197.1 96C239.8 96 280 116.5 305 151.1z"/></svg>',
        };
        const REACTION_ICONS = {
            "tieba_087": '/uploads/default/original/3X/2/e/2e09f3a3c7b27eacbabe9e9614b06b88d5b06343.png?v=15',
            "bili_057": '/uploads/default/original/3X/1/a/1a9f6c30e88a7901b721fffc1aaeec040f54bdf3.png?v=15'
        };

        if (actionType === 5) return ACTION_ICONS.reply;
        if (actionType === 4) return ACTION_ICONS.post;
        if (actionType === 1) return ACTION_ICONS.like;
        if (typeof actionType === 'string') {
            if (REACTION_ICONS[actionType]) return `<img src="${CONFIG.HOST}${REACTION_ICONS[actionType]}" class="action-emoji" alt=":${actionType}:">`;
            return `<img src="${CONFIG.HOST}/images/emoji/twemoji/${actionType}.png?v=15" class="action-emoji" alt=":${actionType}:">`;
        }
        return ACTION_ICONS.reply;
    }

    function getUsernameColor(username) {
        if (!username) return null;
        const lower = username.toLowerCase();
        if (State.selfUser && lower === State.selfUser.toLowerCase()) return nameColors[0];
        const userIndex = State.users.findIndex(u => u.toLowerCase() === lower);
        if (userIndex !== -1 && userIndex + 1 < nameColors.length) return nameColors[userIndex + 1];
        return null;
    }

    function formatActionInfo(action) {
        const icon = getActionIcon(action.action_type);
        const user = action.username || '';
        const actingUser = action.acting_username || '';
        const actingAvatar = action.acting_avatar_template ? CONFIG.HOST + action.acting_avatar_template.replace("{size}", "24") : null;
        const userColor = getUsernameColor(user);
        const actingUserColor = getUsernameColor(actingUser);
        const formatUsername = (content, color) => color ? `<span style="color:${color}; display: flex; align-items: center; gap: 1px;">${content}</span>` : content;
        const userHtml = formatUsername(user, userColor);
        if (actingUser && actingUser !== user) {
            const actingContent = actingAvatar ? `<img src="${actingAvatar}" class="sb-avatar-sm">&nbsp;${actingUser}` : actingUser;
            const actingHtml = formatUsername(actingContent, actingUserColor);
            return { user, icon, actingUser, actingAvatar, html: `${userHtml} ${icon} ${actingHtml}` };
        }
        return { user, icon, actingUser: null, actingAvatar: null, html: `${userHtml} ${icon}` };
    }

    // --- Shadow DOM & UI ---
    let shadowRoot;

    function log(msg, type='info') {
        if (!shadowRoot) return;
        console.log(`[LD-Seeking] ${msg}`);
        const box = shadowRoot.getElementById('sb-console');
        if (box) {
            const d = document.createElement('div');
            d.className = type === 'error' ? 'log-err' : (type === 'success' ? 'log-ok' : '');
            d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
            box.prepend(d);
            if (box.children.length > 20) box.lastChild.remove();
        }
    }

    function sendNotification(action) {
        const uid = getUniqueId(action);
        if (pushedIds.has(uid)) return;
        pushedIds.add(uid);
        if (pushedIds.size > 200) pushedIds.delete(pushedIds.values().next().value);

        let avatar = "https://linux.do/uploads/default/original/3X/9/d/9dd4973138ccd78e8907865261d7b14d45a96d1c.png";
        if (action.avatar_template) avatar = CONFIG.HOST + action.avatar_template.replace("{size}", "64");
        const excerpt = cleanHtml(action.excerpt);
        const link = `${CONFIG.HOST}/t/${action.topic_id}/${action.post_number}`;

        // 1. 弹幕
        if (State.enableDanmaku && shadowRoot) {
            const layer = shadowRoot.getElementById('dm-container');
            if (layer) {
                // Icon pop for likes/reactions
                const isLikeOrReaction = action.action_type === 1 || typeof action.action_type === 'string';
                const isSelfUser = State.selfUser && action.acting_username.toLowerCase() === State.selfUser.toLowerCase();
                if (isLikeOrReaction && isSelfUser) {
                    const iconPop = document.createElement('div');
                    iconPop.className = 'dm-icon-pop';
                    iconPop.style.left = `${10 + Math.random() * 70}vw`;
                    iconPop.style.top = `${10 + Math.random() * 60}vh`;
                    iconPop.innerHTML = getActionIcon(action.action_type);
                    layer.appendChild(iconPop);
                    setTimeout(() => iconPop.remove(), 3000);
                }

                // Message danmaku
                const item = document.createElement('div');
                item.className = 'dm-item';
                item.style.top = `${5 + Math.random() * 80}vh`;
                item.style.animationDuration = `${8 + Math.random() * 4}s`;
                item.onclick = () => window.open(link, '_blank');

                const actionInfo = formatActionInfo(action);
                const excerptClass = (action.action_type === 4 || action.action_type === 5) ? 'dm-excerpt' : 'dm-excerpt-cited';
                item.innerHTML = `
                    <div class="dm-top">
                        <img src="${avatar}" class="dm-avatar">
                        <div class="dm-info">
                            <div class="dm-user">${actionInfo.html}</div>
                            <div class="dm-title">${action.title}</div>
                        </div>
                    </div>
                    ${excerpt ? `<div class="${excerptClass}">${excerpt}</div>` : ''}
                `;
                layer.appendChild(item);
                setTimeout(() => item.remove(), 16000);
            }
        }

        // 2. 系统通知
        if (State.enableSysNotify && document.hidden) {
            GM_notification({
                title: `${action.username} @ Linux.do`,
                text: `${action.title}\n${excerpt.substring(0, 50)}`,
                image: avatar,
                onclick: () => { window.focus(); window.open(link, '_blank'); }
            });
        }
    }

    // Process a single user's data and handle notifications
    async function processUser(user, isInitial = false) {
        const result = await fetchUser(user, isInitial);
        if (result === 'SKIPPED') return false;
        if (result === 'RATE_LIMIT' || result === 'ERROR') return result;
        const actions = result;
        if (!actions || actions.length === 0) return false;

        const latest = actions[0];
        const latestId = getUniqueId(latest);
        const lastSavedId = State.lastIds[user];
        let hasUpdates = false;

        if (!lastSavedId) {
            State.lastIds[user] = latestId;
            hasUpdates = true;
        } else if (latestId !== lastSavedId && !isInitial) {
            const diff = [];
            for (let act of actions) {
                if (getUniqueId(act) === lastSavedId) break;
                diff.push(act);
            }
            if (diff.length > 0) {
                log(`[${user}] has ${diff.length} new`, 'success');
                diff.reverse().forEach((act, i) => setTimeout(() => {
                    sendNotification(act);
                    broadcastNewAction(act);
                }, i * 1000));
                State.lastIds[user] = latestId;
                hasUpdates = true;
            }
        }
        State.data[user] = actions;
        log(`[${user}] has ${actions.length} actions`, 'info');
        return hasUpdates;
    }

    // Full query for all users (initial load and manual refresh)
    async function tickAll() {
        if (!State.isLeader) {
            channel.postMessage({ type: 'cmd_refresh_all' });
            return;
        }
        if (State.isProcessing) return;
        State.isProcessing = true;
        const dot = shadowRoot?.querySelector('.sb-status-dot');
        if (dot) dot.className = 'sb-status-dot loading';

        let hasUpdates = false;
        const now = Date.now();
        for (const user of State.users) {
            const result = await processUser(user, true);
            if (result === true) hasUpdates = true;

            let nextDelay = getUserCycleDuration(user) + Math.random() * 10000;
            if (result === 'RATE_LIMIT') nextDelay = CONFIG.ERROR_BACKOFF_MS * 2;
            else if (result === 'ERROR') nextDelay = CONFIG.ERROR_BACKOFF_MS;

            State.nextFetchTime[user] = now + nextDelay;
            await wait(CONFIG.THROTTLE_MS);
        }
        if (hasUpdates) saveConfig();

        renderFeed();
        broadcastState();
        updateStatusDot();
        State.isProcessing = false;
    }

    async function scheduler() {
        if (!State.isLeader || State.isProcessing || State.users.length === 0) return;
        const now = Date.now();
        const dueUsers = State.users.filter(u => !State.nextFetchTime[u] || now >= State.nextFetchTime[u]);
        if (dueUsers.length === 0) return;

        State.isProcessing = true;
        const user = dueUsers[0];
        const dot = shadowRoot?.querySelector('.sb-status-dot');
        if (dot) dot.className = 'sb-status-dot loading';

        const result = await processUser(user, false);
        let nextDelay = getUserCycleDuration(user) + Math.random() * 10000;
        if (result === 'RATE_LIMIT') nextDelay = CONFIG.ERROR_BACKOFF_MS * 2;
        else if (result === 'ERROR') nextDelay = CONFIG.ERROR_BACKOFF_MS;

        State.nextFetchTime[user] = Date.now() + nextDelay;
        if (result === true) saveConfig();

        renderFeed();
        broadcastState();
        updateStatusDot();
        State.isProcessing = false;
    }

    function updateStatusDot() {
        const dot = shadowRoot?.querySelector('.sb-status-dot');
        if (dot) dot.className = `sb-status-dot ${State.isLeader ? 'leader' : 'follower'}`;
    }

    function broadcastNewAction(action) {
        channel.postMessage({ type: 'new_action', action });
    }

    function takeLeadership() {
        if (State.isLeader) return;
        if (leaderCheckTimeout) {
            clearTimeout(leaderCheckTimeout);
            leaderCheckTimeout = null;
        }
        State.isLeader = true;
        updateStatusDot();
        channel.postMessage({ type: 'leader_takeover' });
        scheduler();
    }
    function handleWindowFocus() {
        if (State.isLeader) return;
        pendingLeadershipTimer = setTimeout(() => {
            takeLeadership();
            pendingLeadershipTimer = null;
        }, 2 * 60 * 1000);
    }
    function handleWindowBlur() {
        if (pendingLeadershipTimer) {
            clearTimeout(pendingLeadershipTimer);
            pendingLeadershipTimer = null;
        }
    }

    channel.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === 'leader_check') { if (State.isLeader) channel.postMessage({ type: 'leader_here' }); }
        else if (msg.type === 'leader_here') { if (leaderCheckTimeout) { clearTimeout(leaderCheckTimeout); leaderCheckTimeout = null; } State.isLeader = false; updateStatusDot(); channel.postMessage({ type: 'data_request' }); }
        else if (msg.type === 'data_request') { if (State.isLeader) broadcastState(); }
        else if (msg.type === 'leader_resign') { setTimeout(() => attemptLeadership(), Math.random() * 300); }
        else if (msg.type === 'leader_takeover') {
            if (State.isLeader) {
                State.isLeader = false;
                if (leaderCheckTimeout) clearTimeout(leaderCheckTimeout);
                broadcastState();
                updateStatusDot();
            }
        }
        else if (msg.type === 'data_update') {
            if (!State.isLeader) {
                if (msg.users && JSON.stringify(msg.users) !== JSON.stringify(State.users)) {
                    State.users = msg.users || [];
                    renderSidebarRows();
                }
                State.data = msg.data;
                State.lastIds = msg.lastIds;
                if(msg.hiddenUsers) State.hiddenUsers = new Set(msg.hiddenUsers);
                if(msg.nextFetchTime) State.nextFetchTime = msg.nextFetchTime;
                if(msg.multipliers) State.multipliers = msg.multipliers;
                if(msg.userProfiles) State.userProfiles = msg.userProfiles;
                renderFeed();
            }
        }
        else if (msg.type === 'new_action') { if (!State.isLeader && State.enableDanmaku) sendNotification(msg.action); }
        else if (msg.type === 'cmd_refresh_all') { if (State.isLeader) tickAll(); }
        else if (msg.type === 'cmd_refresh_user') { if (State.isLeader) refreshSingleUser(msg.username); }
        else if (msg.type === 'cmd_config_sync') {
            if (msg.key === 'enableDanmaku') State.enableDanmaku = msg.value;
            if (msg.key === 'enableSysNotify') State.enableSysNotify = msg.value;
            saveConfig();
            if (shadowRoot) {
                const btn = shadowRoot.getElementById(msg.key === 'enableDanmaku' ? 'btn-dm' : 'btn-sys');
                if (btn) btn.className = `sb-icon-btn ${msg.value?'active':''}`;
            }
        }
        else if (msg.type === 'cmd_add_user') {
            if (State.isLeader && !State.users.includes(msg.username) && State.users.length < CONFIG.MAX_USERS) {
                fetchUser(msg.username, true).then(res => {
                    if (res && res !== 'SKIPPED' && res !== 'RATE_LIMIT' && res !== 'ERROR') {
                        State.users.push(msg.username);
                        saveConfig();
                        renderSidebarRows();
                        tickAll();
                    }
                });
            } else if (State.users.length >= CONFIG.MAX_USERS) {
                log(`Max ${CONFIG.MAX_USERS} users reached.`, 'error');
            }
        }
        else if (msg.type === 'cmd_remove_user') {
            if (State.isLeader) removeUser(msg.username);
        }
    };

    function attemptLeadership() {
        channel.postMessage({ type: 'leader_check' });
        leaderCheckTimeout = setTimeout(() => { State.isLeader = true; leaderCheckTimeout = null; tickAll(); }, 200);
    }
    window.addEventListener('beforeunload', () => { if (State.isLeader) channel.postMessage({ type: 'leader_resign' }); });

    // --- UI 构建 ---
    function createUI() {
        if (State.isInitialized) return;
        const host = document.createElement('div');
        host.id = 'ld-seeking-host';
        document.body.appendChild(host);
        shadowRoot = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = css;
        shadowRoot.appendChild(style);
        const container = document.createElement('div');
        container.innerHTML = `
            <div id="dm-container" class="dm-container"></div>
            <div id="ld-sidebar" class="${State.isCollapsed ? 'collapsed' : ''}">
                <div id="ld-toggle-ball" title="切换侧边栏">👀</div>
                <div class="sb-header">
                    <div class="sb-title-row">
                        <div class="sb-title"><div class="sb-status-dot ok"></div> 追觅 · Seeking</div>
                        <div class="sb-tools">
                            <button id="btn-dm" class="sb-icon-btn ${State.enableDanmaku?'active':''}" title="弹幕">💬</button>
                            <button id="btn-sys" class="sb-icon-btn ${State.enableSysNotify?'active':''}" title="通知">🔔</button>
                            <button id="btn-refresh" class="sb-icon-btn" title="刷新">🔄</button>
                        </div>
                    </div>
                    <div class="sb-input-group">
                        <input id="inp-user" class="sb-input" placeholder="添加用户名...">
                        <button id="btn-add" class="sb-btn-add">＋</button>
                    </div>
                    <div id="sb-tags" class="sb-tags"></div>
                </div>
                <div id="sb-list" class="sb-list"></div>
                <div id="sb-console" class="sb-console"></div>
            </div>`;
        shadowRoot.appendChild(container);

        shadowRoot.getElementById('ld-toggle-ball').onclick = () => {
            const bar = shadowRoot.getElementById('ld-sidebar');
            bar.classList.toggle('collapsed');
            State.isCollapsed = bar.classList.contains('collapsed');
            // GM_setValue('ld_is_collapsed', State.isCollapsed);
            sessionStorage.setItem('ld_is_collapsed', State.isCollapsed);
        };

        shadowRoot.getElementById('btn-dm').onclick = function() {
            State.enableDanmaku = !State.enableDanmaku;
            this.className = `sb-icon-btn ${State.enableDanmaku?'active':''}`;
            saveConfig();
            channel.postMessage({ type: 'cmd_config_sync', key: 'enableDanmaku', value: State.enableDanmaku });
        };

        shadowRoot.getElementById('btn-sys').onclick = function() {
            State.enableSysNotify = !State.enableSysNotify;
            this.className = `sb-icon-btn ${State.enableSysNotify?'active':''}`;
            if (State.enableSysNotify && Notification.permission !== 'granted') Notification.requestPermission();
            saveConfig();
            channel.postMessage({ type: 'cmd_config_sync', key: 'enableSysNotify', value: State.enableSysNotify });
        };
        shadowRoot.getElementById('btn-refresh').onclick = () => tickAll();

        const handleAdd = async () => {
            const inp = shadowRoot.getElementById('inp-user');
            const name = inp.value.trim();
            if(!name || State.users.includes(name)) return;
            const btn = shadowRoot.getElementById('btn-add');
            btn.innerText = '...';

            if (!State.isLeader) {
                channel.postMessage({ type: 'cmd_add_user', username: name });
                btn.innerText = '＋';
                inp.value = '';
                return;
            }

            const test = await fetchUser(name, true);
            if(test && test !== 'SKIPPED' && test !== 'RATE_LIMIT' && test !== 'ERROR') {
                if (State.users.length >= CONFIG.MAX_USERS) {
                    log(`Max ${CONFIG.MAX_USERS} users reached.`, 'error');
                } else {
                    State.users.push(name);
                    saveConfig();
                    renderSidebarRows();
                    tickAll();
                }
            }
            btn.innerText = '＋';
            inp.value = '';
        };
        shadowRoot.getElementById('btn-add').onclick = handleAdd;
        shadowRoot.getElementById('inp-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } });

        renderSidebarRows();
        startVisualLoops();
        window.addEventListener('focus', handleWindowFocus);
        window.addEventListener('blur', handleWindowBlur);

        log('Engine started.', 'success');
        setInterval(() => scheduler(), 1000);
        State.isInitialized = true;
    }

    function removeUser(name) {
        if (!State.isLeader) {
            channel.postMessage({ type: 'cmd_remove_user', username: name });
            return;
        }
        State.users = State.users.filter(u => u !== name);
        delete State.lastIds[name];
        delete State.multipliers[name];
        saveConfig();
        renderSidebarRows();
        renderFeed();
        broadcastState();
    }

    function toggleUserVisibility(name) {
        if (State.hiddenUsers.has(name)) State.hiddenUsers.delete(name);
        else State.hiddenUsers.add(name);
        saveConfig();

        const row = shadowRoot.getElementById(`row-${name}`);
        if(row) {
            const isHidden = State.hiddenUsers.has(name);
            row.className = `sb-user-row ${isHidden ? '' : 'active'}`;
            const nameEl = row.querySelector('.sb-user-name');
            if(nameEl) {
                nameEl.className = `sb-user-name ${isHidden ? 'disabled' : ''}`;
                nameEl.style.color = isHidden ? '' : getUserColor(name);
            }
            const timer = shadowRoot.getElementById(`timer-${name}`);
            if(timer) {
                const circle = timer.querySelector('.timer-progress');
                if(circle) circle.setAttribute('stroke', isHidden ? '#666' : getUserColor(name));
            }
        }
        renderFeed();
        broadcastState();
    }

    async function refreshSingleUser(username) {
        if (!State.isLeader) {
            channel.postMessage({ type: 'cmd_refresh_user', username });
            return;
        }
        if (State.isProcessing) return;
        State.isProcessing = true;
        const dot = shadowRoot?.querySelector('.sb-status-dot');
        if (dot) dot.className = 'sb-status-dot loading';
        const result = await processUser(username, false);
        let nextDelay = getUserCycleDuration(username) + Math.random() * 10000;
        if (result === 'RATE_LIMIT') nextDelay = CONFIG.ERROR_BACKOFF_MS * 2;
        else if (result === 'ERROR') nextDelay = CONFIG.ERROR_BACKOFF_MS;

        State.nextFetchTime[username] = Date.now() + nextDelay;
        if (result === true) saveConfig();
        renderFeed();
        broadcastState();
        updateStatusDot();
        State.isProcessing = false;
    }

    // --- Visual Loops ---
    function startVisualLoops() {
        // High Frequency: Timer Circles (Animation Frame)
        const updateTimers = () => {
            if (!shadowRoot) return;
            const now = Date.now();
            State.users.forEach(u => {
                const timerEl = shadowRoot.getElementById(`timer-${u}`);
                if (!timerEl) return;
                const progressCircle = timerEl.querySelector('.timer-progress');
                if (!progressCircle) return;

                const next = State.nextFetchTime[u];
                const totalDuration = getUserCycleDuration(u);
                const circumference = parseFloat(timerEl.getAttribute('data-circumference'));

                if (next) {
                    const remaining = Math.max(0, next - now);
                    const progress = Math.min(1, Math.max(0, remaining / totalDuration));
                    const offset = circumference * (1 - progress);
                    progressCircle.style.strokeDashoffset = offset;
                } else {
                    progressCircle.style.strokeDashoffset = 0;
                }
            });
            requestAnimationFrame(updateTimers);
        };
        requestAnimationFrame(updateTimers);

        // Low Frequency: Text & Tooltip Updates (1s Interval)
        setInterval(() => {
            if (!shadowRoot) return;
            State.users.forEach(u => {
                const timerEl = shadowRoot.getElementById(`timer-${u}`);
                if (timerEl) {
                    const titleEl = timerEl.querySelector('title');
                    if (titleEl) {
                        const duration = getUserCycleDuration(u);
                        const timerTitle = `刷新间隔：${(duration / 1000).toFixed(0)}s`;
                        if (titleEl.textContent !== timerTitle) {
                            titleEl.textContent = timerTitle;
                        }
                    }
                }

                const activityEl = shadowRoot.getElementById(`activity-${u}`);
                if (!activityEl) return;
                const isHidden = State.hiddenUsers.has(u);
                const userColor = getUserColor(u);
                const profile = State.userProfiles[u];
                const userData = State.data[u];

                if (profile) {
                    const spans = activityEl.querySelectorAll('span');
                    if (spans.length >= 3) {
                        const postedIso = profile.last_posted_at;
                        const actionIso = userData?.[0]?.created_at;
                        const seenIso = profile.last_seen_at;

                        const postedAgo = postedIso ? formatTimeAgo(postedIso) : '--';
                        if (spans[0].textContent !== postedAgo) spans[0].textContent = postedAgo;
                        spans[0].style.color = isHidden ? '#666' : getTimeAgoColor(postedIso, userColor);

                        const lastActionAgo = actionIso ? formatTimeAgo(actionIso) : '--';
                        if (spans[1].textContent !== lastActionAgo) spans[1].textContent = lastActionAgo;
                        spans[1].style.color = isHidden ? '#666' : getTimeAgoColor(actionIso, userColor);

                        const seenAgo = seenIso ? formatTimeAgo(seenIso) : '--';
                        if (spans[2].textContent !== seenAgo) spans[2].textContent = seenAgo;
                        spans[2].style.color = isHidden ? '#666' : getTimeAgoColor(seenIso, userColor);
                    }
                }
            });
        }, 1000);
    }

    // Renders the static structure of sidebar rows. Called ONLY on structure change (add/remove user).
    function renderSidebarRows() {
        if (!shadowRoot) return;
        const div = shadowRoot.getElementById('sb-tags');
        div.innerHTML = '';

        State.users.forEach(u => {
            const isHidden = State.hiddenUsers.has(u);
            const userColor = getUserColor(u);
            const row = document.createElement('div');
            row.id = `row-${u}`;
            row.className = `sb-user-row ${isHidden ? '' : 'active'}`;

            const delBtn = document.createElement('div');
            delBtn.className = 'sb-del';
            delBtn.textContent = '×';
            delBtn.title = '移除用户';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                removeUser(u);
            };

            const timerSize = 10, timerStroke = 2;
            const timerRadius = (timerSize - timerStroke) / 2;
            const timerCircum = 2 * Math.PI * timerRadius;

            const timerSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            timerSvg.setAttribute('width', timerSize);
            timerSvg.setAttribute('height', timerSize);
            timerSvg.setAttribute('class', 'sb-timer-circle');
            timerSvg.id = `timer-${u}`;
            timerSvg.style.cursor = 'pointer';
            timerSvg.setAttribute('data-circumference', timerCircum);
            timerSvg.innerHTML = `
                <title>刷新间隔</title>
                <circle cx="${timerSize/2}" cy="${timerSize/2}" r="${timerRadius}"
                    fill="none" stroke="#333" stroke-width="${timerStroke}"/>
                <circle class="timer-progress" cx="${timerSize/2}" cy="${timerSize/2}" r="${timerRadius}"
                    fill="none" stroke="${isHidden ? '#666' : userColor}" stroke-width="${timerStroke}"
                    stroke-dasharray="${timerCircum}" stroke-dashoffset="${timerCircum}"
                    transform="rotate(-90 ${timerSize/2} ${timerSize/2})"/>
            `;
            timerSvg.onclick = (e) => {
                e.stopPropagation();
                refreshSingleUser(u);
            };

            const activityEl = document.createElement('div');
            activityEl.className = 'sb-user-activity';
            activityEl.id = `activity-${u}`;
            activityEl.innerHTML = `<span title="最近发帖">--</span><span title="最近动态">--</span><span title="最近在线">--</span>`;

            const nameEl = document.createElement('div');
            nameEl.className = `sb-user-name ${isHidden ? 'disabled' : ''}`;
            nameEl.textContent = u;
            if (!isHidden) nameEl.style.color = userColor;

            row.appendChild(delBtn);
            row.appendChild(timerSvg);
            row.appendChild(nameEl);
            row.appendChild(activityEl);
            row.onclick = () => toggleUserVisibility(u);
            div.appendChild(row);
        });
    }

    function renderFeed() {
        if (!shadowRoot) return;
        const div = shadowRoot.getElementById('sb-list');
        let all = [];
        Object.entries(State.data).forEach(([user, arr]) => { if (!State.hiddenUsers.has(user)) all.push(...arr); });
        all.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

        if (all.length === 0) {
            div.innerHTML = `<div style="text-align:center;color:#555;margin-top:40px;font-size:12px;">暂无数据或正在连接...</div>`;
            return;
        }

        // Batch Render
        div.innerHTML = all.map(item => {
            let avatar = "https://linux.do/uploads/default/original/3X/9/d/9dd4973138ccd78e8907865261d7b14d45a96d1c.png";
            if(item.avatar_template) avatar = CONFIG.HOST + item.avatar_template.replace("{size}", "48");

            const date = new Date(item.created_at);
            const now = new Date();
            const timeStr = date.toDateString() === now.toDateString() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : date.toLocaleString('en-US', { month: 'short', day: '2-digit' });
            const catName = categoryMap.get(item.category_id) || "未分区";
            const catColor = categoryColors[catName] || "#9e9e9e";
            const excerpt = cleanHtml(item.excerpt);
            const imgUrl = extractImg(item.excerpt);
            const link = `${CONFIG.HOST}/t/${item.topic_id}/${item.post_number}`;
            const actionInfo = formatActionInfo(item);
            const excerptClass = (item.action_type === 4 || item.action_type === 5) ? 'sb-card-excerpt' : 'sb-card-excerpt-cited';
            return `
                <a href="${link}" target="_blank" class="sb-card">
                    <div class="sb-card-head">
                        <img src="${avatar}" class="sb-avatar">
                        <div class="sb-card-info">
                            <div class="sb-user-box">${actionInfo.html}</div>
                            <div class="sb-card-title">${item.title}</div>
                        </div>
                    </div>
                    ${excerpt ? `<div class="${excerptClass}">${excerpt}</div>` : ''}
                    ${imgUrl ? `<img src="${imgUrl}" class="sb-card-img" loading="lazy">` : ''}
                    <div class="sb-card-foot">
                        <span class="sb-badge" style="color:${catColor};background:${catColor}15">${catName}</span>
                        <span class="sb-timestr">${timeStr}</span>
                    </div>
                </a>
            `;
        }).join('');
    }

    const init = async () => {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', createUI);
        } else {
            createUI();
        }
        attemptLeadership();
    };

    init();
})();
