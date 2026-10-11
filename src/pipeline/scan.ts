// Shell around the scan pass. The pass itself — duplicate detection, the analysis gray, features, motion against the
// previous frame and the long-baseline retry, layer learning, the scan/ and scan-features/ rows, the per-frame
// diagnostics and the regions at the end — is the engine's scan session (rust/engine/src/scan.rs). This file is the
// host around it: the decode loop, copying each frame into the session, the WebGPU gray when that backend runs,
// storing rows in 24-row batches, the facts only the host knows (compute backend, frame conversion, the frame
// reference image), formatting the session's diagnostics with the catalogue, failure classification, progress,
// pause and stop. The decode-loop skeleton mirrors solve()'s and render()'s, but each pass keeps its own loop: the
// three differ enough in their failure wording and, for render(), its one-frame lookahead, that a shared skeleton
// would obscure the ordering each one guarantees. prefixOnly() (context.ts) factors out the one shared piece.
import { conversionDiagnostics } from '../media/conversion-report.ts';
import type { Diagnostic, RGBA } from '../types.ts';
import { RegionAtlas } from '../core/layers.ts';
import { core, coreBuild, type EngineDiagnostic, type ScanSession } from '../core/wasm.ts';
import { analysisFactor } from '../core/raster.ts';
import { releaseUnlessHeld } from '../media/pool.ts';
import { encodeRGBA } from '../codec/png.ts';
import { pad } from '../core/math.ts';
import { t } from '../i18n/index.ts';
import { prefixOnly, type RunContext, StorageError } from './context.ts';
/** Diagnostics whose catalogue entry has an `action` the pass has always attached. */
const WITH_ACTION = new Set(['LOW_TEXTURE_UNOBSERVABLE', 'AUTOMATIC_LAYER_MASK']);
const format = t as unknown as (key: string, params?: Record<string, number>) => string;
/** One of the session's structured diagnostics as the journal row the page has always written: the zh (or en) text
 *  from the catalogue, in the field order the rows have. */
