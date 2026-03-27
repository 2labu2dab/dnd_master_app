import json
import os
import time as time_stdlib
from datetime import datetime
import uuid
import base64
from PIL import Image, ImageFile
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

# Иногда приходят "truncated" PNG/JPG (например, сеть/браузер/кэш).
# Чтобы приложение не падало на upload/сохранении, разрешаем загрузку
# таких изображений и дальше делаем lossless-сохранение на нашей стороне.
ImageFile.LOAD_TRUNCATED_IMAGES = True

DATA_DIR = "data"
BANK_AVATARS_DIR = os.path.join(DATA_DIR, "bank_avatars")


def get_active_project_id():
    try:
        from flask import has_request_context, session

        if has_request_context():
            return session.get("data_project_id")
    except ImportError:
        pass
    return None


def _project_data_home():
    pid = get_active_project_id()
    if not pid:
        return None
    return os.path.join(DATA_DIR, "projects", pid)


def get_maps_dir():
    h = _project_data_home()
    return os.path.join(h, "maps") if h else None


def get_images_dir():
    h = _project_data_home()
    return os.path.join(h, "images") if h else None


def get_token_avatars_dir():
    h = _project_data_home()
    return os.path.join(h, "token_avatars") if h else None


def get_portraits_dir():
    h = _project_data_home()
    return os.path.join(h, "portrait_images") if h else None


def get_drawings_dir():
    h = _project_data_home()
    return os.path.join(h, "drawings") if h else None
TOKEN_SIZE_SCALES = {
    "tiny": 0.25,
    "small": 1.0,
    "medium": 1.0,
    "large": 2.0,
    "huge": 3.0,
    "gargantuan": 4.0,
}


def get_token_size_scale(size_key):
    """Получить масштаб для токена по его размеру"""
    return TOKEN_SIZE_SCALES.get(size_key, 1.0)


def get_bank_avatar_filepath(character_id):
    """Получить путь к файлу аватара персонажа из банка"""
    return os.path.join(BANK_AVATARS_DIR, f"{character_id}.png")


def save_bank_avatar(image_data, character_id):
    """Сохранить аватар для персонажа из банка с максимальным качеством"""
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

        # Открываем изображение
        img = Image.open(io.BytesIO(image_bytes))

        # Сохраняем оригинальный размер - НИЧЕГО НЕ МЕНЯЕМ
        if img.mode != "RGBA" and img.mode != "RGB":
            img = img.convert("RGBA")
        elif img.mode == "RGB":
            rgba = Image.new("RGBA", img.size, (255, 255, 255, 255))
            rgba.paste(img, (0, 0))
            img = rgba

        # PNG сжимается без потери качества — уменьшаем размер файлов для сети
        img_path = get_bank_avatar_filepath(character_id)
        os.makedirs(os.path.dirname(img_path), exist_ok=True)

        try:
            img.save(img_path, "PNG", optimize=True, compress_level=6)
        except OSError:
            img.save(img_path, "PNG", optimize=True, compress_level=0)
        print(
            f"Bank avatar saved with original size: {img.width}x{img.height}"
        )

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

    maps_dir = get_maps_dir()
    if not maps_dir or not os.path.isdir(maps_dir):
        return updated_maps

    for filename in os.listdir(maps_dir):
        if filename.endswith(".json"):
            map_id = filename[:-5]
            filepath = os.path.join(maps_dir, filename)

            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)

                token_updated = False
                if "tokens" in data:
                    for token in data["tokens"]:
                        if str(token.get("id")) == str(token_id):
                            # Обновляем все поля кроме позиции
                            for key, value in updates.items():
                                if key != "position" and key != "avatar_data":
                                    token[key] = value

                            if (
                                "avatar_url" in updates
                                and updates["avatar_url"]
                            ):
                                token["avatar_url"] = (
                                    updates["avatar_url"].split("?")[0]
                                    + f"?t={int(time_stdlib.time())}"
                                )

                            if "has_avatar" in updates:
                                token["has_avatar"] = updates["has_avatar"]

                            # Убеждаемся, что размер синхронизирован
                            if "size" in updates:
                                token["size"] = updates["size"]

                            token_updated = True
                            print(f"  ✓ Updated token on map {map_id}")
                            break

                if token_updated:
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


