/** Bootstrap: builds every feature module in dependency order, routes worker events to them, and wires the handful
 *  of listeners with no state of their own (help dialog, dialog close buttons, viewer zoom). No algorithms here —
 *  this file, and everything it imports from src/ui/**, is the "thin TypeScript" shell over the Rust core. */
// First import: picks the page language before any other module can produce text.
import { t, takeReopenProject, translatePage, wireLanguageSelect } from '../i18n/page.ts';
import { $, NO_COMPRESSION_STREAM, phaseName, storageInfo, toast } from './dom.ts';
import { call, on, onError, onFrameRequest, onMessageError } from './rpc.ts';
import { TiledViewer } from './viewer.ts';
import { createState } from './state.ts';
import { captureFrame, decoderVideo, seekOn, video } from './video.ts';
import { createCanvases } from './canvases.ts';
import { createDiagnostics } from './diagnostics.ts';
import { createSourceFile } from './source-file.ts';
import { createRun } from './run.ts';
import { createHistory } from './history.ts';
import { createRegions } from './regions.ts';
import { createExport } from './export.ts';
import { flightEnd, flightProgress, takeInterruptedFlight } from './flight.ts';
import { MEMORY_EXPORT_LIMIT } from '../export/target.ts';

translatePage();
const state = createState();
const viewer = new TiledViewer(
  $<HTMLCanvasElement>('viewer'),
  (canvasId, level, x, y) => call('tile', { projectId: state.project?.id, canvasId, level, x, y }),
  (text) => {
    $('zoom-label').textContent = text.split(' · ')[0];
    $('lod-label').textContent = text;
  },
  (error) => toast(String(error), true),
);

// Dependency order: canvases and diagnostics need only the viewer; source-file needs diagnostics' addDiagnostic;
// run composes resetView/updateProject out of canvases+diagnostics; history and export both need run for
// setBusy/resetView; regions is independent.
const canvases = createCanvases(state, viewer);
const diagnostics = createDiagnostics(state, viewer, canvases);
const sourceFile = createSourceFile(state, { addDiagnostic: diagnostics.addDiagnostic });
const run = createRun(state, viewer, canvases, diagnostics);
const history = createHistory(state, viewer, run, canvases, diagnostics);
const regions = createRegions(state);
const exporter = createExport(state, viewer, run, diagnostics.addDiagnostic);

canvases.wire();
diagnostics.wire();
sourceFile.wire();
run.wire();
history.wire();
regions.wire();
exporter.wire();

$('fit-btn').onclick = () => viewer.fit();
$('native-btn').onclick = () => viewer.native();
$('zoom-in').onclick = () => viewer.zoom(1.3);
$('zoom-out').onclick = () => viewer.zoom(1 / 1.3);
$<HTMLInputElement>('quality-toggle').onchange = (e) => viewer.setQuality((e.target as HTMLInputElement).checked);
wireLanguageSelect($<HTMLSelectElement>('language-select'), () => state.project?.id, (message) => toast(message, true));
$('help-btn').onclick = () => $<HTMLDialogElement>('help-dialog').showModal();
for (const el of document.querySelectorAll<HTMLElement>('[data-close]')) {
  el.onclick = () => {
    $<HTMLDialogElement>(el.dataset.close!).close();
    video.pause();
  };
}
$('persist-btn').onclick = () => {
  if (typeof navigator.storage?.persist !== 'function') {
    toast(t('ui.main.persistUnsupported'));
    return;
  }
  void navigator.storage.persist().then((granted) => toast(granted ? t('ui.main.persistGranted') : t('ui.main.persistDenied'))).catch((
    error,
  ) => toast(String(error), true));
};

