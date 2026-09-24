/** Builds dist-portable/: one self-contained HTML file a locked-down machine can open with `file://` (double-click,
 *  no server, no install), zipped next to a Simplified-Chinese README. `deno task build:portable` first runs
 *  `deno task build:prod --out dist-portable/.site`, so the dist/ that `deno task start` serves (and a deploy
 *  uploads) is left alone, and this script only rewrites that build's *output*; nothing under src/, static/ or rust/
 *  changes for it.
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
 *   - Chromium only (Chrome, Edge). WebKit runs the synthetic test scenes but, from file://, a worker cannot read the File
 *     the user picked ("The I/O read operation failed") and a <video> cannot load its blob URL, so a real recording
 *     never gets past the probe; routing file reads through the page would need changes under src/.
 *
 *  Every path below is resolved from this script's own location, like scripts/build.ts. */
import { encodeBase64 } from '@std/encoding/base64';
import { fromFileUrl, join } from '@std/path';
import { zipSync } from 'fflate';

const root = fromFileUrl(new URL('..', import.meta.url));
const out = join(root, 'dist-portable');
const site = join(out, '.site');

function readDist(rel: string): Promise<string>;
function readDist(rel: string, binary: true): Promise<Uint8Array>;
async function readDist(rel: string, binary?: true): Promise<string | Uint8Array> {
  const path = join(site, rel);
  try {
    return binary ? await Deno.readFile(path) : await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`dist-portable/.site/${rel} is missing. Run \`deno task build:portable\` (it builds dist-portable/.site first).`);
    }
    throw error;
  }
}

const isDevBuild = await Deno.stat(join(site, 'assets', 'testkit.js')).then(() => true, (error) => {
  if (error instanceof Deno.errors.NotFound) return false;
  throw error;
});
if (isDevBuild) {
  throw new Error(
    'dist-portable/.site is a dev build (its assets/testkit.js exists, which ships source-map links). Run `deno task ' +
      'build:portable`, which rebuilds it with --production first.',
  );
}

