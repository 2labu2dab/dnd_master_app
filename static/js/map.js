// static/js/map.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
canvas.width = window.innerWidth - 270;
canvas.height = window.innerHeight;

let mapImage = new Image();
let mapData = {
  tokens: [],
  finds: [],
  zones: [],
  map_image: "",
  grid_settings: { cell_size: 20, color: "#888888", visible: true }
};


let selectedTokenId = null;
let selectedFindId = null;
let draggingToken = null;
let draggingFind = null;
let dragOffset = [0, 0];

let drawingZone = false; // Переменная для отслеживания режима рисования зоны
let currentZoneVertices = []; // Массив для хранения вершин текущей зоны

let avatarImage = null;
let avatarData = null;
let selectedZoneId = null;
const avatarCache = {};


function syncGridInputs(value) {
  const num = parseInt(value);
  if (isNaN(num) || num < 10 || num > 200) return;

  document.getElementById("gridSlider").value = num;
  document.getElementById("gridInput").value = num;
  mapData.grid_settings.cell_size = num;
  render();

  fetch("/api/map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mapData),
  });
}


function drawAvatarCircle() {
  const canvas = document.getElementById("avatarCanvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!avatarImage) return;

  const size = Math.min(canvas.width, canvas.height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, 2 * Math.PI);
  ctx.clip();
  ctx.drawImage(avatarImage, 0, 0, size, size);
  ctx.restore();

  // Сохраняем base64
  const cropped = canvas.toDataURL("image/png");
  document.getElementById("avatarData").value = cropped;
}

function drawAvatarSelection() {
  const canvas = document.getElementById("avatarCanvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!avatarImage) return;

  // Центрируем изображение
  const size = Math.min(canvas.width, canvas.height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, size / 2, 0, 2 * Math.PI);
  ctx.clip();
  ctx.drawImage(avatarImage, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function saveAvatar() {
  const canvas = document.getElementById("avatarCanvas");
  avatarData = canvas.toDataURL("image/png");
  alert("Аватар сохранён и будет добавлен к токену");
}

function submitToken() {
  const name = document.getElementById("tokenName").value;
  const type = document.querySelector('input[name="tokenType"]:checked').value;
  const isDead = document.getElementById("tokenDead").checked;
  const avatarData = document.getElementById("avatarData").value;

  if (!name) return alert("Введите имя!");

  const centerX = mapImage.width / 2;
  const centerY = mapImage.height / 2;

  const token = {
    id: `token_${Date.now()}`,
    name,
    position: [centerX, centerY],
    size: mapData.grid_settings.cell_size,
    is_dead: isDead,
    is_player: type === "player",
    is_npc: type === "npc",
    avatar_data: avatarData || null  // 👈 новое поле
  };

  fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(token),
  }).then(() => {
    closeTokenModal();
    avatarData = null;
    fetchMap();
  });
}


function autoUploadMap(input) {
  const formData = new FormData();
  formData.append("map_image", input.files[0]);

  fetch("/upload_map", {
    method: "POST",
    body: formData,
  }).then(() => fetchMap());
}

// Глазки
function getOpenEyeSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 5c-6 0-9 6-9 6s3 6 9 6 9-6 9-6-3-6-9-6zm0 10a4 4 0 110-8 4 4 0 010 8z"/></svg>`;
}
function getClosedEyeSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M2 5l2.5 2.5C3.5 9 3 10 3 12s.5 3 1.5 4.5L2 19l2 2 3.5-3.5C9 18.5 10 19 12 19s3-.5 4.5-1.5L20 21l2-2-2.5-2.5C21 15 21 14 21 12s0-3-1.5-4.5L22 5l-2-2-3.5 3.5C15 5.5 14 5 12 5s-3 .5-4.5 1.5L4 3 2 5z"/></svg>`;
}


function updateSidebar() {
  // 🔁 Зоны
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
      render(); // обновим карту
    };

    li.appendChild(nameSpan);
    li.appendChild(eye);
    zoneList.appendChild(li);
  });

  // 🔁 Токены
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
    eye.onclick = () => {
      token.is_visible = !token.is_visible;
      saveMapData();
      updateSidebar();
    };

    li.appendChild(dot);
    li.appendChild(nameSpan);
    li.appendChild(acSpan);
    li.appendChild(hpSpan);
    li.appendChild(eye);
    tokenList.appendChild(li);
  });

  // 🔁 Находки
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

    const nameSpan = document.createElement("span");
    nameSpan.textContent = find.name;
    nameSpan.style.overflow = "hidden";
    nameSpan.style.textOverflow = "ellipsis";
    nameSpan.style.whiteSpace = "nowrap";
    nameSpan.style.color = "#ddd";
    nameSpan.style.flex = "1";

    const statusSpan = document.createElement("span");
    if (find.status) {
      statusSpan.textContent = "Осмотрено";
      statusSpan.style.color = "#4CAF50";
      statusSpan.style.fontSize = "14px";
      statusSpan.style.flexShrink = "0";
    }

    li.appendChild(nameSpan);
    li.appendChild(statusSpan);
    findList.appendChild(li);
  });

}

