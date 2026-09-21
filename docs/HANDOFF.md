> **歷史文件。** 以下內容来自原始 ZIP，不代表本次交付重新驗證。最新復原與驗證狀態見 [../delivery/STATUS.md](../delivery/STATUS.md)。

# Handoff

Written 2026-09-20. Audience: whoever picks this up next, with no memory of this session.

## What was asked and what was done

The project was a Node/npm + Python codebase generated from `docs/original_requirements.md`. Two things were asked:

1. Convert it thoroughly to Deno.
2. Find out why every real screen recording in `test_case/` failed with `InvalidStateError: Failed to execute 'createImageBitmap' on 'Window': The image source is not usable`, producing only the first frame instead of a stitched canvas, and make the core algorithm properly tested against ground truth the model generates itself.

Both were done. Node, npm, TypeScript-as-a-dependency, and all Python test scripts are gone. The toolchain is Deno only: `deno bundle` builds, `Deno.serve` serves, `deno test` tests, Playwright is pulled through `npm:` specifiers for the browser suite only.

Nothing is committed. `git status` shows the whole tree as untracked; there are no commits in this repository at all, so there is no diff, no bisect and no way to verify any "it used to do X" claim in this document. Commit before you change anything.

This document was reviewed by a second agent against the tree, which found four wrong numbers and three imprecise claims; those are corrected here. Numbers age quickly: re-run `deno task coverage` and rebuild `dist/` before trusting any figure below.

## The real bug

There were two separate failures behind one symptom.

**The decode failure was a container-parsing bug.** ISO/IEC 14496-12 says the composition offsets in a `ctts` box are unsigned in version 0 and signed in version 1. Apple's ReplayKit writes *negative* offsets inside a **version 0** box. The demuxer followed the specification, read them unsigned, and produced presentation timestamps around 7,158,278 seconds. The decode loop saw time going backwards and aborted the whole recording. FFmpeg reads these offsets signed regardless of version; so does this code now (`src/media/mp4.ts`, the `ctts` and `trun` readers). Two fixtures lock the behaviour in: `negative-cts.mov` (version 1) and `negative-cts-v0.mov` (the same file with the version byte patched to 0, which is exactly the ReplayKit layout). `tests/unit/media.test.ts` asserts both produce an identical timeline, and asserts against the real recordings in `test_case/` when they are present.

**The `createImageBitmap` error was a separate UI problem.** The old UI read metadata and the first frame from a `<video>` element. When Chrome cannot render a container into a bitmap, that throws, and the app was stuck before it started. The worker now has a `probe` command that demuxes and decodes frame 0 through WebCodecs and transfers an `ImageBitmap` back, and that is the primary path. The `<video>` element is still loaded for every file, because compatibility mode and the "view the original moment" dialog need it, and it remains a metadata fallback if `probe` throws; what changed is that the app no longer *depends* on it to start. See `chooseFile` in `src/ui/main.ts` and `dispatch('probe')` in `src/worker.ts`.

Seven further defects surfaced while building the ground-truth tests. They are listed in `docs/TESTING.md` under 修正过的实际问题 with the reasoning for each fix.

## Read these too

`docs/CAPABILITIES.md` is the authoritative ledger of what works and what does not, mapped item by item onto the original requirements. It carries limitations this document does not repeat: no resumption from an interrupted frame, no general non-rigid reflow or infinite-scroll height change or virtualized lists, no arbitrary nested scroll containers (motion regions under 8% of the main layer are merged into their neighbour), no cross-zoom unified reconstruction, no guarantee that a whole page comes from one instant, and confidence scores that are heuristic rather than calibrated probabilities. `docs/ARCHITECTURE.md` explains the model and the reasoning behind each trade-off. `docs/FORMAT.md` documents the export format and every diagnostic code.

## The design decision that makes testing possible

Decoding is the only step that needs a browser. Everything after it is pure TypeScript:

- `FrameSource` yields `RGBA`, not an `OffscreenCanvas`. The `VideoFrame → RGBA` conversion is an injected function (`FrameConverter` in `src/media/source.ts`), so the decode loop's backpressure, ordering, stall and geometry-change branches are testable in Deno with a fake `VideoDecoder`.
- Analysis downscaling is an integer-factor box filter (`src/core/raster.ts`), not canvas resampling. Factor `f` means an analysis displacement times `f` is exactly a native displacement; the native refinement radius follows from `f`.
- Tiles are encoded and decoded by our own PNG codec (`src/codec/png.ts`), so bytes are identical in both runtimes and exports are still standard PNGs.

