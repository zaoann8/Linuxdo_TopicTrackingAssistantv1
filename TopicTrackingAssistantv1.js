// ==UserScript==
// @name         Linux.do 话题追踪助手
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  追踪已读话题的新回复，推荐活跃话题，悬浮通知提醒
// @author       无及高
// @match        https://linux.do/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_addStyle
// @connect      linux.do
// @run-at       document-end
// @require      https://cdn.jsdelivr.net/npm/marked/marked.min.js
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置 ====================
    const CONFIG = {
        SITE_DOMAIN: 'linux.do',
        FAST_CHECK_INTERVAL: 60000,      // 快速检查：1分钟
        SLOW_CHECK_INTERVAL: 1800000,    // 慢速检查：30分钟
        LATEST_PAGES: 10,                 // 快速检查获取的页数
        RECOMMENDATION_TIME_WINDOW: 1080000, // 推荐时间窗口：18分钟
        MIN_POSTS_FOR_RECOMMENDATION: 3,  // 推荐话题最少回复数
        MAX_RECOMMENDATIONS: 999,         // 最多推荐数量（显示所有）
        STORAGE_KEYS: {
            fingerprints: 'ldtt_fingerprints',
            notifications: 'ldtt_notifications',
            recommendations: 'ldtt_recommendations',
            shownTopics: 'ldtt_shown_topics',
            settings: 'ldtt_settings'
        }
    };

    // ==================== 工具函数 ====================
    const Utils = {
        escapeHtml(str) {
            if (!str || typeof str !== 'string') return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },

        formatRelativeTime(utcStr) {
            if (!utcStr) return '';
            const d = new Date(utcStr);
            const now = new Date();
            const diff = (now - d) / 1000;
            if (diff < 60) return '刚刚';
            if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
            if (diff < 2592000) return `${Math.floor(diff / 86400)}天前`;
            return `${d.getMonth() + 1}月${d.getDate()}日`;
        },

        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        },

        uid() {
            return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        }
    };

    // ==================== 网络管理器 ====================
    class NetworkManager {
        async fetchJson(url, options = {}) {
            return new Promise((resolve, reject) => {
                const timeout = options.timeout || 15000;
                const timeoutId = setTimeout(() => reject(new Error('请求超时')), timeout);

                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    headers: {
                        'Accept': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Discourse-Present': 'true',
                        'Discourse-Logged-In': 'true',
                        ...options.headers
                    },
                    timeout,
                    onload: res => {
                        clearTimeout(timeoutId);
                        try {
                            if (res.status >= 200 && res.status < 300) {
                                resolve(JSON.parse(res.responseText));
                            } else if (res.status === 403) {
                                reject(new Error('需要登录'));
                            } else {
                                reject(new Error(`HTTP ${res.status}`));
                            }
                        } catch (e) {
                            reject(new Error('解析失败'));
                        }
                    },
                    onerror: () => {
                        clearTimeout(timeoutId);
                        reject(new Error('网络错误'));
                    },
                    ontimeout: () => {
                        clearTimeout(timeoutId);
                        reject(new Error('请求超时'));
                    }
                });
            });
        }

        async fetchLatest(pages = 1) {
            const topics = [];
            for (let i = 0; i < pages; i++) {
                const url = `https://${CONFIG.SITE_DOMAIN}/latest.json?page=${i}`;
                const response = await this.fetchJson(url);
                if (response && response.topic_list && response.topic_list.topics) {
                    topics.push(...response.topic_list.topics);
                }
                if (i < pages - 1) await Utils.sleep(300);
            }
            return topics;
        }

        async fetchTopic(topicId) {
            const url = `https://${CONFIG.SITE_DOMAIN}/t/${topicId}.json`;
            return await this.fetchJson(url);
        }

        async fetchReadTopics(page = 0) {
            const url = page > 0
                ? `https://${CONFIG.SITE_DOMAIN}/read.json?page=${page}`
                : `https://${CONFIG.SITE_DOMAIN}/read.json`;
            return await this.fetchJson(url);
        }
    }

    // ==================== 去重管理器 ====================
    class DeduplicationManager {
        constructor() {
            this.shownTopics = new Set();
            this.lastCleanup = Date.now();
            this.load();
        }

        markAsShown(topicId) {
            this.shownTopics.add(topicId);
            this.save();
        }

        hasShown(topicId) {
            return this.shownTopics.has(topicId);
        }

        cleanup() {
            const now = Date.now();
            if (now - this.lastCleanup > 86400000) {
                this.shownTopics.clear();
                this.lastCleanup = now;
                this.save();
            }
        }

        save() {
            GM_setValue(CONFIG.STORAGE_KEYS.shownTopics, {
                ids: Array.from(this.shownTopics),
                lastCleanup: this.lastCleanup
            });
        }

        load() {
            const data = GM_getValue(CONFIG.STORAGE_KEYS.shownTopics, null);
            if (data) {
                this.shownTopics = new Set(data.ids || []);
                this.lastCleanup = data.lastCleanup || Date.now();
            }
        }
    }

    // ==================== 话题追踪器 ====================
    class TopicTracker {
        constructor() {
            this.network = new NetworkManager();
            this.dedup = new DeduplicationManager();
            this.fingerprints = new Map();
            this.notifications = [];
            this.recommendations = [];
            this.isRunning = false;
            this.fastTimer = null;
            this.slowTimer = null;
            this.load();
        }

        async init() {

            // 如果指纹库为空，从已读话题构建
            if (this.fingerprints.size === 0) {
                await this.buildFingerprints();
            }

        }

        async buildFingerprints() {
            let page = 0;
            let hasMore = true;
            let count = 0;

            while (hasMore && page < 20) {
                try {
                    const response = await this.network.fetchReadTopics(page);
                    if (response && response.topic_list && response.topic_list.topics) {
                        response.topic_list.topics.forEach(topic => {
                            this.fingerprints.set(topic.id, {
                                id: topic.id,
                                title: topic.title,
                                slug: topic.slug,
                                posts_count: topic.posts_count || 0,
                                like_count: topic.like_count || 0,
                                last_posted_at: topic.last_posted_at,
                                category_name: topic.category?.name || '',
                                lastChecked: Date.now()
                            });
                            count++;
                        });
                        hasMore = !!response.topic_list.more_topics_url;
                        page++;
                        await Utils.sleep(500);
                    } else {
                        break;
                    }
                } catch (e) {
                    console.error('[话题追踪] 获取已读话题失败:', e.message);
                    break;
                }
            }

            this.save();

        }

        async syncReadTopics() {

            let page = 0;
            let hasMore = true;
            let newCount = 0;
            let totalChecked = 0;

            // 获取所有已读话题（直到没有更多）
            while (hasMore && page < 50) {  // 最多50页，避免无限循环
                try {
                    const response = await this.network.fetchReadTopics(page);
                    if (response && response.topic_list && response.topic_list.topics) {
                        response.topic_list.topics.forEach(topic => {
                            totalChecked++;
                            // 如果是新话题，添加到指纹库
                            if (!this.fingerprints.has(topic.id)) {
                                this.fingerprints.set(topic.id, {
                                    id: topic.id,
                                    title: topic.title,
                                    slug: topic.slug,
                                    posts_count: topic.posts_count || 0,
                                    like_count: topic.like_count || 0,
                                    last_posted_at: topic.last_posted_at,
                                    category_name: topic.category?.name || '',
                                    lastChecked: Date.now()
                                });
                                newCount++;
                            }
                        });
                        hasMore = !!response.topic_list.more_topics_url;
                        page++;

                        // 延迟避免限流
                        if (hasMore) {
                            await Utils.sleep(500);
                        }
                    } else {
                        break;
                    }
                } catch (e) {
                    console.error('[同步] 获取已读话题失败:', e.message);
                    break;
                }
            }

            if (newCount > 0) {
                this.save();

            } else {

            }
        }

        start() {
            if (this.isRunning) return;
            this.isRunning = true;

            // 快速检查：每1分钟
            this.fastTimer = setInterval(() => this.fastCheck(), CONFIG.FAST_CHECK_INTERVAL);

            // 慢速检查：每30分钟
            this.slowTimer = setInterval(() => this.slowCheck(), CONFIG.SLOW_CHECK_INTERVAL);

            // 同步已读话题：每1小时
            this.syncTimer = setInterval(() => this.syncReadTopics(), 3600000);

            // 立即执行一次快速检查
            this.fastCheck();

            // 30秒后执行一次同步（避免初始化时太多请求）
            setTimeout(() => this.syncReadTopics(), 30000);
        }

        stop() {
            if (!this.isRunning) return;
            this.isRunning = false;

            if (this.fastTimer) {
                clearInterval(this.fastTimer);
                this.fastTimer = null;
            }
            if (this.slowTimer) {
                clearInterval(this.slowTimer);
                this.slowTimer = null;
            }
            if (this.syncTimer) {
                clearInterval(this.syncTimer);
                this.syncTimer = null;
            }


        }

        async fastCheck() {


            try {
                const latest = await this.network.fetchLatest(CONFIG.LATEST_PAGES);
                const myTopics = [];
                const newTopics = [];

                // 分类
                latest.forEach(topic => {
                    if (this.fingerprints.has(topic.id)) {
                        myTopics.push(topic);
                    } else {
                        newTopics.push(topic);
                    }
                });



                // 检测已读话题更新
                myTopics.forEach(topic => this.detectChanges(topic));

                // 更新推荐
                this.updateRecommendations(newTopics);

                this.save();
            } catch (e) {
                console.error('[快速检查] 失败:', e.message);
            }
        }

        async slowCheck() {


            let checked = 0;
            for (const [topicId, fp] of this.fingerprints) {
                try {
                    const topic = await this.network.fetchTopic(topicId);
                    this.detectChanges(topic);
                    checked++;

                    if (checked % 10 === 0) {
                        await Utils.sleep(1000);
                    }
                } catch (e) {
                    console.warn(`[慢速检查] 话题 ${topicId} 失败:`, e.message);
                }
            }


            this.save();
        }

        detectChanges(topic) {
            const old = this.fingerprints.get(topic.id);
            if (!old) return;

            const newPosts = topic.posts_count - old.posts_count;
            const newLikes = topic.like_count - old.like_count;

            if (newPosts > 0) {
                this.addNotification({
                    id: Utils.uid(),
                    type: 'new_reply',
                    topicId: topic.id,
                    title: topic.title,
                    slug: topic.slug,
                    message: `有 ${newPosts} 条新回复`,
                    newCount: newPosts,
                    oldCount: old.posts_count,
                    currentCount: topic.posts_count,
                    timestamp: Date.now(),
                    read: false,
                    url: `https://${CONFIG.SITE_DOMAIN}/t/${topic.slug}/${topic.id}`
                });

                old.posts_count = topic.posts_count;
            }

            if (newLikes > 0) {
                this.addNotification({
                    id: Utils.uid(),
                    type: 'new_like',
                    topicId: topic.id,
                    title: topic.title,
                    slug: topic.slug,
                    message: `有 ${newLikes} 个新点赞`,
                    newCount: newLikes,
                    oldCount: old.like_count,
                    currentCount: topic.like_count,
                    timestamp: Date.now(),
                    read: false,
                    url: `https://${CONFIG.SITE_DOMAIN}/t/${topic.slug}/${topic.id}`
                });

                old.like_count = topic.like_count;
            }

            old.lastChecked = Date.now();
        }

        updateRecommendations(newTopics) {
            const filtered = this.filterRecommendations(newTopics);

            // 计算活跃度评分
            const scored = filtered.map(t => ({
                ...t,
                activity_score: this.calculateActivityScore(t)
            }));

            // 增量添加：只添加新的推荐话题
            const existingIds = new Set(this.recommendations.map(r => r.id));
            const newRecommendations = scored.filter(t => !existingIds.has(t.id));

            if (newRecommendations.length > 0) {
                // 添加新推荐
                this.recommendations.push(...newRecommendations);

                // 按最新回复时间排序（最新的在前面）
                this.recommendations.sort((a, b) => {
                    const timeA = new Date(a.last_posted_at).getTime();
                    const timeB = new Date(b.last_posted_at).getTime();
                    return timeB - timeA;  // 降序：最新的在前
                });

                // 标记为已显示
                newRecommendations.forEach(t => this.dedup.markAsShown(t.id));

                // 保存
                this.save();

                // 触发UI更新
                window.dispatchEvent(new CustomEvent('ldtt:recommendations', {
                    detail: { count: this.recommendations.length, newCount: newRecommendations.length }
                }));
            }
        }

        filterRecommendations(topics) {
            const now = Date.now();
            const timeWindow = now - CONFIG.RECOMMENDATION_TIME_WINDOW; // 18分钟

            let totalCount = topics.length;
            let alreadyReadCount = 0;
            let alreadyShownCount = 0;
            let tooOldCount = 0;

            // 筛选条件：未读 + 未推荐过 + 最近18分钟有活动
            const filtered = topics.filter(t => {
                if (this.fingerprints.has(t.id)) {
                    alreadyReadCount++;
                    return false;  // 已读话题
                }
                if (this.dedup.hasShown(t.id)) {
                    alreadyShownCount++;
                    return false;    // 已推荐过
                }

                // 时间过滤：只推荐最近18分钟有活动的话题
                const lastActivity = new Date(t.last_posted_at).getTime();
                if (lastActivity < timeWindow) {
                    tooOldCount++;
                    return false;
                }

                return true;
            });


            return filtered;
        }

        calculateActivityScore(topic) {
            const now = Date.now();
            const lastActivity = new Date(topic.last_posted_at).getTime();
            const ageMinutes = (now - lastActivity) / 60000;
            const timeFactor = Math.max(0, (30 - ageMinutes) / 30);
            const interactionScore = topic.posts_count + topic.like_count * 2;
            const viewScore = Math.log10(topic.views + 1);
            return timeFactor * 50 + interactionScore * 0.3 + viewScore * 20;
        }

        addNotification(notif) {
            this.notifications.unshift(notif);
            // 不限制数量，显示所有实际更新

            // 触发UI更新
            window.dispatchEvent(new CustomEvent('ldtt:notification', { detail: notif }));
        }

        markAsRead(notifId) {
            // 从列表中移除该通知
            this.notifications = this.notifications.filter(n => n.id !== notifId);
            this.save();
        }

        markAllAsRead() {
            // 清空所有已读通知
            this.notifications = this.notifications.filter(n => false);
            this.save();
        }

        getUnreadCount() {
            return this.notifications.filter(n => !n.read).length;
        }

        save() {
            GM_setValue(CONFIG.STORAGE_KEYS.fingerprints, {
                data: Array.from(this.fingerprints.entries()),
                timestamp: Date.now()
            });
            GM_setValue(CONFIG.STORAGE_KEYS.notifications, this.notifications);
            GM_setValue(CONFIG.STORAGE_KEYS.recommendations, this.recommendations);
        }

        load() {
            const fpData = GM_getValue(CONFIG.STORAGE_KEYS.fingerprints, null);
            if (fpData && fpData.data) {
                this.fingerprints = new Map(fpData.data);
            }
            this.notifications = GM_getValue(CONFIG.STORAGE_KEYS.notifications, []);
            this.recommendations = GM_getValue(CONFIG.STORAGE_KEYS.recommendations, []);
        }

        removeRecommendation(topicId) {
            // 从推荐列表中移除该话题
            this.recommendations = this.recommendations.filter(r => r.id !== topicId);
            this.save();
        }

        clearAllRecommendations() {
            // 清空所有推荐话题
            this.recommendations = [];
            // 同时清空去重记录，允许这些话题重新被推荐
            this.dedup.shownTopics.clear();
            this.dedup.save();
            this.save();
        }
    }

    // ==================== UI管理器 ====================
    class UIManager {
        constructor(tracker) {
            this.tracker = tracker;
            this.indicator = null;
            this.panel = null;
            this.currentTab = 'updates';
            this.createStyles();
            this.createIndicator();
            this.createPanel();
            this.bindEvents();
        }

        createStyles() {
            GM_addStyle(`
                #ldtt-indicator {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: #fff;
                    padding: 12px 20px;
                    border-radius: 24px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    cursor: pointer;
                    z-index: 9999;
                    font-size: 14px;
                    font-weight: 500;
                    transition: all 0.3s;
                    user-select: none;
                }
                #ldtt-indicator:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 16px rgba(102, 126, 234, 0.3);
                }
                #ldtt-indicator.has-updates {
                    animation: ldtt-pulse 2s infinite;
                }
                @keyframes ldtt-pulse {
                    0%, 100% { box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
                    50% { box-shadow: 0 4px 20px rgba(102, 126, 234, 0.5); }
                }
                #ldtt-panel {
                    position: fixed;
                    bottom: 80px;
                    right: 20px;
                    width: 400px;
                    max-height: 600px;
                    background: #fff;
                    border-radius: 12px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.15);
                    z-index: 9998;
                    display: none;
                    flex-direction: column;
                    overflow: hidden;
                }
                #ldtt-panel.show {
                    display: flex;
                }
                .ldtt-header {
                    display: flex;
                    align-items: center;
                    padding: 16px 20px;
                    border-bottom: 1px solid #e5e7eb;
                    background: #f9fafb;
                }
                .ldtt-tabs {
                    display: flex;
                    gap: 8px;
                    flex: 1;
                }
                .ldtt-tab {
                    padding: 6px 12px;
                    border-radius: 6px;
                    font-size: 13px;
                    cursor: pointer;
                    transition: all 0.2s;
                    color: #6b7280;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .ldtt-tab.active {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: #fff;
                }
                .ldtt-tab-count {
                    display: inline-block;
                    min-width: 18px;
                    height: 18px;
                    line-height: 18px;
                    text-align: center;
                    border-radius: 9px;
                    font-size: 11px;
                    font-weight: 600;
                }
                .ldtt-tab.active .ldtt-tab-count {
                    background: rgba(255, 255, 255, 0.25);
                    color: #fff;
                }
                .ldtt-tab:not(.active) .ldtt-tab-count {
                    background: #e5e7eb;
                    color: #6b7280;
                }
                .ldtt-tab-count:empty {
                    display: none;
                }
                .ldtt-close {
                    background: none;
                    border: none;
                    font-size: 18px;
                    cursor: pointer;
                    color: #9ca3af;
                    padding: 0;
                    width: 24px;
                    height: 24px;
                }
                .ldtt-close:hover {
                    color: #374151;
                }
                .ldtt-sync {
                    background: none;
                    border: none;
                    font-size: 16px;
                    cursor: pointer;
                    color: #9ca3af;
                    padding: 0;
                    width: 24px;
                    height: 24px;
                    margin-right: 8px;
                    transition: all 0.3s;
                }
                .ldtt-sync:hover {
                    color: #667eea;
                }
                .ldtt-sync.syncing {
                    animation: ldtt-rotate 1s linear infinite;
                    color: #667eea;
                }
                @keyframes ldtt-rotate {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                .ldtt-content {
                    flex: 1;
                    overflow-y: auto;
                    padding: 16px;
                }
                .ldtt-item {
                    padding: 12px;
                    margin-bottom: 8px;
                    border-radius: 8px;
                    background: #f9fafb;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .ldtt-item:hover {
                    background: #f3f4f6;
                    transform: translateX(-2px);
                }
                .ldtt-item-title {
                    font-size: 14px;
                    font-weight: 500;
                    color: #111827;
                    margin-bottom: 4px;
                }
                .ldtt-item-meta {
                    font-size: 12px;
                    color: #6b7280;
                }
                .ldtt-empty {
                    text-align: center;
                    padding: 40px 20px;
                    color: #9ca3af;
                }
                .ldtt-rec-score {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    font-size: 11px;
                    margin-top: 4px;
                }
                .ldtt-rec-bar {
                    flex: 1;
                    height: 4px;
                    background: #e5e7eb;
                    border-radius: 2px;
                    overflow: hidden;
                }
                .ldtt-rec-bar-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #f59e0b 0%, #ef4444 100%);
                    transition: width 0.3s;
                }
                .ldtt-footer {
                    padding: 12px 16px;
                    border-top: 1px solid #e5e7eb;
                    display: flex;
                    gap: 8px;
                }
                .ldtt-btn {
                    flex: 1;
                    padding: 8px 12px;
                    border: none;
                    border-radius: 6px;
                    font-size: 13px;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .ldtt-btn-primary {
                    background: #667eea;
                    color: #fff;
                }
                .ldtt-btn-primary:hover {
                    background: #5568d3;
                }
                .ldtt-btn-secondary {
                    background: #e5e7eb;
                    color: #374151;
                }
                .ldtt-btn-secondary:hover {
                    background: #d1d5db;
                }
                @keyframes ldtt-fadein {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes ldtt-fadeout {
                    from { opacity: 1; transform: translateY(0); }
                    to { opacity: 0; transform: translateY(10px); }
                }
            `);
        }

        createIndicator() {
            this.indicator = document.createElement('div');
            this.indicator.id = 'ldtt-indicator';
            this.indicator.textContent = '📬 运行中';
            document.body.appendChild(this.indicator);

            this.indicator.addEventListener('click', () => {
                this.togglePanel();
            });
        }

        createPanel() {
            this.panel = document.createElement('div');
            this.panel.id = 'ldtt-panel';
            this.panel.innerHTML = `
                <div class="ldtt-header">
                    <div class="ldtt-tabs">
                        <div class="ldtt-tab active" data-tab="updates">已读更新 <span class="ldtt-tab-count" id="ldtt-updates-count"></span></div>
                        <div class="ldtt-tab" data-tab="recommendations">推荐话题 <span class="ldtt-tab-count" id="ldtt-recs-count"></span></div>
                    </div>
                    <button class="ldtt-sync" id="ldtt-sync" title="同步已读话题">🔄</button>
                    <button class="ldtt-close">✕</button>
                </div>
                <div class="ldtt-content" id="ldtt-content"></div>
                <div class="ldtt-footer" id="ldtt-footer"></div>
            `;
            document.body.appendChild(this.panel);
        }

        bindEvents() {
            // 标签页切换
            this.panel.querySelectorAll('.ldtt-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    this.switchTab(tab.dataset.tab);
                });
            });

            // 关闭按钮
            this.panel.querySelector('.ldtt-close').addEventListener('click', () => {
                this.hidePanel();
            });

            // 同步按钮
            this.panel.querySelector('#ldtt-sync').addEventListener('click', async () => {
                const syncBtn = this.panel.querySelector('#ldtt-sync');
                if (syncBtn.classList.contains('syncing')) return;

                syncBtn.classList.add('syncing');
                try {
                    await this.tracker.syncReadTopics();
                    this.showToast('✅ 同步完成');
                } catch (e) {
                    this.showToast(`❌ 同步失败: ${e.message}`);
                } finally {
                    syncBtn.classList.remove('syncing');
                }
            });

            // 监听新通知
            window.addEventListener('ldtt:notification', () => {
                this.updateBadge();
                if (this.currentTab === 'updates') {
                    this.renderUpdates();
                }
            });

            // 监听推荐更新
            window.addEventListener('ldtt:recommendations', () => {
                this.updateBadge();
                if (this.currentTab === 'recommendations') {
                    this.renderRecommendations();
                }
            });
        }

        togglePanel() {
            if (this.panel.classList.contains('show')) {
                this.hidePanel();
            } else {
                this.showPanel();
            }
        }

        showPanel() {
            this.panel.classList.add('show');
            this.renderContent();
        }

        hidePanel() {
            this.panel.classList.remove('show');
        }

        switchTab(tab) {
            this.currentTab = tab;
            this.panel.querySelectorAll('.ldtt-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.tab === tab);
            });
            this.renderContent();
        }

        renderContent() {
            if (this.currentTab === 'updates') {
                this.renderUpdates();
            } else {
                this.renderRecommendations();
            }
        }

        renderUpdates() {
            const content = this.panel.querySelector('#ldtt-content');
            const footer = this.panel.querySelector('#ldtt-footer');

            if (this.tracker.notifications.length === 0) {
                content.innerHTML = '<div class="ldtt-empty">暂无更新</div>';
                footer.innerHTML = '';
                return;
            }

            const html = this.tracker.notifications.map(notif => {
                const icon = notif.type === 'new_reply' ? '💬' : '❤️';
                const typeText = notif.type === 'new_reply' ? '回复' : '点赞';

                // 构建详细信息：原始数量 → 当前数量 (新增数量)
                let detailText = '';
                if (notif.oldCount !== undefined && notif.currentCount !== undefined) {
                    detailText = `${notif.oldCount}→${notif.currentCount}${typeText} (+${notif.newCount})`;
                } else {
                    detailText = `有 ${notif.newCount} ${notif.type === 'new_reply' ? '条新回复' : '个新点赞'}`;
                }

                return `
                    <div class="ldtt-item" data-id="${notif.id}" data-url="${notif.url}">
                        <div class="ldtt-item-title">${icon} ${Utils.escapeHtml(notif.title)}</div>
                        <div class="ldtt-item-meta">${detailText} · ${Utils.formatRelativeTime(new Date(notif.timestamp).toISOString())}</div>
                    </div>
                `;
            }).join('');

            content.innerHTML = html;

            // 绑定点击事件
            content.querySelectorAll('.ldtt-item').forEach(item => {
                item.addEventListener('click', () => {
                    const url = item.dataset.url;
                    const id = item.dataset.id;
                    this.tracker.markAsRead(id);
                    window.open(url, '_blank');
                    this.renderUpdates();
                    this.updateBadge();
                });
            });

            footer.innerHTML = `
                <button class="ldtt-btn ldtt-btn-secondary" id="ldtt-mark-all">全部标记为已读</button>
            `;

            footer.querySelector('#ldtt-mark-all').addEventListener('click', () => {
                this.tracker.markAllAsRead();
                this.renderUpdates();
                this.updateBadge();
            });
        }

        renderRecommendations() {
            const content = this.panel.querySelector('#ldtt-content');
            const footer = this.panel.querySelector('#ldtt-footer');

            if (this.tracker.recommendations.length === 0) {
                content.innerHTML = '<div class="ldtt-empty">暂无推荐</div>';
                footer.innerHTML = '';
                return;
            }

            const html = this.tracker.recommendations.map(topic => {
                const score = Math.round(topic.activity_score);
                const barWidth = Math.min(100, score);
                return `
                    <div class="ldtt-item" data-id="${topic.id}" data-url="https://${CONFIG.SITE_DOMAIN}/t/${topic.slug}/${topic.id}">
                        <div class="ldtt-item-title">🆕 ${Utils.escapeHtml(topic.title)}</div>
                        <div class="ldtt-item-meta">💬 ${topic.posts_count}回复 · 👁️ ${topic.views}浏览 · ${topic.category?.name || ''}</div>
                        <div class="ldtt-rec-score">
                            <span>🔥</span>
                            <div class="ldtt-rec-bar">
                                <div class="ldtt-rec-bar-fill" style="width: ${barWidth}%"></div>
                            </div>
                            <span>${score}%</span>
                        </div>
                    </div>
                `;
            }).join('');

            content.innerHTML = html;

            content.querySelectorAll('.ldtt-item').forEach(item => {
                item.addEventListener('click', () => {
                    const url = item.dataset.url;
                    const id = parseInt(item.dataset.id);

                    // 移除该推荐
                    this.tracker.removeRecommendation(id);

                    // 打开话题
                    window.open(url, '_blank');

                    // 刷新UI
                    this.renderRecommendations();
                    this.updateBadge();
                });
            });

            footer.innerHTML = '';

            // 如果有推荐话题，显示清除按钮
            if (this.tracker.recommendations.length > 0) {
                footer.innerHTML = `
                    <button class="ldtt-btn ldtt-btn-secondary" id="ldtt-clear-recs">清空推荐列表</button>
                `;

                footer.querySelector('#ldtt-clear-recs').addEventListener('click', () => {
                    this.tracker.clearAllRecommendations();
                    this.renderRecommendations();
                    this.updateBadge();
                    this.showToast('✅ 已清空推荐列表');
                });
            }
        }

        updateBadge() {
            const unreadCount = this.tracker.getUnreadCount();
            const recCount = this.tracker.recommendations.length;
            const total = unreadCount + recCount;

            // 更新指示器 - 分开显示
            if (total > 0) {
                const parts = [];
                if (unreadCount > 0) parts.push(`${unreadCount}条更新`);
                if (recCount > 0) parts.push(`${recCount}条推荐`);
                this.indicator.textContent = `📬 ${parts.join(' · ')}`;
                this.indicator.classList.add('has-updates');
            } else {
                this.indicator.textContent = '📬 运行中';
                this.indicator.classList.remove('has-updates');
            }

            // 更新标签页计数
            const updatesCountEl = document.getElementById('ldtt-updates-count');
            const recsCountEl = document.getElementById('ldtt-recs-count');

            if (updatesCountEl) {
                updatesCountEl.textContent = unreadCount > 0 ? `(${unreadCount})` : '';
            }
            if (recsCountEl) {
                recsCountEl.textContent = recCount > 0 ? `(${recCount})` : '';
            }
        }

        showToast(message) {
            // 简单的 toast 提示
            const toast = document.createElement('div');
            toast.style.cssText = `
                position: fixed;
                bottom: 100px;
                right: 20px;
                background: #374151;
                color: #fff;
                padding: 12px 20px;
                border-radius: 8px;
                font-size: 14px;
                z-index: 10000;
                animation: ldtt-fadein 0.3s;
            `;
            toast.textContent = message;
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.style.animation = 'ldtt-fadeout 0.3s';
                setTimeout(() => toast.remove(), 300);
            }, 2000);
        }
    }

    // ==================== 启动 ====================
    async function init() {

        const tracker = new TopicTracker();
        await tracker.init();

        const ui = new UIManager(tracker);
        ui.updateBadge();

        tracker.start();

        // 页面可见性控制
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {

            } else {

                tracker.fastCheck();
            }
        });


    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
