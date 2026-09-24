/** Generates dist/THIRD_PARTY_NOTICES.txt at build time: every Rust crate compiled into the Wasm core and every
 *  npm/jsr package bundled into a JS asset. Both lists are *detected*, not hand-kept, so the file can't drift from
 *  what actually ships:
 *   - Rust: `cargo about generate --format json` (rust/**'s own dependency graph via `cargo metadata`) when
 *     `cargo-about` (https://github.com/EmbarkStudios/cargo-about) is on PATH — `cargo install --locked cargo-about
 *     --features cli` installs it; scripts/notices-about.toml is its config, kept beside this script (the only
 *     thing that reads it) rather than inside rust/, which is the Rust crate itself. Falls back to `cargo metadata`
 *     + each crate's vendored license file in the local cargo registry cache when cargo-about isn't installed.
 *   - JS: `deno info --json <entry>` for every bundle entry point (the same list scripts/build.ts bundles), which
 *     gives the resolved module graph; any specifier that isn't a local `file://` module is a bundled dependency.
 *     License text comes from the local npm/jsr cache (both already downloaded for the build to have worked at
 *     all) — no extra network call beyond what `deno bundle` already made.
 *  Fails (throws) if a bundled dependency's license can't be discovered, rather than silently shipping one with no
 *  notice — see the `--fail`-shaped checks below. MPL-2.0 dependencies get an extra "exact source available at"
 *  line, which MPL-2.0 §3.2 requires when distributing only object/compiled form (true for both the Wasm core and
 *  the minified JS bundles). */
import { dirname, fromFileUrl, join } from '@std/path';

export interface NoticeEntry {
  ecosystem: 'rust' | 'js';
  name: string;
  version: string;
  license: string;
  /** Where the exact source of this version can be obtained — required in the output for MPL-2.0, included when
   *  known for everything else. */
  sourceUrl?: string;
  licenseText?: string;
}

async function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await new Deno.Command(cmd, { args, cwd, stdout: 'piped', stderr: 'piped' }).output();
  return { ok: result.success, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    return (await new Deno.Command(cmd, { args: ['--version'], stdout: 'null', stderr: 'null' }).output()).success;
  } catch {
    return false;
  }
}

// cargo-about's JSON schema (undocumented as a formal spec, observed from `cargo about generate --format json`):
// { crates: [{ package: { name, version, source, repository, license, license_file }, license }],
//   licenses: [{ id, name, text, used_by: [{ crate: { name, version } }] }] }
interface AboutJson {
  crates: { package: { name: string; version: string; source: string | null; repository: string | null }; license: string }[];
  licenses: { id: string; name: string; text: string; used_by: { crate: { name: string; version: string } }[] }[];
}

/** Third-party (non-workspace) Rust crates compiled into rust/core, via cargo-about when installed. */
async function rustNoticesViaCargoAbout(root: string): Promise<NoticeEntry[] | undefined> {
  if (!await commandExists('cargo-about')) {
    return undefined;
  }
  const configPath = join(root, 'scripts/notices-about.toml');
  const result = await run('cargo', [
    'about',
    'generate',
    '--format',
    'json',
    '--workspace',
    '--manifest-path',
    join(root, 'rust/Cargo.toml'),
    '-c',
    configPath,
  ], root);
  if (!result.ok) {
    throw new Error(`cargo about generate failed (rust/core dependency licenses):\n${result.stderr}`);
  }
  const parsed: AboutJson = JSON.parse(result.stdout);
  const textFor = new Map<string, { id: string; text: string }>();
  for (const license of parsed.licenses) {
    for (const used of license.used_by) {
      textFor.set(`${used.crate.name}@${used.crate.version}`, { id: license.id, text: license.text });
    }
  }
  const entries: NoticeEntry[] = [];
  for (const crate of parsed.crates) {
    if (crate.package.source === null) {
      continue; // workspace-local crate (long-screen-core itself), not a third-party dependency
    }
    const found = textFor.get(`${crate.package.name}@${crate.package.version}`);
    if (!found) {
      throw new Error(
        `cargo-about accepted a license for ${crate.package.name} ${crate.package.version} (${crate.license}) but its ` +
          `full text wasn't in the JSON output — scripts/notices-about.toml's accepted list may need a wider match.`,
      );
    }
    entries.push({
      ecosystem: 'rust',
      name: crate.package.name,
      version: crate.package.version,
      license: found.id,
      sourceUrl: crate.package.repository ?? `https://crates.io/crates/${crate.package.name}/${crate.package.version}`,
      licenseText: found.text,
    });
  }
  return entries;
}

