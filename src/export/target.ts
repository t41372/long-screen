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
export async function createTarget(name: string, handle?: FileSystemFileHandle): Promise<ExportTarget> {
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
  if (!navigator.storage?.getDirectory) {
    throw new Error(
      'DISK_EXPORT_UNAVAILABLE: This browser has neither an export file handle nor OPFS. The project remains in IndexedDB for viewing in this browser; no unbounded in-memory export was attempted.',
    );
  }
  const root = await navigator.storage.getDirectory(),
    dir = await root.getDirectoryHandle('long-screen-exports', { create: true }),
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
