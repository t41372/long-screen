/** Bootstrap: builds every feature module in dependency order, routes worker events to them, and wires the handful
 *  of listeners with no state of their own (help dialog, dialog close buttons, viewer zoom). No algorithms here —
 *  this file, and everything it imports from src/ui/**, is the "thin TypeScript" shell over the Rust core. */
// First import: picks the page language before any other module can produce text.
import { t, translatePage, wireLanguageSelect } from '../i18n/page.ts';
import { $, NO_COMPRESSION_STREAM, phaseName, setReceiptOpen, toast } from './dom.ts';
import { call, on, onError, onFrameRequest, onMessageError } from './rpc.ts';
import { TiledViewer } from './viewer.ts';
import { createState, syncControls } from './state.ts';
import { captureFrame, decoderVideo, seekOn, video } from './video.ts';
import { createCanvases } from './canvases.ts';
import { createDiagnostics } from './diagnostics.ts';
import { createSourceFile, forgetHashes } from './source-file.ts';
import { createRun } from './run.ts';
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
// run composes resetView/updateProject out of canvases+diagnostics; export needs run for setBusy/resetView; regions is
// independent.
const canvases = createCanvases(state, viewer);
const diagnostics = createDiagnostics(state, viewer, canvases);
const sourceFile = createSourceFile(state, { addDiagnostic: diagnostics.addDiagnostic });
const run = createRun(state, viewer, canvases, diagnostics);
const regions = createRegions(state);
const exporter = createExport(state, viewer, run, diagnostics.addDiagnostic);

canvases.wire();
diagnostics.wire();
sourceFile.wire();
run.wire();
regions.wire();
exporter.wire();

/** The one demo: a recording that wanders around a page. It takes the same path as a user's file — onto the screen, a
 *  moment to watch it move, then Print — so what it shows is the real flow. */
async function playDemo(): Promise<void> {
  if (state.busy) {
    return;
  }
  const response = await fetch(new URL('./demo/sample.mp4', location.href));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const file = new File([await response.blob()], t('ui.demo.fileName'), { type: 'video/mp4' });
  await sourceFile.chooseFile(file);
  if (state.selectedFile !== file) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  if (state.selectedFile === file && !state.busy) {
    await run.start();
  }
}
// SMIL ignores prefers-reduced-motion: each animated illustration then stays a still at its `data-still` moment.
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  for (const svg of document.querySelectorAll<SVGSVGElement>('svg[data-still]')) {
    svg.setCurrentTime(Number(svg.dataset.still));
    svg.pauseAnimations();
  }
}
// Clear: the printer goes back to how it was on first load, and the print the browser kept is deleted.
$('clear-btn').onclick = () => {
  if (state.busy) {
    return;
  }
  sourceFile.clear();
  run.resetView();
  void call('sweep', {}).then(() => forgetHashes()).catch((error) => toast(String(error), true));
  $('status-title').textContent = t('page.canvas.statusReady');
  $('progress-message').textContent = t('page.canvas.progressMessageDefault');
  $('progress-count').textContent = '';
  syncControls(state, viewer);
};
$('demo-cta').onclick = () => void playDemo().catch((error) => toast(t('ui.demo.loadFailed', { error: String(error) }), true));

$('fit-btn').onclick = () => viewer.fit();
$('native-btn').onclick = () => viewer.native();
$('zoom-in').onclick = () => viewer.zoom(1.3);
$('zoom-out').onclick = () => viewer.zoom(1 / 1.3);
// The viewer's ResizeObserver refits a canvas it is following and keeps the view of one the user zoomed into.
const spreadReceipt = (open: boolean) => setReceiptOpen(open);
$('expand-btn').onclick = () => spreadReceipt(!document.body.classList.contains('receipt-open'));
$('receipt-backdrop').onclick = () => spreadReceipt(false);
addEventListener('keydown', (e) => {
  // An open modal dialog handles its own Escape.
  if (e.key === 'Escape' && document.body.classList.contains('receipt-open') && !document.querySelector('dialog[open]')) {
    spreadReceipt(false);
  }
});
$<HTMLInputElement>('quality-toggle').onchange = (e) => viewer.setQuality((e.target as HTMLInputElement).checked);
wireLanguageSelect($<HTMLSelectElement>('language-select'), (message) => toast(message, true));
$('help-btn').onclick = () => $<HTMLDialogElement>('help-dialog').showModal();
for (const el of document.querySelectorAll<HTMLElement>('[data-close]')) {
  el.onclick = () => {
    $<HTMLDialogElement>(el.dataset.close!).close();
    video.pause();
  };
}
// Bug reports open GitHub's new-issue form pre-filled with what helps triage. Nothing leaves the page from here: the
// user reads and edits the report on GitHub before submitting, and it carries no file name, pixels or file:// path.
addEventListener('click', (e) => {
  const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a.report-link') : null;
  if (!link) {
    return;
  }
  const body = t('ui.feedback.issueBody', {
    browser: navigator.userAgent,
    page: location.protocol === 'file:' ? t('ui.feedback.portable') : location.host,
    threads: crossOriginIsolated ? t('ui.feedback.yes') : t('ui.feedback.no'),
    warnings: diagnostics.warningCodes() || t('ui.feedback.none'),
  });
  link.href = `${link.href.split('?')[0]}?body=${encodeURIComponent(body)}`;
});

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
  void canvases.refreshCanvases(true).then(() => {
    if (viewer.following) {
      viewer.fit();
    }
    // Stacked layouts print below the printer: bring the print into view when it is out of sight.
    const top = $('receipt').getBoundingClientRect().top;
    if (state.canvases.length && top > innerHeight * .6) {
      $('receipt').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  });
  void diagnostics.loadDiagnostics();
  $('status-title').textContent = phaseName(m.data.status);
  // The last progress event can land short of the end; a finished print shows every gumball filled.
  if (m.data.status === 'complete') {
    $('progress-bar').style.width = '100%';
  }
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

// The browser keeps the last print for a day and nothing else, never a history: a reload, a closed tab or a run the
// browser killed brings it back here, and anything older is deleted. The crash report goes after it, since putting
// the print back resets the log.
// If a print or Clear came first (tidying up a large old store can take a moment), that wins.
const resetsAtLoad = state.resets;
void call('restore', {}).then((kept) => {
  if (state.resets !== resetsAtLoad) {
    return;
  }
  forgetHashes(kept?.project.id);
  return kept ? run.restore(kept) : undefined;
}).catch((error) => toast(String(error), true)).finally(reportInterruptedRun);

function reportInterruptedRun(): void {
  const interrupted = takeInterruptedFlight();
  if (!interrupted) {
    return;
  }
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
  /** Runs one of the synthetic scenes (src/synthetic/scenarios.ts) the tests use; the page itself only offers the sample. */
  startDemo: (name: string) => run.start(name),
  rpc: call,
  viewer,
};