/** Fallback when cargo-about isn't installed: `cargo metadata` for the dependency list and declared license, plus
 *  the crate's own vendored license file(s) in the local cargo registry source cache (already downloaded — cargo
 *  can't have built the core without it) as the license text. */
async function rustNoticesViaCargoMetadata(root: string): Promise<NoticeEntry[]> {
  const result = await run('cargo', ['metadata', '--format-version', '1', '--manifest-path', join(root, 'rust/Cargo.toml')], root);
  if (!result.ok) {
    throw new Error(`cargo metadata failed (rust/core dependency licenses):\n${result.stderr}`);
  }
  const meta: {
    packages: {
      name: string;
      version: string;
      source: string | null;
      license: string | null;
      license_file: string | null;
      repository: string | null;
      manifest_path: string;
    }[];
    workspace_members: string[];
    resolve: { nodes: { id: string; deps: { pkg: string }[] }[]; root: string | null } | null;
  } = JSON.parse(result.stdout);
  const cargoHome = Deno.env.get('CARGO_HOME') || join(Deno.env.get('HOME') || '', '.cargo');
  const entries: NoticeEntry[] = [];
  for (const pkg of meta.packages) {
    if (pkg.source === null) {
      continue; // workspace-local
    }
    if (!pkg.license) {
      throw new Error(
        `${pkg.name} ${pkg.version} (a rust/core dependency) has no 'license' field in its Cargo.toml. Install cargo-about ` +
          `(cargo install --locked cargo-about --features cli) for a more thorough license search, or resolve this by hand.`,
      );
    }
    let licenseText: string | undefined;
    if (pkg.license_file) {
      licenseText = await Deno.readTextFile(join(dirname(pkg.manifest_path), pkg.license_file)).catch(() => undefined);
    }
    if (!licenseText) {
      // The registry checkout of this exact version, wherever cargo cached it: registry/src/<index-host-hash>/<name>-<version>/.
      try {
        for await (const indexDir of Deno.readDir(join(cargoHome, 'registry', 'src'))) {
          const crateDir = join(cargoHome, 'registry', 'src', indexDir.name, `${pkg.name}-${pkg.version}`);
          for (const candidate of ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
            licenseText = await Deno.readTextFile(join(crateDir, candidate)).catch(() => undefined);
            if (licenseText) break;
          }
          if (licenseText) break;
        }
      } catch {
        // registry/src absent (e.g. a from-scratch CARGO_HOME): fall through to the "no license found" error below.
      }
    }
    if (!licenseText) {
      throw new Error(
        `${pkg.name} ${pkg.version} declares license "${pkg.license}" but no license file could be found (checked ` +
          `Cargo.toml's license_file and the local cargo registry cache). Install cargo-about for a more thorough ` +
          `search, or resolve this by hand.`,
      );
    }
    entries.push({
      ecosystem: 'rust',
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      sourceUrl: pkg.repository ?? `https://crates.io/crates/${pkg.name}/${pkg.version}`,
      licenseText,
    });
  }
  return entries;
}

async function rustNotices(root: string): Promise<NoticeEntry[]> {
  return await rustNoticesViaCargoAbout(root) ?? await rustNoticesViaCargoMetadata(root);
}

interface DenoInfoJson {
  modules: { specifier: string; kind?: string; npmPackage?: string }[];
  npmPackages: Record<string, { name: string; version: string; localPath: string; dependencies: string[] }>;
}

/** Every non-local module specifier that `deno info` resolved for the given browser bundle entry points (the same
 *  list scripts/build.ts bundles), deduplicated to one (ecosystem, name, version) per package. */