function saveMapData() {
  fetch("/api/map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mapData),
  });
}


function fetchMap() {
  fetch(`/api/map?ts=${Date.now()}`)
    .then(res => res.json())
    .then(data => {
      mapData = data;
      updateSidebar();
      if (!mapData.tokens) mapData.tokens = [];
      if (!mapData.finds) mapData.finds = [];
      if (!mapData.zones) mapData.zones = [];
      if (!mapData.grid_settings) mapData.grid_settings = { cell_size: 20, color: "#888888", visible: true };

      if (mapData.map_image) {
        mapImage = new Image();
        mapImage.onload = () => render();
        mapImage.src = `/static/${mapData.map_image}?ts=${Date.now()}`;
      } else {
        render();
      }
    });
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / mapImage.width, canvas.height / mapImage.height);
  const newWidth = mapImage.width * scale;
  const newHeight = mapImage.height * scale;
  const offsetX = (canvas.width - newWidth) / 2;
  const offsetY = (canvas.height - newHeight) / 2;

  if (mapData.map_image && mapImage.complete) {
    ctx.drawImage(mapImage, offsetX, offsetY, newWidth, newHeight);
  }

  drawLayers(offsetX, offsetY, scale);
  
  if (drawingZone && currentZoneVertices.length > 0) {
    drawTempZone(offsetX, offsetY, scale);
  }
}

function drawTempZone(offsetX, offsetY, scale) {
  if (currentZoneVertices.length === 0) return;

  ctx.beginPath();
  ctx.strokeStyle = "#2196F3"; // Синий контур
  ctx.fillStyle = "rgba(33, 150, 243, 0.3)"; // Прозрачный синий фон
  const [startX, startY] = currentZoneVertices[0];
  ctx.moveTo(startX * scale + offsetX, startY * scale + offsetY);

  for (let i = 1; i < currentZoneVertices.length; i++) {
    const [x, y] = currentZoneVertices[i];
    ctx.lineTo(x * scale + offsetX, y * scale + offsetY);
  }

  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawLayers(offsetX, offsetY, scale) {
  if (mapData.grid_settings.visible) drawGrid(offsetX, offsetY, scale);
  mapData.zones.forEach(z => drawZone(z, offsetX, offsetY, scale)); // Отрисовываем зоны
  mapData.tokens.forEach(t => drawToken(t, offsetX, offsetY, scale));
  mapData.finds.forEach(f => drawFind(f, offsetX, offsetY, scale)); // `status` влияет на цвет, не на отображение
}

function drawGrid(offsetX, offsetY, scale) {
  const size = mapData.grid_settings.cell_size * scale;
  ctx.strokeStyle = mapData.grid_settings.color;
  ctx.lineWidth = 1;

  for (let x = offsetX % size; x < canvas.width; x += size) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = offsetY % size; y < canvas.height; y += size) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function drawToken(token, offsetX, offsetY, scale) {
  const [x, y] = token.position;
  const sx = x * scale + offsetX;
  const sy = y * scale + offsetY;
  const cellSize = mapData.grid_settings.cell_size;
  const size = cellSize * scale;

  ctx.beginPath();
  ctx.arc(sx, sy, size / 2, 0, 2 * Math.PI);
  ctx.strokeStyle = token.is_player
    ? "#4CAF50"
    : token.is_npc
    ? "#FFC107"
    : "#F44336";
  ctx.lineWidth = 4;
  ctx.stroke();

  if (token.avatar) {
    if (!avatarCache[token.avatar]) {
      const img = new Image();
      img.onload = () => render(); // Перерисовать, когда загрузится
      img.src = `/static/${token.avatar}`;
      avatarCache[token.avatar] = img;
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, size / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(avatarCache[token.avatar], sx - size / 2, sy - size / 2, size, size);
      ctx.restore();
    }
  } else {
    // Отрисовка цветного круга (как раньше)
    ctx.beginPath();
    ctx.fillStyle = token.is_player
      ? "#4CAF50"
      : token.is_npc
      ? "#FFC107"
      : token.is_dead
      ? "#616161"
      : "#F44336";
    ctx.arc(sx, sy, size / 2, 0, 2 * Math.PI);
    ctx.fill();
  }

  if (token.id === selectedTokenId) {
    ctx.strokeStyle = "#00FFFF";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, size / 2 + 3, 0, 2 * Math.PI);
    ctx.stroke();
  }

  ctx.fillStyle = "white";
  const fontSize = Math.max(cellSize * 0.5 * scale, 8);
  ctx.font = `${fontSize}px Inter`;
  ctx.textAlign = "center";
  ctx.fillText(token.name, sx, sy + size / 2 + fontSize);
}

