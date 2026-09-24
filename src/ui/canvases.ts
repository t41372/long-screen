/** The canvas picker: fetching a project's canvas list, ranking/labelling it in the <select>, and switching the
 *  viewer to whichever one is selected. `mergeCanvas` is the write side a live 'progress' event uses to update one
 *  canvas's metadata without a full refetch. */
import type { AppState } from './state.ts';
import { $, toast } from './dom.ts';
import { call } from './rpc.ts';
import type { CanvasMeta } from '../types.ts';
import type { TiledViewer } from './viewer.ts';

export interface Canvases {
  refreshCanvases(all?: boolean): Promise<void>;
  updateCanvasOptions(): void;
  selectCanvas(fit?: boolean): void;
  mergeCanvas(meta: CanvasMeta): void;
  /** Coalesces refetches during a run: a full refresh at most every 1200ms of wall clock. */
  refreshIfStale(): void;
  reset(): void;
  wire(): void;
}

export function createCanvases(state: AppState, viewer: TiledViewer): Canvases {
  let refreshing = false, lastRefresh = 0, selectionTouched = false;

  async function refreshCanvases(all = false): Promise<void> {
    if (!state.project) {
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
      const id = state.project.id;
      const result = await call('open', { projectId: id });
      if (state.project?.id !== id) {
        return;
      }
      state.canvases = result.canvases.map((r) => r.value);
      if (all && result.canvases.length === 100) {
        let after = result.canvases.at(-1)!.key;
        while (true) {
          const more = await call('canvases', { projectId: id, after });
          state.canvases.push(...more.map((r) => r.value));
          if (more.length < 100) {
            break;
          }
          after = more.at(-1)!.key;
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
    const usable = state.canvases.filter((c) => c.tileCount && Number.isFinite(c.bounds.width) && Number.isFinite(c.bounds.height));
    if (!usable.length) {
      return;
    }
    const rank = (c: CanvasMeta) => c.kind === 'presentation' ? -1 : c.kind === 'fixed' ? 1 : 0;
    usable.sort((a, b) => rank(a) - rank(b) || b.observedPixels - a.observedPixels);
    select.replaceChildren(
      ...usable.map((c) => new Option(`${c.name} · ${Math.round(c.bounds.width)} × ${Math.round(c.bounds.height)}`, c.id)),
    );
    select.value = !selectionTouched && state.project?.settings.framing === 'context' && usable[0].kind === 'presentation'
      ? usable[0].id
      : usable.some((c) => c.id === old)
      ? old
      : usable[0].id;
    selectCanvas(false);
  }
  function selectCanvas(fit = true): void {
    const c = state.canvases.find((c) => c.id === $<HTMLSelectElement>('canvas-select').value);
    if (!c) {
      return;
    }
    viewer.setCanvas(c, state.project?.settings.tileSize || 512);
    if (fit) {
      viewer.fit();
    }
    $('empty-state').hidden = true;
    $('canvas-badge').hidden = false;
    $('canvas-badge').textContent = `${
      c.kind === 'presentation' ? '带框呈现 · 延伸背景非观察证据' : c.kind === 'fixed' ? '固定 / 观察层' : '二维内容层'
    } · ${c.tileCount} 原图瓦片${c.fragment ? ' · 片段间关系未证实' : ''}`;
    $<HTMLButtonElement>('export-png').disabled = state.busy || !c.tileCount;
    $<HTMLButtonElement>('export-sheets').disabled = state.busy || !c.tileCount;
    $<HTMLButtonElement>('copy-png').disabled = state.busy || !c.tileCount;
  }
  function mergeCanvas(meta: CanvasMeta): void {
    const existing = state.canvases.find((c) => c.id === meta.id);
    if (existing) {
      Object.assign(existing, meta);
    } else {
      state.canvases.push(meta);
    }
    updateCanvasOptions();
    if (viewer.current?.id === meta.id) {
      viewer.setCanvas(meta, state.project?.settings.tileSize || 512);
    }
  }
  function refreshIfStale(): void {
    if (performance.now() - lastRefresh > 1200) {
      void refreshCanvases();
    }
  }
  function reset(): void {
    selectionTouched = false;
  }
  function wire(): void {
    $<HTMLSelectElement>('canvas-select').onchange = () => {
      selectionTouched = true;
      selectCanvas();
    };
  }
  return { refreshCanvases, updateCanvasOptions, selectCanvas, mergeCanvas, refreshIfStale, reset, wire };
}