def token_stats_payload_from_dict(t):
    """Поля «одного персонажа» для слияния на других картах (без позиции)."""
    if not t or t.get("id") is None:
        return None
    payload = {
        "name": t.get("name", ""),
        "armor_class": t.get("armor_class", 10),
        "health_points": t.get("health_points", 10),
        "max_health_points": t.get("max_health_points", 10),
        "is_player": t.get("is_player", False),
        "is_npc": t.get("is_npc", False),
        "is_dead": t.get("is_dead", False),
        "has_avatar": t.get("has_avatar", False),
        "is_visible": t.get("is_visible", True),
        "size": t.get("size", "medium"),
    }
    if t.get("avatar_url"):
        payload["avatar_url"] = t["avatar_url"]
    return payload


def _token_stats_differ(token, updates):
    """Нужно ли применять updates к token (без позиции)."""
    for k, v in updates.items():
        if k in ("position", "avatar_data"):
            continue
        if k == "avatar_url":
            cur = (token.get("avatar_url") or "").split("?")[0]
            new = (v or "").split("?")[0]
            if cur != new:
                return True
            continue
        if token.get(k) != v:
            return True
    return False


def propagate_token_stats_to_other_maps(source_map_id, tokens):
    """
    После сохранения source_map_id: обновить токены с тем же id на всех остальных картах.
    Позиция и avatar_data не трогаются. Один проход по файлам карт на сохранение.
    Возвращает (список id изменённых карт, множество id токенов, у которых что-то обновилось).
    """
    ensure_dirs()
    by_id = {}
    for t in tokens or []:
        tid = t.get("id")
        if tid is None:
            continue
        payload = token_stats_payload_from_dict(t)
        if payload:
            by_id[str(tid)] = payload

    if not by_id:
        return [], set()

    updated_maps = []
    touched_token_ids = set()
    src_mid = str(source_map_id)

    maps_dir = get_maps_dir()
    if not maps_dir or not os.path.isdir(maps_dir):
        return [], set()

    for filename in os.listdir(maps_dir):
        if not filename.endswith(".json"):
            continue
        map_id = filename[:-5]
        if str(map_id) == src_mid:
            continue

        filepath = os.path.join(maps_dir, filename)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"propagate_token_stats: skip {filename}: {e}")
            continue

        changed = False
        for token in data.get("tokens") or []:
            tid = token.get("id")
            if tid is None or str(tid) not in by_id:
                continue
            updates = by_id[str(tid)]
            if not _token_stats_differ(token, updates):
                continue
            for key, value in updates.items():
                if key != "position" and key != "avatar_data":
                    token[key] = value

            if updates.get("avatar_url"):
                token["avatar_url"] = (
                    updates["avatar_url"].split("?")[0]
                    + f"?t={int(time_stdlib.time())}"
                )
            if "has_avatar" in updates:
                token["has_avatar"] = updates["has_avatar"]
            if "size" in updates:
                token["size"] = updates["size"]

            touched_token_ids.add(str(tid))
            changed = True

        if changed:
            try:
                with open(filepath, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                updated_maps.append(map_id)
            except Exception as e:
                print(f"propagate_token_stats: write {filename}: {e}")

    return updated_maps, touched_token_ids


def ensure_dirs():
    """Создать необходимые директории"""
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(BANK_AVATARS_DIR, exist_ok=True)
    home = _project_data_home()
    if not home:
        return
    for sub in ("maps", "images", "token_avatars", "portrait_images", "drawings"):
        os.makedirs(os.path.join(home, sub), exist_ok=True)


def get_all_maps_with_token(token_id):
    """
    Найти все карты, на которых присутствует указанный токен
    Возвращает список словарей с информацией о картах
    """
    maps_with_token = []
    maps_dir = get_maps_dir()

    if not maps_dir or not os.path.isdir(maps_dir):
        return maps_with_token

    print(f"Searching for token {token_id} in maps...")

    for filename in os.listdir(maps_dir):
        if filename.endswith(".json"):
            map_id = filename[:-5]  # убираем .json
            map_data = load_map_data(map_id)

            if map_data and "tokens" in map_data:
                # Проверяем, есть ли токен на этой карте
                for token in map_data["tokens"]:
                    if str(token.get("id")) == str(token_id):
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


def get_all_maps_with_token_all_projects(token_id):
    """Все карты во всех проектах, где встречается токен (для банка и очистки)."""
    from utils.projects import get_project, list_project_ids, project_maps_dir

    maps_with_token = []
    for pid in list_project_ids():
        mdir = project_maps_dir(pid)
        if not os.path.isdir(mdir):
            continue
        proj_name = None
        meta = get_project(pid)
        if meta:
            proj_name = meta.get("name", pid)
        for filename in os.listdir(mdir):
            if not filename.endswith(".json"):
                continue
            map_id = filename[:-5]
            filepath = os.path.join(mdir, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, json.JSONDecodeError):
                continue
            if "tokens" not in data:
                continue
            for token in data["tokens"]:
                if str(token.get("id")) == str(token_id):
                    maps_with_token.append(
                        {
                            "map_id": map_id,
                            "map_name": data.get("name", "Без названия"),
                            "project_id": pid,
                            "project_name": proj_name or pid,
                        }
                    )
                    break
    return maps_with_token


def get_all_maps_with_character(character_id):
    """Найти все карты, в списке персонажей (портреты) которых есть character_id."""
    maps_with_char = []
    maps_dir = get_maps_dir()
    if not maps_dir or not os.path.isdir(maps_dir):
        return maps_with_char

    for filename in os.listdir(maps_dir):
        if not filename.endswith(".json"):
            continue
        map_id = filename[:-5]
        map_data = load_map_data(map_id)
        if not map_data:
            continue
        for ch in map_data.get("characters") or []:
            if str(ch.get("id")) == str(character_id):
                maps_with_char.append(
                    {
                        "map_id": map_id,
                        "map_name": map_data.get("name", "Без названия"),
                    }
                )
                break

    return maps_with_char


def get_token_avatar_filepath(token_id):
    """Получить путь к файлу аватара токена"""
    d = get_token_avatars_dir()
    if not d:
        return None
    return os.path.join(d, f"{token_id}.png")


def save_token_avatar(image_data, token_id):
    """Сохранить аватар токена как файл с максимальным качеством"""
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

        # Открываем изображение
        img = Image.open(io.BytesIO(image_bytes))
        original_size = f"{img.width}x{img.height}"
        print(f"Original image size: {original_size}, mode: {img.mode}")

        # Сохраняем оригинальный размер - НИЧЕГО НЕ ИЗМЕНЯЕМ
        img_path = get_token_avatar_filepath(token_id)
        if not img_path:
            return False
        os.makedirs(os.path.dirname(img_path), exist_ok=True)
        
        # Lossless PNG сжатие (уменьшаем размер для сети).
        # Если PIL не смог прогрузить "truncated" картинку при save,
        # падаем на менее требовательные настройки.
        try:
            img.save(img_path, "PNG", optimize=True, compress_level=6)
        except OSError:
            img.save(img_path, "PNG", optimize=True, compress_level=0)
        
        saved_size = os.path.getsize(img_path)
        print(f"Avatar saved: {img_path}")
        print(f"  Size: {original_size}, File size: {saved_size} bytes")
        
        return True
    except Exception as e:
        print(f"Error saving token avatar: {e}")
        import traceback
        traceback.print_exc()
        return False
def load_token_avatar(token_id):
    """Загрузить аватар токена и вернуть base64 для отображения"""
    img_path = get_token_avatar_filepath(token_id)
    if img_path and os.path.exists(img_path):
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

    maps_dir = get_maps_dir()
    if not maps_dir or not os.path.isdir(maps_dir):
        return []

    for filename in os.listdir(maps_dir):
        if filename.endswith(".json"):
            filepath = os.path.join(maps_dir, filename)
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
    if img_path and os.path.exists(img_path):
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
        url += f"?t={int(time_stdlib.time())}"
    return url


def get_map_filepath(map_id):
    """Получить путь к файлу карты"""
    maps_dir = get_maps_dir()
    if not maps_dir:
        return None
    return os.path.join(maps_dir, f"{map_id}.json")


def get_image_filepath(map_id):
    """Получить путь к файлу изображения карты"""
    idir = get_images_dir()
    if not idir:
        return None
    png_path = os.path.join(idir, f"{map_id}.png")
    if os.path.exists(png_path):
        return png_path
    jpg_path = os.path.join(idir, f"{map_id}.jpg")
    if os.path.exists(jpg_path):
        return jpg_path
    return os.path.join(idir, f"{map_id}.png")


def get_player_image_filepath(map_id):
    """Путь к сжатой версии изображения для игроков (JPEG)"""
    idir = get_images_dir()
    if not idir:
        return None
    return os.path.join(idir, f"{map_id}_player.jpg")


def create_player_image(map_id):
    """Создать/обновить сжатую версию изображения для игроков.

    Максимум 1920×1080, JPEG качество 80. Если оригинал меньше —
    размер не увеличивается, но всё равно конвертируется в JPEG.
    Возвращает True при успехе.
    """
    src_path = get_image_filepath(map_id)
    if not src_path or not os.path.exists(src_path):
        return False
    dst_path = get_player_image_filepath(map_id)
    if not dst_path:
        return False
    try:
        img = Image.open(src_path)
        # Конвертируем в RGB (JPEG не поддерживает alpha)
        if img.mode in ("RGBA", "LA", "P"):
            background = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == "RGBA":
                background.paste(img, mask=img.split()[3])
            else:
                background.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[3])
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")

        # Уменьшаем если больше 1920×1080
        max_w, max_h = 1920, 1080
        if img.width > max_w or img.height > max_h:
            img.thumbnail((max_w, max_h), Image.LANCZOS)

        img.save(dst_path, "JPEG", quality=80, optimize=True)
        print(
            f"Player image created: {dst_path} "
            f"({img.width}x{img.height}, {os.path.getsize(dst_path)} bytes)"
        )
        return True
    except Exception as e:
        print(f"Error creating player image for {map_id}: {e}")
        return False


