// static/js/player.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");

/** Буфер канваса = CSS-размер × DPR (чёткость на телефонах и ТВ). */
let playerCanvasDpr = 1;
function getPlayerCanvasCssPixels() {
    return {
        w: Math.max(1, Math.round(canvas.clientWidth)),
        h: Math.max(1, Math.round(canvas.clientHeight)),
    };
}
function measurePlayerCanvasDevicePixelRatio() {
    const r = window.devicePixelRatio || 1;
    return Math.min(Math.max(r, 1), 3);
}
/** Сброс матрицы, очистка битмапа, ctx в логических (CSS) пикселях. */
function playerCanvasBeginFrame() {
    const { w: lw, h: lh } = getPlayerCanvasCssPixels();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(playerCanvasDpr, 0, 0, playerCanvasDpr, 0, 0);
    ctx.clearRect(0, 0, lw, lh);
    return { lw, lh };
}

const isEmbeddedPreview = window !== window.parent;
let mapData = null;
let zoomLevel = 1;
let pendingTokenUpdates = new Map();
let tokenUpdateTimeout = null;
let drawingsLoaded = false;
let lastDrawingsHash = '';
let playerDrawings = [];
let playerDrawingLayerId = null;
let panX = 0;
let panY = 0;
const TOKEN_SMOOTHING_ENABLED = true;
const isMiniMap = isEmbeddedPreview;
const playerChannel = new BroadcastChannel('dnd_map_channel');

function readParentMasterMapId() {
    try {
        if (!window.parent || window.parent === window) return null;
        const p = window.parent;
        return p.masterCurrentMapId ?? p.currentMapId ?? null;
    } catch {
        return null;
    }
}

function resolvedPlayerUrl(u) {
    if (!u) return "";
    try {
        return new URL(u, window.location.origin).href;
    } catch {
        return String(u);
    }
}

if (document.body && isMiniMap) {
    document.body.classList.add('player-embed');
}

/* Телефон в альбоме часто >768px по ширине — иначе включается десктопная сетка и колонки становятся крошечными */
const PLAYER_MOBILE_MQ = window.matchMedia(
    '(max-width: 768px), ((max-height: 520px) and (orientation: landscape) and (max-width: 1024px))'
);

function isPlayerMobileLayout() {
    return !isMiniMap && PLAYER_MOBILE_MQ.matches;
}

function syncPlayerMobileClass() {
    if (isMiniMap || !document.body) return;
    document.body.classList.toggle('player-mobile', PLAYER_MOBILE_MQ.matches);
}

syncPlayerMobileClass();
PLAYER_MOBILE_MQ.addEventListener('change', () => {
    syncPlayerMobileClass();
    updatePortraits();
});

let _playerLayoutResizeTimer;
window.addEventListener(
    'resize',
    () => {
        clearTimeout(_playerLayoutResizeTimer);
        _playerLayoutResizeTimer = setTimeout(() => {
            syncPlayerMobileClass();
            updatePortraits();
        }, 150);
    },
    { passive: true }
);

let mapImage = new Image();
const avatarCache = new Map();
const portraitImageCache = new Map();
// mapId → HTMLImageElement загруженный из кеша (для немедленной отрисовки)
const mapImageCache = new Map();
let renderRequested = false;

// ---- Загрузочный экран (только для полноэкранного режима) ----
const _loadingOverlay = document.getElementById('dnd-loading-overlay');
const _loadingBar = document.getElementById('dnd-loading-bar');
const _loadingText = document.getElementById('dnd-loading-text');

function showLoadingOverlay() {
    if (isMiniMap || !_loadingOverlay) return;
    _loadingOverlay.style.display = 'flex';
}
function hideLoadingOverlay() {
    if (!_loadingOverlay) return;
    _loadingOverlay.style.display = 'none';
}
function updateLoadingProgress(loaded, total) {
    if (isMiniMap || !_loadingBar || !_loadingText) return;
    const pct = total > 0 ? Math.round(loaded / total * 100) : 100;
    _loadingBar.style.width = pct + '%';
    _loadingText.textContent = total > 0
        ? `Загружено ${loaded} из ${total} ресурсов`
        : 'Всё загружено';
}

// Помещаем blob-URL из dndCache в mapImageCache (HTMLImageElement)
function _storeInMapImageCache(mapId, blobUrl) {
    if (!blobUrl || mapImageCache.has(mapId)) return;
    const img = new Image();
    img.onload = () => mapImageCache.set(mapId, img);
    img.src = blobUrl;
}

// Предзагружаем все карты через dndCache и показываем прогресс
async function preloadAllAssets() {
    if (isMiniMap) return; // в мини-карте не нужно
    showLoadingOverlay();
    updateLoadingProgress(0, 1);

    await dndCache.init();

    // Загружаем список карт
    let maps = [];
    try {
        const r = await fetch('/api/maps');
        maps = await r.json();
    } catch (e) {
        hideLoadingOverlay();
        return;
    }

    const mapsWithImages = maps.filter(m => m.has_image);
    const total = mapsWithImages.length;
    let loaded = 0;
    updateLoadingProgress(0, total);

    // Параллельная загрузка изображений (батчами по 3)
    const BATCH = 3;
    for (let i = 0; i < mapsWithImages.length; i += BATCH) {
        const batch = mapsWithImages.slice(i, i + BATCH);
        await Promise.all(batch.map(async (map) => {
            const url = map.image_url || `/api/map/image/${map.id}`;
            const blobUrl = await dndCache.fetch(url);
            _storeInMapImageCache(map.id, blobUrl);
            loaded++;
            updateLoadingProgress(loaded, total);
        }));
    }

    hideLoadingOverlay();

    // Подгружаем портреты и токены в фоне (не блокируем UI)
    maps.forEach(map => {
        fetch(`/api/map/${map.id}?for=player`)
            .then(r => r.json())
            .then(data => {
                (data.tokens || []).forEach(t => { if (t.avatar_url) dndCache.fetch(t.avatar_url); });
                (data.characters || []).forEach(c => { if (c.portrait_url) dndCache.fetch(c.portrait_url); });
            })
            .catch(() => {});
    });
}

function inferPortraitMedia(character) {
    if (!character) return "image";
    const m = character.portrait_media;
    if (m === "gif" || m === "video" || m === "image") return m;
    const u = (character.portrait_url || "").split("?")[0];
    if (/\.(webm|mp4|mov|m4v)$/i.test(u)) return "video";
    if (/\.gif$/i.test(u)) return "gif";
    return "image";
}

function portraitUrlsMatch(a, b) {
    if (!a || !b) return false;
    try {
        const base = window.location?.href || document.baseURI;
        return new URL(a, base).href === new URL(b, base).href;
    } catch {
        return String(a) === String(b);
    }
}

function preloadPortraits(characters) {
    if (!characters) return;
    characters.forEach(c => {
        const url = c.portrait_url || (c.has_avatar ? `/api/portrait/${c.id}` : null);
        if (!url || inferPortraitMedia(c) === "video") return;
        const prev = portraitImageCache.get(c.id);
        if (prev && prev.src && !portraitUrlsMatch(prev.src, url)) {
            portraitImageCache.delete(c.id);
        }
        if (portraitImageCache.has(c.id)) return;
        const img = new Image();
        img.src = url;
        portraitImageCache.set(c.id, img);
    });
}

// ========== ПОРТРЕТЫ ДЛЯ ИГРОКОВ ==========
let portraitsContainer = document.getElementById('portrait-list');
let portraitSidebar = document.getElementById('portrait-sidebar');
let lastCharactersHash = ''; // Для отслеживания изменений
/** Последняя карта, для которой подтянули полные данные — смена сбрасывает кэш портретов */
let playerLastSyncedMapId = null;
let updateTimeout = null;

// Функция для создания хеша персонажей (чтобы определять реальные изменения)
function getCharactersHash(characters) {
    if (!characters || characters.length === 0) return '';
    return characters
        .filter(char => char.visible_to_players !== false)
        .map(char => `${char.id}-${char.name}-${char.visible_to_players}-${char.portrait_url || ''}-${inferPortraitMedia(char)}`)
        .join('|');
}

function applyTokenUpdates() {
    if (pendingTokenUpdates.size > 0 && mapData && mapData.tokens) {
        for (const [tokenId, update] of pendingTokenUpdates) {
            const token = mapData.tokens.find(t => t.id === tokenId);
            if (token && update.position) {
                token.position = update.position;
            }
        }
        pendingTokenUpdates.clear();
        requestRender();
    }
    tokenUpdateTimeout = null;
}

// Функция для определения конфигурации сетки
function getGridConfig(count) {
    if (count <= 2) {
        // 1 колонка, rows = count
        return { cols: 1, rows: count };
    } else if (count <= 4) {
        // 2 колонки, rows = ceil(count/2)
        return { cols: 2, rows: Math.ceil(count / 2) };
    } else if (count <= 6) {
        // Для 5-6: 2 колонки, 3 строки (2×3)
        return { cols: 2, rows: 3 };
    } else if (count <= 8) {
        // Для 7-8: 2 колонки, 4 строки (2×4)
        return { cols: 2, rows: 4 };
    } else if (count <= 9) {
        // Для 9: 3 колонки, 3 строки (3×3)
        return { cols: 3, rows: 3 };
    } else if (count <= 12) {
        // Для 10-12: 3 колонки, 4 строки (3×4)
        return { cols: 3, rows: 4 };
    } else {
        // Для большего количества: 4 колонки, rows = ceil(count/4)
        return { cols: 4, rows: Math.ceil(count / 4) };
    }
}

// Функция для обновления портретов
function updatePortraits() {
    // Отменяем предыдущий запланированный вызов
    if (updateTimeout) {
        clearTimeout(updateTimeout);
    }

    // Планируем обновление в следующем кадре анимации
    updateTimeout = setTimeout(() => {
        performUpdatePortraits();
        updateTimeout = null;
    }, 10);
}


let resizeTimeout;
const resizeObserver = new ResizeObserver(() => {
    if (resizeTimeout) {
        clearTimeout(resizeTimeout);
    }
    resizeTimeout = setTimeout(() => {
        if (mapData && mapData.characters) {
            // Проверяем видимость карты при ресайзе
            const isMapEnabled = mapData.player_map_enabled !== false;
            const visibleCharacters = mapData.characters.filter(char => char.visible_to_players !== false);
            if (isMapEnabled && visibleCharacters.length > 0) {
                renderPortraits(visibleCharacters);
            }
        }
        resizeTimeout = null;
    }, 180);
});

if (portraitSidebar) {
    resizeObserver.observe(portraitSidebar);
}

// Вызываем updatePortraits при загрузке
document.addEventListener('DOMContentLoaded', () => {
    // Убеждаемся, что контейнер для портретов существует
    portraitsContainer = document.getElementById('portrait-list');
    portraitSidebar = document.getElementById('portrait-sidebar');

    if (!portraitsContainer || !portraitSidebar) {
        console.warn("Portrait elements not found, will retry...");
        // Пробуем снова через небольшую задержку
        setTimeout(() => {
            portraitsContainer = document.getElementById('portrait-list');
            portraitSidebar = document.getElementById('portrait-sidebar');
            if (portraitsContainer && portraitSidebar) {
                updatePortraits();
            }
        }, 500);
    }
});

const socket = window.createDndSocket({ auth: { role: 'player' } });
let fetchGeneration = 0;

