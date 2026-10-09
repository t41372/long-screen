/** WebGPU YUV→RGBA for decoded frames. The frame's own planes are copied out (`copyTo` in its native layout, a plain
 *  copy), uploaded as textures, converted by the YUV matrix alone with chroma interpolated between its samples, and
 *  read back. Measured in Chrome on Apple silicon against `copyTo({ format: 'RGBA' })` on hardware-decoded H.264:
 *  within one level everywhere, and 4.3 ms a frame against 16 ms at 3456×2234 (2.5 against 5.4 ms at 1876×1272),
 *  which is most of what every decoding pass waited for (docs/ARCHITECTURE.md §十二). Importing the frame as an
 *  external texture is faster still but colour-manages it (BT.709 transfer to sRGB), lifting photo mid-tones by
 *  about ten levels; a screen recording's pixels came from an sRGB screen, so only the matrix is undone here. */
import type { MediaInfo, RGBA, Settings } from '../types.ts';
import type { FrameConverter } from './convert.ts';
import { agreement, agrees, matrixCode, type PlanarCheck } from './conversion-check.ts';
import { BufferPool, type PooledRGBA, releaseUnlessHeld } from './pool.ts';

// The structural surface this module uses, so the shell type-checks without WebGPU DOM declarations.
interface ReadBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
interface ConvertDevice {
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
  lost: Promise<{ message?: string }>;
  queue: {
    writeBuffer(buffer: ReadBuffer, offset: number, data: ArrayBufferView): void;
    writeTexture(
      destination: { texture: unknown },
      data: ArrayBufferView,
      layout: { offset: number; bytesPerRow: number },
      size: number[],
    ): void;
    submit(commands: unknown[]): void;
  };
  createBuffer(options: { size: number; usage: number }): ReadBuffer;
  createShaderModule(options: { code: string }): unknown;
  createComputePipelineAsync(options: unknown): Promise<{ getBindGroupLayout(index: number): unknown }>;
  createBindGroup(options: unknown): unknown;
  createSampler(options: unknown): unknown;
  createTexture(options: { size: number[]; format: string; usage: number }): Texture;
  createCommandEncoder(): {
    beginComputePass(): {
      setPipeline(pipeline: unknown): void;
      setBindGroup(index: number, group: unknown): void;
      dispatchWorkgroups(x: number, y: number): void;
      end(): void;
    };
    copyBufferToBuffer(a: ReadBuffer, aOffset: number, b: ReadBuffer, bOffset: number, size: number): void;
    finish(): unknown;
  };
  destroy(): void;
}
export interface ConvertGPUProvider {
  requestAdapter(options?: unknown): Promise<
    {
      requestDevice(options?: unknown): Promise<ConvertDevice>;
      limits?: { maxStorageBufferBindingSize: number; maxBufferSize: number };
      info?: { vendor?: string; architecture?: string };
    } | null
  >;
}
// GPUBufferUsage / GPUTextureUsage / GPUMapMode bits.
const MAP_READ = 0x1, COPY_SRC = 0x4, COPY_DST = 0x8, UNIFORM = 0x40, STORAGE = 0x80;
const TEXTURE_COPY_DST = 0x2, TEXTURE_BINDING = 0x4;
const WORKGROUP = 64;

const RGBA_WGSL = `
struct Params { size: vec2<u32>, chroma: vec2<u32>, nv12: u32, luma: vec2<f32>, chromaScale: f32, matrix: vec4<f32> }
@group(0) @binding(0) var lumaPlane: texture_2d<f32>;
@group(0) @binding(1) var uPlane: texture_2d<f32>;
@group(0) @binding(2) var vPlane: texture_2d<f32>;
@group(0) @binding(3) var linear: sampler;
@group(0) @binding(4) var<storage, read_write> rgba: array<u32>;
@group(0) @binding(5) var<uniform> p: Params;
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.size.x || id.y >= p.size.y) { return; }
    let y = (textureLoad(lumaPlane, id.xy, 0).r * 255.0 - p.luma.y) * p.luma.x;
    // Chroma interpolated between its samples at this pixel's centre (half resolution in both axes), as Chrome's own
    // copyTo(RGBA) of a hardware-decoded frame does; point sampling is up to 130 levels off it at a sharp colour edge.
    let at = (vec2<f32>(id.xy) + 0.5) * 0.5 / vec2<f32>(p.chroma);
    var c = textureSampleLevel(uPlane, linear, at, 0.0).rg;
    if (p.nv12 == 0u) { c = vec2<f32>(c.r, textureSampleLevel(vPlane, linear, at, 0.0).r); }
    let cb = (c.x * 255.0 - 128.0) * p.chromaScale;
    let cr = (c.y * 255.0 - 128.0) * p.chromaScale;
    let rgb = vec3<f32>(y + p.matrix.x * cr, y - p.matrix.y * cb - p.matrix.z * cr, y + p.matrix.w * cb);
    let v = vec3<u32>(round(clamp(rgb, vec3<f32>(0.0), vec3<f32>(255.0))));
    rgba[id.y * p.size.x + id.x] = v.r | (v.g << 8u) | (v.b << 16u) | 0xff000000u;
}`;

