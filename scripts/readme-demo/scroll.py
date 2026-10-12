"""Render the print's showcase as a video: the whole print fitted to the frame, a zoom to the frame's width at its top,
then one smooth scroll to the bottom and a short hold, with a caption on top. Frames go to ffmpeg as raw RGB.
usage: python scroll.py <print.png> <caption.png> <out.mp4>"""
import subprocess
import sys
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
W, H, FPS, MARGIN, BG = 1280, 900, 25, 20, (0x2A, 0x2B, 0x30)
WHOLE, ZOOM, SCROLL, HOLD = 2.5, 1.2, 8.0, 1.2
src, cap_path, out = sys.argv[1:4]
cap = Image.open(cap_path).convert('RGBA')
full = Image.open(src).convert('RGB')
wide = min(W - 4 * MARGIN, full.width)
master = full.resize((wide, round(full.height * wide / full.width)), Image.LANCZOS)
fit = (H - 2 * MARGIN) / master.height
travel = master.height - (H - 2 * MARGIN)


def ease(t: float) -> float:
    return t * t * (3 - 2 * t)


def frame(scale: float, dy: float) -> Image.Image:
    """The print at `scale` of the master width, centred, its top at MARGIN - dy."""
    im = Image.new('RGB', (W, H), BG)
    if scale == 1:
        im.paste(master, ((W - master.width) // 2, MARGIN - round(dy)))
    else:
        w, h = round(master.width * scale), round(master.height * scale)
        im.paste(master.resize((w, h), Image.LANCZOS), ((W - w) // 2, MARGIN))
    im.paste(cap, (0, 0), cap)
    return im


frames = []
frames += [(fit, 0)] * round(WHOLE * FPS)
n = round(ZOOM * FPS)
frames += [(fit + (1 - fit) * ease((i + 1) / n), 0) for i in range(n)]
n = round(SCROLL * FPS)
frames += [(1, travel * ease((i + 1) / n)) for i in range(n)]
frames += [(1, travel)] * round(HOLD * FPS)
enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
                        '-i', '-', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', out], stdin=subprocess.PIPE)
cache = {}
for scale, dy in frames:
    key = (round(scale, 6), round(dy))
    if key not in cache:
        cache = {key: frame(scale, dy).tobytes()}
    enc.stdin.write(cache[key])
enc.stdin.close()
enc.wait()
print(f'{len(frames)} frames, {len(frames) / FPS:.1f} s, master {master.width}x{master.height}, travel {travel} px')
