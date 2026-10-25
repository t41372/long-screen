import type { Point, Rect, RGBA } from '../types.ts';
import { rng } from '../core/math.ts';
import {
  constantFrames,
  type Expectations,
  fillRGBA,
  type Layer,
  linearPath,
  makeWorld,
  type Overlay,
  type RGB,
  type Scenario,
  viewportAt,
  World,
} from './world.ts';
const expect = (partial: Partial<Expectations> = {}): Expectations => ({
  fragments: {},
  diagnostics: { present: [], absent: ['PROCESSING_ERROR', 'NONFINITE_POSE'] },
  maxError: 0,
  status: 'complete',
  ...partial,
});
/** Pre-rendered static band drawn identically in every frame (status bar, toolbar, tab bar, sticky header). */
export function fixedBand(id: string, rect: Rect, seed: number, colour: RGB = [38, 59, 51]): Overlay {
  const band = new World(rect.width, rect.height, colour);
  band.textLine(18, Math.max(4, Math.round(rect.height / 2) - 9), Math.min(220, rect.width - 60), seed, [250, 249, 242], 1.2);
  for (let k = 0; k < 4; k++) {
    band.fill(
      { x: rect.width - 40 - k * 28, y: Math.round(rect.height / 2) - 6, width: 12, height: 12 },
      [[214, 136, 112], [203, 211, 197], [250, 249, 242], [120, 160, 140]][k] as RGB,
    );
  }
  return {
    id,
    kind: 'fixed',
    draw: (frame: RGBA) => {
      for (let y = 0; y < rect.height; y++) {
        frame.data.set(
          band.data.subarray(y * rect.width * 4, (y + 1) * rect.width * 4),
          ((rect.y + y) * frame.width + rect.x) * 4,
        );
      }
      return [rect];
    },
  };
}
export function floatingButton(rect: Rect): Overlay {
  return {
    id: 'fab',
    kind: 'fixed',
    draw: (frame) => {
      fillRGBA(frame, rect, [207, 103, 80]);
      fillRGBA(frame, { x: rect.x + 10, y: rect.y + rect.height / 2 - 2, width: rect.width - 20, height: 4 }, [255, 255, 255]);
      fillRGBA(frame, { x: rect.x + rect.width / 2 - 2, y: rect.y + 10, width: 4, height: rect.height - 20 }, [255, 255, 255]);
      return [rect];
    },
  };
}
/** Mouse pointer moving in screen space: small, dynamic, never page content. */
export function cursor(path: (index: number) => Point): Overlay {
  return {
    id: 'cursor',
    kind: 'dynamic',
    draw: (frame, index) => {
      const p = path(index), r = { x: p.x, y: p.y, width: 10, height: 16 };
      for (let y = 0; y < 16; y++) {
        fillRGBA(
          frame,
          { x: p.x, y: p.y + y, width: Math.max(1, Math.min(10, Math.round(y * .7))), height: 1 },
          y % 3 ? [20, 20, 20] : [255, 255, 255],
        );
      }
      return [r];
    },
  };
}
export function toast(rect: Rect, from: number, to: number): Overlay {
  return {
    id: 'toast',
    kind: 'dynamic',
    draw: (frame, index) => {
      if (index < from || index >= to) return [];
      fillRGBA(frame, rect, [40, 40, 44]);
      fillRGBA(frame, { x: rect.x + 12, y: rect.y + rect.height / 2 - 3, width: rect.width - 24, height: 6 }, [230, 230, 220]);
      return [rect];
    },
  };
}
/** Scrollbar thumb: screen-space, position derived from page offset. */
export function scrollbar(layer: () => Layer, side = 'right'): Overlay {
  return {
    id: 'scrollbar',
    kind: 'dynamic',
    draw: (frame, index) => {
      const l = layer(),
        v = l.viewport,
        t = l.path[index].y / Math.max(1, l.world.height - v.height),
        thumb = Math.max(24, Math.round(v.height * v.height / l.world.height)),
        r = { x: side === 'right' ? v.x + v.width - 8 : v.x + 2, y: v.y + Math.round(t * (v.height - thumb)), width: 6, height: thumb };
      fillRGBA(frame, r, [150, 150, 150]);
      return [r];
    },
  };
}
export function blinkingCaret(rect: Rect, period = 8): NonNullable<Layer['dynamics']>[number] {
  return {
    rect,
    draw: (scratch, frame) => {
      if (Math.floor(frame / period) % 2 === 0) scratch.fill({ x: 0, y: 0, width: rect.width, height: rect.height }, [20, 20, 20]);
    },
  };
}
export function liveCounter(rect: Rect, every = 10): NonNullable<Layer['dynamics']>[number] {
  return {
    rect,
    draw: (scratch, frame) => {
      scratch.fill({ x: 0, y: 0, width: rect.width, height: rect.height }, [255, 255, 255]);
      const n = Math.floor(frame / every);
      for (let d = 0; d < 5; d++) {
        const digit = Math.floor(n / 10 ** d) % 10;
        scratch.fill({ x: rect.width - 14 - d * 14, y: 4, width: 10, height: rect.height - 8 }, [30 + digit * 20, 60, 90 + digit * 10]);
        scratch.fill({ x: rect.width - 12 - d * 14, y: 6 + digit, width: 6, height: 3 }, [255, 255, 255]);
      }
    },
  };
}
export function animatedWidget(rect: Rect): NonNullable<Layer['dynamics']>[number] {
  return {
    rect,
    draw: (scratch, _frame, time) => {
      scratch.fill({ x: 0, y: 0, width: rect.width, height: rect.height }, [31, 57, 66]);
      const cx = Math.round(rect.width / 2 + Math.sin(time * 6) * (rect.width / 2 - 20));
      scratch.fill({ x: cx - 12, y: rect.height / 2 - 12, width: 24, height: 24 }, [230, 191, 101]);
    },
  };
}
export function playingVideo(rect: Rect, seed: number): NonNullable<Layer['dynamics']>[number] {
  return { rect, draw: (scratch, frame) => scratch.picture({ x: 0, y: 0, width: rect.width, height: rect.height }, seed + frame * 7919) };
}
export function jitter(path: Point[], seed: number, amplitude = 1, every = 3): Point[] {
  const random = rng(seed);
  return path.map((p, i) =>
    i % every === 1 ? { x: p.x + Math.round((random() - .5) * 2 * amplitude), y: p.y + Math.round((random() - .5) * 2 * amplitude) } : p
  );
}
/** A translucent bar pinned to the screen (iOS tab bar, input bar, glass navigation bar): the page scrolling under it
 *  shows through blurred and washed out, and the bar's own icons and labels sit on top, opaque. `layer`'s world
 *  continues past its viewport under the bar, so what shows through is the page beyond the viewport's edge. Nothing
 *  seen through the glass is page content the print should hold. */
export function glassBar(id: string, rect: Rect, layer: () => Layer, ink: (band: World) => void, tint: RGB = [246, 246, 248]): Overlay {
  const INK_KEY: RGB = [1, 2, 3], RADIUS = 7, SHOW = .3;
  const marks = new World(rect.width, rect.height, INK_KEY);
  ink(marks);
  const pw = rect.width + 2 * RADIUS, ph = rect.height + 2 * RADIUS;
  return {
    id,
    kind: 'fixed',
    // Content keeps moving under the glass, so the band never settles: its canvas keeps frame 0 (as `live-bar`).
    settled: 0,
    draw: (frame, index) => {
      const l = layer(), v = viewportAt(l, index), p = l.path[index], data = l.world.at(index), ww = l.world.width;
      // The page under the bar and RADIUS around it, then a separable box blur.
      const src = new Float32Array(pw * ph * 3);
      for (let y = 0; y < ph; y++) {
        const wy = p.y + rect.y - RADIUS + y - v.y;
        for (let x = 0; x < pw; x++) {
          const wx = p.x + rect.x - RADIUS + x - v.x, o = (y * pw + x) * 3;
          if (wx < 0 || wy < 0 || wx >= ww || wy >= l.world.height) {
            src[o] = 251, src[o + 1] = 250, src[o + 2] = 246;
            continue;
          }
          const i = (wy * ww + wx) * 4;
          src[o] = data[i], src[o + 1] = data[i + 1], src[o + 2] = data[i + 2];
        }
      }
      const tmp = new Float32Array(pw * ph * 3), k = 2 * RADIUS + 1;
      for (let y = 0; y < ph; y++) {
        for (let x = RADIUS; x < pw - RADIUS; x++) {
          for (let c = 0; c < 3; c++) {
            let s = 0;
            for (let d = -RADIUS; d <= RADIUS; d++) s += src[(y * pw + x + d) * 3 + c];
            tmp[(y * pw + x) * 3 + c] = s / k;
          }
        }
      }
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          const m = (y * rect.width + x) * 4, o = ((rect.y + y) * frame.width + rect.x + x) * 4;
          if (marks.data[m] !== INK_KEY[0] || marks.data[m + 1] !== INK_KEY[1] || marks.data[m + 2] !== INK_KEY[2]) {
            frame.data[o] = marks.data[m], frame.data[o + 1] = marks.data[m + 1], frame.data[o + 2] = marks.data[m + 2];
            continue;
          }
          for (let c = 0; c < 3; c++) {
            let s = 0;
            for (let d = 0; d < k; d++) s += tmp[((y + d) * pw + x + RADIUS) * 3 + c];
            frame.data[o + c] = Math.round(tint[c] * (1 - SHOW) + (s / k) * SHOW);
          }
        }
      }
      return [rect];
    },
  };
}
/** A schematic street map: flat land-use blocks, parks and water cut by white roads of several widths, with a few
 *  place labels. Little texture away from the roads, as on a vector map. */
