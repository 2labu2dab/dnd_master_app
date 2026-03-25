'use strict';

/**
 * DndCacheManager — двухуровневый кеш ассетов DnD-приложения.
 *
 * Уровень 1: Cache API браузера (persistent, переживает перезагрузку страницы).
 * Уровень 2: Map<url, blobURL> в памяти (instant доступ без async).
 *
 * Поддерживает:
 *  - Предзагрузку всех карт, токенов и портретов при старте
 *  - Инвалидацию конкретного URL при обновлении ассета
 *  - Получение blob-URL для немедленной отрисовки без HTTP-запроса
 *  - Отчёт о прогрессе загрузки через onProgress callback
 */
class DndCacheManager {
    constructor(cacheName = 'dnd-assets-v1') {
        this.cacheName = cacheName;
        this._mem = new Map();     // url → blobURL
        this._inflight = new Map(); // url → Promise<blobURL>
        this._api = null;          // CacheStorage instance
        this._ready = false;
    }

    /** Инициализация. Вызвать один раз до использования. */
    async init() {
        if ('caches' in window) {
            try {
                this._api = await caches.open(this.cacheName);
            } catch (e) {
                console.warn('[DndCache] Cache API unavailable:', e);
            }
        }
        this._ready = true;
        return this;
    }

    /** Синхронная проверка — есть ли URL в памяти. */
    has(url) { return this._mem.has(url); }

    /** Синхронное получение blob-URL (только если уже в памяти). */
    get(url) { return this._mem.get(url) || null; }

    /**
     * Загрузить URL в кеш и вернуть blob-URL.
     * Если уже в памяти — возвращает немедленно.
     * Если есть в Cache API — восстанавливает в память без сети.
     * Иначе — скачивает, сохраняет в оба кеша.
     */
    async fetch(url) {
        if (!url) return null;
        if (this._mem.has(url)) return this._mem.get(url);

        // Дедупликация параллельных запросов
        if (this._inflight.has(url)) return this._inflight.get(url);

        const p = this._load(url);
        this._inflight.set(url, p);
        try {
            return await p;
        } finally {
            this._inflight.delete(url);
        }
    }

    async _load(url) {
        // Ленивая инициализация Cache API
        if (!this._ready) await this.init();

        // Пробуем Cache API
        if (this._api) {
            try {
                const cached = await this._api.match(url);
                if (cached) {
                    const blob = await cached.blob();
                    const blobUrl = URL.createObjectURL(blob);
                    this._mem.set(url, blobUrl);
                    return blobUrl;
                }
            } catch (e) { /* ignore */ }
        }

        // Скачиваем
        try {
            const response = await fetch(url);
            if (!response.ok) return null;

            const clone = response.clone();
            if (this._api) {
                try { this._api.put(url, clone); } catch (e) { /* ignore */ }
            }

            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            this._mem.set(url, blobUrl);
            return blobUrl;
        } catch (e) {
            return null;
        }
    }

    /**
     * Инвалидация одного URL.
     * Старый blob-URL освобождается, запись удаляется из Cache API.
     */
    invalidate(url) {
        if (!url) return;
        const blobUrl = this._mem.get(url);
        if (blobUrl) {
            try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ }
            this._mem.delete(url);
        }
        if (this._api) {
            try { this._api.delete(url); } catch (e) { /* ignore */ }
        }
    }

    /**
     * Загрузить изображение — возвращает HTMLImageElement из кеша.
     */
    async loadImage(url) {
        const src = await this.fetch(url) || url;
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Image load failed: ' + url));
            img.src = src;
        });
    }

    /**
     * Предзагрузить все ассеты всех карт.
     *
     * @param {object}   opts
     * @param {Function} opts.onProgress  (loaded, total) => void
     * @param {boolean}  opts.master      Если true — скачивает ассеты мастера (оригинальные изображения)
     * @returns {Promise<void>}
     */
    async preloadAll({ onProgress, master = false } = {}) {
        let mapsRes, maps;
        try {
            mapsRes = await fetch('/api/maps');
            maps = await mapsRes.json();
        } catch (e) {
            console.error('[DndCache] Failed to fetch maps list:', e);
            return;
        }

        // Собираем все URL для загрузки
        const allUrls = [];

        // Изображения карт — используем versioned URL из API (с ?v=mtime)
        for (const map of maps) {
            if (map.has_image && map.image_url) {
                allUrls.push(map.image_url);
            }
        }

        // Токены и портреты берём из данных каждой карты
        const mapDataPromises = maps.map(async (map) => {
            try {
                const endpoint = master
                    ? `/api/map/${map.id}`
                    : `/api/map/${map.id}?for=player`;
                const res = await fetch(endpoint);
                if (!res.ok) return;
                const data = await res.json();

                for (const token of data.tokens || []) {
                    if (token.avatar_url) allUrls.push(token.avatar_url);
                }
                for (const char of data.characters || []) {
                    if (char.portrait_url) allUrls.push(char.portrait_url);
                }
            } catch (e) { /* ignore */ }
        });

        await Promise.all(mapDataPromises);

        // Убираем дубли
        const unique = [...new Set(allUrls)];
        const total = unique.length;
        let loaded = 0;

        if (onProgress) onProgress(loaded, total);

        // Загружаем параллельно пачками по 4 чтобы не перегружать сеть
        const BATCH = 4;
        for (let i = 0; i < unique.length; i += BATCH) {
            const batch = unique.slice(i, i + BATCH);
            await Promise.all(batch.map(async (url) => {
                await this.fetch(url);
                loaded++;
                if (onProgress) onProgress(loaded, total);
            }));
        }
    }
}

// Глобальный синглтон
window.dndCache = new DndCacheManager();
