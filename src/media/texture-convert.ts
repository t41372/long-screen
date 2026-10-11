/** Reading a decoded frame's coded R'G'B' (its YUV matrix undone, nothing else) through the GPU, for the frames the
 *  copy-based converters cannot take: Chrome hands hardware-decoded 10-bit HEVC back with `format: null` (no
 *  `copyTo` at all; the 2D canvas then costs ~350 ms for a 3024 × 2018 frame, measured in Chrome 154 on Apple
 *  silicon), and HDR frames, which every browser's own RGB conversion either tone-maps (Chrome's canvas and
 *  `copyTo`) or leaves coded. What comes back is the coded signal; for an HDR stream the core then undoes its
 *  transfer (rust/core/src/yuv/hdr.rs).
 *
 *  WebGL2 with `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE` returned the coded values in Chrome 154, Safari 27 and
 *  Firefox 157 for SDR, PQ and HLG frames alike (within 2 levels of the encoder's input on the format matrix), so it
 *  is the reference every faster route is checked against, and the route of last resort (~80 ms for that frame in
 *  Chrome). WebGPU's external texture is faster (4–6 ms with the readback) but what it returns depends on the
 *  browser: Chrome passes SDR through and treats a PQ/HLG frame's coded values as BT.2020 linear light, converting
 *  them to BT.709 primaries and sRGB-encoding them (undoing the curve alone left saturated colours 17 levels off;
 *  undoing both matched WebGL exactly); Safari returned the coded values of 8-bit frames but none of these for its
 *  `format: null` 10-bit ones, and Firefox's HDR output matched none. So the first frame decides, against WebGL:
 *  `copyTo(RGBA)` (Firefox's RGB frames are already coded R'G'B'), WebGPU read through one of the three decodes, else
 *  WebGL for every frame.
 *  Dependency-free apart from conversion-check.ts: bundled into the conversion worker, also run in the pipeline
 *  worker when no conversion worker is available. */
import { agreement, agrees, type PlanarCheck } from './conversion-check.ts';
import { RGBA_COPY_OPTIONS } from './rgba-copy.ts';

/** How the returned pixels are packed: RGBA8, or RGB10A2 (little-endian, red in the low ten bits; WebGPU's
 *  `rgb10a2unorm`), which keeps a 10-bit HDR frame's precision at the same four bytes per pixel. */
export type Packing = 'rgba8' | 'rgb10a2';
export interface RawFrame {
  data: Uint8Array;
  packing: Packing;
}

/** WebGL2 readback of the coded R'G'B'. */
export class WebGLReader {
  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture;
  private framebuffer: WebGLFramebuffer;
  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.texture = gl.createTexture()!;
    this.framebuffer = gl.createFramebuffer()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }
  /** undefined where there is no OffscreenCanvas WebGL2 (it is then not a reference either). */
  static create(): WebGLReader | undefined {
    try {
      const gl = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('webgl2');
      return gl ? new WebGLReader(gl) : undefined;
    } catch {
      return undefined;
    }
  }
  /** `width × height` RGBA8, row 0 first, into `out` when given. */
  read(frame: VideoFrame | ImageBitmap, width: number, height: number, out: Uint8Array = new Uint8Array(width * height * 4)): Uint8Array {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out as Uint8Array<ArrayBuffer>);
    const error = gl.getError();
    if (error) throw new Error(`WebGL readback failed (${error})`);
    return out;
  }
  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.framebuffer);
    (this.gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
  }
}

/** How a WebGPU external texture's samples relate to the coded values: as they are, sRGB-encoded, or converted from
 *  BT.2020 to BT.709 primaries and then sRGB-encoded. */
