// Reveal stage (docs/ARCHITECTURE.md §七): after the compositor has written every canvas, four more frame-major
// passes replace what overlays burned in — a composer bar, a floating button, a scrollbar thumb, a cursor, a
// fade veil — with the cleanest observation of the same page content, and give content that really changed over
// time a single moment. The algorithm is rust/core/src/reveal/; this shell decodes, feeds placements and copies
// the chosen 16×16 blocks into the tiles.
import type { CanvasMeta, Placement, Rect } from '../types.ts';
import { iterate } from '../storage/db.ts';
import type { Tile } from '../storage/tiles.ts';
import { QUALITY_BLOCK } from '../storage/tiles.ts';
import { core, type FrameRing, type ResidentFrame } from '../core/wasm.ts';
import type { RevealDecision, RevealPass, RevealRun, RevealWrite } from '../core/wasm/reveal.ts';
import { REVEAL_PASSES, revealCanvasBytes, revealLayerBytes } from '../core/wasm/reveal.ts';
import { resolveRasterPose } from '../core/raster.ts';
import { releaseUnlessHeld } from '../media/pool.ts';
import { t } from '../i18n/index.ts';
import type { RunContext } from './context.ts';

interface ObservationRow {
  frame: number;
  time: number;
  decisions: { canvasId: string; placement: Placement; skipped?: boolean }[];
}

/** Quality a block taken from a clean, agreeing view is shown with (the viewer's low-quality line is 153). */
const REVEALED_QUALITY = 204;
/** `rust/core/src/reveal/blocks.rs::Kind` values that settle a block (the rest only rewrite pixels). */
const SETTLED_KINDS = new Set([1, 2, 5]);
/** `Kind::Fallback`: per-pixel values that may come from several frames, so no frame owns the block. */
const MIXED_KIND = 4;
/** Core memory kept free beside the reveal's own estimate: scratch arenas, tile encoding, allocator slack. */
const REVEAL_MARGIN = 128 * 1024 * 1024;
/** Frames the reveal keeps resident (`frameRing` below). */
const RING_FRAMES = 3;

/** Whether `bytes` more (and the margin) can still be allocated in the core; if not, the run keeps the compositor's
 *  pixels and says why (a run split into 87 fragment canvases needed 3 GB here and aborted the threaded core at its
 *  2 GB ceiling). */
async function fits(ctx: RunContext, bytes: number, stage: string): Promise<boolean> {
  if (core().canAllocate(bytes + REVEAL_MARGIN)) return true;
  const mb = Math.round(bytes / 1048576);
  await ctx.diagnostics.emit({
    code: 'REVEAL_SKIPPED',
    severity: 'warning',
    message: t('diag.REVEAL_SKIPPED.message', { need: mb }),
    action: t('diag.REVEAL_SKIPPED.action'),
    detail: { stage, needMB: mb, coreMB: Math.round(core().memoryBytes / 1048576) },
  });
  return false;
}

