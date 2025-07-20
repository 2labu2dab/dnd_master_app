# ====== logic/models.py ======
class Token:
    def __init__(self, id, name, position, size, is_visible, is_player, is_npc, health_points=10, max_health_points=10, armor_class=10, is_dead=False):
        self.id = id
        self.name = name
        self.position = position
        self.size = size
        self.is_player = is_player
        self.is_npc = is_npc
        self.is_dead = is_dead
        self.is_visible = is_visible
        self.health_points = health_points
        self.max_health_points = max_health_points
        self.armor_class = armor_class

class Find:
    def __init__(self, id, name, position, size, status=False, description=""):
        self.id = id
        self.name = name
        self.position = position
        self.size = size
        self.status = status
        self.description = description

class Zone:
    def __init__(self, id, name, vertices, is_visible=True):
        self.id = id
        self.name = name
        self.vertices = vertices
        self.is_visible = is_visible

class GridSettings:
    def __init__(self, visible=True, visible_to_players=True, cell_size=20, color="#888888", opacity=100):
        self.visible = visible
        self.visible_to_players = visible_to_players
        self.cell_size = cell_size
        self.color = color
        self.opacity = opacity