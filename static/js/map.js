// static/js/map.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");

// ─── RAF-планировщик ────────────────────────────────────────────────────────
let _rafPending = false;
function scheduleRender() {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
        _rafPending = false;
        render();
    });
}
// ────────────────────────────────────────────────────────────────────────────

// ─── Offscreen-кеш фона (карта + сетка) ─────────────────────────────────────
// Фон перерисовывается только при изменении: зум/пан/карта/сетка.
// При движении токена/линейки используем готовый bgCanvas без перерасчёта.
let _bgCanvas = null;
let _bgCtx = null;
let _bgDirty = true;   // нужно ли перерисовать фон
let _bgKey = '';       // строка-ключ: если изменилась — фон устарел

function invalidateBg() { _bgDirty = true; }

function _getBgKey() {
    if (!mapImage || !mapData) return '';
    return `${currentMapId}|${zoomLevel}|${panX}|${panY}|` +
           `${canvas.width}|${canvas.height}|` +
           `${mapData.grid_settings.visible}|${mapData.grid_settings.cell_size}|` +
           `${mapData.grid_settings.color}`;
}

function _renderBg(offsetX, offsetY, scale) {
    if (!_bgCanvas || _bgCanvas.width !== canvas.width || _bgCanvas.height !== canvas.height) {
        _bgCanvas = document.createElement('canvas');
        _bgCanvas.width = canvas.width;
        _bgCanvas.height = canvas.height;
        _bgCtx = _bgCanvas.getContext('2d');
        _bgDirty = true;
    }

    const key = _getBgKey();
    if (!_bgDirty && key === _bgKey) return; // кеш актуален
    _bgDirty = false;
    _bgKey = key;

    _bgCtx.clearRect(0, 0, _bgCanvas.width, _bgCanvas.height);

    if (mapImage && mapImage.complete && mapImage.naturalWidth > 0) {
        _bgCtx.drawImage(mapImage, offsetX, offsetY, mapImage.width * scale, mapImage.height * scale);
    }

    if (mapData && mapData.grid_settings && mapData.grid_settings.visible && mapImage) {
        _drawGridToCtx(_bgCtx, offsetX, offsetY, scale);
    }
}

// Рисует сетку в произвольный 2d-контекст (используется offscreen и основной)
function _drawGridToCtx(c, offsetX, offsetY, scale) {
    const cell = mapData.grid_settings.cell_size;
    const clipX1 = Math.max(0, offsetX);
    const clipY1 = Math.max(0, offsetY);
    const clipX2 = Math.min(c.canvas.width, offsetX + mapImage.width * scale);
    const clipY2 = Math.min(c.canvas.height, offsetY + mapImage.height * scale);

    c.save();
    c.strokeStyle = mapData.grid_settings.color;
    c.lineWidth = 1;
    c.beginPath();

    for (let x = 0; x <= mapImage.width; x += cell) {
        const sx = offsetX + x * scale;
        if (sx < 0 || sx > c.canvas.width) continue;
        c.moveTo(sx, clipY1);
        c.lineTo(sx, clipY2);
    }
    for (let y = 0; y <= mapImage.height; y += cell) {
        const sy = offsetY + y * scale;
        if (sy < 0 || sy > c.canvas.height) continue;
        c.moveTo(clipX1, sy);
        c.lineTo(clipX2, sy);
    }

    c.stroke();
    c.restore();
}
// ────────────────────────────────────────────────────────────────────────────
const sidebar = document.getElementById("sidebar");
const rightSidebar = document.getElementById("right-sidebar");
const playerRulerToggle = document.getElementById("playerRulerToggle");
const rulerToggle = document.getElementById("rulerToggle");
(function initMasterCanvasSize() {
    const container = document.getElementById('canvas-container');
    const c = document.getElementById('mapCanvas');
    if (container && c) {
        c.width = Math.max(1, Math.round(container.clientWidth));
        c.height = Math.max(1, Math.round(container.clientHeight));
    } else if (c && sidebar && rightSidebar) {
        c.width = Math.max(1, Math.round(window.innerWidth - sidebar.offsetWidth - rightSidebar.offsetWidth));
        c.height = Math.max(1, Math.round(window.innerHeight));
    }
})();
let mapsList = [];
/** Единая история Ctrl+Z / Ctrl+Y: снимок рисунков + зон на каждом шаге */
let masterUndoHistory = [];
let masterUndoIndex = -1;
const MAX_HISTORY_SIZE = 50;
let editingMapId = null;
let masterPingInterval = null;
let currentMapImageFile = null;
let allTokensFromMaps = [];
let allCharactersFromMaps = [];
let selectedImportToken = null;
let isSwitchingMap = false;
/** Инкрементируется при каждой смене карты / сбросе — отбрасываем устаревшие ответы fetch. */
let _switchMapGen = 0;
let selectedCharacterId = null;
let spawnPosition = null;
let isClick = true; // Флаг для определения клика vs перетаскивания
let clickTimer = null; // Таймер для определения задержки
let allBankCharacters = [];
let isDrawMode = false;
let isEraseMode = false;
let drawingStroke = null;
let drawingStrokes = [];
let currentStrokePoints = [];
let lastDrawPoint = null;
let drawThrottle = null;
let currentDrawingLayerId = null;

function ensureDrawingLayerId() {
    if (!currentDrawingLayerId && currentMapId) {
        if (typeof crypto !== "undefined" && crypto.randomUUID) {
            currentDrawingLayerId = `layer_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
        } else {
            currentDrawingLayerId = `layer_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        }
    }
}

/** Сброс слоя рисунков при смене карты (до загрузки данных с сервера). */
function resetDrawingStateForNewMap() {
    drawingStroke = null;
    lastDrawPoint = null;
    if (drawThrottle) {
        clearTimeout(drawThrottle);
        drawThrottle = null;
    }
    drawingStrokes = [];
    currentDrawingLayerId = null;
    clearDrawingHistory();
}

/**
 * Загрузить рисунки карты; вызывать после resetDrawingStateForNewMap и выставления currentMapId.
 * Возвращает Promise — дождаться перед тем как отпускать UI на рисование.
 */
function fetchAndApplyDrawingsForMap(mapId) {
    if (!mapId) {
        return Promise.resolve();
    }
    return fetch(`/api/drawings/${mapId}`)
        .then((res) => {
            if (!res.ok) {
                throw new Error(`drawings HTTP ${res.status}`);
            }
            return res.json();
        })
        .then((data) => {
            if (currentMapId !== mapId) return;
            if (data.status === "ok") {
                drawingStrokes = data.strokes || [];
                currentDrawingLayerId = data.layer_id;
            }
            saveDrawingStateToHistory();
            render();
            setTimeout(() => {
                if (currentMapId === mapId && currentDrawingLayerId) {
                    socket.emit("drawings_updated", {
                        map_id: currentMapId,
                        strokes: drawingStrokes,
                        layer_id: currentDrawingLayerId,
                    });
                }
            }, 500);
        })
        .catch((err) => {
            if (currentMapId !== mapId) return;
            console.error("Error loading drawings:", err);
            drawingStrokes = [];
            currentDrawingLayerId = null;
            ensureDrawingLayerId();
            saveDrawingStateToHistory();
            render();
        });
}
let selectedTokens = new Set(); // Множество ID выбранных токенов
let isDraggingMultiple = false; // Флаг перетаскивания нескольких токенов
let multiDragOffsets = new Map(); // Смещения для каждого токена при групповом перетаскивании
let multiDragStartPositions = new Map(); // Начальные позиции для группового перетаскивания
const playerChannel = new BroadcastChannel('dnd_map_channel');
let zoomLevel = 1;
const socket = window.createDndSocket({ auth: { role: 'master' } });
socket.on('disconnect', () => {
    console.log('Socket disconnected');
    if (masterPingInterval) {
        clearInterval(masterPingInterval);
        masterPingInterval = null;
    }
});
socket.on('connect_error', (error) => {
    console.log('Socket connection error:', error);
});

socket.on('reconnect', () => {
    if (currentMapId) {
        socket.emit('join_map', { map_id: currentMapId });
    }
    setMasterMapIdGlobal();
});
let panX = 0;
let panY = 0;
let isPanning = false;
let panStartMouseX = 0;
let panStartMouseY = 0;
let panStartPanX = 0;
let panStartPanY = 0;
let mapImage = new Image();
let mapData = {
    tokens: [],
    finds: [],
    zones: [],
    map_image_base64: "",
    grid_settings: { cell_size: 20, color: "#888888", visible: false }
};


let selectedTokenId = null;
let selectedFindId = null;
let draggingToken = null;
let draggingFind = null;
let dragOffset = [0, 0];

let drawingZone = false;
let currentZoneVertices = [];

let avatarImage = null;
let avatarData = null;
let selectedZoneId = null;
let draggingVertexZoneId = null;  // id зоны, у которой тянем вершину
let draggingVertexIndex  = -1;    // индекс тянущейся вершины
let hoveredVertexZoneId  = null;  // для подсветки при hover
let hoveredVertexIndex   = -1;
let selectedVertexZoneId = null;  // вершина для Delete (клик по ручке)
let selectedVertexIndex  = -1;

function clearSelectedVertex() {
    selectedVertexZoneId = null;
    selectedVertexIndex  = -1;
}

const VERTEX_HIT_R = 10;          // радиус клика по вершине (пиксели экрана)
const EDGE_INSERT_SCREEN_DIST = 16; // допуск к грани при двойном клике (экран, px)

function closestPointOnSegmentWorld(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 <= 0) return { x: x1, y: y1, t: 0 };
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return { x: x1 + t * dx, y: y1 + t * dy, t };
}

/** Двойной клик по грани выделенной зоны — новая вершина на ребре */
function tryInsertZoneVertexOnEdge(mouseX, mouseY) {
    if (!selectedZoneId || !mapData?.zones || !mapImage?.width) return false;
    const zone = mapData.zones.find(z => z.id === selectedZoneId);
    if (!zone?.vertices || zone.vertices.length < 3) return false;

    const { scale, offsetX, offsetY } = getTransform();
    const wxClick = (mouseX - offsetX) / scale;
    const wyClick = (mouseY - offsetY) / scale;

    const n = zone.vertices.length;
    let bestI = -1;
    let bestWorld = null;
    let bestScreenD = EDGE_INSERT_SCREEN_DIST + 1;

    for (let i = 0; i < n; i++) {
        const [x1, y1] = zone.vertices[i];
        const [x2, y2] = zone.vertices[(i + 1) % n];
        const sx1 = x1 * scale + offsetX;
        const sy1 = y1 * scale + offsetY;
        const sx2 = x2 * scale + offsetX;
        const sy2 = y2 * scale + offsetY;
        if (Math.hypot(mouseX - sx1, mouseY - sy1) <= VERTEX_HIT_R) continue;
        if (Math.hypot(mouseX - sx2, mouseY - sy2) <= VERTEX_HIT_R) continue;

        const cp = closestPointOnSegmentWorld(wxClick, wyClick, x1, y1, x2, y2);
        if (cp.t <= 0.04 || cp.t >= 0.96) continue;

        const scx = cp.x * scale + offsetX;
        const scy = cp.y * scale + offsetY;
        const d = Math.hypot(mouseX - scx, mouseY - scy);
        if (d < bestScreenD) {
            bestScreenD = d;
            bestI = i;
            bestWorld = { x: cp.x, y: cp.y };
        }
    }

    if (bestI < 0 || bestScreenD > EDGE_INSERT_SCREEN_DIST || !bestWorld) return false;

    const nx = Math.max(0, Math.min(bestWorld.x, mapImage.width));
    const ny = Math.max(0, Math.min(bestWorld.y, mapImage.height));
    zone.vertices.splice(bestI + 1, 0, [nx, ny]);

    clearSelectedVertex();
    saveDrawingStateToHistory();
    debouncedSave(300);
    invalidateBg();
    render();
    updateSidebar();
    return true;
}

let isRulerMode = false;
let rulerStart = null;
let lastMouseX = 0;
let lastMouseY = 0;
let editingFindId = null;
let editingZoneId = null;
let pendingZoneVertices = null;
let hoveredSnapVertex = null;

/** Ближайшая вершина существующей зоны в радиусе снапа (координаты карты). */
function findZoneVertexSnapWorld(wx, wy, scale) {
    if (!mapData?.zones?.length || !Number.isFinite(scale) || scale <= 0) return null;
    const r = 10 / scale;
    const r2 = r * r;
    let best = null;
    let bestD2 = r2;
    for (const zone of mapData.zones) {
        if (!zone.vertices) continue;
        for (const [vx, vy] of zone.vertices) {
            const dx = wx - vx;
            const dy = wy - vy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = [vx, vy];
            }
        }
    }
    return best;
}

const avatarCache = new Map();

/** GIF/видео портрета без кропа: файл до upload */
window.pendingCharacterPortraitFile = null;
window.pendingCharacterPortraitMedia = null;

/** Оригинал GIF/видео при загрузке аватара токена — уходит в портреты, если отмечено «Добавить в портреты». */
window.pendingTokenPortraitFile = null;
window.pendingTokenPortraitMedia = null;

function clearTokenPendingPortrait() {
    window.pendingTokenPortraitFile = null;
    window.pendingTokenPortraitMedia = null;
}

/**
 * Первый кадр GIF или видео → PNG data URL для аватара токена (на карте всегда PNG).
 */
function tokenMediaFileToStaticPngDataUrl(file) {
    return new Promise((resolve, reject) => {
        const isGif = file.type === "image/gif" || /\.gif$/i.test(file.name);
        const isVideo =
            (file.type && file.type.startsWith("video/")) ||
            /\.(webm|mp4|mov|m4v)$/i.test(file.name);

        if (!isGif && !isVideo) {
            reject(new Error("not gif/video"));
            return;
        }

        const url = URL.createObjectURL(file);

        if (isGif) {
            const img = new Image();
            img.onload = () => {
                try {
                    const w = img.naturalWidth || img.width;
                    const h = img.naturalHeight || img.height;
                    if (!w || !h) throw new Error("bad size");
                    const MAX = 1024;
                    const scale = Math.min(1, MAX / Math.max(w, h));
                    const cw = Math.max(1, Math.round(w * scale));
                    const ch = Math.max(1, Math.round(h * scale));
                    const c = document.createElement("canvas");
                    c.width = cw;
                    c.height = ch;
                    const ctx = c.getContext("2d");
                    if (!ctx) throw new Error("no 2d");
                    ctx.drawImage(img, 0, 0, cw, ch);
                    const dataUrl = c.toDataURL("image/png");
                    URL.revokeObjectURL(url);
                    resolve(dataUrl);
                } catch (e) {
                    URL.revokeObjectURL(url);
                    reject(e);
                }
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error("gif load failed"));
            };
            img.src = url;
            return;
        }

        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.setAttribute("playsinline", "");
        v.preload = "auto";

        let settled = false;

        const cleanup = () => {
            URL.revokeObjectURL(url);
            v.removeAttribute("src");
            try {
                v.load();
            } catch (e) { /* ignore */ }
        };

        const grab = () => {
            if (settled) return true;
            try {
                const w = v.videoWidth;
                const h = v.videoHeight;
                if (!w || !h) return false;
                const MAX = 1024;
                const scale = Math.min(1, MAX / Math.max(w, h));
                const cw = Math.max(1, Math.round(w * scale));
                const ch = Math.max(1, Math.round(h * scale));
                const c = document.createElement("canvas");
                c.width = cw;
                c.height = ch;
                const ctx = c.getContext("2d");
                if (!ctx) return false;
                ctx.drawImage(v, 0, 0, cw, ch);
                const dataUrl = c.toDataURL("image/png");
                settled = true;
                cleanup();
                resolve(dataUrl);
                return true;
            } catch (e) {
                return false;
            }
        };

        const fail = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error("video frame failed"));
        };

        v.addEventListener("loadeddata", () => {
            if (grab()) return;
            try {
                const d = v.duration;
                if (Number.isFinite(d) && d > 0) {
                    v.currentTime = Math.min(0.08, d * 0.02);
                } else {
                    v.currentTime = 0.08;
                }
            } catch (e) {
                fail();
            }
        });
        v.addEventListener("seeked", () => {
            if (settled) return;
            if (!grab()) fail();
        });
        v.addEventListener("error", fail);
        setTimeout(() => {
            if (!settled) fail();
        }, 20000);

        v.src = url;
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

/** Создаёт <video> превью, если в шаблоне его ещё нет (старые кэши HTML). */
function ensureCharacterAvatarPreviewVideo() {
    let el = document.getElementById("characterAvatarPreviewVideo");
    if (el) return el;
    const dz = document.getElementById("characterAvatarDropzone");
    const imgPrev = document.getElementById("characterAvatarPreview");
    if (!dz) return null;
    el = document.createElement("video");
    el.id = "characterAvatarPreviewVideo";
    el.style.display = "none";
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.objectFit = "cover";
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    el.setAttribute("playsinline", "");
    el.autoplay = true;
    if (imgPrev && imgPrev.parentNode === dz) {
        dz.insertBefore(el, imgPrev.nextSibling);
    } else {
        dz.insertBefore(el, dz.firstChild);
    }
    return el;
}

function clearCharacterPendingMedia() {
    window.pendingCharacterPortraitFile = null;
    window.pendingCharacterPortraitMedia = null;
    if (window._characterPortraitBlobUrl) {
        URL.revokeObjectURL(window._characterPortraitBlobUrl);
        window._characterPortraitBlobUrl = null;
    }
    const vid = document.getElementById("characterAvatarPreviewVideo");
    if (vid) {
        vid.pause();
        vid.removeAttribute("src");
        vid.style.display = "none";
    }
}

/** Статичные миниатюры GIF/видео в списке портретов мастера (PNG data URL). Ключ — полный URL (?v=). */
const masterPortraitFrozenThumbCache = new Map();

function applyMasterPortraitListGifStaticFrame(targetImg, portraitUrl) {
    const hit = masterPortraitFrozenThumbCache.get(portraitUrl);
    if (hit) {
        targetImg.src = hit;
        return;
    }
    targetImg.style.opacity = "0.4";
    const loader = new Image();
    loader.onload = () => {
        try {
            const w = loader.naturalWidth || loader.width;
            const h = loader.naturalHeight || loader.height;
            if (!w || !h) throw new Error("bad size");
            const MAX = 192;
            const scale = Math.min(1, MAX / Math.max(w, h));
            const cw = Math.max(1, Math.round(w * scale));
            const ch = Math.max(1, Math.round(h * scale));
            const c = document.createElement("canvas");
            c.width = cw;
            c.height = ch;
            const ctx = c.getContext("2d");
            if (!ctx) throw new Error("no 2d");
            ctx.drawImage(loader, 0, 0, cw, ch);
            const dataUrl = c.toDataURL("image/png");
            masterPortraitFrozenThumbCache.set(portraitUrl, dataUrl);
            targetImg.src = dataUrl;
        } catch (e) {
            targetImg.src = portraitUrl;
        }
        targetImg.style.opacity = "1";
    };
    loader.onerror = () => {
        targetImg.src = portraitUrl;
        targetImg.style.opacity = "1";
    };
    loader.src = portraitUrl;
}

function masterPortraitListPlaceholderDataUrl() {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext("2d");
    if (ctx) {
        ctx.fillStyle = "#3a4a6b";
        ctx.fillRect(0, 0, 32, 32);
    }
    return c.toDataURL("image/png");
}

/** Первый кадр видео-портрета для списка мастера (без воспроизведения). */
function applyMasterPortraitListVideoStaticFrame(targetImg, portraitUrl) {
    const hit = masterPortraitFrozenThumbCache.get(portraitUrl);
    if (hit) {
        targetImg.src = hit;
        return;
    }
    targetImg.style.opacity = "0.4";
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.preload = "auto";

    let settled = false;
    let timeoutId = null;

    const cleanup = () => {
        if (timeoutId != null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        v.removeAttribute("src");
        try {
            v.load();
        } catch (e) { /* ignore */ }
    };

    const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        targetImg.src = masterPortraitListPlaceholderDataUrl();
        targetImg.style.opacity = "1";
    };

    const grab = () => {
        if (settled) return true;
        try {
            const w = v.videoWidth;
            const h = v.videoHeight;
            if (!w || !h) return false;
            const MAX = 192;
            const scale = Math.min(1, MAX / Math.max(w, h));
            const cw = Math.max(1, Math.round(w * scale));
            const ch = Math.max(1, Math.round(h * scale));
            const c = document.createElement("canvas");
            c.width = cw;
            c.height = ch;
            const ctx = c.getContext("2d");
            if (!ctx) return false;
            ctx.drawImage(v, 0, 0, cw, ch);
            const dataUrl = c.toDataURL("image/png");
            masterPortraitFrozenThumbCache.set(portraitUrl, dataUrl);
            targetImg.src = dataUrl;
            settled = true;
            targetImg.style.opacity = "1";
            cleanup();
            return true;
        } catch (e) {
            return false;
        }
    };

    v.addEventListener("loadeddata", () => {
        if (grab()) return;
        try {
            const d = v.duration;
            if (Number.isFinite(d) && d > 0) {
                v.currentTime = Math.min(0.08, d * 0.02);
            } else {
                v.currentTime = 0.08;
            }
        } catch (e) {
            fail();
        }
    });
    v.addEventListener("seeked", () => {
        if (settled) return;
        if (!grab()) fail();
    });
    v.addEventListener("error", fail);

    timeoutId = setTimeout(fail, 15000);
    v.src = portraitUrl;
}

let socketId = null;

// Функция для создания элемента списка портретов (ДОЛЖНА БЫТЬ ГЛОБАЛЬНОЙ)
function createCharacterListItem(character, index) {
    console.log("Creating character list item for:", character?.name);

    // Защита от null/undefined character
    if (!character || !character.id) {
        console.warn("Invalid character data:", character);
        const li = document.createElement('li');
        li.textContent = 'Ошибка данных персонажа';
        li.style.padding = '6px 10px';
        li.style.color = '#f44336';
        return li;
    }

    const li = document.createElement('li');
    li.style.display = 'flex';
    li.style.alignItems = 'center';
    li.style.gap = '8px';
    li.draggable = true;
    li.dataset.characterId = character.id;
    li.dataset.index = index;

    // Единый стиль выделения для портретов
    if (selectedCharacterId === character.id) {
        li.style.background = '#3a4a6b';
        li.style.borderLeft = '4px solid #4C5BEF';
    } else {
        li.style.background = '#2a2a3b';
        li.style.borderLeft = 'none';
    }

    li.style.padding = '6px 10px';
    li.style.borderRadius = '4px';
    li.style.marginBottom = '0';
    li.style.color = '#ccc';
    li.style.cursor = 'grab';
    li.style.position = 'relative';

    const portraitUrl = character.has_avatar
        ? (character.portrait_url || `/api/portrait/${character.id}`)
        : null;
    const pMedia = inferPortraitMedia(character);

    let avEl;
    if (character.has_avatar && portraitUrl) {
        if (pMedia === "video") {
            avEl = document.createElement("img");
            avEl.alt = "";
            applyMasterPortraitListVideoStaticFrame(avEl, portraitUrl);
        } else if (pMedia === "gif") {
            avEl = document.createElement("img");
            avEl.alt = "";
            applyMasterPortraitListGifStaticFrame(avEl, portraitUrl);
        } else {
            avEl = document.createElement("img");
            avEl.src = portraitUrl;
            avEl.alt = "";
        }
    } else {
        avEl = document.createElement("img");
        avEl.style.display = "none";
    }

    avEl.style.width = "32px";
    avEl.style.height = "32px";
    avEl.style.borderRadius = "4px";
    avEl.style.objectFit = "cover";
    avEl.draggable = false;

    avEl.onerror = () => {
        if (portraitUrl && !avEl.dataset._portraitRetry) {
            avEl.dataset._portraitRetry = "1";
            const sep = portraitUrl.includes("?") ? "&" : "?";
            avEl.src = `${portraitUrl}${sep}_retry=${Date.now()}`;
            return;
        }
        avEl.style.display = "none";
        const placeholder = document.createElement("span");
        placeholder.textContent = "👤";
        placeholder.style.fontSize = "24px";
        placeholder.style.lineHeight = "32px";
        placeholder.style.textAlign = "center";
        placeholder.style.width = "32px";
        placeholder.style.height = "32px";
        placeholder.style.backgroundColor = "#3a4a6b";
        placeholder.style.borderRadius = "4px";
        li.insertBefore(placeholder, avEl);
        avEl.remove();
    };

    // Имя с защитой от undefined
    const nameSpan = document.createElement('span');
    nameSpan.textContent = character.name || 'Безымянный';
    nameSpan.style.flex = '1';
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';
    nameSpan.style.whiteSpace = 'nowrap';
    nameSpan.style.color = '#ddd';

    // Кнопка-глаз
    const eye = document.createElement('span');
    eye.innerHTML = character.visible_to_players !== false ? getOpenEyeSVG() : getClosedEyeSVG();
    eye.style.cursor = 'pointer';
    eye.style.marginRight = '8px';
    eye.style.flexShrink = '0';
    eye.title = 'Видимость для игроков';

    eye.onclick = (e) => {
        e.stopPropagation();
        character.visible_to_players = !character.visible_to_players;
        saveMapData();
        refreshPortraits(); // Обновляем отображение
    };

    li.onclick = (e) => {
        if (e.target !== eye) {
            e.stopPropagation();
            selectedCharacterId = character.id;
            selectedTokenId = null;
            selectedFindId = null;
            selectedZoneId = null;
            clearSelectedVertex();
            selectedTokens.clear();
            refreshPortraits();
            render();
        }
    };

    li.appendChild(avEl);
    li.appendChild(nameSpan);
    li.appendChild(eye);

    return li;
}

function saveCurrentMapToStorage(mapId) {
    if (mapId) {
        localStorage.setItem('dnd_last_map_id', mapId);
        console.log('Saved map ID to storage:', mapId);
    } else {
        localStorage.removeItem('dnd_last_map_id');
    }
}

function loadCurrentMapFromStorage() {
    const mapId = localStorage.getItem('dnd_last_map_id');
    console.log('Loaded map ID from storage:', mapId);
    return mapId;
}


socket.on('connect', () => {
    console.log('Socket connected with ID:', socket.id);

    // Запускаем пинг для поддержания блокировки мастера
    if (masterPingInterval) {
        clearInterval(masterPingInterval);
    }

    masterPingInterval = setInterval(() => {
        socket.emit('master_ping');
    }, 10000); // Пинг каждые 10 секунд

    socket.emit('check_master_status');

    if (currentMapId) {
        socket.emit('join_map', { map_id: currentMapId });
    }
    setMasterMapIdGlobal();
});

