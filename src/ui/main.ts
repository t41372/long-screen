import { type CanvasMeta, DEFAULT_SETTINGS, type Diagnostic, type MediaInfo, type Progress, type Project, type Region } from '../types.ts';
import { TiledViewer } from './viewer.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let requestId = 0;
const requests = new Map<number, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}>();
function rpc<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    requests.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}
let selectedFile: File | undefined,
  videoURL: string | undefined,
  previewURL: string | undefined,
  firstBitmap: ImageBitmap | undefined,
  mediaInfo: MediaInfo | undefined;
let project: Project | undefined,
  canvases: CanvasMeta[] = [],
  busy = false,
  paused = false,
  diagnosticRows: Diagnostic[] = [],
  diagnosticCursor: string | undefined,
  projectCursor: string | undefined,
  refreshing = false,
  lastRefresh = 0;
let manualRegions: Region[] = [],
  draftRegions: Region[] = [],
  draftStart: {
    x: number;
    y: number;
  } | undefined,
  draftRect: Region['rect'] | undefined,
  toastTimer: ReturnType<typeof setTimeout> | undefined;
let selectionTouched = false;
let diagRefresh = false, downloadURL: string | undefined;
const video = $<HTMLVideoElement>('source-video');
const viewer = new TiledViewer(
  $<HTMLCanvasElement>('viewer'),
  (canvasId, level, x, y) => rpc('tile', { projectId: project?.id, canvasId, level, x, y }),
  (text) => {
    $('zoom-label').textContent = text.split(' · ')[0];
    $('lod-label').textContent = text;
  },
  (error) => toast(String(error), true),
);
function toast(message: string, error = false): void {
  const el = $('toast');
  el.textContent = message;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.hidden = true, error ? 16000 : 9000);
}
const humanBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
const timeText = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function setBusy(value: boolean): void {
  busy = value;
  document.body.classList.toggle('is-processing', value);
  $<HTMLButtonElement>('start-btn').disabled = value || !selectedFile;
  $<HTMLButtonElement>('demo-btn').disabled = value;
  $<HTMLButtonElement>('regions-btn').disabled = value || !firstBitmap;
  $('run-controls').hidden = !value;
  $('status-dot').classList.toggle('running', value);
  $<HTMLButtonElement>('export-project').disabled = value || !project?.renderedFrames;
  $<HTMLButtonElement>('export-png').disabled = value || !viewer.current?.tileCount;
}
async function storageInfo(): Promise<void> {
  try {
    const estimate = await navigator.storage.estimate();
    $('storage-status').textContent = `本地已用 ${humanBytes(estimate.usage || 0)} / 可用配额 ${humanBytes(estimate.quota || 0)}`;
  } catch (error) {
    $('storage-status').textContent = '浏览器未提供存储配额';
    toast(`无法查询存储配额：${String(error)}`, true);
  }
}
function waitVideo(event: string, timeout = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, done);
      video.removeEventListener('error', failed);
    };
    const done = () => {
        cleanup();
        resolve();
      },
      failed = () => {
        cleanup();
        reject(new Error(video.error?.message || 'Native media playback failed.'));
      };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Native video ${event} timed out.`));
    }, timeout);
    video.addEventListener(event, done, { once: true });
    video.addEventListener('error', failed, { once: true });
  });
}
async function seek(time: number): Promise<void> {
  if (video.readyState >= 2 && Math.abs(video.currentTime - time) < .00001) {
    return;
  }
  const done = waitVideo('seeked');
  video.currentTime = Math.min(Math.max(0, time), Math.max(0, video.duration - .00001));
  await done;
  if (video.readyState < 2) {
    await waitVideo('loadeddata');
  }
}
let nativeReady = false;
async function captureNativeFrame(): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(video);
  } catch (error) {
    // Some containers expose metadata but no capturable frame; a canvas draw is the second attempt, not a silent skip.
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.width) {
      throw error;
    }
    ctx.drawImage(video, 0, 0);
    return await createImageBitmap(canvas);
  }
}
async function chooseFile(file: File): Promise<void> {
  if (busy) {
    toast('请先完成或保存当前处理部分。');
    return;
  }
  selectedFile = file;
  mediaInfo = undefined;
  nativeReady = false;
  manualRegions = [];
  firstBitmap?.close();
  firstBitmap = undefined;
  if (videoURL) {
    URL.revokeObjectURL(videoURL);
  }
  videoURL = URL.createObjectURL(file);
  video.src = videoURL;
  $('file-title').textContent = file.name;
  $('file-subtitle').textContent = `${humanBytes(file.size)} · 未上传 · 正在读取容器与首帧`;
  $('regions-count').textContent = '自动识别 ↗';
  $<HTMLButtonElement>('start-btn').disabled = false;
  $<HTMLButtonElement>('regions-btn').disabled = true;
  // Native element readiness is tracked for compatibility mode and source-time review; it is not required to start.
  void waitVideo('loadeddata').then(() => {
    nativeReady = Number.isFinite(video.duration) && video.duration > 0;
  }).catch(() => {
    nativeReady = false;
  });
  const chosen = file;
  try {
    const probe = await rpc<{ info: MediaInfo; bitmap: ImageBitmap }>('probe', { file });
    if (selectedFile !== chosen) {
      probe.bitmap.close();
      return;
    }
    mediaInfo = probe.info;
    firstBitmap = probe.bitmap;
    $('file-subtitle').textContent = `${mediaInfo.width} × ${mediaInfo.height} · ${timeText(mediaInfo.duration)} · ${
      mediaInfo.frameCount ?? '?'
    } 帧 · ${mediaInfo.codec} · ${humanBytes(file.size)}`;
    $<HTMLButtonElement>('regions-btn').disabled = false;
    for (const warning of mediaInfo.warnings) {
      toast(warning);
    }
    return;
  } catch (error) {
    if (selectedFile !== chosen) {
      return;
    }
    addDiagnostic({
      code: 'PROBE_FAILED',
      severity: 'warning',
      message: `逐帧解码探测失败：${String(error)}`,
      action: '将尝试浏览器原生播放器读取元数据。若仍要处理，请在解码方式中选择“近似 · 原生 seek”。',
    });
  }
  try {
    if (video.readyState < 2) {
      await waitVideo('loadeddata');
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('Native player does not expose a finite duration.');
    }
    nativeReady = true;
    mediaInfo = {
      name: file.name,
      size: file.size,
      width: video.videoWidth,
      height: video.videoHeight,
      codedWidth: video.videoWidth,
      codedHeight: video.videoHeight,
      rotation: 0,
      duration: video.duration,
      codec: 'native media element',
      mode: 'Native seek',
      warnings: [],
      notices: [],
    };
    await seek(0);
    firstBitmap = await captureNativeFrame();
    $('file-subtitle').textContent = `${mediaInfo.width} × ${mediaInfo.height} · ${timeText(mediaInfo.duration)} · ${
      humanBytes(file.size)
    } · 仅原生播放器可读`;
    $<HTMLButtonElement>('regions-btn').disabled = false;
  } catch (error) {
    $('file-subtitle').textContent = `${humanBytes(file.size)} · 逐帧解码与原生预览都不可用`;
    toast(String(error), true);
  }
}
function resetView(): void {
  selectionTouched = false;
  canvases = [];
  diagnosticRows = [];
  diagnosticCursor = undefined;
  viewer.clear();
  $('empty-state').hidden = false;
  $('canvas-badge').hidden = true;
  $<HTMLSelectElement>('canvas-select').replaceChildren(new Option('等待重建画布', ''));
  $('frames-metric').textContent = '0';
  $('canvases-metric').textContent = '0';
  $('warning-count').textContent = '0';
  $('warning-count').classList.remove('has-issues');
  $('progress-bar').style.width = '0';
  renderDiagnostics();
}
async function start(demo?: string): Promise<void> {
  if (busy) {
    return;
  }
  if (!demo && !selectedFile) {
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
    if (!demo && decoder === 'compatibility' && (!mediaInfo || !nativeReady)) {
      throw new Error('兼容模式需要浏览器原生播放器能够读取这段视频。');
    }
    const settings = {
      ...DEFAULT_SETTINGS,
      analysisSize: Number($<HTMLSelectElement>('analysis-size').value),
      memoryMB: Number($<HTMLSelectElement>('memory').value),
      temporalPolicy: $<HTMLSelectElement>('policy').value,
      decoder,
      framing: $<HTMLSelectElement>('framing').value,
      compute: $<HTMLSelectElement>('compute').value,
      regions: demo ? [] : manualRegions,
    };
    project = await rpc<Project>('start', { file: selectedFile, demo, settings, info: mediaInfo });
    updateProject(project);
  } catch (error) {
    setBusy(false);
    $('status-title').textContent = '未能开始重建';
    $('progress-message').textContent = String(error);
    addDiagnostic({ code: 'START_ERROR', severity: 'error', message: String(error) });
    toast(String(error), true);
  }
}
function updateProject(value: Project): void {
  project = value;
  $('frames-metric').textContent = value.renderedFrames.toLocaleString();
  $('canvases-metric').textContent = String(value.canvasCount);
  if (performance.now() - lastRefresh > 1200) {
    void refreshCanvases();
  }
}
const phaseNames: Record<string, string> = {
  scanning: '逐帧观察与运动分层',
  solving: '全局定位与原像素精修',
  optimizing: '校正回环与累计漂移',
  rendering: '合成原尺寸稀疏画布',
  framing: '保留外框与原始比例',
  pyramid: '建立可缩放预览',
  complete: '已完成 · 请检查诊断',
  partial: '部分结果已保存',
  error: '处理遇到错误',
};
function progress(p: Progress): void {
  $('status-title').textContent = phaseNames[p.phase] || p.phase;
  $('progress-count').textContent = `${p.frames.toLocaleString()} 帧 · ${timeText(p.time)}`;
  $('progress-message').textContent = p.message;
  const phaseWeight: Record<string, [
    number,
    number,
  ]> = {
    scanning: [0, .30],
    solving: [.30, .32],
    optimizing: [.62, .03],
    rendering: [.65, .26],
    framing: [.91, .04],
    pyramid: [.95, .05],
    complete: [1, 0],
    partial: [1, 0],
  };
  const [base, weight] = phaseWeight[p.phase] || [0, 0];
  $('progress-bar').style.width = `${Math.min(100, (base + Math.max(0, p.fraction || 0) * weight) * 100)}%`;
  if (p.canvas?.tileCount) {
    const existing = canvases.find((c) => c.id === p.canvas!.id);
    if (existing) {
      Object.assign(existing, p.canvas);
    } else {
      canvases.push(p.canvas);
    }
    updateCanvasOptions();
    if (viewer.current?.id === p.canvas.id) {
      viewer.setCanvas(p.canvas, project?.settings.tileSize || 512);
    }
  }
}
async function refreshCanvases(all = false): Promise<void> {
  if (!project) {
    return;
  }
  if (refreshing) {
    if (all) {
      setTimeout(() => void refreshCanvases(true), 120);
    }
    return;
  }
  refreshing = true;
  lastRefresh = performance.now();
  try {
    const id = project.id;
    const result = await rpc('open', { projectId: id });
    if (project?.id !== id) {
      return;
    }
    canvases = result.canvases.map((r: any) => r.value);
    if (all && result.canvases.length === 100) {
      let after = result.canvases.at(-1).key;
      while (true) {
        const more = await rpc('canvases', { projectId: id, after });
        canvases.push(...more.map((r: any) => r.value));
        if (more.length < 100) {
          break;
        }
        after = more.at(-1).key;
      }
    }
    updateCanvasOptions();
    viewer.invalidate();
  } catch (error) {
    toast(String(error), true);
  } finally {
    refreshing = false;
  }
}
function updateCanvasOptions(): void {
  const select = $<HTMLSelectElement>('canvas-select'), old = select.value;
  const usable = canvases.filter((c) => c.tileCount && Number.isFinite(c.bounds.width) && Number.isFinite(c.bounds.height));
  if (!usable.length) {
    return;
  }
  const rank = (c: CanvasMeta) => c.kind === 'presentation' ? -1 : c.kind === 'fixed' ? 1 : 0;
  usable.sort((a, b) => rank(a) - rank(b) || b.observedPixels - a.observedPixels);
  select.replaceChildren(
    ...usable.map((c) => new Option(`${c.name} · ${Math.round(c.bounds.width)} × ${Math.round(c.bounds.height)}`, c.id)),
  );
  select.value = !selectionTouched && project?.settings.framing === 'context' && usable[0].kind === 'presentation'
    ? usable[0].id
    : usable.some((c) => c.id === old)
    ? old
    : usable[0].id;
  selectCanvas(false);
}
function selectCanvas(fit = true): void {
  const c = canvases.find((c) => c.id === $<HTMLSelectElement>('canvas-select').value);
  if (!c) {
    return;
  }
  viewer.setCanvas(c, project?.settings.tileSize || 512);
  if (fit) {
    viewer.fit();
  }
  $('empty-state').hidden = true;
  $('canvas-badge').hidden = false;
  $('canvas-badge').textContent = `${
    c.kind === 'presentation' ? '带框呈现 · 延伸背景非观察证据' : c.kind === 'fixed' ? '固定 / 观察层' : '二维内容层'
  } · ${c.tileCount} 原图瓦片${c.fragment ? ' · 片段间关系未证实' : ''}`;
  $<HTMLButtonElement>('export-png').disabled = busy || !c.tileCount;
}
function addDiagnostic(d: Diagnostic): void {
  diagnosticRows.push(d);
  if (diagnosticRows.length > 180) {
    diagnosticRows.shift();
  }
  if (!diagRefresh) {
    diagRefresh = true;
    setTimeout(() => {
      diagRefresh = false;
      renderDiagnostics();
    }, 160);
  }
}
function renderDiagnostics(): void {
  const container = $('diagnostics');
  const filter = $<HTMLSelectElement>('diagnostic-filter').value,
    rows = diagnosticRows.filter((d) => filter !== 'issues' || d.severity !== 'info');
  container.replaceChildren();
  const warnings = diagnosticRows.filter((d) => d.severity !== 'info').reduce((s, d) => s + (d.count || 1), 0);
  $('warning-count').textContent = warnings > 999 ? '999+' : String(warnings);
  $('warning-count').classList.toggle('has-issues', warnings > 0);
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'diagnostic-empty';
    empty.textContent = diagnosticRows.length ? '当前过滤条件下没有记录。' : '这里会记录定位依据、页面变化、推断和处理错误。';
    container.append(empty);
    return;
  }
  for (const d of rows) {
    const card = document.createElement('article');
    card.className = `diagnostic ${d.severity}`;
    const header = document.createElement('div');
    header.className = 'diagnostic-head';
    const code = document.createElement('span');
    code.textContent = d.code;
    const time = document.createElement('span');
    time.textContent = d.time === undefined ? '' : timeText(d.time);
    header.append(code, time);
    const text = document.createElement('p');
    text.textContent = d.message + (d.count && d.count > 1 ? `（本类事件累计 ${d.count} 次）` : '');
    card.append(header, text);
    if (d.action) {
      const action = document.createElement('p');
      action.className = 'action';
      action.textContent = d.action;
      card.append(action);
    }
    if (d.time !== undefined || d.region) {
      const button = document.createElement('button');
      button.textContent = d.region ? '定位受影响区域 / 查看来源 ↗' : '查看原始时刻 ↗';
      button.onclick = () => void showDiagnostic(d);
      card.append(button);
    }
    container.append(card);
  }
}
async function showDiagnostic(d: Diagnostic): Promise<void> {
  if (d.canvasId && canvases.some((c) => c.id === d.canvasId)) {
    $<HTMLSelectElement>('canvas-select').value = d.canvasId;
    selectCanvas(false);
    if (d.region) {
      viewer.focusRegion(d.region);
    }
  }
  if (d.time !== undefined) {
    if (!selectedFile || project?.name !== selectedFile.name || project?.media?.size !== selectedFile.size) {
      toast('原始视频未包含在项目中。请重新选择对应录屏，再通过时间戳查看；合成结果仍保存在本地。');
      return;
    }
    try {
      $<HTMLDialogElement>('source-dialog').showModal();
      await seek(d.time);
      $('source-caption').textContent = `源帧 ${d.frame ?? '—'} · ${d.time.toFixed(3)} 秒 · ${d.message}`;
    } catch (error) {
      toast(String(error), true);
    }
  }
}
async function loadDiagnostics(reset = true): Promise<void> {
  if (!project) {
    return;
  }
  if (reset) {
    diagnosticRows = [];
    diagnosticCursor = undefined;
  }
  try {
    const rows = await rpc('diagnostics', { projectId: project.id, after: diagnosticCursor });
    diagnosticRows.push(...rows.map((r: any) => r.value));
    diagnosticCursor = rows.at(-1)?.key || diagnosticCursor;
    $('more-diagnostics').hidden = rows.length < 100;
    renderDiagnostics();
  } catch (error) {
    toast(String(error), true);
  }
}
async function openProject(id: string): Promise<void> {
  if (busy) {
    toast('请先完成当前处理。');
    return;
  }
  resetView();
  const result = await rpc('open', { projectId: id });
  project = result.project;
  updateProject(project!);
  await refreshCanvases(true);
  await loadDiagnostics();
  viewer.fit();
  setBusy(false);
  $('status-title').textContent = result.interrupted ? '处理曾中断 · 查看已提交结果' : phaseNames[project!.status];
  $('progress-message').textContent = project!.error || '本地结果已恢复；原视频没有复制进项目。';
  $('progress-count').textContent = `${project!.renderedFrames} 帧`;
  if (result.interrupted) {
    addDiagnostic({
      code: 'INTERRUPTED_SESSION',
      severity: 'warning',
      message: '上一次处理没有完成。仅已提交的数据可恢复；重新处理需要再次选择原视频，当前不支持断点续算。',
    });
  }
}
async function history(reset = true): Promise<void> {
  try {
    if (reset) {
      projectCursor = undefined;
      $('history-list').replaceChildren();
    }
    const rows = await rpc('projects', { after: projectCursor });
    for (const row of rows) {
      const p: Project = row.value, item = document.createElement('div');
      item.className = 'history-item';
      const body = document.createElement('div'), title = document.createElement('strong'), sub = document.createElement('p');
      title.textContent = p.name;
      sub.textContent = `${new Date(p.created).toLocaleString()} · ${p.renderedFrames} 帧 · ${phaseNames[p.status] || p.status}`;
      body.append(title, sub);
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      const open = document.createElement('button');
      open.className = 'secondary';
      open.textContent = '打开';
      open.onclick = () => {
        void openProject(p.id).then(() => $<HTMLDialogElement>('history-dialog').close()).catch((e) => toast(String(e), true));
      };
      const remove = document.createElement('button');
      remove.className = 'quiet';
      remove.textContent = '删除';
      remove.onclick = () => {
        if (confirm(`删除本地项目「${p.name}」及其所有瓦片？`)) {
          void rpc('delete', { projectId: p.id }).then(() => {
            item.remove();
            if (project?.id === p.id) {
              project = undefined;
              resetView();
              setBusy(false);
            }
            void storageInfo();
          }).catch((e) => toast(String(e), true));
        }
      };
      actions.append(open, remove);
      item.append(body, actions);
      $('history-list').append(item);
    }
    projectCursor = rows.at(-1)?.key || projectCursor;
    $('more-projects').hidden = rows.length < 30;
    if (!rows.length && reset) {
      $('history-list').textContent = '还没有本地项目。';
    }
  } catch (error) {
    toast(String(error), true);
  }
}
function drawRegions(): void {
  if (!firstBitmap) {
    return;
  }
  const canvas = $<HTMLCanvasElement>('region-canvas'), scale = Math.min(1, 850 / firstBitmap.width);
  canvas.width = Math.round(firstBitmap.width * scale);
  canvas.height = Math.round(firstBitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(firstBitmap, 0, 0, canvas.width, canvas.height);
  const draw = (r: Region['rect'], kind: string, n?: number) => {
    ctx.fillStyle = kind === 'ignore' ? '#a33b3b33' : kind === 'fixed' ? '#ad8b3d33' : '#55966a33';
    ctx.strokeStyle = kind === 'ignore' ? '#ba6455' : kind === 'fixed' ? '#bf9b4b' : '#638f63';
    ctx.lineWidth = 2;
    ctx.fillRect(r.x * scale, r.y * scale, r.width * scale, r.height * scale);
    ctx.strokeRect(r.x * scale, r.y * scale, r.width * scale, r.height * scale);
    if (n !== undefined) {
      ctx.fillStyle = '#263b33';
      ctx.font = 'bold 14px system-ui';
      ctx.fillText(String(n + 1), r.x * scale + 6, r.y * scale + 19);
    }
  };
  draftRegions.forEach((r, i) => draw(r.rect, r.kind, i));
  if (draftRect) {
    draw(draftRect, $<HTMLSelectElement>('region-kind').value);
  }
  const list = $('region-list');
  list.replaceChildren();
  draftRegions.forEach((r, i) => {
    const button = document.createElement('button');
    button.textContent = `${i + 1}. ${r.name} ${r.rect.width}×${r.rect.height} ×`;
    button.onclick = () => {
      draftRegions.splice(i, 1);
      drawRegions();
    };
    list.append(button);
  });
}
function regionPoint(e: PointerEvent): {
  x: number;
  y: number;
} {
  const rect = $('region-canvas').getBoundingClientRect();
  return {
    x: Math.round(Math.max(0, Math.min(firstBitmap!.width, (e.clientX - rect.left) * firstBitmap!.width / rect.width))),
    y: Math.round(Math.max(0, Math.min(firstBitmap!.height, (e.clientY - rect.top) * firstBitmap!.height / rect.height))),
  };
}
async function doExport(format: 'project' | 'png'): Promise<void> {
  if (!project || busy) {
    return;
  }
  let handle: FileSystemFileHandle | undefined;
  const c = viewer.current;
  setBusy(true);
  $('run-controls').hidden = true;
  try {
    const width = Math.min(
        4096,
        Math.max(512, Math.floor(project.settings.memoryMB * 1024 * 1024 * .20 / (project.settings.tileSize * 4) / 512) * 512),
      ),
      single = c && c.bounds.width <= width && c.bounds.height <= 32767 && c.bounds.width * c.bounds.height <= 100000000;
    const name = format === 'project' ? 'long-screen-project.zip' : single ? 'long-screen.png' : 'long-screen-sheets.zip';
    if ('showSaveFilePicker' in window) {
      try {
        handle = await (window as unknown as {
          showSaveFilePicker: (options: unknown) => Promise<FileSystemFileHandle>;
        }).showSaveFilePicker({
          suggestedName: name,
          types: [{
            description: name.endsWith('.png') ? 'PNG image' : 'ZIP64 archive',
            accept: { [name.endsWith('.png') ? 'image/png' : 'application/zip']: [name.endsWith('.png') ? '.png' : '.zip'] },
          }],
        });
      } catch (error) {
        if ((error as DOMException).name === 'AbortError') {
          return;
        }
        toast(`直接保存不可用，改用本地磁盘临时文件：${String(error)}`);
      }
    }
    $<HTMLButtonElement>('export-project').disabled = true;
    $<HTMLButtonElement>('export-png').disabled = true;
    const result = await rpc('export', { projectId: project.id, canvasId: c?.id, format, handle });
    toast(result.message);
    if (result.blob) {
      if (downloadURL) {
        URL.revokeObjectURL(downloadURL);
      }
      downloadURL = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = downloadURL;
      a.download = result.name;
      a.textContent = `保存 ${result.name} · ${humanBytes(result.blob.size)}`;
      a.className = 'export-link';
      $('export-download').replaceChildren(a);
      a.click();
      if (result.temporary) {
        const cleanup = document.createElement('button');
        cleanup.className = 'quiet';
        cleanup.textContent = '保存后清理临时副本';
        cleanup.onclick = () => {
          void rpc('cleanup-export', { key: result.temporary }).then(() => {
            if (downloadURL) {
              URL.revokeObjectURL(downloadURL);
            }
            $('export-download').replaceChildren();
            void storageInfo();
          }).catch((e) => toast(String(e), true));
        };
        $('export-download').append(cleanup);
      }
    }
    $('progress-message').textContent = result.message;
    await storageInfo();
  } catch (error) {
    toast(String(error), true);
    addDiagnostic({
      code: 'EXPORT_ERROR',
      severity: 'error',
      message: String(error),
      action: '没有把未完成的导出标记为成功。已提交的项目瓦片仍在本机。',
    });
  } finally {
    setBusy(false);
  }
}
worker.onmessage = (event) => {
  const m = event.data;
  if (m.id && !m.event) {
    const pending = requests.get(m.id);
    if (pending) {
      requests.delete(m.id);
      if (m.error) {
        pending.reject(new Error(m.error));
      } else {
        pending.resolve(m.result);
      }
    }
    return;
  }
  if (m.event === 'frame-request') {
    void seek(m.time).then(() => captureNativeFrame()).then((bitmap) =>
      worker.postMessage({ type: 'frame-response', id: m.id, bitmap }, [bitmap])
    ).catch((error) => worker.postMessage({ type: 'frame-response', id: m.id, error: String(error) }));
    return;
  }
  if (m.event === 'progress') {
    progress(m.data);
  } else if (m.event === 'project') {
    updateProject(m.data);
  } else if (m.event === 'diagnostic') {
    addDiagnostic(m.data);
  } else if (m.event === 'preview') {
    if (previewURL) {
      URL.revokeObjectURL(previewURL);
    }
    previewURL = URL.createObjectURL(m.blob);
  } else if (m.event === 'finished') {
    updateProject(m.data);
    setBusy(false);
    void refreshCanvases(true).then(() => viewer.fit());
    void loadDiagnostics();
    void storageInfo();
    $('status-title').textContent = phaseNames[m.data.status];
    if (m.data.error) {
      toast(m.data.error, true);
    }
  } else if (m.event === 'fatal') {
    setBusy(false);
    toast(m.error, true);
    addDiagnostic({ code: 'WORKER_ERROR', severity: 'error', message: m.error });
  } else if (m.event === 'export-progress') {
    $('progress-message').textContent = m.data.message;
    if (m.data.fraction) {
      $('progress-bar').style.width = `${m.data.fraction * 100}%`;
    }
  }
};
worker.onerror = (event) => {
  for (const pending of requests.values()) {
    pending.reject(new Error(event.message));
  }
  requests.clear();
  setBusy(false);
  toast(`Worker 错误：${event.message}`, true);
};
worker.onmessageerror = () => toast('Worker 消息无法解码。请保留现有结果并重新加载。', true);
$<HTMLInputElement>('file-input').onchange = (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) {
    void chooseFile(file);
  }
};
const drop = $('drop-zone');
drop.onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    $<HTMLInputElement>('file-input').click();
  }
};
drop.ondragover = (e) => {
  e.preventDefault();
  drop.classList.add('dragging');
};
drop.ondragleave = () => drop.classList.remove('dragging');
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove('dragging');
  const file = e.dataTransfer?.files[0];
  if (file) {
    void chooseFile(file);
  }
};
$('start-btn').onclick = () => void start();
$('demo-btn').onclick = () => void start($<HTMLSelectElement>('demo-select').value);
$('pause-btn').onclick = () => {
  void rpc('pause', { paused: !paused }).then((result) => {
    paused = result.paused;
    $('pause-btn').textContent = paused ? '继续' : '暂停';
    $('status-title').textContent = paused ? '已暂停 · 内存状态保留' : '继续处理';
  }).catch((e) => toast(String(e), true));
};
$('stop-btn').onclick = () => {
  void rpc('stop').then(() => toast('正在结束当前阶段，并尽可能合成、保存已处理的观察。')).catch((e) => toast(String(e), true));
};
$('fit-btn').onclick = () => viewer.fit();
$('native-btn').onclick = () => viewer.native();
$('zoom-in').onclick = () => viewer.zoom(1.3);
$('zoom-out').onclick = () => viewer.zoom(1 / 1.3);
$<HTMLSelectElement>('canvas-select').onchange = () => {
  selectionTouched = true;
  selectCanvas();
};
$<HTMLInputElement>('quality-toggle').onchange = (e) => viewer.setQuality((e.target as HTMLInputElement).checked);
$<HTMLSelectElement>('diagnostic-filter').onchange = renderDiagnostics;
$('more-diagnostics').onclick = () => void loadDiagnostics(false);
$('history-btn').onclick = () => {
  $<HTMLDialogElement>('history-dialog').showModal();
  void history();
};
$('more-projects').onclick = () => void history(false);
$('help-btn').onclick = () => $<HTMLDialogElement>('help-dialog').showModal();
for (const el of document.querySelectorAll<HTMLElement>('[data-close]')) {
  el.onclick = () => {
    $<HTMLDialogElement>(el.dataset.close!).close();
    video.pause();
  };
}
$('persist-btn').onclick = () => {
  void navigator.storage.persist().then((granted) =>
    toast(granted ? '浏览器已授予持久存储；清除网站数据仍会删除项目。' : '浏览器未授予持久存储。请导出重要结果，避免自动回收。')
  ).catch((error) => toast(String(error), true));
};
$('regions-btn').onclick = () => {
  draftRegions = structuredClone(manualRegions);
  draftRect = undefined;
  $<HTMLDialogElement>('regions-dialog').showModal();
  drawRegions();
};
const regionCanvas = $<HTMLCanvasElement>('region-canvas');
regionCanvas.onpointerdown = (e) => {
  if (!firstBitmap) {
    return;
  }
  draftStart = regionPoint(e);
  regionCanvas.setPointerCapture(e.pointerId);
};
regionCanvas.onpointermove = (e) => {
  if (!draftStart) {
    return;
  }
  const p = regionPoint(e);
  draftRect = {
    x: Math.min(p.x, draftStart.x),
    y: Math.min(p.y, draftStart.y),
    width: Math.abs(p.x - draftStart.x),
    height: Math.abs(p.y - draftStart.y),
  };
  drawRegions();
};
regionCanvas.onpointerup = () => {
  if (draftRect && draftRect.width >= 4 && draftRect.height >= 4) {
    const kind = $<HTMLSelectElement>('region-kind').value as Region['kind'];
    draftRegions.push({
      id: `manual-${draftRegions.length}`,
      name: kind === 'moving' ? `内容区域 ${draftRegions.length + 1}` : kind === 'fixed' ? '固定界面' : '主动忽略',
      kind,
      rect: draftRect,
      manual: true,
    });
  }
  draftStart = undefined;
  draftRect = undefined;
  drawRegions();
};
regionCanvas.onpointercancel = () => {
  draftStart = undefined;
  draftRect = undefined;
  drawRegions();
};
$('clear-regions').onclick = () => {
  draftRegions = [];
  drawRegions();
};
$('save-regions').onclick = () => {
  manualRegions = structuredClone(draftRegions);
  $('regions-count').textContent = manualRegions.length ? `${manualRegions.length} 个指定区域 ↗` : '自动识别 ↗';
  $<HTMLDialogElement>('regions-dialog').close();
};
$('export-project').onclick = () => void doExport('project');
$('export-png').onclick = () => void doExport('png');
globalThis.addEventListener('beforeunload', (e) => {
  if (busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});
void rpc('capabilities').then((c) => {
  if (!c.offscreen) {
    toast('当前浏览器缺少 OffscreenCanvas；无法运行渲染 Worker。', true);
  }
  if (!c.webcodecs) {
    toast('当前浏览器没有 WebCodecs。需要明确选择可能漏帧的兼容 seek 模式。');
  }
}).catch((error) => toast(`无法打开本地数据库：${String(error)}`, true));
void storageInfo();
// Stable debugging API exposes state, not a hidden server or cloud path.
(globalThis as unknown as {
  longScreen: unknown;
}).longScreen = { getProject: () => project, getCanvases: () => canvases, rpc, viewer };
