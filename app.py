from flask import Flask, render_template, jsonify, request, redirect, session, send_file
from flask_socketio import SocketIO, emit
from utils.storage import (
    load_map_data, save_map_data, list_maps, create_new_map, 
    delete_map, load_map_image, get_image_filepath, save_map_image,
    save_token_avatar, get_token_avatar_url, TOKENS_AVATARS_DIR  # Добавьте эти импорты
)
import os
import time
from PIL import Image
import io
import base64
import uuid

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-here'
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB max file size
# Важно: настройка CORS для Socket.IO
socketio = SocketIO(
    app, 
    cors_allowed_origins="*", 
    logger=True, 
    engineio_logger=True, 
    ping_timeout=60, 
    ping_interval=25,
    max_http_buffer_size=50e6  # 50MB для больших файлов
)

# Кэш для throttle
last_ruler_updates = {}

import os

print("=" * 50)
print("Starting server...")
print(f"Current working directory: {os.getcwd()}")

# Создаем папки и проверяем права
data_dir = "data"
token_avatars_dir = os.path.join(data_dir, "token_avatars")

# Создаем папки
os.makedirs(data_dir, exist_ok=True)
os.makedirs(token_avatars_dir, exist_ok=True)

print(f"Data dir exists: {os.path.exists(data_dir)}")
print(f"Data dir writable: {os.access(data_dir, os.W_OK)}")
print(f"Token avatars dir exists: {os.path.exists(token_avatars_dir)}")
print(f"Token avatars dir writable: {os.access(token_avatars_dir, os.W_OK)}")

# Пробуем создать тестовый файл
test_file = os.path.join(token_avatars_dir, "test.txt")
try:
    with open(test_file, 'w') as f:
        f.write("test")
    print("✓ Test file created successfully")
    os.remove(test_file)
    print("✓ Test file removed")
except Exception as e:
    print(f"✗ Failed to create test file: {e}")
print("=" * 50)

@app.route("/")
def index():
    maps = list_maps()
    current_map_id = None
    
    # Если есть карты, выбираем первую
    if maps:
        current_map_id = maps[0]["id"]
        session['current_map_id'] = current_map_id
    else:
        session['current_map_id'] = None
    
    return render_template("index.html", maps=maps, current_map=current_map_id)

@app.route("/api/maps", methods=["GET"])
def get_maps():
    """Получить список всех карт"""
    return jsonify(list_maps())

@app.route("/api/map/<map_id>", methods=["GET"])
def get_map(map_id):
    """Получить данные конкретной карты"""
    data = load_map_data(map_id)
    if data is None:
        return jsonify({"error": "Map not found"}), 404
    
    # Добавляем изображение отдельно, если оно есть
    image_base64 = load_map_image(map_id)
    if image_base64:
        data["map_image_base64"] = image_base64
    
    # Добавляем URL аватаров для токенов
    if "tokens" in data:
        for token in data["tokens"]:
            if token.get("has_avatar"):
                from utils.storage import get_token_avatar_url
                token["avatar_url"] = get_token_avatar_url(token["id"])
                print(f"Token {token['id']} avatar URL in get_map: {token['avatar_url']}")  # Для отладки
            # Удаляем старые данные аватара если они есть
            token.pop("avatar_data", None)
    
    # Добавляем URL аватаров для персонажей
    if "characters" in data:
        for character in data["characters"]:
            if character.get("has_avatar"):
                from utils.storage import get_token_avatar_url
                character["avatar_url"] = get_token_avatar_url(character["id"])
            character.pop("avatar_data", None)
    
    old_map_id = session.get('current_map_id')
    session['current_map_id'] = map_id
    
    # Если карта действительно сменилась (не та же самая)
    if old_map_id and old_map_id != map_id:
        # Уведомляем всех о смене карты
        socketio.emit("master_switched_map", {
            "map_id": map_id
        })
        print(f"Map switched from {old_map_id} to {map_id}")
    
    return jsonify(data)

@app.route("/api/map/image/<map_id>")
def get_map_image(map_id):
    """Получить изображение карты как файл"""
    image_path = get_image_filepath(map_id)
    if os.path.exists(image_path):
        return send_file(image_path, mimetype='image/jpeg')
    return "", 404

