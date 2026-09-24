/** The local project history dialog: paginated listing, "打开" (reopen an earlier project) and "删除" (the three-
 *  key-family delete now shared with device-check.ts via src/storage/projects.ts on the worker side). */
import type { AppState } from './state.ts';
import { $, phaseName, storageInfo, toast } from './dom.ts';
import { call } from './rpc.ts';
import { t } from '../i18n/page.ts';
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
      toast(t('ui.history.busyToast'));
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
    $('status-title').textContent = result.interrupted ? t('ui.history.interruptedStatus') : phaseName(state.project!.status);
    $('progress-message').textContent = state.project!.error || t('ui.history.restoredMessage');
    $('progress-count').textContent = t('ui.count.frames', {
      count: state.project!.renderedFrames,
      frames: String(state.project!.renderedFrames),
    });
    if (result.interrupted) {
      diagnostics.addDiagnostic({
        code: 'INTERRUPTED_SESSION',
        severity: 'warning',
        message: t('ui.history.interruptedDiagnosticMessage'),
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
        sub.textContent = t('ui.history.rowSub', {
          date: new Date(p.created).toLocaleString(),
          frames: t('ui.count.frames', { count: p.renderedFrames, frames: String(p.renderedFrames) }),
          status: phaseName(p.status),
        });
        body.append(title, sub);
        const actions = document.createElement('div');
        actions.className = 'history-actions';
        const open = document.createElement('button');
        open.className = 'secondary';
        open.textContent = t('ui.history.openBtn');
        open.onclick = () => {
          void openProject(p.id).then(() => $<HTMLDialogElement>('history-dialog').close()).catch((e) => toast(String(e), true));
        };
        const remove = document.createElement('button');
        remove.className = 'quiet';
        remove.textContent = t('ui.history.deleteBtn');
        remove.onclick = () => {
          if (confirm(t('ui.history.deleteConfirm', { name: p.name }))) {
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
        $('history-list').textContent = t('ui.history.noProjects');
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
