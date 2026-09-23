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
| + 掩码零复制 + 解码帧在 worker 中提前一帧转换 | **44 s** | **221 s** | A/B（vs 上一版本：47 / 276 s）瓦片 SHA-256、画布、诊断全部相同 |

单次测量，同一棵树连跑有 ±5% 抖动（45 vs 47 s、243 vs 253 s）。e.mov 当前阶段：scan 49 / solve 62 / optimize 4 /
render 110 / framing 16 / pyramid 12。

**测时方法改为 A/B**：`git worktree add .baseline <上一提交>`，
然后 `benchmark-pipeline.ts --baseline-root .baseline --verify-tiles`（同一次调用里先后跑基准与当前）。解码帧转换移到 worker 那次：
e.mov scan 51.5→50.6 / solve 69→51 / render 118→86 / framing 19→17；1.mov 47→44 s。

### 解码帧转换移出流水线线程

`workerConverter`（`src/media/source.ts` + `src/media/convert-worker.ts`）：同一个 `copyTo({format:'RGBA'})` 在专用 worker 里做
（传过去的是帧的 clone），`PreciseSource` 在流水线处理当前帧时把下一帧交给它（推测性：那一帧的检查仍在取用时按原顺序执行，
被跳过/拒绝的帧只是丢掉提前的转换）。任何失败都回到线程内：worker 出过帧之后只用线程内 `copyTo`，绝不切到 canvas，
所以一次运行不会混用两种 YUV→RGB。浏览器测试逐字节对照线程内 `copyTo`（含负 ctts 夹具、停止后的下一趟、坏 worker URL 回退）。
缓冲池（每帧仍新分配 30 MB，只是在 worker 里）未做：见下一步。

### 验证状态

- `deno task test`：225 通过 / 0 失败。`deno task test:browser`（真 Chrome 154，H.264，含 WebGPU/SwiftShader 用例）：**20 / 20**。
- 浏览器套件里 `ui.test.ts` 的真实容器用例从 PNG filter 移入 Rust 核心起就一直失败（Deno 端 `decodePNG` 依赖 Rust 核心而测试进程没加载；
  在上一版本上复现同样的 `CORE_NOT_LOADED`）——之前只跑了 decode 子集，没跑整个浏览器套件。已修（测试进程加载核心）。
  **以后每次都跑整个 `test:browser`，不要只跑子集。**
- 同类“条件修改未标脏”排查：TS 侧写瓦片证据的路径（`overwritePatch`、framing）都会标脏/显式保存；未发现新的同类缺陷。
  framing 对“有 coverage 但像素全透明”的瓦片不保存——录屏像素不透明，不会发生，记在这里。

## Safari 崩溃与“超级慢”评估（用户在 M5 Max / Safari 上跑类似 e 的项目时崩溃；附件 d.mov）

**d.mov**：HEVC（hvc1）1920×1240，1152 帧，21.4 s，VFR（120 fps 时基，平均 54 fps），音轨在前。Mac 上 Chrome/Safari 都走 VideoToolbox。
Chrome 测时用 ffmpeg 转的 H.264 同几何/同时间戳副本 `d264.mov`（像素不同，只用于测时/内存）。

| 浏览器与输入 | 结果 | 阶段（s） |
| --- | --- | --- |
| Chrome 154，d264 | 157 s 完成 | scan 40 / solve 49 / opt 6 / render 53 / framing 5 / pyramid 4 |
| Playwright WebKit（JSC + WebKit WebCodecs，UA Safari 26），d.mov 原片，canvas 转换 | **184 s 完成，不崩** | 34 / 64 / 11 / 63 / 9 / 4 |
| 同上，planar 转换（本轮） | 175 s 完成 | 32 / 62 / 10 / 61 / 6 / 4 |

WebKit 内存平稳：WebProcess 基线 ~550 MB（空页面就这么大），跑完峰值 +~450 MB；Wasm 峰值 102–120 MB。→ **JSC 里核心、线程池、IndexedDB 本身
都能跑完 d.mov**；崩溃取决于 macOS Safari 特有的东西。