export async function reveal(ctx: RunContext): Promise<void> {
  if (ctx.stopped || ctx.partial || !ctx.atlas || ctx.processed < 2) return;
  const metas: CanvasMeta[] = [];
  for await (const { value } of iterate<CanvasMeta>(ctx.store, 'canvas/')) {
    if (value.kind === 'moving') metas.push(value);
  }
  const layers = ctx.regions.filter((r) => r.kind === 'moving');
  if (!metas.length || !layers.length) return;
  const started = performance.now();
  ctx.phase = 'revealing';
  const { width, height } = ctx.source.info;
  const exports = core().exports;
  const need = metas.reduce((sum, m) => sum + revealCanvasBytes(exports, m.bounds), 0) +
    layers.reduce((sum, r) => sum + revealLayerBytes(exports, r.rect), 0) + RING_FRAMES * width * height * 4;
  if (!await fits(ctx, need, 'canvases')) return;
  const run = core().revealRun(width, height, ctx.noise);
  let ring: FrameRing | undefined;
  try {
    const layerSlot = new Map(layers.map((r) => [r.id, run.layer(r.rect, ctx.atlas!.code(r))]));
    const canvasSlot = new Map(metas.map((m) => [m.id, run.canvas(m.bounds)]));
    const canvasId = metas.map((m) => m.id);
    // Placements of every moving layer, per frame, at the compositor's integer raster pose. Blind ones (too little
    // texture to track: the solve held the pose and the compositor painted nothing) are marked, and the core decides
    // which of them count.
    const observed: { frame: number; time: number; decisions: RevealDecision[]; blind: boolean[] }[] = [];
    for await (const { value } of iterate<ObservationRow>(ctx.store, 'observation/')) {
      const decisions: RevealDecision[] = [], blind: boolean[] = [];
      for (const d of value.decisions) {
        const canvas = canvasSlot.get(d.canvasId), layer = layerSlot.get(d.placement.layer);
        if ((d.skipped && !d.placement.skip) || canvas === undefined || layer === undefined) continue;
        const pose = resolveRasterPose(d.placement.x, d.placement.y);
        decisions.push({ layer, canvas, x: pose.rasterX, y: pose.rasterY, occlusions: d.placement.occlusions as Rect[] | undefined });
        blind.push(!!d.skipped);
      }
      observed.push({ frame: value.frame, time: value.time, decisions, blind });
    }
    const admitted = run.admitted(observed.map((o) => o.decisions), observed.map((o) => o.blind));
    const plans = new Map(observed.map((o, i) => [o.frame, { time: o.time, decisions: o.decisions.filter((_, k) => admitted[i][k]) }]));
    await ingestCanvases(ctx, run, metas, canvasSlot);
    ring = core().frameRing(RING_FRAMES, width, height);
    for (const pass of REVEAL_PASSES) {
      // The write pass adds per-pixel state for the blocks no clean view covered; how many is known only now.
      if (pass === 'write' && !await fits(ctx, run.fallbackBytes(), 'fallback')) return;
      run.begin(pass);
      if (pass === 'write') await supplyFallbacks(ctx, run, metas, canvasSlot);
      await sweep(ctx, run, ring, plans, pass, canvasId);
      if (ctx.stopped || ctx.partial) return;
    }
    for (const meta of metas) {
      const slot = canvasSlot.get(meta.id)!;
      const size = ctx.tiles.size;
      for (const d of run.finish(slot)) {
        const tile = await ctx.tiles.get(meta.id, Math.floor(d.gx * QUALITY_BLOCK / size), Math.floor(d.gy * QUALITY_BLOCK / size));
        writeBlock(tile, size, d.gx, d.gy, d.frame, d.kind, (row) => d.rgba.subarray(row * 64, row * 64 + 64), true);
      }
      const provenance = run.provenance(slot);
      if (provenance) await ctx.store.put(`reveal/${meta.id}`, { version: 1, ...provenance });
    }
    await ctx.tiles.flush();
    const summary = run.summary();
    ctx.timings.revealMS = performance.now() - started;
    await ctx.store.put('reveal-summary', { ...summary, seconds: ctx.timings.revealMS / 1000 });
  } finally {
    ring?.free();
    run.free();
  }
}

/** Feeds every tile of each moving canvas to its reference. */
async function ingestCanvases(ctx: RunContext, run: RevealRun, metas: CanvasMeta[], slots: Map<string, number>): Promise<void> {
  const size = ctx.tiles.size;
  for (const meta of metas) {
    const b = meta.bounds;
    for (let ty = Math.floor(b.y / size); ty * size < b.y + b.height; ty++) {
      for (let tx = Math.floor(b.x / size); tx * size < b.x + b.width; tx++) {
        const tile = await ctx.tiles.get(meta.id, tx, ty);
        run.ingest(slots.get(meta.id)!, tx * size, ty * size, size, tile.pixels, tile.coverage);
        await ctx.checkpoint();
      }
    }
  }
}

