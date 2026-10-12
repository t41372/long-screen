"""Draw a caption pill on a transparent 1280x900 PNG. usage: python caption.py <text> <out.png>"""
import sys
from PIL import Image, ImageDraw, ImageFont
W, H = 1280, 900
text, out = sys.argv[1], sys.argv[2]
font = ImageFont.truetype('/System/Library/Fonts/HelveticaNeue.ttc', 38, index=1)
im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
l, t, r, b = d.textbbox((0, 0), text, font=font)
pw, ph = r - l + 60, b - t + 34
x0, y0 = (W - pw) // 2, H - 32 - ph
d.rounded_rectangle((x0, y0, x0 + pw, y0 + ph), radius=ph // 2, fill=(20, 20, 24, 215))
d.text((x0 + 30 - l, y0 + 17 - t), text, font=font, fill=(255, 255, 255, 255))
im.save(out)
