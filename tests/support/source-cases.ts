/** Independent native-image counterexamples. Truth rectangles are used only by verifyLayer; the
 * detector receives the same RGBA frames and final poses as an ordinary recording. */
import { constantFrames, fillRGBA, type Overlay, type Scenario, World } from '../../src/synthetic/world.ts';
import { cursor, fixedBand } from '../../src/synthetic/scenarios.ts';
import { rng } from '../../src/core/math.ts';
import type { Point } from '../../src/types.ts';
export const SOURCE_CASES = [
  'once-clean',
  'once-clean-shared-background',
  'long-pause',
  'same-pose-disappearance',
  'following-page-overlay',
  'arriving-page-overlay',
  'moving-pointer',
  'translucent-scrollbar',
  'fading-scrollbar',
  'no-boundary-header',
  'partial-union',
] as const;
export type SourceCase = typeof SOURCE_CASES[number];
export function sourceCase(name: SourceCase): Scenario {
  const width = 320, height = 224, world = new World(width, 600, [246, 246, 246]), random = rng(9467);
  // Native texture supplies independent registration truth, including outside the test footprint.
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < width; x++) {
      const n = Math.floor(random() * 90);
      world.set(x, y, [70 + n, 75 + n, 80 + n]);
    }
  }
  const path: Point[] = Array.from({ length: 32 }, (_, i) => ({ x: 0, y: 100 + (i < 16 ? i : 31 - i) * 4 }));
  let overlays: Overlay[] = [];
  const panel = fixedBand('panel', { x: 48, y: 76, width: 224, height: 64 }, 612, [150, 150, 150]);
  if (name === 'once-clean') {
    overlays = [{
      ...panel,
      kind: 'dynamic',
      draw: (image, i, time) => i === 15 ? [] : panel.draw(image, i, time),
    }];
  }
  if (name === 'once-clean-shared-background') {
    world.fill({ x: 0, y: 0, width, height: 600 }, [246, 246, 246]);
    for (let y = 0; y < 600; y += 24) world.textLine(12, y, 290, 100 + y, [40, 40, 40]);
    const sameBackground = fixedBand('panel', { x: 48, y: 76, width: 224, height: 64 }, 612, [246, 246, 246]);
    overlays = [{ ...sameBackground, kind: 'dynamic', draw: (image, i, time) => i === 15 ? [] : sameBackground.draw(image, i, time) }];
  }
  if (name === 'long-pause') {
    path.splice(1, 0, ...Array.from({ length: 80 }, () => ({ ...path[0] })));
    overlays = [{ ...panel, kind: 'dynamic', draw: (image, i, time) => i === path.length - 1 ? [] : panel.draw(image, i, time) }];
  }
  if (name === 'same-pose-disappearance') {
    for (let i = 24; i < path.length; i++) path[i] = { ...path[23] };
    overlays = [{ ...panel, kind: 'dynamic', draw: (image, i, time) => i >= 28 ? [] : panel.draw(image, i, time) }];
  }
  if (name === 'following-page-overlay') {
    overlays = [{
      id: 'following-page-panel',
      kind: 'dynamic',
      draw: (image, i, time) =>
        fixedBand(
          'panel',
          {
            x: 48,
            y: i < 16 ? 76 : 76 + path[15].y - path[i].y,
            width: 224,
            height: 64,
          },
          612,
          [150, 150, 150],
        ).draw(image, i, time),
    }];
  }
  if (name === 'arriving-page-overlay') {
    overlays = [{
      id: 'arriving-panel',
      kind: 'dynamic',
      draw: (image, i, time) =>
        i < 6 || i >= 28 ? [] : fixedBand(
          'panel',
          { x: 48, y: i < 10 ? 76 + path[10].y - path[i].y : 76, width: 224, height: 64 },
          612,
          [150, 150, 150],
        ).draw(image, i, time),
    }];
  }
  if (name === 'moving-pointer') overlays = [cursor((i) => ({ x: 50 + i * 6, y: 90 + Math.floor(i / 4) * 2 }))];
  if (name === 'translucent-scrollbar' || name === 'fading-scrollbar') {
    overlays = [{
      id: 'alpha-thumb',
      kind: 'dynamic',
      draw: (image, i) => {
        if (i >= 28) return [];
        const rect = { x: width - 9, y: 36 + Math.floor(i / 2) * 2, width: 6, height: 52 };
        for (let y = rect.y; y < rect.y + rect.height; y++) {
          for (let x = rect.x; x < rect.x + rect.width; x++) {
            const at = (y * width + x) * 4, edgeAlpha = (x === rect.x || x === rect.x + rect.width - 1) ? 0.12 : 0.45;
            const alpha = edgeAlpha * (name === 'fading-scrollbar' ? Math.min(1, (28 - i) / 8) : 1);
            for (let c = 0; c < 3; c++) image.data[at + c] = Math.round(image.data[at + c] * (1 - alpha) + 30 * alpha);
          }
        }
        return [rect];
      },
    }];
  }
  if (name === 'no-boundary-header') {
    world.fill({ x: 0, y: 0, width, height: 600 }, [246, 246, 246]);
    for (let y = 0; y < 600; y += 24) world.textLine(12, y, 290, 100 + y, [40, 40, 40]);
    const header = fixedBand('header', { x: 0, y: 0, width, height: 40 }, 84, [246, 246, 246]);
    overlays = [{ ...header, kind: 'dynamic', draw: (image, i, time) => i >= 28 ? [] : header.draw(image, i, time) }];
  }
  if (name === 'partial-union') {
    overlays = [{
      id: 'partial-cover',
      kind: 'dynamic',
      draw: (image, i) => {
        const rect = { x: i % 8 < 4 ? 128 : 144, y: 72, width: 16, height: 80 };
        fillRGBA(image, rect, [30, 30, 30]);
        fillRGBA(image, { x: rect.x + 4, y: rect.y + 8, width: 8, height: 64 }, [230, 230, 230]);
        return [rect];
      },
    }];
  }
  return {
    name: `source-${name}`,
    description: name,
    width,
    height,
    background: [246, 246, 246],
    layers: [{ id: 'page', viewport: { x: 0, y: 0, width, height }, world, path }],
    overlays,
    frames: constantFrames(path.length),
    settings: {
      analysisSize: 320,
      tileSize: 256,
      regions: [{ id: 'page', name: 'page', kind: 'moving', rect: { x: 0, y: 0, width, height } }],
    },
    expect: { fragments: { page: 0 }, maxError: 0, status: 'complete', diagnostics: { present: [], absent: ['PROCESSING_ERROR'] } },
  };
}

