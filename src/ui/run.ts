/** The reconstruction run lifecycle: starting it (settings + capability preflight), the busy/enablement state every
 *  other feature reads, `resetView`/`updateProject` (composed here because both touch project, canvas and
 *  diagnostic state at once), and the progress bar. */
import type { AppState } from './state.ts';
import { syncControls } from './state.ts';
import { $, NO_COMPRESSION_STREAM, phaseNames, timeText, toast } from './dom.ts';
import { call } from './rpc.ts';
import { flightStart } from './flight.ts';
import { storeHash } from './source-file.ts';
import { DEFAULT_SETTINGS, type Project, type Settings } from '../types.ts';
import type { WorkerProgress } from '../protocol.ts';
import type { Canvases } from './canvases.ts';
import type { Diagnostics } from './diagnostics.ts';
import type { TiledViewer } from './viewer.ts';

// static/index.html marks `selected` on the analysis-size/memory <option>s that already match DEFAULT_SETTINGS,
// but not on policy/framing/decoder (those <select>s fall back to their first <option>, which is not always the
// default). Setting every value from DEFAULT_SETTINGS here — not just the ones the markup gets right — is what
// actually keeps the shipped UI default and the settings object `start()` builds from drifting apart.
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

  function setBusy(value: boolean): void {
    state.busy = value;
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
    $('empty-state').hidden = false;
    $('canvas-badge').hidden = true;
    $<HTMLSelectElement>('canvas-select').replaceChildren(new Option('等待重建画布', ''));
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
        !globalThis.isSecureContext
          ? '浏览器在当前 HTTP 地址未开放 WebCodecs。可选择“近似 · 原生 seek”继续本地测试；精确逐帧解码需要 localhost 或 HTTPS。视频不会上传。'
          : '当前浏览器没有 WebCodecs。请更新 Safari / iOS，或明确选择可能漏帧的兼容 seek 模式。',
        true,
      );
      return;
    }
    resetView();
    setBusy(true);
    paused = false;
    $('pause-btn').textContent = '暂停';
    $('status-title').textContent = '准备逐帧解码';
    $('progress-message').textContent = '正在读取容器、检查编码支持与本地存储。';
    try {
      const decoder = $<HTMLSelectElement>('decoder').value as 'precise' | 'compatibility';
      if (!demo && decoder === 'compatibility' && (!state.mediaInfo || !state.nativeReady)) {
        throw new Error('兼容模式需要浏览器原生播放器能够读取这段视频。');
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
      flightStart(demo ? undefined : state.selectedFile ?? undefined);
      if (!demo && state.selectedFile) {
        const hash = await state.selectedFileHash;
        if (hash) {
          storeHash(project.id, hash);
        }
      }
      updateProject(project);
    } catch (error) {
      setBusy(false);
      $('status-title').textContent = '未能开始重建';
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
    $('status-title').textContent = phaseNames[p.phase] || p.phase;
    $('progress-count').textContent = `${p.frames.toLocaleString()} 帧 · ${timeText(p.time)}`;
    $('progress-message').textContent = p.message;
    const [base, weight] = phaseWeight[p.phase] || [0, 0];
    $('progress-bar').style.width = `${Math.min(100, (base + Math.max(0, p.fraction || 0) * weight) * 100)}%`;
    if (p.canvas?.tileCount) {
      canvases.mergeCanvas(p.canvas);
    }
  }
  function wire(): void {
    $('start-btn').onclick = () => void start();
    $('demo-btn').onclick = () => void start($<HTMLSelectElement>('demo-select').value);
    $('pause-btn').onclick = () => {
      void call('pause', { paused: !paused }).then((result) => {
        paused = result.paused;
        $('pause-btn').textContent = paused ? '继续' : '暂停';
        $('status-title').textContent = paused ? '已暂停 · 内存状态保留' : '继续处理';
      }).catch((e) => toast(String(e), true));
    };
    $('stop-btn').onclick = () => {
      void call('stop').then(() => toast('正在结束当前阶段，并尽可能合成、保存已处理的观察。')).catch((e) => toast(String(e), true));
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