That means `deno task test` exercises the shipped code path, not a simulation of it. The browser suite covers what genuinely needs a browser: WebCodecs, the worker, IndexedDB, OPFS export and the UI.

## Ground truth, and what the tests actually assert

`src/synthetic/` generates procedural pages (`world.ts`), composes them into recordings with exact viewport paths, overlays and dynamic regions (`scenarios.ts`), and verifies a finished run against the generating world (`verify.ts`). Twenty of the scenarios are also offered in the app's demo menu, so the demo button runs material the test suite has verified.

Per moving layer the verifier computes: maximum placement error in native pixels, pixels observed but missing from the result, pixels present but outside every observed viewport, pixels whose value matches no content version at that coordinate and cannot be explained by an overlay, fragment count, and which diagnostics appeared. Fixed overlays are checked for pixel identity and zero conflicts. Unless a scenario declares otherwise, missing, invented and mismatched must all be **0** and max error must be **0**.

Three scenarios declare something different, deliberately, rather than being loosened:

- `repeated-list-reversal` — identical list rows, direction reversed mid-scroll. Moving up 15px and down 29px are pixel-identical when the row pitch is 44px. The assertion is that any error is a whole multiple of 44 and that the ambiguity is reported, not that the answer is right.
- `toolbar-collapse` — the address bar retracts and the content viewport grows. Marked a known limitation: the run must complete and report conflicts, with under 10% wrong pixels.
- `geometry-change` — the recording changes resolution part-way. It declares `status: 'partial'` and 20 rendered frames: the run must keep the decoded prefix and stop, not merge two pixel grids.

Everything else, including `blank` and `zoom`, is held to the full strict invariants. `blank` additionally has to report `UNOBSERVABLE_FRAME` and produce exactly one fragment.

23 scenarios plus an encoded-video `fixture` scenario. 92 unit tests total.

## Current state

| | |
|---|---|
| `deno task check` | passes |
| `deno task test` | 92 passed, 0 failed (~1m45s) |
| `deno task coverage` | passes its floors; see below |
| `deno task test:browser` | 11 passed, 0 failed (~2m22s) |
| All five recordings in `test_case/` | decode completely in Chrome with monotonic timestamps: 394, 1274, 370, 170 and 1152 frames, every packet becoming a frame |
| Real recording `0.mov` (1418×1590, 394 frames) | reconstructs end to end to a 1322×10778 canvas in ~46s; the exported preview is a clean continuous page |
| Real recording `c.mov` (3456×2234, 170 frames) | reconstructs to 3456×4594, 69 native tiles, pose-graph residual 0 |

There is no pixel ground truth for real recordings, so those runs verify decode completeness, frame counts, timestamp order, completion status and a visual check of the exported preview. They are not an accuracy claim.

**A codec-dependent detail worth knowing.** Chrome's H.264 path returns pixels within about one level per channel of the source; its VP9 path returns them systematically darker (mean signed difference about −19 per channel, maximum 78). That is a colour-range conversion in the decoder, not a reconstruction error. The encoded-fixture tests therefore measure each codec's own decode floor first and require the reconstruction not to exceed it, instead of loosening the tolerance to whatever the worst codec needs. Geometry — placement error, missing, invented, fragments — is still asserted exactly for every codec.

## Coverage, honestly

Line coverage is **89.9%** overall, branch 90.9%, measured on the tree as handed over. The core algorithm is **not** at 100%:

| File | Line % |
|---|---|
| `core/math.ts`, `core/features.ts`, `core/raster.ts`, `types.ts`, `export/{crc,png,zip,offline}.ts`, `media/{reader,demo}.ts`, `storage/diagnostics.ts`, `synthetic/{scenarios,source}.ts` | 100 |
| `core/motion.ts` | 99.5 |
| `core/pose-graph.ts`, `storage/tiles.ts` | 98 |
| `core/compositor.ts`, `codec/png.ts` | 97 |
| `core/keyframes.ts`, `media/source.ts`, `export/project.ts` | 92–94 |
| `core/layers.ts` | 91.8 |
| `pipeline/engine.ts` | **84.0** |
| `main.ts` | 83.7 |
| `media/mp4.ts` | **78.9** |
| `media/webm.ts` | **65.7** |
| `storage/db.ts` (61.6), `export/target.ts` (30.0) | IndexedDB / OPFS, unreachable from Deno, covered by the browser suite |

