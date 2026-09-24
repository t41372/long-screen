/** Choosing a source recording: the file-input/drop-zone wiring, the probe RPC (with a native-player fallback), and
 *  the content fingerprint that later lets diagnostics.ts prove a reopened file is the same recording a project's
 *  source-time evidence came from. `fileFingerprint`/`readStoredHash` are pure/read-only and exported standalone so
 *  diagnostics.ts can use them without importing this module's `addDiagnostic`-emitting half (which would cycle
 *  back here, since `chooseFile` itself reports PROBE_FAILED as a diagnostic). */
import type { AppState } from './state.ts';
import { $, humanBytes, timeText, toast } from './dom.ts';
import { call } from './rpc.ts';
import { captureNativeFrame, decoderVideo, preview, seek, video, waitVideo, waitVideoOn } from './video.ts';
import { t } from '../i18n/page.ts';
import type { Diagnostic, MediaInfo } from '../types.ts';
import { sniffSource, type SourceSniff } from '../media/sniff.ts';

const MEDIA_HASH_PREFIX = 'long-screen-media-hash:';
// Matching name + byte size is not proof of identity (two different recordings can share both). Content
// fingerprint samples the first and last 64KB; it is not a full content hash.
export async function fileFingerprint(file: File): Promise<string> {
  const chunk = 64 * 1024, size = file.size;
  const head = await file.slice(0, Math.min(chunk, size)).arrayBuffer();
  const tail = size > chunk ? await file.slice(Math.max(0, size - chunk)).arrayBuffer() : new ArrayBuffer(0);
  const combined = new Uint8Array(head.byteLength + tail.byteLength);
  combined.set(new Uint8Array(head), 0);
  combined.set(new Uint8Array(tail), head.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function readStoredHash(projectId: string): string | null {
  try {
    return localStorage.getItem(MEDIA_HASH_PREFIX + projectId);
  } catch {
    return null;
  }
}
/** Drops the stored fingerprints of every project but `keep`, alongside the worker's sweep of the projects. */
export function forgetHashes(keep?: string): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(MEDIA_HASH_PREFIX) && key !== MEDIA_HASH_PREFIX + keep) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage unavailable: nothing was stored either.
  }
}
export function storeHash(projectId: string, hash: string): void {
  try {
    localStorage.setItem(MEDIA_HASH_PREFIX + projectId, hash);
  } catch {
    // Storage unavailable or full: source-time review just skips the identity check for this project.
  }
}

export interface SourceFile {
  chooseFile(file: File): Promise<void>;
  /** Takes the recording out: the screen and the slot go back to empty, as on first load. */
  clear(): void;
  wire(): void;
}

function rejectionText(name: string, sniff: Extract<SourceSniff, { supported: false }>): string {
  const kind = t(`ui.source.kind.${sniff.kind}`);
  return sniff.video ? t('ui.source.rejectedVideo', { name, kind }) : t('ui.source.rejectedOther', { name, kind });
}

