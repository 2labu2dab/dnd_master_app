// static/js/map.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const sidebar = document.getElementById("sidebar");
const rightSidebar = document.getElementById("right-sidebar");
canvas.width = window.innerWidth - sidebar.offsetWidth - rightSidebar.offsetWidth;
canvas.height = window.innerHeight;
let isSwitchingMap = false;
let selectedCharacterId = null;
const playerChannel = new BroadcastChannel('dnd_map_channel');
let zoomLevel = 1;
const socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});
socket.on('connect', () => {
    console.log('Socket connected with ID:', socket.id);
});
socket.on('disconnect', () => {
    console.log('Socket disconnected');
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
const avatarCache = {};

let socketId = null;


socket.on('connect', () => {
    socketId = socket.id;
    console.log('Connected with ID:', socketId);
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

  if (editingTokenId) {
    // Редактирование существующего токена (код остается без изменений)
    editExistingToken(name, ac, hp, type, avatarData);
  } else {
    // Создание нового токена
    createNewToken(name, ac, hp, type, avatarData);
  }
  
  editingTokenId = null;
  avatarChanged = false;
}

function editExistingToken(name, ac, hp, type, avatarData) {
  const token = mapData.tokens.find(t => t.id === editingTokenId);
  if (!token) return;

  // Сохраняем старые значения
  const oldAvatar = token.avatar_url;
  const oldAvatarData = token.avatar_data;
  const oldHasAvatar = token.has_avatar;
  
  // Определяем, изменился ли аватар
  const avatarChangedNow = avatarData && avatarData !== oldAvatarData;
  
  // Обновляем данные токена
  token.name = name;
  token.armor_class = ac;
  token.max_health_points = hp;
  if (token.health_points > hp) {
    token.health_points = hp;
  }
  token.is_player = type === "player";
  token.is_npc = type === "npc";
  
  // Если аватар изменился, обновляем его
  if (avatarChangedNow) {
    token.has_avatar = true;
    token.avatar_data = avatarData;
    console.log("Avatar changed for token:", editingTokenId);
  } else {
    // Если аватар не изменился, сохраняем старый
    token.has_avatar = oldHasAvatar;
    token.avatar_url = oldAvatar;
  }
  
  console.log("Updating token:", token);
  
  // Подготавливаем данные для отправки
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
  
  // Добавляем avatar_data только если он изменился
  if (avatarChangedNow) {
    requestBody.avatar_data = avatarData;
  }
  
  // Отправляем запрос на обновление
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
    closeTokenModal();

    // Если аватар изменился, очищаем кэш
    if (avatarChangedNow && avatarCache[editingTokenId]) {
      delete avatarCache[editingTokenId];
    }
    
    // Обновляем данные карты
    if (avatarChangedNow) {
      // Если аватар изменился, перезагружаем полные данные
      fetchMap();
      
      // Также отправляем специальное событие для принудительной перезагрузки аватаров у игроков
      socket.emit("force_avatar_reload", { 
        map_id: currentMapId 
      });
    } else {
      // Иначе просто рендерим
      render();
      updateSidebar();
    }
  })
  .catch(error => {
    console.error('Error updating token:', error);
    alert('Ошибка при обновлении токена');
  });
}

function createNewToken(name, ac, hp, type, avatarData) {
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
    avatar_url: avatarUrl, // Добавляем URL сразу
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

  console.log("Creating token with data:", requestBody);

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
    
    // Если сервер вернул avatar_url, используем его
    if (data.avatar_url) {
      token.avatar_url = data.avatar_url;
    }
    
    // Добавляем токен в локальные данные
    if (!mapData.tokens) mapData.tokens = [];
    mapData.tokens.push(token);
    
    // Если есть аватар, сразу создаем и кэшируем изображение
    if (avatarData && token.avatar_url) {
      const img = new Image();
      img.onload = () => {
        avatarCache[tokenId] = img;
        render(); // Перерендериваем после загрузки
      };
      img.onerror = () => {
        console.warn(`Failed to load avatar for new token ${tokenId}`);
      };
      img.src = token.avatar_url;
    }
    
    // Сразу рендерим с новым токеном
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
    visible_to_players: true,
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
      
      // Обновляем сайдбар
      updateSidebar();
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
            <button class="context-menu-item delete" id="contextDeleteCharacter">
                <span class="context-icon">🗑️</span> Удалить
            </button>
        </div>
    `;
    
    document.body.appendChild(menu);
    
    // Добавляем обработчики
    document.getElementById("contextCharacterVisible").addEventListener("change", function(e) {
        if (window.currentContextCharacter) {
            window.currentContextCharacter.visible_to_players = e.target.checked;
            updateSidebar();
            saveMapData();
        }
    });
    
    document.getElementById("contextDeleteCharacter").addEventListener("click", function() {
        if (window.currentContextCharacter && confirm(`Удалить портрет "${window.currentContextCharacter.name}"?`)) {
            // Удаляем портрет
            fetch(`/api/portrait/${window.currentContextCharacter.id}`, {
                method: 'DELETE'
            }).catch(err => console.error('Error deleting portrait:', err));
            
            mapData.characters = mapData.characters.filter(c => c.id !== window.currentContextCharacter.id);
            selectedCharacterId = null;
            saveMapData();
            render();
            updateSidebar();
            document.getElementById("characterContextMenu").style.display = "none";
        }
    });
    
    return menu;
}

// Обновляем существующую updateSidebar для добавления data-атрибутов
function updateSidebar() {
    // Существующий код для зон...
    const zoneList = document.getElementById("zoneList");
    zoneList.innerHTML = "";

    mapData.zones.forEach(zone => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";
        li.style.background = "#2a2a3b";
        li.style.padding = "6px 10px";
        li.style.borderRadius = "4px";
        li.style.marginBottom = "4px";
        li.dataset.zoneId = zone.id; // Добавляем data-атрибут

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
        eye.onclick = () => {
            zone.is_visible = !zone.is_visible;
            saveMapData();
            updateSidebar();
            render();
        };

        li.appendChild(nameSpan);
        li.appendChild(eye);
        zoneList.appendChild(li);
    });

    // Существующий код для токенов...
    const tokenList = document.getElementById("tokenList");
    tokenList.innerHTML = "";

    mapData.tokens.forEach(token => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";
        li.style.gap = "8px";
        li.style.background = "#2a2a3b";
        li.style.padding = "6px 10px";
        li.style.borderRadius = "4px";
        li.style.color = "#ccc";
        li.dataset.tokenId = token.id; // Добавляем data-атрибут

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

        li.appendChild(dot);
        li.appendChild(nameSpan);
        li.appendChild(acSpan);
        li.appendChild(hpSpan);
        li.appendChild(eye);
        tokenList.appendChild(li);
    });

    // Существующий код для находок...
    const findList = document.getElementById("findList");
    findList.innerHTML = "";

    mapData.finds.forEach(find => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.justifyContent = "space-between";
        li.style.background = "#2a2a3b";
        li.style.padding = "6px 10px";
        li.style.borderRadius = "4px";
        li.style.marginBottom = "4px";
        li.dataset.findId = find.id; // Добавляем data-атрибут

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

        li.appendChild(nameSpan);
        li.appendChild(statusSpan);
        findList.appendChild(li);
    });

    // Существующий код для портретов...
    const characterList = document.getElementById("characterList");
    characterList.innerHTML = "";

    mapData.characters?.forEach(character => {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.alignItems = "center";
        li.style.gap = "8px";
        li.style.background = "#2a2a3b";
        li.style.padding = "6px 10px";
        li.style.borderRadius = "4px";
        li.style.marginBottom = "4px";
        li.style.color = "#ccc";
        li.style.cursor = "pointer";
        li.dataset.characterId = character.id;

        // Если этот портрет выделен, меняем фон
        if (selectedCharacterId === character.id) {
            li.style.background = "#3a4a6b";
            li.style.borderLeft = "4px solid #4C5BEF";
        }

        // аватар
        const img = document.createElement("img");
        if (character.has_avatar) {
            const portraitUrl = character.portrait_url || `/api/portrait/${character.id}`;
            img.src = `${portraitUrl}?t=${Date.now()}`;
        }
        img.style.width = "32px";
        img.style.height = "32px";
        img.style.borderRadius = "4px";
        img.style.objectFit = "cover";
        
        img.onerror = () => {
            img.style.display = "none";
        };

        // имя
        const nameSpan = document.createElement("span");
        nameSpan.textContent = character.name;
        nameSpan.style.flex = "1";
        nameSpan.style.overflow = "hidden";
        nameSpan.style.textOverflow = "ellipsis";
        nameSpan.style.whiteSpace = "nowrap";
        nameSpan.style.color = "#ddd";

        // кнопка-глаз
        const eye = document.createElement("span");
        eye.innerHTML = character.visible_to_players !== false ? getOpenEyeSVG() : getClosedEyeSVG();
        eye.style.cursor = "pointer";
        eye.style.marginRight = "8px";
        eye.title = "Видимость для игроков";

        eye.onclick = (e) => {
            e.stopPropagation();
            character.visible_to_players = !character.visible_to_players;
            updateSidebar();
            saveMapData();
        };

        // Клик на сам элемент портрета - выделение
        li.onclick = (e) => {
            e.stopPropagation();
            selectedCharacterId = character.id;
            updateSidebar();
        };

        li.appendChild(img);
        li.appendChild(nameSpan);
        li.appendChild(eye);
        characterList.appendChild(li);
    });
    
    // После обновления всех списков, настраиваем контекстные меню
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
                    canvas.width/2, canvas.height/2);
        return false;
    }
    return true;
}
function switchMap(mapId) {
    console.log("switchMap called with:", mapId);
    
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
            grid_settings: { cell_size: 20, color: "#888888", visible: false }
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
                const imageUrl = `/api/map/image/${mapId}?t=${Date.now()}`;
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
                switchMap(data.maps[0].id);
            } else {
                // Нет карт
                select.innerHTML = '<option value="">Нет карт</option>';
                switchMap(null);
            }
        }
    });
}

function saveMapData() {
  return fetch("/api/map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mapData),
  }).then(response => {
    if (!response.ok) {
      throw new Error('Failed to save map data');
    }
    // Обновляем имя в селекте если изменилось
    const select = document.getElementById('mapSelect');
    const currentOption = select.querySelector(`option[value="${currentMapId}"]`);
    if (currentOption && mapData.name) {
      currentOption.textContent = mapData.name;
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
    if (!currentMapId) return;
    
    fetch(`/api/map/${currentMapId}?ts=${Date.now()}`)
        .then(res => res.json())
        .then(data => {
            const oldHasImage = mapData?.has_image;
            const oldImageSrc = mapImage?.src;
            
            // Сохраняем текущую позицию перед обновлением
            const currentZoom = zoomLevel;
            const currentPanX = panX;
            const currentPanY = panY;
            
            mapData = data;
            
            // ВАЖНО: НЕ перезаписываем позицию из данных, если она уже есть
            // Используем сохранённые текущие значения
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
            
            updateSidebar();

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

            // Загружаем изображение карты только если оно изменилось
            if (mapData.has_image) {
                const imageUrl = `/api/map/image/${currentMapId}?t=${Date.now()}`;
                
                if (!mapImage.src || !mapImage.src.includes(currentMapId) || oldHasImage !== mapData.has_image) {
                    mapImage = new Image();
                    mapImage.onload = () => {
                        render();
                        socket.emit("notify_image_loaded", {
                            map_id: currentMapId,
                            image_url: imageUrl
                        });
                    };
                    mapImage.src = imageUrl;
                } else {
                    render();
                }
            } else {
                mapImage = new Image();
                render();
            }
        });
}
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!currentMapId) {
        ctx.font = "24px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Нет активной карты. Создайте новую или загрузите изображение", 
                    canvas.width/2, canvas.height/2);
        return;
    }

  if (!mapImage || !mapImage.complete || mapImage.naturalWidth === 0) {
        // Карта есть, но без изображения
        ctx.font = "20px Inter";
        ctx.fillStyle = "#666";
        ctx.textAlign = "center";
        ctx.fillText("Загрузите изображение карты", canvas.width/2, canvas.height/2);
        return;
    }

  const { scale, offsetX, offsetY } = getTransform();
  const newWidth = mapImage.width * scale;
  const newHeight = mapImage.height * scale;

  // Всегда рисуем изображение, если оно загружено
  if (mapImage && mapImage.complete && mapImage.naturalWidth > 0) {
    ctx.drawImage(mapImage, offsetX, offsetY, newWidth, newHeight);
  }

  drawLayers(offsetX, offsetY, scale);

  if (drawingZone && currentZoneVertices.length > 0) {
    drawTempZone(offsetX, offsetY, scale);
  }

  if (isRulerMode && rulerStart) {
    const [x1, y1] = rulerStart;
    const { scale, offsetX, offsetY } = getTransform();

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

    // Координаты линейки в системе карты
    const dxWorld = (sx2 - sx1) / scale;
    const dyWorld = (sy2 - sy1) / scale;
    const cell = mapData.grid_settings.cell_size || 20;

    const dxCells = Math.abs(dxWorld) / cell;
    const dyCells = Math.abs(dyWorld) / cell;

    // Как в Civilization: минимальное число ходов по квадратам
    // (диагональ и ортогональ стоят одинаково — считаем max по осям)
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

    ctx.strokeStyle = "#c82a2aff";
    ctx.lineWidth = 2;
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
    ctx.stroke();
  }
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

function drawToken(token, offsetX, offsetY, scale) {
  const [x, y] = token.position;
  const sx = x * scale + offsetX;
  const sy = y * scale + offsetY;
  const size = mapData.grid_settings.cell_size * scale;
  const radius = size / 2;

  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, 2 * Math.PI);
  
  // Используем avatar_url если есть
  const avatarSrc = token.avatar_url || token.avatar_data;
  
  if (avatarSrc) {
    // Проверяем, есть ли изображение в кэше
    if (!avatarCache[token.id]) {
      // Если нет, создаем новое и загружаем
      const img = new Image();
      img.onload = () => {
        avatarCache[token.id] = img;
        render(); // Перерендериваем после загрузки
      };
      img.onerror = () => {
        console.warn(`⚠ Не удалось загрузить аватар токена ${token.name} по URL: ${avatarSrc}`);
        avatarCache[token.id] = null;
      };
      img.src = avatarSrc;
      avatarCache[token.id] = 'loading'; // Временно помечаем как загружающийся
      
      // Пока загружается, рисуем цветной круг
      ctx.fillStyle = token.is_dead
        ? "#616161"
        : token.is_player
          ? "#4CAF50"
          : token.is_npc
            ? "#FFC107"
            : "#F44336";
      ctx.fill();
    } else if (avatarCache[token.id] instanceof HTMLImageElement && 
               avatarCache[token.id].complete && 
               avatarCache[token.id].naturalWidth > 0) {
      // Изображение уже загружено, рисуем его
      ctx.save();
      ctx.clip();

      if (token.is_dead) {
        ctx.globalAlpha = 0.7;
        ctx.filter = 'grayscale(100%)';
        ctx.drawImage(avatarCache[token.id], sx - radius, sy - radius, size, size);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(avatarCache[token.id], sx - radius, sy - radius, size, size);
      }

      ctx.restore();
    } else {
      // Изображение еще загружается или ошибка, рисуем цветной круг
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
    // Нет аватара, рисуем цветной круг
    ctx.fillStyle = token.is_dead
      ? "#616161"
      : token.is_player
        ? "#4CAF50"
        : token.is_npc
          ? "#FFC107"
          : "#F44336";
    ctx.fill();
  }

  // Обводка
  ctx.strokeStyle = token.is_dead
    ? "#999"
    : token.is_player
      ? "#4CAF50"
      : token.is_npc
        ? "#FFC107"
        : "#F44336";
  ctx.lineWidth = 4;
  ctx.stroke();

  if (selectedTokenId === token.id) {
    ctx.beginPath();
    ctx.arc(sx, sy, radius + 3, 0, Math.PI * 2);
    ctx.strokeStyle = "#00FFFF";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
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
}

function handleCharacterAvatarUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement("canvas");
      const size = 256;
      canvas.width = size;
      canvas.height = size;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, size, size); // ⬅️ без clip()

      const base64 = canvas.toDataURL("image/png");

      const preview = document.getElementById("characterAvatarPreview");
      preview.src = base64;
      preview.style.display = "block";
      preview.dataset.base64 = base64;

      document.getElementById("characterAvatarOverlay").style.display = "none";
      document.getElementById("characterAvatarMask").style.display = "none";
      document.getElementById("characterEditIcon").style.display = "block";
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}


function submitCharacter() {
  const name = document.getElementById("characterName").value.trim();
  const avatarPreview = document.getElementById("characterAvatarPreview");
  const avatarData = avatarPreview.dataset.base64 || "";

  if (!name || !avatarData) {
    alert("Заполните имя и выберите аватар.");
    return;
  }

  const characterId = `char_${Date.now()}`;
  
  // Создаем объект персонажа
  const character = {
    id: characterId,
    name,
    has_avatar: true,
    visible_to_players: true,
    // Не храним avatar_data в основном объекте
  };

  // Добавляем персонажа в данные
  if (!mapData.characters) mapData.characters = [];
  mapData.characters.push(character);
  
  // Сохраняем данные карты сначала
  saveMapData()
    .then(() => {
      // Затем загружаем портрет на сервер отдельным запросом
      const formData = new FormData();
      // Конвертируем base64 в blob
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
        throw new Error("Failed to upload portrait");
      }
      return response.json();
    })
    .then(data => {
      console.log("Portrait uploaded successfully:", data);
      closeCharacterModal();
      updateSidebar();
      
      // Обновляем URL портрета в данных персонажа
      const character = mapData.characters.find(c => c.id === characterId);
      if (character && data.portrait_url) {
        character.portrait_url = data.portrait_url;
      }
      
      // Перезагружаем данные карты для получения URL портрета
      fetchMap();
    })
    .catch(error => {
      console.error("Error saving character:", error);
      alert("Ошибка при сохранении персонажа: " + error.message);
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
}

function drawZone(zone, offsetX, offsetY, scale) {
  if (!zone.vertices || zone.vertices.length < 2) return;

  ctx.beginPath();

  ctx.strokeStyle = zone.is_visible ? "#4CAF50" : "#F44336";
  ctx.fillStyle = zone.is_visible ? "rgba(76, 175, 80, 0.3)" : "rgba(244, 67, 54, 0.3)";

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

  // Проверяем размер файла (макс 2MB)
  if (file.size > 10 * 1024 * 1024) {
    alert("Файл слишком большой. Максимальный размер 2MB.");
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    const preview = document.getElementById('avatarPreview');
    preview.src = e.target.result;
    preview.style.display = 'block';
    
    // Сохраняем новые данные аватара
    preview.dataset.base64 = e.target.result;

    document.getElementById('avatarOverlay').style.display = 'none';
    document.getElementById('avatarMask').style.display = 'block';
    document.getElementById('editIcon').style.display = 'block';
    
    // Если это редактирование, помечаем что аватар изменился
    if (editingTokenId) {
      console.log("Avatar changed for token:", editingTokenId);
    }
  };
  reader.readAsDataURL(file);
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
  
  // Показываем чекбокс обратно
  document.getElementById("addToCharactersCheckbox").parentElement.style.display = "flex";
  document.getElementById("addToCharactersCheckbox").checked = false;
  
  editingTokenId = null;
}

canvas.addEventListener("mousedown", (e) => {
  const [mouseX, mouseY] = [e.offsetX, e.offsetY];
  const { scale, offsetX, offsetY } = getTransform();

  if (isRulerMode) {
    const x = (mouseX - offsetX) / scale;
    const y = (mouseY - offsetY) / scale;
    rulerStart = [x, y];
    render();
    return;
  }

  if (drawingZone) {
          if (e.button === 0) { // Левая кнопка мыши
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
          return; // Важно: добавляем return чтобы не продолжалась обработка
      }

  selectedTokenId = null;
  selectedFindId = null;
  selectedZoneId = null;
  draggingToken = null;
  draggingFind = null;

  let clicked = false;

  for (const token of mapData.tokens) {
    const [x, y] = token.position;
    const sx = x * scale + offsetX;
    const sy = y * scale + offsetY;
    const radius = (mapData.grid_settings.cell_size * scale) / 2;

    if (Math.hypot(mouseX - sx, mouseY - sy) <= radius) {
      draggingToken = token;
      dragOffset = [(mouseX - sx) / scale, (mouseY - sy) / scale];
      selectedTokenId = token.id;
      clicked = true;
      break;
    }
  }

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
        clicked = true;
        break;
      }
    }
  }

  if (!clicked) {
    for (const zone of mapData.zones) {
      if (!zone.vertices || zone.vertices.length < 3) continue;
      const transformed = zone.vertices.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);
      if (pointInPolygon([mouseX, mouseY], transformed)) {
        selectedZoneId = zone.id;
        clicked = true;
        break;
      }
    }
  }

  // Средняя кнопка мыши — панорамирование карты (как в доте),
  // только если кликнули не по объекту
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
      const { scale, offsetX, offsetY } = getTransform();

      const rulerEnd = [
          (e.offsetX - offsetX) / scale,
          (e.offsetY - offsetY) / scale
      ];
      
      // Обновляем данные для рендера
      mapData.ruler_start = rulerStart;
      mapData.ruler_end = rulerEnd;

      render();

      // Используем setTimeout для throttle отправки
      if (!window.rulerThrottle) {
          window.rulerThrottle = setTimeout(() => {
              socket.emit("ruler_update", {
                  map_id: currentMapId,  // Обязательно передаем map_id!
                  ruler_start: rulerStart,
                  ruler_end: rulerEnd
              });
              window.rulerThrottle = null;
          }, 30);
      }

      return;
  }

  if (draggingToken || draggingFind) {
    const newX = (mouseX - offsetX) / scale - dragOffset[0];
    const newY = (mouseY - offsetY) / scale - dragOffset[1];
    
    if (draggingToken) {
      draggingToken.position = [newX, newY];
      
      // Отправляем перемещение в реальном времени
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
        }, 16); // ~60fps
      }
    }
    
    if (draggingFind) draggingFind.position = [newX, newY];
    render();
    return;
  }

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

      if (!Number.isNaN(newHp)) {
        token.health_points = newHp;
      }
      if (!Number.isNaN(newHpMax) && newHpMax > 0) {
        token.max_health_points = newHpMax;
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
    document.getElementById("zoneVisibleCheckbox").checked = true;

    const hasIntersection = mapData.zones.some(z =>
      z.vertices && z.vertices.length >= 3 && zonesIntersect(z.vertices, newZoneVertices)
    );

    if (hasIntersection) {
      alert("Новая зона пересекается с существующей! Измените форму.");
      return;
    }
    return;
  }
});


canvas.addEventListener("mouseup", () => {
    if (draggingToken || draggingFind) {
        // Очищаем throttle
        if (window.tokenMoveThrottle) {
            clearTimeout(window.tokenMoveThrottle);
            window.tokenMoveThrottle = null;
        }
        
        // При отпускании мыши отправляем финальное обновление
        if (draggingToken) {
            socket.emit("token_move", {
                map_id: currentMapId,
                token_id: draggingToken.id,
                position: draggingToken.position,
                is_visible: draggingToken.is_visible,
                is_dead: draggingToken.is_dead
            });
        }
        
        // Затем сохраняем на сервере
        fetch("/api/map", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(mapData),
        });
    }

    // Отправляем финальное положение линейки
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
  if (e.key === "Escape") {
        if (drawingZone) {
            drawingZone = false;
            currentZoneVertices = [];
            updateCanvasCursor();
            
            // Удаляем подсказку
            const hint = document.getElementById('drawing-hint');
            if (hint) hint.remove();
            
            render();
        }
    }
    if (e.key === "Delete") {
        let changed = false;
        
        // Существующий код для токенов
        if (selectedTokenId) {
      fetch(`/api/token/avatar/${selectedTokenId}`, {
        method: 'DELETE'
      }).catch(err => console.error('Error deleting token avatar:', err));
      
      mapData.tokens = mapData.tokens.filter(t => t.id !== selectedTokenId);
      selectedTokenId = null;
      changed = true;
    }

    // Существующий код для зон
    if (selectedZoneId) {
      mapData.zones = mapData.zones.filter(z => z.id !== selectedZoneId);
      selectedZoneId = null;
      changed = true;
    }

    // Существующий код для находок
    if (selectedFindId) {
      mapData.finds = mapData.finds.filter(f => f.id !== selectedFindId);
      selectedFindId = null;
      changed = true;
    }

    // НОВЫЙ КОД ДЛЯ ПОРТРЕТОВ (БЕЗ ПОДТВЕРЖДЕНИЯ)
    if (selectedCharacterId) {
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

    if (hasIntersection) {
      alert("Новая зона пересекается с существующей! Измените форму.");
      return;
    }

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
      size: mapData.grid_settings.cell_size / 4 ,
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

window.onload = () => {
    fetch("/api/maps")
        .then(res => res.json())
        .then(maps => {
            const select = document.getElementById('mapSelect');
            select.innerHTML = '';
            
            if (maps.length > 0) {
                maps.forEach(map => {
                    const option = document.createElement('option');
                    option.value = map.id;
                    option.textContent = map.name;
                    select.appendChild(option);
                });
                select.value = maps[0].id;
                // Убираем fetchMap(), оставляем только switchMap
                switchMap(maps[0].id);
                setTimeout(updateSliderVisual, 100);
            } else {
                select.innerHTML = '<option value="">Нет карт</option>';
                switchMap(null);
            }
        });
      
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
    
    // === НОВОЕ: отправляем сигнал всем вкладкам игрока о необходимости перезагрузки ===
    playerChannel.postMessage({
        type: 'reload_player',
        map_id: currentMapId,
        enabled: mapData.player_map_enabled
    });
    // ===============================================
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
      
      // Отправляем обновление линейки
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
        
        
        // Сохраняем через обычный saveMapData
        saveMapData();
        
        // Отправляем специальное событие для немедленного обновления игроков
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
    const menu = document.getElementById("tokenContextMenu");
    if (!menu.contains(e.target)) {
      menu.style.display = "none";
    }
  });

  updateSliderVisual();
};

socket.on("map_created", (data) => {
    
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
    
    // Устанавливаем currentMapId без вызова switchMap
    currentMapId = data.current_map;
    
    // Загружаем данные карты
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
    canvas.classList.remove('zone-drawing-mode', 'ruler-mode', 'token-dragging', 'map-panning');
    
    if (drawingZone) {
        canvas.classList.add('zone-drawing-mode');
    } else if (isRulerMode) {
        canvas.classList.add('ruler-mode');
    } else if (draggingToken || draggingFind) {
        canvas.classList.add('token-dragging');
    } else if (isPanning) {
        canvas.classList.add('map-panning');
    } else {
        // Возвращаем стандартный курсор
        canvas.style.cursor = 'default';
    }
}

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
    
    // Устанавливаем значения чекбоксов
    document.getElementById("contextTokenVisible").checked = token.is_visible !== false;
    document.getElementById("contextTokenDead").checked = token.is_dead || token.health_points <= 0;
    
    document.getElementById("contextAcInput").value = token.armor_class || 10;
    
    // Сначала показываем меню, чтобы получить его размеры
    menu.style.display = "block";
    menu.style.visibility = "hidden"; // Временно скрываем для измерения
    
    // Получаем размеры меню и окна
    const menuRect = menu.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    
    // Корректируем позицию
    let left = x;
    let top = y;
    
    // Проверяем правый край
    if (left + menuRect.width > windowWidth) {
        left = windowWidth - menuRect.width - 10; // Отступ 10px от края
    }
    
    // Проверяем нижний край
    if (top + menuRect.height > windowHeight) {
        top = windowHeight - menuRect.height - 10; // Отступ 10px от края
    }
    
    // Проверяем левый край (на всякий случай)
    if (left < 10) {
        left = 10;
    }
    
    // Проверяем верхний край
    if (top < 10) {
        top = 10;
    }
    
    // Применяем позицию и показываем меню
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "visible";
    
    // Скрываем другие меню
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
document.getElementById("contextTokenVisible").addEventListener("change", function(e) {
    if (currentContextToken) {
        currentContextToken.is_visible = e.target.checked;
        saveMapData();
        render();
        updateSidebar();
    }
});

document.getElementById("contextTokenDead").addEventListener("change", function(e) {
    if (currentContextToken) {
        const wasDead = currentContextToken.is_dead || currentContextToken.health_points <= 0;
        currentContextToken.is_dead = e.target.checked;
        
        if (e.target.checked) {
            currentContextToken.health_points = 0;
        } else if (wasDead) {
            currentContextToken.health_points = 1;
        }
        
        saveMapData();
        render();
        updateSidebar();
    }
});

document.getElementById("contextApplyDamage").addEventListener("click", function() {
    if (currentContextToken) {
        const damage = parseInt(document.getElementById("contextDamageInput").value) || 0;
        if (damage > 0) {
            const currentHp = currentContextToken.health_points || 0;
            currentContextToken.health_points = Math.max(0, currentHp - damage);
            currentContextToken.is_dead = currentContextToken.health_points <= 0;
            
            document.getElementById("contextTokenDead").checked = currentContextToken.is_dead;
            
            saveMapData();
            render();
            updateSidebar();
        }
    }
});

document.getElementById("contextApplyHeal").addEventListener("click", function() {
    if (currentContextToken) {
        const heal = parseInt(document.getElementById("contextHealInput").value) || 0;
        if (heal > 0) {
            const maxHp = currentContextToken.max_health_points || 10;
            const currentHp = currentContextToken.health_points || 0;
            currentContextToken.health_points = Math.min(maxHp, currentHp + heal);
            currentContextToken.is_dead = currentContextToken.health_points <= 0;
            
            document.getElementById("contextTokenDead").checked = currentContextToken.is_dead;
            
            saveMapData();
            render();
            updateSidebar();
        }
    }
});

document.getElementById("contextApplyAc").addEventListener("click", function() {
    if (currentContextToken) {
        const newAc = parseInt(document.getElementById("contextAcInput").value);
        if (newAc > 0) {
            currentContextToken.armor_class = newAc;
            saveMapData();
            render();
            updateSidebar();
        }
    }
});

document.getElementById("contextEditToken").addEventListener("click", function() {
    if (currentContextToken) {
        openEditTokenModal(currentContextToken);
        document.getElementById("tokenContextMenu").style.display = "none";
    }
});

document.getElementById("contextDeleteToken").addEventListener("click", function() {
    if (currentContextToken && confirm(`Удалить токен "${currentContextToken.name}"?`)) {
        // Удаляем аватар если есть
        if (currentContextToken.has_avatar) {
            fetch(`/api/token/avatar/${currentContextToken.id}`, {
                method: 'DELETE'
            }).catch(err => console.error('Error deleting token avatar:', err));
        }
        
        mapData.tokens = mapData.tokens.filter(t => t.id !== currentContextToken.id);
        selectedTokenId = null;
        saveMapData();
        render();
        updateSidebar();
        document.getElementById("tokenContextMenu").style.display = "none";
    }
});

// Обработчики для меню находки
document.getElementById("contextFindInspected").addEventListener("change", function(e) {
    if (currentContextFind) {
        currentContextFind.status = e.target.checked;
        saveMapData();
        render();
        updateSidebar();
    }
});

document.getElementById("contextEditFind").addEventListener("click", function() {
    if (currentContextFind) {
        openFindModal(currentContextFind);
        document.getElementById("findContextMenu").style.display = "none";
    }
});

document.getElementById("contextDeleteFind").addEventListener("click", function() {
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
document.getElementById("contextZoneVisible").addEventListener("change", function(e) {
    if (currentContextZone) {
        currentContextZone.is_visible = e.target.checked;
        saveMapData();
        render();
        updateSidebar();
    }
});

document.getElementById("contextEditZone").addEventListener("click", function() {
    if (currentContextZone) {
        openEditZoneModal(currentContextZone);
        document.getElementById("zoneContextMenu").style.display = "none";
    }
});

document.getElementById("contextDeleteZone").addEventListener("click", function() {
    if (currentContextZone && confirm(`Удалить зону "${currentContextZone.name}"?`)) {
        mapData.zones = mapData.zones.filter(z => z.id !== currentContextZone.id);
        selectedZoneId = null;
        saveMapData();
        render();
        updateSidebar();
        document.getElementById("zoneContextMenu").style.display = "none";
    }
});

// Функция для открытия модального окна редактирования токена
function openEditTokenModal(token) {
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
    
    // Скрываем чекбокс "Добавить в портреты" при редактировании
    document.getElementById("addToCharactersCheckbox").parentElement.style.display = "none";
    
    // Если есть аватар, показываем его
    if (token.avatar_url) {
        const preview = document.getElementById("avatarPreview");
        preview.src = token.avatar_url;
        preview.style.display = "block";
        // Не сохраняем base64, так как он может быть не в данных
        
        document.getElementById("avatarOverlay").style.display = "none";
        document.getElementById("avatarMask").style.display = "block";
        document.getElementById("editIcon").style.display = "block";
    } else {
        // Сбрасываем预览 аватара
        const preview = document.getElementById("avatarPreview");
        preview.src = "";
        preview.style.display = "none";
        preview.removeAttribute("data-base64");
        
        document.getElementById("avatarOverlay").style.display = "block";
        document.getElementById("avatarMask").style.display = "none";
        document.getElementById("editIcon").style.display = "none";
    }
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
    
    if (data.map_id === currentMapId) {
        // Находим токен в данных
        const token = mapData.tokens.find(t => t.id === data.token_id);
        if (token) {
            // Обновляем URL аватара с новым timestamp
            token.avatar_url = data.avatar_url;
            
            // Очищаем кэш аватара
            if (avatarCache[data.token_id]) {
                delete avatarCache[data.token_id];
            }
            
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
            <button class="context-menu-item delete" id="contextDeleteCharacter">
                <span class="context-icon">🗑️</span> Удалить
            </button>
        </div>
    `;
    
    document.body.appendChild(menu);
    
    // Добавляем обработчики
    document.getElementById("contextCharacterVisible").addEventListener("change", function(e) {
        if (window.currentContextCharacter) {
            window.currentContextCharacter.visible_to_players = e.target.checked;
            updateSidebar();
            saveMapData();
        }
    });
    
    document.getElementById("contextDeleteCharacter").addEventListener("click", function() {
        if (window.currentContextCharacter && confirm(`Удалить портрет "${window.currentContextCharacter.name}"?`)) {
            // Удаляем портрет
            fetch(`/api/portrait/${window.currentContextCharacter.id}`, {
                method: 'DELETE'
            }).catch(err => console.error('Error deleting portrait:', err));
            
            mapData.characters = mapData.characters.filter(c => c.id !== window.currentContextCharacter.id);
            selectedCharacterId = null;
            saveMapData();
            render();
            updateSidebar();
            document.getElementById("characterContextMenu").style.display = "none";
        }
    });
    
    return menu;
}