function performUpdatePortraits() {
    if (!mapData || !portraitsContainer || !portraitSidebar) {
        return;
    }

    const isMapEnabled = mapData.player_map_enabled !== false;
    const visibleCharacters = (mapData.characters || []).filter(char => char.visible_to_players !== false);
    const count = visibleCharacters.length;

    const newHash = getCharactersHash(visibleCharacters);
    const shouldBeVisible = isMapEnabled && count > 0;

    if (newHash === lastCharactersHash && portraitSidebar.classList.contains('visible') === shouldBeVisible) {
        return;
    }

    lastCharactersHash = newHash;

    if (shouldBeVisible) {
        portraitSidebar.classList.add('visible');
        // Два rAF: после flex + min-height полосы у стабильного clientHeight (мобильный Chrome).
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                renderPortraits(visibleCharacters);
                requestRender();
            });
        });
    } else {
        portraitSidebar.classList.remove('visible');
        portraitsContainer.innerHTML = '';
        requestAnimationFrame(() => {
            requestRender();
        });
    }
}

/**
 * Резерв под табличку имени (margin + padding + строка текста + border).
 * Должен быть ≥ фактической высоте .portrait-nameplate в player-theme.css.
 */
const PORTRAIT_NAME_BLOCK_PX = 48;
/** Запас по высоте списка, чтобы нижний ряд не обрезался из‑за округлений и скролла */
const PORTRAIT_LIST_HEIGHT_BUFFER_PX = 10;

function renderPortraits(characters) {
    if (!portraitsContainer || !portraitSidebar) return;

    const count = characters.length;
    const sidebarHeight = portraitSidebar.clientHeight;
    const sidebarWidth = portraitSidebar.clientWidth;

    if (sidebarHeight === 0 || sidebarWidth === 0) {
        setTimeout(() => renderPortraits(characters), 50);
        return;
    }

    // Определяем конфигурацию сетки
    const gridConfig = getGridConfig(count);
    const mobile = isPlayerMobileLayout();
    let cols = gridConfig.cols;
    let rows = gridConfig.rows;
    /* Узкий сайдбар справа: одна колонка, прокрутка по вертикали (не полоса снизу) */
    if (mobile && !isMiniMap && count > 0) {
        cols = 1;
        rows = count;
    }

    const sidebarStyle = window.getComputedStyle(portraitSidebar);
    const padY =
        (parseFloat(sidebarStyle.paddingTop) || 0) + (parseFloat(sidebarStyle.paddingBottom) || 0);
    const listStyle = window.getComputedStyle(portraitsContainer);
    const listPadY =
        (parseFloat(listStyle.paddingTop) || 0) + (parseFloat(listStyle.paddingBottom) || 0);

    const headerHeight = isMiniMap ? 20 : 0;
    let availableHeight =
        sidebarHeight - padY - listPadY - headerHeight - PORTRAIT_LIST_HEIGHT_BUFFER_PX;

    const listInnerH = portraitsContainer.clientHeight - listPadY;
    if (listInnerH > 0) {
        availableHeight = Math.min(
            availableHeight,
            listInnerH - PORTRAIT_LIST_HEIGHT_BUFFER_PX
        );
    }

    availableHeight = Math.max(40, availableHeight);

    let gapSize = isMiniMap ? 2 : 6;
    if (!isMiniMap && count >= 3 && count <= 6 && !mobile) {
        gapSize = 12;
    }
    if (mobile && !isMiniMap) {
        gapSize = 10;
    }

    const padding = isMiniMap ? 10 : mobile ? 24 : 16;
    const availableWidth = sidebarWidth - padding;

    const totalGapHeight = (rows - 1) * gapSize;
    const nameBlock = isMiniMap ? 0 : PORTRAIT_NAME_BLOCK_PX;
    const availableForPortraits = availableHeight - totalGapHeight - rows * nameBlock;

    let portraitHeight =
        mobile && !isMiniMap && count > 0
            ? Math.max(52, Math.floor(availableWidth * 0.92))
            : Math.floor(availableForPortraits / rows);

    let maxPortraitSize;

    if (isMiniMap) {
        if (count === 1) maxPortraitSize = 100;
        else if (count === 2) maxPortraitSize = 85;
        else if (count <= 4) maxPortraitSize = 70;
        else if (count <= 6) maxPortraitSize = 60;
        else if (count <= 8) maxPortraitSize = 50;
        else maxPortraitSize = 45;
    } else {
        if (count === 1) maxPortraitSize = 520;
        else if (count === 2) maxPortraitSize = 336;
        else if (count <= 4) maxPortraitSize = 220;
        else if (count <= 6) maxPortraitSize = 175;
        else if (count <= 8) maxPortraitSize = 160;
        else maxPortraitSize = 150;
    }

    portraitHeight = Math.min(maxPortraitSize, portraitHeight);
    portraitHeight = Math.max(isMiniMap ? 35 : 44, portraitHeight);

    const totalGapWidth = (cols - 1) * gapSize;
    const columnWidth = (availableWidth - totalGapWidth) / cols;

    let finalPortraitSize;
    if (mobile && !isMiniMap) {
        const vh = window.visualViewport?.height ?? window.innerHeight;
        const vw = window.visualViewport?.width ?? window.innerWidth;
        const wBudget =
            count > 0
                ? Math.floor((availableWidth - (cols - 1) * gapSize) / cols)
                : 80;
        const softCap = Math.min(168, Math.round(Math.min(vw, vh) * 0.26));
        const mobS = Math.min(wBudget, softCap, portraitHeight);
        finalPortraitSize = Math.max(44, mobS);
    } else {
        finalPortraitSize = Math.min(portraitHeight, columnWidth);
        finalPortraitSize = Math.max(isMiniMap ? 30 : 44, finalPortraitSize);
    }

    if (isMiniMap) {
        const maxAllowedWidth = (sidebarWidth - padding) / cols;
        if (finalPortraitSize > maxAllowedWidth) {
            finalPortraitSize = maxAllowedWidth - 2;
        }
    } else if (!mobile) {
        const minPortrait = 32;
        const fitHeight = Math.max(0, availableHeight - 4);
        const gridTotalH = () => rows * (finalPortraitSize + nameBlock) + (rows - 1) * gapSize;
        let h = gridTotalH();
        while (h > fitHeight && finalPortraitSize > minPortrait) {
            finalPortraitSize -= 1;
            h = gridTotalH();
        }
        const minGap = !isMiniMap && count >= 3 && count <= 6 ? 8 : 2;
        while (h > fitHeight && gapSize > minGap) {
            gapSize -= 1;
            h = gridTotalH();
        }
        while (h > fitHeight && finalPortraitSize > minPortrait) {
            finalPortraitSize -= 1;
            h = gridTotalH();
        }
        const tgw = (cols - 1) * gapSize;
        const cw = Math.floor((availableWidth - tgw) / cols);
        if (finalPortraitSize > cw) {
            finalPortraitSize = Math.max(minPortrait, cw);
        }
        h = gridTotalH();
        while (h > fitHeight && finalPortraitSize > minPortrait) {
            finalPortraitSize -= 1;
            h = gridTotalH();
        }
    }

    // Очищаем контейнер
    portraitsContainer.innerHTML = '';

    // Создаем сетку с точными размерами
    const gridContainer = document.createElement('div');
    gridContainer.className = 'portrait-grid';
    gridContainer.style.display = 'grid';
    gridContainer.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    gridContainer.style.gap = `${gapSize}px`;
    gridContainer.style.width = '100%';
    gridContainer.style.height = 'auto';
    gridContainer.style.maxHeight = mobile && !isMiniMap ? 'none' : '100%';
    gridContainer.style.alignContent = 'start';
    gridContainer.style.padding = '0';
    gridContainer.style.margin = '0';
    gridContainer.style.boxSizing = 'border-box';

    characters.forEach((character, index) => {
        const portraitItem = document.createElement('div');
        portraitItem.className = 'portrait-item';
        portraitItem.style.display = 'flex';
        portraitItem.style.flexDirection = 'column';
        portraitItem.style.alignItems = 'center';
        portraitItem.style.justifyContent = 'flex-start';
        portraitItem.style.width = '100%';
        portraitItem.style.padding = '0';
        portraitItem.style.margin = '0';
        portraitItem.style.boxSizing = 'border-box';

        const card = document.createElement('div');
        card.className = 'portrait-card';
        card.style.width = `${finalPortraitSize}px`;
        card.style.maxWidth = '100%';
        card.style.margin = '0 auto';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.alignItems = 'stretch';
        card.style.boxSizing = 'border-box';

        // Контейнер для аватара
        const avatarContainer = document.createElement('div');
        avatarContainer.style.width = `${finalPortraitSize}px`;
        avatarContainer.style.height = `${finalPortraitSize}px`;
        avatarContainer.style.margin = '0';
        avatarContainer.style.flexShrink = '0';
        avatarContainer.style.position = 'relative';
        avatarContainer.style.overflow = 'hidden';
        avatarContainer.style.boxSizing = 'border-box';
        avatarContainer.classList.add('portrait-avatar-frame');
        if (isMiniMap) {
            avatarContainer.style.borderRadius = '4px';
            avatarContainer.style.backgroundColor = '#1a1410';
        } else {
            avatarContainer.style.borderRadius = '';
            avatarContainer.style.backgroundColor = '';
        }

        const portraitUrl = character.portrait_url || `/api/portrait/${character.id}`;
        const pMedia = inferPortraitMedia(character);
        let avatar;

        if (pMedia === "video") {
            avatar = document.createElement("video");
            avatar.className = "portrait-avatar";
            avatar.style.width = "100%";
            avatar.style.height = "100%";
            avatar.style.objectFit = "cover";
            avatar.style.display = "block";
            avatar.muted = true;
            avatar.loop = true;
            avatar.autoplay = true;
            avatar.playsInline = true;
            avatar.setAttribute("playsinline", "");
            avatar.src = portraitUrl;
            void avatar.play().catch(() => {});
        } else {
            avatar = document.createElement("img");
            avatar.className = "portrait-avatar";
            avatar.style.width = "100%";
            avatar.style.height = "100%";
            avatar.style.objectFit = "cover";
            avatar.style.display = "block";
            avatar.alt = "";

            const cached = portraitImageCache.get(character.id);
            // GIF: всегда грузим в этот <img> с актуального URL — иначе после смены PNG→GIF
            // или из‑за preload остаётся первый кадр / старый файл. Animated GIF + transition:all в CSS тоже ломают кадры в части браузеров.
            const reusePreload =
                pMedia !== "gif" &&
                cached &&
                cached.tagName === "IMG" &&
                cached.complete &&
                cached.naturalWidth > 0 &&
                portraitUrlsMatch(cached.src, portraitUrl);
            if (reusePreload) {
                avatar.src = cached.src;
                avatar.style.opacity = "1";
            } else {
                avatar.src = portraitUrl;
                avatar.style.opacity = "1";
                avatar.onload = () => {
                    portraitImageCache.set(character.id, avatar);
                };
            }
        }

        avatar.onerror = () => {
            avatar.style.display = "none";
            avatarContainer.style.display = "flex";
            avatarContainer.style.alignItems = "center";
            avatarContainer.style.justifyContent = "center";
            avatarContainer.innerHTML = `<span style="color: #666; font-size: ${finalPortraitSize / 2}px;">?</span>`;
        };

        avatarContainer.appendChild(avatar);
        card.appendChild(avatarContainer);

        // Добавляем имя ТОЛЬКО для полноэкранного режима
        if (!isMiniMap) {
            const nameSpan = document.createElement('span');
            nameSpan.className = 'portrait-name portrait-nameplate';
            nameSpan.textContent = character.name;
            nameSpan.style.flexShrink = '0';
            nameSpan.style.textAlign = 'center';
            nameSpan.style.overflow = 'hidden';
            nameSpan.style.textOverflow = 'ellipsis';
            nameSpan.style.whiteSpace = 'nowrap';

            card.appendChild(nameSpan);
        }

        portraitItem.appendChild(card);
        gridContainer.appendChild(portraitItem);
    });

    portraitsContainer.appendChild(gridContainer);

    // После рендеринга портретов перерендериваем карту
    requestRender();
}
function requestRender() {
    if (!renderRequested) {
        renderRequested = true;
        requestAnimationFrame(() => {
            render();
            updatePlayerInitiativeStrip();
            renderRequested = false;
        });
    }
}




