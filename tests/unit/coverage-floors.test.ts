import { assertEquals } from '@std/assert';
import {
  type FloorEntry,
  formatFloorChanges,
  type MeasuredRow,
  needsRewrite,
  parseFloorsBlock,
  reconcileFloors,
  renderFloorsBlock,
} from '../../scripts/coverage-floors.ts';

const A: FloorEntry = { pattern: '^core\\/a\\.ts$', floor: 90 };
const B: FloorEntry = { pattern: '^core\\/b\\.ts$', floor: 95 };

Deno.test('reconcileFloors: a mixed run raises one floor and reports a drop on another without applying it', () => {
  // A's floor (90) is below the measured 93.7 -> raised to 93. B's floor (95) is above the measured 91 -> a drop,
  // reported but left at 95. Entries keep A-then-B, their original order.
  const measured: MeasuredRow[] = [{ file: 'core/a.ts', line: 93.7 }, { file: 'core/b.ts', line: 91 }];
  const { entries, changes } = reconcileFloors([A, B], measured, ['core/a.ts', 'core/b.ts']);
  assertEquals(entries, [{ pattern: A.pattern, floor: 93 }, B]);
  assertEquals(changes, [
    { kind: 'raised', file: 'core/a.ts', from: 90, to: 93 },
    { kind: 'dropped', file: 'core/b.ts', floor: 95, measured: 91 },
  ]);
});

Deno.test("reconcileFloors: preserves the existing entries' order — it does not re-sort the whole array", () => {
  // `track.ts` sorts AFTER `track-keyframes.ts` by codepoint ('.' > '-'), but this block orders them the other
  // way round by hand; a plain alphabetical re-sort would silently swap them on every --update-floors run.
  const track: FloorEntry = { pattern: '^core\\/wasm\\/track\\.ts$', floor: 95 };
  const trackKeyframes: FloorEntry = { pattern: '^core\\/wasm\\/track-keyframes\\.ts$', floor: 99 };
  const measured: MeasuredRow[] = [{ file: 'core/wasm/track.ts', line: 96 }, { file: 'core/wasm/track-keyframes.ts', line: 99 }];
  const { entries } = reconcileFloors([track, trackKeyframes], measured, [
    'core/wasm/track.ts',
    'core/wasm/track-keyframes.ts',
  ]);
  assertEquals(entries.map((e) => e.pattern), [track.pattern, trackKeyframes.pattern]);
});

Deno.test('reconcileFloors: new entries are appended, sorted only among themselves', () => {
  const measured: MeasuredRow[] = [{ file: 'core/z.ts', line: 50 }, { file: 'core/a.ts', line: 50 }];
  const { entries } = reconcileFloors([B], measured, ['core/b.ts', 'core/z.ts', 'core/a.ts']);
  assertEquals(entries.map((e) => e.pattern), [B.pattern, '^core\\/a\\.ts$', '^core\\/z\\.ts$']);
});

Deno.test('reconcileFloors: a removal and an addition in the same run are both reported, so a rename is visible', () => {
  const old: FloorEntry = { pattern: '^core\\/old-name\\.ts$', floor: 90 };
  const measured: MeasuredRow[] = [{ file: 'core/new-name.ts', line: 92 }];
  const { changes } = reconcileFloors([old], measured, ['core/new-name.ts']);
  assertEquals(changes, [
    { kind: 'removed', file: 'core/old-name.ts', floor: 90 },
    { kind: 'added', file: 'core/new-name.ts', floor: 92 },
  ]);
});

Deno.test('reconcileFloors: a floor that improves is raised to floor(measured)', () => {
  const measured: MeasuredRow[] = [{ file: 'core/a.ts', line: 97.9 }];
  const { entries, changes } = reconcileFloors([A], measured, ['core/a.ts']);
  assertEquals(entries, [{ pattern: A.pattern, floor: 97 }]);
  assertEquals(changes, [{ kind: 'raised', file: 'core/a.ts', from: 90, to: 97 }]);
});

