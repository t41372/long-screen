/** The local project history dialog: paginated listing, "打开" (reopen an earlier project) and "删除" (the three-
 *  key-family delete now shared with device-check.ts via src/storage/projects.ts on the worker side). */
import type { AppState } from './state.ts';
import { $, phaseNames, storageInfo, toast } from './dom.ts';
import { call } from './rpc.ts';
import type { Project } from '../types.ts';
import type { Run } from './run.ts';
import type { Canvases } from './canvases.ts';
import type { Diagnostics } from './diagnostics.ts';
import type { TiledViewer } from './viewer.ts';

export function createHistory(state: AppState, viewer: TiledViewer, run: Run, canvases: Canvases, diagnostics: Diagnostics) {
  let projectCursor: string | undefined;
  // Defensive: dedupe history pages by project id, since a legacy/index pagination edge case on the worker side
  // could otherwise still hand back a project this session already rendered a row for.
  let historyIds = new Set<string>();

  async function openProject(id: string): Promise<void> {
    if (state.busy) {
      toast('请先完成当前处理。');
      return;
    }
    run.resetView();
    const result = await call('open', { projectId: id });
    state.project = result.project;
    run.updateProject(state.project!);
    await canvases.refreshCanvases(true);
    await diagnostics.loadDiagnostics();
    viewer.fit();
    run.setBusy(false);
    $('status-title').textContent = result.interrupted ? '处理曾中断 · 查看已提交结果' : phaseNames[state.project!.status];
    $('progress-message').textContent = state.project!.error || '本地结果已恢复；原视频没有复制进项目。';
    $('progress-count').textContent = `${state.project!.renderedFrames} 帧`;
    if (result.interrupted) {
      diagnostics.addDiagnostic({
        code: 'INTERRUPTED_SESSION',
        severity: 'warning',
        message: '上一次处理没有完成。仅已提交的数据可恢复；重新处理需要再次选择原视频，当前不支持断点续算。',
      });
    }
  }
  async function refresh(reset = true): Promise<void> {
    try {
      if (reset) {
        projectCursor = undefined;
        historyIds = new Set();
        $('history-list').replaceChildren();
      }
      const rows = await call('projects', { after: projectCursor });
      for (const row of rows) {
        const p: Project = row.value;
        if (historyIds.has(p.id)) {
          continue;
        }
        historyIds.add(p.id);
        const item = document.createElement('div');
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
            void call('delete', { projectId: p.id }).then(() => {
              item.remove();
              if (state.project?.id === p.id) {
                state.project = undefined;
                run.resetView();
                run.setBusy(false);
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
  function wire(): void {
    $('history-btn').onclick = () => {
      $<HTMLDialogElement>('history-dialog').showModal();
      void refresh();
    };
    $('more-projects').onclick = () => void refresh(false);
  }
  return { openProject, refresh, wire };
}
export type History = ReturnType<typeof createHistory>;
