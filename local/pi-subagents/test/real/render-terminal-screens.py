"""Render captured xterm cells without replacing text, geometry, or colors."""
import json
import pathlib
import sys
from PIL import Image, ImageDraw, ImageFont

font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 16)
cell_width, cell_height = 10, 21
palette = ["#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
           "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"]
levels = [0, 95, 135, 175, 215, 255]
for red in levels:
    for green in levels:
        for blue in levels:
            palette.append((red, green, blue))
palette.extend((8 + i * 10,) * 3 for i in range(24))

def color(value, mode, default):
    if mode == 0:
        return default
    if mode == 0x3000000:
        return ((value >> 16) & 255, (value >> 8) & 255, value & 255)
    return palette[value & 255]

for path in pathlib.Path(sys.argv[1]).glob("*.cells.json"):
    cells = json.loads(path.read_text())
    image = Image.new("RGB", (len(cells[0]) * cell_width, len(cells) * cell_height), "#151515")
    draw = ImageDraw.Draw(image)
    for row, line in enumerate(cells):
        for column, cell in enumerate(line):
            if not cell:
                continue
            x, y = column * cell_width, row * cell_height
            draw.rectangle((x, y, x + cell_width - 1, y + cell_height - 1), fill=color(cell["bg"], cell["bgMode"], "#151515"))
            if cell["width"] and cell["text"]:
                draw.text((x, y), cell["text"], font=font, fill=color(cell["fg"], cell["fgMode"], "#e5e5e5"), stroke_width=0)
    image.save(path.with_name(path.name.replace(".cells.json", ".png")))