export type Decode = 'identity' | 'srgb' | 'srgb-gamut';
const DECODES: Record<Decode, number> = { identity: 0, srgb: 1, 'srgb-gamut': 2 };
// deno-lint-ignore no-explicit-any
type GPU = any;
const SHADER = `@group(0) @binding(0) var src: texture_external;
struct Params { decode: u32 }
@group(0) @binding(1) var<uniform> params: Params;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
// BT.709 → BT.2020 primaries (ITU-R BT.2087), by columns.
const TO_2020 = mat3x3f(vec3f(0.627404, 0.069097, 0.016392), vec3f(0.329282, 0.919540, 0.088013), vec3f(0.043314, 0.011361, 0.895595));
@fragment fn fs(@builtin(position) at: vec4f) -> @location(0) vec4f {
  var c = textureLoad(src, vec2u(at.xy)).rgb;
  if (params.decode >= 1u) {
    // Sign-preserving, so a colour outside BT.709 (negative after the browser's conversion) comes back whole.
    let a = abs(c);
    c = sign(c) * select(pow((a + 0.055) / 1.055, vec3f(2.4)), a / 12.92, a <= vec3f(0.04045));
  }
  if (params.decode == 2u) {
    c = TO_2020 * c;
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}`;
/** WebGPU readback of the coded R'G'B' through an external texture. */
export class GPUReader {
  private pipelines = new Map<string, GPU>();
  private uniforms: Record<Decode, GPU>;
  private staging?: { buffer: GPU; texture: GPU; key: string };
  /** Reads share one staging texture and buffer, so they run one at a time (frames converted ahead overlap here). */
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private device: GPU) {
    const uniform = (value: number) => {
      const b = device.createBuffer({ size: 16, usage: 0x0040 | 0x0008 }); // UNIFORM | COPY_DST
      device.queue.writeBuffer(b, 0, new Uint32Array([value, 0, 0, 0]));
      return b;
    };
    this.uniforms = { identity: uniform(DECODES.identity), srgb: uniform(DECODES.srgb), 'srgb-gamut': uniform(DECODES['srgb-gamut']) };
  }
  /** undefined without WebGPU. `gpu` is `navigator.gpu`, injectable for tests; null means none. */
  static async create(gpu: GPU | null | undefined = (globalThis.navigator as GPU)?.gpu): Promise<GPUReader | undefined> {
    try {
      const device = await (await gpu?.requestAdapter())?.requestDevice();
      return device ? new GPUReader(device) : undefined;
    } catch {
      return undefined;
    }
  }
  read(frame: VideoFrame, width: number, height: number, decode: Decode, packing: Packing, out?: Uint8Array): Promise<Uint8Array> {
    const next = this.queue.then(() => this.readNow(frame, width, height, decode, packing, out));
    this.queue = next.catch(() => {});
    return next;
  }
  private async readNow(
    frame: VideoFrame,
    width: number,
    height: number,
    decode: Decode,
    packing: Packing,
    out?: Uint8Array,
  ): Promise<Uint8Array> {
    const device = this.device, format = packing === 'rgba8' ? 'rgba8unorm' : 'rgb10a2unorm';
    let pipeline = this.pipelines.get(format);
    if (!pipeline) {
      const module = device.createShaderModule({ code: SHADER });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      });
      this.pipelines.set(format, pipeline);
    }
    const row = Math.ceil(width * 4 / 256) * 256, key = `${format} ${width}x${height}`;
    if (this.staging?.key !== key) {
      this.staging?.buffer.destroy();
      this.staging?.texture.destroy();
      this.staging = {
        key,
        // RENDER_ATTACHMENT | COPY_SRC; MAP_READ | COPY_DST.
        texture: device.createTexture({ size: [width, height], format, usage: 0x10 | 0x01 }),
        buffer: device.createBuffer({ size: row * height, usage: 0x0001 | 0x0008 }),
      };
    }
    const { texture, buffer } = this.staging;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: device.importExternalTexture({ source: frame }) },
          { binding: 1, resource: { buffer: this.uniforms[decode] } },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(1); // READ
    const mapped = new Uint8Array(buffer.getMappedRange()), result = out ?? new Uint8Array(width * height * 4);
    if (row === width * 4) {
      result.set(mapped.subarray(0, width * height * 4));
    } else {
      for (let y = 0; y < height; y++) result.set(mapped.subarray(y * row, y * row + width * 4), y * width * 4);
    }
    buffer.unmap();
    return result;
  }
  dispose(): void {
    this.staging?.buffer.destroy();
    this.staging?.texture.destroy();
    this.device.destroy();
  }
}

/** RGB10A2 → RGBA8 (top eight bits of each channel), to compare a 10-bit reading with the 8-bit reference. */
export function eightBit(data: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length), words = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    out[4 * i] = (w & 1023) >> 2;
    out[4 * i + 1] = ((w >> 10) & 1023) >> 2;
    out[4 * i + 2] = ((w >> 20) & 1023) >> 2;
    out[4 * i + 3] = 255;
  }
  return out;
}

/** A route that reads a frame's coded R'G'B', with what it was measured at on the first frame. */
interface Route {
  name: string;
  read(frame: VideoFrame, width: number, height: number, out?: Uint8Array): Promise<Uint8Array> | Uint8Array;
  packing: Packing;
}
/** What `rawReader` settled on. */
export interface RawChoice {
  route: string;
  /** Milliseconds the chosen route took on the first frame. */
  ms: number;
  /** Agreement of the chosen route with the WebGL reference (absent for WebGL itself, or with no reference). */
  check?: PlanarCheck;
  /** False when nothing could be checked (no WebGL2): the route is the canvas, whose colours are the browser's. */
  verified: boolean;
}
/** How much closer to the reference (mean levels) a later route must come to replace an earlier one: routes come most
 *  likely first, and a frame of greys reads the same through decodes that differ only in the primaries matrix. */
