# Handoff：Rust/Wasm 核心迁移（持续更新）

接手前请先读 [RUST-WASM-ASSESSMENT.md](RUST-WASM-ASSESSMENT.md)（目标边界与验收）和 [ARCHITECTURE.md](ARCHITECTURE.md) §十（不可误改的不变式）。
本文件只记录**当前进度、测量证据与下一步**，每次提交后更新。

## 环境

工具安装见 README 的「运行」一节。

```sh
deno task build            # rust/core → core.wasm / core.simd.wasm / core.threads.wasm，再打包 TS（含 core-helper.js）
deno task test             # 默认 SIMD 核心；LONGSCREEN_CORE=scalar|threads 切换构建（threads 默认 3 个 helper）
```

真实录屏基准需要真正的 Google Chrome（Playwright 自带 Chromium 不含 H.264）：

```sh
LONGSCREEN_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" bash scripts/e2e-recordings.sh [--baseline] 1.mov
```

用户提供的测试视频（私有，不入库）：`e.mov` 3456×2234 H.264 936 帧 20.4 s；`1.mov` 1418×1590 H.264 391 帧 8.6 s。
两者都以 `NEGATIVE_TIMESTAMP_SKIPPED` 结束为 `partial`（容器帧数 ≠ 可展示帧数），基准用 `--allow-partial`。

## 多线程（2026-09-23 接手后新增）

- `rust/core/src/pool.rs`：共享内存线程池。seqlock 发布 job、原子计数领取 chunk、helper 停在 `memory.atomic.wait32`；
  **调用方从不阻塞**（自己跑 chunk，最后自旋），所以引擎可以跑在浏览器主线程（benchmark harness 就是）。
  chunk 体内**禁止分配内存和加锁**（主线程不能 wait；分配器锁若被 helper 持有会死锁/陷阱）。
- `core.threads.wasm`：SIMD128 + atomics，`RUSTC_BOOTSTRAP=1 -Zbuild-std` 在固定的 1.94.0 上重建 std；内存由 JS 创建并导入
  （`--initial-memory=32MiB`，`--max-memory=2GiB`，与 `src/core/wasm.ts` 的 `THREADS_*_PAGES` 必须一致）。
- `planCore()`：页面 `crossOriginIsolated` 且支持 SIMD、有 Worker、≥2 CPU 时选 threads（helper = min(CPU−1, 7)），
  否则 simd/scalar；原因写进 `COMPUTE_BACKEND` 诊断的 `detail.core`。开发服务器现在发 COOP/COEP/CORP。
  **GitHub Pages 等无法设响应头的静态托管不会跨源隔离，会退回单线程**（可后续加 coi-serviceworker；LAN HTTP 没有 SW，只能单线程）。
- 输出与线程数无关：chunk 写不相交区间，归约是整数和或按 chunk 顺序折叠。每个并行化的 kernel 都在三种构建上跑 oracle/parity。

## 本轮进度（接手后，均在 Chrome 154 headless 下测得）

| 阶段 | 1.mov 总时长 | e.mov 总时长 | 输出对照（vs 接手时） |
| --- | ---: | ---: | --- |
| 接手时（重测） | 76 s | 459 / 479 s | — |
| threads + consistency 快路径 + composite 向量化/并行 | 58 s | — | 1.mov 瓦片 SHA-256 相同 |
| + scan/solve kernel 并行、solve 帧/标签常驻 | 47 s | 257 s | 1.mov 相同；e.mov 见下 |
| + 固定区域比较与 native 亮度常驻（Rust） | 45 s | 243 s | 1.mov 相同；e.mov 见下 |
| + quality 脏标记修复（当前） | **47 s** | **253 s** | 1.mov 瓦片 SHA-256（PNG+全部证据）相同；e.mov 见下 |

单次测量，同一棵树连跑有 ±5% 抖动（45 vs 47 s、243 vs 253 s）。e.mov 当前阶段：scan 49 / solve 62 / optimize 4 /
render 110 / framing 16 / pyramid 12。

### e.mov 的不确定性（已定位并修复）

同一棵树（接手时的版本）在 e.mov 上连跑两次，瓦片哈希不同；逐瓦片对比只有 `layer-0-part-0/0/2_7` 的 `quality` 数组不同
（像素、coverage、provisional、conflicts、owner、score、frozen 全部相同）。原因：`composite_tile`（以及它移植自的 TS 版本）
在“不确定、无冲突、不替换”的观察把块的 `quality` 降低时**不标记瓦片已修改**，于是这次降低能否落盘取决于之后是否恰好有别的写入
在按时间触发的 checkpoint flush 或淘汰之前把瓦片弄脏——即取决于时序。修复：块的 quality/owner/score 任何变化都标记瓦片已修改；
`tests/unit/compositor.test.ts` 新增用例先复现（持久化值 ≠ 内存值）后通过。这个修复会让 e.mov 的持久化 quality 与旧基线不同
（旧基线丢失的更新现在会写入），像素与其他证据不变；对照方式改为逐瓦片逐字段哈希（`*.tiles.json`，含解码后像素哈希）。

