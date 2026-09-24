/** `Tile.provisional` bit setters used only by tests and the frozen compositor/framing oracles: production
 *  code sets and clears provisional bits inside the Rust core (rust/core/src/temporal.rs, framing.rs), never
 *  through these. `covered`/`markCovered`/`provisional` stay in `src/storage/tiles.ts` (still exported there). */
import type { Tile } from '../../src/storage/tiles.ts';
export const markProvisional = (tile: Tile, p: number): void => {
  tile.provisional[p >> 3] |= 1 << (p & 7);
};
export const clearProvisional = (tile: Tile, p: number): void => {
  tile.provisional[p >> 3] &= ~(1 << (p & 7));
};
