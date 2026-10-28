/** Export-only size choice. It follows the kept crop, never changes the stored print, and resets for a new print. */
import { canvasRect } from '../export/crop.ts';
import { type ImageSize, outputDimensions } from '../export/size.ts';
import { $ } from './dom.ts';
import { type AppState, syncControls } from './state.ts';
import type { TiledViewer } from './viewer.ts';
import type { Crop } from './crop.ts';

export function createOutputSize(state: AppState, viewer: TiledViewer, crop: Crop) {
  const select = $<HTMLSelectElement>('output-size'), edge = $<HTMLInputElement>('output-max-edge');
  let projectId: string | undefined;
  const rect = () => crop.current() ?? (viewer.current ? canvasRect(viewer.current.bounds) : undefined);

  function options(): ImageSize | undefined {
    if (select.value === '1') return undefined;
    return select.value === 'custom' ? { maxEdge: edge.valueAsNumber } : { scale: Number(select.value) };
  }
  function dimensions() {
    const kept = rect();
    return kept ? outputDimensions(kept, options()) : undefined;
  }
  function refresh(): void {
    if (projectId !== state.project?.id) {
      projectId = state.project?.id;
      select.value = '1';
      edge.value = '8192';
    }
    const available = !!state.project && !!viewer.current?.tileCount;
    $('output-size-bar').hidden = !available;
    const custom = select.value === 'custom';
    $('output-edge-field').hidden = !custom;
    state.outputSizeInvalid = available && custom && !edge.validity.valid;
    edge.toggleAttribute('aria-invalid', state.outputSizeInvalid);
    const size = available && !state.outputSizeInvalid ? dimensions() : undefined;
    $('output-dimensions').textContent = size ? `${size.width} × ${size.height} px` : '—';
    syncControls(state, viewer);
  }
  function wire(): void {
    select.onchange = () => {
      refresh();
      if (select.value === 'custom') edge.focus();
    };
    edge.oninput = refresh;
    refresh();
  }
  return { options, dimensions, refresh, wire };
}
export type OutputSize = ReturnType<typeof createOutputSize>;
