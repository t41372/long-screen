# 模型、取舍与实现

## 一、问题不是累加 scrollY

合理的未知量至少包含：每层画布 C、每帧每层位姿 T、随时间变化的可见掩码 M、内容状态或版本 V，以及无法与其他部分建立关系的连通分量。观察是这些层在某时刻的组合，不是整页唯一静态图的无条件裁剪。

```text
I_t(u) ≈ compositing over layers k of M_(t,k)(u) · C_(k,V_t)(T_(t,k)(u))
```

本实现把可求解的主体限制为**分层平移** `T(u)=u+p`，把不符合该模型的证据放进诊断、时间冲突和独立分量。不是完整的动态场景生成模型。

纵向长截图是 x 位移接近零的特例；像素存储、位置图、区域判定和导出都不要求 y 单调。回滚不是删除或追加，而是再次观察同一坐标。

### 可辨识性不是多写几个 if 能消除的

完全相同的空白帧，可以来自暂停，也可以来自穿越白色区域。两张完全一样的列表卡片可以处于同一位置或相隔多个周期。没有重叠的两幅图不能仅由像素得出它们之间差多少距离。

因此“尽可能完整”不等于“一定只输出一个矩形”。多个独立片段加明确的未知关系，通常比一张错误接好的长图更有价值。测试套件把这一点写成断言：`repeated-list-reversal` 只要求误差是行高的整数倍并给出歧义警告，而不是要求答对。

## 二、为什么三遍

```text
第一遍  逐帧运动证据 + 全局运动区域学习      → 磁盘
第二遍  分层定位、原像素精修、历史重定位、位置图 → 磁盘
第三遍  按校正后的坐标做原分辨率瓦片合成
```

后面的回访约束可以修正前面的轨迹，同时不必把所有完整帧留在内存。代价是三次解码和多次磁盘访问，**不是实时处理承诺**。

## 三、薄 TypeScript 外壳 + Rust/Wasm 核心

解码是唯一依赖浏览器 API 的一步（`FrameSource` 产出 `RGBA` 而不是 canvas，`VideoFrame → RGBA` 的转换是注入的函数）。配准、分层、位置图、合成、瓦片编解码、一致性投票等全部算法都在 `rust/core`，编译成 WebAssembly；TypeScript 只做 UI、Worker RPC、浏览器 I/O（WebCodecs / IndexedDB / OPFS）与编排。迁移过程的历史记录见 [docs/history/2026-09-rust-migration-log.md](history/2026-09-rust-migration-log.md)（哪一轮做了什么，只记录过程，已完结，不再更新）；当前哪些模块在 Rust 里、哪些刻意留在 TypeScript 里，见下面§十一的代码地图与§十二的决策表，出现分歧以 `rust/core/src/lib.rs` 的 `mod` 列表与树本身为准。

核心以三种 Wasm 构建交付，`planCore()`（`src/core/wasm/loader.ts`）按运行环境能力选择：

