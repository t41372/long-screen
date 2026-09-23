import { assert, assertEquals } from '@std/assert';
import { harness } from './support.ts';
// The analysis downscale's WebGPU kernel against the Rust core it must match byte for byte, through the browser's
// real WebGPU implementation (Dawn + Tint; on a GPU-less host the SwiftShader adapter). Each case targets one way
// the kernel or its host code could diverge: partial boxes on the right/bottom edge, a packed-output tail when the
// output pixel count is not a multiple of four, an image smaller than one box, saturated sums, buffer re-creation
// across geometries within one computer, alpha (which luma ignores), and resident frames uploaded straight from
// core memory (shared memory under the threaded core) as well as plain JS frames.
Deno.test({
  name: 'browser: WebGPU box-luma is byte-identical to the core downscale on JS and core-resident frames',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ webgpu: true });
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      const r = await h.page.evaluate(async () => {
        const kit = (window as any).longScreenKit;
        const adapter = await (navigator as any).gpu?.requestAdapter();
        if (!adapter) return { adapter: null };
        const noise = (width: number, height: number, seed: number) => {
          const data = new Uint8ClampedArray(width * height * 4);
          let x = seed >>> 0;
          for (let i = 0; i < data.length; i++) {
            x = (Math.imul(x, 1103515245) + 12345) >>> 0;
            data[i] = x >>> 24;
          }
          return { width, height, data };
        };
        const saturated = (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
        const cases: [string, { width: number; height: number; data: Uint8ClampedArray }, number][] = [
          ['e.mov geometry', noise(3456, 2234, 1), 6],
          ['1.mov geometry, packed tail', noise(1418, 1590, 2), 3],
          ['partial boxes', noise(1418, 1590, 3), 7],
          ['smaller than a box', noise(5, 3, 4), 8],
          ['odd tiny', noise(97, 61, 5), 2],
          ['large factor', noise(1030, 770, 6), 64],
          ['saturated', saturated(1000, 999), 9],
        ];
        const computer = new kit.AnalysisComputer('webgpu');
        const results = [];
        for (const [name, image, factor] of cases) {
          const cpu = kit.downscaleGray(image, factor), gpu = await computer.gray(image, factor);
          const frame = kit.core().frame(image.width, image.height);
          let residentSame = false;
          try {
            frame.write(image.data);
            const residentGpu = await computer.gray(frame, factor), residentCpu = kit.downscaleGray(frame, factor);
            residentSame = residentGpu.width === residentCpu.width && residentGpu.height === residentCpu.height &&
              residentGpu.data.every((v: number, i: number) => v === residentCpu.data[i]) &&
              residentCpu.data.every((v: number, i: number) => v === cpu.data[i]);
          } finally {
            frame.free();
          }
          let firstDiff = -1;
          for (let i = 0; i < Math.max(cpu.data.length, gpu.data.length); i++) {
            if (cpu.data[i] !== gpu.data[i]) {
              firstDiff = i;
              break;
            }
          }
          results.push({
            name,
            size: [gpu.width, gpu.height],
            sameSize: gpu.width === cpu.width && gpu.height === cpu.height,
            firstDiff,
            residentSame,
          });
        }
        const stats = { ...computer.stats }, sharedUpload = computer.sharedUpload;
        computer.dispose();
        return {
          adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, fallback: adapter.info?.isFallbackAdapter },
          results,
          stats,
          sharedUpload,
          isolated: crossOriginIsolated,
          core: kit.corePlan.variant,
        };
      });
      assert(r.adapter, 'Chrome exposed no WebGPU adapter');
      console.log(
        `adapter ${JSON.stringify(r.adapter)}; core ${r.core}, isolated ${r.isolated}; zero-copy resident upload ${r.sharedUpload}`,
      );
      for (const c of r.results!) {
        assert(c.sameSize, `${c.name}: size`);
        assertEquals(c.firstDiff, -1, `${c.name}: first differing gray pixel`);
        assert(c.residentSame, `${c.name}: resident frame`);
      }
      // Every call ran on the GPU: no silent fallback to the CPU after the first-frame parity check.
      assertEquals(r.stats.backend, 'WebGPU box-luma + CPU registration', r.stats.reason);
      assertEquals(r.stats.cpuFrames, 0);
      assertEquals(r.stats.gpuFrames, 2 * r.results!.length);
      assert(r.stats.calibration?.bitExact);
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
