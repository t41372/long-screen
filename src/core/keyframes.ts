import type { Feature, Gray, Point, Rect, RGBA } from '../types.ts';
import type { KV } from '../storage/db.ts';
import type { Patch } from './motion.ts';
import { core, type KeyframeIndexState, type ResidentFrame, type ResidentGray } from './wasm.ts';
export interface Keyframe extends Point {
  id: string;
  node: string;
  canvasId: string;
  layer: string;
  frame: number;
  features: Feature[];
  gray: Gray;
  scaleX: number;
  scaleY: number;
  /** Native-resolution texture samples for pixel-exact revisit measurement. */
  patches: Patch[];
}
export interface Relocalization {
  keyframe: Keyframe;
  /** Native-pixel displacement: current pose = keyframe pose + offset. */
  offset: Point;
  confidence: number;
  ambiguous: boolean;
  support: number;
  unique: number;
  /** Native-pixel residual after patch refinement. */
  error: number;
  analysisError: number;
}
export interface RelocalizationQuery {
  features: Feature[];
  gray: Gray;
  /** Full-resolution luma of the query frame. When `current`/`nativePlane` below are given (the resident-plane
   * path), it is computed lazily, core-side, only if some candidate passes the analysis audit; otherwise (no
   * `current`, or a caller that hands a plain `Gray`/`ResidentGray` directly — e.g. tests) it is used eagerly,
   * before Rust even knows whether a candidate exists — the same trade-off `track.ts`'s `reacquire`/
   * `driftCorrection` already made for their own rare non-resident fallback. */
  native: Gray | ResidentGray | (() => Gray | ResidentGray);
  /** The current frame and the shared per-frame resident native-luma plane (`solve.ts`'s `nativePlane`), when the
   * caller has them — undefined for callers with no resident frame to offer (e.g. direct `find()` calls in tests),
   * in which case `native` above is always used eagerly, exactly as the pre-port `find()` did. `nativeFilled`/
   * `markNativeFilled` share `native()`'s own per-frame memo, so whichever caller fills the plane first (this call
   * or a later `native()` call) is the only fill this frame — same contract as `track.ts`'s `reacquire`/
   * `driftCorrection`. */
  current?: RGBA | ResidentFrame;
  nativePlane?: ResidentGray;
  nativeFilled?: boolean;
  markNativeFilled?: () => void;
  layer: string;
  frame: number;
  roi: Rect;
  region: Rect;
  factor: number;
  radius: number;
  exclude?: string;
  /** Frames closer than this are ordinary odometry, not revisits. */
  minGap?: number;
  /** Maps a keyframe's raw canvasId onto the canvas/offset it is actually observed at, so a fragment and its attachment
   * target are recognised as the same physical place instead of scoring each other as rivals. */
  canonical?: (canvasId: string) => { canvasId: string; dx: number; dy: number };
}
/** Candidate evaluation core of find(): hypothesis matching, analysis audit, native-patch refinement, the
 * confidence formula and the score/sort/strong-best/rival-ambiguity selection all run in one Rust call
 * (`core().keyframesEvaluateCandidates`) — this function is now I/O and marshalling glue: intern each
 * candidate's already-resolved canonical canvas (`canonical`, a precomputed map from the candidate canvasIds
 * the async half already touched, built once per query) into a per-keyframe index, and translate Rust's chosen
 * candidate back into a `Relocalization`. */
