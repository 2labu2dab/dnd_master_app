
// static/js/player.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

let mapImage = new Image();
const avatarCache = {};
let mapData = {
  tokens: [],
  finds: [],
  zones: [],
  map_image: "",
  grid_settings: { cell_size: 20, color: "#888888", visible: true }
};

function fetchMap() {
  fetch(`/api/map?ts=${Date.now()}`)
    .then(res => res.json())
    .then(data => {
      mapData = data;
      if (!mapData.tokens) mapData.tokens = [];
      if (!mapData.finds) mapData.finds = [];
      if (!mapData.zones) mapData.zones = [];
      if (!mapData.grid_settings) mapData.grid_settings = { cell_size: 20, color: "#888888", visible: true };

      if (mapData.map_image_base64) {
        mapImage = new Image();
        mapImage.onload = () => render();
        mapImage.src = mapData.map_image_base64;
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
}

function drawLayers(offsetX, offsetY, scale) {
  if (mapData.grid_settings.visible && mapData.grid_settings.visible_to_players) {
    drawGrid(offsetX, offsetY, scale);
  }

  // Отрисовать блюр-зоны (is_visible = false)
  mapData.zones.forEach(z => {
    if (z.is_visible === false) {
      drawBlurredZone(z, offsetX, offsetY, scale);
    }
  });

  mapData.tokens.forEach(t => {
    if (t.is_visible !== false) drawToken(t, offsetX, offsetY, scale);
  });
}

function drawGrid(offsetX, offsetY, scale) {
  const size = mapData.grid_settings.cell_size * scale;
  ctx.strokeStyle = mapData.grid_settings.color || "#888";
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

  ctx.beginPath();
  ctx.arc(sx, sy, size / 2, 0, 2 * Math.PI);
  ctx.strokeStyle = token.is_player
    ? "#4CAF50"
    : token.is_npc
    ? "#FFC107"
    : "#F44336";
  ctx.lineWidth = 2;
  ctx.stroke();

  const avatarSrc = token.avatar_data || (token.avatar ? `/static/${token.avatar}` : null);
  const cached = avatarCache[token.id];

  if (avatarSrc) {
    if (!cached) {
      const img = new Image();
      img.onload = () => render();
      img.onerror = () => {
        console.warn(`⚠ Не удалось загрузить аватар: ${avatarSrc}`);
        avatarCache[token.id] = null; // помечаем как битый
      };
      img.src = avatarSrc;
      avatarCache[token.id] = img;
    } else if (cached instanceof HTMLImageElement && cached.complete && cached.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, size / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(cached, sx - size / 2, sy - size / 2, size, size);
      ctx.restore();
    } else {
      // ничего не рисуем — картинка в загрузке или битая
    }
  } else {
    // fallback-круг
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

  // подпись
  ctx.fillStyle = "white";
  const fontSize = Math.max(mapData.grid_settings.cell_size * 0.5 * scale, 8);
  ctx.font = `${fontSize}px Segoe UI`;
  ctx.textAlign = "center";
  ctx.fillText(token.name, sx, sy + size / 2 + fontSize);
}

function drawFind(find, offsetX, offsetY, scale) {
  const [x, y] = find.position;
  const sx = x * scale + offsetX;
  const sy = y * scale + offsetY;
  const size = mapData.grid_settings.cell_size * scale;

  ctx.beginPath();
  ctx.fillStyle = find.status ? "#4CAF50" : "white";
  ctx.arc(sx, sy, size / 2, 0, 2 * Math.PI);
  ctx.fill();

  ctx.fillStyle = "black";
  const fontSize = Math.max(mapData.grid_settings.cell_size * 0.5 * scale, 8);
  ctx.font = `${fontSize}px Segoe UI`;
  ctx.textAlign = "center";
  ctx.fillText(find.name, sx, sy + size / 2 + fontSize);
}

function drawBlurredZone(zone, offsetX, offsetY, scale) {
  if (!zone.vertices || zone.vertices.length < 2) return;

  const transformed = zone.vertices.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);

  // Сохраняем контекст
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

// ⏱ Автообновление
setInterval(fetchMap, 1000);
window.onload = fetchMap;