/** Uniforms for `matrixCode`'s matrices (BT.709, BT.601; limited or full range): luma scale and black level, chroma
 *  scale, and the R←Cr, G←Cb, G←Cr, B←Cb weights. */
function params(width: number, height: number, nv12: boolean, code: number): ArrayBuffer {
  const [kr, kb] = code < 2 ? [0.2126, 0.0722] : [0.299, 0.114], kg = 1 - kr - kb, full = code % 2 === 1;
  const buffer = new ArrayBuffer(64), u = new Uint32Array(buffer), f = new Float32Array(buffer);
  u.set([width, height, Math.ceil(width / 2), Math.ceil(height / 2), nv12 ? 1 : 0]);
  // WGSL layout: size @0, chroma @8, nv12 @16, luma @24 (vec2 align 8), chromaScale @32, matrix @48 (vec4 align 16).
  f.set(full ? [1, 0] : [255 / 219, 16], 6);
  f[8] = full ? 1 : 255 / 224;
  f.set([2 * (1 - kr), 2 * kb * (1 - kb) / kg, 2 * kr * (1 - kr) / kg, 2 * (1 - kb)], 12);
  return buffer;
}

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('WebGPU operation timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The frame layouts converted here: luma plus interleaved (NV12) or separate (I420) half-resolution chroma. */
export type PlaneFormat = 'NV12' | 'I420';
interface Texture {
  createView(): unknown;
  destroy(): void;
}

/** One device with its pipeline, plane textures and buffers. Conversions may overlap (the source converts the next
 *  frame while the pipeline works on the current one); each uploads its planes and submits in one synchronous step
 *  and reads back through its own buffer, and the queue runs uploads, dispatches and copies in submission order, so
 *  they share the textures and the storage buffer. */
class Session {
  private key = '';
  private storage?: ReadBuffer;
  private planes: Texture[] = [];
  private group: unknown;
  private readonly uniforms: ReadBuffer;
  private idle: ReadBuffer[] = [];
  private readonly scratch = new BufferPool();
  lost?: string;
  constructor(
    private readonly device: ConvertDevice,
    private readonly pipeline: { getBindGroupLayout(index: number): unknown },
    private readonly sampler: unknown,
    readonly adapter: string,
  ) {
    this.uniforms = device.createBuffer({ size: 64, usage: UNIFORM | COPY_DST });
    device.lost.then((info) => {
      this.lost = info.message || 'device lost';
    });
  }
  private prepare(width: number, height: number, format: PlaneFormat, code: number): void {
    const key = `${width}x${height} ${format} ${code}`, device = this.device;
    if (key === this.key) return;
    const bytes = width * height * 4;
    if (bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize) {
      throw new Error(`a ${width}×${height} frame exceeds this device's buffer limits`);
    }
    this.release();
    const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2), usage = TEXTURE_BINDING | TEXTURE_COPY_DST;
    this.planes = format === 'NV12'
      ? [
        device.createTexture({ size: [width, height], format: 'r8unorm', usage }),
        device.createTexture({ size: [cw, ch], format: 'rg8unorm', usage }),
      ]
      : [
        device.createTexture({ size: [width, height], format: 'r8unorm', usage }),
        device.createTexture({ size: [cw, ch], format: 'r8unorm', usage }),
        device.createTexture({ size: [cw, ch], format: 'r8unorm', usage }),
      ];
    this.storage = device.createBuffer({ size: bytes, usage: STORAGE | COPY_SRC });
    device.queue.writeBuffer(this.uniforms, 0, new Uint8Array(params(width, height, format === 'NV12', code)));
    const [y, u, v = u] = this.planes;
    this.group = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: y.createView() },
        { binding: 1, resource: u.createView() },
        { binding: 2, resource: v.createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.storage } },
        { binding: 5, resource: { buffer: this.uniforms } },
      ],
    });
    this.key = key;
  }
  async convert(
    frame: VideoFrame,
    width: number,
    height: number,
    format: PlaneFormat,
    code: number,
    out: Uint8ClampedArray,
  ): Promise<void> {
    if (this.lost) throw new Error(`GPU_CONVERSION_LOST: ${this.lost}`);
    const size = frame.allocationSize(), buffer = this.scratch.takeBuffer(size);
    let read: ReadBuffer;
    try {
      const layout = await frame.copyTo(new Uint8Array(buffer, 0, size));
      if (this.lost) throw new Error(`GPU_CONVERSION_LOST: ${this.lost}`);
      this.prepare(width, height, format, code);
      const device = this.device, bytes = width * height * 4, data = new Uint8Array(buffer, 0, size);
      const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
      read = this.idle.pop() ?? device.createBuffer({ size: bytes, usage: MAP_READ | COPY_DST });
      // Uploaded, encoded and submitted in one step, so overlapping conversions never interleave on the queue.
      this.planes.forEach((texture, i) => {
        const plane = layout[i];
        device.queue.writeTexture({ texture }, data, { offset: plane.offset, bytesPerRow: plane.stride }, i ? [cw, ch] : [width, height]);
      });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.group);
      pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP), height);
      pass.end();
      encoder.copyBufferToBuffer(this.storage!, 0, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
    } finally {
      this.scratch.releaseBuffer(buffer);
    }
    const key = this.key;
    try {
      await read.mapAsync(MAP_READ);
    } catch (error) {
      read.destroy();
      throw new Error(`GPU_CONVERSION_LOST: ${this.lost ?? (error instanceof Error ? error.message : String(error))}`);
    }
    out.set(new Uint8Array(read.getMappedRange()));
    read.unmap();
    if (key === this.key) this.idle.push(read);
    else read.destroy();
  }
  private release(): void {
    this.storage?.destroy();
    for (const t of this.planes) t.destroy();
    for (const b of this.idle) b.destroy();
    this.storage = undefined;
    this.planes = [];
    this.idle = [];
    this.key = '';
  }
  destroy(): void {
    this.release();
    this.uniforms.destroy();
    this.device.destroy();
  }
}

