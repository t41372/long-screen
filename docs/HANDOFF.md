# Handoff：Rust/Wasm 核心迁移（持续更新）

接手前请先读 [RUST-WASM-ASSESSMENT.md](RUST-WASM-ASSESSMENT.md)（目标边界与验收）和 [ARCHITECTURE.md](ARCHITECTURE.md) §十（不可误改的不变式）。
本文件只记录**当前进度、测量证据与下一步**，每次提交后更新。

## 环境

工具安装见 README 的「运行」一节。

```sh
deno task build            # 先编 rust/core → dist/assets/core.wasm，再打包 TS
deno task test             # 219 个 Deno 测试（含 23 个真值场景与 Rust/TS byte-exact parity）
```

真实录屏基准需要真正的 Google Chrome（Playwright 自带 Chromium 不含 H.264）：

```sh
LONGSCREEN_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" deno run --allow-all scripts/benchmark-pipeline.ts \
  --input 1.mov --passes 1 --allow-partial --output test-results/bench
```

用户提供的测试视频（私有，不入库）：`e.mov` 3456×2234 H.264 936 帧 20.4 s；`1.mov` 1418×1590 H.264 391 帧 8.6 s。
两者都以 `NEGATIVE_TIMESTAMP_SKIPPED` 结束为 `partial`（容器帧数 ≠ 可展示帧数），基准用 `--allow-partial`。

## 已在 Rust 核心中（`rust/core/src`）

raster（灰度、盒式降采样、alpha 加权减半）、features（角点 + BRIEF、匹配、视觉词）、motion（平移假设、验证、audit、
精修、运动场、原像素精修、纹理片、重采样）、png（filter/unfilter）、consistency（±1 帧世界一致性掩码）、
compositor（单瓦片合成：块级冲突/替换、coverage、provisional、quality、owner、score）、
**voting（位移展开一致性投票环：box、interior、partners、box gray、compare、finalize；有状态 handle）**、
**layers（LayerLearner 每帧累加：行/列变化、split/evidence/activity、切分增益、子格边缘票；有状态 handle）**、
**chrome（stationaryBoundary、stickyOcclusions）**、region（regionContains）、geometry（JS 精确的 round/hypot）。
每一项都有 `tests/unit/core-parity.test.ts` 的 byte-exact 对照（冻结的 TS 版本在 `tests/support/reference/`）。

核心以两种构建交付：`core.wasm`（scalar）与 `core.simd.wasm`（SIMD128），`coreURL()` 用 31 字节 v128 模块探测后选择；
Deno 测试默认加载 SIMD 版（`LONGSCREEN_CORE=scalar` 强制基线）。

### 核心内存中的常驻状态

- 渲染：`FrameRing`（3 槽原生帧，按帧号 upload 一次）、atlas 标签平面（每趟一次）、一致性掩码缓冲（核心写、compositor 直接读）。
- 扫描：`FrameRing`（2 槽，首帧后按实际几何创建）；降采样与 LayerLearner 直接读常驻帧。
- 求解：`VotingRing`（每帧一次灰度上传，每个移动区域一次 observe）。
- 指针跨内存增长有效；JS 视图不跨调用持有。全部在各趟 finally 与 `run()` finally 释放。

## 仍在 TypeScript 中的算法

| 模块 | 状态 |
| --- | --- |
| `LayerLearner.finish`（一次性区域构建，读回累加器）、`RegionAtlas` 构建（一次性） | 待做（非热点） |
| `PoseGraph.optimize`、`KeyframeIndex`（IndexedDB 访问为主） | 待评估 |
| `Compositor` 瓦片遍历、temporal 冲突分量/记录（已改为内存索引 + 整数 key）、`overwritePatch`、`framing`、pyramid | 待做 |
| PNG chunk/CRC/deflate（目前 deflate 用 CompressionStream）、ZIP64 | 待评估：Rust deflate 可让编码同步且一次调用 |

## 本轮已做的性能改动（均有 byte-exact 或真值场景验证；全部 220 个 Deno 测试通过）

1. 投票环 → Rust（1.mov 基准中 TS 投票 ≈ 32 s self time）。
2. 解码帧转换：`VideoFrame.copyTo({format:'RGBA'})`，探测失败/旋转容器退回 canvas（Chrome 153 实测走直通路径，与 canvas 路径差异均值 ≤ 1 级）。
3. PNG Sub filter 按 ~64 KiB 批调用核心（512 → ~17 次/瓦片），字节相同。
4. `consistency_mask` 行级 hoist（邻帧行有效性、遮挡矩形、投票行）。
5. scalar + SIMD128 双构建，运行时探测。
6. 渲染帧/标签/掩码常驻核心内存（每帧从 ~7 次帧复制降到 1 次）。
7. temporal 冲突记录改为内存索引 + 整数 block key + checkpoint 批量持久化。
8. 瓦片缓存上限 ≥ 单帧覆盖范围 + 2（`MEMORY_BUDGET_RAISED` 诊断）；周期 flush 只写自上次 checkpoint 起未再改动的瓦片。