export function evaluateCandidates(
  keyframes: Keyframe[],
  q: {
    features: Feature[];
    gray: Gray;
    native: Gray | ResidentGray | (() => Gray | ResidentGray);
    current?: RGBA | ResidentFrame;
    nativePlane?: ResidentGray;
    nativeFilled?: boolean;
    markNativeFilled?: () => void;
    roi: Rect;
    region: Rect;
    factor: number;
    radius: number;
  },
  canonical: Map<string, { canvasId: string; dx: number; dy: number }>,
): Relocalization | undefined {
  if (keyframes.length === 0) {
    return undefined;
  }
  const { features, gray, native, roi, region, factor, radius, current, nativePlane, nativeFilled, markNativeFilled } = q;
  // A keyframe's resolved canvas (its own canvasId, or the canonical target it attaches onto) must intern to the
  // SAME index for every keyframe that resolves to it, so Rust's rival check (comparing indices) matches the
  // original `position().canvas !== bp.canvas` string comparison exactly.
  const canvasIndex = new Map<string, number>();
  const internCanvas = (id: string): number => {
    let idx = canvasIndex.get(id);
    if (idx === undefined) {
      idx = canvasIndex.size;
      canvasIndex.set(id, idx);
    }
    return idx;
  };
  const { result, filledNative } = core().keyframesEvaluateCandidates(
    keyframes.map((k) => {
      const resolved = canonical.get(k.canvasId);
      return {
        features: k.features,
        gray: k.gray,
        patches: k.patches,
        x: k.x,
        y: k.y,
        canonicalIdx: internCanvas(resolved ? resolved.canvasId : k.canvasId),
        dx: resolved?.dx ?? 0,
        dy: resolved?.dy ?? 0,
      };
    }),
    {
      features,
      gray,
      roi,
      region,
      factor,
      radius,
      current,
      nativePlane,
      nativeFilled: nativeFilled ?? false,
      native: typeof native === 'function' ? native : () => native,
    },
  );
  if (filledNative) {
    markNativeFilled?.();
  }
  if (!result) {
    return undefined;
  }
  return {
    keyframe: keyframes[result.keyframeIndex],
    offset: { x: result.x, y: result.y },
    confidence: result.confidence,
    ambiguous: result.ambiguous,
    support: result.support,
    unique: result.unique,
    error: result.error,
    analysisError: result.analysisError,
  };
}
/** The text of the `RELOCALIZATION_BUDGET` warning, as the page has always stored it. It is not in the message
 *  catalogue (an English sentence in the zh journal); kept byte for byte so stored diagnostics do not change. */
const BUDGET_MESSAGE =
  'A highly repetitive visual-word posting exceeded the 96-candidate retrieval budget. Relocalization is approximate here; all image observations remain in the reconstruction journal.';
/** Host for the keyframe index state object (`rust/engine/src/keyframes.rs`): word postings live in core memory,
 *  keyframes in the store (`keyframe/<id>`). A search asks the engine for candidate ids, loads those rows, keeps the
 *  ones the engine admits, and scores them with the core's candidate evaluation. */
export class KeyframeIndex {
  private readonly state: KeyframeIndexState;
  constructor(private db: KV, private warn: (message: string) => Promise<void>) {
    this.state = core().keyframeIndex();
  }
  async add(k: Keyframe): Promise<void> {
    await this.db.put(`keyframe/${k.id}`, k);
    this.state.add(k.id, k.layer, k.frame, k.features);
  }
  /** Finds where the current observation sits relative to earlier keyframes. Returns nothing rather than guessing when several places fit. */
  async find(q: RelocalizationQuery): Promise<Relocalization | undefined> {
    const {
      features,
      gray,
      native,
      current,
      nativePlane,
      nativeFilled,
      markNativeFilled,
      layer,
      frame,
      roi,
      region,
      factor,
      radius,
      exclude,
    } = q;
    const { candidates, budgetWarning } = this.state.retrieve(layer, frame, features, exclude, q.minGap);
    if (budgetWarning) {
      await this.warn(BUDGET_MESSAGE);
    }
    const keyframes: Keyframe[] = [];
    for (const id of candidates) {
      const k = await this.db.get<Keyframe>(`keyframe/${id}`);
      if (k && this.state.admits(k.frame)) {
        keyframes.push(k);
      }
    }
    // canonical() is a pure function of canvasId; memoize it once per candidate canvas instead of calling it
    // repeatedly from evaluateCandidates' position() closure.
    const canonical = new Map<string, { canvasId: string; dx: number; dy: number }>();
    if (q.canonical) {
      for (const k of keyframes) {
        if (!canonical.has(k.canvasId)) {
          canonical.set(k.canvasId, q.canonical(k.canvasId));
        }
      }
    }
    return evaluateCandidates(
      keyframes,
      { features, gray, native, current, nativePlane, nativeFilled, markNativeFilled, roi, region, factor, radius },
      canonical,
    );
  }
}