**Safari 特有的两件事（证据）**

1. **Safari 不支持 `VideoFrame.copyTo({format:'RGBA'})`**（caniuse：Safari ≤ 27.2 均不支持；Playwright WebKit 同样）。之前每一帧都落到
   `canvasConverter`：OffscreenCanvas `drawImage(VideoFrame)` + `getImageData`，在引擎线程同步执行、每帧新分配整帧 RGBA，三趟
   （scan/solve/render）各一次 → d.mov 3,456 次，类似 e 的 3456×2234 每次 30 MB。macOS Safari 的 VideoFrame 在 GPU 进程里，
   这条路径每帧要在 GPU 进程转换再跨进程传回；WebKit 有这条路径 OOM / GPU 进程崩溃的历史（bug 256366 / PR 17808：pixel conformer
   缓冲池只在低内存时释放）。我在 worker 里做的 copyTo 转换对 Safari 完全无效（worker 0 帧）。
2. **WebKit 的内存回收阈值**（`Source/WTF/wtf/MemoryPressureHandler.cpp`，每 30 s 检查）：内存 > 16 GB 的 Mac 上，页面可见时
   footprint ≥ 15 GB + 1 GB × 标签数才杀；**页面不可见（切到别的标签/应用、最小化）时只有 3 GB + 1 GB × 标签数**。
   几分钟的处理放在后台，~4 GB 就会被回收（“此网页因占用大量内存已重新载入”）。

**本轮改动**

- `planarConverter`（`src/media/source.ts` + `rust/core/src/yuv.rs`）：不支持 copyTo(RGBA) 的浏览器改为 `copyTo()` 取原生 YUV 布局
  （I420/I422/I444/NV12，1.5 B/像素，无转换），再由核心按 **libyuv 的整数公式与常数**转成 RGBA（行按线程池切分）。
  在 Chrome 上对真实解码帧（夹具、e.mov、1.mov）以及奇数尺寸的 I420/NV12/I422/I444 × BT.709/BT.601 × limited/full 与 Chrome
  自己的 `copyTo(RGBA)` **逐字节相同**；BT.2020（浏览器还做色域转换）、RGB/alpha 布局、旋转容器交给 canvas。
  **首帧同时走 canvas 比对**（均差 ≤ 8、>48 的通道 ≤ 1%）才对整趟启用；决定在任何帧返回前做出，一趟内不混用。
  这道检查是必须的：**Linux WebKit（GStreamer）的原生 copyTo 对行有填充的帧报告紧凑 stride 却按填充 stride（320→384）拷贝**，
  320 宽夹具均差 50–67；检查拦下后用 canvas，结果正确。新夹具 `scroll-384.mp4`（同内容右侧补黑到 384）在 WebKit 走 planar，
  离真值 1.02（WebKit canvas 2.59）。macOS Safari 的 copyTo 是另一套实现（CVPixelBuffer），尚未验证——所以检查必须保留。
  WebKit 上 d.mov 用 planar 后诊断计数与 canvas 版略有不同（输入像素不同；冲突类警告略少），这是转换来源不同，不是算法变化。
- 崩溃记录器（`src/ui/flight.ts`）：页面线程每秒把阶段/帧/已用时间/核心内存/转换路径/后台时长写进 localStorage；页面被回收或崩溃后，
  下次打开在诊断里给出 `PREVIOUS_RUN_INTERRUPTED`（含可复制的详情），并提示长时间处理保持前台。
- `scripts/inspect-recording.ts` 自迁移起就坏了（没加载核心），已修。

**为什么“超级慢”（结构性，非本轮能消除）**

