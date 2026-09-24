// Shell: the framing (bordered/context canvas) and pyramid (preview levels) stages run() drives after
// scan/solve/render. Both are presentation-only — a failure here must never turn a finished level-0
// reconstruction into partial/error, so each gets its own try/catch and only ever downgrades to a warning
// diagnostic. No algorithm lives here; buildFramedCanvas (core/framing.ts) and TileStore.buildPyramid do the work.
import type { CanvasMeta } from '../types.ts';
import { iterate } from '../storage/db.ts';
import { buildFramedCanvas } from '../core/framing.ts';
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
      message: '保留原始外框；只延伸背景，不拉伸侧栏文字或重复图标。',
    });
    for (const meta of originals) {
      const region = ctx.regions.find((r) => r.id === meta.layer)!;
      const framed = await buildFramedCanvas(ctx.store, ctx.tiles, meta, region, ctx.regions, () => ctx.checkpoint(), {
        onSkipped: (reason) => {
          void ctx.diagnostics.emit({
            code: 'PRESENTATION_TOO_SPARSE',
            severity: 'warning',
            message: reason,
            action: '该画布的带外框呈现被跳过；页面坐标下的核心重建不受影响。',
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
        message:
          '带外框视图与原始二维内容分别保留。外框来自参考帧，延长部分仅为装饰背景，不算作已观察内容；不会拉伸或复制工具栏图标。其他 pane 在外框中只是参考快照。',
      });
    }
  } catch (error) {
    await ctx.diagnostics.emit({
      code: 'PRESENTATION_STAGE_FAILED',
      severity: 'warning',
      message: String(error),
      action: '带外框呈现阶段失败；页面坐标下的核心重建结果和状态不受影响。',
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
            '正在建立磁盘预览金字塔；原尺寸瓦片保持不变。',
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
      action: '预览金字塔构建失败；原尺寸瓦片不受影响，仍可正常查看和导出。',
    });
  }
}
