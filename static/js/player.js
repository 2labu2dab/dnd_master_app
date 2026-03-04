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
let updateTimeout = null;

// Функция для создания хеша персонажей (чтобы определять реальные изменения)
function getCharactersHash(characters) {
    if (!characters || characters.length === 0) return '';
    return characters
        .filter(char => char.visible_to_players !== false)
        .map(char => `${char.id}-${char.name}-${char.visible_to_players}-${char.portrait_url || ''}`)
        .join('|');
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
    }, 100);
});

if (portraitSidebar) {
    resizeObserver.observe(portraitSidebar);
}

// Вызываем updatePortraits при загрузке
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(updatePortraits, 200);
});

const socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket']
});

function performUpdatePortraits() {
    if (!mapData || !portraitsContainer || !portraitSidebar) {
        return;
    }

    // Проверяем, включена ли карта для игроков
    const isMapEnabled = mapData.player_map_enabled !== false;
    
    // Фильтруем персонажей, видимых игрокам
    const visibleCharacters = (mapData.characters || []).filter(char => char.visible_to_players !== false);
    const count = visibleCharacters.length;
    
    const newHash = getCharactersHash(visibleCharacters);
    
    // Всегда обновляем, если изменился хеш или видимость сайдбара
    const sidebarVisible = portraitSidebar.classList.contains('visible');
    // Сайдбар видим только если карта включена И есть видимые персонажи
    const shouldBeVisible = isMapEnabled && count > 0;
    
    if (newHash === lastCharactersHash && sidebarVisible === shouldBeVisible) {
        return;
    }
    
    lastCharactersHash = newHash;
    
    if (shouldBeVisible) {
        portraitSidebar.classList.add('visible');
        
        // Даем время на применение класса visible
        setTimeout(() => {
            renderPortraits(visibleCharacters);
        }, 50);
    } else {
        portraitSidebar.classList.remove('visible');
        portraitsContainer.innerHTML = '';
    }
}

