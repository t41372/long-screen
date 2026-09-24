/** Refactor-equivalence fingerprint: runs every synthetic scenario through the Engine and hashes EVERY row the run
 *  persisted (tiles, evidence, plans, observations, consistency verdicts, diagnostics, canvases, graph, regions…),
 *  normalised only for the random run id and wall-clock fields. A first-class repo script (not an external tool),
 *  so any tree can fingerprint itself with its own deno.json/config (no --config flag needed) and no <root>
 *  argument.
 *
 *  Usage: deno run -A scripts/fingerprint-scenarios.ts <out.json> [--root <otherRepoRoot>] [--pixels] [scenario…]
 *  Without --root, fingerprints this checkout (dynamic-imports its own modules, resolved relative to this script).
 *  With --root, fingerprints the checkout at that path instead — for an A/B compare against a baseline worktree,
 *  e.g. `deno run -A scripts/fingerprint-scenarios.ts out.json --root ../baseline`. The <root> tree is fingerprinted
 *  under ITS OWN deno.json (import map, compiler options, lockfile) by re-spawning this same script with
 *  `--config <root>/deno.json`: a tree being compared can be on a different @std/* version or have different
 *  compilerOptions, and loading its modules through THIS tree's config would silently resolve those imports wrong.
 *  The child receives the target root via LONGSCREEN_FP_ROOT (not --root again), so it runs the body below once,
 *  instead of re-spawning itself.
 *
 *  --pixels: hash every `image/png` Blob by its DECODED pixels ({width,height,sha(RGBA)}, via the fingerprinted
 *  tree's own src/codec/png.ts decodePNG) instead of its raw bytes. Everything else (non-PNG blobs, all other rows)
 *  is unchanged. Used to prove a PNG-codec change alters only bytes, never decoded pixels: run --pixels on two
 *  trees with different codecs and the output must still be IDENTICAL. */
import { fromFileUrl, resolve as resolvePath } from '@std/path';

const argv = Deno.args.slice();
let rootArg: string | undefined;
const rootFlag = argv.indexOf('--root');
if (rootFlag !== -1) {
  rootArg = argv[rootFlag + 1];
  argv.splice(rootFlag, 2);
}
let PIXELS = false;
const pixelsFlag = argv.indexOf('--pixels');
if (pixelsFlag !== -1) {
  PIXELS = true;
  argv.splice(pixelsFlag, 1);
}
const [outArg, ...only] = argv;

if (rootArg !== undefined) {
  const targetRoot = await Deno.realPath(rootArg);
  const out = resolvePath(outArg); // absolute before spawning, in case the child's cwd differs from ours
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '-A',
      '--config',
      `${targetRoot}/deno.json`,
      fromFileUrl(import.meta.url),
      out,
      ...(PIXELS ? ['--pixels'] : []),
      ...only,
    ],
    env: { ...Deno.env.toObject(), LONGSCREEN_FP_ROOT: targetRoot },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const { code } = await child.output();
  Deno.exit(code);
}

const rootDir = Deno.env.get('LONGSCREEN_FP_ROOT') ?? fromFileUrl(new URL('../', import.meta.url));
const out = outArg;
const root = new URL(`file://${await Deno.realPath(rootDir)}/`);
await import(new URL('tests/support/core.ts', root).href);
const { SCENARIO_NAMES, buildScenario } = await import(new URL('src/synthetic/scenarios.ts', root).href);
const { Engine } = await import(new URL('src/pipeline/engine.ts', root).href);
// Only imported in --pixels mode: decodes PNG blobs with the FINGERPRINTED tree's own decoder (this tree's, or the
// --root tree's when respawned above), so a codec change is exercised through the same code path production uses.
const { decodePNG } = PIXELS ? await import(new URL('src/codec/png.ts', root).href) : { decodePNG: undefined };
const { MemoryKV } = await import(new URL('src/storage/db.ts', root).href);
const { ScenarioSource } = await import(new URL('src/synthetic/source.ts', root).href);
const { DEFAULT_SETTINGS } = await import(new URL('src/types.ts', root).href);

