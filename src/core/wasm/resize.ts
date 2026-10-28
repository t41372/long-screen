/** Row-only export resizer (mirrors rust/wasm/src/resize.rs). No source or output image is held in memory. */
import type { Core } from './core.ts';

export function resizeRows(core: Core, width: number, height: number, outputWidth: number, outputHeight: number) {
  const handle = core.check(core.exports.ls_resize_new(width, height, outputWidth, outputHeight), 'resize');
  return {
    push(row: Uint8Array): Uint8Array | undefined {
      if (row.length !== width * 4) throw new Error('Invalid resize row');
      const [input, output] = core.scratch([row.byteLength, outputWidth * 4]);
      core.writeBytes(input, row);
      const ready = core.check(core.exports.ls_resize_push(handle, input, output), 'resize row');
      return ready ? core.readBytes(output, outputWidth * 4) : undefined;
    },
    free(): void {
      core.exports.ls_resize_free(handle);
    },
  };
}
