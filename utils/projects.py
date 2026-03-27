# utils/projects.py
"""Несколько проектов (наборов карт); банк персонажей общий на data/."""
import json
import os
import shutil
import uuid
from datetime import datetime

DATA_DIR = "data"
PROJECTS_FILE = os.path.join(DATA_DIR, "projects.json")
PROJECTS_DIR = os.path.join(DATA_DIR, "projects")

LEGACY_SUBDIRS = (
    "maps",
    "images",
    "token_avatars",
    "portrait_images",
    "drawings",
)


def _default_projects_payload():
    return {"projects": []}


def _load_raw():
    if not os.path.isfile(PROJECTS_FILE):
        return _default_projects_payload()
    try:
        with open(PROJECTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return _default_projects_payload()
        data.setdefault("projects", [])
        return data
    except (json.JSONDecodeError, OSError):
        return _default_projects_payload()


def _save_raw(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(PROJECTS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _legacy_data_present():
    """Есть ли старая раскладка файлов в корне data/."""
    for name in LEGACY_SUBDIRS:
        p = os.path.join(DATA_DIR, name)
        if os.path.isdir(p) and os.listdir(p):
            return True
    return False


def _ensure_project_tree(project_id):
    root = os.path.join(PROJECTS_DIR, project_id)
    for sub in LEGACY_SUBDIRS:
        os.makedirs(os.path.join(root, sub), exist_ok=True)
    return root


def _merge_stray_legacy_into_first_project():
    """
    Если в корне data/ остались maps/images/... (например, projects.json
    появился раньше полной миграции), переносим файлы в первый проект.
    """
    data = _load_raw()
    projects = data.get("projects") or []
    if not projects:
        return
    pid = projects[0].get("id")
    if not pid:
        return
    root = project_root(pid)
    for name in LEGACY_SUBDIRS:
        src = os.path.join(DATA_DIR, name)
        if not os.path.isdir(src):
            continue
        for fn in os.listdir(src):
            sp = os.path.join(src, fn)
            if not os.path.isfile(sp):
                continue
            dst_dir = os.path.join(root, name)
            os.makedirs(dst_dir, exist_ok=True)
            dp = os.path.join(dst_dir, fn)
            if os.path.exists(dp):
                continue
            try:
                shutil.move(sp, dp)
            except OSError:
                pass
        try:
            if os.path.isdir(src) and not os.listdir(src):
                os.rmdir(src)
        except OSError:
            pass


def ensure_migrated():
    """
    Однократная миграция: data/maps → data/projects/<id>/maps.
    Если проектов нет и легаси нет — создаётся один пустой проект.
    """
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(PROJECTS_DIR, exist_ok=True)

    data = _load_raw()
    projects = data.get("projects") or []

    if projects:
        for p in projects:
            pid = p.get("id")
            if pid:
                _ensure_project_tree(pid)
        _merge_stray_legacy_into_first_project()
        return

    if _legacy_data_present():
        pid = uuid.uuid4().hex[:12]
        root = _ensure_project_tree(pid)
        for name in LEGACY_SUBDIRS:
            src = os.path.join(DATA_DIR, name)
            if not os.path.isdir(src) or not os.listdir(src):
                continue
            dst = os.path.join(root, name)
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.move(src, dst)
        entry = {
            "id": pid,
            "name": "Мой проект",
            "created": datetime.now().isoformat(),
        }
        data["projects"] = [entry]
        _save_raw(data)
        _merge_stray_legacy_into_first_project()
        return

    pid = uuid.uuid4().hex[:12]
    _ensure_project_tree(pid)
    data["projects"] = [
        {
            "id": pid,
            "name": "Мой проект",
            "created": datetime.now().isoformat(),
        }
    ]
    _save_raw(data)

    _merge_stray_legacy_into_first_project()


def list_projects():
    ensure_migrated()
    data = _load_raw()
    return list(data.get("projects") or [])


def list_project_ids():
    return [p["id"] for p in list_projects() if p.get("id")]


def get_project(project_id):
    for p in list_projects():
        if p.get("id") == project_id:
            return p
    return None


def set_project_name(project_id, name):
    """Задать отображаемое имя проекта в реестре (если id есть)."""
    ensure_migrated()
    if not project_id:
        return False
    name = (name or "").strip() or "Проект"
    data = _load_raw()
    projects = data.get("projects") or []
    for p in projects:
        if p.get("id") == project_id:
            p["name"] = name
            _save_raw(data)
            return True
    return False


def project_root(project_id):
    return os.path.join(PROJECTS_DIR, project_id)


def project_maps_dir(project_id):
    return os.path.join(project_root(project_id), "maps")


def project_token_avatars_dir(project_id):
    return os.path.join(project_root(project_id), "token_avatars")


def create_project(name):
    ensure_migrated()
    name = (name or "").strip() or "Новый проект"
    pid = uuid.uuid4().hex[:12]
    _ensure_project_tree(pid)
    entry = {
        "id": pid,
        "name": name,
        "created": datetime.now().isoformat(),
    }
    data = _load_raw()
    data.setdefault("projects", []).append(entry)
    _save_raw(data)
    return entry


def delete_project(project_id):
    """Удалить проект из реестра и каталога на диске. False, если проекта не было."""
    ensure_migrated()
    if not project_id or not get_project(project_id):
        return False
    data = _load_raw()
    data["projects"] = [
        p for p in data.get("projects", []) if p.get("id") != project_id
    ]
    _save_raw(data)
    root = os.path.join(PROJECTS_DIR, project_id)
    if os.path.isdir(root):
        shutil.rmtree(root, ignore_errors=True)
    return True


def find_project_id_for_map(map_id):
    """Найти проект, в котором есть карта map_id (для ссылок игрока)."""
    if not map_id:
        return None
    ensure_migrated()
    mid = f"{map_id}.json"
    for pid in list_project_ids():
        if os.path.isfile(os.path.join(project_maps_dir(pid), mid)):
            return pid
    return None


def iter_maps_dirs_all_projects():
    for pid in list_project_ids():
        yield project_maps_dir(pid)


def iter_token_avatars_dirs_all_projects():
    for pid in list_project_ids():
        yield project_token_avatars_dir(pid)


def project_images_dir(project_id):
    return os.path.join(project_root(project_id), "images")


def map_image_path_in_project(project_id, map_id):
    idir = project_images_dir(project_id)
    png = os.path.join(idir, f"{map_id}.png")
    if os.path.isfile(png):
        return png
    jpg = os.path.join(idir, f"{map_id}.jpg")
    if os.path.isfile(jpg):
        return jpg
    return None


def first_map_id_with_image_for_preview(project_id):
    """Карта с самым свежим файлом изображения — для превью на обложке проекта."""
    mdir = project_maps_dir(project_id)
    if not os.path.isdir(mdir):
        return None
    best_mid = None
    best_mtime = -1.0
    for f in os.listdir(mdir):
        if not f.endswith(".json"):
            continue
        mid = f[:-5]
        ip = map_image_path_in_project(project_id, mid)
        if not ip:
            continue
        try:
            mt = os.path.getmtime(ip)
        except OSError:
            continue
        if mt > best_mtime:
            best_mtime = mt
            best_mid = mid
    return best_mid


def count_maps_in_project(project_id):
    mdir = project_maps_dir(project_id)
    if not os.path.isdir(mdir):
        return 0
    return sum(1 for f in os.listdir(mdir) if f.endswith(".json"))


def list_projects_for_cards():
    """Список проектов для UI: название, число карт, флаг превью."""
    ensure_migrated()
    rows = []
    for p in list_projects():
        pid = p.get("id")
        if not pid:
            continue
        rows.append(
            {
                "id": pid,
                "name": p.get("name") or pid,
                "created": p.get("created"),
                "map_count": count_maps_in_project(pid),
                "has_preview": first_map_id_with_image_for_preview(pid)
                is not None,
            }
        )
    return rows
