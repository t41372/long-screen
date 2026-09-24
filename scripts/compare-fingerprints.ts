/** Compares two scripts/fingerprint-scenarios.ts outputs row by row. Exit 1 on any difference.
 *  Usage: deno run -A scripts/compare-fingerprints.ts a.json b.json */
type FP = Record<string, { rows: Record<string, string>; events: string; project: string }>;
const [a, b] = await Promise.all(Deno.args.slice(0, 2).map(async (f) => JSON.parse(await Deno.readTextFile(f)) as FP));
let differences = 0;
for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
  const x = a[name], y = b[name];
  if (!x || !y) {
    console.log(`${name}: only in ${x ? 'first' : 'second'}`);
    differences++;
    continue;
  }
  const diff: string[] = [];
  for (const key of new Set([...Object.keys(x.rows), ...Object.keys(y.rows)])) {
    if (x.rows[key] !== y.rows[key]) diff.push(`${key}${!x.rows[key] ? ' (added)' : !y.rows[key] ? ' (removed)' : ''}`);
  }
  // Live events are rate-limited per code on a 750 ms wall-clock window (src/storage/diagnostics.ts), so the event
  // stream is timing-dependent by design; the persisted diagnostic/ journal rows above are the authoritative record.
  if (x.events !== y.events) console.log(`${name}: (info) live diagnostic event stream differs — timing-dependent, not compared`);
  if (x.project !== y.project) diff.push('<returned project>');
  if (diff.length) {
    differences += diff.length;
    console.log(`${name}: ${diff.length} differing rows\n  ${diff.slice(0, 12).join('\n  ')}${diff.length > 12 ? '\n  …' : ''}`);
  } else console.log(`${name}: identical (${Object.keys(x.rows).length} rows)`);
}
console.log(differences ? `DIFFERENT: ${differences}` : 'IDENTICAL');
Deno.exit(differences ? 1 : 0);
