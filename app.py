# app.py
import base64
import io
import math
import os
import time
import uuid

from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
)
from flask_socketio import SocketIO, disconnect, emit
from PIL import Image

from utils.character_bank import (
    add_character_to_bank,
    delete_character_from_bank,
    get_all_bank_characters,
    get_bank_character,
    init_db,
    save_bank_character_avatar,
    update_character_in_bank,
)
from utils.master_lock import (
    acquire_master_lock,
    get_current_master,
    is_master_active,
    release_master_lock,
    update_master_ping,
)
from utils.storage import (
    TOKENS_AVATARS_DIR,
    create_new_map,
    delete_map,
    get_all_maps_with_token,  # <-- ДОБАВЬТЕ ЭТУ СТРОКУ
    get_image_filepath,
    get_token_avatar_url,
    list_maps,
    load_map_data,
    load_map_image,
    save_map_data,
    save_map_image,
    save_token_avatar,
)

app = Flask(__name__)
app.config["SECRET_KEY"] = "your-secret-key-here"
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB max file size
# Важно: настройка CORS для Socket.IO
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    logger=True,
    engineio_logger=True,
    ping_timeout=60,
    ping_interval=25,
    max_http_buffer_size=50e6,  # 50MB для больших файлов
)

# Кэш для throttle
last_ruler_updates = {}

import os

# Создаем папки и проверяем права
data_dir = "data"
token_avatars_dir = os.path.join(data_dir, "token_avatars")

# Создаем папки
os.makedirs(data_dir, exist_ok=True)
os.makedirs(token_avatars_dir, exist_ok=True)


# Пробуем создать тестовый файл
test_file = os.path.join(token_avatars_dir, "test.txt")
try:
    with open(test_file, "w") as f:
        f.write("test")
    os.remove(test_file)

except Exception as e:
    print(f"✗ Failed to create test file: {e}")


@app.route("/")
def index():
    maps = list_maps()
    current_map_id = None

    # Если есть карты, выбираем первую
    if maps:
        current_map_id = maps[0]["id"]
        session["current_map_id"] = current_map_id
    else:
        session["current_map_id"] = None

    return render_template("index.html", maps=maps, current_map=current_map_id)


@app.route("/api/maps", methods=["GET"])
def get_maps():
    """Получить список всех карт"""
    return jsonify(list_maps())


@app.route("/api/map/<map_id>", methods=["GET"])
def get_map(map_id):
    """Получить данные конкретной карты"""
    data = load_map_data(map_id)
    if data is None:
        return jsonify({"error": "Map not found"}), 404

    # Конвертируем старые данные сетки в новый формат
    if "grid_settings" in data:
        # Если есть cell_size, но нет cell_count, конвертируем
        if (
            "cell_size" in data["grid_settings"]
            and "cell_count" not in data["grid_settings"]
        ):
            # Временное значение, будет пересчитано на клиенте при загрузке изображения
            data["grid_settings"]["cell_count"] = 20
            print(
                f"Converted old grid data for map {map_id}: cell_size={data['grid_settings']['cell_size']}, cell_count set to 20"
            )

        # Убеждаемся, что cell_count существует и в допустимых пределах
        if "cell_count" not in data["grid_settings"]:
            data["grid_settings"]["cell_count"] = 20
        else:
            # Проверяем границы
            if data["grid_settings"]["cell_count"] < 5:
                data["grid_settings"]["cell_count"] = 5
            elif data["grid_settings"]["cell_count"] > 150:
                data["grid_settings"]["cell_count"] = 150

    # Добавляем изображение отдельно, если оно есть
    image_base64 = load_map_image(map_id)
    if image_base64:
        data["map_image_base64"] = image_base64

    # Добавляем URL портретов для персонажей
    if "characters" in data:
        for character in data["characters"]:
            if character.get("has_avatar"):
                from utils.storage import get_portrait_url

                character["portrait_url"] = get_portrait_url(character["id"])
                print(
                    f"Character {character['id']} portrait URL: {character['portrait_url']}"
                )
            # Удаляем старые данные аватара если они есть
            character.pop("avatar_data", None)

    # Добавляем URL аватаров для токенов
    if "tokens" in data:
        for token in data["tokens"]:
            if token.get("has_avatar"):
                from utils.storage import get_token_avatar_url

                token["avatar_url"] = get_token_avatar_url(token["id"])
                print(f"Token {token['id']} avatar URL: {token['avatar_url']}")
            token.pop("avatar_data", None)

    old_map_id = session.get("current_map_id")
    session["current_map_id"] = map_id

    # Если карта действительно сменилась (не та же самая)
    if old_map_id and old_map_id != map_id:
        # Уведомляем всех о смене карты
        socketio.emit("master_switched_map", {"map_id": map_id})
        print(f"Map switched from {old_map_id} to {map_id}")

    return jsonify(data)


@app.route("/api/map/image/<map_id>")
def get_map_image(map_id):
    """Получить изображение карты как файл"""
    image_path = get_image_filepath(map_id)
    if os.path.exists(image_path):
        return send_file(image_path, mimetype="image/jpeg")
    return "", 404


@socketio.on("characters_updated")
def handle_characters_updated(data):
    """Обработчик обновления портретов"""
    map_id = data.get("map_id")
    if not map_id:
        return

    characters = data.get("characters")
    if not characters:
        return

    # Отправляем всем, кроме отправителя
    emit(
        "characters_updated",
        {"map_id": map_id, "characters": characters},
        broadcast=True,
        include_self=False,
    )


@app.route("/api/map", methods=["POST"])
def save_map():
    """Сохранить текущую карту"""
    data = request.get_json()

    # Берем ID из данных, а не из сессии!
    map_id = data.get("map_id")

    if not map_id:
        # Если нет в данных, пробуем из сессии (для обратной совместимости)
        map_id = session.get("current_map_id")
        if not map_id:
            return jsonify({"error": "No map ID provided"}), 400
        print(
            f"Warning: Saving without map_id in body, using session: {map_id}"
        )
    else:
        # Если ID передан, обновляем сессию
        session["current_map_id"] = map_id

    # Убеждаемся, что visible_to_players есть в grid_settings
    if "grid_settings" in data:
        if "visible_to_players" not in data["grid_settings"]:
            data["grid_settings"]["visible_to_players"] = True

    # Сохраняем данные
    save_map_data(data, map_id)

    # Подготавливаем данные для игроков с актуальными URL аватаров
    tokens_for_players = []
    for token in data.get("tokens", []):
        token_copy = token.copy()
        if token_copy.get("has_avatar"):
            from utils.storage import get_token_avatar_url

            base_url = get_token_avatar_url(token_copy["id"])
            token_copy["avatar_url"] = f"{base_url}?t={int(time.time())}"
        token_copy.pop("avatar_data", None)
        tokens_for_players.append(token_copy)

    # Подготавливаем данные персонажей для игроков (если нужно)
    characters_for_players = []
    for character in data.get("characters", []):
        character_copy = character.copy()
        if character_copy.get("has_avatar"):
            from utils.storage import get_portrait_url

            base_url = get_portrait_url(character_copy["id"])
            character_copy["portrait_url"] = f"{base_url}?t={int(time.time())}"
        character_copy.pop("avatar_data", None)
        characters_for_players.append(character_copy)

    player_data = {
        "map_id": map_id,
        "tokens": tokens_for_players,
        "characters": characters_for_players,
        "zones": data.get("zones", []),
        "finds": data.get("finds", []),
        "grid_settings": data.get("grid_settings", {}),
        "ruler_visible_to_players": data.get(
            "ruler_visible_to_players", False
        ),
        "ruler_start": data.get("ruler_start"),
        "ruler_end": data.get("ruler_end"),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False),
    }

    # Если есть изображение, добавляем URL для загрузки
    if data.get("has_image"):
        player_data["image_url"] = (
            f"/api/map/image/{map_id}?t={int(time.time())}"
        )

    socketio.emit("map_updated", player_data)
    return jsonify({"status": "ok"})


