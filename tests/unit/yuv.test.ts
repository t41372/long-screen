import '../support/core.ts';
import { assertEquals } from '@std/assert';
import { core } from '../../src/core/wasm.ts';

// The core's YUV→RGBA conversion (rust/core/src/yuv.rs) against libyuv's per-pixel arithmetic written out here, on
// every build (LONGSCREEN_CORE=scalar|simd|threads): the SIMD build converts several pixels per instruction and must
// produce the same bytes. Failure cases: any layout (I420, I422, I444, NV12) or matrix; widths that leave a tail
// after whole vectors, down to one pixel; an odd last column with its own chroma sample; row strides wider than the
// row; values that clamp at 0 and 255; frames large enough to be split across pool threads.
const MATRICES = [
  { yg: 18997, yb: -1160, ub: 128, ug: 14, vg: 34, vr: 115 },
  { yg: 16320, yb: 32, ub: 119, ug: 12, vg: 30, vr: 101 },
  { yg: 18997, yb: -1160, ub: 128, ug: 25, vg: 52, vr: 102 },
  { yg: 16320, yb: 32, ub: 113, ug: 22, vg: 46, vr: 90 },
];
const FORMATS = { I420: 0, I422: 1, I444: 2, NV12: 3 } as const;
type FormatName = keyof typeof FORMATS;

const clamp = (v: number) => Math.min(255, Math.max(0, v));
function pixel(y: number, u: number, v: number, m: typeof MATRICES[number]): [number, number, number] {
  const y1 = Math.floor(y * 0x0101 * m.yg / 65536) + m.yb, ui = u - 128, vi = v - 128;
  return [clamp((y1 + vi * m.vr) >> 6), clamp((y1 - (ui * m.ug + vi * m.vg)) >> 6), clamp((y1 + ui * m.ub) >> 6)];
}

function planes(format: FormatName, w: number, h: number): [number, number][] {
  const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
  return format === 'I420'
    ? [[w, h], [cw, ch], [cw, ch]]
    : format === 'I422'
    ? [[w, h], [cw, h], [cw, h]]
    : format === 'I444'
    ? [[w, h], [w, h], [w, h]]
    : [[w, h], [cw * 2, ch]];
}

function reference(
  src: Uint8Array,
  format: FormatName,
  layout: { offset: number; stride: number }[],
  w: number,
  h: number,
  m: typeof MATRICES[number],
) {
  const out = new Uint8Array(w * h * 4), at = (i: number, r: number, c: number) => src[layout[i].offset + r * layout[i].stride + c];
  for (let y = 0; y < h; y++) {
    const cy = format === 'I420' || format === 'NV12' ? y >> 1 : y;
    for (let x = 0; x < w; x++) {
      const cx = format === 'I444' ? x : x >> 1;
      const [u, v] = format === 'NV12' ? [at(1, cy, cx * 2), at(1, cy, cx * 2 + 1)] : [at(1, cy, cx), at(2, cy, cx)];
      out.set([...pixel(at(0, y, x), u, v, m), 255], (y * w + x) * 4);
    }
  }
  return out;
}

Deno.test('yuv: every layout, matrix, width tail, stride and clamp converts to the per-pixel bytes on this build', () => {
  let seed = 0x9e3779b9;
  const next = () => (seed = (seed ^ (seed << 13)) >>> 0, seed = (seed ^ (seed >>> 17)) >>> 0, seed = (seed ^ (seed << 5)) >>> 0);
  for (const format of Object.keys(FORMATS) as FormatName[]) {
    for (const [w, h] of [[1, 1], [2, 1], [7, 3], [9, 2], [16, 2], [33, 5], [130, 3], [1876, 4], [640, 480]]) {
      const layout: { offset: number; stride: number }[] = [];
      let length = 0;
      for (const [rowBytes, rows] of planes(format, w, h)) {
        layout.push({ offset: length, stride: rowBytes + 3 });
        length += (rowBytes + 3) * rows;
      }
      for (const fill of [0, 1, 2]) {
        const src = Uint8Array.from(
          { length },
          () => fill === 0 ? next() & 255 : fill === 1 ? (next() & 1) * 255 : [16, 235, 240, 0, 255][next() % 5],
        );
        for (let m = 0; m < MATRICES.length; m++) {
          const actual = core().frameToRGBA(src, FORMATS[format], layout, w, h, m);
          const expected = reference(src, format, layout, w, h, MATRICES[m]);
          const first = actual.findIndex((v, i) => v !== expected[i]);
          assertEquals(first, -1, `${format} ${w}x${h} fill ${fill} matrix ${m}: first differing byte ${first}`);
        }
      }
    }
  }
});

// The HDR conversion (rust/core/src/yuv/hdr.rs) through both entry points, on this build: PQ SDR white (100 nits) and
// HLG reference white (75 %) land on 255, black on 0, and pixels above white are counted once whichever thread converts
// them; planes and RGB give the same bytes for the same coded value. Codes: transfer × 8 + matrix × 2 + full range.
Deno.test('yuv: HDR planes and coded R′G′B′ convert to sRGB with white at 255 and highlights counted, on this build', () => {
  const pq = (nits: number) => {
    const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875, p = (nits / 10000) ** m1;
    return ((c1 + c2 * p) / (1 + c3 * p)) ** m2;
  };
  const w = 640, h = 64, n = w * h;
  // Columns: black, SDR white, 1000 nits (above white), repeating; the frame is large enough to be split across threads.
  const levels = [0, pq(100), pq(1000)];
  const value = (x: number) => levels[x % 3];
  // I444 full range, BT.2020 matrix: grey has Cb = Cr = 128, Y = the coded value.
  const planes = new Uint8Array(n * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      planes[y * w + x] = Math.round(value(x) * 255);
      planes[n + y * w + x] = planes[2 * n + y * w + x] = 128;
    }
  }
  const layout = [{ offset: 0, stride: w }, { offset: n, stride: w }, { offset: 2 * n, stride: w }];
  const report = { above: -1 };
  const fromPlanes = core().frameToRGBA(planes, FORMATS.I444, layout, w, h, 8 + 4 + 1, undefined, report);
  const rgb = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) rgb.set([planes[i], planes[i], planes[i], 255], i * 4);
  const above = core().hdrToRGBA(rgb, 'rgba8', w, h, 'pq');
  const expectedAbove = h * Math.ceil((w - 2) / 3);
  assertEquals(report.above, expectedAbove);
  assertEquals(above, expectedAbove);
  for (let x = 0; x < 3; x++) {
    // 8-bit PQ codes SDR white as 129.6 → 130, a hair above white: 255 either way.
    assertEquals([...fromPlanes.subarray(x * 4, x * 4 + 3)], [[0, 0, 0], [255, 255, 255], [255, 255, 255]][x], `planes column ${x}`);
  }
  assertEquals(rgb, new Uint8Array(fromPlanes.buffer, fromPlanes.byteOffset, fromPlanes.length), 'planes and RGB entry points');
});
