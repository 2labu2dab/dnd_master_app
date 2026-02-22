#app.py
from flask import Flask, render_template, jsonify, request, redirect, session
from flask_socketio import SocketIO, emit
from utils.storage import load_map_data, save_map_data, list_maps, create_new_map, delete_map
import os
import base64
import uuid

app = Flask(__name__)
app.secret_key = 'your-secret-key-here'  # Добавьте секретный ключ для сессий
socketio = SocketIO(app, cors_allowed_origins="*")

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
    session['current_map_id'] = map_id
    return jsonify(data)

@app.route("/api/map", methods=["POST"])
def save_map():
    """Сохранить текущую карту"""
    data = request.get_json()
    map_id = session.get('current_map_id')
    
    if not map_id:
        return jsonify({"error": "No map selected"}), 400
        
    save_map_data(data, map_id)
    socketio.emit("map_updated", {"map_id": map_id, "data": data})
    return jsonify({"status": "ok"})

@app.route("/api/map/new", methods=["POST"])
def new_map():
    """Создать новую карту"""
    map_data = request.get_json()
    name = map_data.get('name', 'Новая карта')
    
    map_id = create_new_map(name)
    session['current_map_id'] = map_id
    
    return jsonify({
        "status": "ok",
        "map_id": map_id,
        "maps": list_maps()
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
    
    socketio.emit("map_updated", {"map_id": map_id, "data": data})
    return jsonify({"status": "token added"})

@app.route("/player")
def player_view():
    map_id = request.args.get('map_id')
    if not map_id:
        maps = list_maps()
        map_id = maps[0]["id"] if maps else None
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
    
    socketio.emit("map_updated", {"map_id": map_id, "data": data})
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
    
    socketio.emit("map_updated", {"map_id": map_id, "data": data})
    return jsonify({"status": "find added"})

@app.route("/upload_map", methods=["POST"])
def upload_map():
    if "map_image" not in request.files:
        return "No file", 400
    file = request.files["map_image"]
    if file.filename == "":
        return "No selected file", 400

    image_data = file.read()
    encoded = base64.b64encode(image_data).decode("utf-8")
    base64_url = f"data:{file.mimetype};base64,{encoded}"

    map_id = session.get('current_map_id')
    if not map_id:
        # Если нет текущей карты, создаем новую
        map_id = create_new_map("Новая карта")
        session['current_map_id'] = map_id
        
    data = load_map_data(map_id)
    data["map_image_base64"] = base64_url
    save_map_data(data, map_id)
    
    socketio.emit("map_updated", {"map_id": map_id, "data": data})
    return redirect("/")

@socketio.on("ruler_update")
def handle_ruler_update(data):
    map_id = session.get('current_map_id')
    if map_id:
        emit("ruler_update", {"map_id": map_id, **data}, broadcast=True, include_self=False)

@socketio.on("zoom_update")
def handle_zoom_update(data):
    map_id = session.get('current_map_id')
    if not map_id:
        return
        
    map_data = load_map_data(map_id)
    if not map_data:
        return
        
    map_data["zoom_level"] = data.get("zoom_level", 1)
    map_data["pan_x"] = data.get("pan_x", 0)
    map_data["pan_y"] = data.get("pan_y", 0)
    map_data["master_canvas_width"] = data.get("canvas_width", 1380)
    map_data["master_canvas_height"] = data.get("canvas_height", 1080)

    save_map_data(map_data, map_id)

    emit("zoom_update", {
        "map_id": map_id,
        "zoom_level": map_data["zoom_level"],
        "pan_x": map_data["pan_x"],
        "pan_y": map_data["pan_y"]
    }, broadcast=True, include_self=False)

if __name__ == "__main__":
    os.makedirs("data", exist_ok=True)
    socketio.run(app, debug=True, port=5000)