@app.route("/api/map/new", methods=["POST"])
def new_map():
    """Создать новую карту"""
    map_data = request.get_json()
    name = map_data.get("name", "Новая карта")

    # Создаем новую карту
    map_id = create_new_map(name)

    # Получаем всех героев (токены-игроки) с других карт
    from utils.storage import get_all_heroes_from_maps

    all_heroes = get_all_heroes_from_maps()

    if all_heroes:
        print(f"Found {len(all_heroes)} heroes from other maps")

        # Загружаем данные новой карты
        new_map_data = load_map_data(map_id)

        # Инициализируем массив tokens если его нет
        if "tokens" not in new_map_data:
            new_map_data["tokens"] = []

        # Вычисляем центр карты для размещения токенов
        center_x = 500
        center_y = 500

        # Проверяем, есть ли изображение карты
        image_path = get_image_filepath(map_id)
        if os.path.exists(image_path):
            try:
                from PIL import Image

                img = Image.open(image_path)
                center_x = img.width / 2
                center_y = img.height / 2
            except:
                pass

        # Располагаем героев по кругу
        radius = min(center_x, center_y) * 0.3

        for index, hero in enumerate(all_heroes):
            # Вычисляем позицию по кругу
            if len(all_heroes) > 1:
                angle = (2 * math.pi * index) / len(all_heroes)
                pos_x = center_x + math.cos(angle) * radius
                pos_y = center_y + math.sin(angle) * radius
            else:
                pos_x = center_x
                pos_y = center_y

            # ВАЖНО: Используем тот же ID, что и у героя
            token = {
                "id": hero["id"],  # Оставляем оригинальный ID!
                "name": hero["name"],
                "position": [pos_x, pos_y],
                "size": 20,
                "is_dead": False,
                "is_player": True,
                "is_npc": hero.get("is_npc", False),
                "armor_class": hero.get("armor_class", 10),
                "health_points": hero.get("health_points", 10),
                "max_health_points": hero.get("max_health_points", 10),
                "has_avatar": hero.get("has_avatar", False),
                "avatar_url": hero.get("avatar_url"),
                "is_visible": True,
            }

            new_map_data["tokens"].append(token)

        # Сохраняем обновленные данные
        save_map_data(new_map_data, map_id)
        print(
            f"Added {len(all_heroes)} hero tokens to new map with original IDs"
        )

    session["current_map_id"] = map_id

    # Получаем обновленный список карт
    maps = list_maps()

    # Отправляем событие о создании новой карты всем клиентам
    socketio.emit(
        "map_created", {"map_id": map_id, "maps": maps, "current_map": map_id}
    )

    return jsonify(
        {"status": "ok", "map_id": map_id, "maps": maps, "current_map": map_id}
    )


@app.route("/api/map/delete/<map_id>", methods=["DELETE"])
def delete_map_route(map_id):
    """Удалить карту"""
    if delete_map(map_id):
        # Если удалили текущую карту
        if session.get("current_map_id") == map_id:
            maps = list_maps()
            if maps:
                session["current_map_id"] = maps[0]["id"]
            else:
                session["current_map_id"] = None
        return jsonify({"status": "ok", "maps": list_maps()})
    return jsonify({"status": "error"}), 404


@app.route("/api/token/avatar/<token_id>", methods=["DELETE"])
def delete_token_avatar(token_id):
    """Удалить аватар токена"""
    from utils.storage import delete_token_avatar

    if delete_token_avatar(token_id):
        return jsonify({"status": "ok"})
    return jsonify({"status": "error"}), 404


@app.route("/api/token/avatar/<token_id>", methods=["POST"])
def upload_token_avatar(token_id):
    """Загрузить аватар токена"""
    try:
        data = request.get_json()
        avatar_data = data.get("avatar_data")

        if not avatar_data:
            return jsonify({"error": "No avatar data"}), 400

        from utils.storage import save_token_avatar

        if save_token_avatar(avatar_data, token_id):
            return jsonify({"status": "ok"})
        return jsonify({"error": "Failed to save avatar"}), 500
    except Exception as e:
        print(f"Error uploading token avatar: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/token/avatar/<token_id>")
def get_token_avatar(token_id):
    """Получить аватар токена как файл"""
    from utils.storage import get_token_avatar_filepath

    image_path = get_token_avatar_filepath(token_id)
    print(f"Looking for token avatar at: {image_path}")
    print(f"File exists: {os.path.exists(image_path)}")

    if os.path.exists(image_path):
        print(f"File size: {os.path.getsize(image_path)} bytes")
        return send_file(image_path, mimetype="image/png")

    # Если файл не найден, создаем заглушку на лету
    return create_default_avatar()


@app.route("/api/token/<token_id>/sync", methods=["POST"])
def sync_token_across_maps(token_id):
    """Синхронизировать изменения токена на всех картах"""
    try:
        data = request.get_json()
        print(f"\n=== Syncing token {token_id} across all maps ===")
        print(f"Sync data: {data}")

        # Получаем список всех карт, где есть этот токен
        from utils.storage import (
            get_all_maps_with_token,
            sync_token_across_maps as sync_storage,
        )

        maps_with_token = get_all_maps_with_token(token_id)
        print(f"Token found on {len(maps_with_token)} maps")

        # Используем функцию из storage для синхронизации
        updated_maps = sync_storage(token_id, data)

        # Отправляем обновления игрокам на всех картах
        for map_id in updated_maps:
            map_data = load_map_data(map_id)
            if map_data:
                # Подготавливаем данные для игроков
                tokens_for_players = []
                for t in map_data.get("tokens", []):
                    token_copy = t.copy()
                    if token_copy.get("has_avatar"):
                        from utils.storage import get_token_avatar_url

                        token_copy["avatar_url"] = (
                            get_token_avatar_url(token_copy["id"])
                            + f"?t={int(time.time())}"
                        )
                    token_copy.pop("avatar_data", None)
                    tokens_for_players.append(token_copy)

                player_data = {
                    "map_id": map_id,
                    "tokens": tokens_for_players,
                    "zones": map_data.get("zones", []),
                    "finds": map_data.get("finds", []),
                    "grid_settings": map_data.get("grid_settings", {}),
                    "player_map_enabled": map_data.get(
                        "player_map_enabled", True
                    ),
                    "has_image": map_data.get("has_image", False),
                }

                if map_data.get("has_image"):
                    player_data["image_url"] = (
                        f"/api/map/image/{map_id}?t={int(time.time())}"
                    )

                socketio.emit("map_updated", player_data)

        # Уведомляем всех мастеров о синхронизации
        if updated_maps:
            socketio.emit(
                "token_synced_across_maps",
                {
                    "token_id": token_id,
                    "updated_data": data,
                    "updated_maps": updated_maps,
                },
                broadcast=True,
            )

        print(f"Token {token_id} updated on {len(updated_maps)} maps")
        return jsonify({"status": "ok", "updated_maps": updated_maps})

    except Exception as e:
        print(f"Error syncing token: {e}")
        import traceback

        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/token/avatar/<source_token_id>/copy", methods=["POST"])
