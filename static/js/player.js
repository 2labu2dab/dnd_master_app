
// static/js/player.js
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const isEmbeddedPreview = window !== window.parent;
let zoomLevel = 1;

let mapImage = new Image();
const avatarCache = {};
const socket = io();
let mapData = {
  tokens: [],
  finds: [],
  zones: [],
  map_image: "",
  ruler_visible_to_players: false,
  ruler_start: null,
  ruler_end: null,
  grid_settings: { cell_size: 20, color: "#888888", visible: true }
};

function resizeCanvasToDisplaySize() {
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;

  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }
}

window.addEventListener("resize", () => {
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;

  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }
  render();
});

function fetchMap() {
  fetch(`/api/map?ts=${Date.now()}`)
    .then(res => res.json())
    .then(data => {
      const mapImageEl = document.getElementById("mapDisabledImage");

      if (mapData.player_map_enabled === false) {
        mapImageEl.style.display = "block";
        canvas.style.display = "none";
      } else {
        mapImageEl.style.display = "none";
        canvas.style.display = "block";
      }
      mapData = data;
      zoomLevel = mapData.zoom_level;
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

socket.on("map_updated", (data) => {
  mapData = data;
  zoomLevel = mapData.zoom_level || 1;

  const mapImageEl = document.getElementById("mapDisabledImage");
  if (mapData.player_map_enabled === false) {
    mapImageEl.style.display = "block";
    canvas.style.display = "none";
    return;
  } else {
    mapImageEl.style.display = "none";
    canvas.style.display = "block";
  }

  render();
});

socket.on("ruler_update", (data) => {
  mapData.ruler_start = data.ruler_start;
  mapData.ruler_end = data.ruler_end;
  render();
});


function render() {
  resizeCanvasToDisplaySize();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const baseScale = Math.min(canvas.width / mapImage.width, canvas.height / mapImage.height);
  const scale = baseScale * zoomLevel;
  const newWidth = mapImage.width * scale;
  const newHeight = mapImage.height * scale;
  const offsetX = (canvas.width - newWidth) / 2;
  const offsetY = (canvas.height - newHeight) / 2;
  if (mapImage.complete) {
    ctx.drawImage(mapImage, offsetX, offsetY, newWidth, newHeight);
  } else {
    console.warn("[render] mapImage еще не загружено полностью");
  }
  if (!isEmbeddedPreview && mapData.ruler_visible_to_players && mapData.ruler_start && mapData.ruler_end) {
    drawMasterRuler(mapData.ruler_start, mapData.ruler_end, offsetX, offsetY, scale);
  }

  drawLayers(offsetX, offsetY, scale);
}


function drawMasterRuler(start, end, offsetX, offsetY, scale) {
  const [x1, y1] = start;
  const [x2, y2] = end;

  const sx1 = x1 * scale + offsetX;
  const sy1 = y1 * scale + offsetY;
  const sx2 = x2 * scale + offsetX;
  const sy2 = y2 * scale + offsetY;

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

function drawLayers(offsetX, offsetY, scale) {
  if (!isEmbeddedPreview && mapData.grid_settings.visible && mapData.grid_settings.visible_to_players) {
    drawGrid(offsetX, offsetY, scale);
  }

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
  ctx.strokeStyle = token.is_dead
    ? "#999"
    : token.is_player
      ? "#4CAF50"
      : token.is_npc
        ? "#FFC107"
        : "#F44336";
  ctx.lineWidth = 4;
  ctx.stroke();

  const avatarSrc = token.avatar_data || (token.avatar ? `/static/${token.avatar}` : null);
  const cached = avatarCache[token.id];

  if (avatarSrc) {
    if (!cached) {
      const img = new Image();
      img.onload = () => render();
      img.onerror = () => {
        console.warn(`⚠ Не удалось загрузить аватар: ${avatarSrc}`);
        avatarCache[token.id] = null;
      };
      img.src = avatarSrc;
      avatarCache[token.id] = img;
    } else if (cached instanceof HTMLImageElement && cached.complete && cached.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, size / 2, 0, Math.PI * 2);
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
        ctx.drawImage(tempCanvas, sx - size / 2, sy - size / 2, size, size);
      } else {
        ctx.drawImage(cached, sx - size / 2, sy - size / 2, size, size);
      }
      ctx.restore();
    } else {

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
    ctx.arc(sx, sy, size / 2, 0, 2 * Math.PI);
    ctx.fill();
  }
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
window.onload = fetchMap;