export function mapWorld(width: number, height: number, seed: number): World {
  const world = new World(width, height, [236, 233, 225]), random = rng(seed);
  for (let k = 0; k < 60; k++) {
    const w = 60 + Math.floor(random() * 260), h = 60 + Math.floor(random() * 260), roll = random();
    world.fill(
      { x: Math.floor(random() * width), y: Math.floor(random() * height), width: w, height: h },
      roll < .2 ? [197, 226, 187] : roll < .3 ? [170, 205, 238] : roll < .65 ? [242, 239, 233] : [228, 224, 216],
    );
  }
  for (let k = 0; k < 16; k++) {
    const thick = [4, 6, 10, 14][Math.floor(random() * 4)], at = Math.floor(random() * (k % 2 ? width : height));
    const road: RGB = thick >= 14 ? [252, 221, 140] : [255, 255, 255];
    if (k % 2) {
      world.fill({ x: at, y: 0, width: thick, height }, road);
    } else {
      world.fill({ x: 0, y: at, width, height: thick }, road);
    }
  }
  for (let k = 0; k < 5; k++) {
    // Diagonal avenues so the street grid is not a pure lattice.
    const x0 = Math.floor(random() * width), slope = (random() - .5) * 1.6, thick = 5 + Math.floor(random() * 5);
    for (let y = 0; y < height; y++) world.fill({ x: Math.round(x0 + slope * y), y, width: thick, height: 1 }, [255, 255, 255]);
  }
  for (let k = 0; k < 24; k++) {
    world.textLine(
      Math.floor(random() * (width - 120)),
      Math.floor(random() * (height - 20)),
      40 + random() * 80,
      Math.floor(random() * 1e6),
      [92, 98, 104],
      .9,
    );
  }
  for (let k = 0; k < 10; k++) {
    // Map pins: small saturated discs (squares here).
    const x = Math.floor(random() * width), y = Math.floor(random() * height);
    world.fill({ x, y, width: 12, height: 12 }, [[219, 68, 55], [66, 133, 244], [15, 157, 88], [244, 160, 0]][k % 4] as RGB);
  }
  return world;
}
export const SCENARIO_NAMES = [
  'traversal',
  'vertical',
  'horizontal',
  'diagonal',
  'fling',
  'revisit',
  'panes',
  'gap',
  'dynamic',
  'lazy-load',
  'zoom',
  'blank',
  'repeated-list',
  'repeated-list-reversal',
  'comic',
  'phone',
  'vfr',
  'retina',
  'factor4',
  'geometry-change',
  'toolbar-collapse',
  'chrome-everything',
  'glimpse',
  'menu-bar',
  'live-bar',
  'overscroll',
  'large-title-collapse',
  'glass-tab-bar',
  'sticky-toc-later',
  'hover-card-grow',
  'map-pan-chips',
  'header-lag-collapse',
] as const;
export type ScenarioName = typeof SCENARIO_NAMES[number];
/** Nested scrolling, which the engine does not reconstruct yet (docs/ARCHITECTURE.md §九): a scroll box that moves
 *  with its page, a narrow pane scrolling beside a wide still one inside a panning layout (own_a), and a pane that
 *  scrolls in only a few frames (the stationary-region rule's known limitation, §十). Not in the catalogue: their
 *  layers share one engine region, which the per-layer pixel checks cannot express. `tests/unit/nested-scroll.test.ts`
 *  measures them and guards what they show today. */
