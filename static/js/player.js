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
const avatarCache = new Map(); // Используем Map для лучшей производительности
let renderRequested = false;
let lastRenderTime = 0;
const RENDER_THROTTLE = 16; // ~60fps

const socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket'] // Используем WebSocket для меньшей задержки
});

// Оптимизированная функция рендера с throttling
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

// Сохраняем в window для отладки
window.playerMapId = mapId;

// Загружаем карту при старте
if (mapId) {
    // Очищаем кэш изображения
    mapImage = new Image();
    
    // Загружаем карту
    fetchMap();
    
    // Настраиваем сокет
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
    }
}

window.addEventListener("resize", () => {
    resizeCanvasToDisplaySize();
});

window.playerMapId = mapId;

// Оптимизированная загрузка карты
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
            
            const hadImage = mapData?.has_image;
            const oldMapImage = mapImage;
            
            mapData = data;
            zoomLevel = mapData.zoom_level || 1;
            panX = mapData.pan_x || 0;
            panY = mapData.pan_y || 0;
            
            console.log("Map data loaded, has_image:", mapData.has_image);
            console.log("Player map enabled:", mapData.player_map_enabled);

            if (mapData.ruler_visible_to_players === undefined) {
                mapData.ruler_visible_to_players = false;
            }
            
            // Показываем или скрываем disabled.png
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
            
            // Загружаем изображение если есть
            if (mapData.has_image) {
                const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
                
                // Всегда перезагружаем изображение при получении новых данных
                const newImage = new Image();
                newImage.onload = () => {
                    console.log("Map image loaded successfully");
                    mapImage = newImage;
                    requestRender();
                };
                newImage.onerror = (err) => {
                    console.error("Error loading map image:", err);
                };
                newImage.src = imageUrl;
            } else {
                mapImage = new Image();
                requestRender();
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

// Оптимизированные обработчики socket.io
socket.on("map_updated", (data) => {
    console.log("Map updated received:", data.map_id, "current:", mapId);
    
    if (data.map_id === mapId) {
        const wasEnabled = mapData?.player_map_enabled;
        
        if (!mapData) {
            mapData = {};
        }
        
        // Сохраняем старые значения для сравнения
        const oldHasImage = mapData.has_image;
        
        // Обновляем данные
        Object.assign(mapData, {
            tokens: data.tokens || [],
            zones: data.zones || [],
            finds: data.finds || [],
            grid_settings: data.grid_settings || mapData.grid_settings,
            ruler_visible_to_players: data.ruler_visible_to_players,
            ruler_start: data.ruler_start,
            ruler_end: data.ruler_end,
            player_map_enabled: data.player_map_enabled !== undefined ? data.player_map_enabled : true,
            has_image: data.has_image || false
        });
        
        console.log("Has image changed?", oldHasImage, "->", mapData.has_image);
        console.log("Player map enabled:", mapData.player_map_enabled);
        
        // Показываем или скрываем disabled.png
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
        
        // Проверяем, появилось ли изображение
        if (mapData.has_image && (!oldHasImage || !mapImage.src)) {
            console.log("Image appeared, loading...");
            // Изображение появилось - загружаем
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
            // Изображение удалено
            mapImage = new Image();
            requestRender();
        }
        
        requestRender();
    }
});

socket.on("ruler_update", (data) => {
    console.log("Ruler update received:", data); // Для отладки
    
    if (data.map_id === mapId && mapData) {
        // Используем throttle для обновления линейки
        if (!window.rulerUpdateThrottle) {
            window.rulerUpdateThrottle = setTimeout(() => {
                mapData.ruler_start = data.ruler_start;
                mapData.ruler_end = data.ruler_end;
                
                // Проверяем, видима ли линейка для игроков
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

socket.on("zoom_update", (data) => {
    if (data.map_id === mapId) {
        zoomLevel = data.zoom_level || 1;
        panX = data.pan_x ?? 0;
        panY = data.pan_y ?? 0;
        
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
    }
});

// Оптимизированная функция рендера
function render() {
    console.log("RENDER CALLED", {
        mapId: mapId,
        hasMapData: !!mapData,
        player_map_enabled: mapData?.player_map_enabled,
        has_image: mapData?.has_image,
        mapImageComplete: mapImage?.complete,
        mapImageNaturalWidth: mapImage?.naturalWidth,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height
    });
    
    resizeCanvasToDisplaySize();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!mapId || !mapData) {
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Карта не выбрана", canvas.width/2, canvas.height/2);
        return;
    }
    
    if (mapData.player_map_enabled === false) {
        const disabledImg = document.getElementById("mapDisabledImage");
        if (disabledImg) {
            disabledImg.style.display = "block";
        }
        canvas.style.display = "none";
    return;
    } else {
        const disabledImg = document.getElementById("mapDisabledImage");
        if (disabledImg) {
            disabledImg.style.display = "none";
        }
        canvas.style.display = "block";
    }

    // Проверяем, есть ли изображение и загружено ли оно
    if (mapData.has_image) {
        if (!mapImage.complete || mapImage.naturalWidth === 0) {
            // Изображение не загружено - пробуем загрузить
            if (!mapImage.src || !mapImage.src.includes(mapId)) {
                const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
                mapImage = new Image();
                mapImage.onload = () => {
                    requestRender();
                };
                mapImage.onerror = () => {
                    console.error("Failed to load map image");
                };
                mapImage.src = imageUrl;
            }
            
            // Показываем сообщение о загрузке
            ctx.font = "24px Inter";
            ctx.fillStyle = "#666";
            ctx.textAlign = "center";
            ctx.fillText("Загрузка карты...", canvas.width/2, canvas.height/2);
            return;
        }
    } else {
        // Нет изображения - показываем пустой холст
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Нет изображения карты", canvas.width/2, canvas.height/2);
        return;
    }

    const mapW = mapImage.width;
    const mapH = mapImage.height;

    let scale, offsetX, offsetY;

    if (isEmbeddedPreview) {
        const masterW = mapData.master_canvas_width || 1380;
        const masterH = mapData.master_canvas_height || 1080;

        const masterBaseScale = Math.min(masterW / mapW, masterH / mapH);
        const masterScale = masterBaseScale * zoomLevel;

        const scaleRatioW = canvas.width / masterW;
        const scaleRatioH = canvas.height / masterH;

        scale = masterScale * scaleRatioW;
        offsetX = panX * scaleRatioW;
        offsetY = panY * scaleRatioH;
    } else {
        const baseScale = Math.min(canvas.width / mapW, canvas.height / mapH);
        scale = baseScale * zoomLevel;
        offsetX = panX;
        offsetY = panY;
    }

    // Рисуем изображение
    ctx.drawImage(mapImage, offsetX, offsetY, mapW * scale, mapH * scale);

    // Рисуем остальные слои
    drawLayers(offsetX, offsetY, scale);
    
    // Рисуем линейку если нужно
    if (!isEmbeddedPreview && mapData.ruler_visible_to_players && 
        mapData.ruler_start && mapData.ruler_end) {
        drawMasterRuler(mapData.ruler_start, mapData.ruler_end, offsetX, offsetY, scale);
    }
}

socket.on("map_sync", (data) => {
    console.log("map_sync received:", data);
    
    if (!data || data.map_id !== mapId) {
        return;
    }

    // Обновляем только параметры камеры, не трогая остальные данные карты
    zoomLevel = data.zoom_level ?? zoomLevel ?? 1;
    panX = data.pan_x ?? panX ?? 0;
    panY = data.pan_y ?? panY ?? 0;

    requestRender();
});


// Оптимизированная отрисовка слоев
function drawLayers(offsetX, offsetY, scale) {
    // Сначала рисуем сетку (фон)
    if (!isEmbeddedPreview && mapData.grid_settings.visible && 
        mapData.grid_settings.visible_to_players) {
        drawGrid(offsetX, offsetY, scale);
    }

    // Затем зоны
    if (mapData.zones && mapData.zones.length) {
        for (let i = 0; i < mapData.zones.length; i++) {
            const zone = mapData.zones[i];
            if (zone.is_visible === false) {
                drawBlurredZone(zone, offsetX, offsetY, scale);
            }
        }
    }

    // Затем токены - ТОЛЬКО те, которые НЕ находятся в скрытых зонах
    if (mapData.tokens && mapData.tokens.length) {
        for (let i = 0; i < mapData.tokens.length; i++) {
            const token = mapData.tokens[i];
            
            // Проверяем видимость токена (по умолчанию true)
            if (token.is_visible !== false) {
                // Получаем позицию токена в мировых координатах
                const tokenPosition = token.position;
                
                // Проверяем, находится ли токен в какой-либо скрытой зоне
                const isInHiddenZone = isPointInAnyZone(tokenPosition, mapData.zones);
                
                // Рисуем токен ТОЛЬКО если он НЕ в скрытой зоне
                if (!isInHiddenZone) {
                    drawToken(token, offsetX, offsetY, scale);
                } else {
                    console.log(`Token ${token.name} hidden because it's in a hidden zone`);
                }
            }
        }
    }
}

// Оптимизированная отрисовка сетки
function drawGrid(offsetX, offsetY, scale) {
    const size = mapData.grid_settings.cell_size * scale;
    ctx.strokeStyle = mapData.grid_settings.color || "#888";
    ctx.lineWidth = 1;
    
    // Сохраняем текущий путь для оптимизации
    ctx.beginPath();
    
    // Вертикальные линии
    for (let x = offsetX % size; x < canvas.width; x += size) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
    }
    
    // Горизонтальные линии
    for (let y = offsetY % size; y < canvas.height; y += size) {
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
    }
    
    ctx.stroke();
}

// Оптимизированная отрисовка токена с кэшированием аватаров
function drawToken(token, offsetX, offsetY, scale) {
  const [x, y] = token.position;
  const sx = x * scale + offsetX;
  const sy = y * scale + offsetY;
  const size = mapData.grid_settings.cell_size * scale;
  const radius = size / 2;

  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, 2 * Math.PI);
  
  // Используем avatar_url для загрузки аватара
  const avatarSrc = token.avatar_url || token.avatar_data;
  
  if (avatarSrc) {
    let cachedImg = avatarCache.get(token.id);
    
    // Проверяем, нужно ли обновить кэш (если URL изменился)
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

// Остальные функции оставляем без изменений...
function drawMasterRuler(start, end, offsetX, offsetY, scale) {
  if (!start || !end) return;
  
  const [x1, y1] = start;
  const [x2, y2] = end;

  const sx1 = x1 * scale + offsetX;
  const sy1 = y1 * scale + offsetY;
  const sx2 = x2 * scale + offsetX;
  const sy2 = y2 * scale + offsetY;

  // Проверяем, видна ли линейка на экране
  const minX = Math.min(sx1, sx2);
  const maxX = Math.max(sx1, sx2);
  const minY = Math.min(sy1, sy2);
  const maxY = Math.max(sy1, sy2);
  
  if (maxX < 0 || minX > canvas.width || maxY < 0 || minY > canvas.height) {
    return; // Линейка вне экрана, не рисуем
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

  // Как в Civilization для квадратной сетки:
  // считаем количество шагов по тайлам, диагональ = 1 шаг.
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
        
        // Сохраняем старое значение has_image для сравнения
        const oldHasImage = mapData.has_image;
        
        mapData.player_map_enabled = data.player_map_enabled;
        
        // Обновляем флаг наличия изображения, если он пришел
        if (data.has_image !== undefined) {
            mapData.has_image = data.has_image;
        }
        
        console.log(`Visibility changed: was ${wasEnabled}, now ${mapData.player_map_enabled}`);
        console.log(`Has image: ${mapData.has_image}`);
        
        // Показываем или скрываем disabled.png
        const disabledImg = document.getElementById("mapDisabledImage");
        if (disabledImg) {
            disabledImg.style.display = mapData.player_map_enabled ? "none" : "block";
        }
        
        if (mapData.player_map_enabled) {
            // Карта стала видимой
            canvas.style.display = "block";
            
            // Проверяем, есть ли у нас уже данные карты и изображение
            const hasMapData = mapData && Object.keys(mapData).length > 0;
            const hasImageLoaded = mapImage && mapImage.complete && mapImage.naturalWidth > 0;
            
            console.log("Current state:", { 
                hasMapData, 
                hasImageLoaded, 
                mapImageSrc: mapImage?.src,
                mapDataHasImage: mapData?.has_image 
            });
            
            // Если у нас уже есть данные карты и изображение загружено, просто рендерим
            if (hasMapData && hasImageLoaded) {
                console.log("Map data and image already present, just rendering");
                requestRender();
                return;
            }
            
            // Если есть данные карты, но нет изображения, а карта должна иметь изображение
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
            
            // Если нет данных карты или они неполные, запрашиваем полные данные
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
                    
                    // Обновляем все данные, но сохраняем существующие если нужно
                    Object.assign(mapData, fullData);
                    
                    // Обновляем флаг видимости из данных, если он там есть
                    if (fullData.player_map_enabled !== undefined) {
                        mapData.player_map_enabled = fullData.player_map_enabled;
                    }
                    
                    if (mapData.has_image) {
                        // Если есть изображение, загружаем его
                        const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
                        console.log("Loading map image:", imageUrl);
                        
                        // Проверяем, не загружено ли уже это изображение
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
                        // Нет изображения - просто рендерим (покажет сообщение)
                        requestRender();
                    }
                })
                .catch(err => {
                    console.error("Error fetching full map data:", err);
                    requestRender();
                });
            
            // Также пробуем загрузить изображение напрямую, если есть URL
            if (data.image_url) {
                console.log("Loading map image from URL:", data.image_url);
                // Проверяем, не загружено ли уже
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
            // Карта стала невидимой
            console.log("Map became invisible");
            canvas.style.display = "none";
            // НЕ очищаем изображение, чтобы при повторном включении быстро показать
            // mapImage = new Image(); // закомментировано
        }
        
        requestRender();
    }
});

socket.on("force_map_update", (data) => {
    console.log("Force map update received:", data);
    
    if (data.map_id === mapId) {
        // Обновляем данные
        Object.assign(mapData, data);
        
        // Если есть изображение, загружаем его
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
    }
});

socket.on("map_image_updated", (data) => {
    if (data.map_id === mapId) {
        // Обновляем только если карта видима игрокам
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
        // Перезагружаем изображение
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
        // Принудительно перезагружаем изображение
        const newImage = new Image();
        newImage.onload = () => {
            console.log("Map image reloaded successfully");
            mapImage = newImage;
            
            // Обновляем mapData если нужно
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

// Принудительно запрашиваем синхронизацию после полной загрузки
window.addEventListener('load', () => {
    console.log("Player page fully loaded");
    if (mapId) {
        setTimeout(() => {
            console.log("Requesting map sync after load");
            if (socket && socket.connected) {
                socket.emit("request_map_sync", { map_id: mapId });
            }
            // Также запрашиваем данные через REST API
            fetchMap();
        }, 1000);
    }
});


playerChannel.addEventListener('message', (event) => {
    console.log("Player received message:", event.data);
    
    if (event.data.type === 'reload_player' && event.data.map_id === mapId) {
        console.log("Master requested reload, reloading page...");
        // Перезагружаем страницу через небольшую задержку
        setTimeout(() => {
            window.location.reload();
        }, 100);
    }
});


function isPointInAnyZone(point, zones) {
    if (!zones || !zones.length) return false;
    
    for (let i = 0; i < zones.length; i++) {
        const zone = zones[i];
        // Проверяем только невидимые зоны (те, которые скрыты от игроков)
        if (zone.is_visible === false && zone.vertices && zone.vertices.length >= 3) {
            if (pointInPolygon(point, zone.vertices)) {
                return true;
            }
        }
    }
    return false;
}

// Вспомогательная функция для проверки точки в полигоне
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
        // Очищаем кэш для этого токена
        if (avatarCache.has(data.token_id)) {
            avatarCache.delete(data.token_id);
            console.log(`Avatar cache cleared for token ${data.token_id}`);
        }
        
        // Обновляем данные токена если они уже есть
        if (mapData && mapData.tokens) {
            const token = mapData.tokens.find(t => t.id === data.token_id);
            if (token) {
                token.avatar_url = data.avatar_url;
                console.log(`Token ${data.token_id} avatar URL updated to: ${data.avatar_url}`);
            }
        }
        
        // Запрашиваем перерендер
        requestRender();
    }
});

socket.on("force_avatar_reload", (data) => {
    console.log("Force avatar reload received:", data);
    
    if (data.map_id === mapId) {
        // Очищаем весь кэш аватаров
        avatarCache.clear();
        console.log("All avatar cache cleared");
        
        // Запрашиваем обновление данных карты
        fetchMap();
    }
});

function drawPortrait(character, offsetX, offsetY, scale) {
  // Логика отрисовки портрета
  const img = new Image();
  if (character.has_avatar) {
    const portraitUrl = character.portrait_url || `/api/portrait/${character.id}`;
    img.src = `${portraitUrl}?t=${Date.now()}`;
    img.onload = () => {
      // Отрисовка изображения
      ctx.drawImage(img, offsetX, offsetY, 50 * scale, 50 * scale);
    };
  }
}