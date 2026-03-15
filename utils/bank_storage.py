# utils/bank_storage.py
import os
import base64
import io
from PIL import Image

BANK_AVATARS_DIR = os.path.join("data", "bank_avatars")


def ensure_bank_avatars_dir():
    """Создать директорию для аватаров банка"""
    os.makedirs(BANK_AVATARS_DIR, exist_ok=True)


def get_bank_avatar_filepath(character_id):
    """Получить путь к файлу аватара персонажа из банка"""
    return os.path.join(BANK_AVATARS_DIR, f"{character_id}.png")


def save_bank_avatar(image_data, character_id):
    """Сохранить аватар для персонажа из банка"""
    try:
        print(f"Attempting to save bank avatar for character {character_id}")
        ensure_bank_avatars_dir()

        # Если пришла base64 строка
        if isinstance(image_data, str) and image_data.startswith("data:image"):
            header, encoded = image_data.split(",", 1)
            image_bytes = base64.b64decode(encoded)
        elif isinstance(image_data, bytes):
            image_bytes = image_data
        else:
            print(f"Unsupported image data type: {type(image_data)}")
            return False

        # Оптимизируем изображение
        img = Image.open(io.BytesIO(image_bytes))

        # Конвертируем в RGBA для поддержки прозрачности
        if img.mode != "RGBA":
            img = img.convert("RGBA")

        # Изменяем размер если слишком большое
        max_size = 256
        if img.width > max_size or img.height > max_size:
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

        # Сохраняем как PNG
        img_path = get_bank_avatar_filepath(character_id)
        img.save(img_path, "PNG", optimize=True)
        print(f"Bank avatar saved successfully: {img_path}")

        return True
    except Exception as e:
        print(f"Error saving bank avatar: {e}")
        import traceback

        traceback.print_exc()
        return False


def get_bank_avatar_url(character_id):
    """Получить URL для загрузки аватара из банка"""
    return f"/api/bank/avatar/{character_id}"


def delete_bank_avatar(character_id):
    """Удалить аватар персонажа из банка"""
    img_path = get_bank_avatar_filepath(character_id)
    if os.path.exists(img_path):
        try:
            os.remove(img_path)
            print(f"Deleted bank avatar for character {character_id}")
            return True
        except Exception as e:
            print(f"Error deleting bank avatar: {e}")
    return False


def bank_avatar_exists(character_id):
    """Проверить, существует ли аватар для персонажа в банке"""
    return os.path.exists(get_bank_avatar_filepath(character_id))