// Получаем map_id
let mapId = window.MAP_ID || null;

// Иногда шаблон рендерит строкой "None"/"null". Нормализуем в null,
// чтобы не делать запрос /api/map/None.
if (
    mapId === "None" ||
    mapId === "null" ||
    mapId === "undefined" ||
    mapId === ""
) {
    mapId = null;
}



const urlParams = new URLSearchParams(window.location.search);
const playerExplicitNoMap =
    urlParams.get("no_map") === "1" ||
    urlParams.get("no_map") === "true";

if (!mapId) {
    mapId = urlParams.get("map_id");
}

if (!mapId && !playerExplicitNoMap) {
    const fromParent = readParentMasterMapId();
    if (fromParent) mapId = fromParent;
}

if (
    mapId === "None" ||
    mapId === "null" ||
    mapId === "undefined" ||
    mapId === ""
) {
    mapId = null;
}

let playerMapBootStarted = false;

function beginMapLoadForPlayer() {
    if (mapId) {
        mapImage = new Image();
        fetchMap();
    } else {
        resizeCanvasToDisplaySize();
        const { lw, lh } = playerCanvasBeginFrame();
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Карта не выбрана", lw / 2, lh / 2);
        if (playerExplicitNoMap || isMiniMap) {
            // остаёмся без mapId
        } else {
            fetch("/api/maps")
                .then(res => res.json())
                .then(maps => {
                    if (!maps || maps.length === 0) return;
                    mapId = maps[0].id;
                    window.playerMapId = mapId;
                    if (socket && socket.connected) {
                        socket.emit("join_map", { map_id: mapId });
                        socket.emit("request_drawings", { map_id: mapId });
                        socket.emit("request_map_sync", { map_id: mapId });
                    }
                    fetchMap();
                })
                .catch(() => {});
        }
    }
}

function ensurePlayerMapBootStarted() {
    if (playerMapBootStarted || isMiniMap) return;
    playerMapBootStarted = true;
    preloadAllAssets();
    beginMapLoadForPlayer();
}

function applyPlayerMasterGate(absent) {
    if (isMiniMap) return;
    const gate = document.getElementById("player-master-absent");
    const main = document.getElementById("main");
    if (absent) {
        if (gate) gate.style.display = "flex";
        if (main) main.style.visibility = "hidden";
        hideLoadingOverlay();
    } else {
        if (gate) gate.style.display = "none";
        if (main) main.style.visibility = "";
        ensurePlayerMapBootStarted();
    }
}

function pollMasterPresence() {
    if (isMiniMap) return;
    fetch("/api/master/status")
        .then(r => r.json())
        .then(data => {
            const active = !!(data && data.active);
            applyPlayerMasterGate(!active);
        })
        .catch(() => {});
}

document.addEventListener("visibilitychange", () => {
    if (isMiniMap || document.visibilityState !== "visible") return;
    pollMasterPresence();
});

socket.on('connect', () => {
    if (mapId) {
        socket.emit('join_map', { map_id: mapId });
        socket.emit('request_drawings', { map_id: mapId });
        socket.emit('request_map_sync', { map_id: mapId });
    }
    pollMasterPresence();
});

let masterCanvasWidth = 1380;
let masterCanvasHeight = 1080;

window.playerMapId = mapId;

if (isMiniMap) {
    dndCache.init();
    beginMapLoadForPlayer();
} else {
    const initial =
        typeof window.__DND_INITIAL_MASTER_ACTIVE__ === "boolean"
            ? window.__DND_INITIAL_MASTER_ACTIVE__
            : false;
    applyPlayerMasterGate(!initial);
    pollMasterPresence();
    setInterval(pollMasterPresence, 3000);
}

function resizeCanvasToDisplaySize() {
    const { w, h } = getPlayerCanvasCssPixels();
    const dpr = measurePlayerCanvasDevicePixelRatio();
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw || canvas.height !== bh || playerCanvasDpr !== dpr) {
        playerCanvasDpr = dpr;
        canvas.width = bw;
        canvas.height = bh;
        requestRender();
        setTimeout(updatePortraits, 100);
    }
}

window.addEventListener("resize", () => {
    resizeCanvasToDisplaySize();
});

socket.on("map_updated", (data) => {
    if (!data || data.map_id !== mapId) return;

    if (!mapData) {
        mapData = {};
    }

    if (playerLastSyncedMapId !== data.map_id) {
        portraitImageCache.clear();
        lastCharactersHash = '';
        playerLastSyncedMapId = data.map_id;
    }

    const oldHasImage = mapData.has_image;
    const oldCharacters = mapData.characters || [];

    invalidateZoneBlurCache();
    const mergedCharacters = Object.prototype.hasOwnProperty.call(data, "characters")
        ? (data.characters || [])
        : oldCharacters;

    Object.assign(mapData, {
        tokens: data.tokens || [],
        zones: data.zones || [],
        fog_walls: data.fog_walls !== undefined ? data.fog_walls : (mapData.fog_walls || []),
        finds: data.finds || [],
        characters: mergedCharacters,
        grid_settings: data.grid_settings || mapData.grid_settings,
        ruler_visible_to_players: data.ruler_visible_to_players,
        ruler_start: data.ruler_start,
        ruler_end: data.ruler_end,
        player_map_enabled: data.player_map_enabled !== undefined ? data.player_map_enabled : true,
        has_image: data.has_image || false,
        master_canvas_width: data.master_canvas_width,
        master_canvas_height: data.master_canvas_height,
        combat: data.combat !== undefined ? data.combat : mapData.combat,
        player_visibility_mode: data.player_visibility_mode !== undefined
            ? data.player_visibility_mode
            : (mapData.player_visibility_mode || "zones"),
        fog_of_war_radius_cells: data.fog_of_war_radius_cells !== undefined
            ? data.fog_of_war_radius_cells
            : (mapData.fog_of_war_radius_cells ?? 4),
        fog_of_war_explored: data.fog_of_war_explored !== undefined
            ? data.fog_of_war_explored
            : (mapData.fog_of_war_explored || []),
    });

    if (data.fog_walls !== undefined) {
        invalidatePlayerFogWallSegmentCache();
    }

    clearPlayerFogLiveTrail();

    preloadPortraits(mapData.characters);

    if (data.master_canvas_width) {
        masterCanvasWidth = data.master_canvas_width;
    }
    if (data.master_canvas_height) {
        masterCanvasHeight = data.master_canvas_height;
    }

    const disabledImg = document.getElementById("mapDisabledImage");
    if (disabledImg) {
        disabledImg.style.display = mapData.player_map_enabled ? "none" : "block";
    }

    if (!mapData.player_map_enabled) {
        canvas.style.display = "none";
    } else {
        canvas.style.display = "block";
    }

    if (mapData.has_image) {
        const imageUrl = data.image_url || `/api/map/image/${mapId}`;
        let needsReload =
            !oldHasImage ||
            !mapImage ||
            !mapImage.complete ||
            mapImage.naturalWidth === 0;
        if (!needsReload && data.image_url) {
            needsReload =
                resolvedPlayerUrl(data.image_url) !== resolvedPlayerUrl(mapImage.src);
        }
        if (needsReload) {
            const memCached = mapImageCache.get(mapId);
            if (memCached && memCached.complete && memCached.naturalWidth > 0) {
                mapImage = memCached;
                requestRender();
            } else {
                // Пробуем dndCache (Cache API + memory)
                const blobUrl = dndCache.get(imageUrl);
                if (blobUrl) {
                    const img = new Image();
                    img.onload = () => { mapImage = img; mapImageCache.set(mapId, img); requestRender(); };
                    img.src = blobUrl;
                } else {
                    // Загружаем через dndCache (скачает и закеширует)
                    dndCache.fetch(imageUrl).then(src => {
                        const img = new Image();
                        img.onload = () => { mapImage = img; mapImageCache.set(mapId, img); requestRender(); };
                        img.src = src || imageUrl;
                    });
                }
            }
        }
    } else {
        mapImage = new Image();
        requestRender();
    }

    requestRender();
    updatePortraits();
});

socket.on("token_synced_across_maps", (data) => {
    if (!data || !mapData || !mapData.tokens) return;
    const { token_id, updated_data } = data;
    const token = mapData.tokens.find(
        (t) => String(t.id) === String(token_id)
    );
    if (token && updated_data) {
        Object.assign(token, updated_data);
        requestRender();
    }
});

socket.on("ruler_update", (data) => {


    if (data.map_id === mapId && mapData) {
        if (!window.rulerUpdateThrottle) {
            window.rulerUpdateThrottle = setTimeout(() => {
                mapData.ruler_start = data.ruler_start;
                mapData.ruler_end = data.ruler_end;

                if (mapData.ruler_visible_to_players) {
                    requestRender();
                }

                window.rulerUpdateThrottle = null;
            }, 16);
        }
    }
});

socket.on("ruler_visibility_change", (data) => {


    if (data.map_id === mapId && mapData) {
        mapData.ruler_visible_to_players = data.ruler_visible_to_players;

        requestRender();
    }
});

socket.on("zoom_update", (data) => {
    if (data.map_id === mapId && mapData) {
        zoomLevel = data.zoom_level || 1;
        panX = data.pan_x ?? 0;
        panY = data.pan_y ?? 0;

        if (data.canvas_width) {
            masterCanvasWidth = data.canvas_width;
        }
        if (data.canvas_height) {
            masterCanvasHeight = data.canvas_height;
        }

        // ВАЖНО: сохраняем размеры канваса мастера
        if (mapData) {
            mapData.master_canvas_width = data.canvas_width;
            mapData.master_canvas_height = data.canvas_height;
        }

        requestRender();
    }
});

socket.on("map_created", (data) => {
    if (data.map_id) {
        mapId = data.map_id;
        window.playerMapId = mapId;
        if (socket && socket.connected) {
            socket.emit("join_map", { map_id: mapId });
            socket.emit("request_map_data", { map_id: mapId });
            socket.emit("request_drawings", { map_id: mapId });
            socket.emit("request_map_sync", { map_id: mapId });
        } else {
            fetchMap();
        }
    }
});

socket.on("master_switched_map", (data) => {
    if (data.map_id && mapId !== data.map_id) {
        mapId = data.map_id;
        window.playerMapId = data.map_id;

        portraitImageCache.clear();
        lastCharactersHash = '';

        // Если карта уже в кеше — берём сразу, иначе начинаем загрузку
        if (!mapImageCache.has(mapId) && data.image_url) {
            dndCache.fetch(data.image_url).then(blobUrl => {
                _storeInMapImageCache(mapId, blobUrl);
            });
        }

        mapImage = new Image();

        const url = new URL(window.location);
        url.searchParams.set('map_id', data.map_id);
        window.history.replaceState({}, '', url);

        if (socket && socket.connected) {
            socket.emit("join_map", { map_id: mapId });
            socket.emit("request_map_data", { map_id: mapId });
            socket.emit("request_drawings", { map_id: mapId });
            socket.emit("request_map_sync", { map_id: mapId });
        } else {
            fetchMap();
        }
    } else if (!data.map_id) {
        mapId = null;
        window.playerMapId = null;
        mapData = null;
        invalidatePlayerFogWallSegmentCache();
        requestRender();
        updatePortraits(); // Обновляем портреты при смене карты
    }
});

