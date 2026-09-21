import type { Attachment, CanvasMeta, Diagnostic, Feature, FramePlan, FrameSource, Gray, MotionField, Placement, Point, Progress, Project, Region, RGBA, ScanRecord, Settings } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { Namespace, iterate } from '../storage/db.ts';
import { Diagnostics } from '../storage/diagnostics.ts';
import { TileStore } from '../storage/tiles.ts';
import { extractFeatures, grayscale, matchFeatures } from '../core/features.ts';
import { auditTranslation, estimateMotion, extractPatches, type NativeRefinement, probeScale, refineNative, refinePatches, translationHypotheses } from '../core/motion.ts';
import { LayerLearner, RegionAtlas, regionContains, stickyOcclusions } from '../core/layers.ts';
import { PoseGraph, type PoseNode } from '../core/pose-graph.ts';
import { KeyframeIndex, type Keyframe } from '../core/keyframes.ts';
import { Compositor } from '../core/compositor.ts';
import { pad } from '../core/math.ts';
import { analysisFactor, equalRGBA, thumbnail } from '../core/raster.ts';
import { encodeRGBA } from '../codec/png.ts';
import { buildFramedCanvas } from '../core/framing.ts';
import { AnalysisComputer } from '../core/compute.ts';
interface State {
    region: Region;
    code: number;
    canvasId: string;
    fragment: number;
    pose: Point;
    /** Last accepted native displacement; a weak constant-velocity prior that breaks ties between period-aliased hypotheses. */
    velocity: Point;
    lastNode?: PoseNode;
    anchor?: Keyframe;
    previousFeatures?: Feature[];
    /** Previous frame carried no usable texture in this pane. */
    blind: boolean;
    /** The last accepted step had little overlap, so its alignment rests on thin evidence and revisits may outrank it. */
    weak: boolean;
    /** A textured frame has been observed, so the canvas origin is defined. */
    started: boolean;
}
type Decision = 'tracked' | 'static' | 'blind' | 'lost';
export interface EngineEvents {
    progress: (p: Progress) => void;
    diagnostic: (d: Diagnostic) => void;
    preview: (blob: Blob) => void;
    project: (p: Project) => void;
}
export class Engine {
    readonly project: Project;
    readonly store: KV;
    readonly diagnostics: Diagnostics;
    readonly tiles: TileStore;
    paused = false;
    stopRequested = false;
    private phase = 'scanning';
    private partial = false;
    private lastProgress = 0;
    private lastPersist = 0;
    private pauseWaiters: (() => void)[] = [];
    private processed = 0;
    private regions: Region[] = [];
    private timings: Record<string, number> = {};
    private duplicates = 0;
    private skippedPaints = 0;
    private atlas?: RegionAtlas;
    private source: FrameSource;
    private computer: AnalysisComputer;
    /** Integer analysis factor: analysis pixels × factor = native pixels, exactly. */
    readonly factor: number;
    /** Native refinement radius must cover the ±factor/2 quantisation of an integer analysis estimate. */
    readonly refineRadius: number;
    constructor(private db: KV, source: FrameSource, settings: Settings, private events: EngineEvents) {
        this.source = source;
        this.computer = new AnalysisComputer(settings.compute || 'cpu');
        const id = crypto.randomUUID(), now = new Date().toISOString();
        this.project = { id, created: now, updated: now, name: source.info.name, settings, media: source.info, status: 'scanning', frames: 0, renderedFrames: 0, canvasCount: 0, tiles: 0, observedPixels: 0, diagnostics: {}, regions: [] };
        this.store = new Namespace(db, `run/${id}/`);
        this.diagnostics = new Diagnostics(this.store, d => events.diagnostic(d));
        this.tiles = new TileStore(this.store, settings.tileSize, settings.memoryMB);
        this.factor = analysisFactor(source.info.width, source.info.height, settings.analysisSize);
        this.refineRadius = Math.max(3, Math.ceil(this.factor / 2) + 1);
    }
    setPaused(paused: boolean): void { this.paused = paused; if (!paused)
        for (const resolve of this.pauseWaiters.splice(0))
            resolve(); }
    private async checkpoint(): Promise<void> {
        if (this.paused)
            await new Promise<void>(resolve => this.pauseWaiters.push(resolve));
        // Yield CPU ownership so message handling, cancellation, and pause remain responsive.
        if (performance.now() - this.lastProgress > 100)
            await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    private async gray(image: RGBA): Promise<Gray> {
        if (image.width !== this.source.info.width || image.height !== this.source.info.height)
            throw new Error(`FRAME_GEOMETRY_CHANGED: observation is ${image.width}×${image.height}; the run is ${this.source.info.width}×${this.source.info.height}.`);
        return this.computer.gray(image, this.factor);
    }
    private async persist(): Promise<void> {
        this.project.updated = new Date().toISOString();
        this.project.diagnostics = { ...this.diagnostics.counts };
        await this.db.put(`project/${this.project.id}`, this.project);
        this.events.project(this.project);
        this.lastPersist = performance.now();
    }
    private async report(frame: number, time: number, message: string, fraction?: number, canvas?: CanvasMeta): Promise<void> {
        const now = performance.now();
        if (now - this.lastProgress < 100)
            return;
        this.lastProgress = now;
        this.events.progress({ phase: this.phase, frames: frame, total: this.source.info.frameCount, time, message, fraction: fraction ?? Math.min(1, time / Math.max(.001, this.source.info.duration)), canvas });
        if (now - this.lastPersist > 1200)
            await this.persist();
        await this.checkpoint();
    }
    async run(): Promise<Project> {
        await this.persist();
        try {
            await this.diagnostics.emit({ code: 'MODEL_ASSUMPTIONS', severity: 'info', message: '重建采用分层平移画布与几何回环约束。自动遮罩和动态区域属于启发式推断；置信分数不是经过校准的正确概率。', action: '比例或结构无法共存时会保留独立片段，不把不相容的状态强行拼接。' });
            if (this.project.settings.decoder === 'compatibility')
                await this.diagnostics.emit({ code: 'APPROXIMATE_DECODER', severity: 'warning', message: `已明确启用 ${this.project.settings.compatibilityFPS} Hz 原生 seek 兼容模式。不能保证采到视频的每一帧，短暂内容可能缺失。`, action: '需要逐帧覆盖保证时，使用 WebCodecs 支持的 H.264、VP9 等输入。' });
            if (this.source.info.width > this.project.settings.analysisSize || this.source.info.height > this.project.settings.analysisSize)
                await this.diagnostics.emit({ code: 'ANALYSIS_PYRAMID', severity: 'info', message: `运动分析的长边上限为 ${this.project.settings.analysisSize}px；原分辨率像素用于精修和最终合成，输出没有跟随降采样。` });
            for (const warning of this.source.info.warnings)
                await this.diagnostics.emit({ code: 'MEDIA_NOTICE', severity: 'warning', message: warning });
            if (this.source.info.width * this.source.info.height * 4 * 4 > this.project.settings.memoryMB * 1024 * 1024 * .8)
                await this.diagnostics.emit({ code: 'FRAME_MEMORY_PRESSURE', severity: 'warning', message: '单帧原始像素及参考帧占用已接近所选缓存预算。解码器/GPU 自身内存不受 JavaScript 缓存预算控制。', action: '不会静默降低输出分辨率；内存不足时保留已提交数据并报告失败。' });
            let phaseStart = performance.now();
            await this.scan();
            this.timings.scanMS = performance.now() - phaseStart;
            if (!this.project.frames)
                throw new Error('No observations could be decoded. Nothing has been marked as reconstructed.');
            phaseStart = performance.now();
            await this.solve();
            this.timings.solveMS = performance.now() - phaseStart;
            phaseStart = performance.now();
            await this.render();
            this.timings.renderMS = performance.now() - phaseStart;
            phaseStart = performance.now();
            if (this.project.settings.framing === 'context') {
                this.phase = 'framing';
                const originals: CanvasMeta[] = [];
                for await (const { value } of iterate<CanvasMeta>(this.store, 'canvas/')) if (value.kind === 'moving' && value.tileCount && !value.attachedTo) originals.push(value);
                this.events.progress({ phase: 'framing', fraction: 0, frames: this.project.renderedFrames, time: 0, message: '保留原始外框；只延伸背景，不拉伸侧栏文字或重复图标。' });
                for (const meta of originals) {
                    const region = this.regions.find(r => r.id === meta.layer)!;
                    const framed = await buildFramedCanvas(this.store, this.tiles, meta, region, this.regions, () => this.checkpoint());
                    if (framed) { this.project.canvasCount++; this.project.tiles += framed.tileCount; }
                }
                if (originals.length) await this.diagnostics.emit({ code: 'PRESENTATION_FRAME', severity: 'info', message: '带外框视图与原始二维内容分别保留。外框来自参考帧，延长部分仅为装饰背景，不算作已观察内容；不会拉伸或复制工具栏图标。其他 pane 在外框中只是参考快照。' });
            }
            this.timings.framingMS = performance.now() - phaseStart;
            phaseStart = performance.now();
            this.phase = 'pyramid';
            this.project.status = 'pyramid';
            await this.persist();
            let built = 0;
            for await (const { value: meta } of iterate<CanvasMeta>(this.store, 'canvas/')) {
                if (meta.tileCount) {
                    await this.tiles.buildPyramid(meta, async () => { await this.checkpoint(); await this.report(this.project.renderedFrames, meta.lastTime, '正在建立磁盘预览金字塔；原尺寸瓦片保持不变。', built / Math.max(1, this.project.canvasCount), meta); });
                }
                built++;
            }
            this.timings.pyramidMS = performance.now() - phaseStart;
            await this.store.put('performance', { ...this.timings, exactDuplicateFrames: this.duplicates, skippedPaints: this.skippedPaints, tileEncodes: this.tiles.encodedTiles, tileDecodes: this.tiles.decodedTiles, tileEvictions: this.tiles.evictions, compute: this.computer.stats, note: 'Stage timings include decoding, storage and yields; not GPU-only kernel time.' });
            this.project.status = this.partial ? 'partial' : 'complete';
            await this.diagnostics.flush();
            await this.persist();
            this.events.progress({ phase: this.project.status, fraction: 1, frames: this.project.renderedFrames, time: this.source.info.duration, message: this.partial ? '已保存明确标记的部分重建。' : '重建已完成；请检查诊断与未观察区域。' });
        }
        catch (error) {
            this.project.status = this.project.renderedFrames ? 'partial' : 'error';
            this.project.error = error instanceof Error ? error.message : String(error);
            this.events.diagnostic({ code: 'PROCESSING_ERROR', severity: 'error', message: this.project.error, action: '已经提交到本地存储的瓦片仍可查看和导出；没有把失败标记成成功。' });
            // Do not destroy committed work when a later operation, codec, or quota fails.
            try {
                await this.tiles.flush();
                await this.diagnostics.flush();
                await this.persist();
            }
            catch (storageError) {
                this.events.diagnostic({ code: 'PERSISTENCE_ERROR', severity: 'error', message: String(storageError), action: '存储写入也失败；仅先前成功提交的数据可恢复。' });
            }
        }
        finally {
            this.computer.dispose();
            this.source.dispose();
        }
        return this.project;
    }
    private async scan(): Promise<void> {
        this.phase = 'scanning';
        let previous: Gray | undefined, previousImage: RGBA | undefined, previousFeatures: Feature[] | undefined, lastField: MotionField | undefined, learner: LayerLearner | undefined;
        const pending: {
            key: string;
            value: ScanRecord;
        }[] = [];
        try {
            for await (const frame of this.source.frames()) {
                await this.checkpoint();
                const duplicate = !!previousImage && equalRGBA(previousImage, frame.image);
                const g = duplicate ? previous! : await this.gray(frame.image), features = duplicate ? previousFeatures! : extractFeatures(g);
                learner ??= new LayerLearner(g.width, g.height);
                let field: MotionField;
                if (duplicate && lastField) {
                    this.duplicates++;
                    field = { ...lastField, motions: [{ x: 0, y: 0, support: features.length, unique: features.length, confidence: 1, error: 0, ambiguous: false }], labels: new Uint8Array(lastField.labels.length), dynamic: new Uint8Array(lastField.labels.length), difference: 0, unknown: false, zoom: 1 };
                }
                else if (previous) {
                    field = estimateMotion(previous, g, lastField, previousFeatures, features);
                    learner.add(field, previous, g, previousImage, frame.image);
                }
                else {
                    const cols = Math.ceil(g.width / 24), rows = Math.ceil(g.height / 24);
                    field = { motions: [{ x: 0, y: 0, support: features.length, unique: features.length, confidence: 1, error: 0, ambiguous: false }], labels: new Uint8Array(cols * rows), confidence: new Uint8Array(cols * rows).fill(255), dynamic: new Uint8Array(cols * rows), cols, rows, cell: 24, difference: 0, featureCount: features.length, unknown: false, zoom: 1 };
                    this.events.preview(new Blob([await encodeRGBA(thumbnail(frame.image, 640))], { type: 'image/png' }));
                    await this.diagnostics.emit({ code: 'COMPUTE_BACKEND', severity: 'info', message: `${this.computer.stats.backend} — ${this.computer.stats.reason}。匹配、位置图与像素合成仍在 CPU。`, detail: this.computer.stats });
                    if (this.project.settings.framing === 'context')
                        await this.store.put('frame-reference', { frame: frame.index, image: new Blob([await encodeRGBA(frame.image)], { type: 'image/png' }) });
                }
                const record: ScanRecord = { index: frame.index, time: frame.time, duration: frame.duration, field, features: duplicate ? undefined : features, duplicate };
                pending.push({ key: `scan/${pad(frame.index)}`, value: record });
                if (pending.length >= 24)
                    await this.store.putMany(pending.splice(0));
                this.project.frames = frame.index + 1;
                previous = g;
                previousImage = frame.image;
                previousFeatures = features;
                lastField = field;
                if (features.length < 8 && frame.index === 0)
                    await this.diagnostics.emit({ code: 'LOW_TEXTURE_UNOBSERVABLE', severity: 'warning', time: frame.time, frame: frame.index, message: '画面缺乏可辨认纹理。完全相同的空白帧既可能是暂停，也可能是在空白区域移动；像素本身无法区分。', action: '增加有区分度的可见内容或录制更多重叠。零位移只是 best guess。' });
                if (field.unknown)
                    await this.diagnostics.emit({ code: 'UNRESOLVED_MOTION', severity: 'warning', time: frame.time, frame: frame.index, message: '这一观察缺少可靠的视觉对齐依据。定位阶段将尝试历史重定位；仍无法定位时保留独立片段。', confidence: 0 });
                if (field.motions[0]?.ambiguous && field.motions[0].support >= 6)
                    await this.diagnostics.emit({ code: 'AMBIGUOUS_PATTERN', severity: 'warning', time: frame.time, frame: frame.index, message: '检测到具有多种合理匹配的重复纹理；连续性只是定位先验，不是已证实的唯一位置。' });
                if (frame.duration > .12)
                    await this.diagnostics.emit({ code: 'TEMPORAL_UNDERSAMPLING', severity: 'info', time: frame.time, frame: frame.index, message: '此帧持续时间较长；高速移动期间可能存在从未被采集到的区域。' });
                await this.report(frame.index + 1, frame.time, '逐帧提取几何证据，学习独立运动区域。');
                if (this.stopRequested) {
                    this.partial = true;
                    this.stopRequested = false;
                    break;
                }
            }
        }
        catch (error) {
            if (!this.project.frames)
                throw error;
            this.partial = true;
            await this.diagnostics.emit({ code: 'DECODE_PREFIX_ONLY', severity: 'error', message: String(error), action: `仅对已经解码的前 ${this.project.frames} 帧继续定位和合成。` });
        }
        if (pending.length)
            await this.store.putMany(pending.splice(0));
        for (const notice of this.source.info.notices || [])
            await this.diagnostics.emit({ code: notice.code, severity: 'warning', message: notice.message, count: notice.count, detail: { count: notice.count } });
        this.regions = learner?.finish(this.source.info.width, this.source.info.height, this.project.settings.regions) || [];
        this.atlas = new RegionAtlas(this.regions, this.source.info.width, this.source.info.height);
        this.project.regions = this.regions.map(({ mask: _mask, ...r }) => r);
        await this.store.put('regions', this.regions);
        if (this.regions.some(r => r.unassigned))
            await this.diagnostics.emit({ code: 'MANUAL_UNASSIGNED', severity: 'warning', message: '手动区域未覆盖的部分被保留为独立的低置信屏幕坐标观察层，没有宣称这些像素已恢复到页面坐标。' });
        if (this.regions.some(r => r.kind === 'ignore'))
            await this.diagnostics.emit({ code: 'EXPLICITLY_EXCLUDED_REGION', severity: 'warning', message: '按手动设置排除了“忽略”区域。该区域不会贡献到重建结果，这不是自动丢帧。' });
        if (this.project.settings.regions.length)
            await this.diagnostics.emit({ code: 'MANUAL_REGION_PRIORITY', severity: 'info', message: '手动区域重叠时，后绘制区域优先；忽略区域始终排除。其余像素保留在未指定观察层。' });
        const moving = this.regions.filter(r => r.kind === 'moving').length, fixed = this.regions.filter(r => r.kind === 'fixed').length;
        if (!this.project.settings.regions.length)
            await this.diagnostics.emit({ code: 'AUTOMATIC_LAYER_MASK', severity: 'info', message: `自动划分出 ${moving} 个内容区域和 ${fixed} 个固定界面区域。边界来自像素运动统计，而不是 DOM。`, action: '若遮罩归属不合理，可在“区域”里画出精确滚动区后重新处理。' });
        if (moving > 1)
            await this.diagnostics.emit({ code: 'MULTIPLE_SCROLL_LAYERS', severity: 'info', message: '多个独立滚动区将分别建立画布，不强制共享一个 scroll offset。' });
        await this.diagnostics.flush();
        await this.persist();
    }
    private async newCanvas(state: State, time: number): Promise<void> {
        state.canvasId = `${state.region.id}-part-${state.fragment}`;
        const meta: CanvasMeta = { id: state.canvasId, layer: state.region.id, name: state.region.name + (state.fragment ? ` · 未定位片段 ${state.fragment}` : ''), kind: state.region.kind, bounds: { x: 0, y: 0, width: 0, height: 0 }, tileCount: 0, observedPixels: 0, uncertainPixels: 0, conflictPixels: 0, maxLevel: 0, fragment: state.fragment, firstTime: time, lastTime: time };
        await this.store.put(`canvas/${meta.id}`, meta);
        this.project.canvasCount++;
    }
    private async solve(): Promise<void> {
        this.phase = 'solving';
        this.project.status = 'solving';
        await this.persist();
        const graph = new PoseGraph(this.store), index = new KeyframeIndex(this.store, async (message) => this.diagnostics.emit({ code: 'RELOCALIZATION_BUDGET', severity: 'warning', message }));
        const atlas = this.atlas!, f = this.factor, radius = this.refineRadius, attachments = new Map<string, Attachment>();
        const states: State[] = this.regions.filter(r => r.kind !== 'ignore').map(region => ({ region, code: atlas.code(region), canvasId: '', fragment: 0, pose: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, blind: false, weak: false, started: false }));
        let previous: RGBA | undefined, previousGray: Gray | undefined, previousFeaturesAll: Feature[] | undefined, previousPlan: FramePlan | undefined, solved = 0;
        const pending: { key: string; value: FramePlan }[] = [];
        const resolveTarget = (id: string): string => {
            const seen = new Set<string>();
            while (attachments.has(id) && !seen.has(id)) {
                seen.add(id);
                id = attachments.get(id)!.target;
            }
            return id;
        };
        for await (const frame of this.source.frames()) {
            await this.checkpoint();
            const scan = await this.store.get<ScanRecord>(`scan/${pad(frame.index)}`);
            if (!scan)
                break;
            if (scan.duplicate && previousPlan && states.every(s => !s.blind)) {
                const plan: FramePlan = { index: frame.index, time: frame.time, duplicate: true,
                    placements: previousPlan.placements.map(p => ({ ...p, time: frame.time })) };
                pending.push({ key: `plan/${pad(frame.index)}`, value: plan });
                if (pending.length >= 24) await this.store.putMany(pending.splice(0));
                previousPlan = plan;
                for (const s of states) s.velocity = { x: 0, y: 0 };
                solved = frame.index + 1;
                await this.report(solved, frame.time, '完全相同的观察复用定位；保留源帧与时间记录。', solved / this.project.frames);
                if (solved >= this.project.frames) break;
                if (this.stopRequested) { this.partial = true; this.stopRequested = false; break; }
                continue;
            }
            const image = frame.image, g = scan.duplicate && previousGray ? previousGray : await this.gray(image);
            const features = scan.features || (scan.duplicate ? previousFeaturesAll : undefined) || extractFeatures(g);
            const native = grayscale(image.data, image.width, image.height);
            const placements: Placement[] = [];
            for (const state of states) {
                const r = state.region, code = state.code, roi = { x: r.rect.x / f, y: r.rect.y / f, width: r.rect.width / f, height: r.rect.height / f };
                const mask = (x: number, y: number) => atlas.contains(code, x, y);
                const ownFeatures = features.filter(p => regionContains(r, p.x * f, p.y * f, image.width, image.height));
                const textured = ownFeatures.length >= 8, zoomChange = Math.abs(scan.field.zoom - 1) > .04;
                let confidence = r.unassigned ? .2 : 1, uncertain = !!r.unassigned, relocalized = false, skip = false, ambiguous = false, lost = false;
                let decision: Decision = 'tracked', delta: Point = { x: 0, y: 0 }, viaAnchor: NativeRefinement | undefined, weakStep = false, stepError = Infinity;
                if (r.kind === 'moving' && !state.started) {
                    // No canvas origin exists until a textured observation defines one; blank leading frames are counted, not placed.
                    if (!textured) {
                        decision = 'blind';
                    }
                    else {
                        state.started = true;
                        state.canvasId = '';
                        await this.newCanvas(state, frame.time);
                    }
                }
                else if (r.kind !== 'moving') {
                    if (frame.index === 0)
                        await this.newCanvas(state, frame.time);
                }
                else if (!textured)
                    decision = 'blind';
                else if (state.blind || zoomChange || !previous || !previousGray)
                    decision = 'lost';
                else {
                    // 1. Frame-to-frame odometry: analysis-scale hypotheses, block-aware audit, then a native-pixel decision.
                    const matches = matchFeatures(state.previousFeatures || [], ownFeatures), models = translationHypotheses(matches, 16).filter(m => m.support >= 4);
                    // Period-aliased hypotheses on repeated content audit equally well; the constant-velocity prior orders them before the
                    // native decision so the true small step is never dropped in favour of a one-row-off alias with more (arbitrary) matches.
                    const prior = (m: Point) => .02 * Math.hypot(m.x * f - state.velocity.x, m.y * f - state.velocity.y);
                    const scored = models.map(m => ({ m, audit: auditTranslation(previousGray!, g, m.x, m.y, roi, f > 1) }))
                        .filter(v => v.audit.overlap > .10 && Number.isFinite(v.audit.error) && ((v.audit.error < 14 && v.audit.mismatch < .2) || (v.audit.agreement >= .4 && v.audit.agreeing >= 3 && v.audit.agreeingError < 8)))
                        .sort((a, b) => Math.min(a.audit.error, a.audit.agreeingError) + prior(a.m) - Math.min(b.audit.error, b.audit.agreeingError) - prior(b.m));
                    const refined = scored.slice(0, 6).map(v => {
                        const n = refineNative(previous!, image, { x: v.m.x * f, y: v.m.y * f }, r.rect, mask, radius);
                        return { ...v, n, key: n.error + .02 * Math.hypot(n.x - state.velocity.x, n.y - state.velocity.y) };
                    }).filter(v => Number.isFinite(v.n.error)).sort((a, b) => a.key - b.key);
                    const best = refined[0];
                    if (best && best.n.error < 14) {
                        decision = 'tracked';
                        delta = { x: best.n.x, y: best.n.y };
                        const rival = refined.find(v => v !== best && Math.hypot(v.n.x - best.n.x, v.n.y - best.n.y) > 2 && v.n.error < best.n.error + 2);
                        ambiguous = !!rival || (best.m.ambiguous && refined.length > 1);
                        // A fast jump leaves a thin strip of shared content. Periodic layouts align just as well one period
                        // away, so such a step is a best guess to be re-examined by revisit evidence, not a settled fact.
                        weakStep = best.audit.overlap < .25;
                        confidence = Math.max(.05, best.m.confidence) * Math.exp(-best.n.error / 20) * (ambiguous ? .6 : 1) * (weakStep ? .5 : 1);
                        stepError = best.n.error;
                        if (best.audit.agreement < .85 && best.audit.blocks >= 4)
                            await this.diagnostics.emit({ code: 'PARTIAL_CONTENT_CHANGE', severity: 'info', time: frame.time, frame: frame.index, canvasId: state.canvasId, message: `约 ${Math.round((1 - best.audit.agreement) * 100)}% 的纹理区块与整体位移不一致（动画、视频、懒加载或重排）；位移由一致区块决定，冲突区域在合成时单独处理。` });
                    }
                    else {
                        let difference = 0, samples = 0;
                        for (let y = Math.ceil(roi.y); y < roi.y + roi.height; y += 7)
                            for (let x = Math.ceil(roi.x); x < roi.x + roi.width; x += 7) {
                                if (!regionContains(r, x * f, y * f, image.width, image.height))
                                    continue;
                                difference += Math.abs(previousGray!.data[y * g.width + x] - g.data[y * g.width + x]);
                                samples++;
                            }
                        decision = difference / Math.max(1, samples) > 5 ? 'lost' : 'static';
                    }
                }
                // 2. Re-acquire the anchor on native patches after blind frames or a failed odometry step (short blank gaps with overlap).
                if (decision === 'lost' && state.anchor && !zoomChange && r.kind === 'moving') {
                    const matches = matchFeatures(state.anchor.features, ownFeatures), models = translationHypotheses(matches, 8).filter(m => m.support >= 6);
                    const options = models.slice(0, 4).map(m => ({ m, n: refinePatches(state.anchor!.patches, native, r.rect, { x: m.x * f, y: m.y * f }, radius) })).filter(v => v.n.error < 12).sort((a, b) => a.n.error - b.n.error);
                    const top = options[0];
                    if (top && !options.some(v => v !== top && Math.hypot(v.n.x - top.n.x, v.n.y - top.n.y) > 2 && v.n.error < top.n.error + 2)) {
                        decision = 'tracked';
                        viaAnchor = top.n;
                        ambiguous = top.m.ambiguous;
                        confidence = Math.max(.05, top.m.confidence) * Math.exp(-top.n.error / 20) * (ambiguous ? .6 : 1);
                    }
                }
                // 3. Apply the decision.
                if (r.kind === 'moving') {
                    if (decision === 'tracked') {
                        if (viaAnchor) {
                            state.pose = { x: state.anchor!.x + viaAnchor.x, y: state.anchor!.y + viaAnchor.y };
                            state.velocity = { x: 0, y: 0 };
                        }
                        else if (frame.index > 0 && previous) {
                            state.pose = { x: state.pose.x + delta.x, y: state.pose.y + delta.y };
                            state.velocity = delta;
                            // Drift control: re-measure the pose against the anchor keyframe's native patches whenever they are still in view.
                            if (state.anchor && scan.field.difference >= .12) {
                                const expected = { x: state.pose.x - state.anchor.x, y: state.pose.y - state.anchor.y };
                                const n = refinePatches(state.anchor.patches, native, r.rect, expected, radius);
                                if (n.error < 12 && n.runnerUp > n.error + 1.5) {
                                    state.pose = { x: state.anchor.x + n.x, y: state.anchor.y + n.y };
                                    confidence = Math.max(confidence, .96 * Math.exp(-n.error / 20));
                                }
                            }
                        }
                        uncertain = confidence < .60 || ambiguous || weakStep;
                        if (weakStep)
                            await this.diagnostics.emit({ code: 'THIN_OVERLAP_STEP', severity: 'warning', time: frame.time, frame: frame.index, canvasId: state.canvasId, confidence, message: '两帧之间移动很快，只剩很小的重叠可供对齐。位移取自这一小块证据；在周期性排版中，相邻周期同样能解释这些像素。', action: '若之后的回访给出更强的证据，这段轨迹会被整体改正并记录。' });
                        if (uncertain)
                            await this.diagnostics.emit({ code: 'LOW_CONFIDENCE_PLACEMENT', severity: 'warning', time: frame.time, frame: frame.index, canvasId: state.canvasId, confidence, region: { x: state.pose.x + r.rect.x, y: state.pose.y + r.rect.y, width: r.rect.width, height: r.rect.height }, message: ambiguous ? '重复纹理使多个位移都能解释像素；采用与运动连续性最一致的解，这是 best guess 而非唯一正确对齐。' : '这一区域采用了低置信度的位置推断；相关像素会在质量遮罩中标记。', action: '连续轨迹和已有锚点用于 best guess，不代表唯一正确对齐。' });
                    }
                    else if (decision === 'static') {
                        state.velocity = { x: 0, y: 0 };
                        confidence = .3;
                        uncertain = true;
                        await this.diagnostics.emit({ code: 'LOW_CONFIDENCE_PLACEMENT', severity: 'warning', time: frame.time, frame: frame.index, canvasId: state.canvasId, confidence, message: '两帧几乎相同但缺少可验证的特征对应；按暂停（零位移）处理，这是 best guess。' });
                    }
                    else if (decision === 'blind') {
                        skip = true;
                        confidence = 0;
                        uncertain = true;
                        state.velocity = { x: 0, y: 0 };
                        await this.diagnostics.emit({ code: 'UNOBSERVABLE_FRAME', severity: 'warning', time: frame.time, frame: frame.index, canvasId: state.canvasId || undefined, message: '这一帧在该区域没有可辨认纹理：空白帧既可能是暂停，也可能是在空白区域移动，像素本身无法区分。它不会被画到任何位置。', action: '若空白之后的内容无法与之前的观察重叠，将保留为独立片段，而不是猜测中间距离。' });
                    }
                    else {
                        lost = true;
                        const match = await index.find({ features: ownFeatures, gray: g, native, layer: r.id, frame: frame.index, roi, region: r.rect, factor: f, radius, exclude: state.anchor?.id });
                        if (match && !match.ambiguous && match.confidence > .6 && !zoomChange) {
                            state.canvasId = resolveTarget(match.keyframe.canvasId);
                            const shift = this.attachmentShift(attachments, match.keyframe.canvasId);
                            state.pose = { x: match.keyframe.x + match.offset.x + shift.x, y: match.keyframe.y + match.offset.y + shift.y };
                            state.lastNode = undefined;
                            state.anchor = match.keyframe;
                            state.velocity = { x: 0, y: 0 };
                            confidence = match.confidence;
                            relocalized = true;
                            await this.diagnostics.emit({ code: 'RELOCALIZED', severity: 'info', canvasId: state.canvasId, time: frame.time, frame: frame.index, confidence, detail: { anchorFrame: match.keyframe.frame, support: match.support, unique: match.unique, error: match.error, offset: match.offset }, message: '通过历史视觉锚点重新定位到已观察画布，未把回访内容追加成长图。' });
                        }
                        else {
                            // Name the cause: a magnification change is a different pixel grid, not a lost trajectory.
                            const scale = zoomChange ? { scale: scan.field.zoom, error: 0 } : previousGray && !state.blind ? probeScale(previousGray, g, ownFeatures) : undefined;
                            state.fragment++;
                            state.pose = { x: 0, y: 0 };
                            state.lastNode = undefined;
                            state.anchor = undefined;
                            state.velocity = { x: 0, y: 0 };
                            await this.newCanvas(state, frame.time);
                            confidence = .20;
                            uncertain = true;
                            await this.diagnostics.emit({ code: scale ? 'SCALE_CHANGE_FRAGMENT' : 'UNPLACED_FRAGMENT', severity: 'warning', canvasId: state.canvasId, time: frame.time, frame: frame.index, confidence, detail: scale,
                                message: scale ? `检测到约 ${scale.scale.toFixed(2)}× 的比例/布局变换，已按原像素保留独立片段；没有偷偷缩放混合。` : '无法确认与原画布的相对位置，已保留独立可导出片段。两个片段之间可能重叠，也可能存在真实缺口。', action: '跨片段关系尚未证实；后续回访若能可靠匹配，片段会被整体接回。重新录制时增加重叠，或用区域设置隔离变化组件。' });
                        }
                    }
                }
                if (!Number.isFinite(state.pose.x) || !Number.isFinite(state.pose.y)) {
                    await this.diagnostics.emit({ code: 'NONFINITE_POSE', severity: 'error', time: frame.time, frame: frame.index, message: '定位计算产生无效数值。已隔离此观察，未将无效坐标写入画布。' });
                    state.fragment++;
                    state.pose = { x: 0, y: 0 };
                    state.lastNode = undefined;
                    state.anchor = undefined;
                    confidence = 0;
                    uncertain = true;
                    await this.newCanvas(state, frame.time);
                }
                if (!skip) {
                    const anchorDistance = state.anchor ? Math.hypot(state.pose.x - state.anchor.x, state.pose.y - state.anchor.y) : Infinity;
                    const needsKey = !state.lastNode || r.kind === 'moving' && (anchorDistance > Math.max(48, Math.min(r.rect.width, r.rect.height) * .30) || (frame.index - state.lastNode.frame > 90 && scan.field.difference > .2));
                    if (needsKey) {
                        const oldAnchor = state.anchor;
                        let attachedFrom: string | undefined, attachMatch: Awaited<ReturnType<KeyframeIndex['find']>> | undefined;
                        // Revisit search at every keyframe: same canvas → loop closure; another canvas → this fragment is tied back rigidly.
                        const global = !lost && !skip && r.kind === 'moving' && frame.index > 3 ? await index.find({ features: ownFeatures, gray: g, native, layer: r.id, frame: frame.index, roi, region: r.rect, factor: f, radius, exclude: oldAnchor?.id }) : undefined;
                        if (global && resolveTarget(global.keyframe.canvasId) !== state.canvasId && !global.ambiguous && global.confidence > .72) {
                            const target = resolveTarget(global.keyframe.canvasId), shift = this.attachmentShift(attachments, global.keyframe.canvasId);
                            const targetPose = { x: global.keyframe.x + global.offset.x + shift.x, y: global.keyframe.y + global.offset.y + shift.y };
                            const attachment: Attachment = { id: state.canvasId, target, dx: targetPose.x - state.pose.x, dy: targetPose.y - state.pose.y, frame: frame.index, confidence: global.confidence };
                            attachments.set(state.canvasId, attachment);
                            await this.store.put(`attach/${state.canvasId}`, attachment);
                            const meta = await this.store.get<CanvasMeta>(`canvas/${state.canvasId}`);
                            if (meta) {
                                meta.attachedTo = target;
                                await this.store.put(`canvas/${state.canvasId}`, meta);
                            }
                            await this.diagnostics.emit({ code: 'FRAGMENT_ATTACHED', severity: 'info', canvasId: target, time: frame.time, frame: frame.index, confidence: global.confidence, detail: attachment, message: '回访证据把一个独立片段整体接回了已有画布；片段内的相对轨迹保持不变。' });
                            attachedFrom = state.canvasId;
                            attachMatch = global;
                            state.canvasId = target;
                            state.pose = targetPose;
                            state.lastNode = undefined;
                            state.velocity = { x: 0, y: 0 };
                        }
                        // Decide a thin-overlap correction before the node exists, so the odometry edge records the corrected
                        // geometry and a weight that matches how little evidence the step actually had.
                        let corrected: Point | undefined, odometryWeight = weakStep ? .05 : 1;
                        if (global && !attachedFrom && resolveTarget(global.keyframe.canvasId) === state.canvasId && (weakStep || state.weak) && !global.ambiguous && global.confidence > .72 && global.error < 8) {
                            const target = { x: global.keyframe.x + global.offset.x, y: global.keyframe.y + global.offset.y };
                            const discrepancy = Math.hypot(target.x - state.pose.x, target.y - state.pose.y);
                            if (discrepancy >= 16) {
                                corrected = target;
                                odometryWeight = .05;
                                await this.diagnostics.emit({ code: 'TRAJECTORY_CORRECTED', severity: 'warning', time: frame.time, frame: frame.index, canvasId: state.canvasId, confidence: global.confidence, detail: { discrepancy, from: { x: state.pose.x, y: state.pose.y }, to: target, revisitError: global.error, stepError, weakStep },
                                    message: `上一步只有很小的重叠，本帧与已观察内容的匹配相差 ${discrepancy.toFixed(1)}px 且证据更强；已按这一匹配改正当前位置。`, action: '被改正的是本帧及之后的轨迹；此前写入的像素保持原样，可能与改正后的坐标存在接缝。' });
                                state.pose = target;
                                state.weak = false;
                            }
                        }
                        const node = await graph.add(state.canvasId, frame.index, state.pose, state.lastNode, odometryWeight);
                        if (corrected)
                            await graph.connect(global!.keyframe.node, node.id, global!.offset.x, global!.offset.y, 6, 'loop');
                        if ((relocalized && oldAnchor) || attachedFrom) {
                            node.pinned = false;
                            await this.store.put(`node/${node.id}`, node);
                            const link = attachMatch ? attachMatch.keyframe : oldAnchor!;
                            const shift = this.attachmentShift(attachments, link.canvasId);
                            await graph.connect(link.node, node.id, state.pose.x - link.x - shift.x, state.pose.y - link.y - shift.y, 5, 'loop');
                        }
                        else if (global && global.keyframe.canvasId === state.canvasId) {
                            const discrepancy = Math.hypot(global.keyframe.x + global.offset.x - state.pose.x, global.keyframe.y + global.offset.y - state.pose.y);
                            if (!global.ambiguous && global.confidence > .72 && discrepancy < 16) {
                                await graph.connect(global.keyframe.node, node.id, global.offset.x, global.offset.y, 4, 'loop');
                                await this.diagnostics.emit({ code: 'LOOP_CLOSURE', severity: 'info', canvasId: state.canvasId, time: frame.time, frame: frame.index, confidence: global.confidence, message: '发现可靠的历史重访，已加入全局位置约束；最终合成使用校正后的轨迹。' });
                            }
                            else if (discrepancy >= 16)
                                await this.diagnostics.emit({ code: 'INCONSISTENT_LOOP_REJECTED', severity: 'warning', time: frame.time, frame: frame.index, canvasId: state.canvasId, message: `历史匹配与连续轨迹相差 ${discrepancy.toFixed(1)}px；证据冲突，未强加为回环。`, confidence: global.confidence });
                            else if (global.ambiguous)
                                await this.diagnostics.emit({ code: 'AMBIGUOUS_LOOP', severity: 'warning', time: frame.time, frame: frame.index, canvasId: state.canvasId, message: '历史检索有多个接近的合理位置；没有把不确定回环当作硬约束。' });
                        }
                        state.lastNode = (await graph.get(node.id))!;
                        const k: Keyframe = { id: `${r.id}/${pad(frame.index)}`, node: node.id, canvasId: state.canvasId, layer: r.id, frame: frame.index, features: ownFeatures, gray: g, x: state.pose.x, y: state.pose.y, scaleX: f, scaleY: f, patches: r.kind === 'moving' ? extractPatches(native, r.rect, ownFeatures.map(p => ({ x: p.x - roi.x, y: p.y - roi.y })), f) : [] };
                        state.anchor = k;
                        if (r.kind === 'moving')
                            await index.add(k);
                    }
                }
                const occlusions = previous && r.kind === 'moving' && (decision === 'tracked' || decision === 'static') ? stickyOcclusions(previous, image, r, delta, previousPlan?.placements.find(p => p.layer === r.id && p.canvasId === state.canvasId)?.occlusions) : [];
                if (occlusions.length) await this.diagnostics.emit({ code: 'STICKY_OCCLUSION', severity: 'info', frame: frame.index, time: frame.time, canvasId: state.canvasId, region: occlusions[0], message: '顶端纹理支持屏幕固定而非页面位移；本次观察的固定遮挡不写入移动画布。原始参考界面保留在外框呈现中。' });
                placements.push({ layer: r.id, canvasId: state.canvasId, node: state.lastNode?.id || '', x: state.pose.x, y: state.pose.y, confidence, uncertain, time: frame.time, ...(skip ? { skip: true } : {}), ...(occlusions.length ? { occlusions } : {}) });
                if (r.kind === 'moving') {
                    state.blind = !textured;
                    state.weak = decision === 'tracked' ? weakStep : false;
                }
                state.previousFeatures = ownFeatures;
            }
            previousPlan = { index: frame.index, time: frame.time, placements, duplicate: scan.duplicate };
            pending.push({ key: `plan/${pad(frame.index)}`, value: previousPlan });
            previousFeaturesAll = features;
            if (pending.length >= 24)
                await this.store.putMany(pending.splice(0));
            previous = image;
            previousGray = g;
            solved = frame.index + 1;
            await this.report(solved, frame.time, '原像素精修、历史重定位与二维回环约束。', solved / this.project.frames);
            if (solved >= this.project.frames)
                break;
            if (this.stopRequested) {
                this.partial = true;
                this.stopRequested = false;
                break;
            }
        }
        if (pending.length)
            await this.store.putMany(pending.splice(0));
        this.processed = solved;
        this.events.progress({ phase: 'optimizing', fraction: 0, frames: solved, time: 0, message: '优化磁盘中的位置图，校正回环漂移。' });
        const result = await graph.optimize(async () => this.checkpoint());
        if (result.residual > 1)
            await this.diagnostics.emit({ code: 'GRAPH_RESIDUAL', severity: 'warning', message: `位置图最大残差仍有 ${result.residual.toFixed(2)} 原像素；相关接缝可能存在几何不一致。`, detail: result, action: '检查回环附近的文字与重复纹理。该残差没有被隐藏。' });
        await this.store.put('graph-summary', { loops: graph.loops, ...result });
        await this.diagnostics.flush();
        await this.persist();
    }
    /** Total rigid shift from a canvas through its attachment chain to the canvas it finally resolves to. */
    private attachmentShift(attachments: Map<string, Attachment>, id: string): Point {
        const shift = { x: 0, y: 0 }, seen = new Set<string>();
        while (attachments.has(id) && !seen.has(id)) {
            seen.add(id);
            const a = attachments.get(id)!;
            shift.x += a.dx;
            shift.y += a.dy;
            id = a.target;
        }
        return shift;
    }
    private async render(): Promise<void> {
        this.phase = 'rendering';
        this.project.status = 'rendering';
        await this.persist();
        const graph = new PoseGraph(this.store), compositor = new Compositor(this.store, this.tiles, this.project.settings.temporalPolicy, d => this.diagnostics.emit(d), this.atlas!);
        const regionMap = new Map(this.regions.map(r => [r.id, r])), attachments = new Map<string, Attachment>();
        for await (const { value } of iterate<Attachment>(this.store, 'attach/'))
            attachments.set(value.id, value);
        const fixedPixels = new Map<string, Uint32Array>(), previousPlacements = new Map<string, Placement>();
        const fixedBytes = this.regions.filter(r => r.kind === 'fixed').reduce((n, r) => n + Math.ceil(r.rect.width) * Math.ceil(r.rect.height) * 4, 0);
        this.tiles.configureBudget(this.project.settings.memoryMB, this.source.info.width * this.source.info.height * 5 + fixedBytes + 8 * 1024 * 1024);
        let lastFlush = performance.now();
        for await (const frame of this.source.frames()) {
            await this.checkpoint();
            const plan = await this.store.get<FramePlan>(`plan/${pad(frame.index)}`);
            if (!plan)
                break;
            const image = frame.image;
            let latest: CanvasMeta | undefined;
            const decisions = [];
            for (const placement of plan.placements) {
                if (placement.skip) {
                    decisions.push({ canvasId: placement.canvasId, placement, addedPixels: 0, conflictPixels: 0, uncertainPixels: 0, skipped: true });
                    continue;
                }
                const correction = await graph.correction(placement.node, frame.index), shift = this.attachmentShift(attachments, placement.canvasId);
                let canvasId = placement.canvasId;
                const seen = new Set<string>();
                while (attachments.has(canvasId) && !seen.has(canvasId)) {
                    seen.add(canvasId);
                    canvasId = attachments.get(canvasId)!.target;
                }
                const p = { ...placement, canvasId, x: placement.x + correction.x + shift.x, y: placement.y + correction.y + shift.y };
                const meta = await this.store.get<CanvasMeta>(`canvas/${p.canvasId}`);
                if (!meta)
                    throw new Error('Canvas metadata is missing.');
                const region = regionMap.get(p.layer)!;
                const last = previousPlacements.get(p.layer);
                let unchanged = !!plan.duplicate && !!last && last.canvasId === p.canvasId && last.x === p.x && last.y === p.y;
                if (region.kind === 'fixed' && !unchanged) {
                    const rect = region.rect, rw = Math.ceil(rect.width), rh = Math.ceil(rect.height), code = this.atlas!.code(region);
                    const old = fixedPixels.get(region.id), saved = old || new Uint32Array(rw * rh);
                    const src = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
                    unchanged = !!old;
                    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
                        const nx = Math.floor(rect.x) + x, ny = Math.floor(rect.y) + y;
                        if (!this.atlas!.contains(code, nx, ny)) continue;
                        const i = ny * image.width + nx, j = y * rw + x;
                        if (saved[j] !== src[i]) { saved[j] = src[i]; unchanged = false; }
                    }
                    fixedPixels.set(region.id, saved);
                }
                previousPlacements.set(p.layer, p);
                if (unchanged) {
                    this.skippedPaints++;
                    meta.lastTime = p.time;
                    await this.store.put(`canvas/${p.canvasId}`, meta);
                    latest = region.kind === 'moving' ? meta : latest;
                    decisions.push({ canvasId: p.canvasId, placement: p, addedPixels: 0, conflictPixels: 0, uncertainPixels: 0, reusedExactObservation: true });
                    continue;
                }
                const stats = await compositor.add(image, region, p, frame.index, meta);
                this.project.tiles += stats.tiles;
                this.project.observedPixels += stats.added;
                await this.store.put(`canvas/${p.canvasId}`, meta);
                latest = region.kind === 'moving' ? meta : latest;
                decisions.push({ canvasId: p.canvasId, placement: p, addedPixels: stats.added, conflictPixels: stats.conflicts, uncertainPixels: stats.uncertain });
            }
            // Every decoded observation has a durable placement and a pixel contribution ledger.
            await this.store.put(`observation/${pad(frame.index)}`, { frame: frame.index, time: frame.time, decisions });
            this.project.renderedFrames = frame.index + 1;
            if (performance.now() - lastFlush >= 1200) {
                lastFlush = performance.now();
                await this.tiles.flush();
                await this.diagnostics.flush();
            }
            await this.report(frame.index + 1, frame.time, '按观察证据合成原尺寸瓦片；缺口保持透明。', (frame.index + 1) / Math.max(1, this.processed), latest);
            if (frame.index + 1 >= this.processed)
                break;
            if (this.stopRequested) {
                this.partial = true;
                this.stopRequested = false;
                break;
            }
        }
        await this.tiles.flush();
        await this.diagnostics.flush();
        await this.store.put('memory-stats', { peakResidentTiles: this.tiles.peakResidentTiles, tileCacheLimit: this.tiles.maxTiles, budgetMB: this.project.settings.memoryMB, note: 'Codec/browser/GPU allocations are additional, not a hard process-RSS bound.' });
        await this.persist();
    }
}
