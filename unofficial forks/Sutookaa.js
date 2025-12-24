// ==UserScript==
// @name         LinuxDo追觅
// @namespace    http://tampermonkey.net/
// @version      2025-08-06-v21-cross-origin
// @description  在任何网页上实时监控 Linux.do 活动。使用 Shadow DOM 隔离样式，GM_xmlhttpRequest 突破跨域限制。
// @author       NullUser
// @match        https://linux.do/*
// @connect      linux.do
// @icon         https://linux.do/uploads/default/original/3X/9/d/9dd4973138ccd78e8907865261d7b14d45a96d1c.png
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        window.focus
// ==/UserScript==

(function () {
    'use strict';

    // 防止在 iframe 中运行 (如广告框)
    if (window.top !== window.self) return;

    // --- 配置 ---
    const CONFIG = {
        MAX_USERS: 5,
        SIDEBAR_WIDTH: '300px',
        REFRESH_INTERVAL_MS: 1 * 60 * 1000,
        LOG_LIMIT_PER_USER: 15,
        HOST: 'https://linux.do'
    };

    // --- 类别定义 ---
    const nameColors = ["#ffd700", "#00d4ff", "#ff6b6b", "#4d5ef7ff", "#c77dff", "#00ff88", "#f87ecaff"];

    const categoryColors = {
        '开发调优': '#32c3c3', '国产替代': '#D12C25', '资源荟萃': '#12A89D',
        '网盘资源': '#16b176', '文档共建': '#9cb6c4', '跳蚤市场': '#ED207B',
        '非我莫属': '#a8c6fe', '读书成诗': '#e0d900', '扬帆起航': '#ff9838',
        '前沿快讯': '#BB8FCE', '网络记忆': '#F7941D', '福利羊毛': '#E45735',
        '搞七捻三': '#3AB54A', '社区孵化': '#ffbb00', '运营反馈': '#808281',
        '深海幽域': '#45B7D1', '未分区':   '#9e9e9e',
        '人工智能': '#00d4ff', '软件分享': '#4dabf7'
    };

    const categoryMap = new Map();
    const category_dict = {
        "前沿快讯": [34, 78, 79, 80], "开发调优": [4, 20, 31, 88],
        "搞七捻三": [11, 35, 89, 21], "深海幽域": [45, 57, 58, 59],
        "福利羊毛": [36, 60, 61, 62], "资源荟萃": [14, 83, 84, 85],
        "跳蚤市场": [10, 13, 81, 82], "运营反馈": [2, 15, 16, 27],
        "人工智能": [34], "软件分享": [14]
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

    // Get current logged-in user from Discourse preloaded data
    function getCurrentUser() {
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
        enableSysNotify: saved.enableSysNotify !== false,
        enableDanmaku: saved.enableDanmaku !== false,
        data: {},
        isCollapsed: GM_getValue('ld_is_collapsed', true), // 默认收起
        isProcessing: false,
        currentFilter: 'ALL',
        currentUser: getCurrentUser() // Current logged-in user
    };

    function saveConfig() {
        const store = {
            users: State.users,
            lastIds: State.lastIds,
            enableSysNotify: State.enableSysNotify,
            enableDanmaku: State.enableDanmaku
        };
        GM_setValue('ld_v21_config', JSON.stringify(store));
    }

    // --- 核心网络层 (突破跨域) ---
    function safeFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                    "Accept": "application/json"
                },
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            resolve(JSON.parse(response.responseText));
                        } catch (e) {
                            reject(new Error("JSON Parse Error"));
                        }
                    } else {
                        reject(new Error(`Status ${response.status}`));
                    }
                },
                onerror: (err) => reject(err)
            });
        });
    }

    // --- 样式 (注入 Shadow DOM) ---
    const css = `
        :host { all: initial; font-family: system-ui, -apple-system, sans-serif; font-size: 14px; z-index: 2147483647; position: fixed; top: 0; left: 0; pointer-events: none; width: 100vw; height: 100vh; }

        /* 侧边栏容器 */
        #ld-sidebar { position: fixed; top: 0; left: 0; width: ${CONFIG.SIDEBAR_WIDTH}; height: 100vh; background: rgba(18, 18, 18, 0.95); backdrop-filter: blur(10px); border-right: 1px solid rgba(255, 255, 255, 0.1); display: flex; flex-direction: column; color: #eee; box-shadow: 5px 0 25px rgba(0,0,0,0.5); transition: transform 0.3s cubic-bezier(0.2, 0, 0, 1); pointer-events: auto; }
        #ld-sidebar.collapsed { transform: translateX(-${CONFIG.SIDEBAR_WIDTH}); }

        /* 悬浮开关 (小球) */
        #ld-toggle-ball { position: absolute; right: -24px; top: 50vh; width: 24px; height: 48px; background: #222; border: 1px solid rgba(255,255,255,0.2); border-left: none; border-radius: 0 100px 100px 0; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #00d4ff; box-shadow: 2px 0 10px rgba(0,0,0,0.3); pointer-events: auto; transition: 0.2s; }
        #ld-toggle-ball:hover { width: 32px; background: #333; }

        /* 头部 */
        .sb-header { padding: 15px; background: rgba(0,0,0,0.3); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .sb-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .sb-title { font-weight: 800; font-size: 16px; color: #fff; display: flex; align-items: center; gap: 8px; }
        .sb-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; transition: 0.3s; }
        .sb-status-dot.ok { background: #00ff88; box-shadow: 0 0 8px #00ff88; }
        .sb-status-dot.loading { background: #00d4ff; animation: pulse 1s infinite; }

        /* 工具栏 */
        .sb-tools { display: flex; gap: 6px; }
        .sb-icon-btn { background: transparent; border: none; color: #888; cursor: pointer; font-size: 14px; padding: 4px; border-radius: 4px; transition: 0.2s; }
        .sb-icon-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
        .sb-icon-btn.active { color: #00d4ff; background: rgba(0, 212, 255, 0.1); }

        /* 输入框 */
        .sb-input-group { display: flex; gap: 5px; margin-bottom: 10px; }
        .sb-input { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 6px 10px; border-radius: 6px; outline: none; font-size: 12px; }
        .sb-input:focus { border-color: #00d4ff; }
        .sb-btn-add { background: #00d4ff; color: #000; border: none; border-radius: 6px; width: 30px; cursor: pointer; font-weight: bold; }

        /* 标签 */
        .sb-tags { display: flex; flex-wrap: wrap; gap: 6px; }
        .sb-tag { font-size: 10px; padding: 3px 8px; border-radius: 10px; background: rgba(255,255,255,0.1); color: #aaa; cursor: pointer; display: flex; align-items: center; gap: 4px; border: 1px solid transparent; }
        .sb-tag:hover { background: rgba(255,255,255,0.2); color: #fff; }
        .sb-tag.active { background: rgba(0, 212, 255, 0.15); color: #00d4ff; border-color: rgba(0,212,255,0.3); }
        .sb-tag-close { font-size: 12px; line-height: 1; opacity: 0.6; }
        .sb-tag-close:hover { opacity: 1; color: #ff5555; }

        /* 列表区域 */
        .sb-list { flex: 1; overflow-y: auto; padding: 10px; scrollbar-width: thin; scrollbar-color: #444 transparent; }
        .sb-list::-webkit-scrollbar { width: 4px; }
        .sb-list::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }

        /* 卡片 */
        .sb-card { display: flex; flex-direction: column; gap: 3px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 8px 6px 8px; margin-bottom: 8px; text-decoration: none; color: inherit; transition: 0.2s; position: relative; overflow: hidden; }
        .sb-card:hover { transform: translateX(4px); background: rgba(255,255,255,0.06); border-color: #00d4ff; }

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

        /* 弹幕 (在 Shadow DOM 内) */
        .dm-container { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; pointer-events: none; overflow: hidden; z-index: 10; }
        .dm-item { position: absolute; left: 100vw; display: flex; flex-direction: column; gap: 4px; background: rgba(30, 30, 30, 0.9); border: 1px solid #444; padding: 10px 15px; border-radius: 30px; color: #fff; box-shadow: 0 4px 15px rgba(0,0,0,0.5); max-width: 500px; min-width: 260px; pointer-events: auto; cursor: pointer; will-change: transform; animation: dm-fly 12s linear forwards; backdrop-filter: blur(5px); }
        .dm-item:hover { z-index: 20; background: #222; border-color: #00d4ff; animation-play-state: paused; }
        .dm-top { display: flex; align-items: flex-start; gap: 8px; }
        .dm-avatar { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; background: #333; }
        .dm-info { display: flex; flex-direction: column; overflow: hidden; flex: 1; }
        .dm-user { font-size: 12px; color: #ccc; font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 2px; flex-wrap: nowrap; white-space: nowrap; line-height: 0.9; }
        .dm-title { font-size: 13px; font-weight: 600; color: #eee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dm-excerpt { font-size: 11px; color: #888; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3; }
        .dm-excerpt-cited { font-size: 11px; color: #888; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3; border-left: 2px solid #333; padding-left: 6px; }

        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes dm-fly { from { transform: translateX(0); } to { transform: translateX(-140vw); } }

        /* 调试日志 */
        .sb-console { height: 20px; background: #000; border-top: 1px solid #333; padding: 5px; font-family: monospace; font-size: 10px; overflow-y: auto; color: #666; }
        .log-ok { color: #0f0; } .log-err { color: #f55; }
    `;

    // --- 逻辑处理 ---

    async function fetchUser(username) {
        try {
            // Fetch user_actions
            const url1 = `${CONFIG.HOST}/user_actions.json?offset=0&limit=${CONFIG.LOG_LIMIT_PER_USER}&username=${username}&filter=1,4,5`;
            const json = await safeFetch(url1);

            // Process user_actions: swap fields for type 1 (likes)
            const actions = (json.user_actions || []).map(action => {
                if (action.action_type === 1) {
                    // For likes: swap user and acting_user fields
                    return {
                        ...action,
                        username: action.acting_username,
                        name: action.acting_name,
                        user_id: action.acting_user_id,
                        avatar_template: action.acting_avatar_template,
                        acting_username: action.username,
                        acting_name: action.name,
                        acting_user_id: action.user_id,
                        acting_avatar_template: action.avatar_template,
                    };
                }
                // Type 4 (new topic) and 5 (reply): keep as-is
                return action;
            });

            // Fetch reactions
            // NOTE: the limit seems to be fixed at 20
            const url2 = `${CONFIG.HOST}/discourse-reactions/posts/reactions.json?offset=0&limit=${CONFIG.LOG_LIMIT_PER_USER}&username=${username}`;
            const json2 = await safeFetch(url2);

            // Transform reactions to match user_actions format
            const reactions = (json2 || []).map(r => ({
                // Core identifiers
                id: r.id,
                post_id: r.post_id,
                created_at: r.created_at,
                // User who made the reaction (acting user)
                username: r.user?.username || '',
                name: r.user?.name || '',
                user_id: r.user_id,
                avatar_template: r.user?.avatar_template || '',
                // Post author (target of the reaction)
                acting_username: r.post?.user?.username || r.post?.username || '',
                acting_name: r.post?.user?.name || r.post?.name || '',
                acting_user_id: r.post?.user_id || '',
                acting_avatar_template: r.post?.user?.avatar_template || r.post?.avatar_template || '',
                // Post/topic info
                topic_id: r.post?.topic_id,
                post_number: r.post?.post_number,
                title: r.post?.topic_title || r.post?.topic?.title || '',
                excerpt: r.post?.excerpt || '',
                category_id: r.post?.category_id,
                // Reaction-specific: use reaction_value as action indicator
                action_type: r.reaction?.reaction_value || 'reaction',
                reaction_value: r.reaction?.reaction_value
            }));

            // Merge, sort by date, and return only most recent entries
            const merged = [...actions, ...reactions]
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                .slice(0, CONFIG.LOG_LIMIT_PER_USER);
            return merged;
        } catch (e) {
            log(`Network Err ${username}: ${e.message}`, 'error');
            return [];
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
        // 移除图片
        tmp.querySelectorAll('img').forEach(img => {
            if (img.classList.contains('emoji')) {
                img.replaceWith(img.alt);
            } else {
                img.remove();
            }
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
        // 修复相对链接
        if (src.startsWith('/')) src = CONFIG.HOST + src;
        // 如果是同页面的引用 (Shadow DOM下 context 不同，最好补全)
        if (!src.startsWith('http')) {
             // 尝试从 img attribute 直接拿
             const rawSrc = img.getAttribute('src');
             if (rawSrc && rawSrc.startsWith('/')) return CONFIG.HOST + rawSrc;
        }
        return src;
    }

    // --- Unified Action Formatting ---

    function getActionIcon(actionType) {
        const ACTION_ICONS = {
            reply: '<svg class="fa d-icon d-icon-reply svg-icon svg-string" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M8.309 189.836L184.313 37.851C199.719 24.546 224 35.347 224 56.015v80.053c160.629 1.839 288 34.032 288 186.258 0 61.441-39.581 122.309-83.333 154.132-13.653 9.931-33.111-2.533-28.077-18.631 45.344-145.012-21.507-183.51-176.59-185.742V360c0 20.7-24.3 31.453-39.687 18.164l-176.004-152c-11.071-9.562-11.086-26.753 0-36.328z"/></svg>',
            post: '<svg class="fa d-icon d-icon-pencil svg-icon svg-string" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M497.9 142.1l-46.1 46.1c-4.7 4.7-12.3 4.7-17 0l-111-111c-4.7-4.7-4.7-12.3 0-17l46.1-46.1c18.7-18.7 49.1-18.7 67.9 0l60.1 60.1c18.8 18.7 18.8 49.1 0 67.9zM284.2 99.8L21.6 362.4.4 483.9c-2.9 16.4 11.4 30.6 27.8 27.8l121.5-21.3 262.6-262.6c4.7-4.7 4.7-12.3 0-17l-111-111c-4.8-4.7-12.4-4.7-17.1 0zM88 424h48v36.3l-64.5 11.3-31.1-31.1L51.7 376H88v48z"/></svg>',
            like: '<svg class="fa d-icon d-icon-d-heart svg-icon svg-string" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path fill="#fa6c8d" d="M305 151.1L320 171.8L335 151.1C360 116.5 400.2 96 442.9 96C516.4 96 576 155.6 576 229.1L576 231.7C576 343.9 436.1 474.2 363.1 529.9C350.7 539.3 335.5 544 320 544C304.5 544 289.2 539.4 276.9 529.9C203.9 474.2 64 343.9 64 231.7L64 229.1C64 155.6 123.6 96 197.1 96C239.8 96 280 116.5 305 151.1z"/></svg>',
        };

        if (actionType === 5) return ACTION_ICONS.reply;
        if (actionType === 4) return ACTION_ICONS.post;
        if (actionType === 1) return ACTION_ICONS.like;
        // For reactions (action_type is the reaction_value string like "laughing", "hugs")
        if (typeof actionType === 'string') {
            return `<img src="${CONFIG.HOST}/images/emoji/twemoji/${actionType}.png?v=15" class="action-emoji" alt=":${actionType}:">`;
        }
        return ACTION_ICONS.reply; // fallback
    }

    // Get highlight color for a username
    function getUsernameColor(username) {
        if (!username) return null;
        const lower = username.toLowerCase();
        // Current user gets gold color
        if (State.currentUser && lower === State.currentUser.toLowerCase()) {
            return nameColors[0];
        }
        // State.users get sequential colors from nameColors[1:]
        const userIndex = State.users.findIndex(u => u.toLowerCase() === lower);
        if (userIndex !== -1 && userIndex + 1 < nameColors.length) {
            return nameColors[userIndex + 1];
        }
        return null; // default color
    }

    function formatActionInfo(action) {
        const icon = getActionIcon(action.action_type);
        const user = action.username || '';
        const actingUser = action.acting_username || '';
        const actingAvatar = action.acting_avatar_template
            ? CONFIG.HOST + action.acting_avatar_template.replace("{size}", "24")
            : null;

        // Get highlight colors
        const userColor = getUsernameColor(user);
        const actingUserColor = getUsernameColor(actingUser);

        // Format content with optional color
        const formatActingUser = (content, color) => color
            ? `<span style="color:${color}; display: flex; align-items: center">${content}</span>`
            : content;

        const userHtml = formatActingUser(user, userColor);

        // Format: {user} {icon} {acting_user avatar + name (if available and different)}
        if (actingUser && actingUser !== user) {
            const actingContent = actingAvatar
                ? `<img src="${actingAvatar}" class="sb-avatar-sm"> &thinsp;${actingUser}`
                : actingUser;
            const actingHtml = formatActingUser(actingContent, actingUserColor);
            return { user, icon, actingUser, actingAvatar, html: `${userHtml} ${icon} ${actingHtml}` };
        }
        return { user, icon, actingUser: null, actingAvatar: null, html: `${userHtml} ${icon}` };
    }

    // --- Shadow DOM 操作 ---
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
                const item = document.createElement('div');
                item.className = 'dm-item';
                item.style.top = `${5 + Math.random() * 80}vh`; // 随机高度
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
                // setTimeout(() => item.remove(), 16000);
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

    async function tick(force = false) {
        if (State.isProcessing && !force) return;
        State.isProcessing = true;

        const dot = shadowRoot?.querySelector('.sb-status-dot');
        if(dot) dot.className = 'sb-status-dot loading';

        let hasUpdates = false;

        for (const user of State.users) {
            const actions = await fetchUser(user);
            if (actions.length > 0) {
                const latest = actions[0];
                const latestId = getUniqueId(latest);
                const lastSavedId = State.lastIds[user];

                if (!lastSavedId) {
                    State.lastIds[user] = latestId;
                    hasUpdates = true;
                    // 初始化不弹幕，防止刷屏
                } else if (latestId !== lastSavedId) {
                    // 找出新消息
                    const diff = [];
                    for (let act of actions) {
                        if (getUniqueId(act) === lastSavedId) break;
                        diff.push(act);
                    }
                    if (diff.length > 0) {
                        log(`User ${user} has ${diff.length} new`, 'success');
                        diff.reverse().forEach((act, i) => setTimeout(() => sendNotification(act), i * 1000));
                        State.lastIds[user] = latestId;
                        hasUpdates = true;
                    }
                }
                State.data[user] = actions;
            }
        }

        if (hasUpdates || force) {
            saveConfig();
            renderList();
        }

        if(dot) dot.className = 'sb-status-dot ok';
        State.isProcessing = false;
    }

    // --- UI 构建 ---

    function createUI() {
        const host = document.createElement('div');
        host.id = 'ld-seeking-host';
        document.body.appendChild(host);

        // 创建 Shadow DOM
        shadowRoot = host.attachShadow({ mode: 'open' });

        // 注入 CSS
        const style = document.createElement('style');
        style.textContent = css;
        shadowRoot.appendChild(style);

        // 注入 HTML
        const container = document.createElement('div');
        // Shadow DOM 内部结构
        container.innerHTML = `
            <div id="dm-container" class="dm-container"></div>
            <div id="ld-sidebar" class="${State.isCollapsed ? 'collapsed' : ''}">
                <div id="ld-toggle-ball" title="切换侧边栏">👀</div>
                <div class="sb-header">
                    <div class="sb-title-row">
                        <div class="sb-title">
                            <div class="sb-status-dot ok"></div> 追觅 · Seeking
                        </div>
                        <div class="sb-tools">
                            <button id="btn-dm" class="sb-icon-btn ${State.enableDanmaku?'active':''}" title="弹幕">💬</button>
                            <button id="btn-sys" class="sb-icon-btn ${State.enableSysNotify?'active':''}" title="通知">🔔</button>
                            <button id="btn-refresh" class="sb-icon-btn" title="刷新">↻</button>
                        </div>
                    </div>
                    <div class="sb-input-group">
                        <input id="inp-user" class="sb-input" placeholder="添加用户名...">
                        <button id="btn-add" class="sb-btn-add">＋</button>
                    </div>
                    <div id="sb-tags" class="sb-tags"></div>
                </div>
                <div id="sb-list" class="sb-list"></div>
                <!-- <div id="sb-console" class="sb-console"></div> -->
            </div>
        `;
        shadowRoot.appendChild(container);

        // 事件绑定
        shadowRoot.getElementById('ld-toggle-ball').onclick = () => {
            const bar = shadowRoot.getElementById('ld-sidebar');
            bar.classList.toggle('collapsed');
            State.isCollapsed = bar.classList.contains('collapsed');
            GM_setValue('ld_is_collapsed', State.isCollapsed);
        };

        shadowRoot.getElementById('btn-dm').onclick = function() {
            State.enableDanmaku = !State.enableDanmaku;
            this.className = `sb-icon-btn ${State.enableDanmaku?'active':''}`;
            saveConfig();
        };

        shadowRoot.getElementById('btn-sys').onclick = function() {
            State.enableSysNotify = !State.enableSysNotify;
            this.className = `sb-icon-btn ${State.enableSysNotify?'active':''}`;
            if (State.enableSysNotify && Notification.permission !== 'granted') Notification.requestPermission();
            saveConfig();
        };

        shadowRoot.getElementById('btn-refresh').onclick = () => tick(true);

        const handleAdd = async () => {
            const inp = shadowRoot.getElementById('inp-user');
            const name = inp.value.trim();
            if(!name || State.users.includes(name)) return;

            const btn = shadowRoot.getElementById('btn-add');
            btn.innerText = '...';

            // 尝试获取一次以验证
            const test = await fetchUser(name);
            State.users.push(name);
            saveConfig();

            btn.innerText = '＋';
            inp.value = '';
            renderTags();
            tick(true);
        };

        shadowRoot.getElementById('btn-add').onclick = handleAdd;

        const inp = shadowRoot.getElementById('inp-user');
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleAdd();
            }
        });

        renderTags();
        log('Seeking Engine Started.', 'success');

        // 初次加载
        tick(true);
        setInterval(() => tick(false), CONFIG.REFRESH_INTERVAL_MS);
    }

    function removeUser(name) {
        State.users = State.users.filter(u => u !== name);
        delete State.lastIds[name];
        saveConfig();
        renderTags();
        renderList();
    }

    function renderTags() {
        if (!shadowRoot) return;
        const div = shadowRoot.getElementById('sb-tags');
        div.innerHTML = '';

        const createTag = (text, isAll) => {
            const el = document.createElement('div');
            el.className = `sb-tag ${State.currentFilter === (isAll?'ALL':text) ? 'active':''}`;
            el.innerHTML = isAll ? `全部` : `<span>${text}</span><span class="sb-tag-close">×</span>`;

            el.onclick = () => {
                State.currentFilter = isAll ? 'ALL' : text;
                renderTags();
                renderList();
            };

            if(!isAll) {
                const close = el.querySelector('.sb-tag-close');
                close.onclick = (e) => { e.stopPropagation(); removeUser(text); };
            }
            div.appendChild(el);
        };

        createTag('All', true);
        State.users.forEach(u => createTag(u, false));
    }

    function renderList() {
        if (!shadowRoot) return;
        const div = shadowRoot.getElementById('sb-list');
        let all = [];
        if (State.currentFilter === 'ALL') Object.values(State.data).forEach(arr => all.push(...arr));
        else all = State.data[State.currentFilter] || [];

        all.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

        if (all.length === 0) {
            div.innerHTML = `<div style="text-align:center;color:#555;margin-top:40px;font-size:12px;">暂无数据或正在连接...</div>`;
            return;
        }

        div.innerHTML = all.map(item => {
            let avatar = "https://linux.do/uploads/default/original/3X/9/d/9dd4973138ccd78e8907865261d7b14d45a96d1c.png";
            if(item.avatar_template) avatar = CONFIG.HOST + item.avatar_template.replace("{size}", "48");

            const date = new Date(item.created_at);
            const now = new Date();
            const timeStr = date.toDateString() === now.toDateString()
                ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
                : date.getFullYear() === now.getFullYear()
                    ? date.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
                    : date.toLocaleString('en-US', { month: 'short', day: '2-digit', year: '2-digit' });
            const catName = categoryMap.get(item.category_id) || "其他";
            const catColor = categoryColors[catName] || "#777";

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

    // 启动
    createUI();

})();