`scripts/coverage.ts` gates on **line** coverage with a floor per file, each set to `floor(measured)` so a file can only improve. `deno task coverage --update-floors` rewrites the floor block from the run that just finished; review that diff, because a lowered floor hides a regression. The gate also fails when a file under `src/` (or `main.ts`) is absent from the report and is not on the short browser-only list, so a new untested module cannot slip past unnoticed, and it throws if it parses an implausibly small number of table rows so a format change cannot make it pass silently.

That last set of guards exists because the gate was wrong once: it compared the table's *second* numeric column, which is function coverage, against its threshold, and so reported "thresholds satisfied" at a claimed 100% while `core/layers.ts` was well below that. Do not trust a green coverage run you have not seen the table for.

## What to do next, in order

1. **Close the coverage gap.** In order of how far they are from done: `media/webm.ts` at 65.7 (lacing variants, unknown-length clusters, BlockGroup paths), `media/mp4.ts` at 78.9 (`co64`, the compact `stz2` table, edit-list branches), `pipeline/engine.ts` at 84.0 (attachment chains, pause and stop paths, error recovery), `main.ts` at 83.7 (server error paths). `core/layers.ts` at 91.8 is closer than it looks and is mostly manual-region and divider variants. Run `deno task coverage --update-floors` after each improvement and check the diff.
2. **Reconstruct the remaining real recordings.** All five decode, but only `0.mov` and `c.mov` have been reconstructed end to end. `LONGSCREEN_REAL=all deno task test:browser` reconstructs every file in `test_case/`; `a.mov` and `d.mov` are 1274 and 1152 frames at 3456×2234 and will take minutes each. Look at the exported previews in `test-results/`, since there is no ground truth to assert against.
3. **Performance.** Rendering is the bottleneck and is single-threaded per frame. The compositor already uses a precomputed region atlas; the next wins are skipping duplicate frames in pass three and batching tile writes.
4. **Real devices.** Nothing has run on Safari, iPhone, iPad or Android. The 390×844 layout check is not a device test.
5. **`toolbar-collapse`.** A viewport that grows mid-recording is currently a declared limitation. Solving it means letting a layer's viewport rectangle change over time, which touches the region atlas and the compositor.

## Things not to undo by accident

- `ctts` offsets are read **signed in both versions**. Making that spec-conformant re-breaks every iOS recording.
- Analysis downscaling must stay an **integer factor**. Non-integer factors reintroduce sub-pixel drift that accumulates over hundreds of frames.
- A stationary side band is only treated as fixed UI when it has visible structure of its own (`textured()` in `src/core/layers.ts`). Without that check, a page's blank margin is classified as a sidebar and the exported long screenshot loses its margins.
- Content entering at the leading edge has no counterpart in the previous frame, so a rival motion hypothesis "wins" there by default. `src/core/motion.ts` explicitly refuses to treat that as evidence of an independent layer. Removing it fragments every fast scroll.
- Thin-overlap steps (`THIN_OVERLAP_STEP`) get odometry weight 0.05 and can be overruled by revisit evidence (`TRAJECTORY_CORRECTED`). This is what fixes period-aliased fast jumps; the pose-graph weighting and the correction have to stay together, and the correction has to happen *before* `graph.add` so the odometry edge records corrected geometry.

## Running it

```sh
deno task start          # builds dist/ if missing, serves on 4173
deno task test           # unit + scenario end-to-end, no browser
deno task coverage       # the above plus line-coverage floors
deno task test:browser   # real Chrome: decode, reconstruct, UI, export
deno task fixtures       # regenerate encoded samples (needs ffmpeg)
deno task check          # type-check everything
```

The browser suite needs a real Google Chrome, not Playwright's bundled Chromium, which ships without H.264. Override with `LONGSCREEN_CHROME=/path/to/binary` or `LONGSCREEN_CHANNEL`.

`test_case/` is gitignored. Tests that need it skip cleanly when it is absent.

The browser harness rebuilds `dist/` whenever the bundle is older than anything under `src/` or `static/`, so the suite cannot quietly test a stale build. `deno task start` does the same only when `dist/` is missing, so run `deno task build` after editing if you are just serving.

`scripts/inspect-recording.ts` is a debugging aid: it streams a real recording through ffmpeg into the scan pass and prints the learned regions, per-frame motion and the row/column statistics behind the band edges. It is how the layer-detection problems on `c.mov` were diagnosed.
