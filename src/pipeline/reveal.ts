// Reveal stage (docs/ARCHITECTURE.md §七): after the compositor has written every canvas, four more frame-major
// passes replace what overlays burned in — a composer bar, a floating button, a scrollbar thumb, a cursor, a fade
// veil — with the cleanest observation of the same page content, and give content that really changed over time a
// single moment. The stage is the engine's reveal session (rust/long-screen/src/engine/reveal.rs, over the algorithm in
// rust/long-screen/src/kernels/reveal/); this host reads the rows it asks for, brings tiles into the cache, decodes the recording
// once per pass, stores what it hands back, and keeps the clock, progress, pause and stop.
import type { CanvasMeta, Diagnostic } from '../types.ts';
import { iterate } from '../storage/db.ts';
import { core, type EngineDiagnostic } from '../core/wasm.ts';
import type { RevealObservedDecision, RevealPass, RevealSessionHandle } from '../core/wasm/reveal.ts';
import { REVEAL_PASSES } from '../core/wasm/reveal.ts';
import { releaseUnlessHeld } from '../media/pool.ts';
import { t } from '../i18n/index.ts';
import type { RunContext } from './context.ts';

/** Core memory kept free beside the reveal's own estimate: scratch arenas, tile encoding, allocator slack. A run split
 *  into 87 fragment canvases needed 3 GB here and aborted the threaded core at its 2 GB ceiling. */
const REVEAL_MARGIN = 128 * 1024 * 1024;

/** The session's `REVEAL_SKIPPED` as the journal row the page has always written. */
function skippedRow(d: EngineDiagnostic): Diagnostic {
  return {
    code: d.code,
    severity: d.severity,
    message: t('diag.REVEAL_SKIPPED.message', { need: d.params.need }),
    action: t('diag.REVEAL_SKIPPED.action'),
    detail: d.detail,
  };
}

export async function reveal(ctx: RunContext): Promise<void> {
  if (ctx.stopped || ctx.partial || !ctx.atlas || ctx.processed < 2) return;
  const metas: CanvasMeta[] = [];
  for await (const { value } of iterate<CanvasMeta>(ctx.store, 'canvas/')) {
    if (value.kind === 'moving') metas.push(value);
  }
  const atlas = ctx.atlas, { width, height } = ctx.source.info;
  const session = core().revealSession({
    width,
    height,
    noise: ctx.noise,
    tileSize: ctx.tiles.size,
    frames: ctx.processed,
    layers: ctx.regions.filter((r) => r.kind === 'moving').map((r) => ({ id: r.id, rect: r.rect, code: atlas.code(r) })),
    canvases: metas.map((m) => ({ id: m.id, bounds: m.bounds })),
  });
  let started = 0;
  try {
    for (;;) {
      const step = session.step(ctx.tiles.engine, performance.now());
      switch (step.kind) {
        case 'memory':
          if (!started) {
            started = performance.now();
            ctx.phase = 'revealing';
          }
          session.memory(core().canAllocate(step.bytes + REVEAL_MARGIN), core().memoryBytes);
          break;
        case 'observations':
          for await (const { value } of iterate<{ frame: number; decisions: RevealObservedDecision[] }>(ctx.store, 'observation/')) {
            session.observation(value.frame, value.decisions);
          }
          break;
        case 'tile':
          await ctx.tiles.load(step.canvas, step.x, step.y, step.level);
          break;
        case 'checkpoint':
          await ctx.checkpoint();
          break;
        case 'decode':
          if (!await sweep(ctx, session, step.pass, step.wanted)) return;
          break;
        case 'provenance':
          await ctx.store.put(`reveal/${step.canvas}`, { version: 1, ...step.provenance });
          break;
        case 'skipped':
          await ctx.diagnostics.emit(skippedRow(step.diagnostic));
          return;
        case 'revealed': {
          await ctx.tiles.flush();
          ctx.timings.revealMS = performance.now() - started;
          await ctx.store.put('reveal-summary', { ...step.summary, seconds: ctx.timings.revealMS / 1000 });
          return;
        }
        case 'nothing':
          return;
        default:
          throw new Error(`CORE_BAD_ARGUMENT: reveal step ${step.kind} out of turn.`);
      }
    }
  } finally {
    session.free();
  }
}

