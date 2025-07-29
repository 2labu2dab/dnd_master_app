// static/js/map.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const sidebar = document.getElementById("sidebar");
canvas.width = window.innerWidth - sidebar.offsetWidth;
canvas.height = window.innerHeight;
let zoomLevel = 1;
const socket = io();

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

let drawingZone = false; // Переменная для отслеживания режима рисования зоны
let currentZoneVertices = []; // Массив для хранения вершин текущей зоны

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
  const avatarData = document.getElementById("avatarPreview").dataset.base64 || null;
  const ac = parseInt(document.getElementById("tokenAC").value);
  const hp = parseInt(document.getElementById("tokenHP").value);
  const type = document.querySelector(".type-btn.active")?.dataset.type;
  const preview = document.getElementById("avatarRawPreview");

  if (!name || !type) return alert("Заполните все поля");

  const centerX = mapImage.width / 2;
  const centerY = mapImage.height / 2;

  const token = {
    id: `token_${Date.now()}`,
    name,
    position: [centerX, centerY],
    size: mapData.grid_settings.cell_size,
    is_dead: false,
    is_player: type === "player",
    is_npc: type === "npc",
    armor_class: ac,
    health_points: hp,
    max_health_points: hp,
    avatar_data: avatarData
  };

  fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(token),
  }).then(() => {
    closeTokenModal();
    fetchMap();
    updateSidebar();
  });
}


function autoUploadMap(input) {
  const formData = new FormData();
  formData.append("map_image", input.files[0]); // ⬅️ название должно быть "map_image"

  fetch("/upload_map", {
    method: "POST",
    body: formData,
  }).then(() => fetchMap());
}

// Глазки
function getOpenEyeSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M2.062 12.348a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 19.876 0a1 1 0 0 1 0 .696a10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></g></svg>`;
}
function getClosedEyeSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="m9.343 18.782l-1.932-.518l.787-2.939a11 11 0 0 1-3.237-1.872l-2.153 2.154l-1.414-1.414l2.153-2.154a10.96 10.96 0 0 1-2.371-5.07l1.968-.359a9.002 9.002 0 0 0 17.713 0l1.968.358a10.96 10.96 0 0 1-2.372 5.071l2.154 2.154l-1.414 1.414l-2.154-2.154a11 11 0 0 1-3.237 1.872l.788 2.94l-1.932.517l-.788-2.94a11 11 0 0 1-3.74 0z"/></svg>`;
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
    if (Math.abs(val) < 1e-10) return 0; // коллинеарны
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
      // Но если один из концов совпадает — не считаем пересечением
      if (
        (pointsEqual(p1, p2) || pointsEqual(p1, q2) ||
          pointsEqual(q1, p2) || pointsEqual(q1, q2))
      ) {
        return false;
      }

      return true;
    }

    // Проверка коллинеарности и касаний
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
  fetch(`/api/map?ts=${Date.now()}`)
    .then(res => res.json())
    .then(data => {
      mapData = data;
      zoomLevel = mapData.zoom_level || 1;
      updateSidebar();

      if (!mapData.tokens) mapData.tokens = [];
      if (!mapData.finds) mapData.finds = [];
      if (!mapData.zones) mapData.zones = [];
      if (!mapData.grid_settings) {
        mapData.grid_settings = {
          cell_size: 20,
          color: "#888888",
          visible: false,
          visible_to_players: true
        };
      }

      // Устанавливаем значения слайдера
      const gridSize = mapData.grid_settings.cell_size || 20;
      document.getElementById("gridSlider").value = gridSize;
      document.getElementById("gridInput").value = gridSize;

      const rawPercent = ((gridSlider.value - gridSlider.min) / (gridSlider.max - gridSlider.min)) * 100;
      const adjustedPercent = Math.min(rawPercent + 2, 100);
      document.getElementById("gridSlider").style.setProperty('--percent', `${adjustedPercent}%`);

      // Обновление состояния кнопки сетки мастера
      const gridToggle = document.getElementById("gridToggle");
      gridToggle.classList.toggle("active", mapData.grid_settings.visible);

      // Обновление состояния кнопки сетки игрока
      const playerGridToggle = document.getElementById("playerGridToggle");
      if (mapData.grid_settings.visible_to_players !== false) {
        playerGridToggle.classList.add("active");
      } else {
        playerGridToggle.classList.remove("active");
      }

      const playerRulerToggle = document.getElementById("playerRulerToggle");
      playerRulerToggle.classList.toggle("active", mapData.ruler_visible_to_players);

      if (mapData.map_image_base64) {
        mapImage = new Image();
        mapImage.onload = () => render();
        mapImage.src = mapData.map_image_base64;
      } else {
        render();
      }
    });
}

