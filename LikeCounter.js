// ==UserScript==
// @name:en      Linux.do Like Counter
// @name         Linux.do 点赞计数器
// @namespace    https://linux.do/
// @version      1.1
// @description:en  Tracks available likes/reactions on linux.do.
// @description     显示 linux.do 上的可用点赞数。
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
        STORAGE_KEY: 'linuxdo_likes_history',
        LIMITS: { 0: 50, 1: 50, 2: 75, 3: 100, 4: 150 },
        MAX_STORED_ITEMS: 1000
    };

    const console = unsafeWindow.console;
    let state = { timestamps: [], cooldownUntil: 0, lastSync: 0, matched: true };
    let currentUser = null;
    let uiUpdateTimer = null;
    let cooldownTicker = null;

    // --- Persistence ---
    function loadState() {
        const stored = GM_getValue(CONFIG.STORAGE_KEY, "{}");
        try {
            const parsed = JSON.parse(stored);
            state = { ...state, ...parsed };
            if (state.timestamps.length > CONFIG.MAX_STORED_ITEMS) {
                state.timestamps = state.timestamps.slice(0, CONFIG.MAX_STORED_ITEMS);
            }
        } catch (e) {
            state = { timestamps: [], cooldownUntil: 0, lastSync: 0, matched: true };
        }
        cleanOldEntries();
    }

    function saveState() {
        GM_setValue(CONFIG.STORAGE_KEY, JSON.stringify(state));
    }

    function cleanOldEntries() {
        const now = Date.now();
        const cutoff = now - 24 * 60 * 60 * 1000;
        state.timestamps = state.timestamps.filter(ts => ts > cutoff);
        state.timestamps.sort((a, b) => b - a);
        if (state.cooldownUntil < now) state.cooldownUntil = 0;
    }

    // --- Core Logic ---
    function processToggleResponse(url, data) {
        loadState();
        const now = Date.now();

        if (data.errors && data.error_type === "rate_limit") {
            let waitSeconds = data.extras?.wait_seconds || 0;
            if (waitSeconds) state.cooldownUntil = now + (waitSeconds * 1000);

            let limit = (currentUser && CONFIG.LIMITS[currentUser.trust_level]) || 50;
            const currentCount = state.timestamps.length;

            state.matched = (currentCount >= limit);

            if (currentCount < limit && waitSeconds > 0) {
                const needed = limit - currentCount;
                const placeholderBaseTime = (now + waitSeconds * 1000) - (24 * 60 * 60 * 1000);
                const safeNeeded = Math.min(needed, 200);
                for (let i = 0; i < safeNeeded; i++) {
                    state.timestamps.push(placeholderBaseTime + i);
                }
                state.timestamps.sort((a, b) => b - a);
            }

        } else if (data.id || data.resource_post_id) {
            const isLike = !!data.current_user_reaction;
            if (isLike) {
                state.timestamps.push(now);
            } else {
                if (state.timestamps.length > 0) state.timestamps.shift();
                if (state.cooldownUntil > now) state.cooldownUntil = 0;
            }
        }

        saveState();
        requestUiUpdate(true);
    }

    // --- Interceptors ---
    function installInterceptors() {
        const originalFetch = unsafeWindow.fetch;
        unsafeWindow.fetch = async function(...args) {
            let url = (typeof args[0] === "string") ? args[0] : (args[0]?.url || "");
            const response = await originalFetch.apply(this, args);
            if (url && (url.includes("/toggle.json") || url.includes("/custom-reactions/"))) {
                response.clone().json().then(data => processToggleResponse(url, data)).catch(() => {});
            }
            return response;
        };

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
                    try { processToggleResponse(url, JSON.parse(this.responseText)); } catch (e) {}
                });
            }
            return originalSend.apply(this, arguments);
        };
    }

    // --- UI Rendering ---
    GM_addStyle(`
        .ld-picker-counter { width: 100% !important; box-sizing: border-box !important; text-align: center; margin: 0 3.5px !important; padding: 6px 0 4px 0; font-size: 0.85em; font-weight: 600; border-bottom: 1px solid var(--primary-low, #e9e9e9); border-top-left-radius: 8px; border-top-right-radius: 8px; display: flex; align-items: center; justify-content: center; }
        .ld-picker-counter.bg-ok { background-color: color-mix(in srgb, var(--secondary), #00F2FF 15%) !important; }
        .ld-picker-counter.bg-cooldown { background-color: color-mix(in srgb, var(--secondary), #FF00E5 15%) !important; }
        .ld-picker-counter.bg-mismatch { background-color: color-mix(in srgb, var(--secondary), #7000FF 15%) !important; }
        .discourse-reactions-picker .discourse-reactions-picker-container { margin-top: 0 !important; border-top-left-radius: 0 !important; border-top-right-radius: 0 !important; }

        .ld-mismatch-tooltip { display: inline-flex; align-items: center; margin-right: 6px; cursor: help; position: relative; }
        .ld-mismatch-tooltip svg { width: 14px; height: 14px; fill: currentColor; }

        .ld-mismatch-tooltip::after { content: attr(data-tooltip); position: absolute; bottom: 125%; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.85); color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 0.75em; white-space: nowrap; opacity: 0; visibility: hidden; transition: opacity 0.2s; pointer-events: none; z-index: 9999; }
        .ld-mismatch-tooltip:hover::after { opacity: 1; visibility: visible; }
    `);

    function requestUiUpdate(immediate = false) {
        if (immediate) {
            if (uiUpdateTimer) cancelAnimationFrame(uiUpdateTimer);
            updateUI();
            uiUpdateTimer = null;
        } else {
            if (uiUpdateTimer) return;
            uiUpdateTimer = requestAnimationFrame(() => {
                updateUI();
                uiUpdateTimer = null;
            });
        }
    }

    function updateUI() {
        const picker = document.querySelector('.discourse-reactions-picker');

        // --- 1. Auto-cleanup Timer ---
        if (cooldownTicker) {
            clearTimeout(cooldownTicker);
            cooldownTicker = null;
        }

        if (!picker) return;

        cleanOldEntries();
        const count = state.timestamps.length;
        const now = Date.now();
        const isCooldown = state.cooldownUntil > now;
        const dailyLimit = (currentUser && CONFIG.LIMITS[currentUser.trust_level]) || 50;

        let statusClass = "bg-ok";
        if (isCooldown) {
            statusClass = "bg-cooldown";
        } else if (!state.matched) {
            statusClass = "bg-mismatch";
        }

        const finalClassName = `ld-picker-counter ${statusClass}`;

        let displayText = "";
        if (isCooldown) {
            const diff = Math.max(0, state.cooldownUntil - now);
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            displayText = `冷却：${h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : `${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`}`;
        } else {
            displayText = `剩余：${dailyLimit - count} / ${dailyLimit}`;
        }

        let counter = picker.querySelector('.ld-picker-counter');

        if (!counter) {
            counter = document.createElement('div');
            counter.className = finalClassName;
            picker.insertBefore(counter, picker.firstChild);
        } else if (counter.className !== finalClassName) {
            counter.className = finalClassName;
        }

        let tooltipSpan = counter.querySelector('.ld-mismatch-tooltip');
        const shouldShowTooltip = !state.matched && !isCooldown;

        if (shouldShowTooltip && !tooltipSpan) {
            tooltipSpan = document.createElement('span');
            tooltipSpan.className = 'ld-mismatch-tooltip';
            tooltipSpan.dataset.tooltip = "计数可能不准确";
            tooltipSpan.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zm0-384c13.3 0 24 10.7 24 24V264c0 13.3-10.7 24-24 24s-24-10.7-24-24V152c0-13.3 10.7-24 24-24zM224 352a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z"/></svg>';
            tooltipSpan.onclick = (e) => { e.preventDefault(); syncRemote(); };
            counter.prepend(tooltipSpan);
        } else if (!shouldShowTooltip && tooltipSpan) {
            tooltipSpan.remove();
        }

        let textSpan = counter.querySelector('.ld-text-span');
        if (!textSpan) {
            textSpan = document.createElement('span');
            textSpan.className = 'ld-text-span';
            counter.appendChild(textSpan);
        }

        if (textSpan.textContent !== displayText) {
            textSpan.textContent = displayText;
        }

        // --- 4. Schedule Next Tick ---
        if (isCooldown) {
            cooldownTicker = setTimeout(() => requestUiUpdate(true), 1000);
        }
    }

    // --- Sync Logic ---
    async function fetchUserActions(username) {
        let offset = 0, limit = 50, allTimestamps = [], keepFetching = true, pages = 0;
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;

        while (keepFetching && pages < 5) {
            try {
                const url = `${CONFIG.HOST}/user_actions.json?limit=${limit}&username=${username}&filter=1&offset=${offset}`;
                const res = await fetch(url).then(r => r.json());
                const items = res.user_actions || [];
                if (!items.length) break;

                let hasOld = false;
                for (const item of items) {
                    const t = new Date(item.created_at).getTime();
                    if (t > cutoff) allTimestamps.push(t);
                    else hasOld = true;
                }
                if (hasOld || items.length < limit) keepFetching = false;
                offset += limit;
                pages++;
            } catch (e) { keepFetching = false; }
        }
        return allTimestamps;
    }

    async function fetchReactions(username) {
        let beforeId = null, allTimestamps = [], keepFetching = true, pages = 0;
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;

        while (keepFetching && pages < 10) {
            try {
                let url = `${CONFIG.HOST}/discourse-reactions/posts/reactions.json?username=${username}`;
                if (beforeId) url += `&before_reaction_user_id=${beforeId}`;

                const items = await fetch(url).then(r => r.json());
                if (!Array.isArray(items) || !items.length) break;

                let hasOld = false;
                for (const item of items) {
                    const t = new Date(item.created_at).getTime();
                    if (t > cutoff) allTimestamps.push(t);
                    else hasOld = true;
                }
                beforeId = items[items.length - 1].id;
                if (hasOld || items.length < 20) keepFetching = false;
                pages++;
            } catch (e) { keepFetching = false; }
        }
        return allTimestamps;
    }

    async function syncRemote() {
        if (!currentUser) {
             try { currentUser = require("discourse/models/user").default.current(); } catch(e) {}
             if(!currentUser) return;
        }
        cleanOldEntries();
        const username = currentUser.username;

        try {
            const [likes, reactions] = await Promise.all([fetchUserActions(username), fetchReactions(username)]);
            const combined = [...likes, ...reactions];
            const maxRemote = Math.max(...combined, 0);

            const localNewer = state.timestamps.filter(ts => ts > maxRemote + 2000);
            let placeholders = [];
            if (state.cooldownUntil > Date.now()) {
                const expectedBase = state.cooldownUntil - (24*60*60*1000);
                placeholders = state.timestamps.filter(ts => ts >= expectedBase && ts < expectedBase + 5000);
            }

            state.timestamps = Array.from(new Set([...combined, ...localNewer, ...placeholders]));
            state.lastSync = Date.now();
            cleanOldEntries();
            saveState();
            requestUiUpdate(true);
        } catch (e) { console.error("[LikeCounter] Sync failed", e); }
    }

    // --- Init ---
    installInterceptors();
    loadState();

    let observerTimer = null;
    const observer = new MutationObserver((mutations) => {
        let reactionPickerFound = false;
        for (const m of mutations) {
            if (m.addedNodes.length) {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1 && (node.classList.contains('discourse-reactions-picker') || node.querySelector('.discourse-reactions-picker'))) {
                        reactionPickerFound = true;
                        break;
                    }
                }
            }
            if (reactionPickerFound) break;
        }

        if (reactionPickerFound) {
            if (observerTimer) clearTimeout(observerTimer);
            requestUiUpdate(true);
        } else {
            if (observerTimer) return;
            observerTimer = setTimeout(() => {
                const picker = document.querySelector('.discourse-reactions-picker');
                if (picker) requestUiUpdate();
                observerTimer = null;
            }, 300);
        }
    });

    window.addEventListener('load', () => {
        try { currentUser = require("discourse/models/user").default.current(); } catch (e) {}
        setTimeout(syncRemote, 3000);
        setInterval(syncRemote, CONFIG.SYNC_INTERVAL);
        observer.observe(document.body, { childList: true, subtree: true });
    });

})();
