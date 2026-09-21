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
    const c = new AnalysisComputer(mode, undefined), src = image();
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
