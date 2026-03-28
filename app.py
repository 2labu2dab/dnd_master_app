# app.py
import base64
import io
import math
import os
import time
import uuid
from datetime import datetime

from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from flask_socketio import SocketIO, disconnect, emit, join_room, leave_room
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
from utils.project_backup import (
    backup_download_slug,
    export_project_zip_bytes,
    import_project_from_zip,
)
from utils.projects import (
    create_project,
    delete_project,
    ensure_migrated,
    find_project_id_for_map,
    get_project,
    first_map_id_with_image_for_preview,
    list_projects,
    list_projects_for_cards,
    map_image_path_in_project,
    set_project_name,
)
from utils.storage import (
    create_new_map,
    delete_map,
    get_all_maps_with_token,
    get_all_maps_with_token_all_projects,
    get_image_filepath,
    get_token_avatar_url,
    list_maps,
    load_map_data,
    load_map_image,
    normalize_map_list_order,
    save_map_data,
    save_map_image,
    save_map_list_order,
    save_token_avatar,
    copy_token_avatar_file,
    copy_filepath_to_token_avatar,
    save_drawings_layer,
    load_drawings_layer,
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
TOKEN_SIZES = {
    "tiny": {"name": "Крошечный", "scale": 0.25, "grid_cells": 0.25},
    "small": {"name": "Маленький", "scale": 1.0, "grid_cells": 1},
    "medium": {"name": "Средний", "scale": 1.0, "grid_cells": 1},
    "large": {"name": "Большой", "scale": 2.0, "grid_cells": 4},
    "huge": {"name": "Огромный", "scale": 3.0, "grid_cells": 9},
    "gargantuan": {"name": "Гигантский", "scale": 4.0, "grid_cells": 20},
}
# Кэш для throttle
last_ruler_updates = {}

# Роли подключений Socket.IO (sid -> "master"|"player"|None)
client_roles = {}
# Tracks which map_id each socket is viewing (sid -> map_id)
client_map_rooms = {}


def versioned_url(base_url, filepath):
    """Return base_url with &v=<mtime> or ?v=<mtime> appended."""
    try:
        v = int(os.path.getmtime(filepath))
    except Exception:
        v = int(time.time())
    sep = "&" if "?" in base_url else "?"
    return f"{base_url}{sep}v={v}"


def _prepare_player_tokens(tokens):
    """Return a copy of token list with versioned avatar URLs, no avatar_data."""
    from utils.storage import get_token_avatar_filepath, get_token_avatar_url

    result = []
    for t in tokens:
        tc = t.copy()
        if tc.get("has_avatar"):
            base = get_token_avatar_url(tc["id"])
            path = get_token_avatar_filepath(tc["id"])
            tc["avatar_url"] = versioned_url(base, path)
        tc.pop("avatar_data", None)
        result.append(tc)
    return result


def _prepare_player_characters(characters):
    """Return a copy of character list with versioned portrait URLs."""
    from utils.storage import find_portrait_file, get_portrait_url, portrait_path_to_media

    result = []
    for c in characters:
        cc = c.copy()
        if cc.get("has_avatar"):
            base = get_portrait_url(cc["id"])
            path = find_portrait_file(cc["id"])
            if path:
                cc["portrait_url"] = versioned_url(base, path)
                if not cc.get("portrait_media"):
                    cc["portrait_media"] = portrait_path_to_media(path)
            else:
                cc["portrait_url"] = base
        cc.pop("avatar_data", None)
        result.append(cc)
    return result


def _build_player_data(map_id, data):
    """Build the standard player_data dict from map data."""
    from utils.storage import get_image_filepath

    pd = {
        "map_id": map_id,
        "tokens": _prepare_player_tokens(data.get("tokens", [])),
        "characters": _prepare_player_characters(data.get("characters", [])),
        "zones": data.get("zones", []),
        "finds": data.get("finds", []),
        "grid_settings": data.get("grid_settings", {}),
        "ruler_visible_to_players": data.get("ruler_visible_to_players", False),
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": data.get("has_image", False),
        "combat": data.get("combat"),
    }
    if data.get("has_image"):
        image_path = get_image_filepath(map_id)
        if image_path:
            pd["image_url"] = versioned_url(
                f"/api/map/image/{map_id}", image_path
            )
    return pd


import os

# Создаем папки и проверяем права
data_dir = "data"
token_avatars_dir = os.path.join(data_dir, "token_avatars")

# Создаем папки
os.makedirs(data_dir, exist_ok=True)
os.makedirs(token_avatars_dir, exist_ok=True)
ensure_migrated()


@app.route("/")
def index():
    ensure_migrated()
    pid = session.get("data_project_id")
    if pid and not get_project(pid):
        session.pop("data_project_id", None)
        pid = None

    if not pid:
        return redirect(url_for("projects_list_page"))

    maps = []
    current_map_id = None
    if pid:
        maps = list_maps()
        if maps:
            current_map_id = session.get("current_map_id")
            if not current_map_id or not any(
                m["id"] == current_map_id for m in maps
            ):
                current_map_id = maps[0]["id"]
            session["current_map_id"] = current_map_id
        else:
            session["current_map_id"] = None

    meta = get_project(pid) if pid else None
    return render_template(
        "index.html",
        maps=maps,
        current_map=current_map_id,
        current_project_id=pid,
        current_project_name=(meta.get("name") if meta else "") or "",
    )


@app.route("/api/maps", methods=["GET"])
def get_maps():
    """Получить список всех карт"""
    if not session.get("data_project_id"):
        return jsonify([])
    return jsonify(list_maps())


@app.route("/api/maps/reorder", methods=["POST"])
def api_maps_reorder():
    """Сохранить порядок карт в списке мастера (как у портретов)."""
    if not session.get("data_project_id"):
        return jsonify({"error": "Нет активного проекта"}), 403
    body = request.get_json(silent=True) or {}
    order = body.get("order")
    if not isinstance(order, list):
        return jsonify({"error": "Нужен массив order с id карт"}), 400
    normalized = normalize_map_list_order([str(x) for x in order])
    if not save_map_list_order(normalized):
        return jsonify({"error": "Не удалось сохранить порядок"}), 500
    maps = list_maps()
    socketio.emit("maps_list_updated", {"maps": maps})
    return jsonify({"ok": True, "maps": maps})


@app.route("/api/projects", methods=["GET"])
def api_projects_list():
    ensure_migrated()
    return jsonify(list_projects())


@app.route("/api/projects", methods=["POST"])
def api_projects_create():
    ensure_migrated()
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "Новый проект").strip() or "Новый проект"
    entry = create_project(name)
    return jsonify(entry)


