# Rust / WebAssembly 架构与性能评估（历史记录，2026-09-22）

> **历史文档。** 这是 2026-09-22 写的一份评估：当时生产代码里还没有任何 Rust/Wasm，本文档论证了迁移的必要性、给出隔离原型的
> 实测数字，并规划了迁移顺序。迁移已经完成（见 [ARCHITECTURE.md](../ARCHITECTURE.md) §三），当前的核心划分、构建与验证方式
> 以那份文档为准，不是本文档规划的"目标"。文中引用的隔离原型 `experiments/wasm-assessment` 已被删除（迁移完成、评估用途
> 已过时）；内容见 git 历史 `12b2fcd`（`git show 12b2fcd:experiments/wasm-assessment/README.md` 等）。内容除本段说明与下方
> 链接修正外未改动。索引见 [docs/history/README.md](README.md)。

## 结论与范围

用户明确要求：**前端是薄层，核心算法全部由 Rust 编译成 WebAssembly，在浏览器本地运行。** 这是目标架构约束，不应降格为一个可选加速点，也不意味着引入服务端。

评估开始时的生产代码没有 Rust crate、Rust 源文件或 Wasm 构建产物。 `README.md`、`docs/ARCHITECTURE.md` 明确描述解码后的实现为 TypeScript，后者还把 SIMD / Wasm 列为未实现。 `scripts/build.ts` 只打包 TypeScript。把算法放进 Web Worker 不等于用 Rust/Wasm 实现。现有 Git 历史从一个 base commit 开始，不能据此还原此前为何偏离用户要求。

本轮只做评估和隔离的性能原型，不把原型接入应用，不声称已完成核心迁移。修复 review 中的坐标、证据和失败边界仍有价值；这些不变式必须保留在 Rust 版本中。

## 为什么慢，语言能解决多少

### 已有真实输入证据

此前对用户视频原生尺寸前缀的 Chromium profile 发现：

- 输入为 3456×2234；取前 60 个编码包，旧版实际交付 59 帧。
- render 的记录耗时为 147.7 秒，整条重建管线为 203.7 秒。
- CPU 采样 self time：`decodePNG` 22.2 秒、`consistencyMask` 21.8 秒、`Compositor.add` 约 10.0 秒。
- 重建期间发生 2,761 次 tile decode、2,931 次 eviction；瓦片快取上限为 38。
- PNG decode 包装器累计墙钟为 59.5 秒，但它包含异步 inflate/调度等开销，**不等于 59.5 秒纯 TS 运算**。

这是旧版本、单次且受另一量测进程竞争的探索性记录。不能据此给当前版本、iPhone 或完整视频许诺加速倍数。随后已做 TS 循环优化和 resident-first 瓦片遍历；对旧版的收益不能再次计入 Rust 相对当前版本的收益。完整视频的后续长跑在本次评估时中止，最后保存进度为 render 606 帧；它不是完整运行结果。

### 可加速与不可自动消失的工作

| 工作                                          | Rust/Wasm 的机会                                | 不能混淆的限制                                                                           |
| --------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 灰度、降采样、BRIEF/Hamming、匹配、原像素精修 | 扁平内存、整数操作、编译器优化、适用处使用 SIMD | TypedArray JS 已可被 JIT 优化；不是每个循环都快很多                                      |
| consistency、coverage、合成、金字塔           | 复用工作区、减少短命对象、批量处理像素          | 分支多的算法未必自动向量化；算法复杂度不变                                               |
| 位姿图与 temporal 状态                        | 紧凑表示、批量求解、明确所有权                  | 按节点逐次访问 IndexedDB 的延迟不会因语言消失                                            |
| PNG filter/unfilter、CRC                      | 可移到 Wasm，按实际输出检查吞吐                 | 当前 deflate/inflate 使用浏览器原生 CompressionStream/DecompressionStream，并非全部纯 TS |
| 视频解码                                      | 在 Wasm 内存附近安排帧缓冲，减少额外复制        | WebCodecs 已调用浏览器解码器；改写核心不会使硬件解码器自动快几倍                         |
| 瓦片和临时记录                                | Rust 管理缓存、批次和二进制格式                 | 缓存颠簸、数百万 IDB row、反复 PNG 编码要改设计，不是翻译语法                            |

“Rust 性能收益”和“缓存/数据布局/算法改进收益”必须分开测量，避免把不同改动的效果都归功于语言。也不能把整段重写为软件视频解码当成加速策略；那可能失去 WebCodecs 的硬件路径。

### 隔离的 Rust/Wasm 对照实测

