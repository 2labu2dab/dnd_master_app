// static/js/map.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const sidebar = document.getElementById("sidebar");
const rightSidebar = document.getElementById("right-sidebar");
const playerRulerToggle = document.getElementById("playerRulerToggle");
const rulerToggle = document.getElementById("rulerToggle");
canvas.width = window.innerWidth - sidebar.offsetWidth - rightSidebar.offsetWidth;
canvas.height = window.innerHeight;
let mapsList = [];
let editingMapId = null;
let masterPingInterval = null;
let currentMapImageFile = null;
let allTokensFromMaps = [];
let selectedImportToken = null;
let isSwitchingMap = false;
let selectedCharacterId = null;
let spawnPosition = null;
let isClick = true; // Флаг для определения клика vs перетаскивания
let clickTimer = null; // Таймер для определения задержки
let allBankCharacters = [];

let selectedTokens = new Set(); // Множество ID выбранных токенов
let isDraggingMultiple = false; // Флаг перетаскивания нескольких токенов
let multiDragOffsets = new Map(); // Смещения для каждого токена при групповом перетаскивании
let multiDragStartPositions = new Map(); // Начальные позиции для группового перетаскивания
const playerChannel = new BroadcastChannel('dnd_map_channel');
let zoomLevel = 1;
const socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});
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

socket.on('reconnect', (attemptNumber) => {
    console.log('Socket reconnected after', attemptNumber, 'attempts');
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
let isRulerMode = false;
let rulerStart = null;
let lastMouseX = 0;
let lastMouseY = 0;
let editingFindId = null;
let editingZoneId = null;
let pendingZoneVertices = null;
let hoveredSnapVertex = null;
const avatarCache = new Map();

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

    // Аватар с защитой от ошибок
    const img = document.createElement('img');
    if (character.has_avatar) {
        // Защита от undefined portrait_url
        const portraitUrl = character.portrait_url || `/api/portrait/${character.id}`;
        img.src = `${portraitUrl}?t=${Date.now()}`;
    } else {
        // Плейсхолдер для персонажей без аватара
        img.style.display = 'none';
    }

    img.style.width = '32px';
    img.style.height = '32px';
    img.style.borderRadius = '4px';
    img.style.objectFit = 'cover';
    img.draggable = false;

    img.onerror = () => {
        img.style.display = 'none';
        // Добавляем иконку-заглушку
        const placeholder = document.createElement('span');
        placeholder.textContent = '👤';
        placeholder.style.fontSize = '24px';
        placeholder.style.lineHeight = '32px';
        placeholder.style.textAlign = 'center';
        placeholder.style.width = '32px';
        placeholder.style.height = '32px';
        placeholder.style.backgroundColor = '#3a4a6b';
        placeholder.style.borderRadius = '4px';
        li.insertBefore(placeholder, img);
        img.remove();
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
            selectedTokens.clear();
            refreshPortraits();
            render();
        }
    };

    li.appendChild(img);
    li.appendChild(nameSpan);
    li.appendChild(eye);

    return li;
}

function saveCurrentMapToStorage(mapId) {
    if (mapId) {
        localStorage.setItem('dnd_last_map_id', mapId);
        console.log('Saved map ID to storage:', mapId);
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

    // Проверяем статус мастера
    socket.emit('check_master_status');
});

socket.on('master_status', (data) => {
    console.log('Master status:', data);

    if (!data.is_current) {
        // Мы потеряли статус мастера
        clearInterval(masterPingInterval);

        if (!data.active) {
            // Мастер не активен - можем попробовать перезахватить
            if (confirm('Соединение с мастером потеряно. Перезагрузить страницу?')) {
                window.location.reload();
            }
        } else {
            // Другой мастер активен
            alert('Другой мастер управляет картой. Вы будете перенаправлены.');
            window.location.href = '/master-locked';
        }
    }
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

    // Здесь можно обновить интерфейс если нужно
});

function syncGridInputs(value) {
    const num = parseInt(value);
    if (isNaN(num) || num < 10 || num > 200) return;

    document.getElementById("gridSlider").value = num;
    document.getElementById("gridInput").value = num;
    mapData.grid_settings.cell_size = num;
    render();

    updateSliderVisual();

    fetch("/api/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mapData),
    });
}
let editingTokenId = null;
let avatarChanged = false;
function submitToken() {
    console.log("submitToken called");

    const name = document.getElementById("tokenName").value;
    const avatarPreview = document.getElementById("avatarPreview");
    const avatarData = avatarPreview.dataset.base64 || null;

    console.log("Avatar data present:", !!avatarData);

    const ac = parseInt(document.getElementById("tokenAC").value);
    const hp = parseInt(document.getElementById("tokenHP").value);
    const type = document.querySelector(".type-btn.active")?.dataset.type;

    if (!name || !type) return alert("Заполните все поля");

    const addToBank = document.getElementById("addToBankCheckbox").checked;

    if (editingTokenId) {
        // Редактирование существующего токена
        editExistingToken(name, ac, hp, type, avatarData, addToBank);
    } else {
        // Создание нового токена
        createNewToken(name, ac, hp, type, avatarData, addToBank);
    }

    editingTokenId = null;
    avatarChanged = false;
}

function editExistingToken(name, ac, hp, type, avatarData, addToBank) {
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

    if (avatarChangedNow) {
        token.has_avatar = true;
        token.avatar_data = avatarData;
        console.log("Avatar changed for token:", editingTokenId);

        // Очищаем кэш аватара при изменении
        if (avatarCache.has(editingTokenId)) {
            avatarCache.delete(editingTokenId);
            console.log("Avatar cache cleared for token:", editingTokenId);
        }

        // Обновляем avatar_url с новым timestamp
        token.avatar_url = `/api/token/avatar/${editingTokenId}?t=${Date.now()}`;
    } else {
        token.has_avatar = oldHasAvatar;
        token.avatar_url = oldAvatar;
    }

    // Проверяем, нужно ли добавить в портреты
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
        has_avatar: token.has_avatar
    };

    if (avatarChangedNow) {
        requestBody.avatar_data = avatarData;
    }

    fetch(`/api/token/${editingTokenId}`, {
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

            syncTokenAcrossMaps(token);

            // Обновляем в банке если нужно
            if (addToBank) {
                // ... существующий код для банка ...
            }

            // Теперь обрабатываем добавление в портреты
            if (addToCharacters) {
                // ... существующий код для портретов ...
            }

            closeTokenModal();

            // Обновляем только те данные, которые нужны
            render();
            updateSidebar();

            socket.emit("force_avatar_reload", {
                map_id: currentMapId
            });
        })
        .catch(error => {
            console.error('Error updating token:', error);
            alert('Ошибка при обновлении токена');
        });
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

