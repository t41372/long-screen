/** Native <video> seek + frame-capture primitives, shared by source-file.ts (native-mode probing), diagnostics.ts
 *  (source-time review) and the worker's compatibility-mode frame-request bridge (routed through rpc.ts). */
import { $ } from './dom.ts';

export const video = $<HTMLVideoElement>('source-video');
// A dedicated hidden decoder element for compatibility-mode frame-request seeks, so they never race the
// user-facing dialog's own seeks on the same <video> (both seeking the shared element could resolve on
// whichever 'seeked' event fired first and capture the wrong-time frame).
export const decoderVideo = $<HTMLVideoElement>('decoder-video');

export function waitVideoOn(el: HTMLVideoElement, event: string, timeout = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, done);
      el.removeEventListener('error', failed);
    };
    const done = () => {
        cleanup();
        resolve();
      },
      failed = () => {
        cleanup();
        reject(new Error(el.error?.message || 'Native media playback failed.'));
      };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Native video ${event} timed out.`));
    }, timeout);
    el.addEventListener(event, done, { once: true });
    el.addEventListener('error', failed, { once: true });
  });
}
export function waitVideo(event: string, timeout = 20000): Promise<void> {
  return waitVideoOn(video, event, timeout);
}
export async function seekOn(el: HTMLVideoElement, time: number): Promise<void> {
  if (el.readyState >= 2 && Math.abs(el.currentTime - time) < .00001) {
    return;
  }
  const done = waitVideoOn(el, 'seeked');
  el.currentTime = Math.min(Math.max(0, time), Math.max(0, el.duration - .00001));
  await done;
  if (el.readyState < 2) {
    await waitVideoOn(el, 'loadeddata');
  }
}
export async function seek(time: number): Promise<void> {
  return seekOn(video, time);
}
export async function captureFrame(el: HTMLVideoElement): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(el);
  } catch (error) {
    // Some containers expose metadata but no capturable frame; a canvas draw is the second attempt, not a silent skip.
    const canvas = document.createElement('canvas');
    canvas.width = el.videoWidth;
    canvas.height = el.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.width) {
      throw error;
    }
    ctx.drawImage(el, 0, 0);
    return await createImageBitmap(canvas);
  }
}
export async function captureNativeFrame(): Promise<ImageBitmap> {
  return captureFrame(video);
}
