import json
import os
from datetime import datetime, time
import uuid
import base64
from PIL import Image
import io
from utils.character_bank import (
    init_db,
    get_all_bank_characters,
    add_character_to_bank,
    update_character_in_bank,
    delete_character_from_bank,
    get_bank_character,
    save_bank_character_avatar,
)

DATA_DIR = "data"
MAPS_DIR = os.path.join(DATA_DIR, "maps")
IMAGES_DIR = os.path.join(DATA_DIR, "images")  # Новая папка для изображений
TOKENS_AVATARS_DIR = os.path.join(
    DATA_DIR, "token_avatars"
)  # Папка для аватаров токенов
PORTRAITS_DIR = os.path.join("data", "portrait_images")
BANK_AVATARS_DIR = os.path.join(DATA_DIR, "bank_avatars")


def get_bank_avatar_filepath(character_id):
    """Получить путь к файлу аватара персонажа из банка"""
    return os.path.join(BANK_AVATARS_DIR, f"{character_id}.png")


def save_bank_avatar(image_data, character_id):
    """Сохранить аватар для персонажа из банка"""
    try:
        print(f"Attempting to save bank avatar for character {character_id}")

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
        os.makedirs(BANK_AVATARS_DIR, exist_ok=True)

        img.save(img_path, "PNG", optimize=True)
        print(f"Bank avatar saved successfully: {img_path}")

        return True
    except Exception as e:
        print(f"Error saving bank avatar: {e}")
        import traceback

        traceback.print_exc()
        return False


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


def get_bank_avatar_url(character_id):
    """Получить URL для загрузки аватара из банка"""
    return f"/api/bank/avatar/{character_id}"


def sync_token_across_maps(token_id, updates):
    """
    Синхронизировать токен на всех картах

    Args:
        token_id: ID токена
        updates: словарь с обновленными полями (кроме позиции)

    Returns:
        list: список ID карт, где был обновлен токен
    """
    ensure_dirs()
    updated_maps = []

    print(f"\n=== Syncing token {token_id} across all maps ===")

    for filename in os.listdir(MAPS_DIR):
        if filename.endswith(".json"):
            map_id = filename[:-5]
            filepath = os.path.join(MAPS_DIR, filename)

            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)

                # Проверяем, есть ли токен на этой карте
                token_updated = False
                if "tokens" in data:
                    for token in data["tokens"]:
                        if token.get("id") == token_id:
                            # Обновляем поля (кроме позиции)
                            for key, value in updates.items():
                                if (
                                    key != "position"
                                    and key != "avatar_data"
                                    and key != "avatar_url"
                                ):
                                    token[key] = value

                            # Отдельно обрабатываем avatar_url
                            if (
                                "avatar_url" in updates
                                and updates["avatar_url"]
                            ):
                                token["avatar_url"] = (
                                    updates["avatar_url"].split("?")[0]
                                    + f"?t={int(time.time())}"
                                )

                            # Обновляем has_avatar если есть
                            if "has_avatar" in updates:
                                token["has_avatar"] = updates["has_avatar"]

                            token_updated = True
                            print(f"  ✓ Updated token on map {map_id}")
                            break

                if token_updated:
                    # Сохраняем карту
                    with open(filepath, "w", encoding="utf-8") as f:
                        json.dump(data, f, indent=2, ensure_ascii=False)
                    updated_maps.append(map_id)

            except Exception as e:
                print(f"  ✗ Error updating map {filename}: {e}")
                import traceback

                traceback.print_exc()
                continue

    print(f"Token {token_id} updated on {len(updated_maps)} maps")
    return updated_maps


def ensure_dirs():
    """Создать необходимые директории"""
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(MAPS_DIR, exist_ok=True)
    os.makedirs(IMAGES_DIR, exist_ok=True)
    os.makedirs(TOKENS_AVATARS_DIR, exist_ok=True)
    os.makedirs(PORTRAITS_DIR, exist_ok=True)


