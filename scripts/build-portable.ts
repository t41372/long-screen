/** Builds dist-portable/: one self-contained HTML file a locked-down machine can open with `file://` (double-click,
 *  no server, no install), zipped next to a Simplified-Chinese README. Runs `deno task build:prod` first (a
 *  dependency in deno.json) and only rewrites its *output*; nothing under src/, static/, rust/ or scripts/build.ts
 *  changes, so this file is the entire cost of the portable variant and can be dropped or cherry-picked on its own.
 *
 *  Why a page opened from disk needs surgery at all — every fact below was checked with Chrome stable and
 *  Playwright WebKit against a page opened from file://, not assumed:
 *   - `fetch()` of any file, `new Worker(fileURL)` and blob *module* workers (Chrome) all fail on file:// — an
 *     opaque origin. Classic (non-module) blob Workers work; `new Function(...)`/blob `<script>` execution of
 *     plain scripts works; `WebAssembly.instantiateStreaming` works when handed a `Response` built from bytes.
 *   - The production bundles (`deno bundle --minify`) are ESM with no top-level `await` and, apart from `new
 *     URL('./x', import.meta.url)`, no runtime dependency on module semantics — so each one can be wrapped as a
 *     plain classic-script IIFE with `import.meta.url` replaced by an injected base href.
 *   - `crossOriginIsolated` is always false on file://, so src/core/wasm/loader.ts's `planCore` always picks the
 *     single-thread simd/scalar core; the threads wasm and core-helper.js are never reached and are not shipped.
 *   - A blob URL made on the page cannot be handed to a worker (opaque-origin fetch/Worker again), so each worker
 *     context must rebuild its own blob URLs from embedded text — hence `installPortable` re-serializes itself
 *     into the classic-worker source it constructs.
 *   - Chromium only (Chrome, Edge). WebKit runs the built-in demos but, from file://, a worker cannot read the File
 *     the user picked ("The I/O read operation failed") and a <video> cannot load its blob URL, so a real recording
 *     never gets past the probe; routing file reads through the page would need changes under src/.
 *
 *  Every path below is resolved from this script's own location, like scripts/build.ts. */
import { fromFileUrl, join } from '@std/path';
import { zipSync } from 'fflate';

const root = fromFileUrl(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const out = join(root, 'dist-portable');

function readDist(rel: string): Promise<string>;
function readDist(rel: string, binary: true): Promise<Uint8Array>;
async function readDist(rel: string, binary?: true): Promise<string | Uint8Array> {
  const path = join(dist, rel);
  try {
    return binary ? await Deno.readFile(path) : await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`dist/${rel} is missing. Run \`deno task build:portable\` (it builds dist/ first).`);
    }
    throw error;
  }
}

