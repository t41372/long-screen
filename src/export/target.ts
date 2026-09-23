import type { ByteSink } from './zip.ts';
import { createId } from '../core/id.ts';
interface SyncFile {
  write(data: Uint8Array, options: {
    at: number;
  }): number;
  flush(): void;
  close(): void;
  truncate(size: number): void;
}
type Handle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<SyncFile>;
};
export interface ExportTarget {
  sink: ByteSink;
  result: () => Promise<{
    blob?: Blob;
    name: string;
    temporary?: string;
  }>;
}
/** Largest export assembled in memory where there is no disk to write to (Safari Private Browsing: no OPFS, no save
 *  picker). Such a session already holds the whole project in memory; past this the export stops with a clear error
 *  instead of risking the tab. */
export const MEMORY_EXPORT_LIMIT = 1024 * 1024 * 1024;
function memoryTarget(name: string, limit: number): ExportTarget {
  let parts: Uint8Array<ArrayBuffer>[] | undefined = [], size = 0, blob: Blob | undefined;
  return {
    sink: {
      write: async (data) => {
        if (!parts) throw new Error('Export is already closed.');
        size += data.byteLength;
        if (size > limit) {
          parts = undefined;
          throw new Error(
            `DISK_EXPORT_UNAVAILABLE: this browser offers no file to write to (no save picker, no OPFS — e.g. Safari Private Browsing), and the export exceeds the ${
              Math.round(limit / 1048576)
            } MB in-memory limit. Open the page in a normal window to export it.`,
          );
        }
        // Copied: writers may reuse their buffers after write() resolves.
        parts.push(data.slice() as Uint8Array<ArrayBuffer>);
      },
      close: async () => {
        if (!parts) throw new Error('Export is already closed.');
        blob = new Blob(parts, { type: name.endsWith('.png') ? 'image/png' : 'application/zip' });
        parts = undefined;
      },
      abort: async () => {
        parts = undefined;
      },
    },
    result: async () => {
      if (!blob) throw new Error('Export is not committed.');
      return { blob, name };
    },
  };
}
export async function createTarget(name: string, handle?: FileSystemFileHandle, memoryLimit = MEMORY_EXPORT_LIMIT): Promise<ExportTarget> {
  if (handle) {
    const writable = await handle.createWritable();
    return {
      sink: {
        write: async (data) => {
          await writable.write(data as Uint8Array<ArrayBuffer>);
        },
        close: () => writable.close(),
        abort: (e) => writable.abort(e),
      },
      result: async () => ({ name }),
    };
  }
  // Safari Private Browsing defines getDirectory() but rejects it; either way there is no disk, only memory.
  const root = await navigator.storage?.getDirectory?.().catch(() => undefined);
  if (!root) return memoryTarget(name, memoryLimit);
  const dir = await root.getDirectoryHandle('long-screen-exports', { create: true }),
    key = `${createId()}-${name}`,
    file = await dir.getFileHandle(key, { create: true }) as Handle;
  let closed = false;
  let sink: ByteSink;
  if (file.createSyncAccessHandle) {
    const sync = await file.createSyncAccessHandle();
    sync.truncate(0);
    let offset = 0;
    sink = {
      write: async (bytes) => {
        let written = 0;
        while (written < bytes.length) {
          const n = sync.write(bytes.subarray(written), { at: offset + written });
          if (n <= 0) {
            throw new Error('Export disk write made no progress.');
          }
          written += n;
        }
        offset += written;
      },
      close: async () => {
        sync.flush();
        sync.close();
        closed = true;
      },
      abort: async () => {
        if (!closed) {
          sync.close();
        }
        closed = true;
        await dir.removeEntry(key);
      },
    };
  } else {
    const writable = await file.createWritable();
    sink = {
      write: async (data) => {
        await writable.write(data as Uint8Array<ArrayBuffer>);
      },
      close: async () => {
        await writable.close();
        closed = true;
      },
      abort: async (e) => {
        await writable.abort(e);
        closed = true;
        await dir.removeEntry(key);
      },
    };
  }
  return {
    sink,
    result: async () => {
      if (!closed) {
        throw new Error('Export is not committed.');
      }
      return { blob: await file.getFile(), name, temporary: key };
    },
  };
}
export async function cleanupExport(key: string): Promise<void> {
  const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('long-screen-exports');
  await dir.removeEntry(key);
}