socket.on('master_status', (data) => {
    console.log('Master status:', data);

    // Не сбрасывать пинг при !is_current: блокировка может кратковременно «моргнуть», а is_current — редкий кейс.
    // Остановка интервала только когда мастер явно неактивен (иначе вкладка остаётся без master_ping).
    if (data && data.active === false) {
        clearInterval(masterPingInterval);
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    try {
        if (typeof socket !== 'undefined' && socket && socket.connected) {
            socket.emit('master_ping');
        }
    } catch (_) {}
});

// В обработчике master_switched_map добавьте проверку
socket.on("master_switched_map", (data) => {
    console.log("Master received master_switched_map:", data);
    // Игнорируем, если это наше же событие (хотя мы должны получать только чужие)
    // Но на всякий случай проверим
    if (data.map_id === currentMapId) {
        console.log("Already on this map, ignoring");
        return;
    }

});

socket.on("player_visibility_change", (data) => {
    if (data && data.map_id === currentMapId && mapData) {
        mapData.player_map_enabled = data.player_map_enabled;
        if (window.updateMiniToggleIcon) window.updateMiniToggleIcon();
    }
});

socket.on("map_deleted", (data) => {
    if (!data) return;
    if (data.maps) {
        const select = document.getElementById("mapSelect");
        if (select) {
            select.innerHTML = "";
            if (data.maps.length === 0) {
                select.innerHTML = '<option value="">Нет карт</option>';
            } else {
                data.maps.forEach(m => {
                    const opt = document.createElement("option");
                    opt.value = m.id;
                    opt.textContent = m.name;
                    select.appendChild(opt);
                });
            }
        }
    }
    if (data.map_id === currentMapId) {
        const maps = data.maps || [];
        if (maps.length > 0) {
            switchMap(maps[0].id);
        } else {
            switchMap(null);
        }
    }
});

function syncGridInputs(value) {
    // Разрешаем дробные значения до десятых
    const num = parseFloat(value);

    // Проверка границ: от 5 до 150 клеток по ширине карты
    if (isNaN(num) || num < 5 || num > 150) {
        // Если значение выходит за пределы, корректируем его
        if (num < 5) {
            document.getElementById("gridSlider").value = 5;
            document.getElementById("gridInput").value = 5;
            updateWithValue(5);
        } else if (num > 150) {
            document.getElementById("gridSlider").value = 150;
            document.getElementById("gridInput").value = 150;
            updateWithValue(150);
        }
        return;
    }

    updateWithValue(num);
}

function updateWithValue(num) {
    // Обновляем поля ввода
    document.getElementById("gridSlider").value = num;
    document.getElementById("gridInput").value = num;

    // Проверяем, загружена ли карта
    if (mapImage && mapImage.complete && mapImage.naturalWidth > 0) {
        // Рассчитываем размер клетки в пикселях
        // cell_size = ширина карты / количество клеток
        const newCellSize = mapImage.naturalWidth / num;

        // Округляем до целого числа пикселей для практичности
        mapData.grid_settings.cell_size = Math.round(newCellSize);
        mapData.grid_settings.cell_count = num; // Сохраняем количество клеток

        console.log(`Карта шириной ${mapImage.naturalWidth}px, ${num} клеток = ${mapData.grid_settings.cell_size}px на клетку`);
    } else {
        // Если карта не загружена, используем примерное значение
        // Базовое предположение: ширина карты 2000px
        const estimatedWidth = 2000;
        mapData.grid_settings.cell_size = Math.round(estimatedWidth / num);
        mapData.grid_settings.cell_count = num;
        console.log(`Карта не загружена, используем примерное значение: ${mapData.grid_settings.cell_size}px на клетку`);
    }

    render();
    updateSliderVisual();

    saveMapData();
}

let editingTokenId = null;
let avatarChanged = false;
function submitToken() {
    console.log("submitToken called");

    const name = document.getElementById("tokenName").value;
    const avatarPreview = document.getElementById("avatarPreview");
    const avatarData = avatarPreview.dataset.base64 || null;
    const sizeSelect = document.getElementById("tokenSize");
    const tokenSize = sizeSelect ? sizeSelect.value : 'medium'; // НОВОЕ: размер

    console.log("Avatar data present:", !!avatarData);
    console.log("Token size:", tokenSize);

    const ac = parseInt(document.getElementById("tokenAC").value);
    const hp = parseInt(document.getElementById("tokenHP").value);
    const type = document.querySelector(".type-btn.active")?.dataset.type;

    if (!name || !type) return alert("Заполните все поля");

    if (window.tokenModalSaveInProgress) return;

    const addToBank = document.getElementById("addToBankCheckbox").checked;

    window.tokenModalSaveInProgress = true;
    setTokenModalSaveProgress(true, {
        indeterminate: true,
        text: editingTokenId ? "Сохраняем токен…" : "Создаём токен…",
    });

    if (editingTokenId) {
        editExistingToken(name, ac, hp, type, avatarData, addToBank, tokenSize);
    } else {
        createNewToken(name, ac, hp, type, avatarData, addToBank, tokenSize);
    }

    editingTokenId = null;
    avatarChanged = false;
}

function editExistingToken(name, ac, hp, type, avatarData, addToBank, tokenSize) {
    const token = mapData.tokens.find(t => t.id === editingTokenId);
    if (!token) return;

    const oldAvatar = token.avatar_url;
    const oldAvatarData = token.avatar_data;
    const oldHasAvatar = token.has_avatar;
    const avatarChangedNow = avatarData && avatarData !== oldAvatarData;

    token.name = name;
    token.armor_class = ac;
    token.max_health_points = hp;
    token.health_points = hp;
    token.is_player = type === "player";
    token.is_npc = type === "npc";

    // ВАЖНО: обновляем размер токена
    token.size = tokenSize;
    console.log(`Token size updated to: ${tokenSize}`);

    if (avatarChangedNow) {
        token.has_avatar = true;
        token.avatar_data = avatarData;
        console.log("Avatar changed for token:", editingTokenId);

        if (avatarCache.has(editingTokenId)) {
            avatarCache.delete(editingTokenId);
            console.log("Avatar cache cleared for token:", editingTokenId);
        }

        token.avatar_url = `/api/token/avatar/${editingTokenId}`;
    } else {
        token.has_avatar = oldHasAvatar;
        token.avatar_url = oldAvatar;
    }

    const addToCharacters = document.getElementById("addToCharactersCheckbox").checked;

    // Сначала обновляем токен на сервере
    const requestBody = {
        id: token.id,
        name: token.name,
        armor_class: token.armor_class,
        max_health_points: token.max_health_points,
        health_points: token.health_points,
        is_player: token.is_player,
        is_npc: token.is_npc,
        position: token.position,
        size: token.size,
        is_dead: token.is_dead,
        is_visible: token.is_visible,
        has_avatar: token.has_avatar,
        map_id: currentMapId
    };

    if (avatarChangedNow) {
        requestBody.avatar_data = avatarData;
    }

    fetch(`/api/token/${encodeURIComponent(editingTokenId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
    })
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json();
        })
        .then(() => {
            console.log("Token updated successfully");

            // PUT уже синкает на сервере и шлёт сокеты; дублируем POST /sync как страховку
            syncTokenAcrossMaps(token);

            // Обновляем в банке если нужно
            if (addToBank) {
                // ... существующий код для банка ...
            }

            let portraitChain = Promise.resolve();
            if (addToCharacters) {
                const ad = document.getElementById("avatarPreview").dataset.base64;
                if (ad) {
                    setTokenModalSaveProgress(true, {
                        indeterminate: true,
                        text: "Добавляем портрет…",
                    });
                    const portraitFile = window.pendingTokenPortraitFile;
                    const portraitMedia = window.pendingTokenPortraitMedia;
                    const characterId = `char_${Date.now()}`;
                    if (!mapData.characters) mapData.characters = [];
                    mapData.characters.push({
                        id: characterId,
                        name,
                        has_avatar: false,
                        visible_to_players: false,
                    });
                    portraitChain = saveMapData()
                        .then(() =>
                            postPortraitUploadForCharacter(
                                characterId,
                                ad,
                                portraitFile,
                                portraitMedia
                            )
                        )
                        .then((data) => {
                            const ch = mapData.characters.find(
                                (c) => c.id === characterId
                            );
                            if (ch && data.portrait_url) {
                                ch.portrait_url = data.portrait_url;
                                ch.has_avatar = true;
                            }
                            if (ch && data.portrait_media) {
                                ch.portrait_media = data.portrait_media;
                            }
                            clearTokenPendingPortrait();
                            refreshPortraits();
                            return saveMapData();
                        })
                        .catch((err) => {
                            console.error("Portrait from token edit:", err);
                            mapData.characters = (mapData.characters || []).filter(
                                (c) => c.id !== characterId
                            );
                            saveMapData().catch(() => {});
                        });
                }
            }

            return portraitChain;
        })
        .then(() => {
            endTokenModalSave();
            closeTokenModal();
            render();
            updateSidebar();
        })
        .catch(error => {
            console.error('Error updating token:', error);
            alert('Ошибка при обновлении токена');
        })
        .finally(() => endTokenModalSave());
}
function refreshCharacterList() {
    if (!mapData.characters) {
        mapData.characters = [];
    }

    // Переинициализируем drag & drop для портретов
    initCharacterDragAndDrop();

    // Обновляем сайдбар
    updateSidebar();

    console.log("Character list refreshed, count:", mapData.characters.length);
}

function createNewToken(name, ac, hp, type, avatarData, addToBank, tokenSize) {
    const centerX = mapImage.width ? mapImage.width / 2 : 500;
    const centerY = mapImage.height ? mapImage.height / 2 : 500;

    const tokenId = `token_${Date.now()}`;

    // Получаем выбранный размер
    const avatarUrl = avatarData ? `/api/token/avatar/${tokenId}` : null;

    const token = {
        id: tokenId,
        name,
        position: [centerX, centerY],
        size: tokenSize,  // Сохраняем строковый идентификатор размера
        is_dead: false,
        is_player: type === "player",
        is_npc: type === "npc",
        armor_class: ac,
        health_points: hp,
        max_health_points: hp,
        has_avatar: !!avatarData,
        avatar_url: avatarUrl,
        is_visible: true
    };

    const addToCharacters = document.getElementById("addToCharactersCheckbox").checked;
    let characterId = null;

    if (addToCharacters) {
        characterId = `char_${Date.now() + 1}`;
    }

    const requestBody = {
        ...token,
        avatar_data: avatarData,
        map_id: currentMapId
    };

    if (addToBank) {
        const bankCharData = {
            id: tokenId,
            name: name,
            type: type,
            armor_class: ac,
            max_health: hp,
            size: tokenSize,  // ВАЖНО: передаём размер в банк
            has_avatar: !!avatarData
        };

        fetch("/api/bank/character", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...bankCharData,
                avatar_data: avatarData
            })
        }).catch(err => console.error("Error adding to bank:", err));
    }

    fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
    })
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok: ' + response.status);
            }
            return response.json();
        })
        .then(data => {
            console.log("Token created successfully, response:", data);

            if (data.avatar_url) {
                token.avatar_url = data.avatar_url;
            }

            if (!mapData.tokens) mapData.tokens = [];
            mapData.tokens.push(token);

            if (avatarData && token.avatar_url) {
                const img = new Image();
                img.onload = () => {
                    avatarCache[tokenId] = img;
                    render();
                };
                img.onerror = () => {
                    console.warn(`Failed to load avatar for new token ${tokenId}`);
                };
                img.src = token.avatar_url;
            }

            render();
            updateSidebar();

            if (addToCharacters && avatarData) {
                setTokenModalSaveProgress(true, {
                    indeterminate: true,
                    text: "Добавляем портрет…",
                });
                const portraitFile = window.pendingTokenPortraitFile;
                const portraitMedia = window.pendingTokenPortraitMedia;
                return createCharacterFromToken(
                    name,
                    avatarData,
                    characterId,
                    portraitFile,
                    portraitMedia
                ).then(() => fetchMap());
            }
        })
        .then(() => {
            endTokenModalSave();
            closeTokenModal();
        })
        .catch(error => {
            console.error('Error:', error);
            alert('Ошибка при создании токена: ' + error.message);
        })
        .finally(() => endTokenModalSave());
}
function createCharacterFromToken(
    name,
    avatarData,
    characterId,
    portraitFile,
    portraitMedia
) {
    console.log("Creating character from token with ID:", characterId);

    if (!mapData.characters) mapData.characters = [];

    const character = {
        id: characterId,
        name,
        has_avatar: false,
        visible_to_players: false,
    };

    mapData.characters.push(character);

    return saveMapData()
        .then(() =>
            postPortraitUploadForCharacter(
                characterId,
                avatarData,
                portraitFile,
                portraitMedia
            )
        )
        .then((data) => {
            console.log("Portrait created from token successfully:", data);

            const ch = mapData.characters.find((c) => c.id === characterId);
            if (ch && data.portrait_url) {
                ch.portrait_url = data.portrait_url;
                ch.has_avatar = true;
            }
            if (ch && data.portrait_media) {
                ch.portrait_media = data.portrait_media;
            }

            updateSidebar();
            refreshPortraits();
            return saveMapData();
        })
        .catch((error) => {
            console.error("Error creating character from token:", error);
            mapData.characters = (mapData.characters || []).filter(
                (c) => c.id !== characterId
            );
            saveMapData().catch(() => {});
        })
        .finally(() => {
            clearTokenPendingPortrait();
        });
}



function autoUploadMap(input) {
    const formData = new FormData();
    formData.append("map_image", input.files[0]);

    fetch("/upload_map", {
        method: "POST",
        body: formData,
    }).then(() => {
        // После загрузки обновляем список карт
        fetch("/api/maps")
            .then(res => res.json())
            .then(maps => {
                const select = document.getElementById('mapSelect');
                if (!select) {
                    console.warn("mapSelect element not found; switching map without select update");
                    if (maps && maps.length > 0) {
                        if (currentMapId !== maps[0].id) {
                            switchMap(maps[0].id);
                        } else {
                            fetchMap();
                        }
                    }
                    return;
                }

                select.innerHTML = '';
                maps.forEach(map => {
                    const option = document.createElement('option');
                    option.value = map.id;
                    option.textContent = map.name;
                    select.appendChild(option);
                });
                if (maps.length > 0) {
                    select.value = maps[0].id;

                    // Важно: обновляем currentMapId если он изменился
                    if (currentMapId !== maps[0].id) {
                        switchMap(maps[0].id);
                    } else {
                        // Если это та же карта, просто обновляем изображение
                        fetchMap();
                    }
                }
            });

        // Сбрасываем input, чтобы можно было загрузить тот же файл снова
        input.value = '';
    });
}

function getOpenEyeSVG() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M2.062 12.348a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 19.876 0a1 1 0 0 1 0 .696a10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></g></svg>`;
}
function getClosedEyeSVG() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="m9.343 18.782l-1.932-.518l.787-2.939a11 11 0 0 1-3.237-1.872l-2.153 2.154l-1.414-1.414l2.153-2.154a10.96 10.96 0 0 1-2.371-5.07l1.968-.359a9.002 9.002 0 0 0 17.713 0l1.968.358a10.96 10.96 0 0 1-2.372 5.071l2.154 2.154l-1.414 1.414l-2.154-2.154a11 11 0 0 1-3.237 1.872l.788 2.94l-1.932.517l-.788-2.94a11 11 0 0 1-3.74 0z"/></svg>`;
}


// Добавить после функции updateSidebar() или в подходящем месте

function setupSidebarContextMenus() {
    // Для токенов
    const tokenList = document.getElementById("tokenList");
    if (tokenList) {
        tokenList.addEventListener("contextmenu", (e) => {
            const li = e.target.closest('li');
            if (!li) return;

            e.preventDefault();

            // Находим токен по имени или другим данным
            const nameSpan = li.querySelector('span:nth-child(2)');
            if (!nameSpan) return;

            const tokenName = nameSpan.textContent;
            const token = mapData.tokens.find(t => t.name === tokenName);

            if (token) {
                selectedTokenId = token.id;
                showTokenContextMenu(token, e.pageX, e.pageY);
            }
        });
    }

    // Для находок
    const findList = document.getElementById("findList");
    if (findList) {
        findList.addEventListener("contextmenu", (e) => {
            const li = e.target.closest('li');
            if (!li) return;

            e.preventDefault();

            const nameSpan = li.querySelector('span:first-child');
            if (!nameSpan) return;

            const findName = nameSpan.textContent;
            const find = mapData.finds.find(f => f.name === findName);

            if (find) {
                selectedFindId = find.id;
                showFindContextMenu(find, e.pageX, e.pageY);
            }
        });
    }

    // Для зон
    const zoneList = document.getElementById("zoneList");
    if (zoneList) {
        zoneList.addEventListener("contextmenu", (e) => {
            const li = e.target.closest('li');
            if (!li) return;

            e.preventDefault();

            const nameSpan = li.querySelector('span:first-child');
            if (!nameSpan) return;

            const zoneName = nameSpan.textContent;
            const zone = mapData.zones.find(z => z.name === zoneName);

            if (zone) {
                selectedZoneId = zone.id;
                clearSelectedVertex();
                showZoneContextMenu(zone, e.pageX, e.pageY);
            }
        });
    }

    // Для портретов
    const characterList = document.getElementById("characterList");
    if (characterList) {
        characterList.addEventListener("contextmenu", (e) => {
            const li = e.target.closest('li');
            if (!li) return;

            e.preventDefault();

            const characterId = li.dataset.characterId;
            const character = mapData.characters?.find(c => c.id === characterId);

            if (character) {
                selectedCharacterId = character.id;
                showCharacterContextMenu(character, e.pageX, e.pageY);
            }
        });
    }
}

// Функция для контекстного меню персонажа (портрета)
function showCharacterContextMenu(character, x, y) {
    const menu = document.getElementById("characterContextMenu") || createCharacterContextMenu();

    document.getElementById("contextCharacterName").textContent = character.name;
    document.getElementById("contextCharacterVisible").checked = character.visible_to_players !== false;

    // Добавляем кнопку редактирования
    const editBtn = document.getElementById("contextEditCharacter");
    if (editBtn) {
        editBtn.onclick = () => {
            openEditCharacterModal(character);
            menu.style.display = "none";
        };
    }

    menu.style.display = "block";
    menu.style.visibility = "hidden";

    const menuRect = menu.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    let left = x;
    let top = y;

    if (left + menuRect.width > windowWidth) {
        left = windowWidth - menuRect.width - 10;
    }
    if (top + menuRect.height > windowHeight) {
        top = windowHeight - menuRect.height - 10;
    }
    if (left < 10) left = 10;
    if (top < 10) top = 10;

    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "visible";

    window.currentContextCharacter = character;
}

function createCharacterContextMenu() {
    const menu = document.createElement('div');
    menu.id = 'characterContextMenu';
    menu.className = 'context-menu';
    menu.innerHTML = `
        <div class="context-menu-header">
            <span id="contextCharacterName"></span>
        </div>
        
        <div class="context-menu-section">
            <label class="context-checkbox">
                <input type="checkbox" id="contextCharacterVisible">
                <span class="checkbox-custom"></span>
                <span>Виден игрокам</span>
            </label>
        </div>

        <div class="context-menu-section">
            <button class="context-menu-item" id="contextEditCharacter">
                <span class="context-icon">✎</span> Редактировать
            </button>
            <button class="context-menu-item delete" id="contextDeleteCharacter">
                <span class="context-icon">🗑️</span> Удалить
            </button>
        </div>
    `;

    document.body.appendChild(menu);

    // Обработчик видимости
    document.getElementById("contextCharacterVisible").addEventListener("change", function (e) {
        if (window.currentContextCharacter) {
            window.currentContextCharacter.visible_to_players = e.target.checked;
            updateSidebar();
            saveMapData();

            // Уведомляем игроков
            socket.emit("characters_updated", {
                map_id: currentMapId,
                characters: mapData.characters
            });
        }
    });

    // Обработчик удаления
    document.getElementById("contextDeleteCharacter").addEventListener("click", function () {
        if (window.currentContextCharacter && confirm(`Удалить портрет "${window.currentContextCharacter.name}"?`)) {
            // Удаляем файл аватара с сервера
            fetch(`/api/portrait/${window.currentContextCharacter.id}`, {
                method: 'DELETE'
            }).catch(err => console.error('Error deleting portrait:', err));

            // Удаляем из локальных данных
            mapData.characters = mapData.characters.filter(c => c.id !== window.currentContextCharacter.id);
            selectedCharacterId = null;

            // Сохраняем изменения
            saveMapData().then(() => {
                render();
                updateSidebar();
                initCharacterDragAndDrop();

                // Уведомляем игроков
                socket.emit("characters_updated", {
                    map_id: currentMapId,
                    characters: mapData.characters
                });
            });

            menu.style.display = "none";
        }
    });

    return menu;
}

/** Состояние DnD списков зон/токенов/находок — тот же UX, что у портретов (полоски .drop-zone). */
const masterSidebarListDnD = {
    draggedItem: null,
    draggedIndex: -1,
    draggedUl: null,
    draggedMapKey: null,
    activeDropZone: null,
    lastDropTargetIndex: null,
};

function removeMasterSidebarDropZones() {
    if (masterSidebarListDnD.draggedUl) {
        masterSidebarListDnD.draggedUl.querySelectorAll(".drop-zone").forEach((z) => z.remove());
    }
    masterSidebarListDnD.activeDropZone = null;
    masterSidebarListDnD.lastDropTargetIndex = null;
}

function getMasterSidebarDropTargetIndex(ul, e) {
    const rect = ul.getBoundingClientRect();
    const mouseY = e.clientY;
    if (mouseY < rect.top || mouseY > rect.bottom) return null;
    const items = ul.querySelectorAll(":scope > li");
    if (items.length === 0) return 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemRect = item.getBoundingClientRect();
        if (mouseY <= itemRect.bottom) {
            if (i === 0 && mouseY < itemRect.top + itemRect.height / 2) {
                return 0;
            }
            if (mouseY > itemRect.top + itemRect.height / 2) {
                return i + 1;
            }
            return i;
        }
    }
    return items.length;
}

function updateMasterSidebarDropZone(e) {
    if (!masterSidebarListDnD.draggedItem || !masterSidebarListDnD.draggedUl) return;
    const ul = masterSidebarListDnD.draggedUl;
    const targetIndex = getMasterSidebarDropTargetIndex(ul, e);
    if (targetIndex === null) {
        removeMasterSidebarDropZones();
        return;
    }
    if (
        masterSidebarListDnD.lastDropTargetIndex === targetIndex &&
        masterSidebarListDnD.activeDropZone
    ) {
        return;
    }
    removeMasterSidebarDropZones();
    const items = ul.querySelectorAll(":scope > li");
    const dropZone = document.createElement("div");
    dropZone.className = "drop-zone active";
    dropZone.dataset.targetIndex = String(targetIndex);
    dropZone.style.height = "8px";
    dropZone.style.background = "#4C5BEF";
    dropZone.style.margin = "4px 0";
    dropZone.style.boxShadow = "0 0 10px #4C5BEF";
    dropZone.style.borderRadius = "4px";
    dropZone.style.width = "100%";
    dropZone.style.transition = "all 0.2s ease";
    masterSidebarListDnD.lastDropTargetIndex = targetIndex;
    masterSidebarListDnD.activeDropZone = dropZone;

    if (items.length === 0) {
        ul.appendChild(dropZone);
    } else if (targetIndex === 0) {
        ul.insertBefore(dropZone, items[0]);
    } else if (targetIndex >= items.length) {
        ul.appendChild(dropZone);
    } else {
        ul.insertBefore(dropZone, items[targetIndex]);
    }
}

function completeMasterSidebarListDrag(e) {
    const di = masterSidebarListDnD.draggedItem;
    const idx = masterSidebarListDnD.draggedIndex;
    const lt = masterSidebarListDnD.lastDropTargetIndex;
    const mk = masterSidebarListDnD.draggedMapKey;
    if (di && lt !== null && idx !== -1 && mk) {
        if (e) e.preventDefault();
        let newIndex = lt;
        if (idx < newIndex) newIndex -= 1;
        if (idx !== newIndex) {
            const arr = mapData[mk];
            if (Array.isArray(arr) && idx >= 0 && idx < arr.length) {
                const [removed] = arr.splice(idx, 1);
                arr.splice(newIndex, 0, removed);
                saveMapData();
                updateSidebar();
                render();
            }
        }
    }
    removeMasterSidebarDropZones();
    if (di) di.classList.remove("dragging");
    masterSidebarListDnD.draggedItem = null;
    masterSidebarListDnD.draggedIndex = -1;
    masterSidebarListDnD.draggedUl = null;
    masterSidebarListDnD.draggedMapKey = null;
    masterSidebarListDnD.activeDropZone = null;
    masterSidebarListDnD.lastDropTargetIndex = null;
}

function masterSidebarListDocumentDragOver(e) {
    if (!masterSidebarListDnD.draggedItem) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    updateMasterSidebarDropZone(e);
}

function masterSidebarListDocumentDragEnd(e) {
    if (!masterSidebarListDnD.draggedItem) return;
    completeMasterSidebarListDrag(e);
}

function initMasterSidebarListsDragOnce() {
    if (window.__masterSidebarListsPortraitDnD) return;

    const configs = [
        { id: "zoneList", key: "zones" },
        { id: "tokenList", key: "tokens" },
        { id: "findList", key: "finds" },
    ];
    const anyUl = configs.some(({ id }) => document.getElementById(id));
    if (!anyUl) return;

    window.__masterSidebarListsPortraitDnD = true;

    document.addEventListener("dragover", masterSidebarListDocumentDragOver);
    document.addEventListener("dragend", masterSidebarListDocumentDragEnd);

    configs.forEach(({ id, key }) => {
        const ul = document.getElementById(id);
        if (!ul) return;

        ul.addEventListener("dragstart", (e) => {
            const li = e.target.closest("li");
            if (!li || li.parentElement !== ul) return;
            const fromIndex = parseInt(li.dataset.sidebarIndex, 10);
            if (Number.isNaN(fromIndex)) return;
            masterSidebarListDnD.draggedItem = li;
            masterSidebarListDnD.draggedIndex = fromIndex;
            masterSidebarListDnD.draggedUl = ul;
            masterSidebarListDnD.draggedMapKey = key;
            li.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.dropEffect = "move";
            e.dataTransfer.setData(
                "text/plain",
                li.dataset.zoneId || li.dataset.tokenId || li.dataset.findId || ""
            );
            e.dataTransfer.setDragImage(new Image(), 0, 0);
        });

        ul.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (masterSidebarListDnD.draggedItem) {
                updateMasterSidebarDropZone(e);
            }
        });

        ul.addEventListener("dragleave", () => {});

        ul.addEventListener("drop", (e) => {
            e.preventDefault();
            completeMasterSidebarListDrag(e);
        });
    });
}

// Обновляем существующую updateSidebar для добавления data-атрибутов
// static/js/map.js - Исправленная функция updateSidebar()

function updateSidebar() {
    // Зоны
    const zoneList = document.getElementById("zoneList");
    zoneList.innerHTML = "";

    mapData.zones.forEach((zone, index) => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";
        li.dataset.sidebarIndex = String(index);

        // Только один стиль выделения - цвет фона
        if (selectedZoneId === zone.id) {
            li.style.background = "#3a4a6b";
            li.style.borderLeft = "4px solid #4C5BEF";
        } else {
            li.style.background = "#2a2a3b";
            li.style.borderLeft = "none";
        }

        li.style.padding = "6px 10px";
        li.style.borderRadius = "4px";
        li.style.marginBottom = "0";
        li.style.cursor = "grab";
        li.style.position = "relative";
        li.draggable = true;
        li.dataset.zoneId = zone.id;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = zone.name;
        nameSpan.style.overflow = "hidden";
        nameSpan.style.textOverflow = "ellipsis";
        nameSpan.style.whiteSpace = "nowrap";
        nameSpan.style.color = "#ddd";
        nameSpan.style.flex = "1";

        const eye = document.createElement("span");
        eye.innerHTML = zone.is_visible ? getOpenEyeSVG() : getClosedEyeSVG();
        eye.style.cursor = "pointer";
        eye.style.flexShrink = "0";
        eye.title = "Показать/скрыть зону";
        eye.onclick = (e) => {
            e.stopPropagation();
            zone.is_visible = !zone.is_visible;
            saveMapData();
            updateSidebar();
            render();
        };

        li.onclick = (e) => {
            e.stopPropagation();
            selectedZoneId = zone.id;
            selectedTokenId = null;
            selectedFindId = null;
            selectedCharacterId = null;
            clearSelectedVertex();
            selectedTokens.clear();
            updateSidebar();
            render();
        };

        li.appendChild(nameSpan);
        li.appendChild(eye);
        zoneList.appendChild(li);
    });

    // Токены
    const tokenList = document.getElementById("tokenList");
    tokenList.innerHTML = "";

    mapData.tokens.forEach((token, index) => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";
        li.style.gap = "8px";
        li.dataset.sidebarIndex = String(index);

        // Единый стиль выделения для токенов
        if (selectedTokens.has(token.id)) {
            // Множественное выделение
            li.style.background = "#3a4a6b";
            li.style.borderLeft = "4px solid #4C5BEF";
        } else if (selectedTokenId === token.id) {
            // Одиночное выделение
            li.style.background = "#3a4a6b";
            li.style.borderLeft = "4px solid #4C5BEF";
        } else {
            // Без выделения
            li.style.background = "#2a2a3b";
            li.style.borderLeft = "none";
        }

        li.style.padding = "6px 10px";
        li.style.borderRadius = "4px";
        li.style.marginBottom = "0";
        li.style.color = "#ccc";
        li.style.cursor = "grab";
        li.style.position = "relative";
        li.draggable = true;
        li.dataset.tokenId = token.id;

        const dot = document.createElement("span");
        dot.style.display = "inline-block";
        dot.style.width = "10px";
        dot.style.height = "10px";
        dot.style.borderRadius = "50%";
        dot.style.backgroundColor = token.is_player
            ? "#4CAF50"
            : token.is_npc
                ? "#FFC107"
                : "#F44336";

        const nameSpan = document.createElement("span");
        nameSpan.style.flex = "1";
        nameSpan.style.overflow = "hidden";
        nameSpan.style.textOverflow = "ellipsis";
        nameSpan.style.whiteSpace = "nowrap";
        nameSpan.textContent = token.name;

        const acSpan = document.createElement("span");
        acSpan.style.minWidth = "40px";
        acSpan.style.textAlign = "right";
        acSpan.style.color = "#aaa";
        acSpan.textContent = `${token.armor_class || 10} КД`;

        const hpSpan = document.createElement("span");
        const hp = token.health_points ?? 10;
        const max = token.max_health_points ?? 10;

        if (token.is_dead || hp <= 0) {
            hpSpan.textContent = "МЁРТВ";
            hpSpan.style.color = "#e53935";
        } else {
            const percent = hp / max;
            hpSpan.textContent = `${hp}/${max} ОЗ`;
            hpSpan.style.color =
                percent > 0.8 ? "#4CAF50" :
                    percent > 0.4 ? "#FFC107" :
                        "#F44336";
        }

        const eye = document.createElement("span");
        eye.innerHTML = token.is_visible !== false ? getOpenEyeSVG() : getClosedEyeSVG();
        eye.style.cursor = "pointer";
        eye.style.flexShrink = "0";
        eye.title = "Видимость для игроков";
        eye.onclick = (e) => {
            e.stopPropagation();
            token.is_visible = !token.is_visible;
            saveMapData();
            updateSidebar();
            render();
            syncTokenAcrossMaps(token);
        };

        // Клик на элемент токена с поддержкой Shift
        li.onclick = (e) => {
            e.stopPropagation();

            if (e.shiftKey) {
                // Shift + клик - переключаем выделение
                if (selectedTokens.has(token.id)) {
                    selectedTokens.delete(token.id);
                } else {
                    selectedTokens.add(token.id);
                }
                // При мультивыделении не устанавливаем selectedTokenId
                selectedTokenId = null;
            } else {
                // Обычный клик - сбрасываем множественное и выделяем этот токен
                selectedTokens.clear();
                selectedTokenId = token.id;
                selectedTokens.add(token.id);
            }

            // Снимаем выделение с других объектов
            selectedZoneId = null;
            selectedFindId = null;
            selectedCharacterId = null;
            clearSelectedVertex();

            updateSidebar();
            render();
        };

        li.appendChild(dot);
        li.appendChild(nameSpan);
        li.appendChild(acSpan);
        li.appendChild(hpSpan);
        li.appendChild(eye);
        tokenList.appendChild(li);
    });

    // Находки
    const findList = document.getElementById("findList");
    findList.innerHTML = "";

    mapData.finds.forEach((find, index) => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";
        li.dataset.sidebarIndex = String(index);

        // Единый стиль выделения для находок
        if (selectedFindId === find.id) {
            li.style.background = "#3a4a6b";
            li.style.borderLeft = "4px solid #4C5BEF";
        } else {
            li.style.background = "#2a2a3b";
            li.style.borderLeft = "none";
        }

        li.style.padding = "6px 10px";
        li.style.borderRadius = "4px";
        li.style.marginBottom = "0";
        li.style.cursor = "grab";
        li.style.position = "relative";
        li.draggable = true;
        li.dataset.findId = find.id;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = find.name;
        nameSpan.style.overflow = "hidden";
        nameSpan.style.textOverflow = "ellipsis";
        nameSpan.style.whiteSpace = "nowrap";
        nameSpan.style.color = "#ddd";
        nameSpan.style.flex = "1";

        const statusSpan = document.createElement("span");
        statusSpan.style.fontSize = "14px";
        statusSpan.style.flexShrink = "0";

        if (find.status) {
            statusSpan.textContent = "Осмотрено";
            statusSpan.style.color = "#4CAF50";
        } else {
            statusSpan.textContent = "";
        }

        li.onclick = (e) => {
            e.stopPropagation();
            selectedFindId = find.id;
            selectedTokenId = null;
            selectedZoneId = null;
            selectedCharacterId = null;
            clearSelectedVertex();
            selectedTokens.clear();
            updateSidebar();
            render();
        };

        li.appendChild(nameSpan);
        li.appendChild(statusSpan);
        findList.appendChild(li);
    });

    // Портреты персонажей
    // const characterList = document.getElementById("characterList");
    // characterList.innerHTML = "";

    // mapData.characters?.forEach(character => {
    //     const li = document.createElement("li");
    //     li.style.display = "flex";
    //     li.style.alignItems = "center";
    //     li.style.gap = "8px";

    //     // Единый стиль выделения для портретов
    //     if (selectedCharacterId === character.id) {
    //         li.style.background = "#3a4a6b";
    //         li.style.borderLeft = "4px solid #4C5BEF";
    //     } else {
    //         li.style.background = "#2a2a3b";
    //         li.style.borderLeft = "none";
    //     }

    //     li.style.padding = "6px 10px";
    //     li.style.borderRadius = "4px";
    //     li.style.marginBottom = "4px";
    //     li.style.color = "#ccc";
    //     li.style.cursor = "pointer";
    //     li.dataset.characterId = character.id;

    //     // аватар
    //     const img = document.createElement("img");
    //     if (character.has_avatar) {
    //         const portraitUrl = character.portrait_url || `/api/portrait/${character.id}`;
    //         img.src = `${portraitUrl}?t=${Date.now()}`;
    //     }
    //     img.style.width = "32px";
    //     img.style.height = "32px";
    //     img.style.borderRadius = "4px";
    //     img.style.objectFit = "cover";

    //     img.onerror = () => {
    //         img.style.display = "none";
    //     };

    //     // имя
    //     const nameSpan = document.createElement("span");
    //     nameSpan.textContent = character.name;
    //     nameSpan.style.flex = "1";
    //     nameSpan.style.overflow = "hidden";
    //     nameSpan.style.textOverflow = "ellipsis";
    //     nameSpan.style.whiteSpace = "nowrap";
    //     nameSpan.style.color = "#ddd";

    //     // кнопка-глаз
    //     const eye = document.createElement("span");
    //     eye.innerHTML = character.visible_to_players !== false ? getOpenEyeSVG() : getClosedEyeSVG();
    //     eye.style.cursor = "pointer";
    //     eye.style.marginRight = "8px";
    //     eye.title = "Видимость для игроков";

    //     eye.onclick = (e) => {
    //         e.stopPropagation();
    //         character.visible_to_players = !character.visible_to_players;
    //         updateSidebar();
    //         saveMapData();
    //     };

    //     li.onclick = (e) => {
    //         e.stopPropagation();
    //         selectedCharacterId = character.id;
    //         selectedTokenId = null;
    //         selectedFindId = null;
    //         selectedZoneId = null;
    //         selectedTokens.clear();
    //         updateSidebar();
    //     };

    //     li.appendChild(img);
    //     li.appendChild(nameSpan);
    //     li.appendChild(eye);
    //     characterList.appendChild(li);
    // });
    initMasterSidebarListsDragOnce();
    initCharacterDragAndDrop();
    // Настраиваем контекстные меню
    setupSidebarContextMenus();
}


let currentMapId = null;

function syncPlayerMiniIframe() {
    const iframe = document.getElementById("playerMini");
    if (!iframe) return;
    const pid = window.__DND_PROJECT_ID__;
    if (currentMapId && pid) {
        iframe.src = `/player?map_id=${encodeURIComponent(currentMapId)}&project_id=${encodeURIComponent(pid)}`;
    } else if (currentMapId) {
        iframe.src = `/player?map_id=${encodeURIComponent(currentMapId)}`;
    } else {
        iframe.src = "/player?no_map=1";
    }
}

function setMasterMapIdGlobal() {
    window.masterCurrentMapId = currentMapId;
}

function checkMapExists() {
    if (!currentMapId) {
        // Показываем сообщение о необходимости создать карту
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Нет активной карты. Создайте новую или загрузите изображение",
            canvas.width / 2, canvas.height / 2);
        return false;
    }
    return true;
}
function switchMap(mapId) {
    console.log("switchMap called with:", mapId);

    saveCurrentMapToStorage(mapId);
    updateActiveMapInList(mapId);

    avatarCache.clear();

    if (!mapId) {
        _switchMapGen++;
        isSwitchingMap = false;
        currentMapId = null;
        resetDrawingStateForNewMap();
        mapData = {
            tokens: [],
            finds: [],
            zones: [],
            characters: [],
            combat: null,
            grid_settings: {
                cell_count: 20,
                cell_size: 20,
                color: "#888888",
                visible: false,
                visible_to_players: true
            }
        };
        mapImage = new Image();
        invalidateBg();
        render();
        updateSidebar();
        refreshPortraits();
        if (window.updateMiniToggleIcon) window.updateMiniToggleIcon();
        syncPlayerMiniIframe();
        setMasterMapIdGlobal();
        socket.emit("switch_map", { map_id: null });
        return;
    }

    if (isSwitchingMap) {
        return;
    }

    isSwitchingMap = true;
    const opGen = ++_switchMapGen;

    fetch(`/api/map/${mapId}`)
        .then(res => {
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            return res.json();
        })
        .then(data => {
            if (opGen !== _switchMapGen) {
                isSwitchingMap = false;
                return Promise.reject("stale");
            }
            if (data.error) {
                console.error(data.error);
                isSwitchingMap = false;
                return Promise.reject(new Error(data.error));
            }

            // base64 больше не приходит — убеждаемся что не осталось в старых данных
            delete data.map_image_base64;
            mapData = data;
            currentMapId = mapId;
            if (mapData.combat === undefined) mapData.combat = null;

            // Убеждаемся, что grid_settings.visible_to_players определен
            if (mapData.grid_settings && mapData.grid_settings.visible_to_players === undefined) {
                mapData.grid_settings.visible_to_players = true;
            }

            // Проверяем границы cell_count
            if (mapData.grid_settings && mapData.grid_settings.cell_count) {
                if (mapData.grid_settings.cell_count < 5) mapData.grid_settings.cell_count = 5;
                if (mapData.grid_settings.cell_count > 150) mapData.grid_settings.cell_count = 150;
            }

            // ВАЖНО: сначала устанавливаем сохранённые значения
            zoomLevel = mapData.zoom_level || 1;
            panX = mapData.pan_x || 0;
            panY = mapData.pan_y || 0;

            console.log(`Restored position: zoom=${zoomLevel}, pan=(${panX}, ${panY})`);

            updateSidebar();
            refreshPortraits();

            // Синхронизируем поля ввода с cell_count
            const gridCount = mapData.grid_settings.cell_count || 20;
            document.getElementById("gridSlider").value = gridCount;
            document.getElementById("gridInput").value = gridCount;

            // !!! ВАЖНО: Обновляем визуальное отображение ползунка !!!
            updateSliderVisual();

            const gridToggle = document.getElementById("gridToggle");
            gridToggle.classList.toggle("active", mapData.grid_settings.visible);

            const playerGridToggle = document.getElementById("playerGridToggle");
            if (mapData.grid_settings.visible_to_players !== false) {
                playerGridToggle.classList.add("active");
            } else {
                playerGridToggle.classList.remove("active");
            }

            const playerRulerToggle = document.getElementById("playerRulerToggle");
            playerRulerToggle.classList.toggle("active", mapData.ruler_visible_to_players);

            resetDrawingStateForNewMap();

            return fetchAndApplyDrawingsForMap(mapId);
        })
        .then(() => {
            if (opGen !== _switchMapGen) {
                isSwitchingMap = false;
                return;
            }
            socket.emit("switch_map", { map_id: mapId });
            socket.emit("join_map", { map_id: mapId });

            const toggleBtn = document.getElementById("togglePlayerMini");
            if (toggleBtn) {
                toggleBtn.innerHTML =
                    mapData.player_map_enabled !== false
                        ? getOpenEyeSVG()
                        : getClosedEyeSVG();
            }

            if (mapData.has_image) {
                const imageUrl = mapData.image_url || `/api/map/image/${mapId}`;
                dndCache.fetch(imageUrl).then(src => {
                    if (opGen !== _switchMapGen) {
                        isSwitchingMap = false;
                        return;
                    }
                    mapImage = new Image();
                    mapImage.onload = () => {
                        if (opGen !== _switchMapGen) return;
                        invalidateBg();
                        updateGridFromImage();
                        render();
                        isSwitchingMap = false;
                    };
                    mapImage.onerror = () => {
                        if (opGen !== _switchMapGen) return;
                        render();
                        isSwitchingMap = false;
                    };
                    mapImage.src = src || imageUrl;
                }).catch(() => {
                    if (opGen !== _switchMapGen) {
                        isSwitchingMap = false;
                        return;
                    }
                    render();
                    isSwitchingMap = false;
                });
            } else {
                mapImage = new Image();
                render();
                isSwitchingMap = false;
            }
            syncPlayerMiniIframe();
            setMasterMapIdGlobal();
        })
        .catch(err => {
            if (err !== "stale") {
                console.error("Error switching map:", err);
            }
            isSwitchingMap = false;
        });
}
function createNewMap() {
    document.getElementById('newMapModal').style.display = 'flex';
    document.getElementById('newMapName').value = '';
}

function closeNewMapModal() {
    document.getElementById('newMapModal').style.display = 'none';
}

function submitNewMap() {
    const name = document.getElementById('newMapName').value.trim() || 'Новая карта';

    fetch('/api/map/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
    })
        .then(res => res.json())
        .then(data => {
            closeNewMapModal();

            const select = document.getElementById('mapSelect');
            if (select) {
                select.innerHTML = '';
                data.maps.forEach(map => {
                    const option = document.createElement('option');
                    option.value = map.id;
                    option.textContent = map.name;
                    if (map.id === data.map_id) option.selected = true;
                    select.appendChild(option);
                });
            } else {
                console.warn("mapSelect element not found; skipping option update");
            }

            // СОХРАНЯЕМ ID НОВОЙ КАРТЫ
            saveCurrentMapToStorage(data.map_id);

            switchMap(data.map_id);
        });
}

function deleteCurrentMap() {
    if (!currentMapId) return;

    if (!confirm('Вы уверены, что хотите удалить эту карту?')) return;

    fetch(`/api/map/delete/${currentMapId}`, {
        method: 'DELETE'
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'ok') {
                const select = document.getElementById('mapSelect');
                if (!select) {
                    console.warn("mapSelect element not found; skipping delete select update");
                } else {
                    select.innerHTML = '';
                }

                if (data.maps.length > 0) {
                    data.maps.forEach(map => {
                        const option = document.createElement('option');
                        option.value = map.id;
                        option.textContent = map.name;
                        if (map.id === data.maps[0].id) option.selected = true;
                        if (select) select.appendChild(option);
                    });

                    // СОХРАНЯЕМ ID ПЕРВОЙ КАРТЫ
                    saveCurrentMapToStorage(data.maps[0].id);

                    switchMap(data.maps[0].id);
                } else {
                    // Нет карт
                    if (select) select.innerHTML = '<option value="">Нет карт</option>';

                    // ОЧИЩАЕМ STORAGE
                    localStorage.removeItem('dnd_last_map_id');

                    switchMap(null);
                }
            }
        });
}

let _debouncedSaveTimer = null;
function debouncedSave(delay = 500) {
    clearTimeout(_debouncedSaveTimer);
    _debouncedSaveTimer = setTimeout(() => saveMapData(), delay);
}

function saveMapData() {
    const { map_image_base64, ...rest } = mapData;
    const dataToSave = {
        ...rest,
        map_id: currentMapId
    };
    if (dataToSave.tokens) {
        dataToSave.tokens = dataToSave.tokens.map(t => {
            const { avatar_data, ...clean } = t;
            return clean;
        });
    }
    if (dataToSave.characters) {
        dataToSave.characters = dataToSave.characters.map(c => {
            const { avatar_data, ...clean } = c;
            return clean;
        });
    }

    return fetch("/api/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dataToSave),
    }).then(response => {
        if (!response.ok) {
            throw new Error('Failed to save map data');
        }

        // Защита от отсутствия элемента mapSelect
        const select = document.getElementById('mapSelect');
        if (select && currentMapId) {
            const currentOption = select.querySelector(`option[value="${currentMapId}"]`);
            if (currentOption && mapData.name) {
                currentOption.textContent = mapData.name;
            }
        } else {
            console.log('mapSelect element not found or currentMapId missing, skipping option update');
        }

        return response.json();
    });
}

// ─── Бой / инициатива ───
function combatIsTokenInCombat(tokenId) {
    const c = mapData && mapData.combat;
    return !!(c && c.active && Array.isArray(c.entries) && c.entries.some((e) => e.id === tokenId));
}

function combatJoinToken(tokenId) {
    if (!mapData.combat || !mapData.combat.active) return;
    if (!Array.isArray(mapData.combat.entries)) mapData.combat.entries = [];
    if (mapData.combat.entries.some((e) => e.id === tokenId)) return;
    mapData.combat.entries.push({ id: tokenId, initiative: 0 });
}

function combatLeaveToken(tokenId) {
    if (!mapData.combat || !Array.isArray(mapData.combat.entries)) return;
    mapData.combat.entries = mapData.combat.entries.filter((e) => e.id !== tokenId);
}

/** После смены инициативы: выше значение — левее в полосе; равные — прежний порядок. */
function resortCombatEntriesByInitiative() {
    if (!mapData.combat || !Array.isArray(mapData.combat.entries)) return;
    const arr = mapData.combat.entries;
    arr.forEach((e, i) => {
        e._tie = i;
    });
    arr.sort((a, b) => {
        const di = (b.initiative ?? 0) - (a.initiative ?? 0);
        if (di !== 0) return di;
        return a._tie - b._tie;
    });
    arr.forEach((e) => delete e._tie);
}

let initiativeStripMenuTokenId = null;

function hideInitiativeStripContextMenu() {
    initiativeStripMenuTokenId = null;
    const m = document.getElementById("initiativeStripContextMenu");
    if (m) m.style.display = "none";
}

function showInitiativeStripContextMenu(clientX, clientY, tokenId, tokenName) {
    hideInitiativeStripContextMenu();
    initiativeStripMenuTokenId = tokenId;
    const menu = document.getElementById("initiativeStripContextMenu");
    const nameEl = document.getElementById("initiativeStripContextName");
    if (!menu) return;
    if (nameEl) nameEl.textContent = tokenName || "Токен";

    menu.style.position = "fixed";
    menu.style.display = "block";
    menu.style.visibility = "hidden";

    const rect = menu.getBoundingClientRect();
    let left = clientX;
    let top = clientY;
    if (left + rect.width > window.innerWidth - 8) {
        left = window.innerWidth - rect.width - 8;
    }
    if (top + rect.height > window.innerHeight - 8) {
        top = window.innerHeight - rect.height - 8;
    }
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.visibility = "visible";

    const tm = document.getElementById("tokenContextMenu");
    if (tm) tm.style.display = "none";
    const fm = document.getElementById("findContextMenu");
    if (fm) fm.style.display = "none";
    const zm = document.getElementById("zoneContextMenu");
    if (zm) zm.style.display = "none";
}

function combatMoveRevivedTokenToEnd(tokenId) {
    if (!mapData || !mapData.combat || !mapData.combat.active || !Array.isArray(mapData.combat.entries)) return;
    const idx = mapData.combat.entries.findIndex((e) => e.id === tokenId);
    if (idx < 0) return;
    const [ent] = mapData.combat.entries.splice(idx, 1);
    mapData.combat.entries.push(ent);
}

function syncCombatToolbarButton() {
    const btn = document.getElementById("combatToggle");
    if (!btn) return;
    btn.classList.toggle("active", !!(mapData && mapData.combat && mapData.combat.active));
}

function initiativeStripTypeClass(token) {
    if (token.is_player) return "initiative-strip-item--hero";
    if (token.is_npc) return "initiative-strip-item--npc";
    return "initiative-strip-item--enemy";
}

function fillInitiativeStrip(stripEl, data) {
    hideInitiativeStripContextMenu();
    if (!stripEl) return;
    const parent = stripEl.parentElement;
    const combat = data && data.combat;
    const tokens = (data && data.tokens) || [];

    if (!combat || !combat.active || !Array.isArray(combat.entries) || combat.entries.length === 0) {
        stripEl.style.display = "none";
        stripEl.innerHTML = "";
        if (parent) parent.classList.remove("has-initiative-strip");
        return;
    }

    const byId = new Map(tokens.map((t) => [t.id, t]));
    stripEl.style.display = "flex";
    stripEl.innerHTML = "";
    if (parent) parent.classList.add("has-initiative-strip");

    for (const ent of combat.entries) {
        const tok = byId.get(ent.id);
        if (!tok) continue;
        const hp = tok.health_points ?? 0;
        const dead = tok.is_dead || hp <= 0;
        if (dead) continue;

        const item = document.createElement("div");
        item.className = `initiative-strip-item ${initiativeStripTypeClass(tok)}`;
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

        item.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!mapData.combat || !mapData.combat.active) return;
            showInitiativeStripContextMenu(e.clientX, e.clientY, ent.id, tok.name);
        });

        stripEl.appendChild(item);
    }

    if (!stripEl.childElementCount) {
        stripEl.style.display = "none";
        stripEl.innerHTML = "";
        if (parent) parent.classList.remove("has-initiative-strip");
        hideInitiativeStripContextMenu();
    }
}

function updateMasterInitiativeStrip() {
    fillInitiativeStrip(document.getElementById("initiativeStrip"), mapData);
}

function openCombatSetupModal() {
    const modal = document.getElementById("combatModal");
    const list = document.getElementById("combatModalList");
    if (!modal || !list) return;
    list.innerHTML = "";
    const tokens = mapData.tokens || [];
    tokens.forEach((token, tieIdx) => {
        const row = document.createElement("div");
        row.className = "combat-modal-row";
        row.dataset.tokenId = token.id;
        row.dataset.tieIndex = String(tieIdx);

        const name = document.createElement("span");
        name.className = "combat-modal-row-name";
        name.textContent = token.name || "Без имени";

        const inp = document.createElement("input");
        inp.type = "number";
        inp.value = "0";
        inp.title = "Инициатива";

        const ex = document.createElement("button");
        ex.type = "button";
        ex.className = "combat-row-exclude";
        ex.textContent = "Исключить";
        ex.addEventListener("click", () => row.remove());

        row.appendChild(name);
        row.appendChild(inp);
        row.appendChild(ex);
        list.appendChild(row);
    });

    modal.style.display = "flex";
}

function closeCombatSetupModal() {
    const modal = document.getElementById("combatModal");
    if (modal) modal.style.display = "none";
}

function startCombatFromModal() {
    const list = document.getElementById("combatModalList");
    if (!list) return;
    const rows = [...list.querySelectorAll(".combat-modal-row")];
    const rowsData = rows.map((row) => ({
        id: row.dataset.tokenId,
        initiative: parseInt(row.querySelector('input[type="number"]').value, 10) || 0,
        tie: parseInt(row.dataset.tieIndex, 10) || 0
    }));
    rowsData.sort((a, b) => (b.initiative - a.initiative) || (a.tie - b.tie));
    mapData.combat = {
        active: true,
        entries: rowsData.map((r) => ({ id: r.id, initiative: r.initiative }))
    };
    closeCombatSetupModal();
    saveMapData();
    syncCombatToolbarButton();
    updateMasterInitiativeStrip();
    render();
}

function endCombat() {
    mapData.combat = null;
    saveMapData();
    syncCombatToolbarButton();
    updateMasterInitiativeStrip();
    render();
}

function zonesIntersect(verticesA, verticesB) {
    function onSegment(p, q, r) {
        return q[0] <= Math.max(p[0], r[0]) &&
            q[0] >= Math.min(p[0], r[0]) &&
            q[1] <= Math.max(p[1], r[1]) &&
            q[1] >= Math.min(p[1], r[1]);
    }

    function orientation(p, q, r) {
        const val = (q[1] - p[1]) * (r[0] - q[0]) -
            (q[0] - p[0]) * (r[1] - q[1]);
        if (Math.abs(val) < 1e-10) return 0;
        return (val > 0) ? 1 : 2;
    }

    function doIntersect(p1, q1, p2, q2) {
        const o1 = orientation(p1, q1, p2);
        const o2 = orientation(p1, q1, q2);
        const o3 = orientation(p2, q2, p1);
        const o4 = orientation(p2, q2, q1);

        function pointsEqual(p, q) {
            return Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
        }

        if (o1 !== o2 && o3 !== o4) {
            if (
                (pointsEqual(p1, p2) || pointsEqual(p1, q2) ||
                    pointsEqual(q1, p2) || pointsEqual(q1, q2))
            ) {
                return false;
            }

            return true;
        }

        if (o1 === 0 && onSegment(p1, p2, q1)) {
            return false;
        }
        if (o2 === 0 && onSegment(p1, q2, q1)) {
            return false;
        }
        if (o3 === 0 && onSegment(p2, p1, q2)) {
            return false;
        }
        if (o4 === 0 && onSegment(p2, q1, q2)) {
            return false;
        }

        return false;
    }

    function getEdges(vertices) {
        const edges = [];
        for (let i = 0; i < vertices.length; i++) {
            const a = vertices[i];
            const b = vertices[(i + 1) % vertices.length];
            edges.push([a, b]);
        }
        return edges;
    }

    const edgesA = getEdges(verticesA);
    const edgesB = getEdges(verticesB);

    for (const [a1, a2] of edgesA) {
        for (const [b1, b2] of edgesB) {
            if (doIntersect(a1, a2, b1, b2)) {
                return true;
            }
        }
    }

    return false;
}

function fetchMap() {
    if (!currentMapId) {
        return Promise.reject("No map ID");
    }

    avatarCache.clear();

    return fetch(`/api/map/${currentMapId}`)
        .then(res => {
            if (!res.ok) {
                throw new Error(`HTTP error! status: ${res.status}`);
            }
            return res.json();
        })
        .then(data => {
            console.log("Map data loaded:", data);

            const oldHasImage = mapData?.has_image;
            const oldImageSrc = mapImage?.src;

            // Сохраняем текущую позицию перед обновлением
            const currentZoom = zoomLevel;
            const currentPanX = panX;
            const currentPanY = panY;
            const select = document.getElementById('mapSelect');
            const currentOption = select ? select.querySelector(`option[value="${currentMapId}"]`) : null;

            mapData = data;

            // Убеждаемся, что visible_to_players определен
            if (mapData.grid_settings && mapData.grid_settings.visible_to_players === undefined) {
                mapData.grid_settings.visible_to_players = true;
            }

            // ВАЖНО: НЕ перезаписываем позицию из данных, если она уже есть
            zoomLevel = currentZoom;
            panX = currentPanX;
            panY = currentPanY;

            // Но если это первый запуск (позиция не установлена), берём из данных
            if (!zoomLevel && mapData.zoom_level) {
                zoomLevel = mapData.zoom_level || 1;
            }
            if (!panX && mapData.pan_x !== undefined) {
                panX = mapData.pan_x || 0;
            }
            if (!panY && mapData.pan_y !== undefined) {
                panY = mapData.pan_y || 0;
            }

            // Инициализация массивов если их нет
            if (!mapData.tokens) mapData.tokens = [];
            if (!mapData.finds) mapData.finds = [];
            if (!mapData.zones) mapData.zones = [];
            if (!mapData.characters) mapData.characters = [];
            if (!mapData.grid_settings) {
                mapData.grid_settings = {
                    cell_size: 20,
                    color: "#888888",
                    visible: false,
                    visible_to_players: true
                };
            }

            if (mapData.player_map_enabled === undefined) {
                mapData.player_map_enabled = true;
            }

            // Обновляем интерфейс
            updateSidebar();

            const gridSize = mapData.grid_settings.cell_count || mapData.grid_settings.cell_size || 20;
            document.getElementById("gridSlider").value = gridSize;
            document.getElementById("gridInput").value = gridSize;

            updateSliderVisual();

            const gridToggle = document.getElementById("gridToggle");
            gridToggle.classList.toggle("active", mapData.grid_settings.visible);

            const playerGridToggle = document.getElementById("playerGridToggle");
            if (mapData.grid_settings.visible_to_players !== false) {
                playerGridToggle.classList.add("active");
            } else {
                playerGridToggle.classList.remove("active");
            }

            const playerRulerToggle = document.getElementById("playerRulerToggle");
            playerRulerToggle.classList.toggle("active", mapData.ruler_visible_to_players);

            if (mapData.has_image) {
                const shouldReload = !mapImage.src || !mapImage.src.includes(currentMapId) || oldHasImage !== mapData.has_image;

                if (shouldReload) {
                    const imageUrl = mapData.image_url || `/api/map/image/${currentMapId}`;
                    dndCache.fetch(imageUrl).then(src => {
                        mapImage = new Image();
                        mapImage.onload = () => { invalidateBg(); render(); };
                        mapImage.onerror = () => render();
                        mapImage.src = src || imageUrl;
                    }).catch(() => render());
                } else {
                    render();
                }
            } else {
                mapImage = new Image();
                render();
            }

            if (currentOption && data.name) {
                currentOption.textContent = data.name;
            }

            refreshPortraits();

            return data;
        })
        .catch(err => {
            console.error("Error fetching map:", err);
            render();
            throw err;
        });
}

function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!currentMapId) {
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Нет активной карты. Создайте новую или загрузите изображение",
            canvas.width / 2, canvas.height / 2);
        syncCombatToolbarButton();
        updateMasterInitiativeStrip();
        return;
    }

    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) {
        ctx.font = "20px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Загрузите изображение карты", canvas.width / 2, canvas.height / 2);
        syncCombatToolbarButton();
        updateMasterInitiativeStrip();
        return;
    }

    const { scale, offsetX, offsetY } = getTransform();

    // Фон (карта + сетка) — рисуем из кеша, пересчитываем только при необходимости
    _renderBg(offsetX, offsetY, scale);
    ctx.drawImage(_bgCanvas, 0, 0);

    // Динамические слои (меняются чаще: зоны, рисунки, токены, находки)
    mapData.zones.forEach(z => drawZone(z, offsetX, offsetY, scale));
    drawAllStrokes(offsetX, offsetY, scale);
    getTokensSortedForDrawing(mapData.tokens).forEach(t => drawToken(t, offsetX, offsetY, scale));
    mapData.finds.forEach(f => drawFind(f, offsetX, offsetY, scale));

    if (drawingZone) {
        drawTempZone(offsetX, offsetY, scale);
    }

    if (isRulerMode && rulerStart) {
        drawRuler(offsetX, offsetY, scale);
    }

    syncCombatToolbarButton();
    updateMasterInitiativeStrip();
}
function drawTempZone(offsetX, offsetY, scale) {
    if (currentZoneVertices.length === 0) {
        if (hoveredSnapVertex) {
            const [hx, hy] = hoveredSnapVertex;
            const px = hx * scale + offsetX;
            const py = hy * scale + offsetY;
            ctx.beginPath();
            ctx.arc(px, py, 6, 0, 2 * Math.PI);
            ctx.fillStyle = "cyan";
            ctx.fill();
            ctx.strokeStyle = "#00ffff";
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        return;
    }

    ctx.beginPath();
    ctx.strokeStyle = "#2196F3";
    ctx.fillStyle = "rgba(33, 150, 243, 0.3)";
    const [startX, startY] = currentZoneVertices[0];
    ctx.moveTo(startX * scale + offsetX, startY * scale + offsetY);

    for (let i = 1; i < currentZoneVertices.length; i++) {
        const [x, y] = currentZoneVertices[i];
        ctx.lineTo(x * scale + offsetX, y * scale + offsetY);
    }

    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Показ первой точки многоугольника, чтобы было понятно, где замкнётся зона
    const [firstX, firstY] = currentZoneVertices[0];
    const fx = firstX * scale + offsetX;
    const fy = firstY * scale + offsetY;
    ctx.beginPath();
    ctx.arc(fx, fy, 5, 0, 2 * Math.PI);
    ctx.fillStyle = "#00ffff";
    ctx.strokeStyle = "#0066ff";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    if (hoveredSnapVertex) {
        const [hx, hy] = hoveredSnapVertex;
        const px = hx * scale + offsetX;
        const py = hy * scale + offsetY;

        ctx.beginPath();
        ctx.arc(px, py, 6, 0, 2 * Math.PI);
        ctx.fillStyle = "cyan";
        ctx.fill();
        ctx.strokeStyle = "#00ffff";
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

function drawLayers(offsetX, offsetY, scale) {
    if (mapData.grid_settings.visible) drawGrid(offsetX, offsetY, scale);

    // Рисуем зоны (скрытые области)
    mapData.zones.forEach(z => drawZone(z, offsetX, offsetY, scale));

    // Рисуем рисунки мастера (НОВОЕ)
    drawAllStrokes(offsetX, offsetY, scale);

    // Токены и находки поверх рисунков (мелкие токены поверх крупных)
    getTokensSortedForDrawing(mapData.tokens).forEach(t => drawToken(t, offsetX, offsetY, scale));
    mapData.finds.forEach(f => drawFind(f, offsetX, offsetY, scale));
}

function drawGrid(offsetX, offsetY, scale) {
    _drawGridToCtx(ctx, offsetX, offsetY, scale);
}

function isPointInHiddenZone(point, zones) {
    if (!zones || !zones.length) return false;

    for (let i = 0; i < zones.length; i++) {
        const zone = zones[i];
        // Проверяем только зоны, которые скрыты от игроков (is_visible === false)
        if (zone.is_visible === false && zone.vertices && zone.vertices.length >= 3) {
            if (pointInPolygon(point, zone.vertices)) {
                return true;
            }
        }
    }
    return false;
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
                console.log(`Avatar loaded for token ${token.id}, size: ${img.naturalWidth}x${img.naturalHeight}`);
                avatarCache.set(token.id, img);
                render();
            };
            img.onerror = () => {
                console.warn(`Failed to load avatar for token ${token.name}, using placeholder`);
                avatarCache.set(token.id, null);
                render();
            };
            img.src = avatarSrc;
            return;
        }
    }

    const isUnderHiddenZone = isPointInHiddenZone(token.position, mapData.zones);
    const isManuallyHidden = token.is_visible === false;

    ctx.save();

    if (isUnderHiddenZone || isManuallyHidden) {
        ctx.globalAlpha = 0.4;
    }

    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, 2 * Math.PI);

    if (avatarSrc) {
        if (cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0) {
            ctx.save();
            ctx.clip();

            // ===== ВАЖНО: Включаем сглаживание для лучшего качества при уменьшении =====
            // Если токен рисуется меньше оригинального размера, включаем сглаживание
            // Если больше - отключаем для четкости
            const scaleFactor = tokenSize / Math.max(cachedImg.naturalWidth, cachedImg.naturalHeight);

            if (scaleFactor < 1) {
                // Уменьшение - включаем сглаживание для плавности
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
            } else {
                // Увеличение - отключаем сглаживание для четкости пикселей
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

    if (selectedTokens.has(token.id)) {
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = "#00FFFF";
        ctx.lineWidth = 3;
        ctx.stroke();
    } else if (selectedTokenId === token.id) {
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = "#00FFFF";
        ctx.lineWidth = 3;
        ctx.stroke();
    }

    ctx.restore();
}

function reloadTokenAvatar(tokenId) {
    if (!tokenId) return;
    avatarCache.delete(tokenId);
    render();
}

// Вызывайте эту функцию после загрузки аватара на сервер
function onAvatarUploaded(tokenId) {
    reloadTokenAvatar(tokenId);

    // Также отправляем событие всем игрокам
    socket.emit("token_avatar_updated", {
        map_id: currentMapId,
        token_id: tokenId,
        avatar_url: `/api/token/avatar/${tokenId}`
    });
}

function openCharacterModal() {
    document.getElementById("characterModal").style.display = "flex";
    document.getElementById("characterName").value = "";
    clearCharacterPendingMedia();
    const preview = document.getElementById("characterAvatarPreview");
    preview.src = "";
    preview.style.display = "none";
    preview.removeAttribute("data-base64");

    document.getElementById("characterAvatarOverlay").style.display = "block";
    document.getElementById("characterAvatarMask").style.display = "none";
    document.getElementById("characterEditIcon").style.display = "none";
}

function closeCharacterModal() {
    document.getElementById("characterModal").style.display = "none";
    document.getElementById("characterModalTitle").textContent = "Добавление портрета";
    window.editingCharacterId = null;

    // Сбрасываем форму
    document.getElementById("characterName").value = "";
    clearCharacterPendingMedia();
    const preview = document.getElementById("characterAvatarPreview");
    preview.src = "";
    preview.style.display = "none";
    preview.removeAttribute("data-base64");
    preview.removeAttribute("data-portrait-id");

    document.getElementById("characterAvatarOverlay").style.display = "block";
    document.getElementById("characterAvatarMask").style.display = "none";
    document.getElementById("characterEditIcon").style.display = "none";
}
function handleCharacterAvatarUpload(event) {
    const input = event.target || event;
    const file = input.files && input.files[0];
    if (!file) return;

    const isGif = file.type === "image/gif" || /\.gif$/i.test(file.name);
    const isVideo = (file.type && file.type.startsWith("video/")) ||
        /\.(webm|mp4|mov|m4v)$/i.test(file.name);

    const maxVideo = 50 * 1024 * 1024;
    const maxImage = 10 * 1024 * 1024;
    if (isVideo) {
        if (file.size > maxVideo) {
            alert("Видео слишком большое. Максимум 50 МБ.");
            return;
        }
    } else if (!isGif && file.size > maxImage) {
        alert("Файл слишком большой. Максимальный размер 10 МБ.");
        return;
    } else if (isGif && file.size > maxVideo) {
        alert("GIF слишком большой. Максимум 50 МБ.");
        return;
    }

    if (isGif || isVideo) {
        clearCharacterPendingMedia();
        window.pendingCharacterPortraitFile = file;
        window.pendingCharacterPortraitMedia = isGif ? "gif" : "video";

        const url = URL.createObjectURL(file);
        window._characterPortraitBlobUrl = url;

        const imgPrev = document.getElementById("characterAvatarPreview");
        if (!imgPrev) return;

        const vidPrev = isVideo ? ensureCharacterAvatarPreviewVideo() : document.getElementById("characterAvatarPreviewVideo");
        imgPrev.removeAttribute("data-base64");

        if (isVideo) {
            if (!vidPrev) {
                alert("Не найден блок превью аватара. Обновите страницу (Ctrl+F5).");
                URL.revokeObjectURL(url);
                window._characterPortraitBlobUrl = null;
                window.pendingCharacterPortraitFile = null;
                window.pendingCharacterPortraitMedia = null;
                return;
            }
            imgPrev.style.display = "none";
            imgPrev.removeAttribute("src");
            vidPrev.style.display = "block";
            vidPrev.src = url;
            vidPrev.loop = true;
            vidPrev.muted = true;
            vidPrev.playsInline = true;
            vidPrev.setAttribute("playsinline", "");
            vidPrev.autoplay = true;
            void vidPrev.play().catch(() => {});
        } else {
            if (vidPrev) {
                vidPrev.style.display = "none";
                vidPrev.removeAttribute("src");
            }
            imgPrev.src = url;
            imgPrev.style.display = "block";
        }

        document.getElementById("characterAvatarOverlay").style.display = "none";
        document.getElementById("characterAvatarMask").style.display = "none";
        document.getElementById("characterEditIcon").style.display = "block";
        input.value = "";
        return;
    }

    openCropModal(file, "character");
    input.value = "";
}

function openEditCharacterModal(character) {
    document.getElementById("characterModal").style.display = "flex";
    document.getElementById("characterModalTitle").textContent = "Редактирование портрета";
    document.getElementById("characterName").value = character.name;
    clearCharacterPendingMedia();

    const preview = document.getElementById("characterAvatarPreview");
    const overlay = document.getElementById("characterAvatarOverlay");
    const mask = document.getElementById("characterAvatarMask");
    const editIcon = document.getElementById("characterEditIcon");

    if (character.has_avatar) {
        const portraitUrl = character.portrait_url || `/api/portrait/${character.id}`;
        const media = inferPortraitMedia(character);
        preview.dataset.portraitId = character.id;

        if (media === "video") {
            const vidPrev = ensureCharacterAvatarPreviewVideo();
            preview.style.display = "none";
            preview.removeAttribute("src");
            if (vidPrev) {
                vidPrev.style.display = "block";
                vidPrev.src = portraitUrl;
                vidPrev.loop = true;
                vidPrev.muted = true;
                vidPrev.playsInline = true;
                vidPrev.setAttribute("playsinline", "");
                vidPrev.autoplay = true;
                void vidPrev.play().catch(() => {});
            }
        } else {
            const vidPrev = document.getElementById("characterAvatarPreviewVideo");
            if (vidPrev) {
                vidPrev.style.display = "none";
                vidPrev.removeAttribute("src");
            }
            preview.src = portraitUrl;
            preview.style.display = "block";
        }

        overlay.style.display = "none";
        mask.style.display = media === "video" ? "none" : "block";
        editIcon.style.display = "block";
    } else {
        preview.src = "";
        preview.style.display = "none";
        preview.removeAttribute("data-base64");
        preview.removeAttribute("data-portrait-id");
        vidPrev.style.display = "none";
        vidPrev.removeAttribute("src");

        overlay.style.display = "block";
        mask.style.display = "none";
        editIcon.style.display = "none";
    }

    window.editingCharacterId = character.id;
}

function submitCharacter() {
    const name = document.getElementById("characterName").value.trim();
    const avatarPreview = document.getElementById("characterAvatarPreview");
    const avatarData = avatarPreview.dataset.base64 || null;
    const editingId = window.editingCharacterId;
    const pendingFile = window.pendingCharacterPortraitFile;
    const pendingMedia = window.pendingCharacterPortraitMedia;

    if (!name) {
        alert("Введите имя персонажа.");
        return;
    }

    if (pendingFile && pendingMedia) {
        if (editingId) {
            editCharacterWithFile(editingId, name, pendingFile, pendingMedia);
        } else {
            createNewCharacterWithFile(name, pendingFile, pendingMedia);
        }
        return;
    }

    if (editingId) {
        editCharacter(editingId, name, avatarData);
    } else {
        if (!avatarData) {
            alert("Выберите изображение для портрета.");
            return;
        }
        createNewCharacter(name, avatarData);
    }
}

function createNewCharacter(name, avatarData) {
    console.log("createNewCharacter called with:", { name, hasAvatar: !!avatarData });

    const characterId = `char_${Date.now()}`;

    const character = {
        id: characterId,
        name,
        has_avatar: false,
        visible_to_players: false,
        portrait_media: "image",
    };

    if (!mapData.characters) mapData.characters = [];
    mapData.characters.push(character);

    const formData = new FormData();
    const blob = dataURLtoBlob(avatarData);
    formData.append("portrait", blob, `${characterId}.png`);
    formData.append("character_id", characterId);

    fetch("/api/portrait/upload", {
        method: "POST",
        body: formData
    })
        .then(response => {
            if (!response.ok) throw new Error("Failed to upload portrait");
            return response.json();
        })
        .then(data => {
            const ch = mapData.characters.find(c => c.id === characterId);
            if (ch && data.portrait_url) {
                ch.portrait_url = data.portrait_url;
                ch.has_avatar = true;
            }
            if (ch && data.portrait_media) {
                ch.portrait_media = data.portrait_media;
            }

            window.editingCharacterId = null;
            closeCharacterModal();
            updateSidebar();
            refreshPortraits();
            initCharacterDragAndDrop();

            saveMapData();

            socket.emit("characters_updated", {
                map_id: currentMapId,
                characters: mapData.characters
            });
        })
        .catch(error => {
            console.error("Error creating character:", error);
            mapData.characters = (mapData.characters || []).filter(c => c.id !== characterId);
            alert("Ошибка при создании персонажа: " + error.message);
        });
}

function createNewCharacterWithFile(name, file, portraitMedia) {
    const characterId = `char_${Date.now()}`;
    const character = {
        id: characterId,
        name,
        has_avatar: false,
        visible_to_players: false,
        portrait_media: portraitMedia,
    };

    if (!mapData.characters) mapData.characters = [];
    mapData.characters.push(character);

    const formData = new FormData();
    formData.append("portrait", file, file.name || "portrait");
    formData.append("character_id", characterId);

    fetch("/api/portrait/upload", {
        method: "POST",
        body: formData
    })
        .then(response => {
            if (!response.ok) throw new Error("Failed to upload portrait");
            return response.json();
        })
        .then(data => {
            const ch = mapData.characters.find(c => c.id === characterId);
            if (ch && data.portrait_url) {
                ch.portrait_url = data.portrait_url;
                ch.has_avatar = true;
            }
            if (ch && data.portrait_media) {
                ch.portrait_media = data.portrait_media;
            }

            window.editingCharacterId = null;
            closeCharacterModal();
            updateSidebar();
            refreshPortraits();
            initCharacterDragAndDrop();
            saveMapData();

            socket.emit("characters_updated", {
                map_id: currentMapId,
                characters: mapData.characters
            });
        })
        .catch(error => {
            console.error("Error creating character:", error);
            mapData.characters = mapData.characters.filter(c => c.id !== characterId);
            alert("Ошибка при создании персонажа: " + error.message);
        });
}


function editCharacter(characterId, name, avatarData) {
    const character = mapData.characters?.find(c => c.id === characterId);
    if (!character) return;

    // Обновляем имя
    character.name = name;

    // Функция для завершения редактирования
    const finishEdit = () => {
        window.editingCharacterId = null;
        closeCharacterModal();
        saveMapData();
        updateSidebar();
        initCharacterDragAndDrop();

        // Уведомляем игроков об обновлении
        socket.emit("characters_updated", {
            map_id: currentMapId,
            characters: mapData.characters
        });
    };

    // Если аватар не изменился
    if (!avatarData) {
        finishEdit();
        return;
    }

    // Обновляем аватар
    const formData = new FormData();
    const blob = dataURLtoBlob(avatarData);
    formData.append("portrait", blob, `${characterId}.png`);
    formData.append("character_id", characterId);

    fetch("/api/portrait/upload", {
        method: "POST",
        body: formData
    })
        .then(response => {
            if (!response.ok) throw new Error("Failed to upload portrait");
            return response.json();
        })
        .then(data => {
            character.has_avatar = true;
            character.portrait_url = data.portrait_url;
            character.portrait_media = data.portrait_media || "image";

            const imgElements = document.querySelectorAll(`img[src*="/api/portrait/${characterId}"]`);
            imgElements.forEach(img => {
                img.src = data.portrait_url;
            });

            finishEdit();
        })
        .catch(error => {
            console.error("Error updating portrait:", error);
            alert("Ошибка при обновлении портрета");
            finishEdit();
        });
}

function editCharacterWithFile(characterId, name, file, portraitMedia) {
    const character = mapData.characters?.find(c => c.id === characterId);
    if (!character) return;

    character.name = name;

    const finishEdit = () => {
        window.editingCharacterId = null;
        closeCharacterModal();
        saveMapData();
        updateSidebar();
        initCharacterDragAndDrop();
        socket.emit("characters_updated", {
            map_id: currentMapId,
            characters: mapData.characters
        });
    };

    const formData = new FormData();
    formData.append("portrait", file, file.name || "portrait");
    formData.append("character_id", characterId);

    fetch("/api/portrait/upload", {
        method: "POST",
        body: formData
    })
        .then(response => {
            if (!response.ok) throw new Error("Failed to upload portrait");
            return response.json();
        })
        .then(data => {
            character.has_avatar = true;
            character.portrait_url = data.portrait_url;
            if (data.portrait_media) {
                character.portrait_media = data.portrait_media;
            } else {
                character.portrait_media = portraitMedia;
            }
            finishEdit();
        })
        .catch(error => {
            console.error("Error updating portrait:", error);
            alert("Ошибка при обновлении портрета");
            finishEdit();
        });
}

function dataURLtoBlob(dataURL) {
    const arr = dataURL.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);

    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }

    return new Blob([u8arr], { type: mime });
}

function postPortraitUploadForCharacter(characterId, pngDataUrl, portraitFile, portraitMedia) {
    const formData = new FormData();
    formData.append("character_id", characterId);
    if (
        portraitFile &&
        (portraitMedia === "gif" || portraitMedia === "video")
    ) {
        formData.append("portrait", portraitFile, portraitFile.name || "portrait");
    } else {
        formData.append(
            "portrait",
            dataURLtoBlob(pngDataUrl),
            `${characterId}.png`
        );
    }
    return fetch("/api/portrait/upload", {
        method: "POST",
        body: formData,
    }).then((response) => {
        if (!response.ok) {
            throw new Error("Failed to upload portrait: " + response.status);
        }
        return response.json();
    });
}

function drawFind(find, offsetX, offsetY, scale) {
    const [x, y] = find.position;
    const sx = x * scale + offsetX;
    const sy = y * scale + offsetY;
    const size = mapData.grid_settings.cell_size * scale;
    const radius = size / 4;

    ctx.save();

    if (find.status) {
        ctx.globalAlpha = 0.5;
    }

    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, 2 * Math.PI);
    ctx.fillStyle = "#4C5BEF";
    ctx.fill();

    ctx.lineWidth = 2;
    ctx.strokeStyle = "white";
    ctx.stroke();

    ctx.fillStyle = "white";
    ctx.font = `bold ${radius}px Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", sx, sy);

    if (selectedFindId === find.id) {
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = "#00FFFF";
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    ctx.restore();
}


function getMapCoordinates(event, offsetX, offsetY, scale) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left - offsetX) / scale;
    const y = (event.clientY - rect.top - offsetY) / scale;
    return [x, y];
}

