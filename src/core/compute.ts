import type { Gray, RGBA } from '../types.ts';
import { downscaleGray } from './raster.ts';
import { ResidentFrame } from './wasm.ts';

// A small structural surface keeps the CPU engine portable to runtimes without WebGPU DOM declarations.
interface BufferLike {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
interface DeviceLike {
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
  lost: Promise<{ message?: string }>;
  queue: { writeBuffer(buffer: BufferLike, offset: number, data: ArrayBuffer | ArrayBufferView): void; submit(commands: unknown[]): void };
  createBuffer(options: { size: number; usage: number }): BufferLike;
  createShaderModule(options: { code: string }): unknown;
  createComputePipelineAsync(options: unknown): Promise<{ getBindGroupLayout(index: number): unknown }>;
  createBindGroup(options: unknown): unknown;
  createCommandEncoder(): {
    beginComputePass(): {
      setPipeline(pipeline: unknown): void;
      setBindGroup(index: number, group: unknown): void;
      dispatchWorkgroups(x: number, y: number): void;
      end(): void;
    };
    copyBufferToBuffer(a: BufferLike, aOffset: number, b: BufferLike, bOffset: number, size: number): void;
    finish(): unknown;
  };
  destroy(): void;
}
export interface GPUProvider {
  requestAdapter(
    options?: unknown,
  ): Promise<{ requestDevice(): Promise<DeviceLike>; info?: { vendor?: string; architecture?: string; description?: string } } | null>;
}
export interface ComputeStats {
  backend: 'CPU' | 'WebGPU box-luma + CPU registration';
  reason: string;
  cpuFrames: number;
  gpuFrames: number;
  /** Medians of three timed runs each, after one warm-up; GPU time is upload + kernel + readback. */
  calibration?: { cpuMS: number; gpuMS: number; bitExact: boolean; adapter?: string };
}
export const BOX_LUMA_WGSL = `
struct Params { width: u32, height: u32, factor: u32, outWidth: u32, outHeight: u32 }
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> p: Params;
fn luma(o: u32) -> u32 {
    let x = o % p.outWidth;
    let y = o / p.outWidth;
    // Clamp the sampled box to the image, matching the CPU path: the last row/column of an integer downscale
    // can be smaller than factor when the native dimension isn't an exact multiple of it.
    let bw = min(p.factor, p.width - x * p.factor);
    let bh = min(p.factor, p.height - y * p.factor);
    var sum = 0u;
    for (var j = 0u; j < bh; j++) {
        let row = (y * p.factor + j) * p.width + x * p.factor;
        for (var k = 0u; k < bw; k++) {
            let pixel = src[row + k];
            sum += (pixel & 255u) * 77u + ((pixel >> 8u) & 255u) * 150u + ((pixel >> 16u) & 255u) * 29u;
        }
    }
    return (sum / (bw * bh)) >> 8u;
}
// Four consecutive output bytes per invocation, packed little-endian, so the readback is the gray image itself.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let n = p.outWidth * p.outHeight;
    let first = id.x * 4u;
    if (first >= n) { return; }
    var packed = 0u;
    for (var i = 0u; i < 4u; i++) {
        if (first + i < n) { packed |= luma(first + i) << (8u * i); }
    }
    dst[id.x] = packed;
}`;
/** WebGPU's per-dimension dispatch limit (the default `maxComputeWorkgroupsPerDimension`). */
const MAX_WORKGROUPS = 65535;
const median3 = (values: number[]) => [...values].sort((a, b) => a - b)[1];
function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('WebGPU operation timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
/** Optional real compute acceleration, never a fake GPU indicator. Auto compares upload + kernel + readback to CPU,
 * validates every analysis pixel on the first image, and stays on CPU if GPU isn't faster. Registration/composition
 * remain CPU algorithms. Adapter absence, allocation failure, loss and timeout preserve the observation via CPU. */
export class AnalysisComputer {
  readonly stats: ComputeStats = { backend: 'CPU', reason: 'CPU requested', cpuFrames: 0, gpuFrames: 0 };
  private tried = false;
  private disabled = false;
  private device?: DeviceLike;
  private pipeline?: { getBindGroupLayout(index: number): unknown };
  private buffers?: {
    input: BufferLike;
    output: BufferLike;
    params: BufferLike;
    read: BufferLike;
    bindings: unknown;
    inputBytes: number;
    outputBytes: number;
  };
  /** False once the runtime refused to upload from a shared-memory view (threaded core); frames are copied then. */
  private sharedUpload = true;
  private adapterName?: string;
  /** `undefined` (the default, when the argument is simply omitted) resolves `navigator.gpu` lazily on first use;
   * an explicit `null` means "no GPU in this context" and must never be upgraded by that lazy resolution. */
  constructor(private mode: 'auto' | 'cpu' | 'webgpu' = 'auto', private provider?: GPUProvider | null) {
    this.stats.reason = mode === 'cpu' ? 'CPU requested' : 'CPU until an integer downscale is calibrated';
  }
  private async initialize(): Promise<void> {
    if (this.provider === undefined) this.provider = (globalThis.navigator as unknown as { gpu?: GPUProvider } | undefined)?.gpu;
    if (!this.provider) throw new Error('WebGPU unavailable in this context');
    const adapter = await deadline(this.provider.requestAdapter({ powerPreference: 'high-performance' }), 4000);
    if (!adapter) throw new Error('No WebGPU adapter');
    const info = adapter.info;
    this.adapterName = info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || undefined : undefined;
    const device = await deadline(adapter.requestDevice(), 4000);
    if (this.disabled) {
      device.destroy();
      return;
    }
    this.device = device;
    void device.lost.then((info) => {
      if (!this.disabled) this.fallback(`Device lost: ${info.message || 'unknown'}`);
    });
    this.pipeline = await deadline(
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: BOX_LUMA_WGSL }), entryPoint: 'main' },
      }),
      4000,
    );
  }
  private releaseBuffers(): void {
    if (this.buffers) { for (const key of ['input', 'output', 'params', 'read'] as const) this.buffers[key].destroy(); }
    this.buffers = undefined;
  }
  private fallback(reason: string): void {
    this.disabled = true;
    this.stats.backend = 'CPU';
    this.stats.reason = reason;
    this.releaseBuffers();
    this.device?.destroy();
    this.device = undefined;
  }
  async gray(image: RGBA | ResidentFrame, factor: number): Promise<Gray> {
    if (!Number.isInteger(factor) || factor < 1) throw new Error(`Invalid analysis factor ${factor}.`);
    if (this.mode === 'cpu' || this.disabled || factor === 1 || factor > 128) {
      this.stats.cpuFrames++;
      return downscaleGray(image, factor);
    }
    try {
      if (!this.tried) {
        this.tried = true;
        await this.initialize();
        if (this.disabled) throw new Error('GPU initialization cancelled');
        // One warm-up each (pipeline, buffers, caches), then the median of three; GPU time includes the upload
        // and the map/readback, i.e. everything the scan pass would wait for.
        let cpu = downscaleGray(image, factor), gpu = await this.dispatch(image, factor);
        const cpuTimes: number[] = [], gpuTimes: number[] = [];
        for (let i = 0; i < 3; i++) {
          const started = performance.now();
          cpu = downscaleGray(image, factor);
          cpuTimes.push(performance.now() - started);
        }
        for (let i = 0; i < 3; i++) {
          const started = performance.now();
          gpu = await this.dispatch(image, factor);
          gpuTimes.push(performance.now() - started);
        }
        const cpuMS = median3(cpuTimes), gpuMS = median3(gpuTimes);
        const bitExact = cpu.data.length === gpu.data.length && cpu.data.every((v, i) => v === gpu.data[i]);
        this.stats.calibration = { cpuMS, gpuMS, bitExact, adapter: this.adapterName };
        if (!bitExact) throw new Error('GPU/CPU analysis parity failed');
        if (this.mode === 'auto' && gpuMS >= cpuMS * .9) {
          this.fallback('CPU wins measured transfer + compute + readback');
          this.stats.cpuFrames++;
          return cpu;
        }
        this.stats.backend = 'WebGPU box-luma + CPU registration';
        this.stats.reason = this.mode === 'auto'
          ? 'Bit-exact and faster in first-frame calibration'
          : 'Explicit WebGPU, first-frame parity validated';
        this.stats.gpuFrames++;
        return gpu;
      }
      const result = await this.dispatch(image, factor);
      this.stats.gpuFrames++;
      return result;
    } catch (error) {
      this.fallback(String(error));
      this.stats.cpuFrames++;
      return downscaleGray(image, factor);
    }
  }
  private async dispatch(frame: RGBA | ResidentFrame, factor: number): Promise<Gray> {
    const device = this.device!;
    // Same dimensions as the CPU path (raster.ts): a dimension smaller than `factor` still yields one output pixel.
    const width = Math.max(1, Math.ceil(frame.width / factor)), height = Math.max(1, Math.ceil(frame.height / factor));
    const pixels = width * height, words = Math.ceil(pixels / 4), groups = Math.ceil(words / 64);
    const inputBytes = frame.width * frame.height * 4, outputBytes = words * 4;
    if (Math.max(inputBytes, outputBytes) > Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)) {
      throw new Error('GPU buffer limit exceeded');
    }
    if (groups > MAX_WORKGROUPS) throw new Error('GPU dispatch limit exceeded');
    if (!this.buffers || this.buffers.inputBytes !== inputBytes || this.buffers.outputBytes !== outputBytes) {
      this.releaseBuffers();
      const input = device.createBuffer({ size: inputBytes, usage: 128 | 8 }),
        output = device.createBuffer({ size: outputBytes, usage: 128 | 4 });
      // WGSL rounds a uniform-address-space struct to 16-byte alignment: five u32 fields still cost 32 bytes
      // (SizeOf(Params) = roundUp(16, 20) = 32), and Chrome/Dawn validates the bound buffer against that
      // minimum, so a 20-byte allocation is rejected there even though Deno's wgpu tolerated it.
      const params = device.createBuffer({ size: 32, usage: 64 | 8 }), read = device.createBuffer({ size: outputBytes, usage: 1 | 8 });
      const bindings = device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [input, output, params].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      this.buffers = { input, output, params, read, bindings, inputBytes, outputBytes };
    }
    const { input, output, params, read, bindings } = this.buffers;
    this.upload(frame, input);
    device.queue.writeBuffer(params, 0, new Uint32Array([frame.width, frame.height, factor, width, height]));
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(groups, 1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, outputBytes);
    device.queue.submit([encoder.finish()]);
    await deadline(read.mapAsync(1), 4000);
    try {
      return { width, height, data: new Uint8Array(read.getMappedRange(), 0, pixels).slice() };
    } finally {
      read.unmap();
    }
  }
  /** A core-resident frame is uploaded straight from core memory: `writeBuffer` copies its source during the call,
   *  so a transient view is safe. A runtime that refuses a view of shared (threaded-core) memory gets a copy. */
  private upload(frame: RGBA | ResidentFrame, input: BufferLike): void {
    const queue = this.device!.queue;
    if (!(frame instanceof ResidentFrame)) {
      queue.writeBuffer(input, 0, frame.data);
      return;
    }
    if (this.sharedUpload) {
      try {
        queue.writeBuffer(input, 0, frame.view());
        return;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        this.sharedUpload = false;
      }
    }
    queue.writeBuffer(input, 0, frame.bytes());
  }
  dispose(): void {
    this.disabled = true;
    this.releaseBuffers();
    this.device?.destroy();
    this.device = undefined;
  }
}
