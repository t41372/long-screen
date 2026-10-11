/** Checks shared by the converters (src/media/convert.ts, src/media/gpu-convert.ts): which YUV matrix a frame takes,
 *  and how close one conversion of a frame must be to another to take a run. Dependency-free, because
 *  convert-worker.ts is bundled on its own and must not pull in src/core/wasm.ts. */
/** Index into rust/long-screen/src/kernels/yuv.rs `MATRICES`, or undefined for BT.2020 (its gamut conversion to sRGB is left to
 *  the canvas) or for GBR/RGB-native planes (there is no YUV matrix to invert at all — a 4:4:4 stream whose colour
 *  space reports `matrix: 'rgb'`, or, measured on VP9 Profile 1's GBR planes decoded by Chrome, an I444 frame whose
 *  `VideoFrame.colorSpace.matrix` comes back `null`; declined here rather than left to the first-frame agreement
 *  check, which a genuinely close-but-wrong YUV-math conversion of RGB planes is not guaranteed to fail loudly
 *  enough to catch). A null/absent matrix on any *other* layout (I420/I422/NV12) is a real, ordinary untagged YUV
 *  stream — most H.264 recordings never tag one at all — and is still taken as BT.709 when HD and BT.601 otherwise. */
export function matrixCode(colorSpace: VideoColorSpace | undefined, format: string | undefined, height: number): number | undefined {
  if (colorSpace && ((colorSpace.matrix as string) === 'rgb' || (colorSpace.matrix === null && format === 'I444'))) {
    return undefined;
  }
  const matrix: string = colorSpace?.matrix ?? (height >= 720 ? 'bt709' : 'smpte170m');
  if (matrix === 'bt2020-ncl' || matrix === 'bt2020-cl') return undefined;
  return (matrix === 'bt709' ? 0 : 2) + (colorSpace?.fullRange ? 1 : 0);
}
/** The HDR transfer a stream's frames code, or undefined for SDR: the container's tag first, because WebKit hands
 *  a PQ or HLG frame back tagged as sRGB (bt709 / iec61966-2-1, measured in Safari 26 and 27), then the frame's. */
export function hdrTransfer(container: VideoColorSpaceInit | undefined, frame?: VideoColorSpaceInit | null): 'pq' | 'hlg' | undefined {
  // TypeScript's DOM types list only the SDR transfers; browsers report 'pq' and 'hlg'.
  for (const transfer of [container?.transfer, frame?.transfer] as (string | null | undefined)[]) {
    if (transfer === 'pq' || transfer === 'hlg') return transfer;
  }
  return undefined;
}
/** rust/long-screen/src/kernels/yuv.rs `Signal` colour code: transfer × 8 + matrix × 2 + full range. */
export function colourCode(matrix: 'bt709' | 'bt601' | 'bt2020', fullRange: boolean, transfer: 'sdr' | 'pq' | 'hlg'): number {
  return { sdr: 0, pq: 8, hlg: 16 }[transfer] + { bt709: 0, bt601: 2, bt2020: 4 }[matrix] + (fullRange ? 1 : 0);
}
const MATRIX_NAMES: Record<string, 'bt709' | 'bt601' | 'bt2020'> = {
  bt709: 'bt709',
  smpte170m: 'bt601',
  bt470bg: 'bt601',
  'bt2020-ncl': 'bt2020',
};
/** Colour codes worth trying for an HDR frame's 8-bit planes, most likely first. A browser's frame tags are not to
 *  be trusted here: WebKit hands HEVC PQ back as full-range NV12 holding the stream's own BT.2020 Y'CbCr while
 *  tagging it BT.709 — its range tag is right and its matrix tag wrong — so the container's matrix (BT.2020 when
 *  untagged) with the frame's range comes first, then the other pairings. A caller keeps the one that agrees best
 *  with a reference reading of the same frame. */
export function hdrCandidates(transfer: 'pq' | 'hlg', container?: VideoColorSpaceInit, frame?: VideoColorSpaceInit | null): number[] {
  const matrices = [MATRIX_NAMES[container?.matrix ?? 'bt2020-ncl'] ?? 'bt2020', MATRIX_NAMES[frame?.matrix ?? ''] ?? 'bt2020'];
  const range = frame?.fullRange ?? container?.fullRange ?? false;
  const codes = [];
  for (const full of [range, !range]) for (const matrix of matrices) codes.push(colourCode(matrix, full, transfer));
  return [...new Set(codes)];
}
/** How far the first planar frame may be from the same frame through the canvas: both are conversions of one
 *  decoded surface, differing by rounding, chroma filtering and (on Safari) colour management — a few levels on
 *  average. A misplaced plane is tens of levels off (WebKit's GStreamer copyTo was measured at a mean of 67 on a
 *  cropped H.264 frame). */
const PLANAR_MAX_MEAN = 8, PLANAR_FAR = 48, PLANAR_MAX_FAR_SHARE = 0.01;
export interface PlanarCheck {
  meanDiff: number;
  farShare: number;
}
/** Whether a converter's first frame is close enough to another conversion of the same frame to take the run. */
export function agrees(check: PlanarCheck): boolean {
  return check.meanDiff <= PLANAR_MAX_MEAN && check.farShare <= PLANAR_MAX_FAR_SHARE;
}
export function agreement(a: Uint8ClampedArray, b: Uint8ClampedArray): PlanarCheck {
  let sum = 0, far = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      sum += d;
      if (d > PLANAR_FAR) far++;
      n++;
    }
  }
  return { meanDiff: sum / n, farShare: far / n };
}
