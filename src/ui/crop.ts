/** Crop: after a print is composed, the user drags a rectangle over it (or types its edges) to keep only part of a
 *  canvas. Each canvas's crop is kept with the stored print by the worker (`crop`/`crops`, src/export/crop.ts), so a
 *  reload keeps it, and every per-canvas export (PNG, copy, paged sheets) takes only that part; the project ZIP never
 *  does. The viewer veils what is cut away. Rectangle bookkeeping only: the pixels are cut by the export. */
import type { AppState } from './state.ts';
import { syncControls } from './state.ts';
import { $, toast } from './dom.ts';
import { call } from './rpc.ts';
import { t } from '../i18n/page.ts';
import { canvasRect, clampCrop, coversCanvas } from '../export/crop.ts';
import type { Rect } from '../types.ts';
import type { TiledViewer } from './viewer.ts';

export interface Crop {
  /** The kept crops of the current print, fetched again (after a restore). */
  load(): Promise<void>;
  /** Shows the current canvas's crop (after the canvas changed). */
  show(): void;
  /** Forgets every crop and leaves editing (a new or cleared print). */
  reset(): void;
  /** The current canvas's kept crop, if any. */
  current(): Rect | undefined;
  wire(): void;
}

type Grip = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
const GRIPS: Grip[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function createCrop(state: AppState, viewer: TiledViewer): Crop {
  let crops = new Map<string, Rect>(), draft: Rect | undefined, saving = false;
  const box = $('crop-box'), size = $('crop-size');
  const fields = {
    left: $<HTMLInputElement>('crop-left'),
    top: $<HTMLInputElement>('crop-top'),
    width: $<HTMLInputElement>('crop-width'),
    height: $<HTMLInputElement>('crop-height'),
  };

  const canvas = () => viewer.current;
  const current = () => {
    const c = canvas();
    return c ? crops.get(c.id) : undefined;
  };
  function label(): void {
    const kept = current(), button = $('crop-btn');
    button.textContent = kept ? t('ui.crop.buttonCropped', { width: kept.width, height: kept.height }) : t('page.crop.button');
    button.setAttribute('aria-pressed', String(!!kept));
  }
  function show(): void {
    if (state.cropping) {
      leave();
    }
    viewer.setCrop(current());
    label();
  }
  /** The crop box over the viewer, from `draft` and the viewer's current pan and zoom. */
  function place(): void {
    if (!state.cropping || !draft) {
      return;
    }
    const r = viewer.toScreen(draft);
    box.style.transform = `translate(${r.x}px, ${r.y}px)`;
    box.style.width = `${Math.max(0, r.width)}px`;
    box.style.height = `${Math.max(0, r.height)}px`;
    size.textContent = `${draft.width} × ${draft.height}`;
  }
  /** The numeric fields show the draft relative to the canvas's top-left corner, which reads as 0, 0. */
  function fill(): void {
    const c = canvas();
    if (!c || !draft) return;
    const origin = canvasRect(c.bounds);
    fields.left.value = String(draft.x - origin.x);
    fields.top.value = String(draft.y - origin.y);
    fields.width.value = String(draft.width);
    fields.height.value = String(draft.height);
    for (const f of Object.values(fields)) f.removeAttribute('aria-invalid');
  }
  function setDraft(rect: Rect, typed = false): void {
    draft = rect;
    viewer.setCrop(draft, true);
    if (!typed) fill();
    place();
  }
  function enter(): void {
    const c = canvas();
    if (!c || state.busy || state.cropping) return;
    state.cropping = true;
    document.body.classList.add('cropping');
    $('crop-bar').hidden = false;
    box.hidden = false;
    $('crop-btn').hidden = true;
    syncControls(state, viewer);
    setDraft(current() ?? canvasRect(c.bounds));
    viewer.fit();
    fields.width.focus();
  }
  function leave(): void {
    state.cropping = false;
    document.body.classList.remove('cropping');
    $('crop-bar').hidden = true;
    box.hidden = true;
    $('crop-btn').hidden = false;
    draft = undefined;
    syncControls(state, viewer);
  }
  function cancel(): void {
    leave();
    viewer.setCrop(current());
    label();
  }
  async function apply(): Promise<void> {
    const c = canvas(), project = state.project;
    if (!c || !project || !draft || saving) return;
    saving = true;
    try {
      const rect = coversCanvas(draft, c.bounds) ? null : draft;
      const kept = await call('crop', { projectId: project.id, canvasId: c.id, rect });
      if (state.project?.id !== project.id) return;
      if (kept) {
        crops.set(c.id, kept);
        toast(t('ui.crop.applied', { width: kept.width, height: kept.height }));
      } else {
        crops.delete(c.id);
        toast(t('ui.crop.removed'));
      }
      leave();
      viewer.setCrop(current());
      label();
    } catch (error) {
      toast(String(error), true);
    } finally {
      saving = false;
    }
  }
  /** Typed edges: applied to the draft as soon as they describe something inside the canvas; otherwise the field is
   *  marked invalid and the draft stays as it was. */
  function typed(): void {
    const c = canvas();
    if (!c || !draft) return;
    const origin = canvasRect(c.bounds), v = (f: HTMLInputElement) => f.value.trim() === '' ? NaN : Number(f.value);
    const rect = clampCrop(
      { x: origin.x + v(fields.left), y: origin.y + v(fields.top), width: v(fields.width), height: v(fields.height) },
      c.bounds,
    );
    for (const f of Object.values(fields)) f.toggleAttribute('aria-invalid', !rect);
    if (rect) setDraft(rect, true);
  }

  // Dragging the box moves the crop; dragging a grip moves its edges. Positions are world pixels, rounded to whole
  // pixels and kept inside the canvas, at least one pixel wide and tall.
  let drag: { grip: Grip; id: number; x: number; y: number; start: Rect } | undefined;
  function onDown(e: PointerEvent): void {
    if (!draft || e.button !== 0) return;
    const grip = ((e.target as HTMLElement).dataset.grip as Grip | undefined) ?? 'move';
    drag = { grip, id: e.pointerId, x: e.clientX, y: e.clientY, start: { ...draft } };
    box.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onMove(e: PointerEvent): void {
    const c = canvas();
    if (!drag || e.pointerId !== drag.id || !c) return;
    const bounds = canvasRect(c.bounds), scale = viewer.zoomScale;
    const dx = Math.round((e.clientX - drag.x) / scale), dy = Math.round((e.clientY - drag.y) / scale), s = drag.start;
    let left = s.x, top = s.y, right = s.x + s.width, bottom = s.y + s.height;
    if (drag.grip === 'move') {
      const x = Math.min(Math.max(bounds.x, s.x + dx), bounds.x + bounds.width - s.width),
        y = Math.min(Math.max(bounds.y, s.y + dy), bounds.y + bounds.height - s.height);
      setDraft({ x, y, width: s.width, height: s.height });
      return;
    }
    if (drag.grip.includes('w')) left = Math.min(Math.max(bounds.x, s.x + dx), right - 1);
    if (drag.grip.includes('e')) right = Math.max(Math.min(bounds.x + bounds.width, right + dx), left + 1);
    if (drag.grip.includes('n')) top = Math.min(Math.max(bounds.y, s.y + dy), bottom - 1);
    if (drag.grip.includes('s')) bottom = Math.max(Math.min(bounds.y + bounds.height, bottom + dy), top + 1);
    setDraft({ x: left, y: top, width: right - left, height: bottom - top });
  }
  function onUp(e: PointerEvent): void {
    if (drag?.id === e.pointerId) drag = undefined;
  }

  function reset(): void {
    if (state.cropping) leave();
    crops = new Map();
    label();
  }
  async function load(): Promise<void> {
    const project = state.project;
    if (!project) return;
    try {
      const kept = await call('crops', { projectId: project.id });
      if (state.project?.id !== project.id) return;
      crops = new Map(Object.entries(kept));
      show();
    } catch (error) {
      toast(String(error), true);
    }
  }
  function wire(): void {
    for (const grip of GRIPS) {
      const handle = document.createElement('i');
      handle.dataset.grip = grip;
      box.append(handle);
    }
    viewer.onDraw = place;
    box.addEventListener('pointerdown', onDown);
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
    // The wheel zooms the print under the box as it does anywhere else on it.
    box.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = $('viewer').getBoundingClientRect();
      viewer.zoom(Math.exp(-e.deltaY * .0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    $('crop-btn').onclick = enter;
    $('crop-cancel').onclick = cancel;
    $('crop-apply').onclick = () => void apply();
    $('crop-full').onclick = () => {
      const c = canvas();
      if (c) setDraft(canvasRect(c.bounds));
    };
    for (const f of Object.values(fields)) {
      f.addEventListener('input', typed);
      f.addEventListener('change', fill);
      f.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void apply();
      });
    }
    // Escape leaves cropping before it would close the spread-out print (main.ts listens on the bubbling phase).
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.cropping && !document.querySelector('dialog[open]')) {
        e.stopImmediatePropagation();
        cancel();
      }
    }, { capture: true });
  }
  return { load, show, reset, current, wire };
}