function render() {
    resizeCanvasToDisplaySize();

    // 1. Базовые проверки
    if (!mapId || !mapData) {
        const { lw, lh } = playerCanvasBeginFrame();
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Карта не выбрана", lw / 2, lh / 2);
        return;
    }

    // 2. Проверка видимости карты
    if (mapData.player_map_enabled === false) {
        const disabledImg = document.getElementById("mapDisabledImage");
        if (disabledImg) disabledImg.style.display = "block";
        canvas.style.display = "none";
        return;
    } else {
        const disabledImg = document.getElementById("mapDisabledImage");
        if (disabledImg) disabledImg.style.display = "none";
        canvas.style.display = "block";
    }

    // 3. Принудительно устанавливаем стили canvas
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.backgroundColor = 'transparent';

    const { lw, lh } = playerCanvasBeginFrame();

    if (!mapData.has_image) {
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Нет изображения карты", lw / 2, lh / 2);
        return;
    }

    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) {
        if (!mapImage.src || !mapImage.src.includes(mapId)) {
            const imageUrl = `/api/map/image/${mapId}`;
            mapImage = new Image();
            mapImage.onload = () => requestRender();
            mapImage.src = imageUrl;
        }
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Загрузка карты...", lw / 2, lh / 2);
        return;
    }

    // 5. Размеры карты в мировых координатах (как у вершин зон) — только natural*
    const mapW = mapImage.naturalWidth || mapImage.width;
    const mapH = mapImage.naturalHeight || mapImage.height;

    // 6. Вычисляем масштаб для игрока (логические пиксели вида)
    const playerBaseScale = Math.min(lw / mapW, lh / mapH);
    const playerScale = playerBaseScale * zoomLevel;

    // 7. Центрируем карту на экране игрока
    const masterScale = Math.min(masterCanvasWidth / mapW, masterCanvasHeight / mapH) * zoomLevel;
    const worldCenterX = (masterCanvasWidth / 2 - panX) / masterScale;
    const worldCenterY = (masterCanvasHeight / 2 - panY) / masterScale;

    const offsetX = lw / 2 - worldCenterX * playerScale;
    const offsetY = lh / 2 - worldCenterY * playerScale;

    ctx.drawImage(mapImage, offsetX, offsetY, mapW * playerScale, mapH * playerScale);

    if (isPlayerFogOfWarActive()) {
        if (mapData.grid_settings && mapData.grid_settings.visible_to_players === true) {
            drawGrid(offsetX, offsetY, playerScale, lw, lh);
        }
        drawPlayerStrokes(offsetX, offsetY, playerScale);
        drawPlayerFogOfWarOverlay(offsetX, offsetY, playerScale, mapW, mapH);
        drawFogOfWarPlayerTokens(offsetX, offsetY, playerScale);
    } else {
        drawLayers(offsetX, offsetY, playerScale, lw, lh);
    }

    if (mapData.ruler_visible_to_players && mapData.ruler_start && mapData.ruler_end) {
        drawMasterRuler(mapData.ruler_start, mapData.ruler_end, offsetX, offsetY, playerScale, lw, lh);
    }
}
socket.on("map_sync", (data) => {
    if (!data || data.map_id !== mapId) {
        return;
    }

    // Обновляем параметры отображения
    if (data.zoom_level !== undefined) {
        zoomLevel = data.zoom_level;
    }
    if (data.pan_x !== undefined) {
        panX = data.pan_x;
    }
    if (data.pan_y !== undefined) {
        panY = data.pan_y;
    }

    // Сохраняем размеры канваса мастера
    if (data.canvas_width) {
        masterCanvasWidth = data.canvas_width;
    }
    if (data.canvas_height) {
        masterCanvasHeight = data.canvas_height;
    }

    requestRender();
});

function getTokenSizeScale(token) {
    switch (token.size) {
        case 'tiny': return 0.5;
        case 'small':
        case 'medium': return 1.0;
        case 'large': return 2.0;
        case 'huge': return 3.0;
        case 'gargantuan': return 4.0;
        default: return 1.0;
    }
}

/** Крупные рисуются первыми, мелкие последними — мелкие визуально сверху. */
function getTokensSortedForDrawing(tokens) {
    if (!tokens || !tokens.length) return [];
    return tokens.slice().sort((a, b) => getTokenSizeScale(b) - getTokenSizeScale(a));
}

function updatePlayerInitiativeStrip() {
    if (isMiniMap) return;
    const strip = document.getElementById("initiativeStrip");
    if (!strip || !mapData) return;
    const parent = strip.parentElement;
    const combat = mapData.combat;
    const tokens = mapData.tokens || [];

    if (!combat || !combat.active || !Array.isArray(combat.entries) || combat.entries.length === 0) {
        strip.style.display = "none";
        strip.innerHTML = "";
        if (parent) parent.classList.remove("has-initiative-strip");
        return;
    }

    const byId = new Map(tokens.map((t) => [t.id, t]));
    strip.style.display = "flex";
    strip.innerHTML = "";
    if (parent) parent.classList.add("has-initiative-strip");

    for (const ent of combat.entries) {
        const tok = byId.get(ent.id);
        if (!tok) continue;
        const hp = tok.health_points ?? 0;
        const dead = tok.is_dead || hp <= 0;
        if (dead) continue;

        const item = document.createElement("div");
        const typeCls = tok.is_player
            ? "initiative-strip-item--hero"
            : tok.is_npc
                ? "initiative-strip-item--npc"
                : "initiative-strip-item--enemy";
        item.className = `initiative-strip-item ${typeCls}`;
        item.title = tok.name || "Токен";

        if (tok.avatar_url) {
            const img = document.createElement("img");
            img.src = tok.avatar_url;
            img.alt = "";
            item.appendChild(img);
        } else if (tok.has_avatar) {
            const img = document.createElement("img");
            img.src = `/api/token_avatar/${tok.id}`;
            img.alt = "";
            item.appendChild(img);
        } else {
            const ph = document.createElement("div");
            ph.className = "initiative-strip-placeholder";
            ph.textContent = (tok.name || "?").slice(0, 1).toUpperCase();
            item.appendChild(ph);
        }

        strip.appendChild(item);
    }

    if (!strip.childElementCount) {
        strip.style.display = "none";
        strip.innerHTML = "";
        if (parent) parent.classList.remove("has-initiative-strip");
    }
}

function isPlayerFogOfWarActive() {
    return mapData && mapData.player_visibility_mode === "fog_of_war";
}

function playerFogHeroTokens() {
    return (mapData && mapData.tokens ? mapData.tokens : []).filter(
        (t) => t.is_player && t.is_visible !== false && !t.is_dead
    );
}

function getPlayerFogRadiusWorld() {
    const cell = (mapData && mapData.grid_settings && mapData.grid_settings.cell_size) || 20;
    const cells = Number(mapData && mapData.fog_of_war_radius_cells);
    const n = Number.isFinite(cells) ? cells : 4;
    return Math.max(1, n) * cell;
}

function playerFogExploredCenters() {
    const raw = (mapData && mapData.fog_of_war_explored) || [];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        if (Array.isArray(p) && p.length >= 2) {
            out.push([p[0], p[1]]);
        } else if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
            out.push([p.x, p.y]);
        }
    }
    return out;
}

/** Точки по token_move (герой), пока сервер не прислал полный fog_of_war_explored — чтобы след был во время перетаскивания. */
const PLAYER_FOG_LIVE_TRAIL_CAP = 5000;
const _playerFogLiveTrail = [];
const _playerFogLiveTrailLastByToken = new Map();

function clearPlayerFogLiveTrail() {
    _playerFogLiveTrail.length = 0;
    _playerFogLiveTrailLastByToken.clear();
}

function appendPlayerFogLiveTrail(tokenId, wx, wy) {
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    const cs = (mapData && mapData.grid_settings && mapData.grid_settings.cell_size) || 20;
    const minStep = Math.max(cs * 0.02, 0.06);
    const min2 = minStep * minStep;
    const tid = String(tokenId);
    const prev = _playerFogLiveTrailLastByToken.get(tid);
    if (prev) {
        const dx = prev[0] - wx;
        const dy = prev[1] - wy;
        if (dx * dx + dy * dy < min2) return;
    }
    _playerFogLiveTrailLastByToken.set(tid, [wx, wy]);
    _playerFogLiveTrail.push([wx, wy]);
    while (_playerFogLiveTrail.length > PLAYER_FOG_LIVE_TRAIL_CAP) {
        _playerFogLiveTrail.shift();
    }
    requestRender();
}

/** Максимум дыр по живому следу за кадр (пока мастер тянет героя). */
const MAX_FOG_LIVE_TRAIL_PUNCHES = 72;
/**
 * Сколько последних точек живого следа участвуют в отрисовке.
 * Раньше субдискретизация шла по всему массиву (до 5000) — при движении героя набор из 72 точек
 * «перескакивал» по всей карте и визуально перерисовывал старые открытые зоны.
 */
const PLAYER_FOG_LIVE_TRAIL_RENDER_TAIL = 520;

/** Больше шагов — острее углы у стен (меньше щелей на углах из‑за дискретизации лучей). */
const _FOG_WALL_RAY_STEPS = 96;

/** Предвычисление направлений лучей — без cos/sin в горячем цикле. */
const _FOG_RAY_DIRS = (() => {
    const n = _FOG_WALL_RAY_STEPS;
    const c = new Float64Array(n + 1);
    const s = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
        const th = (i / n) * Math.PI * 2;
        c[i] = Math.cos(th);
        s[i] = Math.sin(th);
    }
    return { c, s };
})();

/** Кэш слоя «сохранённый explored» в координатах карты (не зависит от zoom). */
let _fogHistoricSavedCanvas = null;
let _fogHistoricSavedState = {
    mapW: 0,
    mapH: 0,
    cacheScale: 1,
    cw: 0,
    ch: 0,
    rWorld: 0,
};

/** Инкрементальный кэш «сохранённого» тумана: без полной пересборки субдискретизацией (она смещалась при каждом новом пункте). */
let _fogHistGeomKey = "";
let _fogHistPunchedCount = 0;
let _fogHistTrackedFirst = null;

const _FOG_HISTORIC_MAX_PIXELS = 4_500_000;

let _cachedFogWallSegmentsRef = null;
let _cachedFogWallSegments = null;

function getActiveFogWallSegmentsWorld() {
    const wallsArr = mapData && mapData.fog_walls;
    if (_cachedFogWallSegmentsRef === wallsArr && _cachedFogWallSegments) {
        return _cachedFogWallSegments;
    }
    const walls = (wallsArr || []).filter(
        (w) => w.is_visible !== false && w.vertices && w.vertices.length >= 2
    );
    const out = [];
    for (const w of walls) {
        const v = w.vertices;
        const n = v.length;
        const closed = w.closed === true && n >= 3;
        const last = closed ? n : n - 1;
        for (let i = 0; i < last; i++) {
            const a = v[i];
            const b = v[(i + 1) % n];
            out.push([a[0], a[1], b[0], b[1]]);
        }
    }
    _cachedFogWallSegmentsRef = wallsArr;
    _cachedFogWallSegments = out;
    return out;
}

function invalidatePlayerFogHistoricLayer() {
    _fogHistGeomKey = "";
    _fogHistPunchedCount = 0;
    _fogHistTrackedFirst = null;
}

function invalidatePlayerFogWallSegmentCache() {
    _cachedFogWallSegmentsRef = null;
    _cachedFogWallSegments = null;
    invalidatePlayerFogHistoricLayer();
}

/** Квадрат расстояния от точки до отрезка (мир). */
function distPointToSegmentSq(px, py, x1, y1, x2, y2) {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const wx = px - x1;
    const wy = py - y1;
    const c1 = wx * vx + wy * vy;
    if (c1 <= 0) return wx * wx + wy * wy;
    const c2 = vx * vx + vy * vy;
    if (c2 <= c1) {
        const dx = px - x2;
        const dy = py - y2;
        return dx * dx + dy * dy;
    }
    const t = c1 / c2;
    const projx = x1 + t * vx;
    const projy = y1 + t * vy;
    const dx = px - projx;
    const dy = py - projy;
    return dx * dx + dy * dy;
}

