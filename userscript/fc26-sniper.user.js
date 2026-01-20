// ==UserScript==
// @name         FC26 Sniper
// @namespace    fc26-sniper
// @version      3.0
// @description  FUT Web App Sniper - працює з Telegram ботом
// @author       FC26
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // CONFIG
    // ==========================================
    const CONFIG = {
        SUPABASE_URL: 'https://gvthriuorgvwnejhwxzf.supabase.co',
        SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2dGhyaXVvcmd2d25lamh3eHpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzY5NTg0OTksImV4cCI6MjA1MjUzNDQ5OX0.KwVgDI-c_XNSvR8kGbE5oadX-ZGXSj5pCWghNj3gJys',
        TELEGRAM_USER_ID: 7066583465,

        // Затримки (мс)
        SEARCH_DELAY_MIN: 7000,
        SEARCH_DELAY_MAX: 15000,
        BUY_DELAY: 300,

        // Anti-ban
        MAX_SEARCHES_PER_HOUR: 200,
        PAUSE_AFTER_BUY: 30000,
    };

    // ==========================================
    // STATE
    // ==========================================
    let isRunning = false;
    let filters = [];
    let stats = { searches: 0, found: 0, bought: 0, profit: 0, errors: 0 };
    let searchesThisHour = 0;

    // ==========================================
    // UI
    // ==========================================
    function createUI() {
        const panel = document.createElement('div');
        panel.id = 'sniper-panel';
        panel.innerHTML = `
            <style>
                #sniper-panel {
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    width: 280px;
                    background: rgba(0,0,0,0.95);
                    border: 2px solid #00ff00;
                    border-radius: 10px;
                    padding: 15px;
                    z-index: 999999;
                    font-family: Arial, sans-serif;
                    color: #fff;
                    font-size: 13px;
                }
                #sniper-panel h3 {
                    margin: 0 0 10px 0;
                    color: #00ff00;
                    text-align: center;
                    font-size: 16px;
                }
                #sniper-panel .status {
                    padding: 8px;
                    margin: 10px 0;
                    border-radius: 5px;
                    text-align: center;
                    font-weight: bold;
                }
                #sniper-panel .status.running { background: #00aa00; }
                #sniper-panel .status.stopped { background: #aa0000; }
                #sniper-panel .stats { line-height: 1.6; }
                #sniper-panel button {
                    width: 100%;
                    padding: 10px;
                    margin: 5px 0;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    font-weight: bold;
                    font-size: 14px;
                }
                #sniper-panel .btn-start { background: #00aa00; color: #fff; }
                #sniper-panel .btn-stop { background: #aa0000; color: #fff; }
                #sniper-panel .btn-refresh { background: #0066cc; color: #fff; }
                #sniper-panel .filters {
                    max-height: 120px;
                    overflow-y: auto;
                    font-size: 11px;
                    background: rgba(255,255,255,0.1);
                    padding: 8px;
                    border-radius: 5px;
                    margin: 10px 0;
                }
                #sniper-panel .filter-item {
                    padding: 4px 0;
                    border-bottom: 1px solid rgba(255,255,255,0.2);
                }
                #sniper-panel .log {
                    max-height: 80px;
                    overflow-y: auto;
                    font-size: 10px;
                    background: #111;
                    padding: 5px;
                    border-radius: 5px;
                    margin-top: 10px;
                    font-family: monospace;
                }
            </style>
            <h3>⚡ FC26 SNIPER</h3>
            <div id="sniper-status" class="status stopped">ЗУПИНЕНО</div>
            <div class="stats">
                🔍 Пошуків: <span id="stat-searches">0</span> |
                ✅ Куплено: <span id="stat-bought">0</span><br>
                💰 Профіт: <span id="stat-profit">0</span>
            </div>
            <div id="sniper-filters" class="filters">Завантаження...</div>
            <button id="btn-start" class="btn-start">▶️ СТАРТ</button>
            <button id="btn-stop" class="btn-stop" style="display:none">⏹️ СТОП</button>
            <button id="btn-refresh" class="btn-refresh">🔄 Оновити фільтри</button>
            <div id="sniper-log" class="log"></div>
        `;
        document.body.appendChild(panel);

        document.getElementById('btn-start').onclick = startSniper;
        document.getElementById('btn-stop').onclick = stopSniper;
        document.getElementById('btn-refresh').onclick = loadFilters;
    }

    function updateUI() {
        document.getElementById('stat-searches').textContent = stats.searches;
        document.getElementById('stat-bought').textContent = stats.bought;
        document.getElementById('stat-profit').textContent = stats.profit.toLocaleString();

        const status = document.getElementById('sniper-status');
        if (isRunning) {
            status.textContent = '🟢 ПРАЦЮЄ';
            status.className = 'status running';
            document.getElementById('btn-start').style.display = 'none';
            document.getElementById('btn-stop').style.display = 'block';
        } else {
            status.textContent = '🔴 ЗУПИНЕНО';
            status.className = 'status stopped';
            document.getElementById('btn-start').style.display = 'block';
            document.getElementById('btn-stop').style.display = 'none';
        }
    }

    function log(msg) {
        const logEl = document.getElementById('sniper-log');
        if (!logEl) return;
        const time = new Date().toLocaleTimeString();
        logEl.innerHTML = `[${time}] ${msg}<br>` + logEl.innerHTML;
        console.log(`[Sniper] ${msg}`);
    }

    function renderFilters() {
        const el = document.getElementById('sniper-filters');
        if (!el) return;
        if (filters.length === 0) {
            el.innerHTML = 'Немає фільтрів. Додайте через Telegram бота.';
            return;
        }
        el.innerHTML = filters.map(f => `
            <div class="filter-item">
                ${f.is_active ? '✅' : '❌'} <b>${f.player_name || 'Фільтр'}</b> |
                Max: ${f.max_buy_price?.toLocaleString()} |
                Sell: ${f.sell_price?.toLocaleString()}
            </div>
        `).join('');
    }

    // ==========================================
    // SUPABASE API
    // ==========================================
    async function supabaseRequest(table, method = 'GET', body = null, query = '') {
        const url = `${CONFIG.SUPABASE_URL}/rest/v1/${table}${query}`;
        const options = {
            method,
            headers: {
                'apikey': CONFIG.SUPABASE_KEY,
                'Authorization': `Bearer ${CONFIG.SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': method === 'POST' ? 'return=representation' : ''
            }
        };
        if (body) options.body = JSON.stringify(body);

        const response = await fetch(url, options);
        return response.json();
    }

    async function loadFilters() {
        try {
            log('Завантаження фільтрів...');
            filters = await supabaseRequest(
                'sniper_filters',
                'GET',
                null,
                `?user_id=eq.${CONFIG.TELEGRAM_USER_ID}&is_active=eq.true`
            );
            log(`Завантажено ${filters.length} фільтрів`);
            renderFilters();
        } catch (e) {
            log(`❌ Помилка: ${e.message}`);
        }
    }

    async function saveStats() {
        try {
            await supabaseRequest('sniper_stats', 'POST', {
                user_id: CONFIG.TELEGRAM_USER_ID,
                ...stats,
                updated_at: new Date().toISOString()
            }, '?on_conflict=user_id');
        } catch (e) {
            console.error('Stats save error:', e);
        }
    }

    async function logPurchase(playerName, buyPrice, sellPrice) {
        try {
            const profit = sellPrice - buyPrice - Math.floor(sellPrice * 0.05);
            await supabaseRequest('purchase_log', 'POST', {
                user_id: CONFIG.TELEGRAM_USER_ID,
                player_name: playerName,
                buy_price: buyPrice,
                sell_price: sellPrice,
                profit: profit
            });
        } catch (e) {
            console.error('Purchase log error:', e);
        }
    }

    // ==========================================
    // FUT WEB APP API
    // ==========================================
    function getServices() {
        return window.services || window.APP_MAIN_CORE?.services;
    }

    async function searchMarket(filter) {
        return new Promise((resolve, reject) => {
            try {
                const services = getServices();
                if (!services || !services.Item) {
                    reject(new Error('FUT не завантажено'));
                    return;
                }

                const searchCriteria = new UTSearchCriteriaDTO();
                searchCriteria.type = 'player';
                searchCriteria.count = 21;

                if (filter.max_buy_price) {
                    searchCriteria.maxBuy = filter.max_buy_price;
                }

                if (filter.player_id) {
                    searchCriteria.defId = [filter.player_id];
                }

                services.Item.searchTransferMarket(searchCriteria, 1)
                    .observe(this, function(sender, response) {
                        if (response.success) {
                            resolve(response.data.items || []);
                        } else {
                            reject(new Error(response.error?.message || 'Search failed'));
                        }
                    });
            } catch (e) {
                reject(e);
            }
        });
    }

    async function buyPlayer(item, maxPrice) {
        return new Promise((resolve, reject) => {
            try {
                const services = getServices();
                if (!services || !services.Item) {
                    reject(new Error('FUT не завантажено'));
                    return;
                }

                const buyNowPrice = item._auction?.buyNowPrice;
                if (!buyNowPrice || buyNowPrice > maxPrice) {
                    reject(new Error('Ціна змінилась'));
                    return;
                }

                services.Item.bid(item, buyNowPrice)
                    .observe(this, function(sender, response) {
                        if (response.success) {
                            resolve(true);
                        } else {
                            reject(new Error(response.error?.message || 'Buy failed'));
                        }
                    });
            } catch (e) {
                reject(e);
            }
        });
    }

    // ==========================================
    // SNIPER LOGIC
    // ==========================================
    function randomDelay(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    async function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    async function sniperLoop() {
        if (!isRunning) return;

        if (searchesThisHour >= CONFIG.MAX_SEARCHES_PER_HOUR) {
            log('⚠️ Ліміт пошуків. Пауза 10 хв...');
            await sleep(600000);
            searchesThisHour = 0;
        }

        const activeFilters = filters.filter(f => f.is_active);

        for (const filter of activeFilters) {
            if (!isRunning) break;

            try {
                stats.searches++;
                searchesThisHour++;
                updateUI();

                log(`🔍 ${filter.player_name || 'Пошук'}...`);
                const items = await searchMarket(filter);

                for (const item of items) {
                    if (!isRunning) break;

                    const buyNow = item._auction?.buyNowPrice;
                    if (!buyNow || buyNow > filter.max_buy_price) continue;

                    const playerName = item._staticData?.name || 'Гравець';
                    log(`💰 ${playerName} за ${buyNow.toLocaleString()}!`);
                    stats.found++;

                    try {
                        await sleep(CONFIG.BUY_DELAY);
                        await buyPlayer(item, filter.max_buy_price);

                        stats.bought++;
                        const profit = (filter.sell_price || buyNow) - buyNow - Math.floor((filter.sell_price || buyNow) * 0.05);
                        stats.profit += profit;

                        log(`✅ КУПЛЕНО! +${profit.toLocaleString()}`);
                        await logPurchase(playerName, buyNow, filter.sell_price || buyNow);
                        await saveStats();

                        log(`⏸️ Пауза ${CONFIG.PAUSE_AFTER_BUY/1000}с...`);
                        await sleep(CONFIG.PAUSE_AFTER_BUY);

                    } catch (buyErr) {
                        stats.errors++;
                        log(`❌ ${buyErr.message}`);
                    }

                    updateUI();
                }

            } catch (e) {
                stats.errors++;
                log(`❌ ${e.message}`);
            }

            if (isRunning) {
                await sleep(randomDelay(CONFIG.SEARCH_DELAY_MIN, CONFIG.SEARCH_DELAY_MAX));
            }
        }

        if (isRunning) {
            setTimeout(sniperLoop, 1000);
        }
    }

    function startSniper() {
        if (filters.length === 0) {
            log('❌ Немає фільтрів! Додайте в Telegram боті.');
            return;
        }
        if (!getServices()) {
            log('❌ FUT не завантажено. Оновіть сторінку.');
            return;
        }

        isRunning = true;
        log('▶️ Снайпер запущено!');
        updateUI();
        sniperLoop();
    }

    function stopSniper() {
        isRunning = false;
        log('⏹️ Снайпер зупинено');
        updateUI();
        saveStats();
    }

    // ==========================================
    // INIT
    // ==========================================
    function init() {
        console.log('[FC26 Sniper] Initializing...');

        const checkReady = setInterval(() => {
            if (document.querySelector('.ut-navigation-bar-view') ||
                document.querySelector('.ut-home-view') ||
                document.querySelector('.ut-hub-view')) {
                clearInterval(checkReady);
                console.log('[FC26 Sniper] FUT ready!');
                createUI();
                loadFilters();
            }
        }, 1000);

        setInterval(() => { searchesThisHour = 0; }, 3600000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 2000);
    }
})();