@app.route("/api/map", methods=["POST"])
def save_map():
    """Сохранить текущую карту"""
    data = request.get_json()
    map_id = session.get('current_map_id')
    
    if not map_id:
        return jsonify({"error": "No map selected"}), 400
    
    # Сохраняем данные (изображение будет обработано в save_map_data)
    save_map_data(data, map_id)
    
    # Подготавливаем данные для игроков (исключаем zoom/pan данные)
    # ВАЖНО: добавляем URL аватаров для токенов
    tokens_for_players = []
    for token in data.get("tokens", []):
        token_copy = token.copy()
        if token_copy.get("has_avatar"):
            from utils.storage import get_token_avatar_url
            token_copy["avatar_url"] = get_token_avatar_url(token_copy["id"])
        # Удаляем avatar_data если есть (не нужно в player)
        token_copy.pop("avatar_data", None)
        tokens_for_players.append(token_copy)
    
    player_data = {
        "map_id": map_id,
        "tokens": tokens_for_players,  # ← Используем обработанные токены
        "zones": data.get("zones", []),
        "finds": data.get("finds", []),
        "grid_settings": data.get("grid_settings", {}),
        "ruler_visible_to_players": data.get("ruler_visible_to_players", False),
        "ruler_start": data.get("ruler_start"),
        "ruler_end": data.get("ruler_end"),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False)
    }
    
    # Если есть изображение, добавляем URL для загрузки
    if data.get("has_image"):
        player_data["image_url"] = f"/api/map/image/{map_id}?t={int(time.time())}"
    
    socketio.emit("map_updated", player_data)
    return jsonify({"status": "ok"})

@app.route("/api/map/new", methods=["POST"])
def new_map():
    """Создать новую карту"""
    map_data = request.get_json()
    name = map_data.get('name', 'Новая карта')
    
    map_id = create_new_map(name)
    session['current_map_id'] = map_id
    
    # Получаем обновленный список карт
    maps = list_maps()
    
    # Отправляем событие о создании новой карты всем клиентам
    socketio.emit("map_created", {
        "map_id": map_id,
        "maps": maps,
        "current_map": map_id
    })
    
    return jsonify({
        "status": "ok",
        "map_id": map_id,
        "maps": maps,
        "current_map": map_id
    })

@app.route("/api/map/delete/<map_id>", methods=["DELETE"])
def delete_map_route(map_id):
    """Удалить карту"""
    if delete_map(map_id):
        # Если удалили текущую карту
        if session.get('current_map_id') == map_id:
            maps = list_maps()
            if maps:
                session['current_map_id'] = maps[0]["id"]
            else:
                session['current_map_id'] = None
        return jsonify({"status": "ok", "maps": list_maps()})
    return jsonify({"status": "error"}), 404

@app.route("/api/token/avatar/<token_id>", methods=["DELETE"])
def delete_token_avatar(token_id):
    """Удалить аватар токена"""
    from utils.storage import delete_token_avatar
    if delete_token_avatar(token_id):
        return jsonify({"status": "ok"})
    return jsonify({"status": "error"}), 404

@app.route("/api/token/avatar/<token_id>")
def get_token_avatar(token_id):
    """Получить аватар токена как файл"""
    from utils.storage import get_token_avatar_filepath
    image_path = get_token_avatar_filepath(token_id)
    print(f"Looking for token avatar at: {image_path}")
    print(f"File exists: {os.path.exists(image_path)}")
    
    if os.path.exists(image_path):
        print(f"File size: {os.path.getsize(image_path)} bytes")
        return send_file(image_path, mimetype='image/png')
    
    # Если файл не найден, проверим содержимое папки
    print(f"Files in token_avatars dir:")
    token_avatars_dir = os.path.dirname(image_path)
    if os.path.exists(token_avatars_dir):
        for f in os.listdir(token_avatars_dir):
            print(f"  - {f}")
    
    return "", 404

