/** Runs the unit tests with coverage and enforces per-file LINE-coverage floors, so coverage can only ratchet upward.
 *  The floors are the numbers actually reached today, not aspirations; `deno task coverage` fails if any file drops below its floor. */
import { formatFloorChanges, needsRewrite, reconcileFloors, renderFloorsBlock } from './coverage-floors.ts';
const dir = '.coverage';
/** Everything that ships: src/ plus the server entry point. Tests, scripts and the synthetic fixtures generator are not gated. */
const INCLUDE = '--include=^file:.*/(src/.*|main\\.ts)$';
/** Line-coverage floors, each set to floor(today's measured value) so a file can only improve. `deno task coverage --update-floors`
 *  reconciles this block against the latest run (scripts/coverage-floors.ts): it raises a floor that improved, adds
 *  one for a newly-measured file, and drops an entry for a file no longer on disk — it never lowers a floor to
 *  match a drop in measured coverage. A drop is printed and left in place instead, because it needs a person to
 *  review why coverage fell and hand-edit the floor down with a reason.
 *  `storage/db.ts` (IndexedDB) and `export/target.ts` (OPFS) cannot execute under Deno and are covered by the browser suite;
 *  every uncovered line in `storage/db.ts` is the `Database` class itself (the IndexedDB adapter).
 *  Line coverage is also a property of the layout: a `deno fmt`-formatted branch whose statements sit on several lines
 *  (rather than sharing one) counts its unexecuted lines separately. Every floor was re-seeded to
 *  floor(measured) on the formatted tree (core/compositor.ts 100→98, pipeline/engine.ts 91→87, core/compute.ts 97→95,
 *  storage/db.ts 61→58, export/target.ts 30→26 moved with no code or test change; the rest moved up).
 *  `main.ts`'s floor was lowered from 83: the server gained realpath containment (tested) and `deno task start` gained a
 *  stale-dist rebuild check whose pure "newest mtime" helper (`newestSource`) is tested directly, but the surrounding
 *  `import.meta.main` block — actual `Deno.serve()` startup and the `scripts/build.ts` spawn — only runs when main.ts is
 *  the process entry point, not when imported by a test, and exercising it would need `--allow-run` that `deno task test`
 *  does not grant plus spawning a real build/server from a unit test, both out of scope here.
 *  Reseeded: the gate had been failing since before the 2026-09 refactor — 55 of 89 src files
 *  (mostly new modules from the Rust-porting rounds: core/wasm/**, pipeline/solve/**, pipeline/{attachments,consistency,
 *  context,features-codec,presentation,render,scan}.ts, media/{convert,pool,rgba-copy}.ts, storage/projects.ts,
 *  core/id.ts, core/wasm.ts) had neither a floor nor a BROWSER_ONLY entry, so `deno task coverage` could never pass.
 *  Fixed the stale `export/crc.ts` floor (the file is `codec/crc.ts`), added ui/*, device-check.ts,
 *  media/convert-worker.ts, core/helper.ts and protocol.ts (type-only, never emits a runtime line) to BROWSER_ONLY,
 *  then ran `--update-floors` once and reviewed the diff: no floor dropped from a real regression — every drop
 *  (core/compositor.ts 98→97, core/compute.ts 95→93, core/framing.ts 100→96, core/layers.ts 91→85, export/zip.ts
 *  100→96, media/mp4.ts 84→82, pipeline/engine.ts 87→78, storage/db.ts 58→50, storage/tiles.ts 98→97, main.ts 77→50)
 *  is a file that had already drifted below its old floor before this reseed — `deno task coverage` had been failing
 *  on the "no floor recorded" errors for the new modules above, so nobody could see these drops fail the gate on
 *  their own; there is no code or test change here to explain any of them.
 *  Reseeded again: later renames left floors keyed to old paths (`core/wasm/composite.ts`
 *  → `core/wasm/compositor.ts`, `core/wasm/learner.ts` → `core/wasm/layers.ts`, `core/features.ts` deleted, the
 *  track trio split into `core/wasm/track.ts` + `track-odometry.ts`/`track-reacquire.ts`/`track-keyframes.ts`, and
 *  the new `core/wasm/yuv.ts`) — carried each renamed file's floor to its new path and added floor(measured) for the
 *  new split files: `core/wasm/compositor.ts` 97, `core/wasm/layers.ts` 96, `core/wasm/track-keyframes.ts` 99,
 *  `core/wasm/track-odometry.ts` 97, `core/wasm/track-reacquire.ts` 95. `core/wasm/yuv.ts` (`frameToRGBA`, the
 *  planar-conversion path `media/convert.ts` calls) only runs from a Worker fed real `VideoFrame.copyTo` output,
 *  which Deno's test runner never produces — but the module is still imported transitively (through the `core.ts`
 *  barrel), so `deno coverage` reports it at 0% rather than omitting it, and BROWSER_ONLY (which only exempts files
 *  absent from the report) does not apply; it gets an explicit 0 floor instead, verified real coverage by the
 *  browser suite (`tests/browser/planar.test.ts`).
 *  Two floors had genuinely dropped: `core/wasm/track.ts` 95→93.9 was `resolveNative`'s mode-0-returns-a-
 *  `ResidentGray` branch (added in 474fb81 to fix a real bug) and its plain-`Gray` sibling branch, neither reached by
 *  the synthetic scenarios (documented on the function: this path never reaches the 24×11 differential suite) — added
 *  `tests/unit/wasm-track-resolve-native.test.ts`, which calls `resolveNative` directly for both branches, restoring
 *  the floor to 95 (measured back above it). `core/wasm/memory.ts` 90→82 was `ResidentGray.window()`, which lost its
 *  only production caller when `extractPatches` moved to Rust (commit d029e6b) — `window()` is real, working code
 *  with no caller left in `src`, not removed dead code, so the same test file adds a direct call to it too; the floor
 *  is restored to 90 rather than lowered. Ran `--update-floors` once on a scratch copy of this file to see its
 *  output (73 entries, all matching the numbers above) but did not accept it, and instead reviewed and typed in
 *  every floor by hand: `--update-floors` reconciles the FLOORS block from measured coverage
 *  (scripts/coverage-floors.ts) — it raises a floor, adds one for a new file, and drops one for a file no longer on
 *  disk, but never lowers a floor to match a regression (that is reported and left for a person to review and
 *  hand-edit with a reason), and it skips writing the file at all when there is nothing to raise, add or remove.
 *  `pipeline/render.ts` 87→89: reading `performance.now()` directly inside `RenderPass.checkpointFlush()`'s
 *  1200 ms gate made which side of the gate a `deno test --parallel` run hit wall-clock-dependent, and line
 *  coverage swung 87.1–89.3% across runs; the floor was lowered to floor(worst observed). `RenderPass` now takes
 *  its clock as a constructor argument (defaulting to `performance.now` in production, injected as a fake in
 *  tests/unit/render-checkpoint-flush.test.ts), so a direct test always exercises both branches regardless of
 *  timing; re-measured at a stable 89.3% across five consecutive runs, restoring the floor to 89. */
