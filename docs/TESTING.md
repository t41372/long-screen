# 实测、可复现性与没有测过的事情

## 环境

macOS（Darwin 27），Deno 2.9.7，真实 Google Chrome 头less 运行 + Playwright WebKit，ffmpeg 仅用于生成编码样本。全部测试自带真值，不依赖用户私有录屏。Deno 测试默认加载 SIMD128 核心构建；`LONGSCREEN_CORE=scalar|threads` 切换另外两种构建（`LONGSCREEN_THREADS` 调整线程数，默认 3），这样 scalar/simd/threads 三种构建都能被同一套测试跑到，而不只是发货默认的那一个。

三类测试：

- `deno task test`：纯 Deno（先跑 `build:core`，需要 Rust 核心已构建）。核心算法的单元测试，以及合成场景的端到端重建——场景名单是 `src/synthetic/scenarios.ts` 的 `SCENARIO_NAMES`，`tests/support/scenario-check.ts` 加一个 `fixture` 场景拼成 `SCENARIO_CATALOGUE`，按 `tests/unit/scenarios-{1..4}.test.ts` 分 4 个 shard 注册（`registerShard`），每个场景都有逐像素真值。不要把某次跑出的测试总数当成固定基线—— 以 `deno task test` 自己这次的输出为准。单元测试覆盖：合成与时间冲突（`compositor.test.ts`）、`AnalysisComputer` 的 CPU/WebGPU 校准与回退路径（`compute.test.ts`）、带外框呈现画布的坐标映射与预算跳过（`framing.test.ts`）、混合坐标系位置图与片段接回后再回环闭合、长基线图层学习、无重叠跳转后再回环闭合（`layers.test.ts` 里的 `geometry:`/`takeover:` 用例，这两组用例已并入 `layers.test.ts`，不再是独立文件）、解码/分析/持久化三类失败域与可选阶段（`engine-failure.test.ts`）、中途停止后的 partial 状态（`engine-stop.test.ts`）、世界一致性掩码与片源噪声容差（`consistency.test.ts`）。
- `tests/unit/parity/`：冻结的 TS 参照实现（`tests/support/reference/`）与当前加载的 Rust 核心之间逐字节对照，运行在 `LONGSCREEN_CORE` 选中的那个构建（scalar/simd/threads，见 `tests/support/core.ts`）上，确保迁移没有改变数值结果。
- `deno task test:browser`：真实 Chrome + Playwright WebKit。WebCodecs 解码、Worker、IndexedDB、OPFS 导出、界面流程，以及（存在时）`test_case/` 里的真实录屏。它自己构建并服务 `dist-test/`（含测试用的 `testkit.js` 与 `harness.html`，源码比它新时自动重建），不碰 `dist/`：`deno task build:prod` 或 `build:portable` 之后照样能跑，跑完也不会把准备部署的生产构建换掉。
- `deno task test:rust`（`cd rust && cargo test --lib`，编译到宿主平台的 `target/debug`，不碰 wasm 产物；`deno task test` 的依赖之一，随它一起跑）：Rust 侧纯函数的内联单元测试（`#[cfg(test)] mod tests`，各模块自带，如 `track/mod.rs`、`track/keyframes.rs`），覆盖用真实素材很难或不可能构造的边界输入——比如 `select_candidate` 的近似打平、`.8` 对手边界、NaN 分数（含长度 ≥ 21 的候选数组，触发 `slice::sort_by` 的全序检查）与不同 canonical 画布。

解码是唯一依赖浏览器 API 的一步；之后配准、分层、位置图、合成、瓦片编解码全部在 Rust/Wasm 核心里，Deno 测试与浏览器加载的是同一份核心（三种构建之一），因此 Deno 里验证过的算法行为就是浏览器里的行为；浏览器测试负责解码、Worker、IndexedDB、OPFS 和界面这些核心之外的部分。

## 合成场景：真值是什么

每个场景由一个程序化生成的页面（`src/synthetic/world.ts`）和一条精确的 viewport 轨迹构成，逐帧无损渲染。校验器（`src/synthetic/verify.ts`）对每个运动层检查：