@app.route("/api/tokens", methods=["GET"])
def get_tokens():
    map_id = session.get('current_map_id')
    if not map_id:
        return jsonify([])
    data = load_map_data(map_id)
    return jsonify(data.get("tokens", []) if data else [])

@app.route("/api/zones", methods=["GET"])
def get_zones():
    map_id = session.get('current_map_id')
    if not map_id:
        return jsonify([])
    data = load_map_data(map_id)
    return jsonify(data.get("zones", []) if data else [])

@app.route("/api/finds", methods=["GET"])
def get_finds():
    map_id = session.get('current_map_id')
    if not map_id:
        return jsonify([])
    data = load_map_data(map_id)
    return jsonify(data.get("finds", []) if data else [])

@app.route("/api/token", methods=["POST"])
def add_token():
    print("\n" + "="*50)
    print("TOKEN API CALLED")
    print("="*50)
    
    # Получаем данные запроса ТОЛЬКО ОДИН РАЗ
    try:
        token = request.get_json()
        print(f"Received JSON data: {token}")
    except Exception as e:
        print(f"Error parsing JSON: {e}")
        return jsonify({"error": "Invalid JSON"}), 400
    
    # Извлекаем avatar_data из полученных данных
    avatar_data = token.pop("avatar_data", None) if token else None
    
    print(f"Token data: {token}")
    print(f"Avatar data present: {bool(avatar_data)}")
    print(f"Avatar data type: {type(avatar_data)}")
    if avatar_data:
        print(f"Avatar data length: {len(avatar_data)}")
        print(f"Avatar data preview: {avatar_data[:100]}...")
    
    map_id = session.get('current_map_id')
    if not map_id:
        print("No map selected")
        return jsonify({"error": "No map selected"}), 400
        
    data = load_map_data(map_id)
    if not data:
        print(f"Map {map_id} not found")
        return jsonify({"error": "Map not found"}), 404
    
    # Сохраняем аватар как файл, если он есть
    if avatar_data:
        print(f"\n=== Calling save_token_avatar for token {token['id']} ===")
        success = save_token_avatar(avatar_data, token["id"])
        if success:
            token["has_avatar"] = True
            print(f"✓ Avatar saved successfully")
        else:
            token["has_avatar"] = False
            print(f"✗ Failed to save avatar")
    else:
        token["has_avatar"] = False
        print("No avatar data provided")
    
    data.setdefault("tokens", []).append(token)
    save_map_data(data, map_id)
    
    # Подготавливаем данные для игроков (без base64)
    tokens_for_players = []
    for token in data.get("tokens", []):
        token_copy = token.copy()
        if token_copy.get("has_avatar"):
            from utils.storage import get_token_avatar_url
            token_copy["avatar_url"] = get_token_avatar_url(token_copy["id"])
        tokens_for_players.append(token_copy)
    
    # Отправляем обновление всем игрокам
    player_data = {
        "map_id": map_id,
        "tokens": tokens_for_players,
        "zones": data.get("zones", []),
        "finds": data.get("finds", []),
        "grid_settings": data.get("grid_settings", {}),
        "ruler_visible_to_players": data.get("ruler_visible_to_players", False),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False)
    }
    
    if data.get("has_image"):
        player_data["image_url"] = f"/api/map/image/{map_id}?t={int(time.time())}"
    
    socketio.emit("map_updated", player_data)
    return jsonify({"status": "token added"})

@app.route('/favicon.ico')
def favicon():
    return '', 204

@app.route("/player")
def player_view():
    map_id = request.args.get('map_id')
    if not map_id:
        # Если map_id не передан, берем текущую карту из сессии мастера
        map_id = session.get('current_map_id')
        
        # Если и в сессии нет, берем первую из списка
        if not map_id:
            maps = list_maps()
            map_id = maps[0]["id"] if maps else None
    
    # Передаем map_id в шаблон
    return render_template("player.html", map_id=map_id)