/** Fallback for a scenario built from a tree that predates Scenario.settings (e.g. the 6f838af baseline): without
 *  this, `--root <old tree>` runs factor4 at the DEFAULT_SETTINGS analysisSize (640) instead of the 480 the
 *  scenario needs for `factor: 4` (docs/ARCHITECTURE.md's downscale-factor invariant), producing a false NOT
 *  IDENTICAL from a difference the settings were always meant to paper over, not a real behaviour change. */
const LEGACY_SETTINGS: Record<string, Record<string, unknown>> = { factor4: { analysisSize: 480 } };

/** Wall-clock or host-dependent fields; everything else must be byte-identical. */
const VOLATILE = new Set(['created', 'updated', 'scanMS', 'solveMS', 'renderMS', 'framingMS', 'pyramidMS', 'compute', 'id']);

async function canon(v: unknown, id: string): Promise<unknown> {
  if (v instanceof Blob) {
    const bytes = new Uint8Array(await v.arrayBuffer());
    if (PIXELS && v.type === 'image/png') {
      const { width, height, data } = await decodePNG!(bytes);
      return { blob: v.type, pixels: { width, height, sha: await sha(data) } };
    }
    return { blob: v.type, sha: await sha(bytes) };
  }
  if (ArrayBuffer.isView(v)) {
    return { [v.constructor.name]: await sha(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  }
  if (v instanceof ArrayBuffer) return { ArrayBuffer: await sha(new Uint8Array(v)) };
  if (typeof v === 'string') return v.split(id).join('<run>');
  if (Array.isArray(v)) return Promise.all(v.map((x) => canon(x, id)));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    // Which analysis backend 'auto' picked is a host/timing measurement; the pixels must be bit-exact either way.
    const hostTimed = (v as { code?: string }).code === 'COMPUTE_BACKEND';
    // Insertion order is kept (not sorted): a refactor that reorders fields of a persisted row changes exported JSON bytes.
    for (const k of Object.keys(v)) {
      if (!VOLATILE.has(k) && !(hostTimed && (k === 'message' || k === 'detail'))) {
        o[k] = await canon((v as Record<string, unknown>)[k], id);
      }
    }
    return o;
  }
  return v;
}
async function sha(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

const names: string[] = only.length ? only : [...SCENARIO_NAMES, 'fixture'];
const result: Record<string, { rows: Record<string, string>; events: string; project: string; seconds: number }> = {};
for (const name of names) {
  const db = new MemoryKV(), events: unknown[] = [];
  const handlers = {
    progress: () => {},
    diagnostic: (d: unknown) => events.push(d),
    preview: () => {},
    project: () => {},
  };
  const started = performance.now();
  // The scenario's own `settings` field (e.g. factor4's analysisSize: 480) is the single source of truth — see
  // the `settings` field on Scenario in src/synthetic/world.ts — instead of a private per-scenario settings map
  // here. LEGACY_SETTINGS above only covers a tree fingerprinted via --root that predates that field.
  const scenario = buildScenario(name);
  let settings = scenario.settings;
  if (settings === undefined && Object.hasOwn(LEGACY_SETTINGS, name)) {
    settings = LEGACY_SETTINGS[name];
    console.error(`fingerprint-scenarios: ${name} has no scenario.settings — using LEGACY_SETTINGS fallback ${JSON.stringify(settings)}`);
  }
  const project = await new Engine(db, new ScenarioSource(scenario), { ...DEFAULT_SETTINGS, ...settings }, handlers).run();
  const rows: Record<string, string> = {};
  for (const [key, value] of [...db.data.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const k = key.split(project.id).join('<run>').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>');
    rows[k] = await sha(new TextEncoder().encode(JSON.stringify(await canon(value, project.id))));
  }
  result[name] = {
    rows,
    events: await sha(new TextEncoder().encode(JSON.stringify(await canon(events, project.id)))),
    project: await sha(new TextEncoder().encode(JSON.stringify(await canon(project, project.id)))),
    seconds: +((performance.now() - started) / 1000).toFixed(1),
  };
  console.log(`${name}: ${Object.keys(rows).length} rows, ${result[name].seconds}s`);
}
await Deno.writeTextFile(out, JSON.stringify(result, null, 1));
// Parked pool helpers (threads build) would keep the process alive.
Deno.exit(0);
