/** The temporal record wire format (`TemporalRow` headers + blocks) the engine compositor's binding
 *  (`./compositor.ts`) reads and writes (mirrors `rust/wasm/src/temporal.rs`). */
import type { Rect } from '../../types.ts';
/** Bytes per serialised temporal record header (mirrors `TEMPORAL_RECORD_HEADER_BYTES` in
 *  rust/wasm/src/temporal.rs). */
export const TEMPORAL_RECORD_HEADER_BYTES = 66;

/** One temporal record as the engine compositor hands it over (a persisted `temporal/<canvas>/<id>` row minus its
 *  `canvasId`, which `Compositor.flush()`, src/core/compositor.ts, adds back). */
export interface TemporalRow {
  id: string;
  rect: Rect;
  /** Absolute [bx, by] block coordinates, in persisted (ascending (by, bx)) order. */
  blocks: [number, number][];
  chosenFrame: number;
  chosenTime: number;
  complete: boolean;
  revisions: number;
}

const idEncoder = new TextEncoder(), idDecoder = new TextDecoder();
function encodeId(mem: Uint8Array, at: number, id: string): void {
  mem.set(idEncoder.encode(id).subarray(0, 10), at);
}
export function decodeId(mem: Uint8Array, at: number): string {
  // slice(), not subarray(): with the threads build core memory is a SharedArrayBuffer, and browsers' TextDecoder
  // rejects shared views ("The provided ArrayBufferView value must not be shared"). Deno accepts them, so only the
  // real-recording run in Chrome caught this.
  return idDecoder.decode(mem.slice(at, at + 10));
}
function writeRectAt(view: DataView, at: number, r: Rect): void {
  view.setFloat64(at, r.x, true);
  view.setFloat64(at + 8, r.y, true);
  view.setFloat64(at + 16, r.width, true);
  view.setFloat64(at + 24, r.height, true);
}
function readRectAt(view: DataView, at: number): Rect {
  return {
    x: view.getFloat64(at, true),
    y: view.getFloat64(at + 8, true),
    width: view.getFloat64(at + 16, true),
    height: view.getFloat64(at + 24, true),
  };
}
export function writeRowHeader(mem: Uint8Array, view: DataView, at: number, row: Omit<TemporalRow, 'blocks'>, blockCount: number): void {
  encodeId(mem, at, row.id);
  writeRectAt(view, at + 10, row.rect);
  view.setUint32(at + 42, row.chosenFrame, true);
  view.setFloat64(at + 46, row.chosenTime, true);
  view.setUint32(at + 54, row.complete ? 1 : 0, true);
  view.setUint32(at + 58, row.revisions, true);
  view.setUint32(at + 62, blockCount, true);
}
export function readRowHeader(mem: Uint8Array, view: DataView, at: number): { row: Omit<TemporalRow, 'blocks'>; blockCount: number } {
  return {
    row: {
      id: decodeId(mem, at),
      rect: readRectAt(view, at + 10),
      chosenFrame: view.getUint32(at + 42, true),
      chosenTime: view.getFloat64(at + 46, true),
      complete: view.getUint32(at + 54, true) !== 0,
      revisions: view.getUint32(at + 58, true),
    },
    blockCount: view.getUint32(at + 62, true),
  };
}
export function writeBlocksAt(view: DataView, at: number, blocks: [number, number][]): void {
  blocks.forEach(([bx, by], i) => {
    view.setInt32(at + i * 8, bx, true);
    view.setInt32(at + i * 8 + 4, by, true);
  });
}
export function readBlocksAt(view: DataView, at: number, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) out.push([view.getInt32(at + i * 8, true), view.getInt32(at + i * 8 + 4, true)]);
  return out;
}
