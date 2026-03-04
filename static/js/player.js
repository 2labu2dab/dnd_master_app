// static/js/player.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const isEmbeddedPreview = window !== window.parent;
let mapData = null;
let zoomLevel = 1;

let panX = 0;
let panY = 0;
const isMiniMap = isEmbeddedPreview;
const playerChannel = new BroadcastChannel('dnd_map_channel');

let mapImage = new Image();
const avatarCache = new Map();
let renderRequested = false;

// ========== ПОРТРЕТЫ ДЛЯ ИГРОКОВ ==========
let portraitsContainer = document.getElementById('portrait-list');
let portraitSidebar = document.getElementById('portrait-sidebar');
let lastCharactersHash = ''; // Для отслеживания изменений

// Функция для создания хеша персонажей (чтобы определять реальные изменения)
function getCharactersHash(characters) {
    if (!characters || characters.length === 0) return '';
    return characters
        .filter(char => char.visible_to_players !== false)
        .map(char => `${char.id}-${char.name}-${char.visible_to_players}-${char.portrait_url || ''}`)
        .join('|');
}
// Функция для обновления портретов
function updatePortraits() {
    if (!mapData || !portraitsContainer || !portraitSidebar) {
        return;
    }

    // Фильтруем персонажей, видимых игрокам
    const visibleCharacters = (mapData.characters || []).filter(char => char.visible_to_players !== false);
    
    // Вычисляем новый хеш
    const newHash = getCharactersHash(visibleCharacters);
    
    // Если ничего не изменилось, выходим
    if (newHash === lastCharactersHash && portraitSidebar.classList.contains('visible') === (visibleCharacters.length > 0)) {
        return;
    }
    
    lastCharactersHash = newHash;
    
    // Показываем или скрываем сайдбар
    if (visibleCharacters.length > 0) {
        portraitSidebar.classList.add('visible');
        
        // Получаем актуальную высоту контейнера
        const sidebarHeight = portraitSidebar.clientHeight;
        if (sidebarHeight === 0) {
            // Если сайдбар ещё не отрисовался, пробуем позже
            setTimeout(updatePortraits, 50);
            return;
        }
        
        // Рассчитываем максимально возможный размер портрета
        // Высота сайдбара минус отступы:
        // - Заголовок: 20px (margin-bottom) + высота текста ~20px = 40px
        // - Padding сайдбара: 20px сверху + 20px снизу = 40px
        // - Дополнительный запас: 20px
        const reservedHeight = 100; // Зарезервированная высота для заголовка и отступов
        
        const availableHeight = sidebarHeight - reservedHeight;
        
        // Зазоры между портретами (делаем минимальными для максимального размера)
        const gapSize = Math.max(10, 20 - visibleCharacters.length * 2); // Уменьшаем зазоры при увеличении количества
        
        // Высота подписи (делаем чуть меньше для экономии места)
        const nameHeight = 24;
        
        // Вычисляем максимально возможную высоту портрета
        // Для N портретов: N * (portraitHeight + nameHeight) + (N-1) * gapSize = availableHeight
        const totalNameHeight = visibleCharacters.length * nameHeight;
        const totalGapHeight = (visibleCharacters.length - 1) * gapSize;
        const availableForPortraits = availableHeight - totalNameHeight - totalGapHeight;
        
        // Рассчитываем высоту портрета (делим поровну)
        let portraitHeight = Math.floor(availableForPortraits / visibleCharacters.length);
        
        // Устанавливаем минимальный и максимальный размеры
        // Минимальный: 60px (чтобы было видно лицо)
        // Максимальный: 300px (ограничиваем, чтобы не было слишком огромным)
        portraitHeight = Math.min(300, Math.max(60, portraitHeight));
        const portraitWidth = portraitHeight; // Квадратные портреты
        
        // Очищаем контейнер
        portraitsContainer.innerHTML = '';
        
        console.log(`Rendering ${visibleCharacters.length} portraits, size: ${portraitHeight}px, available height: ${availableHeight}px`);
        
        // Создаем элементы для каждого персонажа
        visibleCharacters.forEach((character, index) => {
            const portraitItem = document.createElement('div');
            portraitItem.className = 'portrait-item';
            portraitItem.style.animationDelay = `${index * 0.05}s`;
            portraitItem.style.gap = `${Math.max(4, gapSize / 2)}px`; // Адаптивный gap внутри элемента
            
            // Аватар
            const avatar = document.createElement('img');
            avatar.className = 'portrait-avatar';
            avatar.style.width = `${portraitWidth}px`;
            avatar.style.height = `${portraitHeight}px`;
            
            // Устанавливаем URL портрета с timestamp для сброса кэша
            const portraitUrl = character.portrait_url || `/api/portrait/${character.id}`;
            avatar.src = `${portraitUrl}?t=${Date.now()}`;
            
            avatar.onload = () => {
                // Плавное появление после загрузки
                avatar.style.opacity = '1';
            };
            
            avatar.style.opacity = '0';
            avatar.style.transition = 'opacity 0.3s ease';
            
            avatar.onerror = () => {
                // Если не удалось загрузить портрет, показываем заглушку
                avatar.style.display = 'none';
                console.warn(`Failed to load portrait for ${character.name}`);
            };
            
            // Имя персонажа
            const nameSpan = document.createElement('span');
            nameSpan.className = 'portrait-name';
            nameSpan.textContent = character.name;
            nameSpan.style.fontSize = `${Math.max(12, Math.min(16, Math.floor(portraitHeight / 6)))}px`;
            nameSpan.style.maxWidth = `${portraitWidth + 20}px`;
            
            portraitItem.appendChild(avatar);
            portraitItem.appendChild(nameSpan);
            portraitsContainer.appendChild(portraitItem);
        });
        
        // Добавляем небольшой отступ снизу для эстетики
        portraitsContainer.style.paddingBottom = '10px';
        
    } else {
        portraitSidebar.classList.remove('visible');
        portraitsContainer.innerHTML = '';
    }
}

