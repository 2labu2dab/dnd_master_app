# ====== utils/storage.py ======
import json
import os

DATA_FILE = os.path.join("data", "map_data.json")

def load_map_data():
    if not os.path.exists(DATA_FILE):
        return {}

    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Авто-дополнение grid_settings
    if "grid_settings" not in data:
        data["grid_settings"] = {
            "visible": True,
            "visible_to_players": True,
            "cell_size": 20,
            "color": "#888888",
            "opacity": 100
        }

    return data

def save_map_data(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
