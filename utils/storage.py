import json
import os
import shutil
from datetime import datetime
import uuid
import base64
from PIL import Image
import io

DATA_DIR = "data"
MAPS_DIR = os.path.join(DATA_DIR, "maps")
IMAGES_DIR = os.path.join(DATA_DIR, "images")  # Новая папка для изображений

def ensure_dirs():
    """Создать необходимые директории"""
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(MAPS_DIR, exist_ok=True)
    os.makedirs(IMAGES_DIR, exist_ok=True)

def get_map_filepath(map_id):
    """Получить путь к файлу карты"""
    return os.path.join(MAPS_DIR, f"{map_id}.json")

def get_image_filepath(map_id):
    """Получить путь к файлу изображения карты"""
    return os.path.join(IMAGES_DIR, f"{map_id}.jpg")  # Можно использовать .png если нужно

def save_map_image(image_data, map_id):
    """Сохранить изображение карты как файл"""
    try:
        # Если пришла base64 строка
        if isinstance(image_data, str) and image_data.startswith('data:image'):
            # Извлекаем base64 данные
            header, encoded = image_data.split(',', 1)
            image_bytes = base64.b64decode(encoded)
        elif isinstance(image_data, bytes):
            image_bytes = image_data
        else:
            return False
        
        # Оптимизируем изображение
        img = Image.open(io.BytesIO(image_bytes))
        
        # Конвертируем в RGB если нужно
        if img.mode in ('RGBA', 'LA', 'P'):
            rgb_img = Image.new('RGB', img.size, (255, 255, 255))
            rgb_img.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = rgb_img
        
        # Изменяем размер если слишком большое (опционально)
        max_size = 2048
        if img.width > max_size or img.height > max_size:
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        
        # Сохраняем с оптимизацией
        img_path = get_image_filepath(map_id)
        img.save(img_path, 'JPEG', quality=85, optimize=True)
        
        return True
    except Exception as e:
        print(f"Error saving map image: {e}")
        return False

def load_map_image(map_id):
    """Загрузить изображение карты и вернуть base64 для отображения"""
    img_path = get_image_filepath(map_id)
    if os.path.exists(img_path):
        try:
            with open(img_path, 'rb') as f:
                img_bytes = f.read()
                return f"data:image/jpeg;base64,{base64.b64encode(img_bytes).decode('utf-8')}"
        except Exception as e:
            print(f"Error loading map image: {e}")
    return None

def delete_map_image(map_id):
    """Удалить изображение карты"""
    img_path = get_image_filepath(map_id)
    if os.path.exists(img_path):
        os.remove(img_path)
        return True
    return False

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
                
                # Проверяем, есть ли изображение
                has_image = os.path.exists(get_image_filepath(map_id))
                
                maps.append({
                    "id": map_id,
                    "name": data.get("name", "Безымянная карта"),
                    "created": datetime.fromtimestamp(os.path.getctime(filepath)).isoformat(),
                    "modified": datetime.fromtimestamp(os.path.getmtime(filepath)).isoformat(),
                    "has_image": has_image
                })
            except Exception as e:
                print(f"Error loading map {map_id}: {e}")
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
        "has_image": False,  # Флаг наличия изображения
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
    """Удалить карту и её изображение"""
    # Удаляем JSON
    filepath = get_map_filepath(map_id)
    if os.path.exists(filepath):
        os.remove(filepath)
    
    # Удаляем изображение
    delete_map_image(map_id)
    
    return True

def load_map_data(map_id):
    """Загрузить данные карты"""
    ensure_dirs()
    filepath = get_map_filepath(map_id)
    
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            # Добавляем флаг наличия изображения если его нет
            if "has_image" not in data:
                data["has_image"] = os.path.exists(get_image_filepath(map_id))
            
            return data
        except Exception as e:
            print(f"Error loading map data: {e}")
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
    
    # Убираем base64 изображения из JSON если оно там есть
    if "map_image_base64" in data:
        # Если есть новое изображение, сохраняем его отдельно
        if data["map_image_base64"]:
            save_map_image(data["map_image_base64"], map_id)
            data["has_image"] = True
        # Удаляем base64 из данных для сохранения в JSON
        del data["map_image_base64"]
    
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)