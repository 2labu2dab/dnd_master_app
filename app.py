import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
from PIL import Image, ImageTk, ImageDraw, ImageFilter
from dataclasses import dataclass
from typing import Dict, Tuple, List
import math
import numpy as np
from matplotlib.path import Path
import json
import base64
from io import BytesIO

# Modern color scheme
DARK_BG = "#1E1E2F"  # Темно-синий графит
DARKER_BG = "#161622"  # Ещё темнее для контрастных элементов
TEXT_COLOR = "#E0E0E0"  # Светло-серый текст
ACCENT_COLOR = "#4F8EF7"  # Яркий голубой акцент
BUTTON_BG = "#2A2E4A"  # Темно-синий фон кнопок
BUTTON_HOVER = "#3F499D"  # Светлый синий при наведении
SCROLLBAR_BG = "#2A2E4A"
SCROLLBAR_ACTIVE = "#4F8EF7"
LISTBOX_BG = "#222538"
LISTBOX_SELECTION = "#4F8EF7"
HIGHLIGHT_COLOR = "#6a9aff"
FONT = ("Segoe UI Semibold", 11)
FONT_MENU = ("Segoe UI Semibold", 10)


class YesNoDialog(tk.Toplevel):
    def __init__(
        self,
        parent,
        title,
        message,
        bg_color=LISTBOX_BG,
        fg_color="white",
        font=("Segoe UI", 12),
        button_style="Modern.TButton",
    ):
        super().__init__(parent)
        self.parent = parent
        self.result = None
        self.configure(bg=bg_color)
        self.title(title)
        self.resizable(False, False)
        self.grab_set()

        self.geometry(self._center_window(350, 130))

        lbl = tk.Label(
            self, text=message, bg=bg_color, fg=fg_color, font=font, wraplength=300
        )
        lbl.pack(padx=20, pady=20)

        btn_frame = tk.Frame(self, bg=bg_color)
        btn_frame.pack(pady=10)

        yes_btn = ttk.Button(
            btn_frame, text="Да", command=self._on_yes, style=button_style, width=10
        )
        yes_btn.pack(side=tk.LEFT, padx=10)

        no_btn = ttk.Button(
            btn_frame, text="Нет", command=self._on_no, style=button_style, width=10
        )
        no_btn.pack(side=tk.LEFT, padx=10)

    def _center_window(self, width, height):
        self.update_idletasks()
        x = self.parent.winfo_rootx() + (self.parent.winfo_width() // 2) - (width // 2)
        y = (
            self.parent.winfo_rooty()
            + (self.parent.winfo_height() // 2)
            - (height // 2)
        )
        return f"{width}x{height}+{x}+{y}"

    def _on_yes(self):
        self.result = True
        self.destroy()

    def _on_no(self):
        self.result = False
        self.destroy()

    def show(self):
        self.wait_window()
        return self.result


class AvatarLoadDialog(tk.Toplevel):
    def __init__(
        self,
        parent,
        token_size,
        on_avatar_loaded,
        bg_color=LISTBOX_BG,
        fg_color="white",
        font=FONT,
        button_style="Modern.TButton",
    ):
        super().__init__(parent)
        self.parent = parent
        self.token_size = token_size
        self.on_avatar_loaded = on_avatar_loaded  # callback с путем к файлу
        self.configure(bg=bg_color)
        self.title("Загрузка аватара")
        self.resizable(False, False)
        self.grab_set()

        self.geometry(self._center_window(400, 150))

        self.label = tk.Label(
            self,
            text="Выберите файл с изображением аватара:",
            bg=bg_color,
            fg=fg_color,
            font=font,
        )
        self.label.pack(padx=20, pady=15)

        buttons_frame = tk.Frame(self, bg=bg_color)
        buttons_frame.pack(pady=10)

        self.load_button = ttk.Button(
            buttons_frame,
            text="Выбрать файл",
            command=self.select_file,
            style=button_style,
            width=15,
        )
        self.load_button.pack(side=tk.LEFT, padx=10)

        self.cancel_button = ttk.Button(
            buttons_frame,
            text="Отмена",
            command=self.on_cancel,
            style=button_style,
            width=15,
        )
        self.cancel_button.pack(side=tk.LEFT, padx=10)

        self.selected_file = None

    def _center_window(self, width, height):
        self.update_idletasks()
        x = self.parent.winfo_rootx() + (self.parent.winfo_width() // 2) - (width // 2)
        y = (
            self.parent.winfo_rooty()
            + (self.parent.winfo_height() // 2)
            - (height // 2)
        )
        return f"{width}x{height}+{x}+{y}"

    def select_file(self):
        file_path = filedialog.askopenfilename(
            parent=self,
            title="Выберите изображение",
            filetypes=[("Image files", "*.png *.jpg *.jpeg *.gif")],
        )
        if file_path:
            self.selected_file = file_path
            self.on_avatar_loaded(file_path)
            self.destroy()

    def on_cancel(self):
        self.selected_file = None
        self.destroy()

    def show(self):
        self.wait_window()
        return self.selected_file


class TextInputDialog(tk.Toplevel):
    def __init__(
        self,
        parent,
        title,
        prompt,
        initialvalue="",
        bg_color=LISTBOX_BG,
        fg_color="white",
        font=FONT,
        button_style="Modern.TButton",
    ):
        super().__init__(parent)
        self.parent = parent
        self.title(title)
        self.configure(bg=bg_color)
        self.resizable(False, False)
        self.grab_set()

        self.result = None
        self.button_style = button_style

        # Центрируем окно
        self.transient(parent)
        self.geometry(self._center_window(350, 200))

        # Метка с вопросом
        self.label = tk.Label(self, text=prompt, bg=bg_color, fg=fg_color, font=font)
        self.label.pack(padx=20, pady=(20, 10))

        # Поле ввода
        self.entry_var = tk.StringVar(value=initialvalue)
        self.entry = tk.Entry(
            self, textvariable=self.entry_var, font=font, justify="left"
        )
        self.entry.pack(padx=20, pady=(0, 10), fill=tk.X)
        self.entry.focus_set()

        # Ошибка (если нужна)
        self.error_label = tk.Label(
            self, text="", bg=bg_color, fg="red", font=(font[0], 10)
        )
        self.error_label.pack(pady=(0, 10))

        # Кнопки
        buttons_frame = tk.Frame(self, bg=bg_color)
        buttons_frame.pack(pady=(0, 20))

        self.ok_button = ttk.Button(
            buttons_frame,
            text="OK",
            command=self.on_ok,
            style=self.button_style,
            width=10,
        )
        self.ok_button.pack(side=tk.LEFT, padx=10)

        self.cancel_button = ttk.Button(
            buttons_frame,
            text="Отмена",
            command=self.on_cancel,
            style=self.button_style,
            width=10,
        )
        self.cancel_button.pack(side=tk.LEFT, padx=10)

        # Горячие клавиши
        self.bind("<Return>", lambda event: self.on_ok())
        self.bind("<Escape>", lambda event: self.on_cancel())

    def _center_window(self, width, height):
        self.update_idletasks()
        x = self.parent.winfo_rootx() + (self.parent.winfo_width() // 2) - (width // 2)
        y = (
            self.parent.winfo_rooty()
            + (self.parent.winfo_height() // 2)
            - (height // 2)
        )
        return f"{width}x{height}+{x}+{y}"

    def on_ok(self):
        val = self.entry_var.get().strip()
        if not val:
            self.error_label.config(text="Пожалуйста, введите имя")
            return
        self.result = val
        self.destroy()

    def on_cancel(self):
        self.result = None
        self.destroy()

    def show(self):
        self.wait_window()
        return self.result


class IntegerInputDialog(tk.Toplevel):
    def __init__(
        self,
        parent,
        title,
        prompt,
        initialvalue=10,
        minvalue=1,
        maxvalue=200,
        bg_color="#222222",
        fg_color="white",
        font=FONT,
        button_style="Modern.TButton",
    ):
        super().__init__(parent)
        self.parent = parent
        self.title(title)
        self.configure(bg=bg_color)
        self.resizable(False, False)
        self.grab_set()  # Модальность

        self.minvalue = minvalue
        self.maxvalue = maxvalue
        self.result = None
        self.button_style = button_style

        # Центрирование окна
        self.transient(parent)
        self.geometry(self._center_window(300, 200))

        # Метка с вопросом
        self.label = tk.Label(self, text=prompt, bg=bg_color, fg=fg_color, font=font)
        self.label.pack(padx=20, pady=(20, 10))

        # Поле ввода
        self.entry_var = tk.StringVar(value=str(initialvalue))
        self.entry = tk.Entry(
            self, textvariable=self.entry_var, font=font, justify="center"
        )
        self.entry.pack(padx=20, pady=(0, 10))
        self.entry.focus_set()

        # Метка для ошибок
        self.error_label = tk.Label(
            self, text="", bg=bg_color, fg="red", font=(font[0], 10)
        )
        self.error_label.pack(pady=(0, 10))

        # Кнопки
        buttons_frame = tk.Frame(self, bg=bg_color)
        buttons_frame.pack(pady=(0, 20))

        self.ok_button = ttk.Button(
            buttons_frame,
            text="OK",
            command=self.on_ok,
            style=self.button_style,
            width=10,
        )
        self.ok_button.pack(side=tk.LEFT, padx=10)

        self.cancel_button = ttk.Button(
            buttons_frame,
            text="Отмена",
            command=self.on_cancel,
            style=self.button_style,
            width=10,
        )
        self.cancel_button.pack(side=tk.LEFT, padx=10)

        # Горячие клавиши
        self.bind("<Return>", lambda event: self.on_ok())
        self.bind("<Escape>", lambda event: self.on_cancel())

    def _center_window(self, width, height):
        self.update_idletasks()
        x = self.parent.winfo_rootx() + (self.parent.winfo_width() // 2) - (width // 2)
        y = (
            self.parent.winfo_rooty()
            + (self.parent.winfo_height() // 2)
            - (height // 2)
        )
        return f"{width}x{height}+{x}+{y}"

    def on_ok(self):
        try:
            val = int(self.entry_var.get())
            if val < self.minvalue or val > self.maxvalue:
                self.error_label.config(
                    text=f"Введите число от {self.minvalue} до {self.maxvalue}"
                )
                return
            self.result = val
            self.destroy()
        except ValueError:
            self.error_label.config(text="Пожалуйста, введите целое число")

    def on_cancel(self):
        self.result = None
        self.destroy()

    def show(self):
        self.wait_window()
        return self.result


class CustomCheckbutton(tk.Frame):
    def __init__(self, master, text="", variable=None, command=None, **kwargs):
        super().__init__(master, bg=DARK_BG, **kwargs)
        self.variable = variable or tk.BooleanVar()
        self.text = text
        self.command = command

        self.canvas = tk.Canvas(
            self, width=20, height=20, bg=DARK_BG, highlightthickness=0
        )
        self.label = tk.Label(
            self, text=self.text, bg=DARK_BG, fg=TEXT_COLOR, font=FONT
        )

        self.canvas.grid(row=0, column=0, sticky="ns")
        self.label.grid(row=0, column=1, sticky="w", padx=(10, 0))

        # Обработчик клика только на квадрате
        self.canvas.bind("<Button-1>", self.toggle)

        self.variable.trace_add("write", self.redraw)
        self.redraw()

    def toggle(self, event=None):
        current = self.variable.get()
        self.variable.set(not current)
        if self.command:
            self.command()

    def redraw(self, *args):
        self.canvas.delete("all")
        color = ACCENT_COLOR if self.variable.get() else "white"
        self.canvas.create_rectangle(
            2, 2, 18, 18, fill=color, outline=TEXT_COLOR, width=1
        )


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


@dataclass
class Find:
    id: str
    name: str
    image: ImageTk.PhotoImage
    position: Tuple[float, float]
    size: int = 50
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


class FindDescriptionDialog(tk.Toplevel):
    def __init__(self, parent, title, initialtext=""):
        super().__init__(parent)
        self.title(title)
        self.initialtext = initialtext
        self.geometry("500x700")
        self.resizable(True, True)
        self.configure(bg=DARK_BG)
        self.protocol("WM_DELETE_WINDOW", self.on_close)

        self.result = None

        # Текст описания
        ttk.Label(self, text="Описание находки:", style="TLabel").pack(pady=5)

        # Большое текстовое поле с прокруткой
        self.text_frame = ttk.Frame(self)
        self.text_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        self.text_scroll = ttk.Scrollbar(
            self.text_frame, orient=tk.VERTICAL, style="Modern.Vertical.TScrollbar"
        )
        self.text_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        self.text_area = tk.Text(
            self.text_frame,
            wrap=tk.WORD,
            yscrollcommand=self.text_scroll.set,
            bg=DARKER_BG,
            fg=TEXT_COLOR,
            insertbackground=TEXT_COLOR,
            font=FONT,
            padx=5,
            pady=5,
        )
        self.text_area.pack(fill=tk.BOTH, expand=True)
        self.text_scroll.config(command=self.text_area.yview)

        self.text_area.insert("1.0", initialtext)

        # Кнопки
        button_frame = ttk.Frame(self)
        button_frame.pack(pady=5)

        ttk.Button(
            button_frame, text="OK", command=self.on_ok, style="Modern.TButton"
        ).pack(side=tk.LEFT, padx=5)

        ttk.Button(
            button_frame, text="Отмена", command=self.on_cancel, style="Modern.TButton"
        ).pack(side=tk.LEFT, padx=5)

        self.transient(parent)
        self.grab_set()
        self.wait_window(self)

    def on_ok(self):
        self.result = self.text_area.get("1.0", tk.END).strip()
        self.destroy()

    def on_close(self):
        """Handle window close"""
        if self.text_area.get("1.0", tk.END).strip() != self.initialtext:
            self.on_ok()
        else:
            self.destroy()

    def on_cancel(self):
        self.destroy()


class PlayerView:
    def __init__(self, root, master_app):
        self.root = root
        self.master = master_app
        self.root.configure(bg=DARK_BG)
        self.get_token_size = master_app.get_token_size

        # Canvas с современным стилем
        self.canvas = tk.Canvas(
            root,
            bg=DARKER_BG,
            highlightthickness=0,
            borderwidth=0,
            relief=tk.FLAT,
        )
        self.canvas.pack(fill=tk.BOTH, expand=True)

        # Современные скроллбары
        self.h_scroll = ttk.Scrollbar(
            root, orient=tk.HORIZONTAL, style="Modern.Horizontal.TScrollbar"
        )
        self.v_scroll = ttk.Scrollbar(
            root, orient=tk.VERTICAL, style="Modern.Vertical.TScrollbar"
        )

        self.h_scroll.pack(side=tk.BOTTOM, fill=tk.X)
        self.v_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        self.canvas.config(
            xscrollcommand=self.h_scroll.set,
            yscrollcommand=self.v_scroll.set,
        )
        self.h_scroll.config(command=self.canvas.xview)
        self.v_scroll.config(command=self.canvas.yview)

        # Цвета и стили для токенов
        self.fog_color = (0, 0, 0, 200)
        self.fog_opacity = 0.8
        self.player_outline = "#4CAF50"  # Green
        self.npc_outline = "#FFC107"  # Yellow
        self.enemy_outline = "#F44336"  # Red

        # Смещение для центрирования (пересчитывается динамически)
        self.offset_x = 0
        self.offset_y = 0

        # Привязка к изменению размера окна
        self.root.bind("<Configure>", self._on_root_resize)

        self.redraw_map()

    def _on_root_resize(self, event):
        # При изменении размера окна перерисовываем карту с новым центрированием
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

        if not hasattr(self.master, "map_image") or not self.master.map_image:
            return

        # Вычисляем размеры карты с учётом масштаба
        map_width = int(self.master.map_image.width * self.master.scale)
        map_height = int(self.master.map_image.height * self.master.scale)

        # Получаем размеры окна
        window_width = self.root.winfo_width()
        window_height = self.root.winfo_height()

        # Центрируем карту в окне (смещение)
        self.offset_x = max((window_width - map_width) // 2, 0)
        self.offset_y = max((window_height - map_height) // 2, 0)

        # Создаем масштабированное изображение карты
        base_map = self.master.map_image.resize(
            (map_width, map_height), Image.Resampling.LANCZOS
        )

        # Размытая копия карты для закрытых зон
        blurred_map = base_map.filter(ImageFilter.GaussianBlur(radius=20))

        # Маска закрытых зон
        closed_zones_mask = Image.new("L", (map_width, map_height), 0)
        draw = ImageDraw.Draw(closed_zones_mask)

        if hasattr(self.master, "zones") and self.master.zones:
            for zone in self.master.zones.values():
                if not zone.is_visible:  # закрытая зона
                    scaled_vertices = [
                        (x * self.master.scale, y * self.master.scale)
                        for x, y in zone.vertices
                    ]
                    if len(scaled_vertices) >= 3:
                        draw.polygon(scaled_vertices, fill=255)

        # Комбинируем размытый фон и чёткий с маской
        combined = Image.composite(blurred_map, base_map, closed_zones_mask)

        # Добавляем сетку, если включена и видна игрокам
        if (
            hasattr(self.master, "grid_settings")
            and self.master.grid_settings.visible_to_players
        ):
            grid_img = Image.new("RGBA", (map_width, map_height), (0, 0, 0, 0))
            draw_grid = ImageDraw.Draw(grid_img)

            cell_width = map_width / self.master.grid_settings.cell_size
            cell_count_height = int(map_height / cell_width)

            for i in range(self.master.grid_settings.cell_size + 1):
                x = i * cell_width
                draw_grid.line(
                    [(x, 0), (x, map_height)], fill=self.master.grid_settings.color
                )

            for i in range(cell_count_height + 1):
                y = i * cell_width
                draw_grid.line(
                    [(0, y), (map_width, y)], fill=self.master.grid_settings.color
                )

            grid_img.putalpha(self.master.grid_settings.opacity)
            combined = Image.alpha_composite(combined.convert("RGBA"), grid_img)

        # Отображение карты на холсте
        photo = ImageTk.PhotoImage(combined)
        self.canvas.create_image(
            self.offset_x,
            self.offset_y,
            image=photo,
            anchor=tk.NW,
            tags="map",
        )
        self.canvas.image = photo  # Чтобы избежать сборки мусора

        # Рисуем линейку, если активна и видна игрокам
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
            start_x = self.master.ruler_start[0] * self.master.scale + self.offset_x
            start_y = self.master.ruler_start[1] * self.master.scale + self.offset_y
            end_x = self.master.ruler_end[0] * self.master.scale + self.offset_x
            end_y = self.master.ruler_end[1] * self.master.scale + self.offset_y

            self.canvas.delete("ruler")

            self.canvas.create_line(
                start_x,
                start_y,
                end_x,
                end_y,
                fill="#FF5252",
                width=4,
                dash=(5, 3),
                arrow="last",
                tags="ruler",
            )

            cell_width_px = (
                self.master.map_image.width * self.master.scale
            ) / self.master.grid_settings.cell_size
            dx = (end_x - start_x) / cell_width_px
            dy = (end_y - start_y) / cell_width_px
            distance = math.sqrt(dx**2 + dy**2) * 5

            distance_text = f"{distance:.1f} ft"
            text_x = (start_x + end_x) / 2
            text_y = (start_y + end_y) / 2 - 15
            font = FONT

            temp_text = self.canvas.create_text(
                text_x, text_y, text=distance_text, font=font
            )
            bbox = self.canvas.bbox(temp_text)
            self.canvas.delete(temp_text)

            padding = 4
            rect_x1 = bbox[0] - padding
            rect_y1 = bbox[1] - padding
            rect_x2 = bbox[2] + padding
            rect_y2 = bbox[3] + padding

            self.canvas.create_rectangle(
                rect_x1,
                rect_y1,
                rect_x2,
                rect_y2,
                fill="#222222",
                outline="",
                tags="ruler",
            )

            offset = 1
            self.canvas.create_text(
                text_x + offset,
                text_y + offset,
                text=distance_text,
                fill="#000000",
                font=font,
                tags="ruler",
            )

            self.canvas.create_text(
                text_x,
                text_y,
                text=distance_text,
                fill="#FF5252",
                font=font,
                tags="ruler",
            )

        # Рисуем токены
        if hasattr(self.master, "tokens"):
            for token in self.master.tokens.values():
                if self._is_token_visible(token):
                    self._draw_token(token)

        # Обновляем scrollregion для прокрутки
        self.canvas.config(
            scrollregion=(
                0,
                0,
                max(window_width, map_width),
                max(window_height, map_height),
            )
        )

    def _is_token_visible(self, token):
        """Проверка видимости токена для игроков"""
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
        """Проверка, находится ли точка внутри многоугольника"""
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
        """Рисуем токен с современным стилем"""
        x = token.position[0] * self.master.scale + self.offset_x
        y = token.position[1] * self.master.scale + self.offset_y
        token_size = self.get_token_size()

        if token.is_player:
            outline_color = self.player_outline
            fill_color = "#4CAF50"
        elif token.is_npc:
            outline_color = self.npc_outline
            fill_color = "#FFC107"
        else:
            outline_color = self.enemy_outline
            fill_color = "#F44336"

        if token.is_dead:
            fill_color = "#616161"
            outline_color = "#424242"

        if hasattr(token, "avatar_image") and token.avatar_image:
            mask = Image.new("L", (int(token_size), int(token_size)), 0)
            draw = ImageDraw.Draw(mask)
            draw.ellipse((0, 0, token_size, token_size), fill=255)

            avatar_img = Image.open(token.avatar_path).resize(
                (int(token_size), int(token_size)), Image.Resampling.LANCZOS
            )
            avatar_img.putalpha(mask)
            rounded_avatar = ImageTk.PhotoImage(avatar_img)

            if not hasattr(self, "_rounded_avatars"):
                self._rounded_avatars = {}
            self._rounded_avatars[token.id] = rounded_avatar

            self.canvas.create_image(
                x, y, image=rounded_avatar, tags=("token", f"token_{token.id}")
            )

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

        text_color = TEXT_COLOR
        if token.is_dead:
            text_color = "#9E9E9E"

        x_text = x
        y_text = y + token_size // 2 + 10
        text = token.name
        font = FONT
        main_color = text_color
        shadow_color = "#000000"

        # Черная тень текста (буфер)
        self.canvas.create_text(
            x_text + 1,
            y_text + 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("token", f"token_{token.id}"),
        )
        self.canvas.create_text(
            x_text - 1,
            y_text + 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("token", f"token_{token.id}"),
        )
        self.canvas.create_text(
            x_text + 1,
            y_text - 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("token", f"token_{token.id}"),
        )
        self.canvas.create_text(
            x_text - 1,
            y_text - 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("token", f"token_{token.id}"),
        )

        self.canvas.create_text(
            x_text,
            y_text,
            text=text,
            fill=main_color,
            font=font,
            tags=("token", f"token_{token.id}"),
        )


class DnDMapMaster:
    def __init__(self, root):
        self.root = root
        self.root.title("D&D Map Master - Game Master View")
        self.root.geometry("1200x800")
        self.root.configure(bg=DARK_BG)
        self.image_cache = {}
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
        self.ruler_line = None  # объект линии, который будет рисоваться
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
        """Configure ttk styles for a modern stylish look"""
        style = ttk.Style()
        style.theme_use("clam")

        # Общий фон и цвет текста
        style.configure(".", background=DARK_BG, foreground=TEXT_COLOR, font=FONT)

        # Frame
        style.configure("TFrame", background=DARK_BG)

        # Labels
        style.configure("TLabel", background=DARK_BG, foreground=TEXT_COLOR, font=FONT)

        # Кнопки с акцентом и плавным изменением цвета
        style.configure(
            "Modern.TButton",
            background=BUTTON_BG,
            foreground=TEXT_COLOR,
            borderwidth=0,
            focusthickness=3,
            focuscolor="",
            font=FONT,
            padding=8,
            relief=tk.FLAT,
        )
        style.map(
            "Modern.TButton",
            background=[("active", BUTTON_HOVER), ("pressed", ACCENT_COLOR)],
            foreground=[("active", TEXT_COLOR), ("pressed", TEXT_COLOR)],
        )

        # === Стили для слайдера ===
        # Для горизонтального слайдера
        style.configure(
            "Modern.Horizontal.TScale",
            background=DARK_BG,
            troughcolor=SCROLLBAR_BG,  # Цвет фона слайдера
            sliderlength=20,  # Длина ползунка
            sliderrelief="flat",  # Без обводки у ползунка
            width=15,  # Ширина слайдера
            orient="horizontal",  # Горизонтальная ориентация
        )

        # Для вертикального слайдера
        style.configure(
            "Modern.Vertical.TScale",
            background=DARK_BG,
            troughcolor=SCROLLBAR_BG,  # Цвет фона слайдера
            sliderlength=20,  # Длина ползунка
            sliderrelief="flat",  # Без обводки у ползунка
            width=15,  # Ширина слайдера
            orient="vertical",  # Вертикальная ориентация
        )

        # Настройка слайдера: цвета при активации
        style.map(
            "Modern.TScale",
            background=[
                ("active", ACCENT_COLOR),
                ("!active", BUTTON_BG),
            ],  # Цвет при активации
            slidercolor=[
                ("active", ACCENT_COLOR),
                ("!active", "#6a9aff"),
            ],  # Цвет ползунка
        )

        # === Стили для других элементов ===

        # Стили для Scrollbars
        style.element_create("Custom.Vertical.Scrollbar.trough", "from", "clam")
        style.element_create("Custom.Vertical.Scrollbar.thumb", "from", "clam")

        style.layout(
            "Modern.Vertical.TScrollbar",
            [
                (
                    "Vertical.Scrollbar.trough",
                    {
                        "children": [
                            (
                                "Vertical.Scrollbar.thumb",
                                {"unit": "1", "sticky": "nswe"},
                            )
                        ],
                        "sticky": "ns",
                    },
                )
            ],
        )
        style.layout(
            "Modern.Horizontal.TScrollbar",
            [
                (
                    "Horizontal.Scrollbar.trough",
                    {
                        "children": [
                            (
                                "Horizontal.Scrollbar.thumb",
                                {"unit": "1", "sticky": "nswe"},
                            )
                        ],
                        "sticky": "we",
                    },
                )
            ],
        )

        # Цвет thumb — чуть светлее трека, для контраста
        def lighten_color(hex_color, amount=0.15):
            # простая функция для осветления цвета
            hex_color = hex_color.lstrip("#")
            rgb = tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))
            lightened = tuple(min(255, int(c + (255 - c) * amount)) for c in rgb)
            return "#{:02x}{:02x}{:02x}".format(*lightened)

        thumb_color = lighten_color(SCROLLBAR_BG, 0.2)  # светлее на 20%

        style.configure(
            "Modern.Vertical.TScrollbar",
            background=thumb_color,  # Thumb
            troughcolor=SCROLLBAR_BG,  # Track
            bordercolor=SCROLLBAR_BG,
            arrowcolor=SCROLLBAR_BG,  # Скрываем стрелки
            lightcolor=SCROLLBAR_BG,
            darkcolor=SCROLLBAR_BG,
            width=6,
            relief="flat",
        )

        style.configure(
            "Modern.Horizontal.TScrollbar",
            background=thumb_color,
            troughcolor=SCROLLBAR_BG,
            bordercolor=SCROLLBAR_BG,
            arrowcolor=SCROLLBAR_BG,
            lightcolor=SCROLLBAR_BG,
            darkcolor=SCROLLBAR_BG,
            width=6,
            relief="flat",
        )

        style.map(
            "Modern.Vertical.TScrollbar",
            background=[
                ("active", BUTTON_HOVER),  # При активности акцентный цвет
                ("!active", thumb_color),
            ],
        )
        style.map(
            "Modern.Horizontal.TScrollbar",
            background=[("active", BUTTON_HOVER), ("!active", thumb_color)],
        )

        # Listbox (через option_add)
        self.root.option_add("*Listbox*Background", LISTBOX_BG)
        self.root.option_add("*Listbox*Foreground", TEXT_COLOR)
        self.root.option_add("*Listbox*selectBackground", LISTBOX_SELECTION)
        self.root.option_add("*Listbox*selectForeground", TEXT_COLOR)
        self.root.option_add("*Listbox*font", ("Segoe UI Semibold", 10))

        # Entry и Combobox
        style.configure(
            "TEntry",
            fieldbackground=DARKER_BG,
            foreground=TEXT_COLOR,
            insertcolor=TEXT_COLOR,
            borderwidth=1,
            relief=tk.FLAT,
            padding=5,
            font=FONT,
        )
        style.configure(
            "TCombobox",
            fieldbackground=DARKER_BG,
            foreground=TEXT_COLOR,
            selectbackground=ACCENT_COLOR,
            selectforeground=TEXT_COLOR,
            font=FONT,
        )

        # Notebook (если понадобится)
        style.configure("TNotebook", background=DARK_BG)
        style.configure(
            "TNotebook.Tab",
            background=DARKER_BG,
            foreground=TEXT_COLOR,
            padding=[12, 6],
            font=FONT,
            borderwidth=0,
        )
        style.map(
            "TNotebook.Tab",
            background=[("selected", ACCENT_COLOR)],
            foreground=[("selected", TEXT_COLOR)],
        )

        # Checkbutton как переключатель с акцентом и плавным фоном
        style.configure(
            "Modern.TCheckbutton",
            background=DARK_BG,
            foreground=TEXT_COLOR,
            font=FONT,
            padding=(10, 5, 5, 5),
            indicatorbackground="white",
            indicatorcolor="white",  # совпадает с фоном квадрата, чтобы скрыть крестик
            indicatorsize=18,
            relief=tk.FLAT,
        )

        style.map(
            "Modern.TCheckbutton",
            background=[
                ("active", BUTTON_HOVER),
                ("!selected", DARK_BG),
                ("selected", DARK_BG),
            ],
            indicatorbackground=[("selected", ACCENT_COLOR), ("!selected", "white")],
            indicatorcolor=[("selected", ACCENT_COLOR), ("!selected", "white")],
            foreground=[("active", TEXT_COLOR), ("selected", TEXT_COLOR)],
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
        dialog = IntegerInputDialog(
            self.root,
            title="Настройки сетки",
            prompt="Введите размер сетки:",
            initialvalue=self.grid_settings.cell_size,
            minvalue=1,
            maxvalue=200,
            bg_color=DARK_BG,
            fg_color=TEXT_COLOR,
        )
        count = dialog.show()
        if count is not None:
            self.grid_settings.cell_size = count
            for token in self.tokens.values():
                token.size = self.get_token_size()
            for find in self.finds.values():
                find.size = self.get_token_size()
            self.redraw_map()
            self.update_status(f"Set grid to {count} cells wide")

    def toggle_ruler(self):
        """Включить/выключить линейку"""
        self.ruler_active = self.ruler_var.get()
        if not self.ruler_active:
            # Если линейка выключена, сбрасываем точки
            self.ruler_start = None
            self.ruler_end = None
        self.redraw_map()  # Перерисовываем карту для обновления состояния

    def _create_styled_menu(self):
        return tk.Menu(
            self.root,
            tearoff=0,
            bg=DARKER_BG,
            fg=TEXT_COLOR,
            activebackground=ACCENT_COLOR,
            activeforeground=TEXT_COLOR,
            bd=1,
            relief=tk.FLAT,
            font=FONT_MENU,  # зададим шрифт, как везде
        )

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
            label="Скрыть/Показать зону", command=self._toggle_zone_visibility
        )
        self.zone_context_menu.add_separator()
        self.zone_context_menu.add_command(
            label="Удалить зону", command=self._delete_selected_zone
        )

        # Find context menu
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
        self.find_context_menu.add_command(
            label="Просмотреть описание", command=self._view_find_description
        )
        self.find_context_menu.add_separator()
        self.find_context_menu.add_command(
            label="Удалить находку", command=self._delete_find
        )

    def _show_zone_context_menu(self, event, zone_id):
        self.current_context_object = zone_id
        zone = self.zones.get(zone_id)
        if zone:
            label = "Спрятать зону" if zone.is_visible else "Открыть зону"
            self.zone_context_menu.entryconfig(
                1, label=label
            )  # индекс 1 — пункт со статусом
            self.zone_context_menu.tk_popup(event.x_root, event.y_root)

    def _view_find_description(self):
        """Просмотр описания находки"""
        if not hasattr(self, "selected_find"):
            return

        find = self.finds[self.selected_find]
        FindDescriptionDialog(
            self.root, f"Описание находки: {find.name}", find.description or ""
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

        # Используем новый диалог с текущим описанием
        desc_dialog = FindDescriptionDialog(
            self.root, f"Описание находки: {find.name}", find.description or ""
        )

        if desc_dialog.result is not None:
            find.description = desc_dialog.result
            self.update_status(f"Обновлено описание для {find.name}")
            self.redraw_map()

    def _delete_find(self):
        """Удалить выбранную находку"""
        if not hasattr(self, "selected_find"):
            return

        find = self.finds[self.selected_find]
        dialog = YesNoDialog(
            self.root, "Подтверждение", f"Удалить находку {find.name}?"
        )
        if dialog.show():
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
        dialog = YesNoDialog(self.root, "Confirm", f"Удалить токен {token.name}?")
        if dialog.show():
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
        dialog = YesNoDialog(self.root, "Confirm", f"Удалить зону {zone.name}?")
        if dialog.show():
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
        dialog = TextInputDialog(self.root, "Зона", "Введите новое имя зоны")
        new_name = dialog.show()
        if new_name and new_name != zone.name:
            zone.name = new_name
            self._update_zones_list()
            self.redraw_map()
            self.update_status(f"Zone renamed to {new_name}")

    def _toggle_zone_visibility(self):
        """Toggle visibility of the selected zone"""
        if (
            not self.current_context_object
            or self.current_context_object not in self.zones
        ):
            return

        zone = self.zones[self.current_context_object]
        zone.is_visible = not zone.is_visible
        self.redraw_map()

        status = "открыта" if zone.is_visible else "спрятана"
        self.update_status(f"Зона {zone.name} теперь {status}")

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
        if not self.map_image:
            return

        # Размер миникарты
        minimap_img = Image.new(
            "RGBA", (self.minimap_size, self.minimap_size), (0, 0, 0, 0)
        )

        map_width, map_height = self.map_image.size
        scale = min(self.minimap_size / map_width, self.minimap_size / map_height)
        scaled_width = int(map_width * scale)
        scaled_height = int(map_height * scale)

        paste_x = (self.minimap_size - scaled_width) // 2
        paste_y = (self.minimap_size - scaled_height) // 2

        # Масштабируем карту
        map_img = self.map_image.resize(
            (scaled_width, scaled_height), Image.Resampling.LANCZOS
        )
        # Убедимся, что в RGBA
        map_img = map_img.convert("RGBA")

        # Создаем размытое изображение для блюра закрытых зон
        blurred_map_img = map_img.filter(ImageFilter.GaussianBlur(radius=8))

        # Создаем изображение с прозрачным фоном для full size с размерами minimap
        full_blurred = Image.new(
            "RGBA", (self.minimap_size, self.minimap_size), (0, 0, 0, 0)
        )
        # Вставляем размытое изображение в центр
        full_blurred.paste(blurred_map_img, (paste_x, paste_y))

        # Аналогично создаём полный minimap_img с масштабированной картой
        full_minimap = Image.new(
            "RGBA", (self.minimap_size, self.minimap_size), (0, 0, 0, 0)
        )
        full_minimap.paste(map_img, (paste_x, paste_y))

        # Создаём маску в режиме L и нужного размера
        mask = Image.new("L", (self.minimap_size, self.minimap_size), 0)
        draw_mask = ImageDraw.Draw(mask)

        if hasattr(self, "zones"):
            for zone in self.zones.values():
                if not zone.is_visible:
                    scaled_vertices = [
                        (x * scale + paste_x, y * scale + paste_y)
                        for x, y in zone.vertices
                    ]
                    if len(scaled_vertices) >= 3:
                        draw_mask.polygon(scaled_vertices, fill=255)

        # Теперь композитим: там, где маска белая — будет блюр, иначе — оригинал
        minimap_img = Image.composite(full_blurred, full_minimap, mask)

        # Рисуем токены на minimap_img
        draw = ImageDraw.Draw(minimap_img)

        if hasattr(self, "grid_settings") and self.grid_settings.cell_size > 0:
            cell_size_minimap = int(scaled_width / self.grid_settings.cell_size)
        else:
            cell_size_minimap = 5

        if hasattr(self, "tokens"):
            for token in self.tokens.values():
                if self._is_token_visible_in_minimap(token):
                    x = token.position[0] * scale + paste_x
                    y = token.position[1] * scale + paste_y
                    size = max(2, cell_size_minimap / 2)

                    if token.is_player:
                        fill = (76, 175, 80)
                        outline = (56, 142, 60)
                    elif token.is_npc:
                        fill = (255, 193, 7)
                        outline = (230, 174, 0)
                    else:
                        fill = (244, 67, 54)
                        outline = (198, 40, 40)

                    if token.is_dead:
                        fill = (97, 97, 97)
                        outline = (66, 66, 66)

                    draw.ellipse(
                        [x - size - 1, y - size - 1, x + size + 1, y + size + 1],
                        fill=outline,
                    )
                    draw.ellipse([x - size, y - size, x + size, y + size], fill=fill)

        self.player_view_minimap = ImageTk.PhotoImage(minimap_img)
        self.minimap_canvas.create_image(
            0, 0, image=self.player_view_minimap, anchor=tk.NW
        )
        self.minimap_canvas.image = self.player_view_minimap

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
        """Create UI widgets with modern stylish design"""
        self.main_frame = ttk.Frame(self.root, style="TFrame")
        self.main_frame.pack(fill=tk.BOTH, expand=True)

        # === Левая панель через Canvas с вертикальным Scrollbar ===
        self.sidebar_canvas = tk.Canvas(
            self.main_frame,
            bg=DARK_BG,
            highlightthickness=0,
            bd=0,
            width=270,  # 🟢 Здесь уменьшаем ширину
        )
        self.sidebar_canvas.pack(side=tk.LEFT, fill=tk.Y, padx=(10, 0), pady=10)

        self.sidebar_scrollbar = ttk.Scrollbar(
            self.main_frame,
            orient=tk.VERTICAL,
            command=self.sidebar_canvas.yview,
            style="Modern.Vertical.TScrollbar",
        )
        self.sidebar_scrollbar.pack(side=tk.LEFT, fill=tk.Y, pady=10)

        self.sidebar_canvas.configure(yscrollcommand=self.sidebar_scrollbar.set)

        # Контейнер внутри Canvas
        self.control_panel = ttk.Frame(self.sidebar_canvas, style="TFrame", width=270)
        self.canvas_window = self.sidebar_canvas.create_window(
            (0, 0), window=self.control_panel, anchor="nw"
        )

        # Автоматическое обновление scrollregion
        def _on_frame_configure(event):
            self.sidebar_canvas.configure(scrollregion=self.sidebar_canvas.bbox("all"))

        self.control_panel.bind("<Configure>", _on_frame_configure)

        # === Правая часть — холст с миникартой ===
        self.canvas_frame = ttk.Frame(self.main_frame, style="TFrame")
        self.canvas_frame.pack(
            side=tk.RIGHT, fill=tk.BOTH, expand=True, padx=10, pady=10
        )

        self.h_scroll = ttk.Scrollbar(
            self.canvas_frame,
            orient=tk.HORIZONTAL,
            style="Modern.Horizontal.TScrollbar",
        )
        self.v_scroll = ttk.Scrollbar(
            self.canvas_frame, orient=tk.VERTICAL, style="Modern.Vertical.TScrollbar"
        )

        self.canvas = tk.Canvas(
            self.canvas_frame,
            bg=DARKER_BG,
            highlightthickness=0,
            xscrollcommand=self.h_scroll.set,
            yscrollcommand=self.v_scroll.set,
            bd=0,
            relief=tk.FLAT,
        )

        self.h_scroll.pack(side=tk.BOTTOM, fill=tk.X)
        self.v_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.h_scroll.config(command=self.canvas.xview)
        self.v_scroll.config(command=self.canvas.yview)

        # === Контент в control_panel ===

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
                self.control_panel, text=text, command=command, style="Modern.TButton"
            )
            btn.pack(pady=8, padx=10, fill=tk.X)

        ttk.Separator(self.control_panel, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=15)

        self.grid_slider = ttk.Scale(
            self.control_panel,
            from_=1,
            to=200,
            orient="horizontal",
            command=self.update_grid_from_slider,
            style="Modern.Horizontal.TScale",
        )
        self.grid_slider.set(
            self.grid_settings.cell_size
        )  # Устанавливаем начальный размер
        self.grid_slider.pack(pady=8, padx=10, fill=tk.X)

        # Поле для ввода размера сетки
        self.grid_entry = ttk.Entry(
            self.control_panel,
            validate="key",
            validatecommand=(
                self.control_panel.register(self.on_grid_entry_change),
                "%P",
            ),
            font=FONT,
        )
        self.grid_entry.insert(
            0, str(self.grid_settings.cell_size)
        )  # Значение по умолчанию
        self.grid_entry.pack(pady=8, padx=10, fill=tk.X)

        # Рисование сетки и обновление
        self.update_grid_from_slider(
            self.grid_slider.get()
        )  # Перерисовываем сетку при старте

        self.grid_var = tk.BooleanVar(value=self.grid_settings.visible)
        grid_check = CustomCheckbutton(
            self.control_panel,
            text="Показать сетку",
            variable=self.grid_var,
            command=self.toggle_grid,
        )
        grid_check.pack(pady=8, padx=10, fill=tk.X)

        self.grid_player_var = tk.BooleanVar(
            value=self.grid_settings.visible_to_players
        )
        grid_player_check = CustomCheckbutton(
            self.control_panel,
            text="Показать сетку для игроков",
            variable=self.grid_player_var,
            command=self.toggle_grid_for_players,
        )
        grid_player_check.pack(pady=8, padx=10, fill=tk.X)

        self.ruler_var = tk.BooleanVar(value=self.ruler_active)
        self.ruler_check = CustomCheckbutton(
            self.control_panel,
            text="Линейка",
            variable=self.ruler_var,
            command=self.toggle_ruler,
        )
        self.ruler_check.pack(pady=8, padx=10, fill=tk.X)

        ttk.Separator(self.control_panel, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=15)

        ttk.Button(
            self.control_panel,
            text="Экспорт настроек карты",
            command=self.export_settings,
            style="Modern.TButton",
        ).pack(pady=8, padx=10, fill=tk.X)

        ttk.Button(
            self.control_panel,
            text="Импорт настроек карты",
            command=self.import_settings,
            style="Modern.TButton",
        ).pack(pady=8, padx=10, fill=tk.X)

        ttk.Separator(self.control_panel, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=15)

        self.tokens_frame = ttk.LabelFrame(
            self.control_panel, text="Персонажи", style="TFrame"
        )
        self.tokens_frame.pack(pady=5, padx=10, fill=tk.BOTH, expand=True)

        self.tokens_list = tk.Listbox(
            self.tokens_frame,
            bg=LISTBOX_BG,
            fg=TEXT_COLOR,
            selectbackground=LISTBOX_SELECTION,
            selectforeground=TEXT_COLOR,
            highlightthickness=0,
            relief=tk.FLAT,
            font=FONT,
        )
        self.tokens_list.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.tokens_list.bind("<<ListboxSelect>>", self.on_token_select)

        self.zones_frame = ttk.LabelFrame(
            self.control_panel, text="Зоны", style="TFrame"
        )
        self.zones_frame.pack(pady=5, padx=10, fill=tk.BOTH, expand=True)

        self.zones_list = tk.Listbox(
            self.zones_frame,
            bg=LISTBOX_BG,
            fg=TEXT_COLOR,
            selectbackground=LISTBOX_SELECTION,
            selectforeground=TEXT_COLOR,
            highlightthickness=0,
            relief=tk.FLAT,
            font=FONT,
        )
        self.zones_list.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.zones_list.bind("<Double-Button-1>", self.toggle_zone_visibility)

        self.status_var = tk.StringVar()
        self.status_bar = ttk.Label(
            self.root,
            textvariable=self.status_var,
            relief=tk.FLAT,
            anchor=tk.W,
            background=DARKER_BG,
            foreground=TEXT_COLOR,
            font=FONT,
            padding=6,
        )
        self.status_bar.pack(side=tk.BOTTOM, fill=tk.X)

        self.minimap_frame = ttk.Frame(self.canvas_frame, style="TFrame")
        self.minimap_frame.place(relx=1.0, rely=1.0, x=-15, y=-15, anchor=tk.SE)

        self.minimap_canvas = tk.Canvas(
            self.minimap_frame,
            width=self.minimap_size,
            height=self.minimap_size,
            bg=DARKER_BG,
            highlightthickness=0,
            bd=0,
            relief=tk.FLAT,
        )
        self.minimap_canvas.pack(padx=2, pady=2)

        self.minimap_label = ttk.Label(
            self.minimap_frame,
            text="Превью окна игрока",
            style="TLabel",
            font=FONT,
            anchor=tk.CENTER,
            background=DARK_BG,
            foreground=TEXT_COLOR,
            padding=4,
        )
        self.minimap_label.pack(fill=tk.X)

        self.update_status("Ready")

    def update_grid_from_slider(self, value):
        """Обновить размер сетки при изменении ползунка"""
        # Округляем значение до целого числа
        new_value = round(float(value))

        # Обновляем размер сетки
        self.grid_settings.cell_size = new_value

        # Обновляем поле ввода с текущим значением
        self.grid_entry.delete(0, tk.END)
        self.grid_entry.insert(0, str(self.grid_settings.cell_size))

        # Обновляем перерисовку карты
        self.redraw_map()

    def on_grid_entry_change(self, new_value):
        """Обработчик изменений в поле ввода для размера сетки"""
        try:
            # Проверка, что введено целое число в диапазоне от 1 до 200
            if new_value == "":
                return True

            new_value = int(new_value)

            if 1 <= new_value <= 200:
                # Обновляем слайдер
                self.grid_slider.set(new_value)

                # Обновляем размер сетки
                self.grid_settings.cell_size = new_value

                # Перерисовываем карту
                self.redraw_map()

                return True
            else:
                return False
        except ValueError:
            return False

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
            "finds": self._export_finds_data(),
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
        """Export map data with compression"""
        buffered = BytesIO()
        # Сжимаем до 80% качества
        self.map_image.save(buffered, format="PNG", quality=80, optimize=True)
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

    def _export_finds_data(self):
        """Export tokens data"""
        finds_data = []
        for find in self.finds.values():
            find_data = {
                "id": find.id,
                "name": find.name,
                "position": find.position,
                "size": find.size,
                "status": find.status,
                "description": find.description,
            }

            finds_data.append(find_data)
        return finds_data

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
            self.finds = {}
            self.zones = {}
            self.next_token_id = 1
            self.next_find_id = 1
            self.next_zone_id = 1

            # Import map
            self._import_map_data(data["map"])

            # Import tokens
            self._import_tokens_data(data["tokens"])

            # Import finds
            self._import_finds_data(data["finds"])

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

    def _import_finds_data(self, finds_data):
        """Import tokens data"""
        for find_data in finds_data:
            find_id = f"find_{self.next_find_id}"
            self.next_find_id += 1

            # Create base token image
            size = find_data.get("size", 50)
            img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)
            draw.ellipse((0, 0, size, size), fill="white")
            find_photo = ImageTk.PhotoImage(img)

            # Create token
            self.finds[find_id] = Find(
                id=find_id,
                name=find_data["name"],
                image=find_photo,
                position=tuple(find_data["position"]),
                size=size,
                status=find_data.get("status", False),
                description=find_data["description"],
            )

            if not hasattr(self, "_find_images"):
                self._find_images = {}
            self._find_images[find_id] = find_photo

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
        # Привязка мышиного колеса к сайдбару
        self.sidebar_canvas.bind(
            "<Enter>",
            lambda e: self.sidebar_canvas.bind_all(
                "<MouseWheel>", self.on_sidebar_mouse_wheel
            ),
        )
        self.sidebar_canvas.bind(
            "<Leave>", lambda e: self.sidebar_canvas.unbind_all("<MouseWheel>")
        )

        # Привязка колесика к основной canvas — только когда мышь над ней
        self.canvas.bind(
            "<Enter>",
            lambda e: self.canvas.bind_all("<MouseWheel>", self.on_mouse_wheel),
        )
        self.canvas.bind("<Leave>", lambda e: self.canvas.unbind_all("<MouseWheel>"))

        # Другие биндинги, например, для canvas
        self.canvas.bind("<Button-1>", self.on_canvas_click)
        self.canvas.bind("<B1-Motion>", self.on_canvas_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_canvas_release)
        self.canvas.bind("<Button-3>", self.on_right_click)
        self.canvas.bind("<Motion>", self.on_canvas_motion)
        self.canvas.bind("<Delete>", self.delete_selected)

    def delete_selected(self, event=None):
        """Delete selected object"""
        if hasattr(self, "selected_token") and self.selected_token:
            self._delete_selected_token()
        elif hasattr(self, "selected_zone") and self.selected_zone:
            self._delete_selected_zone()
        elif hasattr(self, "selected_find") and self.selected_find:
            self._delete_find()

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
                img.thumbnail((token.size, token.size))

                squared_img = Image.new("RGBA", (token.size, token.size), (0, 0, 0, 0))
                offset = ((token.size - img.width) // 2, (token.size - img.height) // 2)
                squared_img.paste(img, offset)

                avatar_img = ImageTk.PhotoImage(squared_img)

                self.image_cache[file_path] = (img, avatar_img)

                token.avatar_path = file_path
                token.avatar_image = avatar_img
                self.redraw_map()
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

            # Update scroll region
            self.canvas.config(
                scrollregion=(
                    self.offset_x,
                    self.offset_y,
                    self.offset_x + width,
                    self.offset_y + height,
                )
            )
        
        # Если линейка активна и есть точки A и B, рисуем ее
        if self.ruler_active and self.ruler_start and self.ruler_end:
            self._draw_ruler()

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
            font=FONT,
            tags=("find", f"find_{find.id}"),
        )

        x_text = x
        y_text = y + find.size // 2 + 10
        text = find.name
        font = FONT
        main_color = TEXT_COLOR
        shadow_color = "#000000"  # черный буфер

        # Рисуем тень (чёрный текст с небольшим смещением)
        self.canvas.create_text(
            x_text + 1,
            y_text + 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("find", f"find_{find.id}"),
        )
        self.canvas.create_text(
            x_text - 1,
            y_text + 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("find", f"find_{find.id}"),
        )
        self.canvas.create_text(
            x_text + 1,
            y_text - 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("find", f"find_{find.id}"),
        )
        self.canvas.create_text(
            x_text - 1,
            y_text - 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("find", f"find_{find.id}"),
        )

        # Рисуем основной текст поверх
        self.canvas.create_text(
            x_text,
            y_text,
            text=text,
            fill=main_color,
            font=font,
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
        fill_color = (
            "#A5D6A7" if zone.is_visible else "#EF9A9A"
        )  # Светло-зелёный/красный
        outline_color = (
            "#4CAF50" if zone.is_visible else "#F44336"
        )  # Акцент для границы

        self.canvas.create_polygon(
            [
                (x * self.scale + self.offset_x, y * self.scale + self.offset_y)
                for x, y in zone.vertices
            ],
            fill=fill_color,
            outline=outline_color,
            stipple="gray25" if not zone.is_visible else "gray12",
            width=2,
            tags=("zone", f"zone_{zone.id}"),
        )

        if zone.vertices:
            center_x = sum(x for x, y in zone.vertices) / len(zone.vertices)
            center_y = sum(y for x, y in zone.vertices) / len(zone.vertices)
            self.canvas.create_text(
                center_x * self.scale + self.offset_x,
                center_y * self.scale + self.offset_y,
                text=zone.name,
                fill="#ECEFF1",  # Светлый, читаемый текст
                font=("Segoe UI Semibold", int(10 * self.scale)),
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
                dash=(6, 3),
                stipple="gray25",
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

        text_color = TEXT_COLOR
        if token.is_dead:
            text_color = "#9E9E9E"

        x_text = x
        y_text = y + token_size // 2 + 10
        text = token.name
        font = FONT
        main_color = text_color
        shadow_color = "#000000"  # черный буфер

        # Рисуем тень (чёрный текст с небольшим смещением)
        self.canvas.create_text(
            x_text + 1,
            y_text + 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("token", f"token_{token.id}"),
        )
        self.canvas.create_text(
            x_text - 1,
            y_text + 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("token", f"token_{token.id}"),
        )
        self.canvas.create_text(
            x_text + 1,
            y_text - 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("token", f"token_{token.id}"),
        )
        self.canvas.create_text(
            x_text - 1,
            y_text - 1,
            text=text,
            fill=shadow_color,
            font=font,
            tags=("token", f"token_{token.id}"),
        )

        # Рисуем основной текст поверх
        self.canvas.create_text(
            x_text,
            y_text,
            text=text,
            fill=main_color,
            font=font,
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

        dialog = TextInputDialog(self.root, "Находка", "Введите название находки")
        find_name = dialog.show()
        if not find_name:
            return

        # Используем новый диалог для описания
        desc_dialog = FindDescriptionDialog(self.root, "Описание находки")
        find_desc = desc_dialog.result if desc_dialog.result else ""

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
            size=find_size,
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

        dialog = TextInputDialog(self.root, "Персонаж", f"Введите имя {token_type}:")
        token_name = dialog.show()
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
        dialog = YesNoDialog(self.root, "Аватар", "Добавить иконку персонажу?")
        answer = dialog.show()
        if answer:
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
        """Обработчик клика по канвасу"""
        x = (self.canvas.canvasx(event.x) - self.offset_x) / self.scale
        y = (self.canvas.canvasy(event.y) - self.offset_y) / self.scale

        if self.ruler_active:
            # Если линейка активна
            if not self.ruler_start:
                # Устанавливаем точку A при первом клике
                self.ruler_start = (x, y)
                self.ruler_end = None  # Очистим точку B
            else:
                # Обновляем точку A при новом клике и начинаем новую линию
                self.ruler_start = (x, y)
                self.ruler_end = None  # Очистим точку B

            # Перерисовываем карту с линейкой
            self.redraw_map()

        elif self.creating_zone:
            # Логика создания зоны
            snap_point = self._find_snap_point(x, y)
            if snap_point:
                x, y = snap_point

            self.current_zone_vertices.append((x, y))
            self._update_snap_points()
            return

        # Обработка выбора токенов и находок (по аналогии с твоим кодом)
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

                # Выбираем токен в списке
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

        # Если двойной клик на находке — показываем описание
        if event.num == 1 and hasattr(event, "click_count") and event.click_count == 2:
            canvas_x = self.canvas.canvasx(event.x)
            canvas_y = self.canvas.canvasy(event.y)

            for find_id, find in self.finds.items():
                fx = find.position[0] * self.scale + self.offset_x
                fy = find.position[1] * self.scale + self.offset_y
                distance = math.sqrt((fx - canvas_x) ** 2 + (fy - canvas_y) ** 2)

                if distance <= find.size // 2:
                    # Показываем полное описание в диалоге
                    FindDescriptionDialog(
                        self.root,
                        f"Описание находки: {find.name}",
                        find.description or "",
                    )
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
        
        if self.ruler_active and self.ruler_start:
            # Преобразуем текущие координаты мыши в координаты карты
            x = (self.canvas.canvasx(event.x) - self.offset_x) / self.scale
            y = (self.canvas.canvasy(event.y) - self.offset_y) / self.scale
            
            # Обновляем точку B (местоположение мыши)
            self.ruler_end = (x, y)
            self.redraw_map()
            

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
        
        if self.ruler_active and self.ruler_start and self.ruler_end:
            # Завершаем создание линейки, когда отпускаем кнопку
            self.ruler_active = False
            self.ruler_start = None
            self.ruler_end = None
            self.redraw_map()  # Перерисовываем карту, чтобы удалить линейку

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

        dialog = TextInputDialog(self.root, "Зона", "Введите название зоны")
        zone_name = dialog.show()
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
        if not self.zones:
            return False

        new_path = Path(np.array(new_vertices))

        for zone in self.zones.values():
            existing_path = Path(np.array(zone.vertices))

            # Проверяем точки новой зоны — строго внутри (не на границе)
            for point in new_vertices:
                if existing_path.contains_point(point, radius=-1e-9):
                    return True

            # Проверяем точки существующей зоны внутри новой
            for point in zone.vertices:
                if new_path.contains_point(point, radius=-1e-9):
                    return True

            # Проверяем пересечение рёбер — исключая касания концами
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
    def _segments_intersect(p1, p2, p3, p4):
        """Return True if segments (p1,p2) and (p3,p4) intersect strictly inside (no endpoints)."""

        def ccw(a, b, c):
            return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0])

        # Проверка, пересекаются ли отрезки (включая касания)
        intersect = (ccw(p1, p3, p4) != ccw(p2, p3, p4)) and (
            ccw(p1, p2, p3) != ccw(p1, p2, p4)
        )
        if not intersect:
            return False

        # Проверяем, не совпадает ли точка пересечения с концами отрезков
        # Для этого вычислим точку пересечения и проверим равенство с концами

        # Векторное представление
        x1, y1 = p1
        x2, y2 = p2
        x3, y3 = p3
        x4, y4 = p4

        denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1)
        if denom == 0:
            return False  # параллельны или совпадают

        ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom
        ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom

        # Точка пересечения
        xi = x1 + ua * (x2 - x1)
        yi = y1 + ua * (y2 - y1)

        intersection_point = (xi, yi)

        # Функция для проверки совпадения точек с допуском
        def points_are_close(a, b, tol=1e-9):
            return abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol

        # Если точка пересечения совпадает с любым концом — не считать пересечением
        endpoints = [p1, p2, p3, p4]
        for ep in endpoints:
            if points_are_close(intersection_point, ep):
                return False

        return True

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
        # Твой текущий код масштабирования карты
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

    def on_sidebar_mouse_wheel(self, event):
        delta = -1 * (event.delta // 120) if event.delta else 0
        self.sidebar_canvas.yview_scroll(delta, "units")
        return "break"

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

        self.canvas.delete("ruler")

        # Пунктирная линия
        self.canvas.create_line(
            start_x,
            start_y,
            end_x,
            end_y,
            fill="#FF5252",
            width=4,
            dash=(5, 3),
            arrow="last",
            tags="ruler",
        )

        if self.map_image and hasattr(self, "grid_settings"):
            cell_width_px = (
                self.map_image.width * self.scale
            ) / self.grid_settings.cell_size
            dx = (end_x - start_x) / cell_width_px
            dy = (end_y - start_y) / cell_width_px
            distance = math.sqrt(dx**2 + dy**2) * 5

            distance_text = f"{distance:.1f} ft"
            text_x = (start_x + end_x) / 2
            text_y = (start_y + end_y) / 2 - 15
            font = FONT

            # Временный текст, чтобы узнать размер
            temp_text = self.canvas.create_text(
                text_x, text_y, text=distance_text, font=font
            )
            bbox = self.canvas.bbox(temp_text)
            self.canvas.delete(temp_text)

            padding = 4
            rect_x1 = bbox[0] - padding
            rect_y1 = bbox[1] - padding
            rect_x2 = bbox[2] + padding
            rect_y2 = bbox[3] + padding

            # Непрозрачный темный фон (например, черный с 80% непрозрачностью - можно имитировать)
            # Просто возьмём темно-серый (тк прозрачность не работает)
            self.canvas.create_rectangle(
                rect_x1,
                rect_y1,
                rect_x2,
                rect_y2,
                fill="#222222",
                outline="",
                tags="ruler",
            )

            # Тень текста (чуть смещённый черный)
            offset = 1
            self.canvas.create_text(
                text_x + offset,
                text_y + offset,
                text=distance_text,
                fill="#000000",
                font=FONT,
                tags="ruler",
            )
            # Основной текст
            self.canvas.create_text(
                text_x,
                text_y,
                text=distance_text,
                fill="#FF5252",
                font=FONT,
                tags="ruler",
            )


if __name__ == "__main__":
    root = tk.Tk()
    app = DnDMapMaster(root)
    root.mainloop()