export function createSourceFile(state: AppState, deps: { addDiagnostic(d: Diagnostic): void }): SourceFile {
  let videoURL: string | undefined;
  // Cancels the previous file's readiness listeners (decoderVideo's 'loadedmetadata'/'loadeddata'/'error'/timeout)
  // when a new file is chosen before they fired, so they never fire late against the new file's decoderVideo.src.
  let readinessAbort: AbortController | undefined;
  let choices = 0;

  async function chooseFile(file: File): Promise<void> {
    // A file that is not a video is refused before any state changes, so a recording chosen earlier stays selected.
    // The counter keeps a slower check of an earlier pick from landing after a later one. A file that cannot be read
    // at all is passed on: the probe and the native player report that the way they always have.
    const choice = ++choices, sniff = await sniffSource(file).catch((): SourceSniff => ({ supported: true }));
    if (choice !== choices) {
      return;
    }
    if (state.busy) {
      toast(t('ui.source.busyToast'));
      return;
    }
    if (!sniff.supported) {
      toast(rejectionText(file.name, sniff), true);
      return;
    }
    state.selectedFile = file;
    state.selectedFileHash = fileFingerprint(file).catch(() => undefined);
    state.mediaInfo = undefined;
    state.nativeReady = false;
    state.manualRegions = [];
    state.firstBitmap?.close();
    state.firstBitmap = undefined;
    if (videoURL) {
      URL.revokeObjectURL(videoURL);
    }
    videoURL = URL.createObjectURL(file);
    video.src = videoURL;
    decoderVideo.src = videoURL;
    preview.src = videoURL;
    void preview.play().catch(() => {});
    $('file-title').textContent = file.name;
    $('file-subtitle').textContent = t('ui.source.subtitleReading', { size: humanBytes(file.size) });
    $('regions-count').textContent = t('page.reconstruct.regionsAuto');
    $<HTMLButtonElement>('start-btn').disabled = false;
    $<HTMLButtonElement>('regions-btn').disabled = true;
    // Native element readiness is tracked for compatibility mode and source-time review; it is not required to
    // start. It is measured on decoderVideo, the element compatibility mode seeks (main.ts's onFrameRequest), not on
    // this preview. WebKit can leave a <video> at HAVE_METADATA without buffering any frame, so 'loadeddata' never
    // fires on its own: measured on Playwright WebKit 2248 with the preload="metadata" preview, and preload="auto"
    // is only a hint that mobile browsers may lower. Seeking to 0 after 'loadedmetadata' makes it load the first
    // frame ('loadeddata' ~100 ms later); where a frame is already buffered (Chrome) the seek is skipped.
    readinessAbort?.abort();
    const abort = readinessAbort = new AbortController();
    decoderVideo.addEventListener('loadedmetadata', () => {
      if (decoderVideo.readyState < 2) {
        decoderVideo.currentTime = 0;
      }
    }, { once: true, signal: abort.signal });
    void waitVideoOn(decoderVideo, 'loadeddata', { signal: abort.signal }).then(() => {
      state.nativeReady = Number.isFinite(decoderVideo.duration) && decoderVideo.duration > 0;
    }).catch((error) => {
      state.nativeReady = false;
      // A file the native player cannot play (e.g. VP9 Profile 1 in WebKit) ends here; the reason is logged so a
      // declined compatibility-mode start can be diagnosed.
      console.warn('decoderVideo did not become ready:', error);
    });
    const chosen = file;
    try {
      const probe = await call('probe', { file });
      if (state.selectedFile !== chosen) {
        probe.bitmap.close();
        return;
      }
      state.mediaInfo = probe.info;
      state.firstBitmap = probe.bitmap;
      $('file-subtitle').textContent = t('ui.source.subtitleDetailed', {
        width: state.mediaInfo.width,
        height: state.mediaInfo.height,
        duration: timeText(state.mediaInfo.duration),
        frames: state.mediaInfo.frameCount === undefined
          ? t('ui.count.framesUnknown')
          : t('ui.count.frames', { count: state.mediaInfo.frameCount, frames: String(state.mediaInfo.frameCount) }),
        codec: state.mediaInfo.codec,
        size: humanBytes(file.size),
      });
      $<HTMLButtonElement>('regions-btn').disabled = false;
      for (const warning of state.mediaInfo.warnings) {
        toast(warning);
      }
      return;
    } catch (error) {
      if (state.selectedFile !== chosen) {
        return;
      }
      deps.addDiagnostic({
        code: 'PROBE_FAILED',
        severity: 'warning',
        message: t('ui.source.probeFailedMessage', { error: String(error) }),
        action: t('ui.source.probeFailedAction'),
      });
    }
    try {
      if (video.readyState < 2) {
        await waitVideo('loadeddata');
      }
      if (state.selectedFile !== chosen) {
        return;
      }
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error('Native player does not expose a finite duration.');
      }
      state.nativeReady = true;
      const info: MediaInfo = {
        name: file.name,
        size: file.size,
        width: video.videoWidth,
        height: video.videoHeight,
        codedWidth: video.videoWidth,
        codedHeight: video.videoHeight,
        rotation: 0,
        duration: video.duration,
        codec: 'native media element',
        mode: 'Native seek',
        warnings: [],
        notices: [],
      };
      state.mediaInfo = info;
      await seek(0);
      const bitmap = await captureNativeFrame();
      if (state.selectedFile !== chosen) {
        bitmap.close();
        return;
      }
      state.firstBitmap = bitmap;
      $('file-subtitle').textContent = t('ui.source.subtitleNativeOnly', {
        width: info.width,
        height: info.height,
        duration: timeText(info.duration),
        size: humanBytes(file.size),
      });
      $<HTMLButtonElement>('regions-btn').disabled = false;
    } catch (error) {
      if (state.selectedFile !== chosen) {
        return;
      }
      $('file-subtitle').textContent = t('ui.source.subtitleUnavailable', { size: humanBytes(file.size) });
      toast(t('ui.source.unreadableToast', { reason: String(error) }), true);
    }
  }

  function wire(): void {
    $<HTMLInputElement>('file-input').onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        void chooseFile(file);
      }
    };
    const drop = $('drop-zone');
    drop.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        $<HTMLInputElement>('file-input').click();
      }
    };
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add('dragging');
    };
    drop.ondragleave = () => drop.classList.remove('dragging');
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('dragging');
      const file = e.dataTransfer?.files[0];
      if (file) {
        void chooseFile(file);
      }
    };
  }
  function clear(): void {
    // A pick still being sniffed or probed is dropped: chooseFile checks `choices` and `state.selectedFile`.
    choices++;
    readinessAbort?.abort();
    state.selectedFile = undefined;
    state.selectedFileHash = undefined;
    state.mediaInfo = undefined;
    state.nativeReady = false;
    state.manualRegions = [];
    state.firstBitmap?.close();
    state.firstBitmap = undefined;
    for (const el of [preview, video, decoderVideo]) {
      el.removeAttribute('src');
      el.load();
    }
    if (videoURL) {
      URL.revokeObjectURL(videoURL);
      videoURL = undefined;
    }
    // Lets the same file be chosen again: an unchanged <input type=file> value fires no change event.
    $<HTMLInputElement>('file-input').value = '';
    $('file-title').textContent = t('page.observe.dropTitle');
    $('file-subtitle').textContent = t('page.observe.dropSubtitle');
    $('regions-count').textContent = t('page.reconstruct.regionsAuto');
  }
  return { chooseFile, clear, wire };
}
