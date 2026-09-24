/** DOM lookup, the toast, and the handful of pure formatters every feature module needs. No feature state lives
 *  here beyond the toast's own dismiss timer. */
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, error = false): void {
  const el = $('toast');
  el.textContent = message;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.hidden = true, error ? 16000 : 9000);
}

export const humanBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
export const timeText = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// Shown both as a capability toast on load and as the reason start() itself refuses to run: kept as one constant
// so the two call sites (main.ts, run.ts) can never drift into two slightly different explanations of the same limit.
export const NO_COMPRESSION_STREAM = '当前浏览器缺少 CompressionStream；每张原尺寸瓦片都靠它编码为 PNG，无法开始重建。';

export const phaseNames: Record<string, string> = {
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

/** Local storage quota, shown in the sidebar; re-queried after anything that changes usage (a run finishing, an
 *  export, a delete). Not re-queried when persist() is granted. */
export async function storageInfo(): Promise<void> {
  if (typeof navigator.storage?.estimate !== 'function') {
    $('storage-status').textContent = '浏览器未提供存储配额；不影响本地重建';
    return;
  }
  try {
    const estimate = await navigator.storage.estimate();
    $('storage-status').textContent = `本地已用 ${humanBytes(estimate.usage || 0)} / 可用配额 ${humanBytes(estimate.quota || 0)}`;
  } catch (error) {
    $('storage-status').textContent = '浏览器未提供存储配额';
    toast(`无法查询存储配额：${String(error)}`, true);
  }
}
