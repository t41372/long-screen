import type { Gray, RGBA } from '../types.ts';
import { downscaleGray } from './raster.ts';

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
  requestAdapter(options?: unknown): Promise<{ requestDevice(): Promise<DeviceLike> } | null>;
}
export interface ComputeStats {
  backend: 'CPU' | 'WebGPU box-luma + CPU registration';
  reason: string;
  cpuFrames: number;
  gpuFrames: number;
  calibration?: { cpuMS: number; gpuMS: number; bitExact: boolean };
}
export const BOX_LUMA_WGSL = `
struct Params { width: u32, factor: u32, outWidth: u32, outHeight: u32 }
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> p: Params;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.outWidth || id.y >= p.outHeight) { return; }
    var sum = 0u;
    for (var j = 0u; j < p.factor; j++) {
        for (var k = 0u; k < p.factor; k++) {
            let pixel = src[(id.y * p.factor + j) * p.width + id.x * p.factor + k];
            sum += (pixel & 255u) * 77u + ((pixel >> 8u) & 255u) * 150u + ((pixel >> 16u) & 255u) * 29u;
        }
    }
    dst[id.y * p.outWidth + id.x] = (sum / (p.factor * p.factor)) >> 8u;
}`;
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
    inputBytes: number;
    outputBytes: number;
  };
  constructor(
    private mode: 'auto' | 'cpu' | 'webgpu' = 'auto',
    private provider: GPUProvider | undefined = (globalThis.navigator as unknown as { gpu?: GPUProvider } | undefined)?.gpu,
  ) {
    this.stats.reason = mode === 'cpu' ? 'CPU requested' : 'CPU until an integer downscale is calibrated';
  }
  private async initialize(): Promise<void> {
    if (!this.provider) throw new Error('WebGPU unavailable in this context');
    const adapter = await deadline(this.provider.requestAdapter({ powerPreference: 'high-performance' }), 4000);
    if (!adapter) throw new Error('No WebGPU adapter');
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
  async gray(image: RGBA, factor: number): Promise<Gray> {
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
        const start = performance.now(), cpu = downscaleGray(image, factor), cpuMS = performance.now() - start;
        // Warm-up dispatch is excluded, but timed dispatch still includes transfer and map/readback.
        await this.dispatch(image, factor);
        const gpuStart = performance.now(), gpu = await this.dispatch(image, factor), gpuMS = performance.now() - gpuStart;
        const bitExact = cpu.data.length === gpu.data.length && cpu.data.every((v, i) => v === gpu.data[i]);
        this.stats.calibration = { cpuMS, gpuMS, bitExact };
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
  private async dispatch(image: RGBA, factor: number): Promise<Gray> {
    const device = this.device!;
    const width = Math.floor(image.width / factor), height = Math.floor(image.height / factor);
    if (!width || !height) throw new Error('GPU factor exceeds an image dimension');
    const inputBytes = image.data.byteLength, outputBytes = width * height * 4;
    if (Math.max(inputBytes, outputBytes) > Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)) {
      throw new Error('GPU buffer limit exceeded');
    }
    if (!this.buffers || this.buffers.inputBytes !== inputBytes || this.buffers.outputBytes !== outputBytes) {
      this.releaseBuffers();
      const input = device.createBuffer({ size: inputBytes, usage: 128 | 8 }),
        output = device.createBuffer({ size: outputBytes, usage: 128 | 4 });
      const params = device.createBuffer({ size: 16, usage: 64 | 8 }), read = device.createBuffer({ size: outputBytes, usage: 1 | 8 });
      this.buffers = { input, output, params, read, inputBytes, outputBytes };
    }
    const { input, output, params, read } = this.buffers;
    device.queue.writeBuffer(input, 0, image.data);
    device.queue.writeBuffer(params, 0, new Uint32Array([image.width, factor, width, height]));
    const bindings = device.createBindGroup({
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [input, output, params].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, outputBytes);
    device.queue.submit([encoder.finish()]);
    await deadline(read.mapAsync(1), 4000);
    try {
      return { width, height, data: Uint8Array.from(new Uint32Array(read.getMappedRange())) };
    } finally {
      read.unmap();
    }
  }
  dispose(): void {
    this.disabled = true;
    this.releaseBuffers();
    this.device?.destroy();
    this.device = undefined;
  }
}