const resizeObserver = new ResizeObserver(() => {
    updatePortraits();
});

if (portraitSidebar) {
    resizeObserver.observe(portraitSidebar);
}
const socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket']
});

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

console.log("Initial mapId from window.MAP_ID:", mapId);

if (!mapId) {
    const urlParams = new URLSearchParams(window.location.search);
    mapId = urlParams.get('map_id');
    console.log("Map ID from URL:", mapId);
}

if (!mapId && window.parent && window.parent.currentMapId) {
    mapId = window.parent.currentMapId;
    console.log("Map ID from parent:", mapId);
}

console.log("Final mapId:", mapId);

// Сохраняем размеры канваса мастера (будут обновляться при получении данных)
let masterCanvasWidth = 1380;
let masterCanvasHeight = 1080;

window.playerMapId = mapId;

if (mapId) {
    mapImage = new Image();
    fetchMap();
    
    if (socket) {
        socket.on('connect', () => {
            console.log('Socket connected, requesting sync for map:', mapId);
            socket.emit("request_map_sync", { map_id: mapId });
            
            setTimeout(() => {
                if (mapData && mapData.has_image && (!mapImage.src || !mapImage.complete)) {
                    socket.emit("request_map_image", { map_id: mapId });
                }
            }, 500);
        });
    }
} else {
    resizeCanvasToDisplaySize();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "24px Inter";
    ctx.fillStyle = "#666";
    ctx.textAlign = "center";
    ctx.fillText("Карта не выбрана", canvas.width/2, canvas.height/2);
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

function fetchMap() {
    console.log("fetchMap called with mapId:", mapId);
    
    if (!mapId) {
        console.error("No map ID provided");
        requestRender();
        return;
    }
    
    fetch(`/api/map/${mapId}?ts=${Date.now()}`)
        .then(res => {
            if (!res.ok) {
                throw new Error(`HTTP error! status: ${res.status}`);
            }
            return res.json();
        })
        .then(data => {
            if (data.error) {
                console.error(data.error);
                return;
            }
            
            mapData = data;
            
            // Сохраняем размеры канваса мастера
            if (data.master_canvas_width) {
                masterCanvasWidth = data.master_canvas_width;
            }
            if (data.master_canvas_height) {
                masterCanvasHeight = data.master_canvas_height;
            }
            
            zoomLevel = data.zoom_level || 1;
            panX = data.pan_x || 0;
            panY = data.pan_y || 0;
            
            console.log("Map data loaded, has_image:", mapData.has_image);
            console.log("Player map enabled:", mapData.player_map_enabled);
            console.log("Characters count:", (mapData.characters || []).length);

            if (mapData.ruler_visible_to_players === undefined) {
                mapData.ruler_visible_to_players = false;
            }
            
            const disabledImg = document.getElementById("mapDisabledImage");
            if (disabledImg) {
                disabledImg.style.display = mapData.player_map_enabled ? "none" : "block";
            }
            
            if (!mapData.player_map_enabled) {
                canvas.style.display = "none";
                return;
            } else {
                canvas.style.display = "block";
            }
            
            if (mapData.has_image) {
                const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
                
                const newImage = new Image();
                newImage.onload = () => {
                    console.log("Map image loaded successfully");
                    mapImage = newImage;
                    requestRender();
                    updatePortraits();
                };
                newImage.onerror = (err) => {
                    console.error("Error loading map image:", err);
                };
                newImage.src = imageUrl;
            } else {
                mapImage = new Image();
                requestRender();
                updatePortraits();
            }
        })
        .catch(err => {
            console.error("Error fetching map:", err);
            resizeCanvasToDisplaySize();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.font = "24px Inter";
            ctx.fillStyle = "#666";
            ctx.textAlign = "center";
            ctx.fillText("Ошибка загрузки карты", canvas.width/2, canvas.height/2);
        });
}

socket.on("map_updated", (data) => {
    console.log("Map updated received:", data.map_id, "current:", mapId);
    
    if (data.map_id === mapId) {
        const wasEnabled = mapData?.player_map_enabled;
        
        if (!mapData) {
            mapData = {};
        }
        
        const oldHasImage = mapData.has_image;
        const oldCharacters = mapData.characters || [];
        
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
        
        if (data.master_canvas_width) {
            masterCanvasWidth = data.master_canvas_width;
        }
        if (data.master_canvas_height) {
            masterCanvasHeight = data.master_canvas_height;
        }
        
        console.log("Characters updated, count:", (mapData.characters || []).length);
        
        const disabledImg = document.getElementById("mapDisabledImage");
        if (disabledImg) {
            disabledImg.style.display = mapData.player_map_enabled ? "none" : "block";
        }
        
        if (!mapData.player_map_enabled) {
            canvas.style.display = "none";
            return;
        } else {
            canvas.style.display = "block";
        }
        
        if (mapData.has_image && (!oldHasImage || !mapImage.src)) {
            console.log("Image appeared, loading...");
            const imageUrl = data.image_url || `/api/map/image/${mapId}?t=${Date.now()}`;
            const newImage = new Image();
            newImage.onload = () => {
                console.log("Map image loaded successfully");
                mapImage = newImage;
                requestRender();
            };
            newImage.onerror = (err) => {
                console.error("Failed to load map image:", err);
            };
            newImage.src = imageUrl;
        } else if (!mapData.has_image) {
            console.log("Image removed");
            mapImage = new Image();
            requestRender();
        }
        
        requestRender();
        updatePortraits(); // Обновляем портреты при любых изменениях
    }
});

socket.on("ruler_update", (data) => {
    console.log("Ruler update received:", data);
    
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
    console.log("Ruler visibility change received:", data);
    
    if (data.map_id === mapId && mapData) {
        mapData.ruler_visible_to_players = data.ruler_visible_to_players;
        console.log("Ruler visibility updated to:", mapData.ruler_visible_to_players);
        requestRender();
    }
});

console.log("=== PLAYER.JS INITIALIZED ===");
console.log("isEmbeddedPreview:", isEmbeddedPreview);
console.log("Initial mapId:", mapId);
console.log("Initial masterCanvasWidth:", masterCanvasWidth);
console.log("Initial masterCanvasHeight:", masterCanvasHeight);

socket.on("zoom_update", (data) => {
    console.log("📥 RECEIVED zoom_update:", data);
    
    if (data.map_id === mapId) {
        console.log("Before update - zoomLevel:", zoomLevel, "panX:", panX, "panY:", panY);
        console.log("Before update - masterCanvas:", masterCanvasWidth, "x", masterCanvasHeight);
        
        zoomLevel = data.zoom_level || 1;
        panX = data.pan_x ?? 0;
        panY = data.pan_y ?? 0;
        
        if (mapData) {
            if (data.canvas_width) {
                masterCanvasWidth = data.canvas_width;
            }
            if (data.canvas_height) {
                masterCanvasHeight = data.canvas_height;
            }
            mapData.master_canvas_width = data.canvas_width;
            mapData.master_canvas_height = data.canvas_height;
        }
        
        console.log("After update - zoomLevel:", zoomLevel, "panX:", panX, "panY:", panY);
        console.log("After update - masterCanvas:", masterCanvasWidth, "x", masterCanvasHeight);
        
        requestRender();
    }
});

socket.on("map_created", (data) => {
    if (data.map_id) {
        mapId = data.map_id;
        fetchMap();
    }
});

socket.on("master_switched_map", (data) => {
    if (data.map_id && mapId !== data.map_id) {
        mapId = data.map_id;
        window.playerMapId = data.map_id;
        
        const url = new URL(window.location);
        url.searchParams.set('map_id', data.map_id);
        window.history.replaceState({}, '', url);
        
        fetchMap();
    } else if (!data.map_id) {
        mapId = null;
        window.playerMapId = null;
        mapData = null;
        requestRender();
        updatePortraits(); // Обновляем портреты при смене карты
    }
});

function render() {
    console.log("\n========== RENDER DEBUG START ==========");
    console.log("isEmbeddedPreview =", isEmbeddedPreview);
    
    // 1. Базовые проверки
    if (!mapId || !mapData) {
        console.log("No map data");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Карта не выбрана", canvas.width/2, canvas.height/2);
        return;
    }
    
    // 2. Проверка видимости карты
    if (mapData.player_map_enabled === false) {
        console.log("Map disabled for players");
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
    canvas.style.backgroundColor = '#020617';
    
    // 4. Проверка изображения
    resizeCanvasToDisplaySize();
    
    // Сбрасываем трансформацию и очищаем с темным фоном
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!mapData.has_image) {
        console.log("No map image in data");
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Нет изображения карты", canvas.width/2, canvas.height/2);
        return;
    }
    
    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) {
        console.log("Map image not loaded");
        if (!mapImage.src || !mapImage.src.includes(mapId)) {
            const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
            mapImage = new Image();
            mapImage.onload = () => requestRender();
            mapImage.src = imageUrl;
        }
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Загрузка карты...", canvas.width/2, canvas.height/2);
        return;
    }
    
    // 5. Получаем размеры
    const mapW = mapImage.width;
    const mapH = mapImage.height;
    
    console.log("📊 ИСХОДНЫЕ ДАННЫЕ:");
    console.log("Map ID:", mapId);
    console.log("Map image:", mapW + "x" + mapH);
    console.log("Player canvas:", canvas.width + "x" + canvas.height);
    console.log("Master canvas (stored):", masterCanvasWidth + "x" + masterCanvasHeight);
    console.log("Camera params:", { zoomLevel, panX, panY });
    
    // 6. Вычисления
    console.log("\n🔧 РАСЧЕТЫ ДЛЯ МАСТЕРА:");
    
    const masterBaseScale = Math.min(masterCanvasWidth / mapW, masterCanvasHeight / mapH);
    console.log("masterBaseScale = min(" + masterCanvasWidth + "/" + mapW + ", " + masterCanvasHeight + "/" + mapH + ") =", masterBaseScale);
    
    const masterScale = masterBaseScale * zoomLevel;
    console.log("masterScale =", masterBaseScale, "*", zoomLevel, "=", masterScale);
    
    const masterCenterX = masterCanvasWidth / 2;
    const masterCenterY = masterCanvasHeight / 2;
    console.log("masterCenter = (" + masterCenterX + ", " + masterCenterY + ")");
    
    const worldCenterX = (masterCenterX - panX) / masterScale;
    const worldCenterY = (masterCenterY - panY) / masterScale;
    console.log("worldCenterX = (" + masterCenterX + " - " + panX + ") / " + masterScale + " =", worldCenterX);
    console.log("worldCenterY = (" + masterCenterY + " - " + panY + ") / " + masterScale + " =", worldCenterY);
    
    // 7. Вычисления для игрока
    console.log("\n🎮 РАСЧЕТЫ ДЛЯ ИГРОКА:");
    
    const playerBaseScale = Math.min(canvas.width / mapW, canvas.height / mapH);
    console.log("playerBaseScale = min(" + canvas.width + "/" + mapW + ", " + canvas.height + "/" + mapH + ") =", playerBaseScale);
    
    const playerScale = playerBaseScale * zoomLevel;
    console.log("playerScale =", playerBaseScale, "*", zoomLevel, "=", playerScale);
    
    const playerCenterX = canvas.width / 2;
    const playerCenterY = canvas.height / 2;
    console.log("playerCenter = (" + playerCenterX + ", " + playerCenterY + ")");
    
    const offsetX = playerCenterX - worldCenterX * playerScale;
    const offsetY = playerCenterY - worldCenterY * playerScale;
    console.log("offsetX =", offsetX);
    console.log("offsetY =", offsetY);
    
    // 8. Проверка
    console.log("\n✅ ПРОВЕРКА:");
    const testX = offsetX + worldCenterX * playerScale;
    const testY = offsetY + worldCenterY * playerScale;
    console.log("worldCenter на player canvas: (" + testX + ", " + testY + ")");
    console.log("должен быть в центре: (" + playerCenterX + ", " + playerCenterY + ")");
    
    // 9. Границы изображения
    console.log("\n📏 ГРАНИЦЫ ИЗОБРАЖЕНИЯ:");
    console.log("Top-left: (" + offsetX + ", " + offsetY + ")");
    console.log("Bottom-right: (" + (offsetX + mapW * playerScale) + ", " + (offsetY + mapH * playerScale) + ")");
    
    // 10. Рисуем изображение
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(mapImage, offsetX, offsetY, mapW * playerScale, mapH * playerScale);
    
    console.log("\n========== RENDER DEBUG END ==========\n");

    // Рисуем остальные слои
    drawLayers(offsetX, offsetY, playerScale);
    
    // Рисуем линейку если нужно
    if (mapData.ruler_visible_to_players && mapData.ruler_start && mapData.ruler_end) {
        drawMasterRuler(mapData.ruler_start, mapData.ruler_end, offsetX, offsetY, playerScale);
    }
}