/**
 * Сегменты стен, которые могут пересечь диск видимости (cx,cy,r) — остальные не режут лучи длиной r.
 */
function fogWallSegmentsNearDisk(cx, cy, rWorld, segments) {
    if (!segments.length) return segments;
    const r2 = rWorld * rWorld * 1.0001;
    const out = [];
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const d2 = distPointToSegmentSq(cx, cy, s[0], s[1], s[2], s[3]);
        if (d2 <= r2) out.push(s);
    }
    return out;
}

/** Только недавний хвост живого следа — для оверлея (полный след хранится до sync отдельно). */
function playerFogLiveTrailSliceForRender() {
    const t = _playerFogLiveTrail;
    const n = t.length;
    if (n === 0) return t;
    if (n <= PLAYER_FOG_LIVE_TRAIL_RENDER_TAIL) return t;
    return t.slice(n - PLAYER_FOG_LIVE_TRAIL_RENDER_TAIL);
}

/** Равномерная выборка центров для отрисовки тумана (память следа остаётся полной в данных карты). */
function subsampleCentersForFogPunch(centers, maxPoints) {
    const n = centers.length;
    if (n <= maxPoints) return centers;
    const out = [];
    const last = n - 1;
    for (let j = 0; j < maxPoints; j++) {
        const i = Math.floor((j * last) / Math.max(1, maxPoints - 1));
        out.push(centers[i]);
    }
    return out;
}

/** AABB-отсечение: стена вне расширенного коридора герой→токен не может перекрыть LOS. */
function fogWallSegmentsCrossingLosBand(hx, hy, px, py, segments) {
    if (segments.length <= 20) return segments;
    const pad = Math.max(24, Math.hypot(px - hx, py - hy) * 0.02);
    const minx = Math.min(hx, px) - pad;
    const maxx = Math.max(hx, px) + pad;
    const miny = Math.min(hy, py) - pad;
    const maxy = Math.max(hy, py) + pad;
    const out = [];
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const x1 = s[0];
        const y1 = s[1];
        const x2 = s[2];
        const y2 = s[3];
        const sminx = Math.min(x1, x2);
        const smaxx = Math.max(x1, x2);
        const sminy = Math.min(y1, y2);
        const smaxy = Math.max(y1, y2);
        if (smaxx < minx || sminx > maxx || smaxy < miny || sminy > maxy) continue;
        out.push(s);
    }
    return out.length ? out : segments;
}

/**
 * Видна ли точка с любого героя. Тот же луч, что и в fogRayWallHitWorld / прорезании тумана,
 * чтобы не расходиться с отдельной формулой пересечения отрезков (из‑за этого НПС «просвечивали»).
 */
function fogPointVisibleFromAnyHero(wx, wy, heroCenters, segments) {
    if (!segments.length) return true;
    for (let i = 0; i < heroCenters.length; i++) {
        const c = heroCenters[i];
        const hx = c[0];
        const hy = c[1];
        const dx = wx - hx;
        const dy = wy - hy;
        const L = Math.hypot(dx, dy);
        if (L < 1e-9) return true;
        const ux = dx / L;
        const uy = dy / L;
        const segs = fogWallSegmentsCrossingLosBand(hx, hy, wx, wy, segments);
        let blocked = false;
        const margin = Math.max(1e-3, L * 1e-9);
        for (let s = 0; s < segs.length; s++) {
            const hit = fogRayWallHitWorld(hx, hy, ux, uy, L, segs[s]);
            if (hit != null && hit < L - margin) {
                blocked = true;
                break;
            }
        }
        if (!blocked) return true;
    }
    return false;
}

/** Дальность вдоль луча из (ox,oy) с направлением (rdx,rdy) до отрезка в мировых координатах, ≤ maxDist */
function fogRayWallHitWorld(ox, oy, rdx, rdy, maxDist, seg) {
    const [x1, y1, x2, y2] = seg;
    const sdx = x2 - x1;
    const sdy = y2 - y1;
    const det = rdx * sdy - rdy * sdx;
    if (Math.abs(det) < 1e-14) return null;
    const t = ((x1 - ox) * sdy - (y1 - oy) * sdx) / det;
    const u = ((x1 - ox) * rdy - (y1 - oy) * rdx) / det;
    if (t < 1e-6 || t > maxDist + 1e-6) return null;
    if (u < -1e-6 || u > 1 + 1e-6) return null;
    return t;
}

function fogPunchVisibilityPolygon(f, cxWorld, cyWorld, rWorld, scale, segments) {
    const sx = cxWorld * scale;
    const sy = cyWorld * scale;
    const rPx = rWorld * scale;
    if (rPx <= 0) return;
    const localSegs =
        segments.length > 18 ? fogWallSegmentsNearDisk(cxWorld, cyWorld, rWorld, segments) : segments;
    const { c: rc, s: rs } = _FOG_RAY_DIRS;
    const n = _FOG_WALL_RAY_STEPS;
    f.beginPath();
    f.moveTo(sx, sy);
    for (let i = 0; i <= n; i++) {
        const rdx = rc[i];
        const rdy = rs[i];
        let tMax = rPx;
        if (localSegs.length) {
            for (let s = 0; s < localSegs.length; s++) {
                const hw = fogRayWallHitWorld(cxWorld, cyWorld, rdx, rdy, rWorld, localSegs[s]);
                if (hw != null) {
                    const hp = hw * scale;
                    if (hp < tMax) tMax = hp;
                }
            }
        }
        f.lineTo(sx + rdx * tMax, sy + rdy * tMax);
    }
    f.closePath();
    f.fill();
}

function fogWallChecksumSimple(segments) {
    let h = segments.length | 0;
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        h =
            (Math.imul(h, 4099) +
                ((s[0] | 0) + (s[1] | 0) * 3 + (s[2] | 0) * 5 + (s[3] | 0) * 7 + i)) |
            0;
    }
    return h;
}

function fogHistExploredXY(saved, i) {
    const p = saved[i];
    if (!p) return null;
    if (Array.isArray(p) && p.length >= 2) {
        const x = Number(p[0]);
        const y = Number(p[1]);
        return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
    }
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        return [p.x, p.y];
    }
    return null;
}

/** Пересобирает только «сохранённый» explored: новые точки дорисовываются, без субвыборки по всей длине массива. */
function ensureFogHistoricSavedLayer(mapW, mapH, rWorld, wallSegs) {
    const saved = playerFogExploredCenters();
    const n = saved.length;
    const wallCk = fogWallChecksumSimple(wallSegs);

    const area = mapW * mapH;
    let cacheScale = 1;
    if (area > _FOG_HISTORIC_MAX_PIXELS) {
        cacheScale = Math.sqrt(_FOG_HISTORIC_MAX_PIXELS / area);
    }
    const cw = Math.max(1, Math.ceil(mapW * cacheScale));
    const ch = Math.max(1, Math.ceil(mapH * cacheScale));
    const geomKey = `${mapW}|${mapH}|${rWorld}|${cw}|${ch}|${wallCk}|${cacheScale}|r${_FOG_WALL_RAY_STEPS}`;

    if (!_fogHistoricSavedCanvas) {
        _fogHistoricSavedCanvas = document.createElement("canvas");
    }

    let resized = false;
    if (_fogHistoricSavedCanvas.width !== cw || _fogHistoricSavedCanvas.height !== ch) {
        _fogHistoricSavedCanvas.width = cw;
        _fogHistoricSavedCanvas.height = ch;
        resized = true;
    }

    const firstPt = n > 0 ? fogHistExploredXY(saved, 0) : null;
    const firstMoved =
        _fogHistTrackedFirst != null &&
        firstPt != null &&
        (Math.abs(firstPt[0] - _fogHistTrackedFirst[0]) > 0.5 ||
            Math.abs(firstPt[1] - _fogHistTrackedFirst[1]) > 0.5);
    const shrunk = n < _fogHistPunchedCount;
    const geomMismatch = geomKey !== _fogHistGeomKey;

    const needFullRebuild = resized || geomMismatch || firstMoved || shrunk;

    const hf = _fogHistoricSavedCanvas.getContext("2d");
    hf.setTransform(1, 0, 0, 1, 0, 0);

    const punchOne = (cx, cy) => {
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
        if (wallSegs.length) {
            fogPunchVisibilityPolygon(hf, cx, cy, rWorld, cacheScale, wallSegs);
        } else {
            const rPx = rWorld * cacheScale;
            hf.beginPath();
            hf.arc(cx * cacheScale, cy * cacheScale, rPx, 0, Math.PI * 2);
            hf.fill();
        }
    };

    if (needFullRebuild) {
        _fogHistGeomKey = geomKey;
        hf.globalCompositeOperation = "source-over";
        hf.fillStyle = "#000000";
        hf.fillRect(0, 0, cw, ch);
        hf.globalCompositeOperation = "destination-out";
        hf.fillStyle = "#ffffff";
        for (let i = 0; i < n; i++) {
            const pt = fogHistExploredXY(saved, i);
            if (pt) punchOne(pt[0], pt[1]);
        }
        _fogHistPunchedCount = n;
        _fogHistTrackedFirst = firstPt ? [firstPt[0], firstPt[1]] : null;
    } else if (n > _fogHistPunchedCount) {
        hf.globalCompositeOperation = "destination-out";
        hf.fillStyle = "#ffffff";
        for (let i = _fogHistPunchedCount; i < n; i++) {
            const pt = fogHistExploredXY(saved, i);
            if (pt) punchOne(pt[0], pt[1]);
        }
        _fogHistPunchedCount = n;
        if (_fogHistTrackedFirst == null && firstPt) {
            _fogHistTrackedFirst = [firstPt[0], firstPt[1]];
        }
    }

    hf.globalCompositeOperation = "source-over";

    const st = _fogHistoricSavedState;
    st.mapW = mapW;
    st.mapH = mapH;
    st.cacheScale = cacheScale;
    st.cw = cw;
    st.ch = ch;
    st.rWorld = rWorld;
}