修复后的验证（e.mov）：与接手时相比只有 68 块瓦片的 `quality` 不同，解码像素、coverage、provisional、conflicts、owner、
score、frozen、4 个画布的计数与全部诊断计数都相同；两次运行（一次与测试套件争用 CPU、一次独占，时序不同）856 块瓦片逐字段完全相同。
1.mov 不受影响（瓦片 SHA-256 与接手时相同）。

### 工具

- `scripts/benchmark-pipeline.ts --verify-tiles` 现在另写 `<label>-pass-N.tiles.json`（每块瓦片的 PNG / 各证据数组 / 解码像素哈希），
  `--dump-evidence REGEX` 额外写出匹配瓦片的原始证据数组，用于定位差异。
- `deno run --allow-read scripts/compare-tiles.ts a.tiles.json b.tiles.json`：逐瓦片逐字段对比两次运行，列出不同的字段与瓦片。
  以接手时的版本为基准时，e.mov 的 `identicalTiles` 会是 false（上面的 quality 修复），要看 `pixelsSha256` 与这个逐字段对比。

## 已在 Rust 核心中（`rust/core/src`）

raster（灰度、盒式降采样、alpha 加权减半）、features（角点 + BRIEF、匹配、视觉词）、motion（平移假设、验证、audit、
精修、运动场、原像素精修、纹理片、重采样）、png（filter/unfilter）、consistency（±1 帧世界一致性掩码）、
compositor（单瓦片合成：块级冲突/替换、coverage、provisional、quality、owner、score）、
**voting（位移展开一致性投票环：box、interior、partners、box gray、compare、finalize；有状态 handle）**、
**layers（LayerLearner 每帧累加：行/列变化、split/evidence/activity、切分增益、子格边缘票；有状态 handle）**、
**chrome（stationaryBoundary、stickyOcclusions）**、region（regionContains）、geometry（JS 精确的 round/hypot）。
每一项都有 `tests/unit/core-parity.test.ts` 的 byte-exact 对照（冻结的 TS 版本在 `tests/support/reference/`）。

核心以三种构建交付：`core.wasm`（scalar）、`core.simd.wasm`（SIMD128）、`core.threads.wasm`（SIMD128 + atomics，见上文多线程），
`planCore()` 按能力选择；Deno 测试默认加载 SIMD 版（`LONGSCREEN_CORE=scalar|threads` 切换）。

### 核心内存中的常驻状态

- 渲染：`FrameRing`（3 槽原生帧，按帧号 upload 一次）、atlas 标签平面（每趟一次）、一致性掩码缓冲（核心写、compositor 直接读）、
  每个 fixed 区域上次看到的像素（`ls_fixed_update` 比较并刷新）。
- 扫描：`FrameRing`（2 槽，首帧后按实际几何创建）；降采样与 LayerLearner 直接读常驻帧。
- 求解：`VotingRing`（每帧一次灰度上传，每个移动区域一次 observe）；原生帧 `FrameRing`（2 槽）与标签平面；
  全分辨率亮度平面 `ResidentGray`（每帧首次需要时由常驻帧就地计算；纹理片按 32×32 窗口读出，精修直接读平面）。
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

按 e.mov profile（253 s 那棵树）排序：

1. VideoFrame→RGBA（`copyTo`，Chrome 内部 YUV→RGB）仍是最大单项。不能自己在 Rust 里做 YUV→RGB：
   转换矩阵/舍入与浏览器不同就不再逐字节相同，且 Safari 与 Chrome 本来就不同。可做的是减少分配与复制（见下方微基准结论）。
   **微基准**（e.mov 前 150 帧，3456×2234，Chrome 154 headless，只解码+转换）：每帧新分配 `Uint8ClampedArray` 再 `copyTo`
   **37.6 / 41.0 ms/帧**（两次）；复用缓冲（6 个轮转）12.4；SharedArrayBuffer 视图 11.4；原生格式（I420）拷贝 13.7。
   差额几乎全是 30 MB 新内存的缺页/清零与 GC，不是转换本身。三趟各解码一遍，e.mov 约 2,800 次转换 → 预计可省 ~70 s。
   做法必须是**显式归还**的缓冲池（消费方处理完一帧后 release，未归还的缓冲永不复用，最坏情况退化为现在的每帧新分配），
   不能用“固定 N 个轮转”——任何保留 `image.data` 超过预期的调用方都会被静默改写像素。先逐趟列出 `image.data` 的所有持有者。
2. `buildFramedCanvas`（framing 16 s）、PNG encode/decode（各 ~13 s）、存储写入（~20 s）：framing 与 pyramid 目前单线程 TS。
3. JS 胶水：`voting.observe` 外层、`learner.add` 包装、每帧的小数组分配。
4. WebGPU：headless Chrome `requestAdapter()` 返回 null，无法验证也无法测收益；`compute.ts` 现有的 box-luma 路径与
   校准回退保持不动。任何新 GPU kernel 都必须先有真机（Mac/iPhone）上的逐字节对照手段，否则不做。
5. coi-serviceworker（静态托管也能跨源隔离从而用上 threads 构建）；iPhone Safari / macOS Safari 真机验证 threads 构建。
6. 同类缺陷排查：凡是“条件性修改常驻/瓦片状态”的路径都要确认同时标脏（quality 那次就是这类）。

每一步：先冻结 TS 版本为 parity oracle → Rust 实现 → byte-exact 对照 + 全部场景测试 → 真实录屏基准 → 提交。
