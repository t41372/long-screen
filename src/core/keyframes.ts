import type { Feature, Gray, Point, Rect } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { featureWords, matchFeatures } from './features.ts';
import { auditTranslation, type Patch, refinePatches, translationHypotheses } from './motion.ts';
import { pad } from './math.ts';
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
  native: Gray;
  layer: string;
  frame: number;
  roi: Rect;
  region: Rect;
  factor: number;
  radius: number;
  exclude?: string;
  /** Frames closer than this are ordinary odometry, not revisits. */
  minGap?: number;
}
export class KeyframeIndex {
  constructor(private db: KV, private warn: (message: string) => Promise<void>) {}
  async add(k: Keyframe): Promise<void> {
    await this.db.put(`keyframe/${k.id}`, k);
    const words = featureWords(k.features.filter((_, i) => i % 2 === 0));
    // Immutable per-keyframe postings. Reading a frequent word never allocates its entire list.
    for (let i = 0; i < words.length; i += 128) {
      await this.db.putMany(words.slice(i, i + 128).map((word) => ({ key: `word/${k.layer}/${word}/${pad(k.frame)}`, value: k.id })));
    }
  }
  /** Finds where the current observation sits relative to earlier keyframes. Returns nothing rather than guessing when several places fit. */
  async find(q: RelocalizationQuery): Promise<Relocalization | undefined> {
    const { features, gray, native, layer, frame, roi, region, factor, radius, exclude } = q, minGap = q.minGap ?? 3;
    if (features.length < 8) {
      return;
    }
    const allWords = featureWords(features.filter((_, i) => i % 2 === 0)),
      words = allWords.filter((_, i) => i % Math.max(1, Math.floor(allWords.length / 48)) === 0).slice(0, 48),
      votes = new Map<string, number>();
    let truncated = false;
    for (const word of words) {
      const rows = await this.db.scan<string>(`word/${layer}/${word}/`, { limit: 97 });
      if (rows.length > 96) {
        truncated = true;
      }
      for (const { value: id } of rows.slice(0, 96)) {
        if (id !== exclude) {
          votes.set(id, (votes.get(id) || 0) + 1);
        }
      }
    }
    if (truncated) {
      await this.warn(
        'A highly repetitive visual-word posting exceeded the 96-candidate retrieval budget. Relocalization is approximate here; all image observations remain in the reconstruction journal.',
      );
    }
    const candidates = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      results: (Relocalization & { strong: boolean })[] = [];
    for (const [id, count] of candidates) {
      if (count < 3) {
        continue;
      }
      const k = await this.db.get<Keyframe>(`keyframe/${id}`);
      if (!k || Math.abs(k.frame - frame) < minGap) {
        continue;
      }
      const matches = matchFeatures(k.features, features), models = translationHypotheses(matches, 16);
      for (const m of models.slice(0, 8)) {
        if (m.support < 6) {
          continue;
        }
        // Analysis-scale audit tolerates sub-factor misalignment; the decision is made on native pixels below.
        const audit = auditTranslation(k.gray, gray, m.x, m.y, roi, factor > 1);
        if (audit.overlap < .22 || !Number.isFinite(audit.error) || (audit.mismatch > .12 && audit.agreement < .5)) {
          continue;
        }
        const refined = refinePatches(k.patches, native, region, { x: m.x * factor, y: m.y * factor }, radius);
        if (!Number.isFinite(refined.error) || refined.error > 12) {
          continue;
        }
        const strong = m.support >= 10 && m.unique >= 6 && m.confidence >= .45;
        const confidence = Math.min(.95, .45 + .5 * (1 - Math.exp(-m.unique / 7))) * Math.exp(-refined.error / 20);
        results.push({
          keyframe: k,
          offset: { x: refined.x, y: refined.y },
          confidence,
          ambiguous: m.ambiguous,
          support: m.support,
          unique: m.unique,
          error: refined.error,
          analysisError: audit.error,
          strong,
        });
      }
    }
    const score = (r: Relocalization) => (r.support * .25 + r.unique) * r.confidence;
    results.sort((a, b) => score(b) - score(a));
    const best = results.find((r) => r.strong);
    if (!best) {
      return;
    }
    const position = (r: Relocalization) => ({ canvas: r.keyframe.canvasId, x: r.keyframe.x + r.offset.x, y: r.keyframe.y + r.offset.y });
    const bp = position(best);
    // Any other plausible place, weak or strong, that lands somewhere else makes the revisit ambiguous. Repeated cards look alike.
    const rival = results.find((r) =>
      r !== best && (position(r).canvas !== bp.canvas || Math.hypot(position(r).x - bp.x, position(r).y - bp.y) > 6) &&
      score(r) > score(best) * .8
    );
    if (rival || best.ambiguous) {
      best.ambiguous = true;
    }
    return best;
  }
}