def save_map_image(image_data, map_id):
    """Сохранить изображение карты как файл с максимальным качеством"""
    try:
        print(f"Saving map image for {map_id}")

        # Если пришла base64 строка
        if isinstance(image_data, str) and image_data.startswith("data:image"):
            # Извлекаем base64 данные
            header, encoded = image_data.split(",", 1)
            image_bytes = base64.b64decode(encoded)
        elif isinstance(image_data, bytes):
            image_bytes = image_data
        else:
            print(f"Unsupported image data type: {type(image_data)}")
            return False

        # Открываем изображение
        img = Image.open(io.BytesIO(image_bytes))
        print(
            f"Original image size: {img.width}x{img.height}, mode: {img.mode}"
        )

        # Определяем формат по исходным данным
        original_format = img.format
        print(f"Original format: {original_format}")

        # Путь для сохранения
        img_path = get_image_filepath(map_id)
        if not img_path:
            print("save_map_image: нет активного проекта")
            return False
        os.makedirs(os.path.dirname(img_path), exist_ok=True)

        # Сохраняем в оригинальном формате с максимальным качеством
        if original_format == "PNG" or img.mode == "RGBA":
            # Для PNG сохраняем как PNG без потерь, но с нормальным lossless-сжатием
            try:
                img.save(img_path, "PNG", optimize=True, compress_level=6)
            except OSError:
                try:
                    img.save(img_path, "PNG", optimize=True, compress_level=0)
                except OSError:
                    # Если даже fallback не сработал — перезапишем "как есть"
                    # (это не ухудшает качество относительно загруженного файла).
                    with open(img_path, "wb") as f:
                        f.write(image_bytes)
            print(
                f"Saved as PNG (lossless), size: {os.path.getsize(img_path)} bytes"
            )
        else:
            # Для JPEG сохраняем с максимальным качеством
            # Конвертируем в RGB если нужно
            if img.mode in ("RGBA", "LA", "P"):
                rgb_img = Image.new("RGB", img.size, (255, 255, 255))
                if img.mode == "RGBA":
                    rgb_img.paste(img, mask=img.split()[3])
                else:
                    rgb_img.paste(img)
                img = rgb_img

            # Сохраняем с качеством 100%
            img.save(
                img_path, "JPEG", quality=100, optimize=False, subsampling=0
            )
            print(
                f"Saved as JPEG (quality=100), size: {os.path.getsize(img_path)} bytes"
            )

        if os.path.exists(img_path):
            print(f"✓ Map image saved: {img_path}")
            return True
        else:
            print(f"✗ File not found after save: {img_path}")
            return False

    except Exception as e:
        print(f"Error saving map image: {e}")
        import traceback
        traceback.print_exc()
        return False