def copy_token_avatar(source_token_id):
    """Скопировать аватар токена"""
    try:
        data = request.get_json()
        target_token_id = data.get("target_token_id")

        if not target_token_id:
            return jsonify({"error": "No target token ID"}), 400

        from utils.storage import get_token_avatar_filepath, save_token_avatar

        source_path = get_token_avatar_filepath(source_token_id)
        if not os.path.exists(source_path):
            return jsonify({"error": "Source avatar not found"}), 404

        # Читаем исходный файл
        with open(source_path, "rb") as f:
            avatar_data = f.read()

        # Сохраняем для нового токена
        if save_token_avatar(avatar_data, target_token_id):
            return jsonify({"status": "ok"})

        return jsonify({"error": "Failed to copy avatar"}), 500
    except Exception as e:
        print(f"Error copying avatar: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/tokens", methods=["GET"])
def get_tokens():
    map_id = session.get("current_map_id")
    if not map_id:
        return jsonify([])
    data = load_map_data(map_id)
    return jsonify(data.get("tokens", []) if data else [])


@app.route("/api/zones", methods=["GET"])
def get_zones():
    map_id = session.get("current_map_id")
    if not map_id:
        return jsonify([])
    data = load_map_data(map_id)
    return jsonify(data.get("zones", []) if data else [])


@app.route("/api/finds", methods=["GET"])
def get_finds():
    map_id = session.get("current_map_id")
    if not map_id:
        return jsonify([])
    data = load_map_data(map_id)
    return jsonify(data.get("finds", []) if data else [])


@app.route("/api/token", methods=["POST"])
def add_token():
    print("\n" + "=" * 50)
    print("TOKEN API CALLED")
    print("=" * 50)

    try:
        token = request.get_json()
        print(f"Received JSON data: {token}")
    except Exception as e:
        print(f"Error parsing JSON: {e}")
        return jsonify({"error": "Invalid JSON"}), 400

    # Извлекаем avatar_data из полученных данных
    avatar_data = token.pop("avatar_data", None) if token else None

    print(f"Token data: {token}")
    print(f"Avatar data present: {bool(avatar_data)}")

    map_id = session.get("current_map_id")
    if not map_id:
        print("No map selected")
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        print(f"Map {map_id} not found")
        return jsonify({"error": "Map not found"}), 404

    # Сохраняем аватар как файл, если он есть
    avatar_url = None
    if avatar_data:
        print(f"\n=== Calling save_token_avatar for token {token['id']} ===")
        success = save_token_avatar(avatar_data, token["id"])
        if success:
            token["has_avatar"] = True
            # Сразу добавляем URL аватара с timestamp
            timestamp = int(time.time())
            avatar_url = f"/api/token/avatar/{token['id']}?t={timestamp}"
            token["avatar_url"] = avatar_url
            print(f"✓ Avatar saved successfully, URL: {avatar_url}")

            # Проверяем, что файл действительно создан
            from utils.storage import get_token_avatar_filepath

            filepath = get_token_avatar_filepath(token["id"])
            print(f"Avatar file exists: {os.path.exists(filepath)}")
        else:
            token["has_avatar"] = False
            print(f"✗ Failed to save avatar")
    else:
        token["has_avatar"] = False
        print("No avatar data provided")

    # Добавляем токен в данные
    data.setdefault("tokens", []).append(token)
    print(f"Tokens count after adding: {len(data['tokens'])}")

    # Сохраняем данные
    save_map_data(data, map_id)
    print(f"Map data saved for map {map_id}")

    # Подготавливаем данные для игроков
    tokens_for_players = []
    for t in data.get("tokens", []):
        token_copy = t.copy()
        if token_copy.get("has_avatar"):
            from utils.storage import get_token_avatar_url

            token_copy["avatar_url"] = get_token_avatar_url(token_copy["id"])
        token_copy.pop("avatar_data", None)
        tokens_for_players.append(token_copy)

    # Отправляем обновление всем игрокам
    player_data = {
        "map_id": map_id,
        "tokens": tokens_for_players,
        "zones": data.get("zones", []),
        "finds": data.get("finds", []),
        "grid_settings": data.get("grid_settings", {}),
        "ruler_visible_to_players": data.get(
            "ruler_visible_to_players", False
        ),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False),
    }

    if data.get("has_image"):
        player_data["image_url"] = (
            f"/api/map/image/{map_id}?t={int(time.time())}"
        )

    socketio.emit("map_updated", player_data)
    print("Map updated event sent to players")

    # Возвращаем URL аватара в ответе
    return jsonify(
        {
            "status": "token added",
            "token_id": token["id"],
            "avatar_url": avatar_url,
        }
    )


@app.route("/favicon.ico")
def favicon():
    return "", 204


@app.route("/player")
def player_view():
    map_id = request.args.get("map_id")
    if not map_id:
        # Если map_id не передан, берем текущую карту из сессии мастера
        map_id = session.get("current_map_id")

        # Если и в сессии нет, берем первую из списка
        if not map_id:
            maps = list_maps()
            map_id = maps[0]["id"] if maps else None

    # Передаем map_id в шаблон
    return render_template("player.html", map_id=map_id)


@app.route("/api/zone", methods=["POST"])
def add_zone():
    zone = request.get_json()
    map_id = session.get("current_map_id")
    if not map_id:
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404

    data.setdefault("zones", []).append(zone)
    save_map_data(data, map_id)

    # Отправляем обновление всем игрокам
    player_data = {
        "map_id": map_id,
        "tokens": data.get("tokens", []),
        "zones": data.get("zones", []),
        "finds": data.get("finds", []),
        "grid_settings": data.get("grid_settings", {}),
        "ruler_visible_to_players": data.get(
            "ruler_visible_to_players", False
        ),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False),
    }

    if data.get("has_image"):
        player_data["image_url"] = (
            f"/api/map/image/{map_id}?t={int(time.time())}"
        )

    socketio.emit("map_updated", player_data)
    return jsonify({"status": "zone added"})


@app.route("/api/find", methods=["POST"])
def add_find():
    find = request.get_json()
    map_id = session.get("current_map_id")
    if not map_id:
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404

    data.setdefault("finds", []).append(find)
    save_map_data(data, map_id)

    # Отправляем обновление всем игрокам
    player_data = {
        "map_id": map_id,
        "tokens": data.get("tokens", []),
        "zones": data.get("zones", []),
        "finds": data.get("finds", []),
        "grid_settings": data.get("grid_settings", {}),
        "ruler_visible_to_players": data.get(
            "ruler_visible_to_players", False
        ),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False),
    }

    if data.get("has_image"):
        player_data["image_url"] = (
            f"/api/map/image/{map_id}?t={int(time.time())}"
        )

    socketio.emit("map_updated", player_data)
    return jsonify({"status": "find added"})