function drawFind(find, offsetX, offsetY, scale) {
  const [x, y] = find.position;
  const sx = x * scale + offsetX;
  const sy = y * scale + offsetY;
  const cellSize = mapData.grid_settings.cell_size;
  const size = cellSize * scale;

  ctx.beginPath();
  ctx.fillStyle = "white";
  ctx.arc(sx, sy, size / 2, 0, 2 * Math.PI);
  ctx.fill();

  if (find.status) {
    ctx.fillStyle = "#4CAF50";
    ctx.arc(sx, sy, size / 2, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.fillStyle = "black";
  const fontSize = Math.max(cellSize * 0.5 * scale, 8);
  ctx.font = `${fontSize}px Inter`;
  ctx.textAlign = "center";
  ctx.fillText(find.name, sx, sy + size / 2 + fontSize);
}

function drawZone(zone, offsetX, offsetY, scale) {
  if (!zone.vertices || zone.vertices.length < 2) return; // Если зона не имеет вершин, не рисуем её

  ctx.beginPath();
  
  // Цвет зоны в зависимости от видимости
  ctx.strokeStyle = zone.is_visible ? "#4CAF50" : "#F44336";
  ctx.fillStyle = zone.is_visible ? "rgba(76, 175, 80, 0.3)" : "rgba(244, 67, 54, 0.3)";

  const isSelected = zone.id === selectedZoneId;
  if (isSelected) {
    ctx.lineWidth = 3;
  } else {
    ctx.lineWidth = 1;
  }

  // Преобразуем координаты вершин для масштаба и смещения
  const transformed = zone.vertices.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);

  // Рисуем линии, соединяя все вершины
  ctx.moveTo(transformed[0][0], transformed[0][1]);
  for (let i = 1; i < transformed.length; i++) {
    ctx.lineTo(transformed[i][0], transformed[i][1]);
  }
  ctx.closePath(); // Закрываем путь (замкнутый полигон)

  // Заполняем и обводим зону
  ctx.fill();
  ctx.stroke();

  if (isSelected) {
    ctx.strokeStyle = "#00FFFF"; // цвет обводки выделения
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Отображение имени зоны в центре полигона
  const centerX = transformed.reduce((a, b) => a + b[0], 0) / transformed.length;
  const centerY = transformed.reduce((a, b) => a + b[1], 0) / transformed.length;
  ctx.fillStyle = "#333";
  ctx.font = `16px Inter`;
  ctx.fillText(zone.name, centerX, centerY);
}

function addZone() {
  drawingZone = true; // Включаем режим рисования зоны
  currentZoneVertices = []; // Очищаем текущие вершины зоны
}

function onGridSizeChange(value) {
  const newSize = parseInt(value);
  document.getElementById("gridSizeDisplay").innerText = newSize;
  mapData.grid_settings.cell_size = newSize;
  render();

  // сохраняем
  fetch("/api/map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mapData),
  });
}

function handleAvatarUpload(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.getElementById("avatarPreview");
      const ctx = canvas.getContext("2d");

      // Обрезаем круг из центра
      const size = Math.min(img.width, img.height);
      const cx = img.width / 2;
      const cy = img.height / 2;

      canvas.width = 100;
      canvas.height = 100;

      ctx.clearRect(0, 0, 100, 100);
      ctx.save();
      ctx.beginPath();
      ctx.arc(50, 50, 50, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      ctx.drawImage(
        img,
        cx - size / 2,
        cy - size / 2,
        size,
        size,
        0,
        0,
        100,
        100
      );

      ctx.restore();

      // Сохраняем base64
      canvas.dataset.base64 = canvas.toDataURL("image/png");
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function submitToken() {
  const name = document.getElementById("tokenName").value;
  const type = document.querySelector('input[name="tokenType"]:checked').value;
  const isDead = document.getElementById("tokenDead").checked;

  const canvas = document.getElementById("avatarPreview");
  const avatarData = canvas?.dataset?.base64 || null;

  if (!name) return alert("Введите имя!");

  const centerX = mapImage.width / 2;
  const centerY = mapImage.height / 2;

  const token = {
    id: `token_${Date.now()}`,
    name,
    position: [centerX, centerY],
    size: mapData.grid_settings.cell_size,
    is_dead: isDead,
    is_player: type === "player",
    is_npc: type === "npc",
    avatar_data: avatarData
  };

  fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(token),
  }).then(() => {
    closeTokenModal();
    fetchMap();
  });
}

function closeTokenModal() {
  document.getElementById("tokenModal").style.display = "none";
  document.getElementById("tokenName").value = "";
  document.getElementById("tokenDead").checked = false;
  document.querySelector('input[name="tokenType"][value="player"]').checked = true;
}

function addToken() {
  // Открывает модальное окно
  document.getElementById("tokenModal").style.display = "flex";

  // Сброс значений формы
  document.getElementById("tokenName").value = "";
  document.getElementById("tokenDead").checked = false;
  document.querySelector('input[name="tokenType"][value="player"]').checked = true;
}

function addFind() {
  const name = prompt("Имя находки:");
  if (!name) return;

  const centerX = mapImage.width / 2;
  const centerY = mapImage.height / 2;

  const find = {
    id: `find_${Date.now()}`,
    name,
    position: [centerX, centerY],
    size: 25,
    status: false,
    description: "",
  };

  fetch("/api/find", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(find),
  }).then(fetchMap);
}

