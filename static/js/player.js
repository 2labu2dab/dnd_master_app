// static/js/player.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
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

if (document.body && isMiniMap) {
    document.body.classList.add('player-embed');
}

const PLAYER_MOBILE_MQ = window.matchMedia('(max-width: 768px)');

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

function preloadPortraits(characters) {
    if (!characters) return;
    characters.forEach(c => {
        const url = c.portrait_url || (c.has_avatar ? `/api/portrait/${c.id}` : null);
        if (url && !portraitImageCache.has(c.id)) {
            const img = new Image();
            img.src = url;
            portraitImageCache.set(c.id, img);
        }
    });
}

// ========== ПОРТРЕТЫ ДЛЯ ИГРОКОВ ==========
let portraitsContainer = document.getElementById('portrait-list');
let portraitSidebar = document.getElementById('portrait-sidebar');
let lastCharactersHash = ''; // Для отслеживания изменений
let updateTimeout = null;

// Функция для создания хеша персонажей (чтобы определять реальные изменения)
function getCharactersHash(characters) {
    if (!characters || characters.length === 0) return '';
    return characters
        .filter(char => char.visible_to_players !== false)
        .map(char => `${char.id}-${char.name}-${char.visible_to_players}-${char.portrait_url || ''}`)
        .join('|');
}