const CLEARLY_CLOSER = 0.25;
const timed = async <T>(f: () => Promise<T> | T): Promise<[T, number]> => {
  const t0 = performance.now(), value = await f();
  return [value, performance.now() - t0];
};

/** Reads frames' coded R'G'B', choosing the route on the first frame (see the module comment); `hdr` frames are read
 *  at ten bits where the route allows. `canvas` is the last resort without WebGL2: the browser's own conversion,
 *  reported unverified. `compute: 'cpu'` keeps WebGPU out. */
export function rawReader(hdr: boolean, compute: 'auto' | 'cpu' | 'webgpu' = 'auto', gpu?: GPU | null): {
  /** The frame's coded R'G'B', written into `out` when given (4 bytes per pixel either packing). */
  read(frame: VideoFrame, width: number, height: number, out?: Uint8Array): Promise<RawFrame>;
  choice(): RawChoice | undefined;
  dispose(): void;
} {
  let route: Route | undefined, choice: RawChoice | undefined, deciding: Promise<void> | undefined;
  let webgl: WebGLReader | undefined, reader: GPUReader | undefined;
  const decide = async (frame: VideoFrame, width: number, height: number) => {
    webgl = WebGLReader.create();
    if (!webgl) {
      route = { name: '2D canvas (unverified)', packing: 'rgba8', read: (f, w, h) => canvasRead(f, w, h) };
      const [, ms] = await timed(() => route!.read(frame, width, height));
      choice = { route: route.name, ms, verified: false };
      return;
    }
    const gl = webgl;
    const [reference, glMS] = await timed(() => gl.read(frame, width, height));
    const candidates: Route[] = [];
    if (frame.format && typeof frame.copyTo === 'function') {
      candidates.push({
        name: 'copyTo(RGBA)',
        packing: 'rgba8',
        read: async (f, w, h, out) => {
          const data = out ?? new Uint8Array(w * h * 4);
          await f.copyTo(data, RGBA_COPY_OPTIONS);
          return data;
        },
      });
    }
    if (compute !== 'cpu') {
      reader = await GPUReader.create(gpu);
      const packing: Packing = hdr ? 'rgb10a2' : 'rgba8';
      // Ties (a frame of greys, which no primaries matrix moves) go to the earlier decode: Chrome's HDR conversion
      // includes the matrix, so 'srgb-gamut' comes before 'srgb'.
      for (const decode of ['identity', 'srgb-gamut', 'srgb'] as const) {
        if (reader) {
          const r = reader;
          candidates.push({
            name: `WebGPU external texture (${decode})`,
            packing,
            read: (f, w, h, out) => r.read(f, w, h, decode, packing, out),
          });
        }
      }
    }
    let best: { route: Route; check: PlanarCheck; ms: number } | undefined;
    for (const candidate of candidates) {
      try {
        // Twice, timing the second: the first call of a route pays its setup (shader compile, staging buffers).
        await candidate.read(frame, width, height);
        const [data, ms] = await timed(() => candidate.read(frame, width, height));
        const check = agreement(
          candidate.packing === 'rgb10a2' ? eightBit(data) : new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
          new Uint8ClampedArray(reference.buffer),
        );
        if (agrees(check) && (!best || check.meanDiff < best.check.meanDiff - CLEARLY_CLOSER)) best = { route: candidate, check, ms };
      } catch {
        // A route this browser cannot run on this frame is simply not a candidate.
      }
      // copyTo is the cheapest route there is: once it agrees, no GPU route is worth setting up.
      if (best?.route.name === 'copyTo(RGBA)') break;
    }
    if (best) {
      route = best.route;
      choice = { route: route.name, ms: best.ms, check: best.check, verified: true };
    } else {
      route = { name: 'WebGL readback', packing: 'rgba8', read: (f, w, h, out) => gl.read(f, w, h, out) };
      choice = { route: route.name, ms: glMS, verified: true };
    }
    if (!route.name.startsWith('WebGPU')) {
      reader?.dispose();
      reader = undefined;
    }
    if (route.name !== 'WebGL readback') {
      webgl.dispose();
      webgl = undefined;
    }
  };
  return {
    async read(frame, width, height, out) {
      if (!route) await (deciding ??= decide(frame, width, height));
      let data = await route!.read(frame, width, height, out);
      if (out && data !== out) {
        out.set(data);
        data = out;
      }
      return { data, packing: route!.packing };
    },
    choice: () => choice,
    dispose() {
      reader?.dispose();
      webgl?.dispose();
    },
  };
}

/** The browser's own conversion through a 2D canvas: what is left without WebGL2. */
function canvasRead(frame: VideoFrame, width: number, height: number): Uint8Array {
  const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('A 2D offscreen canvas could not be allocated for frame conversion.');
  ctx.drawImage(frame, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  return new Uint8Array(data.buffer, data.byteOffset, data.length);
}