window.addEventListener("resize", () => {
  const sidebar = document.getElementById("sidebar");
  canvas.width = window.innerWidth - sidebar.offsetWidth;
  canvas.height = window.innerHeight;
  render();
});

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const baseScale = Math.min(canvas.width / mapImage.width, canvas.height / mapImage.height);
  const scale = baseScale * (mapData.zoom_level || 1);
  const newWidth = mapImage.width * scale;
  const newHeight = mapImage.height * scale;
  const offsetX = (canvas.width - newWidth) / 2;
  const offsetY = (canvas.height - newHeight) / 2;

  if (mapData.map_image_base64 && mapImage.complete) {
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

    const dx = (sx2 - sx1) / scale;
    const dy = (sy2 - sy1) / scale;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const cells = dist / mapData.grid_settings.cell_size;
    const feet = cells * 5;

    const midX = (sx1 + sx2) / 2;
    const midY = (sy1 + sy2) / 2;

    ctx.font = "bold 16px Inter";
    ctx.textAlign = "center";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "white";
    ctx.strokeText(`${feet.toFixed(0)} футов`, midX, midY - 10); // Белый буфер
    ctx.fillStyle = "black";
    ctx.fillText(`${feet.toFixed(0)} футов`, midX, midY - 10);   // Чёрный текст


    // Стрелка
    ctx.strokeStyle = "#c82a2aff";
    ctx.lineWidth = 2;
    const headlen = 10; // длина стрелочного наконечника
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
  const size = mapData.grid_settings.cell_size * scale;
  const radius = size / 2;

  // Цветная рамка по типу
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, 2 * Math.PI);
  ctx.strokeStyle = token.is_dead
    ? "#999"
    : token.is_player
      ? "#4CAF50"
      : token.is_npc
        ? "#FFC107"
        : "#F44336";
  ctx.lineWidth = 4;
  ctx.stroke();

  // Источник аватара
  const avatarSrc = token.avatar_data || (token.avatar ? `/static/${token.avatar}` : null);
  const cached = avatarCache[token.id];

  if (avatarSrc) {
    if (!cached) {
      const img = new Image();
      img.onload = () => render();
      img.onerror = () => {
        console.warn(`⚠ Не удалось загрузить аватар токена ${token.name}`);
        avatarCache[token.id] = null;
      };
      img.src = avatarSrc;
      avatarCache[token.id] = img;
    } else if (cached instanceof HTMLImageElement && cached.complete && cached.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.clip();

      if (token.is_dead) {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = size;
        tempCanvas.height = size;
        const tempCtx = tempCanvas.getContext("2d");

        tempCtx.drawImage(cached, 0, 0, size, size);
        const imageData = tempCtx.getImageData(0, 0, size, size);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
          const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
          data[i] = data[i + 1] = data[i + 2] = avg;
        }

        tempCtx.putImageData(imageData, 0, 0);
        ctx.drawImage(tempCanvas, sx - radius, sy - radius);
      } else {
        ctx.drawImage(cached, sx - radius, sy - radius, size, size);
      }

      ctx.restore();
    }
  } else {
    ctx.beginPath();
    ctx.fillStyle = token.is_dead
      ? "#616161"
      : token.is_player
        ? "#4CAF50"
        : token.is_npc
          ? "#FFC107"
          : "#F44336";
    ctx.arc(sx, sy, radius, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Обводка выделенного токена
  if (selectedTokenId === token.id) {
    ctx.beginPath();
    ctx.arc(sx, sy, radius + 3, 0, Math.PI * 2);
    ctx.strokeStyle = "#00FFFF";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawFind(find, offsetX, offsetY, scale) {
  const [x, y] = find.position;
  const sx = x * scale + offsetX;
  const sy = y * scale + offsetY;
  const size = mapData.grid_settings.cell_size * scale;
  const radius = size / 2;

  ctx.save();

  if (find.status) {
    ctx.globalAlpha = 0.5;
  }

  // Круг находки
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, 2 * Math.PI);
  ctx.fillStyle = "#4C5BEF";
  ctx.fill();

  // Белая обводка
  ctx.lineWidth = 2;
  ctx.strokeStyle = "white";
  ctx.stroke();

  // Текст "?"
  ctx.fillStyle = "white";
  ctx.font = `bold ${radius}px Inter, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", sx, sy);

  // Обводка выделенной находки
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
  const newWidth = mapImage.width * scale;
  const newHeight = mapImage.height * scale;
  const offsetX = (canvas.width - newWidth) / 2;
  const offsetY = (canvas.height - newHeight) / 2;
  return { scale, offsetX, offsetY };
}

function addToken() {
  document.getElementById("tokenModal").style.display = "flex";
  document.getElementById("tokenName").value = "";
  document.getElementById("tokenAC").value = 10;
  document.getElementById("tokenHP").value = 10;

  // Устанавливаем активную кнопку типа токена по умолчанию
  document.querySelectorAll(".type-btn").forEach(b => b.classList.remove("active"));
  document.querySelector('.type-btn[data-type="player"]').classList.add("active");

  // Сброс аватара
  const avatarPreview = document.getElementById("avatarPreview");
  avatarPreview.src = "";
  avatarPreview.style.display = "none";
  avatarPreview.removeAttribute("data-base64");

  document.getElementById("avatarOverlay").style.display = "block";
  document.getElementById("avatarMask").style.display = "none";
  document.getElementById("editIcon").style.display = "none";
}

function drawZone(zone, offsetX, offsetY, scale) {
  if (!zone.vertices || zone.vertices.length < 2) return; // Если зона не имеет вершин, не рисуем её

  ctx.beginPath();

  // Цвет зоны в зависимости от видимости
  ctx.strokeStyle = zone.is_visible ? "#4CAF50" : "#F44336";
  ctx.fillStyle = zone.is_visible ? "rgba(76, 175, 80, 0.3)" : "rgba(244, 67, 54, 0.3)";

  const isSelected = zone.id === selectedZoneId;
  if (isSelected) {
    ctx.lineWidth = 2;
  } else {
    ctx.lineWidth = 4;
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

  // Отображение имени зоны в центре полигона с белым буфером
  const centerX = transformed.reduce((a, b) => a + b[0], 0) / transformed.length;
  const centerY = transformed.reduce((a, b) => a + b[1], 0) / transformed.length;
  ctx.font = `18px Inter`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Белый контур
  ctx.strokeStyle = "white";
  ctx.lineWidth = 4;
  ctx.strokeText(zone.name, centerX, centerY);

  // Чёрный текст
  ctx.fillStyle = "black";
  ctx.fillText(zone.name, centerX, centerY);
}

function addZone() {
  drawingZone = true; // Включаем режим рисования зоны
  currentZoneVertices = []; // Очищаем текущие вершины зоны
}

function onGridSizeChange(value) {
  const newSize = parseInt(value);
  document.getElementById("gridSlider").value = newSize;
  document.getElementById("gridInput").value = newSize; document.getElementById("gridInput").value = newSize;
  mapData.grid_settings.cell_size = newSize;
  render();

  // сохраняем
  fetch("/api/map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mapData),
  });
}

function handleAvatarUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const img = document.getElementById('avatarPreview');
    img.src = e.target.result;
    img.style.display = 'block';

    document.getElementById('avatarOverlay').style.display = 'none';
    document.getElementById('avatarMask').style.display = 'block';
    document.getElementById('editIcon').style.display = 'block';

    // Можно также сохранить base64:
    img.dataset.base64 = e.target.result;
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
    if (e.button === 0) { // Левый клик добавляет точку
      let x = (mouseX - offsetX) / scale;
      let y = (mouseY - offsetY) / scale;

      // Привязка к вершинам
      if (hoveredSnapVertex) {
        [x, y] = hoveredSnapVertex;
      }

      // Обрезка по карте
      x = Math.max(0, Math.min(x, mapImage.width));
      y = Math.max(0, Math.min(y, mapImage.height));

      currentZoneVertices.push([x, y]);
      render();
    }
  }


  // Выбор объектов
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
    render(); // отрисовать с подсветкой
    return;
  }

  if (isRulerMode && rulerStart) {
    const { scale, offsetX, offsetY } = getTransform();

    mapData.ruler_start = rulerStart;
    mapData.ruler_end = [
      (e.offsetX - offsetX) / scale,
      (e.offsetY - offsetY) / scale
    ];

    render();

    socket.emit("ruler_update", {
      ruler_start: mapData.ruler_start,
      ruler_end: mapData.ruler_end
    });

    return;
  }

  if (draggingToken || draggingFind) {
    const newX = (mouseX - offsetX) / scale - dragOffset[0];
    const newY = (mouseY - offsetY) / scale - dragOffset[1];
    if (draggingToken) draggingToken.position = [newX, newY];
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

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.display = "block";
}

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const { scale, offsetX, offsetY } = getTransform();

  for (const token of mapData.tokens) {
    const [x, y] = token.position;
    const sx = x * scale + offsetX;
    const sy = y * scale + offsetY;
    const radius = (mapData.grid_settings.cell_size * scale) / 2;

    if (Math.hypot(e.offsetX - sx, e.offsetY - sy) <= radius) {
      e.preventDefault();
      selectedTokenId = token.id;
      renderTokenContextMenu(token, e.pageX, e.pageY);
      return;
    }
  }

  if (drawingZone) {
    e.preventDefault(); // предотвращаем стандартное поведение ПКМ (например, контекстное меню)

    // Если в текущей зоне меньше 3 точек, не завершаем рисование
    if (currentZoneVertices.length < 3) {
      alert("Зона должна иметь минимум 3 точки.");
      return;
    }

    // Запрашиваем имя зоны только после того, как рисование завершено
    const newZoneVertices = [...currentZoneVertices]; // <-- СНАЧАЛА копируем
    pendingZoneVertices = [...currentZoneVertices];
    drawingZone = false;
    currentZoneVertices = [];

    document.getElementById("zoneName").value = "";
    document.getElementById("zoneDescription").value = "";
    document.getElementById("zoneModalTitle").textContent = "Создание зоны";
    document.getElementById("zoneModal").style.display = "flex";
    document.getElementById("zoneVisibleCheckbox").checked = true;

    // Проверяем на пересечение с другими зонами
    const hasIntersection = mapData.zones.some(z =>
      z.vertices && z.vertices.length >= 3 && zonesIntersect(z.vertices, newZoneVertices)
    );

    if (hasIntersection) {
      alert("Новая зона пересекается с существующей! Измените форму.");
      return;
    }
    return; // Останавливаем выполнение, чтобы избежать дальнейших действий
  }

  // ПКМ по находке
  for (const find of mapData.finds) {
    const [x, y] = find.position;
    const sx = x * scale + offsetX;
    const sy = y * scale + offsetY;
    const radius = (mapData.grid_settings.cell_size * scale) / 2;

    if (Math.hypot(e.offsetX - sx, e.offsetY - sy) <= radius) {
      e.preventDefault();
      openFindModal(find);
      return;
    }
  }

  // ПКМ по зоне — смена видимости
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

      // Сохраняем текущую зону
      selectedZoneId = zone.id;
      pendingZoneVertices = [...zone.vertices]; // ← если нужно редактировать позже координаты

      // Заполняем поля модалки
      document.getElementById("zoneName").value = zone.name || "";
      document.getElementById("zoneDescription").value = zone.description || "";
      document.getElementById("zoneVisibleCheckbox").checked = zone.is_visible ?? true;

      document.getElementById("zoneModalTitle").textContent = "Редактирование зоны";
      document.getElementById("zoneModal").style.display = "flex";

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

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();

  // нормализуем поведение скролла
  const zoomStep = 0.1;
  const delta = e.deltaY > 0 ? -zoomStep : zoomStep;

  zoomLevel = Math.min(Math.max(zoomLevel + delta, 0.1), 5);
  mapData.zoom_level = zoomLevel;
  render();
  saveMapData();
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
      saveMapData(); // ← сохраняем изменения
      render();
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
    updateSidebar();
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
  } else {
    editingFindId = null;
    title.textContent = "Создание находки";
    document.getElementById("findName").value = "";
    document.getElementById("findDescription").value = "";
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

  const editing = !!selectedZoneId;

  if (!editing) {
    // Проверка на пересечение только при создании новой зоны
    const hasIntersection = mapData.zones.some(z =>
      z.vertices && z.vertices.length >= 3 && zonesIntersect(z.vertices, pendingZoneVertices)
    );

    if (hasIntersection) {
      alert("Новая зона пересекается с существующей! Измените форму.");
      return;
    }
  }

  if (editing) {
    // Редактируем существующую зону
    const zone = mapData.zones.find(z => z.id === selectedZoneId);
    if (zone) {
      zone.name = name;
      zone.description = description;
      zone.is_visible = isVisible;
    }
  } else {
    // Создаём новую зону
    const newZone = {
      id: `zone_${Date.now()}`,
      name,
      description,
      vertices: [...pendingZoneVertices],
      is_visible: isVisible,
    };
    mapData.zones.push(newZone);
  }

  // Очистка и завершение
  selectedZoneId = null;
  pendingZoneVertices = null;
  document.getElementById("zoneModal").style.display = "none";
  render();
  updateSidebar();

  fetch("/api/map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mapData),
  });
}


function submitFind() {
  const name = document.getElementById("findName").value.trim();
  const description = document.getElementById("findDescription").value.trim();

  if (!name) {
    alert("Введите имя находки");
    return;
  }

  if (editingFindId) {
    // Редактирование
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
    // Создание
    const centerX = mapImage.width / 2;
    const centerY = mapImage.height / 2;

    const find = {
      id: `find_${Date.now()}`,
      name,
      position: [centerX, centerY],
      size: mapData.grid_settings.cell_size,
      status: false,
      description
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
  const adjustedPercent = Math.min(rawPercent + 2, 100); // +2% для смягчения края
  gridSlider.style.setProperty('--percent', `${adjustedPercent}%`);
}

window.onload = () => {
  fetchMap();

  const toggleBtn = document.getElementById("togglePlayerMini");
  const miniFrame = document.getElementById("playerMini");
  let playerVisible = false;

  function updateMiniToggleIcon() {
    toggleBtn.innerHTML = playerVisible ? getOpenEyeSVG() : getClosedEyeSVG();
  }

  toggleBtn.addEventListener("click", () => {
    playerVisible = !playerVisible;
    miniFrame.style.display = playerVisible ? "block" : "none";
    updateMiniToggleIcon();
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
    rulerStart = null;

    if (!isRulerMode) {
      mapData.ruler_start = null;
      mapData.ruler_end = null;
      saveMapData();
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
    playerRulerToggle.classList.toggle("active", !current);
    saveMapData();
  });

  document.addEventListener("click", (e) => {
    const menu = document.getElementById("tokenContextMenu");
    if (!menu.contains(e.target)) {
      menu.style.display = "none";
    }
  });

  updateSliderVisual();
};