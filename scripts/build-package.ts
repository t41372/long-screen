/** Builds the npm package into dist-package/ (gitignored): Long Screen's reconstruction for other web pages.
 *
 *  Route (docs/ARCHITECTURE.md §十一, `src/package/`): the same `deno bundle` the app build uses, not @deno/dnt. The
 *  package is a Worker that loads one of three Wasm builds and two helper workers by `new URL('./x',
 *  import.meta.url)`; dnt converts a module tree into per-file npm modules and has no notion of those sibling files,
 *  and the worker has to be one self-contained file anyway. So the package is a flat directory of ready-to-serve
 *  files: the public entry `index.js` (+ `index.d.ts`), `worker.js`, `core-helper.js`, `convert-worker.js` and the
 *  three `core*.wasm`, plus package.json, README.md, LICENSE and THIRD_PARTY_NOTICES.txt. The directory is what
 *  `npm publish` uploads (.github/workflows/release-npm.yml, docs/RELEASING.md).
 *
 *  Every file reference in the bundles is a string-literal `new URL('./name', import.meta.url)`, the form Vite and
 *  webpack rewrite into emitted assets; the build fails if a bundle refers to a file the package lacks or
 *  loses that literal form. `index.d.ts` is src/package/types.ts, which declares the public types without importing
 *  anything (so they stand on their own), plus the `reconstruct` declaration; no TypeScript compiler is involved.
 *
 *  Usage: deno task build:package [--skip-core]. Verify with `npm pack --dry-run` inside dist-package/. */
import { ensureDir } from '@std/fs';
import { fromFileUrl, join } from '@std/path';
import { generateNotices } from './notices.ts';

const root = fromFileUrl(new URL('..', import.meta.url));
const outDir = join(root, 'dist-package'), staging = `${outDir}.build`;
const skipCore = Deno.args.includes('--skip-core');
/** The package's version follows the app's (deno.json). */
const version: string = JSON.parse(await Deno.readTextFile(join(root, 'deno.json'))).version;
/** The npm name `long-screen` was free on 2026-10-11 (registry.npmjs.org answered 404). */
const NPM_NAME = 'long-screen';
const bundles: [string, string][] = [
  ['src/package/index.ts', 'index.js'],
  ['src/worker.ts', 'worker.js'],
  ['src/core/helper.ts', 'core-helper.js'],
  ['src/media/convert-worker.ts', 'convert-worker.js'],
];
const wasm: [string, string][] = [
  ['rust/target/scalar/wasm32-unknown-unknown/release/long_screen_wasm.wasm', 'core.wasm'],
  ['rust/target/simd/wasm32-unknown-unknown/release/long_screen_wasm.wasm', 'core.simd.wasm'],
  ['rust/target/threads/wasm32-unknown-unknown/release/long_screen_wasm.wasm', 'core.threads.wasm'],
];
const docs = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'];

