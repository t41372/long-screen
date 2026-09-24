// Shell: the framing (bordered/context canvas) and pyramid (preview levels) stages run() drives after
// scan/solve/render. Both are presentation-only — a failure here must never turn a finished level-0
// reconstruction into partial/error, so each gets its own try/catch and only ever downgrades to a warning
// diagnostic. No algorithm lives here; buildFramedCanvas (core/framing.ts) and TileStore.buildPyramid do the work.
import type { CanvasMeta } from '../types.ts';
import { iterate } from '../storage/db.ts';
import { buildFramedCanvas } from '../core/framing.ts';
import { t } from '../i18n/index.ts';
import type { RunContext } from './context.ts';
/** Presentation-only: a failure here must never turn a finished level-0 reconstruction into partial/error, so it
 * gets its own try/catch and only ever downgrades to a warning diagnostic. Gated on `stopped` (not
 * `stopRequested`): a stop already honoured inside scan/solve/render resets `stopRequested` to false right after
 * breaking, so by the time run() gets here that flag alone can no longer tell a genuine stop apart from never
 * having been asked to stop at all. */
export async function presentFraming(ctx: RunContext): Promise<void> {
  if (ctx.project.settings.framing !== 'context' || ctx.stopped) return;
  try {
    ctx.phase = 'framing';
    const originals: CanvasMeta[] = [];
    for await (const { value } of iterate<CanvasMeta>(ctx.store, 'canvas/')) {
      if (value.kind === 'moving' && value.tileCount && !value.attachedTo) originals.push(value);
    }
    ctx.events.progress({
      phase: 'framing',
      fraction: 0,
      frames: ctx.project.renderedFrames,
      time: 0,
      message: t('progress.framingStart'),
    });
    for (const meta of originals) {
      const region = ctx.regions.find((r) => r.id === meta.layer)!;
      const framed = await buildFramedCanvas(ctx.store, ctx.tiles, meta, region, ctx.regions, () => ctx.checkpoint(), {
        onSkipped: (reason) => {
          void ctx.diagnostics.emit({
            code: 'PRESENTATION_TOO_SPARSE',
            severity: 'warning',
            message: reason,
            action: t('diag.PRESENTATION_TOO_SPARSE.action'),
          });
        },
      });
      if (framed) {
        ctx.project.canvasCount++;
        ctx.project.tiles += framed.tileCount;
      }
      if (ctx.stopRequested) {
        ctx.stopped = true;
        break;
      }
    }
    if (originals.length) {
      await ctx.diagnostics.emit({
        code: 'PRESENTATION_FRAME',
        severity: 'info',
        message: t('diag.PRESENTATION_FRAME.message'),
      });
    }
  } catch (error) {
    await ctx.diagnostics.emit({
      code: 'PRESENTATION_STAGE_FAILED',
      severity: 'warning',
      message: String(error),
      action: t('diag.PRESENTATION_STAGE_FAILED.action'),
    });
  }
}
/** Stop honoured anywhere up to and including framing means no pyramid: the stage is skipped outright, not
 * entered and cut short. Same `stopped` vs `stopRequested` reasoning as presentFraming's doc comment. */
export async function presentPyramid(ctx: RunContext): Promise<void> {
  if (ctx.stopped) return;
  try {
    let built = 0;
    for await (const { value: meta } of iterate<CanvasMeta>(ctx.store, 'canvas/')) {
      if (meta.tileCount) {
        await ctx.tiles.buildPyramid(meta, async () => {
          await ctx.checkpoint();
          await ctx.report(
            ctx.project.renderedFrames,
            meta.lastTime,
            t('progress.pyramidBuild'),
            built / Math.max(1, ctx.project.canvasCount),
            meta,
          );
        });
      }
      built++;
      if (ctx.stopRequested) {
        ctx.stopped = true;
        break;
      }
    }
  } catch (error) {
    await ctx.diagnostics.emit({
      code: 'PYRAMID_FAILED',
      severity: 'warning',
      message: String(error),
      action: t('diag.PYRAMID_FAILED.action'),
    });
  }
}