function renderPortraits(characters) {
    if (!portraitsContainer || !portraitSidebar) return;
    
    const count = characters.length;
    const sidebarHeight = portraitSidebar.clientHeight;
    const sidebarWidth = portraitSidebar.clientWidth;
    
    if (sidebarHeight === 0 || sidebarWidth === 0) {
        setTimeout(() => renderPortraits(characters), 50);
        return;
    }
    
    console.log(`Rendering ${count} portraits, sidebar: ${sidebarWidth}x${sidebarHeight}, isMiniMap: ${isMiniMap}`);
    
    // Определяем конфигурацию сетки
    const gridConfig = getGridConfig(count);
    const cols = gridConfig.cols;
    const rows = gridConfig.rows;
    
    console.log(`Grid: ${cols} columns, ${rows} rows`);
    
    // Зарезервированная высота для заголовка (минимум)
    const headerHeight = isMiniMap ? 20 : 40;
    
    // Доступная высота для контента (максимум)
    const availableHeight = sidebarHeight - headerHeight;
    
    // Минимальные зазоры для максимального размера
    let gapSize = isMiniMap ? 2 : 4;
    
    // Общая высота зазоров
    const totalGapHeight = (rows - 1) * gapSize;
    
    // Минимальная высота имени (только для полноэкранного режима)
    let nameHeight = isMiniMap ? 0 : 20; // В мини-карте подписей нет
    if (!isMiniMap) {
        if (count > 6) nameHeight = 18;
        if (count > 8) nameHeight = 16;
    }
    
    // Доступная высота для всех портретов (максимум)
    const availableForPortraits = availableHeight - totalGapHeight - (rows * nameHeight);
    
    // Высота каждого портрета (максимально возможная)
    let portraitHeight = Math.floor(availableForPortraits / rows);
    
    // Динамические максимальные размеры
    let maxPortraitSize;
    
    if (isMiniMap) {
        // Для мини-карты - без подписей, можно сделать чуть больше
        if (count === 1) maxPortraitSize = 100;
        else if (count === 2) maxPortraitSize = 85;
        else if (count <= 4) maxPortraitSize = 70;
        else if (count <= 6) maxPortraitSize = 60;
        else if (count <= 8) maxPortraitSize = 50;
        else maxPortraitSize = 45;
    } else {
        // Для полноэкранного режима
        if (count === 1) maxPortraitSize = 400;
        else if (count === 2) maxPortraitSize = 320;
        else if (count <= 4) maxPortraitSize = 260;
        else if (count <= 6) maxPortraitSize = 200;
        else if (count <= 8) maxPortraitSize = 160;
        else maxPortraitSize = 130;
    }
    
    // Применяем максимальный размер
    portraitHeight = Math.min(maxPortraitSize, portraitHeight);
    
    // Минимальный размер
    portraitHeight = Math.max(isMiniMap ? 35 : 60, portraitHeight);
    
    // Рассчитываем доступную ширину колонки
    const padding = isMiniMap ? 10 : 30;
    const availableWidth = sidebarWidth - padding;
    
    // Рассчитываем ширину колонки с учетом зазоров
    const totalGapWidth = (cols - 1) * gapSize;
    const columnWidth = (availableWidth - totalGapWidth) / cols;
    
    // Итоговый размер портрета
    let finalPortraitSize = Math.min(portraitHeight, columnWidth);
    
    // Убеждаемся, что портрет не слишком маленький
    finalPortraitSize = Math.max(isMiniMap ? 30 : 60, finalPortraitSize);
    
    // Для мини-карты дополнительно проверяем, не слишком ли большой
    if (isMiniMap) {
        const maxAllowedWidth = (sidebarWidth - padding) / cols;
        if (finalPortraitSize > maxAllowedWidth) {
            finalPortraitSize = maxAllowedWidth - 2;
        }
    }
    
    console.log(`Portrait size: ${finalPortraitSize}px, Column width: ${columnWidth}px, Available width: ${availableWidth}px`);
    
    // Очищаем контейнер
    portraitsContainer.innerHTML = '';
    
    // Создаем сетку с точными размерами
    const gridContainer = document.createElement('div');
    gridContainer.className = 'portrait-grid';
    gridContainer.style.display = 'grid';
    gridContainer.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    gridContainer.style.gap = `${gapSize}px`;
    gridContainer.style.width = '100%';
    gridContainer.style.height = '100%';
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
        portraitItem.style.width = '100%';
        portraitItem.style.padding = '0';
        portraitItem.style.margin = '0';
        portraitItem.style.boxSizing = 'border-box';
        
        // Контейнер для аватара
        const avatarContainer = document.createElement('div');
        avatarContainer.style.width = `${finalPortraitSize}px`;
        avatarContainer.style.height = `${finalPortraitSize}px`;
        avatarContainer.style.margin = '0 auto';
        avatarContainer.style.flexShrink = '0';
        avatarContainer.style.position = 'relative';
        avatarContainer.style.overflow = 'hidden';
        avatarContainer.style.borderRadius = isMiniMap ? '4px' : '8px';
        avatarContainer.style.backgroundColor = '#2a2a3b';
        
        // Аватар
        const avatar = document.createElement('img');
        avatar.className = 'portrait-avatar';
        avatar.style.width = '100%';
        avatar.style.height = '100%';
        avatar.style.objectFit = 'cover';
        avatar.style.display = 'block';
        
        const portraitUrl = character.portrait_url || `/api/portrait/${character.id}`;
        avatar.src = `${portraitUrl}?t=${Date.now()}`;
        
        avatar.onload = () => {
            avatar.style.opacity = '1';
        };
        
        avatar.style.opacity = '0';
        avatar.style.transition = 'opacity 0.3s ease';
        
        avatar.onerror = () => {
            avatar.style.display = 'none';
            avatarContainer.style.display = 'flex';
            avatarContainer.style.alignItems = 'center';
            avatarContainer.style.justifyContent = 'center';
            avatarContainer.innerHTML = `<span style="color: #666; font-size: ${finalPortraitSize/2}px;">?</span>`;
        };
        
        avatarContainer.appendChild(avatar);
        portraitItem.appendChild(avatarContainer);
        
        // Добавляем имя ТОЛЬКО для полноэкранного режима
        if (!isMiniMap) {
            const nameSpan = document.createElement('span');
            nameSpan.className = 'portrait-name';
            nameSpan.textContent = character.name;
            nameSpan.style.width = '100%';
            nameSpan.style.textAlign = 'center';
            nameSpan.style.overflow = 'hidden';
            nameSpan.style.textOverflow = 'ellipsis';
            nameSpan.style.whiteSpace = 'nowrap';
            
            // Размер шрифта для имени
            let fontSize = 14;
            if (finalPortraitSize < 80) fontSize = 11;
            else if (finalPortraitSize < 120) fontSize = 12;
            else if (finalPortraitSize < 180) fontSize = 13;
            else fontSize = 14;
            
            nameSpan.style.fontSize = `${fontSize}px`;
            nameSpan.style.padding = '2px 6px';
            nameSpan.style.marginTop = '4px';
            nameSpan.style.lineHeight = '1.4';
            nameSpan.style.backgroundColor = 'rgba(0,0,0,0.3)';
            nameSpan.style.borderRadius = '8px';
            nameSpan.style.color = '#fff';
            nameSpan.style.fontWeight = '500';
            
            portraitItem.appendChild(nameSpan);
        }
        
        gridContainer.appendChild(portraitItem);
    });
    
    portraitsContainer.appendChild(gridContainer);
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