async function run(cmd: string, args: string[]): Promise<void> {
  const result = await new Deno.Command(cmd, { args, cwd: root, stdout: 'inherit', stderr: 'inherit' }).output();
  if (!result.success) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.code}).`);
}

await Deno.remove(staging, { recursive: true }).catch(() => {});
await ensureDir(staging);
try {
  if (!skipCore) await run('bash', [join(root, 'scripts/build-core.sh')]);
  for (const [source, name] of wasm) await Deno.copyFile(join(root, source), join(staging, name));
  for (const [input, name] of bundles) {
    await run(Deno.execPath(), ['bundle', '--platform', 'browser', '--quiet', '--minify', '-o', join(staging, name), join(root, input)]);
  }

  // Every sibling a bundle loads must ship, and must be referenced in the literal form bundlers recognise.
  const shipped = new Set([...bundles, ...wasm].map(([, name]) => name));
  const problems: string[] = [];
  for (const [, name] of bundles) {
    const text = await Deno.readTextFile(join(staging, name));
    for (const m of text.matchAll(/new URL\(([^()]*)\)/g)) {
      const literal = /^\s*["']\.\/([\w.-]+\.(?:js|wasm))["']\s*,\s*import\.meta\.url\s*$/.exec(m[1]);
      if (literal) {
        if (!shipped.has(literal[1])) problems.push(`${name}: ${m[0]} names a file the package does not ship`);
      } else if (/\.(?:js|wasm)["']/.test(m[1])) {
        problems.push(`${name}: ${m[0]} is not a literal new URL('./file', import.meta.url), so bundlers will not emit it`);
      }
    }
  }
  if (problems.length) throw new Error(`File references in the package bundles:\n  ${problems.join('\n  ')}`);

  // src/package/types.ts holds declarations only, so it is the declaration file as written; index.ts checks at compile
  // time that `reconstruct` matches its `Reconstruct` type. A line that imports or runs something would not stand
  // alone (or not be a declaration at all), so it fails the build.
  const types = await Deno.readTextFile(join(root, 'src/package/types.ts'));
  const runtime = types.split('\n').filter((line) =>
    /^\s*(?:import\b|export\s+(?:\*|\{|default\b|(?:async\s+)?(?:const|let|var|function|class|enum)\b))/.test(line)
  );
  if (runtime.length) throw new Error(`src/package/types.ts must hold declarations only:\n  ${runtime.join('\n  ')}`);
  // The function carries the same documentation as its type, so editors show it on `reconstruct` itself.
  const doc = /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*export type Reconstruct =/.exec(types)?.[1];
  if (!doc) throw new Error('src/package/types.ts: no documented `export type Reconstruct =` to declare `reconstruct` by.');
  const declaration = `\n${doc}\nexport declare const reconstruct: Reconstruct;\n`;
  await Deno.writeTextFile(join(staging, 'index.d.ts'), types + declaration);
  // Deno reads the types of a JavaScript module from this directive.
  const index = join(staging, 'index.js');
  await Deno.writeTextFile(index, `/* @ts-self-types="./index.d.ts" */\n${await Deno.readTextFile(index)}`);

  await Deno.copyFile(join(root, 'src/package/README.md'), join(staging, 'README.md'));
  await Deno.copyFile(join(root, 'LICENSE'), join(staging, 'LICENSE'));
  await Deno.writeTextFile(
    join(staging, 'THIRD_PARTY_NOTICES.txt'),
    await generateNotices(root, bundles.map(([input]) => input), { page: false }),
  );
  const files = [...shipped, 'index.d.ts', ...docs].sort();
  const description = 'Turn a screen recording into one big screenshot, in the browser: Long Screen’s reconstruction engine ' +
    '(Rust/WebAssembly in a Worker) for your own page.';
  await Deno.writeTextFile(
    join(staging, 'package.json'),
    JSON.stringify(
      {
        name: NPM_NAME,
        version,
        description,
        keywords: ['screen-recording', 'screenshot', 'stitching', 'panorama', 'webassembly', 'webcodecs', 'worker'],
        homepage: 'https://long-screen.yi-ting.com',
        bugs: 'https://github.com/t41372/long-screen/issues',
        repository: { type: 'git', url: 'git+https://github.com/t41372/long-screen.git' },
        license: 'MIT',
        author: 'Yi-Ting Chiu',
        type: 'module',
        exports: { '.': { types: './index.d.ts', default: './index.js' }, './package.json': './package.json' },
        types: './index.d.ts',
        files,
        sideEffects: false,
      },
      null,
      2,
    ) + '\n',
  );

  await Deno.remove(outDir, { recursive: true }).catch(() => {});
  await Deno.rename(staging, outDir);
  for (const name of [...files, 'package.json'].sort()) {
    console.log(`dist-package/${name} (${((await Deno.stat(join(outDir, name))).size / 1024).toFixed(1)} KB)`);
  }
  console.log(`Built ${NPM_NAME}@${version} in dist-package/.`);
} catch (error) {
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  throw error;
}