def get_all_maps_with_token(token_id):
    """
    Найти все карты, на которых присутствует указанный токен
    Возвращает список словарей с информацией о картах
    """
    maps_with_token = []
    maps_dir = "data/maps"

    if not os.path.exists(maps_dir):
        return maps_with_token

    print(f"Searching for token {token_id} in maps...")

    for filename in os.listdir(maps_dir):
        if filename.endswith(".json"):
            map_id = filename[:-5]  # убираем .json
            map_data = load_map_data(map_id)

            if map_data and "tokens" in map_data:
                # Проверяем, есть ли токен на этой карте
                for token in map_data["tokens"]:
                    if token.get("id") == token_id:
                        maps_with_token.append(
                            {
                                "map_id": map_id,
                                "map_name": map_data.get(
                                    "name", "Без названия"
                                ),
                            }
                        )
                        break  # Нашли токен на этой карте, переходим к следующей

    print(f"Found token {token_id} on {len(maps_with_token)} maps")
    return maps_with_token


def get_token_avatar_filepath(token_id):
    """Получить путь к файлу аватара токена"""
    return os.path.join(TOKENS_AVATARS_DIR, f"{token_id}.png")


def save_token_avatar(image_data, token_id):
    """Сохранить аватар токена как файл"""
    try:
        print(f"Attempting to save avatar for token {token_id}")

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

        # Сохраняем как PNG для поддержки прозрачности
        img_path = get_token_avatar_filepath(token_id)
        os.makedirs(os.path.dirname(img_path), exist_ok=True)
        img.save(img_path, "PNG", optimize=True)
        print(
            f"Avatar saved successfully, file exists: {os.path.exists(img_path)}"
        )

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
            with open(img_path, "rb") as f:
                img_bytes = f.read()
                return f"data:image/png;base64,{base64.b64encode(img_bytes).decode('utf-8')}"
        except Exception as e:
            print(f"Error loading token avatar: {e}")
    return None


def get_all_tokens_from_maps():
    """Получить все токены со всех карт со всеми свойствами"""
    ensure_dirs()
    all_tokens = []
    seen_ids = set()  # Для предотвращения дубликатов

    for filename in os.listdir(MAPS_DIR):
        if filename.endswith(".json"):
            filepath = os.path.join(MAPS_DIR, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)

                # Собираем все токены
                if "tokens" in data:
                    for token in data["tokens"]:
                        token_id = token.get("id")
                        if token_id:  # Не фильтруем по seen_ids, чтобы получить все токены
                            # Создаём копию со всеми полями
                            token_copy = {
                                "id": token.get("id"),  # Оригинальный ID!
                                "name": token.get("name", "Безымянный"),
                                "is_player": token.get("is_player", False),
                                "is_npc": token.get("is_npc", False),
                                "armor_class": token.get("armor_class", 10),
                                "health_points": token.get(
                                    "health_points", 10
                                ),
                                "max_health_points": token.get(
                                    "max_health_points", 10
                                ),
                                "is_dead": token.get("is_dead", False),
                                "has_avatar": token.get("has_avatar", False),
                                "size": token.get("size", 20),
                                "is_visible": token.get("is_visible", True),
                                "source_map": data.get(
                                    "name", "Неизвестная карта"
                                ),
                                "source_map_id": filename[
                                    :-5
                                ],  # убираем .json
                            }

                            # Если есть аватар, добавляем URL
                            if token_copy["has_avatar"]:
                                token_copy["avatar_url"] = (
                                    get_token_avatar_url(token_id)
                                )

                            all_tokens.append(token_copy)

            except Exception as e:
                print(f"Error loading map {filename}: {e}")
                continue

    # Сортируем по имени (мёртвые внизу)
    all_tokens.sort(
        key=lambda t: (t.get("is_dead", False), t.get("name", "").lower())
    )

    # Убираем дубликаты ID, оставляя первый встретившийся
    unique_tokens = []
    seen_ids = set()
    for token in all_tokens:
        if token["id"] not in seen_ids:
            seen_ids.add(token["id"])
            unique_tokens.append(token)

    return unique_tokens


def delete_token_avatar(token_id):
    """Удалить аватар токена"""
    img_path = get_token_avatar_filepath(token_id)
    if os.path.exists(img_path):
        try:
            os.remove(img_path)
            print(f"✓ Deleted avatar file: {img_path}")
            return True
        except Exception as e:
            print(f"✗ Error deleting avatar for token {token_id}: {e}")
            return False
    else:
        print(
            f"→ Avatar file for token {token_id} does not exist at {img_path}"
        )
        return False


