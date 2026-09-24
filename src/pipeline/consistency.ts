// consistencyMask() itself already dispatches to the Rust core (rust/core/src/consistency.rs); the TypeScript
// here is the canvas-identity gate around it (a neighbour only counts when its placement resolved to the same
// canvas) plus the shell that picks the resident-vs-plain-array input form and the types both sides share. It
// is not algorithmic TS awaiting a port — there is no algorithm left here to port.
import type { Point, Rect, Region, RGBA } from '../types.ts';
import { RegionAtlas } from '../core/layers.ts';
import { core, type Resident, type ResidentFrame } from '../core/wasm.ts';
/** Analysis-resolution voting box of one moving region, in that region's own local cell coordinates. */
export interface ConsistencyBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
}
/** Persisted analysis-resolution verdict for one frame: per moving region id, the box it was scored in and TWO
 * plain bitsets (LSB-first, row-major over box.w×box.h) — `bits` for cells solve() finalised as inconsistent,
 * `clean` for cells it finalised as confidently consistent. A cell in neither set has NO verdict (too few
 * comparisons to judge, which is the normal state at a region's leading edge and at the very start/end of a run);
 * that three-way distinction is what consistencyMask() needs, because "not flagged" and "found clean" call for
 * opposite treatment when a ±1-frame neighbour disagrees. Only regions with at least one cell in either set are
 * present, and the whole record is omitted when no region has one. */
export type ConsistencyVote = ConsistencyBox & { bits: Uint8Array; clean: Uint8Array };
export type ConsistencyRecord = Record<string, ConsistencyVote>;
/** A neighbouring frame's resolved placement for the SAME region, as consistencyMask() needs it: its image, its
 * final render-time pose, which canvas it resolved to (compared against the current frame's canvasId to decide
 * whether the neighbour counts at all), the sticky occlusions it recorded, and its own voting verdict. */