function getTransform() {
    const baseScale = Math.min(canvas.width / mapImage.width, canvas.height / mapImage.height);
    const scale = baseScale * zoomLevel;
    return {
        scale,
        offsetX: panX,
        offsetY: panY,
    };
}

function addToken() {
    document.getElementById("tokenModal").style.display = "flex";
    document.getElementById("tokenName").value = "";
    document.getElementById("tokenAC").value = 10;
    document.getElementById("tokenHP").value = 10;

    document.querySelectorAll(".type-btn").forEach(b => b.classList.remove("active"));
    document.querySelector('.type-btn[data-type="player"]').classList.add("active");

    const avatarPreview = document.getElementById("avatarPreview");
    avatarPreview.src = "";
    avatarPreview.style.display = "none";
    avatarPreview.removeAttribute("data-base64");

    document.getElementById("avatarOverlay").style.display = "block";
    document.getElementById("avatarMask").style.display = "none";
    document.getElementById("editIcon").style.display = "none";

    // Принудительно показываем чекбоксы
    const addToCharactersParent = document.getElementById("addToCharactersCheckbox").parentElement;
    const addToBankParent = document.getElementById("addToBankCheckbox").parentElement;

    if (addToCharactersParent) {
        addToCharactersParent.style.display = "flex";
        addToCharactersParent.style.visibility = "visible";
    }
    if (addToBankParent) {
        addToBankParent.style.display = "flex";
        addToBankParent.style.visibility = "visible";
    }

    document.getElementById("addToCharactersCheckbox").checked = false;
    document.getElementById("addToBankCheckbox").checked = false;

    clearTokenPendingPortrait();
}

function drawZone(zone, offsetX, offsetY, scale) {
    if (!zone.vertices || zone.vertices.length < 2) return;

    ctx.beginPath();

    ctx.strokeStyle = zone.is_visible ? "#4caf4f00" : "#F44336";
    ctx.fillStyle = zone.is_visible ? "rgba(76, 175, 79, 0)" : "rgba(244, 67, 54, 0.3)";

    const isSelected = zone.id === selectedZoneId;
    if (isSelected) {
        ctx.lineWidth = 2;
    } else {
        ctx.lineWidth = 4;
    }

    const transformed = zone.vertices.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);

    ctx.moveTo(transformed[0][0], transformed[0][1]);
    for (let i = 1; i < transformed.length; i++) {
        ctx.lineTo(transformed[i][0], transformed[i][1]);
    }
    ctx.closePath();

    ctx.fill();
    ctx.stroke();

    if (isSelected) {
        ctx.strokeStyle = "#00FFFF";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Вершины — перетаскиваемые ручки (выделенная — для Delete)
        zone.vertices.forEach(([wx, wy], i) => {
            const sx = wx * scale + offsetX;
            const sy = wy * scale + offsetY;
            const isHov  = hoveredVertexZoneId  === zone.id && hoveredVertexIndex  === i;
            const isDrag = draggingVertexZoneId === zone.id && draggingVertexIndex === i;
            const isSel  = selectedVertexZoneId === zone.id && selectedVertexIndex === i;
            const r = isDrag || isHov ? 9 : isSel ? 8 : 7;

            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fillStyle = isDrag ? '#FFD700' : isHov ? '#FFFAAA' : '#FFFFFF';
            ctx.fill();
            ctx.strokeStyle = isSel ? '#E040FB' : isDrag ? '#FF8C00' : '#00FFFF';
            ctx.lineWidth = isSel ? 3 : 2;
            ctx.stroke();
        });
    }

    // Отрисовываем подпись только если зона НЕ visible
    if (!zone.is_visible) {
        const centerX = transformed.reduce((a, b) => a + b[0], 0) / transformed.length;
        const centerY = transformed.reduce((a, b) => a + b[1], 0) / transformed.length;
        ctx.font = `18px Inter`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        ctx.strokeStyle = "white";
        ctx.lineWidth = 4;
        ctx.strokeText(zone.name, centerX, centerY);

        ctx.fillStyle = "black";
        ctx.fillText(zone.name, centerX, centerY);
    }
}

function addZone() {
    // Если включаем рисование зон
    if (!drawingZone) {
        // Выключаем линейку
        if (isRulerMode) {
            isRulerMode = false;
            rulerStart = null;
            mapData.ruler_start = null;
            mapData.ruler_end = null;

            // Отключаем видимость линейки для игроков
            mapData.ruler_visible_to_players = false;

            // Обновляем кнопку в интерфейсе мастера
            const playerRulerToggle = document.getElementById("playerRulerToggle");
            if (playerRulerToggle) {
                playerRulerToggle.classList.remove("active");
            }

            // Отправляем обновление линейки
            socket.emit("ruler_update", {
                map_id: currentMapId,
                ruler_start: null,
                ruler_end: null
            });

            socket.emit("ruler_visibility_change", {
                map_id: currentMapId,
                ruler_visible_to_players: false
            });

            // Обновляем кнопку линейки мастера
            const rulerBtn = document.getElementById("rulerToggle");
            if (rulerBtn) {
                rulerBtn.classList.remove("active");
            }
        }

        // Выключаем режимы рисования
        if (isDrawMode || isEraseMode) {
            isDrawMode = false;
            isEraseMode = false;
            document.getElementById('drawToggle').classList.remove('active');
            document.getElementById('eraserToggle').classList.remove('active');

            // Завершаем текущий штрих если есть
            if (drawingStroke) {
                if (drawThrottle) {
                    clearTimeout(drawThrottle);
                    drawThrottle = null;
                }
                if (drawingStroke.points.length > 1) {
                    saveDrawingStateToHistory();
                    saveDrawings();
                }
                drawingStroke = null;
                lastDrawPoint = null;
            }
        }
    }

    drawingZone = true;
    currentZoneVertices = [];
    updateCanvasCursor();

    // Опционально: показать подсказку пользователю
    showZoneDrawingHint();
}

function showZoneDrawingHint() {
    // Создаем временную подсказку
    const hint = document.createElement('div');
    hint.id = 'drawing-hint';
    hint.innerHTML = `
        <div style="
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #333;
            color: white;
            padding: 10px 20px;
            border-radius: 8px;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            border-left: 4px solid #2196F3;
        ">
            <strong>Режим рисования зоны</strong><br>
            <small>Кликните для добавления точек • ПКМ для завершения</small>
        </div>
    `;

    // Удаляем старую подсказку если есть
    const oldHint = document.getElementById('drawing-hint');
    if (oldHint) oldHint.remove();

    document.body.appendChild(hint);

    // Автоматически скрываем через 5 секунд
    setTimeout(() => {
        const hint = document.getElementById('drawing-hint');
        if (hint) hint.remove();
    }, 5000);
}

function onGridSizeChange(value) {
    const newSize = parseInt(value);
    document.getElementById("gridSlider").value = newSize;
    document.getElementById("gridInput").value = newSize; document.getElementById("gridInput").value = newSize;
    mapData.grid_settings.cell_size = newSize;
    invalidateBg();
    render();

    saveMapData();
}