/** One component changes through three genuine states. For the partial case, a previously identified
 * floating marker always hides one of its blocks; there is no common clean epoch to manufacture. */
export function dynamicSourceCase(partial = false): Scenario {
  const scenario = sourceCase('moving-pointer'), layer = scenario.layers[0];
  scenario.name = partial ? 'source-dynamic-partial' : 'source-dynamic-epochs';
  scenario.overlays = [];
  const rect = { x: 80, y: 184, width: 48, height: 32 };
  layer.dynamics = [{
    rect,
    draw: (scratch, frame) => {
      const states = [[1, 1, 0], [1, 0, 1], [0, 1, 1]], state = states[Math.max(0, Math.floor((frame - 6) / 4)) % 3];
      for (let i = 0; i < 3; i++) scratch.fill({ x: i * 16, y: 0, width: 16, height: 32 }, state[i] ? [220, 40, 60] : [40, 60, 220]);
    },
  }];
  if (partial) {
    scenario.overlays = [{
      id: 'identified-occluder',
      kind: 'dynamic',
      draw: (image, frame) => {
        // A genuine independent screen object: following the page would be observationally
        // indistinguishable from an animation inside the counter itself.
        const r = { x: 80 + (Math.floor(frame / 4) % 3) * 16, y: 16, width: 16, height: 128 };
        for (let y = 0; y < r.height; y++) {
          for (let x = 0; x < r.width; x++) {
            const at = ((r.y + y) * image.width + r.x + x) * 4;
            image.data.set([30 + (x * 31 + y * 17 + y * y) % 190, 40 + (x * 11 + y * 29) % 160, 20 + (x * 23 + y * 7) % 200, 255], at);
          }
        }
        return [r];
      },
    }];
  }
  return scenario;
}

/** A header stays pinned for most of the recording, then releases while the page reverses past its
 * initial origin. Those newly exposed top rows were never present in the body viewport before. */
export function unpinSourceCase(): Scenario {
  const scenario = sourceCase('once-clean'), layer = scenario.layers[0];
  scenario.name = 'source-unpin';
  layer.path = Array.from({ length: 96 }, (_, i) => ({ x: 0, y: i < 80 ? 80 + i * 3 : Math.max(0, 317 - (i - 79) * (317 / 16)) })).map(
    (p) => ({ x: p.x, y: Math.round(p.y) }),
  );
  scenario.frames = constantFrames(layer.path.length);
  const header = fixedBand('sticky-header', { x: 0, y: 0, width: scenario.width, height: 40 }, 288, [35, 45, 60]);
  scenario.overlays = [{ ...header, kind: 'dynamic', draw: (image, i, time) => i < 80 ? header.draw(image, i, time) : [] }];
  scenario.settings = { analysisSize: 320, tileSize: 256 }; // automatic learning, without a hand-supplied truth mask
  return scenario;
}

export function independentSourceCase(): Scenario {
  const scenario = sourceCase('moving-pointer'), first = scenario.layers[0], second = sourceCase('moving-pointer').layers[0];
  scenario.name = 'source-independent-panes';
  for (let i = 0; i < second.world.data.length; i += 4) second.world.data[i] += 60;
  first.id = 'left';
  first.viewport = { x: 0, y: 0, width: 160, height: 224 };
  first.path = Array.from({ length: 64 }, (_, i) => ({ x: 0, y: 100 + i * 2 }));
  second.id = 'right';
  second.viewport = { x: 160, y: 0, width: 160, height: 224 };
  second.path = Array.from({ length: 64 }, (_, i) => ({ x: 0, y: 200 - i * 3 }));
  scenario.layers = [first, second];
  scenario.frames = constantFrames(64);
  scenario.overlays = [cursor((i) => ({ x: Math.min(306, 8 + i * 5), y: 90 }))];
  scenario.settings = {
    analysisSize: 320,
    tileSize: 256,
    regions: scenario.layers.map((l) => ({ id: l.id, name: l.id, kind: 'moving', rect: l.viewport })),
  };
  return scenario;
}