Deno.test('reconcileFloors: a measured drop is reported and NOT applied', () => {
  const measured: MeasuredRow[] = [{ file: 'core/b.ts', line: 80 }];
  const { entries, changes } = reconcileFloors([B], measured, ['core/b.ts']);
  assertEquals(entries, [B], 'the floor must stay at its old, higher value');
  assertEquals(changes, [{ kind: 'dropped', file: 'core/b.ts', floor: 95, measured: 80 }]);
});

Deno.test('reconcileFloors: an equal measured value changes nothing', () => {
  const measured: MeasuredRow[] = [{ file: 'core/a.ts', line: 90.9 }];
  const { entries, changes } = reconcileFloors([A], measured, ['core/a.ts']);
  assertEquals(entries, [A]);
  assertEquals(changes, []);
});

Deno.test('reconcileFloors: adds a floor(measured) entry for a newly-measured file with no existing floor', () => {
  const measured: MeasuredRow[] = [{ file: 'core/new.ts', line: 88.4 }];
  const { entries, changes } = reconcileFloors([], measured, ['core/new.ts']);
  assertEquals(entries, [{ pattern: '^core\\/new\\.ts$', floor: 88 }]);
  assertEquals(changes, [{ kind: 'added', file: 'core/new.ts', floor: 88 }]);
});

Deno.test('reconcileFloors: removes the entry for a file no longer on disk, and does not touch its floor', () => {
  const { entries, changes } = reconcileFloors([A], [], ['core/b.ts']);
  assertEquals(entries, []);
  assertEquals(changes, [{ kind: 'removed', file: 'core/a.ts', floor: 90 }]);
});

Deno.test('reconcileFloors: a floor for a file that exists on disk but was not measured this run is kept as-is', () => {
  const { entries, changes } = reconcileFloors([A], [], ['core/a.ts']);
  assertEquals(entries, [A]);
  assertEquals(changes, []);
});

Deno.test('needsRewrite: false when the only change is a drop (nothing to raise/add/remove)', () => {
  assertEquals(needsRewrite([{ kind: 'dropped', file: 'core/b.ts', floor: 95, measured: 80 }]), false);
  assertEquals(needsRewrite([]), false);
});

Deno.test('needsRewrite: true for a raise, an addition or a removal', () => {
  assertEquals(needsRewrite([{ kind: 'raised', file: 'core/a.ts', from: 90, to: 93 }]), true);
  assertEquals(needsRewrite([{ kind: 'added', file: 'core/new.ts', floor: 88 }]), true);
  assertEquals(needsRewrite([{ kind: 'removed', file: 'core/old.ts', floor: 90 }]), true);
});

Deno.test('renderFloorsBlock: one entry per line, two-space indent, trailing comma — the layout deno fmt keeps', () => {
  const block = renderFloorsBlock([A, B]);
  assertEquals(block, '  [/^core\\/a\\.ts$/, 90],\n  [/^core\\/b\\.ts$/, 95],');
});

Deno.test('parseFloorsBlock / renderFloorsBlock round-trip: rendering unchanged entries reproduces the block byte-for-byte', () => {
  const original = '  [/^codec\\/crc\\.ts$/, 100],\n  [/^codec\\/png\\.ts$/, 96],\n  [/^core\\/id\\.ts$/, 100],';
  const entries = parseFloorsBlock(original);
  assertEquals(entries, [
    { pattern: '^codec\\/crc\\.ts$', floor: 100 },
    { pattern: '^codec\\/png\\.ts$', floor: 96 },
    { pattern: '^core\\/id\\.ts$', floor: 100 },
  ]);
  assertEquals(renderFloorsBlock(entries), original);
});

Deno.test('formatFloorChanges: drops sort after raises/adds/removes, one line per change', () => {
  const lines = formatFloorChanges([
    { kind: 'dropped', file: 'core/b.ts', floor: 95, measured: 80 },
    { kind: 'added', file: 'core/new.ts', floor: 88 },
    { kind: 'raised', file: 'core/a.ts', from: 90, to: 97 },
  ]);
  assertEquals(lines.length, 3);
  assertEquals(lines[lines.length - 1].includes('NOT lowered'), true);
  assertEquals(lines[0].startsWith('  + core/new.ts'), true);
});
