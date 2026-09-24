/** Browser test kit: exposes the shipped modules on window for Playwright-driven integration tests. Not loaded by the app. */
import { Engine } from './pipeline/engine.ts';
import { Database, iterate, MemoryKV, Namespace } from './storage/db.ts';
import { PoseGraph } from './core/pose-graph.ts';
import { RegionAtlas } from './core/layers.ts';
import { covered, markCovered, pngTileCodec, TileStore } from './storage/tiles.ts';
import { DemoSource } from './media/demo.ts';
import { CompatibilitySource, openDemuxer, openMedia, PreciseSource } from './media/source.ts';
import { canvasConverter, directConverter, planarConverter, workerConverter } from './media/convert.ts';
import { MP4Demuxer } from './media/mp4.ts';
import { WebMDemuxer } from './media/webm.ts';
import { BlobReader } from './media/reader.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import { buildScenario, SCENARIO_NAMES } from './synthetic/scenarios.ts';
import { ScenarioSource } from './synthetic/source.ts';
import { renderFrame } from './synthetic/world.ts';
import { matchRegion, verifyFixed, verifyLayer } from './synthetic/verify.ts';
import { exportCanvas, exportProject } from './export/project.ts';
import { decodePNG, encodePNG, encodeRGBA } from './codec/png.ts';
import { ZipWriter } from './export/zip.ts';
import { core, loadPlannedCore, planCore } from './core/wasm.ts';
import { AnalysisComputer } from './core/compute.ts';
import { analysisFactor, downscaleGray } from './core/raster.ts';
// Browser tests and the pipeline profiler drive Engine directly, so the core is loaded before the kit is exposed.
const corePlan = await loadPlannedCore(planCore(), new URL('./core-helper.js', import.meta.url));
const kit = {
  corePlan,
  coreThreads: () => core().threads,
  core,
  AnalysisComputer,
  analysisFactor,
  downscaleGray,
  Engine,
  Database,
  Namespace,
  iterate,
  MemoryKV,
  PoseGraph,
  RegionAtlas,
  TileStore,
  markCovered,
  covered,
  pngTileCodec,
  DemoSource,
  openMedia,
  openDemuxer,
  canvasConverter,
  directConverter,
  planarConverter,
  workerConverter,
  PreciseSource,
  CompatibilitySource,
  MP4Demuxer,
  WebMDemuxer,
  BlobReader,
  DEFAULT_SETTINGS,
  buildScenario,
  SCENARIO_NAMES,
  ScenarioSource,
  renderFrame,
  matchRegion,
  verifyFixed,
  verifyLayer,
  exportCanvas,
  exportProject,
  encodePNG,
  encodeRGBA,
  decodePNG,
  ZipWriter,
};
(globalThis as unknown as { longScreenKit: typeof kit }).longScreenKit = kit;
export default kit;