function handleAvatarUpload(ev) {
    const input = ev && ev.target ? ev.target : ev;
    const file = input.files && input.files[0];
    if (!file) return;

    const isGif = file.type === "image/gif" || /\.gif$/i.test(file.name);
    const isVideo =
        (file.type && file.type.startsWith("video/")) ||
        /\.(webm|mp4|mov|m4v)$/i.test(file.name);

    const maxVideo = 50 * 1024 * 1024;
    const maxImage = 10 * 1024 * 1024;

    if (isVideo) {
        if (file.size > maxVideo) {
            alert("Видео слишком большое. Максимум 50 МБ.");
            return;
        }
    } else if (!isGif && file.size > maxImage) {
        alert("Файл слишком большой. Максимальный размер 10 МБ.");
        return;
    } else if (isGif && file.size > maxVideo) {
        alert("GIF слишком большой. Максимум 50 МБ.");
        return;
    }

    if (isGif || isVideo) {
        clearTokenPendingPortrait();
        window.pendingTokenPortraitFile = file;
        window.pendingTokenPortraitMedia = isGif ? "gif" : "video";

        tokenMediaFileToStaticPngDataUrl(file)
            .then((pngDataUrl) => {
                const tokenPreview = document.getElementById("avatarPreview");
                tokenPreview.src = pngDataUrl;
                tokenPreview.style.display = "block";
                tokenPreview.dataset.base64 = pngDataUrl;
                document.getElementById("avatarOverlay").style.display = "none";
                document.getElementById("avatarMask").style.display = "block";
                document.getElementById("editIcon").style.display = "block";
            })
            .catch(() => {
                alert(
                    "Не удалось извлечь кадр из GIF/видео для аватара токена."
                );
                clearTokenPendingPortrait();
            });
        input.value = "";
        return;
    }

    clearTokenPendingPortrait();
    openCropModal(file, "token");
    input.value = "";
}

function closeTokenModal() {
    if (window.tokenModalSaveInProgress) return;
    document.getElementById("tokenModal").style.display = "none";
    document.getElementById("tokenName").value = "";
    document.getElementById("tokenAC").value = 10;
    document.getElementById("tokenHP").value = 10;

    document.querySelectorAll(".type-btn").forEach(b => b.classList.remove("active"));
    document.querySelector('.type-btn[data-type="player"]').classList.add("active");

    const avatarPreview = document.getElementById("avatarPreview");
    avatarPreview.src = "";
    avatarPreview.style.display = "none";
    avatarPreview.removeAttribute("data-base64");

    document.getElementById("avatarOverlay").style.display = "block";
    document.getElementById("avatarMask").style.display = "none";
    document.getElementById("editIcon").style.display = "none";

    // Показываем и сбрасываем чекбоксы
    const addToCharactersParent = document.getElementById("addToCharactersCheckbox").parentElement;
    const addToBankParent = document.getElementById("addToBankCheckbox").parentElement;

    if (addToCharactersParent) {
        addToCharactersParent.style.display = "flex";
        addToCharactersParent.style.visibility = "visible";
    }
    if (addToBankParent) {
        addToBankParent.style.display = "flex";
        addToBankParent.style.visibility = "visible";
    }

    document.getElementById("addToCharactersCheckbox").checked = false;
    document.getElementById("addToBankCheckbox").checked = false;

    clearTokenPendingPortrait();
    editingTokenId = null;
}
canvas.addEventListener("mousedown", (e) => {
    const [mouseX, mouseY] = [e.offsetX, e.offsetY];
    const { scale, offsetX, offsetY } = getTransform();
    const isShiftPressed = e.shiftKey;

    // Сбрасываем флаг клика
    isClick = true;

    if (clickTimer) {
        clearTimeout(clickTimer);
    }
    clickTimer = setTimeout(() => {
        isClick = false;
    }, 200);

    if (isRulerMode) {
        const x = (mouseX - offsetX) / scale;
        const y = (mouseY - offsetY) / scale;
        rulerStart = [x, y];
        render();
        return;
    }

    if (isDrawMode || isEraseMode) {
        if (e.button !== 0) return;

        const { scale, offsetX, offsetY } = getTransform();
        const x = (e.offsetX - offsetX) / scale;
        const y = (e.offsetY - offsetY) / scale;

        if (isEraseMode) {
            // Сохраняем состояние ДО стирания
            saveDrawingStateToHistory();
            eraseNearbyPoints(x, y, 20 / scale);
        } else {
            // Рисование - сохраняем состояние ТОЛЬКО если это начало нового штриха
            // и предыдущий штрих был завершен
            if (!drawingStroke) {
                ensureDrawingLayerId();
                saveDrawingStateToHistory();
            }

            drawingStroke = {
                id: `stroke_${Date.now()}`,
                points: [[x, y]],
                color: 'rgba(255, 50, 50, 0.5)',
                width: 20
            };
            drawingStrokes.push(drawingStroke);
            lastDrawPoint = [x, y];
        }
        render();
        return;
    }

    if (drawingZone) {
        if (e.button === 0) {
            let x = (mouseX - offsetX) / scale;
            let y = (mouseY - offsetY) / scale;
            const snap = findZoneVertexSnapWorld(x, y, scale);
            if (snap) {
                [x, y] = snap;
            }

            x = Math.max(0, Math.min(x, mapImage.width));
            y = Math.max(0, Math.min(y, mapImage.height));

            currentZoneVertices.push([x, y]);
            render();
        }
        return;
    }

    // ── Высший приоритет: клик по вершине выделенной зоны ───────────────────
    const _prevSelectedZoneId = selectedZoneId;
    if (_prevSelectedZoneId && e.button === 0 && !drawingZone && !isRulerMode) {
        const _zone = mapData.zones.find(z => z.id === _prevSelectedZoneId);
        if (_zone) {
            for (let _vi = 0; _vi < _zone.vertices.length; _vi++) {
                const [wx, wy] = _zone.vertices[_vi];
                if (Math.hypot(mouseX - (wx * scale + offsetX), mouseY - (wy * scale + offsetY)) <= VERTEX_HIT_R) {
                    draggingVertexZoneId = _prevSelectedZoneId;
                    draggingVertexIndex  = _vi;
                    selectedVertexZoneId = _prevSelectedZoneId;
                    selectedVertexIndex  = _vi;
                    // Сохраняем выделение зоны — не даём сбросить ниже
                    selectedZoneId = _prevSelectedZoneId;
                    render();
                    return; // всё остальное пропускаем
                }
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const clickedToken = findTopTokenAtScreenPoint(mouseX, mouseY, scale, offsetX, offsetY);

    // Логика выделения и перетаскивания
    selectedTokenId = null;
    selectedFindId = null;
    selectedZoneId = null;
    clearSelectedVertex();
    draggingToken = null;
    draggingFind = null;
    isDraggingMultiple = false;

    let clicked = false;

    // Обработка клика по токену
    if (clickedToken) {
        if (isShiftPressed) {
            // Shift + клик - переключаем выделение
            if (selectedTokens.has(clickedToken.id)) {
                selectedTokens.delete(clickedToken.id);
            } else {
                selectedTokens.add(clickedToken.id);
            }

            if (selectedTokens.size > 0) {
                selectedTokenId = clickedToken.id;
            } else {
                selectedTokenId = null;
            }
        } else {
            // Обычный клик без Shift
            if (!selectedTokens.has(clickedToken.id)) {
                selectedTokens.clear();
                selectedTokens.add(clickedToken.id);
                selectedTokenId = clickedToken.id;
            }
        }

        clicked = true;

        // Начинаем перетаскивание
        draggingToken = clickedToken;
        const [tx, ty] = clickedToken.position;
        const tokenSx = tx * scale + offsetX;
        const tokenSy = ty * scale + offsetY;
        dragOffset = [(mouseX - tokenSx) / scale, (mouseY - tokenSy) / scale];

        // Проверяем групповое перетаскивание
        if (selectedTokens.size > 1 && selectedTokens.has(clickedToken.id)) {
            isDraggingMultiple = true;
            multiDragOffsets.clear();

            for (const tokenId of selectedTokens) {
                const token = mapData.tokens.find(t => t.id === tokenId);
                if (token) {
                    const [tx, ty] = token.position;
                    const tokenSx = tx * scale + offsetX;
                    const tokenSy = ty * scale + offsetY;
                    multiDragOffsets.set(tokenId, [
                        (mouseX - tokenSx) / scale,
                        (mouseY - tokenSy) / scale
                    ]);
                }
            }
        }

        updateSidebar();
    }

    // Обработка клика по находке
    if (!clicked) {
        for (const find of mapData.finds) {
            const [x, y] = find.position;
            const sx = x * scale + offsetX;
            const sy = y * scale + offsetY;
            const radius = (mapData.grid_settings.cell_size * scale) / 2;

            if (Math.hypot(mouseX - sx, mouseY - sy) <= radius) {
                draggingFind = find;
                dragOffset = [(mouseX - sx) / scale, (mouseY - sy) / scale];
                selectedFindId = find.id;
                selectedTokens.clear();
                selectedTokenId = null;
                clicked = true;
                updateSidebar();
                break;
            }
        }
    }

    // Обработка клика по зоне
    if (!clicked) {
        for (const zone of mapData.zones) {
            if (!zone.vertices || zone.vertices.length < 3) continue;
            const transformed = zone.vertices.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);
            if (pointInPolygon([mouseX, mouseY], transformed)) {
                selectedZoneId = zone.id;
                selectedTokens.clear();
                selectedTokenId = null;
                clicked = true;
                updateSidebar();
                break;
            }
        }
    }

    // Клик по пустому месту - снимаем всё выделение
    if (!clicked && !isRulerMode && !drawingZone) {
        selectedTokenId = null;
        selectedFindId = null;
        selectedZoneId = null;
        selectedCharacterId = null;
        selectedTokens.clear();
        updateSidebar();
    }

    // Средняя кнопка мыши — панорамирование
    if (!clicked && e.button === 1 && !isRulerMode && !drawingZone) {
        isPanning = true;
        panStartMouseX = e.clientX;
        panStartMouseY = e.clientY;
        panStartPanX = panX;
        panStartPanY = panY;
        updateCanvasCursor();
        e.preventDefault();
        return;
    }

    render();
});

function pointInPolygon(point, vs) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        const xi = vs[i][0], yi = vs[i][1];
        const xj = vs[j][0], yj = vs[j][1];

        const intersect = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

let hoveringFind = null;

canvas.addEventListener("mousemove", (e) => {
    const mouseX = e.offsetX;
    const mouseY = e.offsetY;

    const { scale, offsetX, offsetY } = getTransform();

    lastMouseX = mouseX;
    lastMouseY = mouseY;

    if (drawingZone) {
        let x = (mouseX - offsetX) / scale;
        let y = (mouseY - offsetY) / scale;
        hoveredSnapVertex = findZoneVertexSnapWorld(x, y, scale);
        scheduleRender();
        return;
    }

    // ── Перетаскивание вершины зоны ──────────────────────────────────────────
    if (draggingVertexZoneId !== null && draggingVertexIndex >= 0) {
        const zone = mapData.zones.find(z => z.id === draggingVertexZoneId);
        if (zone) {
            const wx = (mouseX - offsetX) / scale;
            const wy = (mouseY - offsetY) / scale;
            zone.vertices[draggingVertexIndex] = [
                Math.max(0, Math.min(wx, mapImage.width)),
                Math.max(0, Math.min(wy, mapImage.height))
            ];
            scheduleRender();
        }
        return;
    }

    // ── Hover-подсветка вершин выделенной зоны ───────────────────────────────
    if (selectedZoneId && !drawingZone && !isRulerMode) {
        const zone = mapData.zones.find(z => z.id === selectedZoneId);
        let foundVtx = -1;
        if (zone) {
            for (let i = 0; i < zone.vertices.length; i++) {
                const [wx, wy] = zone.vertices[i];
                if (Math.hypot(mouseX - (wx * scale + offsetX), mouseY - (wy * scale + offsetY)) <= VERTEX_HIT_R) {
                    foundVtx = i;
                    break;
                }
            }
        }
        if (hoveredVertexIndex !== foundVtx || hoveredVertexZoneId !== selectedZoneId) {
            hoveredVertexIndex  = foundVtx;
            hoveredVertexZoneId = foundVtx >= 0 ? selectedZoneId : null;
            scheduleRender();
        }
    } else if (hoveredVertexIndex >= 0) {
        hoveredVertexIndex  = -1;
        hoveredVertexZoneId = null;
        scheduleRender();
    }
    // ─────────────────────────────────────────────────────────────────────────

    updateCanvasCursor();

    // Перемещение карты средней кнопкой мыши
    if (isPanning) {
        panX = panStartPanX + (e.clientX - panStartMouseX);
        panY = panStartPanY + (e.clientY - panStartMouseY);
        invalidateBg();
        scheduleRender();

        clearTimeout(zoomSyncTimeout);
        zoomSyncTimeout = setTimeout(() => {
            socket.emit("zoom_update", {
                map_id: currentMapId,
                zoom_level: zoomLevel,
                pan_x: panX,
                pan_y: panY,
                canvas_width: canvas.width,
                canvas_height: canvas.height
            });
        }, 200);

        return;
    }

    if (isDrawMode && drawingStroke && e.buttons === 1) {
        const { scale, offsetX, offsetY } = getTransform();
        const x = (e.offsetX - offsetX) / scale;
        const y = (e.offsetY - offsetY) / scale;

        if (lastDrawPoint) {
            const dist = Math.hypot(x - lastDrawPoint[0], y - lastDrawPoint[1]);
            if (dist < 2) return;
        }

        drawingStroke.points.push([x, y]);
        lastDrawPoint = [x, y];

        scheduleRender();

        // Отправляем с throttle для плавности
        if (!drawThrottle) {
            drawThrottle = setTimeout(() => {
                console.log(`📤 Sending ${drawingStrokes.length} strokes to players`);
                socket.emit('drawings_updated', {
                    map_id: currentMapId,
                    strokes: drawingStrokes,
                    layer_id: currentDrawingLayerId
                });
                drawThrottle = null;
            }, 30);
        }
    }
    if (isRulerMode && rulerStart) {
        const rulerEnd = [
            (e.offsetX - offsetX) / scale,
            (e.offsetY - offsetY) / scale
        ];

        mapData.ruler_start = rulerStart;
        mapData.ruler_end = rulerEnd;

        scheduleRender();

        if (!window.rulerThrottle) {
            window.rulerThrottle = setTimeout(() => {
                socket.emit("ruler_update", {
                    map_id: currentMapId,
                    ruler_start: rulerStart,
                    ruler_end: rulerEnd
                });
                window.rulerThrottle = null;
            }, 30);
        }

        return;
    }

    // Групповое перетаскивание нескольких токенов
    if (isDraggingMultiple && selectedTokens.size > 0) {
        const newX = (mouseX - offsetX) / scale;
        const newY = (mouseY - offsetY) / scale;

        // Перемещаем все выделенные токены
        for (const tokenId of selectedTokens) {
            const token = mapData.tokens.find(t => t.id === tokenId);
            const offset = multiDragOffsets.get(tokenId);

            if (token && offset) {
                token.position = [newX - offset[0], newY - offset[1]];
            }
        }

        // Отправляем перемещения в реальном времени с throttle
        if (!window.multiTokenMoveThrottle) {
            window.multiTokenMoveThrottle = setTimeout(() => {
                for (const tokenId of selectedTokens) {
                    const token = mapData.tokens.find(t => t.id === tokenId);
                    if (token) {
                        socket.emit("token_move", {
                            map_id: currentMapId,
                            token_id: tokenId,
                            position: token.position,
                            is_visible: token.is_visible,
                            is_dead: token.is_dead
                        });
                    }
                }
                window.multiTokenMoveThrottle = null;
            }, 16);
        }

        scheduleRender();
        return;
    }

    // Одиночное перетаскивание
    if (draggingToken || draggingFind) {
        const newX = (mouseX - offsetX) / scale - dragOffset[0];
        const newY = (mouseY - offsetY) / scale - dragOffset[1];

        if (draggingToken) {
            draggingToken.position = [newX, newY];

            if (!window.tokenMoveThrottle) {
                window.tokenMoveThrottle = setTimeout(() => {
                    socket.emit("token_move", {
                        map_id: currentMapId,
                        token_id: draggingToken.id,
                        position: [newX, newY],
                        is_visible: draggingToken.is_visible,
                        is_dead: draggingToken.is_dead
                    });
                    window.tokenMoveThrottle = null;
                }, 16);
            }
        }

        if (draggingFind) draggingFind.position = [newX, newY];
        scheduleRender();
        return;
    }

    // Ховер для находок
    let hovered = null;
    for (const find of mapData.finds) {
        const [x, y] = find.position;
        const sx = x * scale + offsetX;
        const sy = y * scale + offsetY;
        const radius = (mapData.grid_settings.cell_size * scale) / 4;

        if (Math.hypot(mouseX - sx, mouseY - sy) <= radius) {
            hovered = find;
            break;
        }
    }

    const tooltip = document.getElementById("findTooltip");
    if (hovered) {
        tooltip.style.display = "block";
        tooltip.innerHTML = `<strong>${hovered.name}</strong><br>${hovered.description || ""}`;
        tooltip.style.left = `${e.clientX + 12}px`;
        tooltip.style.top = `${e.clientY + 12}px`;
    } else {
        tooltip.style.display = "none";
    }
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

/** Порядок отрисовки: сначала крупные, последними — мелкие (мелкие визуально сверху). */
function getTokensSortedForDrawing(tokens) {
    if (!tokens || !tokens.length) return [];
    return tokens.slice().sort((a, b) => getTokenSizeScale(b) - getTokenSizeScale(a));
}

/** Клик по стопке: приоритет у меньшего токена (тот, что нарисован сверху). При равном размере — раньше в массиве. */
function findTopTokenAtScreenPoint(screenX, screenY, scale, offsetX, offsetY) {
    if (!mapData.tokens || !mapData.tokens.length) return null;
    let best = null;
    let bestRadius = Infinity;
    let bestIndex = Infinity;
    for (let i = 0; i < mapData.tokens.length; i++) {
        const token = mapData.tokens[i];
        const [x, y] = token.position;
        const sx = x * scale + offsetX;
        const sy = y * scale + offsetY;
        const radius = getTokenScreenRadius(token, scale);
        if (Math.hypot(screenX - sx, screenY - sy) <= radius) {
            if (radius < bestRadius || (radius === bestRadius && i < bestIndex)) {
                best = token;
                bestRadius = radius;
                bestIndex = i;
            }
        }
    }
    return best;
}

function getTokenScreenRadius(token, scale) {
    const cellSize = mapData.grid_settings.cell_size * scale;
    return (cellSize * getTokenSizeScale(token)) / 2;
}

function renderTokenContextMenu(token, x, y) {
    const menu = document.getElementById("tokenContextMenu");
    const nameElem = document.getElementById("contextTokenName");
    const statsElem = document.getElementById("contextTokenStats");
    const checkbox = document.getElementById("contextIsDeadCheckbox");
    const hpInput = document.getElementById("contextHpInput");
    const hpMaxInput = document.getElementById("contextHpMaxInput");
    const acInput = document.getElementById("contextAcInput");
    const saveBtn = document.getElementById("contextSaveTokenBtn");

    nameElem.textContent = token.name;
    statsElem.textContent = `КД: ${token.armor_class}, HP: ${token.health_points}/${token.max_health_points}`;

    checkbox.checked = token.is_dead || token.health_points <= 0;

    checkbox.onchange = () => {
        const wasDead = token.is_dead || token.health_points <= 0;
        token.is_dead = checkbox.checked;

        if (checkbox.checked) {
            token.health_points = 0;
        } else if (wasDead) {
            token.health_points = 1;
            combatMoveRevivedTokenToEnd(token.id);
        }

        saveMapData();
        render();
        updateSidebar();
        updateMasterInitiativeStrip();
    };

    // Заполняем поля редактирования
    if (hpInput) {
        hpInput.value = token.health_points ?? token.max_health_points ?? 10;
    }
    if (hpMaxInput) {
        hpMaxInput.value = token.max_health_points ?? token.health_points ?? 10;
    }
    if (acInput) {
        acInput.value = token.armor_class ?? 10;
    }

    // Обработчик сохранения изменений
    if (saveBtn) {
        saveBtn.onclick = () => {
            const wasDeadBefore = token.is_dead || (token.health_points ?? 0) <= 0;
            const newHp = parseInt(hpInput.value, 10);
            const newHpMax = parseInt(hpMaxInput.value, 10);
            const newAc = parseInt(acInput.value, 10);

            if (!Number.isNaN(newHpMax) && newHpMax > 0) {
                // Проверяем, изменилось ли максимальное HP
                const maxHpChanged = token.max_health_points !== newHpMax;

                token.max_health_points = newHpMax;

                if (maxHpChanged) {
                    // Если максимальное HP изменилось, устанавливаем текущее HP равным максимальному
                    token.health_points = newHpMax;
                } else if (!Number.isNaN(newHp) && newHp >= 0) {
                    // Если максимальное HP не изменилось, используем введенное значение
                    token.health_points = newHp;
                }

                if (token.health_points > newHpMax) {
                    token.health_points = newHpMax;
                }
            }

            if (!Number.isNaN(newAc) && newAc > 0) {
                token.armor_class = newAc;
            }

            // Обновляем состояние «мёртв» в зависимости от HP
            token.is_dead = token.health_points <= 0;
            checkbox.checked = token.is_dead;
            if (wasDeadBefore && token.health_points > 0) {
                combatMoveRevivedTokenToEnd(token.id);
            }

            saveMapData();
            render();
            updateSidebar();
            updateMasterInitiativeStrip();
            menu.style.display = "none";
        };
    }

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = "block";
}

canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    hideInitiativeStripContextMenu();
    if (isDrawMode || isEraseMode) {
        // Завершаем текущий штрих если есть
        if (drawingStroke) {
            if (drawThrottle) {
                clearTimeout(drawThrottle);
                drawThrottle = null;
            }

            if (drawingStroke.points.length > 1) {
                saveDrawingStateToHistory();
                saveDrawings();
                socket.emit('drawings_updated', {
                    map_id: currentMapId,
                    strokes: drawingStrokes,
                    layer_id: currentDrawingLayerId
                });
            }

            drawingStroke = null;
            lastDrawPoint = null;
        }

        isDrawMode = false;
        isEraseMode = false;

        // Обновляем кнопки
        const drawToggle = document.getElementById('drawToggle');
        const eraserToggle = document.getElementById('eraserToggle');

        if (drawToggle) drawToggle.classList.remove('active');
        if (eraserToggle) eraserToggle.classList.remove('active');

        updateCanvasCursor();
        render();
        console.log("Drawing/Erase mode disabled with right-click");
        return;
    }
    if (isRulerMode) {
        isRulerMode = false;
        rulerStart = null;
        mapData.ruler_start = null;
        mapData.ruler_end = null;

        // НОВОЕ: Отключаем видимость линейки для игроков
        mapData.ruler_visible_to_players = false;

        // Обновляем кнопку в интерфейсе мастера
        const playerRulerToggle = document.getElementById("playerRulerToggle");
        if (playerRulerToggle) {
            playerRulerToggle.classList.remove("active");
        }

        // Отправляем обновление линейки
        socket.emit("ruler_update", {
            map_id: currentMapId,
            ruler_start: null,
            ruler_end: null
        });

        // НОВОЕ: Отправляем событие об изменении видимости для игроков
        socket.emit("ruler_visibility_change", {
            map_id: currentMapId,
            ruler_visible_to_players: false
        });

        // Обновляем кнопку линейки мастера
        const rulerBtn = document.getElementById("rulerToggle");
        if (rulerBtn) {
            rulerBtn.classList.remove("active");
        }

        saveMapData();
        render();
        updateCanvasCursor();
        console.log("Ruler disabled with right-click, player visibility also disabled");
        return;
    }
    const { scale, offsetX, offsetY } = getTransform();

    const ctxToken = findTopTokenAtScreenPoint(e.offsetX, e.offsetY, scale, offsetX, offsetY);
    if (ctxToken) {
        e.preventDefault();
        selectedTokenId = ctxToken.id;
        showTokenContextMenu(ctxToken, e.pageX, e.pageY);
        return;
    }

    // Проверяем клик по находке
    for (const find of mapData.finds) {
        const [x, y] = find.position;
        const sx = x * scale + offsetX;
        const sy = y * scale + offsetY;
        const radius = (mapData.grid_settings.cell_size * scale) / 2;

        if (Math.hypot(e.offsetX - sx, e.offsetY - sy) <= radius) {
            e.preventDefault();
            selectedFindId = find.id;
            showFindContextMenu(find, e.pageX, e.pageY);
            return;
        }
    }

    // Проверяем клик по зоне
    for (const zone of mapData.zones) {
        if (!zone.vertices || zone.vertices.length < 3) continue;

        const transformed = zone.vertices.map(([vx, vy]) => [vx * scale + offsetX, vy * scale + offsetY]);
        if (pointInPolygon([e.offsetX, e.offsetY], transformed)) {
            e.preventDefault();
            selectedZoneId = zone.id;
            clearSelectedVertex();
            showZoneContextMenu(zone, e.pageX, e.pageY);
            return;
        }
    }

    // Если кликнули не по объекту, проверяем режим рисования зоны
    if (drawingZone) {
        if (currentZoneVertices.length < 3) {
            alert("Зона должна иметь минимум 3 точки.");
            drawingZone = false;
            currentZoneVertices = [];
            updateCanvasCursor();

            const hint = document.getElementById('drawing-hint');
            if (hint) hint.remove();

            return;
        }

        const newZoneVertices = [...currentZoneVertices];
        pendingZoneVertices = [...currentZoneVertices];
        drawingZone = false;
        currentZoneVertices = [];
        updateCanvasCursor();

        const hint = document.getElementById('drawing-hint');
        if (hint) hint.remove();

        document.getElementById("zoneName").value = "";
        document.getElementById("zoneDescription").value = "";
        document.getElementById("zoneModalTitle").textContent = "Создание зоны";
        document.getElementById("zoneModal").style.display = "flex";
        document.getElementById("zoneVisibleCheckbox").checked = false;

        const hasIntersection = mapData.zones.some(z =>
            z.vertices && z.vertices.length >= 3 && zonesIntersect(z.vertices, newZoneVertices)
        );

        // if (hasIntersection) {
        //   alert("Новая зона пересекается с существующей! Измените форму.");
        //   return;
        // }
        return;
    }
});


canvas.addEventListener("mouseup", () => {
    // Очищаем таймер
    if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
    }

    // Завершаем групповое перетаскивание
    if (isDraggingMultiple && selectedTokens.size > 0) {
        if (window.multiTokenMoveThrottle) {
            clearTimeout(window.multiTokenMoveThrottle);
            window.multiTokenMoveThrottle = null;
        }

        // Отправляем финальные позиции всех токенов
        for (const tokenId of selectedTokens) {
            const token = mapData.tokens.find(t => t.id === tokenId);
            if (token) {
                socket.emit("token_move", {
                    map_id: currentMapId,
                    token_id: tokenId,
                    position: token.position,
                    is_visible: token.is_visible,
                    is_dead: token.is_dead
                });
            }
        }

        // Сохраняем на сервере
        saveMapData();
    }

    // Обычное завершение перетаскивания
    if (draggingToken || draggingFind) {
        if (window.tokenMoveThrottle) {
            clearTimeout(window.tokenMoveThrottle);
            window.tokenMoveThrottle = null;
        }

        if (draggingToken) {
            socket.emit("token_move", {
                map_id: currentMapId,
                token_id: draggingToken.id,
                position: draggingToken.position,
                is_visible: draggingToken.is_visible,
                is_dead: draggingToken.is_dead
            });
        }

        debouncedSave(300);
    }

    if (drawingStroke) {
        if (drawThrottle) {
            clearTimeout(drawThrottle);
            drawThrottle = null;
        }

        // Сохраняем состояние после завершения штриха
        // Но только если штрих имеет больше 1 точки (реальный штрих)
        if (drawingStroke.points.length > 1) {
            saveDrawingStateToHistory();
        }

        // Сохраняем на сервере
        saveDrawings();

        // Отправляем финальное обновление всем
        console.log(`📤 Final send: ${drawingStrokes.length} strokes`);
        socket.emit('drawings_updated', {
            map_id: currentMapId,
            strokes: drawingStrokes,
            layer_id: currentDrawingLayerId
        });

        drawingStroke = null;
        lastDrawPoint = null;
    }

    // Завершаем линейку
    if (isRulerMode && rulerStart && window.rulerThrottle) {
        clearTimeout(window.rulerThrottle);
        socket.emit("ruler_update", {
            map_id: currentMapId,
            ruler_start: rulerStart,
            ruler_end: mapData.ruler_end
        });
        window.rulerThrottle = null;
    }

    draggingToken = null;
    draggingFind = null;
    isDraggingMultiple = false;
    multiDragOffsets.clear();

    // Завершение перетаскивания вершины зоны — чекпоинт в общей истории отмены
    if (draggingVertexZoneId !== null) {
        draggingVertexZoneId = null;
        draggingVertexIndex  = -1;
        saveDrawingStateToHistory();
        debouncedSave(300);
        render();
    }

    if (isPanning) {
        isPanning = false;
    }
    updateCanvasCursor();
});


canvas.addEventListener("mouseleave", () => {
    if (isPanning) {
        isPanning = false;
        updateCanvasCursor();
    }
    if (draggingVertexZoneId !== null) {
        draggingVertexZoneId = null;
        draggingVertexIndex  = -1;
        saveDrawingStateToHistory();
        debouncedSave(300);
        render();
    }
    if (hoveredVertexIndex >= 0) {
        hoveredVertexIndex  = -1;
        hoveredVertexZoneId = null;
        scheduleRender();
    }
});

let zoomSyncTimeout;

canvas.addEventListener("click", (e) => {
    const { scale, offsetX, offsetY } = getTransform();
    const isShiftPressed = e.shiftKey;

    if (!isClick) return;

    const clickedToken = findTopTokenAtScreenPoint(e.offsetX, e.offsetY, scale, offsetX, offsetY);

    if (clickedToken && !isShiftPressed) {
        selectedTokens.clear();
        selectedTokens.add(clickedToken.id);
        selectedTokenId = clickedToken.id;

        selectedZoneId = null;
        selectedFindId = null;
        selectedCharacterId = null;
        clearSelectedVertex();

        updateSidebar();
        render();
    }
});

canvas.addEventListener("dblclick", (e) => {
    if (!currentMapId || !mapData) return;
    if (drawingZone || isDrawMode || isEraseMode || isRulerMode) return;
    if (e.button !== 0) return;
    if (tryInsertZoneVertexOnEdge(e.offsetX, e.offsetY)) {
        e.preventDefault();
    }
});

canvas.addEventListener("wheel", (e) => {
    e.preventDefault();

    const { scale } = getTransform();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const worldX = (mouseX - panX) / scale;
    const worldY = (mouseY - panY) / scale;

    const zoomStep = 0.1;
    const delta = e.deltaY > 0 ? -zoomStep : zoomStep;
    zoomLevel = Math.min(Math.max(zoomLevel + delta, 0.1), 5);
    mapData.zoom_level = zoomLevel;

    const { scale: newScale } = getTransform();
    panX = mouseX - worldX * newScale;
    panY = mouseY - worldY * newScale;

    invalidateBg();
    scheduleRender();

    clearTimeout(zoomSyncTimeout);
    zoomSyncTimeout = setTimeout(() => {
        // Отправляем данные о масштабе на сервер
        socket.emit("zoom_update", {
            map_id: currentMapId,  // Убедитесь, что currentMapId определен
            zoom_level: zoomLevel,
            pan_x: panX,
            pan_y: panY,
            canvas_width: canvas.width,
            canvas_height: canvas.height
        });
    }, 200);
});

document.addEventListener("keydown", (e) => {
    // Проверяем, не находится ли фокус на поле ввода
    const isInputActive = document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA' ||
        document.activeElement.isContentEditable;

    // Обработка Escape - всегда работает, даже если фокус на поле ввода
    if (e.key === "Escape") {
        if (initiativeStripMenuTokenId) {
            hideInitiativeStripContextMenu();
            e.preventDefault();
            return;
        }

        e.preventDefault(); // Предотвращаем стандартное поведение браузера

        // Проверяем, открыто ли какое-либо модальное окно
        const anyModalOpen = [
            'characterModal',
            'tokenModal',
            'findModal',
            'zoneModal',
            'mapModal',
            'importTokenModal',
            'importPortraitModal',
            'bankModal',
            'newMapModal',
            'bankCharacterModal',
            'combatModal'
        ].some(modalId => {
            const modal = document.getElementById(modalId);
            return modal && modal.style.display === 'flex';
        });

        if (anyModalOpen) {
            // Если открыто модальное окно - закрываем все модалки
            closeAllModals();
        } else {
            // Если модалки закрыты, обрабатываем другие режимы

            const hasVertexHandle =
                selectedVertexZoneId != null && selectedVertexIndex >= 0;
            const hasObjectSelection =
                hasVertexHandle ||
                Boolean(selectedTokenId) ||
                Boolean(selectedFindId) ||
                Boolean(selectedZoneId) ||
                selectedTokens.size > 0;

            if (hasObjectSelection) {
                selectedTokens.clear();
                selectedTokenId = null;
                selectedFindId = null;
                selectedZoneId = null;
                clearSelectedVertex();
                hoveredVertexIndex = -1;
                hoveredVertexZoneId = null;
                draggingVertexZoneId = null;
                draggingVertexIndex = -1;
                draggingToken = null;
                draggingFind = null;
                isDraggingMultiple = false;
                multiDragOffsets.clear();
                multiDragStartPositions.clear();

                [
                    "tokenContextMenu",
                    "findContextMenu",
                    "zoneContextMenu",
                    "characterContextMenu",
                    "mapContextMenu"
                ].forEach((menuId) => {
                    const menu = document.getElementById(menuId);
                    if (menu) menu.style.display = "none";
                });
                hideInitiativeStripContextMenu();

                updateSidebar();
                render();
                updateCanvasCursor();
                return;
            }

            if (isDrawMode || isEraseMode) {
                // Завершаем текущий штрих если есть
                if (drawingStroke) {
                    if (drawThrottle) {
                        clearTimeout(drawThrottle);
                        drawThrottle = null;
                    }

                    if (drawingStroke.points.length > 1) {
                        saveDrawingStateToHistory();
                        saveDrawings();
                        socket.emit('drawings_updated', {
                            map_id: currentMapId,
                            strokes: drawingStrokes,
                            layer_id: currentDrawingLayerId
                        });
                    }

                    drawingStroke = null;
                    lastDrawPoint = null;
                }

                isDrawMode = false;
                isEraseMode = false;

                // Обновляем кнопки
                document.getElementById('drawToggle').classList.remove('active');
                document.getElementById('eraserToggle').classList.remove('active');

                updateCanvasCursor();
                render();
                console.log("Drawing/Erase mode disabled with Escape");
            }

            // Отключаем линейку
            if (isRulerMode) {
                isRulerMode = false;
                rulerStart = null;
                mapData.ruler_start = null;
                mapData.ruler_end = null;

                // Отключаем видимость линейки для игроков
                mapData.ruler_visible_to_players = false;

                // Обновляем кнопку в интерфейсе мастера
                const playerRulerToggle = document.getElementById("playerRulerToggle");
                if (playerRulerToggle) {
                    playerRulerToggle.classList.remove("active");
                }

                // Отправляем обновление линейки
                socket.emit("ruler_update", {
                    map_id: currentMapId,
                    ruler_start: null,
                    ruler_end: null
                });

                socket.emit("ruler_visibility_change", {
                    map_id: currentMapId,
                    ruler_visible_to_players: false
                });

                // Обновляем кнопку линейки мастера
                const rulerBtn = document.getElementById("rulerToggle");
                if (rulerBtn) {
                    rulerBtn.classList.remove("active");
                }

                saveMapData();
                render();
                updateCanvasCursor();
                console.log("Ruler disabled with Escape, player visibility also disabled");
            }

            // Отключаем рисование зон
            if (drawingZone) {
                drawingZone = false;
                currentZoneVertices = [];
                updateCanvasCursor();

                // Удаляем подсказку
                const hint = document.getElementById('drawing-hint');
                if (hint) hint.remove();

                render();
            }

            // Закрываем контекстные меню
            const contextMenus = [
                'tokenContextMenu',
                'findContextMenu',
                'zoneContextMenu',
                'characterContextMenu',
                'mapContextMenu'
            ];

            contextMenus.forEach(menuId => {
                const menu = document.getElementById(menuId);
                if (menu) {
                    menu.style.display = 'none';
                }
            });
        }

        return; // Выходим, чтобы не обрабатывать другие клавиши
    }

    // Если фокус на поле ввода - не перехватываем комбинации клавиш
    if (isInputActive) {
        return; // Позволяем стандартному поведению (включая Ctrl+V)
    }

    if ((e.ctrlKey || e.metaKey)) {
        // Проверяем разные варианты клавиш (английская Z, русская Я, а также код клавиши)
        const key = e.key.toLowerCase();
        const code = e.code;

        // Проверяем, является ли нажатая клавиша Z (в любой раскладке)
        const isZKey = key === 'z' || key === 'я' || code === 'KeyZ';

        // Проверяем, является ли нажатая клавиша Y (для Ctrl+Y)
        const isYKey = key === 'y' || key === 'н' || code === 'KeyY';

        // Обработка Ctrl+Z: единая история (рисунки + зоны)
        if (isZKey && !e.shiftKey) {
            e.preventDefault();

            // Проверяем, не открыто ли модальное окно
            const anyModalOpen = checkAnyModalOpen();

            if (!anyModalOpen) {
                if (!masterUndo()) {
                    showUndoNotification('Нечего отменять');
                }
            }
            return;
        }

        // Обработка Ctrl+Shift+Z или Ctrl+Y для повтора
        if ((e.shiftKey && isZKey) || (isYKey && !e.shiftKey)) {
            e.preventDefault();

            const anyModalOpen = checkAnyModalOpen();

            if (!anyModalOpen) {
                if (!masterRedo()) {
                    showUndoNotification('Нечего повторять');
                }
            }
            return;
        }
    }

    if (e.key === "Delete") {
        // Удаление вершины: только явно выделенной (клик по ручке)
        if (!drawingZone && selectedVertexZoneId != null && selectedVertexIndex >= 0 && mapData?.zones &&
            selectedVertexZoneId === selectedZoneId) {
            const zid = selectedVertexZoneId;
            const vidx = selectedVertexIndex;
            const zone = mapData.zones.find(z => z.id === zid);
            if (zone && zone.vertices && vidx < zone.vertices.length) {
                e.preventDefault();
                zone.vertices.splice(vidx, 1);
                if (zone.vertices.length < 3) {
                    mapData.zones = mapData.zones.filter(z => z.id !== zid);
                    if (selectedZoneId === zid) selectedZoneId = null;
                }
                clearSelectedVertex();
                hoveredVertexIndex  = -1;
                hoveredVertexZoneId = null;
                saveDrawingStateToHistory();
                debouncedSave(300);
                invalidateBg();
                render();
                updateSidebar();
                return;
            }
        }

        let changed = false;

        // Удаление нескольких выделенных токенов
        if (selectedTokens.size > 0) {
            // Подтверждение удаления
            if (selectedTokens.size === 1) {
                const token = mapData.tokens.find(t => t.id === Array.from(selectedTokens)[0]);
                if (!confirm(`Удалить токен "${token?.name}"?`)) {
                    return;
                }
            } else {
                if (!confirm(`Удалить ${selectedTokens.size} выделенных токенов?`)) {
                    return;
                }
            }

            // Удаляем все выделенные токены
            const tokensToDelete = Array.from(selectedTokens);

            // Для каждого токена отправляем запрос на удаление на сервер
            tokensToDelete.forEach(tokenId => {
                fetch(`/api/token/${tokenId}?map_id=${currentMapId}`, {
                    method: 'DELETE'
                })
                    .then(response => response.json())
                    .then(data => {
                        if (data.status === 'token deleted') {
                            console.log(`Token ${tokenId} deleted successfully`);
                        }
                    })
                    .catch(err => console.error(`Error deleting token ${tokenId}:`, err));
            });

            // Удаляем токены из локальных данных
            mapData.tokens = mapData.tokens.filter(t => !selectedTokens.has(t.id));

            // Очищаем выделение
            selectedTokens.clear();
            selectedTokenId = null;
            changed = true;
        }
        // Существующий код для одиночного токена
        else if (selectedTokenId) {
            if (!confirm(`Удалить токен?`)) {
                return;
            }

            fetch(`/api/token/${selectedTokenId}?map_id=${currentMapId}`, {
                method: 'DELETE'
            })
                .then(response => response.json())
                .then(data => {
                    if (data.status === 'token deleted') {
                        console.log('Token deleted successfully');
                    }
                })
                .catch(err => console.error('Error deleting token:', err));

            // Удаляем токен из локальных данных
            mapData.tokens = mapData.tokens.filter(t => t.id !== selectedTokenId);
            selectedTokenId = null;
            changed = true;
        }

        // Существующий код для зон
        if (selectedZoneId) {
            if (!confirm(`Удалить зону?`)) return;
            mapData.zones = mapData.zones.filter(z => z.id !== selectedZoneId);
            selectedZoneId = null;
            clearSelectedVertex();
            changed = true;
        }

        // Существующий код для находок
        if (selectedFindId) {
            if (!confirm(`Удалить находку?`)) return;
            mapData.finds = mapData.finds.filter(f => f.id !== selectedFindId);
            selectedFindId = null;
            changed = true;
        }

        // Код для портретов
        if (selectedCharacterId) {
            if (!confirm(`Удалить портрет?`)) return;

            const character = mapData.characters?.find(c => c.id === selectedCharacterId);
            if (character) {
                fetch(`/api/portrait/${selectedCharacterId}`, {
                    method: 'DELETE'
                }).catch(err => console.error('Error deleting portrait:', err));

                mapData.characters = mapData.characters.filter(c => c.id !== selectedCharacterId);
                changed = true;
            }
            selectedCharacterId = null;
        }

        if (changed) {
            render();
            saveMapData();
            updateSidebar();
        }
    }

    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') {
        // Проверяем, есть ли выбранный токен
        if (selectedTokenId) {
            e.preventDefault(); // Блокируем только если есть выбранный токен
            copySelectedToken();
        }
        // Если нет выбранного токена - ничего не делаем, позволяем стандартному поведению
    }

    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
        e.preventDefault();
        pasteToken();
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD') {
        e.preventDefault();
        copySelectedToken();
        pasteToken();
    }
});


