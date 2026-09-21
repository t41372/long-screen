import { assert, assertEquals, assertRejects } from '@std/assert';
import { AnalysisComputer, BOX_LUMA_WGSL, type GPUProvider } from '../../src/core/compute.ts';
import { downscaleGray, equalRGBA } from '../../src/core/raster.ts';
import type { RGBA } from '../../src/types.ts';
const image = (): RGBA => ({
  width: 16,
  height: 12,
  data: Uint8ClampedArray.from({ length: 16 * 12 * 4 }, (_, i) => (i * 77 + (i >> 3)) % 256),
});
Deno.test('compute: CPU and missing-GPU fallback preserve integer-box analysis exactly', async () => {
  for (const mode of ['cpu', 'auto', 'webgpu'] as const) {
    // `null` means "no GPU in this context", explicitly; unlike `undefined` it must never resolve navigator.gpu.
    const c = new AnalysisComputer(mode, null), src = image();
    assertEquals(await c.gray(src, 2), downscaleGray(src, 2));
    assertEquals(await c.gray(src, 1), downscaleGray(src, 1));
    assertEquals(c.stats.backend, 'CPU');
    assertEquals(c.stats.cpuFrames, 2);
    c.dispose();
  }
});
Deno.test('compute: adapter absence and rejected requests preserve the current observation through CPU', async () => {
  const providers: GPUProvider[] = [{ requestAdapter: async () => null }, {
    requestAdapter: async () => {
      throw new Error('denied');
    },
  }, {
    requestAdapter: async () => ({
      requestDevice: async () => {
        throw new Error('device unavailable');
      },
    }),
  }];
  for (const provider of providers) {
    const c = new AnalysisComputer('webgpu', provider);
    assertEquals(await c.gray(image(), 2), downscaleGray(image(), 2));
    assertEquals(c.stats.gpuFrames, 0);
    assertEquals(c.stats.cpuFrames, 1);
    assert(c.stats.reason.length > 0);
    c.dispose();
  }
});
Deno.test('compute: invalid factors reject explicitly and disposal makes later requests CPU-only', async () => {
  const c = new AnalysisComputer('auto');
  await assertRejects(() => c.gray(image(), 0), Error, 'factor');
  await assertRejects(() => c.gray(image(), 1.5), Error, 'factor');
  c.dispose();
  assertEquals(await c.gray(image(), 2), downscaleGray(image(), 2));
  assert(BOX_LUMA_WGSL.includes('@compute'));
  assert(BOX_LUMA_WGSL.includes('77u'));
  assert(BOX_LUMA_WGSL.includes('150u'));
});
Deno.test('compute: duplicate detection is exact native RGBA, including alpha and one-pixel updates', () => {
  const a = image(), b = image();
  assert(equalRGBA(a, b));
  b.data[b.data.length - 1] ^= 1;
  assert(!equalRGBA(a, b));
  b.data[b.data.length - 1] ^= 1;
  b.data[0] ^= 1;
  assert(!equalRGBA(a, b));
  assert(!equalRGBA(a, { ...b, width: b.width + 1 }));
});
// A deterministic in-process WebGPU stand-in: writeBuffer stores raw bytes, submit() runs an exact JS box-luma over
// the stored input using the stored Params (so parity with the CPU path is genuinely exercised, not assumed), and
// mapAsync/lost are the only controllable knobs (readback latency, device loss) a real adapter would also expose.
function fakeGPU(options: { corrupt?: boolean; delayMS?: number; lost?: Promise<{ message?: string }> } = {}): GPUProvider {
  const delayMS = options.delayMS ?? 0;
  class FakeBuffer {
    bytes: Uint8Array;
    constructor(size: number) {
      this.bytes = new Uint8Array(Math.max(4, size));
    }
    async mapAsync(): Promise<void> {
      if (delayMS) await new Promise((r) => setTimeout(r, delayMS));
    }
    getMappedRange(): ArrayBuffer {
      return this.bytes.buffer as ArrayBuffer;
    }
    unmap(): void {}
    destroy(): void {}
  }
  let bound: { input: FakeBuffer; output: FakeBuffer; params: FakeBuffer } | undefined;
  const copies: { a: FakeBuffer; aOffset: number; b: FakeBuffer; bOffset: number; size: number }[] = [];
  const run = () => {
    if (!bound) return;
    const [width, height, factor, outWidth, outHeight] = new Uint32Array(bound.params.bytes.buffer);
    const src = new Uint32Array(bound.input.bytes.buffer), dst = new Uint32Array(bound.output.bytes.buffer);
    for (let y = 0; y < outHeight; y++) {
      for (let x = 0; x < outWidth; x++) {
        const bw = Math.min(factor, width - x * factor), bh = Math.min(factor, height - y * factor);
        let sum = 0;
        for (let j = 0; j < bh; j++) {
          for (let k = 0; k < bw; k++) {
            const pixel = src[(y * factor + j) * width + x * factor + k];
            sum += (pixel & 255) * 77 + ((pixel >> 8) & 255) * 150 + ((pixel >> 16) & 255) * 29;
          }
        }
        const luma = (sum / (bw * bh)) >> 8;
        dst[y * outWidth + x] = options.corrupt ? 255 - luma : luma;
      }
    }
    for (const c of copies) c.b.bytes.set(c.a.bytes.subarray(c.aOffset, c.aOffset + c.size), c.bOffset);
    copies.length = 0;
  };
  const device = {
    limits: { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30 },
    lost: options.lost ?? new Promise<{ message?: string }>(() => {}),
    queue: {
      writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void {
        const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        buffer.bytes.set(view, offset);
      },
      submit(): void {
        run();
      },
    },
    createBuffer: (o: { size: number; usage: number }) => new FakeBuffer(o.size),
    createShaderModule: () => ({}),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: (o: { entries: { binding: number; resource: { buffer: FakeBuffer } }[] }) => {
      const [input, output, params] = o.entries.map((e) => e.resource.buffer);
      // Dawn/Chrome validates a bound buffer against the WGSL uniform-address-space struct's rounded size;
      // `Params` (five u32) rounds to 32 bytes, so mimic that rejection here to catch a regression to the
      // pre-padding 20-byte allocation that only Deno's wgpu tolerated.
      if (params.bytes.length < 32) {
        throw new Error('Buffer size (' + params.bytes.length + ') is smaller than the minimum binding size (32) for uniform binding 2');
      }
      return bound = { input, output, params };
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({ setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: () => {}, end: () => {} }),
      copyBufferToBuffer: (a: FakeBuffer, aOffset: number, b: FakeBuffer, bOffset: number, size: number) => {
        copies.push({ a, aOffset, b, bOffset, size });
      },
      finish: () => ({}),
    }),
    destroy: () => {},
  };
  return { requestAdapter: async () => ({ requestDevice: async () => device }) };
}
Deno.test('compute: a bit-exact fake GPU calibrates, is used for the backend, and keeps producing correct output', async () => {
  const c = new AnalysisComputer('webgpu', fakeGPU()), src = image();
  const first = await c.gray(src, 2);
  assertEquals(first, downscaleGray(src, 2));
  assertEquals(c.stats.backend, 'WebGPU box-luma + CPU registration');
  assert(c.stats.calibration?.bitExact);
  assertEquals(c.stats.gpuFrames, 1);
  assertEquals(c.stats.cpuFrames, 0);
  assertEquals(await c.gray(src, 2), downscaleGray(src, 2));
  assertEquals(c.stats.gpuFrames, 2);
  c.dispose();
});
Deno.test('compute: a fake GPU that miscomputes fails calibration and falls back to CPU with the correct output', async () => {
  const c = new AnalysisComputer('webgpu', fakeGPU({ corrupt: true })), src = image();
  assertEquals(await c.gray(src, 2), downscaleGray(src, 2));
  assertEquals(c.stats.backend, 'CPU');
  assertEquals(c.stats.calibration?.bitExact, false);
  assert(c.stats.reason.length > 0);
  assertEquals(c.stats.gpuFrames, 0);
  assertEquals(c.stats.cpuFrames, 1);
  c.dispose();
});
Deno.test('compute: device loss after calibration falls back to CPU for every later frame', async () => {
  let resolveLost!: (info: { message?: string }) => void;
  const lost = new Promise<{ message?: string }>((resolve) => {
    resolveLost = resolve;
  });
  const c = new AnalysisComputer('webgpu', fakeGPU({ lost })), src = image();
  assertEquals(await c.gray(src, 2), downscaleGray(src, 2));
  assertEquals(c.stats.backend, 'WebGPU box-luma + CPU registration');
  resolveLost({ message: 'simulated loss' });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(c.stats.backend, 'CPU');
  assertEquals(await c.gray(src, 2), downscaleGray(src, 2));
  assertEquals(c.stats.backend, 'CPU');
  assertEquals(c.stats.gpuFrames, 1);
  c.dispose();
});
Deno.test('compute: auto mode stays on CPU when a bit-exact fake GPU measures slower than the CPU path', async () => {
  const c = new AnalysisComputer('auto', fakeGPU({ delayMS: 30 })), src = image();
  assertEquals(await c.gray(src, 2), downscaleGray(src, 2));
  assertEquals(c.stats.backend, 'CPU');
  assertEquals(c.stats.reason, 'CPU wins measured transfer + compute + readback');
  assert(c.stats.calibration?.bitExact);
  assertEquals(c.stats.gpuFrames, 0);
  assertEquals(c.stats.cpuFrames, 1);
  c.dispose();
});