@app.route("/upload_map", methods=["POST"])
def upload_map():
    """Загрузить изображение карты"""
    if "map_image" not in request.files:
        return "No file", 400
    file = request.files["map_image"]
    if file.filename == "":
        return "No selected file", 400

    map_id = session.get("current_map_id")
    if not map_id:
        # Если нет текущей карты, создаем новую
        map_id = create_new_map("Новая карта")
        session["current_map_id"] = map_id

    # Сохраняем изображение
    if save_map_image(file.read(), map_id):
        # Обновляем данные карты
        data = load_map_data(map_id)
        data["has_image"] = True
        save_map_data(data, map_id)

        # Получаем изображение в base64 для мастера
        image_base64 = load_map_image(map_id)

        # Отправляем обновление мастеру (с base64 для немедленного отображения)
        socketio.emit(
            "map_image_updated",
            {
                "map_id": map_id,
                "map_image_base64": image_base64,
                "has_image": True,
            },
            room=request.sid,
        )

        # Подготавливаем данные для игроков
        player_data = {
            "map_id": map_id,
            "tokens": data.get("tokens", []),
            "zones": data.get("zones", []),
            "finds": data.get("finds", []),
            "grid_settings": data.get("grid_settings", {}),
            "ruler_visible_to_players": data.get(
                "ruler_visible_to_players", False
            ),
            "player_map_enabled": data.get("player_map_enabled", True),
            "has_image": True,
            "image_url": f"/api/map/image/{map_id}?t={int(time.time())}",
        }

        # Отправляем ВСЕМ игрокам (включая того, кто уже подключен)
        socketio.emit("map_updated", player_data, broadcast=True)

        # Также отправляем специальное событие для принудительной перезагрузки изображения
        socketio.emit(
            "force_image_reload",
            {
                "map_id": map_id,
                "image_url": f"/api/map/image/{map_id}?t={int(time.time())}",
            },
            broadcast=True,
        )

    return redirect("/")


@socketio.on("notify_image_loaded")
def handle_notify_image_loaded(data):
    """Обработчик уведомления о загрузке изображения мастером"""
    map_id = data.get("map_id")
    image_url = data.get("image_url")

    if map_id and image_url:
        # Отправляем всем игрокам
        emit(
            "force_image_reload",
            {"map_id": map_id, "image_url": image_url},
            broadcast=True,
            include_self=False,
        )


@socketio.on("connect")
def handle_connect():
    print(f"Client connected: {request.sid}")

    # Проверяем, является ли подключившийся мастером
    session_id = session.get("session_id")
    if session_id and request.path == "/socket.io/":  # Это мастер
        success, lock = acquire_master_lock(session_id, request.sid)
        if success:
            print(f"Master lock acquired for session {session_id}")
            # Запускаем пинг для поддержания блокировки
            emit("master_status", {"active": True, "is_current": True})
        else:
            print(f"Failed to acquire master lock for session {session_id}")
            # Отключаем сокет
            emit("master_status", {"active": False, "is_current": False})
            disconnect()


@socketio.on("disconnect")
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")

    # Освобождаем блокировку если это был мастер
    session_id = session.get("session_id")
    if session_id:
        release_master_lock(session_id)


@socketio.on("ruler_update")
def handle_ruler_update(data):
    """Обработчик обновления линейки с throttle"""
    # Всегда берем map_id из данных, не из сессии!
    map_id = data.get("map_id")
    if not map_id:
        print("No map_id in ruler_update")
        return

    client_id = request.sid
    current_time = time.time()

    # Throttle: обновляем не чаще чем раз в 50ms
    if client_id in last_ruler_updates:
        if current_time - last_ruler_updates[client_id] < 0.05:  # 50ms
            return

    last_ruler_updates[client_id] = current_time

    # Больше не сохраняем линейку в JSON — только рассылаем событие
    # Отправляем всем, кроме отправителя
    emit(
        "ruler_update",
        {
            "map_id": map_id,
            "ruler_start": data.get("ruler_start"),
            "ruler_end": data.get("ruler_end"),
        },
        broadcast=True,
        include_self=False,
    )


@socketio.on("zoom_update")
def handle_zoom_update(data):
    print("Received zoom_update:", data)
    map_id = data.get("map_id")
    if not map_id:
        map_id = session.get("current_map_id")

    if not map_id:
        print("No map_id in zoom_update")
        return

    map_data = load_map_data(map_id)
    if not map_data:
        print(f"Map data not found for {map_id}")
        return

    map_data["zoom_level"] = data.get("zoom_level", 1)
    map_data["pan_x"] = data.get("pan_x", 0)
    map_data["pan_y"] = data.get("pan_y", 0)
    map_data["master_canvas_width"] = data.get(
        "canvas_width", map_data.get("master_canvas_width", 1380)
    )
    map_data["master_canvas_height"] = data.get(
        "canvas_height", map_data.get("master_canvas_height", 1080)
    )

    save_map_data(map_data, map_id)

    # Отправляем всем, кроме отправителя
    emit(
        "zoom_update",
        {
            "map_id": map_id,
            "zoom_level": map_data["zoom_level"],
            "pan_x": map_data["pan_x"],
            "pan_y": map_data["pan_y"],
            "canvas_width": map_data["master_canvas_width"],
            "canvas_height": map_data["master_canvas_height"],
        },
        broadcast=True,
        include_self=False,
    )
    print(f"Sent zoom_update to others for map {map_id}")


@socketio.on("switch_map")
def handle_switch_map(data):
    """Обработчик смены карты мастером"""
    map_id = data.get("map_id")
    print(
        f"Received switch_map event for map: {map_id} from client {request.sid}"
    )

    # Отправляем всем КРОМЕ отправителя, что карта сменилась
    emit(
        "master_switched_map",
        {"map_id": map_id},
        broadcast=True,
        include_self=False,
    )
    print(f"Notified players about map switch to {map_id}")


@socketio.on("request_map_sync")
def handle_map_sync(data):
    """Обработчик запроса синхронизации карты от клиента"""
    map_id = data.get("map_id")
    if not map_id:
        map_id = session.get("current_map_id")

    if map_id:
        map_data = load_map_data(map_id)
        if map_data:
            # Отправляем только этому клиенту
            emit(
                "map_sync",
                {
                    "map_id": map_id,
                    "zoom_level": map_data.get("zoom_level", 1),
                    "pan_x": map_data.get("pan_x", 0),
                    "pan_y": map_data.get("pan_y", 0),
                },
            )


@socketio.on("player_visibility_change")
def handle_player_visibility_change(data):
    """Обработчик изменения видимости карты для игроков"""
    map_id = data.get("map_id")
    if not map_id:
        return

    print(
        f"Player visibility changed for map {map_id}: {data.get('player_map_enabled')}"
    )

    # Загружаем данные карты, чтобы получить актуальную информацию об изображении
    map_data = load_map_data(map_id)
    has_image = map_data.get("has_image", False) if map_data else False

    # Сохраняем новое значение в данные карты
    if map_data:
        map_data["player_map_enabled"] = data.get("player_map_enabled", True)
        save_map_data(map_data, map_id)

    # Подготавливаем данные для отправки
    visibility_data = {
        "map_id": map_id,
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": has_image,
    }

    # Если карта стала видимой и есть изображение, добавляем URL
    if data.get("player_map_enabled", True) and has_image:
        visibility_data["image_url"] = (
            f"/api/map/image/{map_id}?t={int(time.time())}"
        )

    # Отправляем всем игрокам
    emit(
        "map_visibility_change",
        visibility_data,
        broadcast=True,
        include_self=False,
    )

    # Если карта стала видимой, также отправляем полные данные
    if data.get("player_map_enabled", True) and map_data:
        # Подготавливаем полные данные карты для игроков
        tokens_for_players = []
        for token in map_data.get("tokens", []):
            token_copy = token.copy()
            if token_copy.get("has_avatar"):
                from utils.storage import get_token_avatar_url

                token_copy["avatar_url"] = get_token_avatar_url(
                    token_copy["id"]
                )
            token_copy.pop("avatar_data", None)
            tokens_for_players.append(token_copy)

        full_update = {
            "map_id": map_id,
            "tokens": tokens_for_players,
            "zones": map_data.get("zones", []),
            "finds": map_data.get("finds", []),
            "grid_settings": map_data.get("grid_settings", {}),
            "ruler_visible_to_players": map_data.get(
                "ruler_visible_to_players", False
            ),
            "ruler_start": map_data.get("ruler_start"),
            "ruler_end": map_data.get("ruler_end"),
            "player_map_enabled": True,
            "has_image": has_image,
        }

        if has_image:
            full_update["image_url"] = (
                f"/api/map/image/{map_id}?t={int(time.time())}"
            )

        # Небольшая задержка перед отправкой полных данных
        socketio.sleep(0.1)
        emit("map_updated", full_update, broadcast=True, include_self=False)