function openFindModal(find = null) {
    const modal = document.getElementById("findModal");
    const title = document.getElementById("findModalTitle");

    modal.style.display = "flex";

    if (find) {
        editingFindId = find.id;
        title.textContent = "Редактирование находки";
        document.getElementById("findName").value = find.name;
        document.getElementById("findDescription").value = find.description || "";
        document.getElementById("findVisibleCheckbox").checked = !!find.status;
    } else {
        editingFindId = null;
        title.textContent = "Создание находки";
        document.getElementById("findName").value = "";
        document.getElementById("findDescription").value = "";
        document.getElementById("findVisibleCheckbox").checked = false;
    }
}

function closeFindModal() {
    document.getElementById("findModal").style.display = "none";
    editingFindId = null;
}

function closeZoneModal() {
    document.getElementById("zoneModal").style.display = "none";
    editingZoneId = null;
    pendingZoneVertices = null;
}

function submitZone() {
    const isVisible = document.getElementById("zoneVisibleCheckbox").checked;
    const name = document.getElementById("zoneName").value.trim();
    const description = document.getElementById("zoneDescription").value.trim();

    if (!name || !pendingZoneVertices) {
        alert("Введите имя зоны.");
        return;
    }

    if (selectedZoneId) {
        // Редактирование существующей зоны
        const zone = mapData.zones.find(z => z.id === selectedZoneId);
        if (zone) {
            zone.name = name;
            zone.description = description;
            zone.vertices = [...pendingZoneVertices];
            zone.is_visible = isVisible;
        }
    } else {
        // Проверка на пересечение для новой зоны
        const hasIntersection = mapData.zones.some(z =>
            z.vertices && z.vertices.length >= 3 && zonesIntersect(z.vertices, pendingZoneVertices)
        );

        // if (hasIntersection) {
        //   alert("Новая зона пересекается с существующей! Измените форму.");
        //   return;
        // }

        const newZone = {
            id: `zone_${Date.now()}`,
            name,
            description,
            vertices: [...pendingZoneVertices],
            is_visible: isVisible,
        };
        mapData.zones.push(newZone);
    }

    selectedZoneId = null;
    pendingZoneVertices = null;
    document.getElementById("zoneModal").style.display = "none";
    render();
    updateSidebar();

    saveMapData();
}


function submitFind() {
    const name = document.getElementById("findName").value.trim();
    const description = document.getElementById("findDescription").value.trim();

    if (!name) {
        alert("Введите имя находки");
        return;
    }

    if (editingFindId) {
        const find = mapData.finds.find(f => f.id === editingFindId);
        if (find) {
            find.name = name;
            find.description = description;
            saveMapData();
            closeFindModal();
            render();
            updateSidebar();
        }
    } else {
        const centerX = mapImage.width ? mapImage.width / 2 : 500;
        const centerY = mapImage.height ? mapImage.height / 2 : 500;

        const find = {
            id: `find_${Date.now()}`,
            name,
            description,
            position: [centerX, centerY],
            size: mapData.grid_settings.cell_size / 4,
            status: false,
            map_id: currentMapId
        };

        fetch("/api/find", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(find),
        }).then(() => {
            closeFindModal();
            fetchMap();
        });
    }
}

function updateSliderVisual() {
    const rawPercent = ((gridSlider.value - gridSlider.min) / (gridSlider.max - gridSlider.min)) * 100;
    const adjustedPercent = Math.min(rawPercent + 2, 100);
    gridSlider.style.setProperty('--percent', `${adjustedPercent}%`);
}

socket.on("maps_list_updated", (data) => {
    if (data.maps) {
        mapsList = data.maps;
        renderMapsList(data.maps);
    }
});

window.onload = () => {
    // Инициализируем кеш и предзагружаем все ассеты пачками по 4
    dndCache.init().then(() => {
        const indicator = document.createElement('div');
        indicator.id = 'master-cache-indicator';
        indicator.style.cssText = `
            position:fixed;bottom:16px;right:16px;
            background:rgba(0,0,0,.75);color:#fff;
            font-size:12px;padding:6px 12px;border-radius:8px;
            z-index:9999;pointer-events:none;transition:opacity .4s;
        `;
        indicator.textContent = 'Загрузка карт...';
        document.body.appendChild(indicator);

        const hideIndicator = () => {
            indicator.textContent = 'Карты загружены ✓';
            setTimeout(() => { indicator.style.opacity = '0'; }, 1500);
            setTimeout(() => { indicator.remove(); }, 2000);
        };

        dndCache.preloadAll({
            master: true,
            onProgress(loaded, total) {
                if (total === 0) { hideIndicator(); return; }
                indicator.textContent = `Загрузка карт: ${loaded}/${total}`;
                if (loaded >= total) hideIndicator();
            }
        }).then(() => {
            // На случай если onProgress не дошёл до total (все из кеша)
            const ind = document.getElementById('master-cache-indicator');
            if (ind) hideIndicator();
        }).catch(() => { indicator.remove(); });
    });

    loadMapsList();

    // ===== ИСПРАВЛЕННЫЙ КОД: загружаем сохраненную карту =====
    const savedMapId = loadCurrentMapFromStorage();

    window.addEventListener('beforeunload', () => {
        // Освобождаем блокировку при закрытии
        fetch('/api/master/release', { method: 'POST' });
    });

    // Сначала загружаем список карт, потом проверяем сохраненную
    fetch("/api/maps")
        .then(res => res.json())
        .then(maps => {
            if (maps.length > 0) {
                // Проверяем, существует ли сохраненная карта
                const savedMapExists = savedMapId && maps.some(map => map.id === savedMapId);

                if (savedMapExists) {
                    // Загружаем сохраненную карту
                    console.log('Loading saved map:', savedMapId);
                    switchMap(savedMapId);
                } else {
                    // Если сохраненной нет, загружаем первую
                    console.log('Loading first map:', maps[0].id);
                    switchMap(maps[0].id);
                    // Сохраняем первую карту как текущую
                    saveCurrentMapToStorage(maps[0].id);
                }
            } else {
                // Если карт нет
                switchMap(null);
            }
        })
        .catch(err => {
            console.error("Error loading maps:", err);
        });
    // ===== КОНЕЦ ИСПРАВЛЕННОГО КОДА =====

    setupEnterHandler("contextDamageInput", "contextApplyDamage");
    setupEnterHandler("contextHealInput", "contextApplyHeal");
    setupEnterHandler("contextAcInput", "contextApplyAc");

    const toggleBtn = document.getElementById("togglePlayerMini");
    const openPlayerPageBtn = document.getElementById("openPlayerPageBtn");

    function getPlayerPageUrl() {
        const pid = window.__DND_PROJECT_ID__;
        if (currentMapId && pid) {
            return `/player?map_id=${encodeURIComponent(currentMapId)}&project_id=${encodeURIComponent(pid)}`;
        }
        if (currentMapId) {
            return `/player?map_id=${encodeURIComponent(currentMapId)}`;
        }
        return "/player?no_map=1";
    }

    function openPlayerPageInNewTab() {
        window.open(getPlayerPageUrl(), "_blank", "noopener,noreferrer");
    }
    window.openPlayerPageInNewTab = openPlayerPageInNewTab;

    if (openPlayerPageBtn) {
        openPlayerPageBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openPlayerPageInNewTab();
        });
    }

    function updateMiniToggleIcon() {
        const btn = document.getElementById("togglePlayerMini");
        if (btn) btn.innerHTML = mapData && mapData.player_map_enabled !== false ? getOpenEyeSVG() : getClosedEyeSVG();
    }
    window.updateMiniToggleIcon = updateMiniToggleIcon;

    if (toggleBtn) toggleBtn.addEventListener("click", () => {
        const mapIdToUse =
            currentMapId ||
            document.getElementById("mapSelect")?.value ||
            null;

        if (!mapIdToUse) {
            console.warn("togglePlayerMini: missing map_id (currentMapId is null)");
            return;
        }

        if (!mapData) mapData = {};
        if (mapData.player_map_enabled === undefined) mapData.player_map_enabled = true;

        const enabled = mapData.player_map_enabled !== false;
        mapData.player_map_enabled = !enabled;

        updateMiniToggleIcon();

        // Сохраняем на сервере/рассылаем через сокет (это быстрее, чем POST на /api/map
        // с полным содержимым карты).
        socket.emit("player_visibility_change", {
            map_id: mapIdToUse,
            player_map_enabled: mapData.player_map_enabled,
        });
    });

    updateMiniToggleIcon();

    document.querySelectorAll(".type-btn").forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll(".type-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
        };
    });

    const gridSlider = document.getElementById('gridSlider');
    gridSlider.addEventListener('input', updateSliderVisual);

    const rulerBtn = document.getElementById("rulerToggle");
    rulerBtn.addEventListener("click", () => {
        // Если включаем линейку
        if (!isRulerMode) {
            // Выключаем режимы рисования
            if (isDrawMode || isEraseMode) {
                isDrawMode = false;
                isEraseMode = false;
                document.getElementById('drawToggle').classList.remove('active');
                document.getElementById('eraserToggle').classList.remove('active');

                // Завершаем текущий штрих если есть
                if (drawingStroke) {
                    if (drawThrottle) {
                        clearTimeout(drawThrottle);
                        drawThrottle = null;
                    }
                    if (drawingStroke.points.length > 1) {
                        saveDrawingStateToHistory();
                        saveDrawings();
                    }
                    drawingStroke = null;
                    lastDrawPoint = null;
                }
            }

            // Выключаем режим рисования зон
            if (drawingZone) {
                drawingZone = false;
                currentZoneVertices = [];
                const hint = document.getElementById('drawing-hint');
                if (hint) hint.remove();
            }
        }

        isRulerMode = !isRulerMode;

        if (!isRulerMode) {
            mapData.ruler_start = null;
            mapData.ruler_end = null;

            socket.emit("ruler_update", {
                map_id: currentMapId,
                ruler_start: null,
                ruler_end: null
            });

            debouncedSave(300);
        } else {
            rulerStart = null;
        }

        rulerBtn.classList.toggle("active", isRulerMode);

        // ВАЖНО: принудительно перерисовываем канвас
        render();
        updateCanvasCursor();
    });

    const gridToggle = document.getElementById("gridToggle");
    gridToggle.addEventListener("click", () => {
        gridToggle.classList.toggle("active");
        mapData.grid_settings.visible = gridToggle.classList.contains("active");
        invalidateBg();
        render();
        saveMapData();
    });

    const playerGridToggle = document.getElementById("playerGridToggle");
    playerGridToggle.addEventListener("click", () => {
        const current = mapData.grid_settings.visible_to_players ?? true;
        mapData.grid_settings.visible_to_players = !current;
        playerGridToggle.classList.toggle("active", !current);
        saveMapData();
    });

    const playerRulerToggle = document.getElementById("playerRulerToggle");
    playerRulerToggle.addEventListener("click", () => {
        const current = mapData.ruler_visible_to_players ?? false;
        mapData.ruler_visible_to_players = !current;
        playerRulerToggle.classList.toggle("active", mapData.ruler_visible_to_players);

        saveMapData();

        socket.emit("ruler_visibility_change", {
            map_id: currentMapId,
            ruler_visible_to_players: mapData.ruler_visible_to_players
        });
    });

    const combatBtn = document.getElementById("combatToggle");
    if (combatBtn) {
        combatBtn.addEventListener("click", () => {
            if (mapData.combat && mapData.combat.active) {
                if (confirm("Закончить бой? Полоса инициативы исчезнет у всех.")) {
                    endCombat();
                }
            } else {
                openCombatSetupModal();
            }
        });
    }

    const combatModalClose = document.getElementById("combatModalClose");
    if (combatModalClose) {
        combatModalClose.addEventListener("click", closeCombatSetupModal);
    }
    const combatModalCancel = document.getElementById("combatModalCancel");
    if (combatModalCancel) {
        combatModalCancel.addEventListener("click", closeCombatSetupModal);
    }
    const combatModalStart = document.getElementById("combatModalStart");
    if (combatModalStart) {
        combatModalStart.addEventListener("click", startCombatFromModal);
    }

    const initiativeStripEditInit = document.getElementById("initiativeStripEditInit");
    if (initiativeStripEditInit) {
        initiativeStripEditInit.addEventListener("click", (e) => {
            e.stopPropagation();
            const id = initiativeStripMenuTokenId;
            if (!id || !mapData.combat || !mapData.combat.entries) return;
            const entry = mapData.combat.entries.find((x) => x.id === id);
            if (!entry) return;
            const raw = prompt("Новая инициатива:", String(entry.initiative ?? 0));
            if (raw === null) return;
            const n = parseInt(raw, 10);
            if (Number.isNaN(n)) {
                alert("Введите целое число.");
                return;
            }
            entry.initiative = n;
            resortCombatEntriesByInitiative();
            hideInitiativeStripContextMenu();
            saveMapData();
            updateMasterInitiativeStrip();
            render();
        });
    }
    const initiativeStripLeaveCombat = document.getElementById("initiativeStripLeaveCombat");
    if (initiativeStripLeaveCombat) {
        initiativeStripLeaveCombat.addEventListener("click", (e) => {
            e.stopPropagation();
            const id = initiativeStripMenuTokenId;
            if (!id) return;
            combatLeaveToken(id);
            hideInitiativeStripContextMenu();
            saveMapData();
            updateMasterInitiativeStrip();
            render();
        });
    }

    const findVisibleCheckbox = document.getElementById("findVisibleCheckbox");
    findVisibleCheckbox.addEventListener("change", () => {
        if (!editingFindId) return;

        const find = mapData.finds.find(f => f.id === editingFindId);
        if (find) {
            find.status = findVisibleCheckbox.checked;
            saveMapData();
            render();
            updateSidebar();
        }
    });

    document.addEventListener("click", (e) => {
        const tokenMenu = document.getElementById("tokenContextMenu");
        const findMenu = document.getElementById("findContextMenu");
        const zoneMenu = document.getElementById("zoneContextMenu");
        const characterMenu = document.getElementById("characterContextMenu");
        const mapMenu = document.getElementById("mapContextMenu");

        const initStripMenu = document.getElementById("initiativeStripContextMenu");

        if (!tokenMenu?.contains(e.target) &&
            !findMenu?.contains(e.target) &&
            !zoneMenu?.contains(e.target) &&
            !characterMenu?.contains(e.target) &&
            !mapMenu?.contains(e.target) &&
            !initStripMenu?.contains(e.target)) {

            if (tokenMenu) tokenMenu.style.display = "none";
            if (findMenu) findMenu.style.display = "none";
            if (zoneMenu) zoneMenu.style.display = "none";
            if (characterMenu) characterMenu.style.display = "none";
            if (mapMenu) mapMenu.style.display = "none";
            hideInitiativeStripContextMenu();
        }
    });

    updateSliderVisual();
    initSidebarCollapse();
};
socket.on("map_created", (data) => {
    console.log("Map created event received:", data);

    saveCurrentMapToStorage(data.current_map);

    const select = document.getElementById("mapSelect");
    if (!select) {
        console.warn("mapSelect element not found; skipping select update");
    } else {
        select.innerHTML = "";
        data.maps.forEach((map) => {
            const option = document.createElement("option");
            option.value = map.id;
            option.textContent = map.name;
            if (map.id === data.current_map) option.selected = true;
            select.appendChild(option);
        });
    }

    // Не подменяем mapData заглушкой и не рендерим со старым drawingStrokes — иначе
    // штрихи с прошлой карты «наезжают» на новую. Если switchMap уже идёт (создатель
    // после POST), только обновили список карт выше.
    if (isSwitchingMap) {
        if (window.updateMiniToggleIcon) {
            queueMicrotask(() => window.updateMiniToggleIcon());
        }
        return;
    }

    switchMap(data.current_map);

    if (window.updateMiniToggleIcon) {
        queueMicrotask(() => window.updateMiniToggleIcon());
    }
});
socket.on("map_image_updated", (data) => {
    if (data.map_id === currentMapId && data.new_image_url) {
        // Инвалидируем старый URL, загружаем новый через кеш
        if (mapData?.image_url) dndCache.invalidate(mapData.image_url);
        mapData.image_url = data.new_image_url;
        mapData.has_image = true;

        dndCache.fetch(data.new_image_url).then(src => {
            mapImage = new Image();
            mapImage.onload = () => { invalidateBg(); render(); };
            mapImage.src = src || data.new_image_url;
        });
    }
});

socket.on("request_image_reload", (data) => {
    if (data.map_id === currentMapId) {
        // Перезагружаем изображение
        const imageUrl = mapData?.image_url || `/api/map/image/${currentMapId}`;
        mapImage = new Image();
        mapImage.onload = () => {
            render();
        };
        mapImage.src = imageUrl;
    }
});

function updateCanvasCursor() {
    canvas.classList.remove(
        'zone-drawing-mode', 'ruler-mode', 'token-dragging',
        'map-panning', 'multi-dragging', 'draw-mode', 'erase-mode'
    );

    if (isDrawMode) {
        canvas.classList.add('draw-mode');
    } else if (isEraseMode) {
        canvas.classList.add('erase-mode');
    } else if (draggingVertexZoneId !== null || hoveredVertexIndex >= 0) {
        canvas.style.cursor = 'move';
    } else if (drawingZone) {
        canvas.classList.add('zone-drawing-mode');
    } else if (isRulerMode) {
        canvas.classList.add('ruler-mode');
    } else if (isDraggingMultiple) {
        canvas.classList.add('multi-dragging');
    } else if (draggingToken || draggingFind) {
        canvas.classList.add('token-dragging');
    } else if (isPanning) {
        canvas.classList.add('map-panning');
    } else {
        canvas.style.cursor = 'default';
    }
}

const drawStyle = document.createElement('style');
drawStyle.textContent = `
    canvas.draw-mode {
        cursor: crosshair !important;
    }
    canvas.erase-mode {
        cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="white" stroke="red" stroke-width="2"/><line x1="6" y1="6" x2="18" y2="18" stroke="red" stroke-width="2"/><line x1="18" y1="6" x2="6" y2="18" stroke="red" stroke-width="2"/></svg>') 12 12, auto !important;
    }
`;
document.head.appendChild(drawStyle);


const style = document.createElement('style');
style.textContent = `
    canvas.multi-dragging {
        cursor: grabbing !important;
    }
`;
document.head.appendChild(style);

let currentContextToken = null;
let currentContextFind = null;
let currentContextZone = null;

// Функция для показа контекстного меню токена
function showTokenContextMenu(token, x, y) {
    hideInitiativeStripContextMenu();
    currentContextToken = token;

    const menu = document.getElementById("tokenContextMenu");
    document.getElementById("contextTokenName").textContent = token.name;

    // Определяем тип токена
    let typeText = "NPC";
    if (token.is_player) typeText = "Игрок";
    else if (token.is_npc) typeText = "НПС";
    else typeText = "Враг";
    document.getElementById("contextTokenType").textContent = typeText;

    // ===== НОВЫЙ КОД: Отображение HP =====
    const hpValue = token.health_points ?? token.max_health_points ?? 10;
    const hpMax = token.max_health_points ?? token.health_points ?? 10;

    document.getElementById("contextHpValue").textContent = hpValue;
    document.getElementById("contextHpMax").textContent = hpMax;

    // Меняем цвет в зависимости от состояния
    const hpDisplay = document.getElementById("contextHpDisplay");

    // Убираем все классы
    hpDisplay.classList.remove('critical', 'warning', 'dead');

    if (token.is_dead || hpValue <= 0) {
        hpDisplay.classList.add('dead');
    } else {
        const percent = hpValue / hpMax;
        if (percent <= 0.25) {
            hpDisplay.classList.add('critical');
        } else if (percent <= 0.5) {
            hpDisplay.classList.add('warning');
        }
    }
    // ===== КОНЕЦ НОВОГО КОДА =====

    // Устанавливаем значения чекбоксов
    document.getElementById("contextTokenVisible").checked = token.is_visible !== false;
    document.getElementById("contextTokenDead").checked = token.is_dead || token.health_points <= 0;

    document.getElementById("contextAcInput").value = token.armor_class || 10;

    // Установка активной кнопки типа
    const typeButtons = document.querySelectorAll('.context-type-btn');
    typeButtons.forEach(btn => btn.classList.remove('active'));

    if (token.is_player) {
        document.querySelector('.context-type-btn[data-type="player"]').classList.add('active');
    } else if (token.is_npc) {
        document.querySelector('.context-type-btn[data-type="npc"]').classList.add('active');
    } else {
        document.querySelector('.context-type-btn[data-type="enemy"]').classList.add('active');
    }

    // Обработчики для кнопок типа
    typeButtons.forEach(btn => {
        btn.onclick = null;
    });

    typeButtons.forEach(btn => {
        btn.onclick = function (e) {
            e.stopPropagation();

            if (!currentContextToken) return;

            const type = this.dataset.type;

            typeButtons.forEach(b => b.classList.remove('active'));
            this.classList.add('active');

            currentContextToken.is_player = (type === 'player');
            currentContextToken.is_npc = (type === 'npc');

            let typeText = type === 'player' ? 'Игрок' : (type === 'npc' ? 'НПС' : 'Враг');
            document.getElementById("contextTokenType").textContent = typeText;

            saveMapData();
            updateSidebar();
            render();

            // Добавляем синхронизацию
            syncTokenAcrossMaps(currentContextToken);
        };
    });

    const combatCtxBtn = document.getElementById("contextCombatToggle");
    const combatCtxLbl = document.getElementById("contextCombatToggleLabel");
    if (combatCtxBtn && combatCtxLbl) {
        if (mapData.combat && mapData.combat.active) {
            combatCtxBtn.style.display = "block";
            combatCtxLbl.textContent = combatIsTokenInCombat(token.id) ? "Выйти из боя" : "Войти в бой";
        } else {
            combatCtxBtn.style.display = "none";
        }
    }

    // Позиционирование меню...
    menu.style.display = "block";
    menu.style.visibility = "hidden";

    const menuRect = menu.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    let left = x;
    let top = y;

    if (left + menuRect.width > windowWidth) {
        left = windowWidth - menuRect.width - 10;
    }

    if (top + menuRect.height > windowHeight) {
        top = windowHeight - menuRect.height - 10;
    }

    if (left < 10) left = 10;
    if (top < 10) top = 10;

    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "visible";

    document.getElementById("findContextMenu").style.display = "none";
    document.getElementById("zoneContextMenu").style.display = "none";
}
// Функция для показа контекстного меню находки
function showFindContextMenu(find, x, y) {
    currentContextFind = find;

    const menu = document.getElementById("findContextMenu");
    document.getElementById("contextFindName").textContent = find.name;
    document.getElementById("contextFindInspected").checked = find.status || false;

    // Сначала показываем меню для измерения
    menu.style.display = "block";
    menu.style.visibility = "hidden";

    const menuRect = menu.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    let left = x;
    let top = y;

    if (left + menuRect.width > windowWidth) {
        left = windowWidth - menuRect.width - 10;
    }

    if (top + menuRect.height > windowHeight) {
        top = windowHeight - menuRect.height - 10;
    }

    if (left < 10) left = 10;
    if (top < 10) top = 10;

    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "visible";

    document.getElementById("tokenContextMenu").style.display = "none";
    document.getElementById("zoneContextMenu").style.display = "none";
}

// Функция для показа контекстного меню зоны
function showZoneContextMenu(zone, x, y) {
    currentContextZone = zone;

    const menu = document.getElementById("zoneContextMenu");
    document.getElementById("contextZoneName").textContent = zone.name;
    document.getElementById("contextZoneVisible").checked = zone.is_visible !== false;

    // Сначала показываем меню для измерения
    menu.style.display = "block";
    menu.style.visibility = "hidden";

    const menuRect = menu.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    let left = x;
    let top = y;

    if (left + menuRect.width > windowWidth) {
        left = windowWidth - menuRect.width - 10;
    }

    if (top + menuRect.height > windowHeight) {
        top = windowHeight - menuRect.height - 10;
    }

    if (left < 10) left = 10;
    if (top < 10) top = 10;

    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "visible";

    document.getElementById("tokenContextMenu").style.display = "none";
    document.getElementById("findContextMenu").style.display = "none";
}

// Обработчики для меню токена
document.getElementById("contextTokenVisible").addEventListener("change", function (e) {
    if (currentContextToken) {
        currentContextToken.is_visible = e.target.checked;
        saveMapData();
        render();
        updateSidebar();

        // Добавляем синхронизацию
        if (currentContextToken && currentContextToken.id) {
            // Используем setTimeout, чтобы не блокировать UI
            setTimeout(() => {
                syncTokenAcrossMaps(currentContextToken);
            }, 100);
        }
    }
});

document.getElementById("contextTokenDead").addEventListener("change", function (e) {
    if (currentContextToken) {
        const wasDead = currentContextToken.is_dead || currentContextToken.health_points <= 0;
        currentContextToken.is_dead = e.target.checked;

        if (e.target.checked) {
            currentContextToken.health_points = 0;
        } else if (wasDead) {
            currentContextToken.health_points = 1;
            combatMoveRevivedTokenToEnd(currentContextToken.id);
        }

        // Обновляем отображение HP
        document.getElementById("contextHpValue").textContent = currentContextToken.health_points;

        // Обновляем цвет индикатора
        const hpDisplay = document.getElementById("contextHpDisplay");
        hpDisplay.classList.remove('critical', 'warning', 'dead');

        if (currentContextToken.is_dead || currentContextToken.health_points <= 0) {
            hpDisplay.classList.add('dead');
        } else {
            const percent = currentContextToken.health_points / currentContextToken.max_health_points;
            if (percent <= 0.25) {
                hpDisplay.classList.add('critical');
            } else if (percent <= 0.5) {
                hpDisplay.classList.add('warning');
            }
        }

        saveMapData();
        render();
        updateSidebar();
        updateMasterInitiativeStrip();

        // Добавляем синхронизацию
        syncTokenAcrossMaps(currentContextToken);
    }
});
document.getElementById("contextApplyDamage").addEventListener("click", function () {
    if (currentContextToken) {
        const damage = parseInt(document.getElementById("contextDamageInput").value) || 0;
        if (damage > 0) {
            const currentHp = currentContextToken.health_points || 0;
            currentContextToken.health_points = Math.max(0, currentHp - damage);
            currentContextToken.is_dead = currentContextToken.health_points <= 0;

            document.getElementById("contextTokenDead").checked = currentContextToken.is_dead;

            // Обновляем отображение HP
            document.getElementById("contextHpValue").textContent = currentContextToken.health_points;

            // Обновляем цвет
            const hpDisplay = document.getElementById("contextHpDisplay");
            hpDisplay.classList.remove('critical', 'warning', 'dead');

            if (currentContextToken.is_dead || currentContextToken.health_points <= 0) {
                hpDisplay.classList.add('dead');
            } else {
                const percent = currentContextToken.health_points / currentContextToken.max_health_points;
                if (percent <= 0.25) {
                    hpDisplay.classList.add('critical');
                } else if (percent <= 0.5) {
                    hpDisplay.classList.add('warning');
                }
            }

            saveMapData();
            render();
            updateSidebar();
            updateMasterInitiativeStrip();

            // Добавляем синхронизацию
            syncTokenAcrossMaps(currentContextToken);
        }
    }
});
document.getElementById("contextApplyHeal").addEventListener("click", function () {
    if (currentContextToken) {
        const heal = parseInt(document.getElementById("contextHealInput").value) || 0;
        if (heal > 0) {
            const maxHp = currentContextToken.max_health_points || 10;
            const currentHp = currentContextToken.health_points || 0;
            const wasDead = currentContextToken.is_dead || currentHp <= 0;
            currentContextToken.health_points = Math.min(maxHp, currentHp + heal);
            currentContextToken.is_dead = currentContextToken.health_points <= 0;
            if (wasDead && currentContextToken.health_points > 0) {
                combatMoveRevivedTokenToEnd(currentContextToken.id);
            }

            document.getElementById("contextTokenDead").checked = currentContextToken.is_dead;

            // Обновляем отображение HP
            document.getElementById("contextHpValue").textContent = currentContextToken.health_points;

            // Обновляем цвет
            const hpDisplay = document.getElementById("contextHpDisplay");
            hpDisplay.classList.remove('critical', 'warning', 'dead');

            if (currentContextToken.is_dead || currentContextToken.health_points <= 0) {
                hpDisplay.classList.add('dead');
            } else {
                const percent = currentContextToken.health_points / currentContextToken.max_health_points;
                if (percent <= 0.25) {
                    hpDisplay.classList.add('critical');
                } else if (percent <= 0.5) {
                    hpDisplay.classList.add('warning');
                }
            }

            saveMapData();
            render();
            updateSidebar();
            updateMasterInitiativeStrip();

            // Добавляем синхронизацию
            syncTokenAcrossMaps(currentContextToken);
        }
    }
});

document.getElementById("contextApplyAc").addEventListener("click", function () {
    if (currentContextToken) {
        const newAc = parseInt(document.getElementById("contextAcInput").value);
        if (newAc > 0) {
            currentContextToken.armor_class = newAc;
            saveMapData();
            render();
            updateSidebar();

            // Добавляем синхронизацию
            syncTokenAcrossMaps(currentContextToken);
        }
    }
});

document.getElementById("contextEditToken").addEventListener("click", function () {
    if (currentContextToken) {
        openEditTokenModal(currentContextToken);
        document.getElementById("tokenContextMenu").style.display = "none";
    }
});

document.getElementById("contextDuplicateToken").addEventListener("click", function () {
    if (currentContextToken) {
        duplicateToken(currentContextToken);
        document.getElementById("tokenContextMenu").style.display = "none";
    }
});

document.getElementById("contextDeleteToken").addEventListener("click", function () {
    if (currentContextToken && confirm(`Удалить токен "${currentContextToken.name}"?`)) {
        fetch(`/api/token/${currentContextToken.id}?map_id=${currentMapId}`, {
            method: 'DELETE'
        })
            .then(response => response.json())
            .then(data => {
                if (data.status === 'token deleted') {
                    console.log('Token deleted successfully');
                }
            })
            .catch(err => console.error('Error deleting token:', err));

        // Удаляем токен из локальных данных
        mapData.tokens = mapData.tokens.filter(t => t.id !== currentContextToken.id);
        combatLeaveToken(currentContextToken.id);
        selectedTokenId = null;

        saveMapData();
        render();
        updateSidebar();
        document.getElementById("tokenContextMenu").style.display = "none";
    }
});

document.getElementById("contextCombatToggle").addEventListener("click", function (e) {
    e.stopPropagation();
    if (!currentContextToken || !mapData.combat || !mapData.combat.active) return;
    const id = currentContextToken.id;
    if (combatIsTokenInCombat(id)) {
        combatLeaveToken(id);
    } else {
        combatJoinToken(id);
    }
    saveMapData();
    updateMasterInitiativeStrip();
    render();
    document.getElementById("tokenContextMenu").style.display = "none";
});

// Обработчики для меню находки
document.getElementById("contextFindInspected").addEventListener("change", function (e) {
    if (currentContextFind) {
        currentContextFind.status = e.target.checked;
        saveMapData();
        render();
        updateSidebar();
    }
});

document.getElementById("contextEditFind").addEventListener("click", function () {
    if (currentContextFind) {
        openFindModal(currentContextFind);
        document.getElementById("findContextMenu").style.display = "none";
    }
});

document.getElementById("contextDeleteFind").addEventListener("click", function () {
    if (currentContextFind && confirm(`Удалить находку "${currentContextFind.name}"?`)) {
        mapData.finds = mapData.finds.filter(f => f.id !== currentContextFind.id);
        selectedFindId = null;
        saveMapData();
        render();
        updateSidebar();
        document.getElementById("findContextMenu").style.display = "none";
    }
});

// Обработчики для меню зоны
document.getElementById("contextZoneVisible").addEventListener("change", function (e) {
    if (currentContextZone) {
        currentContextZone.is_visible = e.target.checked;
        saveMapData();
        render();
        updateSidebar();
    }
});

document.getElementById("contextEditZone").addEventListener("click", function () {
    if (currentContextZone) {
        openEditZoneModal(currentContextZone);
        document.getElementById("zoneContextMenu").style.display = "none";
    }
});

document.getElementById("contextDeleteZone").addEventListener("click", function () {
    if (currentContextZone && confirm(`Удалить зону "${currentContextZone.name}"?`)) {
        mapData.zones = mapData.zones.filter(z => z.id !== currentContextZone.id);
        selectedZoneId = null;
        saveMapData();
        render();
        updateSidebar();
        document.getElementById("zoneContextMenu").style.display = "none";
    }
});

function reloadAvatarInModal(tokenId) {
    console.log("Reloading avatar in modal for token:", tokenId);

    const token = mapData.tokens.find(t => t.id === tokenId);
    if (token) {
        // Очищаем кэш
        if (avatarCache.has(tokenId)) {
            avatarCache.delete(tokenId);
        }

        // Перезагружаем аватар
        loadTokenAvatarInModal(token);
    }
}
// Функция для открытия модального окна редактирования токена
function openEditTokenModal(token) {
    console.log("Opening edit modal for token:", token.id, token.name);

    clearTokenPendingPortrait();

    document.getElementById("tokenModal").style.display = "flex";
    document.getElementById("tokenName").value = token.name;
    document.getElementById("tokenAC").value = token.armor_class || 10;
    document.getElementById("tokenHP").value = token.max_health_points || token.health_points || 10;

    // Устанавливаем тип токена
    document.querySelectorAll(".type-btn").forEach(b => b.classList.remove("active"));
    if (token.is_player) {
        document.querySelector('.type-btn[data-type="player"]').classList.add("active");
    } else if (token.is_npc) {
        document.querySelector('.type-btn[data-type="npc"]').classList.add("active");
    } else {
        document.querySelector('.type-btn[data-type="enemy"]').classList.add("active");
    }

    // НОВОЕ: устанавливаем размер
    const sizeSelect = document.getElementById("tokenSize");
    if (sizeSelect && token.size) {
        sizeSelect.value = token.size;
    }

    // Сохраняем ID редактируемого токена
    editingTokenId = token.id;

    // Показываем чекбоксы
    const addToCharactersParent = document.getElementById("addToCharactersCheckbox").parentElement;
    const addToBankParent = document.getElementById("addToBankCheckbox").parentElement;

    if (addToCharactersParent) {
        addToCharactersParent.style.display = "flex";
        addToCharactersParent.style.visibility = "visible";
    }
    if (addToBankParent) {
        addToBankParent.style.display = "flex";
        addToBankParent.style.visibility = "visible";
    }

    // Сбрасываем чекбоксы
    document.getElementById("addToCharactersCheckbox").checked = false;
    document.getElementById("addToBankCheckbox").checked = false;

    // Загружаем текущий аватар токена
    loadTokenAvatarInModal(token, true);
}

