import type { Feature, Gray, Point, Rect, RGBA } from '../types.ts';
import type { KV } from '../storage/db.ts';
import type { Patch } from './motion.ts';
import { pad } from './math.ts';
import { core, type ResidentFrame, type ResidentGray } from './wasm.ts';
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
export class KeyframeIndex {
  private warnedLayers = new Set<string>();
  constructor(private db: KV, private warn: (message: string) => Promise<void>) {}
  private async warnOnce(layer: string): Promise<void> {
    if (this.warnedLayers.has(layer)) {
      return;
    }
    this.warnedLayers.add(layer);
    await this.warn(
      'A highly repetitive visual-word posting exceeded the 96-candidate retrieval budget. Relocalization is approximate here; all image observations remain in the reconstruction journal.',
    );
  }
  async add(k: Keyframe): Promise<void> {
    await this.db.put(`keyframe/${k.id}`, k);
    const words = core().featureWords(k.features.filter((_, i) => i % 2 === 0));
    // Immutable per-keyframe postings. Reading a frequent word never allocates its entire list.
    for (let i = 0; i < words.length; i += 128) {
      await this.db.putMany(words.slice(i, i + 128).map((word) => ({ key: `word/${k.layer}/${word}/${pad(k.frame)}`, value: k.id })));
    }
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
      } = q,
      minGap = q.minGap ?? 3;
    if (features.length < 8) {
      return;
    }
    const allWords = core().featureWords(features.filter((_, i) => i % 2 === 0)),
      words = allWords.filter((_, i) => i % Math.max(1, Math.floor(allWords.length / 48)) === 0).slice(0, 48),
      votes = new Map<string, number>();
    let truncated = false;
    for (const word of words) {
      const prefix = `word/${layer}/${word}/`, forward = await this.db.scan<string>(prefix, { limit: 97 });
      if (forward.length > 96) {
        truncated = true;
      }
      const seen = new Set<string>();
      // The whole posting can only ever be scanned in ascending frame order; on a long recording that starves recent
      // keyframes of ever becoming candidates. Take a spread — the earliest half and, when the list overruns the
      // forward budget, the latest half too — within the same total candidate budget.
      for (const { value: id } of forward.slice(0, 48)) {
        if (id === exclude) {
          continue;
        }
        seen.add(id);
        votes.set(id, (votes.get(id) || 0) + 1);
      }
      if (forward.length > 48) {
        const backward = await this.db.scan<string>(prefix, { limit: 48, reverse: true });
        for (const { value: id } of backward) {
          if (id === exclude || seen.has(id)) {
            continue;
          }
          seen.add(id);
          votes.set(id, (votes.get(id) || 0) + 1);
        }
      }
    }
    if (truncated) {
      await this.warnOnce(layer);
    }
    // Intentional TS, not an unported kernel: top-12 candidates by word-vote
    // count, each needing at least 3 votes, is inline glue over `votes` (a KV posting-list tally built above by
    // `this.db.scan`) — there is no buffer to hand Rust here until the KV reads finish, so this stays the
    // adapter's own bookkeeping, like `evaluateCandidates`'s scoring above.
    const candidateIds = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      keyframes: Keyframe[] = [];
    for (const [id, count] of candidateIds) {
      if (count < 3) {
        continue;
      }
      const k = await this.db.get<Keyframe>(`keyframe/${id}`);
      if (!k || Math.abs(k.frame - frame) < minGap) {
        continue;
      }
      keyframes.push(k);
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
