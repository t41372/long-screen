import type { Point, Rect, RGBA } from '../types.ts';
import { rng } from '../core/math.ts';
import { type Expectations, type Layer, type Overlay, type RGB, type Scenario, World, constantFrames, fillRGBA, linearPath, makeWorld } from './world.ts';
const expect = (partial: Partial<Expectations> = {}): Expectations => ({ fragments: {}, diagnostics: { present: [], absent: ['PROCESSING_ERROR', 'NONFINITE_POSE'] }, maxError: 0, status: 'complete', ...partial });
/** Pre-rendered static band drawn identically in every frame (status bar, toolbar, tab bar, sticky header). */
export function fixedBand(id: string, rect: Rect, seed: number, colour: RGB = [38, 59, 51]): Overlay {
    const band = new World(rect.width, rect.height, colour);
    band.textLine(18, Math.max(4, Math.round(rect.height / 2) - 9), Math.min(220, rect.width - 60), seed, [250, 249, 242], 1.2);
    for (let k = 0; k < 4; k++)
        band.fill({ x: rect.width - 40 - k * 28, y: Math.round(rect.height / 2) - 6, width: 12, height: 12 }, [[214, 136, 112], [203, 211, 197], [250, 249, 242], [120, 160, 140]][k] as RGB);
    return { id, kind: 'fixed', draw: (frame: RGBA) => { for (let y = 0; y < rect.height; y++) frame.data.set(band.data.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.y + y) * frame.width + rect.x) * 4); return [rect]; } };
}
export function floatingButton(rect: Rect): Overlay {
    return { id: 'fab', kind: 'fixed', draw: frame => { fillRGBA(frame, rect, [207, 103, 80]); fillRGBA(frame, { x: rect.x + 10, y: rect.y + rect.height / 2 - 2, width: rect.width - 20, height: 4 }, [255, 255, 255]); fillRGBA(frame, { x: rect.x + rect.width / 2 - 2, y: rect.y + 10, width: 4, height: rect.height - 20 }, [255, 255, 255]); return [rect]; } };
}
/** Mouse pointer moving in screen space: small, dynamic, never page content. */
export function cursor(path: (index: number) => Point): Overlay {
    return { id: 'cursor', kind: 'dynamic', draw: (frame, index) => { const p = path(index), r = { x: p.x, y: p.y, width: 10, height: 16 }; for (let y = 0; y < 16; y++) fillRGBA(frame, { x: p.x, y: p.y + y, width: Math.max(1, Math.min(10, Math.round(y * .7))), height: 1 }, y % 3 ? [20, 20, 20] : [255, 255, 255]); return [r]; } };
}
export function toast(rect: Rect, from: number, to: number): Overlay {
    return { id: 'toast', kind: 'dynamic', draw: (frame, index) => { if (index < from || index >= to) return []; fillRGBA(frame, rect, [40, 40, 44]); fillRGBA(frame, { x: rect.x + 12, y: rect.y + rect.height / 2 - 3, width: rect.width - 24, height: 6 }, [230, 230, 220]); return [rect]; } };
}
/** Scrollbar thumb: screen-space, position derived from page offset. */
export function scrollbar(layer: () => Layer, side = 'right'): Overlay {
    return { id: 'scrollbar', kind: 'dynamic', draw: (frame, index) => { const l = layer(), v = l.viewport, t = l.path[index].y / Math.max(1, l.world.height - v.height), thumb = Math.max(24, Math.round(v.height * v.height / l.world.height)), r = { x: side === 'right' ? v.x + v.width - 8 : v.x + 2, y: v.y + Math.round(t * (v.height - thumb)), width: 6, height: thumb }; fillRGBA(frame, r, [150, 150, 150]); return [r]; } };
}
export function blinkingCaret(rect: Rect, period = 8): NonNullable<Layer['dynamics']>[number] {
    return { rect, draw: (scratch, frame) => { if (Math.floor(frame / period) % 2 === 0) scratch.fill({ x: 0, y: 0, width: rect.width, height: rect.height }, [20, 20, 20]); } };
}
export function liveCounter(rect: Rect, every = 10): NonNullable<Layer['dynamics']>[number] {
    return { rect, draw: (scratch, frame) => { scratch.fill({ x: 0, y: 0, width: rect.width, height: rect.height }, [255, 255, 255]); const n = Math.floor(frame / every); for (let d = 0; d < 5; d++) { const digit = Math.floor(n / 10 ** d) % 10; scratch.fill({ x: rect.width - 14 - d * 14, y: 4, width: 10, height: rect.height - 8 }, [30 + digit * 20, 60, 90 + digit * 10]); scratch.fill({ x: rect.width - 12 - d * 14, y: 6 + digit, width: 6, height: 3 }, [255, 255, 255]); } } };
}
export function animatedWidget(rect: Rect): NonNullable<Layer['dynamics']>[number] {
    return { rect, draw: (scratch, _frame, time) => { scratch.fill({ x: 0, y: 0, width: rect.width, height: rect.height }, [31, 57, 66]); const cx = Math.round(rect.width / 2 + Math.sin(time * 6) * (rect.width / 2 - 20)); scratch.fill({ x: cx - 12, y: rect.height / 2 - 12, width: 24, height: 24 }, [230, 191, 101]); } };
}
export function playingVideo(rect: Rect, seed: number): NonNullable<Layer['dynamics']>[number] {
    return { rect, draw: (scratch, frame) => scratch.picture({ x: 0, y: 0, width: rect.width, height: rect.height }, seed + frame * 7919) };
}
export function jitter(path: Point[], seed: number, amplitude = 1, every = 3): Point[] {
    const random = rng(seed);
    return path.map((p, i) => i % every === 1 ? { x: p.x + Math.round((random() - .5) * 2 * amplitude), y: p.y + Math.round((random() - .5) * 2 * amplitude) } : p);
}
export const SCENARIO_NAMES = ['traversal', 'vertical', 'horizontal', 'diagonal', 'fling', 'revisit', 'panes', 'gap', 'dynamic', 'lazy-load', 'zoom', 'blank', 'repeated-list', 'repeated-list-reversal', 'comic', 'phone', 'vfr', 'retina', 'factor4', 'geometry-change', 'toolbar-collapse', 'chrome-everything', 'glimpse'] as const;
export type ScenarioName = typeof SCENARIO_NAMES[number];
/** Deterministic recordings with exact ground truth. Each one isolates a behaviour named in the requirements. */
export function buildScenario(name: ScenarioName | string): Scenario {
    const W = 640, H = 448, HEADER = 48, bodyViewport = { x: 0, y: HEADER, width: W, height: H - HEADER };
    const frames = (n: number, fps = 30) => constantFrames(n, fps);
    const body = (world: World, path: Point[], extra: Partial<Layer> = {}): Layer => ({ id: 'body', viewport: bodyViewport, world, path, ...extra });
    switch (name) {
        case 'traversal': {
            const world = makeWorld(1400, 2200, 11, 'cards', 3);
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 350 }, { x: 210, y: 560 }, { x: 370, y: 240 }, { x: 140, y: 160 }, { x: 0, y: 0 }, { x: 0, y: 350 }, { x: 280, y: 540 }], [13, 11, 13, 9, 8, 13, 13]);
            path.splice(24, 0, path[24], path[24], path[24], path[24], path[24]);
            return { name, description: '二维非单调移动、暂停、回访，固定顶部栏。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 5)], frames: frames(path.length), expect: expect({ fragments: { body: 0, header: 0 }, diagnostics: { present: ['AUTOMATIC_LAYER_MASK'], absent: ['UNPLACED_FRAGMENT', 'SCALE_CHANGE_FRAGMENT', 'PROCESSING_ERROR', 'NONFINITE_POSE'] } }) };
        }
        case 'vertical': {
            const world = makeWorld(900, 3200, 21, 'article');
            let path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 900 }, { x: 0, y: 700 }, { x: 0, y: 1900 }, { x: 0, y: 2600 }], [30, 6, 20, 14]);
            path.splice(12, 0, path[12], path[12], path[12]);
            path = jitter(path, 3, 1, 4);
            return { name, description: '纵向滚动：非恒定速度、暂停、手抖、方向反转。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 6)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'horizontal': {
            const world = makeWorld(3000, 600, 31, 'cards', 6);
            const path = linearPath([{ x: 0, y: 40 }, { x: 1200, y: 40 }, { x: 900, y: 40 }, { x: 2300, y: 40 }], [28, 6, 24]);
            return { name, description: '横向移动与回退。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 7)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'diagonal': {
            const world = makeWorld(1600, 1600, 41, 'article', 2);
            const path = linearPath([{ x: 0, y: 0 }, { x: 700, y: 900 }, { x: 900, y: 300 }, { x: 200, y: 1000 }], [26, 14, 22]);
            return { name, description: '斜向与奇数位移。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 8)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'fling': {
            const world = makeWorld(900, 4000, 51, 'article');
            const path: Point[] = [{ x: 0, y: 0 }];
            const steps = [40, 90, 160, 230, 230, 200, 140, 70, 20, 5, 0, 0, -30, -120, -220, -220, -160, -60, 0, 0, 250, 250, 250, 250, 180, 90, 30, 0];
            for (const s of steps)
                path.push({ x: 0, y: Math.max(0, path[path.length - 1].y + s) });
            return { name, description: '高速 fling、加减速、方向反转；部分内容只出现 1–2 帧。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 9)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'revisit': {
            const world = makeWorld(900, 2600, 61, 'article');
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1500 }, { x: 0, y: 0 }, { x: 0, y: 1500 }], [30, 30, 30]);
            return { name, description: '同一区域反复经过三次；内容只能出现一次。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 10)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'panes': {
            const left = makeWorld(318, 2400, 71, 'cards'), right = makeWorld(318, 2600, 72, 'article');
            const n = 75, lp: Point[] = [], rp: Point[] = [];
            for (let i = 0; i < n; i++) {
                lp.push({ x: 0, y: i < 35 ? i * 8 : 280 - (i - 35) * 5 });
                rp.push({ x: 0, y: i < 20 ? 0 : (i - 20) * 7 });
            }
            const divider: Overlay = { id: 'divider', kind: 'fixed', draw: frame => { const r = { x: 318, y: HEADER, width: 4, height: H - HEADER }; fillRGBA(frame, r, [57, 67, 55]); return [r]; } };
            return { name, description: '两个独立滚动的 pane，各自的位移轨迹。', width: W, height: H, background: [251, 250, 246], layers: [{ id: 'left', viewport: { x: 0, y: HEADER, width: 318, height: H - HEADER }, world: left, path: lp }, { id: 'right', viewport: { x: 322, y: HEADER, width: 318, height: H - HEADER }, world: right, path: rp }], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 11), divider], frames: frames(n), expect: expect({ fragments: { left: 0, right: 0 }, diagnostics: { present: ['MULTIPLE_SCROLL_LAYERS'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'gap': {
            const world = makeWorld(1400, 4600, 81, 'cards', 3);
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 350 }, { x: 210, y: 560 }, { x: 370, y: 240 }, { x: 140, y: 160 }, { x: 0, y: 0 }, { x: 0, y: 350 }, { x: 280, y: 540 }], [13, 11, 13, 9, 8, 13, 13]);
            path.splice(25, 0, { x: 0, y: 4100 }, { x: 0, y: 4118 });
            return { name, description: '无重叠跳转后返回：跳转观察保留为独立片段。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 12)], frames: frames(path.length), expect: expect({ fragments: { body: 1 }, diagnostics: { present: ['UNPLACED_FRAGMENT'], absent: ['PROCESSING_ERROR'] } }) };
        }
        case 'dynamic': {
            const world = makeWorld(1400, 2200, 91, 'cards', 3);
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 350 }, { x: 210, y: 560 }, { x: 370, y: 240 }, { x: 140, y: 160 }, { x: 0, y: 0 }, { x: 0, y: 350 }, { x: 280, y: 540 }], [13, 11, 13, 9, 8, 13, 13]);
            return { name, description: '页面内动画组件 + 鼠标指针。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path, { dynamics: [animatedWidget({ x: 200, y: 260, width: 150, height: 70 })] })], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 13), cursor(i => ({ x: 320 + Math.round(Math.sin(i / 5) * 200), y: 240 + Math.round(Math.cos(i / 7) * 150) }))], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: ['TEMPORAL_OR_ALIGNMENT_CONFLICT'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'lazy-load': {
            const world = makeWorld(900, 2000, 101, 'article');
            world.fill({ x: 40, y: 700, width: 500, height: 200 }, [236, 236, 230]);
            world.patch(30, { x: 40, y: 700, width: 500, height: 200 }, scratch => scratch.picture({ x: 0, y: 0, width: 500, height: 200 }, 4242));
            const path = linearPath([{ x: 0, y: 300 }, { x: 0, y: 900 }, { x: 0, y: 300 }, { x: 0, y: 1000 }], [22, 22, 22]);
            return { name, description: '懒加载图片在录制中途出现：同一区域存在两个版本。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 14)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: ['TEMPORAL_OR_ALIGNMENT_CONFLICT'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'zoom': {
            const world = makeWorld(1400, 1600, 111, 'cards', 3);
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 500 }, { x: 120, y: 620 }, { x: 120, y: 900 }], [20, 8, 16]);
            const zoom = path.map((_, i) => i < 28 ? 1 : 1.25);
            return { name, description: '录制中途 pinch zoom：比例变化后的观察成为独立片段，不被缩放混合。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path, { zoom })], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 15)], frames: frames(path.length), expect: expect({ fragments: { body: 1 }, diagnostics: { present: ['SCALE_CHANGE_FRAGMENT'], absent: ['PROCESSING_ERROR'] } }) };
        }
        case 'blank': {
            const world = makeWorld(900, 2600, 121, 'article');
            world.fill({ x: 0, y: 700, width: 900, height: 900 }, [251, 250, 246]);
            const path = linearPath([{ x: 0, y: 200 }, { x: 0, y: 1400 }, { x: 0, y: 2000 }], [30, 15]);
            return { name, description: '大面积纯色：完全空白的帧无法判断运动，只能 best guess 并给出警告。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 16)], frames: frames(path.length), expect: expect({ fragments: { body: 1 }, diagnostics: { present: ['UNOBSERVABLE_FRAME', 'UNPLACED_FRAGMENT'], absent: ['PROCESSING_ERROR'] } }) };
        }
        case 'repeated-list': {
            const world = makeWorld(900, 2800, 131, 'list');
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1200 }, { x: 0, y: 2300 }], [80, 44]);
            return { name, description: '高度重复的相同列表行，单向滚动：每步都小于行高的一半或与速度连续，位置可由连续性唯一确定。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 17)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: ['LOW_CONFIDENCE_PLACEMENT'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'repeated-list-reversal': {
            const world = makeWorld(900, 2800, 131, 'list');
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1500 }, { x: 0, y: 1200 }, { x: 0, y: 2300 }], [100, 20, 44]);
            return { name, description: '相同列表行中途反向：向上 15px 与向下 29px（行高 44）像素上无法区分，只能 best guess 并明确警告；误差只会是行高的整数倍。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 17)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, maxError: Infinity, ambiguousPeriod: 44, diagnostics: { present: ['LOW_CONFIDENCE_PLACEMENT', 'AMBIGUOUS_PATTERN'], absent: ['PROCESSING_ERROR'] } }) };
        }
        case 'comic': {
            const world = makeWorld(700, 5200, 141, 'comic');
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 4700 }], [46]);
            return { name, description: '长条漫画：大幅图片、快速纵向滚动。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 18)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'phone': {
            const PW = 390, PH = 844, TOP = 44, NAV = 64;
            const world = makeWorld(390, 3600, 151, 'cards');
            let path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1400 }, { x: 0, y: 1100 }, { x: 0, y: 2600 }], [30, 8, 26]);
            path = jitter(path, 5, 2, 3);
            const layer: Layer = { id: 'body', viewport: { x: 0, y: TOP, width: PW, height: PH - TOP - NAV }, world, path };
            return { name, description: '手机竖屏：状态栏、底部导航、悬浮按钮、滚动条、手抖。', width: PW, height: PH, background: [251, 250, 246], layers: [layer], overlays: [fixedBand('status', { x: 0, y: 0, width: PW, height: TOP }, 19, [20, 20, 24]), fixedBand('nav', { x: 0, y: PH - NAV, width: PW, height: NAV }, 20, [245, 245, 240]), floatingButton({ x: PW - 76, y: PH - NAV - 80, width: 56, height: 56 }), scrollbar(() => layer)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
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
            for (const k of [10, 11, 25])
                path[k] = path[k - 1];
            return { name, description: '可变帧率、超长首帧、重复帧。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 21)], frames: list, expect: expect({ fragments: { body: 0 }, diagnostics: { present: ['TEMPORAL_UNDERSAMPLING'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'retina': {
            const RW = 1280, RH = 896, RH_HEADER = 96;
            const world = makeWorld(2000, 2600, 171, 'cards', 3);
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 700 }, { x: 300, y: 1100 }, { x: 500, y: 400 }, { x: 0, y: 0 }], [14, 10, 12, 12]);
            return { name, description: '2× 高分辨率录屏：分析在 1/2 尺度进行，输出保持原像素。', width: RW, height: RH, background: [251, 250, 246], layers: [{ id: 'body', viewport: { x: 0, y: RH_HEADER, width: RW, height: RH - RH_HEADER }, world, path }], overlays: [fixedBand('header', { x: 0, y: 0, width: RW, height: RH_HEADER }, 22)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: ['ANALYSIS_PYRAMID'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'factor4': {
            const RW = 1920, RH = 1080, RH_HEADER = 80;
            const world = makeWorld(2400, 2600, 181, 'cards', 4);
            const path = linearPath([{ x: 0, y: 0 }, { x: 200, y: 900 }, { x: 400, y: 300 }], [14, 12]);
            return { name, description: '桌面横屏 1080p，分析因子 4。', width: RW, height: RH, background: [251, 250, 246], layers: [{ id: 'body', viewport: { x: 0, y: RH_HEADER, width: RW, height: RH - RH_HEADER }, world, path }], overlays: [fixedBand('header', { x: 0, y: 0, width: RW, height: RH_HEADER }, 23)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: ['ANALYSIS_PYRAMID'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'geometry-change': {
            const world = makeWorld(900, 2000, 191, 'article');
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 900 }], [40]);
            const list = frames(path.length).map((f, i) => i >= 20 ? { ...f, width: H, height: W } : f);
            return { name, description: '录制中途方向/尺寸改变：保留前缀，明确报告。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 24)], frames: list, expect: expect({ fragments: { body: 0 }, status: 'partial', frames: 20, diagnostics: { present: ['DECODE_PREFIX_ONLY'], absent: ['NONFINITE_POSE'] } }) };
        }
        case 'toolbar-collapse': {
            const world = makeWorld(900, 2400, 201, 'article');
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1400 }], [50]);
            const tall = fixedBand('header', { x: 0, y: 0, width: W, height: 96 }, 25), short = fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 25);
            const layer: Layer = { id: 'body', viewport: { x: 0, y: 96, width: W, height: H - 96 }, world, path };
            const header: Overlay = { id: 'header', kind: 'dynamic', draw: (frame, index, time) => index < 30 ? tall.draw(frame, index, time) : short.draw(frame, index, time) };
            const collapse: Overlay = { id: 'collapse', kind: 'dynamic', draw: (frame, index) => { if (index < 30) return []; const r = { x: 0, y: HEADER, width: W, height: 96 - HEADER }; const p = path[index]; for (let y = 0; y < r.height; y++) frame.data.set(world.data.subarray(((p.y - r.height + y) * world.width + p.x) * 4, ((p.y - r.height + y) * world.width + p.x + W) * 4), ((r.y + y) * frame.width) * 4); return [r]; } };
            return { name, description: '地址栏收起：正文可视区在录制中途变大。已知局限，只要求不崩溃、不伪造。', width: W, height: H, background: [251, 250, 246], layers: [layer], overlays: [header, collapse], frames: frames(path.length), expect: expect({ fragments: { body: -1 }, limitation: true, diagnostics: { present: ['TEMPORAL_OR_ALIGNMENT_CONFLICT'], absent: ['PROCESSING_ERROR', 'NONFINITE_POSE'] } }) };
        }
        case 'chrome-everything': {
            const world = makeWorld(900, 2600, 211, 'article');
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 1200 }, { x: 0, y: 900 }, { x: 0, y: 1900 }], [24, 8, 20]);
            return { name, description: '固定栏、悬浮按钮、toast、闪烁光标、实时计数器、播放中的视频同时存在。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path, { dynamics: [blinkingCaret({ x: 60, y: 130, width: 2, height: 14 }), liveCounter({ x: 700, y: 400, width: 120, height: 28 }), playingVideo({ x: 100, y: 1500, width: 320, height: 180 }, 77)] })], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 26), floatingButton({ x: W - 72, y: H - 72, width: 52, height: 52 }), toast({ x: 160, y: H - 90, width: 320, height: 40 }, 18, 34), cursor(i => ({ x: 400 + Math.round(Math.sin(i / 4) * 120), y: 300 + Math.round(Math.cos(i / 6) * 90) }))], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: ['TEMPORAL_OR_ALIGNMENT_CONFLICT'], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'glimpse': {
            const world = makeWorld(900, 3000, 221, 'cards');
            const path: Point[] = [];
            for (let i = 0; i < 12; i++)
                path.push({ x: 0, y: i * 20 });
            // One frame in the middle of a fast sweep exposes content seen in no other frame.
            path.push({ x: 0, y: 520 }, { x: 0, y: 820 }, { x: 0, y: 1100 }, { x: 0, y: 1360 }, { x: 0, y: 1600 }, { x: 0, y: 1820 }, { x: 0, y: 2020 }, { x: 0, y: 2180 }, { x: 0, y: 2300 });
            for (let i = 0; i < 10; i++)
                path.push({ x: 0, y: 2300 + i * 15 });
            return { name, description: '快速扫过：某些内容仅在一帧可见，仍必须进入结果。', width: W, height: H, background: [251, 250, 246], layers: [body(world, path)], overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 27)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] } }) };
        }
        case 'fixture': {
            // Small encoded-video fixture: 320×240, 32px fixed bar, 2D non-monotonic path with pauses, jitter and jumps.
            const world = makeWorld(900, 1300, 1337, 'cards', 3);
            const path = linearPath([{ x: 0, y: 0 }, { x: 0, y: 210 }, { x: 100, y: 330 }, { x: 20, y: 100 }, { x: 0, y: 0 }], [10, 8, 10, 6]);
            path.push({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 140 }, { x: 0, y: 141 }, { x: 0, y: 320 }, { x: 120, y: 410 });
            return { name, description: '编码测试样本：H.264 / VP9 容器解析与解码路径。', width: 320, height: 240, background: [251, 250, 246], layers: [{ id: 'body', viewport: { x: 0, y: 32, width: 320, height: 208 }, world, path }], overlays: [fixedBand('header', { x: 0, y: 0, width: 320, height: 32 }, 99)], frames: frames(path.length), expect: expect({ fragments: { body: 0 }, diagnostics: { present: [], absent: ['PROCESSING_ERROR'] } }) };
        }
        default:
            throw new Error(`Unknown scenario ${name}. Known: ${SCENARIO_NAMES.join(', ')}.`);
    }
}
