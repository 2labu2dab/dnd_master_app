# ====== app.py ======

from flask import Flask, render_template, jsonify, request, redirect
from utils.storage import load_map_data, save_map_data
from logic.models import Token, Zone, Find, GridSettings
import os

app = Flask(__name__, static_folder="static", template_folder="templates")


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

    os.makedirs("static/maps", exist_ok=True)
    filepath = os.path.join("static/maps", "current_map.png")
    try:
        file.save(filepath)
        print(f"[DEBUG] Map saved to: {filepath}")
    except Exception as e:
        print(f"[ERROR] Failed to save file: {e}")
        return f"Failed to save file: {e}", 500

    # Обновим map_data.json
    data = load_map_data()
    data["map_image"] = filepath.replace("static/", "")
    save_map_data(data)
    return redirect("/")


if __name__ == "__main__":
    os.makedirs("data", exist_ok=True)
    if not os.path.exists("data/map_data.json"):
        save_map_data({
            "tokens": [],
            "zones": [],
            "finds": [],
            "map_image": "",  # 👈 добавляем эту строку
            "grid_settings": {
                "visible": True,
                "visible_to_players": True,
                "cell_size": 20,
                "color": "#888888",
                "opacity": 100
            },
            "ruler_visible_to_players": True
        })
    app.run(debug=True, port=5000)