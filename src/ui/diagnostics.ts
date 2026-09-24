/** The diagnostics panel: the warning badge's running counts, the (filterable, paginated) diagnostic list, and
 *  "查看原始时刻/定位受影响区域", which reopens the source video at the moment a diagnostic fired after checking the
 *  reopened file's content hash still matches what the project was built from. */
import type { AppState } from './state.ts';
import { $, timeText, toast } from './dom.ts';
import { call } from './rpc.ts';
import { fileFingerprint, readStoredHash } from './source-file.ts';
import { seek } from './video.ts';
import type { Diagnostic, Project, Severity } from '../types.ts';
import type { Canvases } from './canvases.ts';
import type { TiledViewer } from './viewer.ts';

export interface Diagnostics {
  addDiagnostic(d: Diagnostic): void;
  applyDiagnosticTotals(project: Project | undefined): void;
  loadDiagnostics(reset?: boolean): Promise<void>;
  renderDiagnostics(): void;
  reset(): void;
  wire(): void;
}

export function createDiagnostics(state: AppState, viewer: TiledViewer, canvases: Canvases): Diagnostics {
  let diagnosticRows: Diagnostic[] = [], diagnosticCursor: string | undefined, diagRefresh = false;
  // Per-code severity + authoritative occurrence count for the warning badge. Live events only ever raise a
  // code's count (never sum across events, which double-counts an already-cumulative number); `project.diagnostics`
  // — sent on every `project` event and on open — overrides the count with the true persisted total.
  const warningCounts = new Map<string, { severity: Severity; count: number }>();

  function trackDiagnostic(d: Diagnostic): void {
    const occurrences = d.occurrences ?? d.count ?? 1, existing = warningCounts.get(d.code);
    warningCounts.set(d.code, { severity: d.severity, count: Math.max(existing?.count || 0, occurrences) });
  }
  function updateWarningBadge(): void {
    const warnings = [...warningCounts.values()].filter((v) => v.severity !== 'info').reduce((s, v) => s + v.count, 0);
    $('warning-count').textContent = warnings > 999 ? '999+' : String(warnings);
    $('warning-count').classList.toggle('has-issues', warnings > 0);
  }
  // `project.diagnostics` only carries totals, not severity, so a code's severity comes from the persisted
  // `project.severities` (written by Engine.persist from Diagnostics.severities, covering the whole run, not just
  // whichever diagnostic rows this session happened to load) or from a severity this session already learned via a
  // live event or a loaded diagnostic row. A code with no known severity yet is left out of the badge entirely —
  // never defaulted to 'warning' — since e.g. an info code that only fires past the first page of persisted rows
  // must not inflate the warning count just because its severity hasn't been resolved yet.
  function applyDiagnosticTotals(project: Project | undefined): void {
    if (!project?.diagnostics) {
      return;
    }
    for (const [code, count] of Object.entries(project.diagnostics)) {
      const severity = project.severities?.[code] ?? warningCounts.get(code)?.severity;
      if (!severity) {
        continue;
      }
      warningCounts.set(code, { severity, count });
    }
    updateWarningBadge();
  }
  function addDiagnostic(d: Diagnostic): void {
    diagnosticRows.push(d);
    if (diagnosticRows.length > 180) {
      diagnosticRows.shift();
    }
    trackDiagnostic(d);
    updateWarningBadge();
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
    if (d.canvasId && state.canvases.some((c) => c.id === d.canvasId)) {
      $<HTMLSelectElement>('canvas-select').value = d.canvasId;
      canvases.selectCanvas(false);
      if (d.region) {
        viewer.focusRegion(d.region);
      }
    }
    if (d.time !== undefined) {
      if (
        !state.selectedFile || state.project?.name !== state.selectedFile.name || state.project?.media?.size !== state.selectedFile.size
      ) {
        toast('原始视频未包含在项目中。请重新选择对应录屏，再通过时间戳查看；合成结果仍保存在本地。');
        return;
      }
      // Name and size alone do not prove this is the same recording. Compare content hashes when we have one.
      const expectedHash = state.project?.id ? readStoredHash(state.project.id) : null;
      if (expectedHash && (await (state.selectedFileHash ?? fileFingerprint(state.selectedFile))) !== expectedHash) {
        toast('所选文件名称与大小相符，但内容哈希与本项目最初处理的录屏不一致，拒绝作为源时刻证据显示。请重新选择正确的录屏文件。', true);
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
    if (!state.project) {
      return;
    }
    if (reset) {
      diagnosticRows = [];
      diagnosticCursor = undefined;
    }
    try {
      const rows = await call('diagnostics', { projectId: state.project.id, after: diagnosticCursor });
      const loaded = rows.map((r) => r.value);
      diagnosticRows.push(...loaded);
      // Persisted rows carry real severity, unlike project.diagnostics; use them to learn severity for codes this
      // session never received a live event for (e.g. after reopening a project from history).
      for (const d of loaded) {
        trackDiagnostic(d);
      }
      applyDiagnosticTotals(state.project);
      diagnosticCursor = rows.at(-1)?.key || diagnosticCursor;
      $('more-diagnostics').hidden = rows.length < 100;
      renderDiagnostics();
    } catch (error) {
      toast(String(error), true);
    }
  }
  function reset(): void {
    diagnosticRows = [];
    diagnosticCursor = undefined;
    warningCounts.clear();
    $('warning-count').textContent = '0';
    $('warning-count').classList.remove('has-issues');
    renderDiagnostics();
  }
  function wire(): void {
    $<HTMLSelectElement>('diagnostic-filter').onchange = renderDiagnostics;
    $('more-diagnostics').onclick = () => void loadDiagnostics(false);
  }
  return { addDiagnostic, applyDiagnosticTotals, loadDiagnostics, renderDiagnostics, reset, wire };
}
