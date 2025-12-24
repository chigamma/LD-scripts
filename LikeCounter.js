// ==UserScript==
// @name         Linux.do Like Counter & Tracker (Time-Based Sync)
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  Tracks available likes/reactions on linux.do. Syncs strictly based on 24h timestamps.
// @author       Frontend & Scripts
// @match        https://linux.do/*
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
        SYNC_INTERVAL: 60 * 60 * 1000,
        UI_UPDATE_DEBOUNCE: 200,
        STORAGE_KEY: 'linuxdo_likes_history',
        LIMITS: { 0: 50, 1: 50, 2: 75, 3: 100, 4: 150 }
    };

    const console = unsafeWindow.console;
    const log = (msg, ...args) => console.log(`%c[LikeCounter] ${msg}`, ...args);

    let state = { timestamps: [], cooldownUntil: 0, lastSync: 0 };
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
        .ld-picker-counter {
            display: block;
            width: 100%;
            text-align: center;
            font-size: 12px;
            padding: 6px 0;
            background: var(--primary-low);
            color: var(--primary-medium);
            border-bottom: 1px solid var(--primary-low-mid);
            font-weight: bold;
            border-radius: 4px 4px 0 0;
            margin-bottom: 4px;
        }
        .ld-picker-counter.limit-reached {
            color: var(--danger);
            background: var(--danger-low);
        }
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

        if (isCooldown) {
            const diff = state.cooldownUntil - now;
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            text = `冷却：${h}h ${m}m`;
            cls += " limit-reached";
        } else {
            text = `剩余：${dailyLimit - count} / ${dailyLimit}`;
            if (count >= dailyLimit) cls += " limit-reached";
        }

        return `<div class="${cls}">${text}</div>`;
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
        const limit = 20;
        let allTimestamps = [];
        let keepFetching = true;
        let pagesFetched = 0;
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const MAX_PAGES = 10;

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