@app.route("/api/projects/open", methods=["POST"])
def api_projects_open():
    """Активен только один проект на сессию — id в session перезаписывается."""
    ensure_migrated()
    body = request.get_json(silent=True) or {}
    pid = body.get("id")
    if not pid or not get_project(pid):
        return jsonify({"error": "Проект не найден"}), 404
    session["data_project_id"] = pid
    return jsonify({"ok": True, "id": pid})


@app.route("/api/projects/leave", methods=["POST"])
def api_projects_leave():
    session.pop("data_project_id", None)
    return jsonify({"ok": True})


@app.route("/api/projects/<project_id>", methods=["PATCH"])
def api_projects_rename(project_id):
    ensure_migrated()
    if not get_project(project_id):
        return jsonify({"error": "Проект не найден"}), 404
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Укажите название"}), 400
    set_project_name(project_id, name)
    return jsonify({"ok": True, "name": name})


@app.route("/api/projects/<project_id>", methods=["DELETE"])
def api_projects_delete(project_id):
    ensure_migrated()
    if not delete_project(project_id):
        return jsonify({"error": "Проект не найден"}), 404
    if session.get("data_project_id") == project_id:
        session.pop("data_project_id", None)
    return jsonify({"ok": True})


@app.route("/projects")
def projects_list_page():
    ensure_migrated()
    return render_template(
        "projects.html",
        projects=list_projects_for_cards(),
        current_project_id=session.get("data_project_id"),
    )


@app.route("/projects/open/<project_id>")
def open_project_redirect(project_id):
    """В сессии хранится ровно один активный проект — при открытии другого предыдущий заменяется."""
    ensure_migrated()
    if not get_project(project_id):
        return redirect(url_for("projects_list_page"))
    session["data_project_id"] = project_id
    return redirect(url_for("index"))


@app.route("/projects/new", methods=["POST"])
def projects_create_redirect():
    ensure_migrated()
    name = (request.form.get("name") or "").strip() or "Новый проект"
    entry = create_project(name)
    session["data_project_id"] = entry["id"]
    return redirect(url_for("index"))


@app.route("/api/project/export", methods=["GET"])
def project_export():
    """Скачать все данные из data/ как ZIP (.mdma). Имя файла и манифест — по выбранному проекту."""
    ensure_migrated()
    q_pid = request.args.get("project_id")
    if q_pid and not get_project(q_pid):
        q_pid = None
    pid = q_pid or session.get("data_project_id")
    meta = get_project(pid) if pid else None
    if not meta:
        plist = list_projects()
        if plist:
            meta = plist[0]
            pid = meta.get("id")
    focus_name = None
    if meta:
        focus_name = (meta.get("name") or "").strip() or meta.get("id") or "Проект"
    slug = backup_download_slug(focus_name if meta else "dnd-data")
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    payload = export_project_zip_bytes(
        focus_project_id=pid if meta else None,
        focus_project_name=focus_name if meta else None,
    )
    buf = io.BytesIO(payload)
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/octet-stream",
        as_attachment=True,
        download_name=f"{slug}-{stamp}.mdma",
    )


@app.route("/api/project/import", methods=["POST"])
def project_import():
    """Восстановить data/ из архива .mdma (ZIP)."""
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "Файл не передан"}), 400
    upload = request.files["file"]
    if not upload.filename:
        return jsonify({"ok": False, "error": "Пустое имя файла"}), 400
    ok, msg = import_project_from_zip(upload)
    if not ok:
        return jsonify({"ok": False, "error": msg}), 400
    return jsonify({"ok": True, "message": msg})


@socketio.on("drawings_updated")
def handle_drawings_updated(data):
    """Обработчик обновления рисунков"""
    map_id = data.get("map_id")
    if not map_id:
        return

    strokes = data.get("strokes", [])
    layer_id = data.get("layer_id")

    # Сохраняем в отдельный файл
    if map_id and layer_id:
        save_drawings_layer(map_id, layer_id, strokes)

    emit(
        "drawings_updated",
        {"map_id": map_id, "strokes": strokes, "layer_id": layer_id},
        to=f"map_{map_id}",
        include_self=False,
    )


@app.route("/api/drawings/<map_id>", methods=["GET"])
def get_drawings(map_id):
    """Получить рисунки для карты"""
    from utils.storage import load_drawings_layer

    strokes, layer_id = load_drawings_layer(map_id)
    return jsonify({"status": "ok", "strokes": strokes, "layer_id": layer_id})


@app.route("/api/drawings/<map_id>", methods=["POST"])
def save_drawings(map_id):
    """Сохранить рисунки для карты"""
    from utils.storage import save_drawings_layer

    data = request.get_json()
    layer_id = data.get("layer_id")
    strokes = data.get("strokes", [])

    if save_drawings_layer(map_id, layer_id, strokes):
        return jsonify({"status": "ok"})
    else:
        return jsonify({"status": "error"}), 500


@app.route("/api/drawings/<map_id>", methods=["DELETE"])
def delete_drawings(map_id):
    """Удалить рисунки для карты"""
    from utils.storage import delete_drawings_layer

    if delete_drawings_layer(map_id):
        return jsonify({"status": "ok"})
    else:
        return jsonify({"status": "error"}), 500


@socketio.on("request_drawings")
def handle_request_drawings(data):
    """Запрос рисунков для карты"""
    map_id = data.get("map_id")
    if not map_id:
        return

    print(f"Request drawings for map {map_id}")

    strokes, layer_id = load_drawings_layer(map_id)
    print(f"Sending {len(strokes)} strokes to client")

    emit(
        "drawings_loaded",
        {"map_id": map_id, "strokes": strokes, "layer_id": layer_id},
        room=request.sid,
    )