def load_map_image(map_id):
    """Загрузить изображение карты и вернуть base64 без потерь"""
    img_path = get_image_filepath(map_id)
    if img_path and os.path.exists(img_path):
        try:
            with open(img_path, "rb") as f:
                img_bytes = f.read()

            # Определяем MIME тип по расширению файла
            if img_path.lower().endswith(".png"):
                mime_type = "image/png"
            else:
                mime_type = "image/jpeg"

            return f"data:{mime_type};base64,{base64.b64encode(img_bytes).decode('utf-8')}"
        except Exception as e:
            print(f"Error loading map image: {e}")
    return None


def delete_map_image(map_id):
    """Удалить изображения карты: PNG/JPEG оригинал и сжатую копию для игрока."""
    removed = False
    idir = get_images_dir()
    if not idir:
        return False
    for suffix in (f"{map_id}.png", f"{map_id}.jpg"):
        p = os.path.join(idir, suffix)
        if os.path.exists(p):
            try:
                os.remove(p)
                removed = True
            except OSError as e:
                print(f"✗ Error removing map image {p}: {e}")
    player_path = get_player_image_filepath(map_id)
    if player_path and os.path.exists(player_path):
        try:
            os.remove(player_path)
            removed = True
        except OSError as e:
            print(f"✗ Error removing player map image {player_path}: {e}")
    return removed