@socketio.on("force_map_update")
def handle_force_map_update(data):
    """Принудительное обновление карты для игроков"""
    map_id = data.get("map_id")
    if not map_id:
        return

    print(f"Forcing map update for map {map_id}")

    # Отправляем всем игрокам
    emit("map_updated", data, broadcast=True, include_self=False)

    # Также отправляем событие о видимости для надёжности
    emit(
        "map_visibility_change",
        {
            "map_id": map_id,
            "player_map_enabled": True,
            "has_image": data.get("has_image", False),
            "image_url": data.get("image_url"),
        },
        broadcast=True,
        include_self=False,
    )


@socketio.on("request_map_image")
def handle_request_map_image(data):
    """Обработчик запроса изображения карты"""
    map_id = data.get("map_id")
    if map_id:
        image_base64 = load_map_image(map_id)
        if image_base64:
            emit(
                "map_image_updated",
                {
                    "map_id": map_id,
                    "map_image_base64": image_base64,
                    "has_image": True,
                },
                room=request.sid,
            )


@socketio.on("map_image_updated_to_player")
def handle_map_image_updated_to_player(data):
    """Обработчик уведомления об обновлении изображения карты"""
    map_id = data.get("map_id")
    if map_id:
        # Передаем всем игрокам
        emit(
            "map_image_updated_to_player",
            {"map_id": map_id, "has_image": data.get("has_image", True)},
            broadcast=True,
            include_self=False,
        )


@socketio.on("ruler_visibility_change")
def handle_ruler_visibility_change(data):
    """Обработчик изменения видимости линейки для игроков"""
    map_id = data.get("map_id")
    if not map_id:
        return

    print(
        f"Ruler visibility change for map {map_id}: {data.get('ruler_visible_to_players')}"
    )

    # Обновляем данные карты
    map_data = load_map_data(map_id)
    if map_data:
        map_data["ruler_visible_to_players"] = data.get(
            "ruler_visible_to_players", False
        )
        save_map_data(map_data, map_id)

    # Отправляем всем игрокам
    emit(
        "ruler_visibility_change",
        {
            "map_id": map_id,
            "ruler_visible_to_players": data.get(
                "ruler_visible_to_players", False
            ),
        },
        broadcast=True,
        include_self=False,
    )


@app.route("/api/token/<token_id>", methods=["PUT"])
def update_token(token_id):
    """Обновить существующий токен"""
    print(f"\n=== Updating token {token_id} ===")

    try:
        token = request.get_json()
        print(f"Received token data: {token}")
    except Exception as e:
        print(f"Error parsing JSON: {e}")
        return jsonify({"error": "Invalid JSON"}), 400

    # Извлекаем avatar_data из полученных данных
    avatar_data = token.pop("avatar_data", None) if token else None

    map_id = session.get("current_map_id")
    if not map_id:
        print("No map selected")
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        print(f"Map {map_id} not found")
        return jsonify({"error": "Map not found"}), 404

    # Находим и обновляем токен
    tokens = data.get("tokens", [])
    token_found = False
    avatar_changed = False

    for i, t in enumerate(tokens):
        if t.get("id") == token_id:
            # Сохраняем старые значения
            old_has_avatar = t.get("has_avatar", False)
            old_avatar_url = t.get("avatar_url")

            # Сохраняем существующий аватар, если не передан новый
            if old_has_avatar and not avatar_data:
                token["has_avatar"] = True
                token["avatar_url"] = old_avatar_url
                print(f"Keeping existing avatar for token {token_id}")

            # Обновляем остальные поля токена
            token["id"] = token_id
            if "position" not in token and "position" in t:
                token["position"] = t["position"]

            # Обновляем токен
            tokens[i] = token
            token_found = True

            # Обрабатываем новый аватар, если он передан
            if avatar_data:
                print(f"Saving new avatar for token {token_id}")
                success = save_token_avatar(avatar_data, token_id)
                if success:
                    token["has_avatar"] = True
                    timestamp = int(time.time())
                    token["avatar_url"] = (
                        f"/api/token/avatar/{token_id}?t={timestamp}"
                    )
                    print(
                        f"✓ Avatar updated successfully, new URL: {token['avatar_url']}"
                    )
                    avatar_changed = True
                else:
                    token["has_avatar"] = False
                    print(f"✗ Failed to save avatar")

            break

    if not token_found:
        return jsonify({"error": "Token not found"}), 404

    # Сохраняем обновленные данные для ТЕКУЩЕЙ карты
    save_map_data(data, map_id)

    # ===== СИНХРОНИЗАЦИЯ НА ДРУГИХ КАРТАХ =====
    try:
        # Подготавливаем данные для синхронизации (без позиции)
        sync_data = {
            "name": token["name"],
            "armor_class": token["armor_class"],
            "health_points": token["health_points"],
            "max_health_points": token["max_health_points"],
            "is_player": token["is_player"],
            "is_npc": token["is_npc"],
            "is_dead": token["is_dead"],
            "has_avatar": token["has_avatar"],
        }

        # Если аватар изменился, добавляем URL
        if avatar_changed:
            sync_data["avatar_url"] = token["avatar_url"]

        # Получаем список всех карт, где есть этот токен
        from utils.storage import (
            get_all_maps_with_token,
            sync_token_across_maps,
        )

        # Используем функцию синхронизации
        updated_maps = sync_token_across_maps(token_id, sync_data)

        print(
            f"Token {token_id} synced on {len(updated_maps)} maps: {updated_maps}"
        )

        # Отправляем обновления игрокам на всех картах (кроме текущей)
        for other_map_id in updated_maps:
            if other_map_id != map_id:
                other_map_data = load_map_data(other_map_id)
                if other_map_data:
                    # Подготавливаем данные для игроков
                    tokens_for_players = []
                    for t in other_map_data.get("tokens", []):
                        token_copy = t.copy()
                        if token_copy.get("has_avatar"):
                            token_copy["avatar_url"] = (
                                f"/api/token/avatar/{token_copy['id']}?t={int(time.time())}"
                            )
                        token_copy.pop("avatar_data", None)
                        tokens_for_players.append(token_copy)

                    player_data = {
                        "map_id": other_map_id,
                        "tokens": tokens_for_players,
                        "zones": other_map_data.get("zones", []),
                        "finds": other_map_data.get("finds", []),
                        "grid_settings": other_map_data.get(
                            "grid_settings", {}
                        ),
                        "player_map_enabled": other_map_data.get(
                            "player_map_enabled", True
                        ),
                        "has_image": other_map_data.get("has_image", False),
                    }

                    if other_map_data.get("has_image"):
                        player_data["image_url"] = (
                            f"/api/map/image/{other_map_id}?t={int(time.time())}"
                        )

                    # Отправляем обновление на конкретную карту
                    socketio.emit("map_updated", player_data)

        # Уведомляем всех мастеров о синхронизации
        if len(updated_maps) > 0:
            socketio.emit(
                "token_synced_across_maps",
                {
                    "token_id": token_id,
                    "updated_data": sync_data,
                    "updated_maps": updated_maps,
                },
                broadcast=True,
            )

    except Exception as e:
        print(f"Error during cross-map sync: {e}")
        import traceback

        traceback.print_exc()
    # ===== КОНЕЦ СИНХРОНИЗАЦИИ =====

    # Подготавливаем данные для игроков на ТЕКУЩЕЙ карте
    tokens_for_players = []
    for t in data.get("tokens", []):
        token_copy = t.copy()
        if token_copy.get("has_avatar"):
            timestamp = int(time.time())
            token_copy["avatar_url"] = (
                f"/api/token/avatar/{token_copy['id']}?t={timestamp}"
            )
        token_copy.pop("avatar_data", None)
        tokens_for_players.append(token_copy)

    # Отправляем обновление игрокам на текущей карте
    player_data = {
        "map_id": map_id,
        "tokens": tokens_for_players,
        "zones": data.get("zones", []),
        "finds": data.get("finds", []),
        "grid_settings": data.get("grid_settings", {}),
        "ruler_visible_to_players": data.get(
            "ruler_visible_to_players", False
        ),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False),
    }

    if data.get("has_image"):
        player_data["image_url"] = (
            f"/api/map/image/{map_id}?t={int(time.time())}"
        )

    socketio.emit("map_updated", player_data)

    # Если аватар изменился, отправляем специальное событие
    if avatar_changed:
        timestamp = int(time.time())
        socketio.emit(
            "token_avatar_updated",
            {
                "map_id": map_id,
                "token_id": token_id,
                "avatar_url": f"/api/token/avatar/{token_id}?t={timestamp}",
            },
        )
        print(f"Sent token_avatar_updated event for token {token_id}")

    return jsonify({"status": "token updated"})