function hostDiagnostic(d: EngineDiagnostic): Diagnostic {
  return {
    code: d.code,
    severity: d.severity,
    ...(d.time !== undefined ? { time: d.time } : {}),
    ...(d.frame !== undefined ? { frame: d.frame } : {}),
    message: format(`diag.${d.code}.message`, d.params),
    ...(WITH_ACTION.has(d.code) ? { action: format(`diag.${d.code}.action`) } : {}),
    // An unresolved motion has no confidence at all; the row has always said so.
    ...(d.code === 'UNRESOLVED_MOTION' ? { confidence: 0 } : {}),
  };
}
/** Per-pass state, as fields rather than closed-over locals; the small methods below are the pass's sub-steps. */
class ScanPass {
  private session: ScanSession | undefined;
  // Mixed scan/ (ScanRecord) and scan-features/ (CompactFeatures) rows batched together; both are scratch that
  // solve() consumes once and this run deletes afterwards, so one flush cadence for both is enough.
  private readonly pending: { key: string; value: unknown }[] = [];
  private storageFailed = false;
  private endedNaturally = false;
  // Set by analyzeFrame() once a stop request was honoured or a per-frame failure ended the pass, so run()'s
  // loop can break right after the call that set it, without threading a stop signal back through a return value.
  private stop = false;
  constructor(private readonly ctx: RunContext) {}
  /** What only the host knows about the first frame: the COMPUTE_BACKEND diagnostic (compute backend and core build,
   * known only once an actual frame has been analysed), how decoded frames became pixels, and — presentation-only —
   * the frame-reference PNG a "context" framing mode needs later. An encode/storage failure on the reference must not
   * abort the run, just demote to a warning: buildFramedCanvas already skips framing when this row is missing. */
  private async firstFrameFacts(frame: { index: number; image: RGBA }): Promise<void> {
    await this.ctx.diagnostics.emit({
      code: 'COMPUTE_BACKEND',
      severity: 'info',
      message: t('diag.COMPUTE_BACKEND.message', {
        backend: this.ctx.computer.stats.backend,
        reason: this.ctx.computer.stats.reason,
        variant: coreBuild().variant,
        threads: coreBuild().threads,
        coreReason: coreBuild().reason,
      }),
      detail: { ...this.ctx.computer.stats, core: coreBuild() },
    });
    // How decoded frames became pixels (decoding sources only), with warnings for what the conversion could not do well.
    const conversion = this.ctx.source.conversionReport?.();
    if (conversion) {
      for (const diagnostic of conversionDiagnostics(conversion, this.ctx.source.info)) await this.ctx.diagnostics.emit(diagnostic);
    }
    if (this.ctx.project.settings.framing === 'context') {
      try {
        await this.ctx.store.put('frame-reference', {
          frame: frame.index,
          image: new Blob([await encodeRGBA(frame.image)], { type: 'image/png' }),
        });
      } catch (error) {
        await this.ctx.diagnostics.emit({
          code: 'PRESENTATION_REFERENCE_FAILED',
          severity: 'warning',
          message: String(error),
          action: t('diag.PRESENTATION_REFERENCE_FAILED.action'),
        });
      }
    }
  }
  /** One decoded frame's worth of work: size the run on frame 0, step the session, persist its rows, emit its
   * diagnostics, and report progress. Sets `this.stop` (never breaks itself — run()'s loop owns the decode order) on
   * a stop request, an unrecoverable per-frame failure, or a rethrow. */
  private async analyzeFrame(frame: { index: number; time: number; duration: number; image: RGBA }): Promise<void> {
    // The decode step (next()) and this per-frame body are two separate try blocks — this one and run()'s
    // around it — so a body failure (algorithm or storage) is never blamed on the decoder, and a decoder
    // failure is never misclassified as an analysis or storage error.
    let released = false;
    const release = () => {
      if (!released) releaseUnlessHeld(frame.image);
      released = true;
    };
    try {
      if (frame.index === 0) {
        // Provisional until now: a CONTAINER_SIZE_MISMATCH notice on this very frame may just have rewritten
        // source.info.width/height, so the factor is derived only after that can no longer change.
        this.ctx.factor = analysisFactor(this.ctx.source.info.width, this.ctx.source.info.height, this.ctx.project.settings.analysisSize);
        this.ctx.refineRadius = Math.max(3, Math.ceil(this.ctx.factor / 2) + 1);
        this.session = this.ctx.scan = core().scanSession(this.ctx.source.info.width, this.ctx.source.info.height, this.ctx.factor);
      }
      // A frame whose geometry differs from the run's is rejected before it reaches the session.
      this.ctx.checkGeometry(frame.image);
      const session = this.session!;
      // The native frame enters the session once; a duplicate needs no analysis gray, and without WebGPU the
      // session downscales it itself.
      session.write(frame.image);
      const gray = session.isDuplicate() ? undefined : await this.ctx.computer.hostGray(frame.image, this.ctx.factor);
      const step = session.push(frame.index, frame.time, frame.duration, gray);
      if (step.record.duplicate) this.ctx.duplicates++;
      if (step.first) await this.firstFrameFacts(frame);
      // The session holds its own copy; nothing in this pass reads the decoded image after this.
      release();
      this.pending.push({ key: `scan/${pad(frame.index)}`, value: step.record });
      if (step.features) {
        this.pending.push({ key: `scan-features/${pad(frame.index)}`, value: step.features });
      }
      if (this.pending.length >= 24) {
        await this.ctx.commitRows(this.pending);
      }
      this.ctx.project.frames = frame.index + 1;
      for (const diagnostic of step.diagnostics) await this.ctx.diagnostics.emit(hostDiagnostic(diagnostic));
      await this.ctx.report(frame.index + 1, frame.time, t('progress.scanFrame'));
      if (this.ctx.stopRequested) {
        this.ctx.honourStop();
        this.stop = true;
      }
    } catch (error) {
      // Nothing else in this pass holds the decoded image, so it goes back to the pool instead of leaking into its
      // "outstanding" count for the rest of the (now stopping) pass.
      release();
      if (!this.ctx.project.frames) {
        throw error;
      }
      this.ctx.partial = true;
      if (error instanceof StorageError) {
        this.storageFailed = true;
        // Storage is failing: mark partial and stop, do not attempt another write. The diagnostic itself goes
        // through the journal only if that journal write succeeds.
        try {
          await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'scan', this.ctx.project.frames, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
        this.stop = true;
        return;
      }
      // A frame-geometry mismatch (mid-recording rotation/resolution change) is a source/decoder-level anomaly,
      // not an algorithmic one, even though only the body notices it once it already has the frame in hand;
      // it is reported the same way a decode failure is.
      if (error instanceof Error && error.message.startsWith('FRAME_GEOMETRY_CHANGED')) {
        await this.ctx.diagnostics.emit(prefixOnly('DECODE_PREFIX_ONLY', 'scan', this.ctx.project.frames, error));
        this.stop = true;
        return;
      }
      await this.ctx.diagnostics.emit(prefixOnly('ANALYSIS_PREFIX_ONLY', 'scan', this.ctx.project.frames, error));
      this.stop = true;
    }
  }
  /** The decode loop: mirrors solve()'s and render()'s shape (see the file header), but no lookahead — each
   * decoded frame is analysed immediately. */
  private async run(): Promise<void> {
    const it = this.ctx.source.frames();
    try {
      while (true) {
        await this.ctx.checkpoint();
        let step: Awaited<ReturnType<typeof it.next>>;
        try {
          step = await it.next();
        } catch (error) {
          if (!this.ctx.project.frames) {
            throw error;
          }
          this.ctx.partial = true;
          await this.ctx.diagnostics.emit(prefixOnly('DECODE_PREFIX_ONLY', 'scan', this.ctx.project.frames, error));
          break;
        }
        if (step.done) {
          this.endedNaturally = true;
          break;
        }
        await this.analyzeFrame(step.value);
        if (this.stop) {
          break;
        }
      }
    } finally {
      // Switching from for-await-of to manual next() calls lost the implicit return() an early break used to
      // get for free; restore it explicitly so the decoder is released on every exit path.
      try {
        await it.return(undefined);
      } catch { /* already unwinding */ }
    }
  }
  /** Trailing commit of whatever scan/scan-features rows never reached a 24-row batch, the scan-vs-source
   * frame-count mismatch check, and the source's own decode notices (each re-emitted as a diagnostic). */
  private async trailingCommit(): Promise<void> {
    if (this.pending.length && !this.storageFailed) {
      // Routed through commitRows (not a bare store.putMany) so a quota/transaction failure on this trailing
      // <24-row batch is classified and handled the same way an in-loop flush failure is — partial and
      // PERSISTENCE_PREFIX_ONLY — instead of escaping scan() entirely as an unclassified top-level error.
      try {
        await this.ctx.commitRows(this.pending);
      } catch (error) {
        this.ctx.partial = true;
        this.storageFailed = true;
        try {
          await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'scan', this.ctx.project.frames, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
      }
    }
    if (this.endedNaturally && this.ctx.source.info.frameCount !== undefined) {
      const preroll = this.ctx.source.info.notices?.find((n) => n.code === 'NEGATIVE_TIMESTAMP_SKIPPED')?.count || 0;
      await this.ctx.passMismatch('scan', this.ctx.source.info.frameCount - preroll, this.ctx.project.frames);
    }
    for (const notice of this.ctx.source.info.notices || []) {
      await this.ctx.diagnostics.emit({
        code: notice.code,
        severity: 'warning',
        message: notice.message,
        count: notice.count,
        detail: { count: notice.count },
      });
    }
  }
  /** Region finalisation: the session builds the regions (none if no frame was analysed) and the diagnostics about
   * their shape; the host builds the region atlas, persists the regions row and journals the diagnostics. */
  private async finalizeRegions(): Promise<void> {
    const { width, height } = this.ctx.source.info;
    // A run that analysed no frame has no session yet; an empty one still reports the layout diagnostics.
    this.session ??= this.ctx.scan = core().scanSession(width, height, this.ctx.factor);
    const { regions, diagnostics } = this.session.finish(this.ctx.project.settings.regions);
    this.ctx.regions = regions;
    this.ctx.atlas = new RegionAtlas(this.ctx.regions, width, height);
    this.ctx.project.regions = this.ctx.regions.map(({ mask: _mask, ...r }) => r);
    await this.ctx.store.put('regions', this.ctx.regions);
    for (const diagnostic of diagnostics) await this.ctx.diagnostics.emit(hostDiagnostic(diagnostic));
    await this.ctx.diagnostics.flush();
    await this.ctx.persist();
  }
  /** Runs the whole pass: the decode loop, the trailing commit, then region finalisation. */
  async execute(): Promise<void> {
    this.ctx.phase = 'scanning';
    try {
      await this.run();
      await this.trailingCommit();
      await this.finalizeRegions();
    } finally {
      this.session?.free();
      this.ctx.scan = undefined;
    }
  }
}
export async function scan(ctx: RunContext): Promise<void> {
  await new ScanPass(ctx).execute();
}