function applyTokenUpdates() {
    if (pendingTokenUpdates.size > 0 && mapData && mapData.tokens) {
        for (const [tokenId, update] of pendingTokenUpdates) {
            const token = mapData.tokens.find(t => t.id === tokenId);
            if (token) {
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
        requestAnimationFrame(() => {
            renderPortraits(visibleCharacters);
            requestRender();
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
const PORTRAIT_NAME_BLOCK_PX = 42;
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
    if (mobile && !isMiniMap && count > 0) {
        cols = count;
        rows = 1;
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

    const totalGapHeight = (rows - 1) * gapSize;
    const nameBlock = isMiniMap ? 0 : PORTRAIT_NAME_BLOCK_PX;
    const availableForPortraits = availableHeight - totalGapHeight - rows * nameBlock;

    let portraitHeight = Math.floor(availableForPortraits / rows);

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

    const padding = isMiniMap ? 10 : mobile ? 24 : 16;
    const availableWidth = sidebarWidth - padding;
    const totalGapWidth = (cols - 1) * gapSize;
    const columnWidth = (availableWidth - totalGapWidth) / cols;

    let finalPortraitSize;
    if (mobile && !isMiniMap) {
        const hCap = Math.floor(
            (availableHeight - (rows - 1) * gapSize - rows * nameBlock) / rows
        );
        const pxCap = Math.min(120, Math.max(56, hCap));
        finalPortraitSize = Math.min(portraitHeight, pxCap);
        finalPortraitSize = Math.max(48, finalPortraitSize);
    } else {
        finalPortraitSize = Math.min(portraitHeight, columnWidth);
        finalPortraitSize = Math.max(isMiniMap ? 30 : 44, finalPortraitSize);
    }

    if (isMiniMap) {
        const maxAllowedWidth = (sidebarWidth - padding) / cols;
        if (finalPortraitSize > maxAllowedWidth) {
            finalPortraitSize = maxAllowedWidth - 2;
        }
    } else {
        const minPortrait = 32;
        const fitHeight = Math.max(0, availableHeight - 4);
        const gridTotalH = () => rows * (finalPortraitSize + nameBlock) + (rows - 1) * gapSize;
        let h = gridTotalH();
        while (h > fitHeight && finalPortraitSize > minPortrait) {
            finalPortraitSize -= 1;
            h = gridTotalH();
        }
        const minGap = mobile ? 4 : !isMiniMap && count >= 3 && count <= 6 ? 8 : 2;
        while (h > fitHeight && gapSize > minGap) {
            gapSize -= 1;
            h = gridTotalH();
        }
        while (h > fitHeight && finalPortraitSize > minPortrait) {
            finalPortraitSize -= 1;
            h = gridTotalH();
        }
        if (!mobile) {
            const tgw = (cols - 1) * gapSize;
            const cw = Math.floor((availableWidth - tgw) / cols);
            if (finalPortraitSize > cw) {
                finalPortraitSize = Math.max(minPortrait, cw);
            }
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
    gridContainer.style.maxHeight = '100%';
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

        // Аватар
        const avatar = document.createElement('img');
        avatar.className = 'portrait-avatar';
        avatar.style.width = '100%';
        avatar.style.height = '100%';
        avatar.style.objectFit = 'cover';
        avatar.style.display = 'block';

        const portraitUrl = character.portrait_url || `/api/portrait/${character.id}`;
        const cached = portraitImageCache.get(character.id);
        if (cached && cached.complete && cached.naturalWidth > 0) {
            avatar.src = cached.src;
            avatar.style.opacity = '1';
        } else {
            avatar.src = portraitUrl;
            avatar.style.opacity = '1';
            avatar.onload = () => {
                portraitImageCache.set(character.id, avatar);
            };
        }

        avatar.onerror = () => {
            avatar.style.display = 'none';
            avatarContainer.style.display = 'flex';
            avatarContainer.style.alignItems = 'center';
            avatarContainer.style.justifyContent = 'center';
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



if (!mapId) {
    const urlParams = new URLSearchParams(window.location.search);
    mapId = urlParams.get('map_id');

}

if (!mapId && window.parent && window.parent.currentMapId) {
    mapId = window.parent.currentMapId;

}

if (
    mapId === "None" ||
    mapId === "null" ||
    mapId === "undefined" ||
    mapId === ""
) {
    mapId = null;
}

socket.on('connect', () => {
    if (mapId) {
        socket.emit('join_map', { map_id: mapId });
        socket.emit('request_drawings', { map_id: mapId });
        socket.emit('request_map_sync', { map_id: mapId });
    }
});

let masterCanvasWidth = 1380;
let masterCanvasHeight = 1080;

window.playerMapId = mapId;

// Запускаем предзагрузку ВСЕХ ассетов с прогрессом
// (для мини-карты только инициализируем кеш без UI)
if (isMiniMap) {
    // В мини-карте (iframe) только тихо инициализируем кеш
    dndCache.init();
} else {
    // В полноэкранном режиме — загрузочный экран + предзагрузка всего
    preloadAllAssets();
}

if (mapId) {
    mapImage = new Image();
    fetchMap();
} else {
    resizeCanvasToDisplaySize();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "24px Inter";
    ctx.fillStyle = "#666";
    ctx.textAlign = "center";
    ctx.fillText("Карта не выбрана", canvas.width / 2, canvas.height / 2);

    // Если mapId не передали (или в шаблоне пришло None),
    // пробуем взять первую доступную карту.
    fetch("/api/maps")
        .then(res => res.json())
        .then(maps => {
            if (!maps || maps.length === 0) return;
            mapId = maps[0].id;
            window.playerMapId = mapId;

            // Синхронизация сразу, если сокет уже подключен.
            if (socket && socket.connected) {
                socket.emit("request_drawings", { map_id: mapId });
                socket.emit("request_map_sync", { map_id: mapId });
            }
            fetchMap();
        })
        .catch(() => {
            // Оставляем "Карта не выбрана"
        });
}

function resizeCanvasToDisplaySize() {
    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;

    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        requestRender();
        // При изменении размера окна обновляем портреты
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

    const oldHasImage = mapData.has_image;
    const oldCharacters = mapData.characters || [];

    invalidateZoneBlurCache();
    Object.assign(mapData, {
        tokens: data.tokens || [],
        zones: data.zones || [],
        finds: data.finds || [],
        characters: data.characters || oldCharacters,
        grid_settings: data.grid_settings || mapData.grid_settings,
        ruler_visible_to_players: data.ruler_visible_to_players,
        ruler_start: data.ruler_start,
        ruler_end: data.ruler_end,
        player_map_enabled: data.player_map_enabled !== undefined ? data.player_map_enabled : true,
        has_image: data.has_image || false,
        master_canvas_width: data.master_canvas_width,
        master_canvas_height: data.master_canvas_height
    });

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
        const currentSrc = mapImage ? mapImage.src : "";
        const needsReload = !oldHasImage || !currentSrc || !currentSrc.includes(mapId);
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
        requestRender();
        updatePortraits(); // Обновляем портреты при смене карты
    }
});

function render() {
    // 1. Базовые проверки
    if (!mapId || !mapData) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Карта не выбрана", canvas.width / 2, canvas.height / 2);
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

    // 4. Проверка изображения
    resizeCanvasToDisplaySize();

    // Сбрасываем трансформацию и очищаем с темным фоном
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!mapData.has_image) {
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Нет изображения карты", canvas.width / 2, canvas.height / 2);
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
        ctx.fillText("Загрузка карты...", canvas.width / 2, canvas.height / 2);
        return;
    }

    // 5. Получаем размеры карты
    const mapW = mapImage.width;
    const mapH = mapImage.height;

    // 6. Вычисляем масштаб для игрока
    const playerBaseScale = Math.min(canvas.width / mapW, canvas.height / mapH);
    const playerScale = playerBaseScale * zoomLevel;

    // 7. Центрируем карту на экране игрока
    // Используем те же мировые координаты, что и у мастера
    // Для этого нам нужно знать, какой размер канваса у мастера
    const masterScale = Math.min(masterCanvasWidth / mapW, masterCanvasHeight / mapH) * zoomLevel;
    const worldCenterX = (masterCanvasWidth / 2 - panX) / masterScale;
    const worldCenterY = (masterCanvasHeight / 2 - panY) / masterScale;

    // Вычисляем смещение для игрока
    const offsetX = canvas.width / 2 - worldCenterX * playerScale;
    const offsetY = canvas.height / 2 - worldCenterY * playerScale;

    // 8. Рисуем изображение
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(mapImage, offsetX, offsetY, mapW * playerScale, mapH * playerScale);

    // Рисуем остальные слои
    drawLayers(offsetX, offsetY, playerScale);

    // Рисуем линейку если нужно
    if (mapData.ruler_visible_to_players && mapData.ruler_start && mapData.ruler_end) {
        drawMasterRuler(mapData.ruler_start, mapData.ruler_end, offsetX, offsetY, playerScale);
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
function drawLayers(offsetX, offsetY, scale) {
    const imageLoaded = mapImage && mapImage.complete && mapImage.naturalWidth > 0;

    if (imageLoaded &&
        mapData.grid_settings &&
        mapData.grid_settings.visible_to_players === true) {
        drawGrid(offsetX, offsetY, scale);
    }

    // Рисуем рисунки мастера - ЭТУ СТРОКУ НУЖНО ДОБАВИТЬ
    drawPlayerStrokes(offsetX, offsetY, scale);

    if (mapData.zones && mapData.zones.length) {
        for (let i = 0; i < mapData.zones.length; i++) {
            const zone = mapData.zones[i];
            if (zone.is_visible === false) {
                drawBlurredZone(zone, offsetX, offsetY, scale);
            }
        }
    }

    if (mapData.tokens && mapData.tokens.length) {
        for (let i = 0; i < mapData.tokens.length; i++) {
            const token = mapData.tokens[i];
            if (token.is_visible !== false) {
                const tokenPosition = token.position;
                const isInHiddenZone = isPointInAnyZone(tokenPosition, mapData.zones);
                if (!isInHiddenZone) {
                    drawToken(token, offsetX, offsetY, scale);
                }
            }
        }
    }
}

function drawGrid(offsetX, offsetY, scale) {
    // Получаем количество клеток из настроек
    let cellsCount = mapData.grid_settings.cell_count || 20; // По умолчанию 20 клеток

    // Проверяем границы
    if (cellsCount < 5) cellsCount = 5;
    if (cellsCount > 150) cellsCount = 150;

    // Рассчитываем размер клетки в пикселях на карте
    const cellSizeInPixels = mapImage.naturalWidth / cellsCount;

    ctx.strokeStyle = mapData.grid_settings.color || "#888";
    ctx.lineWidth = 1;

    const mapScreenWidth = mapImage.width * scale;
    const mapScreenHeight = mapImage.height * scale;

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
        if (sx < 0 || sx > canvas.width) continue;

        ctx.moveTo(sx, Math.max(mapTop, 0));
        ctx.lineTo(sx, Math.min(mapBottom, canvas.height));
    }

    // Рисуем горизонтальные линии - их количество = cellsCount * (высота/ширина)
    const aspectRatio = mapImage.naturalHeight / mapImage.naturalWidth;
    const horizontalCells = Math.round(cellsCount * aspectRatio);

    for (let i = 0; i <= horizontalCells; i++) {
        const y = i * cellSizeInPixels; // Позиция в пикселях на карте
        const sy = offsetY + y * scale;
        if (sy < 0 || sy > canvas.height) continue;

        ctx.moveTo(Math.max(mapLeft, 0), sy);
        ctx.lineTo(Math.min(mapRight, canvas.width), sy);
    }

    ctx.stroke();
    ctx.restore();
}

function drawToken(token, offsetX, offsetY, scale) {
    const [x, y] = token.position;
    const sx = x * scale + offsetX;
    const sy = y * scale + offsetY;

    const cellSize = mapData.grid_settings.cell_size * scale;
    let sizeScale = 1.0;
    switch (token.size) {
        case 'tiny': sizeScale = 0.5; break;
        case 'small':
        case 'medium': sizeScale = 1.0; break;
        case 'large': sizeScale = 2.0; break;
        case 'huge': sizeScale = 3.0; break;
        case 'gargantuan': sizeScale = 4.0; break;
        default: sizeScale = 1.0;
    }

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

function drawMasterRuler(start, end, offsetX, offsetY, scale) {
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

    if (maxX < 0 || minX > canvas.width || maxY < 0 || minY > canvas.height) {
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

// ─── Кеш блюра зон ──────────────────────────────────────────────────────────
// Блюр вычисляется ОДИН РАЗ на зону при загрузке карты/изменении зоны.
// При каждом кадре — только дешёвый drawImage(cached, ...).
const _zoneBlurCache = new Map(); // id → { canvas, worldX, worldY, worldW, worldH, mapSrc, hash }

function invalidateZoneBlurCache() { _zoneBlurCache.clear(); }

function _zoneKey(zone) { return zone.id || JSON.stringify(zone.vertices); }
function _zoneHash(zone) { return JSON.stringify(zone.vertices); }

function _buildZoneBlur(zone) {
    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) return null;

    // Bounding box в координатах карты
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of zone.vertices) {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }

    // Отступ для плавного размытия по краям
    const pad = Math.max(mapImage.naturalWidth, mapImage.naturalHeight) * 0.06;
    const wx  = Math.max(0, minX - pad);
    const wy  = Math.max(0, minY - pad);
    const wx2 = Math.min(mapImage.naturalWidth,  maxX + pad);
    const wy2 = Math.min(mapImage.naturalHeight, maxY + pad);
    const ww  = wx2 - wx;
    const wh  = wy2 - wy;
    if (ww <= 0 || wh <= 0) return null;

    // Рендерим в ограниченном разрешении (не больше 512px по длинной стороне)
    const MAX_DIM = 512;
    const rs = Math.min(1, MAX_DIM / Math.max(ww, wh));
    const cw = Math.max(1, Math.round(ww * rs));
    const ch = Math.max(1, Math.round(wh * rs));

    // Шаг 1: вырезаем нужный кусок карты
    const src = document.createElement('canvas');
    src.width = cw; src.height = ch;
    const srcCtx = src.getContext('2d');
    srcCtx.drawImage(mapImage, wx, wy, ww, wh, 0, 0, cw, ch);

    // Шаг 2: применяем blur на отдельный холст (нельзя in-place)
    const dst = document.createElement('canvas');
    dst.width = cw; dst.height = ch;
    const dstCtx = dst.getContext('2d');
    const blurPx = Math.max(6, cw * 0.07);
    dstCtx.filter = `blur(${blurPx}px)`;
    dstCtx.drawImage(src, 0, 0);
    dstCtx.filter = 'none';

    return { canvas: dst, worldX: wx, worldY: wy, worldW: ww, worldH: wh,
             mapSrc: mapImage.src, hash: _zoneHash(zone) };
}

function _getCachedZoneBlur(zone) {
    const key  = _zoneKey(zone);
    const hash = _zoneHash(zone);
    const c    = _zoneBlurCache.get(key);
    if (c && c.hash === hash && c.mapSrc === mapImage.src) return c;
    const built = _buildZoneBlur(zone);
    if (built) _zoneBlurCache.set(key, built);
    return built;
}
// ────────────────────────────────────────────────────────────────────────────

function drawBlurredZone(zone, offsetX, offsetY, scale) {
    if (!zone.vertices || zone.vertices.length < 2) return;

    const cached = _getCachedZoneBlur(zone);
    const transformed = zone.vertices.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(transformed[0][0], transformed[0][1]);
    for (let i = 1; i < transformed.length; i++) ctx.lineTo(transformed[i][0], transformed[i][1]);
    ctx.closePath();
    ctx.clip();

    if (cached) {
        // Мгновенный drawImage из кеша — без пересчёта blur каждый кадр
        ctx.drawImage(
            cached.canvas,
            cached.worldX * scale + offsetX,
            cached.worldY * scale + offsetY,
            cached.worldW * scale,
            cached.worldH * scale
        );
    } else {
        // Fallback пока mapImage не готов
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
            const imageUrl = `/api/map/image/${mapId}`;
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
            if (window.parent.currentMapId) {
                mapId = window.parent.currentMapId;
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
        // Сохраняем обновление
        pendingTokenUpdates.set(data.token_id, {
            position: data.position
        });

        // Планируем применение обновлений
        if (!tokenUpdateTimeout) {
            tokenUpdateTimeout = setTimeout(applyTokenUpdates, 16); // ~60fps
        }
    }
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "24px Inter";
    ctx.fillStyle = "#666";
    ctx.textAlign = "center";
    ctx.fillText("Загрузка карты...", canvas.width / 2, canvas.height / 2);

    if (!mapId) {
        try {
            if (window.parent && window.parent.currentMapId) {
                mapId = window.parent.currentMapId;
                window.playerMapId = mapId;
            } else {
                const urlParams = new URLSearchParams(window.location.search);
                mapId = urlParams.get('map_id');
            }
        } catch (err) { /* cross-origin */ }

        if (!mapId) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.font = "24px Inter";
            ctx.fillStyle = "#666";
            ctx.textAlign = "center";
            ctx.fillText("Карта не выбрана", canvas.width / 2, canvas.height / 2);
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

            if (data.master_canvas_width) masterCanvasWidth = data.master_canvas_width;
            if (data.master_canvas_height) masterCanvasHeight = data.master_canvas_height;

            zoomLevel = data.zoom_level || 1;
            panX = data.pan_x || 0;
            panY = data.pan_y || 0;

            if (mapData.ruler_visible_to_players === undefined)
                mapData.ruler_visible_to_players = false;
            if (!mapData.characters) mapData.characters = [];
            preloadPortraits(mapData.characters);

            const disabledImg = document.getElementById("mapDisabledImage");
            if (disabledImg) {
                disabledImg.style.display = mapData.player_map_enabled ? "none" : "block";
            }

            if (!mapData.player_map_enabled) {
                canvas.style.display = "none";
                updatePortraits();
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

                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.font = "24px Inter";
                ctx.fillStyle = "#666";
                ctx.textAlign = "center";
                ctx.fillText("Загрузка карты...", canvas.width / 2, canvas.height / 2);
                return;
            }

            console.error("Error fetching map:", err);

            // Проверяем тип ошибки
            if (err.name === 'AbortError') {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.font = "24px Inter";
                ctx.fillStyle = "#f44336";
                ctx.textAlign = "center";
                ctx.fillText("Таймаут загрузки карты", canvas.width / 2, canvas.height / 2 - 20);
                ctx.font = "16px Inter";
                ctx.fillStyle = "#4C5BEF";
                ctx.fillText("Проверьте соединение с сервером", canvas.width / 2, canvas.height / 2 + 20);
            } else if (err.message?.includes("Failed to fetch")) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.font = "24px Inter";
                ctx.fillStyle = "#f44336";
                ctx.textAlign = "center";
                ctx.fillText("Сервер недоступен", canvas.width / 2, canvas.height / 2 - 20);
                ctx.font = "16px Inter";
                ctx.fillStyle = "#4C5BEF";
                ctx.fillText("Проверьте, запущен ли сервер", canvas.width / 2, canvas.height / 2 + 20);
            }

            // Повторная попытка
            if (retryCount < maxRetries && !err.message?.includes("404") && err.name !== 'AbortError') {
                console.log(`Retrying fetchMap (${retryCount + 1}/${maxRetries})...`);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.font = "20px Inter";
                ctx.fillStyle = "#666";
                ctx.textAlign = "center";
                ctx.fillText(`Повторная попытка загрузки... (${retryCount + 1}/${maxRetries})`,
                    canvas.width / 2, canvas.height / 2);

                return new Promise(resolve => {
                    setTimeout(() => {
                        resolve(fetchMap(retryCount + 1, maxRetries));
                    }, 3000);
                });
            }

            // Показываем кнопку для повторной попытки
            ctx.font = "16px Inter";
            ctx.fillStyle = "#4C5BEF";
            ctx.fillText("Нажмите для повторной попытки", canvas.width / 2, canvas.height / 2 + 60);

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