// Worker event routing.
onFrameRequest((time) =>
  // Exclusively on decoderVideo, never the dialog's source-video: the two must not share a seek target.
  seekOn(decoderVideo, time).then(() => captureFrame(decoderVideo))
);
on('progress', (m) => {
  run.progress(m.data);
  flightProgress(m.data);
});
on('project', (m) => run.updateProject(m.data));
on('diagnostic', (m) => diagnostics.addDiagnostic(m.data));
on('finished', (m) => {
  flightEnd();
  run.updateProject(m.data);
  run.setBusy(false);
  void canvases.refreshCanvases(true).then(() => viewer.fit());
  void diagnostics.loadDiagnostics();
  void storageInfo();
  $('status-title').textContent = phaseName(m.data.status);
  if (m.data.error) {
    toast(m.data.error, true);
  }
});
on('fatal', (m) => {
  flightEnd();
  run.setBusy(false);
  toast(m.error, true);
  diagnostics.addDiagnostic({ code: 'WORKER_ERROR', severity: 'error', message: m.error });
});
on('export-progress', (m) => {
  $('progress-message').textContent = m.data.message;
  if (m.data.fraction) {
    $('progress-bar').style.width = `${m.data.fraction * 100}%`;
  }
});
onError((message) => {
  flightEnd();
  run.setBusy(false);
  toast(t('ui.main.workerErrorToast', { message }), true);
});
onMessageError(() => toast(t('ui.main.workerMessageUndecodable'), true));

void call('capabilities').then((c) => {
  state.capabilities = c;
  if (!c.offscreen) {
    toast(t('ui.main.offscreenMissing'), true);
  }
  if (!c.webcodecs) {
    toast(t('ui.main.webcodecsMissingToast'));
  }
  if (!c.compression) {
    toast(NO_COMPRESSION_STREAM, true);
  }
  if (c.privateStorage) {
    toast(t('ui.main.privateStorageToast'));
  } else if (!c.opfs && !('showSaveFilePicker' in window)) {
    toast(t('ui.main.noOpfsNoPicker', { mb: Math.round(MEMORY_EXPORT_LIMIT / 1048576) }));
  }
}).catch((error) => toast(t('ui.main.dbOpenFailed', { error: String(error) }), true));
void storageInfo();

// The project that was on screen when the language menu reloaded the page.
const reopen = takeReopenProject();
if (reopen) {
  void history.openProject(reopen).catch((error) => toast(String(error), true));
}

const interrupted = takeInterruptedFlight();
if (interrupted) {
  const where = interrupted.phase
    ? t('ui.main.interruptedPhaseWhere', { phase: phaseName(interrupted.phase), frames: interrupted.frames ?? 0 })
    : t('ui.main.interruptedStartPhase');
  const hidden = interrupted.hiddenS
    ? t('ui.main.interruptedHiddenSome', {
      seconds: interrupted.hiddenS,
      stillHidden: interrupted.hiddenNow ? t('ui.main.interruptedStillHidden') : '',
    })
    : t('ui.main.interruptedHiddenNone');
  diagnostics.addDiagnostic({
    code: 'PREVIOUS_RUN_INTERRUPTED',
    severity: 'warning',
    message: t('ui.main.interruptedDiagnosticMessage', {
      where,
      elapsed: interrupted.elapsedS,
      memory: interrupted.peakMemoryMB ?? '?',
      hidden,
      conversion: interrupted.conversion ?? t('ui.main.unknownValue'),
      cores: interrupted.cores,
      isolation: interrupted.crossOriginIsolated ? '' : t('ui.main.interruptedNotIsolated'),
    }),
    action: t('ui.main.interruptedDiagnosticAction'),
    detail: interrupted,
  });
  console.warn('PREVIOUS_RUN_INTERRUPTED', JSON.stringify(interrupted));
  toast(t('ui.main.interruptedToast', { where, hidden }), true);
}

// Stable debugging API exposes state, not a hidden server or cloud path.
(globalThis as unknown as { longScreen: unknown }).longScreen = {
  getProject: () => state.project,
  getCanvases: () => state.canvases,
  rpc: call,
  viewer,
};