function isWorldPointInsideFogCircles(wx, wy, centers, rWorld) {
    const r2 = rWorld * rWorld;
    for (let i = 0; i < centers.length; i++) {
        const c = centers[i];
        const dx = wx - c[0];
        const dy = wy - c[1];
        if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
}

function tokenVisibleUnderFogOfWar(token, heroCenters, wallSegs) {
    if (token.is_visible === false) return false;
    if (token.is_player) return true;
    const r = getPlayerFogRadiusWorld();
    const centers = heroCenters || playerFogHeroTokens().map((t) => t.position);
    if (!centers.length) return false;
    const [wx, wy] = token.position || [0, 0];
    if (!isWorldPointInsideFogCircles(wx, wy, centers, r)) return false;
    const segs = wallSegs != null ? wallSegs : getActiveFogWallSegmentsWorld();
    if (!segs.length) return true;
    return fogPointVisibleFromAnyHero(wx, wy, centers, segs);
}

let _playerFogScratchCanvas = null;

function drawPlayerFogOfWarOverlay(offsetX, offsetY, scale, mapW, mapH) {
    const rWorld = getPlayerFogRadiusWorld();
    const heroes = playerFogHeroTokens();
    const mx = mapW * scale;
    const my = mapH * scale;
    const W = Math.max(1, Math.ceil(mx));
    const H = Math.max(1, Math.ceil(my));
    if (!_playerFogScratchCanvas) {
        _playerFogScratchCanvas = document.createElement("canvas");
    }
    if (_playerFogScratchCanvas.width !== W || _playerFogScratchCanvas.height !== H) {
        _playerFogScratchCanvas.width = W;
        _playerFogScratchCanvas.height = H;
    }
    const f = _playerFogScratchCanvas.getContext("2d");
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.clearRect(0, 0, W, H);

    const rPx = rWorld * scale;
    const wallSegs = getActiveFogWallSegmentsWorld();

    ensureFogHistoricSavedLayer(mapW, mapH, rWorld, wallSegs);
    const hist = _fogHistoricSavedState;
    f.save();
    f.imageSmoothingEnabled = false;
    f.drawImage(_fogHistoricSavedCanvas, 0, 0, hist.cw, hist.ch, 0, 0, W, H);
    f.restore();

    if (_playerFogLiveTrail.length && rPx > 0) {
        f.globalCompositeOperation = "destination-out";
        f.fillStyle = "#ffffff";
        const liveTail = playerFogLiveTrailSliceForRender();
        const livePunch = subsampleCentersForFogPunch(liveTail, MAX_FOG_LIVE_TRAIL_PUNCHES);
        for (let i = 0; i < livePunch.length; i++) {
            const [cx, cy] = livePunch[i];
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
            if (wallSegs.length) {
                fogPunchVisibilityPolygon(f, cx, cy, rWorld, scale, wallSegs);
            } else {
                f.beginPath();
                f.arc(cx * scale, cy * scale, rPx, 0, Math.PI * 2);
                f.fill();
            }
        }
        f.globalCompositeOperation = "source-over";
    }

    f.fillStyle = "rgba(0, 0, 0, 0.55)";
    f.fillRect(0, 0, W, H);

    if (heroes.length && rPx > 0) {
        f.globalCompositeOperation = "destination-out";
        f.fillStyle = "#ffffff";
        for (let i = 0; i < heroes.length; i++) {
            const t = heroes[i];
            const [cx, cy] = t.position;
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
            if (wallSegs.length) {
                fogPunchVisibilityPolygon(f, cx, cy, rWorld, scale, wallSegs);
            } else {
                f.beginPath();
                f.arc(cx * scale, cy * scale, rPx, 0, Math.PI * 2);
                f.fill();
            }
        }
        f.globalCompositeOperation = "source-over";
    }

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(_playerFogScratchCanvas, offsetX, offsetY, mx, my);
    ctx.restore();
}

function drawFogOfWarPlayerTokens(offsetX, offsetY, scale) {
    if (!mapData.tokens || !mapData.tokens.length) return;
    const heroCenters = playerFogHeroTokens().map((t) => t.position);
    const wallSegs = getActiveFogWallSegmentsWorld();
    const visible = mapData.tokens.filter((token) =>
        tokenVisibleUnderFogOfWar(token, heroCenters, wallSegs)
    );
    for (const token of getTokensSortedForDrawing(visible)) {
        drawToken(token, offsetX, offsetY, scale);
    }
}

function drawLayers(offsetX, offsetY, scale, lw, lh) {
    const imageLoaded = mapImage && mapImage.complete && mapImage.naturalWidth > 0;

    if (imageLoaded &&
        mapData.grid_settings &&
        mapData.grid_settings.visible_to_players === true) {
        drawGrid(offsetX, offsetY, scale, lw, lh);
    }

    // Рисуем рисунки мастера - ЭТУ СТРОКУ НУЖНО ДОБАВИТЬ
    drawPlayerStrokes(offsetX, offsetY, scale);

    const hiddenZones = (mapData.zones || []).filter(
        (z) => z.is_visible === false && z.vertices && z.vertices.length >= 3
    );
    if (hiddenZones.length) {
        drawUnionBlurredHiddenZones(hiddenZones, offsetX, offsetY, scale);
    }

    if (mapData.tokens && mapData.tokens.length) {
        const visible = mapData.tokens.filter((token) => {
            if (token.is_visible === false) return false;
            return !isPointInAnyZone(token.position, mapData.zones);
        });
        for (const token of getTokensSortedForDrawing(visible)) {
            drawToken(token, offsetX, offsetY, scale);
        }
    }
}

function drawGrid(offsetX, offsetY, scale, lw, lh) {
    // Получаем количество клеток из настроек
    let cellsCount = mapData.grid_settings.cell_count || 20; // По умолчанию 20 клеток

    // Проверяем границы
    if (cellsCount < 5) cellsCount = 5;
    if (cellsCount > 150) cellsCount = 150;

    // Рассчитываем размер клетки в пикселях на карте
    const cellSizeInPixels = mapImage.naturalWidth / cellsCount;

    ctx.strokeStyle = mapData.grid_settings.color || "#888";
    ctx.lineWidth = 1;

    const mw = mapImage.naturalWidth || mapImage.width;
    const mh = mapImage.naturalHeight || mapImage.height;
    const mapScreenWidth = mw * scale;
    const mapScreenHeight = mh * scale;

    const mapLeft = offsetX;
    const mapRight = offsetX + mapScreenWidth;
    const mapTop = offsetY;
    const mapBottom = offsetY + mapScreenHeight;

    ctx.save();
    ctx.beginPath();
    ctx.rect(mapLeft, mapTop, mapScreenWidth, mapScreenHeight);
    ctx.clip();

    ctx.beginPath();

    // Рисуем вертикальные линии - их количество = cellsCount
    for (let i = 0; i <= cellsCount; i++) {
        const x = i * cellSizeInPixels; // Позиция в пикселях на карте
        const sx = offsetX + x * scale;
        if (sx < 0 || sx > lw) continue;

        ctx.moveTo(sx, Math.max(mapTop, 0));
        ctx.lineTo(sx, Math.min(mapBottom, lh));
    }

    // Рисуем горизонтальные линии - их количество = cellsCount * (высота/ширина)
    const aspectRatio = mapImage.naturalHeight / mapImage.naturalWidth;
    const horizontalCells = Math.round(cellsCount * aspectRatio);

    for (let i = 0; i <= horizontalCells; i++) {
        const y = i * cellSizeInPixels; // Позиция в пикселях на карте
        const sy = offsetY + y * scale;
        if (sy < 0 || sy > lh) continue;

        ctx.moveTo(Math.max(mapLeft, 0), sy);
        ctx.lineTo(Math.min(mapRight, lw), sy);
    }

    ctx.stroke();
    ctx.restore();
}

function drawToken(token, offsetX, offsetY, scale) {
    const [x, y] = token.position;
    const sx = x * scale + offsetX;
    const sy = y * scale + offsetY;

    const cellSize = mapData.grid_settings.cell_size * scale;
    const sizeScale = getTokenSizeScale(token);
    const tokenSize = cellSize * sizeScale;
    const radius = tokenSize / 2;

    const avatarSrc = token.avatar_url || token.avatar_data;
    const cachedImg = avatarCache.get(token.id);

    if (avatarSrc) {
        if (cachedImg === 'loading') {
            return;
        }
        if (!avatarCache.has(token.id)) {
            avatarCache.set(token.id, 'loading');

            const img = new Image();
            img.onload = () => {
                avatarCache.set(token.id, img);
                requestRender();
            };
            img.onerror = () => {
                avatarCache.set(token.id, null);
                requestRender();
            };
            // URL уже может содержать версию (?v=...), не добавляем Date.now().
            img.src = avatarSrc;
            return;
        }
    }

    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, 2 * Math.PI);

    if (avatarSrc) {
        if (cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0) {
            ctx.save();
            ctx.clip();

            // ===== УПРАВЛЕНИЕ СГЛАЖИВАНИЕМ =====
            if (TOKEN_SMOOTHING_ENABLED) {
                // Включаем сглаживание для плавности
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
            } else {
                // Отключаем сглаживание для четкости
                ctx.imageSmoothingEnabled = false;
            }

            if (token.is_dead) {
                ctx.globalAlpha = 0.7;
                ctx.filter = 'grayscale(100%)';
                ctx.drawImage(cachedImg, sx - radius, sy - radius, tokenSize, tokenSize);
                ctx.filter = 'none';
                ctx.globalAlpha = 1;
            } else {
                ctx.drawImage(cachedImg, sx - radius, sy - radius, tokenSize, tokenSize);
            }

            ctx.restore();
        } else {
            ctx.fillStyle = token.is_dead
                ? "#616161"
                : token.is_player
                    ? "#4CAF50"
                    : token.is_npc
                        ? "#FFC107"
                        : "#F44336";
            ctx.fill();
        }
    } else {
        ctx.fillStyle = token.is_dead
            ? "#616161"
            : token.is_player
                ? "#4CAF50"
                : token.is_npc
                    ? "#FFC107"
                    : "#F44336";
        ctx.fill();
    }

    ctx.strokeStyle = token.is_dead
        ? "#999"
        : token.is_player
            ? "#4CAF50"
            : token.is_npc
                ? "#FFC107"
                : "#F44336";
    ctx.lineWidth = 4;
    ctx.stroke();
}

function drawMasterRuler(start, end, offsetX, offsetY, scale, lw, lh) {
    if (!start || !end) return;

    const [x1, y1] = start;
    const [x2, y2] = end;

    const sx1 = x1 * scale + offsetX;
    const sy1 = y1 * scale + offsetY;
    const sx2 = x2 * scale + offsetX;
    const sy2 = y2 * scale + offsetY;

    const minX = Math.min(sx1, sx2);
    const maxX = Math.max(sx1, sx2);
    const minY = Math.min(sy1, sy2);
    const maxY = Math.max(sy1, sy2);

    if (maxX < 0 || minX > lw || maxY < 0 || minY > lh) {
        return;
    }

    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.lineTo(sx2, sy2);
    ctx.strokeStyle = "#c82a2aff";
    ctx.lineWidth = 4;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const dx = (x2 - x1);
    const dy = (y2 - y1);
    const cell = mapData.grid_settings.cell_size || 20;

    const dxCells = Math.abs(dx) / cell;
    const dyCells = Math.abs(dy) / cell;

    const steps = Math.max(dxCells, dyCells);
    const cells = Math.max(1, Math.round(steps));
    const feet = cells * 5;

    const midX = (sx1 + sx2) / 2;
    const midY = (sy1 + sy2) / 2;

    // Рисуем надпись ТОЛЬКО если это не мини-карта
    if (!isMiniMap) {
        ctx.font = "bold 16px Inter";
        ctx.textAlign = "center";
        ctx.lineWidth = 4;
        ctx.strokeStyle = "white";
        ctx.strokeText(`${feet.toFixed(0)} футов`, midX, midY - 10);
        ctx.fillStyle = "black";
        ctx.fillText(`${feet.toFixed(0)} футов`, midX, midY - 10);
    }

    const headlen = 10;
    const angle = Math.atan2(sy2 - sy1, sx2 - sx1);

    const arrowX1 = sx2 - headlen * Math.cos(angle - Math.PI / 6);
    const arrowY1 = sy2 - headlen * Math.sin(angle - Math.PI / 6);
    const arrowX2 = sx2 - headlen * Math.cos(angle + Math.PI / 6);
    const arrowY2 = sy2 - headlen * Math.sin(angle + Math.PI / 6);

    ctx.beginPath();
    ctx.moveTo(sx2, sy2);
    ctx.lineTo(arrowX1, arrowY1);
    ctx.moveTo(sx2, sy2);
    ctx.lineTo(arrowX2, arrowY2);
    ctx.strokeStyle = "#c82a2aff";
    ctx.lineWidth = 2;
    ctx.stroke();
}

// ─── Кеш блюра скрытых зон (один размытый фрагмент на объединение всех полигонов) ───
// Раньше блюр считался отдельно по каждой зоне — на общей границе двух полигонов
// получалась тонкая «полоска» из‑за разных локальных текстур; теперь один blur по общему bbox.
const _unionZoneBlurCache = new Map(); // key → { canvas, worldX, worldY, worldW, worldH, mapSrc, cacheVersion }

/** Смена версии сбрасывает кеш после правок алгоритма блюра */
const ZONE_BLUR_CACHE_VERSION = 7;