// --- 1/2: read + wrap the three bundles the portable page actually loads (main, worker, convert-worker; the
// threads-only core-helper.js is never reached from file://, see the module doc comment). ---
const html = await readDist('index.html');
// A file:// page cannot load ./fonts/ either, so each font style.css names goes into it as a data: URL.
let css = await readDist('style.css');
for (const name of new Set([...css.matchAll(/url\(\.\/fonts\/([\w.-]+\.woff2)\)/g)].map((m) => m[1]))) {
  const data = encodeBase64(await readDist(`fonts/${name}`, true));
  css = css.replaceAll(`url(./fonts/${name})`, `url(data:font/woff2;base64,${data})`);
}
if (css.includes('url(./')) throw new Error('dist-portable/.site/style.css: a url(./...) reference survived font inlining.');
const icon = await readDist('icon.svg');
// The sample recording behind the demo button. The page fetches ./demo/sample.mp4, which file:// cannot serve, so the
// bytes ride along in the page and the bootstrap answers that one fetch from them. Page-only: it stays out of the
// payload, which every worker's source re-embeds.
const demoVideo = encodeBase64(await readDist('demo/sample.mp4', true));
const notices = await readDist('THIRD_PARTY_NOTICES.txt');
// `resolvesAssets`: the bundle locates a sibling asset (worker.js, the Wasm core, convert-worker.js) through
// `new URL('./x', import.meta.url)`, so the rewrite below must actually hit it; a bundle that stopped doing so
// would otherwise ship with those lookups resolving against the blob: URL and missing the shim's tables.
const bundles = [['main.js', true], ['worker.js', true], ['convert-worker.js', false]] as const;
const wrappedScripts: Record<string, string> = {};
for (const [name, resolvesAssets] of bundles) {
  const source = await readDist(`assets/${name}`);
  if (resolvesAssets && !source.includes('import.meta.url')) {
    throw new Error(`dist-portable/.site/assets/${name}: expected at least one import.meta.url to rewrite, found none.`);
  }
  const code = source.replaceAll('import.meta.url', '__LS_BASE__');
  if (code.includes('import.meta')) {
    throw new Error(`dist-portable/.site/assets/${name}: an import.meta reference survived the import.meta.url rewrite.`);
  }
  // A dynamic import() still parses in a classic script, so the parse check below cannot catch it, but it fails at
  // runtime on file:// like any other module load. The lookbehind skips a method named import (`x.import(`).
  if (/(?<![.\w$])import\s*\(/.test(code)) {
    throw new Error(`dist-portable/.site/assets/${name}: contains a dynamic import(), which cannot load from file://.`);
  }
  const wrapped = `((__LS_BASE__) => {"use strict";\n${code}\n})(new URL("assets/${name}", self.__LS_PAGE__).href);`;
  try {
    new Function(wrapped); // parses only, never runs — catches leftover static import/export/top-level-await.
  } catch (error) {
    throw new Error(`dist-portable/.site/assets/${name} did not parse as a classic script after wrapping: ${(error as Error).message}`);
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
  // One blob URL per script per context: `workerConverter` starts a convert worker for every opened source, and
  // each blob carries the whole payload (~2 MB), so rebuilding and never revoking one per construction leaks.
  const blobURLs: Record<string, string> = {};
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
        blobURLs[name] ??= URL.createObjectURL(
          new Blob([
            `(${installPortable.toString()})(${JSON.stringify(payload)}, ${JSON.stringify(pageHref)});\n`,
            payload.scripts[name],
          ], { type: 'text/javascript' }),
        );
        super(blobURLs[name], { ...options, type: 'classic' });
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
function replaceOnce(text: string, needle: string, replacement: string, label = needle): string {
  const parts = text.split(needle);
  if (parts.length !== 2) {
    throw new Error(`dist-portable/.site/index.html: expected exactly one occurrence of ${label}, found ${parts.length - 1}.`);
  }
  return parts[0] + replacement + parts[1];
}
if (css.includes('</style')) throw new Error('dist-portable/.site/style.css contains a literal "</style" — cannot inline it as <style>.');
let page = html;
page = replaceOnce(page, '<link rel="stylesheet" href="./style.css">', `<style>${css}</style>`);
page = replaceOnce(page, 'href="./icon.svg"', `href="data:image/svg+xml;base64,${encodeBase64(icon)}"`);
page = replaceOnce(page, 'href="./"', 'href=""', 'the brand link href="./"');
// What the page cannot tell a user on its own: a browser this build does not support (WebKit cannot read the picked
// file from file://, see the module doc comment; Firefox is untested), and an app that never started. main.ts
// publishes `window.longScreen` as the last step of its synchronous start-up, so a main.js that loaded but threw
// part-way leaves it unset; a worker that fails later is the app's own "Worker 错误" toast. The banners float over the
// top of the page, each with a close button, because the layout below is sized to the viewport (.workspace is
// 100dvh minus the header): a banner in the flow would push its controls off-screen. The <noscript> one goes first
// in <body> for the same reason. The UA test has no word boundary on purpose: headless Chrome reports itself as
// "HeadlessChrome/".
const OVERLAY_STYLE = 'position:fixed;top:0;left:0;right:0;z-index:40;box-shadow:0 4px 18px rgba(0,0,0,.18)';
const NOTICE_STYLE = 'display:flex;gap:16px;align-items:flex-start;padding:12px 30px;background:#834d3c;color:#fcfff6;' +
  'font-size:14px;line-height:1.7';
const CLOSE_STYLE = 'flex:none;background:none;border:1px solid rgba(252,255,246,.6);border-radius:6px;color:inherit;' +
  'font:inherit;padding:0 10px;cursor:pointer';
const BROWSER_NOTICE = '这个便携版只支持 Chrome 和 Edge。当前浏览器多半读不了录屏文件。' +
  '请用 Chrome 或 Edge 打开 long-screen.html（Mac：右键 →“打开方式”→ Chrome）。';
const START_NOTICE =
  'Long Screen 没能启动：页面脚本加载或运行失败。请用最新版 Chrome 或 Edge 打开，并确认浏览器或公司策略没有禁止本地网页运行脚本；' +
  '仍然失败时，把浏览器控制台（F12）里的报错发给提供这个文件的人。';
const noscript = `<noscript><div role="alert" style="${OVERLAY_STYLE};${NOTICE_STYLE}">Long Screen 需要 JavaScript：` +
  '请在 Chrome 或 Edge 中允许这个页面运行脚本。</div></noscript>';
const bootstrap = `<script type="application/json" id="long-screen-portable">${payloadJSON}</script>
<script type="text/plain" id="long-screen-demo">${demoVideo}</script>
<script>(function () {
  function notice(text) {
    var box = document.getElementById('portable-notices');
    if (!box) {
      box = document.createElement('div');
      box.id = 'portable-notices';
      box.style.cssText = ${JSON.stringify(OVERLAY_STYLE)};
      document.body.appendChild(box);
    }
    var el = document.createElement('div'), message = document.createElement('span'), close = document.createElement('button');
    el.setAttribute('role', 'alert');
    el.className = 'portable-notice';
    el.style.cssText = ${JSON.stringify(NOTICE_STYLE)};
    message.style.flex = '1';
    message.textContent = text;
    close.type = 'button';
    close.textContent = '关闭';
    close.style.cssText = ${JSON.stringify(CLOSE_STYLE)};
    close.onclick = function () { el.remove(); };
    el.appendChild(message);
    el.appendChild(close);
    box.appendChild(el);
  }
  var failed = false;
  function fail(reason) {
    console.error('long-screen portable: ' + reason);
    if (!failed) notice(${JSON.stringify(START_NOTICE)});
    failed = true;
  }
  if (!/Chrom(e|ium)\\//.test(navigator.userAgent)) notice(${JSON.stringify(BROWSER_NOTICE)});
  try {
    var demo = document.getElementById('long-screen-demo'), demoHref = new URL('demo/sample.mp4', location.href).href;
    var pageFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var href = typeof input === 'string' ? new URL(input, location.href).href : input instanceof URL ? input.href : input.url;
      if (href !== demoHref) return pageFetch(input, init);
      var bin = atob(demo.textContent), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return Promise.resolve(new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
    };
    var data = JSON.parse(document.getElementById('long-screen-portable').textContent);
    (${installPortable.toString()})(data, location.href);
    var s = document.createElement('script');
    s.src = URL.createObjectURL(new Blob([data.scripts['main.js']], { type: 'text/javascript' }));
    s.onerror = function () { fail('main.js blob script failed to load'); };
    s.onload = function () { if (!window.longScreen) fail('main.js loaded but did not finish starting (see the error above)'); };
    document.body.appendChild(s);
  } catch (error) {
    fail('bootstrap failed: ' + error);
  }
})();</script>`;
page = replaceOnce(page, '<body>', `<body>\n${noscript}`);
page = replaceOnce(page, '<script type="module" src="./assets/main.js"></script>', bootstrap);
const hash = await gitShortHash(root);
const stamp = new Date().toISOString();
page = replaceOnce(page, '<!doctype html>', `<!doctype html>\n<!-- Long Screen portable build · ${hash} · ${stamp} -->`);
if (page.includes('./assets/')) throw new Error('dist-portable/.site/index.html: a ./assets/ reference survived rewriting.');
if (/src="\.\//.test(page)) throw new Error('dist-portable/.site/index.html: a src="./..." reference survived rewriting.');
if (/href="\.\/(?!THIRD_PARTY_NOTICES\.txt")/.test(page)) {
  throw new Error('dist-portable/.site/index.html: a href="./..." reference (other than THIRD_PARTY_NOTICES.txt) survived rewriting.');
}

// --- 6: write dist-portable/. Only this script's own outputs are replaced (the folder and earlier zips), so
// anything else kept in dist-portable/ survives a rebuild. ---
const folder = join(out, 'long-screen');
await Deno.remove(folder, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(folder, { recursive: true });
for await (const entry of Deno.readDir(out)) {
  if (entry.isFile && /^long-screen-portable-.*\.zip$/.test(entry.name)) await Deno.remove(join(out, entry.name));
}
const encoder = new TextEncoder();
const pageBytes = encoder.encode(page);
const noticesBytes = encoder.encode(notices);
const readmeBytes = encoder.encode('\uFEFF' + readmeText(hash, stamp).replaceAll('\n', '\r\n'));
const htmlPath = join(folder, 'long-screen.html');
const noticesPath = join(folder, 'THIRD_PARTY_NOTICES.txt');
const readmePath = join(folder, 'README.txt');
await Deno.writeFile(htmlPath, pageBytes);
await Deno.writeFile(noticesPath, noticesBytes);
await Deno.writeFile(readmePath, readmeBytes);

const zipped = zipSync({
  'long-screen': {
    'long-screen.html': pageBytes,
    'THIRD_PARTY_NOTICES.txt': noticesBytes,
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

/** HEAD's short hash, with `-dirty` when the working tree differs from it — modified or staged files, or untracked
 *  ones a build may pick up (scripts/build.ts copies everything under static/) — so a build of uncommitted changes is
 *  never labelled (and its zip named) as if it were that commit. A failing git command fails the build rather than
 *  being read as either answer. */
async function gitShortHash(cwd: string): Promise<string> {
  const git = async (...args: string[]): Promise<string> => {
    const result = await new Deno.Command('git', { args, cwd, stdout: 'piped', stderr: 'piped' }).output();
    if (!result.success) {
      throw new Error(`git ${args.join(' ')} failed (is this a git checkout?): ${new TextDecoder().decode(result.stderr).trim()}`);
    }
    return new TextDecoder().decode(result.stdout).trim();
  };
  const hash = await git('rev-parse', '--short', 'HEAD');
  return await git('status', '--porcelain') ? `${hash}-dirty` : hash;
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
