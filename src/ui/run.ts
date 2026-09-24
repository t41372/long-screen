/** The reconstruction run lifecycle: starting it (settings + capability preflight), the busy/enablement state every
 *  other feature reads, `resetView`/`updateProject` (composed here because both touch project, canvas and
 *  diagnostic state at once), and the progress bar. */
import type { AppState } from './state.ts';
import { syncControls } from './state.ts';
import { $, NO_COMPRESSION_STREAM, phaseName, setReceiptOpen, timeText, toast } from './dom.ts';
import { preview } from './video.ts';
import { call } from './rpc.ts';
import { flightStart } from './flight.ts';
import { storeHash } from './source-file.ts';
import { t } from '../i18n/page.ts';
import { DEFAULT_SETTINGS, type Project, type Settings } from '../types.ts';
import type { WorkerProgress } from '../protocol.ts';
import type { Canvases } from './canvases.ts';
import type { Diagnostics } from './diagnostics.ts';
import type { TiledViewer } from './viewer.ts';

// static/index.html marks `selected` on the analysis-size/memory <option>s that already match DEFAULT_SETTINGS,
// but not on policy/framing/compute/decoder (those <select>s fall back to their first <option>, which is not
// guaranteed to be the default). Setting every value from DEFAULT_SETTINGS here — not just the ones the markup
// gets right — is what actually keeps the shipped UI default and the settings object `start()` builds from
// drifting apart.
$<HTMLSelectElement>('policy').value = DEFAULT_SETTINGS.temporalPolicy;
$<HTMLSelectElement>('framing').value = DEFAULT_SETTINGS.framing!;
$<HTMLSelectElement>('analysis-size').value = String(DEFAULT_SETTINGS.analysisSize);
$<HTMLSelectElement>('memory').value = String(DEFAULT_SETTINGS.memoryMB);
$<HTMLSelectElement>('compute').value = DEFAULT_SETTINGS.compute!;
$<HTMLSelectElement>('decoder').value = DEFAULT_SETTINGS.decoder;

export interface Run {
  setBusy(value: boolean): void;
  resetView(): void;
  updateProject(value: Project): void;
  start(demo?: string): Promise<void>;
  progress(p: WorkerProgress): void;
  wire(): void;
}