def list_maps():
    """Получить список всех карт"""
    ensure_dirs()
    maps = []

    maps_dir = get_maps_dir()
    if not maps_dir or not os.path.isdir(maps_dir):
        return maps

    # Читаем все JSON файлы из папки maps
    for filename in os.listdir(maps_dir):
        if filename.endswith(".json"):
            map_id = filename[:-5]  # убираем .json
            filepath = os.path.join(maps_dir, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)

                has_image = os.path.exists(get_image_filepath(map_id))

                entry = {
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

                # Версионированный URL изображения для предзагрузки
                if has_image:
                    orig_path = get_image_filepath(map_id)
                    try:
                        import time as _time
                        v = int(os.path.getmtime(orig_path))
                    except Exception:
                        import time as _time
                        v = int(_time.time())
                    entry["image_url"] = f"/api/map/image/{map_id}?v={v}"

                maps.append(entry)
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
    """
    Удалить карту: JSON, изображения, слой рисунков.
    Аватары токенов и файлы портретов удаляются с диска, только если больше не
    упоминаются ни на одной другой карте.
    """
    filepath = get_map_filepath(map_id)
    if not filepath:
        return False
    map_data = None
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                map_data = json.load(f)
        except Exception as e:
            print(f"Warning: could not read map {map_id} before delete: {e}")

    token_ids = []
    character_ids = []
    if map_data:
        for t in map_data.get("tokens") or []:
            if t.get("has_avatar") and t.get("id"):
                token_ids.append(str(t["id"]))
        for c in map_data.get("characters") or []:
            if c.get("has_avatar") and c.get("id"):
                character_ids.append(str(c["id"]))
        token_ids = list(dict.fromkeys(token_ids))
        character_ids = list(dict.fromkeys(character_ids))

    if os.path.exists(filepath):
        os.remove(filepath)

    delete_map_image(map_id)
    delete_drawings_layer(map_id)

    for tid in token_ids:
        if not get_all_maps_with_token(tid):
            delete_token_avatar(tid)

    for cid in character_ids:
        if not get_all_maps_with_character(cid):
            delete_portrait_image(cid)

    return True


def load_map_data(map_id):
    """Загрузить данные карты"""
    ensure_dirs()
    filepath = get_map_filepath(map_id)
    if not filepath:
        return None

    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)

            # Добавляем флаг наличия изображения если его нет
            if "has_image" not in data:
                ip = get_image_filepath(map_id)
                data["has_image"] = bool(ip and os.path.exists(ip))

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

    maps_dir = get_maps_dir()
    if not maps_dir or not os.path.isdir(maps_dir):
        return heroes

    for filename in os.listdir(maps_dir):
        if filename.endswith(".json"):
            filepath = os.path.join(maps_dir, filename)
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
        map_id = data_map_id

    ensure_dirs()
    filepath = get_map_filepath(map_id)
    if not filepath:
        print("save_map_data: нет активного проекта")
        return

    # Добавляем/обновляем метаданные
    data["modified"] = datetime.now().isoformat()
    if "created" not in data:
        data["created"] = datetime.now().isoformat()

    # Сохраняем информацию о формате изображения
    if data.get("has_image"):
        img_path = get_image_filepath(map_id)
        if img_path and os.path.exists(img_path):
            data["image_format"] = (
                "png" if img_path.endswith(".png") else "jpg"
            )

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
            token.pop("avatar_data", None)

    # Убедимся, что у персонажей сохраняются has_avatar
    if "characters" in data:
        for character in data["characters"]:
            character.pop("avatar_data", None)

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"Map data saved for {map_id}")