export interface ConsistencyNeighbour {
  image: RGBA | ResidentFrame;
  x: number;
  y: number;
  canvasId: string;
  occlusions?: Rect[];
  voting?: ConsistencyVote;
}
export interface ConsistencyOptions {
  /** Integer analysis factor: analysis pixels × factor = native pixels, exactly (Engine.factor). */
  factor: number;
  /** Per-channel decode noise the source declares; every "is this the same content?" comparison is derived
   * from it (Engine.noise). */
  noise: number;
  prev?: ConsistencyNeighbour;
  next?: ConsistencyNeighbour;
  voting?: ConsistencyVote;
  /** When given, the mask is written into this resident buffer instead of allocating a new Uint8Array. */
  output?: Resident;
}
/** World-consistency mask for one moving-region placement (docs/ARCHITECTURE.md §七): per screen pixel inside
 *  `region.rect`, decides whether the content this observation shows there can be trusted as page content at
 *  the world position it is about to be written to (screen pixel + this frame's resolved `pose`). Two kinds of
 *  evidence exist, and they are NOT symmetric in strength:
 *
 *  - solve()'s displacement-spread voting (`voting`, upsampled from analysis resolution — see ConsistencyVote
 *    and the block comment above `states` in solve()) is a MULTI-frame verdict over partners displaced far
 *    enough that a screen-fixed overlay cannot occupy the same world position in both. It says WHICH frame is
 *    wrong, and gets the last word wherever it reached a verdict at all.
 *  - the ±1-frame native check is a PAIRWISE DISAGREEMENT signal. When this frame and its neighbour show
 *    different content at the same world position, one of the two is wrong — the comparison itself cannot say
 *    which. Treating both as wrong is what used to condemn a run's genuinely-clean last frame because its only
 *    neighbour happened to be under a floating button, and with it the chance to heal that neighbour's
 *    provisional pixel (docs/ARCHITECTURE.md §七, world pixel (314, 3198) on `phone`). So a disagreement now
 *    only condemns this frame when the evidence is symmetric: every available neighbour disagrees, or the one
 *    that does carries its own positive voting verdict at that world position and is therefore trustworthy.
 *
 *  Truth table for one pixel, first matching row wins (`own verdict` is THIS frame's voting verdict at this
 *  world position; a neighbour's verdict is that NEIGHBOUR's, read at its own screen position in the same box):
 *
 *    own verdict  | comparable ±1 neighbours                                    | result
 *    -------------|------------------------------------------------------------|--------------
 *    inconsistent | not consulted                                               | inconsistent
 *    anything else| 0 (no prev/next, other canvas, or outside the atlas mask)    | consistent
 *                 | 1, it agrees                                                | consistent
 *                 | 1, it disagrees, voting found THAT neighbour inconsistent    | consistent
 *                 | 1, it disagrees, voting has no such verdict for it           | inconsistent
 *                 | 2, both agree                                               | consistent
 *                 | 2, either disagrees (excused or not)                        | inconsistent
 *
 *  Two things that look arbitrary in that table are not, and both were measured. The excuse is limited to the
 *  LONE-neighbour row because with two comparable neighbours the evidence is already two-sided: an overlay
 *  taller than one frame's scroll routinely covers a world position in frames t and t−1 while t+1 is clean, and
 *  the plain any-disagreement reading is what catches it — extending the excuse to two neighbours was measured
 *  taking `chrome-everything` from 4.2k unhealed overlay pixels to 27k. And a POSITIVE voting verdict never
 *  overrules a ±1 disagreement on its own: `consistencyCompare` agrees when the MINIMUM difference over a
 *  ±`consistencyRadius` window is within tolerance, which is the right bias for flagging but makes "agrees"
 *  weak evidence on textured content, where a window that size nearly always holds something close enough.
 *  Trusting it flipped overlay pixels to "consistent" wholesale (provisionalPixels collapsed to 0 on
 *  `chrome-everything`, recoverable rose to 27k). It is trusted only for the narrow question the lone-neighbour
 *  row asks, where the alternative is no evidence at all.
 *
 *  The "0 comparable" row is the long-standing consistent-by-default rule and must stay: content glimpsed in
 *  only one frame still has to be painted (the 'glimpse' scenario) — no evidence is not evidence of a fault.
 *  A neighbour comparison counts only when that neighbour's own placement for this layer resolved to the same
 *  `canvasId` and the corresponding neighbour screen position lies inside both the frame and this region's
 *  atlas membership; agreement is exact RGB equality, else mean |ΔRGB| ≤ `options.noise` — the decode noise the
 *  SOURCE declares (`MediaInfo.noise`), not a constant. A lossless source is therefore compared exactly, which
 *  is what lets a white floating-button glyph over a near-white page (mean |ΔRGB| 6 — under the 10 levels a
 *  decoded recording needs) be seen at all; a real recording keeps exactly the headroom it always had. Returned array is image-sized
 *  (one byte per native pixel, indexed like RegionAtlas.labels); pixels outside the region are left at the
 *  default 1 and are never read by the compositor (it already gates on region membership before consulting
 *  this mask). */
export function consistencyMask(
  image: RGBA | ResidentFrame,
  atlas: RegionAtlas | Uint8Array | Resident,
  region: Region,
  code: number,
  pose: Point,
  canvasId: string,
  options: ConsistencyOptions,
): Uint8Array | Resident {
  // The mask itself is computed by the Rust core (rust/core/src/consistency.rs); this keeps the
  // canvas-identity gate (a neighbour only counts when its placement resolved to the same canvas) here.
  const neighbour = (n: ConsistencyNeighbour | undefined) =>
    n && n.canvasId === canvasId ? { image: n.image, x: n.x, y: n.y, occlusions: n.occlusions, voting: n.voting } : undefined;
  const input = {
    image,
    labels: atlas instanceof RegionAtlas ? atlas.labels : atlas,
    region: region.rect,
    code,
    pose,
    prev: neighbour(options.prev),
    next: neighbour(options.next),
    voting: options.voting,
    factor: options.factor,
    noise: options.noise,
  };
  if (!options.output) return core().consistencyMask(input);
  core().consistencyMaskInto(input, options.output);
  return options.output;
}