socket.on("map_sync", (data) => {
    console.log("map_sync received:", data);
    
    if (!data || data.map_id !== mapId) {
        return;
    }

    zoomLevel = data.zoom_level ?? zoomLevel ?? 1;
    panX = data.pan_x ?? panX ?? 0;
    panY = data.pan_y ?? panY ?? 0;

    requestRender();
});

function drawLayers(offsetX, offsetY, scale) {
    const imageLoaded = mapImage && mapImage.complete && mapImage.naturalWidth > 0;
    
    if (!isEmbeddedPreview && 
        mapData.grid_settings.visible && 
        mapData.grid_settings.visible_to_players &&
        imageLoaded) {
        drawGrid(offsetX, offsetY, scale);
    }

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
    const cell = mapData.grid_settings.cell_size;
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
    
    for (let x = 0; x <= mapImage.width; x += cell) {
        const sx = offsetX + x * scale;
        if (sx < 0 || sx > canvas.width) continue;
        
        ctx.moveTo(sx, Math.max(mapTop, 0));
        ctx.lineTo(sx, Math.min(mapBottom, canvas.height));
    }
    
    for (let y = 0; y <= mapImage.height; y += cell) {
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
    const size = mapData.grid_settings.cell_size * scale;
    const radius = size / 2;

    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, 2 * Math.PI);
    
    const avatarSrc = token.avatar_url || token.avatar_data;
    
    if (avatarSrc) {
        let cachedImg = avatarCache.get(token.id);
        
        if (cachedImg && cachedImg.src !== avatarSrc) {
            avatarCache.delete(token.id);
            cachedImg = null;
        }
        
        if (!cachedImg) {
            cachedImg = new Image();
            cachedImg.onload = () => {
                requestRender();
            };
            cachedImg.onerror = () => {
                console.warn(`Failed to load avatar for token ${token.name}: ${avatarSrc}`);
                avatarCache.set(token.id, null);
            };
            cachedImg.src = avatarSrc;
            avatarCache.set(token.id, cachedImg);
        }
        
        if (cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0) {
            ctx.save();
            ctx.clip();
            
            if (token.is_dead) {
                ctx.globalAlpha = 0.7;
                ctx.filter = 'grayscale(100%)';
                ctx.drawImage(cachedImg, sx - radius, sy - radius, size, size);
                ctx.filter = 'none';
                ctx.globalAlpha = 1;
            } else {
                ctx.drawImage(cachedImg, sx - radius, sy - radius, size, size);
            }
            
            ctx.restore();
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
    ctx.lineWidth = 2;
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
    ctx.lineWidth = 2;
    ctx.stroke();
}

function drawBlurredZone(zone, offsetX, offsetY, scale) {
    if (!zone.vertices || zone.vertices.length < 2) return;

    const transformed = zone.vertices.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(transformed[0][0], transformed[0][1]);
    for (let i = 1; i < transformed.length; i++) {
        ctx.lineTo(transformed[i][0], transformed[i][1]);
    }
    ctx.closePath();
    ctx.clip();

    ctx.filter = "blur(50px)";
    ctx.drawImage(mapImage, offsetX, offsetY, mapImage.width * scale, mapImage.height * scale);
    ctx.filter = "none";
    ctx.restore();
}

socket.on("map_visibility_change", (data) => {
    console.log("Map visibility change received:", data);
    
    if (data.map_id === mapId) {
        const wasEnabled = mapData?.player_map_enabled;
        
        if (!mapData) {
            mapData = {};
        }
        
        const oldHasImage = mapData.has_image;
        
        mapData.player_map_enabled = data.player_map_enabled;
        
        if (data.has_image !== undefined) {
            mapData.has_image = data.has_image;
        }
        
        console.log(`Visibility changed: was ${wasEnabled}, now ${mapData.player_map_enabled}`);
        console.log(`Has image: ${mapData.has_image}`);
        
        const disabledImg = document.getElementById("mapDisabledImage");
        if (disabledImg) {
            disabledImg.style.display = mapData.player_map_enabled ? "none" : "block";
        }
        
        if (mapData.player_map_enabled) {
            canvas.style.display = "block";
            
            const hasMapData = mapData && Object.keys(mapData).length > 0;
            const hasImageLoaded = mapImage && mapImage.complete && mapImage.naturalWidth > 0;
            
            console.log("Current state:", { 
                hasMapData, 
                hasImageLoaded, 
                mapImageSrc: mapImage?.src,
                mapDataHasImage: mapData?.has_image 
            });
            
            if (hasMapData && hasImageLoaded) {
                console.log("Map data and image already present, just rendering");
                requestRender();
                return;
            }
            
            if (hasMapData && mapData.has_image && !hasImageLoaded) {
                console.log("Map data present but image not loaded, loading image...");
                const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
                const newImage = new Image();
                newImage.onload = () => {
                    console.log("Map image loaded successfully");
                    mapImage = newImage;
                    requestRender();
                };
                newImage.onerror = (err) => {
                    console.error("Failed to load map image:", err);
                    requestRender();
                };
                newImage.src = imageUrl;
                return;
            }
            
            console.log("Requesting full map data...");
            
            fetch(`/api/map/${mapId}?ts=${Date.now()}`)
                .then(res => {
                    if (!res.ok) {
                        throw new Error(`HTTP error! status: ${res.status}`);
                    }
                    return res.json();
                })
                .then(fullData => {
                    console.log("Full map data received:", fullData);
                    
                    Object.assign(mapData, fullData);
                    
                    if (fullData.player_map_enabled !== undefined) {
                        mapData.player_map_enabled = fullData.player_map_enabled;
                    }
                    
                    if (mapData.has_image) {
                        const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
                        console.log("Loading map image:", imageUrl);
                        
                        if (mapImage && mapImage.src === imageUrl && mapImage.complete) {
                            console.log("Image already loaded with same URL");
                            requestRender();
                        } else {
                            const newImage = new Image();
                            newImage.onload = () => {
                                console.log("Map image loaded successfully");
                                mapImage = newImage;
                                requestRender();
                            };
                            newImage.onerror = (err) => {
                                console.error("Failed to load map image:", err);
                                requestRender();
                            };
                            newImage.src = imageUrl;
                        }
                    } else {
                        requestRender();
                    }
                    
                    updatePortraits(); // Обновляем портреты после загрузки полных данных
                })
                .catch(err => {
                    console.error("Error fetching full map data:", err);
                    requestRender();
                });
            
            if (data.image_url) {
                console.log("Loading map image from URL:", data.image_url);
                if (mapImage && mapImage.src === data.image_url && mapImage.complete) {
                    console.log("Image already loaded from URL");
                } else {
                    const newImage = new Image();
                    newImage.onload = () => {
                        console.log("Map image loaded from URL");
                        mapImage = newImage;
                        requestRender();
                    };
                    newImage.onerror = (err) => {
                        console.error("Failed to load map image from URL:", err);
                    };
                    newImage.src = data.image_url;
                }
            }
        } else {
            console.log("Map became invisible");
            canvas.style.display = "none";
        }
        
        requestRender();
        updatePortraits(); // Обновляем портреты при изменении видимости
    }
});

socket.on("force_map_update", (data) => {
    console.log("Force map update received:", data);
    
    if (data.map_id === mapId) {
        Object.assign(mapData, data);
        
        if (data.has_image && data.image_url) {
            const newImage = new Image();
            newImage.onload = () => {
                mapImage = newImage;
                requestRender();
            };
            newImage.src = data.image_url;
        } else {
            requestRender();
        }
        
        updatePortraits(); // Обновляем портреты при форсированном обновлении
    }
});

socket.on("map_image_updated", (data) => {
    if (data.map_id === mapId) {
        if (mapData && mapData.player_map_enabled !== false) {
            const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
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
        const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
        mapImage = new Image();
        mapImage.onload = () => {
            requestRender();
        };
        mapImage.src = imageUrl;
    }
});

socket.on("force_image_reload", (data) => {
    console.log("Force image reload received for map:", data.map_id);
    
    if (data.map_id === mapId) {
        const newImage = new Image();
        newImage.onload = () => {
            console.log("Map image reloaded successfully");
            mapImage = newImage;
            
            if (mapData) {
                mapData.has_image = true;
            }
            
            requestRender();
        };
        newImage.onerror = (err) => {
            console.error("Failed to reload map image:", err);
        };
        newImage.src = data.image_url;
    }
});

window.addEventListener('load', () => {
    console.log("Player page fully loaded");
    if (mapId) {
        setTimeout(() => {
            console.log("Requesting map sync after load");
            if (socket && socket.connected) {
                socket.emit("request_map_sync", { map_id: mapId });
            }
            fetchMap();
        }, 1000);
    }
    
    // Инициализируем портреты после загрузки
    setTimeout(updatePortraits, 500);
});

playerChannel.addEventListener('message', (event) => {
    console.log("Player received message:", event.data);
    
    if (event.data.type === 'reload_player' && event.data.map_id === mapId) {
        console.log("Master requested reload, reloading page...");
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

socket.on("token_avatar_updated", (data) => {
    console.log("Token avatar updated received:", data);
    
    if (data.map_id === mapId) {
        if (avatarCache.has(data.token_id)) {
            avatarCache.delete(data.token_id);
            console.log(`Avatar cache cleared for token ${data.token_id}`);
        }
        
        if (mapData && mapData.tokens) {
            const token = mapData.tokens.find(t => t.id === data.token_id);
            if (token) {
                token.avatar_url = data.avatar_url;
                console.log(`Token ${data.token_id} avatar URL updated to: ${data.avatar_url}`);
            }
        }
        
        requestRender();
    }
});

socket.on("force_avatar_reload", (data) => {
    console.log("Force avatar reload received:", data);
    
    if (data.map_id === mapId) {
        avatarCache.clear();
        console.log("All avatar cache cleared");
        fetchMap();
    }
});