@app.route("/api/zone", methods=["POST"])
def add_zone():
    zone = request.get_json()
    map_id = session.get('current_map_id')
    if not map_id:
        return jsonify({"error": "No map selected"}), 400
        
    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404
        
    data.setdefault("zones", []).append(zone)
    save_map_data(data, map_id)
    
    # Отправляем обновление всем игрокам
    player_data = {
        "map_id": map_id,
        "tokens": data.get("tokens", []),
        "zones": data.get("zones", []),
        "finds": data.get("finds", []),
        "grid_settings": data.get("grid_settings", {}),
        "ruler_visible_to_players": data.get("ruler_visible_to_players", False),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False)
    }
    
    if data.get("has_image"):
        player_data["image_url"] = f"/api/map/image/{map_id}?t={int(time.time())}"
    
    socketio.emit("map_updated", player_data)
    return jsonify({"status": "zone added"})

@app.route("/api/find", methods=["POST"])
def add_find():
    find = request.get_json()
    map_id = session.get('current_map_id')
    if not map_id:
        return jsonify({"error": "No map selected"}), 400
        
    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404
        
    data.setdefault("finds", []).append(find)
    save_map_data(data, map_id)
    
    # Отправляем обновление всем игрокам
    player_data = {
        "map_id": map_id,
        "tokens": data.get("tokens", []),
        "zones": data.get("zones", []),
        "finds": data.get("finds", []),
        "grid_settings": data.get("grid_settings", {}),
        "ruler_visible_to_players": data.get("ruler_visible_to_players", False),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False)
    }
    
    if data.get("has_image"):
        player_data["image_url"] = f"/api/map/image/{map_id}?t={int(time.time())}"
    
    socketio.emit("map_updated", player_data)
    return jsonify({"status": "find added"})

@app.route("/upload_map", methods=["POST"])
def upload_map():
    """Загрузить изображение карты"""
    if "map_image" not in request.files:
        return "No file", 400
    file = request.files["map_image"]
    if file.filename == "":
        return "No selected file", 400

    map_id = session.get('current_map_id')
    if not map_id:
        # Если нет текущей карты, создаем новую
        map_id = create_new_map("Новая карта")
        session['current_map_id'] = map_id
    
    # Сохраняем изображение
    if save_map_image(file.read(), map_id):
        # Обновляем данные карты
        data = load_map_data(map_id)
        data["has_image"] = True
        save_map_data(data, map_id)
        
        # Получаем изображение в base64 для мастера
        image_base64 = load_map_image(map_id)
        
        # Отправляем обновление мастеру (с base64 для немедленного отображения)
        socketio.emit("map_image_updated", {
            "map_id": map_id,
            "map_image_base64": image_base64,
            "has_image": True
        }, room=request.sid)
        
        # Подготавливаем данные для игроков
        player_data = {
            "map_id": map_id,
            "tokens": data.get("tokens", []),
            "zones": data.get("zones", []),
            "finds": data.get("finds", []),
            "grid_settings": data.get("grid_settings", {}),
            "ruler_visible_to_players": data.get("ruler_visible_to_players", False),
            "player_map_enabled": data.get("player_map_enabled", True),
            "has_image": True,
            "image_url": f"/api/map/image/{map_id}?t={int(time.time())}"
        }
        
        # Отправляем ВСЕМ игрокам (включая того, кто уже подключен)
        socketio.emit("map_updated", player_data, broadcast=True)
        
        # Также отправляем специальное событие для принудительной перезагрузки изображения
        socketio.emit("force_image_reload", {
            "map_id": map_id,
            "image_url": f"/api/map/image/{map_id}?t={int(time.time())}"
        }, broadcast=True)
    
    return redirect("/")

@socketio.on("notify_image_loaded")
def handle_notify_image_loaded(data):
    """Обработчик уведомления о загрузке изображения мастером"""
    map_id = data.get('map_id')
    image_url = data.get('image_url')
    
    if map_id and image_url:
        # Отправляем всем игрокам
        emit("force_image_reload", {
            "map_id": map_id,
            "image_url": image_url
        }, broadcast=True, include_self=False)

@socketio.on("connect")
def handle_connect():
    print(f"Client connected: {request.sid}")

@socketio.on("disconnect")
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")