@socketio.on("force_avatar_reload")
def handle_force_avatar_reload(data):
    """Принудительная перезагрузка аватаров для всех игроков"""
    map_id = data.get("map_id")
    if map_id:
        emit(
            "force_avatar_reload",
            {"map_id": map_id},
            broadcast=True,
            include_self=False,
        )


@app.route("/api/bank/avatar/<character_id>")
def get_bank_avatar(character_id):
    """Получить аватар персонажа из банка как файл"""
    from utils.bank_storage import get_bank_avatar_filepath

    image_path = get_bank_avatar_filepath(character_id)

    if os.path.exists(image_path):
        return send_file(image_path, mimetype="image/png")

    # Возвращаем 404 если аватар не найден
    return "", 404


def create_default_avatar():
    """Создать заглушку для аватара"""
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Рисуем серый круг
    draw.ellipse(
        [20, 20, 236, 236],
        fill=(100, 100, 100, 255),
        outline=(150, 150, 150, 255),
        width=2,
    )

    # Добавляем вопросительный знак
    try:
        from PIL import ImageFont

        try:
            font = ImageFont.truetype(
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 120
            )
        except:
            font = ImageFont.load_default()

        draw.text(
            (128, 128), "?", fill=(150, 150, 150, 255), font=font, anchor="mm"
        )
    except:
        draw.line((78, 78, 178, 178), fill=(150, 150, 150, 255), width=10)
        draw.line((178, 78, 78, 178), fill=(150, 150, 150, 255), width=10)

    img_io = io.BytesIO()
    img.save(img_io, "PNG")
    img_io.seek(0)
    return img_io


@app.route("/api/token/<token_id>", methods=["DELETE"])
def delete_token(token_id):
    """Удалить токен и его аватар (только если не используется на других картах)"""
    map_id = session.get("current_map_id")
    if not map_id:
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404

    # Проверяем, есть ли токен в данных текущей карты
    token_exists = any(t.get("id") == token_id for t in data.get("tokens", []))
    if not token_exists:
        return jsonify({"error": "Token not found on current map"}), 404

    # Удаляем токен из данных текущей карты
    data["tokens"] = [
        t for t in data.get("tokens", []) if t.get("id") != token_id
    ]
    save_map_data(data, map_id)

    # Проверяем, используется ли этот токен на ДРУГИХ картах
    from utils.storage import get_all_maps_with_token

    maps_with_token = get_all_maps_with_token(token_id)

    # Фильтруем текущую карту из списка
    other_maps = [m for m in maps_with_token if m["map_id"] != map_id]

    print(
        f"Token {token_id} is used on {len(other_maps)} other maps: {other_maps}"
    )

    # Удаляем аватар ТОЛЬКО если токен НЕ используется на других картах
    if not other_maps:
        from utils.storage import delete_token_avatar

        avatar_deleted = delete_token_avatar(token_id)
        if avatar_deleted:
            print(f"✓ Token {token_id} not used elsewhere, avatar deleted")
        else:
            print(
                f"✗ Token {token_id} avatar file not found or could not be deleted"
            )
    else:
        print(f"→ Token {token_id} used on other maps, keeping avatar")

    # Отправляем обновление игрокам
    socketio.emit(
        "map_updated",
        {
            "map_id": map_id,
            "tokens": data.get("tokens", []),
            "zones": data.get("zones", []),
            "finds": data.get("finds", []),
            "grid_settings": data.get("grid_settings", {}),
            "player_map_enabled": data.get("player_map_enabled", True),
            "has_image": data.get("has_image", False),
        },
    )

    return jsonify({"status": "token deleted"})


@app.route("/api/token/cleanup-avatars", methods=["POST"])
def cleanup_token_avatars():
    """Очистить аватары токенов, которые нигде не используются"""
    from utils.storage import TOKENS_AVATARS_DIR, get_all_maps_with_token

    deleted_count = 0
    kept_count = 0

    # Получаем все файлы аватаров
    if os.path.exists(TOKENS_AVATARS_DIR):
        for filename in os.listdir(TOKENS_AVATARS_DIR):
            if filename.endswith(".png"):
                token_id = filename[:-4]  # убираем .png

                # Проверяем, используется ли токен на каких-либо картах
                maps_with_token = get_all_maps_with_token(token_id)

                if not maps_with_token:
                    # Токен нигде не используется - удаляем аватар
                    filepath = os.path.join(TOKENS_AVATARS_DIR, filename)
                    try:
                        os.remove(filepath)
                        deleted_count += 1
                        print(f"Cleaned up unused avatar: {filename}")
                    except Exception as e:
                        print(f"Error deleting {filename}: {e}")
                else:
                    kept_count += 1

    return jsonify(
        {"status": "ok", "deleted": deleted_count, "kept": kept_count}
    )


@app.route("/api/portrait/<portrait_id>")
def get_portrait(portrait_id):
    """Получить портрет персонажа как файл"""
    from utils.storage import get_portrait_filepath

    image_path = get_portrait_filepath(portrait_id)
    print(f"Looking for portrait at: {image_path}")
    print(f"File exists: {os.path.exists(image_path)}")

    if os.path.exists(image_path):
        print(f"File size: {os.path.getsize(image_path)} bytes")
        return send_file(image_path, mimetype="image/png")

    return "", 404


