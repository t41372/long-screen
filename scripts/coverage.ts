/** Runs the unit tests with coverage and enforces per-file LINE-coverage floors, so coverage can only ratchet upward.
 *  The floors are the numbers actually reached today, not aspirations; `deno task coverage` fails if any file drops below its floor. */
const dir = '.coverage';
/** Everything that ships: src/ plus the server entry point. Tests, scripts and the synthetic fixtures generator are not gated. */
const INCLUDE = '--include=^file:.*/(src/.*|main\\.ts)$';
/** Line-coverage floors, each set to floor(today's measured value) so a file can only improve. `deno task coverage --update-floors`
 *  rewrites this block from the latest run; review the diff, because lowering a floor hides a regression.
 *  `storage/db.ts` (IndexedDB) and `export/target.ts` (OPFS) cannot execute under Deno and are covered by the browser suite. */
const FLOORS: [RegExp, number][] = [
    [/^codec\/png\.ts$/, 96], [/^core\/compositor\.ts$/, 97], [/^core\/features\.ts$/, 100],
    [/^core\/keyframes\.ts$/, 93], [/^core\/layers\.ts$/, 91], [/^core\/math\.ts$/, 100],
    [/^core\/motion\.ts$/, 99], [/^core\/pose-graph\.ts$/, 98], [/^core\/raster\.ts$/, 100],
    [/^export\/crc\.ts$/, 100], [/^export\/offline\.ts$/, 100], [/^export\/png\.ts$/, 100],
    [/^export\/project\.ts$/, 92], [/^export\/target\.ts$/, 30], [/^export\/zip\.ts$/, 100],
    [/^media\/demo\.ts$/, 100], [/^media\/mp4\.ts$/, 78], [/^media\/reader\.ts$/, 100],
    [/^media\/source\.ts$/, 93], [/^media\/webm\.ts$/, 65], [/^pipeline\/engine\.ts$/, 84],
    [/^storage\/db\.ts$/, 61], [/^storage\/diagnostics\.ts$/, 100], [/^storage\/tiles\.ts$/, 98],
    [/^synthetic\/scenarios\.ts$/, 100], [/^synthetic\/source\.ts$/, 100], [/^synthetic\/verify\.ts$/, 85],
    [/^synthetic\/world\.ts$/, 95], [/^types\.ts$/, 100], [/^main\.ts$/, 83],
];
await Deno.remove(dir, { recursive: true }).catch(() => { });
const test = await new Deno.Command(Deno.execPath(), { args: ['test', '--allow-read', '--allow-write', '--allow-env', '--allow-run', '--parallel', `--coverage=${dir}`, 'tests/unit'], stdout: 'inherit', stderr: 'inherit' }).output();
if (!test.success)
    Deno.exit(test.code);
const report = await new Deno.Command(Deno.execPath(), { args: ['coverage', dir, INCLUDE], stdout: 'piped', stderr: 'inherit' }).output();
const text = new TextDecoder().decode(report.stdout);
console.log(text);
/** Rows are `| file | branch % | function % | line % |`; the line percentage is the last column and the one that gates. */
const rows: { file: string; branch: number; fn: number; line: number }[] = [];
for (const raw of text.split('\n')) {
    const cells = raw.replace(/\u001b\[[0-9;]*m/g, '').split('|').map(c => c.trim()).filter((c, i, a) => !(i === 0 && !c) && !(i === a.length - 1 && !c));
    if (cells.length !== 4 || cells[0] === 'File' || cells[0].startsWith('---') || cells[0] === 'All files')
        continue;
    const [branch, fn, line] = cells.slice(1).map(Number);
    if ([branch, fn, line].some(n => !Number.isFinite(n)))
        continue;
    rows.push({ file: cells[0].replace(/^src\//, ''), branch, fn, line });
}
if (rows.length < 20)
    throw new Error(`Coverage table parsed only ${rows.length} rows; the report format changed and the gate would silently pass.`);
let failed = false;
const summary: Record<string, { line: number; branch: number; fn: number; floor: number; ok: boolean }> = {};
for (const row of rows) {
    const rule = FLOORS.find(([pattern]) => pattern.test(row.file));
    if (!rule)
        console.warn(`No coverage floor recorded for ${row.file} (line ${row.line}%). Add one to scripts/coverage.ts.`);
    const floor = rule ? rule[1] : 0, ok = row.line >= floor;
    summary[row.file] = { line: row.line, branch: row.branch, fn: row.fn, floor, ok };
    if (!ok) {
        failed = true;
        console.error(`Line coverage dropped: ${row.file} ${row.line}% < floor ${floor}%`);
    }
}
for (const [pattern] of FLOORS.filter(([pattern]) => !rows.some(r => pattern.test(r.file))))
    console.warn(`Coverage floor ${pattern.source} matched no file; it may be stale.`);
// A file that never loads under Deno is absent from the report entirely, so a new untested module would otherwise be invisible here.
const BROWSER_ONLY = ['ui/main.ts', 'ui/viewer.ts', 'worker.ts', 'testkit.ts'];
const onDisk: string[] = ['main.ts'];
for await (const entry of walk('src'))
    onDisk.push(entry);
const unreported = onDisk.filter(f => !rows.some(r => r.file === f) && !BROWSER_ONLY.includes(f));
if (unreported.length) {
    failed = true;
    console.error(`Source files absent from the coverage report and not declared browser-only: ${unreported.join(', ')}`);
}
async function* walk(dir: string): AsyncGenerator<string> {
    for await (const entry of Deno.readDir(dir)) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory)
            yield* walk(path);
        else if (entry.name.endsWith('.ts'))
            yield path.replace(/^src\//, '');
    }
}

await Deno.mkdir('test-results', { recursive: true });
await Deno.writeTextFile('test-results/coverage.json', JSON.stringify({ generated: new Date().toISOString(), note: 'Floors are ratchets at the level actually reached, not targets. Line coverage gates; branch and function are reported.', browserOnly: BROWSER_ONLY, files: summary }, null, 2));
const lcov = await new Deno.Command(Deno.execPath(), { args: ['coverage', dir, '--lcov', '--output=test-results/coverage.lcov', INCLUDE], stdout: 'inherit', stderr: 'inherit' }).output();
if (!lcov.success)
    console.error('lcov export failed');
if (Deno.args.includes('--update-floors')) {
    // Rewrites the FLOORS block in this file from the run that just finished. Review the diff: a lowered floor hides a regression.
    const source = await Deno.readTextFile('scripts/coverage.ts');
    const entries = rows.slice().sort((a, b) => a.file.localeCompare(b.file)).map(r => `[/^${r.file.replace(/\./g, '\\.').replace(/\//g, '\\/')}$/, ${Math.floor(r.line)}]`);
    const grouped: string[] = [];
    for (let i = 0; i < entries.length; i += 3)
        grouped.push('    ' + entries.slice(i, i + 3).join(', ') + ',');
    const begin = source.indexOf('const FLOORS: [RegExp, number][] = ['), stop = source.indexOf('];', begin) + 2;
    await Deno.writeTextFile('scripts/coverage.ts', source.slice(0, begin) + 'const FLOORS: [RegExp, number][] = [\n' + grouped.join('\n') + '\n];' + source.slice(stop));
    console.log(`Rewrote ${entries.length} coverage floors from this run.`);
}
if (failed)
    Deno.exit(1);
console.log(`Line coverage at or above every recorded floor (${rows.length} files).`);