/** The compositor's pixels of every block the write pass may keep or replace per pixel. */
async function supplyFallbacks(ctx: RunContext, run: RevealRun, metas: CanvasMeta[], slots: Map<string, number>): Promise<void> {
  const size = ctx.tiles.size, rgba = new Uint8Array(QUALITY_BLOCK * QUALITY_BLOCK * 4);
  for (const meta of metas) {
    const slot = slots.get(meta.id)!;
    for (const [gx, gy] of run.fallbacks(slot)) {
      const x0 = gx * QUALITY_BLOCK, y0 = gy * QUALITY_BLOCK;
      const tx = Math.floor(x0 / size), ty = Math.floor(y0 / size), lx = x0 - tx * size, ly = y0 - ty * size;
      const tile = await ctx.tiles.get(meta.id, tx, ty);
      for (let row = 0; row < QUALITY_BLOCK; row++) {
        const p = (ly + row) * size + lx;
        rgba.set(tile.pixels.subarray(p * 4, (p + QUALITY_BLOCK) * 4), row * QUALITY_BLOCK * 4);
        for (let x = 0; x < QUALITY_BLOCK; x++) {
          const q = p + x;
          if (!(tile.coverage[q >> 3] & (1 << (q & 7)))) rgba[(row * QUALITY_BLOCK + x) * 4 + 3] = 0;
        }
      }
      run.setMain(slot, gx, gy, rgba);
    }
  }
}

/** One decode of the solved frames through `pass`. Frames the pass does not read are decoded but not converted. */
async function sweep(
  ctx: RunContext,
  run: RevealRun,
  ring: FrameRing,
  plans: Map<number, { time: number; decisions: RevealDecision[] }>,
  pass: RevealPass,
  canvasId: string[],
): Promise<void> {
  const message = t(`progress.reveal.${pass}`), offset = REVEAL_PASSES.indexOf(pass);
  const started = performance.now();
  let coreMS = 0, writeMS = 0, waitMS = 0, uploadMS = 0, converted = 0, waited = performance.now();
  const wanted = run.wanted(Array.from({ length: ctx.processed }, (_, i) => plans.get(i)?.decisions || []));
  const want = (index: number) => wanted[index] === 1;
  // Frames the run converts on the CPU come as planes and convert straight into the ring (src/media/convert.ts).
  const it = ctx.source.sparseFrames ? ctx.source.sparseFrames(want, { planes: true }) : ctx.source.frames();
  let prev: ResidentFrame | undefined, prev2: ResidentFrame | undefined, last = -1;
  try {
    for await (const frame of it) {
      waitMS += performance.now() - waited;
      if (frame.index >= ctx.processed) {
        releaseUnlessHeld(frame.image);
        break;
      }
      let mark = performance.now(), current: ResidentFrame | undefined;
      if ('planes' in frame) {
        const planes = frame.planes;
        try {
          if (want(frame.index)) {
            current = ring.fill(frame.index, planes.width, planes.height, (slot) => core().planesToCore(planes, slot.ptr));
            converted++;
          }
        } finally {
          planes.release();
        }
      } else if (frame.image && want(frame.index)) {
        current = ring.upload(frame.index, frame.image);
        converted++;
      }
      releaseUnlessHeld(frame.image);
      uploadMS += performance.now() - mark;
      mark = performance.now();
      run.frame(frame.index, current, prev, prev2, ctx.atlas!.resident, plans.get(frame.index)?.decisions || []);
      coreMS += performance.now() - mark;
      mark = performance.now();
      if (pass === 'write' && prev) await applyWrites(ctx, run.writes(), prev, canvasId);
      writeMS += performance.now() - mark;
      prev2 = prev;
      prev = current;
      last = frame.index;
      await ctx.report(
        frame.index + 1,
        frame.time,
        message,
        (offset + (frame.index + 1) / Math.max(1, ctx.processed)) / REVEAL_PASSES.length,
      );
      waited = performance.now();
      if (ctx.stopRequested) {
        ctx.honourStop();
        return;
      }
    }
  } finally {
    try {
      await it.return(undefined);
    } catch { /* already unwinding */ }
  }
  if (last >= 0) {
    run.end(prev, prev2, ctx.atlas!.resident);
    if (pass === 'write' && prev) await applyWrites(ctx, run.writes(), prev, canvasId);
  }
  ctx.timings[`reveal.${pass}MS`] = performance.now() - started;
  ctx.timings[`reveal.${pass}.coreMS`] = coreMS;
  ctx.timings[`reveal.${pass}.writeMS`] = writeMS;
  ctx.timings[`reveal.${pass}.waitMS`] = waitMS;
  ctx.timings[`reveal.${pass}.uploadMS`] = uploadMS;
  ctx.timings[`reveal.${pass}.frames`] = converted;
  ctx.recordSource(`reveal.${pass}`);
}