@app.route("/api/portrait/<portrait_id>", methods=["DELETE"])
def delete_portrait(portrait_id):
    """Удалить портрет персонажа"""
    from utils.storage import delete_portrait_image

    if delete_portrait_image(portrait_id):
        return jsonify({"status": "ok"})
    return jsonify({"status": "error"}), 404


@app.route("/api/portrait/upload", methods=["POST"])
def upload_portrait():
    """Загрузить изображение портрета"""
    try:
        if "portrait" not in request.files:
            return jsonify({"error": "No file"}), 400

        file = request.files["portrait"]
        character_id = request.form.get("character_id")

        if not character_id:
            return jsonify({"error": "No character ID"}), 400

        if file.filename == "":
            return jsonify({"error": "No selected file"}), 400

        # Проверяем размер файла (макс 5MB)
        file.seek(0, os.SEEK_END)
        file_length = file.tell()
        file.seek(0)

        if file_length > 5 * 1024 * 1024:  # 5MB
            return jsonify({"error": "File too large"}), 400

        # Сохраняем портрет
        from utils.storage import save_portrait_image

        if save_portrait_image(file.read(), character_id):
            return jsonify(
                {
                    "status": "ok",
                    "portrait_url": f"/api/portrait/{character_id}",
                }
            )

        return jsonify({"error": "Failed to save portrait"}), 500

    except Exception as e:
        print(f"Error uploading portrait: {e}")
        return jsonify({"error": str(e)}), 500


@socketio.on("token_move")
def handle_token_move(data):
    """Обработчик перемещения токена в реальном времени"""
    map_id = data.get("map_id")
    if not map_id:
        return

    token_id = data.get("token_id")
    position = data.get("position")

    if not token_id or not position:
        return

    # Отправляем всем, кроме отправителя
    emit(
        "token_move",
        {
            "map_id": map_id,
            "token_id": token_id,
            "position": position,
            "is_visible": data.get("is_visible", True),
            "is_dead": data.get("is_dead", False),
        },
        broadcast=True,
        include_self=False,
    )


@socketio.on("characters_reordered")
def handle_characters_reordered(data):
    """Обработчик изменения порядка портретов"""
    map_id = data.get("map_id")
    if not map_id:
        return

    characters = data.get("characters")
    if not characters:
        return

    print(f"Characters reordered for map {map_id}")

    # Загружаем данные карты
    map_data = load_map_data(map_id)
    if map_data:
        # Обновляем порядок портретов
        map_data["characters"] = characters
        save_map_data(map_data, map_id)

        # Отправляем всем, кроме отправителя
        emit(
            "characters_reordered",
            {"map_id": map_id, "characters": characters},
            broadcast=True,
            include_self=False,
        )


@app.route("/api/bank/characters", methods=["GET"])
def get_bank_characters():
    """Получить всех персонажей из банка"""
    characters = get_all_bank_characters()

    # Добавляем URL аватаров из банка, а не из токенов!
    for char in characters:
        if char.get("has_avatar"):
            # ИСПРАВЛЕНО: используем URL для банка, а не для токенов
            char["avatar_url"] = (
                f"/api/bank/avatar/{char['id']}?t={int(time.time())}"
            )
            print(
                f"Bank character {char['name']} avatar URL: {char['avatar_url']}"
            )

    return jsonify(characters)


@app.route("/api/bank/character", methods=["POST"])
def add_bank_character():
    """Добавить персонажа в банк"""
    try:
        data = request.get_json()

        # Извлекаем avatar_data если есть
        avatar_data = data.pop("avatar_data", None)

        # Добавляем в банк
        char_id = add_character_to_bank(data)

        # Если есть аватар, сохраняем его в банк
        if avatar_data:
            from utils.character_bank import save_bank_character_avatar

            save_bank_character_avatar(avatar_data, char_id)
            print(f"✓ Bank avatar saved for character {char_id}")

            # Также создаем копию для токена на текущей карте, если это нужно
            # Но это опционально

        return jsonify({"status": "ok", "id": char_id})
    except Exception as e:
        print(f"Error adding to bank: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/tokens/all", methods=["GET"])
def get_all_tokens():
    """Получить все токены со всех карт"""
    from utils.storage import get_all_tokens_from_maps

    tokens = get_all_tokens_from_maps()

    # Добавляем URL аватаров
    for token in tokens:
        if token.get("has_avatar"):
            from utils.storage import get_token_avatar_url

            token["avatar_url"] = get_token_avatar_url(token["id"])

    return jsonify(tokens)


@app.route("/api/bank/character/<char_id>", methods=["DELETE"])
def delete_bank_character(char_id):
    """Удалить персонажа из банка"""
    try:
        # Проверяем, используется ли этот персонаж на картах
        from utils.storage import get_all_maps_with_token

        maps_with_token = get_all_maps_with_token(char_id)

        print(
            f"Deleting bank character {char_id}, used on {len(maps_with_token)} maps"
        )

        # Если персонаж используется на картах, предупреждаем
        if maps_with_token:
            map_names = [m["map_name"] for m in maps_with_token]
            return jsonify(
                {
                    "error": f"Character is used on maps: {', '.join(map_names)}. Remove from maps first or delete maps."
                }
            ), 400

        # Удаляем аватар
        from utils.storage import delete_token_avatar

        delete_token_avatar(char_id)

        # Удаляем из базы данных
        delete_character_from_bank(char_id)

        return jsonify({"status": "ok"})
    except Exception as e:
        print(f"Error deleting from bank: {e}")
        return jsonify({"error": str(e)}), 500


@socketio.on("check_master_status")
def handle_check_master_status():
    """
    Проверка статуса мастера
    """
    session_id = session.get("session_id")
    current_master = get_current_master()

    if current_master:
        is_current = session_id and session_id == current_master.get(
            "session_id"
        )
        emit("master_status", {"active": True, "is_current": is_current})
    else:
        emit("master_status", {"active": False, "is_current": False})


@socketio.on("master_ping")
def handle_master_ping():
    """
    Пинг от мастера для поддержания блокировки
    """
    session_id = session.get("session_id")
    if session_id:
        if update_master_ping(session_id, request.sid):
            emit("pong")
        else:
            # Блокировка потеряна
            emit("master_status", {"active": False, "is_current": False})
            disconnect()