async function open(provider: ConvertGPUProvider | null | undefined): Promise<Session> {
  if (!provider) throw new Error('WebGPU unavailable');
  const adapter = await deadline(provider.requestAdapter({ powerPreference: 'high-performance' }), 4000);
  if (!adapter) throw new Error('no WebGPU adapter');
  // A 4K frame's RGBA already passes the default 128 MiB binding limit; ask for what the adapter allows.
  const limits = adapter.limits;
  const device = await deadline(
    adapter.requestDevice(
      limits
        ? { requiredLimits: { maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize, maxBufferSize: limits.maxBufferSize } }
        : {},
    ),
    4000,
  );
  try {
    const pipeline = await deadline(
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: RGBA_WGSL }), entryPoint: 'main' },
      }),
      4000,
    );
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const name = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ') || 'WebGPU';
    return new Session(device, pipeline, sampler, name);
  } catch (error) {
    device.destroy();
    throw error;
  }
}

/** First-frame agreement with the fallback's conversion, and both conversions' measured time. */
export interface GpuConversionCheck extends PlanarCheck {
  gpuMS: number;
  /** Absent with the explicit WebGPU setting, which skips the speed comparison. */
  fallbackMS?: number;
  adapter: string;
}

/** What the GPU path does with `frame`: its plane layout and `matrixCode`, or why it cannot take it. */
function layoutOf(frame: VideoFrame, info: MediaInfo): { format: PlaneFormat; code: number } | string {
  const width = info.codedWidth, height = info.codedHeight, rect = frame.visibleRect;
  if (info.rotation !== 0) return 'rotated container';
  if (frame.displayWidth !== width || frame.displayHeight !== height) return 'display size differs from the coded size';
  if (rect && (rect.width !== width || rect.height !== height || rect.x % 2 || rect.y % 2)) return 'visible rectangle off the chroma grid';
  if (frame.format !== 'NV12' && frame.format !== 'I420') return `${frame.format} planes`;
  const code = matrixCode(frame.colorSpace ?? undefined, frame.format, height);
  return code === undefined ? `${frame.colorSpace?.matrix} matrix` : { format: frame.format, code };
}

/** Timed conversions each way on the first frame, after a warm-up. */
const TIMED_RUNS = 3;
/** Converts on the GPU when its first frame agrees with `fallback`'s conversion of the same frame and, unless the
 *  setting asks for WebGPU explicitly, converts faster; otherwise every frame goes to `fallback`. The choice is made
 *  on the first frame and never changes, so a run never mixes two YUV→RGB conversions: once the GPU is chosen, a
 *  frame it cannot take (a lost device, a layout it does not convert) fails the run instead of switching. Rotated
 *  containers, non-square pixels, layouts other than NV12/I420 and BT.2020 or RGB planes are left to the
 *  fallback. */
