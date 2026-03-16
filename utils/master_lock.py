# utils/master_lock.py
import time
import json
import os

MASTER_LOCK_FILE = "data/master_lock.json"


def acquire_master_lock(session_id, socket_id=None):
    """
    Попытаться захватить блокировку мастера

    Args:
        session_id: ID сессии Flask
        socket_id: ID сокета (опционально)

    Returns:
        tuple: (success, current_master_info)
    """
    try:
        # Создаем директорию если её нет
        os.makedirs(os.path.dirname(MASTER_LOCK_FILE), exist_ok=True)

        # Пытаемся прочитать существующую блокировку
        current_lock = None
        if os.path.exists(MASTER_LOCK_FILE):
            try:
                with open(MASTER_LOCK_FILE, "r") as f:
                    current_lock = json.load(f)
            except:
                current_lock = None

        # Проверяем, существует ли блокировка и не истекла ли она
        if current_lock:
            # Проверяем время блокировки (таймаут 30 секунд без пинга)
            last_seen = current_lock.get("last_seen", 0)
            if time.time() - last_seen < 30:
                # Блокировка активна
                return False, current_lock
            else:
                # Блокировка истекла, можно перезахватить
                pass

        # Захватываем блокировку
        lock_data = {
            "session_id": session_id,
            "socket_id": socket_id,
            "acquired_at": time.time(),
            "last_seen": time.time(),
            "user_agent": None,  # Можно добавить информацию о браузере
        }

        with open(MASTER_LOCK_FILE, "w") as f:
            json.dump(lock_data, f, indent=2)

        return True, lock_data

    except Exception as e:
        print(f"Error acquiring master lock: {e}")
        return False, None


def release_master_lock(session_id):
    """
    Освободить блокировку мастера
    """
    try:
        if not os.path.exists(MASTER_LOCK_FILE):
            return True

        with open(MASTER_LOCK_FILE, "r") as f:
            current_lock = json.load(f)

        if current_lock.get("session_id") == session_id:
            os.remove(MASTER_LOCK_FILE)
            print(f"Master lock released for session {session_id}")
            return True

        return False
    except Exception as e:
        print(f"Error releasing master lock: {e}")
        return False


def update_master_ping(session_id, socket_id=None):
    """
    Обновить время последней активности мастера
    """
    try:
        if not os.path.exists(MASTER_LOCK_FILE):
            return False

        with open(MASTER_LOCK_FILE, "r") as f:
            current_lock = json.load(f)

        if current_lock.get("session_id") == session_id:
            current_lock["last_seen"] = time.time()
            if socket_id:
                current_lock["socket_id"] = socket_id

            with open(MASTER_LOCK_FILE, "w") as f:
                json.dump(current_lock, f, indent=2)
            return True

        return False
    except Exception as e:
        print(f"Error updating master ping: {e}")
        return False


def get_current_master():
    """
    Получить информацию о текущем мастере
    """
    try:
        if not os.path.exists(MASTER_LOCK_FILE):
            return None

        with open(MASTER_LOCK_FILE, "r") as f:
            lock = json.load(f)

        # Проверяем, не истекла ли блокировка
        if time.time() - lock.get("last_seen", 0) < 30:
            return lock
        else:
            # Блокировка истекла, удаляем файл
            os.remove(MASTER_LOCK_FILE)
            return None
    except Exception as e:
        print(f"Error getting current master: {e}")
        return None


def is_master_active():
    """
    Проверить, активен ли мастер
    """
    return get_current_master() is not None