function invalidateZoneBlurCache() {
    _unionZoneBlurCache.clear();
}

function _unionHiddenZonesCacheKey(zones) {
    return JSON.stringify(zones.map((z) => [z.id, z.vertices]));
}

/** min/max по всем вершинам списка зон */
function _boundsOfZonesVertexUnion(zones) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const z of zones) {
        for (const [x, y] of z.vertices || []) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
}

function _buildBlurredMapRegionForBounds(minX, minY, maxX, maxY) {
    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) return null;

    const imgW = mapImage.naturalWidth;
    const imgH = mapImage.naturalHeight;

    const BLUR_RADIUS_WORLD = 130;
    const padFrac = Math.max(imgW, imgH) * 0.11;
    const padMin = Math.max(140, Math.ceil(BLUR_RADIUS_WORLD * 4));
    const pad = Math.max(padFrac, padMin);

    const wx0 = minX - pad;
    const wy0 = minY - pad;
    const wx1 = maxX + pad;
    const wy1 = maxY + pad;
    const virtW = wx1 - wx0;
    const virtH = wy1 - wy0;
    if (virtW <= 0 || virtH <= 0) return null;

    const ix0 = Math.min(imgW, Math.max(0, wx0));
    const iy0 = Math.min(imgH, Math.max(0, wy0));
    const ix1 = Math.min(imgW, Math.max(0, wx1));
    const iy1 = Math.min(imgH, Math.max(0, wy1));
    if (ix1 <= ix0 || iy1 <= iy0) return null;

    const MAX_DIM = 1280;
    const rs = Math.min(1, MAX_DIM / Math.max(virtW, virtH));
    const cw = Math.max(1, Math.round(virtW * rs));
    const ch = Math.max(1, Math.round(virtH * rs));

    const offX = Math.round((ix0 - wx0) * rs);
    const offY = Math.round((iy0 - wy0) * rs);
    const cropW = Math.max(1, Math.round((ix1 - ix0) * rs));
    const cropH = Math.max(1, Math.round((iy1 - iy0) * rs));

    const src = document.createElement('canvas');
    src.width = cw;
    src.height = ch;
    const srcCtx = src.getContext('2d');
    const sw = ix1 - ix0;
    const sh = iy1 - iy0;

    srcCtx.drawImage(mapImage, ix0, iy0, sw, sh, offX, offY, cropW, cropH);

    if (offY > 0) {
        srcCtx.drawImage(mapImage, ix0, iy0, sw, 1, 0, 0, cw, offY);
    }
    if (offY + cropH < ch) {
        const bh = ch - offY - cropH;
        srcCtx.drawImage(mapImage, ix0, iy1 - 1, sw, 1, 0, offY + cropH, cw, bh);
    }
    if (offX > 0) {
        srcCtx.drawImage(mapImage, ix0, iy0, 1, sh, 0, offY, offX, cropH);
    }
    if (offX + cropW < cw) {
        const rw = cw - offX - cropW;
        srcCtx.drawImage(mapImage, ix1 - 1, iy0, 1, sh, offX + cropW, offY, rw, cropH);
    }

    const dst = document.createElement('canvas');
    dst.width = cw;
    dst.height = ch;
    const dstCtx = dst.getContext('2d');
    const blurPx = Math.max(8, BLUR_RADIUS_WORLD * rs);
    dstCtx.filter = `blur(${blurPx}px)`;
    dstCtx.drawImage(src, 0, 0);
    dstCtx.filter = 'none';

    return {
        canvas: dst,
        worldX: wx0,
        worldY: wy0,
        worldW: virtW,
        worldH: virtH
    };
}

function _getCachedUnionHiddenZonesBlur(zones) {
    const key = _unionHiddenZonesCacheKey(zones);
    const c = _unionZoneBlurCache.get(key);
    if (c && c.mapSrc === mapImage.src && c.cacheVersion === ZONE_BLUR_CACHE_VERSION) {
        return c;
    }
    const b = _boundsOfZonesVertexUnion(zones);
    if (!b) return null;
    const built = _buildBlurredMapRegionForBounds(b.minX, b.minY, b.maxX, b.maxY);
    if (!built) return null;
    const entry = {
        canvas: built.canvas,
        worldX: built.worldX,
        worldY: built.worldY,
        worldW: built.worldW,
        worldH: built.worldH,
        mapSrc: mapImage.src,
        cacheVersion: ZONE_BLUR_CACHE_VERSION
    };
    _unionZoneBlurCache.set(key, entry);
    return entry;
}

function drawUnionBlurredHiddenZones(hiddenZones, offsetX, offsetY, scale) {
    const cached = _getCachedUnionHiddenZonesBlur(hiddenZones);

    ctx.save();
    ctx.beginPath();
    for (const zone of hiddenZones) {
        const transformed = zone.vertices.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);
        ctx.moveTo(transformed[0][0], transformed[0][1]);
        for (let i = 1; i < transformed.length; i++) {
            ctx.lineTo(transformed[i][0], transformed[i][1]);
        }
        ctx.closePath();
    }
    ctx.clip();

    if (cached) {
        ctx.drawImage(
            cached.canvas,
            cached.worldX * scale + offsetX,
            cached.worldY * scale + offsetY,
            cached.worldW * scale,
            cached.worldH * scale
        );
    } else {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fill();
    }

    ctx.restore();
}

socket.on("map_visibility_change", (data) => {
    if (!data) return;

    // Если событие прилетело раньше, чем mapId нормализовался/подставился,
    // подхватываем mapId и применяем видимость сразу.
    if (!mapId && data.map_id) {
        mapId = data.map_id;
        window.playerMapId = mapId;
    }

    if (data.map_id === mapId) {
        if (!mapData) mapData = {};

        mapData.player_map_enabled = data.player_map_enabled;

        if (data.has_image !== undefined) {
            mapData.has_image = data.has_image;
        }

        const disabledImg = document.getElementById("mapDisabledImage");
        if (disabledImg) {
            disabledImg.style.display = mapData.player_map_enabled ? "none" : "block";
        }

        if (mapData.player_map_enabled) {
            canvas.style.display = "block";
            if (mapData.has_image && (!mapImage || !mapImage.complete)) {
                const imageUrl = data.image_url || `/api/map/image/${mapId}`;
                const newImage = new Image();
                newImage.onload = () => {
                    mapImage = newImage;
                    requestRender();
                };
                newImage.src = imageUrl;
            } else {
                requestRender();
            }
        } else {
            canvas.style.display = "none";
        }

        updatePortraits();
    }
});

socket.on("force_map_update", (data) => {
    if (!data) return;
    if (data.map_id === mapId) {
        if (!mapData) mapData = {};
        Object.assign(mapData, data);

        if (data.has_image && data.image_url) {
            const cid = data.map_id || mapId;
            const cached = mapImageCache.get(cid);
            if (cached && cached.complete && cached.naturalWidth > 0) {
                mapImage = cached;
                requestRender();
            } else {
                const newImage = new Image();
                newImage.onload = () => {
                    mapImage = newImage;
                    mapImageCache.set(cid, newImage);
                    requestRender();
                };
                newImage.src = data.image_url;
            }
        } else {
            requestRender();
        }

        updatePortraits(); // Обновляем портреты при форсированном обновлении
    }
});


socket.on("map_image_updated", (data) => {
    if (data.map_id === mapId) {
        if (mapData && mapData.player_map_enabled !== false) {
            const base = `/api/map/image/${mapId}`;
            const imageUrl = `${base}${base.includes("?") ? "&" : "?"}_=${Date.now()}`;
            const newImage = new Image();
            newImage.onload = () => {
                mapImage = newImage;
                requestRender();
            };
            newImage.src = imageUrl;
        }
    }
});

socket.on("map_image_updated_to_player", (data) => {
    if (data.map_id === mapId && mapData) {
        const imageUrl = data.image_url || `/api/map/image/${mapId}`;
        // Инвалидируем все кеши — новое изображение
        dndCache.invalidate(imageUrl);
        mapImageCache.delete(mapId);
        dndCache.fetch(imageUrl).then(src => {
            const img = new Image();
            img.onload = () => { mapImage = img; mapImageCache.set(mapId, img); invalidateZoneBlurCache(); requestRender(); };
            img.src = src || imageUrl;
        });
    }
});

socket.on("force_image_reload", (data) => {
    if (data.map_id === mapId) {
        const imageUrl = data.image_url || `/api/map/image/${mapId}`;
        dndCache.invalidate(imageUrl);
        mapImageCache.delete(mapId);
        dndCache.fetch(imageUrl).then(src => {
            const img = new Image();
            img.onload = () => {
                mapImage = img;
                mapImageCache.set(mapId, img);
                if (mapData) mapData.has_image = true;
                invalidateZoneBlurCache();
                requestRender();
            };
            img.src = src || imageUrl;
        });
    }
});
window.addEventListener('load', () => {
    if (!mapId && window.parent) {
        try {
            const fromParent = readParentMasterMapId();
            if (fromParent) {
                mapId = fromParent;
                window.playerMapId = mapId;
                if (socket && socket.connected) {
                    socket.emit("join_map", { map_id: mapId });
                    socket.emit('request_drawings', { map_id: mapId });
                }
                fetchMap();
            }
        } catch (e) { /* cross-origin */ }
    }
    setTimeout(updatePortraits, 500);
});

playerChannel.addEventListener('message', (event) => {


    if (event.data.type === 'reload_player' && event.data.map_id === mapId) {

        setTimeout(() => {
            window.location.reload();
        }, 100);
    }
});

function isPointInAnyZone(point, zones) {
    if (!zones || !zones.length) return false;

    for (let i = 0; i < zones.length; i++) {
        const zone = zones[i];
        if (zone.is_visible === false && zone.vertices && zone.vertices.length >= 3) {
            if (pointInPolygon(point, zone.vertices)) {
                return true;
            }
        }
    }
    return false;
}

function pointInPolygon(point, vertices) {
    const [x, y] = point;
    let inside = false;

    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const xi = vertices[i][0], yi = vertices[i][1];
        const xj = vertices[j][0], yj = vertices[j][1];

        const intersect = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }

    return inside;
}

socket.on("token_move", (data) => {
    if (data.map_id === mapId && mapData && mapData.tokens) {
        const fogMoveActive = isPlayerFogOfWarActive();
        if (fogMoveActive && data.position && data.token_id != null) {
            const pos = data.position;
            if (Array.isArray(pos) && pos.length >= 2) {
                const tok = mapData.tokens.find((t) => String(t.id) === String(data.token_id));
                if (tok && tok.is_player && tok.is_visible !== false && !tok.is_dead) {
                    appendPlayerFogLiveTrail(data.token_id, pos[0], pos[1]);
                }
            }
        }

        pendingTokenUpdates.set(data.token_id, {
            position: data.position,
        });

        if (!tokenUpdateTimeout) {
            tokenUpdateTimeout = setTimeout(applyTokenUpdates, 16);
        }
    }
});

socket.on("fog_explored_sync", (data) => {
    if (!data || data.map_id !== mapId || !mapData) return;
    if (mapData.player_visibility_mode !== "fog_of_war") return;
    if (!Array.isArray(data.fog_of_war_explored)) return;
    mapData.fog_of_war_explored = data.fog_of_war_explored;
    clearPlayerFogLiveTrail();
    requestRender();
});

socket.on("token_avatar_updated", (data) => {


    if (data.map_id === mapId) {
        if (avatarCache.has(data.token_id)) {
            avatarCache.delete(data.token_id);

        }

        if (mapData && mapData.tokens) {
            const token = mapData.tokens.find(t => t.id === data.token_id);
            if (token) {
                token.avatar_url = data.avatar_url;

            }
        }

        requestRender();
    }
});

socket.on("force_avatar_reload", (data) => {
    if (data.map_id === mapId) {
        avatarCache.clear();
        requestRender();
    }
});

