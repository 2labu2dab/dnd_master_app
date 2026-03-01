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
TOKENS_AVATARS_DIR = os.path.join(DATA_DIR, "token_avatars")  # Папка для аватаров токенов

def ensure_dirs():
    """Создать необходимые директории"""
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(MAPS_DIR, exist_ok=True)
    os.makedirs(IMAGES_DIR, exist_ok=True)
    os.makedirs(TOKENS_AVATARS_DIR, exist_ok=True)  # Добавляем создание папки для аватаров

def get_token_avatar_filepath(token_id):
    """Получить путь к файлу аватара токена"""
    return os.path.join(TOKENS_AVATARS_DIR, f"{token_id}.png")

def save_token_avatar(image_data, token_id):
    """Сохранить аватар токена как файл"""
    try:
        print(f"Attempting to save avatar for token {token_id}")
        print(f"Image data type: {type(image_data)}")
        print(f"Image data preview: {str(image_data)[:100] if image_data else 'None'}")
        
        # Если пришла base64 строка
        if isinstance(image_data, str) and image_data.startswith('data:image'):
            print("Detected base64 image data")
            # Извлекаем base64 данные
            header, encoded = image_data.split(',', 1)
            print(f"Image header: {header}")
            image_bytes = base64.b64decode(encoded)
            print(f"Decoded {len(image_bytes)} bytes")
        elif isinstance(image_data, bytes):
            print("Detected bytes image data")
            image_bytes = image_data
        else:
            print(f"Unsupported image data type: {type(image_data)}")
            return False
        
        # Оптимизируем изображение
        img = Image.open(io.BytesIO(image_bytes))
        print(f"Image opened: {img.size}, mode: {img.mode}")
        
        # Конвертируем в RGBA для поддержки прозрачности
        if img.mode != 'RGBA':
            print(f"Converting from {img.mode} to RGBA")
            img = img.convert('RGBA')
        
        # Изменяем размер если слишком большое
        max_size = 256
        if img.width > max_size or img.height > max_size:
            print(f"Resizing from {img.size} to max {max_size}")
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        
        # Сохраняем как PNG для поддержки прозрачности
        img_path = get_token_avatar_filepath(token_id)
        print(f"Saving to: {img_path}")
        
        # Убедимся, что директория существует
        os.makedirs(os.path.dirname(img_path), exist_ok=True)
        
        img.save(img_path, 'PNG', optimize=True)
        print(f"Avatar saved successfully, file exists: {os.path.exists(img_path)}")
        
        return True
    except Exception as e:
        print(f"Error saving token avatar: {e}")
        import traceback
        traceback.print_exc()
        return False

def load_token_avatar(token_id):
    """Загрузить аватар токена и вернуть base64 для отображения"""
    img_path = get_token_avatar_filepath(token_id)
    if os.path.exists(img_path):
        try:
            with open(img_path, 'rb') as f:
                img_bytes = f.read()
                return f"data:image/png;base64,{base64.b64encode(img_bytes).decode('utf-8')}"
        except Exception as e:
            print(f"Error loading token avatar: {e}")
    return None

def delete_token_avatar(token_id):
    """Удалить аватар токена"""
    img_path = get_token_avatar_filepath(token_id)
    if os.path.exists(img_path):
        os.remove(img_path)
        return True
    return False

def get_token_avatar_url(token_id):
    """Получить URL для загрузки аватара токена"""
    if not token_id:
        return None
    # Убедимся, что URL начинается с /
    return f"/api/token/avatar/{token_id}"

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
    
    # Убедимся, что у токенов сохраняются has_avatar
    if "tokens" in data:
        for token in data["tokens"]:
            # Удаляем avatar_data если он есть (он не должен сохраняться)
            token.pop("avatar_data", None)
            # НЕ удаляем avatar_url - пусть сохраняется в JSON
            # token.pop("avatar_url", None)  # ← ЗАКОММЕНТИРОВАТЬ или УДАЛИТЬ эту строку
    
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)