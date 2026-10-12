#!/usr/bin/env python3
"""Check known real-recording ROIs against independently decoded native frames.

Requires ffmpeg, ffprobe, Python3, numpy and Pillow. RESULT is a scripts/benchmark-pipeline.ts output directory
written with --export-canvases. Example:
python3 scripts/check-recording-oracles.py --clip f --video test_case/f.mov --result test-results/benchmark-pipeline

Writes a JSON report and native/current comparison PNGs under RESULT/real-oracles.
Exit1 means a named local check failed or the Engine outcome is incomplete.
Informational dynamic crops do not certify image quality.

--reference ffmpeg (default) compares against FFmpeg's own RGB conversion. --reference browser decodes the raw
YUV planes with FFmpeg and converts them the way the app's GPU conversion and Chrome's copyTo(RGBA) of a hardware
frame do (the YUV matrix alone, chroma interpolated between its samples), so a sharp colour edge is not reported
as an output error when it is only a different chroma filter.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw


def engine_completeness(result):
    """A successful local crop cannot certify a stopped or failed Engine run."""
    path = result / 'benchmark-pass-1.json'
    if not path.exists():
        return {'complete': False, 'reason': 'missing Engine outcome'}
    outcome = json.loads(path.read_text())
    pipeline = outcome.get('pipeline', {})
    frames = pipeline.get('frames')
    rendered = pipeline.get('renderedFrames')
    source_frames = outcome.get('source', {}).get('frames')
    complete = (
        outcome.get('status') == 'complete'
        and isinstance(frames, int) and frames > 0
        and rendered == frames
        and (source_frames is None or source_frames == frames)
    )
    return {
        'complete': complete, 'status': outcome.get('status'),
        'frames': frames, 'renderedFrames': rendered, 'sourceFrames': source_frames,
    }


def complete_epoch_plans(evidence, canvas_id, rect):
    """Require one frame to own every pixel of the physical rectangle.

    The reveal stage's provenance row (reveal/<canvas>) names, per 16-pixel block, the frame a whole block was
    copied from (-1 where the compositor's pixels stand, -2 for per-pixel values from several frames). Only blocks
    copied whole from the same frame certify an epoch; the compositor's representative owner frame never does.
    """
    x, y, width, height = rect
    for row in evidence['rows'].get('reveal/', []):
        if row.get('key') != f'reveal/{canvas_id}':
            continue
        if row.get('version') != 1:
            raise ValueError(f"{row.get('key')}: unsupported provenance record")
        gx, gy, bw, bh, source = row['gx'], row['gy'], row['bw'], row['bh'], row['source']
        if len(source) != bw * bh:
            raise ValueError(f"{row.get('key')}: {len(source)} block sources for a {bw}x{bh} grid")
        frames = set()
        for by in range(y // 16, (y + height - 1) // 16 + 1):
            for bx in range(x // 16, (x + width - 1) // 16 + 1):
                if not (gx <= bx < gx + bw and gy <= by < gy + bh):
                    return []
                frames.add(source[(by - gy) * bw + bx - gx])
        if len(frames) == 1 and min(frames) >= 0:
            return [{'key': row['key'], 'frame': frames.pop()}]
        return []
    return []


def browser_rgb(yuv, width, height, matrix):
    """YUV 4:2:0 planes to RGB as the app's GPU conversion does: chroma sampled bilinearly at each pixel's centre
    (half resolution in both axes, clamped at the edges), the matrix alone, rounded."""
    cw, ch = (width + 1) // 2, (height + 1) // 2
    y = yuv[:width * height].reshape(height, width).astype(np.float64)
    u = yuv[width * height:width * height + cw * ch].reshape(ch, cw).astype(np.float64)
    v = yuv[width * height + cw * ch:width * height + 2 * cw * ch].reshape(ch, cw).astype(np.float64)

    def up(plane):
        def axis(n, m):
            at = (np.arange(n) + 0.5) / 2 - 0.5
            lo = np.floor(at).astype(int)
            return np.clip(lo, 0, m - 1), np.clip(lo + 1, 0, m - 1), at - lo
        x0, x1, fx = axis(width, cw)
        y0, y1, fy = axis(height, ch)
        top = plane[y0][:, x0] * (1 - fx) + plane[y0][:, x1] * fx
        bottom = plane[y1][:, x0] * (1 - fx) + plane[y1][:, x1] * fx
        return top * (1 - fy)[:, None] + bottom * fy[:, None]

    kr, kb, full = matrix
    kg = 1 - kr - kb
    luma = y if full else (y - 16) * 255 / 219
    scale = 1 if full else 255 / 224
    cb, cr = (up(u) - 128) * scale, (up(v) - 128) * scale
    rgb = np.stack([
        luma + 2 * (1 - kr) * cr,
        luma - 2 * kb * (1 - kb) / kg * cb - 2 * kr * (1 - kr) / kg * cr,
        luma + 2 * (1 - kb) * cb,
    ], axis=2)
    return np.clip(np.round(rgb), 0, 255).astype(np.uint8)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--clip', required=True, choices=['0', 'a', 'b', 'c', 'd', 'e', 'f'])
    parser.add_argument('--video', required=True, type=Path)
    parser.add_argument('--result', required=True, type=Path)
    parser.add_argument('--output', type=Path, help='Write a separate review without replacing an earlier oracle report')
    parser.add_argument('--manifest', type=Path, default=Path(__file__).resolve().parent / 'recording-oracles.json')
    parser.add_argument('--reference', choices=['ffmpeg', 'browser'], default='ffmpeg')
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    cases = manifest['cases'][args.clip]
    evidence = json.loads((args.result / 'benchmark-pass-1.evidence.json').read_text())
    cid = manifest['canvasId']
    meta = next(c for c in evidence['rows']['canvas/'] if c['id'] == cid)
    bounds = meta['bounds']
    observations = {r['frame']: r for r in evidence['rows']['observation/']}
    output_path = args.result / f'benchmark-pass-1-{cid}.png'
    output_image = Image.open(output_path).convert('RGBA')
    out = args.output or args.result / 'real-oracles'
    out.mkdir(parents=True, exist_ok=True)
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,color_space,color_range', '-of', 'json', str(args.video)]))['streams'][0]
    width, height = probe['width'], probe['height']
    # The app's choice for an untagged stream: BT.709 when HD, BT.601 otherwise (src/media/conversion-check.ts).
    space = probe.get('color_space') or ('bt709' if height >= 720 else 'smpte170m')
    matrix = ((0.2126, 0.0722) if space == 'bt709' else (0.299, 0.114)) + (probe.get('color_range') == 'pc',)
    epoch_plans = {
        c['id']: complete_epoch_plans(evidence, cid, c['worldRect'])
        for c in cases if c['check'] == 'accepted-epoch-native-close'
    }
    frames = sorted({c['frame'] for c in cases} | {
        plan['frame'] for plans in epoch_plans.values() for plan in plans
    })
    select = '+'.join(f'eq(n\\,{n})' for n in frames)
    browser = args.reference == 'browser'
    command = ['ffmpeg', '-v', 'error', '-threads', '1', '-i', str(args.video), '-filter_threads', '1', '-vf', f'select={select}', '-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p' if browser else 'rgb24', '-f', 'rawvideo', 'pipe:1']
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    decoded = {}
    size = width * height + 2 * ((width + 1) // 2) * ((height + 1) // 2) if browser else width * height * 3
    for frame in frames:
        data = process.stdout.read(size)
        if len(data) != size:
            raise RuntimeError(f'Native decode ended before frame {frame}')
        raw = np.frombuffer(data, dtype=np.uint8)
        decoded[frame] = browser_rgb(raw, width, height, matrix) if browser else raw.reshape(height, width, 3)
    if process.wait() != 0:
        raise RuntimeError('Native decoder failed')
    checks = []
    for case in cases:
        selected_plan = None
        row = observations[case['frame']]
        pose = next(d['placement'] for d in row['decisions'] if d.get('canvasId') == cid)
        raster = [math.floor(pose[axis] + 0.5) for axis in ['x', 'y']]
        # A changed geometry is a changed oracle mapping, never silently compare unrelated content.
        if raster != case['pose'] or abs(row['time'] - case['time']) > 0.000002:
            raise ValueError(f"{case['id']}: expected native pose/time {case['pose']}/{case['time']}, got {raster}/{row['time']}; revalidate mapping")
        x, y, w, h = case['worldRect']
        sx, sy = x - raster[0], y - raster[1]
        if not (0 <= sx and 0 <= sy and sx + w <= width and sy + h <= height):
            raise ValueError(f"{case['id']}: native crop outside viewport")
        ox, oy = x - bounds['x'], y - bounds['y']
        if not (0 <= ox and 0 <= oy and ox + w <= output_image.width and oy + h <= output_image.height):
            raise ValueError(f"{case['id']}: output crop outside canvas")
        native = decoded[case['frame']][sy:sy+h, sx:sx+w]
        actual_rgba = np.asarray(output_image.crop((ox, oy, ox+w, oy+h)))
        actual = actual_rgba[:, :, :3]
        if case['check'] == 'accepted-epoch-native-close':
            alternatives = []
            for plan in epoch_plans[case['id']]:
                selected_row = observations[plan['frame']]
                selected_pose = next(d['placement'] for d in selected_row['decisions'] if d.get('canvasId') == cid)
                selected_raster = [math.floor(selected_pose[axis] + 0.5) for axis in ['x', 'y']]
                px, py = x - selected_raster[0], y - selected_raster[1]
                if not (0 <= px and 0 <= py and px+w <= width and py+h <= height):
                    raise ValueError(f"{plan['key']}: claimed complete epoch outside native viewport")
                observed = decoded[plan['frame']][py:py+h, px:px+w]
                error = np.abs(actual.astype(np.int16) - observed.astype(np.int16))
                alternatives.append((float(error.mean()), plan, observed, selected_row, selected_raster, px, py))
            if alternatives:
                _, selected_plan, native, row, raster, sx, sy = min(alternatives, key=lambda item: (item[0], item[1]['frame']))
        delta = np.abs(actual.astype(np.int16) - native.astype(np.int16))
        metrics = {'nonOpaquePixels': int((actual_rgba[:, :, 3] != 255).sum()), 'meanAbsoluteError': float(delta.mean()), 'maximumChannelError': int(delta.max()), 'pixelsAbove30': int((delta.max(2) > 30).sum()), 'darkNativeTurnedWhite': int(((native.max(2) < 220) & (actual.min(2) > 250)).sum())}
        status = 'informational'
        if case['check'] == 'flat':
            metrics['nativeNonFlatPixels'] = int(np.any(native != case['value'], axis=2).sum())
            metrics['outputNonFlatPixels'] = int(np.any(actual != case['value'], axis=2).sum())
            if metrics['nativeNonFlatPixels']:
                raise ValueError(f"{case['id']}: supplied video no longer satisfies native flat reference")
            status = 'pass' if metrics['outputNonFlatPixels'] == 0 else 'fail'
        elif case['check'] in ['native-close', 'accepted-epoch-native-close']:
            metrics['pixelsAboveAllowedDelta'] = int((delta.max(2) > case['maxChannelDelta']).sum())
            status = 'pass' if metrics['pixelsAboveAllowedDelta'] <= case['maxAboveDelta'] and metrics['meanAbsoluteError'] <= case['maxMeanError'] else 'fail'
            if case['check'] == 'accepted-epoch-native-close':
                metrics['completeAcceptedEpochs'] = len(epoch_plans[case['id']])
                if not selected_plan:
                    status = 'fail'
        elif case['check'] == 'white-glyph':
            white = native.min(2) > case['referenceWhiteAbove']
            metrics['strongWhiteReferencePixels'] = int(white.sum())
            metrics['strongWhitePixelsTurnedDark'] = int((white & (actual.min(2) < case['outputDarkBelow'])).sum())
            status = 'pass' if metrics['strongWhitePixelsTurnedDark'] <= case['maxDarkPixels'] and metrics['meanAbsoluteError'] <= case['maxMeanError'] else 'fail'
        if status != 'informational' and metrics['nonOpaquePixels']:
            status = 'fail'
        scale = min(8, max(1, 512 // max(w, h)))
        panel = Image.new('RGB', (w*scale*2, h*scale+26), 'white')
        draw = ImageDraw.Draw(panel)
        draw.text((2, 2), 'Native / output', fill='black')
        for column, image in enumerate([native, actual]):
            panel.paste(Image.fromarray(image).resize((w*scale, h*scale), Image.Resampling.NEAREST), (column*w*scale, 26))
        image_name = case['id'] + '.png'
        panel.save(out / image_name)
        check = {'id': case['id'], 'status': status, 'worldRect': case['worldRect'], 'frame': row['frame'], 'time': row['time'], 'rasterPose': raster, 'nativeScreenRect': [sx, sy, w, h], 'metrics': metrics, 'comparison': image_name, 'rationale': case.get('rationale')}
        if case['check'] == 'accepted-epoch-native-close':
            check['acceptedEpochPlan'] = selected_plan
            check['missingCompleteEpoch'] = selected_plan is None
        checks.append(check)
    digest = hashlib.sha256()
    with args.video.open('rb') as file:
        for chunk in iter(lambda: file.read(1024*1024), b''):
            digest.update(chunk)
    report = {'clip': args.clip, 'video': str(args.video.resolve()), 'videoSha256': digest.hexdigest(), 'manifest': str(args.manifest.resolve()), 'manifestSha256': hashlib.sha256(args.manifest.read_bytes()).hexdigest(), 'result': str(args.result.resolve()), 'canvasBounds': bounds, 'scope': manifest['scope'], 'reference': args.reference, 'decoderCommand': command, 'checks': checks, 'failed': sum(c['status'] == 'fail' for c in checks)}
    report['engineCompleteness'] = engine_completeness(args.result)
    report['localGateStatus'] = 'failed' if report['failed'] or not report['engineCompleteness']['complete'] else ('passed' if any(c['status'] == 'pass' for c in checks) else 'informational-only')
    report['outputSha256'] = hashlib.sha256(output_path.read_bytes()).hexdigest()
    report['ledgerSha256'] = hashlib.sha256((args.result / 'benchmark-pass-1.evidence.json').read_bytes()).hexdigest()
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return 1 if report['localGateStatus'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