Chrome d264 主线程 profile：Rust 核心 37%、空闲等待（解码/转换/IndexedDB）29%、JS 胶水 10%、IndexedDB 7%、JS↔Wasm 复制 5%、GC 4%。
- 每帧在三趟里各解码 + 转成全分辨率 RGBA 一次（d.mov 3,456 次）；solve 趟其实大多只需要分析分辨率的灰度，原生帧只在关键帧/补丁时用。
- render 每帧对整帧做一致性掩码 + 合成进所有覆盖的瓦片；60–120 fps 的录屏相邻帧几乎相同，仍逐帧全量处理。
- 编排是单个 JS 线程串行：解码、IndexedDB、PNG、framing/pyramid 都不在线程池里。
Rust 把计算 kernel 提速 3–16×，但端到端受这些结构限制（纯 TS→现在是 3.7–5.1×）。要做到“接近录屏时长”需要改流水线：
(a) scan 趟保存分析灰度，solve 不再解码全部原生帧；(b) render 对与上一帧像素相同/仅平移的区域跳过重复合成；(c) 存储批量化；
每项都会改变“逐帧全量”的执行方式，必须先定义输出等价的验收（真值场景 + 真实录屏逐瓦片指纹）再动。

**需要用户提供**：崩溃时的确切提示文字、Safari 版本、当时标签页是否在后台、本地测试录屏的分辨率/编码/时长；更新后再跑一次，
若再中断，重新打开页面后诊断里的 `PREVIOUS_RUN_INTERRUPTED` 详情。

## Safari 隐私浏览（用户报 “Local storage transaction failed.”）

**原因（已在 WebKit 临时会话复现）**：隐私浏览的 IndexedDB 在内存里，**接受字节但拒绝一切 Blob**
（`UnknownError: Error preparing Blob/File data to be stored in object store`）。瓦片（PNG Blob）与帧参照都是 Blob，第一次瓦片
flush 就失败，运行以 `partial` 结束。报错含糊是因为请求错误冒泡到 `tx.onerror` 时 `tx.error` 还是 null。测试 harness 早就写着
“WebKit ephemeral context cannot store IndexedDB Blobs”，但用持久 profile 绕过了而不是修。另外隐私浏览没有 OPFS
（`getDirectory()` 拒绝），Safari 也没有保存对话框，导出原来会直接报 `DISK_EXPORT_UNAVAILABLE`。

**修复**
- `Database.open()` 探测一次能否存 Blob（探测事务总是回滚，不留数据）。不能时，Blob 值（值本身或普通对象的顶层字段）
  以字节 + MIME 存，读出时还原为 Blob；上层代码不变。事务失败时报告失败请求的真实错误。
- 无文件句柄且无 OPFS 时导出在内存中组装（上限 1 GB，超出给出明确错误），UI 已有的 Blob 下载链接接手。
- 隐私浏览时提示“项目只保存在这个窗口的内存里，关闭窗口后即消失”。
- `tests/browser/private.test.ts`：WebKit 临时会话里跑演示 → complete、瓦片经 worker 读回可解码为 PNG、PNG 与 ZIP 导出下载成功、
  刷新后项目仍可打开。去掉写入转换会以真实错误（不再是笼统的 transaction failed）失败。
  d.mov 在 WebKit 临时会话：169 s 完成；内存数据库使网络进程多 ~160 MB。

## 与纯 TypeScript 版本对比（迁移前最后一个纯 TS 版本；同一次调用内先后跑）

| 录屏 | 纯 TS | 现在 | 输出 |
| --- | ---: | ---: | --- |
| 1.mov 1418×1590 × 381 帧 | 161 s（scan 32 / solve 56 / render 69） | **43 s**（12 / 16 / 12），3.7× | 瓦片 SHA-256（PNG + 全部证据）、画布、诊断**完全相同** |
| e.mov 前 4.9 s（247 帧，ffmpeg 流复制） | 386 s（33 / 49 / render 280） | **76 s**（13 / 12 / 31），5.1× | 解码像素、画布相同；85/609 块瓦片只有 `quality` 不同（quality 脏标记修复）；多一条 info 级 `MEMORY_BUDGET_RAISED` |

