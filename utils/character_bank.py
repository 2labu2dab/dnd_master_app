import sqlite3
import os
import json
import base64
import io
from datetime import datetime
from PIL import Image

DB_PATH = os.path.join("data", "character_bank.db")

def init_db():
    """Инициализация базы данных банка персонажей"""
    os.makedirs("data", exist_ok=True)
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute('''
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
    ''')
    
    conn.commit()
    conn.close()

def get_all_bank_characters():
    """Получить всех персонажей из банка"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute('''
        SELECT * FROM characters 
        ORDER BY name COLLATE NOCASE
    ''')
    
    rows = cursor.fetchall()
    characters = []
    
    for row in rows:
        char = dict(row)
        # Парсим metadata если есть
        if char.get('metadata'):
            try:
                char['metadata'] = json.loads(char['metadata'])
            except:
                char['metadata'] = {}
        characters.append(char)
    
    conn.close()
    return characters

def add_character_to_bank(character_data):
    """Добавить персонажа в банк"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    char_id = character_data.get('id')
    if not char_id:
        import uuid
        char_id = str(uuid.uuid4())
    
    now = datetime.now().isoformat()
    
    # Подготавливаем metadata для JSON полей
    metadata = character_data.get('metadata', {})
    
    cursor.execute('''
        INSERT OR REPLACE INTO characters 
        (id, name, type, armor_class, max_health, current_health, is_dead, 
         has_avatar, avatar_path, created_at, updated_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        char_id,
        character_data.get('name', 'Безымянный'),
        character_data.get('type', 'player'),
        character_data.get('armor_class', 10),
        character_data.get('max_health', 10),
        character_data.get('current_health', 10),
        0,  # is_dead всегда 0 при добавлении
        character_data.get('has_avatar', False),
        character_data.get('avatar_path'),
        now,
        now,
        json.dumps(metadata)
    ))
    
    conn.commit()
    conn.close()
    
    return char_id

def update_character_in_bank(char_id, character_data):
    """Обновить данные персонажа в банке"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    now = datetime.now().isoformat()
    
    cursor.execute('''
        UPDATE characters 
        SET name = ?, type = ?, armor_class = ?, max_health = ?, 
            current_health = ?, updated_at = ?, metadata = ?
        WHERE id = ?
    ''', (
        character_data.get('name'),
        character_data.get('type'),
        character_data.get('armor_class'),
        character_data.get('max_health'),
        character_data.get('current_health'),
        now,
        json.dumps(character_data.get('metadata', {})),
        char_id
    ))
    
    conn.commit()
    conn.close()

def delete_character_from_bank(char_id):
    """Удалить персонажа из банка"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute('DELETE FROM characters WHERE id = ?', (char_id,))
    
    conn.commit()
    conn.close()

def get_bank_character(char_id):
    """Получить конкретного персонажа из банка"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute('SELECT * FROM characters WHERE id = ?', (char_id,))
    row = cursor.fetchone()
    
    conn.close()
    
    if row:
        char = dict(row)
        if char.get('metadata'):
            try:
                char['metadata'] = json.loads(char['metadata'])
            except:
                char['metadata'] = {}
        return char
    return None

def save_bank_character_avatar(image_data, char_id):
    """Сохранить аватар для персонажа из банка"""
    from utils.storage import save_token_avatar
    success = save_token_avatar(image_data, char_id)
    
    if success:
        # Обновляем путь к аватару в БД
        init_db()
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE characters 
            SET has_avatar = 1, avatar_path = ? 
            WHERE id = ?
        ''', (f"{char_id}.png", char_id))
        conn.commit()
        conn.close()
    
    return success