# utils/character_bank.py
import sqlite3
import os
import json
from datetime import datetime
from utils.bank_storage import (
    save_bank_avatar,
    get_bank_avatar_url,
    delete_bank_avatar,
    bank_avatar_exists,
    ensure_bank_avatars_dir,
)
from utils.bank_storage import bank_avatar_exists as bank_storage_avatar_exists

DB_PATH = os.path.join("data", "character_bank.db")


def init_db():
    """Инициализация базы данных банка персонажей"""
    os.makedirs("data", exist_ok=True)
    ensure_bank_avatars_dir()  # Создаем папку для аватаров

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS characters (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            armor_class INTEGER DEFAULT 10,
            max_health INTEGER DEFAULT 10,
            current_health INTEGER DEFAULT 10,
            is_dead BOOLEAN DEFAULT 0,
            has_avatar BOOLEAN DEFAULT 0,
            avatar_path TEXT,
            created_at TIMESTAMP,
            updated_at TIMESTAMP,
            metadata TEXT
        )
    """)

    conn.commit()
    conn.close()


def get_all_bank_characters():
    """Получить всех персонажей из банка"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("""
        SELECT * FROM characters 
        ORDER BY name COLLATE NOCASE
    """)

    rows = cursor.fetchall()
    characters = []

    for row in rows:
        char = dict(row)
        # Парсим metadata если есть
        if char.get("metadata"):
            try:
                char["metadata"] = json.loads(char["metadata"])
            except:
                char["metadata"] = {}

        # Добавляем URL аватара, если есть аватар
        if char.get("has_avatar"):
            char["avatar_url"] = get_bank_avatar_url(char["id"])
        else:
            # Проверяем, может быть файл есть, а в БД не отмечено
            if bank_avatar_exists(char["id"]):
                char["has_avatar"] = True
                char["avatar_url"] = get_bank_avatar_url(char["id"])
                # Обновляем БД
                update_character_avatar_status(char["id"], True)

        characters.append(char)

    conn.close()
    return characters


def update_character_avatar_status(char_id, has_avatar):
    """Обновить статус наличия аватара в БД"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE characters SET has_avatar = ? WHERE id = ?",
        (1 if has_avatar else 0, char_id),
    )
    conn.commit()
    conn.close()


def add_character_to_bank(character_data):
    """Добавить персонажа в банк"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    char_id = character_data.get("id")
    if not char_id:
        import uuid

        char_id = str(uuid.uuid4())

    now = datetime.now().isoformat()

    # Подготавливаем metadata для JSON полей
    metadata = character_data.get("metadata", {})

    cursor.execute(
        """
        INSERT OR REPLACE INTO characters 
        (id, name, type, armor_class, max_health, current_health, is_dead, 
         has_avatar, avatar_path, created_at, updated_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """,
        (
            char_id,
            character_data.get("name", "Безымянный"),
            character_data.get("type", "player"),
            character_data.get("armor_class", 10),
            character_data.get("max_health", 10),
            character_data.get("current_health", 10),
            0,  # is_dead всегда 0 при добавлении
            character_data.get("has_avatar", False),
            character_data.get("avatar_path"),
            now,
            now,
            json.dumps(metadata),
        ),
    )

    conn.commit()
    conn.close()

    return char_id


def update_character_in_bank(char_id, character_data):
    """Обновить данные персонажа в банке"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    now = datetime.now().isoformat()

    cursor.execute(
        """
        UPDATE characters 
        SET name = ?, type = ?, armor_class = ?, max_health = ?, 
            current_health = ?, updated_at = ?, metadata = ?
        WHERE id = ?
    """,
        (
            character_data.get("name"),
            character_data.get("type"),
            character_data.get("armor_class"),
            character_data.get("max_health"),
            character_data.get("current_health"),
            now,
            json.dumps(character_data.get("metadata", {})),
            char_id,
        ),
    )

    conn.commit()
    conn.close()


def delete_character_from_bank(char_id):
    """Удалить персонажа из банка"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("DELETE FROM characters WHERE id = ?", (char_id,))

    conn.commit()
    conn.close()

    # Удаляем аватар
    delete_bank_avatar(char_id)


def get_bank_character(char_id):
    """Получить конкретного персонажа из банка"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM characters WHERE id = ?", (char_id,))
    row = cursor.fetchone()

    conn.close()

    if row:
        char = dict(row)
        if char.get("metadata"):
            try:
                char["metadata"] = json.loads(char["metadata"])
            except:
                char["metadata"] = {}

        if char.get("has_avatar") or bank_avatar_exists(char_id):
            char["has_avatar"] = True
            # ИСПРАВЛЕНО: используем URL для банка
            char["avatar_url"] = get_bank_avatar_url(char["id"])

        return char
    return None


def bank_avatar_exists(char_id):
    """Проверить, существует ли аватар для персонажа в банке"""
    return bank_storage_avatar_exists(char_id)


def save_bank_character_avatar(image_data, char_id):
    """Сохранить аватар для персонажа из банка"""
    success = save_bank_avatar(image_data, char_id)

    if success:
        # Обновляем статус в БД
        update_character_avatar_status(char_id, True)
        print(f"Updated database for bank character {char_id}: has_avatar=1")

    return success


def migrate_existing_avatars_to_bank():
    """Перенести существующие аватары из token_avatars в bank_avatars для персонажей в банке"""
    from utils.storage import get_token_avatar_filepath

    characters = get_all_bank_characters()
    migrated = 0

    for char in characters:
        if char.get("has_avatar") and not bank_avatar_exists(char["id"]):
            # Проверяем, есть ли аватар в старой папке
            old_path = get_token_avatar_filepath(char["id"])
            if os.path.exists(old_path):
                # Копируем в новую папку
                with open(old_path, "rb") as f:
                    avatar_data = f.read()

                if save_bank_avatar(avatar_data, char["id"]):
                    migrated += 1
                    print(f"Migrated avatar for {char['name']} ({char['id']})")

    print(f"Migration complete: {migrated} avatars migrated to bank storage")
    return migrated