function createNewToken(name, ac, hp, type, avatarData, addToBank) {
    const centerX = mapImage.width ? mapImage.width / 2 : 500;
    const centerY = mapImage.height ? mapImage.height / 2 : 500;

    const tokenId = `token_${Date.now()}`;

    // Создаем URL для аватара сразу
    const avatarUrl = avatarData ? `/api/token/avatar/${tokenId}?t=${Date.now()}` : null;

    const token = {
        id: tokenId,
        name,
        position: [centerX, centerY],
        size: mapData.grid_settings.cell_size,
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
        avatar_data: avatarData
    };

    // Добавляем в банк если нужно
    if (addToBank) {
        const bankCharData = {
            id: tokenId,
            name: name,
            type: type,
            armor_class: ac,
            max_health: hp,
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
                return createCharacterFromToken(name, avatarData, characterId)
                    .then(() => {
                        return fetchMap();
                    });
            }
        })
        .then(() => {
            closeTokenModal();
        })
        .catch(error => {
            console.error('Error:', error);
            alert('Ошибка при создании токена: ' + error.message);
        });
}
function createCharacterFromToken(name, avatarData, characterId) {
    console.log("Creating character from token with ID:", characterId);

    if (!mapData.characters) mapData.characters = [];

    const character = {
        id: characterId,
        name,
        has_avatar: true,
        visible_to_players: false,
    };

    mapData.characters.push(character);

    // Сохраняем данные карты с новым персонажем
    return saveMapData()
        .then(() => {
            // Затем загружаем портрет на сервер отдельным запросом
            const formData = new FormData();
            const blob = dataURLtoBlob(avatarData);
            formData.append("portrait", blob, `${characterId}.png`);
            formData.append("character_id", characterId);

            return fetch("/api/portrait/upload", {
                method: "POST",
                body: formData
            });
        })
        .then(response => {
            if (!response.ok) {
                throw new Error("Failed to upload portrait: " + response.status);
            }
            return response.json();
        })
        .then(data => {
            console.log("Portrait created from token successfully:", data);

            // Обновляем URL портрета в данных персонажа
            const character = mapData.characters.find(c => c.id === characterId);
            if (character && data.portrait_url) {
                character.portrait_url = data.portrait_url;
            }

            // Обновляем сайдбар и список портретов
            updateSidebar();
            refreshPortraits(); // Добавьте эту строку
        })
        .catch(error => {
            console.error("Error creating character from token:", error);
            // Не прерываем выполнение, просто логируем ошибку
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

// Обновляем существующую updateSidebar для добавления data-атрибутов
// static/js/map.js - Исправленная функция updateSidebar()

function updateSidebar() {
    // Зоны
    const zoneList = document.getElementById("zoneList");
    zoneList.innerHTML = "";

    mapData.zones.forEach(zone => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";

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
        li.style.marginBottom = "4px";
        li.style.cursor = "pointer";
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

    mapData.tokens.forEach(token => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";
        li.style.gap = "8px";

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
        li.style.color = "#ccc";
        li.style.cursor = "pointer";
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
        eye.title = "Видимость для игроков";
        eye.onclick = (e) => {
            e.stopPropagation();
            token.is_visible = !token.is_visible;
            saveMapData();
            updateSidebar();
            render();
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

    mapData.finds.forEach(find => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";

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
        li.style.marginBottom = "4px";
        li.style.cursor = "pointer";
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
    initCharacterDragAndDrop();
    // Настраиваем контекстные меню
    setupSidebarContextMenus();
}


let currentMapId = null;

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

    // СОХРАНЯЕМ ID В STORAGE
    saveCurrentMapToStorage(mapId);
    updateActiveMapInList(mapId);

    avatarCache.clear();

    // Очищаем кэш аватаров
    for (let key in avatarCache) {
        delete avatarCache[key];
    }

    if (isSwitchingMap) {
        console.log("Already switching map, ignoring");
        return;
    }

    if (currentMapId === mapId) {
        console.log("Already on this map, ignoring");
        return;
    }

    isSwitchingMap = true;

    if (!mapId) {
        currentMapId = null;
        mapData = {
            tokens: [],
            finds: [],
            zones: [],
            characters: [],
            grid_settings: { cell_size: 20, color: "#888888", visible: false, visible_to_players: true }
        };
        render();
        updateSidebar();
        socket.emit("switch_map", { map_id: null });
        isSwitchingMap = false;
        return;
    }

    fetch(`/api/map/${mapId}`)
        .then(res => {
            if (!res.ok) {
                throw new Error(`HTTP error! status: ${res.status}`);
            }
            return res.json();
        })
        .then(data => {
            if (data.error) {
                console.error(data.error);
                isSwitchingMap = false;
                return;
            }

            mapData = data;
            currentMapId = mapId;

            // Убеждаемся, что grid_settings.visible_to_players определен
            if (mapData.grid_settings && mapData.grid_settings.visible_to_players === undefined) {
                mapData.grid_settings.visible_to_players = true;
            }

            // ВАЖНО: сначала устанавливаем сохранённые значения
            zoomLevel = mapData.zoom_level || 1;
            panX = mapData.pan_x || 0;
            panY = mapData.pan_y || 0;

            console.log(`Restored position: zoom=${zoomLevel}, pan=(${panX}, ${panY})`);

            updateSidebar();

            const gridSize = mapData.grid_settings.cell_size || 20;
            document.getElementById("gridSlider").value = gridSize;
            document.getElementById("gridInput").value = gridSize;

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

            // Загружаем изображение карты
            if (mapData.has_image) {
                // Добавляем timestamp для сброса кэша
                const timestamp = Date.now();
                const imageUrl = `/api/map/image/${mapId}?t=${timestamp}`;

                mapImage = new Image();
                mapImage.onload = () => {
                    console.log("Map image loaded, rendering with restored position");
                    render();

                    // Дополнительная проверка: если после загрузки позиция сбросилась
                    if (panX !== mapData.pan_x || panY !== mapData.pan_y) {
                        console.log("Position was reset, restoring...");
                        panX = mapData.pan_x || 0;
                        panY = mapData.pan_y || 0;
                        zoomLevel = mapData.zoom_level || 1;
                        render();
                    }
                };
                mapImage.onerror = () => {
                    console.error("Failed to load map image");
                    render();
                };
                mapImage.src = imageUrl;
            } else {
                // ВАЖНО: сбрасываем изображение, если у карты нет картинки
                mapImage = new Image(); // пустое изображение
                render();
            }

            const playerFrame = document.getElementById('playerMini');
            if (playerFrame) {
                playerFrame.src = `/player?map_id=${mapId}`;
            }

            socket.emit("switch_map", { map_id: mapId });

            setTimeout(() => {
                isSwitchingMap = false;
            }, 500);
        })
        .catch(err => {
            console.error("Error switching map:", err);
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
            select.innerHTML = '';
            data.maps.forEach(map => {
                const option = document.createElement('option');
                option.value = map.id;
                option.textContent = map.name;
                if (map.id === data.map_id) option.selected = true;
                select.appendChild(option);
            });

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
                select.innerHTML = '';

                if (data.maps.length > 0) {
                    data.maps.forEach(map => {
                        const option = document.createElement('option');
                        option.value = map.id;
                        option.textContent = map.name;
                        if (map.id === data.maps[0].id) option.selected = true;
                        select.appendChild(option);
                    });

                    // СОХРАНЯЕМ ID ПЕРВОЙ КАРТЫ
                    saveCurrentMapToStorage(data.maps[0].id);

                    switchMap(data.maps[0].id);
                } else {
                    // Нет карт
                    select.innerHTML = '<option value="">Нет карт</option>';

                    // ОЧИЩАЕМ STORAGE
                    localStorage.removeItem('dnd_last_map_id');

                    switchMap(null);
                }
            }
        });
}

function saveMapData() {
    // Явно добавляем map_id в сохраняемые данные
    const dataToSave = {
        ...mapData,
        map_id: currentMapId  // ВАЖНО: передаем ID текущей карты
    };

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
        console.log("No current map ID");
        return Promise.reject("No map ID");
    }

    console.log("Fetching map data for ID:", currentMapId);
    avatarCache.clear();

    for (let key in avatarCache) {
        delete avatarCache[key];
    }

    return fetch(`/api/map/${currentMapId}?ts=${Date.now()}`)
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
            const currentOption = select.querySelector(`option[value="${currentMapId}"]`);

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

            const gridSize = mapData.grid_settings.cell_size || 20;
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

            // Загружаем изображение карты только если оно изменилось
            if (mapData.has_image) {
                const timestamp = Date.now();
                const imageUrl = `/api/map/image/${currentMapId}?t=${timestamp}`;

                if (!mapImage.src || !mapImage.src.includes(currentMapId) || oldHasImage !== mapData.has_image) {
                    console.log("Loading map image from:", imageUrl);
                    mapImage = new Image();
                    mapImage.onload = () => {
                        console.log("Map image loaded successfully");
                        render();
                        socket.emit("notify_image_loaded", {
                            map_id: currentMapId,
                            image_url: imageUrl
                        });
                    };
                    mapImage.onerror = (err) => {
                        console.error("Failed to load map image:", err);
                        render();
                    };
                    mapImage.src = imageUrl;
                } else {
                    render();
                }
            } else {
                console.log("Map has no image");
                mapImage = new Image();
                render();
            }

            if (currentOption && data.name) {
                currentOption.textContent = data.name;
            }

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
        return;
    }

    if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) {
        ctx.font = "20px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Загрузите изображение карты", canvas.width / 2, canvas.height / 2);
        return;
    }

    const { scale, offsetX, offsetY } = getTransform();
    const newWidth = mapImage.width * scale;
    const newHeight = mapImage.height * scale;

    if (mapImage && mapImage.complete && mapImage.naturalWidth > 0) {
        ctx.drawImage(mapImage, offsetX, offsetY, newWidth, newHeight);
    }

    drawLayers(offsetX, offsetY, scale);

    if (drawingZone && currentZoneVertices.length > 0) {
        drawTempZone(offsetX, offsetY, scale);
    }

    if (isRulerMode && rulerStart) {
        drawRuler(offsetX, offsetY, scale);
    }

    // Рисуем рамку выделения, если активна
}
function drawTempZone(offsetX, offsetY, scale) {
    if (currentZoneVertices.length === 0) return;

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
    mapData.zones.forEach(z => drawZone(z, offsetX, offsetY, scale));
    mapData.tokens.forEach(t => drawToken(t, offsetX, offsetY, scale));
    mapData.finds.forEach(f => drawFind(f, offsetX, offsetY, scale));
}

function drawGrid(offsetX, offsetY, scale) {
    const cell = mapData.grid_settings.cell_size;
    ctx.strokeStyle = mapData.grid_settings.color;
    ctx.lineWidth = 1;

    // Рисуем сетку в координатах карты (world‑space),
    // чтобы она была «приклеена» к картинке и не съезжала при зуме.

    // Вертикальные линии
    for (let x = 0; x <= mapImage.width; x += cell) {
        const sx = offsetX + x * scale; // экранная координата
        if (sx < 0 || sx > canvas.width) continue;

        ctx.beginPath();
        ctx.moveTo(sx, Math.max(0, offsetY));
        ctx.lineTo(sx, Math.min(canvas.height, offsetY + mapImage.height * scale));
        ctx.stroke();
    }

    // Горизонтальные линии
    for (let y = 0; y <= mapImage.height; y += cell) {
        const sy = offsetY + y * scale;
        if (sy < 0 || sy > canvas.height) continue;

        ctx.beginPath();
        ctx.moveTo(Math.max(0, offsetX), sy);
        ctx.lineTo(Math.min(canvas.width, offsetX + mapImage.width * scale), sy);
        ctx.stroke();
    }
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
    const size = mapData.grid_settings.cell_size * scale;
    const radius = size / 2;

    // Проверяем, находится ли токен под скрытой зоной
    const isUnderHiddenZone = isPointInHiddenZone(token.position, mapData.zones);
    // Проверяем, скрыт ли токен вручную мастером
    const isManuallyHidden = token.is_visible === false;

    ctx.save();

    // Если токен под скрытой зоной ИЛИ скрыт вручную, делаем его полупрозрачным
    if (isUnderHiddenZone || isManuallyHidden) {
        ctx.globalAlpha = 0.4;
    }

    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, 2 * Math.PI);

    const avatarSrc = token.avatar_url || token.avatar_data;

    if (avatarSrc) {
        let cachedImg = avatarCache.get(token.id);

        if (cachedImg === 'loading') {
            ctx.fillStyle = token.is_dead
                ? "#616161"
                : token.is_player
                    ? "#4CAF50"
                    : token.is_npc
                        ? "#FFC107"
                        : "#F44336";
            ctx.fill();
        }
        else if (cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0) {
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
        else {
            if (!avatarCache.has(token.id) || avatarCache.get(token.id) === null) {
                avatarCache.set(token.id, 'loading');

                const img = new Image();
                img.onload = () => {
                    console.log(`Avatar loaded for token ${token.id}`);
                    avatarCache.set(token.id, img);
                    render();
                };
                img.onerror = () => {
                    console.warn(`Failed to load avatar for token ${token.name}, using placeholder`);
                    avatarCache.set(token.id, null);
                    render();
                };
                img.src = avatarSrc.includes('?') ? avatarSrc : `${avatarSrc}?t=${Date.now()}`;
            }

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

    // Единый стиль выделения для всех выбранных токенов (сплошная линия)
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

    // Иконки УБРАНЫ - оставляем только прозрачность
}

function reloadTokenAvatar(tokenId) {
    if (!tokenId) return;

    // Удаляем из кэша
    if (avatarCache.has(tokenId)) {
        avatarCache.delete(tokenId);
    }

    // Находим токен
    const token = mapData.tokens.find(t => t.id === tokenId);
    if (token && token.avatar_url) {
        // Добавляем timestamp для сброса кэша
        const newUrl = token.avatar_url.includes('?')
            ? token.avatar_url.split('?')[0] + '?t=' + Date.now()
            : token.avatar_url + '?t=' + Date.now();

        token.avatar_url = newUrl;

        // Загружаем заново
        const img = new Image();
        img.onload = () => {
            avatarCache.set(tokenId, img);
            render();
        };
        img.onerror = () => {
            avatarCache.set(tokenId, null);
            render();
        };
        img.src = newUrl;
    }
}

// Вызывайте эту функцию после загрузки аватара на сервер
function onAvatarUploaded(tokenId) {
    reloadTokenAvatar(tokenId);

    // Также отправляем событие всем игрокам
    socket.emit("token_avatar_updated", {
        map_id: currentMapId,
        token_id: tokenId,
        avatar_url: `/api/token/avatar/${tokenId}?t=${Date.now()}`
    });
}

function openCharacterModal() {
    document.getElementById("characterModal").style.display = "flex";
    document.getElementById("characterName").value = "";
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
    const file = event.target.files[0];
    if (!file) return;

    // Проверяем размер файла
    if (file.size > 10 * 1024 * 1024) {
        alert("Файл слишком большой. Максимальный размер 10MB.");
        return;
    }

    // Открываем кроппер для выбора области
    openCropModal(file, 'character');
}

function openEditCharacterModal(character) {
    document.getElementById("characterModal").style.display = "flex";
    document.getElementById("characterModalTitle").textContent = "Редактирование портрета";
    document.getElementById("characterName").value = character.name;

    const preview = document.getElementById("characterAvatarPreview");
    const overlay = document.getElementById("characterAvatarOverlay");
    const mask = document.getElementById("characterAvatarMask");
    const editIcon = document.getElementById("characterEditIcon");

    // Загружаем существующий аватар
    if (character.has_avatar) {
        const portraitUrl = character.portrait_url || `/api/portrait/${character.id}?t=${Date.now()}`;
        preview.src = portraitUrl;
        preview.style.display = "block";
        preview.dataset.portraitId = character.id; // Сохраняем ID для обновления

        overlay.style.display = "none";
        mask.style.display = "block";
        editIcon.style.display = "block";
    } else {
        preview.src = "";
        preview.style.display = "none";
        preview.removeAttribute("data-base64");
        preview.removeAttribute("data-portrait-id");

        overlay.style.display = "block";
        mask.style.display = "none";
        editIcon.style.display = "none";
    }

    // Сохраняем ID редактируемого портрета
    window.editingCharacterId = character.id;
}

function submitCharacter() {
    const name = document.getElementById("characterName").value.trim();
    const avatarPreview = document.getElementById("characterAvatarPreview");
    const avatarData = avatarPreview.dataset.base64 || null;
    const editingId = window.editingCharacterId;

    if (!name) {
        alert("Введите имя персонажа.");
        return;
    }

    if (editingId) {
        // Редактирование существующего портрета
        editCharacter(editingId, name, avatarData);
    } else {
        // Создание нового портрета
        if (!avatarData) {
            alert("Выберите изображение для портрета.");
            return;
        }
        createNewCharacter(name, avatarData); // avatarData передается правильно
    }
}

function createNewCharacter(name, avatarData) {
    console.log("createNewCharacter called with:", { name, hasAvatar: !!avatarData });

    const characterId = `char_${Date.now()}`;

    const character = {
        id: characterId,
        name,
        has_avatar: true,
        visible_to_players: false,
    };

    if (!mapData.characters) mapData.characters = [];
    mapData.characters.push(character);

    // Сохраняем данные карты
    saveMapData()
        .then(() => {
            console.log("Map data saved, uploading portrait...");

            // Загружаем портрет
            const formData = new FormData();
            const blob = dataURLtoBlob(avatarData);
            formData.append("portrait", blob, `${characterId}.png`);
            formData.append("character_id", characterId);

            return fetch("/api/portrait/upload", {
                method: "POST",
                body: formData
            });
        })
        .then(response => {
            if (!response.ok) throw new Error("Failed to upload portrait");
            return response.json();
        })
        .then(data => {
            console.log("Portrait uploaded successfully:", data);

            const character = mapData.characters.find(c => c.id === characterId);
            if (character && data.portrait_url) {
                character.portrait_url = data.portrait_url;
            }

            window.editingCharacterId = null;
            closeCharacterModal();

            // Обновляем интерфейс
            updateSidebar();
            refreshPortraits();
            initCharacterDragAndDrop();

            // Уведомляем игроков
            socket.emit("characters_updated", {
                map_id: currentMapId,
                characters: mapData.characters
            });
        })
        .catch(error => {
            console.error("Error creating character:", error);
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

            // Очищаем кэш если есть
            const imgElements = document.querySelectorAll(`img[src*="/api/portrait/${characterId}"]`);
            imgElements.forEach(img => {
                img.src = `${data.portrait_url}?t=${Date.now()}`;
            });

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
    drawingZone = true;
    currentZoneVertices = [];
    updateCanvasCursor(); // Добавьте эту строку

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
    render();

    fetch("/api/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mapData),
    });
}

function handleAvatarUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Проверяем размер файла
    if (file.size > 10 * 1024 * 1024) {
        alert("Файл слишком большой. Максимальный размер 10MB.");
        return;
    }

    // Открываем кроппер для выбора области
    openCropModal(file, 'token');
}

function closeTokenModal() {
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

    editingTokenId = null;
}
canvas.addEventListener("mousedown", (e) => {
    const [mouseX, mouseY] = [e.offsetX, e.offsetY];
    const { scale, offsetX, offsetY } = getTransform();
    const isShiftPressed = e.shiftKey;

    // Сбрасываем флаг клика
    isClick = true;

    // Устанавливаем таймер для определения перетаскивания
    if (clickTimer) {
        clearTimeout(clickTimer);
    }
    clickTimer = setTimeout(() => {
        isClick = false; // Если прошло больше 200ms - это перетаскивание
    }, 200);

    if (isRulerMode) {
        const x = (mouseX - offsetX) / scale;
        const y = (mouseY - offsetY) / scale;
        rulerStart = [x, y];
        render();
        return;
    }

    if (drawingZone) {
        if (e.button === 0) {
            let x = (mouseX - offsetX) / scale;
            let y = (mouseY - offsetY) / scale;

            if (hoveredSnapVertex) {
                [x, y] = hoveredSnapVertex;
            }

            x = Math.max(0, Math.min(x, mapImage.width));
            y = Math.max(0, Math.min(y, mapImage.height));

            currentZoneVertices.push([x, y]);
            render();
        }
        return;
    }

    // Проверяем клик по токену
    let clickedToken = null;
    for (const token of mapData.tokens) {
        const [x, y] = token.position;
        const sx = x * scale + offsetX;
        const sy = y * scale + offsetY;
        const radius = (mapData.grid_settings.cell_size * scale) / 2;

        if (Math.hypot(mouseX - sx, mouseY - sy) <= radius) {
            clickedToken = token;
            break;
        }
    }

    // Логика выделения и перетаскивания
    selectedTokenId = null;
    selectedFindId = null;
    selectedZoneId = null;
    draggingToken = null;
    draggingFind = null;
    isDraggingMultiple = false;

    let clicked = false;

    // Обработка клика по токену
    if (clickedToken) {
        if (isShiftPressed) {
            // Shift + клик - переключаем выделение токена (мультивыделение)
            if (selectedTokens.has(clickedToken.id)) {
                selectedTokens.delete(clickedToken.id);
            } else {
                selectedTokens.add(clickedToken.id);
            }

            // Обновляем selectedTokenId для отображения в сайдбаре
            if (selectedTokens.size > 0) {
                selectedTokenId = clickedToken.id; // Показываем последний кликнутый
            } else {
                selectedTokenId = null;
            }
        } else {
            // Обычный клик без Shift - пока просто запоминаем, что кликнули
            // Окончательная обработка будет в обработчике click
        }

        clicked = true;

        // ВАЖНО: Всегда начинаем перетаскивание при клике на токен (независимо от Shift)
        draggingToken = clickedToken;
        const [tx, ty] = clickedToken.position;
        const tokenSx = tx * scale + offsetX;
        const tokenSy = ty * scale + offsetY;
        dragOffset = [(mouseX - tokenSx) / scale, (mouseY - tokenSy) / scale];

        // Если выделено несколько токенов (независимо от того, как они были выделены),
        // начинаем групповое перетаскивание
        if (selectedTokens.size > 1) {
            isDraggingMultiple = true;

            // Сохраняем смещения для всех выделенных токенов
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

        // Обновляем сайдбар
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
        let found = null;
        const snapRadius = 10 / scale;

        for (const zone of mapData.zones) {
            for (const [vx, vy] of zone.vertices) {
                const dist = Math.hypot(x - vx, y - vy);
                if (dist < snapRadius) {
                    found = [vx, vy];
                    break;
                }
            }
            if (found) break;
        }

        hoveredSnapVertex = found;
        render();
        return;
    }

    updateCanvasCursor();

    // Перемещение карты средней кнопкой мыши
    if (isPanning) {
        panX = panStartPanX + (e.clientX - panStartMouseX);
        panY = panStartPanY + (e.clientY - panStartMouseY);
        render();

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

    if (isRulerMode && rulerStart) {
        const rulerEnd = [
            (e.offsetX - offsetX) / scale,
            (e.offsetY - offsetY) / scale
        ];

        mapData.ruler_start = rulerStart;
        mapData.ruler_end = rulerEnd;

        render();

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

        render();
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
        render();
        return;
    }

    // Ховер для находок
    let hovered = null;
    for (const find of mapData.finds) {
        const [x, y] = find.position;
        const sx = x * scale + offsetX;
        const sy = y * scale + offsetY;
        const radius = (mapData.grid_settings.cell_size * scale) / 2;

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
        }

        saveMapData();
        render();
        updateSidebar();
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

            saveMapData();
            render();
            updateSidebar();
            menu.style.display = "none";
        };
    }

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = "block";
}

canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
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

    // Проверяем клик по токену
    for (const token of mapData.tokens) {
        const [x, y] = token.position;
        const sx = x * scale + offsetX;
        const sy = y * scale + offsetY;
        const radius = (mapData.grid_settings.cell_size * scale) / 2;

        if (Math.hypot(e.offsetX - sx, e.offsetY - sy) <= radius) {
            e.preventDefault();
            selectedTokenId = token.id;
            showTokenContextMenu(token, e.pageX, e.pageY);
            return;
        }
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

        fetch("/api/map", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(mapData),
        });
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
});

let zoomSyncTimeout;

canvas.addEventListener("click", (e) => {
    const { scale, offsetX, offsetY } = getTransform();
    const isShiftPressed = e.shiftKey;

    // Проверяем, был ли это именно клик, а не перетаскивание
    if (!isClick) return;

    // Проверяем клик по токену
    let clickedToken = null;
    for (const token of mapData.tokens) {
        const [x, y] = token.position;
        const sx = x * scale + offsetX;
        const sy = y * scale + offsetY;
        const radius = (mapData.grid_settings.cell_size * scale) / 2;

        if (Math.hypot(e.offsetX - sx, e.offsetY - sy) <= radius) {
            clickedToken = token;
            break;
        }
    }

    if (clickedToken && !isShiftPressed) {
        // Обычный клик без Shift - сбрасываем множественное выделение и выделяем этот токен
        selectedTokens.clear();
        selectedTokens.add(clickedToken.id);
        selectedTokenId = clickedToken.id;

        // Снимаем выделение с других объектов
        selectedZoneId = null;
        selectedFindId = null;
        selectedCharacterId = null;

        updateSidebar();
        render();
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

    render();

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
        e.preventDefault(); // Предотвращаем стандартное поведение браузера

        // Проверяем, открыто ли какое-либо модальное окно
        const anyModalOpen = [
            'characterModal',
            'tokenModal',
            'findModal',
            'zoneModal',
            'mapModal',
            'importTokenModal',
            'bankModal',
            'newMapModal',
            'bankModal',
            'bankCharacterModal'
        ].some(modalId => {
            const modal = document.getElementById(modalId);
            return modal && modal.style.display === 'flex';
        });

        if (anyModalOpen) {
            // Если открыто модальное окно - закрываем все модалки
            closeAllModals();
        } else {
            // Если модалки закрыты, обрабатываем другие режимы

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

            // Снимаем выделение с токенов
            if (selectedTokens.size > 0) {
                selectedTokens.clear();
                updateSidebar();
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

    if (e.key === "Delete") {
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
                // Отправляем запрос на удаление токена
                fetch(`/api/token/${tokenId}`, {
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

            // Отправляем запрос на удаление токена
            fetch(`/api/token/${selectedTokenId}`, {
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
            saveMapData().then(() => {
                socket.emit("force_avatar_reload", { map_id: currentMapId });
            });
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
            status: false
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
    // Загружаем список карт для новой панели
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

    function updateMiniToggleIcon() {
        toggleBtn.innerHTML = mapData.player_map_enabled !== false ? getOpenEyeSVG() : getClosedEyeSVG();
    }

    toggleBtn.addEventListener("click", () => {
        const enabled = mapData.player_map_enabled !== false;
        mapData.player_map_enabled = !enabled;

        updateMiniToggleIcon();

        // Сохраняем на сервере
        saveMapData();

        // Отправляем через сокет
        socket.emit("player_visibility_change", {
            map_id: currentMapId,
            player_map_enabled: mapData.player_map_enabled
        });

        playerChannel.postMessage({
            type: 'reload_player',
            map_id: currentMapId,
            enabled: mapData.player_map_enabled
        });
    });

    socket.on("player_visibility_change", (data) => {
        if (data.map_id === currentMapId) {
            mapData.player_map_enabled = data.player_map_enabled;
            updateMiniToggleIcon();
        }
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
        isRulerMode = !isRulerMode;

        if (!isRulerMode) {
            mapData.ruler_start = null;
            mapData.ruler_end = null;

            socket.emit("ruler_update", {
                ruler_start: null,
                ruler_end: null
            });

            saveMapData();
        } else {
            rulerStart = null;
        }

        rulerBtn.classList.toggle("active", isRulerMode);
        render();
    });

    const gridToggle = document.getElementById("gridToggle");
    gridToggle.addEventListener("click", () => {
        gridToggle.classList.toggle("active");
        mapData.grid_settings.visible = gridToggle.classList.contains("active");
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

        if (!tokenMenu?.contains(e.target) &&
            !findMenu?.contains(e.target) &&
            !zoneMenu?.contains(e.target) &&
            !characterMenu?.contains(e.target) &&
            !mapMenu?.contains(e.target)) {

            if (tokenMenu) tokenMenu.style.display = "none";
            if (findMenu) findMenu.style.display = "none";
            if (zoneMenu) zoneMenu.style.display = "none";
            if (characterMenu) characterMenu.style.display = "none";
            if (mapMenu) mapMenu.style.display = "none";
        }
    });

    updateSliderVisual();
    initSidebarCollapse();
};
socket.on("map_created", (data) => {
    console.log("Map created event received:", data);

    // СОХРАНЯЕМ ID НОВОЙ КАРТЫ
    saveCurrentMapToStorage(data.current_map);

    // Обновляем селект карт
    const select = document.getElementById('mapSelect');
    select.innerHTML = '';

    data.maps.forEach(map => {
        const option = document.createElement('option');
        option.value = map.id;
        option.textContent = map.name;
        if (map.id === data.current_map) option.selected = true;
        select.appendChild(option);
    });

    // Устанавливаем currentMapId
    currentMapId = data.current_map;

    // Загружаем данные карты (токены уже будут там, созданные на сервере)
    fetchMap();

    // Обновляем iframe игрока
    const playerFrame = document.getElementById('playerMini');
    if (playerFrame) {
        playerFrame.src = `/player?map_id=${data.current_map}`;
    }
});
socket.on("map_image_updated", (data) => {

    if (data.map_id === currentMapId) {
        // Обновляем изображение карты
        if (data.map_image_base64) {
            mapImage = new Image();
            mapImage.onload = () => {
                render();
            };
            mapImage.src = data.map_image_base64;

            // Обновляем mapData
            mapData.has_image = true;
        }
    }
});

socket.on("request_image_reload", (data) => {
    if (data.map_id === currentMapId) {
        // Перезагружаем изображение
        const imageUrl = `/api/map/image/${currentMapId}?t=${Date.now()}`;
        mapImage = new Image();
        mapImage.onload = () => {
            render();
        };
        mapImage.src = imageUrl;
    }
});

function updateCanvasCursor() {
    canvas.classList.remove('zone-drawing-mode', 'ruler-mode', 'token-dragging', 'map-panning', 'multi-dragging');

    if (drawingZone) {
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
            currentContextToken.health_points = Math.min(maxHp, currentHp + heal);
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
        // Отправляем запрос на удаление токена
        fetch(`/api/token/${currentContextToken.id}`, {
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
        selectedTokenId = null;

        saveMapData();
        render();
        updateSidebar();
        document.getElementById("tokenContextMenu").style.display = "none";
    }
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

    // Загружаем текущий аватар токена с принудительным сбросом кэша
    loadTokenAvatarInModal(token, true); // Передаем true для принудительной перезагрузки
}

function clearAvatarCacheForToken(tokenId) {
    if (avatarCache.has(tokenId)) {
        avatarCache.delete(tokenId);
        console.log(`Avatar cache cleared for token ${tokenId}`);
    }

    // Также очищаем кэш браузера для этого URL
    const img = new Image();
    img.src = `/api/token/avatar/${tokenId}?t=${Date.now()}&cache=false`;
}

function loadTokenAvatarInModal(token, forceReload = false) {
    const preview = document.getElementById("avatarPreview");
    const overlay = document.getElementById("avatarOverlay");
    const mask = document.getElementById("avatarMask");
    const editIcon = document.getElementById("editIcon");

    // Сначала сбрасываем preview
    preview.src = "";
    preview.style.display = "none";
    preview.removeAttribute("data-base64");

    // Отменяем предыдущие загрузки
    if (preview._abortController) {
        preview._abortController.abort();
    }

    if (token.has_avatar) {
        // Показываем состояние загрузки
        overlay.style.display = "none";
        mask.style.display = "block";
        editIcon.style.display = "block";

        // Показываем временный серый фон
        preview.style.display = "block";
        preview.style.opacity = "0.5";

        // Создаем AbortController для отмены загрузки при необходимости
        const abortController = new AbortController();
        preview._abortController = abortController;

        // Генерируем URL с уникальным timestamp для сброса кэша
        const timestamp = Date.now();
        // ВАЖНО: используем базовый URL аватара без параметров
        const baseAvatarUrl = token.avatar_url
            ? token.avatar_url.split('?')[0]
            : `/api/token/avatar/${token.id}`;

        const avatarUrl = baseAvatarUrl + '?t=' + timestamp;

        console.log("Loading avatar from:", avatarUrl);

        // Создаем новый Image для загрузки
        const img = new Image();
        img.crossOrigin = "anonymous"; // Добавляем для CORS

        img.onload = () => {
            console.log("Avatar loaded successfully in modal");

            // Устанавливаем src в preview
            preview.src = avatarUrl;
            preview.style.opacity = "1";

            // Конвертируем в base64 для сохранения при редактировании
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                preview.dataset.base64 = canvas.toDataURL('image/png');
                console.log("Avatar converted to base64 for saving");
            } catch (e) {
                console.warn("Could not convert avatar to base64:", e);
            }

            // Обновляем кэш
            avatarCache.set(token.id, img);
        };

        img.onerror = (err) => {
            console.error("Failed to load avatar in modal:", err);

            // Показываем заглушку
            preview.style.display = "none";
            preview.style.opacity = "1";
            preview.removeAttribute("data-base64");

            overlay.style.display = "block";
            mask.style.display = "none";
            editIcon.style.display = "none";

            // Пытаемся загрузить с сервера напрямую
            fetchAvatarFromServer(token.id);
        };

        img.src = avatarUrl;

        // Если принудительная перезагрузка, добавляем обработчик для обновления кэша браузера
        if (forceReload) {
            // Добавляем заголовки для предотвращения кэширования
            fetch(avatarUrl, {
                method: 'HEAD',
                cache: 'no-store',
                headers: {
                    'Pragma': 'no-cache',
                    'Cache-Control': 'no-cache'
                }
            }).catch(() => { });
        }

    } else {
        // Если у токена нет аватара, показываем заглушку
        overlay.style.display = "block";
        mask.style.display = "none";
        editIcon.style.display = "none";

        preview.style.display = "none";
        preview.src = "";
        preview.removeAttribute("data-base64");
    }
}

function fetchAvatarFromServer(tokenId) {
    console.log("Fetching avatar from server for token:", tokenId);

    const preview = document.getElementById("avatarPreview");
    const overlay = document.getElementById("avatarOverlay");
    const mask = document.getElementById("avatarMask");
    const editIcon = document.getElementById("editIcon");

    fetch(`/api/token/avatar/${tokenId}?t=${Date.now()}`)
        .then(response => {
            if (!response.ok) {
                throw new Error('Avatar not found');
            }
            return response.blob();
        })
        .then(blob => {
            const reader = new FileReader();
            reader.onload = (e) => {
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
        img.src = `/api/token/avatar/${tokenId}?t=${Date.now()}`;
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


    // Отправляем на сервер вместе с avatar_data если есть
    const requestBody = {
        ...newToken,
        avatar_data: copiedToken.avatar_data || null
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
            // Обновляем URL из ответа
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

    // Проверяем границы карты
    newX = Math.max(0, Math.min(newX, mapImage.width));
    newY = Math.max(0, Math.min(newY, mapImage.height));

    const newTokenId = `token_${Date.now()}`;

    // Если у исходного токена есть аватар, нужно его скопировать
    let avatarDataToSend = null;

    if (sourceToken.has_avatar && sourceToken.avatar_url) {
        // Пытаемся получить изображение из кэша
        const cachedImg = avatarCache.get(sourceToken.id);
        if (cachedImg && cachedImg instanceof HTMLImageElement && cachedImg.complete) {
            // Конвертируем изображение в base64
            const canvas = document.createElement('canvas');
            canvas.width = cachedImg.width;
            canvas.height = cachedImg.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(cachedImg, 0, 0);
            avatarDataToSend = canvas.toDataURL('image/png');
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
        avatar_url: sourceToken.avatar_url, // Временный URL
        is_visible: sourceToken.is_visible // ДОБАВЬТЕ ЭТУ СТРОКУ
    };

    // Отправляем на сервер вместе с данными аватара если есть
    const requestBody = {
        ...newToken,
        avatar_data: avatarDataToSend // Отправляем base64 если есть
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
            // Обновляем URL аватара из ответа сервера
            if (data.avatar_url) {
                newToken.avatar_url = data.avatar_url;
            }

            mapData.tokens.push(newToken);

            // Если есть аватар в кэше, копируем его в кэш для нового токена
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
    // Если перетаскивается элемент из characterList
    if (e.target.closest('#characterList')) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.dropEffect = 'move';
    }
});

document.addEventListener('dragover', (e) => {
    // Если мы в области портретов или над зонами вставки
    if (e.target.closest('#characterList') || e.target.classList.contains('drop-zone')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }
});

document.addEventListener('dragenter', (e) => {
    if (e.target.closest('#characterList') || e.target.classList.contains('drop-zone')) {
        e.preventDefault();
    }
});

document.addEventListener('dragleave', (e) => {
    if (e.target.closest('#characterList') || e.target.classList.contains('drop-zone')) {
        e.preventDefault();
    }
});

document.addEventListener('drop', (e) => {
    if (e.target.closest('#characterList') || e.target.classList.contains('drop-zone')) {
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

    // Убеждаемся, что используем правильный URL для аватара
    const avatarUrl = character.avatar_url || '/static/default-avatar.png';
    console.log(`Bank character ${character.name} avatar URL:`, avatarUrl);

    div.innerHTML = `
        <img class="bank-character-avatar" src="${avatarUrl}" 
             onerror="this.src='/static/default-avatar.png'; console.error('Failed to load avatar for ${character.name}')">
        <div class="bank-character-info" onclick="spawnBankCharacter(${JSON.stringify(character).replace(/"/g, '&quot;')})">
            <div class="bank-character-name">${character.name}</div>
            <div class="bank-character-type">${typeText}</div>
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
    if (!spawnPosition) return;

    fetch(`/api/bank/character/${character.id}/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            map_id: currentMapId,
            position: spawnPosition
        })
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'ok') {
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

function closeImportTokenModal() {
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
        const createToken = (avatarData = null) => {
            const requestBody = {
                ...targetToken,
                avatar_data: avatarData
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
                    closeImportTokenModal();

                    // Показываем уведомление с учётом состояния
                    const statusText = targetToken.is_dead ? " (мёртв)" : "";
                    showNotification(`Токен "${sourceToken.name}"${statusText} импортирован`, 'success');
                })
                .catch(error => {
                    console.error('Error importing token:', error);
                    showNotification('Ошибка при импорте токена', 'error');
                });
        };

        // Если у исходного токена есть аватар, пытаемся его скопировать
        if (sourceToken.has_avatar && sourceToken.id) {
            showNotification('Копирование аватара...', 'info');

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

            setTimeout(() => {
                resizeCanvas();
                render();
            }, 300);
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

            setTimeout(() => {
                resizeCanvas();
                render();
            }, 300);
        };
    }
}
function resizeCanvas() {
    const leftSidebar = document.getElementById('sidebar');
    const rightSidebar = document.getElementById('right-sidebar');
    const canvas = document.getElementById('mapCanvas');

    if (!canvas || !leftSidebar || !rightSidebar) return;

    console.log('Resizing canvas:', {
        leftWidth: leftSidebar.offsetWidth,
        rightWidth: rightSidebar.offsetWidth,
        windowWidth: window.innerWidth
    });

    canvas.width = window.innerWidth - leftSidebar.offsetWidth - rightSidebar.offsetWidth;
    canvas.height = window.innerHeight;

    // Центрируем карту после изменения размера
    if (mapImage && mapImage.complete && mapImage.naturalWidth > 0) {
        centerMap();
    }
}
window.addEventListener('resize', function () {
    resizeCanvas();
    render();
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        setTimeout(initSidebarCollapse, 200);
    });
} else {
    setTimeout(initSidebarCollapse, 200);
}

function loadMapsList() {
    fetch("/api/maps")
        .then(res => res.json())
        .then(maps => {
            mapsList = maps;
            renderMapsList(maps);
        });
}

// Функция отрисовки списка карт
function renderMapsList(maps) {
    const container = document.getElementById("mapsList");
    if (!container) return;

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

    container.innerHTML = maps.map(map => {
        const isActive = map.id === currentMapId;
        // Обрезаем длинное название до 8 символов + троеточие
        const displayName = map.name.length > 8 ? map.name.substring(0, 8) + '…' : map.name;

        return `
            <div class="map-card ${isActive ? 'active' : ''}" data-map-id="${map.id}" onclick="selectMap('${map.id}')">
                <div class="map-thumbnail">
                    ${map.has_image
                ? `<img src="/api/map/thumbnail/${map.id}?t=${Date.now()}" alt="${map.name}" loading="lazy">`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <rect x="2" y="2" width="20" height="20" rx="2" ry="2"/>
                            <circle cx="8.5" cy="8.5" r="1.5"/>
                            <polyline points="21 15 16 10 5 21"/>
                          </svg>`
            }
                </div>
                <div class="map-name" title="${map.name}">${displayName}</div>
                <button class="map-more-btn" onclick="event.stopPropagation(); showMapContextMenu('${map.id}', event)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="2"/>
                        <circle cx="12" cy="5" r="2"/>
                        <circle cx="12" cy="19" r="2"/>
                    </svg>
                </button>
            </div>
        `;
    }).join('');

    // Обновляем активное состояние
    updateActiveMapInList(currentMapId);
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
        preview.src = `/api/map/image/${mapId}?t=${Date.now()}`;
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
    document.getElementById("mapModal").style.display = "none";
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

    // Если это создание новой карты (без редактирования)
    if (!editingMapId) {
        // Сначала создаем карту с именем
        fetch("/api/map/new", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name })
        })
            .then(res => {
                if (!res.ok) {
                    throw new Error('Network response was not ok: ' + res.status);
                }
                return res.json();
            })
            .then(data => {
                // Если есть изображение для загрузки, загружаем его отдельно
                if (currentMapImageFile) {
                    const formData = new FormData();
                    formData.append("map_image", currentMapImageFile);

                    return fetch("/upload_map", {
                        method: "POST",
                        body: formData
                    }).then(() => data);
                }
                return data;
            })
            .then(data => {
                closeMapModal();
                loadMapsList();

                if (data.map_id) {
                    switchMap(data.map_id);
                }

                showNotification("Карта создана", "success");
            })
            .catch(err => {
                console.error("Error saving map:", err);
                showNotification("Ошибка при создании карты: " + err.message, "error");
            });
    } else {
        // Редактирование существующей карты
        const formData = new FormData();
        formData.append("name", name);
        if (currentMapImageFile) {
            formData.append("map_image", currentMapImageFile);
        }

        fetch(`/api/map/update/${editingMapId}`, {
            method: "POST",
            body: formData
        })
            .then(res => {
                if (!res.ok) {
                    throw new Error('Network response was not ok: ' + res.status);
                }
                return res.json();
            })
            .then(data => {
                closeMapModal();
                loadMapsList();

                if (data.map_id === currentMapId) {
                    // ОЧИЩАЕМ КЭШ И ПЕРЕЗАГРУЖАЕМ ТЕКУЩУЮ КАРТУ
                    // Удаляем старую ссылку на изображение
                    if (mapImage) {
                        // Создаем новый объект Image
                        mapImage = new Image();
                        mapImage.crossOrigin = "Anonymous"; // Добавляем для работы с кэшем
                    }

                    // Перезагружаем карту с новым параметром timestamp
                    const timestamp = Date.now();
                    const imageUrl = `/api/map/image/${currentMapId}?t=${timestamp}`;

                    mapImage.onload = () => {
                        console.log("New map image loaded after edit");
                        render();

                        // Сохраняем позицию
                        mapData.zoom_level = zoomLevel;
                        mapData.pan_x = panX;
                        mapData.pan_y = panY;

                        // Отправляем всем игрокам принудительную перезагрузку
                        socket.emit("notify_image_loaded", {
                            map_id: currentMapId,
                            image_url: imageUrl
                        });
                    };

                    mapImage.src = imageUrl;

                    // Обновляем has_image в mapData
                    mapData.has_image = true;
                }

                showNotification("Карта обновлена", "success");
            })
            .catch(err => {
                console.error("Error updating map:", err);
                showNotification("Ошибка при обновлении карты", "error");
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
    window.currentMapId = mapId;

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
        'bankModal',
        'newMapModal',
        'bankCharacterModal'  // ДОБАВЛЕНО
    ];

    modals.forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal && modal.style.display === 'flex') {
            modal.style.display = 'none';
        }
    });

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
        is_visible: token.is_visible
    };

    // Добавляем avatar_url если есть
    if (token.avatar_url) {
        syncData.avatar_url = token.avatar_url.split('?')[0]; // Без timestamp
    }

    console.log("Sending sync data:", syncData);

    // Отправляем на сервер для синхронизации
    fetch(`/api/token/${token.id}/sync`, {
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
    const token = mapData.tokens.find(t => t.id === token_id);
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
    const editingId = window.editingBankCharacterId;

    if (!name) {
        alert("Введите имя персонажа");
        return;
    }

    if (!type) {
        alert("Выберите тип персонажа");
        return;
    }

    // Получаем аватар, если есть
    const avatarPreview = document.getElementById("bankAvatarPreview");
    const avatarData = avatarPreview?.dataset.base64 || null;

    console.log("Character data:", { name, ac, hp, type, hasAvatar: !!avatarData, editingId });

    // Создаем объект персонажа
    const characterData = {
        name: name,
        type: type,
        armor_class: ac,
        max_health: hp,
        has_avatar: !!avatarData
    };

    // Добавляем аватар, если есть
    const requestBody = {
        ...characterData,
        avatar_data: avatarData
    };

    // Определяем URL и метод в зависимости от того, редактирование это или создание
    const url = editingId ? `/api/bank/character/${editingId}` : "/api/bank/character";
    const method = editingId ? "PUT" : "POST";

    // Отправляем на сервер
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

            // Очищаем ID редактируемого
            window.editingBankCharacterId = null;

            // Закрываем модальное окно
            closeBankCharacterModal();

            // Показываем уведомление
            const action = editingId ? "обновлен" : "добавлен";
            showNotification(`Персонаж "${name}" ${action} в банк`, 'success');
        })
        .catch(error => {
            console.error("Error saving bank character:", error);
            showNotification("Ошибка при сохранении персонажа", 'error');
        });
}

function openEditBankCharacterModal(character) {
    console.log("Opening edit bank character modal for:", character);

    // Закрываем банк и открываем окно редактирования персонажа
    document.getElementById("bankModal").style.display = "none";
    document.getElementById("bankCharacterModal").style.display = "flex";

    // Меняем заголовок
    const modalTitle = document.querySelector("#bankCharacterModal h3");
    if (modalTitle) {
        modalTitle.textContent = "Редактирование персонажа в банке";
    }

    // Заполняем форму данными персонажа
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

    // Загружаем аватар если есть
    const preview = document.getElementById("bankAvatarPreview");
    const overlay = document.getElementById("bankAvatarOverlay");
    const editIcon = document.getElementById("bankEditIcon");

    if (character.has_avatar && character.avatar_url) {
        preview.src = `${character.avatar_url}?t=${Date.now()}`;
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

    // Сохраняем ID редактируемого персонажа
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

    // Получаем обрезанное изображение в максимальном качестве
    const canvas = cropper.getCroppedCanvas({
        width: 256,
        height: 256,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high'
    });

    // Конвертируем в base64
    const croppedBase64 = canvas.toDataURL('image/png');

    // В зависимости от цели, обновляем соответствующий превью
    switch (currentCropTarget) {
        case 'token':
            const tokenPreview = document.getElementById("avatarPreview");
            tokenPreview.src = croppedBase64;
            tokenPreview.style.display = "block";
            tokenPreview.dataset.base64 = croppedBase64;

            document.getElementById("avatarOverlay").style.display = "none";
            document.getElementById("avatarMask").style.display = "block";
            document.getElementById("editIcon").style.display = "block";
            break;

        case 'character':
            const charPreview = document.getElementById("characterAvatarPreview");
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