/** Bootstrap: builds every feature module in dependency order, routes worker events to them, and wires the handful
 *  of listeners with no state of their own (help dialog, dialog close buttons, viewer zoom). No algorithms here —
 *  this file, and everything it imports from src/ui/**, is the "thin TypeScript" shell over the Rust core. */
import { $, NO_COMPRESSION_STREAM, phaseNames, storageInfo, toast } from './dom.ts';
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
$('help-btn').onclick = () => $<HTMLDialogElement>('help-dialog').showModal();
for (const el of document.querySelectorAll<HTMLElement>('[data-close]')) {
  el.onclick = () => {
    $<HTMLDialogElement>(el.dataset.close!).close();
    video.pause();
  };
}
$('persist-btn').onclick = () => {
  if (typeof navigator.storage?.persist !== 'function') {
    toast('当前浏览器不支持申请持久存储；本地重建仍可使用，请在支持导出的环境保存重要结果。');
    return;
  }
  void navigator.storage.persist().then((granted) =>
    toast(granted ? '浏览器已授予持久存储；清除网站数据仍会删除项目。' : '浏览器未授予持久存储。请导出重要结果，避免自动回收。')
  ).catch((error) => toast(String(error), true));
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
  $('status-title').textContent = phaseNames[m.data.status];
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
  toast(`Worker 错误：${message}`, true);
});
onMessageError(() => toast('Worker 消息无法解码。请保留现有结果并重新加载。', true));

void call('capabilities').then((c) => {
  state.capabilities = c;
  if (!c.offscreen) {
    toast('当前浏览器缺少 OffscreenCanvas；无法运行渲染 Worker。', true);
  }
  if (!c.webcodecs) {
    toast('当前浏览器没有 WebCodecs。需要明确选择可能漏帧的兼容 seek 模式。');
  }
  if (!c.compression) {
    toast(NO_COMPRESSION_STREAM, true);
  }
  if (c.privateStorage) {
    toast('隐私浏览：项目只保存在这个窗口的内存里，关闭窗口后即消失；需要保留请在关闭前导出。');
  } else if (!c.opfs && !('showSaveFilePicker' in window)) {
    toast(`当前浏览器既没有 OPFS 也没有文件保存对话框；导出会在内存中生成（上限 ${Math.round(MEMORY_EXPORT_LIMIT / 1048576)} MB）。`);
  }
}).catch((error) => toast(`无法打开本地数据库：${String(error)}`, true));
void storageInfo();

const interrupted = takeInterruptedFlight();
if (interrupted) {
  const where = interrupted.phase
    ? `「${phaseNames[interrupted.phase] || interrupted.phase}」第 ${interrupted.frames ?? 0} 帧`
    : '开始阶段';
  const hidden = interrupted.hiddenS
    ? `页面在后台约 ${interrupted.hiddenS} 秒${interrupted.hiddenNow ? '（中断时仍在后台）' : ''}`
    : '页面一直在前台';
  diagnostics.addDiagnostic({
    code: 'PREVIOUS_RUN_INTERRUPTED',
    severity: 'warning',
    message: `上一次重建在${where}中断，页面没有收到结束信号（浏览器回收或崩溃了这个页面）。已运行 ${interrupted.elapsedS} 秒，核心内存 ${
      interrupted.peakMemoryMB ?? '?'
    } MB，${hidden}，帧转换：${interrupted.conversion ?? '未知'}，${interrupted.cores} 核${
      interrupted.crossOriginIsolated ? '' : '（未跨源隔离，单线程）'
    }。`,
    action: 'Safari 会在页面转入后台时以低得多的内存上限回收它：长时间处理请保持该标签页在前台。完整记录已写入浏览器控制台。',
    detail: interrupted,
  });
  console.warn('PREVIOUS_RUN_INTERRUPTED', JSON.stringify(interrupted));
  toast(`上一次重建在${where}中断（${hidden}）。详情见诊断。`, true);
}

// Stable debugging API exposes state, not a hidden server or cloud path.
(globalThis as unknown as { longScreen: unknown }).longScreen = {
  getProject: () => state.project,
  getCanvases: () => state.canvases,
  rpc: call,
  viewer,
};
