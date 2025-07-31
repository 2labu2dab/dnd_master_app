# app.py
from flask import Flask, render_template, jsonify, request, redirect
from flask_socketio import SocketIO, emit
from utils.storage import load_map_data, save_map_data
import os
import base64

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")  # Включаем WebSocket


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/map", methods=["GET"])
def get_map():
    data = load_map_data()
    return jsonify(data)


@app.route("/api/map", methods=["POST"])
def save_map():
    data = request.get_json()
    save_map_data(data)
    socketio.emit("map_updated", data)  # ⬅ отправляем обновление всем
    return jsonify({"status": "ok"})


@app.route("/api/tokens", methods=["GET"])
def get_tokens():
    data = load_map_data()
    return jsonify(data.get("tokens", []))


@app.route("/api/zones", methods=["GET"])
def get_zones():
    data = load_map_data()
    return jsonify(data.get("zones", []))


@app.route("/api/finds", methods=["GET"])
def get_finds():
    data = load_map_data()
    return jsonify(data.get("finds", []))


@app.route("/api/token", methods=["POST"])
def add_token():
    token = request.get_json()
    avatar_data = token.pop("avatar_data", None)

    if avatar_data:
        token["avatar_data"] = avatar_data  # ⬅️ сохраняем base64 прямо в JSON

    data = load_map_data()
    data.setdefault("tokens", []).append(token)
    save_map_data(data)
    return jsonify({"status": "token added"})

@app.route("/player")
def player_view():
    return render_template("player.html")


@app.route("/api/zone", methods=["POST"])
def add_zone():
    zone = request.get_json()
    data = load_map_data()
    data.setdefault("zones", []).append(zone)
    save_map_data(data)
    return jsonify({"status": "zone added"})


@app.route("/api/find", methods=["POST"])
def add_find():
    find = request.get_json()
    data = load_map_data()
    data.setdefault("finds", []).append(find)
    save_map_data(data)
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

    data = load_map_data()
    data["map_image_base64"] = base64_url
    save_map_data(data)
    return redirect("/")

@socketio.on("ruler_update")
def handle_ruler_update(data):
    emit("ruler_update", data, broadcast=True, include_self=False)

@socketio.on("zoom_update")
def handle_zoom_update(data):
    emit("zoom_update", data, broadcast=True, include_self=False)

    


if __name__ == "__main__":
    os.makedirs("data", exist_ok=True)
    if not os.path.exists("data/map_data.json"):
        save_map_data({
            "tokens": [],
            "zones": [],
            "finds": [],
            "map_image_base64": "",
            "ruler_visible_to_players": False,
            "ruler_start": None,
            "ruler_end": None,
            "grid_settings": {
                "visible": True,
                "visible_to_players": True,
                "cell_size": 20,
                "color": "#888888",
                "opacity": 100
            },
            "characters": [],
        })
    socketio.run(app, debug=True, port=5000)  # ⬅ запускаем через socketio.run