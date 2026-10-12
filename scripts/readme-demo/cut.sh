#!/bin/bash
# Cuts the README demo from what record.ts left in WORK (default test-results/readme-demo):
# the input recording WORK/rec/screen-recording.mp4 (first INTRO s at 2x, with a caption), then WORK/out/raw.webm
# (the drop and Run in real time, processing at 8x, the export at 2x), then the exported print WORK/out/print.png
# (scroll.py: whole, zoom, one smooth scroll). Writes WORK/cut.mp4 and WORK/demo.webp. The README loads the image
# from GitHub's attachment CDN, not from the repo: upload a new one in a posted issue comment and point the README at it.
# Needs ffmpeg, img2webp and uv. usage: [WORK=dir] [WIDTH=960] [INTRO=8] bash cut.sh [fps] [quality]
# The README's demo: owner_2.01.28.mov (Wikipedia's "Bug (engineering)", panned in two dimensions), remuxed with
# `ffmpeg -i owner_2.01.28.mov -map 0:v:0 -c copy WORK/rec/screen-recording.mp4`, then `bash cut.sh 10 55`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HERE/../../test-results/readme-demo}"
cd "$WORK"
FPS=${1:-12.5} Q=${2:-70}
m() { python3 -c "import json;print(json.load(open('out/marks.json'))['$1'])"; }
B=$(python3 -c "print($(m landing)-0.4)"); D=$(m run); E=$(m done); F=$(m exported)
uv run --with pillow python "$HERE/caption.py" "A screen recording: any direction, any speed, any path" caption.png
uv run --with pillow python "$HERE/caption.py" "One big screenshot, at full resolution" caption-print.png
uv run --with pillow python "$HERE/scroll.py" out/print.png caption-print.png scroll.mp4
ffmpeg -v error -y -i rec/screen-recording.mp4 -i caption.png -i out/raw.webm -i scroll.mp4 -filter_complex "
[0:v]trim=0:${INTRO:-8},setpts=(PTS-STARTPTS)/2,scale=1280:900:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:900:(ow-iw)/2:(oh-ih)/2:color=0x111111,fps=25,format=yuv420p[i0];
[i0][1:v]overlay=0:0:format=auto,format=yuv420p,setsar=1[a];
[2:v]fps=25,format=yuv420p,setsar=1,split=3[r1][r2][r3];
[r1]trim=$B:$D,setpts=PTS-STARTPTS[b];
[r2]trim=$D:$E,setpts=(PTS-STARTPTS)/8[c];
[r3]trim=$E:$F,setpts=(PTS-STARTPTS)/2[d];
[3:v]fps=25,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[e];
[a][b][c][d][e]concat=n=5:v=1,fps=$FPS,scale=${WIDTH:-960}:-2:flags=lanczos[v]" -map "[v]" -c:v libx264 -crf 18 -pix_fmt yuv420p cut.mp4
rm -rf frames && mkdir frames
ffmpeg -v error -i cut.mp4 frames/f%04d.png
D_MS=$(python3 -c "print(round(1000/$FPS))")
img2webp -loop 0 -lossy -q "$Q" -m 6 -mixed -d "$D_MS" frames/f*.png -o demo.webp >/dev/null
rm -rf frames
rm -f caption.png caption-print.png scroll.mp4
ls -la demo.webp cut.mp4; ffprobe -v error -show_entries format=duration -of csv=p=0 cut.mp4
