// Compares two `<label>-pass-N.tiles.json` fingerprint files (written by benchmark-pipeline.ts --verify-tiles) tile
// by tile and field by field, so a changed run hash can be traced to the tiles and evidence arrays that differ.
// Exit status 1 when anything differs. Usage: deno run --allow-read scripts/compare-tiles.ts a.tiles.json b.tiles.json
interface TileFingerprint {
  key: string;
  hashes: Record<string, string>;
}
const [a, b] = Deno.args;
if (!a || !b) {
  console.error('usage: compare-tiles.ts a.tiles.json b.tiles.json');
  Deno.exit(2);
}
const load = async (file: string) =>
  new Map((JSON.parse(await Deno.readTextFile(file)) as TileFingerprint[]).map((t) => [t.key, t.hashes]));
const [left, right] = await Promise.all([load(a), load(b)]);
const differing: Record<string, string[]> = {};
for (const key of new Set([...left.keys(), ...right.keys()])) {
  const x = left.get(key), y = right.get(key);
  if (!x || !y) {
    (differing[x ? 'only-in-a' : 'only-in-b'] ??= []).push(key);
    continue;
  }
  for (const field of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (x[field] !== y[field]) (differing[field] ??= []).push(key);
  }
}
const fields = Object.fromEntries(
  Object.entries(differing).map(([field, keys]) => [field, { tiles: keys.length, first: keys.sort().slice(0, 10) }]),
);
console.log(JSON.stringify({ tiles: [left.size, right.size], identical: !Object.keys(fields).length, fields }, null, 2));
if (Object.keys(fields).length) Deno.exit(1);
