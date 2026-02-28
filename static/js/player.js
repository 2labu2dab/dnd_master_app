// static/js/player.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const isEmbeddedPreview = window !== window.parent;
let mapData = null;
let zoomLevel = 1;

let panX = 0;
let panY = 0;
const isMiniMap = isEmbeddedPreview;

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

if (mapId) {
    // Запрашиваем синхронизацию при подключении
    socket.on('connect', () => {
        console.log('Socket connected, requesting sync for map:', mapId);
        socket.emit("request_map_sync", { map_id: mapId });
        
        // Также запрашиваем изображение если нужно
        setTimeout(() => {
            if (mapData && mapData.has_image && (!mapImage.src || !mapImage.complete)) {
                socket.emit("request_map_image", { map_id: mapId });
            }
        }, 500);
    });
}

if (!mapId) {
    const urlParams = new URLSearchParams(window.location.search);
    mapId = urlParams.get('map_id');
}

if (!mapId && window.parent && window.parent.currentMapId) {
    mapId = window.parent.currentMapId;
}

// Загружаем карту при старте
if (mapId) {
    fetchMap();
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

            if (mapData.ruler_visible_to_players === undefined) {
                mapData.ruler_visible_to_players = false;
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
        const hadImage = mapData?.has_image;
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
        
        // Проверяем, изменилась ли видимость
        if (wasEnabled !== mapData.player_map_enabled) {
            console.log("Visibility changed to:", mapData.player_map_enabled);
            if (mapData.player_map_enabled && mapData.has_image && !mapImage.src) {
                // Карта стала видимой, но изображение не загружено
                const imageUrl = data.image_url || `/api/map/image/${mapId}?t=${Date.now()}`;
                const newImage = new Image();
                newImage.onload = () => {
                    mapImage = newImage;
                    requestRender();
                };
                newImage.src = imageUrl;
            }
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
        document.getElementById("mapDisabledImage").style.display = "block";
        canvas.style.display = "none";
        return;
    }
    
    document.getElementById("mapDisabledImage").style.display = "none";
    canvas.style.display = "block";

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
// Оптимизированная отрисовка слоев
function drawLayers(offsetX, offsetY, scale) {
    // Сначала рисуем сетку (фон)
    if (!isEmbeddedPreview && mapData.grid_settings.visible && 
        mapData.grid_settings.visible_to_players) {
        drawGrid(offsetX, offsetY, scale);
    }

    // Затем зоны
    if (mapData.zones && mapData.zones.length) {
        // Используем обычный цикл вместо forEach для производительности
        for (let i = 0; i < mapData.zones.length; i++) {
            const zone = mapData.zones[i];
            if (zone.is_visible === false) {
                drawBlurredZone(zone, offsetX, offsetY, scale);
            }
        }
    }

    // Затем токены
    if (mapData.tokens && mapData.tokens.length) {
        for (let i = 0; i < mapData.tokens.length; i++) {
            const token = mapData.tokens[i];
            if (token.is_visible !== false) {
                drawToken(token, offsetX, offsetY, scale);
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
    
    if (!cachedImg) {
      cachedImg = new Image();
      cachedImg.onload = () => requestRender();
      cachedImg.onerror = () => {
        console.warn(`Failed to load avatar for token ${token.name}`);
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
  const dist = Math.sqrt(dx * dx + dy * dy);
  const cells = dist / mapData.grid_settings.cell_size;
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

    ctx.filter = "blur(100px)";
    ctx.drawImage(mapImage, offsetX, offsetY, mapImage.width * scale, mapImage.height * scale);
    ctx.filter = "none";
    ctx.restore();
}

socket.on("map_visibility_change", (data) => {
    if (data.map_id === mapId) {
        const wasEnabled = mapData?.player_map_enabled;
        mapData.player_map_enabled = data.player_map_enabled;
        
        if (data.player_map_enabled && !wasEnabled && mapData?.has_image) {
            // Карта стала видимой - загружаем изображение
            const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
            mapImage = new Image();
            mapImage.onload = () => {
                requestRender();
            };
            mapImage.onerror = () => {
                console.error("Failed to load map image");
            };
            mapImage.src = imageUrl;
        } else if (!data.player_map_enabled && wasEnabled) {
            // Карта стала невидимой - очищаем изображение для экономии памяти
            mapImage = new Image();
        }
        
        requestRender();
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