export function createRun(state: AppState, viewer: TiledViewer, canvases: Canvases, diagnostics: Diagnostics): Run {
  let paused = false;
  // The LCD's run timer: wall-clock time of the current run, not counting time spent paused.
  let startedAt = 0, pausedAt = 0, pausedFor = 0, ticker: ReturnType<typeof setInterval> | undefined;
  const showElapsed = () => {
    $('elapsed').textContent = timeText(((paused ? pausedAt : performance.now()) - startedAt - pausedFor) / 1000);
  };

  function setBusy(value: boolean): void {
    state.busy = value;
    if (!value && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
      showElapsed();
    }
    // The screen pauses while the printer works, so it never competes with the run for a video decoder.
    if (value) {
      preview.pause();
    } else if (preview.src) {
      void preview.play().catch(() => {});
    }
    document.body.classList.toggle('is-processing', value);
    $('run-controls').hidden = !value;
    $('status-dot').classList.toggle('running', value);
    syncControls(state, viewer);
  }
  function resetView(): void {
    state.project = undefined;
    state.canvases = [];
    canvases.reset();
    diagnostics.reset();
    viewer.clear();
    document.body.classList.remove('has-result');
    setReceiptOpen(false);
    $('empty-state').hidden = false;
    $('canvas-badge').hidden = true;
    $<HTMLSelectElement>('canvas-select').replaceChildren(new Option(t('ui.run.waitingCanvasOption'), ''));
    $('elapsed').textContent = timeText(0);
    $('frames-metric').textContent = '0';
    $('canvases-metric').textContent = '0';
    $('progress-bar').style.width = '0';
  }
  function updateProject(value: Project): void {
    state.project = value;
    $('frames-metric').textContent = value.renderedFrames.toLocaleString();
    $('canvases-metric').textContent = String(value.canvasCount);
    diagnostics.applyDiagnosticTotals(value);
    canvases.refreshIfStale();
  }
  async function start(demo?: string): Promise<void> {
    if (state.busy) {
      return;
    }
    if (!demo && !state.selectedFile) {
      return;
    }
    if (state.capabilities && !state.capabilities.compression) {
      toast(NO_COMPRESSION_STREAM, true);
      return;
    }
    if (!demo && $<HTMLSelectElement>('decoder').value === 'precise' && state.capabilities && !state.capabilities.webcodecs) {
      toast(
        !globalThis.isSecureContext ? t('ui.run.webcodecsHttpBlocked') : t('ui.run.webcodecsMissing'),
        true,
      );
      return;
    }
    resetView();
    setBusy(true);
    paused = false;
    startedAt = performance.now();
    pausedFor = 0;
    ticker = setInterval(showElapsed, 250);
    $('pause-btn').textContent = t('ui.run.pauseLabel');
    $('status-title').textContent = t('ui.run.preparingStatus');
    $('progress-message').textContent = t('ui.run.preparingMessage');
    try {
      const decoder = $<HTMLSelectElement>('decoder').value as 'precise' | 'compatibility';
      if (!demo && decoder === 'compatibility' && (!state.mediaInfo || !state.nativeReady)) {
        throw new Error(t('ui.run.compatibilityNeedsNative'));
      }
      // The worker (src/worker.ts) is the authority on these values: it re-validates analysisSize/memoryMB/tileSize
      // and rejects an unrecognised compute/framing string, so a <select>'s raw .value is trusted here and cast,
      // not re-narrowed into a second copy of that validation.
      const settings = {
        ...DEFAULT_SETTINGS,
        analysisSize: Number($<HTMLSelectElement>('analysis-size').value),
        memoryMB: Number($<HTMLSelectElement>('memory').value),
        temporalPolicy: $<HTMLSelectElement>('policy').value,
        decoder,
        framing: $<HTMLSelectElement>('framing').value,
        compute: $<HTMLSelectElement>('compute').value,
        regions: demo ? [] : state.manualRegions,
      } as Settings;
      const project = await call('start', { file: state.selectedFile, demo, settings, info: state.mediaInfo });
      // Set state.project as soon as the worker hands it back: getProject() and the viewer's tile callback
      // read state.project synchronously, and the file-hash await below must not leave them seeing the
      // pre-start undefined (resetView()) in the meantime.
      state.project = project;
      flightStart(demo ? undefined : state.selectedFile ?? undefined);
      if (!demo && state.selectedFile) {
        const hash = await state.selectedFileHash;
        if (hash) {
          storeHash(project.id, hash);
        }
      }
      updateProject(state.project);
    } catch (error) {
      setBusy(false);
      $('status-title').textContent = t('ui.run.startFailedStatus');
      $('progress-message').textContent = String(error);
      diagnostics.addDiagnostic({ code: 'START_ERROR', severity: 'error', message: String(error) });
      toast(String(error), true);
    }
  }
  const phaseWeight: Record<string, [number, number]> = {
    scanning: [0, .30],
    solving: [.30, .32],
    optimizing: [.62, .03],
    rendering: [.65, .26],
    framing: [.91, .04],
    pyramid: [.95, .05],
    complete: [1, 0],
    partial: [1, 0],
  };
  function progress(p: WorkerProgress): void {
    $('status-title').textContent = phaseName(p.phase);
    $('progress-count').textContent = `${t('ui.count.frames', { count: p.frames, frames: p.frames.toLocaleString() })} · ${
      timeText(p.time)
    }`;
    $('progress-message').textContent = p.message;
    const [base, weight] = phaseWeight[p.phase] || [0, 0];
    $('progress-bar').style.width = `${Math.min(100, (base + Math.max(0, p.fraction || 0) * weight) * 100)}%`;
    if (p.canvas?.tileCount) {
      canvases.mergeCanvas(p.canvas);
    }
  }
  function wire(): void {
    $('start-btn').onclick = () => void start();
    $('pause-btn').onclick = () => {
      void call('pause', { paused: !paused }).then((result) => {
        if (result.paused !== paused) {
          const now = performance.now();
          if (result.paused) {
            pausedAt = now;
          } else {
            pausedFor += now - pausedAt;
          }
        }
        paused = result.paused;
        $('pause-btn').textContent = paused ? t('ui.run.resumeLabel') : t('ui.run.pauseLabel');
        $('status-title').textContent = paused ? t('ui.run.pausedStatus') : t('ui.run.resumedStatus');
      }).catch((e) => toast(String(e), true));
    };
    $('stop-btn').onclick = () => {
      void call('stop').then(() => {
        // Stopping also resumes a paused run (it goes on to put together and save what it has): the timer runs again.
        if (paused) {
          pausedFor += performance.now() - pausedAt;
          paused = false;
          $('pause-btn').textContent = t('ui.run.pauseLabel');
        }
        toast(t('ui.run.stopToast'));
      }).catch((e) => toast(String(e), true));
    };
    globalThis.addEventListener('beforeunload', (e) => {
      if (state.busy) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }
  return { setBusy, resetView, updateProject, start, progress, wire };
}
