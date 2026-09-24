// Per-region odometry/tracking state and its two small constructors, shared by solve.ts's frame loop and
// region-step.ts's per-region shell.
import type { CanvasMeta, Feature, Point, Region } from '../../types.ts';
import type { PoseNode } from '../../core/pose-graph.ts';
import type { Keyframe } from '../../core/keyframes.ts';
import type { RunContext } from '../context.ts';
/** Per-region odometry/tracking state carried frame to frame through solve()'s loop. */
export interface RegionState {
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
export type Decision = 'tracked' | 'static' | 'blind' | 'lost';
/** The initial state solve() carries into its frame loop for one region, before any frame has been observed. */
export function initialState(region: Region, code: number): RegionState {
  return {
    region,
    code,
    canvasId: '',
    fragment: 0,
    pose: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    blind: false,
    weak: false,
    started: false,
  };
}
export async function newCanvas(ctx: RunContext, state: RegionState, time: number): Promise<void> {
  state.canvasId = `${state.region.id}-part-${state.fragment}`;
  const meta: CanvasMeta = {
    id: state.canvasId,
    layer: state.region.id,
    name: state.region.name + (state.fragment ? ` · 未定位片段 ${state.fragment}` : ''),
    kind: state.region.kind,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    tileCount: 0,
    observedPixels: 0,
    uncertainPixels: 0,
    conflictPixels: 0,
    provisionalPixels: 0,
    maxLevel: 0,
    fragment: state.fragment,
    firstTime: time,
    lastTime: time,
  };
  await ctx.store.put(`canvas/${meta.id}`, meta);
  ctx.project.canvasCount++;
}