本轮新增 `experiments/wasm-assessment`（已删除，见文首说明；git 历史 `12b2fcd`）：Rust 1.94.0、release/LTO、 **scalar Wasm，不用 SIMD 或线程**，与当前生产 TS 的 `consistencyMask`、`downscaleGray` 比较。输入为 3456×2234 的确定性合成 RGBA，不是用户视频帧。浏览器是 Chromium 152 和 Playwright WebKit 26。每条路径暖机三轮、交错顺序量九轮取中位数；两个浏览器串行运行。

两者均通过 166 个 consistency 与 5 个 downscale 的 byte-exact 对照，包括半整数邻域、负位姿、投票、遮挡、缺失/不同画布邻帧和非整除尺寸。这个对照证明限定案例上的迁移等价，不证明算法本身没有错误。

2026-09-22 10:11 UTC 的最终复测（毫秒，中位数）：

| 浏览器 / kernel                        | 当前 TS | Wasm 常驻 | Wasm 一帧输入 + 输出复制 | 含该复制的加速比 | Wasm 三帧输入 + 输出复制 |
| -------------------------------------- | ------: | --------: | -----------------------: | ---------------: | -----------------------: |
| Chromium / consistency，有投票与遮挡   |   369.7 |     157.2 |                    166.6 |        **2.22×** |                    171.5 |
| Chromium / consistency，无投票、有遮挡 |   296.8 |     102.1 |                    111.8 |        **2.65×** |                    116.0 |
| Chromium / downscaleGray               |    31.7 |      11.0 |                     13.2 |        **2.40×** |                   不适用 |
| WebKit / consistency，有投票与遮挡     |   373.0 |     136.0 |                    144.0 |        **2.59×** |                    148.0 |
| WebKit / consistency，无投票、有遮挡   |   300.0 |      87.0 |                     95.0 |        **3.16×** |                     99.0 |
| WebKit / downscaleGray                 |    19.0 |      10.0 |                     13.0 |        **1.46×** |                   不适用 |

一帧 copy 路径包括一张新 RGBA 复制到 Wasm，以及输出 mask/gray 复制回 JS；已有邻帧、atlas、投票和遮挡元数据常驻。它模拟帧环形缓冲的复制量，尚未集成真实解码器。Wasm 重用输出空间，而当前 TS 每次分配 mask，因此收益也包含数据布局/分配策略的改善。另测三帧全复制路径，避免只展示输入完全常驻的最好情况。完整样本与 Wasm SHA-256 由脚本写入 `test-results/wasm-assessment/`。

**这些是组件数字，不能直接相乘或外推成整条管线倍数。** 尚未测 Rust compositor、匹配、位姿图、PNG 或完整视频。 Wasm 线性内存本身约 104 MiB，另外还有 JS 测试帧和浏览器内存；它不是“总共只用 104 MiB”的结论。两种浏览器的实际运行均为 `isSecureContext=false`、`crossOriginIsolated=false`，无需安全限制绕过参数。

### 端到端预算：条件模型，不是实测承诺

设原耗时中可迁移计算占比为 `p`，迁移后的该部分加速比为 `k`，边界复制和调用新增耗时占原总时长的 `c`：

```text
整体加速比 = 1 / ((1 - p) + p / k + c)
```

忽略额外复制，仅作为预算情景：

| 可迁移部分占原总耗时 | 该部分快 2× | 快 4× | 快 8× | 该部分耗时趋近于零的上限 |
| -------------------- | ----------: | ----: | ----: | -----------------------: |
| 50%                  |       1.33× | 1.60× | 1.78× |                    2.00× |
| 70%                  |       1.54× | 2.11× | 2.58× |                    3.33× |
| 85%                  |       1.74× | 2.76× | 3.90× |                    6.67× |

因此，**约 1.5–3× 可作为待验证的端到端规划区间，而非现有证据已证明的结果**：它要求可迁移部分占比较高、多个主要热路径都得到明显加速，并且复制/I/O 没有抵消收益。只机械翻译 TS、保留原有储存与拷贝设计时，结果可能低于该区间，甚至没有净收益。不能承诺整体 5×、10×，也不能把任一单核微基准倍数当成整体倍数。例如套用本轮某个 kernel 的 2.22×，即使假设全部可迁移计算都同样加速、占原时长 70%，整体也只有约 **1.63×**；规划区间的高端还需要其他热路径和数据流优化获得额外收益，并由完整运行重新验证。

## 目标边界：Rust 核心，薄浏览器适配层