function clearAvatarCacheForToken(tokenId) {
    if (avatarCache.has(tokenId)) {
        avatarCache.delete(tokenId);
        console.log(`Avatar cache cleared for token ${tokenId}`);
    }

    // Также очищаем кэш браузера для этого URL
    const img = new Image();
    img.src = `/api/token/avatar/${tokenId}`;
}

function loadTokenAvatarInModal(token, forceReload = false) {
    clearTokenPendingPortrait();

    const loadForTokenId = token.id;

    const preview = document.getElementById("avatarPreview");
    const overlay = document.getElementById("avatarOverlay");
    const mask = document.getElementById("avatarMask");
    const editIcon = document.getElementById("editIcon");

    preview.src = "";
    preview.style.display = "none";
    preview.removeAttribute("data-base64");

    if (preview._abortController) {
        preview._abortController.abort();
    }

    if (token.has_avatar) {
        overlay.style.display = "none";
        mask.style.display = "block";
        editIcon.style.display = "block";

        preview.style.display = "block";
        preview.style.opacity = "0.5";

        const abortController = new AbortController();
        preview._abortController = abortController;

        const avatarUrl = token.avatar_url || `/api/token/avatar/${token.id}`;

        console.log("Loading avatar from:", avatarUrl);

        const img = new Image();
        img.crossOrigin = "Anonymous";

        img.onload = () => {
            if (editingTokenId !== loadForTokenId) return;
            console.log("Avatar loaded successfully in modal, size:", img.naturalWidth, "x", img.naturalHeight);
            preview.src = avatarUrl;
            preview.style.opacity = "1";

            // ===== ВАЖНО: сохраняем с оригинальным размером БЕЗ сглаживания =====
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');

                // ОТКЛЮЧАЕМ СГЛАЖИВАНИЕ
                ctx.imageSmoothingEnabled = false;
                ctx.imageSmoothingQuality = 'high'; // но это не влияет при false

                ctx.drawImage(img, 0, 0);

                // Используем PNG без потерь
                if (editingTokenId === loadForTokenId) {
                    preview.dataset.base64 = canvas.toDataURL('image/png', 1.0);
                }
                console.log("Avatar converted to base64 with original size:", img.naturalWidth, "x", img.naturalHeight);
            } catch (e) {
                console.warn("Could not convert avatar to base64:", e);
            }

            if (editingTokenId === loadForTokenId) {
                avatarCache.set(token.id, img);
            }
        };

        img.onerror = (err) => {
            if (editingTokenId !== loadForTokenId) return;
            console.error("Failed to load avatar in modal:", err);

            preview.style.display = "none";
            preview.style.opacity = "1";
            preview.removeAttribute("data-base64");

            overlay.style.display = "block";
            mask.style.display = "none";
            editIcon.style.display = "none";

            fetchAvatarFromServer(token.id, loadForTokenId);
        };

        img.src = avatarUrl;
    } else {
        overlay.style.display = "block";
        mask.style.display = "none";
        editIcon.style.display = "none";

        preview.style.display = "none";
        preview.src = "";
        preview.removeAttribute("data-base64");
    }
}

function fetchAvatarFromServer(tokenId, loadForTokenId) {
    const expectId = loadForTokenId !== undefined ? loadForTokenId : tokenId;
    console.log("Fetching avatar from server for token:", tokenId);

    const preview = document.getElementById("avatarPreview");
    const overlay = document.getElementById("avatarOverlay");
    const mask = document.getElementById("avatarMask");
    const editIcon = document.getElementById("editIcon");

    fetch(`/api/token/avatar/${tokenId}`)
        .then(response => {
            if (!response.ok) {
                throw new Error('Avatar not found');
            }
            return response.blob();
        })
        .then(blob => {
            const reader = new FileReader();
            reader.onload = (e) => {
                if (editingTokenId !== expectId) return;
                preview.src = e.target.result;
                preview.style.display = "block";
                preview.style.opacity = "1";
                preview.dataset.base64 = e.target.result;

                overlay.style.display = "none";
                mask.style.display = "block";
                editIcon.style.display = "block";

                console.log("Avatar loaded via fetch");
            };
            reader.readAsDataURL(blob);
        })
        .catch(err => {
            console.error("Failed to fetch avatar:", err);
            if (editingTokenId !== expectId) return;

            preview.style.display = "none";
            preview.removeAttribute("data-base64");

            overlay.style.display = "block";
            mask.style.display = "none";
            editIcon.style.display = "none";
        });
}

async function preloadAvatarForEdit(token) {
    if (!token.has_avatar) return false;

    try {
        const exists = await checkAvatarExists(token.id);
        if (!exists) {
            console.log(`Avatar for token ${token.id} does not exist on server`);
            return false;
        }
        return true;
    } catch (e) {
        console.error('Error checking avatar existence:', e);
        return false;
    }
}

function checkAvatarExists(tokenId) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = `/api/token/avatar/${tokenId}`;
    });
}

let copiedToken = null;

function copySelectedToken() {
    if (!selectedTokenId) {
        showNotification('Сначала выберите токен', 'warning');
        return;
    }

    const token = mapData.tokens.find(t => t.id === selectedTokenId);
    if (!token) return;

    // Создаем копию без ID
    copiedToken = {
        name: token.name,
        armor_class: token.armor_class,
        health_points: token.health_points,
        max_health_points: token.max_health_points,
        is_player: token.is_player,
        is_npc: token.is_npc,
        has_avatar: token.has_avatar,
        avatar_url: token.avatar_url,
        size: token.size,
        is_dead: token.is_dead,
        is_visible: token.is_visible // ДОБАВЬТЕ ЭТУ СТРОКУ
    };

    // Если у токена есть аватар, пытаемся получить его данные
    if (token.has_avatar) {
        const cachedImg = avatarCache.get(token.id);
        if (cachedImg && cachedImg instanceof HTMLImageElement && cachedImg.complete) {
            // Конвертируем в base64 для копирования
            const canvas = document.createElement('canvas');
            canvas.width = cachedImg.width;
            canvas.height = cachedImg.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(cachedImg, 0, 0);
            copiedToken.avatar_data = canvas.toDataURL('image/png');
        }
    }

    showNotification('Токен скопирован', 'success');
}
function pasteToken() {
    if (!copiedToken) {
        showNotification('Нет скопированного токена', 'warning');
        return;
    }

    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) {
        showNotification('Нет карты для размещения токена', 'error');
        return;
    }

    // Получаем позицию курсора
    let pasteX, pasteY;

    if (lastMouseX && lastMouseY) {
        const { scale, offsetX, offsetY } = getTransform();
        pasteX = (lastMouseX - offsetX) / scale;
        pasteY = (lastMouseY - offsetY) / scale;
    } else {
        pasteX = mapImage.width / 2;
        pasteY = mapImage.height / 2;
    }

    pasteX = Math.max(0, Math.min(pasteX, mapImage.width));
    pasteY = Math.max(0, Math.min(pasteY, mapImage.height));

    const newTokenId = `token_${Date.now()}`;

    const newToken = {
        id: newTokenId,
        name: copiedToken.name,
        position: [pasteX, pasteY],
        size: copiedToken.size || mapData.grid_settings.cell_size,
        is_dead: copiedToken.is_dead,
        is_player: copiedToken.is_player,
        is_npc: copiedToken.is_npc,
        armor_class: copiedToken.armor_class,
        health_points: copiedToken.health_points,
        max_health_points: copiedToken.max_health_points,
        has_avatar: copiedToken.has_avatar,
        avatar_url: copiedToken.avatar_url,
        is_visible: copiedToken.is_visible // ДОБАВЬТЕ ЭТУ СТРОКУ
    };


    const requestBody = {
        ...newToken,
        avatar_data: copiedToken.avatar_data || null,
        map_id: currentMapId
    };

    fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
    })
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok: ' + response.status);
            }
            return response.json();
        })
        .then(data => {
            if (data.avatar_url) {
                newToken.avatar_url = data.avatar_url;
            }

            if (!mapData.tokens) mapData.tokens = [];
            mapData.tokens.push(newToken);

            // Загружаем аватар в кэш
            if (newToken.has_avatar && newToken.avatar_url) {
                const img = new Image();
                img.onload = () => {
                    avatarCache.set(newTokenId, img);
                    render();
                };
                img.src = newToken.avatar_url;
            }

            selectedTokenId = newTokenId;
            render();
            updateSidebar();
            showNotification('Токен создан', 'success');
        })
        .catch(error => {
            console.error('Error pasting token:', error);
            showNotification('Ошибка при создании копии токена', 'error');
        });
}

function duplicateToken(sourceToken) {
    if (!sourceToken) return;

    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) {
        showNotification('Нет карты для размещения токена', 'error');
        return;
    }

    // Смещаем копию немного относительно оригинала
    const offset = mapData.grid_settings.cell_size;
    let newX = sourceToken.position[0] + offset;
    let newY = sourceToken.position[1] + offset;

    newX = Math.max(0, Math.min(newX, mapImage.width));
    newY = Math.max(0, Math.min(newY, mapImage.height));

    const newTokenId = `token_${Date.now()}`;

    // Если у исходного токена есть аватар, получаем его с максимальным качеством
    let avatarDataToSend = null;

    if (sourceToken.has_avatar && sourceToken.avatar_url) {
        const cachedImg = avatarCache.get(sourceToken.id);
        if (cachedImg && cachedImg instanceof HTMLImageElement && cachedImg.complete) {
            // Конвертируем в base64 с оригинальным качеством
            const canvas = document.createElement('canvas');
            canvas.width = cachedImg.naturalWidth;
            canvas.height = cachedImg.naturalHeight;
            const ctx = canvas.getContext('2d');

            // ОТКЛЮЧАЕМ СГЛАЖИВАНИЕ
            ctx.imageSmoothingEnabled = false;

            ctx.drawImage(cachedImg, 0, 0);

            // Используем максимальное качество PNG
            avatarDataToSend = canvas.toDataURL('image/png', 1.0);
        } else {
            // Если нет в кэше, загружаем с сервера
            avatarDataToSend = sourceToken.avatar_data || null;
        }
    }

    const newToken = {
        id: newTokenId,
        name: sourceToken.name,
        position: [newX, newY],
        size: sourceToken.size || mapData.grid_settings.cell_size,
        is_dead: false,
        is_player: sourceToken.is_player,
        is_npc: sourceToken.is_npc,
        armor_class: sourceToken.armor_class,
        health_points: sourceToken.health_points,
        max_health_points: sourceToken.max_health_points,
        has_avatar: sourceToken.has_avatar,
        avatar_url: sourceToken.avatar_url,
        is_visible: sourceToken.is_visible
    };

    const requestBody = {
        ...newToken,
        avatar_data: avatarDataToSend,
        map_id: currentMapId
    };

    fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
    })
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok: ' + response.status);
            }
            return response.json();
        })
        .then(data => {
            if (data.avatar_url) {
                newToken.avatar_url = data.avatar_url;
            }

            mapData.tokens.push(newToken);

            // Копируем аватар в кэш
            if (sourceToken.has_avatar && avatarCache.get(sourceToken.id) instanceof HTMLImageElement) {
                const sourceImg = avatarCache.get(sourceToken.id);
                const newImg = new Image();
                newImg.onload = () => {
                    avatarCache.set(newTokenId, newImg);
                    render();
                };
                newImg.src = data.avatar_url || newToken.avatar_url;
            }

            selectedTokenId = newTokenId;
            render();
            updateSidebar();
            showNotification('Копия токена создана', 'success');
        })
        .catch(error => {
            console.error('Error duplicating token:', error);
            showNotification('Ошибка при создании копии', 'error');
        });
}

// Функция для показа уведомлений
function showNotification(message, type = 'info') {
    // Создаем элемент уведомления, если его нет
    let notification = document.getElementById('notification');
    if (!notification) {
        notification = document.createElement('div');
        notification.id = 'notification';
        notification.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 6px;
            color: white;
            font-size: 14px;
            z-index: 10000;
            transition: opacity 0.3s;
            opacity: 0;
        `;
        document.body.appendChild(notification);
    }

    // Устанавливаем цвет в зависимости от типа
    const colors = {
        success: '#4CAF50',
        error: '#F44336',
        warning: '#FF9800',
        info: '#2196F3'
    };
    notification.style.backgroundColor = colors[type] || colors.info;

    // Показываем сообщение
    notification.textContent = message;
    notification.style.opacity = '1';

    // Скрываем через 3 секунды
    setTimeout(() => {
        notification.style.opacity = '0';
    }, 3000);
}

// Функция для открытия модального окна редактирования зоны
function openEditZoneModal(zone) {
    pendingZoneVertices = [...zone.vertices];

    document.getElementById("zoneName").value = zone.name || "";
    document.getElementById("zoneDescription").value = zone.description || "";
    document.getElementById("zoneVisibleCheckbox").checked = zone.is_visible !== false;

    document.getElementById("zoneModalTitle").textContent = "Редактирование зоны";
    document.getElementById("zoneModal").style.display = "flex";

    selectedZoneId = zone.id;
    clearSelectedVertex();
}

document.addEventListener("click", (e) => {
    const tokenMenu = document.getElementById("tokenContextMenu");
    const findMenu = document.getElementById("findContextMenu");
    const zoneMenu = document.getElementById("zoneContextMenu");
    const characterMenu = document.getElementById("characterContextMenu");

    // Проверяем, был ли клик вне всех меню
    if (!tokenMenu?.contains(e.target) &&
        !findMenu?.contains(e.target) &&
        !zoneMenu?.contains(e.target) &&
        !characterMenu?.contains(e.target)) {

        // Скрываем все меню
        if (tokenMenu) {
            tokenMenu.style.display = "none";
            tokenMenu.style.visibility = "visible"; // Сбрасываем visibility
        }
        if (findMenu) {
            findMenu.style.display = "none";
            findMenu.style.visibility = "visible";
        }
        if (zoneMenu) {
            zoneMenu.style.display = "none";
            zoneMenu.style.visibility = "visible";
        }
        if (characterMenu) {
            characterMenu.style.display = "none";
            characterMenu.style.visibility = "visible";
        }

        // Очищаем поля ввода при закрытии
        document.getElementById("contextDamageInput").value = "";
        document.getElementById("contextHealInput").value = "";
    }
});

socket.on("token_avatar_updated", (data) => {
    console.log("Token avatar updated event received:", data);

    if (data.map_id === currentMapId) {
        // Находим токен в данных
        const token = mapData.tokens.find(t => t.id === data.token_id);
        if (token) {
            // Обновляем URL аватара с новым timestamp
            token.avatar_url = data.avatar_url;

            // Принудительно перезагружаем аватар
            reloadTokenAvatar(data.token_id);

            // Перерисовываем
            render();
        }
    }
});

function setupEnterHandler(inputId, buttonId) {
    const input = document.getElementById(inputId);
    if (input) {
        input.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                e.preventDefault(); // Предотвращаем возможное нежелательное поведение
                document.getElementById(buttonId).click();
            }
        });
    }
}
// Добавьте эту функцию в файл static/js/map.js
function centerMap() {
    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) {
        console.log("No map image to center");
        return;
    }

    // Вычисляем масштаб, чтобы карта поместилась полностью
    const scaleX = canvas.width / mapImage.width;
    const scaleY = canvas.height / mapImage.height;
    const baseScale = Math.min(scaleX, scaleY);

    // Устанавливаем zoomLevel в базовый масштаб (без дополнительного увеличения)
    zoomLevel = 1;

    // Вычисляем смещения для центрирования
    const newScale = baseScale * zoomLevel;
    panX = (canvas.width - mapImage.width * newScale) / 2;
    panY = (canvas.height - mapImage.height * newScale) / 2;

    // Сохраняем позицию в данных карты
    mapData.zoom_level = zoomLevel;
    mapData.pan_x = panX;
    mapData.pan_y = panY;

    // Перерисовываем
    render();

    // Сохраняем на сервере
    saveMapData();

    // Отправляем обновление зума всем игрокам
    socket.emit("zoom_update", {
        map_id: currentMapId,
        zoom_level: zoomLevel,
        pan_x: panX,
        pan_y: panY,
        canvas_width: canvas.width,
        canvas_height: canvas.height
    });

    console.log("Map centered:", { zoomLevel, panX, panY });
}

// Добавьте обработчик для кнопки в window.onload
document.getElementById("centeringToggle").addEventListener("click", centerMap);

// Добавьте эту функцию, если она ещё не определена
function drawRuler(offsetX, offsetY, scale) {
    if (!rulerStart) return;

    const [x1, y1] = rulerStart;
    const sx1 = x1 * scale + offsetX;
    const sy1 = y1 * scale + offsetY;
    const sx2 = lastMouseX;
    const sy2 = lastMouseY;

    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.lineTo(sx2, sy2);
    ctx.strokeStyle = "#c82a2aff";
    ctx.lineWidth = 4;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const dxWorld = (sx2 - sx1) / scale;
    const dyWorld = (sy2 - sy1) / scale;
    const cell = mapData.grid_settings.cell_size || 20;

    const dxCells = Math.abs(dxWorld) / cell;
    const dyCells = Math.abs(dyWorld) / cell;

    const steps = Math.max(dxCells, dyCells);
    const cells = Math.max(1, Math.round(steps));
    const feet = cells * 5;

    const midX = (sx1 + sx2) / 2;
    const midY = (sy1 + sy2) / 2;

    ctx.font = "bold 16px Inter";
    ctx.textAlign = "center";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "white";
    ctx.strokeText(`${feet.toFixed(0)} футов`, midX, midY - 10);
    ctx.fillStyle = "black";
    ctx.fillText(`${feet.toFixed(0)} футов`, midX, midY - 10);

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
    ctx.stroke();
}

playerRulerToggle.addEventListener("click", (e) => {
    // Не блокируем всплытие, чтобы сработал существующий обработчик
    // После того как сработает существующий обработчик, синхронизируем вторую кнопку

    // Используем setTimeout, чтобы дать время сработать существующему обработчику
    setTimeout(() => {
        // Синхронизируем состояние rulerToggle с playerRulerToggle
        const isActive = playerRulerToggle.classList.contains("active");
        rulerToggle.classList.toggle("active", isActive);

        // Если rulerToggle не активен, а playerRulerToggle активен - активируем rulerMode
        if (isActive && !isRulerMode) {
            isRulerMode = true;
            rulerStart = null;
            render();
            updateCanvasCursor();
        } else if (!isActive && isRulerMode) {
            isRulerMode = false;
            rulerStart = null;
            mapData.ruler_start = null;
            mapData.ruler_end = null;
            render();
            updateCanvasCursor();
        }
    }, 10);
});

function initCharacterDragAndDrop() {
    const characterList = document.getElementById("characterList");
    if (!characterList) return;

    // Удаляем старые обработчики, чтобы избежать дублирования
    const oldListener = characterList._dragDropListener;
    if (oldListener) {
        characterList.removeEventListener('dragover', oldListener.dragover);
        characterList.removeEventListener('dragleave', oldListener.dragleave);
        characterList.removeEventListener('drop', oldListener.drop);
    }

    let draggedItem = null;
    let draggedIndex = -1;
    let activeDropZone = null;
    let lastDropTargetIndex = null;

    // Функция для обновления порядка в mapData.characters
    function reorderCharacters(fromIndex, toIndex) {
        if (!mapData.characters || fromIndex === toIndex) return;

        // Перемещаем элемент в массиве
        const [removed] = mapData.characters.splice(fromIndex, 1);
        mapData.characters.splice(toIndex, 0, removed);

        // Сохраняем новый порядок
        saveMapData();

        // Обновляем отображение
        renderCharacterList();

        // Отправляем событие об изменении порядка
        socket.emit("characters_reordered", {
            map_id: currentMapId,
            characters: mapData.characters
        });
    }

    // Функция для рендеринга списка портретов
    function renderCharacterList() {
        if (!mapData.characters) {
            characterList.innerHTML = "";
            return;
        }

        characterList.innerHTML = "";

        // Добавляем все портреты
        mapData.characters.forEach((character, index) => {
            const li = createCharacterListItem(character, index);
            characterList.appendChild(li);
        });

        // После рендеринга добавляем обработчики dragstart для каждого элемента
        setupDragStartHandlers();
    }

    // Функция для настройки обработчиков dragstart на элементах
    function setupDragStartHandlers() {
        const items = characterList.querySelectorAll('li');
        items.forEach((item, index) => {
            // Удаляем старый обработчик, если есть
            if (item._dragStartHandler) {
                item.removeEventListener('dragstart', item._dragStartHandler);
            }

            // Создаём новый обработчик
            const handler = (e) => {
                draggedItem = item;
                draggedIndex = index;
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.dropEffect = 'move';
                e.dataTransfer.setData('text/plain', item.dataset.characterId);
                e.dataTransfer.setDragImage(new Image(), 0, 0);
            };

            item._dragStartHandler = handler;
            item.addEventListener('dragstart', handler);

            // Удаляем старый обработчик dragend, если есть
            if (item._dragEndHandler) {
                item.removeEventListener('dragend', item._dragEndHandler);
            }

            // Создаём новый обработчик dragend
            const endHandler = (e) => {
                item.classList.remove('dragging');
                draggedItem = null;
                draggedIndex = -1;
                removeAllDropZones();
            };

            item._dragEndHandler = endHandler;
            item.addEventListener('dragend', endHandler);
        });
    }

    // Функция для очистки всех зон вставки
    function removeAllDropZones() {
        document.querySelectorAll('.drop-zone').forEach(z => z.remove());
        activeDropZone = null;
        lastDropTargetIndex = null;
    }

    // Функция для создания зоны вставки
    function createDropZone(targetIndex) {
        const dropZone = document.createElement('div');
        dropZone.className = 'drop-zone active';
        dropZone.dataset.targetIndex = targetIndex;
        dropZone.style.height = '8px';
        dropZone.style.background = '#4C5BEF';
        dropZone.style.margin = '4px 0';
        dropZone.style.boxShadow = '0 0 10px #4C5BEF';
        dropZone.style.borderRadius = '4px';
        dropZone.style.width = '100%';
        dropZone.style.transition = 'all 0.2s ease';

        lastDropTargetIndex = targetIndex;
        return dropZone;
    }

    // Функция для определения места вставки по позиции мыши
    function getDropTargetIndex(e) {
        const rect = characterList.getBoundingClientRect();
        const mouseY = e.clientY;

        if (mouseY < rect.top || mouseY > rect.bottom) return null;

        const items = characterList.querySelectorAll('li');

        if (items.length === 0) return 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const itemRect = item.getBoundingClientRect();

            if (mouseY <= itemRect.bottom) {
                if (i === 0 && mouseY < itemRect.top + itemRect.height / 2) {
                    return 0;
                }
                if (mouseY > itemRect.top + itemRect.height / 2) {
                    return i + 1;
                } else {
                    return i;
                }
            }
        }

        return items.length;
    }

    // Функция для обновления зоны вставки
    function updateDropZone(e) {
        if (!draggedItem) return;

        const targetIndex = getDropTargetIndex(e);

        if (targetIndex === null) {
            removeAllDropZones();
            return;
        }

        if (lastDropTargetIndex === targetIndex && activeDropZone) return;

        removeAllDropZones();

        const items = characterList.querySelectorAll('li');

        if (items.length === 0) {
            const dropZone = createDropZone(0);
            characterList.appendChild(dropZone);
            activeDropZone = dropZone;
            return;
        }

        if (targetIndex === 0) {
            const dropZone = createDropZone(0);
            characterList.insertBefore(dropZone, items[0]);
            activeDropZone = dropZone;
        } else if (targetIndex >= items.length) {
            const dropZone = createDropZone(items.length);
            characterList.appendChild(dropZone);
            activeDropZone = dropZone;
        } else {
            const dropZone = createDropZone(targetIndex);
            characterList.insertBefore(dropZone, items[targetIndex]);
            activeDropZone = dropZone;
        }
    }

    // Функция для завершения перетаскивания
    function completeDrag(e) {
        if (draggedItem && lastDropTargetIndex !== null && draggedIndex !== -1) {
            e.preventDefault();

            let newIndex = lastDropTargetIndex;
            if (draggedIndex < newIndex) {
                newIndex -= 1;
            }

            console.log(`Moving from ${draggedIndex} to ${newIndex}`);
            reorderCharacters(draggedIndex, newIndex);
        }

        removeAllDropZones();
        draggedItem = null;
        draggedIndex = -1;
        lastDropTargetIndex = null;
    }

    // Глобальные обработчики для документа
    function globalDragOver(e) {
        if (draggedItem) {
            e.preventDefault();
            updateDropZone(e);
        }
    }

    function globalDragEnd(e) {
        completeDrag(e);
    }

    // Удаляем старые глобальные обработчики
    document.removeEventListener('dragover', document._dragOverHandler);
    document.removeEventListener('dragend', document._dragEndHandler);

    // Сохраняем новые глобальные обработчики
    document._dragOverHandler = globalDragOver;
    document._dragEndHandler = globalDragEnd;

    document.addEventListener('dragover', globalDragOver);
    document.addEventListener('dragend', globalDragEnd);

    // Обработчики для списка
    const dragoverHandler = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (draggedItem) {
            updateDropZone(e);
        }
    };

    const dragleaveHandler = (e) => {
        // Не удаляем зону сразу
    };

    const dropHandler = (e) => {
        e.preventDefault();
        completeDrag(e);
    };

    // Сохраняем обработчики для возможного удаления
    characterList._dragDropListener = {
        dragover: dragoverHandler,
        dragleave: dragleaveHandler,
        drop: dropHandler
    };

    characterList.addEventListener('dragover', dragoverHandler);
    characterList.addEventListener('dragleave', dragleaveHandler);
    characterList.addEventListener('drop', dropHandler);

    // Первоначальный рендеринг
    renderCharacterList();
}
function preventDefaultHandler(e) {
    e.preventDefault();
}


document.addEventListener('dragstart', (e) => {
    if (e.target.closest('#characterList') || e.target.closest('#mapsList')) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.dropEffect = 'move';
    }
});

document.addEventListener('dragover', (e) => {
    // Если мы в области портретов, списка карт или над зонами вставки
    if (
        e.target.closest('#characterList') ||
        e.target.closest('#mapsList') ||
        e.target.classList.contains('drop-zone') ||
        e.target.classList.contains('map-list-drop-zone')
    ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }
});

document.addEventListener('dragenter', (e) => {
    if (
        e.target.closest('#characterList') ||
        e.target.closest('#mapsList') ||
        e.target.classList.contains('drop-zone') ||
        e.target.classList.contains('map-list-drop-zone')
    ) {
        e.preventDefault();
    }
});

document.addEventListener('dragleave', (e) => {
    if (
        e.target.closest('#characterList') ||
        e.target.closest('#mapsList') ||
        e.target.classList.contains('drop-zone') ||
        e.target.classList.contains('map-list-drop-zone')
    ) {
        e.preventDefault();
    }
});

document.addEventListener('drop', (e) => {
    if (
        e.target.closest('#characterList') ||
        e.target.closest('#mapsList') ||
        e.target.classList.contains('drop-zone') ||
        e.target.classList.contains('map-list-drop-zone')
    ) {
        e.preventDefault();
    }
});

socket.on("characters_reordered", (data) => {
    if (data.map_id === currentMapId && data.characters) {
        // Обновляем порядок портретов
        mapData.characters = data.characters;

        // Обновляем отображение
        initCharacterDragAndDrop();

        // Сохраняем изменения
        saveMapData();
    }
});

function openBankModal() {
    const modal = document.getElementById("bankModal");
    modal.style.display = "flex";

    // Сохраняем позицию курсора для спавна
    if (lastMouseX && lastMouseY) {
        const { scale, offsetX, offsetY } = getTransform();
        spawnPosition = [
            (lastMouseX - offsetX) / scale,
            (lastMouseY - offsetY) / scale
        ];
    } else if (mapImage && mapImage.complete && mapImage.naturalWidth > 0) {
        spawnPosition = [mapImage.width / 2, mapImage.height / 2];
    } else {
        spawnPosition = [500, 500];
    }

    loadBankCharacters();
}

function closeBankModal() {
    if (window.bankModalSpawnInProgress) return;
    document.getElementById("bankModal").style.display = "none";
    // Очищаем поле поиска
    const searchInput = document.getElementById("bankSearchInput");
    if (searchInput) searchInput.value = "";
}

function loadBankCharacters() {
    const list = document.getElementById("bankCharacterList");
    list.innerHTML = '<div style="text-align: center; padding: 20px;">Загрузка...</div>';

    // Очищаем поле поиска
    const searchInput = document.getElementById("bankSearchInput");
    if (searchInput) searchInput.value = "";

    fetch("/api/bank/characters")
        .then(res => res.json())
        .then(characters => {
            allBankCharacters = characters; // Сохраняем всех персонажей

            if (characters.length === 0) {
                list.innerHTML = '<div style="text-align: center; padding: 20px; color: #aaa;">Банк пуст</div>';
                return;
            }

            displayBankCharacters(characters);
        })
        .catch(err => {
            console.error("Error loading bank characters:", err);
            list.innerHTML = '<div style="text-align: center; padding: 20px; color: #f44336;">Ошибка загрузки</div>';
        });
}

function displayBankCharacters(characters) {
    const list = document.getElementById("bankCharacterList");
    list.innerHTML = "";

    characters.forEach(char => {
        const item = createBankCharacterItem(char);
        list.appendChild(item);
    });
}

function filterBankCharacters() {
    const searchText = document.getElementById("bankSearchInput").value.toLowerCase().trim();

    if (!allBankCharacters || allBankCharacters.length === 0) return;

    if (searchText === "") {
        displayBankCharacters(allBankCharacters);
        return;
    }

    const filtered = allBankCharacters.filter(char =>
        char.name.toLowerCase().includes(searchText)
    );

    displayBankCharacters(filtered);

    // Если ничего не найдено, показываем сообщение
    if (filtered.length === 0) {
        const list = document.getElementById("bankCharacterList");
        list.innerHTML = '<div style="text-align: center; padding: 20px; color: #aaa;">Ничего не найдено</div>';
    }
}


function createBankCharacterItem(character) {
    const div = document.createElement('div');
    div.className = 'bank-character-item';

    const typeText = character.type === 'player' ? 'Игрок' : (character.type === 'npc' ? 'НПС' : 'Враг');

    // Получаем название размера
    const sizeNames = {
        'tiny': 'Крош.',
        'small': 'Мал.',
        'medium': 'Сред.',
        'large': 'Бол.',
        'huge': 'Огр.',
        'gargantuan': 'Гиг.'
    };
    const sizeText = sizeNames[character.size] || 'Сред.';

    const avatarUrl = character.avatar_url || '/static/default-avatar.png';

    div.innerHTML = `
        <img class="bank-character-avatar" src="${avatarUrl}" 
             onerror="this.src='/static/default-avatar.png'">
        <div class="bank-character-info" onclick="spawnBankCharacter(${JSON.stringify(character).replace(/"/g, '&quot;')})">
            <div class="bank-character-name">${character.name}</div>
            <div class="bank-character-type">${typeText} • ${sizeText}</div>
        </div>
        <div class="bank-character-stats" onclick="spawnBankCharacter(${JSON.stringify(character).replace(/"/g, '&quot;')})">
            КД: ${character.armor_class} | ОЗ: ${character.max_health}
        </div>
        <div class="bank-character-actions">
            <button class="bank-action-btn edit" onclick="event.stopPropagation(); openEditBankCharacterModal(${JSON.stringify(character).replace(/"/g, '&quot;')})" title="Редактировать">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                </svg>
            </button>
            <button class="bank-action-btn delete" onclick="event.stopPropagation(); deleteBankCharacter('${character.id}', '${character.name.replace(/'/g, "\\'")}')" title="Удалить">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    <line x1="10" y1="11" x2="10" y2="17"/>
                    <line x1="14" y1="11" x2="14" y2="17"/>
                </svg>
            </button>
        </div>
    `;

    return div;
}

function spawnBankCharacter(character) {
    if (window.bankModalSpawnInProgress) return;

    const centerX = mapImage && mapImage.width ? mapImage.width / 2 : 500;
    const centerY = mapImage && mapImage.height ? mapImage.height / 2 : 500;
    const pos = spawnPosition || [centerX, centerY];

    window.bankModalSpawnInProgress = true;
    setBankModalSpawnProgress(true, {
        indeterminate: true,
        text: "Добавляем на карту…",
    });

    fetch(`/api/bank/character/${character.id}/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            map_id: currentMapId,
            position: pos
        })
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'ok') {
                window.bankModalSpawnInProgress = false;
                setBankModalSpawnProgress(false);
                closeBankModal();

                // Обновляем данные карты
                if (!mapData.tokens) mapData.tokens = [];
                mapData.tokens.push(data.token);

                render();
                updateSidebar();

                showNotification(`Персонаж "${character.name}" добавлен на карту`, 'success');
            }
        })
        .catch(err => {
            console.error("Error spawning character:", err);
            showNotification("Ошибка при добавлении персонажа", 'error');
        })
        .finally(() => {
            window.bankModalSpawnInProgress = false;
            setBankModalSpawnProgress(false);
        });
}

function refreshPortraits() {
    console.log("REFRESH PORTRAITS CALLED");

    // Защита от null mapData.characters
    if (!mapData || !mapData.characters) {
        console.log("No characters data");
        const characterList = document.getElementById("characterList");
        if (characterList) {
            characterList.innerHTML = '<li style="color: #666; text-align: center; padding: 10px;">Нет портретов</li>';
        }
        return;
    }

    console.log("Refreshing portraits, characters count:", mapData.characters.length);

    // Очищаем и заново создаем список портретов
    const characterList = document.getElementById("characterList");
    if (!characterList) {
        console.error("Character list element not found!");
        return;
    }

    characterList.innerHTML = "";

    if (mapData.characters.length === 0) {
        characterList.innerHTML = '<li style="color: #666; text-align: center; padding: 10px;">Нет портретов</li>';
    } else {
        // Добавляем все портреты с проверкой на валидность
        mapData.characters.forEach((character, index) => {
            if (character && character.id) {
                try {
                    const li = createCharacterListItem(character, index);
                    if (li) {
                        characterList.appendChild(li);
                    }
                } catch (err) {
                    console.error("Error creating character list item:", err, character);
                }
            } else {
                console.warn("Invalid character at index", index, character);
            }
        });
    }

    // Переинициализируем drag & drop
    setTimeout(() => {
        initCharacterDragAndDrop();
    }, 100);

    console.log("Portraits refreshed, final count:", characterList.children.length);
}

function setupDragAndDropListeners() {
    const characterList = document.getElementById("characterList");
    if (!characterList) return;

    // Удаляем старые обработчики и добавляем новые
    // (код из initCharacterDragAndDrop, но без создания элементов)
    // Можно просто вызвать initCharacterDragAndDrop заново, 
    // но с проверкой, что элементы уже есть
    initCharacterDragAndDrop();
}

function openImportTokenModal() {
    const modal = document.getElementById("importTokenModal");
    modal.style.display = "flex";

    // Сохраняем позицию курсора для спавна
    if (lastMouseX && lastMouseY) {
        const { scale, offsetX, offsetY } = getTransform();
        spawnPosition = [
            (lastMouseX - offsetX) / scale,
            (lastMouseY - offsetY) / scale
        ];
    } else if (mapImage && mapImage.complete) {
        spawnPosition = [mapImage.width / 2, mapImage.height / 2];
    } else {
        spawnPosition = [500, 500];
    }

    loadAllTokens();
}

function closeImportTokenModal(force) {
    if (!force && window.importTokenModalBusy) return;
    window.importTokenModalBusy = false;
    setImportTokenModalProgress(false);
    document.getElementById("importTokenModal").style.display = "none";
    document.getElementById("importTokenSearchInput").value = "";
    selectedImportToken = null;
}

function loadAllTokens() {
    const list = document.getElementById("importTokenList");
    list.innerHTML = '<div style="text-align: center; padding: 20px;">Загрузка...</div>';

    fetch("/api/tokens/all")
        .then(res => res.json())
        .then(tokens => {
            allTokensFromMaps = tokens;

            if (tokens.length === 0) {
                list.innerHTML = '<div style="text-align: center; padding: 20px; color: #aaa;">Нет токенов на других картах</div>';
                return;
            }

            displayImportTokens(tokens);
        })
        .catch(err => {
            console.error("Error loading tokens:", err);
            list.innerHTML = '<div style="text-align: center; padding: 20px; color: #f44336;">Ошибка загрузки</div>';
        });
}

function displayImportTokens(tokens) {
    const list = document.getElementById("importTokenList");
    list.innerHTML = "";

    tokens.forEach(token => {
        const item = createImportTokenItem(token);
        list.appendChild(item);
    });
}

function filterImportTokens() {
    const searchText = document.getElementById("importTokenSearchInput").value.toLowerCase().trim();

    if (!allTokensFromMaps || allTokensFromMaps.length === 0) return;

    if (searchText === "") {
        displayImportTokens(allTokensFromMaps);
        return;
    }

    const filtered = allTokensFromMaps.filter(token =>
        token.name.toLowerCase().includes(searchText)
    );

    displayImportTokens(filtered);

    if (filtered.length === 0) {
        const list = document.getElementById("importTokenList");
        list.innerHTML = '<div style="text-align: center; padding: 20px; color: #aaa;">Ничего не найдено</div>';
    }
}