export function gpuConverter(
  fallback: FrameConverter,
  mode: Settings['compute'] = 'auto',
  /** `undefined` resolves `navigator.gpu`; `null` means no WebGPU. */
  provider?: ConvertGPUProvider | null,
  /** Where converted frames' buffers come from and return to (the conversion worker shares its own). */
  pool = new BufferPool(),
): FrameConverter & { readonly gpu?: boolean; readonly check?: GpuConversionCheck } {
  let gpu: boolean | undefined, session: Session | undefined, check: GpuConversionCheck | undefined, reason: string | undefined;
  let deciding: Promise<unknown> | undefined;
  const decline = (why: string) => {
    gpu = false;
    reason ??= why;
    session?.destroy();
    session = undefined;
  };
  const onGPU = async (frame: VideoFrame, info: MediaInfo, layout: { format: PlaneFormat; code: number }): Promise<PooledRGBA> => {
    const width = info.codedWidth, height = info.codedHeight, image = pool.take(width, height);
    try {
      await session!.convert(frame, width, height, layout.format, layout.code, image.data);
      return image;
    } catch (error) {
      image.release();
      throw error;
    }
  };
  /** One warm-up (a GPU pipeline compiling, the fallback starting its own worker), then the fastest of a few timed
   *  runs: a single timed conversion is noisy enough to flip the choice for the whole run. */
  const fastest = async <T extends RGBA>(convert: () => Promise<T>): Promise<{ image: T; ms: number }> => {
    releaseUnlessHeld(await convert());
    let image: T | undefined, ms = Infinity;
    try {
      for (let run = 0; run < TIMED_RUNS; run++) {
        if (image) releaseUnlessHeld(image);
        image = undefined;
        const started = performance.now();
        image = await convert();
        ms = Math.min(ms, performance.now() - started);
      }
    } catch (error) {
      if (image) releaseUnlessHeld(image);
      throw error;
    }
    return { image: image!, ms };
  };
  const decide = async (frame: VideoFrame, info: MediaInfo, layout: { format: PlaneFormat; code: number }): Promise<RGBA> => {
    let image: PooledRGBA, gpuMS: number;
    try {
      session = await open(provider === undefined ? (globalThis.navigator as unknown as { gpu?: ConvertGPUProvider })?.gpu : provider);
      ({ image, ms: gpuMS } = await fastest(() => onGPU(frame, info, layout)));
    } catch (error) {
      decline(error instanceof Error ? error.message : String(error));
      return fallback(frame, info);
    }
    let reference: RGBA, fallbackMS: number | undefined;
    if (mode === 'auto') {
      ({ image: reference, ms: fallbackMS } = await fastest(async () => await fallback(frame, info)));
    } else {
      reference = await fallback(frame, info);
    }
    check = { ...agreement(reference.data, image.data), gpuMS, fallbackMS, adapter: session.adapter };
    if (!agrees(check)) {
      image.release();
      decline(`first frame ${check.meanDiff.toFixed(1)} from ${fallback.describe?.() ?? 'the fallback'}`);
      return reference;
    }
    if (fallbackMS !== undefined && gpuMS >= fallbackMS * .9) {
      image.release();
      decline(`${gpuMS.toFixed(1)} ms against ${fallbackMS.toFixed(1)} ms`);
      return reference;
    }
    gpu = true;
    releaseUnlessHeld(reference);
    // The fallback converts nothing more in this run; a worker behind it is let go.
    fallback.dispose?.();
    return image;
  };
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    while (deciding) await deciding.catch(() => {});
    if (gpu === false) return fallback(frame, info);
    const layout = layoutOf(frame, info);
    if (gpu) {
      if (typeof layout === 'string') throw new Error(`GPU conversion cannot take a frame (${layout}) after taking earlier ones`);
      return onGPU(frame, info, layout);
    }
    if (mode === 'cpu' || typeof layout === 'string') {
      decline(mode === 'cpu' ? 'CPU only' : layout as string);
      return fallback(frame, info);
    }
    const decision = decide(frame, info, layout);
    deciding = decision;
    try {
      return await decision;
    } finally {
      deciding = undefined;
    }
  };
  const describe = () =>
    gpu
      ? `WebGPU planes → RGBA (${check!.adapter}; first frame ${check!.meanDiff.toFixed(2)} from the fallback${
        check!.fallbackMS === undefined ? '' : `, ${check!.gpuMS.toFixed(1)} ms against ${check!.fallbackMS.toFixed(1)} ms`
      })`
      : `${fallback.describe?.() ?? 'fallback'}${reason ? ` (WebGPU declined: ${reason})` : ''}`;
  const dispose = () => {
    session?.destroy();
    session = undefined;
    fallback.dispose?.();
  };
  return Object.defineProperties(Object.assign(convert, { prefetch: true, describe, dispose }), {
    gpu: { get: () => gpu },
    check: { get: () => check },
  });
}
