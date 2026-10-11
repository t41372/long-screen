import { assertEquals } from '@std/assert';
import { colourCode, hdrCandidates, hdrTransfer } from '../../src/media/conversion-check.ts';
import { conversionDiagnostics } from '../../src/media/conversion-report.ts';
import type { MediaInfo } from '../../src/types.ts';

// Failure cases: a recording judged SDR because WebKit tags its PQ frames as sRGB (the container must win); an HDR
// frame without container tags missed; colour codes that disagree with rust/core/src/yuv.rs `Signal::from_code`;
// WebKit's full-range NV12 of BT.2020 Y'CbCr tried with its wrong BT.709 tag first, or the frame's correct range
// ignored; a warning raised for an HDR recording that was converted and checked, or missing for one that was not;
// highlights in an iPhone recording (0.3 % of pixels) taken for a white set too high; a fast conversion called slow,
// or a slow one (Chrome's canvas, 350 ms a frame) not; a recording without a frame count crashing the estimate.

/** A colour space as browsers report it: TypeScript's DOM types list only the SDR transfers and matrices. */
const space = (c: Record<string, unknown>) => c as unknown as VideoColorSpaceInit;

Deno.test('hdrTransfer: the container decides, the frame only when the container says nothing', () => {
  const webkitFrame = space({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true });
  assertEquals(hdrTransfer(space({ transfer: 'pq' }), webkitFrame), 'pq');
  assertEquals(hdrTransfer(undefined, space({ transfer: 'hlg' })), 'hlg');
  assertEquals(hdrTransfer({ transfer: 'bt709' }, { transfer: 'bt709' }), undefined);
  assertEquals(hdrTransfer(undefined, null), undefined);
});

Deno.test('colourCode: transfer × 8 + matrix × 2 + full range, as the core reads it', () => {
  assertEquals(colourCode('bt709', false, 'sdr'), 0);
  assertEquals(colourCode('bt601', true, 'sdr'), 3);
  assertEquals(colourCode('bt709', false, 'pq'), 8);
  assertEquals(colourCode('bt2020', true, 'pq'), 13);
  assertEquals(colourCode('bt601', true, 'hlg'), 19);
  assertEquals(colourCode('bt2020', false, 'hlg'), 20);
});

Deno.test('hdrCandidates: the container matrix with the frame range first, then the other pairings, once each', () => {
  const container = space({ primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false });
  // WebKit's HEVC PQ frame: full-range planes tagged BT.709.
  const webkit = space({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true });
  assertEquals(hdrCandidates('pq', container, webkit), [13, 9, 12, 8]);
  // Honest tags: only the two ranges remain.
  assertEquals(hdrCandidates('pq', container, container), [12, 13]);
  // No tags at all: BT.2020, limited first.
  assertEquals(hdrCandidates('hlg', undefined, undefined), [20, 21]);
});

const info = (frameCount?: number): MediaInfo => ({
  name: 'r.mov',
  size: 1,
  width: 3024,
  height: 2018,
  codedWidth: 3024,
  codedHeight: 2018,
  rotation: 0,
  duration: 11.4,
  codec: 'hvc1',
  frameCount,
  mode: 'Frame-accurate WebCodecs',
  warnings: [],
});
const codes = (d: { code: string }[]) => d.map((x) => x.code);

Deno.test('conversionDiagnostics: one info line, and a warning only for what the conversion could not do well', () => {
  assertEquals(codes(conversionDiagnostics({ method: 'copyTo(RGBA)' }, info(593))), ['FRAME_CONVERSION']);
  // Converted and checked, with an iPhone recording's few highlights: nothing to warn about.
  const checked = { method: 'planar', ms: 12, hdr: { transfer: 'pq' as const, verified: true, aboveShare: 0.003 } };
  assertEquals(codes(conversionDiagnostics(checked, info(944))), ['FRAME_CONVERSION']);
  const unchecked = conversionDiagnostics({ ...checked, hdr: { ...checked.hdr, verified: false } }, info(944));
  assertEquals(codes(unchecked), ['FRAME_CONVERSION', 'HDR_UNCHECKED']);
  assertEquals(unchecked[1].severity, 'warning');
  const bright = conversionDiagnostics({ ...checked, hdr: { ...checked.hdr, aboveShare: 0.32 } }, info(944));
  assertEquals(codes(bright), ['FRAME_CONVERSION', 'HDR_ABOVE_WHITE']);
  assertEquals((bright[1].detail as { aboveShare: number }).aboveShare, 0.32);
  // Chrome's canvas on a 593-frame 3K recording: ~21 minutes of conversion.
  const slow = conversionDiagnostics({ method: '2D canvas', ms: 350 }, info(593));
  assertEquals(codes(slow), ['FRAME_CONVERSION', 'SLOW_CONVERSION']);
  assertEquals((slow[1].detail as { estimatedSeconds: number }).estimatedSeconds, 1245);
  // The WebGPU route on the same recording: no warning.
  assertEquals(codes(conversionDiagnostics({ method: 'WebGPU', ms: 5 }, info(593))), ['FRAME_CONVERSION']);
  // No frame count: estimated from the duration at 30 fps (342 frames × 6 × 0.35 s ≈ 718 s).
  assertEquals((conversionDiagnostics({ method: '2D canvas', ms: 350 }, info())[1].detail as { frames: number }).frames, 342);
});