完整 e.mov 的纯 TS 本轮没重跑（上一轮接手时测过 8,549 s，那时已部分是 Rust；现在 221 s）。
render 的提升里有相当一部分来自 TS 侧的结构性修复（temporal 常驻索引、瓦片缓存 ≥ 单帧覆盖），不全是 Rust。

同输入逐 kernel（`scripts/benchmark-ts-vs-rust.ts`，冻结的 TS 实现 vs Rust，Deno V8，Rust 计时含拷入/拷出 Wasm 内存，
真实解码帧）：grayscale 1.8–2.1×、downscale 2.0–2.5×、extractFeatures 3.2–4.6×、matchFeatures 4.2–5.6×、
estimateMotion 2.1–2.9×、voting observe 4.5–5.3×、PNG Sub filter 3.7–10.7×、PNG unfilter ~1×；consistency mask 4.8–15.8×
（但参照是 hoist 之前的 TS，实际发货的 TS 更快，这一行偏高）。

### 发现：motion.rs 的浮点并非逐位等于 V8

`rust/core/src/motion.rs` 用 Rust libm 的 `exp`（3 处：平移假设置信度、误差衰减、逐格置信度）和 `f64::hypot`（1 处），
TS 用的是 V8 的 `Math.exp` / `Math.hypot`。两者最后一位可能不同：真实帧上 motion confidence 最大相对差 2.4e-16（≈1 ULP）；
逐格 confidence/labels/dynamic 字节、特征、匹配全部相同，端到端瓦片也相同，但阈值比较（如 `confidence > .6`）理论上可能被这 1 ULP 翻转。
parity 测试用 1e-9 相对容差掩盖了它。修法：`geometry.rs` 已有逐位模仿 V8 的 `js_hypot`，motion 改用它；`exp` 移植 V8 用的
fdlibm `ieee754::exp`，然后把 parity 测试对这些字段改为逐位相等。（Safari 的 JSC 用系统 libm，TS 版在 Chrome 与 Safari 之间本来就可能差 1 ULP；
Rust 版移植后在所有浏览器上逐位一致，等于 TS-on-Chrome。）

## WebGPU（本轮评估，结论要点）

- **之前的结论是错的**：headless Linux Chrome 加 `--enable-unsafe-webgpu` 有 SwiftShader 适配器（真 Dawn/Tint 栈），
  “requestAdapter 返回 null” 是在非安全上下文（about:blank）上测的。整数 kernel 可以在 SwiftShader 上逐字节验证；**性能不可参考**
  （软件 GPU）。`harness({ webgpu: true })` 打开它。
- 发货的 GPU kernel 仍只有一个：扫描趟的分析降采样（box-luma，`src/core/compute.ts`；`auto` = 首帧逐字节校验 + 计时，
  GPU 不快于 CPU 的 90% 就整趟留在 CPU）。本轮修正了它对 GPU 不公平的地方：常驻帧直接从核心内存视图上传
  （Chrome 接受 threads 构建的共享内存视图）、4 像素打包读回、bind group 复用、各 3 次中位数校准。
  `tests/browser/compute.test.ts` 在真 Chrome WebGPU 上逐字节对照核心（3 个变异都被抓到）。
- **为什么没有把 consistency / composite 搬到 GPU**：逐字节一致要求 GPU 的输入必须是 `copyTo` 得到的同一份 RGBA，
  所以每帧都要上传 30 MB（e.mov）再读回结果；这些 kernel 每字节只有几条整数运算，在 Apple Silicon 统一内存上 GPU 与 CPU
  共享同一带宽，上传 + 读回本身的内存流量就与 kernel 相当。按 profile 外推，e.mov 上 consistency + composite 在
  8 核 Mac 上合计只有约 5 s 墙钟，GPU 最多省下其中一部分；分析降采样每帧 2–5 ms，就算 GPU 免费也只省 ~5 s。
  真正的大头是串行部分（帧转换、JS↔Wasm 复制、IndexedDB/PNG、framing、pyramid），GPU 帮不上。
  若 GPU 直接吃 VideoFrame（`importExternalTexture`）可免上传，但它自己的 YUV→RGB 与 `copyTo` 不逐字节相同，会改变输出。