@app.route("/api/bank/character/<char_id>/spawn", methods=["POST"])
def spawn_bank_character(char_id):
    """Создать токен на карте из персонажа из банка"""
    try:
        data = request.get_json()
        map_id = data.get("map_id")
        position = data.get("position")

        if not map_id or not position:
            return jsonify({"error": "Missing map_id or position"}), 400

        # Получаем персонажа из банка
        bank_char = get_bank_character(char_id)
        if not bank_char:
            return jsonify({"error": "Character not found"}), 404

        # Загружаем данные карты
        map_data = load_map_data(map_id)
        if not map_data:
            return jsonify({"error": "Map not found"}), 404

        # Создаем токен
        token_id = f"token_{uuid.uuid4().hex[:8]}"

        token = {
            "id": token_id,
            "name": bank_char["name"],
            "position": position,
            "size": map_data.get("grid_settings", {}).get("cell_size", 20),
            "is_dead": False,
            "is_player": bank_char["type"] == "player",
            "is_npc": bank_char["type"] == "npc",
            "armor_class": bank_char["armor_class"],
            "health_points": bank_char["max_health"],
            "max_health_points": bank_char["max_health"],
            "has_avatar": bank_char.get("has_avatar", False),
            "is_visible": True,
        }

        # Копируем аватар из банка, если есть
        if bank_char.get("has_avatar"):
            from utils.storage import save_token_avatar
            from utils.bank_storage import get_bank_avatar_filepath

            bank_avatar_path = get_bank_avatar_filepath(char_id)
            if os.path.exists(bank_avatar_path):
                with open(bank_avatar_path, "rb") as f:
                    avatar_data = f.read()
                save_token_avatar(avatar_data, token_id)
                token["has_avatar"] = True
                token["avatar_url"] = (
                    f"/api/token/avatar/{token_id}?t={int(time.time())}"
                )
                print(f"✓ Avatar copied from bank to token {token_id}")

        # Добавляем токен на карту
        map_data.setdefault("tokens", []).append(token)
        save_map_data(map_data, map_id)

        # Подготавливаем данные для игроков
        tokens_for_players = []
        for t in map_data.get("tokens", []):
            token_copy = t.copy()
            if token_copy.get("has_avatar"):
                token_copy["avatar_url"] = (
                    f"/api/token/avatar/{token_copy['id']}?t={int(time.time())}"
                )
            token_copy.pop("avatar_data", None)
            tokens_for_players.append(token_copy)

        # Отправляем обновление
        player_data = {
            "map_id": map_id,
            "tokens": tokens_for_players,
            "zones": map_data.get("zones", []),
            "finds": map_data.get("finds", []),
            "grid_settings": map_data.get("grid_settings", {}),
            "player_map_enabled": map_data.get("player_map_enabled", True),
            "has_image": map_data.get("has_image", False),
        }

        if map_data.get("has_image"):
            player_data["image_url"] = (
                f"/api/map/image/{map_id}?t={int(time.time())}"
            )

        socketio.emit("map_updated", player_data)

        return jsonify({"status": "ok", "token": token})

    except Exception as e:
        print(f"Error spawning character: {e}")
        return jsonify({"error": str(e)}), 500


@socketio.on("maps_list_updated")
def handle_maps_list_updated(data):
    """Обработчик обновления списка карт"""
    emit("maps_list_updated", data, broadcast=True, include_self=False)


@app.route("/api/map/update/<map_id>", methods=["POST"])
def update_map(map_id):
    """Обновить карту (название и/или изображение)"""
    try:
        name = request.form.get("name")
        if not name:
            return jsonify({"error": "Name required"}), 400

        # Загружаем существующие данные
        map_data = load_map_data(map_id)
        if not map_data:
            return jsonify({"error": "Map not found"}), 404

        # Обновляем название
        map_data["name"] = name

        # Если загружено новое изображение
        if "map_image" in request.files:
            file = request.files["map_image"]
            if file.filename:
                if save_map_image(file.read(), map_id):
                    map_data["has_image"] = True

        # Сохраняем данные
        save_map_data(map_data, map_id)

        # Обновляем список карт для всех
        socketio.emit("maps_list_updated", {"maps": list_maps()})

        return jsonify({"status": "ok", "map_id": map_id})
    except Exception as e:
        print(f"Error updating map: {e}")


@app.route("/api/map/thumbnail/<map_id>")
def get_map_thumbnail(map_id):
    """Получить миниатюру карты"""
    from utils.storage import get_image_filepath
    from PIL import Image
    import io

    image_path = get_image_filepath(map_id)
    if not os.path.exists(image_path):
        return "", 404

    try:
        # Открываем изображение
        img = Image.open(image_path)

        # Создаем миниатюру
        img.thumbnail((100, 100), Image.Resampling.LANCZOS)

        # Сохраняем в BytesIO
        img_io = io.BytesIO()
        img.save(img_io, "JPEG", quality=70)
        img_io.seek(0)

        return send_file(img_io, mimetype="image/jpeg")
    except Exception as e:
        print(f"Error creating thumbnail: {e}")
        return "", 500


@app.route("/api/bank/character/<char_id>", methods=["PUT"])
def update_bank_character(char_id):
    """Обновить данные персонажа в банке"""
    try:
        data = request.get_json()

        # Извлекаем avatar_data если есть
        avatar_data = data.pop("avatar_data", None)

        # Обновляем в базе данных
        from utils.character_bank import update_character_in_bank

        update_character_in_bank(char_id, data)

        # Если есть новый аватар, сохраняем его
        if avatar_data:
            from utils.character_bank import save_bank_character_avatar

            save_bank_character_avatar(avatar_data, char_id)
            print(f"✓ Bank avatar updated for character {char_id}")

        return jsonify({"status": "ok"})
    except Exception as e:
        print(f"Error updating bank character: {e}")
        return jsonify({"error": str(e)}), 500


@app.before_request
def check_master_access():
    """
    Проверка доступа к мастер-страницам
    """
    # Пропускаем статические файлы и API запросы
    if request.path.startswith("/static/") or request.path.startswith("/api/"):
        return None

    # Пропускаем страницу блокировки
    if request.path == "/master-locked":
        return None

    # Пропускаем страницу игрока
    if request.path == "/player":
        return None

    # Проверяем, является ли запрос к мастер-интерфейсу
    if (
        request.path == "/"
        and not request.headers.get("X-Requested-With") == "XMLHttpRequest"
    ):
        # Получаем текущего мастера
        current_master = get_current_master()

        # Если мастер уже есть
        if current_master:
            session_id = session.get("session_id")
            # Если это не текущий мастер, перенаправляем на страницу блокировки
            if not session_id or session_id != current_master.get(
                "session_id"
            ):
                return redirect("/master-locked")

        # Если мастера нет, генерируем ID сессии
        if "session_id" not in session:
            import uuid

            session["session_id"] = str(uuid.uuid4())

    return None


@app.route("/master-locked")
def master_locked():
    """
    Страница, показываемая при попытке зайти вторым мастером
    """
    return render_template("master_locked.html")


@app.route("/api/master/status", methods=["GET"])
def master_status():
    """
    API для проверки статуса мастера
    """
    current_master = get_current_master()
    session_id = session.get("session_id")

    if current_master:
        is_current = session_id and session_id == current_master.get(
            "session_id"
        )
        return jsonify(
            {
                "active": True,
                "is_current": is_current,
                "master_info": {
                    "acquired_at": current_master.get("acquired_at"),
                    "last_seen": current_master.get("last_seen"),
                }
                if is_current
                else None,
            }
        )
    else:
        return jsonify({"active": False, "is_current": False})


@app.route("/api/master/release", methods=["POST"])
def release_master():
    """
    Принудительно освободить блокировку
    """
    session_id = session.get("session_id")
    if session_id and release_master_lock(session_id):
        return jsonify({"status": "ok"})
    return jsonify({"status": "error"}), 400


if __name__ == "__main__":
    # Создаем необходимые директории
    os.makedirs("data", exist_ok=True)
    os.makedirs("data/maps", exist_ok=True)
    os.makedirs("data/images", exist_ok=True)
    os.makedirs("data/token_avatars", exist_ok=True)

    # Запускаем приложение
    os.makedirs("data", exist_ok=True)
    socketio.run(
        app,
        host="192.168.0.163",  # ВАЖНО
        port=5000,
        debug=True,
        allow_unsafe_werkzeug=True,
    )
