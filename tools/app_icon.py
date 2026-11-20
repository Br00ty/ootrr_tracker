"""Draw the desktop app's icon (app/art/icon.ico, plus icon.png to look at).

An original design in the tracker's colours: a gold map pin with a check mark on the dark panel colour.
Run it again only to change the design; the .ico is committed.
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG, PANEL, LINE, GOLD, DARK = (20, 19, 15), (38, 35, 25), (90, 80, 52), (217, 180, 90), (20, 19, 15)
S = 1024  # drawn large, then shrunk for smooth edges


def draw():
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # rounded square
    d.rounded_rectangle([40, 40, S - 40, S - 40], radius=200, fill=PANEL, outline=LINE, width=24)
    # map pin: a circle with a point below
    cx, cy, r = S // 2, 430, 250
    d.polygon([(cx - r * 0.86, cy + r * 0.5), (cx + r * 0.86, cy + r * 0.5), (cx, cy + r * 1.95)], fill=GOLD)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD)
    # check mark in the pin's head
    w = 64
    d.line([(cx - 120, cy + 5), (cx - 30, cy + 95), (cx + 135, cy - 85)], fill=DARK, width=w, joint='curve')
    for x, y in [(cx - 120, cy + 5), (cx + 135, cy - 85)]:
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=DARK)
    return im


im = draw()
out = os.path.join(ROOT, 'app', 'art')
os.makedirs(out, exist_ok=True)
im.resize((256, 256), Image.LANCZOS).save(os.path.join(out, 'icon.png'))
im.resize((256, 256), Image.LANCZOS).save(os.path.join(out, 'icon.ico'), sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)])
print('app/art/icon.ico, app/art/icon.png')
