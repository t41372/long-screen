/** What a chosen file is, read from its first bytes before anything tries to demux it. A file's name and `File.type`
 *  only say what the OS guessed, and the file input's `accept` list is bypassed by drag-and-drop and by the picker's
 *  "All files" choice — a Markdown file got as far as isobmff-probe.ts ("Invalid MP4 box") and then the native
 *  player's 20-second wait. Only ISOBMFF (MP4/MOV/M4V) and EBML (WebM/MKV) are passed on. A file this cannot place
 *  is passed on too when its name or type says video, so the demuxer, not this table, has the last word on it. */
/** What a refused file looks like, as a code the page translates (ui.source.kind in the i18n catalogues): this
 *  module is shared with the worker, so it carries no display text. */
export type SourceKind =
  | 'empty'
  | 'heif'
  | 'avi'
  | 'webp'
  | 'wav'
  | 'riff'
  | 'wmv'
  | 'flv'
  | 'mpegps'
  | 'ogg'
  | 'gif'
  | 'png'
  | 'jpeg'
  | 'pdf'
  | 'zip'
  | 'mp3'
  | 'text'
  | 'mpegts'
  | 'unknown';
export type SourceSniff = { supported: true } | {
  supported: false;
  kind: SourceKind;
  /** A video (or animation) in a container this project does not read, as opposed to not a video at all. */
  video: boolean;
};
const ISOBMFF_TOP_LEVEL = new Set(['ftyp', 'styp', 'sidx', 'moov', 'moof', 'mdat', 'free', 'skip', 'wide', 'pnot', 'junk', 'uuid']);
// HEIF/AVIF stills are ISOBMFF too, but carry no moov: an iPhone screenshot would otherwise reach the demuxer.
const IMAGE_BRANDS = new Set(['heic', 'heix', 'mif1', 'avif']);
const VIDEO_NAME = /\.(mp4|m4v|mov|qt|3gp|webm|mkv)$/i;
export async function sniffSource(file: File): Promise<SourceSniff> {
  const b = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
  const starts = (...bytes: number[]) => bytes.every((x, i) => b[i] === x);
  const no = (kind: SourceKind, video = false): SourceSniff => ({ supported: false, kind, video });
  if (!b.length) {
    return no('empty');
  }
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) {
    return { supported: true };
  }
  if (ISOBMFF_TOP_LEVEL.has(ascii(4, 8))) {
    return ascii(4, 8) === 'ftyp' && IMAGE_BRANDS.has(ascii(8, 12)) ? no('heif') : { supported: true };
  }
  if (ascii(0, 4) === 'RIFF') {
    const form = ascii(8, 12);
    return form === 'AVI ' ? no('avi', true) : form === 'WEBP' ? no('webp') : form === 'WAVE' ? no('wav') : no('riff');
  }
  if (starts(0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11)) {
    return no('wmv', true);
  }
  if (ascii(0, 3) === 'FLV') {
    return no('flv', true);
  }
  if (starts(0, 0, 1, 0xba) || starts(0, 0, 1, 0xb3)) {
    return no('mpegps', true);
  }
  if (ascii(0, 4) === 'OggS') {
    return no('ogg', true);
  }
  if (ascii(0, 4) === 'GIF8') {
    return no('gif', true);
  }
  if (starts(0x89, 0x50, 0x4e, 0x47)) {
    return no('png');
  }
  if (starts(0xff, 0xd8, 0xff)) {
    return no('jpeg');
  }
  if (ascii(0, 4) === '%PDF') {
    return no('pdf');
  }
  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    return no('zip');
  }
  if (ascii(0, 3) === 'ID3') {
    return no('mp3');
  }
  // Text: no NUL and no C0 control byte other than tab, line breaks, form feed and escape. PDF stays above this (its
  // header is text); MPEG-TS stays below, because its only mark is a sync byte ('G') every 188 bytes, which a text
  // file could carry, while a real stream's first packet always holds a NUL.
  if (b.every((x) => x >= 0x20 || x === 9 || x === 10 || x === 12 || x === 13 || x === 27)) {
    return no('text');
  }
  if (b[0] === 0x47 && b[188] === 0x47 && (b.length <= 376 || b[376] === 0x47)) {
    return no('mpegts', true);
  }
  return VIDEO_NAME.test(file.name) || file.type.startsWith('video/') ? { supported: true } : no('unknown');
}