try {
  await Deno.stat(join(dist, 'assets', 'testkit.js'));
  throw new Error(
    'dist/ is a dev build (dist/assets/testkit.js exists, which ships source-map links). Run `deno task build:portable` — ' +
      'it rebuilds dist/ with `deno task build:prod` first.',
  );
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

// --- 1/2: read + wrap the three bundles the portable page actually loads (main, worker, convert-worker; the
// threads-only core-helper.js is never reached from file://, see the module doc comment). ---
const html = await readDist('index.html');
const css = await readDist('style.css');
const icon = await readDist('icon.svg');
const notices = await readDist('THIRD_PARTY_NOTICES.txt');
const bundleNames = ['main.js', 'worker.js', 'convert-worker.js'] as const;
const wrappedScripts: Record<string, string> = {};
for (const name of bundleNames) {
  const code = (await readDist(`assets/${name}`)).replaceAll('import.meta.url', '__LS_BASE__');
  if (code.includes('import.meta')) {
    throw new Error(`dist/assets/${name}: an import.meta reference survived the import.meta.url rewrite.`);
  }
  const wrapped = `((__LS_BASE__) => {"use strict";\n${code}\n})(new URL("assets/${name}", self.__LS_PAGE__).href);`;
  try {
    new Function(wrapped); // parses only, never runs — catches leftover import/export/top-level-await.
  } catch (error) {
    throw new Error(`dist/assets/${name} did not parse as a classic script after wrapping: ${(error as Error).message}`);
  }
  wrappedScripts[name] = wrapped;
}
const wasmNames = ['core.simd.wasm', 'core.wasm'] as const;
const wasmB64: Record<string, string> = {};
for (const name of wasmNames) {
  wasmB64[name] = encodeBase64(await readDist(`assets/${name}`, true));
}

// --- 3: the payload the runtime shim reads. `</script>`/`<!--` are neutralised by escaping `<`; the bundles do
// contain literal `</script>` text (src/export/offline.ts writes an HTML offline viewer). ---
const payload = { scripts: wrappedScripts, wasm: wasmB64 };
const payloadJSON = JSON.stringify(payload).replace(/</g, '\\u003c');

// --- 4: the runtime shim. Self-contained on purpose: it is never called from this module's scope, only ever
// serialized (installPortable.toString()) into the page's bootstrap script and, from there, into each nested
// classic worker's source — so it re-embeds its own source text to keep working after that second hop. ---
function installPortable(payload: PortablePayload, pageHref: string): void {
  const self = globalThis as unknown as {
    __LS_PAGE__?: string;
    fetch: typeof fetch;
    Worker?: typeof Worker;
    atob: (s: string) => string;
  };
  self.__LS_PAGE__ = pageHref;
  const assetHref = (name: string): string => new URL('assets/' + name, pageHref).href;
  const scriptHrefs: Record<string, string> = {};
  for (const name of Object.keys(payload.scripts)) scriptHrefs[assetHref(name)] = name;
  const wasmHrefs: Record<string, string> = {};
  for (const name of Object.keys(payload.wasm)) wasmHrefs[assetHref(name)] = name;
  const wasmBytesCache: Record<string, Uint8Array> = {};
  const decodeBase64 = (b64: string): Uint8Array => {
    const bin = self.atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  const hrefOf = (input: unknown): string => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return (input as Request).url;
  };
  const nativeFetch = self.fetch.bind(self);
  self.fetch = ((input: unknown, init?: RequestInit) => {
    const href = hrefOf(input);
    const wasmName = wasmHrefs[href];
    if (wasmName) {
      const bytes = wasmBytesCache[wasmName] ??= decodeBase64(payload.wasm[wasmName]);
      return Promise.resolve(new Response(bytes as BodyInit, { headers: { 'content-type': 'application/wasm' } }));
    }
    return nativeFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const NativeWorker = self.Worker;
  if (typeof NativeWorker === 'function') {
    self.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        const href = hrefOf(url);
        const name = scriptHrefs[href];
        if (!name) {
          super(url as string | URL, options);
          return;
        }
        const prelude = `(${installPortable.toString()})(${JSON.stringify(payload)}, ${JSON.stringify(pageHref)});\n`;
        const blob = new Blob([prelude + payload.scripts[name]], { type: 'text/javascript' });
        const blobURL = URL.createObjectURL(blob);
        super(blobURL, { ...options, type: 'classic' });
      }
    } as unknown as typeof Worker;
  }
}
interface PortablePayload {
  scripts: Record<string, string>;
  wasm: Record<string, string>;
}

// --- 5: HTML. Every replacement must match exactly once, so drift after a future fix round fails the build loudly
// instead of silently shipping a page that still points at ./assets/. ---
function replaceOnce(text: string, needle: string, replacement: string, label: string): string {
  const parts = text.split(needle);
  if (parts.length !== 2) {
    throw new Error(`dist/index.html: expected exactly one occurrence of ${label}, found ${parts.length - 1}.`);
  }
  return parts[0] + replacement + parts[1];
}
if (css.includes('</style')) throw new Error('dist/style.css contains a literal "</style" — cannot inline it as <style>.');
let page = html;
page = replaceOnce(
  page,
  '<link rel="stylesheet" href="./style.css">',
  `<style>${css}</style>`,
  '<link rel="stylesheet" href="./style.css">',
);
page = replaceOnce(
  page,
  'href="./icon.svg"',
  `href="data:image/svg+xml;base64,${encodeBase64(new TextEncoder().encode(icon))}"`,
  'href="./icon.svg"',
);
page = replaceOnce(page, 'href="./"', 'href=""', 'the brand link href="./"');
const bootstrap = `<script type="application/json" id="long-screen-portable">${payloadJSON}</script>
<script>(function () {
  var data = JSON.parse(document.getElementById('long-screen-portable').textContent);
  (${installPortable.toString()})(data, location.href);
  var code = data.scripts['main.js'];
  var blobURL = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  var s = document.createElement('script');
  s.src = blobURL;
  s.onerror = function () { console.error('long-screen portable: main.js blob script failed to load'); };
  document.body.appendChild(s);
})();</script>`;
page = replaceOnce(
  page,
  '<script type="module" src="./assets/main.js"></script>',
  bootstrap,
  '<script type="module" src="./assets/main.js">',
);
const hash = await gitShortHash(root);
const stamp = new Date().toISOString();
page = replaceOnce(page, '<!doctype html>', `<!doctype html>\n<!-- Long Screen portable build · ${hash} · ${stamp} -->`, '<!doctype html>');
if (page.includes('./assets/')) throw new Error('dist/index.html: a ./assets/ reference survived rewriting.');
if (/src="\.\//.test(page)) throw new Error('dist/index.html: a src="./..." reference survived rewriting.');
if (/href="\.\/(?!THIRD_PARTY_NOTICES\.txt")/.test(page)) {
  throw new Error('dist/index.html: a href="./..." reference (other than THIRD_PARTY_NOTICES.txt) survived rewriting.');
}

// --- 6: write dist-portable/. ---
await Deno.remove(out, { recursive: true }).catch(() => {});
const folder = join(out, 'long-screen');
await Deno.mkdir(folder, { recursive: true });
const htmlPath = join(folder, 'long-screen.html');
await Deno.writeTextFile(htmlPath, page);
const noticesPath = join(folder, 'THIRD_PARTY_NOTICES.txt');
await Deno.writeTextFile(noticesPath, notices);
const readme = readmeText(hash, stamp);
const readmePath = join(folder, 'README.txt');
const readmeBytes = new TextEncoder().encode('﻿' + readme.replaceAll('\n', '\r\n'));
await Deno.writeFile(readmePath, readmeBytes);

const zipped = zipSync({
  'long-screen': {
    'long-screen.html': new TextEncoder().encode(page),
    'THIRD_PARTY_NOTICES.txt': new TextEncoder().encode(notices),
    'README.txt': readmeBytes,
  },
});
const zipPath = join(out, `long-screen-portable-${hash}.zip`);
await Deno.writeFile(zipPath, zipped);

for (const p of [htmlPath, noticesPath, readmePath, zipPath]) {
  const size = (await Deno.stat(p)).size;
  console.log(`${p.slice(root.length)} (${(size / 1024).toFixed(1)} KB)`);
}
console.log('Built dist-portable/ — a single file/folder that opens over file:// (double-click, no server).');

async function gitShortHash(cwd: string): Promise<string> {
  const result = await new Deno.Command('git', { args: ['rev-parse', '--short', 'HEAD'], cwd, stdout: 'piped', stderr: 'piped' }).output();
  if (!result.success) throw new Error('git rev-parse --short HEAD failed; is this a git checkout?');
  return new TextDecoder().decode(result.stdout).trim();
}
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function readmeText(hash: string, stamp: string): string {
  const date = stamp.slice(0, 10);
  return `Long Screen 便携版（${hash}，${date}）

用法：解压整个文件夹，用 Chrome 或 Edge 打开 long-screen.html：双击，或拖进浏览器窗口。不需要安装软件，不需要网络；录屏和结果都不会离开这台电脑。

要选的文件：一段滚动页面的屏幕录影，MP4、MOV、WebM 或 MKV。Windows 可用“截图工具”的录制功能或 Xbox Game Bar（Win+Alt+R），Mac 用 ⌘⇧5，手机用系统自带的屏幕录制。文档、图片和 AVI / WMV / GIF 等其他格式会被直接拒绝并说明原因。

浏览器：只支持 Chrome 和 Edge。Mac 上双击默认用 Safari 打开，请改用右键 →“打开方式”→ Chrome。Safari 打开后读不了你选的视频文件；Firefox 没有测试过。不要用无痕 / 隐私窗口，关掉窗口项目就没了。

须知：
- 这是单线程版本，重建结果和网页版相同。
- 导出时会弹出“另存为”直接写入磁盘。如果公司策略禁用了这个对话框，会改成浏览器下载，这时单个导出文件上限 1 GB。
- 项目保存在这个浏览器的本地存储里。清除浏览器数据会删除它们，重要结果请导出。
`;
}