async function jsDependencyIdentities(
  root: string,
  entries: readonly string[],
): Promise<{ ecosystem: 'npm' | 'jsr'; name: string; version: string }[]> {
  const seen = new Map<string, { ecosystem: 'npm' | 'jsr'; name: string; version: string }>();
  for (const entry of entries) {
    const result = await run(Deno.execPath(), ['info', '--json', join(root, entry)], root);
    if (!result.ok) {
      throw new Error(`deno info --json ${entry} failed:\n${result.stderr}`);
    }
    const info: DenoInfoJson = JSON.parse(result.stdout);
    // `info.npmPackages` is the *whole resolved lockfile's* npm packages (e.g. it always lists the `playwright`
    // devDependency, even for an entry point that imports nothing from npm) — not what this entry actually pulls
    // in. Only a `modules` entry with kind 'npm' proves this entry's graph reached that package; from there, walk
    // its own transitive npm dependencies (which its code can import, and `deno bundle` would inline) via
    // `npmPackages[id].dependencies`.
    const addNpm = (id: string) => {
      const pkg = info.npmPackages[id];
      if (!pkg || seen.has(`npm:${pkg.name}@${pkg.version}`)) {
        return;
      }
      seen.set(`npm:${pkg.name}@${pkg.version}`, { ecosystem: 'npm', name: pkg.name, version: pkg.version });
      for (const dep of pkg.dependencies) {
        addNpm(dep);
      }
    };
    for (const mod of info.modules) {
      if (mod.kind === 'npm' && mod.npmPackage) {
        addNpm(mod.npmPackage);
        continue;
      }
      const jsr = mod.specifier.match(/^https:\/\/jsr\.io\/(@[^/]+\/[^/]+)\/([^/]+)\//);
      if (jsr) {
        seen.set(`jsr:${jsr[1]}@${jsr[2]}`, { ecosystem: 'jsr', name: jsr[1], version: jsr[2] });
      }
    }
  }
  return [...seen.values()];
}

/** The npm package cache directory Deno actually resolved for this run — `deno info --json` (no entry point)
 *  reports the live `npmCache` path, so this tracks DENO_DIR/registry overrides instead of assuming the default
 *  macOS cache location (the previous hard-coded `~/Library/Caches/deno` broke on Linux CI and any DENO_DIR override,
 *  and silently produced a path that never matched, which is why licenseText was never set below). */
async function npmCacheRoot(root: string): Promise<string> {
  const result = await run(Deno.execPath(), ['info', '--json'], root);
  if (!result.ok) {
    throw new Error(`deno info --json (npm cache location) failed:\n${result.stderr}`);
  }
  const info: { npmCache: string } = JSON.parse(result.stdout);
  return join(info.npmCache, 'registry.npmjs.org');
}

async function jsNotices(root: string, entries: readonly string[]): Promise<NoticeEntry[]> {
  const identities = await jsDependencyIdentities(root, entries);
  const results: NoticeEntry[] = [];
  const npmCache = await npmCacheRoot(root);
  for (const dep of identities) {
    if (dep.ecosystem === 'npm') {
      const pkgDir = join(npmCache, dep.name, dep.version);
      const pkgJsonPath = join(pkgDir, 'package.json');
      const pkgJson = await Deno.readTextFile(pkgJsonPath).then(JSON.parse).catch(() => undefined);
      const license = pkgJson?.license ??
        (Array.isArray(pkgJson?.licenses) ? pkgJson.licenses.map((l: { type: string }) => l.type).join(' OR ') : undefined);
      if (!license) {
        throw new Error(`npm package ${dep.name}@${dep.version} (bundled into a JS asset) has no discoverable license in ${pkgJsonPath}.`);
      }
      let licenseText: string | undefined;
      for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE.MIT', 'license']) {
        licenseText = await Deno.readTextFile(join(pkgDir, candidate)).catch(() => undefined);
        if (licenseText) break;
      }
      if (!licenseText) {
        throw new Error(
          `npm package ${dep.name}@${dep.version} (bundled into a JS asset) declares license "${license}" but no license ` +
            `file was found in ${pkgDir} — the notices file would ship without its required text.`,
        );
      }
      results.push({
        ecosystem: 'js',
        name: dep.name,
        version: dep.version,
        license,
        sourceUrl: `https://www.npmjs.com/package/${dep.name}/v/${dep.version}`,
        licenseText,
      });
    } else {
      // jsr's package-version API carries the license SPDX id it computed at publish time (most jsr packages don't
      // repeat a `license` field in their own deno.json — it lives at the registry level instead). No local cache
      // holds this, so it's a network read (generic request, no identifying headers, jsr.io only — see the
      // --allow-net=jsr.io grant on the build task).
      const apiUrl = `https://api.jsr.io/scopes/${dep.name.slice(1).split('/')[0]}/packages/${
        dep.name.split('/')[1]
      }/versions/${dep.version}`;
      const response = await fetch(apiUrl, { headers: { 'user-agent': 'long-screen-notices' } }).catch(() => undefined);
      const meta = response?.ok ? await response.json().catch(() => undefined) : undefined;
      const license: string | undefined = meta?.license;
      if (!license) {
        throw new Error(
          `jsr package ${dep.name}@${dep.version} (bundled into a JS asset) has no discoverable license (checked ${apiUrl}).`,
        );
      }
      // Best-effort license text: jsr serves each package version's raw files at a predictable URL; not every
      // package ships one at the root (e.g. it may live one level up, in a monorepo's shared LICENSE), so this is
      // supplementary — the SPDX id above is what the notice is built on either way.
      let licenseText: string | undefined;
      for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
        const res = await fetch(`https://jsr.io/${dep.name}/${dep.version}/${candidate}`).catch(() => undefined);
        if (res?.ok) {
          licenseText = await res.text();
          break;
        }
      }
      results.push({
        ecosystem: 'js',
        name: dep.name,
        version: dep.version,
        license,
        sourceUrl: `https://jsr.io/${dep.name}@${dep.version}`,
        licenseText,
      });
    }
  }
  return results;
}

