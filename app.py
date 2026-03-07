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
from flask_socketio import SocketIO, emit
from PIL import Image

from utils.storage import (
    TOKENS_AVATARS_DIR,  # Добавьте эти импорты
    create_new_map,
    delete_map,
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
        "characters": characters_for_players,  # Добавляем персонажей
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
        center_x = 500  # Значения по умолчанию
        center_y = 500

        # Проверяем, есть ли изображение карты, чтобы использовать реальные размеры
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

            # Создаем токен для героя
            token = {
                "id": hero["id"],
                "name": hero["name"],
                "position": [pos_x, pos_y],
                "size": 20,  # Размер по умолчанию
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
        print(f"Added {len(all_heroes)} hero tokens to new map")

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
        avatar_data = data.get('avatar_data')
        
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
    
    # Создаем заглушку с прозрачным фоном
    from PIL import Image, ImageDraw
    img = Image.new('RGBA', (256, 256), (0, 0, 0, 0))  # Прозрачный фон
    
    # Рисуем серый круг с вопросительным знаком
    draw = ImageDraw.Draw(img)
    
    # Рисуем круг
    draw.ellipse([20, 20, 236, 236], fill=(100, 100, 100, 255), outline=(150, 150, 150, 255), width=2)
    
    # Добавляем вопросительный знак
    import textwrap
    try:
        # Пытаемся использовать шрифт побольше
        from PIL import ImageFont
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 120)
        except:
            font = ImageFont.load_default()
        
        # Рисуем "?" в центре
        draw.text((128, 128), "?", fill=(150, 150, 150, 255), font=font, anchor="mm")
    except:
        # Если не получается со шрифтом, рисуем простой крестик
        draw.line((78, 78, 178, 178), fill=(150, 150, 150, 255), width=10)
        draw.line((178, 78, 78, 178), fill=(150, 150, 150, 255), width=10)
    
    # Сохраняем в BytesIO
    img_io = io.BytesIO()
    img.save(img_io, 'PNG')
    img_io.seek(0)
    
    # Добавляем заголовки для отключения кэширования
    response = send_file(img_io, mimetype='image/png')
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    
    return response

@app.route("/api/token/avatar/<source_token_id>/copy", methods=["POST"])
def copy_token_avatar(source_token_id):
    """Скопировать аватар токена"""
    try:
        data = request.get_json()
        target_token_id = data.get('target_token_id')
        
        if not target_token_id:
            return jsonify({"error": "No target token ID"}), 400
        
        from utils.storage import get_token_avatar_filepath, save_token_avatar
        
        source_path = get_token_avatar_filepath(source_token_id)
        if not os.path.exists(source_path):
            return jsonify({"error": "Source avatar not found"}), 404
        
        # Читаем исходный файл
        with open(source_path, 'rb') as f:
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
        "ruler_visible_to_players": data.get("ruler_visible_to_players", False),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False),
    }

    if data.get("has_image"):
        player_data["image_url"] = f"/api/map/image/{map_id}?t={int(time.time())}"

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


@socketio.on("disconnect")
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")


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
            # Сохраняем старые значения для сравнения
            old_has_avatar = t.get("has_avatar", False)
            old_avatar_url = t.get("avatar_url")

            # Сохраняем существующий аватар, если не передан новый
            if old_has_avatar and not avatar_data:
                # Сохраняем флаг наличия аватара
                token["has_avatar"] = True
                token["avatar_url"] = old_avatar_url
                print(f"Keeping existing avatar for token {token_id}")

            # Обновляем остальные поля токена
            # Важно: сохраняем id, position и другие поля, которые могли не прийти
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
                    # Обновляем URL с timestamp для сброса кэша
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

    # Сохраняем обновленные данные
    save_map_data(data, map_id)

    # Подготавливаем данные для игроков
    tokens_for_players = []
    for t in data.get("tokens", []):
        token_copy = t.copy()
        if token_copy.get("has_avatar"):
            # Добавляем timestamp для сброса кэша
            timestamp = int(time.time())
            token_copy["avatar_url"] = (
                f"/api/token/avatar/{token_copy['id']}?t={timestamp}"
            )
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

    # Отправляем обновление всем
    socketio.emit("map_updated", player_data)

    # Если аватар изменился, отправляем специальное событие для очистки кэша
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


@app.route("/api/token/<token_id>", methods=["DELETE"])
def delete_token(token_id):
    """Удалить токен и его аватар"""
    map_id = session.get("current_map_id")
    if not map_id:
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404

    # Удаляем аватар если есть
    delete_token_avatar(token_id)

    # Удаляем токен из данных
    tokens = data.get("tokens", [])
    data["tokens"] = [t for t in tokens if t.get("id") != token_id]

    save_map_data(data, map_id)

    # Отправляем обновление игрокам
    socketio.emit(
        "map_updated", {"map_id": map_id, "tokens": data.get("tokens", [])}
    )

    return jsonify({"status": "token deleted"})


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