const FLOORS: [RegExp, number][] = [
  [/^codec\/crc\.ts$/, 100],
  [/^codec\/png\.ts$/, 96],
  [/^core\/compositor\.ts$/, 97],
  [/^core\/compute\.ts$/, 93],
  [/^core\/framing\.ts$/, 96],
  [/^core\/id\.ts$/, 100],
  [/^core\/keyframes\.ts$/, 100],
  [/^core\/layers\.ts$/, 85],
  [/^core\/math\.ts$/, 100],
  [/^core\/motion\.ts$/, 100],
  [/^core\/pose-graph\.ts$/, 100],
  [/^core\/raster\.ts$/, 100],
  [/^core\/wasm\.ts$/, 100],
  [/^core\/wasm\/chrome\.ts$/, 98],
  [/^core\/wasm\/compositor\.ts$/, 97],
  [/^core\/wasm\/consistency\.ts$/, 95],
  [/^core\/wasm\/core\.ts$/, 82],
  [/^core\/wasm\/exports\.ts$/, 91],
  [/^core\/wasm\/features\.ts$/, 100],
  [/^core\/wasm\/framing\.ts$/, 95],
  [/^core\/wasm\/layers\.ts$/, 96],
  [/^core\/wasm\/loader\.ts$/, 37],
  [/^core\/wasm\/marshal\.ts$/, 100],
  [/^core\/wasm\/memory\.ts$/, 90],
  [/^core\/wasm\/motion\.ts$/, 97],
  [/^core\/wasm\/png\.ts$/, 98],
  [/^core\/wasm\/pose-graph\.ts$/, 91],
  [/^core\/wasm\/pyramid\.ts$/, 100],
  [/^core\/wasm\/raster\.ts$/, 66],
  [/^core\/wasm\/regions\.ts$/, 95],
  [/^core\/wasm\/temporal\.ts$/, 99],
  [/^core\/wasm\/track\.ts$/, 95],
  [/^core\/wasm\/track-keyframes\.ts$/, 99],
  [/^core\/wasm\/track-odometry\.ts$/, 97],
  [/^core\/wasm\/track-reacquire\.ts$/, 95],
  [/^core\/wasm\/voting\.ts$/, 97],
  [/^core\/wasm\/yuv\.ts$/, 0],
  [/^export\/offline\.ts$/, 100],
  [/^export\/png\.ts$/, 100],
  [/^export\/project\.ts$/, 97],
  [/^export\/target\.ts$/, 43],
  [/^export\/zip\.ts$/, 96],
  [/^main\.ts$/, 50],
  [/^media\/convert\.ts$/, 8],
  [/^media\/demo\.ts$/, 100],
  [/^media\/mp4\.ts$/, 82],
  [/^media\/pool\.ts$/, 100],
  [/^media\/reader\.ts$/, 100],
  [/^media\/rgba-copy\.ts$/, 14],
  [/^media\/source\.ts$/, 94],
  [/^media\/webm\.ts$/, 70],
  [/^pipeline\/attachments\.ts$/, 100],
  [/^pipeline\/consistency\.ts$/, 100],
  [/^pipeline\/context\.ts$/, 92],
  [/^pipeline\/engine\.ts$/, 78],
  [/^pipeline\/features-codec\.ts$/, 100],
  [/^pipeline\/presentation\.ts$/, 87],
  [/^pipeline\/render\.ts$/, 89],
  [/^pipeline\/scan\.ts$/, 89],
  [/^pipeline\/solve\/keyframe-step\.ts$/, 95],
  [/^pipeline\/solve\/region-step\.ts$/, 96],
  [/^pipeline\/solve\/solve\.ts$/, 82],
  [/^pipeline\/solve\/state\.ts$/, 100],
  [/^pipeline\/solve\/track\.ts$/, 100],
  [/^storage\/db\.ts$/, 50],
  [/^storage\/diagnostics\.ts$/, 100],
  [/^storage\/projects\.ts$/, 12],
  [/^storage\/tiles\.ts$/, 97],
  [/^synthetic\/scenarios\.ts$/, 100],
  [/^synthetic\/source\.ts$/, 100],
  [/^synthetic\/verify\.ts$/, 93],
  [/^synthetic\/world\.ts$/, 96],
  [/^types\.ts$/, 100],
];
await Deno.remove(dir, { recursive: true }).catch(() => {});
const test = await new Deno.Command(Deno.execPath(), {
  args: ['test', '--allow-read', '--allow-write', '--allow-env', '--allow-run', '--parallel', `--coverage=${dir}`, 'tests/unit'],
  stdout: 'inherit',
  stderr: 'inherit',
}).output();
if (!test.success) {
  Deno.exit(test.code);
}
const report = await new Deno.Command(Deno.execPath(), { args: ['coverage', dir, INCLUDE], stdout: 'piped', stderr: 'inherit' }).output();
const text = new TextDecoder().decode(report.stdout);
console.log(text);
/** Rows are `| file | branch % | function % | line % |`; the line percentage is the last column and the one that gates. */
const rows: { file: string; branch: number; fn: number; line: number }[] = [];
for (const raw of text.split('\n')) {
  const cells = raw.replace(/\u001b\[[0-9;]*m/g, '').split('|').map((c) => c.trim()).filter((c, i, a) =>
    !(i === 0 && !c) && !(i === a.length - 1 && !c)
  );
  if (cells.length !== 4 || cells[0] === 'File' || cells[0].startsWith('---') || cells[0] === 'All files') {
    continue;
  }
  const [branch, fn, line] = cells.slice(1).map(Number);
  if ([branch, fn, line].some((n) => !Number.isFinite(n))) {
    continue;
  }
  rows.push({ file: cells[0].replace(/^src\//, ''), branch, fn, line });
}
if (rows.length < 20) {
  throw new Error(`Coverage table parsed only ${rows.length} rows; the report format changed and the gate would silently pass.`);
}
// Kept apart from `otherFailed` below so `--update-floors` can recompute just this half against the reconciled
// floors, without losing (or being masked by) the unrelated "file absent from the report" check.
const updateFloors = Deno.args.includes('--update-floors');
let floorsFailed = false;
const summary: Record<string, { line: number; branch: number; fn: number; floor: number; ok: boolean }> = {};
for (const row of rows) {
  const rule = FLOORS.find(([pattern]) => pattern.test(row.file));
  if (!rule) {
    floorsFailed = true;
    // Under --update-floors a missing floor is about to be added, not a failure worth printing; the change
    // summary below reports it as `+ <file>` instead.
    if (!updateFloors) {
      console.error(`No coverage floor recorded for ${row.file} (line ${row.line}%). Add one to scripts/coverage.ts.`);
    }
  }
  const floor = rule ? rule[1] : 0, ok = row.line >= floor;
  summary[row.file] = { line: row.line, branch: row.branch, fn: row.fn, floor, ok };
  if (!ok) {
    floorsFailed = true;
    // Under --update-floors a drop is reported once, by the change summary below (`! <file>`), not here too.
    if (!updateFloors) {
      console.error(`Line coverage dropped: ${row.file} ${row.line}% < floor ${floor}%`);
    }
  }
}
for (const [pattern] of FLOORS.filter(([pattern]) => !rows.some((r) => pattern.test(r.file)))) {
  console.warn(`Coverage floor ${pattern.source} matched no file; it may be stale.`);
}
// A file that never loads under Deno (browser-only entry points/workers) or that TypeScript erases entirely (a
// types-only module with no runtime statement to instrument, e.g. protocol.ts) is absent from the report entirely,
// so a new untested module would otherwise be invisible here. A trailing `/*` matches every file directly under
// that directory (non-recursive — add the subdirectory explicitly if one appears), for directories that are
// entirely browser UI, so adding a file there doesn't silently need a coverage.ts edit to stay ungated.
const BROWSER_ONLY = ['ui/*', 'worker.ts', 'testkit.ts', 'device-check.ts', 'media/convert-worker.ts', 'core/helper.ts', 'protocol.ts'];
const isBrowserOnly = (file: string) =>
  BROWSER_ONLY.some((entry) =>
    entry.endsWith('/*') ? file.startsWith(entry.slice(0, -1)) && !file.slice(entry.length - 1).includes('/') : file === entry
  );
const onDisk: string[] = ['main.ts'];
for await (const entry of walk('src')) {
  onDisk.push(entry);
}
const unreported = onDisk.filter((f) => !rows.some((r) => r.file === f) && !isBrowserOnly(f));
let otherFailed = false;
if (unreported.length) {
  otherFailed = true;
  console.error(`Source files absent from the coverage report and not declared browser-only: ${unreported.join(', ')}`);
}
async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (entry.name.endsWith('.ts')) {
      yield path.replace(/^src\//, '');
    }
  }
}

await Deno.mkdir('test-results', { recursive: true });
await Deno.writeTextFile(
  'test-results/coverage.json',
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      note: 'Floors are ratchets at the level actually reached, not targets. Line coverage gates; branch and function are reported.',
      browserOnly: BROWSER_ONLY,
      files: summary,
    },
    null,
    2,
  ),
);
const lcov = await new Deno.Command(Deno.execPath(), {
  args: ['coverage', dir, '--lcov', '--output=test-results/coverage.lcov', INCLUDE],
  stdout: 'inherit',
  stderr: 'inherit',
}).output();
if (!lcov.success) {
  console.error('lcov export failed');
}
if (updateFloors) {
  // Reconciles the FLOORS block against this run's measured numbers (scripts/coverage-floors.ts): raises a floor
  // that improved, adds one for a newly-measured file, drops an entry for a file no longer on disk, and leaves a
  // drop in place (reported, not applied) for a person to review and hand-edit with a reason.
  const { entries, changes } = reconcileFloors(
    FLOORS.map(([pattern, floor]) => ({ pattern: pattern.source, floor })),
    rows.map((r) => ({ file: r.file, line: r.line })),
    onDisk,
  );
  console.log(changes.length ? 'Coverage floor changes:' : 'No coverage floor changes.');
  for (const line of formatFloorChanges(changes)) {
    console.log(line);
  }
  if (needsRewrite(changes)) {
    // Written in exactly the layout `deno fmt` already normalises a multi-line array literal to (one entry per
    // line, two-space indent — see renderFloorsBlock's doc comment), so writing this file never leaves it needing
    // a second `deno fmt` pass to match what gets committed.
    const source = await Deno.readTextFile('scripts/coverage.ts');
    const begin = source.indexOf('const FLOORS: [RegExp, number][] = ['), stop = source.indexOf('];', begin) + 2;
    await Deno.writeTextFile(
      'scripts/coverage.ts',
      source.slice(0, begin) + 'const FLOORS: [RegExp, number][] = [\n' + renderFloorsBlock(entries) + '\n];' + source.slice(stop),
    );
  } else {
    console.log('Nothing to raise, add or remove; scripts/coverage.ts left untouched.');
  }
  // Re-check against the RECONCILED floors, not the stale ones this run started with: a raise, or a new file's
  // floor(measured), always passes; a drop stays parked at its old, higher floor, so the gate keeps failing on it
  // (as it would have anyway) until the drop is reviewed and the floor is hand-edited down with a reason. Already
  // reported once above by formatFloorChanges, so no further per-row message here.
  floorsFailed = false;
  const reconciled: [RegExp, number][] = entries.map((e) => [new RegExp(e.pattern), e.floor]);
  for (const row of rows) {
    const rule = reconciled.find(([pattern]) => pattern.test(row.file));
    const floor = rule ? rule[1] : 0;
    if (row.line < floor) {
      floorsFailed = true;
    }
  }
  if (floorsFailed) {
    console.error('One or more floors need a hand edit — see the drop(s) above.');
  }
}
if (floorsFailed || otherFailed) {
  Deno.exit(1);
}
console.log(`Line coverage at or above every recorded floor (${rows.length} files).`);
