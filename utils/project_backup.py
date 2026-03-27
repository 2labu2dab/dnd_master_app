# utils/project_backup.py
"""Экспорт/импорт данных проекта (папка data) в архив .mdma (ZIP)."""
import io
import json
import os
import re
import shutil
import zipfile
from datetime import datetime, timezone

from utils.storage import DATA_DIR

MANIFEST_NAME = "mdma_manifest.json"


def backup_download_slug(name):
    """Безопасный фрагмент имени файла (Unicode допускается, убираем символы Windows)."""
    s = (name or "").strip() or "dnd-data"
    for ch in '\\/:*?"<>|\x00':
        s = s.replace(ch, "")
    s = re.sub(r"\s+", "-", s).strip("-") or "dnd-data"
    if len(s) > 80:
        s = s[:80].rstrip("-")
    return s
SKIP_EXPORT_FILES = {"master_lock.json"}
SKIP_EXPORT_DIRS = {".git", "__pycache__"}


def _build_manifest(focus_project_id=None, focus_project_name=None):
    m = {
        "format": "mdma",
        "version": 1,
        "app": "maps-dungeon-master-app",
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }
    if focus_project_id and focus_project_name:
        m["export_focus_project_id"] = focus_project_id
        m["export_focus_project_name"] = focus_project_name
    return m


def export_project_zip_bytes(focus_project_id=None, focus_project_name=None):
    """Собрать ZIP со всем содержимым data/, кроме master_lock.json.

    В манифест пишутся имя и id проекта для подписи бэкапа и восстановления названия при импорте.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            MANIFEST_NAME,
            json.dumps(
                _build_manifest(
                    focus_project_id=focus_project_id,
                    focus_project_name=focus_project_name,
                ),
                indent=2,
                ensure_ascii=False,
            ),
        )
        data_abs = os.path.abspath(DATA_DIR)
        if not os.path.isdir(data_abs):
            return buf.getvalue()
        for root, dirnames, filenames in os.walk(data_abs):
            # не заходим в служебные каталоги
            dirnames[:] = [d for d in dirnames if d not in SKIP_EXPORT_DIRS]
            rel_root = os.path.relpath(root, data_abs)
            for name in filenames:
                if name in SKIP_EXPORT_FILES:
                    continue
                if name.startswith("."):
                    continue
                fp = os.path.join(root, name)
                if not os.path.isfile(fp):
                    continue
                if rel_root == ".":
                    arc = name
                else:
                    arc = os.path.join(rel_root, name).replace("\\", "/")
                zf.write(fp, arcname=arc)
    buf.seek(0)
    return buf.getvalue()


def _safe_target_path(dest_root_abs, member_name):
    """Путь внутри dest_root_abs; None если небезопасно (zip slip)."""
    if not member_name or member_name.endswith("/"):
        return None
    norm = os.path.normpath(member_name.replace("\\", "/"))
    parts = norm.split(os.sep)
    if ".." in parts or parts[0] in ("", os.path.sep):
        return None
    full = os.path.abspath(os.path.join(dest_root_abs, norm))
    if not full.startswith(dest_root_abs + os.sep) and full != dest_root_abs:
        return None
    return full


def _is_valid_mdma_zip(zf):
    if MANIFEST_NAME in zf.namelist():
        try:
            raw = zf.read(MANIFEST_NAME).decode("utf-8")
            meta = json.loads(raw)
            if meta.get("format") == "mdma":
                return True
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    # резерв: похоже на бэкап приложения (старые архивы без манифеста)
    for n in zf.namelist():
        u = n.replace("\\", "/")
        if u.startswith("maps/") or u.startswith("token_avatars/"):
            return True
        if u.startswith("projects/"):
            return True
        if u == "projects.json":
            return True
        if u == "character_bank.db" or u.endswith("/character_bank.db"):
            return True
    return False


def _apply_manifest_project_name_after_import(data_abs):
    """После распаковки: имя проекта из манифеста (по id или единственный проект в реестре)."""
    mp = os.path.join(data_abs, MANIFEST_NAME)
    if not os.path.isfile(mp):
        return
    try:
        with open(mp, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (json.JSONDecodeError, OSError):
        return
    pid = manifest.get("export_focus_project_id")
    pname = manifest.get("export_focus_project_name")
    if not isinstance(pname, str):
        return
    pname = pname.strip()
    if not pname:
        return
    from utils.projects import ensure_migrated, list_projects, set_project_name

    ensure_migrated()
    if pid and set_project_name(pid, pname):
        return
    plist = list_projects()
    if len(plist) == 1:
        set_project_name(plist[0].get("id"), pname)


def import_project_from_zip(file_storage, data_dir=None):
    """
    Заменить содержимое data/ данными из ZIP.
    master_lock.json на диске сохраняется, если в архиве его нет.
    Возвращает (ok: bool, message: str).
    """
    data_dir = data_dir or DATA_DIR
    data_abs = os.path.abspath(data_dir)

    lock_path = os.path.join(data_abs, "master_lock.json")
    lock_backup = None
    if os.path.isfile(lock_path):
        try:
            with open(lock_path, "r", encoding="utf-8") as f:
                lock_backup = f.read()
        except OSError:
            lock_backup = None

    try:
        raw = file_storage.read()
    except OSError as e:
        return False, f"Не удалось прочитать файл: {e}"

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw), "r")
    except zipfile.BadZipFile:
        return False, "Файл не является ZIP-архивом"

    with zf:
        if not _is_valid_mdma_zip(zf):
            return False, "Не похоже на архив MDMA этого приложения"

        # очистить data, оставив только master_lock.json временно
        os.makedirs(data_abs, exist_ok=True)
        for name in os.listdir(data_abs):
            path = os.path.join(data_abs, name)
            if name == "master_lock.json":
                continue
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path)
                else:
                    os.unlink(path)
            except OSError as e:
                return False, f"Не удалось очистить data: {path}: {e}"

        imported_lock = False
        for info in zf.infolist():
            if info.is_dir():
                continue
            member = info.filename.replace("\\", "/")
            if member == MANIFEST_NAME:
                continue
            dest = _safe_target_path(data_abs, member)
            if dest is None:
                continue
            if os.path.basename(dest) == "master_lock.json":
                imported_lock = True
            parent = os.path.dirname(dest)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with zf.open(info, "r") as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)

    if lock_backup and not imported_lock:
        try:
            with open(lock_path, "w", encoding="utf-8") as f:
                f.write(lock_backup)
        except OSError:
            pass

    _apply_manifest_project_name_after_import(data_abs)

    return True, "Импорт выполнен"