// Функция для отладки портретов
window.debugPortraits = function () {
    if (!mapData || !portraitSidebar) {
        return;
    }

    const visibleChars = mapData.characters.filter(c => c.visible_to_players !== false);
    renderPortraits(visibleChars);
};

function getAvailableWidth() {
    if (!portraitSidebar) return 0;

    const styles = window.getComputedStyle(portraitSidebar);
    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const paddingRight = parseFloat(styles.paddingRight) || 0;
    const borderLeft = parseFloat(styles.borderLeftWidth) || 0;
    const borderRight = parseFloat(styles.borderRightWidth) || 0;

    const totalPadding = paddingLeft + paddingRight + borderLeft + borderRight;
    return portraitSidebar.clientWidth - totalPadding;
}

socket.on("characters_updated", (data) => {
    if (data && data.map_id === mapId && mapData) {
        mapData.characters = data.characters || [];
        preloadPortraits(mapData.characters);
        updatePortraits();
        requestRender();
    }
});

socket.on("characters_reordered", (data) => {
    if (data && data.map_id === mapId && mapData) {
        mapData.characters = data.characters || [];
        updatePortraits();
        requestRender();
    }
});

function fetchMap(retryCount = 0, maxRetries = 3) {
    const thisGeneration = ++fetchGeneration;

    if (!canvas || !ctx) return Promise.resolve(null);

    resizeCanvasToDisplaySize();
    let _fm = playerCanvasBeginFrame();
    ctx.font = "24px Inter";
    ctx.fillStyle = "#666";
    ctx.textAlign = "center";
    ctx.fillText("Загрузка карты...", _fm.lw / 2, _fm.lh / 2);

    if (!mapId) {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const noMap = urlParams.get("no_map") === "1" || urlParams.get("no_map") === "true";
            if (noMap) {
                // явно без карты
            } else {
                const fromParent = readParentMasterMapId();
                if (fromParent) {
                    mapId = fromParent;
                    window.playerMapId = mapId;
                } else {
                    mapId = urlParams.get("map_id");
                    if (mapId) window.playerMapId = mapId;
                }
            }
        } catch (err) { /* cross-origin */ }

        if (!mapId) {
            _fm = playerCanvasBeginFrame();
            ctx.font = "24px Inter";
            ctx.fillStyle = "#666";
            ctx.textAlign = "center";
            ctx.fillText("Карта не выбрана", _fm.lw / 2, _fm.lh / 2);
            return Promise.reject("No map ID");
        }
    }

    const fetchUrl = `/api/map/${mapId}?for=player`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    return fetch(fetchUrl, {
        signal: controller.signal,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
    })
        .then(res => {
            clearTimeout(timeoutId);
            if (thisGeneration !== fetchGeneration) return null;

            if (!res.ok) {
                if (res.status === 404) {
                    return fetch('/api/maps', { signal: AbortSignal.timeout(5000) })
                        .then(mapsRes => mapsRes.json())
                        .then(maps => {
                            if (maps && maps.length > 0) {
                                mapId = maps[0].id;
                                window.playerMapId = mapId;
                                const url = new URL(window.location);
                                url.searchParams.set('map_id', mapId);
                                window.history.replaceState({}, '', url);
                                if (socket && socket.connected) {
                                    socket.emit("join_map", { map_id: mapId });
                                }
                                return fetchMap(0);
                            }
                            throw new Error("No maps available");
                        });
                }
                throw new Error(`HTTP error! status: ${res.status}`);
            }
            return res.json();
        })
        .then(data => {
            if (!data || thisGeneration !== fetchGeneration) return;
            if (data.error) throw new Error(data.error);

            mapData = data;
            invalidatePlayerFogWallSegmentCache();
            if (mapData.combat === undefined) mapData.combat = null;

            if (data.master_canvas_width) masterCanvasWidth = data.master_canvas_width;
            if (data.master_canvas_height) masterCanvasHeight = data.master_canvas_height;

            zoomLevel = data.zoom_level || 1;
            panX = data.pan_x || 0;
            panY = data.pan_y || 0;

            if (mapData.ruler_visible_to_players === undefined)
                mapData.ruler_visible_to_players = false;
            if (!mapData.characters) mapData.characters = [];
            playerLastSyncedMapId = mapId;
            preloadPortraits(mapData.characters);

            const disabledImg = document.getElementById("mapDisabledImage");
            if (disabledImg) {
                disabledImg.style.display = mapData.player_map_enabled ? "none" : "block";
            }

            if (!mapData.player_map_enabled) {
                canvas.style.display = "none";
                updatePortraits();
                updatePlayerInitiativeStrip();
                return;
            } else {
                canvas.style.display = "block";
            }

            if (mapData.has_image) {
                const imageUrl = mapData.image_url || `/api/map/image/${mapId}`;
                const gen = thisGeneration;

                const applyImage = (img) => {
                    if (gen !== fetchGeneration) return;
                    mapImage = img;
                    mapImageCache.set(mapId, img);
                    requestRender();
                    updatePortraits();
                };

                const memCached = mapImageCache.get(mapId);
                if (memCached && memCached.complete && memCached.naturalWidth > 0) {
                    applyImage(memCached);
                } else {
                    // Используем dndCache — сначала из памяти, затем Cache API, затем сеть
                    dndCache.fetch(imageUrl).then(src => {
                        if (gen !== fetchGeneration) return;
                        const img = new Image();
                        img.onload = () => applyImage(img);
                        img.onerror = () => {
                            if (socket && socket.connected)
                                socket.emit("request_map_image", { map_id: mapId });
                        };
                        img.src = src || imageUrl;
                    });
                }
            } else {
                mapImage = new Image();
                requestRender();
                updatePortraits();
            }

            if (socket && socket.connected) {
                socket.emit('request_map_sync', { map_id: mapId });
                socket.emit('request_drawings', { map_id: mapId });
            }
        })
        .catch(err => {
            clearTimeout(timeoutId);
            if (thisGeneration !== fetchGeneration) return;

            const isFailedToFetch =
                typeof err?.message === "string" &&
                err.message.includes("Failed to fetch");
            const isAbort = err && err.name === "AbortError";

            if (retryCount === 0 && (isFailedToFetch || isAbort) && socket && mapId) {
                try {
                    socket.emit("request_map_data", { map_id: mapId });
                    socket.emit("request_drawings", { map_id: mapId });
                    socket.emit("request_map_sync", { map_id: mapId });
                } catch (e) { /* silent */ }

                _fm = playerCanvasBeginFrame();
                ctx.font = "24px Inter";
                ctx.fillStyle = "#666";
                ctx.textAlign = "center";
                ctx.fillText("Загрузка карты...", _fm.lw / 2, _fm.lh / 2);
                return;
            }

            console.error("Error fetching map:", err);

            // Проверяем тип ошибки
            if (err.name === 'AbortError') {
                _fm = playerCanvasBeginFrame();
                ctx.font = "24px Inter";
                ctx.fillStyle = "#f44336";
                ctx.textAlign = "center";
                ctx.fillText("Таймаут загрузки карты", _fm.lw / 2, _fm.lh / 2 - 20);
                ctx.font = "16px Inter";
                ctx.fillStyle = "#4C5BEF";
                ctx.fillText("Проверьте соединение с сервером", _fm.lw / 2, _fm.lh / 2 + 20);
            } else if (err.message?.includes("Failed to fetch")) {
                _fm = playerCanvasBeginFrame();
                ctx.font = "24px Inter";
                ctx.fillStyle = "#f44336";
                ctx.textAlign = "center";
                ctx.fillText("Сервер недоступен", _fm.lw / 2, _fm.lh / 2 - 20);
                ctx.font = "16px Inter";
                ctx.fillStyle = "#4C5BEF";
                ctx.fillText("Проверьте, запущен ли сервер", _fm.lw / 2, _fm.lh / 2 + 20);
            }

            // Повторная попытка
            if (retryCount < maxRetries && !err.message?.includes("404") && err.name !== 'AbortError') {
                console.log(`Retrying fetchMap (${retryCount + 1}/${maxRetries})...`);
                _fm = playerCanvasBeginFrame();
                ctx.font = "20px Inter";
                ctx.fillStyle = "#666";
                ctx.textAlign = "center";
                ctx.fillText(`Повторная попытка загрузки... (${retryCount + 1}/${maxRetries})`,
                    _fm.lw / 2, _fm.lh / 2);

                return new Promise(resolve => {
                    setTimeout(() => {
                        resolve(fetchMap(retryCount + 1, maxRetries));
                    }, 3000);
                });
            }

            // Показываем кнопку для повторной попытки
            ctx.font = "16px Inter";
            ctx.fillStyle = "#4C5BEF";
            ctx.fillText("Нажмите для повторной попытки", _fm.lw / 2, _fm.lh / 2 + 60);

            const clickHandler = () => {
                canvas.removeEventListener('click', clickHandler);
                fetchMap(0);
            };
            canvas.addEventListener('click', clickHandler);

            // Don't rethrow: fetchMap can be called from socket handlers without awaiting,
            // and throwing causes "Uncaught (in promise)" errors.
            return Promise.resolve(null);
        });
}

function requestDrawingsSync() {
    if (socket && socket.connected && mapId) {
        socket.emit('request_drawings', { map_id: mapId });
    }
}

function drawPlayerStrokes(offsetX, offsetY, scale) {
    if (!playerDrawings || playerDrawings.length === 0) {
        return;
    }

    ctx.save();

    for (let i = 0; i < playerDrawings.length; i++) {
        const stroke = playerDrawings[i];

        // Пропускаем штрихи с одной точкой
        if (!stroke || !stroke.points || !Array.isArray(stroke.points) || stroke.points.length < 2) {
            continue;
        }

        // Проверяем первую точку
        const firstPoint = stroke.points[0];
        if (!Array.isArray(firstPoint) || firstPoint.length < 2) {
            continue;
        }

        ctx.beginPath();
        ctx.strokeStyle = stroke.color || 'rgba(255, 50, 50, 0.5)';
        ctx.lineWidth = (stroke.width || 20) * scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const startX = firstPoint[0] * scale + offsetX;
        const startY = firstPoint[1] * scale + offsetY;

        ctx.moveTo(startX, startY);

        // Добавляем остальные точки
        for (let j = 1; j < stroke.points.length; j++) {
            const point = stroke.points[j];
            if (!Array.isArray(point) || point.length < 2) {
                continue;
            }

            const x = point[0] * scale + offsetX;
            const y = point[1] * scale + offsetY;
            ctx.lineTo(x, y);
        }

        ctx.stroke();
    }

    ctx.restore();
}
socket.on('drawings_updated', (data) => {
    if (data.map_id === mapId) {
        // Фильтруем штрихи - оставляем только те, у которых >= 2 точек
        const filteredStrokes = (data.strokes || []).filter(stroke =>
            stroke && stroke.points && stroke.points.length >= 2
        );

        playerDrawings = filteredStrokes;
        playerDrawingLayerId = data.layer_id;
        requestRender();
    }
});

socket.on('drawings_loaded', (data) => {
    if (data.map_id === mapId) {
        // Фильтруем штрихи при загрузке
        const filteredStrokes = (data.strokes || []).filter(stroke =>
            stroke && stroke.points && stroke.points.length >= 2
        );

        playerDrawings = filteredStrokes;
        playerDrawingLayerId = data.layer_id;
        lastDrawingsHash = JSON.stringify(filteredStrokes);
        drawingsLoaded = true;

        requestRender();
    }
});

socket.on('reconnect', () => {
    if (mapId) {
        socket.emit('join_map', { map_id: mapId });
        socket.emit('request_drawings', { map_id: mapId });
        socket.emit('request_map_sync', { map_id: mapId });
        fetchMap();
    }
});