export const NESTED_SCENARIO_NAMES = ['nested-scroll-box', 'pane-majority', 'pane-rare-scroll'] as const;
/** Deterministic recordings with exact ground truth. Each one isolates a behaviour named in the requirements. */
export function buildScenario(name: ScenarioName | string): Scenario {
  const W = 640, H = 448, HEADER = 48, bodyViewport = { x: 0, y: HEADER, width: W, height: H - HEADER };
  const frames = (n: number, fps = 30) => constantFrames(n, fps);
  const body = (world: World, path: Point[], extra: Partial<Layer> = {}): Layer => ({
    id: 'body',
    viewport: bodyViewport,
    world,
    path,
    ...extra,
  });
  switch (name) {
    case 'traversal': {
      const world = makeWorld(1400, 2200, 11, 'cards', 3);
      const path = linearPath([
        { x: 0, y: 0 },
        { x: 0, y: 350 },
        { x: 210, y: 560 },
        { x: 370, y: 240 },
        { x: 140, y: 160 },
        { x: 0, y: 0 },
        { x: 0, y: 350 },
        { x: 280, y: 540 },
      ], [13, 11, 13, 9, 8, 13, 13]);
      path.splice(24, 0, path[24], path[24], path[24], path[24], path[24]);
      return {
        name,
        description: '二维非单调移动、暂停、回访，固定顶部栏。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 5)],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0, header: 0 },
          diagnostics: {
            present: ['AUTOMATIC_LAYER_MASK'],
            absent: ['UNPLACED_FRAGMENT', 'SCALE_CHANGE_FRAGMENT', 'PROCESSING_ERROR', 'NONFINITE_POSE'],
          },
        }),
      };
    }
    case 'vertical': {
      const world = makeWorld(900, 3200, 21, 'article');
      let path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 900 }, { x: 0, y: 700 }, { x: 0, y: 1900 }, { x: 0, y: 2600 }], [30, 6, 20, 14]);
      path.splice(12, 0, path[12], path[12], path[12]);
      path = jitter(path, 3, 1, 4);
      return {
        name,
        description: '纵向滚动：非恒定速度、暂停、手抖、方向反转。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 6)],
        frames: frames(path.length),
        expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }),
      };
    }
    case 'horizontal': {
      const world = makeWorld(3000, 600, 31, 'cards', 6);
      const path = linearPath([{ x: 0, y: 40 }, { x: 1200, y: 40 }, { x: 900, y: 40 }, { x: 2300, y: 40 }], [28, 6, 24]);
      return {
        name,
        description: '横向移动与回退。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 7)],
        frames: frames(path.length),
        expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }),
      };
    }
    case 'diagonal': {
      const world = makeWorld(1600, 1600, 41, 'article', 2);
      const path = linearPath([{ x: 0, y: 0 }, { x: 700, y: 900 }, { x: 900, y: 300 }, { x: 200, y: 1000 }], [26, 14, 22]);
      return {
        name,
        description: '斜向与奇数位移。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 8)],
        frames: frames(path.length),
        expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }),
      };
    }
    case 'fling': {
      const world = makeWorld(900, 4000, 51, 'article');
      const path: Point[] = [{ x: 0, y: 0 }];
      const steps = [
        40,
        90,
        160,
        230,
        230,
        200,
        140,
        70,
        20,
        5,
        0,
        0,
        -30,
        -120,
        -220,
        -220,
        -160,
        -60,
        0,
        0,
        250,
        250,
        250,
        250,
        180,
        90,
        30,
        0,
      ];
      for (const s of steps) {
        path.push({ x: 0, y: Math.max(0, path[path.length - 1].y + s) });
      }
      return {
        name,
        description: '高速 fling、加减速、方向反转；部分内容只出现 1–2 帧。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 9)],
        frames: frames(path.length),
        expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }),
      };
    }
    case 'revisit': {
      const world = makeWorld(900, 2600, 61, 'article');
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1500 }, { x: 0, y: 0 }, { x: 0, y: 1500 }], [30, 30, 30]);
      return {
        name,
        description: '同一区域反复经过三次；内容只能出现一次。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 10)],
        frames: frames(path.length),
        expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }),
      };
    }
    case 'panes': {
      const left = makeWorld(318, 2400, 71, 'cards'), right = makeWorld(318, 2600, 72, 'article');
      const n = 75, lp: Point[] = [], rp: Point[] = [];
      for (let i = 0; i < n; i++) {
        lp.push({ x: 0, y: i < 35 ? i * 8 : 280 - (i - 35) * 5 });
        rp.push({ x: 0, y: i < 20 ? 0 : (i - 20) * 7 });
      }
      const divider: Overlay = {
        id: 'divider',
        kind: 'fixed',
        draw: (frame) => {
          const r = { x: 318, y: HEADER, width: 4, height: H - HEADER };
          fillRGBA(frame, r, [57, 67, 55]);
          return [r];
        },
      };
      return {
        name,
        description: '两个独立滚动的 pane，各自的位移轨迹。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [{ id: 'left', viewport: { x: 0, y: HEADER, width: 318, height: H - HEADER }, world: left, path: lp }, {
          id: 'right',
          viewport: { x: 322, y: HEADER, width: 318, height: H - HEADER },
          world: right,
          path: rp,
        }],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 11), divider],
        frames: frames(n),
        expect: expect({
          fragments: { left: 0, right: 0 },
          diagnostics: { present: ['MULTIPLE_SCROLL_LAYERS'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
        }),
      };
    }
    case 'nested-scroll-box': {
      // A scroll box inside an article (13% of the body viewport): it moves with the page, and while the page stands
      // still for 30 frames only the box scrolls. The box's screen rectangle is the page's rectangle for it moved by
      // the page path and clipped to the body viewport, so its pose is the page's translation plus its own scroll.
      const page = makeWorld(900, 2400, 301, 'article'), inner = makeWorld(320, 1400, 302, 'cards');
      const box = { x: 160, y: 900, width: 320, height: 110 };
      page.fill(box, [236, 236, 230]);
      page.stroke({ x: box.x - 2, y: box.y - 2, width: box.width + 4, height: box.height + 4 }, [120, 126, 118]);
      const pagePath: Point[] = [], viewports: Rect[] = [], boxPath: Point[] = [];
      const bottom = bodyViewport.y + bodyViewport.height;
      for (let i = 0; i < 90; i++) {
        const p = { x: 0, y: i < 35 ? i * 20 : i < 65 ? 700 : 700 + (i - 65) * 16 }, scroll = i < 35 ? 0 : i < 65 ? (i - 35) * 20 : 600;
        const top = bodyViewport.y + box.y - p.y,
          y0 = Math.max(bodyViewport.y, Math.min(bottom, top)),
          y1 = Math.max(y0, Math.min(bottom, top + box.height));
        pagePath.push(p);
        viewports.push({ x: box.x - p.x, y: y0, width: box.width, height: y1 - y0 });
        boxPath.push({ x: 0, y: scroll + y0 - top });
      }
      return {
        name,
        description: '长文里的内嵌滚动框跟着页面走；页面停住时只有它自己滚。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(page, pagePath), { id: 'box', viewport: viewports[40], viewports, world: inner, path: boxPath }],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 31)],
        frames: frames(pagePath.length),
        expect: expect({ fragments: { body: -1, box: -1 }, limitation: true }),
      };
    }
    case 'pane-majority': {
      // own_a's shape: a two-pane layout wider than the screen (a pinch-zoomed page). The view starts on the narrow
      // right pane and pans down, pans left until the wide left pane fills two thirds of it, the right pane alone
      // scrolls 320 px, then the view pans back right and up over what it saw first.
      const LEFT = 420, RIGHT = 480;
      const left = makeWorld(LEFT, 2400, 311, 'cards'), right = makeWorld(RIGHT, 3200, 312, 'article');
      const view: Point[] = [], own: number[] = [];
      for (let i = 0; i < 90; i++) {
        if (i < 20) view.push({ x: 260, y: i * 12 }), own.push(0);
        else if (i < 35) view.push({ x: Math.round(260 - (i - 19) * 260 / 15), y: 240 }), own.push(0);
        else if (i < 55) view.push({ x: 0, y: 240 }), own.push((i - 34) * 16);
        else if (i < 70) view.push({ x: Math.round((i - 54) * 260 / 15), y: 240 }), own.push(320);
        else view.push({ x: 260, y: 240 - (i - 69) * 12 }), own.push(320);
      }
      const pane = (id: string, origin: number, world: World, base: number): Layer => {
        const viewports: Rect[] = [], path: Point[] = [];
        view.forEach((v, i) => {
          const x0 = Math.max(0, origin - v.x), x1 = Math.min(W, origin + world.width - v.x);
          viewports.push({ x: x0, y: HEADER, width: Math.max(0, x1 - x0), height: H - HEADER });
          path.push({ x: x0 + v.x - origin, y: v.y + (id === 'right' ? own[i] : 0) });
        });
        return { id, viewport: viewports[base], viewports, world, path };
      };
      return {
        name,
        description: '宽的静止左栏占视口多数时，窄右栏自己滚动，之后整个版面二维平移（own_a 的形状）。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [pane('left', 0, left, 45), pane('right', LEFT, right, 10)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 32)],
        frames: frames(view.length),
        expect: expect({ fragments: { left: -1, right: -1 }, limitation: true }),
      };
    }
    case 'pane-rare-scroll': {
      // Two fixed panes like `panes`, but the right one (40% of the body) scrolls in only six frames while the left
      // one scrolls throughout: the nested container docs/ARCHITECTURE.md §十 says the stationary-region rule freezes.
      const left = makeWorld(380, 2400, 321, 'cards'), right = makeWorld(256, 1600, 322, 'article');
      const n = 80, lp: Point[] = [], rp: Point[] = [];
      for (let i = 0; i < n; i++) {
        lp.push({ x: 0, y: i * 6 });
        rp.push({ x: 0, y: 20 * (Math.max(0, Math.min(3, i - 29)) + Math.max(0, Math.min(3, i - 59))) });
      }
      const divider: Overlay = {
        id: 'divider',
        kind: 'fixed',
        draw: (frame) => {
          const r = { x: 380, y: HEADER, width: 4, height: H - HEADER };
          fillRGBA(frame, r, [57, 67, 55]);
          return [r];
        },
      };
      return {
        name,
        description: '两个固定 pane，右边那个只在六帧里自己滚动。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [{ id: 'left', viewport: { x: 0, y: HEADER, width: 380, height: H - HEADER }, world: left, path: lp }, {
          id: 'right',
          viewport: { x: 384, y: HEADER, width: 256, height: H - HEADER },
          world: right,
          path: rp,
        }],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 33), divider],
        frames: frames(n),
        expect: expect({ fragments: { left: -1, right: -1 }, limitation: true }),
      };
    }
    case 'gap': {
      const world = makeWorld(1400, 4600, 81, 'cards', 3);
      const path = linearPath([
        { x: 0, y: 0 },
        { x: 0, y: 350 },
        { x: 210, y: 560 },
        { x: 370, y: 240 },
        { x: 140, y: 160 },
        { x: 0, y: 0 },
        { x: 0, y: 350 },
        { x: 280, y: 540 },
      ], [13, 11, 13, 9, 8, 13, 13]);
      path.splice(25, 0, { x: 0, y: 4100 }, { x: 0, y: 4118 });
      return {
        name,
        description: '无重叠跳转后返回：跳转观察保留为独立片段。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 12)],
        frames: frames(path.length),
        expect: expect({ fragments: { body: 1 }, diagnostics: { present: ['UNPLACED_FRAGMENT'], absent: ['PROCESSING_ERROR'] } }),
      };
    }
    case 'dynamic': {
      const world = makeWorld(1400, 2200, 91, 'cards', 3);
      const path = linearPath([
        { x: 0, y: 0 },
        { x: 0, y: 350 },
        { x: 210, y: 560 },
        { x: 370, y: 240 },
        { x: 140, y: 160 },
        { x: 0, y: 0 },
        { x: 0, y: 350 },
        { x: 280, y: 540 },
      ], [13, 11, 13, 9, 8, 13, 13]);
      // Split ratchets (world-consistency mask + displacement-spread voting, docs/ARCHITECTURE.md §七).
      // maxContaminatedDynamic covers the animated widget alone (legitimately allowed to keep one moment),
      // measured 10,500px. The overlay side is now at the TARGET: contaminatedOverlay and
      // contaminatedOverlayRecoverable both measure 0, so both ratchets are the default 0 and this scenario
      // asserts the cursor is removed completely rather than merely bounded. Two changes got it there from
      // 442px: verify.ts now attributes an overlay colour only where the overlay actually PAINTED (an
      // overlay rect is a bounding box, and this cursor is a 10px-wide arrow inside a 10×16 one — the widget
      // background showing through the rest of that box was being charged to the cursor), and the
      // world-consistency comparison tolerance now comes from the source (`MediaInfo.noise`), so a lossless
      // scenario is compared EXACTLY instead of against the ±10 levels a decoded recording needs. The
      // cursor's white rows differ from this page's background by a mean |ΔRGB| of 6 and were invisible to
      // every comparison in the pipeline until that changed. maxProvisional is 0: nothing is left unhealed.
      return {
        name,
        description: '页面内动画组件 + 鼠标指针。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path, { dynamics: [animatedWidget({ x: 200, y: 260, width: 150, height: 70 })] })],
        overlays: [
          fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 13),
          cursor((i) => ({ x: 320 + Math.round(Math.sin(i / 5) * 200), y: 240 + Math.round(Math.cos(i / 7) * 150) })),
        ],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0 },
          maxContaminatedDynamic: 10801,
          diagnostics: { present: ['TEMPORAL_OR_ALIGNMENT_CONFLICT'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
        }),
      };
    }
    case 'lazy-load': {
      const world = makeWorld(900, 2000, 101, 'article');
      world.fill({ x: 40, y: 700, width: 500, height: 200 }, [236, 236, 230]);
      world.patch(
        30,
        { x: 40, y: 700, width: 500, height: 200 },
        (scratch) => scratch.picture({ x: 0, y: 0, width: 500, height: 200 }, 4242),
      );
      const path = linearPath([{ x: 0, y: 300 }, { x: 0, y: 900 }, { x: 0, y: 300 }, { x: 0, y: 1000 }], [22, 22, 22]);
      return {
        name,
        description: '懒加载图片在录制中途出现：同一区域存在两个版本。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 14)],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0 },
          diagnostics: { present: ['TEMPORAL_OR_ALIGNMENT_CONFLICT'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
        }),
      };
    }
    case 'zoom': {
      const world = makeWorld(1400, 1600, 111, 'cards', 3);
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 500 }, { x: 120, y: 620 }, { x: 120, y: 900 }], [20, 8, 16]);
      const zoom = path.map((_, i) => i < 28 ? 1 : 1.25);
      return {
        name,
        description: '录制中途 pinch zoom：比例变化后的观察成为独立片段，不被缩放混合。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path, { zoom })],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 15)],
        frames: frames(path.length),
        expect: expect({ fragments: { body: 1 }, diagnostics: { present: ['SCALE_CHANGE_FRAGMENT'], absent: ['PROCESSING_ERROR'] } }),
      };
    }
    case 'blank': {
      const world = makeWorld(900, 2600, 121, 'article');
      world.fill({ x: 0, y: 700, width: 900, height: 900 }, [251, 250, 246]);
      const path = linearPath([{ x: 0, y: 200 }, { x: 0, y: 1400 }, { x: 0, y: 2000 }], [30, 15]);
      return {
        name,
        description: '大面积纯色：完全空白的帧无法判断运动，只能 best guess 并给出警告。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 16)],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 1 },
          diagnostics: { present: ['UNOBSERVABLE_FRAME', 'UNPLACED_FRAGMENT'], absent: ['PROCESSING_ERROR'] },
        }),
      };
    }
    case 'repeated-list': {
      const world = makeWorld(900, 2800, 131, 'list');
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1200 }, { x: 0, y: 2300 }], [80, 44]);
      return {
        name,
        description: '高度重复的相同列表行，单向滚动：每步都小于行高的一半或与速度连续，位置可由连续性唯一确定。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 17)],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0 },
          diagnostics: { present: ['LOW_CONFIDENCE_PLACEMENT'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
        }),
      };
    }
    case 'repeated-list-reversal': {
      const world = makeWorld(900, 2800, 131, 'list');
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1500 }, { x: 0, y: 1200 }, { x: 0, y: 2300 }], [100, 20, 44]);
      // maxInvented/maxMismatched ratchet the ambiguous best-guess reconstruction: today's measured invented 563,200 /
      // mismatched 73,026 (test-results/scenarios-c.json), +~5%.
      return {
        name,
        description:
          '相同列表行中途反向：向上 15px 与向下 29px（行高 44）像素上无法区分，只能 best guess 并明确警告；误差只会是行高的整数倍。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 17)],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0 },
          maxError: Infinity,
          ambiguousPeriod: 44,
          maxInvented: 591400,
          maxMismatched: 76700,
          diagnostics: { present: ['LOW_CONFIDENCE_PLACEMENT', 'AMBIGUOUS_PATTERN'], absent: ['PROCESSING_ERROR'] },
        }),
      };
    }
    case 'comic': {
      const world = makeWorld(700, 5200, 141, 'comic');
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 4700 }], [46]);
      return {
        name,
        description: '长条漫画：大幅图片、快速纵向滚动。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 18)],
        frames: frames(path.length),
        expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }),
      };
    }
    case 'phone': {
      const PW = 390, PH = 844, TOP = 44, NAV = 64;
      const world = makeWorld(390, 3600, 151, 'cards');
      let path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1400 }, { x: 0, y: 1100 }, { x: 0, y: 2600 }], [30, 8, 26]);
      path = jitter(path, 5, 2, 3);
      const layer: Layer = { id: 'body', viewport: { x: 0, y: TOP, width: PW, height: PH - TOP - NAV }, world, path };
      // Precise overlay-contamination split (docs/ARCHITECTURE.md §七, issue #2; verify.ts's contaminatedOverlayUnobservable
      // / contaminatedOverlayRecoverable): measured 3,192px total overlay contamination (was 4,334px).
      // 1,517px are UNOBSERVABLE — the analytic ceiling for this scenario, computed the same way over every
      // ever-visible main-canvas world pixel regardless of contamination — almost entirely the scrollbar
      // thumb's own interior: this page never scrolls horizontally, and the thumb is drawn on every single
      // frame with no fade, so that ~6-native-px column is never once observed clean. maxContaminatedOverlay-
      // Unobservable is seeded from this exact analytic count.
      //
      // maxContaminatedOverlayRecoverable is DECLARED here (1,759 = measured 1,675 +5%) rather than left at
      // the target 0 — a known limitation with one traced mechanism, not an open question. Every one of the
      // 1,675 is detectable in principle (scrollbar grey #969696 1,223px and FAB #cf6750 452px, both a mean
      // |ΔRGB| ≈ 100 from the true page — nothing here is under a comparison threshold), and 1,240 of them
      // ARE correctly flagged provisional. What is missing is a frame that can HEAL them, and the reason is
      // always the same shape: THE ONLY CLEAN LOOK IS A BOUNDARY FRAME OF THE RECORDING, which the very same
      // pairwise disagreement condemns.
      //   - World (382, 45), frames 0–1: frame 0 is the run's first frame and covers the pixel under the
      //     scrollbar; frame 1 is clean but its only comparable neighbour is frame 0 (frame 2 maps out of
      //     region), so it is condemned too and cannot heal.
      //   - World (335, 3217), frames 63–64: the mirror image at the end. Frame 63 first covers it under the
      //     FAB and is correctly flagged; frame 64 is genuinely clean and is the last frame of the run.
      //   - World (387, 3072), frames 62–64: the thumb is 150px tall against ~58px of scroll per frame, so
      //     the first look (frame 62, prev out of region) has one comparable neighbour — frame 63, also under
      //     the thumb, which AGREES — and only frame 64 is clean, again the last frame.
      // Engine.consistencyMask()'s lone-neighbour excuse exists for exactly this and cannot fire: it needs
      // voting to have independently found the neighbour inconsistent, and voting has no verdict at a
      // recording's boundary — a world position entering at the leading edge with one or two frames left is
      // off screen in every ring partner that clears Dmin, so no comparison is ever possible for it. That is
      // a property of where the recording stops, not of the detector. Only 2 of the 1,675 sit in analysis
      // cells the voting interior mask (`RegionSlot.interior`, rust/long-screen/src/kernels/voting.rs) excludes from voting, so the mask is not what stands in the way.
      // The reveal stage (docs/ARCHITECTURE.md §七) then replaces part of what is left: measured 2,766px total and
      // 1,249px recoverable after it; maxContaminatedOverlay and maxContaminatedOverlayRecoverable are those +5%.
      return {
        name,
        description: '手机竖屏：状态栏、底部导航、悬浮按钮、滚动条、手抖。',
        width: PW,
        height: PH,
        background: [251, 250, 246],
        layers: [layer],
        overlays: [
          fixedBand('status', { x: 0, y: 0, width: PW, height: TOP }, 19, [20, 20, 24]),
          fixedBand('nav', { x: 0, y: PH - NAV, width: PW, height: NAV }, 20, [245, 245, 240]),
          floatingButton({ x: PW - 76, y: PH - NAV - 80, width: 56, height: 56 }),
          scrollbar(() => layer),
        ],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0 },
          maxContaminatedOverlay: 2904,
          maxContaminatedOverlayUnobservable: 1517,
          maxContaminatedOverlayRecoverable: 1311,
          maxProvisional: 1832,
          diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
        }),
      };
    }
    case 'vfr': {
      const world = makeWorld(900, 2400, 161, 'article');
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1500 }], [40]);
      const random = rng(9);
      const list: Scenario['frames'] = [];
      let t = 0;
      for (let i = 0; i < path.length; i++) {
        const d = i === 0 ? .5 : random() < .2 ? .2 : 1 / 60 + random() * .02;
        list.push({ time: t, duration: d });
        t += d;
      }
      for (const k of [10, 11, 25]) {
        path[k] = path[k - 1];
      }
      return {
        name,
        description: '可变帧率、超长首帧、重复帧。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 21)],
        frames: list,
        expect: expect({
          fragments: { body: 0 },
          diagnostics: { present: ['TEMPORAL_UNDERSAMPLING'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
        }),
      };
    }
    case 'retina': {
      const RW = 1280, RH = 896, RH_HEADER = 96;
      const world = makeWorld(2000, 2600, 171, 'cards', 3);
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 700 }, { x: 300, y: 1100 }, { x: 500, y: 400 }, { x: 0, y: 0 }], [
        14,
        10,
        12,
        12,
      ]);
      return {
        name,
        description: '2× 高分辨率录屏：分析在 1/2 尺度进行，输出保持原像素。',
        width: RW,
        height: RH,
        background: [251, 250, 246],
        layers: [{ id: 'body', viewport: { x: 0, y: RH_HEADER, width: RW, height: RH - RH_HEADER }, world, path }],
        overlays: [fixedBand('header', { x: 0, y: 0, width: RW, height: RH_HEADER }, 22)],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0 },
          factor: 2,
          diagnostics: { present: ['ANALYSIS_PYRAMID'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
        }),
      };
    }
    case 'factor4': {
      // A height not divisible by 4 (to exercise downscaleGray's truncating floor(), not just the exact case) was tried
      // here and made the scenario fail (165px placement error) — reverted; geometry stays exact per-axis, only the
      // factor claim is fixed (see analysisSize: 480 at the call site and `factor: 4` below).
      const RW = 1920, RH = 1080, RH_HEADER = 80;
      const world = makeWorld(2400, 2600, 181, 'cards', 4);
      const path = linearPath([{ x: 0, y: 0 }, { x: 200, y: 900 }, { x: 400, y: 300 }], [14, 12]);
      // No overlay or dynamic here; at this scenario's factor (4, the largest any scenario uses),
      // solve()'s displacement-spread consistency voting (docs/ARCHITECTURE.md §七) would leave a small,
      // scattered residual of unhealed flags even with the local-search radius scaled to the analysis factor
      // and the strictest (6/6 unanimous) finalisation threshold — root-caused to genuine downscaleGray
      // box-filter PHASE noise: the box-filter grid is fixed to SCREEN pixel 0,0 in every frame, not to world
      // content, so the same world pixel lands in analysis cells at a different sub-cell phase in frame T vs
      // a ring partner S whenever their pose delta isn't a multiple of the factor (true for nearly every
      // partner pair), which flips a small fraction of individual comparisons on fine "cards" edges/borders
      // even after the local search. A region-masked, edge-replicated 3×3 box-blur of the analysis luma
      // (computeBoxGray in solve(), gated off at f=1 where no such phase exists) suppresses this at the
      // comparison level rather than requiring near-unanimity to statistically drown it out, which is what
      // let the finalisation rule move from literal 6/6 unanimity to the ratio rule below it without
      // reopening this residual — now genuinely 0, so no ratchet here (default 0, exact).
      return {
        name,
        description: '桌面横屏 1080p；以 analysisSize 480 运行时分析因子为 4（默认 640 下为 3）。',
        width: RW,
        height: RH,
        background: [251, 250, 246],
        layers: [{ id: 'body', viewport: { x: 0, y: RH_HEADER, width: RW, height: RH - RH_HEADER }, world, path }],
        overlays: [fixedBand('header', { x: 0, y: 0, width: RW, height: RH_HEADER }, 23)],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0 },
          factor: 4,
          diagnostics: { present: ['ANALYSIS_PYRAMID'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
        }),
        // Must run at analysisSize 480 to hit factor 4 (the default 640 gives factor 3); see the description above.
        settings: { analysisSize: 480 },
      };
    }
    case 'geometry-change': {
      const world = makeWorld(900, 2000, 191, 'article');
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 900 }], [40]);
      const list = frames(path.length).map((f, i) => i >= 20 ? { ...f, width: H, height: W } : f);
      return {
        name,
        description: '录制中途方向/尺寸改变：保留前缀，明确报告。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 24)],
        frames: list,
        expect: expect({
          fragments: { body: 0 },
          status: 'partial',
          frames: 20,
          diagnostics: { present: ['DECODE_PREFIX_ONLY'], absent: ['NONFINITE_POSE'] },
        }),
      };
    }
    case 'toolbar-collapse': {
      const world = makeWorld(900, 2400, 201, 'article');
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1400 }], [50]);
      const tall = fixedBand('header', { x: 0, y: 0, width: W, height: 96 }, 25),
        short = fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 25);
      const viewports = path.map((_, index) => {
        const y = index < 30 ? 96 : HEADER;
        return { x: 0, y, width: W, height: H - y };
      });
      const layer: Layer = {
        id: 'body',
        viewport: viewports[0],
        viewports,
        world,
        path: path.map((p, index) => ({ x: p.x, y: p.y + viewports[index].y - viewports[0].y })),
      };
      const header: Overlay = {
        id: 'header',
        kind: 'dynamic',
        draw: (frame, index, time) => index < 30 ? tall.draw(frame, index, time) : short.draw(frame, index, time),
      };
      // maxInvented ratchets the known-limitation reconstruction: today's measured invented 48,360px (test-results/scenarios-d.json), +~5%.
      // maxProvisional is back at its default 0: the measured provisionalPixels is 0. The old 42,759 (measured
      // 40,722) was left over from an earlier engine. The per-frame viewports did not remove it: the 51 frames are
      // byte-identical to the earlier description with a fixed body viewport and a `collapse` overlay painting the
      // exposed rows, so the viewports change only what the verifier expects, not what the engine sees.
      return {
        name,
        description: '地址栏收起：正文可视区在录制中途变大。已知局限，只要求不崩溃、不伪造。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [layer],
        overlays: [header],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: -1 },
          limitation: true,
          maxInvented: 50800,
          diagnostics: { present: ['TEMPORAL_OR_ALIGNMENT_CONFLICT'], absent: ['PROCESSING_ERROR', 'NONFINITE_POSE'] },
        }),
      };
    }
    case 'chrome-everything': {
      const world = makeWorld(900, 2600, 211, 'article');
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1200 }, { x: 0, y: 900 }, { x: 0, y: 1900 }], [24, 8, 20]);
      // Split ratchets (world-consistency mask + displacement-spread voting, docs/ARCHITECTURE.md §七).
      // maxContaminatedDynamic covers the caret/counter/video trio alone (legitimately allowed to keep one
      // moment): measured 57,579px; the ratchet keeps its earlier, higher value rather than being re-seeded up.
      // Precise overlay split (docs/ARCHITECTURE.md §七, issue #2): measured 3,569px total overlay contamination, down
      // from 9,534px. 1,664px are UNOBSERVABLE — the analytic ceiling, computed the same way over every
      // ever-visible main-canvas world pixel regardless of contamination — the FAB's own trailing-corner
      // content that never migrates toward any future frame's leading edge before the fixed-length recording
      // ends (its 52×52 footprint sits at the viewport's OWN bottom-right corner, the freshest-revealed
      // content in most frames it touches). maxContaminatedOverlayUnobservable is seeded from that count.
      //
      // maxContaminatedOverlayRecoverable is DECLARED here (2,001 = measured 1,905 +5%) rather than left at
      // the target 0 — a known limitation with one traced mechanism. It was 7,870 before this pass; ~2,880 of
      // that was the FAB's white [255,255,255] glyph over this page's [251,250,246] background, a mean
      // |ΔRGB| of 6 that no comparison could see until the world-consistency tolerance started coming from
      // the source (`MediaInfo.noise`: 0 for a lossless scenario, the H.264/VP9 headroom for a real
      // recording). What is left is the same recording-boundary shape traced pixel by pixel on `phone`:
      // 1,615 of the 1,905 ARE flagged provisional and simply never meet a frame allowed to heal them.
      // World (603, 2209) is the type case — frame 51 first covers it under the FAB and is correctly
      // flagged, frame 52 is genuinely clean and is the LAST frame of the run, and the same pairwise
      // disagreement condemns frame 52 as well, with voting silent for both (a world position entering at
      // the leading edge one frame before the end is off screen in every ring partner that clears Dmin).
      // NONE of the 1,905 sit in analysis cells the voting interior mask (`RegionSlot.interior`, rust/long-screen/src/kernels/voting.rs) excludes from voting.
      // maxProvisional is the net unhealed flag count at the end: measured 32,151px, +~5%.
      // The reveal stage (docs/ARCHITECTURE.md §七) then replaces most of the recoverable residue: measured 1,966px total
      // and 302px recoverable after it; maxContaminatedOverlay and maxContaminatedOverlayRecoverable are those +5%.
      return {
        name,
        description: '固定栏、悬浮按钮、toast、闪烁光标、实时计数器、播放中的视频同时存在。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [
          body(world, path, {
            dynamics: [
              blinkingCaret({ x: 60, y: 130, width: 2, height: 14 }),
              liveCounter({ x: 700, y: 400, width: 120, height: 28 }),
              playingVideo({ x: 100, y: 1500, width: 320, height: 180 }, 77),
            ],
          }),
        ],
        overlays: [
          fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 26),
          floatingButton({ x: W - 72, y: H - 72, width: 52, height: 52 }),
          toast({ x: 160, y: H - 90, width: 320, height: 40 }, 18, 34),
          cursor((i) => ({ x: 400 + Math.round(Math.sin(i / 4) * 120), y: 300 + Math.round(Math.cos(i / 6) * 90) })),
        ],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0 },
          maxContaminatedOverlay: 2064,
          maxContaminatedOverlayUnobservable: 1664,
          maxContaminatedOverlayRecoverable: 317,
          maxContaminatedDynamic: 60436,
          maxProvisional: 33759,
          diagnostics: { present: ['TEMPORAL_OR_ALIGNMENT_CONFLICT'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
        }),
      };
    }
    case 'glimpse': {
      const world = makeWorld(900, 3000, 221, 'cards');
      const path: Point[] = [];
      for (let i = 0; i < 12; i++) {
        path.push({ x: 0, y: i * 20 });
      }
      // One frame in the middle of a fast sweep exposes content seen in no other frame.
      path.push(
        { x: 0, y: 520 },
        { x: 0, y: 820 },
        { x: 0, y: 1100 },
        { x: 0, y: 1360 },
        { x: 0, y: 1600 },
        { x: 0, y: 1820 },
        { x: 0, y: 2020 },
        { x: 0, y: 2180 },
        { x: 0, y: 2300 },
      );
      for (let i = 0; i < 10; i++) {
        path.push({ x: 0, y: 2300 + i * 15 });
      }
      return {
        name,
        description: '快速扫过：某些内容仅在一帧可见，仍必须进入结果。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 27)],
        frames: frames(path.length),
        expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }),
      };
    }
    case 'menu-bar': {
      // A screen-fixed bar shows one toolbar until frame 24, cross-fades over eight frames to another and keeps it (a
      // menu bar that appears during a recording). A mouse pointer sweeps across it 27 px a frame in frames 0–3 (so
      // frame 0 shows it) and again in frames 20–34, through the whole fade and past it. The bar's canvas must show the
      // settled toolbar without the pointer: no pointer trail, no frame of the fade, nothing of the first toolbar.
      // The recording is long and the pointer is in the bar for few of its frames: region learning reads a row's mean
      // change over the whole recording, and in a 90-frame version the pointer's rows changed often enough that only
      // the bar's top 17–24 rows were learned as fixed.
      const world = makeWorld(900, 2400, 231, 'article');
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1900 }], [299]);
      const n = path.length, bar = { x: 0, y: 0, width: W, height: HEADER };
      const before = fixedBand('header', bar, 29, [24, 26, 30]), after = fixedBand('header', bar, 28);
      const pointer = cursor((i) => ({ x: 30 + (i * 27) % 560, y: 14 }));
      return {
        name,
        description: '固定栏中途淡出换成另一条栏，鼠标指针在栏里扫过：栏的画布只留下最后的样子，不留指针。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [
          {
            id: 'header',
            kind: 'fixed',
            settled: n - 1,
            draw: (frame, index, time) => {
              const alpha = Math.min(1, Math.max(0, (index - 23) / 8));
              const start = (bar.y * frame.width) * 4, end = ((bar.y + bar.height) * frame.width) * 4;
              before.draw(frame, index, time);
              const old = frame.data.slice(start, end), rects = after.draw(frame, index, time);
              for (let i = start; i < end; i++) {
                frame.data[i] = Math.round(old[i - start] * (1 - alpha) + frame.data[i] * alpha);
              }
              return rects;
            },
          },
          {
            id: 'cursor',
            kind: 'dynamic',
            draw: (frame, index, time) => index < 4 || (index >= 20 && index < 35) ? pointer.draw(frame, index, time) : [],
          },
        ],
        frames: frames(n),
        expect: expect({
          fragments: { body: 0 },
          diagnostics: { present: ['TEMPORAL_OR_ALIGNMENT_CONFLICT'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR', 'NONFINITE_POSE'] },
        }),
      };
    }
    case 'live-bar': {
      // A screen-fixed bar whose status light changes colour every third frame for the whole recording, as content
      // scrolling under a translucent header does (test_8): the bar settles into a new state in a third of its frames,
      // so it is not one bar with a few states. Its canvas keeps frame 0 as it was (the light's first colour), and the
      // framed print keeps the reference frame. The light stays in place: a mark moving along the bar every third frame
      // pulled the body's placement off by 1 px.
      const world = makeWorld(900, 2400, 231, 'article');
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1900 }], [299]);
      const bar = { x: 0, y: 0, width: W, height: HEADER }, light = { x: 300, y: 18, width: 16, height: 12 };
      const band = fixedBand('header', bar, 251);
      const colours: RGB[] = [[214, 136, 112], [120, 160, 140], [203, 211, 197], [90, 110, 180], [240, 200, 90]];
      return {
        name,
        description: '固定栏里的内容一直在变（像内容在半透明标题栏下滚过）：栏的画布保留第 0 帧，不取最后的样子。',
        width: W,
        height: H,
        background: [251, 250, 246],
        layers: [body(world, path)],
        overlays: [
          {
            id: 'header',
            kind: 'fixed',
            settled: 0,
            draw: (frame, index, time) => {
              const rects = band.draw(frame, index, time), k = Math.floor(index / 3);
              fillRGBA(frame, light, colours[k % colours.length]);
              return rects;
            },
          },
        ],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0 },
          diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR', 'NONFINITE_POSE'] },
        }),
      };
    }
    case 'overscroll': {
      // Elastic overscroll at every edge of a 900×1800 page: the viewport runs past the page's edge and shows the
      // scenario background there (the browser's overscroll gap), which is not page content. A fling into the bottom
      // edge overshoots and decays back exponentially; a pan into the right edge does the same; a drag past the top
      // edge is held for a while before release; a pan past the left edge springs back only part of the way before
      // the user pans away (the left edge itself is where the page rested earlier). The page ends with an ordinary
      // reversal inside it, which must not be mistaken for a bounce.
      const world = makeWorld(900, 1800, 241, 'article');
      const path: Point[] = [];
      const run = (xs: number[], ys: number[]) => xs.forEach((x, i) => path.push({ x, y: ys[i] }));
      const ys = (values: number[], x: number) => run(values.map(() => x), values);
      const xs = (values: number[], y: number) => run(values, values.map(() => y));
      ys([0, 0, 0, 0, 60, 150, 270, 420, 590, 760, 920, 1060, 1180, 1280, 1350, 1400], 0);
      // Bottom edge at 1400: overshoot to 1448, exponential decay, settle.
      ys([1430, 1445, 1448, 1444, 1437, 1429, 1422, 1416, 1411, 1407, 1404, 1402, 1401, 1400, 1400, 1400, 1400], 0);
      // Right edge at 260: overshoot to 290, decay, settle.
      xs([30, 70, 120, 170, 215, 250, 260, 275, 286, 290, 287, 281, 275, 270, 266, 263, 261, 260, 260, 260, 260], 1400);
      // Top edge at 0: a drag past it, held at -40, released.
      ys([1300, 1150, 980, 800, 620, 450, 300, 170, 70, 10, 0, -12, -22, -30, -36, -40, -40, -40, -40, -40], 260);
      ys([-27, -17, -10, -6, -3, -1, 0, 0, 0, 0], 260);
      // Left edge at 0: past it to -26, part of the way back, then away before settling.
      xs([200, 140, 80, 30, 0, -14, -22, -26, -24, -19, -14, -10, -7, -5, -5, 8, 40, 90, 140], 0);
      // An ordinary reversal inside the page.
      ys([60, 180, 330, 480, 600, 680, 720, 700, 640, 560, 500, 470, 460, 460, 500, 600, 720], 140);
      return {
        name,
        description: '弹性越界：滚过页面边缘时露出的底色不是页面内容。',
        width: W,
        height: H,
        background: [226, 229, 234],
        layers: [body(world, path, { pageEdges: true })],
        overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 241)],
        frames: frames(path.length),
        expect: expect({
          fragments: { body: 0 },
          bounds: { x: 0, y: HEADER, width: 900, height: 1800 },
          diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
        }),
      };
    }
    case 'large-title-collapse': {
      // An iOS large-title navigation bar (new_ip_1): in the first frames of the scroll the large title rides up with the
      // content and is clipped away while the small centred title fades in, and the bar loses 44 px, the content under it
      // gaining those rows; from then on the bar stays
      // pinned for the rest of the recording. The bar's pixels move inside it during the collapse, so it is not one
      // static band from frame 0, and the rows it gives up become page rows. Ideal: the status bar and the collapsed
      // bar are fixed canvases, the page is one canvas.
      const PW = 390, PH = 844, TOP = 44, TALL = 96, SHORT = 52, COLLAPSE = 8, n = 140;
      const world = makeWorld(PW, 4400, 261, 'cards');
      const progress = (i: number) => Math.min(1, i / COLLAPSE), barHeight = (i: number) => Math.round(TALL - (TALL - SHORT) * progress(i));
      const scroll: number[] = [];
      for (let i = 0, y = 200; i < n; i++) {
        scroll.push(y);
        y += Math.min(26, 4 + i * 2);
      }
      const viewports = scroll.map((_, i) => {
        const top = TOP + barHeight(i);
        return { x: 0, y: top, width: PW, height: PH - top };
      });
      const layer: Layer = {
        id: 'body',
        viewport: viewports[0],
        viewports,
        world,
        path: scroll.map((s, i) => ({ x: 0, y: s + viewports[i].y - viewports[0].y })),
      };
      const ink: RGB = [28, 28, 30], paper: RGB = [247, 247, 245];
      const mix = (a: RGB, b: RGB, t: number) => a.map((v, c) => Math.round(v * (1 - t) + b[c] * t)) as RGB;
      const header: Overlay = {
        id: 'header',
        kind: 'fixed',
        settled: n - 1,
        draw: (frame, index) => {
          const t = progress(index), h = barHeight(index), band = new World(PW, h, paper);
          band.fill({ x: 12, y: 14, width: 14, height: 22 }, [10, 132, 255]);
          if (t > 0) band.textLine(150, 16, 90, 2611, mix(paper, ink, t));
          // The large title rides up with the content until the shrinking bar clips it away.
          if (t < 1) band.textLine(16, TALL - 44 - (scroll[index] - scroll[0]), 210, 2612, ink, 2.2);
          band.fill({ x: 0, y: h - 1, width: PW, height: 1 }, [198, 198, 200]);
          frame.data.set(band.data, TOP * frame.width * 4);
          return [{ x: 0, y: TOP, width: PW, height: h }];
        },
      };
      return {
        name,
        description: 'iOS 大标题导航栏：开始滚动的几帧里大标题缩成小标题、栏变矮，之后一直钉在屏幕上。',
        width: PW,
        height: PH,
        background: [251, 250, 246],
        layers: [layer],
        overlays: [fixedBand('status', { x: 0, y: 0, width: PW, height: TOP }, 262, [20, 20, 24]), header],
        frames: frames(n),
        // Measured on main (c65e33e): the collapsing bar is learned as part of the page region (fixed region only the
        // 48 px status bar), so the bar's frames land on top of the print: invented 35,490, mismatched 1,214,
        // provisional 610; ratchets are those +5 %. Ideal: all 0, and the status bar plus the collapsed bar fixed.
        expect: expect({
          fragments: { body: -1 },
          limitation: true,
          maxInvented: 37300,
          maxMismatched: 1280,
          maxProvisional: 650,
          diagnostics: { present: [], absent: ['PROCESSING_ERROR', 'NONFINITE_POSE'] },
        }),
      };
    }
    case 'header-lag-collapse': {
      // A phone feed whose header collapses late and at its own speed (new_ip_8, Bilibili): under a pinned status bar a
      // search row and a tab row sit over the page. The page starts scrolling first while the header stays put for two
      // frames, then the header slides up 2 → 12 px a frame, far slower than the page, until the search row is gone under
      // the status bar and the tab row stays pinned; later the page scrolls back and the header slides down again at its
      // own speed. Right under the expanded header the page has a carousel that changes every frame. Ideal: nothing of
      // the header on the page canvas, and the carousel as of one clean moment.
      const PW = 390, PH = 844, TOP = 48, SEARCH = 52, TABS = 40, HEADER = SEARCH + TABS;
      const world = makeWorld(PW, 4200, 301, 'cards');
      const carousel = { x: 12, y: HEADER - 8, width: PW - 24, height: 260 };
      world.fill({ x: 0, y: 0, width: PW, height: carousel.y + carousel.height + 16 }, [251, 250, 246]);
      world.paragraph(16, 12, PW - 32, 3, 3011);
      // Per-frame header steps (screen px, upward) and page steps: six still frames with the carousel playing; the page
      // moving on frames 6 and 7 with the header still; then both moving, the header at under a fifth of the page's
      // speed, until it is collapsed; a long scroll with the tab row pinned; a scroll back up while the header expands
      // again at its own speed (so the pinned rows are not a fixed band, as on the real page); and still frames.
      const slide = [2, 3, 4, 5, 6, 8, 10, 12, 2], fast = [24, 28, 32, 36, 40, 44, 48, 52, 52];
      const headerSteps = [...Array(8).fill(0), ...slide, ...Array(33).fill(0), ...slide.map((v) => -v), ...Array(8).fill(0)];
      const pageSteps = [
        ...Array(6).fill(0),
        20,
        22,
        ...fast,
        ...Array(33).fill(40),
        ...fast.toReversed().map((v) => -v),
        ...Array(8).fill(0),
      ];
      const n = headerSteps.length, lift: number[] = [], scroll: number[] = [];
      for (let i = 0, u = 0, y = 0; i < n; i++) {
        u += headerSteps[i];
        y += pageSteps[i];
        lift.push(u);
        scroll.push(y);
      }
      const paper: RGB = [247, 247, 245], band = new World(PW, HEADER, paper);
      // Avatar, search field and icon; tab labels as dense glyph strips (pictures), whose rows all differ from the rows a
      // couple of pixels away, as anti-aliased text does: the header moving 2 px is no longer a zero-motion band.
      band.picture({ x: 12, y: 10, width: 32, height: 32 }, 3012);
      band.fill({ x: 54, y: 10, width: PW - 112, height: 32 }, [232, 232, 236]);
      band.textLine(70, 20, 150, 3013, [120, 120, 126]);
      band.picture({ x: PW - 46, y: 12, width: 28, height: 28 }, 3014);
      for (let k = 0; k < 5; k++) band.picture({ x: 16 + k * 74, y: SEARCH + 10, width: 48, height: 18 }, 3015 + k);
      band.fill({ x: 16 + 74, y: SEARCH + TABS - 5, width: 48, height: 3 }, [251, 114, 153]);
      band.fill({ x: 0, y: HEADER - 1, width: PW, height: 1 }, [198, 198, 200]);
      const header: Overlay = {
        id: 'header',
        kind: 'dynamic',
        draw: (frame, index) => {
          const top = TOP - lift[index], from = Math.max(TOP, top);
          for (let y = from; y < top + HEADER; y++) {
            frame.data.set(band.data.subarray((y - top) * PW * 4, (y - top + 1) * PW * 4), y * frame.width * 4);
          }
          return [{ x: 0, y: from, width: PW, height: top + HEADER - from }];
        },
      };
      return {
        name,
        description: '手机信息流：页面先滚，顶栏晚两帧才以自己的小速度往上收，之后标签栏钉在状态栏下；顶栏下面是每帧都在换的轮播图。',
        width: PW,
        height: PH,
        background: [251, 250, 246],
        layers: [{
          id: 'body',
          viewport: { x: 0, y: TOP, width: PW, height: PH - TOP },
          world,
          path: scroll.map((y) => ({ x: 0, y })),
          dynamics: [playingVideo(carousel, 3020)],
        }],
        overlays: [header, fixedBand('status', { x: 0, y: 0, width: PW, height: TOP }, 302, [20, 20, 24])],
        frames: frames(n),
        // Measured before sticky bands could slide: no STICKY_OCCLUSION while the header is in motion (frames 8–16 and 50–57), nor on frames 6–7
        // where it is still over a scrolling page, so its rows reach the compositor; 56 px of it stay on the page canvas
        // over rows seen clean (recoverable). The other 17,336 px of contaminatedOverlay are the 44 rows under the tab row
        // at pose 0, never seen without the header (unobservable; the analytic ceiling, 91,824, also counts the carousel,
        // a page-space dynamic that is never "clean"). The carousel keeps frame 5, the last still frame, so new_ip_8's
        // duplicated tab row (its carousel took a frame with the header over it) does not reproduce here; and unlike
        // new_ip_8 the pinned tab row is learned as a fixed band (screen 48–96). contaminatedDynamic is the carousel
        // keeping one moment. Ratchets are the measured values +5 % (the analytic ceiling exactly).
        // Since sticky_occlusions accepts a band moving at a small speed of its own, frames 12–16 and 54, 55, 57 and 58
        // get their band. Frames 6–11 still do not, although the kernel finds the band there with the true page step
        // (on new_ip_8 the same gap is the pose coming through the anchor, which hands sticky_occlusions a zero step);
        // nor do 50–53 and 56, whose header rows have their page partner in the status bar. Measured contaminatedOverlay
        // 17,304, recoverable 32, provisional 62,342, contaminatedDynamic 92,120 (+64, under its ratchet).
        expect: expect({
          fragments: { body: 0 },
          maxContaminatedOverlay: 18170,
          maxContaminatedOverlayRecoverable: 34,
          maxContaminatedOverlayUnobservable: 91824,
          maxContaminatedDynamic: 96659,
          maxProvisional: 65460,
          diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR', 'NONFINITE_POSE'] },
        }),
      };
    }
    case 'glass-tab-bar': {
      // Frosted-glass bars at both ends of a phone screen (new_ip_9's tab bar, new_ip_3's navigation bar): the page
      // scrolls under them and shows through blurred and washed out (30 % of a 15 px box blur over a light tint), with
      // the bars' own title, icons and labels opaque on top. What shows through is not page content: the print holds the
      // page from the clear area between the bars only. Ideal: both bars are fixed canvases (kept as of frame 0, as
      // `live-bar`), the page is one canvas with nothing of the glass in it.
      const PW = 390, PH = 844, TOP = 100, TAB = 116;
      const world = makeWorld(PW, 4000, 271, 'cards');
      const path = jitter(linearPath([{ x: 0, y: 200 }, { x: 0, y: 1500 }, { x: 0, y: 1300 }, { x: 0, y: 2900 }], [50, 10, 50]), 27, 1, 5);
      const layer: Layer = { id: 'body', viewport: { x: 0, y: TOP, width: PW, height: PH - TOP - TAB }, world, path };
      const dark: RGB = [20, 20, 24];
      return {
        name,
        description: '毛玻璃导航栏与 tab bar：页面在它们下面滚动、模糊透出，栏上的图标文字不动；透出来的不是长图内容。',
        width: PW,
        height: PH,
        background: [251, 250, 246],
        layers: [layer],
        overlays: [
          glassBar('header', { x: 0, y: 0, width: PW, height: TOP }, () => layer, (band) => {
            band.textLine(24, 12, 40, 2711, dark);
            band.fill({ x: 300, y: 16, width: 64, height: 12 }, dark);
            band.textLine(140, 58, 110, 2712, dark, 1.3);
            band.fill({ x: 0, y: TOP - 1, width: PW, height: 1 }, [205, 205, 208]);
          }),
          glassBar('tabs', { x: 0, y: PH - TAB, width: PW, height: TAB }, () => layer, (band) => {
            band.fill({ x: 0, y: 0, width: PW, height: 1 }, [205, 205, 208]);
            for (let k = 0; k < 4; k++) {
              const colour: RGB = k ? [142, 142, 147] : [10, 132, 255];
              band.fill({ x: 34 + k * 92, y: 14, width: 30, height: 26 }, colour);
              band.textLine(28 + k * 92, 46, 42, 2713 + k, colour, .8);
            }
            band.fill({ x: 128, y: TAB - 14, width: 134, height: 5 }, dark);
          }),
        ],
        frames: frames(path.length),
        // Measured on main (c65e33e): no bar is learned as fixed (the only fixed regions are the page's empty 20 px side
        // margins); the top bar is learned as part of the page region, putting 35,000 px seen through the glass on the
        // print (invented), and the tab bar becomes a second moving region with two canvases (UNPLACED_FRAGMENT).
        // maxInvented is that +5 %. Ideal: invented 0, both bars fixed, one moving region.
        expect: expect({
          fragments: { body: -1 },
          limitation: true,
          maxInvented: 36750,
          diagnostics: { present: [], absent: ['PROCESSING_ERROR', 'NONFINITE_POSE'] },
        }),
      };
    }
    case 'sticky-toc-later': {
      // A docs page on a desktop browser (new_mac_3): a full-bleed hero first, then an article column; for the last third
      // of the recording a table of contents is pinned in the left margin (part of the viewport's height), not moving
      // with the page. Full-bleed bands and margin notes keep the margin moving page content; every page pixel under the
      // TOC was seen clean further down the screen before it got there. Ideal: nothing of the TOC on the page canvas.
      const DW = 864, DH = 560, CHROME = 56, n = 150, TOC_FROM = 100;
      const world = new World(DW, 4300), random = rng(281);
      world.picture({ x: 0, y: 0, width: DW, height: 460 }, 2811);
      for (let y = 500; y < 4300 - 80;) {
        const roll = random();
        if (roll < .1) {
          // Full-bleed bands and margin notes keep the left margin moving page content, as on the real page.
          world.picture({ x: 0, y, width: DW, height: Math.min(110, 4300 - y - 8) }, Math.floor(random() * 1e9));
          y += 126;
        } else if (roll < .2) {
          world.paragraph(24, y, 200, 3, Math.floor(random() * 1e6), .85);
          y += world.paragraph(260, y, 560, 3, Math.floor(random() * 1e6)) + 12;
        } else if (roll < .3) {
          world.textLine(260, y, 380, Math.floor(random() * 1e6), [30, 34, 30], 1.8);
          y += 40;
        } else if (roll < .4) {
          const h = 120 + Math.floor(random() * 100);
          world.picture({ x: 260, y, width: 560, height: Math.min(h, 4300 - y - 8) }, Math.floor(random() * 1e9));
          y += h + 16;
        } else {
          y += world.paragraph(260, y, 560, 2 + Math.floor(random() * 5), Math.floor(random() * 1e6)) + 12;
        }
      }
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 3500 }], [n - 1]);
      const tocRect = { x: 24, y: CHROME + 48, width: 196, height: 300 }, toc = new World(tocRect.width, tocRect.height, [243, 243, 240]);
      toc.stroke({ x: 0, y: 0, width: tocRect.width, height: tocRect.height }, [214, 214, 210]);
      toc.textLine(14, 12, 110, 2812, [30, 34, 30], 1.2);
      for (let k = 0; k < 12; k++) toc.textLine(14 + (k % 3 ? 12 : 0), 44 + k * 21, 120 + (k * 37) % 50, 2813 + k, [90, 94, 90], .85);
      toc.fill({ x: 4, y: 44 + 3 * 21, width: 3, height: 14 }, [10, 110, 220]);
      const tocOverlay: Overlay = {
        id: 'toc',
        kind: 'dynamic',
        draw: (frame, index) => {
          if (index < TOC_FROM) return [];
          for (let y = 0; y < tocRect.height; y++) {
            frame.data.set(
              toc.data.subarray(y * tocRect.width * 4, (y + 1) * tocRect.width * 4),
              ((tocRect.y + y) * frame.width + tocRect.x) * 4,
            );
          }
          return [tocRect];
        },
      };
      return {
        name,
        description: '桌面文档页：先是满版大图，最后三分之一时间左侧出现钉在屏幕上的目录（部分高度）；目录不属于页面。',
        width: DW,
        height: DH,
        background: [251, 250, 246],
        layers: [{ id: 'body', viewport: { x: 0, y: CHROME, width: DW, height: DH - CHROME }, world, path }],
        overlays: [fixedBand('header', { x: 0, y: 0, width: DW, height: CHROME }, 282), tocOverlay],
        frames: frames(n),
        // Measured on main (c65e33e): 39,231 px of the TOC stay on the page canvas, every one of them over page content
        // seen clean before the TOC arrived (recoverable); 7,774 px are left provisional. Ratchets are those +5 %.
        // Ideal: contaminatedOverlay 0.
        expect: expect({
          fragments: { body: 0 },
          maxContaminatedOverlay: 41200,
          maxContaminatedOverlayRecoverable: 41200,
          maxProvisional: 8170,
          diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR', 'NONFINITE_POSE'] },
        }),
      };
    }
    case 'hover-card-grow': {
      // A low-contrast card (13 levels darker than the page) on a desktop page (new_mac_2): as it crosses the middle of
      // the screen a hover animation scales it about its centre over eight frames, 636 → 828 px wide and 240 → 314 px
      // tall, and it stays scaled. Rows pass the screen's middle while it grows, so rows taken from different frames
      // would record different widths, the staircase seen on the real recording. Ideal: the card as of one moment (the
      // `atomic` dynamic's torn count is 0). The text inside does not scale here, so the pixels stay exact.
      const DW = 864, DH = 560, CHROME = 56, n = 105, GROW_FROM = 50, GROW = 8;
      const world = makeWorld(DW, 3200, 291, 'article');
      const card = { y: 1500, height: 240 }, narrow = 636, wide = 828, page: RGB = [251, 250, 246], tone: RGB = [238, 237, 233];
      world.fill({ x: 0, y: card.y - 64, width: DW, height: card.height + 128 }, page);
      world.fill({ x: (DW - narrow) / 2, y: card.y, width: narrow, height: card.height }, tone);
      world.textLine((DW - narrow) / 2 + 40, card.y + 30, 300, 2911, [30, 34, 30], 1.6);
      world.paragraph((DW - narrow) / 2 + 40, card.y + 80, narrow - 80, 5, 2912);
      const tall = card.height + 2 * Math.round(card.height * (wide - narrow) / narrow / 2), padY = (tall - card.height) / 2;
      const grow: NonNullable<Layer['dynamics']>[number] = {
        rect: { x: (DW - wide) / 2, y: card.y - padY, width: wide, height: tall },
        atomic: true,
        draw: (scratch, frame) => {
          const t = Math.min(1, Math.max(0, (frame - GROW_FROM + 1) / GROW));
          const w = Math.round(narrow + (wide - narrow) * t), h = Math.round(card.height + (tall - card.height) * t);
          // Whole pixels only: World.fill takes integer rectangles.
          const sx = Math.floor((w - narrow) / 2), sy = Math.floor((h - card.height) / 2), ex = (wide - narrow) / 2;
          const left = ex - sx, top = padY - sy;
          scratch.fill({ x: left, y: top, width: w, height: sy }, tone);
          scratch.fill({ x: left, y: padY + card.height, width: w, height: h - card.height - sy }, tone);
          scratch.fill({ x: left, y: padY, width: sx, height: card.height }, tone);
          scratch.fill({ x: ex + narrow, y: padY, width: w - narrow - sx, height: card.height }, tone);
        },
      };
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 2600 }], [n - 1]);
      return {
        name,
        description: '低对比卡片在滚入视野时被 hover 动画八帧内左右展宽，之后不变：卡片要整张取同一时刻，不拼出阶梯。',
        width: DW,
        height: DH,
        background: [251, 250, 246],
        layers: [{ id: 'body', viewport: { x: 0, y: CHROME, width: DW, height: DH - CHROME }, world, path, dynamics: [grow] }],
        overlays: [fixedBand('header', { x: 0, y: 0, width: DW, height: CHROME }, 292)],
        frames: frames(n),
        // Measured on main (c65e33e): the whole card as of its last moment, torn 0 — this scenario does not reproduce the
        // real staircase (test-results/opt-20261018/synth/REPORT.md) and guards the behaviour instead. The scaled card
        // differed from the unscaled page by 105,696 px, which the page-space dynamic is allowed to keep; since the
        // reveal ranks moments that overflow their component below clean ones it is 62,820 (+5 % here).
        expect: expect({
          fragments: { body: 0 },
          maxContaminatedDynamic: 65961,
          diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR', 'NONFINITE_POSE'] },
        }),
      };
    }
    case 'map-pan-chips': {
      // A vector map panned on a phone (new_ip_7): diagonal drags, flings that decelerate by a constant ratio (so the
      // rounded per-frame steps are irregular), and pauses. A status bar, a search field and a row of filter chips float
      // over the top 154 px of the map, pinned to the screen, with the map showing between the chips. Ideal: the status
      // bar and the search field are fixed canvases, the map one canvas with nothing of the chips in it.
      const PW = 390, PH = 844, TOP = 44;
      const world = mapWorld(1800, 2400, 301);
      const path: Point[] = [];
      let x = 700, y = 900;
      const step = (dx: number, dy: number) => {
        x += dx, y += dy;
        path.push({ x: Math.round(x), y: Math.round(y) });
      };
      path.push({ x, y });
      const drag = (frames: number, dx: number, dy: number) => {
        for (let i = 0; i < frames; i++) step(dx, dy);
      };
      const fling = (frames: number, dx: number, dy: number, decay: number) => {
        for (let i = 0; i < frames; i++) step(dx * decay ** i, dy * decay ** i);
      };
      drag(14, -9, 14);
      fling(22, -26, 40, .86);
      drag(8, 0, 0);
      drag(12, 18, -6);
      fling(20, 34, -12, .85);
      drag(6, 0, 0);
      drag(16, -12, -18);
      fling(18, -20, -30, .87);
      const search = { x: 16, y: 54, width: 296, height: 48 };
      const chips = [{ x: 16, width: 84 }, { x: 116, width: 92 }, { x: 226, width: 80 }, { x: 322, width: 68 }].map((c) => ({
        x: c.x,
        y: 112,
        width: c.width,
        height: 34,
      }));
      const floating: Overlay = {
        id: 'search',
        kind: 'fixed',
        draw: (frame) => {
          fillRGBA(frame, search, [255, 255, 255]);
          fillRGBA(frame, { x: search.x, y: search.y + search.height - 2, width: search.width, height: 2 }, [210, 210, 214]);
          fillRGBA(frame, { x: search.x + 14, y: search.y + 14, width: 20, height: 20 }, [66, 133, 244]);
          fillRGBA(frame, { x: search.x + 48, y: search.y + 19, width: 150, height: 10 }, [112, 117, 122]);
          fillRGBA(frame, { x: search.x + search.width - 40, y: search.y + 10, width: 28, height: 28 }, [94, 151, 108]);
          chips.forEach((c, k) => {
            fillRGBA(frame, c, [255, 255, 255]);
            fillRGBA(frame, { x: c.x, y: c.y + c.height - 2, width: c.width, height: 2 }, [210, 210, 214]);
            fillRGBA(
              frame,
              { x: c.x + 10, y: c.y + 10, width: 14, height: 14 },
              [[219, 68, 55], [66, 133, 244], [15, 157, 88], [244, 160, 0]][k] as RGB,
            );
            fillRGBA(frame, { x: c.x + 30, y: c.y + 13, width: c.width - 42, height: 8 }, [60, 64, 67]);
          });
          return [search, ...chips];
        },
      };
      return {
        name,
        description:
          '手机上平移矢量地图：斜向拖动、按比例减速的甩动（取整后步长不规则）、停顿；状态栏、搜索框和一排筛选 chips 浮在地图上方钉在屏幕上。',
        width: PW,
        height: PH,
        background: [251, 250, 246],
        layers: [{ id: 'body', viewport: { x: 0, y: 0, width: PW, height: PH }, world, path }],
        overlays: [fixedBand('status', { x: 0, y: 0, width: PW, height: TOP }, 302, [32, 33, 36]), floating],
        frames: frames(path.length),
        // Measured on main (c65e33e): the search field and chips were not learned as fixed; their 148 px band became a
        // second moving region (MULTIPLE_SCROLL_LAYERS) holding the map seen between the chips. Since a region
        // whose pixels mostly stay put is frozen into fixed UI, a fixed canvas covers `search`, but that canvas
        // is the whole 148 px band, map seen between the chips included, so its tiles carry temporal conflicts (173)
        // where a pure chrome band would carry none: a known limitation of rectangular region masks. The map's own
        // region is exact.
        expect: expect({
          limitation: true,
          fragments: { body: 0 },
          diagnostics: { present: [], absent: ['PROCESSING_ERROR', 'NONFINITE_POSE'] },
        }),
      };
    }
    case 'fixture': {
      // Small encoded-video fixture: 320×240, 32px fixed bar, 2D non-monotonic path with pauses, jitter and jumps.
      const world = makeWorld(900, 1300, 1337, 'cards', 3);
      const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 210 }, { x: 100, y: 330 }, { x: 20, y: 100 }, { x: 0, y: 0 }], [10, 8, 10, 6]);
      path.push({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 140 }, { x: 0, y: 141 }, { x: 0, y: 320 }, {
        x: 120,
        y: 410,
      });
      return {
        name,
        description: '编码测试样本：H.264 / VP9 容器解析与解码路径。',
        width: 320,
        height: 240,
        background: [251, 250, 246],
        layers: [{ id: 'body', viewport: { x: 0, y: 32, width: 320, height: 208 }, world, path }],
        overlays: [fixedBand('header', { x: 0, y: 0, width: 320, height: 32 }, 99)],
        frames: frames(path.length),
        expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['PROCESSING_ERROR'] } }),
      };
    }
    default:
      throw new Error(`Unknown scenario ${name}. Known: ${SCENARIO_NAMES.join(', ')}.`);
  }
}
