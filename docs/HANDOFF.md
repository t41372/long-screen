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
compositor（单瓦片合成：块级冲突/替换、coverage、provisional、quality、owner、score）。
每一项都有 `tests/unit/core-parity.test.ts` 的 byte-exact 对照（冻结的 TS 版本在 `tests/support/reference/`）。

## 仍在 TypeScript 中的算法（迁移顺序按实测热度）

| 模块 | 1.mov 基准 self time | 状态 |
| --- | ---: | --- |
| `Engine.solve()` 位移展开一致性投票（computeBoxGray / consistencyCompare / partners / finalize） | 23.6 s + 5.0 s（regionContains）+ 3.4 s ≈ 20% | **进行中** |
| `LayerLearner.add/addNative/finish`、`RegionAtlas`、`stickyOcclusions` | ≈ 3.5 s | 待做 |
| `PoseGraph.optimize`、`KeyframeIndex`（IndexedDB 访问为主） | 3.7 s | 待评估 |
| `Compositor` 瓦片遍历、temporal 冲突记录、`framing`、pyramid | 小 | 待做 |
| PNG chunk/CRC、ZIP64 | 小 | 待做 |

## 基准：接手时（1.mov，Chrome 153 headless，单次）

总 159.0 s：scanning 24.1 / solving 61.2 / optimizing 3.7 / rendering 67.1 / framing 0.3 / pyramid 2.3。
PNG encode 588 次 15.5 s，decode 96 次 0.9 s；putMany 1004 次 5.6 s。峰值常驻瓦片 63 / 上限 74。

CPU self time 前列：`canvasConverter` 内 `getImageData`（VideoFrame→RGBA）34.1 s；TS `consistencyCompare` 23.6 s；
Rust `consistency_mask` 15.6 s；Rust `composite_tile` 11.8 s；`encodePNG` 逐行调用核心 9.4 s；
Wasm 边界复制 read 5.9 s / write 4.6 s；`contains`（computeBoxGray 内 regionContains）5.0 s；
Rust `downscale_gray` 4.1 s；`computeBoxGray` 3.4 s；`addNative` 2.9 s；`extract_features` 2.3 s。

## 计划（按收益）

1. 一致性投票环搬入 Rust（有状态 ring，一帧一次调用）。
2. 解码帧转换：优先 `VideoFrame.copyTo({ format: 'RGBA' })`，能力探测失败时退回 canvas。
3. PNG 编码按批（≈64 KiB）而不是按行调用核心；CRC 进核心。
4. 瓦片 flush 节奏自适应（编码耗时占比上限），瓦片缓存预算重新核算。
5. `consistency_mask` / `composite_tile` 行级优化（遮挡跨度、邻帧行有效性预判）。
6. SIMD128 双构建 + 运行时探测（Safari 16.4+ / Chrome 均支持；老设备用 scalar 版）。
7. LayerLearner / RegionAtlas / stickyOcclusions → Rust。
8. 帧常驻 Wasm（解码直接落入核心内存，消除 scan/solve/render 的重复复制）。
9. 评估 WebGPU 与多线程（SharedArrayBuffer 需跨源隔离；见评估文档）。

每一步：先冻结 TS 版本为 parity oracle → Rust 实现 → byte-exact 对照 + 全部场景测试 → 真实录屏基准 → 提交。
