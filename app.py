from flask import Flask, render_template, jsonify, request, redirect, session, send_file
from flask_socketio import SocketIO, emit
from utils.storage import (
    load_map_data, save_map_data, list_maps, create_new_map, 
    delete_map, load_map_image, get_image_filepath, save_map_image
)
import os
import time
from PIL import Image
import io
import base64

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
    player_data = {
        "map_id": map_id,
        "tokens": data.get("tokens", []),
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
    token = request.get_json()
    avatar_data = token.pop("avatar_data", None)

    if avatar_data:
        token["avatar_data"] = avatar_data

    map_id = session.get('current_map_id')
    if not map_id:
        return jsonify({"error": "No map selected"}), 400
        
    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404
        
    data.setdefault("tokens", []).append(token)
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
        
        # Отправляем обновление всем
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
        
        socketio.emit("map_updated", player_data)
    
    return redirect("/")

@socketio.on("connect")
def handle_connect():
    print(f"Client connected: {request.sid}")

@socketio.on("disconnect")
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")

@socketio.on("ruler_update")
def handle_ruler_update(data):
    """Обработчик обновления линейки с throttle"""
    map_id = session.get('current_map_id')
    if not map_id:
        # Пробуем получить map_id из данных
        map_id = data.get('map_id')
        if not map_id:
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

if __name__ == "__main__":
    # Создаем необходимые директории
    os.makedirs("data", exist_ok=True)
    os.makedirs("data/maps", exist_ok=True)
    os.makedirs("data/images", exist_ok=True)
    
    # Запускаем приложение
    os.makedirs("data", exist_ok=True)
    socketio.run(app, debug=True, port=5000, allow_unsafe_werkzeug=True)