const MPL_PREFIX = 'MPL-2.0';

function renderSection(title: string, emptyNote: string, entries: NoticeEntry[]): string {
  if (entries.length === 0) {
    return `## ${title}\n\n${emptyNote}\n`;
  }
  const parts = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const lines = [`${e.name} ${e.version} — ${e.license}`];
      if (e.sourceUrl) {
        lines.push(`Source: ${e.sourceUrl}`);
      }
      if (e.license.includes(MPL_PREFIX) && e.sourceUrl) {
        lines.push(`Exact source for this version (MPL-2.0 §3.2): ${e.sourceUrl}`);
      }
      if (e.licenseText) {
        lines.push('', e.licenseText.trimEnd());
      }
      return lines.join('\n');
    });
  return `## ${title}\n\n${parts.join('\n\n' + '-'.repeat(72) + '\n\n')}\n`;
}

/** Builds the full THIRD_PARTY_NOTICES.txt text for a build whose JS bundle entry points are `jsEntries` (paths
 *  relative to `root`, matching scripts/build.ts's own `entries` list for that build — a production build that
 *  drops testkit.js should pass the same trimmed list it bundles). */
export async function generateNotices(root: string, jsEntries: readonly string[]): Promise<string> {
  const [rust, js] = await Promise.all([rustNotices(root), jsNotices(root, jsEntries)]);
  return [
    'Long Screen — Third-Party Notices',
    '',
    'This file is generated at build time (scripts/notices.ts, called from scripts/build.ts) from the actual',
    "dependency graph — `cargo metadata`/`cargo-about` for rust/core and `deno info`'s module graph for the",
    'bundled JS assets — not hand-maintained. Regenerate it by rebuilding (`deno task build` / `deno task build:prod`).',
    '',
    renderSection(
      'Rust crates compiled into the WebAssembly core',
      'rust/core has no third-party crate dependencies (verified via cargo-about/cargo metadata at build time).',
      rust,
    ),
    renderSection(
      'npm/jsr packages bundled into the JS assets',
      "No npm or jsr package is bundled into dist/assets/*.js (verified via `deno info`'s module graph at build " +
        "time) — every module in the bundle is this project's own src/**.",
      js,
    ),
  ].join('\n');
}

if (import.meta.main) {
  const root = fromFileUrl(new URL('..', import.meta.url));
  const entries = Deno.args.length
    ? Deno.args
    : ['src/ui/main.ts', 'src/worker.ts', 'src/core/helper.ts', 'src/media/convert-worker.ts', 'src/device-check.ts'];
  console.log(await generateNotices(root, entries));
}
