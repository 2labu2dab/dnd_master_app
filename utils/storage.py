#utils/storage.py
import json
import os
import shutil
from datetime import datetime
import uuid

DATA_DIR = "data"
MAPS_DIR = os.path.join(DATA_DIR, "maps")

def ensure_dirs():
    """Создать необходимые директории"""
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(MAPS_DIR, exist_ok=True)

def get_map_filepath(map_id):
    """Получить путь к файлу карты"""
    return os.path.join(MAPS_DIR, f"{map_id}.json")

def list_maps():
    """Получить список всех карт"""
    ensure_dirs()
    maps = []
    
    # Читаем все JSON файлы из папки maps
    for filename in os.listdir(MAPS_DIR):
        if filename.endswith(".json"):
            map_id = filename[:-5]  # убираем .json
            filepath = os.path.join(MAPS_DIR, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                
                maps.append({
                    "id": map_id,
                    "name": data.get("name", "Безымянная карта"),
                    "created": datetime.fromtimestamp(os.path.getctime(filepath)).isoformat(),
                    "modified": datetime.fromtimestamp(os.path.getmtime(filepath)).isoformat()
                })
            except:
                continue
    
    # Сортируем по дате создания (новые сверху)
    maps.sort(key=lambda x: x["created"], reverse=True)
    return maps

def create_new_map(name="Новая карта"):
    """Создать новую карту"""
    ensure_dirs()
    map_id = str(uuid.uuid4())[:8]  # короткий ID
    
    default_data = {
        "name": name,
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
        "pan_x": 0,
        "pan_y": 0,
        "zoom_level": 1,
        "player_map_enabled": True,
        "created": datetime.now().isoformat(),
        "modified": datetime.now().isoformat()
    }
    
    save_map_data(default_data, map_id)
    return map_id

def delete_map(map_id):
    """Удалить карту"""
    filepath = get_map_filepath(map_id)
    if os.path.exists(filepath):
        os.remove(filepath)
        return True
    return False

def load_map_data(map_id):
    """Загрузить данные карты"""
    ensure_dirs()
    filepath = get_map_filepath(map_id)
    
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            return None
    return None

def save_map_data(data, map_id):
    """Сохранить данные карты"""
    ensure_dirs()
    filepath = get_map_filepath(map_id)
    
    # Добавляем/обновляем метаданные
    data["modified"] = datetime.now().isoformat()
    if "created" not in data:
        data["created"] = datetime.now().isoformat()
    
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)