/** Captures of a <video> element's current frame, for compatibility mode's frame-request bridge (src/ui/main.ts) and
 *  source-time review. No DOM lookups here, so the test kit can drive them on its own elements. */

/** The frame as the page would show it, colour-converted to sRGB. */
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

/** A captured frame and whether it holds the coded values. */
export interface Capture {
  bitmap: ImageBitmap;
  coded: boolean;
}

/** The frame of an HDR recording as its coded values, without the browser's colour conversion, for the worker to
 *  convert in the core: Chrome tone-maps a converted capture (an iPhone recording's white came out at 184) and Safari
 *  shows the PQ signal as if it were sRGB (white at 140), while WebGL reads a capture taken with
 *  `colorSpaceConversion: 'none'` back as the coded values in both. Falls back to a converted capture, saying so. */
export async function captureCodedFrame(el: HTMLVideoElement): Promise<Capture> {
  try {
    return { bitmap: await createImageBitmap(el, { colorSpaceConversion: 'none' }), coded: true };
  } catch {
    return { bitmap: await captureFrame(el), coded: false };
  }
}
