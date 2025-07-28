# ====== utils/storage.py ======
import json
import os

DATA_FILE = os.path.join("data", "map_data.json")

def load_map_data():
    if not os.path.exists("data/map_data.json"):
        return {
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
            }
        }
    with open("data/map_data.json", "r", encoding="utf-8") as f:
        return json.load(f)

def save_map_data(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
