// ==UserScript==
// @name         Linux.do Like Counter
// @name:zh-CN   Linux.do 点赞计数器
// @namespace    https://linux.do/
// @version      1.0
// @description  Tracks available likes/reactions on linux.do.
// @description:zh-CN 显示 linux.do 上的可用点赞数。
// @author       ChiGamma
// @license      Fair License
// @match        https://linux.do/t/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        HOST: window.location.origin,
        SYNC_INTERVAL: 30 * 60 * 1000,
        UI_UPDATE_DEBOUNCE: 200,
        STORAGE_KEY: 'linuxdo_likes_history',
        LIMITS: { 0: 50, 1: 50, 2: 75, 3: 100, 4: 150 }
    };

    const console = unsafeWindow.console;
    const log = (msg, ...args) => console.log(`%c[LikeCounter] ${msg}`, ...args);

    let state = { timestamps: [], cooldownUntil: 0, lastSync: 0, matched: true };
    let currentUser = null;

    // --- Persistence ---
    function loadState() {
        const stored = GM_getValue(CONFIG.STORAGE_KEY, "{}");
        try {
            const parsed = JSON.parse(stored);
            state = { ...state, ...parsed };
        } catch (e) { console.error("[LikeCounter] State parse error", e); }
        cleanOldEntries();
    }

    function saveState() { GM_setValue(CONFIG.STORAGE_KEY, JSON.stringify(state)); }

    function cleanOldEntries() {
        const now = Date.now();
        const cutoff = now - 24 * 60 * 60 * 1000;
        state.timestamps = state.timestamps.filter(ts => ts > cutoff).sort((a, b) => b - a);
        if (state.cooldownUntil < now) state.cooldownUntil = 0;
    }

    // --- Core Logic: Handle Response Data ---
    function processToggleResponse(url, data) {
        loadState();
        const now = Date.now();

        if (data.errors && data.error_type === "rate_limit") {
            let waitSeconds = 0;
            if (data.extras && data.extras.wait_seconds) {
                waitSeconds = data.extras.wait_seconds;
                state.cooldownUntil = now + (waitSeconds * 1000);
            }

            let limit = 50;
            if (currentUser && CONFIG.LIMITS[currentUser.trust_level]) {
                limit = CONFIG.LIMITS[currentUser.trust_level];
            }

            const currentCount = state.timestamps.length;

            // Check if current count matches the limit
            if (currentCount === limit) {
                state.matched = true;
            } else {
                state.matched = false;
            }

            if (currentCount < limit && waitSeconds > 0) {
                const needed = limit - currentCount;

                const cooldownEnd = now + (waitSeconds * 1000);
                const placeholderBaseTime = cooldownEnd - (24 * 60 * 60 * 1000);

                for (let i = 0; i < needed; i++) {
                    state.timestamps.push(placeholderBaseTime + i);
                }
                state.timestamps.sort((a, b) => b - a);
            }

        } else if (data.id || data.resource_post_id) {
            const isLike = !!data.current_user_reaction;
            if (isLike) {
                // log("Reaction ADDED (+1)");
                state.timestamps.push(now);
            } else {
                // log("Reaction REMOVED (-1)");
                if (state.timestamps.length > 0) {
                    state.timestamps.shift();
                }
                if (state.cooldownUntil > now) {
                    state.cooldownUntil = 0;
                }
            }
        }

        saveState();
        updateUI(true);
    }

    // --- NETWORK INTERCEPTOR (Fetch + XHR) ---
    function installInterceptors() {
        // 1. Intercept Fetch
        const originalFetch = unsafeWindow.fetch;
        unsafeWindow.fetch = async function(...args) {
            let url = "";
            if (typeof args[0] === "string") url = args[0];
            else if (args[0] && args[0].url) url = args[0].url;

            const response = await originalFetch.apply(this, args);

            if (url && (url.includes("/toggle.json") || url.includes("/custom-reactions/"))) {
                response.clone().json().then(data => processToggleResponse(url, data)).catch(e => console.error(e));
            }
            return response;
        };

        // 2. Intercept XHR
        const originalOpen = unsafeWindow.XMLHttpRequest.prototype.open;
        unsafeWindow.XMLHttpRequest.prototype.open = function(method, url) {
            this._interceptUrl = url;
            return originalOpen.apply(this, arguments);
        };

        const originalSend = unsafeWindow.XMLHttpRequest.prototype.send;
        unsafeWindow.XMLHttpRequest.prototype.send = function() {
            const url = this._interceptUrl;
            if (url && (url.includes("/toggle.json") || url.includes("/custom-reactions/"))) {
                this.addEventListener('load', function() {
                    try {
                        const data = JSON.parse(this.responseText);
                        processToggleResponse(url, data);
                    } catch (e) {
                        console.error("[LikeCounter] Failed to parse XHR response", e);
                    }
                });
            }
            return originalSend.apply(this, arguments);
        };
    }

    // --- UI Rendering ---
    GM_addStyle(`
        .ld-picker-counter { width: 100% !important; box-sizing: border-box !important; text-align: center; margin: 0 3.5px !important; padding: 6px 0 4px 0; font-size: 0.85em; font-weight: 600; border-bottom: 1px solid var(--primary-low, #e9e9e9); border-top-left-radius: 8px; border-top-right-radius: 8px; position: relative; }
        .ld-picker-counter.bg-ok { background-color: color-mix(in srgb, var(--secondary), #00F2FF 15%) !important; }
        .ld-picker-counter.bg-cooldown { background-color: color-mix(in srgb, var(--secondary), #FF00E5 15%) !important; }
        .ld-picker-counter.bg-mismatch { background-color: color-mix(in srgb, var(--secondary), #7000FF 15%) !important; }
        .discourse-reactions-picker .discourse-reactions-picker-container { width: 100% !important; box-sizing: border-box !important; border: none !important; margin-top: 0 !important; border-top-left-radius: 0 !important; border-top-right-radius: 0 !important; background-color: var(--secondary, #fff); }
        .ld-mismatch-tooltip { display: inline-flex; align-items: center; margin-left: 6px; cursor: help; position: relative; vertical-align: middle; }
        .ld-mismatch-tooltip svg { width: 14px; height: 14px; fill: currentColor; }
        .ld-mismatch-tooltip::after { content: attr(data-tooltip); position: absolute; bottom: 125%; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.85); color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 0.75em; white-space: nowrap; opacity: 0; visibility: hidden; transition: opacity 0.2s, visibility 0.2s; pointer-events: none; z-index: 1000; }
        .ld-mismatch-tooltip:hover::after { opacity: 1; visibility: visible; }
    `);

    function getCounterHtml() {
        cleanOldEntries();
        const count = state.timestamps.length;
        const now = Date.now();
        const isCooldown = state.cooldownUntil > now;

        let dailyLimit = 50;
        if (currentUser) {
            dailyLimit = CONFIG.LIMITS[currentUser.trust_level] || 50;
        }

        let text = "";
        let cls = "ld-picker-counter";

        if (state.matched === false) {
            cls += " bg-mismatch";
        } else if (isCooldown) {
            cls += " bg-cooldown";
        } else {
            cls += " bg-ok";
        }

        if (isCooldown) {
            const diff = Math.max(0, state.cooldownUntil - now);
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            text = `冷却：${h > 0 ? `${h}h ${String(m).padStart(2, '0')} m` : `${String(m).padStart(2, '0')} m ${String(s).padStart(2, '0')} s`}`;
        } else {
            text = `剩余：${dailyLimit - count} / ${dailyLimit}`;
        }

        // Add mismatch tooltip if matched is false
        let tooltipHtml = '';
        if (state.matched === false) {
            tooltipHtml = '<span class="ld-mismatch-tooltip" data-tooltip="计数可能不准确"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path d="M528 320C528 205.1 434.9 112 320 112C205.1 112 112 205.1 112 320C112 434.9 205.1 528 320 528C434.9 528 528 434.9 528 320zM64 320C64 178.6 178.6 64 320 64C461.4 64 576 178.6 576 320C576 461.4 461.4 576 320 576C178.6 576 64 461.4 64 320zM320 240C302.3 240 288 254.3 288 272C288 285.3 277.3 296 264 296C250.7 296 240 285.3 240 272C240 227.8 275.8 192 320 192C364.2 192 400 227.8 400 272C400 319.2 364 339.2 344 346.5L344 350.3C344 363.6 333.3 374.3 320 374.3C306.7 374.3 296 363.6 296 350.3L296 342.2C296 321.7 310.8 307 326.1 302C332.5 299.9 339.3 296.5 344.3 291.7C348.6 287.5 352 281.7 352 272.1C352 254.4 337.7 240.1 320 240.1zM288 432C288 414.3 302.3 400 320 400C337.7 400 352 414.3 352 432C352 449.7 337.7 464 320 464C302.3 464 288 449.7 288 432z"/></svg></span>';
        }

        return `<div class="${cls}">${tooltipHtml}${text}</div>`;
    }

    function updateUI(force = false) {
        const picker = document.querySelector('.discourse-reactions-picker');
        if (!picker) return;

        const html = getCounterHtml();
        let counter = picker.querySelector('.ld-picker-counter');

        if (!counter) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;
            counter = tempDiv.firstElementChild;
            picker.insertBefore(counter, picker.firstChild);
        } else if (counter.outerHTML !== html) {
            counter.outerHTML = html;
        }
    }

    // --- Sync Logic ---
    // Fetch user_actions with offset-based pagination
    async function fetchUserActions(username) {
        let offset = 0;
        const limit = 50;
        let allTimestamps = [];
        let keepFetching = true;
        let pagesFetched = 0;
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const MAX_PAGES = 5;

        while (keepFetching && pagesFetched < MAX_PAGES) {
            try {
                const url = `${CONFIG.HOST}/user_actions.json?limit=${limit}&username=${username}&filter=1&offset=${offset}`;
                const response = await fetch(url);
                const data = await response.json();
                const items = data.user_actions || [];

                if (!items || items.length === 0) {
                    keepFetching = false;
                    break;
                }

                let hasOldItems = false;
                for (const item of items) {
                    const time = new Date(item.created_at).getTime();
                    if (time > cutoff) {
                        allTimestamps.push(time);
                    } else {
                        hasOldItems = true;
                    }
                }

                if (hasOldItems || items.length < limit) {
                    keepFetching = false;
                }

                offset += limit;
                pagesFetched++;
            } catch (err) {
                console.warn("[LikeCounter] user_actions fetch error", err);
                keepFetching = false;
            }
        }
        return allTimestamps;
    }

    // Fetch reactions with before_reaction_user_id cursor pagination
    async function fetchReactions(username) {
        let beforeId = null;
        let allTimestamps = [];
        let keepFetching = true;
        let pagesFetched = 0;
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const MAX_PAGES = 10;

        while (keepFetching && pagesFetched < MAX_PAGES) {
            try {
                let url = `${CONFIG.HOST}/discourse-reactions/posts/reactions.json?username=${username}`;
                if (beforeId) {
                    url += `&before_reaction_user_id=${beforeId}`;
                }

                const response = await fetch(url);
                const data = await response.json();
                const items = Array.isArray(data) ? data : [];

                if (!items || items.length === 0) {
                    keepFetching = false;
                    break;
                }

                let hasOldItems = false;
                for (const item of items) {
                    const time = new Date(item.created_at).getTime();
                    if (time > cutoff) {
                        allTimestamps.push(time);
                    } else {
                        hasOldItems = true;
                    }
                }

                // Get the id of the last item for next page cursor
                const lastItem = items[items.length - 1];
                beforeId = lastItem.id;

                if (hasOldItems || items.length < 20) {
                    keepFetching = false;
                }

                pagesFetched++;
            } catch (err) {
                console.warn("[LikeCounter] reactions fetch error", err);
                keepFetching = false;
            }
        }
        return allTimestamps;
    }

    async function syncRemote() {
        if (!currentUser) {
             try {
                const User = require("discourse/models/user").default;
                currentUser = User.current();
             } catch(e) {}
             if(!currentUser) return;
        }

        cleanOldEntries();
        const username = currentUser.username;

        try {
            const [likes, reactions] = await Promise.all([
                fetchUserActions(username),
                fetchReactions(username)
            ]);
            const combined = [...likes, ...reactions];
            const maxRemoteTs = Math.max(...combined, 0);
            log(`[LikeCounter] Synced: ${likes.length} likes, ${reactions.length} reactions`);

            const localNewer = state.timestamps.filter(ts => ts > maxRemoteTs + 2000);

            let placeholders = [];
            if (state.cooldownUntil > Date.now()) {
                const expectedBase = state.cooldownUntil - (24*60*60*1000);
                placeholders = state.timestamps.filter(ts => ts >= expectedBase && ts < expectedBase + 5000);
            }

            state.timestamps = Array.from(new Set([...combined, ...localNewer, ...placeholders]));
            state.lastSync = Date.now();

            cleanOldEntries();
            saveState();
            updateUI();
        } catch (e) { console.error("[LikeCounter] Sync failed", e); }
    }

    // --- Init ---
    installInterceptors();
    loadState();

    window.addEventListener('load', () => {
        try {
            const User = require("discourse/models/user").default;
            if (User) currentUser = User.current();
        } catch (e) {}

        setTimeout(syncRemote, 3000);
        setInterval(syncRemote, CONFIG.SYNC_INTERVAL);

        const observer = new MutationObserver((mutations) => {
            let pickerFound = false;
            for (const m of mutations) {
                if (m.addedNodes.length && document.querySelector('.discourse-reactions-picker')) {
                    pickerFound = true;
                    break;
                }
            }
            if (pickerFound) updateUI();
        });

        observer.observe(document.body, { childList: true, subtree: true });
    });

})();