function createImportTokenItem(token) {
    const div = document.createElement('div');
    div.className = 'bank-character-item';
    div.onclick = () => spawnImportedToken(token);

    // Определяем тип
    let typeText = "Враг";
    if (token.is_player) typeText = "Игрок";
    else if (token.is_npc) typeText = "НПС";

    // Статус HP с учётом смерти
    let hpStatus;
    let hpColor;

    if (token.is_dead) {
        hpStatus = "МЁРТВ";
        hpColor = "#f44336"; // Красный
    } else {
        const currentHp = token.health_points || 0;
        const maxHp = token.max_health_points || 10;
        hpStatus = `${currentHp}/${maxHp}`;

        // Цвет в зависимости от процента HP
        const percent = currentHp / maxHp;
        hpColor = percent > 0.8 ? "#4CAF50" :    // Зелёный
            percent > 0.4 ? "#FFC107" :    // Жёлтый
                "#F44336";                      // Красный
    }

    // Добавляем иконку смерти если нужно
    const deadIcon = token.is_dead ? '💀 ' : '';

    div.innerHTML = `
        <img class="bank-character-avatar" src="${token.avatar_url || '/static/default-avatar.png'}" 
             onerror="this.src='/static/default-avatar.png'">
        <div class="bank-character-info">
            <div class="bank-character-name">${deadIcon}${token.name}</div>
            <div class="bank-character-type">${typeText}</div>
        </div>
        <div class="bank-character-stats" style="color: ${hpColor}; font-weight: ${token.is_dead ? 'bold' : 'normal'};">
            КД: ${token.armor_class || 10} | ОЗ: ${hpStatus}
        </div>
    `;

    // Добавляем класс для мёртвых токенов
    if (token.is_dead) {
        div.style.opacity = '0.8';
        div.style.backgroundColor = 'rgba(244, 67, 54, 0.1)';
    }

    return div;
}

function spawnImportedToken(sourceToken) {
    if (!spawnPosition) return;

    // Проверяем, существует ли уже токен с таким ID на текущей карте
    const existingToken = mapData.tokens.find(t => t.id === sourceToken.id);

    if (existingToken) {
        // Если токен уже есть на карте, спрашиваем, что делать
        if (confirm(`Токен "${sourceToken.name}" уже есть на этой карте. Создать копию с новым ID?`)) {
            // Создаём копию с новым ID
            createTokenCopyWithNewId(sourceToken);
        } else {
            closeImportTokenModal();
        }
        return;
    }

    // Используем оригинальный ID из исходного токена
    const newToken = {
        id: sourceToken.id,  // ВАЖНО: используем оригинальный ID!
        name: sourceToken.name,
        position: spawnPosition,
        size: sourceToken.size || mapData.grid_settings.cell_size,
        is_dead: sourceToken.is_dead || false,
        is_player: sourceToken.is_player || false,
        is_npc: sourceToken.is_npc || false,
        armor_class: sourceToken.armor_class || 10,
        health_points: sourceToken.health_points || sourceToken.max_health_points || 10,
        max_health_points: sourceToken.max_health_points || sourceToken.health_points || 10,
        has_avatar: sourceToken.has_avatar || false,
        is_visible: sourceToken.is_visible !== undefined ? sourceToken.is_visible : true
    };

    // Логируем для отладки
    console.log("Importing token with original ID:", sourceToken.id, newToken);

    // Функция для создания токена с новым ID (как запасной вариант)
    function createTokenCopyWithNewId(sourceToken) {
        const newId = `token_${Date.now()}`;
        const copyToken = {
            ...newToken,
            id: newId
        };

        createTokenWithAvatar(sourceToken, copyToken);
    }

    // Функция для создания токена (с аватаром или без)
    function createTokenWithAvatar(sourceToken, targetToken) {
        window.importTokenModalBusy = true;
        setImportTokenModalProgress(true, {
            indeterminate: true,
            text: "Импорт токена…",
        });

        const endImportBusy = () => {
            window.importTokenModalBusy = false;
            setImportTokenModalProgress(false);
        };

        const createToken = (avatarData = null) => {
            setImportTokenModalProgress(true, {
                indeterminate: true,
                text: "Создаём токен на карте…",
            });
            const requestBody = {
                ...targetToken,
                avatar_data: avatarData,
                map_id: currentMapId
            };

            return fetch("/api/token", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            })
                .then(response => {
                    if (!response.ok) throw new Error('Network response was not ok');
                    return response.json();
                })
                .then(data => {
                    if (data.avatar_url) {
                        targetToken.avatar_url = data.avatar_url;
                    }

                    mapData.tokens.push(targetToken);
                    render();
                    updateSidebar();
                    closeImportTokenModal(true);

                    syncTokenAcrossMaps(targetToken);

                    // Показываем уведомление с учётом состояния
                    const statusText = targetToken.is_dead ? " (мёртв)" : "";
                    showNotification(`Токен "${sourceToken.name}"${statusText} импортирован`, 'success');
                })
                .catch(error => {
                    console.error('Error importing token:', error);
                    showNotification('Ошибка при импорте токена', 'error');
                })
                .finally(endImportBusy);
        };

        // Если у исходного токена есть аватар, пытаемся его скопировать
        if (sourceToken.has_avatar && sourceToken.id) {
            setImportTokenModalProgress(true, {
                indeterminate: true,
                text: "Копируем аватар…",
            });

            // Пытаемся получить аватар из кэша
            const cachedImg = avatarCache.get(sourceToken.id);
            if (cachedImg && cachedImg instanceof HTMLImageElement && cachedImg.complete) {
                // Конвертируем в base64
                const canvas = document.createElement('canvas');
                canvas.width = cachedImg.width;
                canvas.height = cachedImg.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(cachedImg, 0, 0);
                const avatarData = canvas.toDataURL('image/png');
                createToken(avatarData);
            } else {
                // Загружаем аватар с сервера
                const avatarUrl = sourceToken.avatar_url || `/api/token/avatar/${sourceToken.id}`;

                fetch(avatarUrl.split('?')[0])
                    .then(res => {
                        if (!res.ok) throw new Error('Failed to fetch avatar');
                        return res.blob();
                    })
                    .then(blob => {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            createToken(e.target.result);
                        };
                        reader.readAsDataURL(blob);
                    })
                    .catch(err => {
                        console.warn('Could not copy avatar, creating without avatar:', err);
                        createToken(null);
                    });
            }
        } else {
            // Создаем без аватара
            createToken(null);
        }
    }

    // Запускаем процесс импорта с оригинальным ID
    createTokenWithAvatar(sourceToken, newToken);
}

// ─── Импорт портрета с другой карты (как токены: список со всех карт) ───

function openImportPortraitModal() {
    const modal = document.getElementById("importPortraitModal");
    if (!modal) return;
    modal.style.display = "flex";
    loadAllCharactersForImport();
}

function closeImportPortraitModal() {
    const modal = document.getElementById("importPortraitModal");
    if (modal) modal.style.display = "none";
    const inp = document.getElementById("importPortraitSearchInput");
    if (inp) inp.value = "";
}

function portraitImportUploadFilename(source) {
    const ext = (source.portrait_ext || "").replace(/^\./, "");
    if (ext && /^[a-z0-9]+$/i.test(ext)) return `portrait.${ext}`;
    if (source.portrait_media === "gif") return "portrait.gif";
    if (source.portrait_media === "video") return "portrait.webm";
    return "portrait.png";
}

function loadAllCharactersForImport() {
    const list = document.getElementById("importPortraitList");
    if (!list) return;
    list.innerHTML = '<div style="text-align: center; padding: 20px;">Загрузка...</div>';

    fetch("/api/characters/all")
        .then((res) => res.json())
        .then((chars) => {
            allCharactersFromMaps = Array.isArray(chars) ? chars : [];
            if (allCharactersFromMaps.length === 0) {
                list.innerHTML =
                    '<div style="text-align: center; padding: 20px; color: #aaa;">Нет портретов на других картах (или файлы ещё не загружены)</div>';
                return;
            }
            displayImportPortraits(allCharactersFromMaps);
        })
        .catch((err) => {
            console.error("Error loading characters for import:", err);
            list.innerHTML =
                '<div style="text-align: center; padding: 20px; color: #f44336;">Ошибка загрузки</div>';
        });
}

function displayImportPortraits(chars) {
    const list = document.getElementById("importPortraitList");
    if (!list) return;
    list.innerHTML = "";
    chars.forEach((ch) => {
        list.appendChild(createImportPortraitItem(ch));
    });
}

function filterImportPortraits() {
    const inp = document.getElementById("importPortraitSearchInput");
    const list = document.getElementById("importPortraitList");
    if (!inp || !list) return;
    const q = inp.value.toLowerCase().trim();
    if (!allCharactersFromMaps || allCharactersFromMaps.length === 0) return;
    if (q === "") {
        displayImportPortraits(allCharactersFromMaps);
        return;
    }
    const filtered = allCharactersFromMaps.filter((ch) => {
        const n = (ch.name || "").toLowerCase();
        const m = (ch.source_map || "").toLowerCase();
        return n.includes(q) || m.includes(q);
    });
    if (filtered.length === 0) {
        list.innerHTML =
            '<div style="text-align: center; padding: 20px; color: #aaa;">Ничего не найдено</div>';
        return;
    }
    displayImportPortraits(filtered);
}

function createImportPortraitItem(ch) {
    const div = document.createElement("div");
    div.className = "bank-character-item";
    div.onclick = () => importPortraitFromOtherMap(ch);

    const mapLabel = (ch.source_map || "Карта").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const nameSafe = (ch.name || "Без имени").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const src = ch.portrait_url || `/api/portrait/${ch.id}`;
    const mediaLabel =
        ch.portrait_media === "gif" ? "GIF" : ch.portrait_media === "video" ? "Видео" : "Изображение";

    div.innerHTML = `
        <img class="bank-character-avatar" src="${src}" alt="" onerror="this.src='/static/default-avatar.png'">
        <div class="bank-character-info">
            <div class="bank-character-name">${nameSafe}</div>
            <div class="bank-character-type">${mapLabel}</div>
        </div>
        <div class="bank-character-stats" style="color: #94a3b8;">
            ${mediaLabel}
        </div>
    `;
    return div;
}

async function importPortraitFromOtherMap(source) {
    if (!currentMapId) {
        showNotification("Нет активной карты", "error");
        return;
    }
    if (!mapData.characters) mapData.characters = [];

    const existsHere = mapData.characters.some((c) => c.id === source.id);
    let targetId = source.id;
    let name = source.name || "Без имени";
    let portraitUrl = source.portrait_url || `/api/portrait/${source.id}`;
    let portraitMedia = source.portrait_media || "image";

    if (existsHere) {
        if (
            !confirm(
                `Портрет «${name}» уже есть на этой карте (тот же id). Создать копию с новым id?`
            )
        ) {
            closeImportPortraitModal();
            return;
        }
        targetId = `char_${Date.now()}`;
        try {
            showNotification("Копирование файла портрета…", "info");
            const baseUrl = (source.portrait_url || `/api/portrait/${source.id}`).split("?")[0];
            const res = await fetch(baseUrl);
            if (!res.ok) throw new Error("fetch portrait");
            const blob = await res.blob();
            const base = portraitImportUploadFilename(source);
            const file = new File([blob], base, {
                type: blob.type || "application/octet-stream",
            });
            const fd = new FormData();
            fd.append("portrait", file);
            fd.append("character_id", targetId);
            const up = await fetch("/api/portrait/upload", { method: "POST", body: fd });
            if (!up.ok) throw new Error("upload");
            const data = await up.json();
            if (data.portrait_url) portraitUrl = data.portrait_url;
            if (data.portrait_media) portraitMedia = data.portrait_media;
            name = `${name} (копия)`;
        } catch (e) {
            console.error(e);
            showNotification("Не удалось скопировать портрет", "error");
            return;
        }
    }

    mapData.characters.push({
        id: targetId,
        name,
        has_avatar: true,
        visible_to_players: source.visible_to_players === true,
        portrait_url: portraitUrl,
        portrait_media: portraitMedia,
    });

    try {
        await saveMapData();
        socket.emit("characters_updated", {
            map_id: currentMapId,
            characters: mapData.characters,
        });
        refreshPortraits();
        initCharacterDragAndDrop();
        closeImportPortraitModal();
        closeCharacterModal();
        showNotification(`Портрет «${name}» добавлен`, "success");
    } catch (e) {
        console.error(e);
        mapData.characters = mapData.characters.filter((c) => c.id !== targetId);
        showNotification("Ошибка сохранения карты", "error");
    }
}

const importPortraitSearchInput = document.getElementById("importPortraitSearchInput");
if (importPortraitSearchInput) {
    importPortraitSearchInput.addEventListener("input", filterImportPortraits);
    importPortraitSearchInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") e.preventDefault();
    });
}


// Добавляем обработчик поиска
document.getElementById("importTokenSearchInput").addEventListener("input", filterImportTokens);

document.getElementById("importTokenSearchInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        // Ничего не делаем, просто предотвращаем отправку формы
    }
});

function initSidebarCollapse() {
    const leftSidebar = document.getElementById('sidebar');
    const rightSidebar = document.getElementById('right-sidebar');
    const canvasContainer = document.getElementById('canvas-container');
    const body = document.body;

    if (!leftSidebar || !rightSidebar || !canvasContainer) {
        console.error('Sidebar elements not found');
        return;
    }

    console.log('Initializing sidebar collapse');

    // Загружаем сохраненное состояние
    const leftCollapsed = localStorage.getItem('sidebar_left_collapsed') === 'true';
    const rightCollapsed = localStorage.getItem('sidebar_right_collapsed') === 'true';

    // Применяем начальное состояние
    if (leftCollapsed) {
        leftSidebar.classList.add('collapsed');
        body.classList.add('sidebar-collapsed-left');
        const leftToggle = document.getElementById('toggleLeftSidebar');
        if (leftToggle) {
            leftToggle.innerHTML = '▶';
            leftToggle.title = 'Развернуть левую панель';
        }
    }

    if (rightCollapsed) {
        rightSidebar.classList.add('collapsed');
        body.classList.add('sidebar-collapsed-right');
        const rightToggle = document.getElementById('toggleRightSidebar');
        if (rightToggle) {
            rightToggle.innerHTML = '◀';
            rightToggle.title = 'Развернуть правую панель';
        }
    }

    // Обработчик для левой панели
    const leftToggle = document.getElementById('toggleLeftSidebar');
    if (leftToggle) {
        leftToggle.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();

            const isCollapsed = leftSidebar.classList.toggle('collapsed');

            if (isCollapsed) {
                body.classList.add('sidebar-collapsed-left');
                this.innerHTML = '▶';
                this.title = 'Развернуть левую панель';
            } else {
                body.classList.remove('sidebar-collapsed-left');
                this.innerHTML = '◀';
                this.title = 'Свернуть левую панель';
            }

            localStorage.setItem('sidebar_left_collapsed', isCollapsed);

            resizeCanvas();
            render();
        };
    }

    // Обработчик для правой панели
    const rightToggle = document.getElementById('toggleRightSidebar');
    if (rightToggle) {
        rightToggle.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();

            const isCollapsed = rightSidebar.classList.toggle('collapsed');

            if (isCollapsed) {
                body.classList.add('sidebar-collapsed-right');
                this.innerHTML = '◀';
                this.title = 'Развернуть правую панель';
            } else {
                body.classList.remove('sidebar-collapsed-right');
                this.innerHTML = '▶';
                this.title = 'Свернуть правую панель';
            }

            localStorage.setItem('sidebar_right_collapsed', isCollapsed);

            resizeCanvas();
            render();
        };
    }

    resizeCanvas();
    render();
}
function resizeCanvas() {
    const canvasContainer = document.getElementById('canvas-container');
    const canvas = document.getElementById('mapCanvas');

    if (!canvas || !canvasContainer) return;

    const w = Math.max(1, Math.round(canvasContainer.clientWidth));
    const h = Math.max(1, Math.round(canvasContainer.clientHeight));
    if (canvas.width === w && canvas.height === h) return;

    canvas.width = w;
    canvas.height = h;
    invalidateBg();
}
window.addEventListener('resize', function () {
    resizeCanvas();
    render();
});

function initMasterProjectUI() {
    const backBtn = document.getElementById("masterBackToProjects");
    if (backBtn) {
        backBtn.addEventListener("click", async () => {
            try {
                await fetch("/api/projects/leave", { method: "POST" });
            } catch (e) { /* ignore */ }
            window.location.href = "/projects";
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        setTimeout(initSidebarCollapse, 200);
        initMasterProjectUI();
    });
} else {
    setTimeout(initSidebarCollapse, 200);
    initMasterProjectUI();
}

function loadMapsList() {
    fetch("/api/maps")
        .then(res => res.json())
        .then(maps => {
            mapsList = maps;
            renderMapsList(maps);
        });
}

function teardownMapsListDragDrop() {
    const el = document.getElementById("mapsList");
    if (!el || !el._mapsListDragMeta) return;
    const m = el._mapsListDragMeta;
    if (m.docOver) document.removeEventListener("dragover", m.docOver);
    if (m.docEnd) document.removeEventListener("dragend", m.docEnd);
    if (m.listListener) {
        el.removeEventListener("dragover", m.listListener.dragover);
        el.removeEventListener("dragleave", m.listListener.dragleave);
        el.removeEventListener("drop", m.listListener.drop);
    }
    el._mapsListDragMeta = null;
}

function initMapsListDragDrop() {
    const mapsListEl = document.getElementById("mapsList");
    if (!mapsListEl) return;

    teardownMapsListDragDrop();

    const cards = mapsListEl.querySelectorAll(".map-card");
    if (cards.length === 0) return;

    let draggedCard = null;
    let draggedIndex = -1;
    let activeDropZone = null;
    let lastDropTargetIndex = null;

    function reorderMapsOnServer(fromIndex, toIndex) {
        if (fromIndex === toIndex || !mapsList.length) return;
        const next = mapsList.slice();
        const [removed] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, removed);
        const order = next.map((m) => m.id);
        fetch("/api/maps/reorder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order })
        })
            .then((r) => r.json())
            .then((data) => {
                if (data.maps) {
                    mapsList = data.maps;
                    renderMapsList(data.maps);
                } else {
                    loadMapsList();
                }
            })
            .catch(() => loadMapsList());
    }

    function removeAllDropZones() {
        mapsListEl.querySelectorAll(".map-list-drop-zone").forEach((z) => z.remove());
        activeDropZone = null;
        lastDropTargetIndex = null;
    }

    function createDropZone(targetIndex) {
        const dropZone = document.createElement("div");
        dropZone.className = "map-list-drop-zone active";
        dropZone.dataset.targetIndex = String(targetIndex);
        lastDropTargetIndex = targetIndex;
        return dropZone;
    }

    function getDropTargetIndex(e) {
        const rect = mapsListEl.getBoundingClientRect();
        const mouseX = e.clientX;
        const mouseY = e.clientY;
        if (mouseX < rect.left || mouseX > rect.right || mouseY < rect.top || mouseY > rect.bottom) {
            return null;
        }
        const items = mapsListEl.querySelectorAll(".map-card");
        if (items.length === 0) return 0;
        for (let i = 0; i < items.length; i++) {
            const itemRect = items[i].getBoundingClientRect();
            if (mouseX <= itemRect.right) {
                const mid = itemRect.left + itemRect.width / 2;
                return mouseX < mid ? i : i + 1;
            }
        }
        return items.length;
    }

    function updateDropZone(e) {
        if (!draggedCard) return;
        const targetIndex = getDropTargetIndex(e);
        if (targetIndex === null) {
            removeAllDropZones();
            return;
        }
        if (lastDropTargetIndex === targetIndex && activeDropZone) return;
        removeAllDropZones();
        const items = mapsListEl.querySelectorAll(".map-card");
        if (items.length === 0) {
            activeDropZone = createDropZone(0);
            mapsListEl.appendChild(activeDropZone);
            return;
        }
        if (targetIndex === 0) {
            activeDropZone = createDropZone(0);
            mapsListEl.insertBefore(activeDropZone, items[0]);
        } else if (targetIndex >= items.length) {
            activeDropZone = createDropZone(items.length);
            mapsListEl.appendChild(activeDropZone);
        } else {
            activeDropZone = createDropZone(targetIndex);
            mapsListEl.insertBefore(activeDropZone, items[targetIndex]);
        }
    }

    function completeDrag(e) {
        if (draggedCard && lastDropTargetIndex !== null && draggedIndex >= 0) {
            if (e) e.preventDefault();
            let newIndex = lastDropTargetIndex;
            if (draggedIndex < newIndex) newIndex -= 1;
            reorderMapsOnServer(draggedIndex, newIndex);
        }
        removeAllDropZones();
        draggedCard = null;
        draggedIndex = -1;
    }

    cards.forEach((card, index) => {
        const handle = card.querySelector(".map-drag-handle");
        if (!handle) return;
        if (handle._mapDragStart) {
            handle.removeEventListener("dragstart", handle._mapDragStart);
            handle.removeEventListener("dragend", handle._mapDragEnd);
        }
        const start = (ev) => {
            draggedCard = card;
            draggedIndex = index;
            card.classList.add("map-card--dragging");
            ev.dataTransfer.effectAllowed = "move";
            ev.dataTransfer.setData("text/plain", card.dataset.mapId || "");
            try {
                ev.dataTransfer.setDragImage(new Image(), 0, 0);
            } catch (err) { /* ignore */ }
        };
        const end = () => {
            card.classList.remove("map-card--dragging");
            if (!draggedCard) return;
            draggedCard = null;
            draggedIndex = -1;
            removeAllDropZones();
        };
        handle._mapDragStart = start;
        handle._mapDragEnd = end;
        handle.addEventListener("dragstart", start);
        handle.addEventListener("dragend", end);
    });

    function globalDragOver(e) {
        if (!draggedCard) return;
        e.preventDefault();
        updateDropZone(e);
    }

    function globalDragEnd(e) {
        if (!draggedCard) return;
        completeDrag(e);
    }

    const dragoverHandler = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (draggedCard) updateDropZone(e);
    };
    const dragleaveHandler = () => {};
    const dropHandler = (e) => {
        e.preventDefault();
        completeDrag(e);
    };

    document.addEventListener("dragover", globalDragOver);
    document.addEventListener("dragend", globalDragEnd);
    mapsListEl.addEventListener("dragover", dragoverHandler);
    mapsListEl.addEventListener("dragleave", dragleaveHandler);
    mapsListEl.addEventListener("drop", dropHandler);

    mapsListEl._mapsListDragMeta = {
        docOver: globalDragOver,
        docEnd: globalDragEnd,
        listListener: {
            dragover: dragoverHandler,
            dragleave: dragleaveHandler,
            drop: dropHandler
        }
    };
}

// Функция отрисовки списка карт
function renderMapsList(maps) {
    const container = document.getElementById("mapsList");
    if (!container) return;

    teardownMapsListDragDrop();

    if (maps.length === 0) {
        container.innerHTML = `
            <div class="empty-maps">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="2" y="2" width="20" height="20" rx="2" ry="2"/>
                    <line x1="8" y1="2" x2="8" y2="22"/>
                    <line x1="16" y1="2" x2="16" y2="22"/>
                    <line x1="2" y1="8" x2="22" y2="8"/>
                    <line x1="2" y1="16" x2="22" y2="16"/>
                </svg>
                <p>Нет карт</p>
                <small>Создайте новую карту</small>
            </div>
        `;
        return;
    }

    container.innerHTML = "";

    maps.forEach((map) => {
        const isActive = map.id === currentMapId;
        const name = map.name || "Без названия";

        const card = document.createElement("div");
        card.className = "map-card" + (isActive ? " active" : "");
        card.dataset.mapId = map.id;

        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "map-drag-handle";
        handle.draggable = true;
        handle.title = "Перетащите, чтобы изменить порядок";
        handle.setAttribute("aria-label", "Изменить порядок карты в списке");
        handle.innerHTML =
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
            '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/>' +
            '<circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/>' +
            '<circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/></svg>';
        handle.addEventListener("click", (e) => e.stopPropagation());

        const main = document.createElement("div");
        main.className = "map-card-main";
        main.addEventListener("click", () => selectMap(map.id));

        const thumb = document.createElement("div");
        thumb.className = "map-thumbnail";
        if (map.has_image) {
            const img = document.createElement("img");
            img.src = `/api/map/thumbnail/${map.id}`;
            img.alt = name;
            img.loading = "lazy";
            thumb.appendChild(img);
        } else {
            thumb.innerHTML =
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">' +
                '<rect x="2" y="2" width="20" height="20" rx="2" ry="2"/>' +
                '<circle cx="8.5" cy="8.5" r="1.5"/>' +
                '<polyline points="21 15 16 10 5 21"/></svg>';
        }

        const nameEl = document.createElement("div");
        nameEl.className = "map-name";
        nameEl.title = name;
        nameEl.textContent = name;

        main.appendChild(thumb);
        main.appendChild(nameEl);

        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "map-more-btn";
        moreBtn.setAttribute("aria-label", "Меню карты");
        moreBtn.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<circle cx="12" cy="12" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
        moreBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            showMapContextMenu(map.id, e);
        });

        card.appendChild(handle);
        card.appendChild(main);
        card.appendChild(moreBtn);
        container.appendChild(card);
    });

    updateActiveMapInList(currentMapId);
    initMapsListDragDrop();
}
function selectMap(mapId) {
    if (mapId === currentMapId) return;
    switchMap(mapId);
}

function openCreateMapModal() {
    editingMapId = null;
    currentMapImageFile = null;
    document.getElementById("mapModalTitle").textContent = "Создание новой карты";
    document.getElementById("mapName").value = "";
    document.getElementById("mapImagePreview").style.display = "none";
    document.getElementById("mapImagePlaceholder").style.display = "flex";
    document.getElementById("mapImageOverlay").style.display = "none";
    document.getElementById("mapImagePreview").src = "";
    document.getElementById("mapModal").style.display = "flex";
}

// Открытие модального окна редактирования карты
function openEditMapModal(mapId) {
    const map = mapsList.find(m => m.id === mapId);
    if (!map) return;

    editingMapId = mapId;
    currentMapImageFile = null;
    document.getElementById("mapModalTitle").textContent = "Редактирование карты";
    document.getElementById("mapName").value = map.name;

    const preview = document.getElementById("mapImagePreview");
    const placeholder = document.getElementById("mapImagePlaceholder");
    const overlay = document.getElementById("mapImageOverlay");

    if (map.has_image) {
        // ИСПРАВЛЕНО: используем полноразмерное изображение вместо миниатюры
        preview.src = map.image_url || `/api/map/image/${mapId}`;
        preview.style.display = "block";

        // Добавляем обработчик для правильного масштабирования изображения в модальном окне
        preview.onload = function () {
            // Автоматически подгоняем изображение под размер контейнера
            const container = document.getElementById("mapImageDropzone");
            const containerWidth = container.clientWidth;
            const containerHeight = container.clientHeight;

            // Сохраняем пропорции
            if (this.naturalWidth > this.naturalHeight) {
                this.style.width = "100%";
                this.style.height = "auto";
            } else {
                this.style.width = "auto";
                this.style.height = "100%";
            }
        };

        placeholder.style.display = "none";
        overlay.style.display = "flex";
    } else {
        preview.src = "";
        preview.style.display = "none";
        placeholder.style.display = "flex";
        overlay.style.display = "none";
    }

    document.getElementById("mapModal").style.display = "flex";
}

// Закрытие модального окна
function closeMapModal() {
    if (window.mapModalSaveInProgress) return;
    document.getElementById("mapModal").style.display = "none";
}

function setMapModalSaveProgress(visible, options = {}) {
    const overlay = document.getElementById("mapModalProgressOverlay");
    const textEl = document.getElementById("mapModalProgressText");
    const bar = document.getElementById("mapModalProgressBar");
    const saveBtn = document.getElementById("mapModalSaveBtn");
    const cancelBtn = document.getElementById("mapModalCancelBtn");
    const closeBtn = document.querySelector("#mapModal .close");
    if (!overlay || !textEl || !bar) return;

    if (visible) {
        overlay.style.display = "flex";
        overlay.setAttribute("aria-hidden", "false");
        textEl.textContent = options.text || "Сохранение…";
        bar.classList.toggle("indeterminate", !!options.indeterminate);
        if (options.indeterminate) {
            bar.style.width = "";
        } else {
            const p = Math.min(100, Math.max(0, options.percent ?? 0));
            bar.style.width = `${p}%`;
        }
        if (saveBtn) saveBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        if (closeBtn) {
            closeBtn.style.pointerEvents = "none";
            closeBtn.style.opacity = "0.35";
        }
    } else {
        overlay.style.display = "none";
        overlay.setAttribute("aria-hidden", "true");
        bar.classList.remove("indeterminate");
        bar.style.width = "0%";
        if (saveBtn) saveBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        if (closeBtn) {
            closeBtn.style.pointerEvents = "";
            closeBtn.style.opacity = "";
        }
    }
}

function endTokenModalSave() {
    window.tokenModalSaveInProgress = false;
    setTokenModalSaveProgress(false);
}

function setTokenModalSaveProgress(visible, options = {}) {
    const overlay = document.getElementById("tokenModalProgressOverlay");
    const textEl = document.getElementById("tokenModalProgressText");
    const bar = document.getElementById("tokenModalProgressBar");
    const saveBtn = document.getElementById("tokenModalSaveBtn");
    const cancelBtn = document.getElementById("tokenModalCancelBtn");
    const closeBtn = document.querySelector("#tokenModal .close");
    if (!overlay || !textEl || !bar) return;

    if (visible) {
        overlay.style.display = "flex";
        overlay.setAttribute("aria-hidden", "false");
        textEl.textContent = options.text || "Сохранение…";
        bar.classList.toggle("indeterminate", !!options.indeterminate);
        if (options.indeterminate) {
            bar.style.width = "";
        } else {
            const p = Math.min(100, Math.max(0, options.percent ?? 0));
            bar.style.width = `${p}%`;
        }
        if (saveBtn) saveBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        if (closeBtn) {
            closeBtn.style.pointerEvents = "none";
            closeBtn.style.opacity = "0.35";
        }
    } else {
        overlay.style.display = "none";
        overlay.setAttribute("aria-hidden", "true");
        bar.classList.remove("indeterminate");
        bar.style.width = "0%";
        if (saveBtn) saveBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        if (closeBtn) {
            closeBtn.style.pointerEvents = "";
            closeBtn.style.opacity = "";
        }
    }
}

function setBankModalSpawnProgress(visible, options = {}) {
    const overlay = document.getElementById("bankModalProgressOverlay");
    const textEl = document.getElementById("bankModalProgressText");
    const bar = document.getElementById("bankModalProgressBar");
    const closeBtn = document.querySelector("#bankModal .close");
    const closeFooterBtn = document.getElementById("bankModalCloseBtn");
    if (!overlay || !textEl || !bar) return;

    if (visible) {
        overlay.style.display = "flex";
        overlay.setAttribute("aria-hidden", "false");
        textEl.textContent = options.text || "Добавляем на карту…";
        bar.classList.toggle("indeterminate", !!options.indeterminate);
        if (options.indeterminate) {
            bar.style.width = "";
        } else {
            const p = Math.min(100, Math.max(0, options.percent ?? 0));
            bar.style.width = `${p}%`;
        }
        if (closeBtn) {
            closeBtn.style.pointerEvents = "none";
            closeBtn.style.opacity = "0.35";
        }
        if (closeFooterBtn) closeFooterBtn.disabled = true;
    } else {
        overlay.style.display = "none";
        overlay.setAttribute("aria-hidden", "true");
        bar.classList.remove("indeterminate");
        bar.style.width = "0%";
        if (closeBtn) {
            closeBtn.style.pointerEvents = "";
            closeBtn.style.opacity = "";
        }
        if (closeFooterBtn) closeFooterBtn.disabled = false;
    }
}

function setImportTokenModalProgress(visible, options = {}) {
    const overlay = document.getElementById("importTokenModalProgressOverlay");
    const textEl = document.getElementById("importTokenModalProgressText");
    const bar = document.getElementById("importTokenModalProgressBar");
    const closeBtn = document.querySelector("#importTokenModal .close");
    const cancelBtn = document.getElementById("importTokenModalCancelBtn");
    if (!overlay || !textEl || !bar) return;

    if (visible) {
        overlay.style.display = "flex";
        overlay.setAttribute("aria-hidden", "false");
        textEl.textContent = options.text || "Импорт токена…";
        bar.classList.toggle("indeterminate", !!options.indeterminate);
        if (options.indeterminate) {
            bar.style.width = "";
        } else {
            const p = Math.min(100, Math.max(0, options.percent ?? 0));
            bar.style.width = `${p}%`;
        }
        if (closeBtn) {
            closeBtn.style.pointerEvents = "none";
            closeBtn.style.opacity = "0.35";
        }
        if (cancelBtn) cancelBtn.disabled = true;
    } else {
        overlay.style.display = "none";
        overlay.setAttribute("aria-hidden", "true");
        bar.classList.remove("indeterminate");
        bar.style.width = "0%";
        if (closeBtn) {
            closeBtn.style.pointerEvents = "";
            closeBtn.style.opacity = "";
        }
        if (cancelBtn) cancelBtn.disabled = false;
    }
}

function setBankCharacterModalSaveProgress(visible, options = {}) {
    const overlay = document.getElementById("bankCharacterModalProgressOverlay");
    const textEl = document.getElementById("bankCharacterModalProgressText");
    const bar = document.getElementById("bankCharacterModalProgressBar");
    const saveBtn = document.getElementById("bankCharacterModalSaveBtn");
    const cancelBtn = document.getElementById("bankCharacterModalCancelBtn");
    const closeBtn = document.querySelector("#bankCharacterModal .close");
    if (!overlay || !textEl || !bar) return;

    if (visible) {
        overlay.style.display = "flex";
        overlay.setAttribute("aria-hidden", "false");
        textEl.textContent = options.text || "Сохранение…";
        bar.classList.toggle("indeterminate", !!options.indeterminate);
        if (options.indeterminate) {
            bar.style.width = "";
        } else {
            const p = Math.min(100, Math.max(0, options.percent ?? 0));
            bar.style.width = `${p}%`;
        }
        if (saveBtn) saveBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        if (closeBtn) {
            closeBtn.style.pointerEvents = "none";
            closeBtn.style.opacity = "0.35";
        }
    } else {
        overlay.style.display = "none";
        overlay.setAttribute("aria-hidden", "true");
        bar.classList.remove("indeterminate");
        bar.style.width = "0%";
        if (saveBtn) saveBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        if (closeBtn) {
            closeBtn.style.pointerEvents = "";
            closeBtn.style.opacity = "";
        }
    }
}

/**
 * POST multipart с отслеживанием прогресса загрузки (fetch не умеет upload progress).
 */
function xhrPostFormData(url, formData, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.onload = () => {
            const ok = xhr.status >= 200 && xhr.status < 300;
            let body = {};
            const raw = xhr.responseText || "";
            try {
                body = raw ? JSON.parse(raw) : {};
            } catch {
                body = {};
            }
            if (ok) {
                resolve(body);
            } else {
                const msg =
                    body.error ||
                    (raw && raw.length < 240 ? raw.trim() : "") ||
                    `Ошибка ${xhr.status}`;
                reject(new Error(msg));
            }
        };
        xhr.onerror = () => reject(new Error("Нет соединения с сервером"));
        if (onProgress && xhr.upload) {
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    onProgress(Math.round((e.loaded / e.total) * 100));
                }
            };
        }
        xhr.send(formData);
    });
}

// Обработка загрузки изображения
function handleMapImageUpload(input) {
    const file = input.files[0];
    if (!file) return;

    // Проверяем размер
    if (file.size > 50 * 1024 * 1024) {
        alert("Файл слишком большой. Максимальный размер 50MB.");
        return;
    }

    currentMapImageFile = file;

    // Показываем превью
    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById("mapImagePreview");
        preview.src = e.target.result;
        preview.style.display = "block";
        document.getElementById("mapImagePlaceholder").style.display = "none";
        document.getElementById("mapImageOverlay").style.display = "flex";
    };
    reader.readAsDataURL(file);
}