# Расширения портрета (порядок: сначала типичные для find)
PORTRAIT_FILE_SUFFIXES = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webm",
    ".mp4",
    ".mov",
    ".m4v",
)


def find_portrait_file(portrait_id):
    """Найти файл портрета с любым из поддерживаемых расширений."""
    pdir = get_portraits_dir()
    if not pdir:
        return None
    for suf in PORTRAIT_FILE_SUFFIXES:
        p = os.path.join(pdir, f"{portrait_id}{suf}")
        if os.path.exists(p):
            return p
    return None


def portrait_mimetype_for_path(path):
    ext = os.path.splitext(path)[1].lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webm": "video/webm",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".m4v": "video/x-m4v",
    }.get(ext, "application/octet-stream")


def portrait_path_to_media(path):
    """Для JSON/API: image | gif | video"""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".gif":
        return "gif"
    if ext in (".webm", ".mp4", ".mov", ".m4v"):
        return "video"
    return "image"


def save_portrait_upload(raw_bytes, portrait_id, content_type=None, filename=None):
    """
    Сохранить портрет: PNG/JPEG/WebP → PNG через PIL; GIF и видео — байты как есть.
    Возвращает dict {ok, media, ext} или None при ошибке.
    """
    try:
        ct = (content_type or "").lower().split(";")[0].strip()
        fn = (filename or "").lower()

        is_gif = ct == "image/gif" or fn.endswith(".gif")
        is_vid = ct.startswith("video/") or fn.endswith(
            (".webm", ".mp4", ".mov", ".m4v")
        )

        delete_portrait_image(portrait_id)
        pdir = get_portraits_dir()
        if not pdir:
            return None
        os.makedirs(pdir, exist_ok=True)

        if is_vid:
            if fn.endswith(".webm") or "webm" in ct:
                ext = ".webm"
            elif fn.endswith(".mov") or "quicktime" in ct:
                ext = ".mov"
            elif fn.endswith(".m4v") or "m4v" in ct:
                ext = ".m4v"
            else:
                ext = ".mp4"
            path = os.path.join(pdir, f"{portrait_id}{ext}")
            with open(path, "wb") as f:
                f.write(raw_bytes)
            print(f"Portrait video saved {path} ({len(raw_bytes)} bytes)")
            return {"ok": True, "media": "video", "ext": ext}

        if is_gif:
            path = os.path.join(pdir, f"{portrait_id}.gif")
            with open(path, "wb") as f:
                f.write(raw_bytes)
            print(f"Portrait GIF saved {path} ({len(raw_bytes)} bytes)")
            return {"ok": True, "media": "gif", "ext": ".gif"}

        # Статичная картинка → PNG
        if isinstance(raw_bytes, str) and raw_bytes.startswith("data:image"):
            b64 = raw_bytes.split(",")[1] if "," in raw_bytes else raw_bytes
            import base64

            image_binary = base64.b64decode(b64)
        elif isinstance(raw_bytes, bytes):
            image_binary = raw_bytes
        else:
            print(f"Unsupported portrait data type: {type(raw_bytes)}")
            return None

        img = Image.open(io.BytesIO(image_binary))
        if img.mode != "RGBA" and img.mode != "RGB":
            img = img.convert("RGBA")
        elif img.mode == "RGB":
            rgba = Image.new("RGBA", img.size, (255, 255, 255, 255))
            rgba.paste(img, (0, 0))
            img = rgba

        filepath = os.path.join(pdir, f"{portrait_id}.png")
        try:
            img.save(filepath, "PNG", optimize=True, compress_level=6)
        except OSError:
            img.save(filepath, "PNG", optimize=True, compress_level=0)
        print(f"Portrait PNG saved {img.width}x{img.height}")
        return {"ok": True, "media": "image", "ext": ".png"}
    except Exception as e:
        print(f"Error saving portrait: {e}")
        import traceback

        traceback.print_exc()
        return None


