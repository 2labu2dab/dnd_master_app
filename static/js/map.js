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

function autoUploadMap(input) {
  const formData = new FormData();
  formData.append("map_image", input.files[0]);

  fetch("/upload_map", {
    method: "POST",
    body: formData,
  }).then(() => fetchMap());
}

function fetchMap() {
  fetch(`/api/map?ts=${Date.now()}`)
    .then(res => res.json())
    .then(data => {
      mapData = data;
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
}

function drawLayers(offsetX, offsetY, scale) {
  if (mapData.grid_settings.visible) drawGrid(offsetX, offsetY, scale);
  mapData.zones.forEach(z => drawZone(z, offsetX, offsetY, scale)); // Отрисовываем зоны
  mapData.tokens.forEach(t => drawToken(t, offsetX, offsetY, scale));
  mapData.finds.forEach(f => drawFind(f, offsetX, offsetY, scale));
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
  ctx.fillStyle = token.is_player
    ? "#4CAF50"
    : token.is_npc
    ? "#FFC107"
    : token.is_dead
    ? "#616161"
    : "#F44336";
  ctx.arc(sx, sy, size / 2, 0, 2 * Math.PI);
  ctx.fill();

  if (token.id === selectedTokenId) {
    ctx.strokeStyle = "#00FFFF";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, size / 2 + 3, 0, 2 * Math.PI);
    ctx.stroke();
  }

  ctx.fillStyle = "white";
  const fontSize = Math.max(cellSize * 0.5 * scale, 8);
  ctx.font = `${fontSize}px Segoe UI`;
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
  ctx.font = `${fontSize}px Segoe UI`;
  ctx.textAlign = "center";
  ctx.fillText(find.name, sx, sy + size / 2 + fontSize);
}

function drawZone(zone, offsetX, offsetY, scale) {
  if (!zone.vertices || zone.vertices.length < 2) return; // Если зона не имеет вершин, не рисуем её

  ctx.beginPath();
  
  // Цвет зоны в зависимости от видимости
  ctx.strokeStyle = zone.is_visible ? "#4CAF50" : "#F44336"; // Зеленый, если видимая, и красный, если скрытая
  ctx.fillStyle = zone.is_visible ? "#A5D6A7" : "#EF9A9A";   // Светло-зеленый или светло-красный

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

  // Отображение имени зоны в центре полигона
  const centerX = transformed.reduce((a, b) => a + b[0], 0) / transformed.length;
  const centerY = transformed.reduce((a, b) => a + b[1], 0) / transformed.length;
  ctx.fillStyle = "#333";
  const fontSize = Math.max(10 * scale, 8);
  ctx.font = `${fontSize}px Segoe UI`;
  ctx.fillText(zone.name, centerX, centerY);
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

function addToken() {
  const name = prompt("Имя персонажа:");
  if (!name) return;

  const centerX = mapImage.width / 2;
  const centerY = mapImage.height / 2;

  const token = {
    id: `token_${Date.now()}`,
    name,
    position: [centerX, centerY],
    is_player: true,
    is_npc: false,
    is_dead: false,
  };

  fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(token),
  }).then(fetchMap);
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

function addZone() {
  const name = prompt("Имя зоны:");
  if (!name) return;

  const zone = {
    id: `zone_${Date.now()}`,
    name,
    vertices: [
      [100, 100],
      [150, 80],
      [200, 120],
      [160, 180],
    ],
    is_visible: true,
  };

  fetch("/api/zone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(zone),
  }).then(fetchMap);
}

function resetView() {
  fetchMap();
}

// 🎯 Обработка мыши
canvas.addEventListener("mousedown", (e) => {
  const [mouseX, mouseY] = [e.offsetX, e.offsetY];
  const scale = Math.min(canvas.width / mapImage.width, canvas.height / mapImage.height);
  const offsetX = (canvas.width - mapImage.width * scale) / 2;
  const offsetY = (canvas.height - mapImage.height * scale) / 2;

  selectedTokenId = null;
  selectedFindId = null;
  draggingToken = null;
  draggingFind = null;

  // Проверка попадания в круг радиусом равным половине клетки
  for (const token of mapData.tokens) {
    const [x, y] = token.position;
    const sx = x * scale + offsetX;
    const sy = y * scale + offsetY;
    const cellSize = mapData.grid_settings.cell_size;
    const radius = (cellSize * scale) / 2;

    if (Math.hypot(mouseX - sx, mouseY - sy) <= radius) {
      draggingToken = token;
      dragOffset = [(mouseX - sx) / scale, (mouseY - sy) / scale];
      selectedTokenId = token.id;
      render();
      return;
    }
  }

  for (const find of mapData.finds) {
    const [x, y] = find.position;
    const sx = x * scale + offsetX;
    const sy = y * scale + offsetY;
    const cellSize = mapData.grid_settings.cell_size;
    const radius = (cellSize * scale) / 2;

    if (Math.hypot(mouseX - sx, mouseY - sy) <= radius) {
      draggingFind = find;
      dragOffset = [(mouseX - sx) / scale, (mouseY - sy) / scale];
      selectedFindId = find.id;
      render();
      return;
    }
  }

  render();
});

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
