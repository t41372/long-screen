import { assert, assertEquals, assertThrows } from '@std/assert';
import { constantFrames, fillRGBA, linearPath, makeWorld, renderFrame, World } from '../../src/synthetic/world.ts';
import { buildScenario, SCENARIO_NAMES } from '../../src/synthetic/scenarios.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
import { DemoSource } from '../../src/media/demo.ts';
Deno.test('world: drawing primitives are deterministic, bounded and patch-aware', () => {
  const a = makeWorld(300, 400, 1, 'article'), b = makeWorld(300, 400, 1, 'article');
  assertEquals(a.data, b.data);
  for (const style of ['cards', 'list', 'comic', 'sparse'] as const) {
    assert(makeWorld(200, 300, 2, style).data.length === 200 * 300 * 4);
  }
  const w = new World(10, 10);
  w.set(-1, 0, [1, 2, 3]);
  w.set(10, 10, [1, 2, 3]);
  w.fill({ x: 8, y: 8, width: 5, height: 5 }, [9, 9, 9]);
  assertEquals(w.rgb(w.data, 9, 9), [9, 9, 9]);
  assertEquals(w.rgb(w.data, 7, 7), [251, 250, 246]);
  w.stroke({ x: 0, y: 0, width: 4, height: 4 }, [1, 1, 1]);
  assertEquals(w.rgb(w.data, 3, 0), [1, 1, 1]);
  assertEquals(w.rgb(w.data, 1, 1), [251, 250, 246]);
  w.picture({ x: 0, y: 0, width: 6, height: 6 }, 7);
  w.barChart({ x: 0, y: 0, width: 8, height: 8 }, 3);
  assert(w.textLine(0, 0, 10, 5) > 0);
  assert(w.paragraph(0, 0, 10, 2, 5) > 0);
  w.patch(5, { x: 2, y: 2, width: 3, height: 3 }, (s) => s.fill({ x: 0, y: 0, width: 3, height: 3 }, [0, 0, 0]));
  assertEquals(w.rgb(w.at(4), 3, 3), w.rgb(w.data, 3, 3));
  assertEquals(w.rgb(w.at(5), 3, 3), [0, 0, 0]);
  assertEquals(w.versions(3, 3).length, 2);
  assertEquals(w.versions(0, 0).length, 1);
  assertEquals(w.at(0), w.data);
});
Deno.test('world: paths, frames and RGBA fills', () => {
  const p = linearPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], [2, 5]);
  assertEquals(p.length, 8);
  assertEquals(p[p.length - 1], { x: 10, y: 10 });
  assertEquals(linearPath([{ x: 0, y: 0 }, { x: 4, y: 0 }], 4)[2], { x: 2, y: 0 });
  const f = constantFrames(3, 30, 1);
  assertEquals(f[2].time, 1 + 2 / 30);
  const img = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
  fillRGBA(img, { x: -1, y: -1, width: 3, height: 3 }, [5, 6, 7]);
  assertEquals([...img.data.subarray(0, 4)], [5, 6, 7, 255]);
  assertEquals(img.data[(3 * 4 + 3) * 4 + 3], 0);
});
Deno.test('scenarios: every catalogued scenario renders each frame with the declared geometry and overlay bookkeeping', () => {
  for (const name of SCENARIO_NAMES) {
    const s = buildScenario(name);
    assert(s.frames.length > 5 && s.layers.length > 0, name);
    for (const layer of s.layers) {
      assertEquals(layer.path.length, s.frames.length, `${name}/${layer.id} path length`);
    }
    for (const i of [0, Math.floor(s.frames.length / 2), s.frames.length - 1]) {
      const r = renderFrame(s, i), spec = s.frames[i];
      assertEquals(r.image.width, spec.width ?? s.width);
      assertEquals(r.image.height, spec.height ?? s.height);
      for (const rect of r.overlayRects) {
        assert(rect.width > 0 && rect.height > 0);
      }
    }
  }
  assertThrows(() => buildScenario('nope'), Error, 'Unknown scenario');
  const zoom = buildScenario('zoom'), last = renderFrame(zoom, zoom.frames.length - 1).image;
  assert(last.data.some((v, i) => i % 4 === 3 && v === 255));
  const dynamic = buildScenario('dynamic');
  assert(renderFrame(dynamic, 3).dynamicRects.body.length === 1);
  const counter = buildScenario('chrome-everything');
  assert(renderFrame(counter, 20).overlayRects.length >= 3);
  assertEquals(renderFrame(counter, 0).overlayRects.length, 3);
});
Deno.test('scenario source and demo source expose media info, frames and disposal', async () => {
  const source = new ScenarioSource(buildScenario('gap'));
  assertEquals(source.info.width, 640);
  assert(source.info.duration > 2);
  let n = 0;
  for await (const f of source.frames()) {
    assertEquals(f.index, n++);
    if (n === 3) {
      source.dispose();
    }
  }
  assertEquals(n, 3);
  const demo = new DemoSource('panes');
  assertEquals(demo.path.length, 75);
  assertEquals(demo.info.name, 'demo-panes.generated');
  assertEquals(new DemoSource().kind, 'traversal');
});