def save_portrait_image(image_data, portrait_id):
    """
    Сохранить портрет (обёртка для старого API: только растровая картинка → PNG).
    """
    r = save_portrait_upload(image_data, portrait_id, "image/png", "x.png")
    return bool(r and r.get("ok"))


def get_portrait_filepath(portrait_id):
    """
    Путь к PNG по умолчанию (для обратной совместимости).
    Для фактической отдачи файла используйте find_portrait_file.
    """
    pdir = get_portraits_dir()
    if not pdir:
        return None
    return os.path.join(pdir, f"{portrait_id}.png")


def get_portrait_url(portrait_id):
    """
    Получить URL для загрузки портрета

    Args:
        portrait_id: ID портрета

    Returns:
        str: URL для загрузки портрета
    """
    return f"/api/portrait/{portrait_id}"


def ensure_drawings_dir():
    """Создать папку для рисунков если её нет"""
    ddir = get_drawings_dir()
    if ddir:
        os.makedirs(ddir, exist_ok=True)


def get_drawings_filepath(map_id):
    """Получить путь к файлу с рисунками для карты"""
    ensure_drawings_dir()
    ddir = get_drawings_dir()
    if not ddir:
        return None
    return os.path.join(ddir, f"{map_id}.json")


def save_drawings_layer(map_id, layer_id, strokes):
    """Сохранить слой рисунков"""
    filepath = get_drawings_filepath(map_id)
    if not filepath:
        return False

    # Проверяем структуру перед сохранением
    print(f"Saving {len(strokes)} strokes")
    if strokes and len(strokes) > 0:
        print(f"Sample stroke: {strokes[0]}")

    data = {
        "map_id": map_id,
        "layer_id": layer_id,
        "strokes": strokes,
        "modified": datetime.now().isoformat(),
    }

    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        print(f"✓ Drawings saved for map {map_id}")
        return True
    except Exception as e:
        print(f"✗ Error saving drawings: {e}")
        return False


def load_drawings_layer(map_id):
    """Загрузить слой рисунков"""
    filepath = get_drawings_filepath(map_id)
    if not filepath:
        layer_id = f"layer_{uuid.uuid4().hex[:8]}"
        return [], layer_id

    if not os.path.exists(filepath):
        # Создаём новый слой
        layer_id = f"layer_{uuid.uuid4().hex[:8]}"
        return [], layer_id

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)

        strokes = data.get("strokes", [])
        layer_id = data.get("layer_id", f"layer_{uuid.uuid4().hex[:8]}")

        return strokes, layer_id
    except Exception as e:
        print(f"✗ Error loading drawings: {e}")
        layer_id = f"layer_{uuid.uuid4().hex[:8]}"
        return [], layer_id


def delete_drawings_layer(map_id):
    """Удалить слой рисунков"""
    filepath = get_drawings_filepath(map_id)
    if filepath and os.path.exists(filepath):
        try:
            os.remove(filepath)
            print(f"✓ Drawings deleted for map {map_id}")
            return True
        except Exception as e:
            print(f"✗ Error deleting drawings: {e}")
    return False


def delete_portrait_image(portrait_id):
    """
    Удалить все варианты файла портрета (любое расширение).
    """
    try:
        removed = False
        pdir = get_portraits_dir()
        if not pdir:
            return False
        for suf in PORTRAIT_FILE_SUFFIXES:
            filepath = os.path.join(pdir, f"{portrait_id}{suf}")
            if os.path.exists(filepath):
                os.remove(filepath)
                print(f"✓ Portrait deleted: {filepath}")
                removed = True
        if not removed:
            print(f"→ No portrait files for {portrait_id}")
        return removed
    except Exception as e:
        print(f"✗ Error deleting portrait: {e}")
        return False