## 基准：e.mov 接手时（3456×2234，935 帧，Chrome 153 headless，单次）

总 **8,549 s**：scanning 145 / solving 220 / optimizing 7 / rendering **8,125** / framing 29 / pyramid 23。
PNG encode 29,220 次 565 s，decode 13,800 次 129 s；putMany 74,669 次 **1,882 s**。瓦片缓存上限 38（单帧覆盖 ≈ 42–56）。
CPU self time：GC 1,304 s；putMany 1,224 s；resolveTemporal 及其闭包 ≈ 2,265 s；sameBlockSet 366 s；
Rust consistency_mask 136 s；Rust composite_tile 89 s。→ 渲染慢的主因是 TS temporal 记录处理与瓦片颠簸，不是像素核。

## 基准：本轮结果（Chrome 153 headless，单次；输出与接手时逐项相同）

| 录屏 | 接手时 | 现在 | 加速 | 输出对照 |
| --- | ---: | ---: | ---: | --- |
| 1.mov 1418×1590 × 381 帧 | 159 s | **125 s** | 1.27× | observed/conflict 像素、瓦片数、全部诊断计数相同；瓦片 SHA-256 已记录（`test-results/bench-1mov-current/verification.json`） |
| e.mov 3456×2234 × 935 帧 | 8,549 s | **1,254 s** | **6.8×** | 4 个画布的 observed/conflict 像素与瓦片数相同；全部诊断计数相同（仅新增 info 级 `MEMORY_BUDGET_RAISED`）；PNG 编码 29,220 → 1,816，存储写入 1,882 s → 56 s |

e.mov 现在的阶段：scanning 88 / solving 135 / optimizing 7 / rendering 986 / framing 22 / pyramid 16。
渲染剩余热点（self time，1,254 s 那次）：TS `resolveTemporal` 306 s + GC 227 s（60,594 个冲突分量，每个都重建重叠记录的整块集合）；
Rust `consistency_mask` 148 s；Rust `composite_tile` 112 s；`copyTo` 转换 108 s。
→ 随后提交把 temporal 记录改为常驻整数 key 集合（并集就地构建、`complete` 用外接矩形 O(1) 判定、只在 flush 时序列化），
全部 222 个测试通过（含逐字节的 temporal 行对照）；e.mov 复测数字待跑。

可复现：`LONGSCREEN_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" bash scripts/e2e-recordings.sh [--baseline] e.mov`，
产物在 `test-results/e2e-recordings/<name>/summary.json`（含瓦片 SHA-256；`--baseline` 时基准与当前的哈希不同会直接失败）。

## 基准：1.mov 接手时（1.mov，Chrome 153 headless，单次）

总 159.0 s：scanning 24.1 / solving 61.2 / optimizing 3.7 / rendering 67.1 / framing 0.3 / pyramid 2.3。
PNG encode 588 次 15.5 s，decode 96 次 0.9 s；putMany 1004 次 5.6 s。峰值常驻瓦片 63 / 上限 74。

CPU self time 前列：`canvasConverter` 内 `getImageData`（VideoFrame→RGBA）34.1 s；TS `consistencyCompare` 23.6 s；
Rust `consistency_mask` 15.6 s；Rust `composite_tile` 11.8 s；`encodePNG` 逐行调用核心 9.4 s；
Wasm 边界复制 read 5.9 s / write 4.6 s；`contains`（computeBoxGray 内 regionContains）5.0 s；
Rust `downscale_gray` 4.1 s；`computeBoxGray` 3.4 s；`addNative` 2.9 s；`extract_features` 2.3 s。

## 下一步

1. 重跑 e.mov 基准（含 temporal 常驻集合的版本），并用 `--baseline` 跑一次 1.mov 取得基准/当前的瓦片哈希对照。
2. LayerLearner / RegionAtlas / stickyOcclusions / stationaryBoundary → Rust（scan 阶段热点）。
3. Rust deflate（miniz_oxide 或自写）让 PNG 编码在核心内一次完成，去掉 CompressionStream 的异步与逐块复制。
4. 帧常驻扩展到 scan/solve（降采样、灰度、特征直接读常驻帧）。
5. WebGPU：目前只有 box-luma 降采样（`compute.ts`）；评估 consistency/composite 是否值得搬到 GPU（数据往返成本高，先测）。
6. 多线程：SharedArrayBuffer 需跨源隔离；GitHub Pages 不能假设；先做可转移缓冲的解码/编码 Worker 并行。
7. iPhone Safari 真机验证。

每一步：先冻结 TS 版本为 parity oracle → Rust 实现 → byte-exact 对照 + 全部场景测试 → 真实录屏基准 → 提交。