def get_token_avatar_url(token_id, force_timestamp=False):
    """Получить URL для загрузки аватара токена"""
    if not token_id:
        return None
    url = f"/api/token/avatar/{token_id}"
    if force_timestamp:
        url += f"?t={int(time.time())}"
    return url


def get_map_filepath(map_id):
    """Получить путь к файлу карты"""
    return os.path.join(MAPS_DIR, f"{map_id}.json")


def get_image_filepath(map_id):
    """Получить путь к файлу изображения карты"""
    return os.path.join(
        IMAGES_DIR, f"{map_id}.jpg"
    )  # Можно использовать .png если нужно


def save_map_image(image_data, map_id):
    """Сохранить изображение карты как файл"""
    try:
        # Если пришла base64 строка
        if isinstance(image_data, str) and image_data.startswith("data:image"):
            # Извлекаем base64 данные
            header, encoded = image_data.split(",", 1)
            image_bytes = base64.b64decode(encoded)
        elif isinstance(image_data, bytes):
            image_bytes = image_data
        else:
            return False

        # Оптимизируем изображение
        img = Image.open(io.BytesIO(image_bytes))

        # Конвертируем в RGB если нужно
        if img.mode in ("RGBA", "LA", "P"):
            rgb_img = Image.new("RGB", img.size, (255, 255, 255))
            rgb_img.paste(
                img, mask=img.split()[-1] if img.mode == "RGBA" else None
            )
            img = rgb_img

        # Изменяем размер если слишком большое (опционально)
        max_size = 2048
        if img.width > max_size or img.height > max_size:
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

        # Сохраняем с оптимизацией
        img_path = get_image_filepath(map_id)
        img.save(img_path, "JPEG", quality=85, optimize=True)

        return True
    except Exception as e:
        print(f"Error saving map image: {e}")
        return False


def load_map_image(map_id):
    """Загрузить изображение карты и вернуть base64 для отображения"""
    img_path = get_image_filepath(map_id)
    if os.path.exists(img_path):
        try:
            with open(img_path, "rb") as f:
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

                maps.append(
                    {
                        "id": map_id,
                        "name": data.get("name", "Безымянная карта"),
                        "created": datetime.fromtimestamp(
                            os.path.getctime(filepath)
                        ).isoformat(),
                        "modified": datetime.fromtimestamp(
                            os.path.getmtime(filepath)
                        ).isoformat(),
                        "has_image": has_image,
                    }
                )
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
        "grid_settings": {
            "visible": True,
            "visible_to_players": True,  # По умолчанию сетка видна игрокам
            "cell_count": 20,  # НОВОЕ: количество клеток по ширине (5-150)
            "cell_size": 20,  # Оставляем для обратной совместимости
            "color": "#888888",
            "opacity": 100,
        },
        "characters": [],
        "pan_x": 0,
        "pan_y": 0,
        "zoom_level": 1,
        "player_map_enabled": True,
        "created": datetime.now().isoformat(),
        "modified": datetime.now().isoformat(),
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

            # Убеждаемся, что все необходимые поля есть
            if "tokens" not in data:
                data["tokens"] = []
            if "zones" not in data:
                data["zones"] = []
            if "finds" not in data:
                data["finds"] = []
            if "characters" not in data:
                data["characters"] = []

            return data
        except json.JSONDecodeError as e:
            print(f"Error parsing JSON for map {map_id}: {e}")
            return None
        except Exception as e:
            print(f"Error loading map data for {map_id}: {e}")
            return None
    return None


