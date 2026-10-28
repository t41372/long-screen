/** "下载大截图" (one PNG at the chosen size) and "导出完整项目" (the archival ZIP), plus "复制大截图" to the clipboard. Both
 *  downloads prefer a native save-file picker and fall back to an anchor download / OPFS temporary copy. */
import { type AppState, syncControls } from './state.ts';
import { $, humanBytes, toast } from './dom.ts';
import { call } from './rpc.ts';
import { t } from '../i18n/page.ts';
import type { ExportResult } from '../export/project.ts';
import type { Diagnostic } from '../types.ts';
import type { TiledViewer } from './viewer.ts';
import type { OutputSize } from './output-size.ts';

/** File name for the downloaded image: the recording's name, not a generic one. */
function imageFileName(state: AppState): string {
  const stem = (state.project?.name || '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return `${stem || 'long-screen'}${t('ui.export.imageSuffix')}.png`;
}

type ExportKind = 'project' | 'png' | 'sheets';

export function createExport(state: AppState, viewer: TiledViewer, addDiagnostic: (d: Diagnostic) => void, outputSize: OutputSize) {
  let downloadURL: string | undefined;
  // The key whose export is running. The print is finished, so the printer stays at rest: the controls lock as they
  // do during a run, and the export shows its progress on this key instead of the printer's gauge.
  let working: HTMLElement | undefined;
  function setWorking(key: HTMLElement | undefined): void {
    working?.removeAttribute('aria-busy');
    working?.style.removeProperty('--export-done');
    working = key;
    key?.setAttribute('aria-busy', 'true');
    state.busy = key !== undefined;
    syncControls(state, viewer);
  }
  /** The worker's export progress, from 0 to 1, as the busy key's fill. */
  function progress(fraction: number): void {
    working?.style.setProperty('--export-done', `${Math.max(0, Math.min(1, fraction)) * 100}%`);
  }

  function cleanupTemporary(key?: string): void {
    if (key) void call('cleanup-export', { key }).catch(() => {});
  }
  async function doExport(kind: ExportKind): Promise<void> {
    if (!state.project || state.busy || state.cropping || (kind === 'png' && state.outputSizeInvalid)) {
      return;
    }
    let handle: FileSystemFileHandle | undefined;
    const c = viewer.current;
    const format = kind === 'png' ? 'png' : kind === 'sheets' ? 'png' : 'project';
    const name = kind === 'png' ? imageFileName(state) : kind === 'sheets' ? 'long-screen-sheets.zip' : 'long-screen-project.zip';
    const isZip = kind !== 'png';
    setWorking($(kind === 'png' ? 'export-png' : kind === 'sheets' ? 'export-sheets' : 'export-project'));
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
        size: kind === 'png' ? outputSize.options() : undefined,
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
      setWorking(undefined);
    }
  }
  /** Copies the current canvas as one PNG. The clipboard write starts synchronously inside the click (Safari
   *  refuses clipboard writes started later) with the image as a promise, which the worker fulfils once encoded. */
  function doCopy(): void {
    const c = viewer.current;
    if (!state.project || state.busy || state.cropping || state.outputSizeInvalid || !c) return;
    const copied = outputSize.dimensions()!;
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      toast(t('ui.export.clipboardUnsupported'), true);
      return;
    }
    setWorking($('copy-png'));
    let temporary: string | undefined;
    const project = state.project;
    const png = call('export', { projectId: project.id, canvasId: c.id, format: 'png', layout: 'single', size: outputSize.options() })
      .then((r) => {
        temporary = r.temporary;
        if (!r.blob) throw new Error(t('ui.export.copyNoImage'));
        return new Blob([r.blob], { type: 'image/png' });
      });
    let item: ClipboardItem;
    try {
      item = new ClipboardItem({ 'image/png': png });
    } catch (error) {
      png.then((b) => b, () => undefined).finally(() => cleanupTemporary(temporary));
      setWorking(undefined);
      toast(t('ui.export.copyFailedCtor', { error: String(error) }), true);
      return;
    }
    navigator.clipboard.write([item])
      .then(() => toast(t('ui.export.copySuccess', { width: copied.width, height: copied.height })))
      .catch((error) => toast(t('ui.export.copyFailed', { error: String(error) }), true))
      .finally(() => {
        void png.catch(() => {}).finally(() => cleanupTemporary(temporary));
        setWorking(undefined);
      });
  }
  function wire(): void {
    $('export-project').onclick = () => void doExport('project');
    $('export-png').onclick = () => void doExport('png');
    $('export-sheets').onclick = () => void doExport('sheets');
    $('copy-png').onclick = () => doCopy();
  }
  return { doExport, doCopy, progress, wire };
}
