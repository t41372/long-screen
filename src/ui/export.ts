/** "下载大截图" (one native-size PNG) and "导出完整项目" (the archival ZIP), plus "复制大截图" to the clipboard. Both
 *  downloads prefer a native save-file picker and fall back to an anchor download / OPFS temporary copy. */
import type { AppState } from './state.ts';
import { $, humanBytes, toast } from './dom.ts';
import { call } from './rpc.ts';
import { t } from '../i18n/page.ts';
import type { ExportResult } from '../export/project.ts';
import type { Diagnostic } from '../types.ts';
import type { Run } from './run.ts';
import type { TiledViewer } from './viewer.ts';

/** File name for the downloaded image: the recording's name, not a generic one. */
function imageFileName(state: AppState): string {
  const stem = (state.project?.name || '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return `${stem || 'long-screen'}${t('ui.export.imageSuffix')}.png`;
}

type ExportKind = 'project' | 'png' | 'sheets';

export function createExport(state: AppState, viewer: TiledViewer, run: Run, addDiagnostic: (d: Diagnostic) => void) {
  let downloadURL: string | undefined;

  function cleanupTemporary(key?: string): void {
    if (key) void call('cleanup-export', { key }).catch(() => {});
  }
  async function doExport(kind: ExportKind): Promise<void> {
    if (!state.project || state.busy) {
      return;
    }
    let handle: FileSystemFileHandle | undefined;
    const c = viewer.current;
    const format = kind === 'png' ? 'png' : kind === 'sheets' ? 'png' : 'project';
    const name = kind === 'png' ? imageFileName(state) : kind === 'sheets' ? 'long-screen-sheets.zip' : 'long-screen-project.zip';
    const isZip = kind !== 'png';
    run.setBusy(true);
    $('run-controls').hidden = true;
    try {
      if ('showSaveFilePicker' in window) {
        try {
          handle = await (window as unknown as {
            showSaveFilePicker: (options: unknown) => Promise<FileSystemFileHandle>;
          }).showSaveFilePicker({
            suggestedName: name,
            types: [{
              description: isZip ? 'ZIP64 archive' : 'PNG image',
              accept: { [isZip ? 'application/zip' : 'image/png']: [isZip ? '.zip' : '.png'] },
            }],
          });
        } catch (error) {
          if ((error as DOMException).name === 'AbortError') {
            return;
          }
          toast(t('ui.export.savePickerFallback', { error: String(error) }));
        }
      }
      const result: ExportResult = await call('export', {
        projectId: state.project.id,
        canvasId: c?.id,
        format,
        layout: kind === 'sheets' ? 'sheets' : 'single',
        handle,
      });
      toast(result.message);
      if (result.blob) {
        if (downloadURL) {
          URL.revokeObjectURL(downloadURL);
        }
        const fileName = kind === 'png' ? name : result.name;
        downloadURL = URL.createObjectURL(result.blob);
        const row = document.createElement('div'), a = document.createElement('a');
        row.className = 'export-download-row';
        a.href = downloadURL;
        a.download = fileName;
        a.textContent = t('ui.export.saveRowLabel', { name: fileName, size: humanBytes(result.blob.size) });
        a.className = 'export-link';
        row.append(a);
        // On phones a download lands in Files; sharing is how an image reaches Photos. A fresh tap is required.
        const file = kind === 'png' ? new File([result.blob], fileName, { type: 'image/png' }) : undefined;
        if (file && navigator.canShare?.({ files: [file] })) {
          const share = document.createElement('button');
          share.className = 'secondary';
          share.textContent = t('ui.export.shareLabel');
          share.onclick = () =>
            void navigator.share({ files: [file] }).catch((error) => {
              if ((error as DOMException).name !== 'AbortError') toast(t('ui.export.shareFailed', { error: String(error) }), true);
            });
          row.append(share);
        }
        if (result.temporary) {
          const cleanup = document.createElement('button');
          cleanup.className = 'quiet';
          cleanup.textContent = t('ui.export.cleanupLabel');
          cleanup.onclick = () => {
            cleanupTemporary(result.temporary);
            if (downloadURL) URL.revokeObjectURL(downloadURL);
            $('export-download').replaceChildren();
          };
          row.append(cleanup);
        }
        $('export-download').replaceChildren(row);
        a.click();
      }
      $('progress-message').textContent = result.message;
    } catch (error) {
      toast(String(error), true);
      addDiagnostic({
        code: 'EXPORT_ERROR',
        severity: 'error',
        message: String(error),
        action: t('ui.export.exportErrorAction'),
      });
    } finally {
      run.setBusy(false);
    }
  }
  /** Copies the current canvas as one PNG. The clipboard write starts synchronously inside the click (Safari
   *  refuses clipboard writes started later) with the image as a promise, which the worker fulfils once encoded. */
  function doCopy(): void {
    const c = viewer.current;
    if (!state.project || state.busy || !c) return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      toast(t('ui.export.clipboardUnsupported'), true);
      return;
    }
    run.setBusy(true);
    $('run-controls').hidden = true;
    let temporary: string | undefined;
    const project = state.project;
    const png = call('export', { projectId: project.id, canvasId: c.id, format: 'png', layout: 'single' }).then((r) => {
      temporary = r.temporary;
      if (!r.blob) throw new Error(t('ui.export.copyNoImage'));
      return new Blob([r.blob], { type: 'image/png' });
    });
    let item: ClipboardItem;
    try {
      item = new ClipboardItem({ 'image/png': png });
    } catch (error) {
      png.then((b) => b, () => undefined).finally(() => cleanupTemporary(temporary));
      run.setBusy(false);
      toast(t('ui.export.copyFailedCtor', { error: String(error) }), true);
      return;
    }
    navigator.clipboard.write([item])
      .then(() => toast(t('ui.export.copySuccess', { width: Math.round(c.bounds.width), height: Math.round(c.bounds.height) })))
      .catch((error) => toast(t('ui.export.copyFailed', { error: String(error) }), true))
      .finally(() => {
        void png.catch(() => {}).finally(() => cleanupTemporary(temporary));
        run.setBusy(false);
      });
  }
  function wire(): void {
    $('export-project').onclick = () => void doExport('project');
    $('export-png').onclick = () => void doExport('png');
    $('export-sheets').onclick = () => void doExport('sheets');
    $('copy-png').onclick = () => doCopy();
  }
  return { doExport, doCopy, wire };
}
