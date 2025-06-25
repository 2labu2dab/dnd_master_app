import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
from PIL import Image, ImageTk, ImageDraw, ImageFont
from dataclasses import dataclass
from typing import Dict, Tuple, List
import math
import numpy as np
from matplotlib.path import Path
import json
import base64
from io import BytesIO

# Modern color scheme
DARK_BG = "#2d2d2d"
DARKER_BG = "#1e1e1e"
ACCENT_COLOR = "#4e7cff"
HIGHLIGHT_COLOR = "#6a9aff"
TEXT_COLOR = "#ffffff"
SECONDARY_TEXT = "#b0b0b0"
BUTTON_BG = "#3a3a3a"
BUTTON_HOVER = "#4a4a4a"
LISTBOX_BG = "#252525"
LISTBOX_SELECTION = "#4e7cff"
SCROLLBAR_BG = "#3a3a3a"
SCROLLBAR_ACTIVE = "#5a5a5a"


@dataclass
class Token:
    id: str
    name: str
    image: ImageTk.PhotoImage
    position: Tuple[float, float]
    size: int = 50
    is_player: bool = False
    is_npc: bool = False
    is_dead: bool = False
    avatar_path: str = None
    avatar_image: ImageTk.PhotoImage = None
    health: int = None
    effects: str = None


@dataclass
class Find:
    id: str
    name: str
    image: ImageTk.PhotoImage
    position: Tuple[float, float]
    size: int = 25
    status: bool = False
    description: str = None


@dataclass
class GridSettings:
    visible: bool = False
    visible_to_players: bool = False
    cell_size: int = 50
    color: str = "#888888"
    opacity: int = 100


@dataclass
class Zone:
    id: str
    name: str
    vertices: List[Tuple[float, float]]
    is_visible: bool = False


