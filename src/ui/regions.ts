/** The manual-regions editor dialog: draw fixed/ignore/moving rectangles over the first decoded frame, saved into
 *  `state.manualRegions` for the next `start()` to send as settings.regions. */
import type { AppState } from './state.ts';
import { $ } from './dom.ts';
import type { Region } from '../types.ts';

export function createRegions(state: AppState) {
  let draftRegions: Region[] = [], draftStart: { x: number; y: number } | undefined, draftRect: Region['rect'] | undefined;

  function drawRegions(): void {
    if (!state.firstBitmap) {
      return;
    }
    const canvas = $<HTMLCanvasElement>('region-canvas'), scale = Math.min(1, 850 / state.firstBitmap.width);
    canvas.width = Math.round(state.firstBitmap.width * scale);
    canvas.height = Math.round(state.firstBitmap.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(state.firstBitmap, 0, 0, canvas.width, canvas.height);
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
  function regionPoint(e: PointerEvent): { x: number; y: number } {
    const rect = $('region-canvas').getBoundingClientRect(), bitmap = state.firstBitmap!;
    return {
      x: Math.round(Math.max(0, Math.min(bitmap.width, (e.clientX - rect.left) * bitmap.width / rect.width))),
      y: Math.round(Math.max(0, Math.min(bitmap.height, (e.clientY - rect.top) * bitmap.height / rect.height))),
    };
  }
  function wire(): void {
    $('regions-btn').onclick = () => {
      draftRegions = structuredClone(state.manualRegions);
      draftRect = undefined;
      $<HTMLDialogElement>('regions-dialog').showModal();
      drawRegions();
    };
    const regionCanvas = $<HTMLCanvasElement>('region-canvas');
    regionCanvas.onpointerdown = (e) => {
      if (!state.firstBitmap) {
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
      state.manualRegions = structuredClone(draftRegions);
      $('regions-count').textContent = state.manualRegions.length ? `${state.manualRegions.length} 个指定区域 ↗` : '自动识别 ↗';
      $<HTMLDialogElement>('regions-dialog').close();
    };
  }
  return { wire };
}