@socketio.on("ruler_update")
def handle_ruler_update(data):
    """Обработчик обновления линейки с throttle"""
    # Всегда берем map_id из данных, не из сессии!
    map_id = data.get('map_id')
    if not map_id:
        print("No map_id in ruler_update")
        return
    
    client_id = request.sid
    current_time = time.time()
    
    # Throttle: обновляем не чаще чем раз в 50ms
    if client_id in last_ruler_updates:
        if current_time - last_ruler_updates[client_id] < 0.05:  # 50ms
            return
    
    last_ruler_updates[client_id] = current_time
    
    # Сохраняем в данные карты
    map_data = load_map_data(map_id)
    if map_data:
        map_data["ruler_start"] = data.get("ruler_start")
        map_data["ruler_end"] = data.get("ruler_end")
        save_map_data(map_data, map_id)
    
    # Отправляем всем, кроме отправителя
    emit("ruler_update", {
        "map_id": map_id,
        "ruler_start": data.get("ruler_start"),
        "ruler_end": data.get("ruler_end")
    }, broadcast=True, include_self=False)

@socketio.on("zoom_update")
def handle_zoom_update(data):
    print("Received zoom_update:", data)
    map_id = data.get('map_id')
    if not map_id:
        map_id = session.get('current_map_id')
    
    if not map_id:
        print("No map_id in zoom_update")
        return
        
    map_data = load_map_data(map_id)
    if not map_data:
        print(f"Map data not found for {map_id}")
        return
        
    map_data["zoom_level"] = data.get("zoom_level", 1)
    map_data["pan_x"] = data.get("pan_x", 0)
    map_data["pan_y"] = data.get("pan_y", 0)
    map_data["master_canvas_width"] = data.get("canvas_width", 1380)
    map_data["master_canvas_height"] = data.get("canvas_height", 1080)

    save_map_data(map_data, map_id)

    # Отправляем всем, кроме отправителя
    emit("zoom_update", {
        "map_id": map_id,
        "zoom_level": map_data["zoom_level"],
        "pan_x": map_data["pan_x"],
        "pan_y": map_data["pan_y"]
    }, broadcast=True, include_self=False)
    print(f"Sent zoom_update to others for map {map_id}")
    
@socketio.on("switch_map")
def handle_switch_map(data):
    """Обработчик смены карты мастером"""
    map_id = data.get('map_id')
    print(f"Received switch_map event for map: {map_id} from client {request.sid}")
    
    # Отправляем всем КРОМЕ отправителя, что карта сменилась
    emit("master_switched_map", {
        "map_id": map_id
    }, broadcast=True, include_self=False)
    print(f"Notified players about map switch to {map_id}")

@socketio.on("request_map_sync")
def handle_map_sync(data):
    """Обработчик запроса синхронизации карты от клиента"""
    map_id = data.get('map_id')
    if not map_id:
        map_id = session.get('current_map_id')
    
    if map_id:
        map_data = load_map_data(map_id)
        if map_data:
            # Отправляем только этому клиенту
            emit("map_sync", {
                "map_id": map_id,
                "zoom_level": map_data.get("zoom_level", 1),
                "pan_x": map_data.get("pan_x", 0),
                "pan_y": map_data.get("pan_y", 0)
            })
