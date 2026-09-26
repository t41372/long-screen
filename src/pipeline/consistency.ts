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
/** Persisted analysis-resolution verdict for one frame: per moving region id, the box it was scored in and the two historical
 * plain bitsets (LSB-first, row-major over box.w×box.h) — `bits` for cells solve() finalised as inconsistent,
 * `clean` for cells it finalised as confidently consistent. A cell in neither set has NO verdict (too few
 * comparisons to judge, which is the normal state at a region's leading edge and at the very start/end of a run);
 * that three-way distinction is what consistencyMask() needs, because "not flagged" and "found clean" call for
 * opposite treatment when a ±1-frame neighbour disagrees. Only regions with at least one cell in either set are
 * present; optional `screen` bits add independent screen-motion evidence in the same layout. The whole record is omitted when no region has one. */
export type ConsistencyVote = ConsistencyBox & { bits: Uint8Array; clean: Uint8Array; screen?: Uint8Array };
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
/** Native mask for a moving region: 0 = ordinary inconsistency, 1 = accepted/unknown, 2 = screen occluder.
 * Screen evidence is separate from the historical world-voting bits: agreeing with any nearby grey tap is
 * weak evidence, whereas screen witnesses compare whole patches at independent page positions. A native
 * pixel can inherit a neighbour's screen witness at the SAME screen position only within the source noise.
 *
 * A screen-occluded neighbour cannot veto newly exposed page content. If at least one such neighbour was
 * excluded and all remaining comparable neighbours agree, even a weak negative world vote can be excused.
 * Otherwise the old conservative rule remains:
 *   own negative vote -> reject;
 *   no comparable neighbour -> accept (preserve single-frame glimpses);
 *   one disagreeing neighbour -> reject unless voting independently condemned that neighbour;
 *   two neighbours -> reject any disagreement, even when a weak vote condemned the neighbour.
 * Positive world votes alone never overrule native disagreement.
 *
 * Neighbours must resolve to the same canonical canvas and belong to the region at the sampled pixel.
 * RGB comparisons use the source's declared noise (0 for lossless synthetic frames), not a user setting.
 * The image-sized output stays 1 outside the region; the compositor still checks atlas membership. */
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