/** One decode of the solved frames through `pass`. Frames the pass does not read are decoded but not converted.
 *  Returns false when the run stopped. */
async function sweep(ctx: RunContext, session: RevealSessionHandle, pass: RevealPass, wanted: Uint8Array): Promise<boolean> {
  const message = t(`progress.reveal.${pass}`), offset = REVEAL_PASSES.indexOf(pass), labels = ctx.atlas!.resident;
  const { width, height } = ctx.source.info;
  const started = performance.now();
  let coreMS = 0, writeMS = 0, waitMS = 0, uploadMS = 0, converted = 0, waited = performance.now();
  const want = (index: number) => wanted[index] === 1;
  // Frames the run converts on the CPU come as planes and convert straight into the session's frame buffer
  // (src/media/convert.ts).
  const it = ctx.source.sparseFrames ? ctx.source.sparseFrames(want, { planes: true }) : ctx.source.frames();
  try {
    for await (const frame of it) {
      waitMS += performance.now() - waited;
      if (frame.index >= ctx.processed) {
        releaseUnlessHeld(frame.image);
        break;
      }
      let mark = performance.now();
      if ('planes' in frame) {
        const planes = frame.planes;
        try {
          if (want(frame.index)) {
            fits(planes, width, height);
            core().planesToCore(planes, session.frameBuffer());
            converted++;
          }
        } finally {
          planes.release();
        }
      } else if (frame.image && want(frame.index)) {
        const image = frame.image;
        fits(image, width, height);
        // Ask for the buffer before viewing core memory: handing it out can allocate a frame slot and grow memory.
        const ptr = session.frameBuffer();
        new Uint8Array(core().exports.memory.buffer).set(
          new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
          ptr,
        );
        converted++;
      }
      releaseUnlessHeld(frame.image);
      uploadMS += performance.now() - mark;
      mark = performance.now();
      session.push(frame.index, labels);
      coreMS += performance.now() - mark;
      mark = performance.now();
      await untilDone(ctx, session, 'nextFrame');
      writeMS += performance.now() - mark;
      await ctx.report(
        frame.index + 1,
        frame.time,
        message,
        (offset + (frame.index + 1) / Math.max(1, ctx.processed)) / REVEAL_PASSES.length,
      );
      waited = performance.now();
      if (ctx.stopRequested) {
        ctx.honourStop();
        return false;
      }
    }
  } finally {
    try {
      await it.return(undefined);
    } catch { /* already unwinding */ }
  }
  session.end(labels);
  await untilDone(ctx, session, 'passDone');
  ctx.timings[`reveal.${pass}MS`] = performance.now() - started;
  ctx.timings[`reveal.${pass}.coreMS`] = coreMS;
  ctx.timings[`reveal.${pass}.writeMS`] = writeMS;
  ctx.timings[`reveal.${pass}.waitMS`] = waitMS;
  ctx.timings[`reveal.${pass}.uploadMS`] = uploadMS;
  ctx.timings[`reveal.${pass}.frames`] = converted;
  ctx.recordSource(`reveal.${pass}`);
  return !ctx.stopped && !ctx.partial;
}

/** A decoded frame must have the run's size to go into the session's frame buffer. */
function fits(image: { width: number; height: number }, width: number, height: number): void {
  if (image.width !== width || image.height !== height) {
    throw new Error(`CORE_BAD_ARGUMENT: frame ${image.width}×${image.height} does not fit a ${width}×${height} reveal.`);
  }
}

/** Steps the session, bringing in the tiles its block copies need, until it reports `kind`. */
async function untilDone(ctx: RunContext, session: RevealSessionHandle, kind: 'nextFrame' | 'passDone'): Promise<void> {
  for (
    let step = session.step(ctx.tiles.engine, performance.now());
    step.kind !== kind;
    step = session.step(ctx.tiles.engine, performance.now())
  ) {
    if (step.kind !== 'tile') throw new Error(`CORE_BAD_ARGUMENT: reveal step ${step.kind} out of turn.`);
    await ctx.tiles.load(step.canvas, step.x, step.y, step.level);
  }
}