@app.route("/api/map/<map_id>", methods=["GET"])
def get_map(map_id):
    """Получить данные конкретной карты"""
    data = load_map_data(map_id)
    if data is None:
        return jsonify({"error": "Map not found"}), 404

    # Игрокам не отправляем картинку в base64 (слишком тяжело по сети).
    # Мастер по-прежнему может получать base64 (используется в мастер-интерфейсе).
    client_type = request.args.get("for") or request.headers.get("X-DND-Client")
    is_player_client = str(client_type).lower() in ("player", "p", "1", "true", "yes")

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

    from utils.storage import get_image_filepath

    image_path = get_image_filepath(map_id)
    if os.path.exists(image_path):
        try:
            version = int(os.path.getmtime(image_path))
        except Exception:
            version = int(time.time())
        data["has_image"] = True
        data["image_url"] = f"/api/map/image/{map_id}?v={version}"
    else:
        data["has_image"] = False

    # base64 только если явно запрошено (?include_image=1) — тяжело, не для обычной загрузки
    if request.args.get("include_image") == "1":
        image_base64 = load_map_image(map_id)
        if image_base64:
            data["map_image_base64"] = image_base64

    # Добавляем URL портретов для персонажей
    if "characters" in data:
        for character in data["characters"]:
            if character.get("has_avatar"):
                from utils.storage import (
                    find_portrait_file,
                    get_portrait_url,
                    portrait_path_to_media,
                )

                portrait_path = find_portrait_file(character["id"])
                portrait_url = get_portrait_url(character["id"])
                if portrait_path and os.path.exists(portrait_path):
                    try:
                        pv = int(os.path.getmtime(portrait_path))
                    except Exception:
                        pv = int(time.time())
                    character["portrait_url"] = f"{portrait_url}?v={pv}"
                    if not character.get("portrait_media"):
                        character["portrait_media"] = portrait_path_to_media(
                            portrait_path
                        )
                else:
                    character["portrait_url"] = portrait_url
            # Удаляем старые данные аватара если они есть
            character.pop("avatar_data", None)

    # Добавляем URL аватаров для токенов
    if "tokens" in data:
        for token in data["tokens"]:
            if token.get("has_avatar"):
                from utils.storage import (
                    get_token_avatar_filepath,
                    get_token_avatar_url,
                )

                avatar_path = get_token_avatar_filepath(token["id"])
                avatar_url = get_token_avatar_url(token["id"])
                if os.path.exists(avatar_path):
                    try:
                        av = int(os.path.getmtime(avatar_path))
                    except Exception:
                        av = int(time.time())
                    token["avatar_url"] = f"{avatar_url}?v={av}"
                else:
                    token["avatar_url"] = avatar_url
            token.pop("avatar_data", None)

    return jsonify(data)


@app.route("/api/map/image/<map_id>")
def get_map_image(map_id):
    """Получить изображение карты (оригинальное качество)."""
    from utils.storage import get_image_filepath

    image_path = get_image_filepath(map_id)
    if os.path.exists(image_path):
        mimetype = "image/png" if image_path.endswith(".png") else "image/jpeg"
        resp = send_file(image_path, mimetype=mimetype, conditional=True)
        resp.cache_control.public = True
        resp.cache_control.max_age = 31536000
        resp.cache_control.immutable = True
        return resp

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

    prepared = _prepare_player_characters(characters)
    emit(
        "characters_updated",
        {"map_id": map_id, "characters": prepared},
        to=f"map_{map_id}",
        include_self=False,
    )