```text
UI / File / WebCodecs / IndexedDB / OPFS / 下载（浏览器适配）
                ↕ 有界批量命令、字节缓冲和状态事件
Worker 内 Rust/Wasm Engine
  ├─ 光栅、特征、匹配、运动、分层、关键帧、位姿图
  ├─ consistency、时间冲突、像素归属、瓦片和缓存策略
  ├─ framing、pyramid、覆盖/品质证据与统计
  └─ 二进制解析/序列化、图像与导出算法、续算状态
```

JS 保留的是浏览器 API 适配，不是第二套算法实现。长期生产路径不应依靠 TS Engine 才能完成运算。浏览器原生解码/压缩能力可以继续经薄适配层调用；不能以“核心要 Rust”为理由重新实现一个更慢的软件解码器。

关键约束：

- 一次调用处理一帧、一个批次或一组瓦片，不逐像素、逐 feature 跨 JS/Wasm 边界。
- 长寿命状态、工作区与缓存由 Rust 统一管理，避免 JS 和 Wasm 各持一份原生帧/瓦片。
- 明确区分数据已在 Wasm 内存的 kernel 耗时、输入复制、输出复制和全管线耗时。
- Wasm 不自动降低峰值内存；三张 RGBA、atlas、mask、解码 surface 和缓存仍须计入预算。
- 连续 Wasm 内存可能增长后不缩小，必须设计缓冲池、上限和实例生命周期。
- 使用一致的整数 raster pose；像素、coverage、provisional、quality、owner、conflict 与诊断都要回归。
- 浮点评分、相同得分的排序、负坐标取整和 typed-array 转换语义需逐项核对，不能只比较最终图片“看起来差不多”。

## 部署、HTTP 和 Safari

**普通单线程 WebAssembly 不需要 HTTPS 或跨来源隔离。** 可以继续用本机或局域网 HTTP 开发。项目依赖的 WebCodecs、OPFS 等浏览器 API 有自己的能力限制；它们和 Wasm 是不同问题。

共享内存多线程需要 secure context 与 cross-origin isolation；HTTPS 本身并不充分。 GitHub Pages 部署不能未经验证就假设 `crossOriginIsolated === true`。因此基础路径应是 **Worker 内单线程 Rust/Wasm**，SIMD 另做能力探测/兼容性验证；共享内存线程池作为后续可选优化，不能成为普通 GitHub Pages 或 LAN HTTP 运行的前提。独立 Worker + 可转移缓冲也能做不共享内存的并发，但广播大帧的复制成本仍要测量。

WebKit 官方从 Safari 16.4 起提供 Wasm SIMD；仍需按项目最低 Safari 版本验证实际构建，不能仅凭版本号推定所有设备情况。 Playwright WebKit 自动化不是 iPhone 真机，也不能回答 iOS 内存压力、硬件解码和热降频表现。

参考：

- [WebAssembly JavaScript API](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface)
- [SharedArrayBuffer 的安全与隔离要求](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- [Safari 16.4 的 WebAssembly 更新](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)
- [Rust wasm32-unknown-unknown 目标限制](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)

## 迁移顺序与验收

1. **测量原型**：同浏览器、同输入、同阈值验证 TS/Wasm 字节等价，测 kernel 与真实边界复制。先确认路线，不直接替换生产实现。
2. **Rust Engine 边界**：定义帧/瓦片/持久化批次 ABI、内存所有权、错误和停止协议；在静态构建中加入可复现的 Wasm 产物。
3. **计算核心**：迁移 raster/features/motion/layers/pose graph/consistency，旧 TS 暂留为测试对照，不作为最终生产后端。
4. **合成与状态**：迁移 compositor、temporal、framing、pyramid、缓存和证据统计，设计二进制 scratch 与原子提交边界，避免把当前规模问题原样翻译。
5. **收尾与平台 gate**：算法性的媒体/输出处理按模块迁移；移除生产 TS 算法路径，保留薄浏览器适配层。实际 iPhone Safari 验证是完成条件之一。

每个模块原子提交并 push。性能与正确性分别验收：不降分辨率、不放宽阈值、不跳过原本需要保留的观察，不上调错误棘轮。用已有 TS 对照可检查迁移等价性，但它不是独立真值；原 review 指出的 layer oracle 自我参照问题仍须用场景真值和独立不变式补足。

端到端 gate 应包括：同一当前 TS 基线与 Rust 候选交错多轮、无竞争运行，完整 `e.mov`、合成场景、真实编码 fixture、非整除尺寸、不同内存预算、WebCodecs 与 native seek 分开计时，重建与 ZIP/PNG 导出分别计时。保存阶段耗时、CPU profile、tile encode/decode/eviction 次数、持久化量、峰值内存的实际可测范围，以及完整像素/证据对照。未取得完整视频和真实 iPhone 的结果前，不宣布端到端提速倍数或移动端已达标。