| 检查                | 含义                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxError`          | 每帧位置与真值的最大偏差，单位原像素                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `missing`           | 观察过却没有进入结果的像素数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `invented`          | 结果中存在、但不属于任何观察视口的像素数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mismatched`        | 覆盖像素的取值不等于该坐标在任何内容版本下的真值，且不能用遮挡解释                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `contaminated`      | 与页面不同但确实被动态内容或悬浮层覆盖过的像素，拆成 `contaminatedOverlay`（屏幕坐标覆盖物：悬浮按钮、滚动条、鼠标指针、toast；世界一致性掩码的目标是 0——同一像素若也落在页面坐标动态区域内，只算 overlay，不重复计入 dynamic）与 `contaminatedDynamic`（页面坐标动态内容：动画组件、实时计数器、闪烁光标、播放中的视频；允许保留某一个时刻）；各自有默认 0 的上限棘轮 `maxContaminatedOverlay`/`maxContaminatedDynamic`，`maxContaminated`（默认取两者之和）仍可作为合计上限单独声明，向后兼容。`contaminatedOverlay` 进一步精确拆成 `contaminatedOverlayUnobservable`（该世界位置在这块画布记录的任何一帧里都从未同时"在视口内"且"不在任何 overlay/dynamic 矩形内"——录制素材本身就没有干净证据，是场景自身覆盖物几何的属性，与检测/修复机制无关；断言测得值不超过同一算法在"该区域整段录制曾经可见的每个世界像素"上算出的解析上限，该上限另有自己的棘轮 `maxContaminatedOverlayUnobservable`，默认 0）与 `contaminatedOverlayRecoverable`（确实被干净观察到过至少一次，理论上应被修复；真正的目标，棘轮 `maxContaminatedOverlayRecoverable` 默认 0）；`unobservableProvisional`（unobservable 像素里有多少带有瞬态位）只汇报，暂不断言 |
| `provisionalPixels` | 主画布结束时仍未被世界一致性掩码修复的净瞬态像素数（`CanvasMeta.provisionalPixels`），有上限棘轮 `maxProvisional`（默认 0）。一个瞬态像素不等于一个错误像素：它可能是被降级、值其实完全正确的像素（`toolbar-collapse` 在测得 36,762 个瞬态像素时，这些像素与生成世界的平均                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fragments`         | 独立片段数量                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 诊断码              | 必须出现 / 必须不出现的诊断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 固定层              | 固定栏画布像素必须与观察一致且零冲突                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

除标注为”已知局限”或”像素级不可分辨”的场景外，**`missing`、`invented`、`mismatched` 必须为 0，`maxError` 必须为 0**；这几项之上还各有一个默认 0 的棘轮（`maxMissing`/`maxInvented`/`maxMismatched`/`maxContaminatedOverlay`/`maxContaminatedOverlayUnobservable`/`maxContaminatedOverlayRecoverable`/`maxContaminatedDynamic`/`maxProvisional`），只有测得的已知偏差才会显式声明为非 0，且只能往下调，不能悄悄调高。`maxContaminatedOverlayRecoverable`（真正的目标）在 `dynamic` 上**已经达成 0**；`phone` 与 `chrome-everything` 声明为 1,311 / 317（揭示阶段之后实测 1,249 / 302 的 +5%；只有投票时是 1,675 / 1,905），是按机制查清后确认的**已知局限**，不再是待办——成因单一且可逐像素复现：唯一的干净观察正好是录制的边界帧，被同一次成对分歧一起判为不一致而失去修复资格，而投票在录制边界上不可能有任何一次比较（见 `src/synthetic/scenarios.ts` 里各场景注释给出的具体世界像素与帧号）。本轮把 `phone` 从 2,817 降到 1,675、`chrome-everything` 从 7,870 降到 1,905、`dynamic` 从 442 降到 0，改动是六处：投票参照帧改为"最近两个 + 最远一个 + 位移分段内挑比较次数最少者"（`Ring::partners`，`rust/core/src/voting.rs`；`performance.consistencyVotedLayers`/`consistencyThinLayers` 是它的看门指标）；投票只在内点格比较（`RegionSlot.interior`）；投票结论改为三态并被 ±1 帧规则用来判定该归咎于哪一帧；`Compositor` 里"整块逐位相同即跳过"不再跳过仍带瞬态位的块，且被拒绝的观察若与已覆盖像素逐位相同会把它降级为瞬态；比较容差改为取自片源（`MediaInfo.noise`，无损场景 0 级即逐像素精确，压缩视频仍是 10 级）——这一项单独把 `chrome-everything` 的 4,243 降到 1,905、`dynamic` 的 199 降到 0，因为白色覆盖物画在接近白色页面上时平均 |ΔRGB| 只有 6，此前在任何比较里都与页面等同；以及 `verify.ts` 只在覆盖物**实际绘制过**的像素上记录 overlay 颜色（`RenderedFrame.beneath`）。`tests/unit/consistency.test.ts` 是投票机制本身的单元测试：构造一个比单帧位移更高的屏幕固定色块断言中段帧只标记色块内部、从不误标页面内容；构造一个"干净对照只存在于未来帧"的前沿色块断言 `consistencyThinLayers` 为 0 且色块仍被标出；并直接对 `consistencyMask()` 断言那条"唯一邻居被投票判定为不一致时不得连坐"的真值表。`retina`/`factor4`/`fixture`/`geometry-change` 场景（无覆盖物、无动态内容）是这套机制不应产生假阳性的回归测试，`provisionalPixels` 必须保持 0。已测得的具体数值与像素来源追溯见 issue #2，以及各场景自身在 `src/synthetic/scenarios.ts` 里的注释。

**片段（fragment）与主画布受同一套检查**：每个未被回访接回（`attachedTo` 未设置）的独立片段，都会按自己的局部坐标原点（该片段第一帧的实际落点）重新计算期望位置与期望覆盖集，与主画布一样断言 `missing`/`invented`/`mismatched`/`contaminated` 与 `covered > 0`。片段中包含缩放（`zoom ≠ 1`）帧时内容已被重采样，像素级比对没有意义，只检查帧计数与 `observedPixels > 0`（`pixelChecked: false`）。已被接回主画布的片段自身不持有瓦片，其帧数已经算在目标画布名下（观察台账里的 `canvasId` 已经是回访解析后的最终画布）。

**画布自身的瓦片台账**：与页面内容无关的一致性检查——每个有瓦片的画布（移动、固定、presentation 画布皆可），其 `tile-index/<id>/0/` 的行数必须等于 `CanvasMeta.tileCount`，把每个已存瓦片的 coverage 位图重新计数后求和必须等于 `CanvasMeta.observedPixels`。这只检查画布自己声称持有什么与实际持有什么是否一致，不涉及像素颜色或世界真值。

场景覆盖：二维非单调移动与回访、纵向滚动（变速 / 暂停 / 手抖 / 反向）、横向、斜向、高速 fling、同一区域三次经过、双 pane 独立滚动、无重叠跳转、页面内动画、懒加载改变内容、pinch zoom、大面积纯色、重复列表（单向可解 / 反向不可分辨两个变体）、长条漫画、手机竖屏（状态栏 + 导航栏 + 悬浮按钮 + 滚动条）、可变帧率与重复帧、2× 与 4× 分析因子（`factor4` 场景以 `analysisSize: 480` 运行才是真正的 4×——默认 640 下 `ceil(1920/640)` 只有 3×，断言现在检查 `Engine.factor` 本身，不只是描述文字）、录制中途尺寸改变、地址栏收起、六种动态元素同时存在、单帧一闪而过的内容、编码样本场景。

三个场景**声明**了不同的期望，而不是被放宽：

- `repeated-list-reversal`：完全相同的列表行中途反向，向上 15px 与向下 29px 在像素上无法区分。断言改为“误差只能是行高 44px 的整数倍”，并要求出现 `AMBIGUOUS_PATTERN` 与低置信标记；`invented`/`mismatched` 额外棘轮在今天实测值（563,200 / 73,026）之上 +~5%，不是无限放开。
- `toolbar-collapse`：地址栏收起使正文可视区在录制中途变大。断言只要求完成、报告冲突、错误像素低于 10%；`invented` 额外棘轮在今天实测值（48,360）之上 +~5%。这是已知局限，不是通过。
- `blank`：大面积纯色时无纹理帧不被画到任何位置，断言其产生 `UNOBSERVABLE_FRAME` 与独立片段。

## 运行测试与复现

`DEFAULT_SETTINGS` 包含 `framing: 'context'` 与 `compute: 'auto'`，这样 `deno task test`（不显式覆盖 settings 的每个场景）跑的是应用实际发货的配置——每个场景真正跑过带外框呈现阶段和 `auto` 的 WebGPU/CPU 校准，而不是被 worker 校验隐式降级成 `region`/`cpu`。测试与场景数量会随开发持续变化；不要把某一次跑出的数字当成固定基线，以 `deno task test` / `deno task test:browser` 自己这次的输出、以及 `test-results/` 为准。

用真实的字节级指纹（不是"测试通过"）找出一次改动实际改变了哪些持久化行：`deno task fingerprint out.json`（`scripts/fingerprint-scenarios.ts`）跑全部合成场景并哈希每一条持久化行（瓦片、证据、计划、观察、一致性判定、诊断……），只忽略随机 run id 与墙钟字段；`--pixels` 改为哈希 PNG 的解码像素而不是原始字节（证明一次 PNG 编解码改动只改字节、不改像素）；`--root <otherRepoRoot>` 对另一棵树重复同样的过程（在**那棵树自己的** `deno.json`/锁文件/编译选项下），用于 A/B 对比——比如 `deno run -A scripts/fingerprint-scenarios.ts b.json --root ../baseline`，再用 `scripts/compare-fingerprints.ts` 比较两份输出：这是变化检测器，不是逐像素一致性门槛——改动前后 `IDENTICAL` 是预期，但不同也不代表失败，每一类变化的行都要能对应到改动本身并在报告里说明原因，说不清楚的变化才是 bug。真实录屏上的 A/B 基准用 `scripts/benchmark-pipeline.ts --baseline-root <旧checkout> --verify-tiles`（同一次调用先后跑基准与当前）：`--verify-tiles` 在计时结束后额外哈希每块瓦片**解码后的像素**加 `coverage`/`provisional`/`quality`/`conflicts`/`owner`/`score`/`frozen` 全部证据数组（`sha256` 覆盖 PNG 字节本身，会随编解码器改动合法变化；`contentSha256` 只覆盖解码像素与证据，是判断"输出是否等价"的那个哈希），运行间或与基准不同就直接失败；`--dump-evidence REGEX` 额外把匹配瓦片的原始证据数组写出来定位差异。`scripts/e2e-recordings.sh [--baseline] <name>` 包一层，把结果连同瓦片 SHA-256 写进 `test-results/e2e-recordings/<name>/summary.json`。

| 测试                                                                       | 结果                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 六种容器解码（含两个 ReplayKit 风格样本）                                  | 各 43 帧，展示顺序单调，无异常通知（977ms）                                                                                                                                                                            |
| F18：声明旋转 90°（tkhd matrix，像素未转置）的容器                         | `canvasConverter` 正确旋转，原始像素不受影响（526ms）                                                                                                                                                                  |
| `test_case/` 全部五段真实录屏解码                                          | 394 / 1274 / 370 / 170 / 1152 帧，每个包都成为一帧，时间戳单调（59s）                                                                                                                                                  |
| 无损合成样本 + 五个编码样本在 Chrome 中重建                                | 位置误差 0，缺失 0，虚构 0，不匹配 0，固定栏零冲突；编码样本像素差异不超过该编码自身的解码基线（各 1s）                                                                                                                |
| 真实录屏端到端重建（`0.mov`，跳过 all，仅这一段）                          | 1418×1590 / 394 帧 → 主画布 1418×10778，observedPixels 15,283,204，约 28.5 秒（阶段耗时：scanning 9.5s / solving 8.4s / optimizing 0.5s / rendering 9.2s / framing 67ms / pyramid 0.6s）                               |
| 界面：选文件 → 探测 → 重建 → 刷新恢复 → 导出原尺寸 PNG                     | 通过，导出尺寸等于当前选中画布（`framing: 'context'` 下默认选中带外框呈现画布）的尺寸（2s）                                                                                                                            |
| 界面：内置演示 → Worker → ZIP64 导出 → 390×844 无横向溢出                  | 通过（4s）                                                                                                                                                                                                             |
| 界面：裁切（拖手柄 + 输入四边，跨 512px 瓦片接缝）→ 导出 → 刷新 → 裁回整张 | 裁切后的 PNG 与整张导出的对应窗口逐像素相同；刷新后导出字节不变；裁回整张后与整张导出 SHA-256 相同、不再保存裁切。产物：`test-results/page-tweaks/crop-e2e.json`（`deno test --allow-all tests/browser/crop.test.ts`） |

必须使用真实 Google Chrome，不能用 Playwright 自带的 Chromium（不含 H.264）；WebKit 一侧用 Playwright 自带的 WebKit （`npx playwright@1.58.2 install webkit`，见 README）。可用 `LONGSCREEN_CHROME` 或 `LONGSCREEN_CHANNEL` 覆盖 Chrome 路径。上面的数字是某一轮实测；`0.mov` 的画布尺寸与耗时会随 `DEFAULT_SETTINGS`（分析加速、外框策略）与硬件变化，重新测量请看 `test-results/`，不要照抄这里的数字当作恒定基线。

`deno task test:browser` 在 M5 Max 上约两分半跑完，目前没有已知的失败。两个只在有 `test_case/` 的主检出里才跑的真实录屏测试以前在主线上一直失败，现在都通过：`browser: real recordings in test_case/ decode completely…` 改为核对每一帧都带着它那个包的呈现时间（以前要求最后一帧不超过容器时长 + 0.1 s，而 e.mov 的最后一帧在编辑表结束之后 0.295 s，h 的最后一帧正好从时长处开始；这样的帧是屏幕的真实截取，照常保留），另留一条「不超过时长 1 s」的宽松界限，拦住把偏移读错到几百万秒那一类错误；`browser: real recordings reconstruct end to end…` 的 `CORE_NOT_LOADED` 来自测试自己在 Deno 一侧用 `decodePNG` 前没有加载核心，已补上。以前记录的两个 WebKit 失败（LAN HTTP 的 600 s 超时与平面转换的 `Decoder failure`）也都通过。任何失败都不是已知的。

`tests/browser/gpu-convert.test.ts` 覆盖 WebGPU 帧转换：真实解码帧和奇数尺寸的手工帧（I420/NV12、BT.709/BT.601、有限/全范围）与 Chrome 自己的 `copyTo(RGBA)` 的差距，BT.2020、旋转、没有 WebGPU、没有适配器、「仅 CPU」、首帧不一致、GPU 实测更慢时都不能走 GPU，选定 GPU 后设备丢失要让运行失败而不是换路，停在半路的一趟与下一趟逐字节相同，以及发货的 worker 转换链。Playwright 的 WebKit 没有 WebGPU，那一侧只验证干净地回退到平面转换。

`tests/browser/planes.test.ts` 覆盖揭示阶段的平面直转：在 Chrome 和 WebKit 里，转进常驻帧槽的像素必须与平面转换器的 RGBA 逐字节相同；新运行的第一帧（平面路径还没通过首帧比对）不能以平面交出；走浏览器自己 `copyTo(RGBA)` 的运行永远拿不到平面；同时持有几帧的平面时缓冲池不能复用其中任何一块；没被要的帧不带像素。

### 编码差异如何处理

同一份源像素，Chrome 的 H.264 路径解出来与源相差约每通道 1 级；VP9 路径则系统性偏暗（平均带符号差约 −19，最大 78）。这是解码器的色彩范围转换，不是重建错误。

因此编码样本测试**先测量该编码自身的解码基线**（frame 0 中已经超出容差的像素比例），再要求重建结果的不匹配率不超过这个基线。几何指标（位置误差、缺失、虚构、片段数）对所有编码一律精确断言。这样既不会用“放宽容差”掩盖差异，也不会把解码器的色彩行为算成算法缺陷。

## 覆盖率

`deno task coverage` 跑全部单元与场景测试，然后按**行覆盖率**逐文件设下限。下限是今天实际达到的数字，不是目标：任何文件掉下去就失败，只能往上棘轮。

`scripts/coverage.ts` 里的下限按最近一次全部测试通过、全部门槛达标时的实测重设。这里不再列逐文件百分比，避免和当前代码脱节还被当成基线。注意行覆盖率也取决于排版：整棵树用 `deno fmt` 重排后，原本挤在一行里的未执行分支会被拆成多行，逐文件百分比因此会在没有任何代码或测试改动的情况下移动（例如 `core/compositor.ts` 100 → 98.3、`pipeline/engine.ts` 91.5 → 87.4），下限也随之重设；不要把这种移动当成回退，也不要靠重新排版把数字抬回去。数字应以 `deno task coverage` 自己这次跑出的表格与 `scripts/coverage.ts` 里逐文件下限为准，或查看 `test-results/`。`core/compute.ts`、`core/framing.ts` 是本轮新增、此前从未被覆盖率门槛统计过的文件。

每个文件的下限是 `floor(当次实测值)`，只能往上走。`deno task coverage --update-floors` 会按最近一次结果重写下限表；请审查这个 diff，因为调低下限等于掩盖回退。门槛还会在两种情况下失败：`src/` 下（或 `main.ts`）有文件完全没出现在报告里且不在“仅浏览器”名单上；解析到的表格行数异常少（格式变化）。

覆盖率脚本本身曾有一个缺陷：它比较的是 `deno coverage` 表格的第二列（函数覆盖率）而不是行覆盖率，因此在核心目录实际只有 76–84% 时仍报告“达标”。已改为解析四列并以行覆盖率判定，并在解析到的行数异常时直接抛错，避免格式变化让门槛静默通过。

## 修正过的实际问题

本轮由真实录屏暴露并修正：

1. **QuickTime / ReplayKit 的有符号 `ctts`**：ISO 14496-12 只规定 version 1 的 composition offset 有符号，但 iOS 录屏在 version 0 的盒子里写负偏移。按无符号读会得到约 7,158,278 秒的时间戳，帧顺序被判为倒退，整段录屏失败。现在始终按有符号读取，并有 `negative-cts.mov` / `negative-cts-v0.mov` 两个样本与真实 `.mov` 的解析测试。
2. **`createImageBitmap(video)` 失败即无法开始**：界面原先依赖 `<video>` 元素读元数据和首帧。改为 worker 用 WebCodecs 解出第一帧并传回 `ImageBitmap`，`<video>` 只用于兼容模式与源时刻回看。
3. **负时间戳与倒退时间戳被静默丢弃 / 中止整段**：现在分别计数并作为诊断显式上报，解码顺序照常继续。
4. **容器声明尺寸与码流不符**：首帧以码流为准并记录 `CONTAINER_SIZE_MISMATCH`，其后的尺寸变化仍保留前缀并报错。
5. **分析缩图引入亚像素漂移**：改为整数因子盒式滤波，原像素精修半径随因子放大。
6. **固定栏边界只能落在分析格上**：新增原生分辨率的行 / 列统计，边界定位到原像素；上下左右四条静止带都会被识别。
7. **前沿新进内容被当成独立图层**：新进区域在上一帧没有对应像素，不再作为图层分裂证据。
8. **薄重叠的高速跳转在周期性排版里错位一个周期**：这类步长现在被标记，回访证据更强时整体改正轨迹并记录 `TRAJECTORY_CORRECTED`，里程计边按证据量降权。
9. **合成阶段逐像素调用遮罩函数**：改为一次性的原生分辨率归属图。

## 录屏格式

`tests/browser/formats.test.ts` 在 Chrome 和 WebKit 里用发货的转换链解码 `tests/fixtures/` 里几种非常规格式的固件，和编码前的合成帧逐像素比较（`scripts/make-fixtures.ts` 生成，真值仍是 `fixture` 场景）：`hdr-pq.mp4`（HEVC Main 10、BT.2020、PQ，普通白在 100 尼特，和 iPhone/Mac 的 HDR 录屏一样）、`hdr-hlg.mp4`、`hdr-pq.webm`（VP9 Profile 2）、`hevc-10bit.mp4`（10 位 SDR，Chrome 给的是无法拷贝的帧）。要求平均差 ≤5 级、差超过 24 级的通道值 ≤1%，HDR 的路线必须经 WebGL 编码值核对过，Chrome 不能落到 2D canvas。浏览器解不了的格式（`prores.mov`、WebKit 里的 `h264-444.mp4`）必须给出本地化的原因和建议。完整 10 位解码在这些固件上的理想值是 1.2–1.9 级。

更大的格式矩阵（22 种编码：H.264 各种标签与范围、4:4:4、High 10、MKV、VideoToolbox 编出的 H.264/HEVC、HEVC 8/10 位 SDR、PQ、HLG、VP8、VP9 及其 PQ、AV1 及其 PQ、ProRes）在 2026-10-10 用四个浏览器各跑过一遍，平均差（级）如下，“不能解”的格式都给出本地化错误：

| 格式                        | Chrome 154    | Safari 27     | Playwright WebKit 26                | Firefox 157 |
| --------------------------- | ------------- | ------------- | ----------------------------------- | ----------- |
| SDR H.264 / VP8 / VP9 / AV1 | 0.8–1.2       | 0.8–1.6       | 0.8–1.6（标 BT.709 的 H.264 为 12） | 1.0–1.4     |
| H.264 4:4:4、High 10        | 0.8、1.6      | 不能解        | 不能解                              | 不能解      |
| HEVC 8 位 / 10 位 SDR       | 0.9 / 2.9     | 1.4 / 1.1     | 1.4 / 1.1                           | 不能解      |
| HEVC PQ / HLG               | 2.4–2.8 / 1.8 | 2.6–3.0 / 1.9 | 2.6–3.0 / 1.9                       | 不能解      |
| VP9 PQ、AV1 PQ              | 3.9、4.1      | 3.1、3.4      | 2.5、3.2                            | 3.9、4.3    |
| ProRes                      | 不能解        | 不能解        | 不能解                              | 不能解      |

修复前 PQ 一行在各浏览器上都是 60–103 级。

兼容模式（原生 seek 一个 `<video>` 再截图）对 HDR 录屏原先用浏览器自己的颜色：iPhone 录屏的白色在 Chrome 是 184、在 Safari 是 140（应为 253–255）。现在 worker 请求不做颜色转换的截图（`createImageBitmap(video, { colorSpaceConversion: 'none' })`，`src/media/capture.ts`），用 WebGL 关掉颜色转换读回，在 Chrome 与 Safari 27 上都和 WebCodecs 帧的 WebGL 读回逐级一致（差 0–0.26 级），再交给核心按 PQ/HLG 换算；读不到编码值时保留浏览器的颜色并报 `HDR_UNCHECKED`。`formats.test.ts` 在 Chrome 与 WebKit 上用这条路解 HDR 固件（平均差 1.8–3.2 级），`compatibility.test.ts` 经页面的取帧桥跑完整重建并断言没有 `HDR_UNCHECKED`；真实录屏 g、h 在 Chrome 与 Safari 27 上与精确路线平均差 0.07–1.19 级。

Chrome 里 iPhone 录屏的白色是 253，不是 255，原因在 Chrome 内部，不在我们的换算：h 的白色是 10 位 Y=509、色度 512，准确值是 99.9 尼特、sRGB 255；Chrome 把 10 位 HDR 帧交给 WebGPU 外部纹理之前先量化成 8 位的 sRGB 编码值（这个像素在外部纹理里读到 188.5/255，准确值是 188.86/255），换回 PQ 是 98.3 尼特、sRGB 253。Chrome 的另外两条路也不更好：WebGL 读回同样是 8 位（129 → 253），2D canvas 自带色调映射且每帧约 350 ms。2 级在解码噪声（10 级）之内，测试不断言 255。

Playwright 自带的 WebKit 26 会对标了 BT.709 传递函数的 SDR H.264 做颜色管理，中间调提亮约 12 级（未标注的不会）；Safari 27 不会，这一点测试不断言，记在这里免得被当成回归。

## 真实录屏

`test_case/` 中的录屏不进仓库。存在时测试会自动使用，缺失时跳过。已实际跑通：`c.mov`（3456×2234，170 帧，H.264 Main）在 Chrome 中完整解码并重建，输出 3456×4594 的主画布，69 个原尺寸瓦片，位置图残差 0。这验证了解码与端到端管线，**不是对任意真实录屏的准确率结论**：真实录屏没有逐像素真值，只能检查解码完整性、帧计数、时间戳单调、状态完成与可视检查。

性能基准另外用了几段用户提供、同样不进仓库的录屏（放在仓库根目录旁，用绝对路径传给 `benchmark-pipeline.ts` / `scripts/e2e-recordings.sh`）：`e.mov`（3456×2234 H.264，935/936 帧）、`1.mov`（1418×1590 H.264，381/391 帧）、`d.mov`（1920×1240 HEVC/hvc1，1152 帧，VFR，用于 Safari/WebKit 崩溃排查，还有一份 ffmpeg 转的 H.264 等价物 `d264.mov` 用于计时）。这三段都以 `NEGATIVE_TIMESTAMP_SKIPPED` 结束为 `partial`（容器帧数 ≠ 可展示帧数），基准需要 `--allow-partial`。已测得的具体耗时、阶段分解与 Chrome/WebKit 对照见 [docs/history/2026-09-rust-migration-log.md](history/2026-09-rust-migration-log.md)——那些数字会随硬件和后续改动变化，不要当作当前基线，只把"跑得完、输出一致"当作已验证的事实。

### 局部真值（recording oracles）

真实录屏没有整图真值，但有一些位置能从原生帧里确知应该是什么：`docs/benchmarks/2026-10-03-recording-oracles.json` 按录屏列出这些世界矩形（f 22 处、c 7 处、0 两处，a、b、d、e 少量仅供参考），`scripts/check-recording-oracles.py` 把输出画布与 ffmpeg 独立解码的原生帧逐像素比较。检查分几种：纯色（例如 c 的滚动条轨道必须是白的）、与指定原生帧足够接近、白字不能变暗，以及「完整时刻」——整片区域必须完整来自同一帧，并且与那一帧足够接近。完整时刻只认揭示阶段的 `reveal/<canvas>` 来源行（docs/FORMAT.md）：整片覆盖的每一块都必须是同一帧的整块拷贝。

```sh
deno run --allow-all scripts/benchmark-pipeline.ts --input test_case/f.mov --export-canvases --no-profile --output test-results/oracles/f
python3 scripts/check-recording-oracles.py --clip f --video test_case/f.mov --result test-results/oracles/f
python3 scripts/check-recording-oracles.py --clip f --video test_case/f.mov --result test-results/oracles/f --reference browser --output test-results/oracles/f/browser-reference
```

ffmpeg 的 RGB 转换与浏览器在锐利色边上不一样（色度插值不同），f 的蓝色图标在完全正确的输出上也会差出约 8 级，所以这一项按 ffmpeg 参照会失败。`--reference browser` 让 ffmpeg 只解出 YUV 平面，再按应用自己的转换（YUV 矩阵，色度在像素中心双线性插值；Chrome 对硬件解码帧的 `copyTo(RGBA)` 与它逐像素差 ≤ 1）生成参照。两种参照的结果都报告，不拿后者替换前者。Safari/WebKit 在 CPU 上做平面转换（色度取最近采样点，与 ffmpeg 一致），情况正好相反：f 的蓝色图标按 ffmpeg 参照通过（平均差 1.66），按浏览器参照差约 8 级。清单里的位姿与时间是按主线的几何记录的；几何变了（哪怕一像素）检查会报错要求重新核对映射，而不是悄悄比较错位的内容。

检查器本身的失败情形在 `python3 scripts/test_recording_oracles.py` 里：两帧拼成的、留着合成器像素（−1）或逐像素混合（−2）的块都不能认作完整时刻，负世界坐标与网格边界要算对，别的画布的来源行不算数，版本不对或块数与网格不符的行直接报错；停下、失败、部分完成或帧数对不上的运行不能拿来认证任何像素。

## 性能基准（CodSpeed）

核心算法的性能在每个 PR 上自动测：`.github/workflows/codspeed.yml` 在 PR 和推到 `main` 时运行 `rust/bench` 的基准，结果上传到 CodSpeed，由它把 PR 与 `main` 最近一次运行对比并在 PR 里留言。这个工作流只管测量，不挡部署：生产环境仍由 Cloudflare Pages 自己构建。

**测试用例。** `rust/bench/cases.json` 列出公开测试录屏：8 段由仓库所有者专门录制、可以公开的录屏（2 段 SDR H.264 桌面录屏，6 段 HDR PQ/BT.2020 的 10-bit HEVC，含 3 段 iPhone 录屏；其中一段拍的是所有者自己的照片，test_4 是公有领域的《蒙娜丽莎》）。每段记着文件名、字节数、SHA-256、ffprobe 读出的编码、尺寸、像素格式、色彩参数和帧数（按 `-fps_mode passthrough` 逐帧计数，录屏都是可变帧率）。录屏本身作为 GitHub Release `test-cases-v1` 的附件发布，不进仓库；所有者用 `bash scripts/upload-test-cases.sh <录屏目录>` 上传，脚本先按清单核对每个文件再创建 release。

**固定片段（fixture）。** 整段 4K 录屏在 CPU 模拟下跑不完，所以每段只取清单里 `window` 指定的 3 个连续有运动的帧。`cargo run -p long-screen-bench --bin cases -- fixtures` 下载缺失的录屏（`curl`，下载后核对 SHA-256），再用 ffmpeg 按原像素格式解出这几帧的 YUV 平面（不缩放、不转换格式，`-fps_mode passthrough`），并核对清单里记录的 fixture SHA-256；10-bit 的帧在读入时取高 8 位，即浏览器 `VideoFrame.copyTo` 交给核心的 8-bit 平面，PQ 的帧因此走核心的 HDR 转换路径。macOS 上的 ffmpeg 9.0.2 与 Ubuntu 24.04（amd64）的 ffmpeg 6.1.1 解出的 fixture 逐字节一致；换了解码器而哈希不同时命令直接失败，不拿不同的字节去比。改了窗口或解码参数时，要把清单里的 `extractor` 加一，再用 `-- fixtures --write-hashes` 重新记录哈希。fixture 约 300 MB，放在 `rust/target/bench-fixtures/extractor-N/`，从不提交；CI 以 `cases.json` 的哈希为键缓存它，命中缓存时不用下载录屏。

**基准项。** `rust/bench/benches/kernels.rs` 用 divan（CodSpeed 的兼容层 `codspeed-divan-compat`）对每段录屏各测一次这些核心函数：YUV/HDR 转 RGBA、原尺寸亮度、分析灰度图、特征提取与匹配、运动估计、原尺寸精修、层学习、一致性掩码、投票环、整帧合成到 512 瓦片、金字塔父瓦片、瓦片 PNG 编码。输入都在计时之外准备好，参数与应用默认值一致（`analysisSize` 640、480 个特征、512 瓦片、噪声 10）。

**本地运行。**

```sh
deno task bench                     # 生成并核对 fixture，然后用 divan 计时全部基准
LONGSCREEN_CASES=/path/to/public_test_cases deno task bench   # 录屏已在本地时不下载
cargo install cargo-codspeed --locked --version 5.0.2
cd rust && cargo codspeed build -p long-screen-bench --profile bench-native && cargo codspeed run -p long-screen-bench
```

`LONGSCREEN_CASES` 指向已有录屏的目录（只读，不下载），`LONGSCREEN_FIXTURES` 改 fixture 目录，`LONGSCREEN_CASES_URL`（含 `{file}`）从别的地址下载。基准用 `bench-native` 配置（release 的优化设置加 bench 目标需要的 unwind）。本地没有 CodSpeed 的模拟器时，`cargo codspeed run` 只把每项跑一遍检查能否运行。

**CI 里怎么测。** CodSpeed 的 CPU 模拟（simulation）模式在模拟 CPU 上把每项只跑一次，结果不受共享 runner 负载影响，系统调用不计入；公开仓库上传结果不需要 token，fork 来的 PR 也能上传（[文档](https://codspeed.io/docs/integrations/ci/github-actions)）。墙钟（walltime）模式需要 CodSpeed 的专用机器（免费计划每月 600 分钟），目前没有用。

**局限。** 这些是核心的原生构建：跑的是标量代码，不是浏览器实际加载的 WebAssembly SIMD128 路径，也不含多线程。浏览器里的解码（WebCodecs）、GPU 转换、IndexedDB 存储和整条管线的耗时仍要用 `scripts/benchmark-pipeline.ts` 在 Chrome/WebKit 里测。目前只有单个函数的基准；重建管线移到 Rust 之后，在 `rust/bench/benches/` 里加整条管线在每段窗口上的端到端基准（`kernels.rs` 开头留了 TODO）。

## 仍未验证

- 实体 Safari / iPhone / iPad / Android 全流程。移动尺寸截图不能替代真机。手机上的转换路线（iOS Safari 的 HDR 平面、Android Chrome 是否也交出无法拷贝的帧）只靠首帧核对兜底，没有实测。
- 300MB+ / 10 分钟以上真实录屏的完整三遍重建耗时与内存峰值。
- 4GiB 以上导出、长期运行功耗。
- 瓦片缓存上限（运行设置里的「瓦片缓存上限」）只约束自有瓦片缓存，放不下一帧要画的瓦片时自动加大（`MEMORY_BUDGET_RAISED`），不包括解码器、GPU、浏览器与核心的内存。