/** Copies each written block from the resident vote frame into its tile, one tile fetch per tile. */
async function applyWrites(ctx: RunContext, writes: RevealWrite[], source: ResidentFrame, canvasId: string[]): Promise<void> {
  const size = ctx.tiles.size, w = source.width, groups = new Map<string, RevealWrite[]>();
  for (const wr of writes) {
    const key = `${wr.canvas} ${Math.floor(wr.gx * QUALITY_BLOCK / size)} ${Math.floor(wr.gy * QUALITY_BLOCK / size)}`;
    const group = groups.get(key);
    if (group) group.push(wr);
    else groups.set(key, [wr]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    const tile = await ctx.tiles.get(
      canvasId[first.canvas],
      Math.floor(first.gx * QUALITY_BLOCK / size),
      Math.floor(first.gy * QUALITY_BLOCK / size),
    );
    // A fresh view per tile: the fetch above may have run other core calls that grew memory.
    const pixels = source.view();
    for (const wr of group) {
      writeBlock(tile, size, wr.gx, wr.gy, wr.frame, wr.kind, (row) => {
        const at = ((wr.sy + row) * w + wr.sx) * 4;
        return pixels.subarray(at, at + QUALITY_BLOCK * 4);
      }, false);
    }
  }
}

/** Writes one world block of `tile` (16 rows of RGBA from `row`). With `masked`, pixels whose alpha is 0 keep the
 *  canvas. */
function writeBlock(
  tile: Tile,
  size: number,
  gx: number,
  gy: number,
  frame: number,
  kind: number,
  row: (r: number) => Uint8Array,
  masked: boolean,
): void {
  const lx = gx * QUALITY_BLOCK - Math.floor(gx * QUALITY_BLOCK / size) * size;
  const ly = gy * QUALITY_BLOCK - Math.floor(gy * QUALITY_BLOCK / size) * size;
  const settled = SETTLED_KINDS.has(kind);
  for (let r = 0; r < QUALITY_BLOCK; r++) {
    const src = row(r), p = (ly + r) * size + lx;
    if (!masked) {
      // A whole row of an opaque frame: the alpha comes with it, and the row's 16 coverage/provisional bits are two
      // whole bytes (blocks start on a multiple of 16 pixels).
      tile.pixels.set(src, p * 4);
      tile.coverage[p >> 3] = tile.coverage[(p >> 3) + 1] = 0xff;
      if (settled) tile.provisional[p >> 3] = tile.provisional[(p >> 3) + 1] = 0;
      continue;
    }
    for (let x = 0; x < QUALITY_BLOCK; x++) {
      if (src[x * 4 + 3] !== 255) continue;
      const q = p + x;
      tile.pixels.set(src.subarray(x * 4, x * 4 + 3), q * 4);
      tile.pixels[q * 4 + 3] = 255;
      tile.coverage[q >> 3] |= 1 << (q & 7);
      if (settled) tile.provisional[q >> 3] &= ~(1 << (q & 7));
    }
  }
  const b = (ly / QUALITY_BLOCK) * (size / QUALITY_BLOCK) + lx / QUALITY_BLOCK;
  // A whole block copied from one frame is owned by it; per-pixel fallback values keep the compositor's owner.
  if (kind !== MIXED_KIND) tile.owner[b] = frame + 1;
  if (settled) {
    tile.conflicts[b] = 0;
    tile.quality[b] = Math.max(tile.quality[b], REVEALED_QUALITY);
  }
  tile.dirty = true;
  tile.touched = performance.now();
}