- **真机验证**：`device-check.html`（`tests/browser/device-check.test.ts` 在 SwiftShader 上端到端跑过；1.mov 手动跑：
  CPU 与强制 WebGPU 的完整流程 97 块瓦片指纹相同）。报告里有：适配器、跨源隔离与核心构建、一帧 RGBA 上传/读回耗时、
  分析降采样 GPU vs CPU（逐字节 + 中位数）、可选完整流程 A/B。Mac：`deno task dev` 后打开
  `http://localhost:4173/device-check.html`（localhost 是安全上下文，且开发服务器发 COOP/COEP → threads 构建）。
  iPhone：WebGPU 需要安全上下文，局域网 HTTP 不行，需要 HTTPS（GitHub Pages 可用但无跨源隔离 → 单线程核心；或 HTTPS 隧道）。
  若真机数据显示上传 + kernel + 读回明显快于 CPU，第一个值得移植的是 consistency_mask（纯逐像素函数、整数可精确）。

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
   **已做一半**：转换移到 worker 并提前一帧，主线程不再等它。仍未做：缓冲复用（worker 每帧新分配 30 MB）。
   做法：流水线用完一帧后把 `image.data.buffer` 转移回 worker（transfer 后原视图变 0 长，误用会大声失败而不是静默改像素）。
   **微基准**（e.mov 前 150 帧，3456×2234，Chrome 154 headless，只解码+转换）：每帧新分配 `Uint8ClampedArray` 再 `copyTo`
   **37.6 / 41.0 ms/帧**（两次）；复用缓冲（6 个轮转）12.4；SharedArrayBuffer 视图 11.4；原生格式（I420）拷贝 13.7。
   差额几乎全是 30 MB 新内存的缺页/清零与 GC，不是转换本身。三趟各解码一遍，e.mov 约 2,800 次转换 → 预计可省 ~70 s。
   做法必须是**显式归还**的缓冲池（消费方处理完一帧后 release，未归还的缓冲永不复用，最坏情况退化为现在的每帧新分配），
   不能用“固定 N 个轮转”——任何保留 `image.data` 超过预期的调用方都会被静默改写像素。先逐趟列出 `image.data` 的所有持有者。
2. `buildFramedCanvas`（framing 16 s）、PNG encode/decode（各 ~13 s）、存储写入（~20 s）：framing 与 pyramid 目前单线程 TS。
3. JS 胶水：`voting.observe` 外层、`learner.add` 包装、每帧的小数组分配。
4. WebGPU：先拿到真机 `device-check.html` 的报告再决定（见上文“WebGPU”一节）；新 GPU kernel 必须有 `tests/browser/compute.test.ts`
   那样在真 Chrome WebGPU 上的逐字节对照，并且保留 `auto` 的首帧校验 + 计时门槛。
5. coi-serviceworker（静态托管也能跨源隔离从而用上 threads 构建）；iPhone Safari / macOS Safari 真机验证 threads 构建。
6. 同类缺陷排查：凡是“条件性修改常驻/瓦片状态”的路径都要确认同时标脏（quality 那次就是这类）。
7. **Safari**：拿到用户的 `PREVIOUS_RUN_INTERRUPTED` 详情再定；若 planar 在真机上被首帧检查拒绝，查 macOS copyTo 布局。
8. **流水线结构**（见“Safari 崩溃与超级慢评估”）：solve 不重解码原生帧、render 跳过重复合成、存储批量化——先定义等价验收。
9. **motion.rs 的 exp/hypot 逐位对齐 V8**（见“与纯 TypeScript 版本对比”一节），并收紧 parity 测试的浮点容差。

每一步：先冻结 TS 版本为 parity oracle → Rust 实现 → byte-exact 对照 + 全部场景测试 → 真实录屏基准 → 提交。