canvas.addEventListener("mousedown", (e) => {
  const [mouseX, mouseY] = [e.offsetX, e.offsetY];
  const scale = Math.min(canvas.width / mapImage.width, canvas.height / mapImage.height);
  const offsetX = (canvas.width - mapImage.width * scale) / 2;
  const offsetY = (canvas.height - mapImage.height * scale) / 2;

  if (drawingZone) {
    const newVertex = [(mouseX - offsetX) / scale, (mouseY - offsetY) / scale];
    currentZoneVertices.push(newVertex);
    render();
    return;
  }

  // Сброс выделения
  selectedTokenId = null;
  selectedFindId = null;
  selectedZoneId = null;
  draggingToken = null;
  draggingFind = null;

  let clicked = false;

  // Токены
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

  // Находки
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

  // Зоны
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

canvas.addEventListener("mousemove", (e) => {
  if (!draggingToken && !draggingFind) return;

  const scale = Math.min(canvas.width / mapImage.width, canvas.height / mapImage.height);
  const offsetX = (canvas.width - mapImage.width * scale) / 2;
  const offsetY = (canvas.height - mapImage.height * scale) / 2;

  const newX = (e.offsetX - offsetX) / scale - dragOffset[0];
  const newY = (e.offsetY - offsetY) / scale - dragOffset[1];

  if (draggingToken) draggingToken.position = [newX, newY];
  if (draggingFind) draggingFind.position = [newX, newY];

  render();
});

canvas.addEventListener("contextmenu", (e) => {
  if (drawingZone) {
    e.preventDefault(); // Отменяем стандартное контекстное меню
    const zoneName = prompt("Введите имя зоны:");
    if (zoneName) {
      const newZone = {
        id: `zone_${Date.now()}`,
        name: zoneName,
        vertices: currentZoneVertices,
        is_visible: true,
      };
      mapData.zones.push(newZone);
      drawingZone = false; // Отключаем режим рисования
      currentZoneVertices = []; // Очищаем текущие вершины
      render();
      // Сохраняем изменения
      fetch("/api/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mapData),
      });
    }
  }
  for (const zone of mapData.zones) {
  const path = new Path2D();
  zone.vertices.forEach(([vx, vy], i) => {
    const px = vx * scale + offsetX;
    const py = vy * scale + offsetY;
    if (i === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  });
  path.closePath();

  if (ctx.isPointInPath(path, e.offsetX, e.offsetY)) {
    e.preventDefault();
    const choice = confirm(zone.is_visible ? "Скрыть зону?" : "Сделать зону видимой?");
    if (choice !== null) {
      zone.is_visible = !zone.is_visible;
      fetch("/api/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mapData),
      });
      render();
    }
    return;
  }
}
});

canvas.addEventListener("mouseup", () => {
  if (draggingToken || draggingFind) {
    fetch("/api/map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mapData),
    });
  }

  draggingToken = null;
  draggingFind = null;
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Delete") {
    let changed = false;

    if (selectedTokenId) {
      mapData.tokens = mapData.tokens.filter(t => t.id !== selectedTokenId);
      selectedTokenId = null;
      changed = true;
    }

    if (selectedZoneId) {
      mapData.zones = mapData.zones.filter(z => z.id !== selectedZoneId);
      selectedZoneId = null;
      changed = true;
    }

    if (selectedFindId) {
      mapData.finds = mapData.finds.filter(f => f.id !== selectedFindId);
      selectedFindId = null;
      changed = true;
    }

    if (changed) {
      render();
      fetch("/api/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mapData),
      });
    }
  }
});

window.onload = fetchMap;