@socketio.on("player_visibility_change")
def handle_player_visibility_change(data):
    """Обработчик изменения видимости карты для игроков"""
    map_id = data.get('map_id')
    if not map_id:
        return
    
    print(f"Player visibility changed for map {map_id}: {data.get('player_map_enabled')}")
    
    # Загружаем данные карты, чтобы получить актуальную информацию об изображении
    map_data = load_map_data(map_id)
    has_image = map_data.get("has_image", False) if map_data else False
    
    # Сохраняем новое значение в данные карты
    if map_data:
        map_data["player_map_enabled"] = data.get("player_map_enabled", True)
        save_map_data(map_data, map_id)
    
    # Подготавливаем данные для отправки
    visibility_data = {
        "map_id": map_id,
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": has_image
    }
    
    # Если карта стала видимой и есть изображение, добавляем URL
    if data.get("player_map_enabled", True) and has_image:
        visibility_data["image_url"] = f"/api/map/image/{map_id}?t={int(time.time())}"
    
    # Отправляем всем игрокам
    emit("map_visibility_change", visibility_data, broadcast=True, include_self=False)
    
    # Если карта стала видимой, также отправляем полные данные
    if data.get("player_map_enabled", True) and map_data:
        # Подготавливаем полные данные карты для игроков
        tokens_for_players = []
        for token in map_data.get("tokens", []):
            token_copy = token.copy()
            if token_copy.get("has_avatar"):
                from utils.storage import get_token_avatar_url
                token_copy["avatar_url"] = get_token_avatar_url(token_copy["id"])
            token_copy.pop("avatar_data", None)
            tokens_for_players.append(token_copy)
        
        full_update = {
            "map_id": map_id,
            "tokens": tokens_for_players,
            "zones": map_data.get("zones", []),
            "finds": map_data.get("finds", []),
            "grid_settings": map_data.get("grid_settings", {}),
            "ruler_visible_to_players": map_data.get("ruler_visible_to_players", False),
            "ruler_start": map_data.get("ruler_start"),
            "ruler_end": map_data.get("ruler_end"),
            "player_map_enabled": True,
            "has_image": has_image
        }
        
        if has_image:
            full_update["image_url"] = f"/api/map/image/{map_id}?t={int(time.time())}"
        
        # Небольшая задержка перед отправкой полных данных
        socketio.sleep(0.1)
        emit("map_updated", full_update, broadcast=True, include_self=False)

@socketio.on("force_map_update")
def handle_force_map_update(data):
    """Принудительное обновление карты для игроков"""
    map_id = data.get('map_id')
    if not map_id:
        return
    
    print(f"Forcing map update for map {map_id}")
    
    # Отправляем всем игрокам
    emit("map_updated", data, broadcast=True, include_self=False)
    
    # Также отправляем событие о видимости для надёжности
    emit("map_visibility_change", {
        "map_id": map_id,
        "player_map_enabled": True,
        "has_image": data.get("has_image", False),
        "image_url": data.get("image_url")
    }, broadcast=True, include_self=False)

@socketio.on("request_map_image")
def handle_request_map_image(data):
    """Обработчик запроса изображения карты"""
    map_id = data.get('map_id')
    if map_id:
        image_base64 = load_map_image(map_id)
        if image_base64:
            emit("map_image_updated", {
                "map_id": map_id,
                "map_image_base64": image_base64,
                "has_image": True
            }, room=request.sid)

@socketio.on("map_image_updated_to_player")
def handle_map_image_updated_to_player(data):
    """Обработчик уведомления об обновлении изображения карты"""
    map_id = data.get('map_id')
    if map_id:
        # Передаем всем игрокам
        emit("map_image_updated_to_player", {
            "map_id": map_id,
            "has_image": data.get("has_image", True)
        }, broadcast=True, include_self=False)
@socketio.on("ruler_visibility_change")
def handle_ruler_visibility_change(data):
    """Обработчик изменения видимости линейки для игроков"""
    map_id = data.get('map_id')
    if not map_id:
        return
    
    print(f"Ruler visibility change for map {map_id}: {data.get('ruler_visible_to_players')}")
    
    # Обновляем данные карты
    map_data = load_map_data(map_id)
    if map_data:
        map_data["ruler_visible_to_players"] = data.get("ruler_visible_to_players", False)
        save_map_data(map_data, map_id)
    
    # Отправляем всем игрокам
    emit("ruler_visibility_change", {
        "map_id": map_id,
        "ruler_visible_to_players": data.get("ruler_visible_to_players", False)
    }, broadcast=True, include_self=False)
if __name__ == "__main__":
    # Создаем необходимые директории
    os.makedirs("data", exist_ok=True)
    os.makedirs("data/maps", exist_ok=True)
    os.makedirs("data/images", exist_ok=True)
    os.makedirs("data/token_avatars", exist_ok=True)
    
    # Запускаем приложение
    os.makedirs("data", exist_ok=True)
    socketio.run(app, debug=True, port=5000, allow_unsafe_werkzeug=True)