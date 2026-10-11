# long-screen

Turn a screen recording into one big screenshot, inside your own web page. The recording can move along any path (scroll, pan, diagonal, loop back) as long as it shows every part you want in the picture. Everything runs in the visitor's browser: the video is decoded with WebCodecs and reconstructed by [Long Screen](https://github.com/t41372/long-screen)'s Rust engine, compiled to WebAssembly and run in a Worker. Nothing is uploaded.

Reconstruction is heuristic. A finished run does not prove the picture is right; what the run could not resolve is reported as diagnostics and as separate fragment prints.

## Install

```sh
npm install long-screen
```

## Use

```js
import { reconstruct } from 'long-screen';

const run = reconstruct(file, {
  locale: 'en', // or 'zh'
  onProgress: (p) => console.log(p.phase, Math.round(p.fraction * 100) + '%'),
});
const { status, prints, diagnostics } = await run.result;
if (prints.length) document.querySelector('img').src = URL.createObjectURL(prints[0].png);
```

`reconstruct(source, options)` takes a `Blob` or `File` (MP4, MOV or WebM the browser can decode) and returns `{ result, pause(), resume(), stop(), cancel() }`:

- `result` resolves to `{ status, error?, frames, prints, diagnostics }`. Each print is one composed picture (`kind` `moving`, `fixed`, `presentation`, or a numbered `fragment`) with its size and a native-resolution `png` Blob; transparent pixels were never seen in the recording. `diagnostics` lists everything the run noticed, each with a `code`, a `severity` and a `message` in the chosen locale.
- `stop()` finishes early and still resolves with what was composed (`status: 'partial'`); `cancel()` throws the run away and rejects with an `AbortError`.
- `options.settings` takes the app's settings (`analysisSize`, `memoryMB`, `tileSize`, `temporalPolicy`, `framing`, `compute`); the types in `index.d.ts` document each.

The call keeps its working data in an IndexedDB database of its own and deletes it before `result` settles. The PNGs are held in memory, so a very long print costs its PNG size in RAM.

## Serving the files

The package is a folder of files that load each other by relative URL: `index.js` starts `worker.js`, which loads one of `core.wasm`, `core.simd.wasm` or `core.threads.wasm` and may start `core-helper.js` and `convert-worker.js`. Serve them from your own origin (browsers do not run a Worker from another origin), with `.wasm` as `application/wasm`.

- **Vite, webpack 5**: nothing to do; they follow `new URL('./file', import.meta.url)` and emit the files (checked with Vite 8.3 and webpack 5.111). For Vite's dev server add `optimizeDeps: { exclude: ['long-screen'] }`, or its dev server's pre-bundling moves `index.js` away from its files.
- **esbuild, Rollup without a URL plugin, `deno bundle`**: they leave those URLs alone, so copy the package's `*.js` and `*.wasm` files next to the bundle that imports `index.js`.
- **No bundler**: copy the folder into your site and `import { reconstruct } from '/vendor/long-screen/index.js'`.

## Cross-origin isolation

On a cross-origin-isolated page the engine runs on several threads. Send these headers with the page (and keep every subresource same-origin or CORP/CORS-enabled):

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them it runs the single-thread SIMD build. The prints are the same; only the speed differs.

## Browser support

Recent Chrome, Edge and Safari (WebCodecs, OffscreenCanvas, module Workers). Firefox decodes only what its WebCodecs supports.

## License

MIT, © 2026 Yi-Ting Chiu. The bundled files include third-party code (mediabunny, i18next, client-zip and the Rust crates compiled into the WebAssembly core); their licences are in `THIRD_PARTY_NOTICES.txt`.