def get_all_heroes_from_maps():
    """Получить всех героев (токены-игроки) со всех карт"""
    ensure_dirs()
    heroes = []
    seen_ids = set()  # Для отслеживания уникальных ID

    for filename in os.listdir(MAPS_DIR):
        if filename.endswith(".json"):
            filepath = os.path.join(MAPS_DIR, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)

                # Собираем ТОЛЬКО токены-игроки
                if "tokens" in data:
                    for token in data["tokens"]:
                        # Проверяем, что это игрок и ID еще не встречался
                        if (
                            token.get("is_player")
                            and token.get("id") not in seen_ids
                        ):
                            seen_ids.add(token["id"])

                            # Создаем копию с нужными полями
                            hero = {
                                "id": token["id"],
                                "name": token.get("name", "Безымянный герой"),
                                "has_avatar": token.get("has_avatar", False),
                                "avatar_url": token.get("avatar_url"),
                                "armor_class": token.get("armor_class", 10),
                                "health_points": token.get(
                                    "health_points", 10
                                ),
                                "max_health_points": token.get(
                                    "max_health_points", 10
                                ),
                                "is_player": True,
                                "is_npc": token.get("is_npc", False),
                                "source_map": data.get(
                                    "name", "Неизвестная карта"
                                ),
                            }
                            heroes.append(hero)

            except Exception as e:
                print(f"Error loading map {filename}: {e}")
                continue

    print(f"Found {len(heroes)} unique heroes from all maps")
    return heroes


def save_map_data(data, map_id):
    """Сохранить данные карты"""
    # Проверяем, соответствует ли map_id в данных переданному
    data_map_id = data.get("map_id")
    if data_map_id and data_map_id != map_id:
        print(f"⚠️ CRITICAL: data.map_id ({data_map_id}) != map_id ({map_id})")
        # Исправляем несоответствие - используем ID из данных
        map_id = data_map_id

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

    # Линейку не сохраняем в JSON — она временная
    data.pop("ruler_start", None)
    data.pop("ruler_end", None)

    # Убедимся, что у токенов сохраняются has_avatar
    if "tokens" in data:
        for token in data["tokens"]:
            # Удаляем avatar_data если он есть (он не должен сохраняться)
            token.pop("avatar_data", None)
            # НЕ удаляем avatar_url - пусть сохраняется в JSON

    # Убедимся, что у персонажей сохраняются has_avatar
    if "characters" in data:
        for character in data["characters"]:
            # Удаляем avatar_data если он есть
            character.pop("avatar_data", None)
            # НЕ удаляем portrait_url - пусть сохраняется в JSON

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def save_portrait_image(image_data, portrait_id):
    """
    Сохранить изображение портрета как файл

    Args:
        image_data: base64 строка с изображением или бинарные данные
        portrait_id: ID портрета

    Returns:
        bool: True если успешно, False если ошибка
    """
    try:
        # Создаем директорию если её нет
        os.makedirs(PORTRAITS_DIR, exist_ok=True)

        # Определяем путь к файлу
        filepath = os.path.join(PORTRAITS_DIR, f"{portrait_id}.png")

        # Если image_data - строка base64, конвертируем в бинарные данные
        if isinstance(image_data, str) and image_data.startswith("data:image"):
            # Извлекаем base64 часть
            base64_data = (
                image_data.split(",")[1] if "," in image_data else image_data
            )
            import base64

            image_binary = base64.b64decode(base64_data)
        elif isinstance(image_data, bytes):
            image_binary = image_data
        else:
            # Если это уже готовый файл или другой формат
            print(f"Unsupported image data type: {type(image_data)}")
            return False

        # Сохраняем файл
        with open(filepath, "wb") as f:
            f.write(image_binary)

        print(f"✓ Portrait saved: {filepath}")
        return True

    except Exception as e:
        print(f"✗ Error saving portrait: {e}")
        return False


def get_portrait_filepath(portrait_id):
    """
    Получить путь к файлу портрета

    Args:
        portrait_id: ID портрета

    Returns:
        str: путь к файлу
    """
    return os.path.join(PORTRAITS_DIR, f"{portrait_id}.png")


def get_portrait_url(portrait_id):
    """
    Получить URL для загрузки портрета

    Args:
        portrait_id: ID портрета

    Returns:
        str: URL для загрузки портрета
    """
    return f"/api/portrait/{portrait_id}"


def delete_portrait_image(portrait_id):
    """
    Удалить файл портрета

    Args:
        portrait_id: ID портрета

    Returns:
        bool: True если успешно, False если ошибка
    """
    try:
        filepath = get_portrait_filepath(portrait_id)
        if os.path.exists(filepath):
            os.remove(filepath)
            print(f"✓ Portrait deleted: {filepath}")
            return True
        else:
            print(f"→ Portrait file not found: {filepath}")
            return False
    except Exception as e:
        print(f"✗ Error deleting portrait: {e}")
        return False