- `core.wasm`（scalar）：没有 SIMD128 时的兜底。
- `core.simd.wasm`（SIMD128）：默认，SIMD128 可用、页面未跨源隔离或不满足线程条件时使用。
- `core.threads.wasm`（SIMD128 + 共享内存原子）：要求页面 `crossOriginIsolated`、支持 SIMD、有 `Worker`、逻辑 CPU ≥ 2；helper 线程数为 `min(CPU−1, 7)`。跨源隔离需要静态托管发送 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`（`static/_headers`，Cloudflare Pages / Netlify 支持；开发服务器 `deno task start` 也发这两个头）。不满足任一条件时退回 simd/scalar，原因写进 `COMPUTE_BACKEND` 诊断的 `detail.core` 并由 `CorePlan.reason` 报告，不是静默降级。
- Deno 测试默认加载 SIMD 构建；`LONGSCREEN_CORE=scalar|threads` 环境变量切换（`tests/support/core.ts`），线程数另有 `LONGSCREEN_THREADS`（默认 3）。构建产物在 `rust/target/{scalar,simd,threads}/wasm32-unknown-unknown/release/`，由 `bash scripts/build-core.sh` 生成（`deno task build:core`）；不要用裸 `cargo build`，`rust/.cargo/config.toml` 固定的是 scalar 的编译参数，裸构建会覆盖 SIMD 产物。

之前几轮迁移过程中的性能测量方法（A/B 基准 `benchmark-pipeline.ts --baseline-root`、`.baseline` git worktree 对照、`scripts/e2e-recordings.sh` 真实录屏基准）见 [测试说明](TESTING.md)。

- **分析缩图**是整数因子的盒式滤波（`analysisFactor` / `downscaleGray`，`rust/core/src/raster.rs`），不是 canvas 重采样。因子 f 意味着分析位移 ×f 恰好是原像素位移，原像素精修半径随之取 `max(3, ⌈f/2⌉+1)`。
- **瓦片编解码**由 Rust 侧的 `image-rs` `png` crate 及其 deflate 后端驱动（两端字节一致），不是自制编解码器，导出的仍是标准 PNG。
- **区域归属**在扫描结束后一次性展开成原分辨率的 `RegionAtlas`（每像素一个字节），合成内层循环查表而不是调用函数。

Deno 测试与浏览器跑的是同一份 Wasm 核心（不像迁移前那样"同一份 TS 代码在两种环境里跑"），因此 Deno 里验证过的算法行为就是浏览器里的行为；浏览器测试负责解码、Worker、IndexedDB、OPFS 和界面这些核心之外的部分。

## 四、输入与解码

`BlobReader` 默认缓存 8 个 256KiB 页面，按范围读取头、样本表和媒体包，不调用整段输入的 `arrayBuffer()`。

MP4/MOV 解析普通 sample table 与 fragmented `trun`：DTS/CTS、sync sample、chunk offset、size table、旋转、简单编辑列表。**composition offset 始终按有符号读取**：ISO 14496-12 只规定 version 1 有符号，但 QuickTime / ReplayKit 在 version 0 的 `ctts` 里写负偏移，按无符号读会得到约 7,158,278 秒的时间戳并判定帧序倒退——这正是本项目最初对真实 iOS 录屏全部失败的原因。

WebCodecs 支持查询在启动前完成。按展示顺序消费输出、处理 B 帧、主动 `close()`；背压限制 decode queue、输出队列与在途请求。解码期的异常一律显式化，不静默：负时间戳帧按容器语义不展示但**计数并上报**；时间戳倒退时保留解码器顺序并上报，不再中止整段录屏；首帧尺寸与容器声明不符时以码流为准并上报，其后的尺寸变化保留前缀并报错。

## 五、运动候选与独立验证

分析图灰度化 → 平滑 → 空间均衡角点 → 256-bit BRIEF。匹配分为互为最近且有距离裕量的 distinctive matches 与显式保留的 ambiguous alternatives。二维位移直方图产生多个平移候选。

**局部描述子的唯一性不是页面位置的唯一性。** 定位阶段对每个候选做独立的重叠像素 audit：只看有纹理的像素，统计整体误差、明显不一致比例、真实重叠面积，以及 32×32 区块中有多少**与该位移一致**。区块统计把“页面整体按这个位移移动了，只有一个组件在变”与“这个对齐根本不对”区分开——前者是动画或懒加载，后者才是错误。

随后在**原像素**上精修并复核：`refineNative` 返回整数位移、残差和“离胜者两像素以外的最好残差”，后者小就说明存在周期性歧义。候选排序带一个弱的匀速先验，用来在周期别名之间打破平局。

关键帧另存 24 块 32×32 的**原分辨率纹理片**（几 KB）。回访检索先用视觉词投票、再用分析尺度 audit 初筛，最后一律用这些纹理片在原像素上判定，因此重定位精度不受分析因子限制。检索到任何一个落在别处的合理解，就把这次回访标记为歧义而不使用。

### 薄重叠的高速跳转

移动很快时只剩一小条重叠。在周期性排版里，相邻周期同样能解释这一小条像素，而且因为样本少，错误对齐的残差同样很低。这类步长被标记（`THIN_OVERLAP_STEP`），其里程计边在位置图中降权到 0.05；若随后的回访给出更强的原像素证据，整段轨迹被改正并记录 `TRAJECTORY_CORRECTED`，同时说明此前写入的像素保持原样、可能存在接缝。

## 六、分层

`LayerLearner` 在整段录屏上累计证据，而不是逐帧判断：相邻单元格的运动分歧、行/列切分增益、每行每列的时间变化量。

边界用**原生分辨率**的行列统计定位到像素，分析格只决定归属。四条静止带（上、下、左、右）都会被识别，但侧边带额外要求**自身有可见结构**：均匀的页面留白不会被当成侧栏，否则导出的长图会丢掉页面边距。两个 pane 之间的分隔条取最靠近切分位置的低变化列段。

前沿新进的内容在上一帧没有对应像素，任何竞争假设都会在那里“获胜”，这不是图层分裂的证据，已排除。面积不足最大内容层 8% 的小块运动区域并入最近的大区域：悬浮按钮旁边的一条缝不是嵌套滚动容器。

## 七、合成与时间冲突

合成不做跨帧透明度平均。像素有明确归属：未覆盖处写入，已覆盖处按分数决定是否整块替换。检测到冲突区域后，尽量选择一次**完整观察**整块保留或更新，并记录来源帧和时间；区域从未完整出现在一个视口里时保留诊断，不编造。

### 世界一致性掩码与瞬态像素

不随页面移动的屏幕坐标覆盖物（悬浮按钮、滚动条、鼠标指针、toast）如果被直接按世界坐标写入，会把自己烧录进移动画布——它们在屏幕上位置不变，但对应的世界坐标每帧都在变。渲染阶段用单帧前瞻消除这类烧录：`src/pipeline/render.ts` 的 `RenderPass` 把解码提前一帧缓冲（`pending`/`pendingPrev`），使合成第 t 帧时，第 t−1 帧的原生像素已经在手，第 t+1 帧也已解码完毕。对每个未跳过的移动区域观察，`consistencyMask()`（`src/pipeline/consistency.ts`，分派到 Rust `consistency_mask`）按屏幕像素比较"这一帧在世界坐标 W = 屏幕坐标 + pose(t) 处的内容"与"相邻帧（t−1、t+1）在同一世界坐标处的内容"——只在相邻帧对同一层的位置解析到同一张画布、且换算出的相邻帧屏幕坐标落在该帧和该区域的归属掩码内时才比较；比较用精确 RGB 相等作为快速路径，否则用平均绝对差 ≤ **本片源声明的解码噪声**（`MediaInfo.noise`，`Engine.noise` getter）判定一致。

**比较容差是片源的属性，不是算法的常数。** 同一个世界像素在两帧里到底"一不一样"，取决于这些帧是怎么来的：H.264/VP9 的锐边振铃与 4:2:0 色度重建会让单个通道差出好几级，这与本项目做什么无关，所以解码视频（`PreciseSource`/`CompatibilitySource`）声明 `DECODED_VIDEO_NOISE = 10`，与一直以来的阈值完全相同；而合成场景与内置 demo（`ScenarioSource`/`DemoSource`）的像素是无损产生的，声明 0，于是**逐像素精确比较**。这不是把阈值调松或调紧，而是不再让无损片源替压缩视频的余量买单：一个画在 `[251,250,246]` 页面上的 `[255,255,255]` 悬浮按钮图标，平均 |ΔRGB| 只有 6，在 ≤10 的容差下与页面完全等同——`chrome-everything` 约 2,880 个、`dynamic` 全部 262 个残留污染像素就是这么来的，改用片源自己的噪声后它们才第一次被看见并修复。下面投票的阈值由同一个旋钮导出，整条流水线只有这一个可调量；本次运行用的是哪个值会写进 `MODEL_ASSUMPTIONS` 诊断的 `detail.noise`，因为"精确比较过"和"允许了 10 级余量"是两种不同的证据，事后从像素本身看不出来。

**±1 帧比较本质上是"成对不一致"信号：它只说明这两帧里有一帧是错的，不说明是哪一帧。** 因此判定规则是：只要有任一可比较的相邻帧不一致，本帧该像素即判为不一致——**唯一的例外**是该像素只有一个可比较的相邻帧（另一侧越界、不在同一画布或不在归属掩码内），且下面的环形投票**独立地**在同一世界位置判定那个邻居本身不一致：此时这次分歧归咎于邻居，本帧保持一致。没有这条例外，一段录制的最后一帧只要紧邻一帧被悬浮按钮遮住，自己也会被判不一致，于是再也没有任何观察能修复前一帧留下的瞬态像素（`phone` 世界像素 (335, 3217) 就是这个形状）。有两个可比较邻居时不适用这条例外——证据已经足够，宁可多标一个可被后续修复的瞬态像素，也不要漏掉一个永久烧录。完全没有可比较的相邻帧（例如整段录制的第一帧，或 `glimpse` 场景中只被扫过一次的内容）按一致处理——没有证据不等于证据说它错，孤例内容仍必须画出来。`consistencyMask()` 的注释里有完整真值表。

`Compositor.add()` 接收这份掩码（`consistent`，与 `labels`同尺寸、逐像素一字节），据此维护瓦片新增的 `provisional` 位图（与 `coverage` 同布局）：新像素总是写入，只是若不一致就顺带标记为瞬态；已覆盖且被标记瞬态的像素，只要新观察在该处一致就会被覆盖并清除标记——**不受该块的 `replace`/`frozen` 状态约束**，因为 `frozen` 防的是"重新挑选某个时刻"，不是"修复屏幕覆盖物留下的错误像素"；已覆盖且未被标记瞬态的像素，绝不会被判定为不一致的观察覆盖，即使块级 `replace` 满足也不行。

**被拒绝的观察如果与已覆盖像素逐位相同，会把那个像素降级为瞬态（只标记，不改写）。** 覆盖物第一次扫到某个世界位置时，往往正是"落笔"的那一帧：此时该像素还没被覆盖，而 ±1 帧比较要么在前沿没有可比较的邻居、要么因为邻居也在同一覆盖物下而"一致"，于是覆盖物被当成正常内容写下且不带瞬态标记；标记要等一两帧后才出现，那时写入已经被上一条规则挡住，错误就此永久烧录。既然被拒绝的观察在该处显示的正是已存的值，那个已存像素的证据强度不会高于刚被拒绝的这次观察，因此把它降级为瞬态、留给后续一致观察修复。判定用**逐位相等**，而不是上面那条按片源噪声取的容差：容差会把"内容确实不同但差别不大"也算进来，而那恰恰是块级冲突判定要保护的东西。

**整块逐位相同的观察会在更早一步被短路跳过**（`identical === count`），但这个短路现在要求该块没有未修复的瞬态位：一次一致观察即使无字可写，也仍然要清除它能清除的标记。反过来，一次完整复现整块内容的观察是**佐证**而非反证，所以上面那条降级规则刻意不在这里生效。块级 `replace` 只对"一致或默认一致"的像素生效。冲突检测本身（`TEMPORAL_OR_ALIGNMENT_CONFLICT`）仍然看到全部像素，不受这份掩码影响；但 `resolveTemporal()` 选择"完整时刻"整块覆盖时，要求候选观察在整个冲突分量的每个像素上都一致——包含鼠标指针的一帧不能被当成"完整时刻"。仍带有瞬态像素的块，质量分数会被封顶（`rust/core/src/compositor.rs:526` 的 `t.quality[q].min(64)`），让质量遮罩能标出它们。`CanvasMeta.provisionalPixels`/`TilePayload.provisional` 记录当前仍未被修复的瞬态像素净数，会随后续观察涨落，不是单调递增的累计值。

页面坐标内的动态内容（动画组件、正在播放的视频、实时计数器）不受这套机制约束为零——它们允许保留某一个时刻的完整快照，只是同样会被世界一致性掩码判定为"不一致"（因为相邻帧的世界坐标处内容也在变化），因此也会带着瞬态标记，直到某次观察恰好与相邻帧一致才会被摘掉。

单帧前瞻并非在所有几何下都完全消除屏幕覆盖物：当覆盖物自身在屏幕上的尺寸大于相邻帧之间的页面滚动位移时（例如一个高度明显超过单帧滚动速度的滚动条滑块），该覆盖物中段像素在 t−1、t、t+1 三帧里换算出的世界坐标附近可能仍然全部落在覆盖物范围内，一次相邻帧比较无法把它和真实页面内容区分开——这是仅靠 ±1 帧比较这套方法本身的数学局限，不是实现缺陷。

### 位移展开一致性投票

为弥补 ±1 帧比较对"覆盖物尺寸超过单帧滚动速度"这类几何的失效，`solve()`（`src/pipeline/solve/solve.ts`）额外维护一份跨越更大时间跨度的证据：一个按分析分辨率保存的环形缓冲（`Ring`，`rust/core/src/voting.rs`），每帧只保留各移动区域当时的画布 id / pose 与一份区域自有的、box 本地坐标系下的比较用灰度（`Ring::box_gray`，见下），按字节数定 budget（约 24MB，不保留原生分辨率帧）。对每个移动区域这一帧的最终 pose，从环里挑选最多 6 个满足"世界位移 ≥ Dmin"的历史帧作为参照——Dmin = max(64, 0.25×min(区域宽, 区域高)) 原生像素，取值刻意大于任何合理的覆盖物尺寸，同时远小于视口本身。

参照帧的挑法（`Ring::partners`）同时服务两件互相拉扯的事：

- **展开。** 合格候选按位移排序后，**最近的两个**、**最远的一个**总是入选，其余名额在剩下的区间里等分成若干段各取一个。每个候选本来就已经过了 Dmin，所以"覆盖物不可能同时在两帧的同一世界位置"这件事任何一个候选都成立；展开要防的是下面结算注释里量化的那个巧合——干净像素会和"位移恰好把该世界位置送进那一帧自己覆盖物范围"的参照帧不一致，而那是一个与覆盖物等宽的位移窗口。参照帧挤在一小段位移里就会整批落进或整批落出这个窗口，展开让这些巧合彼此独立。最近的两个是专门为**前沿**留的：一个世界位置刚进入视口时，能看见它的合格参照帧全部在未来，而未来帧里离它最近的那两个正是与它重叠最多的。
- **公平。** 每段之内选**已比较次数最少**（`Layer.pairs`，位移大者优先破平）的那一个。只按位移挑会反复挑中同几个锚点帧，于是"自己的干净对照只存在于未来帧里"的那些帧（滚动前沿上的内容，任何过去帧都还没到那里）几乎不会被任何未来帧选中，结算时只有两三次比较甚至一次都没有。由于每次比较同时给**两**帧记分（见 `Ring::compare`）、而一帧要离开环才结算，晚来的比较一样算数。`performance` 里的 `consistencyVotedLayers`/`consistencyThinLayers` 就是这条性质的看门指标：后者统计结算时比较次数不足以下任何正面结论的层，正常应当为 0（`tests/unit/consistency.test.ts` 有专门断言）。

比较只在**内点**格上进行（`RegionSlot.interior`，每区域算一次）：该格自身与 3×3 均值的全部取样格都在本区域内，且 ±`Ring.radius` 的局部搜索窗完整落在 box 内。两条排除都指向同一个实测失效——区域边界上的格会拿"邻居根本没有的值"去比较：`Ring::box_gray` 用中心格原值替换越界取样（边缘复制，对均值本身是对的），而参照帧对应的格通常不在它自己的边界上、用的是完整 9 点均值，两者因此差一个与内容相关、与覆盖物无关的偏置；被裁剪的搜索窗只在一侧少候选，偏向同一个方向。这些偏置不会在多个参照帧之间抵消，于是在**前沿**——那里一个格本来就只有两三次比较——足以凑出一次全票的假"不一致"，在 `retina` 上实测到（页面正常内容，附近根本没有覆盖物）。

每对比较落在分析分辨率的同一世界像素上（换算方式与 ±1 帧一致，只是坐标除以分析因子），用 ±`Ring.radius`（随分析因子缩放：`Ring.radius = f`）范围内的局部搜索取最小灰度差（阈值 `Ring.tau`，见下），容忍位姿在亚分析像素级别的残余误差和抖动，而不是要求恰好落在四舍五入后的同一格——这一层局部搜索是原生分辨率 ±1 帧比较不需要的（原生分辨率没有这种量化）。**比较用的灰度不是 `downscaleGray` 的原始输出，而是 `Ring::box_gray` 算出的区域自有 box 本地 3×3 均值**：`downscaleGray` 的取样网格固定在每帧的屏幕像素 (0,0)，不随世界内容移动，所以同一个世界像素在帧 T 与参照帧 S 里，只要两者的 pose 差不是分析因子的整数倍（几乎总是如此），就会落在网格里不同的"亚格相位"上——纯色内容不受影响，但 `factor4`/`retina` 这类精细边框/文字内容会因此产生真实但与覆盖物无关的灰度差，用临时逐比较直方图测得并确认（不是编造）。3×3 均值抹平这种取相位敏感的高频噪声，同时仍能清楚区分覆盖物；均值只取"同一区域"的相邻格（`regionContains` 过滤，越界或落在另一个区域/邻近固定覆盖物范围内的格改用中心格自身的原始值代替，而不是直接跳过不算）——直接跳过被排除的格会在区域自身边界上让均值样本变少、抹平力度减弱，留下比整体更小但依然非零的残留；直接不做区域过滤会让相邻固定区域的恒定颜色渗入区域自身的边界行/列（在 `fixture`/`geometry-change` 上实测到，被排除格全落在 box 的第一实际行）。**该均值只在 f>1 时计算；f=1（分析即原生分辨率）时直接使用原始值**——f=1 时不存在上述取样相位问题，均值反而会因为区域边界的不对称处理（当前帧的边界格用中心值加权、被比较帧对应位置一般不在其自身边界、用的是未加权均值）引入一个新的、内容梯度相关的小偏差，实测同样在 `fixture`/`geometry-change` 上出现且被 f=1 门控彻底消除。

投票的一致阈值 `Ring.tau` 由上面同一个旋钮导出，但多了一项 ±1 帧比较不需要的余量：`downscaleGray` 的取样网格固定在屏幕像素 (0,0)，所以 f>1 时同一个世界像素在两帧里落在不同的亚格相位上，这是**同一批无损像素的两个平均值之间**真实存在的差，算不到解码噪声头上，也不会因为片源无损而消失（`Ring::box_gray` 的 3×3 均值只是压低它）。因此 `Ring.tau = max(f === 1 ? 0 : phase, round(noise × 2.6))`，其中 `phase = 26`（该常量已内联进 `Ring::new`，不再具名，只在源码注释里留了 CONSISTENCY_PHASE 这个名字）是在 `factor4`/`retina`（都是无损片源）上实测的相位余量，且与均值本身同一个门控条件——只在 f>1 生效；f=1 时分析即原生分辨率，根本不存在相位项，无损片源于是同样精确比较。取 `max` 而不是相加，是为了让解码视频拿到的仍然精确是它一直以来的 26。

每次比较同时更新两侧（当前帧与参照帧）各自的净分数（一致 +1／不一致 −1）与比较次数，一帧离开环（或 `solve()` 结束）时才结算。结算阈值不是字面的"≥2 次比较、净分数 <0"，也不是要求与全部参照帧一致：比较次数为 2、3 时仍要求逐一致（⌈0.75×2⌉=2、⌈0.75×3⌉=3），比较次数 ≥4 时只需 ≥75% 的净不一致比例（`threshold(comparisons) = comparisons − 2×⌈comparisons×0.75⌉`）。要求全部一致曾经是必要的：一个持续存在、每帧都画在同一屏幕位置的覆盖物，会让"恰好有一两个参照帧的自身覆盖物位移窗口"碰巧落在被测世界坐标附近，从而让页面上完全干净的像素也偶然和某个参照帧不一致，简单多数会被这种巧合污染（`tests/unit/consistency.test.ts` 用专门构造的夹具证明并量化了这一点）；但全票要求本身也有代价——参照帧不足 6 个的帧（录制首尾附近，或同画布帧数少）永远无法标出任何东西，且哪怕只有一个参照帧碰巧一致，也会挡住其余 5 个一致同意的修复。上面的 3×3 均值把取相位噪声压低到足以改用比例阈值而不重新引入巧合误标——`factor4`（该均值机制的专门回归测试，见该场景注释）、`retina`、`tests/unit/consistency.test.ts` 均已验证。结算结果以分析分辨率位图形式写入 `consistency/<frame>`（见下一段的三态编码；只有当某个区域至少有一格拿到结论时才写这一行）。

结算写出的不再只是"不一致"一份位图，而是**三态**（`ConsistencyVote`）：`bits` 是判定不一致的格，`clean` 是以同一比例阈值的镜像（`score ≥ −`threshold`(comparisons)`，即 3/3、3/4、4/5、5/6 次一致）且比较次数 ≥3 的格，两者都不在的格**没有结论**（比较次数不足以判断，前沿和录制首尾的常态）。这个三分是必需的：上面 ±1 帧那条例外要问的是"那个邻居自己被判定为不一致了吗"，而"没被标出来"和"被判定为干净"要求完全相反的处理。正面结论要求 ≥3 次比较，因为它被用来推翻原生分辨率的直接证据；两次全票不一致足以引起怀疑（标记瞬态可以被后续修复），但不足以推翻直接证据。

渲染阶段读取 `consistency/<frame>` 以及**相邻两帧**的同一份记录（`VotingWindow` 类，`src/pipeline/render.ts`，用一个四槽滑动窗口把每帧三次查询摊成一次），按分析因子放大到原生分辨率（原生像素所在的分析格不一致，则原生像素不一致）。投票判定不一致的像素直接不一致；否则走上面的 ±1 帧规则，而"只有一个可比较邻居"那条例外正是查邻居帧的这份记录。两套机制此后共享同一条 `Compositor.add()` / `provisional` 位图流水线。

每帧每区域的比较次数因此固定在 6 次以内（`voting::PARTNERS`），与录制长度无关。

即便如此，投票机制也不是万能的，且"检测到不一致"与"实际被修复"是两个不同的问题。`src/synthetic/verify.ts` 把每个 overlay 归因的污染像素精确拆成两类：`contaminatedOverlayUnobservable`（该世界位置在整段录制里**从未**被干净观察到过——比如页面从不发生水平滚动、覆盖物又逐帧无条件绘制在同一屏幕列，或悬浮按钮落在视口自身的滚动前沿、后续没有足够剩余视频让它移到未来某帧的前沿；这是场景本身的几何/素材属性，用与污染像素完全相同的算法在"该区域整段录制曾经可见的每一个世界像素"上重新计算一遍即可得到这个上限，与检测/修复机制无关）与 `contaminatedOverlayRecoverable`（该位置确实被干净观察到过至少一次，理论上应当被修复，目标是 0）。`dynamic` 已经达到目标（recoverable 与 contaminatedOverlay 都是 0，两个棘轮都是默认值 0）；`phone` 1,675、`chrome-everything` 1,905 仍未达到，并且已经作为**已知局限**按实测值 +5% 显式声明（`maxContaminatedOverlayRecoverable` 1,759 / 2,001），因为成因已经查到单一机制、可以逐像素复现：

**唯一剩下的机制是"唯一的干净观察正好是录制的边界帧"。** 残留里没有一个像素低于比较阈值（`phone` 全部是 |ΔRGB| ≈ 100 的滚动条灰与悬浮按钮橙；`chrome-everything` 只剩 194 个在 ≤10 以内），而且大多数**已经被正确标记为瞬态**（`phone` 1,675 里 1,240 个、`chrome-everything` 1,905 里 1,615 个）——缺的不是检测，是一次**有资格修复它们**的观察。形状永远相同：某个世界位置在录制只剩一两帧时才从滚动前沿进入视口，第一次落笔时正好被覆盖物盖住（该帧唯一可比较的邻居要么越界、要么同样在覆盖物下并与之"一致"），而唯一干净的那一帧是录制的**最后一帧**（或最前一帧），于是被同一次成对分歧一起判为不一致，失去修复资格。`consistencyMask()` 的"唯一邻居"例外正是为这种情况设计的，但它需要投票独立判定那个邻居不一致，而投票在录制边界上没有任何结论——一个在只剩一两帧时才进入视口的世界位置，在所有位移过 Dmin 的环形参照帧里都不在屏幕上，根本不可能产生任何一次比较。这是录制在哪里结束的属性，不是检测器的缺陷。实例：`phone` 世界像素 (382, 45)（帧 0–1，录制开头）、(335, 3217) 与 (387, 3072)（帧 62–64，录制结尾），`chrome-everything` 世界像素 (603, 2209)（帧 51–52，最后一帧）。

顺带排除了一个怀疑方向：`RegionSlot.interior` 排除在投票之外的边界格**不是**原因——`phone` 1,675 个残留里只有 2 个在每一个观察帧里都落在被排除的格上，`chrome-everything` 1,905 个里一个也没有。

已测得的残留数值、逐像素溯源，以及三个被实测否决、不要重新推导的方向，记录在 issue #2。

## 八、输出

原尺寸磁盘瓦片 + 覆盖位图 + 有限 LRU 缓存。查看器只绘制可见区域，预览金字塔按 alpha 加权减半，不让未观察像素把已观察像素拉暗，且不改写 level 0。

导出：完整项目 ZIP64（原尺寸瓦片、离线查看器、覆盖与质量信息、逐帧记录、位置图、诊断），或当前画布 PNG / 二维分页（流式编码，超尺寸时分页并记录坐标与重叠，不静默缩小）。未观察像素保持透明。

## 九、明确没有做的

- 通用非刚性 reflow、任意嵌套滚动、跨 zoom 的统一重建。检测到比例变化时保留独立片段并报告倍率，不缩放混合。
- 语义识别（视频播放器、弹窗、sticky 元素）。处理的是视觉变化区域。
- 断点续算。可以恢复已提交结果，不能从中断帧继续计算。

Rust/Wasm 核心（scalar/SIMD128/threads 三种构建，见 §三）、WebGPU 分析加速与第三遍重复帧跳过都已实现，不在上面这份清单里：

`AnalysisComputer`（`src/core/compute.ts`）用一个 WGSL compute shader 做盒式滤波降采样（灰度 luma + 整数因子降采样），只加速 `gray()` 这一步；特征匹配、位置图求解、像素合成全部保持 CPU 算法不变。`auto` 模式在第一帧同时跑 CPU 与 GPU 路径，要求逐字节位精确（`bitExact`）且 GPU 实测（含上传、kernel、回读）比 CPU 快，否则整段运行退回 CPU；适配器缺失、分配失败、设备丢失、超时都通过同一个回退路径保留观察，不是静默降质。`explicit webgpu` 模式跳过速度比较但仍要求首帧位精确。校准结果记录在 `performance.json` 的 `compute` 字段。`Params` uniform 缓冲区必须按 WGSL 的 16 字节 struct 对齐分配（五个 u32 仍要凑够 32 字节），否则 Chrome/Dawn 会按这个最小绑定尺寸校验并拒绝——Deno 自带的 wgpu 曾经并不校验，这个差异一度让该问题只在真实 Chrome 里现形。

`ScanPass`（`src/pipeline/scan.ts`）扫描阶段对逐字节相同的连续帧（`equalRGBA` 精确匹配，不是感知相似）跳过重复的运动估计：复用上一帧的运动场与特征，`performance.json` 的 `exactDuplicateFrames` 记录跳过次数。这只影响扫描阶段的重复工作，不改变输出像素或覆盖集合。

### 混合坐标系的位置图与接回几何

位置图里的每个节点活在**它自己画布的坐标系**里，不是一个全局统一坐标系：一个独立片段被回访证据接回主画布之前，它的节点坐标是片段自己的局部坐标；接回之后，新产生的节点才直接是目标画布坐标。跨画布的回环边（loop edge）记录的是**原始位姿差**——`state.pose − keyframe.local`——这个差值本身已经包含了目标画布的接回位移（`Attachment.dx/dy`）与本次重访的 offset，因此连接图时不能再减一次接回位移，否则会被减两次。渲染阶段反过来：从一个片段画布出发，如果它已被接回，渲染位移要把 `Attachment.dx/dy`（测量时相对目标关键帧节点的刚性位移）再加上该目标锚点节点自己经过全局优化后的 correction（`attachedRenderShift`），因为接回之后目标画布自身的节点还会因为后续的里程计/回环边继续移动，片段必须跟着走，而不是冻结在接回瞬间的位置。

### 长基线图层学习

`LayerLearner` 不止看相邻帧：当逐帧位移小于一个分析像素时（例如极慢的滚动），单帧证据不够可靠地把固定栏和内容区分开。除了逐帧证据，学习器还累计帧 t−k 与帧 t 之间的长基线比较——只有累计位移足够大时才纳入统计——这样慢速滚动仍能积累出可用的行/列切分增益，而不必等到运动本身变快。逐帧与长基线证据共享同一套判定阈值，不是两套独立标准。

## 十、不要误改的不变式

下面每一条都对应一次实测到的失效，改动前请先确认自己知道它为什么在那里。§七 对其中一致性相关的几条有完整推导，这里只给结论与出处。

### 解码

- **`ctts` 偏移在两个版本里都按有符号读取**（容器解析已交给 npm 包 mediabunny，它本身就这样读；本项目只在 `src/media/isobmff-probe.ts` 里加了一个轻量探测，专门用来在版本 0 出现负偏移时补上 mediabunny 没有的诊断）。版本 0 的负偏移会推送 `NONSTANDARD_SIGNED_CTTS_V0` 消息，以 `MEDIA_NOTICE` 码、`warning` 级别呈现；这个级别只标记非规范（QuickTime/ReplayKit）编码，不表示文件坏了。

### 几何与分层

- **分析降采样必须保持整数因子**（`src/core/raster.ts` 转发到 `rust/core/src/raster.rs`）。非整数因子会重新引入亚像素漂移，在几百帧上累积。
- **静止的侧边带只有在自身具备可见结构时才算固定 UI**（`stationaryBoundary`，`src/core/layers.ts` 转发到 `rust/core/src/chrome.rs::stationary_boundary`）。去掉这个检查，页面的空白边距会被判成侧栏，导出的长截图就少了边距。
- **前沿新进的内容不算图层分裂的证据**（`src/core/motion.ts` 转发到 `rust/core/src/motion.rs`）。它在上一帧没有对应像素，任何竞争假设都会在那里默认「获胜」。移除这条会让每一次快速滚动都碎成片段。
- **薄重叠步长（`THIN_OVERLAP_STEP`）的里程计边降权到 0.05，且回访改正必须发生在 `graph.add` 之前**（`src/core/pose-graph.ts::PoseGraph`：节点/边的 KV I/O 与调用顺序，TS 编排层；单趟 Gauss-Seidel 松弛本身已在 `rust/core/src/pose_graph.rs`，见十二节），这样里程计边记录的才是改正后的几何。降权与改正是一套，拆开任何一半都会让周期别名的快速跳转重新错位。
- **跨画布回环边的 delta 是原始位姿差** `state.pose − keyframe.local`，它已经包含目标画布的接回位移。连接边时再减一次会双重计算，重新打开接回本应闭合的接缝（见 §九「混合坐标系的位置图与接回几何」）。

### 合成与瞬态像素

- **`TemporalRegion` 的 `complete` 意思是「这次观察重写了该块以前覆盖过的每一个像素」**，不是「该块有 256 个覆盖像素」。只有部分覆盖历史的块，以部分覆盖达成 `complete` 是合法的（`src/core/compositor.ts` 是 TS 编排层，负责 `temporal/` 行的 KV I/O 与调用顺序；连通分量（`temporalComponents`）与决策（`resolveTemporal`，对应 Rust 的 `TemporalIndex::decide`/`mask_complete`/`commit`）都已下沉到 `rust/core/src/temporal.rs`，单瓦片的逐像素合成在 `rust/core/src/compositor.rs::composite_tile`）。
- **`Compositor.resolveTemporal` 的 `maskComplete` 检查是整个连通冲突分量上的全有全无，不是逐像素的。** 带着指针/悬浮按钮的观察不是一个好的「完整时刻」，即使它是该区域的第一次完整视图。这是单独设计的不变式，不要随手放宽；它也**不是**覆盖物污染残留的原因（已逐像素查证排除，见 issue #2）。
- **任何相邻帧都无法比较的像素默认为一致，不是不一致**（`src/pipeline/engine.ts`/`src/pipeline/render.ts`，编排仍是 TS，逐像素判定在 `rust/core/src/consistency.rs::consistency_mask`）。只出现在一帧里的内容（`glimpse` 场景）仍然必须画出来；把「没有证据」当成「拒绝」会让每个首尾帧和每次短暂回访变成窟窿。
- **瞬态像素可以被一致的观察覆盖修复，即使所在块是 `frozen` 的。** `frozen` 防的是重新挑选某个时刻，不是修复屏幕覆盖物的烧录；像普通替换那样用 `!frozen` 挡住修复路径会让烧录永久化（§七）。
- **`identical === count` 短路必须保留 `&& !provisionalInBlock` 例外**；反过来，降级规则刻意不作用于被逐位完整复现的块——那是佐证而非反证（§七）。
- **降级判据必须是逐位相同，不是容差。** ≤10 的容差会连「确实不同但接近」一起抓进来，而那正是块级冲突逻辑负责的事（§七，`tests/unit/compositor.test.ts` 两侧都有断言）。
- **`MediaInfo.noise` 只是片源的属性。** 不要把它变成设置项、按场景的覆写或相似度阈值。世界一致性掩码的每一次比较、以及 `Ring.tau`，都从它导出（§七）。
- **一致性投票的几条构造缺一不可**：`Ring.radius = f` 随分析因子缩放；只在内点格比较（`RegionSlot.interior`）；参照帧「最近两个 + 最远一个 + 分段内挑比较次数最少者」；结算是比例阈值而非字面全票；结论是三态而非一份位图；`Ring::box_gray` 在 f>1 时区域掩码 + 边缘复制、在 f=1 时完全关闭。每一条都对应一次实测的假阳性或漏报，推导见 §七。
- **`consistencyMask()` 的「唯一邻居例外」只在该像素恰好有一个可比较邻居时适用。** 放宽到两个邻居实测让 `chrome-everything` 从 4.2k 涨到 27k（§七）。

### 呈现画布

- **`src/core/framing.ts`（编排）/ `rust/core/src/framing.rs`（`openFramingSession` 实现）必须保持 O(周长瓦片 + 已观察源瓦片)。** 那个只做网格算术与查找、不碰像素的前置检查，正是为了让大面积装饰背景不会强制一次完整包围盒扫描；去掉它会把稀疏外框变成意外的稠密画布。

### 界面语言

- **共享的 `src/i18n/index.ts` 从不读取 `navigator` 或存储，默认 zh。** Deno 也有 `navigator.language`；共享模块一旦读取它，单测、场景指纹和导出文本就会随主机语言变化。只有页面端的 `src/i18n/page.ts` 检测语言，worker 在收到任何命令之前由页面发来的 `locale` 消息得知语言（`src/ui/rpc.ts`）。
- **zh 目录里的文案就是持久化文本。** 诊断的 `message`/`action` 按运行时的界面语言写入并持久化，场景指纹按 zh 计算；改动一条 zh 文案会改变指纹，这是需要解释的变化，不是噪声。
- **区域与画布名称是固定的 zh 词表，只在显示时翻译**（`src/i18n/names.ts`）。`rust/core/src/regions/crops.rs` 按 `固定分隔界面` 这个名字查找分隔带，parity oracle 与已保存的项目也都存着这些名字；在创建时就按界面语言命名会同时破坏这三者。

### 测试

- **`src/synthetic/verify.ts` 只在覆盖物实际绘制过的像素上记录 overlay 颜色**（与 `RenderedFrame.beneath` 比较）。overlay 的 rect 是包围盒，有些覆盖物只画其中一部分（鼠标指针是 10×16 盒子里的一个箭头）；按整个 rect 记录会把页面坐标的动态内容算成屏幕覆盖物污染，并错误地在 `contaminatedOverlay` 与 `contaminatedDynamic` 之间划分。
- **各场景的棘轮只能往下调**（`maxMissing`/`maxInvented`/`maxMismatched`/`maxContaminated*`/`maxProvisional`）。调高一个来让运行通过是在掩盖回退。调高需要的是一个查清的机制，不是一次测量；`maxContaminatedOverlayRecoverable` 对任何没有查清理由的场景保持默认 0。

## 十一、代码地图

下面按目录列出每个模块归属，标注它属于哪一层：**TS 外壳**（细分为 UI / worker RPC / 浏览器 API / I/O / 编排）、**Rust 算法核心**，或**绑定**（TS↔Wasm 的双向封送层）。清单由 `find src rust/core/src -type f | sort` 生成，不是凭记忆写的；出现分歧以树本身为准。

**一域三文件规则**：算法核心的每个领域都拆成三个同名文件——`rust/core/src/<域>.rs`（纯算法，无 FFI）↔ `rust/core/src/abi/<域>.rs`（该域的 `extern "C"` 导出，序列化/反序列化）↔ `src/core/wasm/<域>.ts`（TS 侧的对应封送模块）。例如 `raster`：`raster.rs` 算法、`abi/raster.rs` 导出、`wasm/raster.ts` 封送。两个域例外，都是因为体量被拆成多文件：`regions`（算法侧 `rust/core/src/regions/{mod,atlas,bands,band_fn,cells,construct,crops,merge,tests}.rs`，binding 侧仍是单个 `abi/regions.rs` ↔ `src/core/wasm/regions.ts`）与 `track`（binding 侧也拆成 `abi/track.rs` + `abi/track_{odometry,reacquire,keyframes}.rs` ↔ `src/core/wasm/track.ts` + `wasm/track-{odometry,reacquire,keyframes}.ts`，算法侧仍是单个 `rust/core/src/track.rs`）。`pool`/`geometry`/`region`（单数，`filter_features` 等，供 `regions`/`framing`/`voting` 共用）没有对应的 `abi/*.rs` 独立入口或被多个域共用，不算独立的"域"；`png`/`yuv` 现在各自都有完整的三文件（`png.rs`/`abi/png.rs`/`wasm/png.ts`，`yuv.rs`/`abi/yuv.rs`/`wasm/yuv.ts`），不再是例外。

### src/core（绑定层 + 少量仍待迁的算法转发）

- `wasm.ts` — 桶文件，把 `src/core/wasm/*` 的每个导出重新导出给三十多个调用方（现测 31 个，数字随新文件漂移，不必追求精确；用 `grep -rl "from '.*core/wasm\.ts'"` 之类的命令重新数），保留 `import { core } from './wasm.ts'` 这条旧路径。绑定层。
- `wasm/core.ts` — `Core`：加载/持有 Wasm 实例（含可选的线程池）、`core().x(...)` 的统一入口，把每个内核调用委派给对应域模块。绑定层。
- `wasm/exports.ts` — `rust/core/src/abi/*.rs` 导出的 `extern "C"` 签名类型、内存布局常量、状态码约定。绑定层。
- `wasm/loader.ts` — `planCore()`：按 SIMD128/threads/crossOriginIsolated 能力选择 scalar/simd/threads 三种构建之一并加载为 `active` 单例。绑定层，兼 TS 外壳（浏览器能力探测）。
- `wasm/marshal.ts` — 每个域模块写入核心内存的公共封送原语（`writeRect` 等）。绑定层。
- `wasm/memory.ts` — 核心内存所有权：bump arena 的规划、`Resident`/`ResidentFrame`/`ResidentGray`/`FrameRing` 等跨调用常驻句柄。绑定层。
- `wasm/raster.ts` — 像素格式转换与逐像素光栅内核封送（镜像 `abi/raster.rs`）。绑定层。
- `wasm/features.ts` — 角点/描述子提取、匹配、视觉词封送（镜像 `abi/features.rs`）。绑定层。
- `wasm/motion.ts` — 平移/缩放假设、audit、精修、运动场封送（镜像 `abi/motion.rs`）。绑定层。
- `wasm/chrome.ts` — 固定边界与吸附遮挡带检测封送（镜像 `abi/chrome.rs`）。绑定层。
- `wasm/consistency.ts` — 世界一致性掩码封送（镜像 `abi/consistency.rs`）。绑定层。
- `wasm/compositor.ts` — 单瓦片合成（冲突/替换、coverage、quality）封送（镜像 `abi/compositor.rs`）。绑定层。
- `wasm/temporal.ts` — 时间冲突连通分量、`overwritePatch` 像素写入、内存态时间索引与 `resolveTemporal` 决策封送（镜像 `abi/temporal.rs`）。绑定层。
- `wasm/framing.ts` — 呈现画布合成的两趟逐瓦片调用封送（镜像 `abi/framing.rs`）。绑定层。
- `wasm/pyramid.ts` — 金字塔父瓦片装配封送（镜像 `abi/pyramid.rs`）。绑定层。
- `wasm/png.ts` — 单 PNG 导出路径的扫描行 (un)filter 封送（镜像 `abi/png.rs`）。绑定层。
- `wasm/pose-graph.ts` — 位置图松弛的有状态 handle 封送（镜像 `abi/pose_graph.rs`）。绑定层。
- `wasm/layers.ts` — `LayerLearner` 逐帧证据累加 handle 封送（镜像 `abi/layers.rs`）。绑定层。
- `wasm/regions.ts` — 一次性区域构建与原生分辨率像素打标封送（镜像 `abi/regions.rs`）。绑定层。
- `wasm/track.ts` — 逐区域逐帧跟踪判定与关键帧候选评分封送的共用小工具（`b`/`b2`/`writePatches`/`resolveNative`），`export *` 重新导出下面三个拆分模块，供 `wasm/core.ts` 的 `import * as track from './track.ts'` 免改（镜像 `abi/track.rs`）。绑定层。
- `wasm/track-odometry.ts` — 逐区域逐帧里程计融合调用（`odometry`），从 `wasm/track.ts` 拆出（镜像 `abi/track_odometry.rs`）。绑定层。
- `wasm/track-reacquire.ts` — 重定位与漂移改正融合调用（`reacquire`/`driftCorrection`），从 `wasm/track.ts` 拆出（镜像 `abi/track_reacquire.rs`）。绑定层。
- `wasm/track-keyframes.ts` — 关键帧候选评分融合调用（`evaluateCandidates`），从 `wasm/track.ts` 拆出（镜像 `abi/track_keyframes.rs`）。绑定层。
- `wasm/voting.ts` — 位移展开一致性投票环 handle 封送（镜像 `abi/voting.rs`）。绑定层。
- `wasm/yuv.ts` — 解码帧到 RGBA 的平面/半平面转换封送（`frameToRGBA`，供 Safari 等不支持 `copyTo` 直转 RGB 的浏览器使用；镜像 `abi/yuv.rs`）。绑定层。Deno 下会被 `core.ts` 桶文件间接引入而出现在覆盖率报告里，但函数体从不在 Deno 下执行，`scripts/coverage.ts` 给它单独的 0 下限而不是 BROWSER_ONLY。
- `helper.ts` — 线程构建（`core.threads.wasm`）的 pool helper worker 入口，在共享内存上实例化并常驻。TS 外壳：浏览器 API（Worker）。
- `id.ts` — `createId`：优先 `randomUUID`，非安全上下文回退 `getRandomValues`。TS 外壳：浏览器 API。
- `math.ts` — `clamp`/`median`/`pad`/`intersect`/`contains`/`norm`/`rng` 等与领域无关的纯数值/几何小工具，供 Rust 尚未接管的编排代码使用。TS 外壳（编排用的纯函数，未来若被算法路径复用可考虑下沉）。
- `raster.ts` — `analysisFactor`/`downscaleGray`/`equalRGBA`/`RasterPose` 等转发到 `rust/core/src/raster.rs` 的薄封装。绑定转发层。
- `motion.ts` — `estimateMotion`（真编排：帧间惰性求值判断）加两个仅供调用方沿用的类型别名（`NativeRefinement`/`Patch`）；`extractPatches`/`probeScale`/`refineNative`/`refinePatches` 这些一行转发在 d029e6b 被删，调用方现在直接用 `core().x(...)`。绑定转发层，兼少量编排。
- `layers.ts` — `LayerLearner`（累加器 handle 持有者）、`RegionAtlas`（原生分辨率标签平面持有者）、`stationaryBoundary`/`stickyOcclusions` 的转发；`regionContains` 的 TS 副本已删（R6-B，过滤逻辑移进 `rust/core/src/region.rs::filter_features`，见十二节 track 行），一次性构建仍留少量 TS 胶水（对象封送）。绑定转发层，兼少量编排。
- `compositor.ts` — `Compositor`：瓦片缓存遍历、时间冲突分量/记录（内存索引，转发到 `rust/core/src/temporal.rs` 的 `temporalComponents`/`resolveTemporal`）、`add()`/`overwritePatch` 的 TS 侧编排，单瓦片像素合成已下沉到 `rust/core/src/compositor.rs`。TS 外壳：编排，绑定单瓦片内核。
- `framing.ts` — `buildFramedCanvas`：瓦片缓存遍历、O(周长瓦片) 候选预检查、KV 读写；两趟逐瓦片像素工作转发到 `wasm/framing.ts`。TS 外壳：编排。
- `keyframes.ts` — 关键帧原分辨率纹理片存取、回访检索；候选的 audit/精修/置信度/排序/最强候选/对手歧义判定全部在 Rust（一次 `core().keyframesEvaluateCandidates` 调用直接返回选中的候选），`evaluateCandidates` 现在只是把 `canonical` 映射解析、按目标画布 id 装箱成整数索引传进去，再把选中的候选装回 `Relocalization`，详见十二节 track 行。TS 外壳：编排，混合绑定转发。
- `pose-graph.ts` — `PoseGraph`：节点/边的 KV I/O 与 `Map` 迭代顺序构建，`optimize()` 的停止检查点循环；单趟 Gauss-Seidel 松弛转发到 Rust。`correction()`（≈6 次浮点运算）保留纯 TS，见十二节。TS 外壳：编排 + I/O。
- `compute.ts` — `AnalysisComputer`：WGSL compute shader 做灰度+整数降采样，首帧 CPU/GPU 位精确校准与自动回退；只加速 `gray()`。TS 外壳：浏览器 API（WebGPU）。
- `wasm/*` 之外没有其它未列出的核心域模块。

### rust/core/src（算法核心）

- `lib.rs` — crate 入口与三构建说明；`abi` 是唯一带 `extern "C"` 的模块。Rust 算法核心（模块声明）。
- `abi/mod.rs`、`abi/memory.rs`、`abi/wire.rs` — FFI 总纲、线性内存分配/越界检查/handle 表、共享字节布局与小端读取器。绑定（Rust 侧 FFI 层，被下面每个 `abi/<域>.rs` 复用）。
- `abi/raster.rs`、`abi/features.rs`、`abi/motion.rs`、`abi/chrome.rs`、`abi/consistency.rs`、`abi/compositor.rs`、`abi/temporal.rs`、`abi/framing.rs`、`abi/pyramid.rs`、`abi/png.rs`、`abi/pose_graph.rs`、`abi/layers.rs`、`abi/regions.rs`、`abi/track.rs`、`abi/track_odometry.rs`、`abi/track_reacquire.rs`、`abi/track_keyframes.rs`、`abi/voting.rs`、`abi/yuv.rs` — 对应域的 `extern "C"` 导出，逐个镜像 `src/core/wasm/<域>.ts`（见一域三文件规则）。绑定。
- `raster.rs` — 原生帧光栅内核：luma、盒式分析降采样、预览减半。Rust 算法核心。
- `features.rs` — 角点检测（3×3 结构张量最小特征值，整数前缀和）与二值描述子。Rust 算法核心。
- `motion.rs` — 平移/缩放假设生成、patch 误差、audit、整数精修。Rust 算法核心。
- `chrome.rs` — 固定边界持续性外观边、吸附遮挡带检测。Rust 算法核心。
- `consistency.rs` — 单区域世界一致性掩码（±1 帧证据 + 投票环终审）。Rust 算法核心。
- `compositor.rs` — 单瓦片像素归属合成：块级冲突/替换决策、coverage/provisional 记账、像素写入。Rust 算法核心。
- `temporal.rs` — 时间冲突连通分量、`overwrite_tile`、内存态 `TemporalIndex`/`resolveTemporal` 决策。Rust 算法核心。
- `framing.rs` — 呈现画布布局/坐标映射、背景扩展统计、逐瓦片两趟绘制。Rust 算法核心。
- `pyramid.rs` — 四子瓦片（含空洞）减半装配为父瓦片；减半本身复用 `raster::halve_rgba`。Rust 算法核心。
- `png.rs` — 单 PNG 导出路径的扫描行 (un)filter；瓦片编解码走 `abi/png.rs` 的 `png` crate 端到端路径，不经过这里。Rust 算法核心。
- `pose_graph.rs` — Gauss-Seidel 位置图松弛，纯数组/CSR 输入，不认识字符串 id。Rust 算法核心。
- `region.rs` — 泛型 `Region<M: AsRef<[u8]>>::contains`（矩形、排除区、可选原生裁剪、分析分辨率掩码查询，对掩码存储是拥有还是借用泛型化，供 `voting.rs`/`track.rs` 与 `regions::atlas` 共用同一份实现）与 `filter_features`（`ownFeaturesOf` 的区域成员过滤，R6-B 从 TS `regionContains` 移入）。Rust 算法核心。
- `regions/mod.rs` + `{atlas,bands,band_fn,cells,construct,crops,merge,tests}.rs` — 一次性区域构建流水线（并查集分格、条带检测、区域装配、原生精度裁剪、小块合并、最终过滤）与原生像素打标；逐阶段从冻结的 TS oracle（`tests/support/reference/layers.ts`）移植。Rust 算法核心。
- `layers.rs` — `LayerLearner` 逐帧累加证据（行/列分歧、split/evidence/activity），冻结为 `tests/support/reference/layers.ts` 的字节对照基准。Rust 算法核心。
- `track.rs` — 逐区域逐帧无状态跟踪判定（不确定度、重定位判定、attach/thin-overlap/loop-closure 判定、关键帧候选评分等），含 `odometry`/`reacquire`/`driftCorrection` 与关键帧候选评分的置信度 `exp()` 收尾，以及关键帧候选的排序/最强候选/对手歧义判定（`select_candidate`），见十二节。Rust 算法核心。
- `voting.rs` — 位移展开一致性投票环：ring buffer、box-gray、interior、partners、compare、finalize，有状态 handle。Rust 算法核心。
- `pool.rs` — 线程构建下把独立分块工作分发给共享内存 helper worker 的数据并行 `for`；非线程构建内联顺序执行。Rust 算法核心（并行基础设施）。
- `geometry.rs` — 与 JS `Math.round`/`Math.floor` 精确对齐的取整/几何约定。Rust 算法核心（共享工具）。
- `yuv.rs` — 平面/半平面 YUV → RGBA（libyuv 参考算法），供不支持 `copyTo` 直转 RGB 的浏览器（Safari）使用。Rust 算法核心。

### src/pipeline（编排 + 尚未迁移的算法转发）

- `engine.ts` — `Engine`：一次重建运行的公开门面，`run()` 编排（阶段顺序、计时、性能行、终态、资源释放）。TS 外壳：编排。
- `context.ts` — `RunContext`：每趟共享的状态与服务，存储/诊断/进度/暂停/停止管线。TS 外壳：编排。
- `scan.ts` — 扫描趟解码循环编排；`estimateMotion`/`LayerLearner` 的调用仍是待迁移算法转发（累加器本体已在 Rust）。TS 外壳：编排 + 绑定转发。
- `presentation.ts` — `run()` 在 scan/solve/render 之后驱动的 framing 与 pyramid 展示阶段；本身不含算法，失败只降级为警告诊断。TS 外壳：编排。
- `render.ts` — 渲染趟：单帧前瞻、放置解析、固定区域重复绘制检测、一致性掩码咨询与合成调用、观察台账、周期性落盘。TS 外壳：编排。
- `consistency.ts` — `consistencyMask()` 本身已转发到 `rust/core/src/consistency.rs`；这里只是画布身份闸门（邻居必须解析到同一画布）与常驻/普通数组入参形态选择。TS 外壳：编排 + 绑定转发。
- `attachments.ts` — 沿片段接回链查找片段最终解析到的画布，纯图结构查找，非算法。TS 外壳：编排。
- `features-codec.ts` — 一帧 `Feature[]` 的磁盘编码（三个定长 TypedArray），纯存储编码，非算法。TS 外壳：I/O（存储编码）。
- `solve/solve.ts` — 求解趟：建立位置图/关键帧索引/逐区域状态/帧环/atlas 标签平面/原生亮度平面/投票环，帧循环驱动 `stepRegion()`，计划/一致性批处理，图优化收尾。TS 外壳：编排。
- `solve/region-step.ts` — 每区域每帧的外壳：调用 `track.ts` 的纯判定并按原始顺序应用（诊断、关键帧索引/位置图 I/O、新画布、投票、遮挡检测、放置构造）。TS 外壳：编排。
- `solve/keyframe-step.ts` — 关键帧/回访半边：是否铸造新关键帧、回访检索、片段接回、薄重叠轨迹改正、回环记账，按原始顺序应用 `track.ts` 的判定。TS 外壳：编排。
- `solve/state.ts` — 逐区域里程计/跟踪状态及其两个构造器，供 `solve.ts` 帧循环与 `region-step.ts` 共享。TS 外壳：编排（状态容器）。
- `solve/track.ts` — 大部分已迁移到 Rust（见十二节）：`region-step.ts`/`keyframe-step.ts` 应用的每帧跟踪判定薄转发；`ownFeaturesOf`/`priorMatchesOf`/`isTextured`/`gate()` 仍是纯 TS 小胶水，见十二节说明。TS 外壳：编排 + 绑定转发。

### src/ui（TS 外壳：UI）

- `main.ts` — 启动：按依赖顺序建立每个功能模块、把 worker 事件路由给它们、少量无状态的监听器（帮助对话框、对话框关闭、查看器缩放）。UI。
- `state.ts` — 多个功能模块共读写的字段集合；其余状态私有于各自模块。UI。
- `dom.ts` — DOM 查找、toast、纯格式化小工具。UI。
- `rpc.ts` — 有类型 worker RPC 客户端：请求/响应、`WorkerEvent` 订阅、compatibility 模式的帧请求桥接。UI，兼 worker RPC。
- `run.ts` — 重建运行生命周期：启动（设置 + 能力预检）、忙态、`resetView`/`updateProject`、进度条。UI。
- `canvases.ts` — 画布选择器：项目画布列表获取、排序/标注、切换查看器画布；`mergeCanvas` 处理实时进度事件的增量更新。UI。
- `viewer.ts` — `TiledViewer`：瓦片查看器的绘制、缩放、缓存。UI。
- `diagnostics.ts` — 诊断面板：警告徽标计数、可筛选分页列表、"查看原始时刻/定位受影响区域"。UI。
- `export.ts` — "下载长图"/"导出完整项目"/"复制长图"：优先原生保存文件选择器，回退锚点下载/OPFS 临时副本。UI。
- `history.ts` — 本地项目历史对话框：分页列表、"打开"、"删除"（经 `src/storage/projects.ts` 的三键族删除）。UI。
- `regions.ts` — 手动区域编辑对话框：在首帧上绘制 fixed/ignore/moving 矩形，写入 `state.manualRegions`。UI。
- `source-file.ts` — 选择源录屏：文件输入/拖放、按文件头拦下不是 MP4/MOV/WebM/MKV 的文件并给出指引（`media/sniff.ts`）、探测 RPC（含原生播放器回退）、内容指纹（供 diagnostics.ts 校验重开文件与项目来源一致）。UI，兼浏览器 API（File）。
- `video.ts` — 原生 `<video>` seek + 帧捕获原语，供 source-file.ts/diagnostics.ts/compatibility 帧请求桥接共用。UI，兼浏览器 API。
- `flight.ts` — 崩溃记录器：把重建的最后已知状态写入 localStorage，页面被杀或崩溃后下次加载上报一次并清除。UI，兼 I/O（localStorage）。

### src/i18n（TS 外壳：界面语言）

- `index.ts` — 本 JS 环境（页面、每个 worker、Deno 各一份）唯一的 i18next 实例与有类型的 `t()`；目录内联打包，同步初始化；默认 zh，从不读取 `navigator`。TS 外壳：UI。
- `page.ts` — 仅页面：加载时选语言（已保存的选择 → 浏览器首选语言 → 英文，任何 zh-* 都选 zh）、按 `data-i18n*` 属性翻译静态页面、语言菜单保存选择并重新加载（打开中的项目在重新加载后重新打开）。检测本身不保存任何东西。TS 外壳：UI，兼 I/O（localStorage）。
- `names.ts` — 持久化的 zh 区域/画布名称词表到界面语言的显示映射，及手动区域的规范名称。TS 外壳：UI。
- `catalog.ts`、`zh/*.ts`、`en/*.ts` — 目录。按显示位置分为 `page`（静态页面）、`ui`（页面脚本）、`pipeline`（worker 写出的诊断、进度、导出文本）；每个 en 分区的类型由对应的 zh 分区导出，缺键或多键是编译错误，`tests/unit/i18n.test.ts` 再检查插值变量一致、英文无汉字、静态页面引用的键都存在。TS 外壳（数据）。

### src/media（TS 外壳：浏览器 API / I/O）

- `source.ts` — `FrameSource` 实现的组装点：demuxer 选择、`FrameConverter` 接入、缓冲区释放。TS 外壳：编排 + 浏览器 API。
- `reader.ts` — `Demuxer`/`Packet` 接口，以及 `BlobReader`：最多 8 个 256KiB 页面的随机访问读取，不调用整段 `arrayBuffer()`；现在只被 `isobmff-probe.ts` 使用（容器本身的读取交给了 mediabunny 自己的 `BlobSource`）。TS 外壳：I/O。
- `mediabunny-demux.ts` — `MediabunnyDemuxer`：MP4/MOV/fMP4/WebM 解封装，包在 npm 包 mediabunny 的 `Input`/`BlobSource`/`EncodedPacketSink` 之上，只用它的 packet 级 API（不用它的解码 sink，解码仍是本项目自己的 WebCodecs 路径）；把 mediabunny "警告后继续"的几种情形翻译成本项目原有的、冻结的错误文案。TS 外壳：I/O（容器解析）。
- `isobmff-probe.ts` — 一次轻量 box 扫描，只检测 mediabunny 自己不拒绝的几种情形（多重/变速剪辑列表、sample-description 索引 ≠ 1）与 mediabunny 没有对应诊断的版本 0 `ctts` 有符号偏移，以及文件在 `mdat`/`moof` 中途结束（`TRUNCATED_RECORDING` 警告；mediabunny 会不声不响地读到最后一个完整样本为止）；顶层 box 的容错与 mediabunny 一致（解析不了或超出文件末尾的顶层 box 结束扫描而不报错），不比它更严；不重复 mediabunny 的解封装本身。TS 外壳：I/O（容器解析）。
- `sniff.ts` — 按文件前 512 字节判断所选文件是什么：ISOBMFF（MP4/MOV）与 EBML（WebM/MKV）放行；文本、图片（含 HEIC/AVIF）、PDF、压缩包，以及 AVI/WMV/FLV/MPEG-TS/GIF 等本项目不读的视频格式，由 source-file.ts 直接拒绝并说明原因。认不出的字节只在文件名或类型表明是视频时放行，交给 demuxer 判断。TS 外壳：I/O。
- `convert.ts` — `VideoFrame` → RGBA 转换的可注入形态（直转/worker 转换）与显式释放缓冲池接入。TS 外壳：浏览器 API（WebCodecs）。
- `convert-worker.ts` — 帧转换 worker：转移进来的 `VideoFrame` 上跑 `copyTo({format:'RGBA'})`，转移 RGBA 缓冲回去；刻意保持零依赖（不引入 `src/core/wasm.ts`）。TS 外壳：浏览器 API（Worker）。
- `rgba-copy.ts` — `copyTo(RGBA)` 选项与结果布局校验，供直转/worker 转换器与 convert-worker.ts 共用。TS 外壳：浏览器 API。
- `pool.ts` — 显式释放的 RGBA 转换缓冲池：`release()` 才归还，永不按固定轮转回收。TS 外壳：I/O（内存管理）。
- `demo.ts` — `DemoSource`：内置 demo 复用与测试套件相同的 ground-truth 合成场景。TS 外壳：编排（测试/演示数据接入）。

### src/codec、src/export、src/storage、src/synthetic（TS 外壳，各自领域）

- `codec/crc.ts` — 一次性 `crc32()`，经 Rust `crc32fast` 的薄封装：`codec/png.ts::chunk()` 唯一的生产调用方总是先把类型+正文拼成连续内存，不需要增量（分批喂数据）形式；旧的 handle 表 + `FinalizationRegistry` 增量 CRC（`ls_crc32_new/update/digest/free`）已删。绑定转发层。
- `codec/png.ts` — 单 PNG chunk 编解码：chunk 组装、`decodePNG`/`encodeRGBA`，调用核心 (un)filter 与 CRC。TS 外壳：I/O（编码），部分绑定转发。
- `export/zip.ts` — `ByteSink` 接口与 `client-zip`（npm，ZIP64）驱动的写入。TS 外壳：I/O。
- `export/target.ts` — 同步文件写入目标的小接口与实现（`createId` 用于临时命名）。TS 外壳：I/O。
- `export/project.ts` — 完整项目 ZIP64 导出：画布/瓦片/诊断从 KV 读出并交给 `ZipWriter`。TS 外壳：编排 + I/O。
- `export/png.ts` — 从磁盘瓦片流式产出原生分辨率行，未观察像素透明。TS 外壳：I/O。
- `export/offline.ts` — 生成自包含 `file://` 离线查看器 HTML。TS 外壳：I/O（静态资源生成）。
- `storage/db.ts` — `KV`/`Row`/`Database`/`MemoryKV`/`Namespace` 等存储抽象与遍历/前缀删除工具。TS 外壳：I/O。
- `storage/tiles.ts` — `TileStore`：瓦片读写、coverage/quality 位图、金字塔构建入口（内核已转发到 Rust）。TS 外壳：I/O + 绑定转发。
- `storage/diagnostics.ts` — 诊断事件的存储形态、按代码取最高严重级别。TS 外壳：I/O。
- `storage/projects.ts` — 项目键布局（`project/`、`project-index/`、`run/<id>/`）的唯一入口，防止三键族删除漂移。TS 外壳：I/O。
- `synthetic/world.ts` — `World`：无损程序化页面，用于可精确核验的合成场景。TS 外壳：编排（测试基础设施）。
- `synthetic/scenarios.ts` — 24 个合成场景目录的构建（`buildScenario`）与期望值。TS 外壳：编排（测试基础设施）。
- `synthetic/source.ts` — `ScenarioSource`：合成场景的 `FrameSource` 封装，Deno 与浏览器行为一致。TS 外壳：编排（测试基础设施）。
- `synthetic/verify.ts` — 重建结果与合成 ground truth 的逐像素核验，含瞬态/污染像素的可恢复性分类。TS 外壳：编排（测试基础设施）。

### 顶层与其它（src/*.ts）

- `types.ts` — 跨模块共享的纯数据类型（`Gray`/`RGBA`/`Region`/`CanvasMeta` 等），无逻辑。TS 外壳（类型定义）。
- `protocol.ts` — 页面↔worker 类型化协议：冻结的命令名字符串 + 每个命令的载荷/回复类型。TS 外壳：worker RPC。
- `worker.ts` — worker 入口：接线 `Engine`、存储、项目生命周期、媒体源选择到 `protocol.ts` 的命令处理器。TS 外壳：worker RPC + 编排。
- `device-check.ts` — 独立页面（不随主应用加载）：报告本机/本浏览器的核心能力与 GPU 路径成本。TS 外壳：编排（诊断工具）。
- `testkit.ts` — 浏览器测试用：把 `Engine`/`Database`/`PoseGraph`/`RegionAtlas`/`TileStore` 等挂到 `window` 上给 Playwright 用，不随应用加载。TS 外壳（测试基础设施）。

### 测试布局

- `tests/unit/*.test.ts` — 逐模块行为单测（`codec`/`compositor`/`compute`/`consistency`/`engine-*`/`export`/`features`/`framing`/`id`/`keyframes`/`layers`/`math`/`media`/`motion`/`pose-graph`/`raster`/`storage`/`synthetic`/`server` 等）与四个分片的场景目录测试 `scenarios-{1..4}.test.ts`（单一目录拆分而成，见 `tests/support/scenario-check.ts`）。`shared-memory-guard.test.ts` 是一道静态+运行时检查：threads 构建下 `exports.memory.buffer` 是 `SharedArrayBuffer`，它的 `.slice()` 仍返回共享缓冲（不像 `core.readBytes()` 用的 `TypedArray.slice()` 总分配普通 `ArrayBuffer`）；防的是 `wasm/regions.ts` 曾经两处 `exports.memory.buffer.slice(...)` 那类写法再次出现，外加 `MemoryKV.put` 拒绝 `SharedArrayBuffer` 支持的值这条运行时兜底（`structuredClone`/IndexedDB 对共享内存有同样的盲区）。
- `tests/unit/parity/*.test.ts` — 每个已迁移 Rust 域与其冻结 TS oracle 的 byte-exact 对照（`chrome`/`compositor`/`framing`/`kernels`/`layers`/`motion`/`pose-graph`/`pyramid`/`regions`/`track`/`voting`），oracle 源在 `tests/support/reference/*.ts`。
- `tests/support/reference/*.ts` — 冻结的、迁移前 TS 实现快照，只作对照基准，不参与生产路径。
- `tests/support/{core,run,scenario-check,parity-fixtures,pixel-fixtures}.ts` — 测试基础设施：加载工作区 Wasm 构建、跑一次场景到 KV、场景目录自检、parity/像素测试用的固定输入。
- `tests/browser/*.test.ts` — Playwright 驱动的真实 Chrome/WebKit 集成测试（`ui`/`export-ui`/`flight`/`private`/`compatibility`/`device-check`/`compute`/`decode`/`planar`/`reconstruct`），覆盖解码、Worker、IndexedDB、OPFS、界面等核心之外的部分。`tests/browser/support.ts` 不是测试文件，是上述用例共用的测试基础设施（启动/连接被测页面等）。
- `tests/fixtures/*` — 确定性编码/解码测试固件（mp4/mov/webm 样本、`truth.json`、`world.png`），多数由 `scripts/make-fixtures.ts` 生成。

### scripts/ 工具

- `build.ts` / `build-core.sh` — 应用构建（bundle + dist 静态资源 + THIRD_PARTY_NOTICES）与 Rust 核心三构建编译；后者是修改任何 `.rs` 后唯一允许的构建入口。
- `fingerprint-scenarios.ts` / `compare-fingerprints.ts` — 24 个合成场景跑一遍并哈希每一条持久化记录；两份指纹逐行比较，任何差异退出码 1。
- `compare-tiles.ts` — `benchmark-pipeline.ts --verify-tiles` 产出的逐瓦片指纹按字段比较，定位差异瓦片。
- `benchmark-pipeline.ts` — 真实 Chrome（Playwright）下的端到端流水线基准，支持 `--baseline-root`/`--verify-tiles`。
- `benchmark-kernels.ts` — Deno V8 下的核心内核微基准（投票环 observe、一致性掩码、瓦片合成）。
- `benchmark-ts-vs-rust.ts` — 同输入同算法，冻结 TS oracle 对 Rust 核心的逐内核计时对比。
- `benchmark-png.ts` — PNG 编解码基准。
- `benchmark-consistency.ts` — 一致性掩码基准，对照 `tests/support/reference/consistency.ts`。
- `e2e-recordings.sh` — 真实录屏端到端证据：当前树（可选 `--baseline` 对照 `.baseline` worktree）逐瓦片/证据哈希。
- `inspect-recording.ts` — 离线用真实录屏跑扫描趟，打印学到的区域，供人工核查。
- `make-fixtures.ts` — 生成 `tests/fixtures/` 下的确定性编码固件。
- `notices.ts` / `notices-about.toml` — 构建期从 `cargo about` 与 npm/jsr 依赖图生成 `dist/THIRD_PARTY_NOTICES.txt`。
- `coverage.ts` — `deno task coverage`：带逐文件行覆盖率下限的测试运行；下限只能上调（`--update-floors` 重写整块，但要求先逐条审阅每处升降的理由再手动接受，不能盲跑）。

## 十二、Rust 核心边界与决策表

§三给的是原则（薄 TS 外壳 + Rust/Wasm 算法核心）；下面逐项给已迁移、刻意留在 TS 的部分各自的理由与实测数字。每一行都对应过至少一次迁移或评估提交，数字来自那次测量，不是估计。

| 领域                                                                                           | 归属                                                                                                          | 理由与实测数字                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 瓦片 PNG 编解码                                                                                | Rust（`png` crate / image-rs，`abi/png.rs` 的 `ls_png_encode`/`_decode`，fdeflate + crc32fast）               | `Compression::Fast` + 自适应 filter，由项目 owner 选定；编码约 4×、解码约 1.7×；c.mov 总耗时 31.4 s → 21.8 s；瓦片体积 +8.8–10%；像素完全一致（831 个 blob 交叉解码验证，真实录屏瓦片逐像素相同）。曾评估浏览器原生解码，被拒绝：预乘 alpha 会改变金字塔像素、Safari canvas 回读噪声、Safari 缺 `ImageDecoder`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 帧转换（解码→RGBA）                                                                            | TS 外壳（浏览器 API 路径，显式释放缓冲池，`src/media/pool.ts`/`convert.ts`/`convert-worker.ts`）              | c.mov 总耗时 −35%，渲染阶段 −43%（固定 30 MB 缓冲复用，避免逐帧分配触发 GC）。零拷贝进核心常驻内存**未做**：需要在 3456×2234 分辨率下再开一个 30 MB 环形槽（第 4 槽），约占 e.mov 的 7%，且 Safari 内存压力下风险更高——留作未决项。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Framing（呈现画布合成）                                                                        | Rust（`rust/core/src/framing.rs` + `abi/framing.rs`）                                                         | e.mov framing 阶段 5.76 s → 3.55 s（−38%）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 区域构建（`LayerLearner.finish` + `RegionAtlas`）                                              | Rust（`rust/core/src/regions/*`），atlas 常驻核心内存                                                         | finish + atlas 比 TS oracle 快 1.9–2×；三次冗余标签上传被移除。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 位置图松弛（pose-graph relaxation）                                                            | Rust（`rust/core/src/pose_graph.rs`）                                                                         | 性能中性（未出现在 profile 里），迁移理由是架构一致性，不是速度。`PoseGraph.correction()`（每帧约 6 次浮点运算）留在 TS：一次 FFI 调用的开销比这几次运算本身更贵。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 跟踪判定（里程计、重定位、漂移控制、各类 verdict）与关键帧候选评分                             | Rust（`rust/core/src/track.rs`，binding 拆成 `abi/track.rs` + `abi/track_{odometry,reacquire,keyframes}.rs`） | 曾测量并**未构建**有状态融合跟踪器：0.mov/e.mov 求解阶段耗时差异落在噪声范围内。`driftCorrection`/`reacquire`/`odometry` 与 `keyframes.ts` 关键帧候选评分的置信度收尾（含各自的 `exp()` 因子）都已迁入 Rust，用 `f64::exp`（各引擎一致的软件 libm），不再依赖 V8 的 `Math.exp`：与迁移前 TS 输出位精确一致不再是约束，见 `rust/core/src/track/odometry.rs`/`track/reacquire.rs` 的 `confidence`/`confidence_floor` 字段与 `track/keyframes.rs` 的 `select_candidate`（候选评分/排序/最强候选选择/对手歧义判定也一并迁入，随 `ls_keyframes_evaluate_candidates` 直接返回选中的候选，`keyframes.ts::evaluateCandidates` 现在只是封送与 canonical 画布索引化）。`.8`/`6`（对手分数须在最强候选 80% 以内、或落点相差 ≥6px 才算歧义）是实测阈值，不是算法核，迁移时原样带过去；近似打平、0.8 边界、NaN 分数、不同 canonical 画布的选择行为由 `track/keyframes.rs` 自带的 `#[cfg(test)]` 单元测试覆盖（`cargo test --lib`，也接进了 `deno task test`，见下方"托管"节前的测试任务说明；这是这个仓库既有的 Rust 单元测试惯例，见 `track/mod.rs`）。以下几处仍**刻意**留在 TS，各自理由：<br>· `KeyframeIndex.find()` 的 top-12 候选、每个至少 3 票（`keyframes.ts`）：视觉词投票计数的 posting-list 整理胶水，不是核算法，留在 TS。<br>· `applyTracked`（`region-step.ts`）的漂移门 `.12`（`scan.field.difference >= .12`）：只是决定要不要调用 `driftCorrection` 这个 Rust 融合调用，不是跟踪数学本身，仍在调用点旁边。<br>· `solve/track.ts` 的 `isTextured`/`priorMatchesOf`/`gate()`：外壳自身的分发胶水（`isTextured` 是裸 `.length >= 8`；`priorMatchesOf` 是对已在 Rust 的 `matchFeatures` 的匹配胶水；`gate()` 是六路分支，没有自己的原生/patch/特征运算）。`ownFeaturesOf` 用于过滤特征的 `regionContains` TS 副本已删（R6-B）：过滤逻辑现在是 `rust/core/src/region.rs::filter_features`（泛型 `Region<M: AsRef<[u8]>>`，供拥有/借用两种掩码复用），`ownFeaturesOf` 现在只是对 `core().filterFeatures` 的薄调用。<br>· `src/media/convert.ts` 的 `agreement()`：浏览器端解码转换的健全性检查（比较直转与 worker 转换两条路径是否一致），不是重建算法，见下方"帧转换"行。<br>· `pose-graph.ts` 的 `correction()`：见上面 pose-graph 这一行。 |
| 时间冲突合成（连通分量、`resolveTemporal` 决策、内存态时间索引、`overwritePatch`）与金字塔装配 | Rust（`rust/core/src/temporal.rs`、`pyramid.rs`）                                                             | flush 行序显式复现 JS `Map` 插入顺序。`overwritePatch` 现在把 `ResidentFrame.ptr` 一路传给 `wasm/temporal.ts` 的每瓦片内层调用（`Compositor.overwritePatch`，`src/core/compositor.ts:302`），不再对 3456×2234 这类分辨率的每块都整帧拷进 scratch（原是每瓦片一次整帧拷贝，约 30 MB）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ZIP64 导出                                                                                     | TS 外壳（npm `client-zip`，MIT 许可）                                                                         | 比手写 ZIP64 写入器更简单、不需要 IndexedDB 暂存；小条目更快（4.06 对 4.98 ms/MiB），大条目更慢（2.14 对 0.73 ms/MiB，其自带 JS CRC）——权衡后接受：导出耗时主要由 IndexedDB 读取与 PNG 编码主导，ZIP 本身不是瓶颈。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 容器反封装（demuxing）                                                                         | npm 包 mediabunny（`src/media/mediabunny-demux.ts`），只用它的 packet 级 API                                  | 在全部固件与 iOS 真实录屏上与手写 demuxer 打平：timestamp/size/key、frameCount、`MediaInfo.duration`（含剪辑列表调整）逐一核对一致；唯一的刻意差异是 packet 的 `duration` 字段——旧实现读的是解码顺序的 `stts` delta，mediabunny 给的是展示顺序里到下一帧的间隔，两者在有 B 帧重排的录屏上逐帧不同（例如 0.mov 第 1 个包：141667→16667 微秒），但超过 120ms 的帧数（`TEMPORAL_UNDERSAMPLING` 用到的口径）在全部六段真实录屏上不变；owner 已接受其 MPL-2.0 许可义务（`dist/THIRD_PARTY_NOTICES.txt` 附完整协议文本与 npm/GitHub（指向该版本 tag）两处精确源码地址）。手写 WebM demuxer 曾有的 VP9 Profile-1 codec 字符串缺陷（`vp09CodecString` 缺失字段时固定回退 `vp09.00.10.08`，不反映真实的 profile 1 流）随之修复；scroll.webm 的 Matroska track 并无 CodecPrivate，mediabunny 是从首帧的未压缩帧头读出真实 profile/位深/色度采样的。仍手写/仍不同的部分：mediabunny 对几种情形只警告不拒绝（多重/变速剪辑列表、sample-description 索引 ≠ 1、`encv` 加密样本），`isobmff-probe.ts` 补上这几处及版本 0 `ctts` 有符号偏移诊断，用的是被替换掉的 box 解析器的一个很小的子集（只读头部，不读样本数据）；`mdhd` timescale 为 0 与 `stsz` 声明计数不符这两种畸形文件，旧实现给出更具体的错误/一致性检查，mediabunny 不做等价校验（不再自行解析 sample table），这两种情形现在报的是更通用的“未找到可解码样本”或直接静默按实际计数处理，改动被接受，不打算复刻。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| WebGPU 分析降采样（WGSL）                                                                      | 维持现状（GPU 路径，字节精确校准闸门）                                                                        | `AnalysisComputer` 首帧 CPU/GPU 双跑校准，要求 `bitExact` 且 GPU 实测（含上传/kernel/回读）比 CPU 快，否则整段回退 CPU；不做进一步改动。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 托管                                                                                           | `_headers`（COOP/COEP/CORP）开启线程构建                                                                      | 开发服务器对**每个**响应（含 304）都重新附加这些头——一次遗漏 304 上 CORP 头的回归曾打断 WebKit 私密浏览下载流程，见提交历史 "dev server re-applies COOP/COEP/CORP to every response"。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**验证工具链**（让上述每一次移植都有把握、不是凭感觉）：

- 字节 + 像素两级场景指纹（`scripts/fingerprint-scenarios.ts` + `scripts/compare-fingerprints.ts`）：24 个合成场景全量跑一遍，哈希每一条持久化记录，逐行比较。
- 冻结 oracle 的三构建 parity（`tests/unit/parity/*.test.ts` 对照 `tests/support/reference/*.ts`，在 scalar/SIMD/threads 三种构建上跑）。
- 针对原始引擎的差分测试（对同一批扰动输入分别跑迁移前后两份引擎，逐字段比较）。
- 真实录屏 A/B（`scripts/e2e-recordings.sh`）：解码像素哈希 + 证据瓦片哈希。

上面第三项（差分测试用的对照哈希）本身不在这个代码仓库里，活在编排会话的 scratch 目录下，随每轮任务现造现用——如实说明，不假装它是仓库的一部分。

Rust 核心的完整迁移时间线（哪一轮做了什么、每一步的验证方式）记录在 [docs/history/2026-09-rust-migration-log.md](history/2026-09-rust-migration-log.md)；上表只给当前状态与理由，不重复过程。