class PlayerView:
    def __init__(self, root, master_app):
        self.root = root
        self.master = master_app
        self.root.configure(bg=DARK_BG)
        self.get_token_size = master_app.get_token_size

        # Configure window style
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TFrame", background=DARK_BG)
        style.configure("TLabel", background=DARK_BG, foreground=TEXT_COLOR)
        style.configure(
            "TButton",
            background=BUTTON_BG,
            foreground=TEXT_COLOR,
            borderwidth=1,
            focusthickness=3,
            focuscolor="none",
        )
        style.map(
            "TButton",
            background=[("active", BUTTON_HOVER), ("pressed", ACCENT_COLOR)],
            foreground=[("active", TEXT_COLOR), ("pressed", TEXT_COLOR)],
        )

        self.canvas = tk.Canvas(root, bg=DARKER_BG, highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True)

        # Modern scrollbars
        self.h_scroll = ttk.Scrollbar(root, orient=tk.HORIZONTAL)
        self.v_scroll = ttk.Scrollbar(root, orient=tk.VERTICAL)
        self.h_scroll.pack(side=tk.BOTTOM, fill=tk.X)
        self.v_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.canvas.config(
            xscrollcommand=self.h_scroll.set, yscrollcommand=self.v_scroll.set
        )
        self.h_scroll.config(command=self.canvas.xview)
        self.v_scroll.config(command=self.canvas.yview)

        # Settings
        self.fog_color = (0, 0, 0, 200)
        self.fog_opacity = 0.8
        self.player_outline = "#4CAF50"  # Green
        self.npc_outline = "#FFC107"  # Yellow
        self.enemy_outline = "#F44336"  # Red

        self.redraw_map()

    def _draw_hexagon(self, x, y, size, **kwargs):
        """Draw hexagon with center at (x, y)"""
        points = []
        for i in range(6):
            angle_deg = 60 * i - 30
            angle_rad = math.pi / 180 * angle_deg
            points.append(x + size * math.cos(angle_rad))
            points.append(y + size * math.sin(angle_rad))
        return self.canvas.create_polygon(points, **kwargs)

    def redraw_map(self):
        self.canvas.delete("all")

        if not hasattr(self.master, "map_photo") or not self.master.map_photo:
            return

        # Draw visible parts of the map
        self._draw_visible_map()

        # Draw tokens
        if hasattr(self.master, "tokens"):
            for token in self.master.tokens.values():
                if self._is_token_visible(token):
                    self._draw_token(token)

        self.canvas.config(scrollregion=self.canvas.bbox("all"))

    def _draw_visible_map(self):
        """Draw only visible parts of the map with fog overlay"""
        width = int(self.master.map_image.width * self.master.scale)
        height = int(self.master.map_image.height * self.master.scale)

        # Create base map image
        map_img = self.master.map_image.resize(
            (width, height), Image.Resampling.LANCZOS
        )

        # Create visibility mask (255 = visible, 0 = hidden)
        visibility_mask = Image.new("L", (width, height), 255)
        draw = ImageDraw.Draw(visibility_mask)

        # Mark invisible zones
        if hasattr(self.master, "zones") and self.master.zones:
            for zone in self.master.zones.values():
                if not zone.is_visible:
                    scaled_vertices = [
                        (x * self.master.scale, y * self.master.scale)
                        for x, y in zone.vertices
                    ]
                    if len(scaled_vertices) >= 3:
                        draw.polygon(scaled_vertices, fill=0)

        # Apply visibility to map
        map_img.putalpha(visibility_mask)

        # Create fog layer
        fog = Image.new("RGBA", (width, height), self.fog_color)
        fog.putalpha(
            Image.eval(visibility_mask, lambda x: 255 - int(x * self.fog_opacity))
        )

        # Combine images
        combined = Image.alpha_composite(map_img.convert("RGBA"), fog)

        # Draw grid if enabled and visible to players
        if (
            hasattr(self.master, "grid_settings")
            and self.master.grid_settings.visible
            and self.master.grid_settings.visible_to_players
        ):
            grid_img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            draw_grid = ImageDraw.Draw(grid_img)

            cell_width = width / self.master.grid_settings.cell_size
            cell_count_height = int(height / cell_width)

            # Draw vertical lines
            for i in range(self.master.grid_settings.cell_size + 1):
                x = i * cell_width
                draw_grid.line(
                    [(x, 0), (x, height)], fill=self.master.grid_settings.color
                )

            # Draw horizontal lines
            for i in range(cell_count_height + 1):
                y = i * cell_width
                draw_grid.line(
                    [(0, y), (width, y)], fill=self.master.grid_settings.color
                )

            # Apply opacity
            grid_img.putalpha(self.master.grid_settings.opacity)

            # Combine with map
            combined = Image.alpha_composite(combined, grid_img)

        # Convert to PhotoImage
        photo = ImageTk.PhotoImage(combined)

        # Draw on canvas
        self.canvas.create_image(
            self.master.offset_x,
            self.master.offset_y,
            image=photo,
            anchor=tk.NW,
            tags="map",
        )
        self.canvas.image = photo  # Keep reference

        # Draw ruler if active and visible to players
        if (
            hasattr(self.master, "ruler_active")
            and self.master.ruler_active
            and hasattr(self.master, "ruler_visible_to_players")
            and self.master.ruler_visible_to_players
            and hasattr(self.master, "ruler_start")
            and hasattr(self.master, "ruler_end")
            and self.master.ruler_start
            and self.master.ruler_end
        ):
            start_x = (
                self.master.ruler_start[0] * self.master.scale + self.master.offset_x
            )
            start_y = (
                self.master.ruler_start[1] * self.master.scale + self.master.offset_y
            )
            end_x = self.master.ruler_end[0] * self.master.scale + self.master.offset_x
            end_y = self.master.ruler_end[1] * self.master.scale + self.master.offset_y

            # Draw ruler line
            self.canvas.create_line(
                start_x,
                start_y,
                end_x,
                end_y,
                fill="#FF5252",
                width=2,
                arrow=tk.BOTH,
                tags="ruler",
            )

            # Calculate distance
            cell_width_px = width / self.master.grid_settings.cell_size
            dx = (self.master.ruler_end[0] - self.master.ruler_start[0]) / cell_width_px
            dy = (self.master.ruler_end[1] - self.master.ruler_start[1]) / cell_width_px
            distance = math.sqrt(dx**2 + dy**2) * 5

            # Draw distance text
            self.canvas.create_text(
                (start_x + end_x) / 2,
                (start_y + end_y) / 2 - 15,
                text=f"{distance:.1f} ft",
                fill="#FF5252",
                font=("Segoe UI", 10, "bold"),
                tags="ruler",
            )

    def _is_token_visible(self, token):
        """Check if token should be visible to players"""
        if token.is_player:
            return True

        if not hasattr(self.master, "zones") or not self.master.zones:
            return True

        in_any_zone = False
        for zone in self.master.zones.values():
            if self._point_in_polygon(token.position, zone.vertices):
                in_any_zone = True
                if zone.is_visible:
                    return True

        return not in_any_zone

    @staticmethod
    def _point_in_polygon(point, polygon):
        """Robust point-in-polygon check"""
        if not polygon or len(polygon) < 3:
            return False

        x, y = point
        n = len(polygon)
        inside = False

        p1x, p1y = polygon[0]
        for i in range(n + 1):
            p2x, p2y = polygon[i % n]
            if y > min(p1y, p2y):
                if y <= max(p1y, p2y):
                    if x <= max(p1x, p2x):
                        if p1y != p2y:
                            xinters = (y - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                        if p1x == p2x or x <= xinters:
                            inside = not inside
            p1x, p1y = p2x, p2y

        return inside

    def _draw_token(self, token):
        """Draw token with modern styling"""
        x = token.position[0] * self.master.scale + self.master.offset_x
        y = token.position[1] * self.master.scale + self.master.offset_y
        token_size = self.get_token_size()  # Используем новый метод

        # Определяем цвета в зависимости от типа токена
        if token.is_player:
            outline_color = self.player_outline
            fill_color = "#4CAF50"  # Green
        elif token.is_npc:
            outline_color = self.npc_outline
            fill_color = "#FFC107"  # Yellow
        else:  # Enemy
            outline_color = self.enemy_outline
            fill_color = "#F44336"  # Red

        # Мертвые токены серые
        if token.is_dead:
            fill_color = "#616161"
            outline_color = "#424242"

        # Если есть аватар
        if hasattr(token, "avatar_image") and token.avatar_image:
            # Создаем круглую маску
            mask = Image.new("L", (int(token_size), int(token_size)), 0)
            draw = ImageDraw.Draw(mask)
            draw.ellipse((0, 0, token_size, token_size), fill=255)

            # Применяем маску
            avatar_img = Image.open(token.avatar_path).resize(
                (int(token_size), int(token_size)), Image.Resampling.LANCZOS
            )
            avatar_img.putalpha(mask)
            rounded_avatar = ImageTk.PhotoImage(avatar_img)

            # Сохраняем ссылку
            if not hasattr(self, "_rounded_avatars"):
                self._rounded_avatars = {}
            self._rounded_avatars[token.id] = rounded_avatar

            # Рисуем аватар
            self.canvas.create_image(
                x, y, image=rounded_avatar, tags=("token", f"token_{token.id}")
            )

            # Рисуем обводку - шестиугольник для игроков, круг для остальных
            if token.is_player:
                self._draw_hexagon(
                    x,
                    y,
                    token_size // 2,
                    outline=outline_color,
                    fill="",
                    width=3,
                    tags=("token", f"token_{token.id}"),
                )
            else:
                self.canvas.create_oval(
                    x - token_size // 2,
                    y - token_size // 2,
                    x + token_size // 2,
                    y + token_size // 2,
                    outline=outline_color,
                    fill="",
                    width=3,
                    tags=("token", f"token_{token.id}"),
                )
        else:
            # Стандартный вид токена
            if token.is_player:
                self._draw_hexagon(
                    x,
                    y,
                    token_size // 2,
                    outline=outline_color,
                    fill=fill_color,
                    width=2,
                    tags=("token", f"token_{token.id}"),
                )
            else:
                self.canvas.create_oval(
                    x - token_size // 2,
                    y - token_size // 2,
                    x + token_size // 2,
                    y + token_size // 2,
                    fill=fill_color,
                    outline=outline_color,
                    width=2,
                    tags=("token", f"token_{token.id}"),
                )

        # Метка токена
        text_color = "#212121" if token.is_npc else "#FAFAFA"
        if token.is_dead:
            text_color = "#9E9E9E"

        self.canvas.create_text(
            x,
            y - token_size // 2 - 10,
            text=token.name,
            fill=text_color,
            font=("Segoe UI", 9, "bold"),
            tags=("token", f"token_{token.id}"),
        )


class DnDMapMaster:
    def __init__(self, root):
        self.root = root
        self.root.title("D&D Map Master - Game Master View")
        self.root.geometry("1200x800")
        self.root.configure(bg=DARK_BG)

        # Configure styles
        self._configure_styles()

        self.player_view_minimap = None
        self.minimap_size = 300

        # Game data
        self.map_image = None
        self.map_photo = None
        self.tokens: Dict[str, Token] = {}
        self.zones: Dict[str, Zone] = {}
        self.next_token_id = 1
        self.next_zone_id = 1
        self.finds = {}
        self.next_find_id = 1

        # Grid and ruler settings
        self.grid_settings = GridSettings()
        self.ruler_active = False
        self.ruler_start = None
        self.ruler_end = None
        self.ruler_visible_to_players = True

        # Display settings
        self.scale = 1.0
        self.offset_x = 0
        self.offset_y = 0

        # UI state
        self.selected_token = None
        self.drag_start = None
        self.token_start_pos = None
        self.creating_zone = False
        self.current_zone_vertices = []
        self.snap_points = []

        # Player view
        self.player_window = None
        self.player_view = None

        # Context menus
        self.token_context_menu = None
        self.zone_context_menu = None
        self.current_context_object = None

        # Create UI
        self._create_widgets()
        self._setup_bindings()
        self._create_context_menus()
        self.root.bind("<Configure>", self._on_window_resize)

    def get_token_size(self):
        """Calculate token size based on grid cell size"""
        if not self.map_image or not hasattr(self, "grid_settings"):
            return 50  # Default size if no grid

        # Calculate cell size in pixels at current scale
        return int((self.map_image.width / self.grid_settings.cell_size) * self.scale)

    def _configure_styles(self):
        """Configure ttk styles for a modern look"""
        style = ttk.Style()
        style.theme_use("clam")

        # Main window styles
        style.configure(".", background=DARK_BG, foreground=TEXT_COLOR)
        style.configure("TFrame", background=DARK_BG)
        style.configure("TLabel", background=DARK_BG, foreground=TEXT_COLOR)
        style.configure(
            "TButton",
            background=BUTTON_BG,
            foreground=TEXT_COLOR,
            borderwidth=1,
            focusthickness=3,
            focuscolor="none",
            font=("Segoe UI", 9),
        )
        style.map(
            "TButton",
            background=[("active", BUTTON_HOVER), ("pressed", ACCENT_COLOR)],
            foreground=[("active", TEXT_COLOR), ("pressed", TEXT_COLOR)],
        )

        # Scrollbar styles
        style.configure(
            "TScrollbar",
            background=SCROLLBAR_BG,
            troughcolor=DARKER_BG,
            arrowcolor=TEXT_COLOR,
            bordercolor=DARK_BG,
        )
        style.map("TScrollbar", background=[("active", SCROLLBAR_ACTIVE)])

        # Listbox styles (need to configure tkinter directly)
        self.root.option_add("*Listbox*Background", LISTBOX_BG)
        self.root.option_add("*Listbox*Foreground", TEXT_COLOR)
        self.root.option_add("*Listbox*selectBackground", LISTBOX_SELECTION)
        self.root.option_add("*Listbox*selectForeground", TEXT_COLOR)
        self.root.option_add("*Listbox*font", ("Segoe UI", 9))

        # Entry and combobox styles
        style.configure(
            "TEntry",
            fieldbackground=DARKER_BG,
            foreground=TEXT_COLOR,
            insertcolor=TEXT_COLOR,
            borderwidth=1,
        )
        style.configure(
            "TCombobox",
            fieldbackground=DARKER_BG,
            foreground=TEXT_COLOR,
            selectbackground=ACCENT_COLOR,
            selectforeground=TEXT_COLOR,
        )

        # Notebook style (for potential future tabs)
        style.configure("TNotebook", background=DARK_BG)
        style.configure(
            "TNotebook.Tab",
            background=DARKER_BG,
            foreground=TEXT_COLOR,
            padding=[10, 5],
        )
        style.map(
            "TNotebook.Tab",
            background=[("selected", ACCENT_COLOR)],
            foreground=[("selected", TEXT_COLOR)],
        )

    def toggle_grid(self):
        """Toggle grid visibility"""
        self.grid_settings.visible = not self.grid_settings.visible
        self.redraw_map()
        status = "visible" if self.grid_settings.visible else "hidden"
        self.update_status(f"Grid is now {status}")

    def toggle_grid_for_players(self):
        """Toggle grid visibility for players"""
        self.grid_settings.visible_to_players = (
            not self.grid_settings.visible_to_players
        )
        self.redraw_map()
        status = "visible" if self.grid_settings.visible_to_players else "hidden"
        self.update_status(f"Grid for players is now {status}")

    def set_grid_cell_count(self):
        """Set number of grid cells"""
        count = simpledialog.askinteger(
            "Настройки сетки",
            "Введите размер сетки:",
            initialvalue=self.grid_settings.cell_size,
            minvalue=1,
            maxvalue=200,
        )
        if count:
            self.grid_settings.cell_size = count
            for token in self.tokens.values():
                token.size = self.get_token_size()
            for find in self.finds.values():
                find.size = self.get_token_size()
            self.redraw_map()
            self.update_status(f"Set grid to {count} cells wide")

    def toggle_ruler(self):
        """Toggle ruler tool"""
        self.ruler_active = not self.ruler_active
        if not self.ruler_active:
            self.ruler_start = None
            self.ruler_end = None
        self.redraw_map()
        status = "active" if self.ruler_active else "inactive"
        self.update_status(f"Ruler is now {status}")

    def _create_context_menus(self):
        """Create modern context menus"""
        # Token context menu
        self.token_context_menu = tk.Menu(
            self.root,
            tearoff=0,
            bg=DARKER_BG,
            fg=TEXT_COLOR,
            activebackground=ACCENT_COLOR,
            activeforeground=TEXT_COLOR,
            bd=1,
            relief=tk.FLAT,
        )

        self.token_context_menu.add_command(
            label="Сменить тип персонажа", command=self._change_token_type
        )
        self.token_context_menu.add_command(
            label="Сменить аватар",
            command=lambda: self._load_avatar(self.current_context_object),
        )
        self.token_context_menu.add_command(
            label="Жив/Мертв", command=self._toggle_token_dead_status
        )
        self.token_context_menu.add_separator()
        self.token_context_menu.add_command(
            label="Удалить персонажа", command=self._delete_selected_token
        )

        # Zone context menu
        self.zone_context_menu = tk.Menu(
            self.root,
            tearoff=0,
            bg=DARKER_BG,
            fg=TEXT_COLOR,
            activebackground=ACCENT_COLOR,
            activeforeground=TEXT_COLOR,
            bd=1,
            relief=tk.FLAT,
        )
        self.zone_context_menu.add_command(
            label="Переименовать зону", command=self._rename_selected_zone
        )
        self.zone_context_menu.add_command(
            label="Открыть зону", command=lambda: self._toggle_zone_visibility(True)
        )
        self.zone_context_menu.add_command(
            label="Спрятать зону", command=lambda: self._toggle_zone_visibility(False)
        )
        self.zone_context_menu.add_separator()
        self.zone_context_menu.add_command(
            label="Удалить зону", command=self._delete_selected_zone
        )

        self.find_context_menu = tk.Menu(
            self.root,
            tearoff=0,
            bg=DARKER_BG,
            fg=TEXT_COLOR,
            activebackground=ACCENT_COLOR,
            activeforeground=TEXT_COLOR,
            bd=1,
            relief=tk.FLAT,
        )
        self.find_context_menu.add_command(
            label="Найдена/Не найдена", command=self._toggle_find_status
        )
        self.find_context_menu.add_command(
            label="Изменить описание", command=self._edit_find_description
        )
        self.find_context_menu.add_separator()
        self.find_context_menu.add_command(
            label="Удалить находку", command=self._delete_find
        )

    def _toggle_find_status(self):
        """Переключить статус находки (найдена/не найдена)"""
        if not hasattr(self, "selected_find"):
            return

        find = self.finds[self.selected_find]
        find.status = not find.status
        self.redraw_map()
        status = "найдена" if find.status else "не найдена"
        self.update_status(f"Находка {find.name} теперь {status}")

    def _edit_find_description(self):
        """Изменить описание находки"""
        if not hasattr(self, "selected_find"):
            return

        find = self.finds[self.selected_find]
        new_desc = simpledialog.askstring(
            "Описание находки", "Введите новое описание:", initialvalue=find.description
        )
        if new_desc is not None:
            find.description = new_desc
            self.update_status(f"Обновлено описание для {find.name}")

    def _delete_find(self):
        """Удалить выбранную находку"""
        if not hasattr(self, "selected_find"):
            return

        find = self.finds[self.selected_find]
        if messagebox.askyesno("Подтверждение", f"Удалить находку {find.name}?"):
            del self.finds[self.selected_find]
            del self.selected_find
            self.redraw_map()
            self.update_status(f"Находка {find.name} удалена")

    def _change_token_type(self):
        """Change token type (player/NPC/enemy)"""
        if (
            not self.current_context_object
            or self.current_context_object not in self.tokens
        ):
            return

        token = self.tokens[self.current_context_object]

        # Create modern popup menu
        type_menu = tk.Menu(
            self.root,
            tearoff=0,
            bg=DARKER_BG,
            fg=TEXT_COLOR,
            activebackground=ACCENT_COLOR,
            activeforeground=TEXT_COLOR,
        )

        type_menu.add_command(
            label="Игрок",
            command=lambda: self._set_token_type("Игрок"),
            font=("Segoe UI", 9),
        )
        type_menu.add_command(
            label="НПС",
            command=lambda: self._set_token_type("НПС"),
            font=("Segoe UI", 9),
        )
        type_menu.add_command(
            label="Враг",
            command=lambda: self._set_token_type("Враг"),
            font=("Segoe UI", 9),
        )

        # Show menu near cursor
        try:
            type_menu.tk_popup(self.root.winfo_pointerx(), self.root.winfo_pointery())
        finally:
            type_menu.grab_release()

    def _set_token_type(self, token_type):
        """Set token type"""
        if not self.current_context_object:
            return

        token = self.tokens[self.current_context_object]

        if token_type == "Игрок":
            token.is_player = True
            token.is_npc = False
        elif token_type == "НПС":
            token.is_player = False
            token.is_npc = True
        else:  # enemy
            token.is_player = False
            token.is_npc = False

        self.redraw_map()
        self._update_tokens_list()
        self.update_status(f"Token {token.name} changed to {token_type}")

    def _toggle_token_dead_status(self):
        """Toggle token dead/alive status"""
        if (
            not self.current_context_object
            or self.current_context_object not in self.tokens
        ):
            return

        token = self.tokens[self.current_context_object]
        token.is_dead = not token.is_dead
        self.redraw_map()
        status = "мертв" if token.is_dead else "жив"
        self.update_status(f"Token {token.name} is now {status}")

    def _delete_selected_token(self):
        """Delete selected token"""
        if (
            not self.current_context_object
            or self.current_context_object not in self.tokens
        ):
            return

        token = self.tokens[self.current_context_object]
        if messagebox.askyesno("Confirm", f"Удалить токен {token.name}?"):
            del self.tokens[self.current_context_object]
            self._update_tokens_list()
            self.redraw_map()
            self.update_status(f"Token {token.name} deleted")

    def _delete_selected_zone(self):
        """Delete selected zone"""
        if (
            not self.current_context_object
            or self.current_context_object not in self.zones
        ):
            return

        zone = self.zones[self.current_context_object]
        if messagebox.askyesno("Confirm", f"Удалить зону {zone.name}?"):
            del self.zones[self.current_context_object]
            self._update_zones_list()
            self.redraw_map()
            self.update_status(f"Zone {zone.name} deleted")

    def _rename_selected_zone(self):
        """Rename selected zone"""
        if (
            not self.current_context_object
            or self.current_context_object not in self.zones
        ):
            return

        zone = self.zones[self.current_context_object]
        new_name = simpledialog.askstring(
            "Rename Zone", "New zone name:", initialvalue=zone.name
        )
        if new_name and new_name != zone.name:
            zone.name = new_name
            self._update_zones_list()
            self.redraw_map()
            self.update_status(f"Zone renamed to {new_name}")

    def _toggle_zone_visibility(self, visible):
        """Change zone visibility"""
        if (
            not self.current_context_object
            or self.current_context_object not in self.zones
        ):
            return

        zone = self.zones[self.current_context_object]
        zone.is_visible = visible
        self.redraw_map()
        status = "revealed" if visible else "hidden"
        self.update_status(f"Zone {zone.name} is now {status}")

    def _update_tokens_list(self):
        """Update tokens list"""
        self.tokens_list.delete(0, tk.END)
        for token in self.tokens.values():
            prefix = "[И] " if token.is_player else "[Н] " if token.is_npc else "[В] "
            status = " (мертв)" if token.is_dead else ""
            self.tokens_list.insert(tk.END, f"{prefix}{token.name}{status}")

    def _update_zones_list(self):
        """Update zones list"""
        self.zones_list.delete(0, tk.END)
        for zone in self.zones.values():
            status = " (visible)" if zone.is_visible else " (hidden)"
            self.zones_list.insert(tk.END, f"{zone.name}{status}")

    def _on_window_resize(self, event):
        """Handle window resize"""
        self._update_ui_layout()
        if self.map_image:
            self._fit_map_to_canvas()
            self.redraw_map()

    def _update_minimap(self):
        """Update player view minimap with grid-scaled tokens"""
        if not self.map_image:
            return

        # Create minimized player view
        minimap_img = Image.new(
            "RGBA", (self.minimap_size, self.minimap_size), (0, 0, 0, 0)
        )
        draw = ImageDraw.Draw(minimap_img)

        # Scale main map
        map_width, map_height = self.map_image.size
        scale = min(self.minimap_size / map_width, self.minimap_size / map_height)
        scaled_width = int(map_width * scale)
        scaled_height = int(map_height * scale)

        # Draw map
        map_img = self.map_image.resize(
            (scaled_width, scaled_height), Image.Resampling.LANCZOS
        )
        minimap_img.paste(
            map_img,
            (
                (self.minimap_size - scaled_width) // 2,
                (self.minimap_size - scaled_height) // 2,
            ),
        )

        # Calculate cell size in minimap pixels
        if hasattr(self, "grid_settings"):
            cell_size_minimap = int(scaled_width / self.grid_settings.cell_size)
        else:
            cell_size_minimap = 5  # Default size if no grid

        # Draw zones (only hidden ones)
        if hasattr(self, "zones"):
            for zone in self.zones.values():
                if not zone.is_visible:
                    scaled_vertices = [
                        (
                            x * scale + (self.minimap_size - scaled_width) // 2,
                            y * scale + (self.minimap_size - scaled_height) // 2,
                        )
                        for x, y in zone.vertices
                    ]
                    if len(scaled_vertices) >= 3:
                        draw.polygon(scaled_vertices, fill=(0, 0, 0, 160))

        # Draw tokens with grid-scaled size
        if hasattr(self, "tokens"):
            for token in self.tokens.values():
                if self._is_token_visible_in_minimap(token):
                    x = (
                        token.position[0] * scale
                        + (self.minimap_size - scaled_width) // 2
                    )
                    y = (
                        token.position[1] * scale
                        + (self.minimap_size - scaled_height) // 2
                    )

                    # Use grid-based size for tokens
                    size = max(2, cell_size_minimap / 2)  # Half of cell size

                    if token.is_player:
                        fill = (76, 175, 80)  # Green
                        outline = (56, 142, 60)  # Dark green
                    elif token.is_npc:
                        fill = (255, 193, 7)  # Yellow
                        outline = (230, 174, 0)  # Dark yellow
                    else:
                        fill = (244, 67, 54)  # Red
                        outline = (198, 40, 40)  # Dark red

                    # Dead tokens
                    if token.is_dead:
                        fill = (97, 97, 97)  # Gray
                        outline = (66, 66, 66)  # Dark gray

                    # Draw outline
                    draw.ellipse(
                        [x - size - 1, y - size - 1, x + size + 1, y + size + 1],
                        fill=outline,
                    )
                    # Draw main circle
                    draw.ellipse([x - size, y - size, x + size, y + size], fill=fill)

        # Convert to PhotoImage
        self.player_view_minimap = ImageTk.PhotoImage(minimap_img)

        # Update canvas
        self.minimap_canvas.create_image(
            0, 0, image=self.player_view_minimap, anchor=tk.NW
        )
        self.minimap_canvas.image = self.player_view_minimap  # Keep reference

    def _is_token_visible_in_minimap(self, token):
        """Check if token should be visible in minimap"""
        if token.is_player:
            return True

        if not hasattr(self, "zones") or not self.zones:
            return True

        in_any_zone = False
        for zone in self.zones.values():
            if self._point_in_polygon(token.position, zone.vertices):
                in_any_zone = True
                if zone.is_visible:
                    return True

        return not in_any_zone

    def _create_widgets(self):
        """Create all UI widgets with modern styling"""
        self.main_frame = ttk.Frame(self.root)
        self.main_frame.pack(fill=tk.BOTH, expand=True)

        # Control panel - modern dark sidebar
        self.control_panel = ttk.Frame(self.main_frame, width=220, style="TFrame")
        self.control_panel.pack(side=tk.LEFT, fill=tk.Y, padx=5, pady=5)

        # Canvas with scrollbars
        self.canvas_frame = ttk.Frame(self.main_frame)
        self.canvas_frame.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)

        # Modern scrollbars
        self.h_scroll = ttk.Scrollbar(
            self.canvas_frame, orient=tk.HORIZONTAL, style="TScrollbar"
        )
        self.v_scroll = ttk.Scrollbar(
            self.canvas_frame, orient=tk.VERTICAL, style="TScrollbar"
        )

        self.canvas = tk.Canvas(
            self.canvas_frame,
            bg=DARKER_BG,
            highlightthickness=0,
            xscrollcommand=self.h_scroll.set,
            yscrollcommand=self.v_scroll.set,
        )

        self.h_scroll.pack(side=tk.BOTTOM, fill=tk.X)
        self.v_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.h_scroll.config(command=self.canvas.xview)
        self.v_scroll.config(command=self.canvas.yview)

        # Control buttons with modern styling
        controls = [
            ("Загрузить карту", self.load_map),
            ("Добавить игрока", lambda: self.add_token(is_player=True)),
            ("Добавить врага", lambda: self.add_token(is_player=False)),
            ("Добавить НПС", lambda: self.add_token(is_npc=True)),
            ("Добавить зону", self.start_zone_creation),
            ("Добавить находку", lambda: self.add_find()),
            ("Открыть окно игрока", self.open_player_view),
        ]

        for text, command in controls:
            btn = ttk.Button(
                self.control_panel, text=text, command=command, style="TButton"
            )
            btn.pack(pady=5, padx=5, fill=tk.X)

        # Separator
        ttk.Separator(self.control_panel, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=10)

        # Grid controls
        grid_controls = [
            ("Показать/Скрыть сетку", self.toggle_grid),
            ("Показать/Скрыть сетку для игроков", self.toggle_grid_for_players),
            ("Задать размер сетки", self.set_grid_cell_count),
            ("Линейка", self.toggle_ruler),
        ]

        for text, command in grid_controls:
            btn = ttk.Button(
                self.control_panel, text=text, command=command, style="TButton"
            )
            btn.pack(pady=5, padx=5, fill=tk.X)

        # Separator
        ttk.Separator(self.control_panel, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=10)

        # Tokens list with modern styling
        self.tokens_frame = ttk.LabelFrame(
            self.control_panel, text="Персонажи", style="TFrame"
        )
        self.tokens_frame.pack(pady=5, padx=5, fill=tk.BOTH, expand=True)

        self.tokens_list = tk.Listbox(
            self.tokens_frame,
            bg=LISTBOX_BG,
            fg=TEXT_COLOR,
            selectbackground=LISTBOX_SELECTION,
            selectforeground=TEXT_COLOR,
            highlightthickness=0,
            relief=tk.FLAT,
        )
        self.tokens_list.pack(fill=tk.BOTH, expand=True, padx=2, pady=2)
        self.tokens_list.bind("<<ListboxSelect>>", self.on_token_select)

        # Zones list
        self.zones_frame = ttk.LabelFrame(
            self.control_panel, text="Зоны", style="TFrame"
        )
        self.zones_frame.pack(pady=5, padx=5, fill=tk.BOTH, expand=True)

        self.zones_list = tk.Listbox(
            self.zones_frame,
            bg=LISTBOX_BG,
            fg=TEXT_COLOR,
            selectbackground=LISTBOX_SELECTION,
            selectforeground=TEXT_COLOR,
            highlightthickness=0,
            relief=tk.FLAT,
        )
        self.zones_list.pack(fill=tk.BOTH, expand=True, padx=2, pady=2)
        self.zones_list.bind("<Double-Button-1>", self.toggle_zone_visibility)

        # Modern status bar
        self.status_var = tk.StringVar()
        self.status_bar = ttk.Label(
            self.root,
            textvariable=self.status_var,
            relief=tk.SUNKEN,
            anchor=tk.W,
            style="TLabel",
            font=("Segoe UI", 9),
        )
        self.status_bar.pack(side=tk.BOTTOM, fill=tk.X)

        # Minimap frame with modern styling
        self.minimap_frame = ttk.Frame(
            self.canvas_frame, relief=tk.SUNKEN, style="TFrame"
        )
        self.minimap_frame.place(relx=1.0, rely=1.0, x=-10, y=-10, anchor=tk.SE)

        self.minimap_canvas = tk.Canvas(
            self.minimap_frame,
            width=self.minimap_size,
            height=self.minimap_size,
            bg=DARKER_BG,
            highlightthickness=0,
        )
        self.minimap_canvas.pack(padx=1, pady=1)

        self.minimap_label = ttk.Label(
            self.minimap_frame,
            text="Превью окна игрока",
            style="TLabel",
            font=("Segoe UI", 9),
        )
        self.minimap_label.pack(fill=tk.X)

        # Move canvas under label
        self.minimap_canvas.pack(padx=1, pady=(0, 1))

        # Import/Export buttons
        ttk.Button(
            self.control_panel,
            text="Экспорт настроек карты",
            command=self.export_settings,
            style="TButton",
        ).pack(pady=5, padx=5, fill=tk.X)

        ttk.Button(
            self.control_panel,
            text="Импорт настроек карты",
            command=self.import_settings,
            style="TButton",
        ).pack(pady=5, padx=5, fill=tk.X)

        self.update_status("Ready")

    def export_settings(self):
        """Export all settings to file"""
        if not self.map_image:
            messagebox.showwarning("Warning", "No map loaded to export!")
            return

        data = {
            "version": 1,
            "map": self._export_map_data(),
            "tokens": self._export_tokens_data(),
            "zones": self._export_zones_data(),
            "view_settings": {
                "scale": self.scale,
                "offset_x": self.offset_x,
                "offset_y": self.offset_y,
            },
            "grid_settings": {
                "visible": self.grid_settings.visible,
                "visible_to_players": self.grid_settings.visible_to_players,
                "cell_size": self.grid_settings.cell_size,
                "color": self.grid_settings.color,
                "opacity": self.grid_settings.opacity,
            },
            "ruler_visible_to_players": self.ruler_visible_to_players,
        }

        file_path = filedialog.asksaveasfilename(
            defaultextension=".dndmap", filetypes=[("D&D Map Files", "*.dndmap")]
        )

        if file_path:
            with open(file_path, "w") as f:
                json.dump(data, f, indent=2)
            self.update_status(f"Settings exported to {file_path}")

    def _export_map_data(self):
        """Export map data"""
        buffered = BytesIO()
        self.map_image.save(buffered, format="PNG")
        img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
        return {
            "image_data": img_str,
            "width": self.map_image.width,
            "height": self.map_image.height,
        }

    def _export_tokens_data(self):
        """Export tokens data"""
        tokens_data = []
        for token in self.tokens.values():
            token_data = {
                "id": token.id,
                "name": token.name,
                "position": token.position,
                "size": token.size,
                "is_player": token.is_player,
                "is_npc": token.is_npc,
                "is_dead": token.is_dead,
            }

            if token.avatar_path:
                with open(token.avatar_path, "rb") as f:
                    avatar_data = base64.b64encode(f.read()).decode("utf-8")
                token_data["avatar"] = {
                    "data": avatar_data,
                    "extension": token.avatar_path.split(".")[-1].lower(),
                }

            tokens_data.append(token_data)
        return tokens_data

    def _export_zones_data(self):
        """Export zones data"""
        return [
            {
                "id": zone.id,
                "name": zone.name,
                "vertices": zone.vertices,
                "is_visible": zone.is_visible,
            }
            for zone in self.zones.values()
        ]

    def import_settings(self):
        """Import settings from file"""
        file_path = filedialog.askopenfilename(
            filetypes=[("D&D Map Files", "*.dndmap")]
        )

        if not file_path:
            return

        try:
            with open(file_path, "r") as f:
                data = json.load(f)

            # Clear current data
            self.map_image = None
            self.tokens = {}
            self.zones = {}
            self.next_token_id = 1
            self.next_zone_id = 1

            # Import map
            self._import_map_data(data["map"])

            # Import tokens
            self._import_tokens_data(data["tokens"])

            # Import zones
            self._import_zones_data(data["zones"])

            # Restore view settings
            if "view_settings" in data:
                self.scale = data["view_settings"]["scale"]
                self.offset_x = data["view_settings"]["offset_x"]
                self.offset_y = data["view_settings"]["offset_y"]

            if "grid_settings" in data:
                grid_data = data["grid_settings"]
                self.grid_settings.visible = grid_data.get("visible", False)
                self.grid_settings.visible_to_players = grid_data.get(
                    "visible_to_players", False
                )
                self.grid_settings.cell_size = grid_data.get("cell_size", 50)
                self.grid_settings.color = grid_data.get("color", "#888888")
                self.grid_settings.opacity = grid_data.get("opacity", 100)

            self.ruler_visible_to_players = data.get("ruler_visible_to_players", True)
            self.redraw_map()
            self._update_tokens_list()
            self._update_zones_list()
            self.update_status(f"Settings imported from {file_path}")

        except Exception as e:
            messagebox.showerror("Import Error", f"Failed to import settings: {str(e)}")

    def _import_map_data(self, map_data):
        """Import map data"""
        img_data = base64.b64decode(map_data["image_data"])
        self.map_image = Image.open(BytesIO(img_data))
        self.map_photo = ImageTk.PhotoImage(self.map_image)

    def _import_tokens_data(self, tokens_data):
        """Import tokens data"""
        for token_data in tokens_data:
            token_id = f"token_{self.next_token_id}"
            self.next_token_id += 1

            # Create base token image
            size = token_data.get("size", 50)
            img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)

            if token_data["is_player"]:
                color = (76, 175, 80)  # Green
            elif token_data["is_npc"]:
                color = (255, 193, 7)  # Yellow
            else:
                color = (244, 67, 54)  # Red

            draw.ellipse((0, 0, size, size), fill=color)
            token_photo = ImageTk.PhotoImage(img)

            # Create token
            token = Token(
                id=token_id,
                name=token_data["name"],
                image=token_photo,
                position=tuple(token_data["position"]),
                size=size,
                is_player=token_data["is_player"],
                is_npc=token_data["is_npc"],
                is_dead=token_data.get("is_dead", False),
            )

            # Restore avatar if exists
            if "avatar" in token_data:
                try:
                    avatar_data = base64.b64decode(token_data["avatar"]["data"])
                    extension = token_data["avatar"]["extension"]

                    # Save temp file
                    temp_path = f"temp_avatar_{token_id}.{extension}"
                    with open(temp_path, "wb") as f:
                        f.write(avatar_data)

                    # Load avatar
                    img = Image.open(temp_path)
                    img.thumbnail((size, size))

                    squared_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
                    offset = ((size - img.width) // 2, (size - img.height) // 2)
                    squared_img.paste(img, offset)

                    avatar_img = ImageTk.PhotoImage(squared_img)
                    token.avatar_path = temp_path
                    token.avatar_image = avatar_img

                    # Save reference
                    if not hasattr(self, "_avatar_images"):
                        self._avatar_images = {}
                    self._avatar_images[token_id] = avatar_img

                except Exception as e:
                    print(f"Failed to load avatar for token {token_id}: {str(e)}")

            self.tokens[token_id] = token

    def _import_zones_data(self, zones_data):
        """Import zones data"""
        for zone_data in zones_data:
            zone_id = f"zone_{self.next_zone_id}"
            self.next_zone_id += 1

            zone = Zone(
                id=zone_id,
                name=zone_data["name"],
                vertices=[tuple(v) for v in zone_data["vertices"]],
                is_visible=zone_data["is_visible"],
            )

            self.zones[zone_id] = zone

    def _setup_bindings(self):
        """Setup event bindings"""
        self.canvas.bind("<Button-1>", self.on_canvas_click)
        self.canvas.bind("<B1-Motion>", self.on_canvas_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_canvas_release)
        self.canvas.bind("<MouseWheel>", self.on_mouse_wheel)
        self.canvas.bind("<Button-3>", self.on_right_click)
        self.canvas.bind("<Motion>", self.on_canvas_motion)

    def update_status(self, message):
        """Update status bar"""
        self.status_var.set(message)

    def _fit_map_to_canvas(self):
        """Calculate scale to fit map to canvas"""
        if not self.map_image:
            return

        # Get canvas size (subtract control panel width)
        canvas_width = self.canvas.winfo_width() - 220  # Subtract control panel width
        canvas_height = self.canvas.winfo_height()

        if canvas_width <= 0 or canvas_height <= 0:
            return

        # Calculate scale to fit map to canvas
        img_width, img_height = self.map_image.size
        scale_x = canvas_width / img_width
        scale_y = canvas_height / img_height
        self.scale = min(scale_x, scale_y)

        # Center the map
        self.offset_x = (
            canvas_width - img_width * self.scale
        ) / 2 + 110  # Add half of control panel
        self.offset_y = (canvas_height - img_height * self.scale) / 2

        self.update_status(f"Стандартный масштаб: {self.scale:.2f}x")

    def load_map(self):
        """Load map image"""
        file_path = filedialog.askopenfilename(
            filetypes=[("Image files", "*.png *.jpg *.jpeg")]
        )
        if file_path:
            try:
                self.map_image = Image.open(file_path)
                self.map_photo = ImageTk.PhotoImage(self.map_image)
                self._fit_map_to_canvas()
                self.redraw_map()
                self.update_status(f"Загруженная карта: {file_path}")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to load image: {e}")
                self.update_status(f"Error: {e}")

    def _load_avatar(self, token_id):
        """Load and prepare avatar for token"""
        file_path = filedialog.askopenfilename(
            filetypes=[("Image files", "*.png *.jpg *.jpeg *.gif")]
        )
        if file_path:
            try:
                token = self.tokens[token_id]
                img = Image.open(file_path)

                # Scale while maintaining aspect ratio
                img.thumbnail((token.size, token.size))

                # Create square image
                squared_img = Image.new("RGBA", (token.size, token.size), (0, 0, 0, 0))
                offset = ((token.size - img.width) // 2, (token.size - img.height) // 2)
                squared_img.paste(img, offset)

                avatar_img = ImageTk.PhotoImage(squared_img)
                token.avatar_path = file_path
                token.avatar_image = avatar_img

                # Save reference
                if not hasattr(self, "_avatar_images"):
                    self._avatar_images = {}
                self._avatar_images[token_id] = avatar_img

                self.redraw_map()
                self.update_status(f"Avatar updated for {token.name}")
            except Exception as e:
                messagebox.showerror("Error", f"Failed to load image: {e}")

    def reset_view(self):
        """Reset zoom and position"""
        self._fit_map_to_canvas()
        self.redraw_map()

    def _draw_hexagon(self, x, y, size, **kwargs):
        """Draw hexagon with center at (x, y)"""
        points = []
        for i in range(6):
            angle_deg = 60 * i - 30
            angle_rad = math.pi / 180 * angle_deg
            points.append(x + size * math.cos(angle_rad))
            points.append(y + size * math.sin(angle_rad))
        return self.canvas.create_polygon(points, **kwargs)

    def redraw_map(self):
        """Redraw everything on canvas"""
        self.canvas.delete("all")

        if self.map_photo:
            # Calculate scaled size
            width = int(self.map_image.width * self.scale)
            height = int(self.map_image.height * self.scale)

            # Create scaled image
            scaled_img = self.map_image.resize(
                (width, height), Image.Resampling.LANCZOS
            )
            self.map_photo = ImageTk.PhotoImage(scaled_img)

            # Draw image
            self.canvas.create_image(
                self.offset_x,
                self.offset_y,
                image=self.map_photo,
                anchor=tk.NW,
                tags="map",
            )

            # Draw zones
            for zone in self.zones.values():
                self._draw_zone(zone)

            # Draw current zone being created
            if self.current_zone_vertices:
                self._draw_current_zone()

            # Draw tokens
            for token in self.tokens.values():
                self._draw_token(token)

            # Draw snap points
            for point in self.snap_points:
                self._draw_snap_point(point)

            # Рисуем находки (только в GM view)
            for find in self.finds.values():
                self._draw_find(find)

            # Draw grid
            self._draw_grid()
            self._draw_ruler()

            # Update scroll region
            self.canvas.config(
                scrollregion=(
                    self.offset_x,
                    self.offset_y,
                    self.offset_x + width,
                    self.offset_y + height,
                )
            )

        # Update player view if exists
        if hasattr(self, "player_view") and self.player_view:
            try:
                self.player_view.redraw_map()
            except:
                pass
        self._update_minimap()

    def _update_ui_layout(self):
        """Update UI element positions"""
        if hasattr(self, "minimap_frame"):
            self.minimap_frame.place(relx=1.0, rely=1.0, x=-10, y=-10, anchor=tk.SE)

    def _draw_find(self, find):
        """Отрисовать находку на карте"""
        # Если размер не задан, вычисляем его
        if find.size is None:
            find.size = self.get_token_size()

        x = find.position[0] * self.scale + self.offset_x
        y = find.position[1] * self.scale + self.offset_y

        # Основной круг
        self.canvas.create_oval(
            x - find.size // 2,
            y - find.size // 2,
            x + find.size // 2,
            y + find.size // 2,
            fill="white",
            outline="#888888",
            width=2,
            tags=("find", f"find_{find.id}"),
        )

        # Иконка "?" или "!" в зависимости от статуса
        symbol = "!" if find.status else "?"
        self.canvas.create_text(
            x,
            y,
            text=symbol,
            fill="#333333",
            font=("Segoe UI", 10, "bold"),
            tags=("find", f"find_{find.id}"),
        )

        # Название находки
        self.canvas.create_text(
            x,
            y - find.size // 2 - 10,
            text=find.name,
            fill="#333333",
            font=("Segoe UI", 8),
            tags=("find", f"find_{find.id}"),
        )

        # Подсветка если выбрана
        if hasattr(self, "selected_find") and self.selected_find == find.id:
            self.canvas.create_oval(
                x - find.size // 2 - 4,
                y - find.size // 2 - 4,
                x + find.size // 2 + 4,
                y + find.size // 2 + 4,
                outline=HIGHLIGHT_COLOR,
                width=2,
                tags=("find", f"find_{find.id}"),
            )

    def _draw_zone(self, zone):
        """Draw a zone on canvas"""
        fill_color = "#81C784" if zone.is_visible else "#E57373"  # Light green/red
        self.canvas.create_polygon(
            [
                (x * self.scale + self.offset_x, y * self.scale + self.offset_y)
                for x, y in zone.vertices
            ],
            fill=fill_color,
            outline="#424242",
            stipple="gray50" if not zone.is_visible else "",
            width=2,
            tags=("zone", f"zone_{zone.id}"),
        )

        # Draw zone name
        if zone.vertices:
            center_x = sum(x for x, y in zone.vertices) / len(zone.vertices)
            center_y = sum(y for x, y in zone.vertices) / len(zone.vertices)
            self.canvas.create_text(
                center_x * self.scale + self.offset_x,
                center_y * self.scale + self.offset_y,
                text=zone.name,
                fill="#212121",
                font=("Segoe UI", 10, "bold"),
                tags=("zone", f"zone_{zone.id}"),
            )

    def _draw_current_zone(self):
        """Draw zone being created"""
        if len(self.current_zone_vertices) >= 2:
            self.canvas.create_polygon(
                [
                    (x * self.scale + self.offset_x, y * self.scale + self.offset_y)
                    for x, y in self.current_zone_vertices
                ],
                outline=ACCENT_COLOR,
                fill="",
                width=2,
                dash=(5, 1),
                tags="zone_creation",
            )

    def _draw_token(self, token):
        """Draw token with modern styling"""
        x = token.position[0] * self.scale + self.offset_x
        y = token.position[1] * self.scale + self.offset_y
        token_size = self.get_token_size()

        # Determine colors based on token type
        if token.is_player:
            outline_color = "#4CAF50"  # Green
            fill_color = "#4CAF50"
        elif token.is_npc:
            outline_color = "#FFC107"  # Yellow
            fill_color = "#FFC107"
        else:  # Enemy
            outline_color = "#F44336"  # Red
            fill_color = "#F44336"

        # Dead tokens are gray
        if token.is_dead:
            fill_color = "#616161"
            outline_color = "#424242"

        # If avatar exists
        if token.avatar_image:
            # Create circular mask
            mask = Image.new("L", (token_size, token_size), 0)
            draw = ImageDraw.Draw(mask)
            draw.ellipse((0, 0, token_size, token_size), fill=255)

            # Apply mask
            avatar_img = Image.open(token.avatar_path).resize((token_size, token_size))
            avatar_img.putalpha(mask)
            rounded_avatar = ImageTk.PhotoImage(avatar_img)

            # Save reference
            if not hasattr(self, "_rounded_avatars"):
                self._rounded_avatars = {}
            self._rounded_avatars[token.id] = rounded_avatar

            # Draw avatar
            self.canvas.create_image(
                x,
                y,
                image=rounded_avatar,
                tags=("token", f"token_{token.id}"),
            )

            # Draw outline - hexagon for players, circle for others
            if token.is_player:
                self._draw_hexagon(
                    x,
                    y,
                    token_size // 2,
                    outline=outline_color,
                    fill="",
                    width=3,
                    tags=("token", f"token_{token.id}"),
                )
            else:
                self.canvas.create_oval(
                    x - token_size // 2,
                    y - token_size // 2,
                    x + token_size // 2,
                    y + token_size // 2,
                    outline=outline_color,
                    fill="",
                    width=3,
                    tags=("token", f"token_{token.id}"),
                )
        else:
            # Default token appearance
            if token.is_player:
                self._draw_hexagon(
                    x,
                    y,
                    token_size // 2,
                    outline=outline_color,
                    fill=fill_color,
                    width=2,
                    tags=("token", f"token_{token.id}"),
                )
            else:
                self.canvas.create_oval(
                    x - token_size // 2,
                    y - token_size // 2,
                    x + token_size // 2,
                    y + token_size // 2,
                    fill=fill_color,
                    outline=outline_color,
                    width=2,
                    tags=("token", f"token_{token.id}"),
                )

        # Token label
        text_color = "#212121"
        if token.is_dead:
            text_color = "#757575"

        self.canvas.create_text(
            x,
            y - token_size // 2 - 10,
            text=token.name,
            fill=text_color,
            font=("Segoe UI", 9),
            tags=("token", f"token_{token.id}"),
        )

        # Highlight selected token
        if token.id == self.selected_token:
            self.canvas.create_oval(
                x - token_size // 2 - 4,
                y - token_size // 2 - 4,
                x + token_size // 2 + 4,
                y + token_size // 2 + 4,
                outline=HIGHLIGHT_COLOR,
                width=2,
                tags=("token", f"token_{token.id}"),
            )

    def _draw_snap_point(self, point):
        """Draw snap point for zone creation"""
        x, y = point
        self.canvas.create_oval(
            x * self.scale + self.offset_x - 3,
            y * self.scale + self.offset_y - 3,
            x * self.scale + self.offset_x + 3,
            y * self.scale + self.offset_y + 3,
            fill=ACCENT_COLOR,
            outline=ACCENT_COLOR,
            tags="snap_point",
        )

    def add_find(self):
        """Добавить новую находку на карту"""
        if not self.map_image:
            messagebox.showwarning("Warning", "Пожалуйста, сначала загрузите карту!")
            return

        find_name = simpledialog.askstring("Находка", "Введите название находки:")
        if not find_name:
            return

        find_desc = simpledialog.askstring("Находка", "Введите описание находки:")

        # Размер находки - половина от размера токена
        find_size = self.get_token_size()

        # Создаем изображение для находки (белый круг)
        img = Image.new("RGBA", (find_size, find_size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.ellipse((0, 0, find_size, find_size), fill="white")
        find_photo = ImageTk.PhotoImage(img)

        find_id = f"find_{self.next_find_id}"
        self.next_find_id += 1

        # Позиция по центру карты
        center_x = self.map_image.width / 2
        center_y = self.map_image.height / 2

        # Создаем находку
        self.finds[find_id] = Find(
            id=find_id,
            name=find_name,
            image=find_photo,
            position=(center_x, center_y),
            size=find_size,  # Устанавливаем вычисленный размер
            description=find_desc,
        )

        self.update_status(f"Добавлена находка: {find_name}")
        self.redraw_map()

    def add_token(self, is_player=False, is_npc=False):
        """Add new token"""
        if not self.map_image:
            messagebox.showwarning("Warning", "Please load map first!")
            return

        token_type = "Игрок" if is_player else "НПС" if is_npc else "Враг"
        token_name = simpledialog.askstring("Персонаж", f"Введите имя {token_type}:")
        if not token_name:
            return

        # Create default token image
        size = self.get_token_size()
        img = Image.new("RGBA", (int(size), int(size)), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        if is_player:
            color = (76, 175, 80)  # Green
        elif is_npc:
            color = (255, 193, 7)  # Yellow
        else:
            color = (244, 67, 54)  # Red

        draw.ellipse((0, 0, size, size), fill=color)
        token_photo = ImageTk.PhotoImage(img)

        token_id = f"token_{self.next_token_id}"
        self.next_token_id += 1

        # Position at center of map
        center_x = self.map_image.width / 2
        center_y = self.map_image.height / 2

        # Create token
        self.tokens[token_id] = Token(
            id=token_id,
            name=token_name,
            image=token_photo,
            position=(center_x, center_y),
            is_player=is_player,
            is_npc=is_npc,
            is_dead=False,
        )

        # Offer to add avatar
        if messagebox.askyesno("Аватар", "Добавить иконку персонажу?"):
            self._load_avatar(token_id)

        # Add to list
        prefix = "[И] " if is_player else "[Н] " if is_npc else "[В] "
        self.tokens_list.insert(tk.END, f"{prefix}{token_name}")
        self.tokens_list.selection_clear(0, tk.END)
        self.tokens_list.selection_set(tk.END)
        self.selected_token = token_id

        self.redraw_map()
        self.update_status(f"Added {token_type} token: {token_name}")

    def start_zone_creation(self):
        """Start creating new zone"""
        if not self.map_image:
            messagebox.showwarning("Warning", "Please load map first!")
            return

        self.creating_zone = True
        self.current_zone_vertices = []
        self._update_snap_points()
        self.update_status("Creating zone: LMB to add points, RMB to finish")

    def _update_snap_points(self):
        """Update snap points from existing zones"""
        self.snap_points = []
        for zone in self.zones.values():
            self.snap_points.extend(zone.vertices)
        self.redraw_map()

    def _find_snap_point(self, x, y, threshold=10):
        """Find nearest snap point within threshold"""
        for px, py in self.snap_points:
            if math.sqrt((px - x) ** 2 + (py - y) ** 2) <= threshold / self.scale:
                return (px, py)
        return None

    def on_canvas_click(self, event):
        """Handle canvas click"""
        if self.ruler_active:
            x = (self.canvas.canvasx(event.x) - self.offset_x) / self.scale
            y = (self.canvas.canvasy(event.y) - self.offset_y) / self.scale

            if not self.ruler_start:
                self.ruler_start = (x, y)
            else:
                self.ruler_end = (x, y)
            self.redraw_map()
            return

        if self.creating_zone:
            # Convert to map coordinates
            x = (self.canvas.canvasx(event.x) - self.offset_x) / self.scale
            y = (self.canvas.canvasy(event.y) - self.offset_y) / self.scale

            # Try to snap to existing point
            snap_point = self._find_snap_point(x, y)
            if snap_point:
                x, y = snap_point

            self.current_zone_vertices.append((x, y))
            self._update_snap_points()
            return

        # Handle token selection
        canvas_x = self.canvas.canvasx(event.x)
        canvas_y = self.canvas.canvasy(event.y)

        self.selected_token = None
        for token_id, token in self.tokens.items():
            tx = token.position[0] * self.scale + self.offset_x
            ty = token.position[1] * self.scale + self.offset_y
            distance = math.sqrt((tx - canvas_x) ** 2 + (ty - canvas_y) ** 2)

            if distance <= token.size // 2:
                self.selected_token = token_id
                self.drag_start = (canvas_x, canvas_y)
                self.token_start_pos = token.position

                # Select in listbox
                for i in range(self.tokens_list.size()):
                    if self.tokens_list.get(i).endswith(token.name):
                        self.tokens_list.selection_clear(0, tk.END)
                        self.tokens_list.selection_set(i)
                        break
                break

        self.selected_find = None
        for find_id, find in self.finds.items():
            fx = find.position[0] * self.scale + self.offset_x
            fy = find.position[1] * self.scale + self.offset_y
            distance = math.sqrt((fx - canvas_x) ** 2 + (fy - canvas_y) ** 2)

            if distance <= find.size // 2:
                self.selected_find = find_id
                self.drag_start = (canvas_x, canvas_y)
                self.find_start_pos = find.position
                break

    def on_canvas_motion(self, event):
        """Handle mouse motion (for snap point highlighting)"""
        if self.creating_zone and self.current_zone_vertices:
            x = (self.canvas.canvasx(event.x) - self.offset_x) / self.scale
            y = (self.canvas.canvasy(event.y) - self.offset_y) / self.scale

            # Highlight nearest snap point
            snap_point = self._find_snap_point(x, y)
            if snap_point:
                self.canvas.delete("snap_highlight")
                self.canvas.create_oval(
                    snap_point[0] * self.scale + self.offset_x - 5,
                    snap_point[1] * self.scale + self.offset_y - 5,
                    snap_point[0] * self.scale + self.offset_x + 5,
                    snap_point[1] * self.scale + self.offset_y + 5,
                    outline="#FFEB3B",  # Yellow highlight
                    width=2,
                    tags="snap_highlight",
                )

    def on_canvas_drag(self, event):
        """Handle canvas dragging"""
        if self.ruler_active and self.ruler_start:
            x = (self.canvas.canvasx(event.x) - self.offset_x) / self.scale
            y = (self.canvas.canvasy(event.y) - self.offset_y) / self.scale
            self.ruler_end = (x, y)
            self.redraw_map()
            return

        if self.creating_zone:
            return

        canvas_x = self.canvas.canvasx(event.x)
        canvas_y = self.canvas.canvasy(event.y)

        if self.selected_token:
            # Move token
            if not hasattr(self, "drag_start"):
                self.drag_start = (canvas_x, canvas_y)
            if not hasattr(self, "token_start_pos"):
                self.token_start_pos = self.tokens[self.selected_token].position

            dx = (canvas_x - self.drag_start[0]) / self.scale
            dy = (canvas_y - self.drag_start[1]) / self.scale

            self.tokens[self.selected_token].position = (
                self.token_start_pos[0] + dx,
                self.token_start_pos[1] + dy,
            )
        elif self.selected_find:
            if not hasattr(self, "drag_start"):
                self.drag_start = (canvas_x, canvas_y)
            if not hasattr(self, "find_start_pos"):
                self.find_start_pos = self.finds[self.selected_find].position

            dx = (canvas_x - self.drag_start[0]) / self.scale
            dy = (canvas_y - self.drag_start[1]) / self.scale

            self.finds[self.selected_find].position = (
                self.find_start_pos[0] + dx,
                self.find_start_pos[1] + dy,
            )
        else:
            # Pan the map
            if not hasattr(self, "last_x"):
                self.last_x = event.x
                self.last_y = event.y

            dx = event.x - self.last_x
            dy = event.y - self.last_y

            self.offset_x += dx
            self.offset_y += dy

            self.last_x = event.x
            self.last_y = event.y

        if hasattr(self, "minimap_canvas"):
            self._update_minimap()

        self.redraw_map()

    def on_canvas_release(self, event):
        """Handle canvas release"""
        if hasattr(self, "last_x"):
            del self.last_x
        if hasattr(self, "last_y"):
            del self.last_y
        if hasattr(self, "drag_start"):
            del self.drag_start
        if hasattr(self, "token_start_pos"):
            del self.token_start_pos

        self.redraw_map()

    def on_right_click(self, event):
        """Handle right click - show context menu"""
        if self.creating_zone:
            self.finish_zone_creation()
            return

        # Convert to canvas coordinates
        canvas_x = self.canvas.canvasx(event.x)
        canvas_y = self.canvas.canvasy(event.y)

        # Check if clicked on a token
        clicked_token = None
        for token_id, token in self.tokens.items():
            tx = token.position[0] * self.scale + self.offset_x
            ty = token.position[1] * self.scale + self.offset_y
            distance = math.sqrt((tx - canvas_x) ** 2 + (ty - canvas_y) ** 2)

            if distance <= token.size // 2:
                clicked_token = token_id
                break

        # Check if clicked on a zone
        clicked_zone = None
        if not clicked_token and hasattr(self, "zones"):
            x = (canvas_x - self.offset_x) / self.scale
            y = (canvas_y - self.offset_y) / self.scale

            for zone_id, zone in self.zones.items():
                if self._point_in_polygon((x, y), zone.vertices):
                    clicked_zone = zone_id
                    break

        clicked_find = None
        if not clicked_token and not clicked_zone:
            canvas_x = self.canvas.canvasx(event.x)
            canvas_y = self.canvas.canvasy(event.y)

            for find_id, find in self.finds.items():
                fx = find.position[0] * self.scale + self.offset_x
                fy = find.position[1] * self.scale + self.offset_y
                distance = math.sqrt((fx - canvas_x) ** 2 + (fy - canvas_y) ** 2)

                if distance <= find.size // 2:
                    clicked_find = find_id
                    break

        # Show appropriate context menu
        if clicked_token:
            self.current_context_object = clicked_token
            self.selected_token = clicked_token
            try:
                self.token_context_menu.tk_popup(event.x_root, event.y_root)
            finally:
                self.token_context_menu.grab_release()
        elif clicked_zone:
            self.current_context_object = clicked_zone
            try:
                self.zone_context_menu.tk_popup(event.x_root, event.y_root)
            finally:
                self.zone_context_menu.grab_release()
        elif clicked_find:
            self.current_context_object = clicked_find
            self.selected_find = clicked_find
            try:
                self.find_context_menu.tk_popup(event.x_root, event.y_root)
            finally:
                self.find_context_menu.grab_release()

    def finish_zone_creation(self):
        """Finish creating zone"""
        if len(self.current_zone_vertices) < 3:
            messagebox.showwarning("Warning", "Zone must have at least 3 points!")
            return

        zone_name = simpledialog.askstring("Настройки зоны", "Введите название зоны:")
        if not zone_name:
            self.creating_zone = False
            self.current_zone_vertices = []
            self.snap_points = []
            self.redraw_map()
            return

        # Check if zone intersects with existing zones
        if self._zones_intersect(self.current_zone_vertices):
            messagebox.showwarning("Warning", "Zones cannot intersect!")
            return

        zone_id = f"zone_{self.next_zone_id}"
        self.next_zone_id += 1

        self.zones[zone_id] = Zone(
            id=zone_id,
            name=zone_name,
            vertices=self.current_zone_vertices,
        )

        self.zones_list.insert(tk.END, zone_name)
        self.creating_zone = False
        self.current_zone_vertices = []
        self._update_snap_points()

        self.update_status(f"Zone '{zone_name}' created")
        self.redraw_map()

    def _zones_intersect(self, new_vertices):
        """Check if new zone intersects with existing zones (with area overlap)"""
        if not self.zones:
            return False

        # Create path for new zone
        new_path = Path(np.array(new_vertices))

        for zone in self.zones.values():
            # Create path for existing zone
            existing_path = Path(np.array(zone.vertices))

            # Check if any point from new zone is inside existing zone
            for point in new_vertices:
                if existing_path.contains_point(point):
                    return True

            # Check if any point from existing zone is inside new zone
            for point in zone.vertices:
                if new_path.contains_point(point):
                    return True

            # Check if edges intersect
            for i in range(len(new_vertices)):
                p1 = new_vertices[i]
                p2 = new_vertices[(i + 1) % len(new_vertices)]

                for j in range(len(zone.vertices)):
                    p3 = zone.vertices[j]
                    p4 = zone.vertices[(j + 1) % len(zone.vertices)]

                    if self._segments_intersect(p1, p2, p3, p4):
                        return True

        return False

    @staticmethod
    def _segments_intersect(a1, a2, b1, b2):
        """Check if two line segments intersect"""

        def ccw(A, B, C):
            return (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0])

        return ccw(a1, b1, b2) != ccw(a2, b1, b2) and ccw(a1, a2, b1) != ccw(a1, a2, b2)

    @staticmethod
    def _point_in_polygon(point, polygon):
        """Ray casting algorithm to check if point is in polygon"""
        x, y = point
        n = len(polygon)
        inside = False
        p1x, p1y = polygon[0]
        for i in range(n + 1):
            p2x, p2y = polygon[i % n]
            if y > min(p1y, p2y):
                if y <= max(p1y, p2y):
                    if x <= max(p1x, p2x):
                        if p1y != p2y:
                            xinters = (y - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                        if p1x == p2x or x <= xinters:
                            inside = not inside
            p1x, p1y = p2x, p2y
        return inside

    def on_mouse_wheel(self, event):
        """Handle mouse wheel zoom"""
        x = self.canvas.canvasx(event.x)
        y = self.canvas.canvasy(event.y)

        map_x = (x - self.offset_x) / self.scale
        map_y = (y - self.offset_y) / self.scale

        if event.delta > 0:
            self.scale *= 1.1
        else:
            self.scale *= 0.9

        self.scale = max(0.1, min(5.0, self.scale))

        self.offset_x = x - map_x * self.scale
        self.offset_y = y - map_y * self.scale

        for token in self.tokens.values():
            token.size = self.get_token_size()

        for find in self.finds.values():
            find.size = self.get_token_size()

        self.redraw_map()
        self.update_status(f"Масштаб: {self.scale:.2f}x")
        self._update_ui_layout()

    def on_token_select(self, event):
        """Handle token selection from list"""
        selection = self.tokens_list.curselection()
        if selection:
            token_name = self.tokens_list.get(selection[0]).split("] ")[-1]
            for token_id, token in self.tokens.items():
                if token.name == token_name:
                    self.selected_token = token_id
                    self.redraw_map()
                    break

    def toggle_zone_visibility(self, event):
        """Toggle zone visibility"""
        selection = self.zones_list.curselection()
        if selection:
            zone_name = self.zones_list.get(selection[0])
            for zone in self.zones.values():
                if zone.name == zone_name:
                    zone.is_visible = not zone.is_visible
                    self.update_status(
                        f"Зона '{zone.name}' видимость: {zone.is_visible}"
                    )
                    self.redraw_map()
                    break

    def open_player_view(self):
        """Open player view window"""
        if not self.map_image:
            messagebox.showwarning("Warning", "Please load map first!")
            return

        try:
            if hasattr(self, "player_window") and self.player_window.winfo_exists():
                self.player_window.lift()
                return
        except:
            pass

        self.player_window = tk.Toplevel(self.root)
        self.player_window.title("D&D Map Master - Player View")
        self.player_window.configure(bg=DARK_BG)
        self.player_view = PlayerView(self.player_window, self)

        def on_close():
            if hasattr(self, "player_window"):
                try:
                    self.player_window.destroy()
                except:
                    pass
            self.player_window = None
            self.player_view = None

        self.player_window.protocol("WM_DELETE_WINDOW", on_close)
        self.update_status("Окно игрока открыто")

        if hasattr(self, "minimap_frame"):
            self._update_minimap()

    def _draw_grid(self):
        """Draw grid on canvas"""
        if not self.map_image or not self.grid_settings.visible:
            return

        width = self.map_image.width
        height = self.map_image.height

        # Calculate cell size in pixels
        cell_width = width / self.grid_settings.cell_size
        cell_height = cell_width  # Square cells

        # Calculate number of cells along height
        cell_count_height = int(height / cell_height)

        # Draw vertical lines
        for i in range(self.grid_settings.cell_size + 1):
            x = i * cell_width
            self.canvas.create_line(
                x * self.scale + self.offset_x,
                self.offset_y,
                x * self.scale + self.offset_x,
                height * self.scale + self.offset_y,
                fill=self.grid_settings.color,
                width=1,
                tags="grid",
            )

        # Draw horizontal lines
        for i in range(cell_count_height + 1):
            y = i * cell_height
            self.canvas.create_line(
                self.offset_x,
                y * self.scale + self.offset_y,
                width * self.scale + self.offset_x,
                y * self.scale + self.offset_y,
                fill=self.grid_settings.color,
                width=1,
                tags="grid",
            )

    def _draw_ruler(self):
        """Draw the ruler measurement on the canvas"""
        if not self.ruler_start or not self.ruler_end:
            return

        start_x = self.ruler_start[0] * self.scale + self.offset_x
        start_y = self.ruler_start[1] * self.scale + self.offset_y
        end_x = self.ruler_end[0] * self.scale + self.offset_x
        end_y = self.ruler_end[1] * self.scale + self.offset_y

        # Draw ruler line
        self.canvas.create_line(
            start_x,
            start_y,
            end_x,
            end_y,
            fill="#FF5252",  # Bright red
            width=2,
            arrow=tk.BOTH,
            tags="ruler",
        )

        # Calculate distance in feet (assuming 5ft per cell)
        if self.map_image and hasattr(self, "grid_settings"):
            cell_width_px = (
                self.map_image.width * self.scale
            ) / self.grid_settings.cell_size
            dx = (end_x - start_x) / cell_width_px
            dy = (end_y - start_y) / cell_width_px
            distance = math.sqrt(dx**2 + dy**2) * 5  # 5 feet per cell

            # Draw distance text
            self.canvas.create_text(
                (start_x + end_x) / 2,
                (start_y + end_y) / 2 - 15,
                text=f"{distance:.1f} ft",
                fill="#FF5252",
                font=("Segoe UI", 10, "bold"),
                tags="ruler",
            )


if __name__ == "__main__":
    root = tk.Tk()
    app = DnDMapMaster(root)
    root.mainloop()