@app.route("/api/map", methods=["POST"])
def save_map():
    """Сохранить текущую карту"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400

    map_id = data.get("map_id")
    if not map_id:
        return jsonify({"error": "No map ID provided"}), 400

    if "grid_settings" in data:
        if "visible_to_players" not in data["grid_settings"]:
            data["grid_settings"]["visible_to_players"] = True

    save_map_data(data, map_id)

    from utils.storage import propagate_token_stats_to_other_maps, token_stats_payload_from_dict

    other_map_ids, touched_token_ids = propagate_token_stats_to_other_maps(
        map_id, data.get("tokens", [])
    )
    for mid in other_map_ids:
        other_data = load_map_data(mid)
        if other_data:
            socketio.emit(
                "map_updated",
                _build_player_data(mid, other_data),
                room=f"map_{mid}",
            )

    for tid_str in touched_token_ids:
        src_tok = next(
            (t for t in data.get("tokens", []) if str(t.get("id")) == tid_str),
            None,
        )
        if src_tok:
            payload = token_stats_payload_from_dict(src_tok)
            if payload:
                socketio.emit(
                    "token_synced_across_maps",
                    {
                        "token_id": src_tok.get("id"),
                        "updated_data": payload,
                        "updated_maps": other_map_ids,
                    },
                )

    player_data = _build_player_data(map_id, data)
    socketio.emit("map_updated", player_data, room=f"map_{map_id}")
    return jsonify({"status": "ok"})


@app.route("/api/map/new", methods=["POST"])
def new_map():
    """Создать новую карту"""
    map_data = request.get_json()
    name = map_data.get("name", "Новая карта")

    # Создаем новую карту
    map_id = create_new_map(name)

    # По требованию: при добавлении карты она всегда скрыта для игроков
    new_map_data = load_map_data(map_id) or {}
    new_map_data["player_map_enabled"] = False
    new_map_data.setdefault("tokens", [])
    save_map_data(new_map_data, map_id)

    # Получаем всех героев (токены-игроки) с других карт
    from utils.storage import get_all_heroes_from_maps

    all_heroes = get_all_heroes_from_maps()

    if all_heroes:
        print(f"Found {len(all_heroes)} heroes from other maps")

        # Загружаем данные новой карты
        new_map_data = load_map_data(map_id) or {}
        # Гарантируем скрытие для игроков
        new_map_data["player_map_enabled"] = False

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
        maps = list_maps()
        socketio.emit("map_deleted", {"map_id": map_id, "maps": maps})
        return jsonify({"status": "ok", "maps": maps})
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

    if image_path and os.path.exists(image_path):
        resp = send_file(image_path, mimetype="image/png", conditional=True)
        resp.cache_control.public = True
        resp.cache_control.max_age = 31536000
        resp.cache_control.immutable = True
        return resp

    # Если файл не найден, создаем заглушку на лету
    return create_default_avatar()


@app.route("/api/token/<token_id>/sync", methods=["POST"])
def sync_token_across_maps(token_id):
    """Синхронизировать изменения токена на всех картах"""
    try:
        data = request.get_json()
        print(f"\n=== Syncing token {token_id} across all maps ===")
        print(f"Sync data: {data}")

        from utils.storage import (
            get_all_maps_with_token,
            sync_token_across_maps as sync_storage,
        )

        maps_with_token = get_all_maps_with_token(token_id)
        print(f"Token found on {len(maps_with_token)} maps")

        updated_maps = sync_storage(token_id, data)

        for map_id in updated_maps:
            map_data = load_map_data(map_id)
            if map_data:
                socketio.emit("map_updated", _build_player_data(map_id, map_data), room=f"map_{map_id}")

        if updated_maps:
            socketio.emit(
                "token_synced_across_maps",
                {
                    "token_id": token_id,
                    "updated_data": data,
                    "updated_maps": updated_maps,
                },
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

        if copy_token_avatar_file(source_token_id, target_token_id):
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
    try:
        token = request.get_json()
    except Exception as e:
        return jsonify({"error": "Invalid JSON"}), 400

    if not token:
        return jsonify({"error": "Invalid JSON"}), 400

    avatar_data = token.pop("avatar_data", None)
    copy_avatar_from_token_id = token.pop("copy_avatar_from_token_id", None)
    token_size = token.get("size", "medium")

    map_id = token.pop("map_id", None) or session.get("current_map_id")
    if not map_id:
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404

    avatar_url = None
    if avatar_data:
        from utils.storage import get_token_avatar_filepath
        success = save_token_avatar(avatar_data, token["id"])
        if success:
            token["has_avatar"] = True
            base = f"/api/token/avatar/{token['id']}"
            path = get_token_avatar_filepath(token["id"])
            avatar_url = versioned_url(base, path)
            token["avatar_url"] = avatar_url
        else:
            token["has_avatar"] = False
    elif copy_avatar_from_token_id:
        from utils.storage import get_token_avatar_filepath

        tid = token["id"]
        src_id = copy_avatar_from_token_id
        path = get_token_avatar_filepath(tid)

        # Импорт с тем же id: файл уже один и тот же — copy2(src, src) ломал бы сохранение.
        if src_id == tid:
            if path and os.path.isfile(path):
                token["has_avatar"] = True
                base = f"/api/token/avatar/{tid}"
                avatar_url = versioned_url(base, path)
                token["avatar_url"] = avatar_url
            else:
                token["has_avatar"] = False
        elif copy_token_avatar_file(src_id, tid):
            token["has_avatar"] = True
            base = f"/api/token/avatar/{tid}"
            path = get_token_avatar_filepath(tid)
            avatar_url = versioned_url(base, path)
            token["avatar_url"] = avatar_url
        else:
            token["has_avatar"] = False
    else:
        token["has_avatar"] = False

    token["size"] = token_size
    data.setdefault("tokens", []).append(token)
    save_map_data(data, map_id)

    player_data = _build_player_data(map_id, data)
    socketio.emit("map_updated", player_data, room=f"map_{map_id}")

    return jsonify(
        {
            "status": "token added",
            "token_id": token["id"],
            "avatar_url": avatar_url,
            "size": token_size,
        }
    )


@app.route("/favicon.ico")
def favicon():
    return "", 204


@app.route("/player")
def player_view():
    ensure_migrated()
    project_id = request.args.get("project_id")
    map_id = request.args.get("map_id")
    if project_id and get_project(project_id):
        session["data_project_id"] = project_id
    elif map_id:
        found = find_project_id_for_map(map_id)
        if found:
            session["data_project_id"] = found

    if not map_id:
        map_id = session.get("current_map_id")
        if not map_id:
            maps = list_maps()
            map_id = maps[0]["id"] if maps else None

    player_project = session.get("data_project_id")
    return render_template(
        "player.html",
        map_id=map_id,
        project_id=player_project,
        master_active=is_master_active(),
    )


@app.route("/api/zone", methods=["POST"])
def add_zone():
    zone = request.get_json()
    if not zone:
        return jsonify({"error": "Invalid JSON"}), 400

    map_id = zone.pop("map_id", None) or session.get("current_map_id")
    if not map_id:
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404

    data.setdefault("zones", []).append(zone)
    save_map_data(data, map_id)

    socketio.emit("map_updated", _build_player_data(map_id, data), room=f"map_{map_id}")
    return jsonify({"status": "zone added"})


@app.route("/api/find", methods=["POST"])
def add_find():
    find = request.get_json()
    if not find:
        return jsonify({"error": "Invalid JSON"}), 400

    map_id = find.pop("map_id", None) or session.get("current_map_id")
    if not map_id:
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404

    data.setdefault("finds", []).append(find)
    save_map_data(data, map_id)

    socketio.emit("map_updated", _build_player_data(map_id, data), room=f"map_{map_id}")
    return jsonify({"status": "find added"})


@app.route("/upload_map", methods=["POST"])
def upload_map():
    """Загрузить изображение карты с максимальным качеством"""
    if "map_image" not in request.files:
        return "No file", 400

    file = request.files["map_image"]
    if file.filename == "":
        return "No selected file", 400

    map_id = request.form.get("map_id") or session.get("current_map_id")
    if not map_id:
        map_id = create_new_map("Новая карта")

    print(f"Uploading map image for {map_id}, filename: {file.filename}")

    # Читаем файл напрямую, без изменений
    file_data = file.read()
    print(f"File size: {len(file_data)} bytes")

    # Сохраняем изображение с максимальным качеством
    if save_map_image(file_data, map_id):
        # Обновляем данные карты
        data = load_map_data(map_id)
        data["has_image"] = True
        # По требованию: при добавлении карты она всегда скрыта для игроков
        data["player_map_enabled"] = False

        # Сохраняем информацию о формате
        if file.filename.lower().endswith(".png"):
            data["image_format"] = "png"
        else:
            data["image_format"] = "jpg"

        save_map_data(data, map_id)

        # Send base64 to the master only (for the canvas preview)
        current_master = get_current_master()
        master_socket_id = (
            current_master.get("socket_id") if current_master else None
        )
        if master_socket_id:
            from utils.storage import get_image_filepath
            img_path = get_image_filepath(map_id)
            new_image_url = versioned_url(f"/api/map/image/{map_id}", img_path)
            socketio.emit(
                "map_image_updated",
                {"map_id": map_id, "has_image": True, "new_image_url": new_image_url},
                room=master_socket_id,
            )

        # Notify players in this map's room
        socketio.emit("map_updated", _build_player_data(map_id, data), room=f"map_{map_id}")

        return jsonify({"status": "ok", "map_id": map_id})

    print(f"✗ Failed to save map image")
    return "Failed to save image", 500


@socketio.on("connect")
def handle_connect(auth=None):
    print(f"Client connected: {request.sid}")

    role = None
    try:
        if isinstance(auth, dict):
            role = auth.get("role")
    except Exception:
        role = None

    if not role:
        role = request.args.get("role")

    role = (role or "").lower().strip() or None
    client_roles[request.sid] = role

    if role == "master":
        join_room("master")
        session_id = session.get("session_id")
        if not session_id:
            print("Master connect without session_id; disconnecting.")
            emit("master_status", {"active": False, "is_current": False})
            disconnect()
            return

        success, _lock = acquire_master_lock(session_id, request.sid)
        if success:
            print(f"Master lock acquired for session {session_id}")
            emit("master_status", {"active": True, "is_current": True})
        else:
            print(f"Failed to acquire master lock for session {session_id}")
            emit("master_status", {"active": False, "is_current": False})
            disconnect()
        return

    # Player role
    join_room("players")

    # If auth carries a map_id, auto-join that map room
    initial_map = None
    try:
        if isinstance(auth, dict):
            initial_map = auth.get("map_id")
    except Exception:
        pass
    if not initial_map:
        initial_map = request.args.get("map_id")
    if initial_map:
        room_name = f"map_{initial_map}"
        join_room(room_name)
        client_map_rooms[request.sid] = room_name
        print(f"Player {request.sid} auto-joined room {room_name}")

    print(f"Player connected: {request.sid} (role={role})")


@socketio.on("join_map")
def handle_join_map(data):
    """Player/client joins a map-specific room for targeted updates."""
    map_id = data.get("map_id") if data else None
    if not map_id:
        return

    new_room = f"map_{map_id}"
    old_room = client_map_rooms.get(request.sid)

    if old_room and old_room != new_room:
        leave_room(old_room)

    join_room(new_room)
    client_map_rooms[request.sid] = new_room

    role = client_roles.get(request.sid)
    if role == "player":
        map_data = load_map_data(map_id)
        if map_data:
            player_data = _build_player_data(map_id, map_data)
            emit("map_updated", player_data)


@socketio.on("disconnect")
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")

    # Clean up room tracking
    client_map_rooms.pop(request.sid, None)

    try:
        role = client_roles.pop(request.sid, None)
        if role == "master":
            current = get_current_master()
            if current and current.get("socket_id") == request.sid:
                session_id = current.get("session_id")
                if session_id:
                    release_master_lock(session_id)
    except Exception as e:
        print(f"Error during disconnect cleanup: {e}")


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

    emit(
        "ruler_update",
        {
            "map_id": map_id,
            "ruler_start": data.get("ruler_start"),
            "ruler_end": data.get("ruler_end"),
        },
        to=f"map_{map_id}",
        include_self=False,
    )


@socketio.on("zoom_update")
def handle_zoom_update(data):
    map_id = data.get("map_id")
    if not map_id:
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
        to=f"map_{map_id}",
        include_self=False,
    )


@socketio.on("switch_map")
def handle_switch_map(data):
    """Обработчик смены карты мастером"""
    map_id = data.get("map_id")

    payload = {"map_id": map_id}
    if map_id:
        from utils.storage import get_image_filepath
        image_path = get_image_filepath(map_id)
        if os.path.exists(image_path):
            payload["image_url"] = versioned_url(f"/api/map/image/{map_id}", image_path)

    emit("master_switched_map", payload, to="players")


@socketio.on("request_map_sync")
def handle_map_sync(data):
    """Обработчик запроса синхронизации карты от клиента"""
    map_id = data.get("map_id") if data else None
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


@socketio.on("request_map_data")
def handle_request_map_data(data):
    """Send lightweight map data to a single player client.

    This is a socket-based fallback for cases where HTTP /api/map fetch fails
    on some client networks (Error: Failed to fetch).
    """
    map_id = data.get("map_id") if data else None
    if not map_id:
        emit("map_updated", {"map_id": None, "error": "No map_id"}, room=request.sid)
        return

    map_data = load_map_data(map_id)
    if not map_data:
        emit("map_updated", {"map_id": map_id, "error": "Map not found"}, room=request.sid)
        return

    # Normalize grid settings to match logic of HTTP /api/map/<map_id>.
    # This prevents grid mismatch when older saved maps have `cell_size` but no `cell_count`.
    if "grid_settings" in map_data and isinstance(map_data["grid_settings"], dict):
        grid_settings = map_data["grid_settings"]
        if "cell_size" in grid_settings and "cell_count" not in grid_settings:
            grid_settings["cell_count"] = 20

        if "cell_count" not in grid_settings:
            grid_settings["cell_count"] = 20
        else:
            try:
                if grid_settings["cell_count"] < 5:
                    grid_settings["cell_count"] = 5
                elif grid_settings["cell_count"] > 150:
                    grid_settings["cell_count"] = 150
            except Exception:
                grid_settings["cell_count"] = 20

        # Ensure player visibility flag exists.
        if "visible_to_players" not in grid_settings:
            grid_settings["visible_to_players"] = True
    # Debug (help track fallback behavior on problematic clients).
    try:
        gs = map_data.get("grid_settings", {}) if map_data else {}
        print(
            f"request_map_data: map={map_id} sid={request.sid} "
            f"cell_count={gs.get('cell_count')} cell_size={gs.get('cell_size')} "
            f"visible_to_players={gs.get('visible_to_players')}"
        )
    except Exception:
        pass

    from utils.storage import (
        get_image_filepath,
        get_token_avatar_filepath,
        get_token_avatar_url,
        find_portrait_file,
        get_portrait_url,
        portrait_path_to_media,
    )

    image_path = get_image_filepath(map_id)
    if os.path.exists(image_path):
        has_image = True
        try:
            mv = int(os.path.getmtime(image_path))
        except Exception:
            mv = int(time.time())
        image_url = f"/api/map/image/{map_id}?v={mv}"
    else:
        has_image = False
        image_url = None

    # Build player token/character data with versioned avatar URLs.
    tokens_for_players = []
    for token in map_data.get("tokens", []):
        token_copy = token.copy()
        if token_copy.get("has_avatar"):
            avatar_path = get_token_avatar_filepath(token_copy["id"])
            base_avatar_url = get_token_avatar_url(token_copy["id"])
            if os.path.exists(avatar_path):
                try:
                    av = int(os.path.getmtime(avatar_path))
                except Exception:
                    av = int(time.time())
                token_copy["avatar_url"] = f"{base_avatar_url}?v={av}"
            else:
                token_copy["avatar_url"] = base_avatar_url
        token_copy.pop("avatar_data", None)
        tokens_for_players.append(token_copy)

    characters_for_players = []
    for character in map_data.get("characters", []):
        character_copy = character.copy()
        if character_copy.get("has_avatar"):
            portrait_path = find_portrait_file(character_copy["id"])
            base_portrait_url = get_portrait_url(character_copy["id"])
            if portrait_path and os.path.exists(portrait_path):
                try:
                    pv = int(os.path.getmtime(portrait_path))
                except Exception:
                    pv = int(time.time())
                character_copy["portrait_url"] = f"{base_portrait_url}?v={pv}"
                if not character_copy.get("portrait_media"):
                    character_copy["portrait_media"] = portrait_path_to_media(
                        portrait_path
                    )
            else:
                character_copy["portrait_url"] = base_portrait_url
        character_copy.pop("avatar_data", None)
        characters_for_players.append(character_copy)

    player_data = {
        "map_id": map_id,
        "tokens": tokens_for_players,
        "characters": characters_for_players,
        "zones": map_data.get("zones", []),
        "finds": map_data.get("finds", []),
        "grid_settings": map_data.get("grid_settings", {}),
        "ruler_visible_to_players": map_data.get("ruler_visible_to_players", False),
        "ruler_start": map_data.get("ruler_start"),
        "ruler_end": map_data.get("ruler_end"),
        "player_map_enabled": map_data.get("player_map_enabled", True),
        "has_image": has_image,
        "image_url": image_url,
        # These are used by the player renderer.
        "master_canvas_width": map_data.get("master_canvas_width", 1380),
        "master_canvas_height": map_data.get("master_canvas_height", 1080),
        "zoom_level": map_data.get("zoom_level", 1),
        "pan_x": map_data.get("pan_x", 0),
        "pan_y": map_data.get("pan_y", 0),
        "combat": map_data.get("combat"),
    }

    emit("map_updated", player_data, room=request.sid)


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

    # Версия изображения для кэшируемого URL
    image_url_v = None
    if has_image:
        try:
            from utils.storage import get_image_filepath

            image_path = get_image_filepath(map_id)
            mv = (
                int(os.path.getmtime(image_path))
                if os.path.exists(image_path)
                else int(time.time())
            )
            image_url_v = f"/api/map/image/{map_id}?v={mv}"
        except Exception:
            image_url_v = f"/api/map/image/{map_id}"

    # Подготавливаем данные для отправки (только легковесное событие)
    visibility_data = {
        "map_id": map_id,
        "player_map_enabled": data.get("player_map_enabled", True),
        "has_image": has_image,
    }

    # Если карта стала видимой и есть изображение, добавляем URL (v для кэша)
    if data.get("player_map_enabled", True) and has_image and image_url_v:
        visibility_data["image_url"] = image_url_v

    emit(
        "map_visibility_change",
        visibility_data,
        to=f"map_{map_id}",
        include_self=False,
    )
    # ВАЖНО: раньше при включении дополнительно отправлялся огромный map_updated.
    # Это сильно тормозило toggle. Теперь полные данные догружаются обычными
    # map_updated при изменениях токенов/зон/настроек, поэтому здесь достаточно
    # лёгкого события map_visibility_change.


@socketio.on("request_map_image")
def handle_request_map_image(data):
    """Обработчик запроса изображения карты — возвращает URL, не base64."""
    map_id = data.get("map_id")
    if map_id:
        from utils.storage import get_image_filepath
        img_path = get_image_filepath(map_id)
        if os.path.exists(img_path):
            emit(
                "map_image_updated",
                {"map_id": map_id, "has_image": True,
                 "new_image_url": versioned_url(f"/api/map/image/{map_id}", img_path)},
                room=request.sid,
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

    emit(
        "ruler_visibility_change",
        {
            "map_id": map_id,
            "ruler_visible_to_players": data.get(
                "ruler_visible_to_players", False
            ),
        },
        to=f"map_{map_id}",
        include_self=False,
    )


@app.route("/api/token/<token_id>", methods=["PUT"])
def update_token(token_id):
    """Обновить существующий токен с сохранением качества аватара"""
    try:
        token = request.get_json()
    except Exception as e:
        return jsonify({"error": "Invalid JSON"}), 400

    if not token:
        return jsonify({"error": "Invalid JSON"}), 400

    avatar_data = token.pop("avatar_data", None)
    token_size = token.get("size", "medium")

    map_id = token.pop("map_id", None) or session.get("current_map_id")
    if not map_id:
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404

    token_found = False
    avatar_changed = False

    for i, t in enumerate(data.get("tokens", [])):
        if str(t.get("id")) == str(token_id):
            old_has_avatar = t.get("has_avatar", False)
            old_avatar_url = t.get("avatar_url")

            if old_has_avatar and not avatar_data:
                token["has_avatar"] = True
                token["avatar_url"] = old_avatar_url

            token["id"] = token_id
            token["size"] = token_size
            if "position" not in token and "position" in t:
                token["position"] = t["position"]

            data["tokens"][i] = token
            token_found = True

            if avatar_data:
                from utils.storage import get_token_avatar_filepath
                success = save_token_avatar(avatar_data, token_id)
                if success:
                    token["has_avatar"] = True
                    base = f"/api/token/avatar/{token_id}"
                    path = get_token_avatar_filepath(token_id)
                    token["avatar_url"] = versioned_url(base, path)
                    avatar_changed = True
                else:
                    token["has_avatar"] = False

            break

    if not token_found:
        return jsonify({"error": "Token not found"}), 404

    save_map_data(data, map_id)

    updated_maps = []
    try:
        from utils.storage import sync_token_across_maps, token_stats_payload_from_dict

        sync_data = token_stats_payload_from_dict(token) or {}
        if avatar_changed and token.get("avatar_url"):
            sync_data["avatar_url"] = token.get("avatar_url")

        updated_maps = sync_token_across_maps(token_id, sync_data)

        for mid in updated_maps:
            map_data = load_map_data(mid)
            if map_data:
                socketio.emit(
                    "map_updated",
                    _build_player_data(mid, map_data),
                    room=f"map_{mid}",
                )

        if updated_maps:
            socketio.emit(
                "token_synced_across_maps",
                {
                    "token_id": token_id,
                    "updated_data": sync_data,
                    "updated_maps": updated_maps,
                },
            )
    except Exception as e:
        print(f"Error during cross-map sync: {e}")

    if map_id not in updated_maps:
        socketio.emit("map_updated", _build_player_data(map_id, data), room=f"map_{map_id}")

    if avatar_changed:
        from utils.storage import get_token_avatar_filepath
        base = f"/api/token/avatar/{token_id}"
        path = get_token_avatar_filepath(token_id)
        socketio.emit(
            "token_avatar_updated",
            {"map_id": map_id, "token_id": token_id, "avatar_url": versioned_url(base, path)},
        )

    return jsonify({"status": "token updated"})


@app.route("/api/bank/avatar/<character_id>")
def get_bank_avatar(character_id):
    """Получить аватар персонажа из банка как файл"""
    from utils.bank_storage import get_bank_avatar_filepath

    image_path = get_bank_avatar_filepath(character_id)

    if os.path.exists(image_path):
        resp = send_file(image_path, mimetype="image/png", conditional=True)
        resp.cache_control.public = True
        resp.cache_control.max_age = 31536000
        resp.cache_control.immutable = True
        return resp

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
    map_id = request.args.get("map_id") or session.get("current_map_id")
    if not map_id:
        return jsonify({"error": "No map selected"}), 400

    data = load_map_data(map_id)
    if not data:
        return jsonify({"error": "Map not found"}), 404

    # Проверяем, есть ли токен в данных текущей карты
    token_exists = any(
        str(t.get("id")) == str(token_id) for t in data.get("tokens", [])
    )
    if not token_exists:
        return jsonify({"error": "Token not found on current map"}), 404

    # Удаляем токен из данных текущей карты
    data["tokens"] = [
        t for t in data.get("tokens", []) if str(t.get("id")) != str(token_id)
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

    socketio.emit("map_updated", _build_player_data(map_id, data), room=f"map_{map_id}")
    return jsonify({"status": "token deleted"})


@app.route("/api/token/cleanup-avatars", methods=["POST"])
def cleanup_token_avatars():
    """Очистить аватары токенов, которые нигде не используются"""
    from utils.projects import iter_token_avatars_dirs_all_projects
    from utils.storage import get_all_maps_with_token_all_projects

    deleted_count = 0
    kept_count = 0

    for av_dir in iter_token_avatars_dirs_all_projects():
        if not os.path.isdir(av_dir):
            continue
        for filename in os.listdir(av_dir):
            if not filename.endswith(".png"):
                continue
            token_id = filename[:-4]
            maps_with_token = get_all_maps_with_token_all_projects(token_id)
            filepath = os.path.join(av_dir, filename)
            if not maps_with_token:
                try:
                    os.remove(filepath)
                    deleted_count += 1
                    print(f"Cleaned up unused avatar: {filepath}")
                except Exception as e:
                    print(f"Error deleting {filepath}: {e}")
            else:
                kept_count += 1

    return jsonify(
        {"status": "ok", "deleted": deleted_count, "kept": kept_count}
    )


@app.route("/api/portrait/<portrait_id>")
def get_portrait(portrait_id):
    """Получить портрет персонажа (PNG, GIF, WebM, MP4…)"""
    from utils.storage import find_portrait_file, portrait_mimetype_for_path

    image_path = find_portrait_file(portrait_id)

    if image_path and os.path.exists(image_path):
        mime = portrait_mimetype_for_path(image_path)
        resp = send_file(image_path, mimetype=mime, conditional=True)
        resp.cache_control.public = True
        resp.cache_control.max_age = 31536000
        resp.cache_control.immutable = True
        return resp

    return "", 404


@app.route("/api/portrait/<portrait_id>", methods=["DELETE"])
def delete_portrait(portrait_id):
    """Удалить файлы портрета только если этот id больше ни на одной карте (ни в одном проекте)."""
    from utils.storage import (
        delete_portrait_image,
        get_all_maps_with_character_all_projects,
    )

    still_used = get_all_maps_with_character_all_projects(portrait_id)
    if still_used:
        return jsonify(
            {
                "status": "ok",
                "deleted": False,
                "still_on_maps": len(still_used),
            }
        )

    removed = delete_portrait_image(portrait_id)
    return jsonify({"status": "ok", "deleted": bool(removed)})


@app.route("/api/portrait/upload", methods=["POST"])
def upload_portrait():
    """Загрузить изображение портрета с максимальным качеством"""
    try:
        if "portrait" not in request.files:
            return jsonify({"error": "No file"}), 400

        file = request.files["portrait"]
        character_id = request.form.get("character_id")

        if not character_id:
            return jsonify({"error": "No character ID"}), 400

        if file.filename == "":
            return jsonify({"error": "No selected file"}), 400

        from utils.storage import find_portrait_file, save_portrait_upload

        file_data = file.read()
        result = save_portrait_upload(
            file_data,
            character_id,
            content_type=file.content_type,
            filename=file.filename,
        )

        if result and result.get("ok"):
            print(
                f"✓ Portrait saved for character {character_id}, "
                f"media={result.get('media')}, size: {len(file_data)} bytes"
            )
            portrait_path = find_portrait_file(character_id)
            if portrait_path and os.path.exists(portrait_path):
                try:
                    pv = int(os.path.getmtime(portrait_path))
                except Exception:
                    pv = int(time.time())
                portrait_url = f"/api/portrait/{character_id}?v={pv}"
            else:
                portrait_url = f"/api/portrait/{character_id}"
            return jsonify(
                {
                    "status": "ok",
                    "portrait_url": portrait_url,
                    "portrait_media": result.get("media", "image"),
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

    emit(
        "token_move",
        {
            "map_id": map_id,
            "token_id": token_id,
            "position": position,
            "is_visible": data.get("is_visible", True),
            "is_dead": data.get("is_dead", False),
        },
        to=f"map_{map_id}",
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

        emit(
            "characters_reordered",
            {"map_id": map_id, "characters": characters},
            to=f"map_{map_id}",
            include_self=False,
        )


@app.route("/api/bank/characters", methods=["GET"])
def get_bank_characters():
    """Получить всех персонажей из банка"""
    characters = get_all_bank_characters()

    from utils.bank_storage import get_bank_avatar_filepath
    for char in characters:
        if char.get("has_avatar"):
            base = f"/api/bank/avatar/{char['id']}"
            path = get_bank_avatar_filepath(char["id"])
            char["avatar_url"] = versioned_url(base, path)

    return jsonify(characters)


@app.route("/api/bank/character", methods=["POST"])
def add_bank_character():
    """Добавить персонажа в банк с сохранением качества аватара"""
    try:
        data = request.get_json()

        # Извлекаем avatar_data если есть
        avatar_data = data.pop("avatar_data", None)
        print(
            f"Adding bank character, avatar_data present: {bool(avatar_data)}"
        )
        if avatar_data:
            print(f"Avatar data length: {len(avatar_data)}")

        # Добавляем в банк
        char_id = add_character_to_bank(data)

        # Если есть аватар, сохраняем его в банк с максимальным качеством
        if avatar_data:
            from utils.character_bank import save_bank_character_avatar

            success = save_bank_character_avatar(avatar_data, char_id)
            if success:
                print(f"✓ Bank avatar saved for character {char_id}")
            else:
                print(f"✗ Failed to save bank avatar for character {char_id}")

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


@app.route("/api/characters/all", methods=["GET"])
def get_all_map_characters():
    """Все портреты персонажей с карт проекта (с файлом на диске) — для импорта на текущую карту."""
    if not session.get("data_project_id"):
        return jsonify([])
    from utils.storage import get_all_characters_from_maps

    return jsonify(get_all_characters_from_maps())


@app.route("/api/bank/character/<char_id>", methods=["DELETE"])
def delete_bank_character(char_id):
    """Удалить персонажа из банка"""
    try:
        # Проверяем, используется ли этот персонаж на картах
        from utils.storage import get_all_maps_with_token_all_projects

        maps_with_token = get_all_maps_with_token_all_projects(char_id)

        print(
            f"Deleting bank character {char_id}, used on {len(maps_with_token)} maps"
        )

        # Если персонаж используется на картах, предупреждаем
        if maps_with_token:
            labels = [
                f"{m['map_name']} ({m.get('project_name', '')})"
                for m in maps_with_token
            ]
            return jsonify(
                {
                    "error": f"Персонаж на картах: {', '.join(labels)}. Сначала уберите с карт."
                }
            ), 400

        # Удаляем из БД и файл в bank_avatars (delete_character_from_bank).
        # Не вызывать delete_token_avatar: id в банке часто совпадает с id токена (token_…), иначе сотрётся аватар токена на карте.
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
    """Создать токен на карте из персонажа из банка с сохранением качества"""
    try:
        data = request.get_json()
        map_id = data.get("map_id")
        position = data.get("position")

        if not map_id or not position:
            return jsonify({"error": "Missing map_id or position"}), 400

        bank_char = get_bank_character(char_id)
        if not bank_char:
            return jsonify({"error": "Character not found"}), 404

        map_data = load_map_data(map_id)
        if not map_data:
            return jsonify({"error": "Map not found"}), 404

        existing_ids = {t.get("id") for t in (map_data.get("tokens") or []) if t.get("id")}
        req_tid = data.get("client_token_id")
        if (
            req_tid
            and isinstance(req_tid, str)
            and req_tid.startswith("token_")
            and req_tid not in existing_ids
        ):
            token_id = req_tid
        else:
            token_id = f"token_{uuid.uuid4().hex[:8]}"

        token = {
            "id": token_id,
            "name": bank_char["name"],
            "position": position,
            "size": bank_char.get("size", "medium"),
            "is_dead": False,
            "is_player": bank_char["type"] == "player",
            "is_npc": bank_char["type"] == "npc",
            "armor_class": bank_char["armor_class"],
            "health_points": bank_char["max_health"],
            "max_health_points": bank_char["max_health"],
            "has_avatar": bank_char.get("has_avatar", False),
            "is_visible": True,
        }

        if bank_char.get("has_avatar"):
            from utils.storage import get_token_avatar_filepath
            from utils.bank_storage import get_bank_avatar_filepath

            bank_avatar_path = get_bank_avatar_filepath(char_id)
            if bank_avatar_path and os.path.isfile(bank_avatar_path):
                if copy_filepath_to_token_avatar(bank_avatar_path, token_id):
                    token["has_avatar"] = True
                    base = f"/api/token/avatar/{token_id}"
                    path = get_token_avatar_filepath(token_id)
                    token["avatar_url"] = versioned_url(base, path)

        map_data.setdefault("tokens", []).append(token)
        save_map_data(map_data, map_id)

        socketio.emit("map_updated", _build_player_data(map_id, map_data), room=f"map_{map_id}")

        return jsonify({"status": "ok", "token": token})

    except Exception as e:
        print(f"Error spawning character: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/map/update/<map_id>", methods=["POST"])
def update_map(map_id):
    """Обновить карту (название и/или изображение) с сохранением качества"""
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
                file_data = file.read()
                print(
                    f"Updating map image, new file size: {len(file_data)} bytes"
                )

                if save_map_image(file_data, map_id):
                    map_data["has_image"] = True

                    # Сохраняем информацию о формате
                    if file.filename.lower().endswith(".png"):
                        map_data["image_format"] = "png"
                    else:
                        map_data["image_format"] = "jpg"

                    print(f"✓ Map image updated successfully")

        # Сохраняем данные
        save_map_data(map_data, map_id)

        socketio.emit("maps_list_updated", {"maps": list_maps()})
        socketio.emit("map_updated", _build_player_data(map_id, map_data), room=f"map_{map_id}")

        return jsonify({"status": "ok", "map_id": map_id})

    except Exception as e:
        print(f"Error updating map: {e}")
        return jsonify({"error": str(e)}), 500


def _build_map_thumbnail_io(image_path):
    """Миниатюра до 300px; возвращает (BytesIO, mimetype)."""
    img = Image.open(image_path)
    img_copy = img.copy()
    img_copy.thumbnail((300, 300), Image.Resampling.LANCZOS)
    img_io = io.BytesIO()
    low = image_path.lower()
    if img_copy.mode == "RGBA" or low.endswith(".png"):
        img_copy.save(img_io, "PNG", optimize=False, compress_level=0)
        mimetype = "image/png"
    else:
        if img_copy.mode in ("RGBA", "LA", "P"):
            rgb_img = Image.new("RGB", img_copy.size, (255, 255, 255))
            if img_copy.mode == "RGBA":
                rgb_img.paste(img_copy, mask=img_copy.split()[3])
            else:
                rgb_img.paste(img_copy)
            img_copy = rgb_img
        img_copy.save(img_io, "JPEG", quality=95, optimize=False)
        mimetype = "image/jpeg"
    img_io.seek(0)
    return img_io, mimetype


@app.route("/api/map/thumbnail/<map_id>")
def get_map_thumbnail(map_id):
    """Получить миниатюру карты с сохранением качества"""
    from utils.storage import get_image_filepath

    image_path = get_image_filepath(map_id)
    if not image_path or not os.path.isfile(image_path):
        return "", 404

    try:
        img_io, mimetype = _build_map_thumbnail_io(image_path)
        return send_file(img_io, mimetype=mimetype)
    except Exception as e:
        print(f"Error creating thumbnail: {e}")
        return "", 500


@app.route("/api/projects/<project_id>/preview")
def project_preview_thumb(project_id):
    """Превью проекта по последней карте с изображением (без привязки к сессии)."""
    ensure_migrated()
    if not get_project(project_id):
        return "", 404
    mid = first_map_id_with_image_for_preview(project_id)
    if not mid:
        return "", 404
    path = map_image_path_in_project(project_id, mid)
    if not path or not os.path.isfile(path):
        return "", 404
    try:
        img_io, mimetype = _build_map_thumbnail_io(path)
        return send_file(img_io, mimetype=mimetype)
    except Exception as e:
        print(f"Error creating project preview: {e}")
        return "", 500


@app.route("/api/bank/character/<char_id>", methods=["PUT"])
def update_bank_character(char_id):
    """Обновить данные персонажа в банке с сохранением качества аватара"""
    try:
        data = request.get_json()

        # Извлекаем avatar_data если есть
        avatar_data = data.pop("avatar_data", None)
        print(
            f"Updating bank character {char_id}, avatar_data present: {bool(avatar_data)}"
        )

        # Обновляем в базе данных
        from utils.character_bank import update_character_in_bank

        update_character_in_bank(char_id, data)

        # Если есть новый аватар, сохраняем его с максимальным качеством
        if avatar_data:
            from utils.character_bank import save_bank_character_avatar

            success = save_bank_character_avatar(avatar_data, char_id)
            if success:
                print(f"✓ Bank avatar updated for character {char_id}")
            else:
                print(
                    f"✗ Failed to update bank avatar for character {char_id}"
                )

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

    # Проверяем, является ли запрос к мастер-интерфейсу (главная и все /projects/*)
    if (
        (request.path == "/" or request.path.startswith("/projects"))
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
    os.makedirs("data", exist_ok=True)
    ensure_migrated()

    socketio.run(
        app,
        host="0.0.0.0",
        port=5000,
        debug=False,
        allow_unsafe_werkzeug=True,
    )