function submitMap() {
    const name = document.getElementById("mapName").value.trim();
    if (!name) {
        alert("Введите название карты");
        return;
    }
    if (window.mapModalSaveInProgress) return;

    const endMapModalSave = () => {
        window.mapModalSaveInProgress = false;
        setMapModalSaveProgress(false);
    };

    // Если это создание новой карты (без редактирования)
    if (!editingMapId) {
        window.mapModalSaveInProgress = true;
        setMapModalSaveProgress(true, {
            indeterminate: true,
            text: "Создаём карту…",
        });

        fetch("/api/map/new", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name })
        })
            .then(res => {
                if (!res.ok) {
                    throw new Error("Network response was not ok: " + res.status);
                }
                return res.json();
            })
            .then(data => {
                if (currentMapImageFile) {
                    setMapModalSaveProgress(true, {
                        indeterminate: false,
                        percent: 0,
                        text: "Загружаем изображение… 0%",
                    });
                    const formData = new FormData();
                    formData.append("map_image", currentMapImageFile);
                    if (data.map_id) {
                        formData.append("map_id", data.map_id);
                    }
                    return xhrPostFormData("/upload_map", formData, {
                        onProgress: (p) =>
                            setMapModalSaveProgress(true, {
                                percent: p,
                                text: `Загружаем изображение… ${p}%`,
                            }),
                    }).then(() => data);
                }
                return data;
            })
            .then(data => {
                endMapModalSave();
                closeMapModal();
                loadMapsList();

                if (data.map_id) {
                    switchMap(data.map_id);
                }

                showNotification("Карта создана", "success");
            })
            .catch(err => {
                console.error("Error saving map:", err);
                showNotification(
                    "Ошибка при создании карты: " + err.message,
                    "error"
                );
            })
            .finally(() => {
                endMapModalSave();
            });
    } else {
        window.mapModalSaveInProgress = true;

        const formData = new FormData();
        formData.append("name", name);
        if (currentMapImageFile) {
            formData.append("map_image", currentMapImageFile);
        }

        let savePromise;
        if (currentMapImageFile) {
            setMapModalSaveProgress(true, {
                indeterminate: false,
                percent: 0,
                text: "Загружаем изображение… 0%",
            });
            savePromise = xhrPostFormData(
                `/api/map/update/${editingMapId}`,
                formData,
                {
                    onProgress: (p) =>
                        setMapModalSaveProgress(true, {
                            percent: p,
                            text: `Загружаем изображение… ${p}%`,
                        }),
                }
            );
        } else {
            setMapModalSaveProgress(true, {
                indeterminate: true,
                text: "Сохраняем…",
            });
            savePromise = fetch(`/api/map/update/${editingMapId}`, {
                method: "POST",
                body: formData,
            }).then(res => {
                if (!res.ok) {
                    throw new Error("Network response was not ok: " + res.status);
                }
                return res.json();
            });
        }

        savePromise
            .then(data => {
                endMapModalSave();
                closeMapModal();
                loadMapsList();

                if (data.map_id === currentMapId) {
                    if (mapImage) {
                        mapImage = new Image();
                        mapImage.crossOrigin = "Anonymous";
                    }

                    const imageUrl =
                        data.image_url ||
                        mapData?.image_url ||
                        `/api/map/image/${currentMapId}`;

                    mapImage.onload = () => {
                        console.log("New map image loaded after edit");
                        render();

                        mapData.zoom_level = zoomLevel;
                        mapData.pan_x = panX;
                        mapData.pan_y = panY;
                    };

                    mapImage.src = imageUrl;
                    mapData.has_image = true;
                }

                showNotification("Карта обновлена", "success");
            })
            .catch(err => {
                console.error("Error updating map:", err);
                showNotification(
                    "Ошибка при обновлении карты: " + (err.message || ""),
                    "error"
                );
            })
            .finally(() => {
                endMapModalSave();
            });
    }
}
// Показать контекстное меню карты
function showMapContextMenu(mapId, event) {
    event.preventDefault();
    event.stopPropagation();

    const map = mapsList.find(m => m.id === mapId);
    if (!map) return;

    const menu = document.getElementById("mapContextMenu");
    document.getElementById("contextMapName").textContent = map.name;

    // Настраиваем кнопки
    document.getElementById("contextEditMap").onclick = () => {
        menu.style.display = "none";
        openEditMapModal(mapId);
    };

    document.getElementById("contextDeleteMap").onclick = () => {
        menu.style.display = "none";
        if (confirm(`Удалить карту "${map.name}"?`)) {
            deleteMap(mapId);
        }
    };

    // Позиционирование меню
    menu.style.display = "block";
    menu.style.visibility = "hidden";

    const menuRect = menu.getBoundingClientRect();
    let left = event.pageX;
    let top = event.pageY;

    if (left + menuRect.width > window.innerWidth) {
        left = window.innerWidth - menuRect.width - 10;
    }
    if (top + menuRect.height > window.innerHeight) {
        top = window.innerHeight - menuRect.height - 10;
    }

    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "visible";

    // ===== НОВЫЙ КОД: добавляем временный обработчик для закрытия меню =====
    // Сохраняем ссылку на текущее меню
    window.currentMapMenu = menu;
    window.contextMenuTargetMapId = mapId;

    // Функция для закрытия меню при клике вне его
    const closeMenuOnClickOutside = (e) => {
        // Если кликнули не по меню и не по кнопке, которая его открыла
        if (!menu.contains(e.target) && !e.target.closest('.map-more-btn')) {
            menu.style.display = "none";
            // Удаляем обработчики
            document.removeEventListener('click', closeMenuOnClickOutside);
            document.removeEventListener('contextmenu', closeMenuOnContextMenu);
        }
    };

    // Функция для закрытия при правом клике где-то ещё
    const closeMenuOnContextMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.style.display = "none";
            document.removeEventListener('click', closeMenuOnClickOutside);
            document.removeEventListener('contextmenu', closeMenuOnContextMenu);
        }
    };

    // Добавляем обработчики с небольшой задержкой, чтобы не поймать текущий клик
    setTimeout(() => {
        document.addEventListener('click', closeMenuOnClickOutside);
        document.addEventListener('contextmenu', closeMenuOnContextMenu);
    }, 100);
}

function deleteMap(mapId) {
    fetch(`/api/map/delete/${mapId}`, {
        method: "DELETE"
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'ok') {
                loadMapsList();

                if (mapId === currentMapId) {
                    if (data.maps && data.maps.length > 0) {
                        switchMap(data.maps[0].id);
                    } else {
                        switchMap(null);
                    }
                }

                showNotification("Карта удалена", "success");
            }
        })
        .catch(err => {
            console.error("Error deleting map:", err);
            showNotification("Ошибка при удалении карты", "error");
        });
}

function updateActiveMapInList(mapId) {
    // Убираем active класс у всех карточек
    document.querySelectorAll('.map-card').forEach(card => {
        card.classList.remove('active');
    });

    // Добавляем active класс текущей карте
    if (mapId) {
        const activeCard = document.querySelector(`.map-card[data-map-id="${mapId}"]`);
        if (activeCard) {
            activeCard.classList.add('active');
        }
    }
}

function closeAllModals() {
    // Список всех модальных окон
    const modals = [
        'characterModal',
        'tokenModal',
        'findModal',
        'zoneModal',
        'mapModal',
        'importTokenModal',
        'importPortraitModal',
        'bankModal',
        'newMapModal',
        'bankCharacterModal',  // ДОБАВЛЕНО
        'combatModal'
    ];

    modals.forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal && modal.style.display === 'flex') {
            modal.style.display = 'none';
        }
    });

    closeImportPortraitModal();
    closeImportTokenModal(true);
    window.tokenModalSaveInProgress = false;
    setTokenModalSaveProgress(false);
    window.bankModalSpawnInProgress = false;
    setBankModalSpawnProgress(false);
    window.bankCharacterModalSaveInProgress = false;
    setBankCharacterModalSaveProgress(false);

    // Сбрасываем режимы рисования, если они активны
    if (drawingZone) {
        drawingZone = false;
        currentZoneVertices = [];
        updateCanvasCursor();
        const hint = document.getElementById('drawing-hint');
        if (hint) hint.remove();
        render();
    }

    // Сбрасываем линейку, если она активна
    if (isRulerMode) {
        isRulerMode = false;
        rulerStart = null;
        mapData.ruler_start = null;
        mapData.ruler_end = null;

        // Отключаем видимость линейки для игроков
        mapData.ruler_visible_to_players = false;

        // Обновляем кнопки
        const playerRulerToggle = document.getElementById("playerRulerToggle");
        if (playerRulerToggle) {
            playerRulerToggle.classList.remove("active");
        }

        const rulerBtn = document.getElementById("rulerToggle");
        if (rulerBtn) {
            rulerBtn.classList.remove("active");
        }

        socket.emit("ruler_update", {
            map_id: currentMapId,
            ruler_start: null,
            ruler_end: null
        });

        socket.emit("ruler_visibility_change", {
            map_id: currentMapId,
            ruler_visible_to_players: false
        });

        saveMapData();
        render();
        updateCanvasCursor();
    }

    // Закрываем контекстные меню
    const contextMenus = [
        'tokenContextMenu',
        'findContextMenu',
        'zoneContextMenu',
        'characterContextMenu',
        'mapContextMenu'
    ];

    contextMenus.forEach(menuId => {
        const menu = document.getElementById(menuId);
        if (menu) {
            menu.style.display = 'none';
        }
    });

    // Сбрасываем состояния редактирования
    editingTokenId = null;
    editingFindId = null;
    editingZoneId = null;
    window.editingCharacterId = null;
    pendingZoneVertices = null;

    // Если было открыто окно создания персонажа в банке, сбрасываем форму
    resetBankAvatarPreview();

    console.log('All modals closed with Escape');
}

function syncTokenAcrossMaps(token) {
    if (!token || !token.id) return;

    console.log(`Syncing token ${token.id} across maps`);

    // Подготавливаем данные для синхронизации (без позиции)
    const syncData = {
        name: token.name,
        armor_class: token.armor_class,
        health_points: token.health_points,
        max_health_points: token.max_health_points,
        is_player: token.is_player,
        is_npc: token.is_npc,
        is_dead: token.is_dead,
        has_avatar: token.has_avatar,
        is_visible: token.is_visible,
        size: token.size || "medium"
    };

    // Добавляем avatar_url если есть
    if (token.avatar_url) {
        syncData.avatar_url = token.avatar_url.split('?')[0]; // Без timestamp
    }

    console.log("Sending sync data:", syncData);

    // Отправляем на сервер для синхронизации
    fetch(`/api/token/${encodeURIComponent(token.id)}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(syncData)
    })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => {
                    throw new Error(err.error || `HTTP error! status: ${response.status}`);
                });
            }
            return response.json();
        })
        .then(data => {
            if (data.status === 'ok') {
                console.log(`Token synced on ${data.updated_maps} maps`);
            }
        })
        .catch(err => {
            console.error("Error syncing token:", err);
            // Не показываем ошибку пользователю, просто логируем
        });
}

socket.on("token_synced_across_maps", (data) => {
    const { token_id, updated_data } = data;

    console.log(`Token ${token_id} was synced across maps`);

    // Если текущий токен был синхронизирован, обновляем его данные
    const token = mapData.tokens.find(
        (t) => String(t.id) === String(token_id)
    );
    if (token) {
        // Обновляем поля (кроме позиции)
        Object.assign(token, updated_data);

        // Перерисовываем
        render();
        updateSidebar();
    }
});

function openBankCharacterModal() {
    console.log("Opening bank character modal");

    // Закрываем банк и открываем окно создания персонажа
    document.getElementById("bankModal").style.display = "none";
    document.getElementById("bankCharacterModal").style.display = "flex";

    // Сбрасываем форму
    document.getElementById("bankCharacterName").value = "";
    document.getElementById("bankCharacterAC").value = 10;
    document.getElementById("bankCharacterHP").value = 10;

    // Сбрасываем тип на "Игрок"
    document.querySelectorAll("#bankCharacterModal .type-btn").forEach(b => b.classList.remove("active"));
    document.querySelector('#bankCharacterModal .type-btn[data-type="player"]').classList.add("active");

    // Сбрасываем аватар
    resetBankAvatarPreview();
}

function closeBankCharacterModal() {
    if (window.bankCharacterModalSaveInProgress) return;
    document.getElementById("bankCharacterModal").style.display = "none";

    // Сбрасываем заголовок обратно
    const modalTitle = document.querySelector("#bankCharacterModal h3");
    if (modalTitle) {
        modalTitle.textContent = "Создание персонажа в банке";
    }

    // Очищаем ID редактируемого
    window.editingBankCharacterId = null;

    // Возвращаемся к банку и обновляем список
    openBankModal(); // Это переоткроет банк и загрузит список
}
function resetBankAvatarPreview() {
    const preview = document.getElementById("bankAvatarPreview");
    if (preview) {
        preview.src = "";
        preview.style.display = "none";
        preview.removeAttribute("data-base64");
    }

    const overlay = document.getElementById("bankAvatarOverlay");
    const editIcon = document.getElementById("bankEditIcon");

    if (overlay) overlay.style.display = "block";
    if (editIcon) editIcon.style.display = "none";
}

function handleBankAvatarUpload(file) {
    if (!file) return;

    // Проверяем размер файла
    if (file.size > 10 * 1024 * 1024) {
        alert("Файл слишком большой. Максимальный размер 10MB.");
        return;
    }

    // Открываем кроппер для выбора области
    openCropModal(file, 'bank');
}

function submitBankCharacter() {
    console.log("Submitting bank character");

    const name = document.getElementById("bankCharacterName").value.trim();
    const ac = parseInt(document.getElementById("bankCharacterAC").value) || 10;
    const hp = parseInt(document.getElementById("bankCharacterHP").value) || 10;
    const type = document.querySelector("#bankCharacterModal .type-btn.active")?.dataset.type;
    const sizeSelect = document.getElementById("bankCharacterSize");
    const size = sizeSelect ? sizeSelect.value : 'medium'; // НОВОЕ: размер
    const editingId = window.editingBankCharacterId;

    if (!name) {
        alert("Введите имя персонажа");
        return;
    }

    if (!type) {
        alert("Выберите тип персонажа");
        return;
    }

    const avatarPreview = document.getElementById("bankAvatarPreview");
    const avatarData = avatarPreview?.dataset.base64 || null;

    console.log("Character data:", { name, ac, hp, type, size, hasAvatar: !!avatarData, editingId });

    const characterData = {
        name: name,
        type: type,
        armor_class: ac,
        max_health: hp,
        size: size, // НОВОЕ: размер
        has_avatar: !!avatarData
    };

    const requestBody = {
        ...characterData,
        avatar_data: avatarData
    };

    const url = editingId ? `/api/bank/character/${editingId}` : "/api/bank/character";
    const method = editingId ? "PUT" : "POST";

    if (window.bankCharacterModalSaveInProgress) return;
    window.bankCharacterModalSaveInProgress = true;
    setBankCharacterModalSaveProgress(true, {
        indeterminate: true,
        text: editingId ? "Сохраняем в банке…" : "Добавляем в банк…",
    });

    fetch(url, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    })
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok: ' + response.status);
            }
            return response.json();
        })
        .then(data => {
            console.log("Bank character saved:", data);
            window.editingBankCharacterId = null;
            window.bankCharacterModalSaveInProgress = false;
            setBankCharacterModalSaveProgress(false);
            closeBankCharacterModal();
            showNotification(`Персонаж "${name}" ${editingId ? "обновлен" : "добавлен"} в банк`, 'success');
        })
        .catch(error => {
            console.error("Error saving bank character:", error);
            showNotification("Ошибка при сохранении персонажа", 'error');
        })
        .finally(() => {
            window.bankCharacterModalSaveInProgress = false;
            setBankCharacterModalSaveProgress(false);
        });
}

function openEditBankCharacterModal(character) {
    console.log("Opening edit bank character modal for:", character);

    document.getElementById("bankModal").style.display = "none";
    document.getElementById("bankCharacterModal").style.display = "flex";

    const modalTitle = document.querySelector("#bankCharacterModal h3");
    if (modalTitle) {
        modalTitle.textContent = "Редактирование персонажа в банке";
    }

    document.getElementById("bankCharacterName").value = character.name || "";
    document.getElementById("bankCharacterAC").value = character.armor_class || 10;
    document.getElementById("bankCharacterHP").value = character.max_health || 10;

    // Устанавливаем тип
    document.querySelectorAll("#bankCharacterModal .type-btn").forEach(b => b.classList.remove("active"));
    if (character.type === 'player') {
        document.querySelector('#bankCharacterModal .type-btn[data-type="player"]').classList.add("active");
    } else if (character.type === 'npc') {
        document.querySelector('#bankCharacterModal .type-btn[data-type="npc"]').classList.add("active");
    } else {
        document.querySelector('#bankCharacterModal .type-btn[data-type="enemy"]').classList.add("active");
    }

    // НОВОЕ: устанавливаем размер
    const sizeSelect = document.getElementById("bankCharacterSize");
    if (sizeSelect && character.size) {
        sizeSelect.value = character.size;
    }

    // Загружаем аватар
    const preview = document.getElementById("bankAvatarPreview");
    const overlay = document.getElementById("bankAvatarOverlay");
    const editIcon = document.getElementById("bankEditIcon");

    if (character.has_avatar && character.avatar_url) {
        preview.src = character.avatar_url;
        preview.style.display = "block";
        overlay.style.display = "none";
        editIcon.style.display = "block";
    } else {
        preview.src = "";
        preview.style.display = "none";
        preview.removeAttribute("data-base64");
        overlay.style.display = "block";
        editIcon.style.display = "none";
    }

    window.editingBankCharacterId = character.id;
}

function deleteBankCharacter(characterId, characterName) {
    if (!confirm(`Удалить персонажа "${characterName}" из банка?`)) {
        return;
    }

    fetch(`/api/bank/character/${characterId}`, {
        method: 'DELETE'
    })
        .then(response => {
            if (!response.ok) {
                return response.json().then(data => {
                    throw new Error(data.error || 'Ошибка при удалении');
                });
            }
            return response.json();
        })
        .then(data => {
            console.log("Bank character deleted:", data);
            showNotification(`Персонаж "${characterName}" удален из банка`, 'success');

            // Обновляем список в банке
            loadBankCharacters();
        })
        .catch(err => {
            console.error("Error deleting bank character:", err);
            showNotification(err.message || "Ошибка при удалении персонажа", 'error');
        });
}

let cropper = null;
let currentCropTarget = null; // 'token', 'character', 'bank'
let cropFile = null;

function openCropModal(file, target) {
    const modal = document.getElementById("cropModal");
    const cropImage = document.getElementById("cropImage");

    // Сохраняем цель и файл
    currentCropTarget = target;
    cropFile = file;

    // Загружаем изображение
    const reader = new FileReader();
    reader.onload = function (e) {
        cropImage.src = e.target.result;

        // Показываем модальное окно
        modal.style.display = "flex";

        // Инициализируем кроппер после загрузки изображения
        setTimeout(() => {
            if (cropper) {
                cropper.destroy();
            }

            cropper = new Cropper(cropImage, {
                aspectRatio: 1, // Квадратное соотношение
                viewMode: 1,
                dragMode: 'move',
                autoCropArea: 1,
                restore: false,
                guides: true,
                center: true,
                highlight: false,
                cropBoxMovable: true,
                cropBoxResizable: true,
                toggleDragModeOnDblclick: false,
                minContainerWidth: 650,
                minContainerHeight: 400,
                ready: function () {
                    // Центрируем crop box
                    const cropBox = cropper.getCropBoxData();
                    const container = cropper.getContainerData();
                    const image = cropper.getImageData();

                    // Устанавливаем размер как минимум из ширины/высоты
                    const size = Math.min(image.width, image.height);

                    cropper.setCropBoxData({
                        left: (container.width - size) / 2,
                        top: (container.height - size) / 2,
                        width: size,
                        height: size
                    });
                }
            });
        }, 100);
    };
    reader.readAsDataURL(file);
}

// Функция для закрытия кроппера
function closeCropModal() {
    document.getElementById("cropModal").style.display = "none";
    if (cropper) {
        cropper.destroy();
        cropper = null;
    }
    cropFile = null;
    currentCropTarget = null;
}

// Функция для применения обрезки
function applyCrop() {
    if (!cropper || !currentCropTarget || !cropFile) return;

    // ПОЛУЧАЕМ ОРИГИНАЛЬНЫЙ РАЗМЕР ИЗОБРАЖЕНИЯ
    const imageData = cropper.getImageData();

    // СОЗДАЕМ CANVAS С ОРИГИНАЛЬНЫМ РАЗМЕРОМ
    const canvas = cropper.getCroppedCanvas({
        width: imageData.naturalWidth,  // Используем оригинальную ширину
        height: imageData.naturalHeight, // Используем оригинальную высоту
        imageSmoothingEnabled: false,    // ОТКЛЮЧАЕМ СГЛАЖИВАНИЕ для сохранения четкости
        imageSmoothingQuality: 'high'
    });

    // Конвертируем в base64 без потерь (PNG)
    const croppedBase64 = canvas.toDataURL('image/png');

    // В зависимости от цели, обновляем соответствующий превью
    switch (currentCropTarget) {
        case 'token':
            clearTokenPendingPortrait();
            const tokenPreview = document.getElementById("avatarPreview");
            tokenPreview.src = croppedBase64;
            tokenPreview.style.display = "block";
            tokenPreview.dataset.base64 = croppedBase64;

            document.getElementById("avatarOverlay").style.display = "none";
            document.getElementById("avatarMask").style.display = "block";
            document.getElementById("editIcon").style.display = "block";
            break;

        case 'character':
            clearCharacterPendingMedia();
            const charPreview = document.getElementById("characterAvatarPreview");
            const charVid = document.getElementById("characterAvatarPreviewVideo");
            if (charVid) {
                charVid.style.display = "none";
                charVid.removeAttribute("src");
            }
            charPreview.src = croppedBase64;
            charPreview.style.display = "block";
            charPreview.dataset.base64 = croppedBase64;

            document.getElementById("characterAvatarOverlay").style.display = "none";
            document.getElementById("characterAvatarMask").style.display = "none";
            document.getElementById("characterEditIcon").style.display = "block";
            break;

        case 'bank':
            const bankPreview = document.getElementById("bankAvatarPreview");
            bankPreview.src = croppedBase64;
            bankPreview.style.display = "block";
            bankPreview.dataset.base64 = croppedBase64;

            document.getElementById("bankAvatarOverlay").style.display = "none";
            document.getElementById("bankEditIcon").style.display = "block";
            break;
    }

    closeCropModal();
}

function updateGridFromImage() {
    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) return;
    invalidateBg();

    const gridSettings = mapData.grid_settings;

    // Если есть cell_count, пересчитываем cell_size
    if (gridSettings.cell_count) {
        // Проверяем, что cell_count в допустимых пределах
        let cellCount = gridSettings.cell_count;
        if (cellCount < 5) cellCount = 5;
        if (cellCount > 150) cellCount = 150;

        const newCellSize = Math.round(mapImage.naturalWidth / cellCount);
        gridSettings.cell_size = newCellSize;
        gridSettings.cell_count = cellCount;

        console.log(`Grid updated: ${cellCount} cells = ${newCellSize}px per cell`);

        // Синхронизируем поля ввода
        document.getElementById("gridSlider").value = cellCount;
        document.getElementById("gridInput").value = cellCount;
        updateSliderVisual();

        render();
    }
    // Если есть только cell_size (старые данные), конвертируем в cell_count
    else if (gridSettings.cell_size) {
        let newCellCount = Math.round(mapImage.naturalWidth / gridSettings.cell_size);

        // Проверяем, что newCellCount в допустимых пределах
        if (newCellCount < 5) newCellCount = 5;
        if (newCellCount > 150) newCellCount = 150;

        gridSettings.cell_count = newCellCount;
        // Пересчитываем cell_size для точности
        gridSettings.cell_size = Math.round(mapImage.naturalWidth / newCellCount);

        console.log(`Converted old grid: ${gridSettings.cell_size}px per cell = ${newCellCount} cells`);

        // Синхронизируем поля ввода
        document.getElementById("gridSlider").value = newCellCount;
        document.getElementById("gridInput").value = newCellCount;
        updateSliderVisual();

        render();
    }
}

// Сохраняем рисунки
function saveDrawings() {
    if (!currentMapId) {
        console.log("Cannot save drawings: no mapId");
        return;
    }
    ensureDrawingLayerId();

    console.log("Saving drawings, count:", drawingStrokes.length);

    fetch(`/api/drawings/${currentMapId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            layer_id: currentDrawingLayerId,
            strokes: drawingStrokes
        })
    })
        .then(res => {
            if (!res.ok) {
                throw new Error(`HTTP error! status: ${res.status}`);
            }
            return res.json();
        })
        .then(data => {
            if (data.status === 'ok') {
                console.log('Drawings saved successfully');
            }
        })
        .catch(err => console.error('Error saving drawings:', err));
}

// Отрисовка всех штрихов
function drawAllStrokes(offsetX, offsetY, scale) {
    if (!drawingStrokes || drawingStrokes.length === 0) return;

    ctx.save();

    for (const stroke of drawingStrokes) {
        if (!stroke.points || stroke.points.length < 2) continue;

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 50, 50, 0.5)';
        ctx.lineWidth = (stroke.width || 20) * scale; // Здесь stroke.width = 20
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const firstPoint = stroke.points[0];
        ctx.moveTo(
            firstPoint[0] * scale + offsetX,
            firstPoint[1] * scale + offsetY
        );

        for (let i = 1; i < stroke.points.length; i++) {
            const point = stroke.points[i];
            ctx.lineTo(
                point[0] * scale + offsetX,
                point[1] * scale + offsetY
            );
        }

        ctx.stroke();
    }

    ctx.restore();
}

document.getElementById('drawToggle').addEventListener('click', () => {
    // Если включаем рисование
    if (!isDrawMode) {
        // Выключаем линейку
        if (isRulerMode) {
            isRulerMode = false;
            rulerStart = null;
            mapData.ruler_start = null;
            mapData.ruler_end = null;

            // Отключаем видимость линейки для игроков
            mapData.ruler_visible_to_players = false;

            // Обновляем кнопку в интерфейсе мастера
            const playerRulerToggle = document.getElementById("playerRulerToggle");
            if (playerRulerToggle) {
                playerRulerToggle.classList.remove("active");
            }

            // Отправляем обновление линейки
            socket.emit("ruler_update", {
                map_id: currentMapId,
                ruler_start: null,
                ruler_end: null
            });

            socket.emit("ruler_visibility_change", {
                map_id: currentMapId,
                ruler_visible_to_players: false
            });

            // Обновляем кнопку линейки мастера
            const rulerBtn = document.getElementById("rulerToggle");
            if (rulerBtn) {
                rulerBtn.classList.remove("active");
            }
        }

        // Выключаем режим рисования зон
        if (drawingZone) {
            drawingZone = false;
            currentZoneVertices = [];
            const hint = document.getElementById('drawing-hint');
            if (hint) hint.remove();
        }
    }

    isDrawMode = !isDrawMode;
    isEraseMode = false;

    document.getElementById('drawToggle').classList.toggle('active', isDrawMode);
    document.getElementById('eraserToggle').classList.remove('active');

    // ВАЖНО: принудительно перерисовываем канвас
    render();
    updateCanvasCursor();
});

document.getElementById('eraserToggle').addEventListener('click', () => {
    // Если включаем ластик
    if (!isEraseMode) {
        // Выключаем линейку
        if (isRulerMode) {
            isRulerMode = false;
            rulerStart = null;
            mapData.ruler_start = null;
            mapData.ruler_end = null;

            // Отключаем видимость линейки для игроков
            mapData.ruler_visible_to_players = false;

            // Обновляем кнопку в интерфейсе мастера
            const playerRulerToggle = document.getElementById("playerRulerToggle");
            if (playerRulerToggle) {
                playerRulerToggle.classList.remove("active");
            }

            // Отправляем обновление линейки
            socket.emit("ruler_update", {
                map_id: currentMapId,
                ruler_start: null,
                ruler_end: null
            });

            socket.emit("ruler_visibility_change", {
                map_id: currentMapId,
                ruler_visible_to_players: false
            });

            // Обновляем кнопку линейки мастера
            const rulerBtn = document.getElementById("rulerToggle");
            if (rulerBtn) {
                rulerBtn.classList.remove("active");
            }
        }

        // Выключаем режим рисования зон
        if (drawingZone) {
            drawingZone = false;
            currentZoneVertices = [];
            const hint = document.getElementById('drawing-hint');
            if (hint) hint.remove();
        }
    }

    isEraseMode = !isEraseMode;
    isDrawMode = false;

    document.getElementById('eraserToggle').classList.toggle('active', isEraseMode);
    document.getElementById('drawToggle').classList.remove('active');

    // ВАЖНО: принудительно перерисовываем канвас
    render();
    updateCanvasCursor();
});


function eraseNearbyPoints(x, y, radius) {
    console.log('Erasing near point:', x, y, 'radius:', radius);

    // Находим штрих, который находится ближе всего к точке клика
    let closestStrokeIndex = -1;
    let closestDistance = Infinity;

    for (let i = 0; i < drawingStrokes.length; i++) {
        const stroke = drawingStrokes[i];
        for (const point of stroke.points) {
            const dist = Math.hypot(point[0] - x, point[1] - y);
            if (dist < closestDistance) {
                closestDistance = dist;
                closestStrokeIndex = i;
            }
        }
    }

    // Если нашли штрих достаточно близко, удаляем его целиком
    if (closestStrokeIndex !== -1 && closestDistance < radius) {
        const removedStroke = drawingStrokes.splice(closestStrokeIndex, 1)[0];
        console.log(`Removed entire stroke with ${removedStroke.points.length} points`);

        // Сохраняем состояние после стирания
        saveDrawingStateToHistory();

        // Сохраняем на сервере
        saveDrawings();

        // Отправляем всем игрокам
        socket.emit('drawings_updated', {
            map_id: currentMapId,
            strokes: drawingStrokes,
            layer_id: currentDrawingLayerId
        });

        render();
        return true;
    }

    console.log('No stroke found to erase');
    return false;
}

function clearAllDrawings() {
    if (!confirm('Очистить все рисунки на карте?')) return;

    drawingStrokes = [];
    saveDrawings();

    socket.emit('drawings_updated', {
        map_id: currentMapId,
        strokes: [],
        layer_id: currentDrawingLayerId
    });

    render();
}

socket.on('request_drawings_from_master', (data) => {
    console.log('Master received request for drawings:', data);
    if (data.map_id === currentMapId) {
        socket.emit('drawings_updated', {
            map_id: currentMapId,
            strokes: drawingStrokes,
            layer_id: currentDrawingLayerId
        });
    }
});

// Добавляем обработчик для принудительной отправки рисунков при подключении игрока
socket.on('player_connected', (data) => {
    console.log('Player connected to map:', data.map_id);
    if (data.map_id === currentMapId) {
        // Отправляем текущие рисунки новому игроку
        setTimeout(() => {
            socket.emit('drawings_updated', {
                map_id: currentMapId,
                strokes: drawingStrokes,
                layer_id: currentDrawingLayerId
            });
        }, 500);
    }
});

function applyMasterUndoStateAt(index) {
    const e = masterUndoHistory[index];
    if (!e) return;
    draggingVertexZoneId = null;
    draggingVertexIndex  = -1;
    clearSelectedVertex();
    drawingStrokes = JSON.parse(JSON.stringify(e.strokes));
    if (mapData) {
        mapData.zones = JSON.parse(JSON.stringify(e.zones));
    }
    saveDrawings();
    socket.emit('drawings_updated', {
        map_id: currentMapId,
        strokes: drawingStrokes,
        layer_id: currentDrawingLayerId
    });
    debouncedSave(300);
    invalidateBg();
    render();
    updateCanvasCursor();
}

function masterUndo() {
    if (masterUndoIndex <= 0) return false;
    masterUndoIndex--;
    applyMasterUndoStateAt(masterUndoIndex);
    return true;
}

function masterRedo() {
    if (masterUndoIndex >= masterUndoHistory.length - 1) return false;
    masterUndoIndex++;
    applyMasterUndoStateAt(masterUndoIndex);
    return true;
}

/** Сохранить снимок рисунков + зон в единую историю (рисование, перетаскивание вершины зоны и т.д.) */
function saveDrawingStateToHistory() {
    const entry = {
        strokes: JSON.parse(JSON.stringify(drawingStrokes)),
        zones: JSON.parse(JSON.stringify(mapData?.zones || []))
    };
    if (masterUndoHistory.length > 0) {
        const last = masterUndoHistory[masterUndoIndex];
        if (JSON.stringify(last.strokes) === JSON.stringify(entry.strokes) &&
            JSON.stringify(last.zones) === JSON.stringify(entry.zones)) {
            return;
        }
    }
    if (masterUndoIndex < masterUndoHistory.length - 1) {
        masterUndoHistory = masterUndoHistory.slice(0, masterUndoIndex + 1);
    }
    masterUndoHistory.push(entry);
    masterUndoIndex++;
    if (masterUndoHistory.length > MAX_HISTORY_SIZE) {
        masterUndoHistory.shift();
        masterUndoIndex--;
    }
}

function undoDrawing() {
    return masterUndo();
}

function redoDrawing() {
    return masterRedo();
}

function clearDrawingHistory() {
    masterUndoHistory = [];
    masterUndoIndex = -1;
}

function checkAnyModalOpen() {
    const modals = [
        'characterModal',
        'tokenModal',
        'findModal',
        'zoneModal',
        'mapModal',
        'importTokenModal',
        'importPortraitModal',
        'bankModal',
        'newMapModal',
        'bankCharacterModal',
        'combatModal'
    ];

    return modals.some(modalId => {
        const modal = document.getElementById(modalId);
        return modal && modal.style.display === 'flex';
    });
}

function showUndoNotification(message) {
    // Используем существующую функцию showNotification или создаем временное уведомление
    if (typeof showNotification === 'function') {
        showNotification(message, 'info');
    } else {
        // Создаем временное уведомление
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #333;
            color: white;
            padding: 8px 16px;
            border-radius: 4px;
            z-index: 10000;
            opacity: 0.9;
            font-size: 14px;
            transition: opacity 0.3s;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => notification.remove(), 300);
        }, 1500);
    }
}

// Переменные для хранения текущих фильтров
let currentBankTypeFilter = 'all';
let currentImportTypeFilter = 'all';

// Фильтрация банка по типу
function filterBankByType(type) {
    currentBankTypeFilter = type;

    // Обновляем активное состояние кнопок
    document.querySelectorAll('#bankModal .filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.filter === type) {
            btn.classList.add('active');
        }
    });

    // Применяем фильтрацию
    applyBankFilters();
}

// Применение всех фильтров банка (тип + поиск)
function applyBankFilters() {
    const searchText = document.getElementById("bankSearchInput").value.toLowerCase().trim();

    if (!allBankCharacters || allBankCharacters.length === 0) return;

    // Фильтруем сначала по типу
    let filtered = allBankCharacters;

    if (currentBankTypeFilter !== 'all') {
        filtered = filtered.filter(char => char.type === currentBankTypeFilter);
    }

    // Затем по поиску
    if (searchText !== "") {
        filtered = filtered.filter(char =>
            char.name.toLowerCase().includes(searchText)
        );
    }

    displayBankCharacters(filtered);

    // Показываем сообщение, если ничего не найдено
    if (filtered.length === 0) {
        const list = document.getElementById("bankCharacterList");
        list.innerHTML = '<div style="text-align: center; padding: 20px; color: #aaa;">Ничего не найдено</div>';
    }
}

// Фильтрация импорта токенов по типу
function filterImportTokensByType(type) {
    currentImportTypeFilter = type;

    // Обновляем активное состояние кнопок
    document.querySelectorAll('#importTokenModal .filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.filter === type) {
            btn.classList.add('active');
        }
    });

    // Применяем фильтрацию
    applyImportFilters();
}

// Применение всех фильтров импорта (тип + поиск)
function applyImportFilters() {
    const searchText = document.getElementById("importTokenSearchInput").value.toLowerCase().trim();

    if (!allTokensFromMaps || allTokensFromMaps.length === 0) return;

    // Фильтруем сначала по типу
    let filtered = allTokensFromMaps;

    if (currentImportTypeFilter !== 'all') {
        filtered = filtered.filter(token => {
            if (currentImportTypeFilter === 'player') return token.is_player === true;
            if (currentImportTypeFilter === 'npc') return token.is_npc === true;
            if (currentImportTypeFilter === 'enemy') return !token.is_player && !token.is_npc;
            return true;
        });
    }

    // Затем по поиску
    if (searchText !== "") {
        filtered = filtered.filter(token =>
            token.name.toLowerCase().includes(searchText)
        );
    }

    displayImportTokens(filtered);

    // Показываем сообщение, если ничего не найдено
    if (filtered.length === 0) {
        const list = document.getElementById("importTokenList");
        list.innerHTML = '<div style="text-align: center; padding: 20px; color: #aaa;">Ничего не найдено</div>';
    }
}

// Обновляем существующую функцию filterBankCharacters
function filterBankCharacters() {
    applyBankFilters();
}

// Обновляем существующую функцию filterImportTokens
function filterImportTokens() {
    applyImportFilters();
}

// Обновляем функцию loadBankCharacters для сброса фильтра при загрузке
function loadBankCharacters() {
    const list = document.getElementById("bankCharacterList");
    list.innerHTML = '<div style="text-align: center; padding: 20px;">Загрузка...</div>';

    // Сбрасываем фильтр на "Все"
    currentBankTypeFilter = 'all';
    document.querySelectorAll('#bankModal .filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.filter === 'all') {
            btn.classList.add('active');
        }
    });

    // Очищаем поле поиска
    const searchInput = document.getElementById("bankSearchInput");
    if (searchInput) searchInput.value = "";

    fetch("/api/bank/characters")
        .then(res => res.json())
        .then(characters => {
            allBankCharacters = characters;

            if (characters.length === 0) {
                list.innerHTML = '<div style="text-align: center; padding: 20px; color: #aaa;">Банк пуст</div>';
                return;
            }

            displayBankCharacters(characters);
        })
        .catch(err => {
            console.error("Error loading bank characters:", err);
            list.innerHTML = '<div style="text-align: center; padding: 20px; color: #f44336;">Ошибка загрузки</div>';
        });
}

// Обновляем функцию loadAllTokens для сброса фильтра при загрузке
function loadAllTokens() {
    const list = document.getElementById("importTokenList");
    list.innerHTML = '<div style="text-align: center; padding: 20px;">Загрузка...</div>';

    // Сбрасываем фильтр на "Все"
    currentImportTypeFilter = 'all';
    document.querySelectorAll('#importTokenModal .filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.filter === 'all') {
            btn.classList.add('active');
        }
    });

    fetch("/api/tokens/all")
        .then(res => res.json())
        .then(tokens => {
            allTokensFromMaps = tokens;

            if (tokens.length === 0) {
                list.innerHTML = '<div style="text-align: center; padding: 20px; color: #aaa;">Нет токенов на других картах</div>';
                return;
            }

            displayImportTokens(tokens);
        })
        .catch(err => {
            console.error("Error loading tokens:", err);
            list.innerHTML = '<div style="text-align: center; padding: 20px; color: #f44336;">Ошибка загрузки</div>';
        });
}