if (!mapId) {
    const urlParams = new URLSearchParams(window.location.search);
    mapId = urlParams.get('map_id');

}

if (!mapId && window.parent && window.parent.currentMapId) {
    mapId = window.parent.currentMapId;

}



// Сохраняем размеры канваса мастера (будут обновляться при получении данных)
let masterCanvasWidth = 1380;
let masterCanvasHeight = 1080;

window.playerMapId = mapId;

if (mapId) {
    mapImage = new Image();
    fetchMap();
    
    if (socket) {
        socket.on('connect', () => {

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
        


        
        const disabledImg = document.getElementById("mapDisabledImage");
        if (disabledImg) {
            disabledImg.style.display = mapData.player_map_enabled ? "none" : "block";
        }
        
        if (!mapData.player_map_enabled) {
            canvas.style.display = "none";
        } else {
            canvas.style.display = "block";
        }
        
        if (mapData.has_image && (!oldHasImage || !mapImage.src)) {

            const imageUrl = data.image_url || `/api/map/image/${mapId}?t=${Date.now()}`;
            const newImage = new Image();
            newImage.onload = () => {

                mapImage = newImage;
                requestRender();
            };
            newImage.onerror = (err) => {
                console.error("Failed to load map image:", err);
            };
            newImage.src = imageUrl;
        } else if (!mapData.has_image) {

            mapImage = new Image();
            requestRender();
        }
        
        requestRender();
        updatePortraits(); // Обновляем портреты при любых изменениях
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

    
    if (data.map_id === mapId) {


        
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


    
    // 1. Базовые проверки
    if (!mapId || !mapData) {

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Карта не выбрана", canvas.width/2, canvas.height/2);
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
    canvas.style.backgroundColor = '#020617';
    
    // 4. Проверка изображения
    resizeCanvasToDisplaySize();
    
    // Сбрасываем трансформацию и очищаем с темным фоном
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!mapData.has_image) {

        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Нет изображения карты", canvas.width/2, canvas.height/2);
        return;
    }
    
    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) {

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
    






    
    // 6. Вычисления

    
    const masterBaseScale = Math.min(masterCanvasWidth / mapW, masterCanvasHeight / mapH);

    
    const masterScale = masterBaseScale * zoomLevel;

    
    const masterCenterX = masterCanvasWidth / 2;
    const masterCenterY = masterCanvasHeight / 2;

    
    const worldCenterX = (masterCenterX - panX) / masterScale;
    const worldCenterY = (masterCenterY - panY) / masterScale;


    
    // 7. Вычисления для игрока

    
    const playerBaseScale = Math.min(canvas.width / mapW, canvas.height / mapH);

    
    const playerScale = playerBaseScale * zoomLevel;

    
    const playerCenterX = canvas.width / 2;
    const playerCenterY = canvas.height / 2;

    
    const offsetX = playerCenterX - worldCenterX * playerScale;
    const offsetY = playerCenterY - worldCenterY * playerScale;


    
    // 8. Проверка

    const testX = offsetX + worldCenterX * playerScale;
    const testY = offsetY + worldCenterY * playerScale;


    
    // 9. Границы изображения



    
    // 10. Рисуем изображение
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
        
        const disabledImg = document.getElementById("mapDisabledImage");
        if (disabledImg) {
            disabledImg.style.display = mapData.player_map_enabled ? "none" : "block";
        }
        
        if (mapData.player_map_enabled) {
            canvas.style.display = "block";
            
            const hasMapData = mapData && Object.keys(mapData).length > 0;
            const hasImageLoaded = mapImage && mapImage.complete && mapImage.naturalWidth > 0;
            
            if (hasMapData && hasImageLoaded) {
                requestRender();
                return;
            }
            
            if (hasMapData && mapData.has_image && !hasImageLoaded) {
                const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
                const newImage = new Image();
                newImage.onload = () => {
                    mapImage = newImage;
                    requestRender();
                };
                newImage.onerror = (err) => {
                    requestRender();
                };
                newImage.src = imageUrl;
                return;
            }
            
            
            fetch(`/api/map/${mapId}?ts=${Date.now()}`)
                .then(res => {
                    if (!res.ok) {
                        throw new Error(`HTTP error! status: ${res.status}`);
                    }
                    return res.json();
                })
                .then(fullData => {
                    
                    Object.assign(mapData, fullData);
                    
                    if (fullData.player_map_enabled !== undefined) {
                        mapData.player_map_enabled = fullData.player_map_enabled;
                    }
                    
                    if (mapData.has_image) {
                        const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
                        
                        if (mapImage && mapImage.src === imageUrl && mapImage.complete) {
                            requestRender();
                        } else {
                            const newImage = new Image();
                            newImage.onload = () => {
                                mapImage = newImage;
                                requestRender();
                            };
                            newImage.onerror = (err) => {
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
                    requestRender();
                });
            
            // if (data.image_url) {
            //     console.log("Loading map image from URL:", data.image_url);
            //     if (mapImage && mapImage.src === data.image_url && mapImage.complete) {
            //         // console.log("Image already loaded from URL");
            //     } else {
            //         const newImage = new Image();
            //         newImage.onload = () => {
            //             console.log("Map image loaded from URL");
            //             mapImage = newImage;
            //             requestRender();
            //         };
            //         newImage.onerror = (err) => {
            //             console.error("Failed to load map image from URL:", err);
            //         };
            //         newImage.src = data.image_url;
            //     }
            // }
        } else {
            // console.log("Map became invisible");
            canvas.style.display = "none";
        }
        
        requestRender();
        updatePortraits(); // Обновляем портреты при изменении видимости
    }
});

socket.on("force_map_update", (data) => {
    
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

    
    if (data.map_id === mapId) {
        const newImage = new Image();
        newImage.onload = () => {
            mapImage = newImage;
            
            if (mapData) {
                mapData.has_image = true;
            }
            
            requestRender();
        };
        newImage.src = data.image_url;
    }
});

window.addEventListener('load', () => {
    if (mapId) {
        setTimeout(() => {
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

        fetchMap();
    }
});

// Функция для отладки портретов
window.debugPortraits = function() {
    if (!mapData || !portraitSidebar) {
        console.log('No map data or sidebar');
        return;
    }
    
    const visibleChars = mapData.characters.filter(c => c.visible_to_players !== false);
    console.log('=== DEBUG PORTRAITS ===');
    console.log('Count:', visibleChars.length);
    
    // Получаем все стили сайдбара
    const sidebarStyles = window.getComputedStyle(portraitSidebar);
    console.log('Sidebar dimensions:', {
        height: portraitSidebar.clientHeight,
        width: portraitSidebar.clientWidth,
        paddingLeft: sidebarStyles.paddingLeft,
        paddingRight: sidebarStyles.paddingRight,
        paddingTop: sidebarStyles.paddingTop,
        paddingBottom: sidebarStyles.paddingBottom
    });
    
    // Принудительно перерендерим с логами
    console.log('Forcing re-render...');
    renderPortraits(visibleChars);
    
    // Покажем информацию о сетке после рендера
    setTimeout(() => {
        const grid = document.querySelector('.portrait-grid');
        if (grid) {
            const gridStyle = window.getComputedStyle(grid);
            console.log('Grid styles:', {
                gap: gridStyle.gap,
                columnGap: gridStyle.columnGap,
                rowGap: gridStyle.rowGap,
                gridTemplateColumns: gridStyle.gridTemplateColumns
            });
            
            // Проверяем первый портрет
            const firstItem = grid.querySelector('.portrait-item');
            if (firstItem) {
                const itemStyle = window.getComputedStyle(firstItem);
                console.log('Portrait item styles:', {
                    margin: itemStyle.margin,
                    padding: itemStyle.padding
                });
                
                const avatarContainer = firstItem.querySelector('div');
                if (avatarContainer) {
                    console.log('Avatar container size:', avatarContainer.style.width);
                    console.log('Avatar container margin:', window.getComputedStyle(avatarContainer).margin);
                }
            }
            
            // Считаем реальную ширину колонок
            const gridWidth = grid.clientWidth;
            const computedGap = parseInt(gridStyle.columnGap) || 0;
            const columns = gridStyle.gridTemplateColumns.split(' ').length;
            console.log('Grid actual width:', gridWidth);
            console.log('Computed gap:', computedGap);
            console.log('Number of columns:', columns);
            
            // Теоретическая ширина колонки
            const theoreticalColumnWidth = (gridWidth - (computedGap * (columns - 1))) / columns;
            console.log('Theoretical column width:', theoreticalColumnWidth);
        }
    }, 100);
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

// И используйте её в renderPortraits:
// Замените строку с расчетом availableWidth на:
const availableWidth = getAvailableWidth();