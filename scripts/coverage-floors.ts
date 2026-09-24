/** Pure reconciliation of scripts/coverage.ts's FLOORS block, extracted so `--update-floors` can be unit-tested
 *  without spawning the coverage subprocess. Floors are a ratchet: `reconcileFloors` raises a floor to match a
 *  higher measured value, adds a floor for a newly-measured file at floor(measured), and drops the entry for a
 *  file no longer on disk — it never lowers a floor to match a drop in measured coverage. A drop is reported in
 *  `changes` (kind 'dropped') and left untouched, so the gate keeps failing against the old, higher floor until a
 *  person reviews the drop and edits scripts/coverage.ts by hand with a reason, as the FLOORS block's header
 *  requires. */

/** One FLOORS row as the caller already has it: `pattern` is the regex SOURCE (anchors included, e.g.
 *  `^core\/compute\.ts$`), matching `RegExp.prototype.source` for the entries in scripts/coverage.ts. */
export interface FloorEntry {
  pattern: string;
  floor: number;
}

export interface MeasuredRow {
  file: string;
  line: number;
}

export type FloorChange =
  | { kind: 'raised'; file: string; from: number; to: number }
  | { kind: 'added'; file: string; floor: number }
  | { kind: 'removed'; file: string; floor: number }
  | { kind: 'dropped'; file: string; floor: number; measured: number };

function displayName(pattern: string): string {
  return pattern.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\\\./g, '.');
}

function escapeToPattern(file: string): string {
  return `^${file.replace(/\./g, '\\.').replace(/\//g, '\\/')}$`;
}

export function reconcileFloors(
  current: readonly FloorEntry[],
  measured: readonly MeasuredRow[],
  onDisk: readonly string[],
): { entries: FloorEntry[]; changes: FloorChange[] } {
  const changes: FloorChange[] = [];
  const entries: FloorEntry[] = [];
  for (const entry of current) {
    const re = new RegExp(entry.pattern);
    if (!onDisk.some((f) => re.test(f))) {
      changes.push({ kind: 'removed', file: displayName(entry.pattern), floor: entry.floor });
      continue;
    }
    const row = measured.find((r) => re.test(r.file));
    if (!row) {
      // Not measured this run (e.g. a partial test filter); keep the recorded floor untouched.
      entries.push(entry);
      continue;
    }
    const measuredFloor = Math.floor(row.line);
    if (measuredFloor > entry.floor) {
      changes.push({ kind: 'raised', file: row.file, from: entry.floor, to: measuredFloor });
      entries.push({ pattern: entry.pattern, floor: measuredFloor });
    } else if (measuredFloor < entry.floor) {
      changes.push({ kind: 'dropped', file: row.file, floor: entry.floor, measured: measuredFloor });
      entries.push(entry);
    } else {
      entries.push(entry);
    }
  }
  // New entries are appended, sorted among themselves only — the existing entries above keep the file's current
  // order (not necessarily alphabetical; e.g. `track.ts` sorts after `track-keyframes.ts` by codepoint, but this
  // block was hand-ordered before that mattered). Re-sorting the whole array on every run would reorder untouched
  // entries for no reason and make `deno fmt --check` (and a reviewer's diff) show churn unrelated to any change.
  const added: FloorEntry[] = [];
  for (const row of measured) {
    if (!current.some((e) => new RegExp(e.pattern).test(row.file))) {
      const floor = Math.floor(row.line);
      changes.push({ kind: 'added', file: row.file, floor });
      added.push({ pattern: escapeToPattern(row.file), floor });
    }
  }
  added.sort((a, b) => a.pattern.localeCompare(b.pattern));
  entries.push(...added);
  return { entries, changes };
}

/** True when `reconcileFloors`' `changes` require rewriting the FLOORS block — i.e. anything but a `dropped`
 *  entry, which is reported but deliberately left unapplied (see the module doc comment). Lets the caller skip
 *  the file write (and the reformat it would otherwise force) on a run that found nothing to raise, add or
 *  remove. */
export function needsRewrite(changes: readonly FloorChange[]): boolean {
  return changes.some((c) => c.kind !== 'dropped');
}

/** Renders `entries` as the FLOORS array's body, one entry per line — the layout `deno fmt` already normalises a
 *  multi-line array literal to, so a file `--update-floors` writes never needs a second `deno fmt` pass to match
 *  what's committed. Each line reproduces exactly what an entry looked like in scripts/coverage.ts to begin with:
 *  `  [/<pattern>/, <floor>],` (two-space indent, trailing comma on every line including the last). */
export function renderFloorsBlock(entries: readonly FloorEntry[]): string {
  return entries.map((e) => `  [/${e.pattern}/, ${e.floor}],`).join('\n');
}

/** The inverse of `renderFloorsBlock`, for the round-trip test: pulls `{pattern, floor}` out of a FLOORS block's
 *  body text (or the whole file — it only looks at `[/pattern/, floor]` entries) in source order. */
export function parseFloorsBlock(text: string): FloorEntry[] {
  const entries: FloorEntry[] = [];
  const re = /\[\/(.+?)\/,\s*([\d.]+)\]/g;
  for (const m of text.matchAll(re)) {
    entries.push({ pattern: m[1], floor: Number(m[2]) });
  }
  return entries;
}

/** Diff-style one-line-per-change summary for the console; `reconcileFloors`' three applied kinds first, then any
 *  drops last so they are the thing a person scrolls to. */
export function formatFloorChanges(changes: readonly FloorChange[]): string[] {
  const order: Record<FloorChange['kind'], number> = { added: 0, raised: 1, removed: 2, dropped: 3 };
  return changes.slice().sort((a, b) => order[a.kind] - order[b.kind]).map((c) => {
    switch (c.kind) {
      case 'raised':
        return `  ^ ${c.file}: ${c.from} -> ${c.to}`;
      case 'added':
        return `  + ${c.file}: ${c.floor} (new)`;
      case 'removed':
        return `  - ${c.file}: ${c.floor} (file no longer exists)`;
      case 'dropped':
        return `  ! ${c.file}: measured ${c.measured} < floor ${c.floor} — NOT lowered; review and hand-edit with a reason`;
    }
  });
}
