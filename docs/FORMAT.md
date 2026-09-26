# 稀疏画布结果包

格式：`long-screen/sparse-canvas`，version 2。`project` 内嵌的 `schema` 字段是内部存储层版本（scan-time 特征改为 `scan-features/<frame>` 独立行，不再内联在 ScanRecord 上），与本导出格式的 `version` 是两回事。

`manifest.json` 保存项目、设置、媒体尺寸 / 名称 / 字节数、各画布原生坐标边界。每个独立画布有自己的坐标原点；fragment 之间没有声明空间邻接关系。bounds 是外接矩形，不是“全部被观察”的保证。

瓦片 PNG 现在由 Rust 核心里的 `png` crate（`=0.18.1`，及其传递依赖 fdeflate/flate2/miniz_oxide/crc32fast）编码，取代了此前手写的 Sub filter + 浏览器 `CompressionStream` + 手写 JS CRC32 表。这只改变编码器实现，PNG 字节流本身仍是标准、可被任意 PNG 阅读器打开；换编码器之后新写出的瓦片字节可能与旧版本不同（比如 filter 选择的启发式），但解码出的像素完全相同——比较两次运行是否等价时用 `--pixels`（`deno task fingerprint`）或 `--verify-tiles`（`benchmark-pipeline.ts`）的解码像素哈希，不要直接比较 PNG 字节。

```text
index.html                              可直接离线打开的查看器
manifest.json                           全局描述
README.txt                              阅读说明
tiles/<canvas>/<level>/<tileX>_<tileY>.png    # 标准 PNG；由 Rust 核心里的 `png` crate（image-rs）编码（见下）
coverage/<canvas>/<tileX>_<tileY>.bin
provisional/<canvas>/<tileX>_<tileY>.bin
quality/<canvas>/<tileX>_<tileY>.json
observations.jsonl                      每个完成合成帧的决定
analysis.jsonl                          每帧运动分析记录（不含特征描述子，见下）
poses.jsonl                             校正前后关键帧位置
pose-edges.jsonl                        持久化邻接约束（双向）
temporal.jsonl                          冲突区域与选择时刻，含参与合并的块级掩码
attachments.jsonl                       被回访证据整体接回主画布的片段及其刚性位移
diagnostics.jsonl                       持久化诊断
regions.json                            自动/手动区域记录，含 base64 编码的归属掩码
graph-summary.json                     优化残差与回环数量
memory-stats.json                      瓦片缓存计数与预算说明
performance.json                       各阶段耗时、精确重复帧跳过数、瓦片编解码/淘汰计数、分析加速后端与实测校准
```

## 瓦片坐标

默认 tileSize 512，Level 0 为原分辨率。世界坐标：

```text
worldX = tileX * tileSize + inTileX
worldY = tileY * tileSize + inTileY
```

负坐标用向下取整，不用向零截断。Level L 的 tile 覆盖原始世界 `tileSize * 2^L`，L≥1 是明确降采样的预览。主结果不被预览替代。缺失 tile、coverage=0 的像素是 hole；透明不是白色背景。

覆盖位图按 row-major，index=`y*tileSize+x`，一个 byte 的低位先使用：`(coverage[index>>3] >> (index&7)) & 1`。所有像素均有覆盖表示，质量和来源则是较粗的块级描述。

## quality JSON

`blockSize=16`，数组 row-major。`quality` 范围 0…255，来自未校准的启发式评分，不是正确率。`conflicts` 表示曾出现明显像素不一致；解决后不清除历史冲突标记。`frozen` 表示 stable 策略已锁定的时间块。

`ownerFrame`：0 为尚无来源；其他值等于零基源帧索引 + 1。它是整个块的代表来源，**不保证块中每个像素都来自这帧**（例如边界部分被之后观察补齐）。需要原视频与 observations、temporal 账本联合审计，不能把它解释成逐像素来源证书。

`observedPixels` 是覆盖数量。`conflictPixels` 是处理期间多次观察产生的累计差异计数，**不是最终图中互不重复的坏像素个数**。`uncertainPixels` 记录不确定观察首次补入的像素，后续质量改变并不使它成为严格最终错误统计。`provisionalPixels` 是当前仍未被修复的瞬态像素净数（世界一致性掩码找不到支持它的相邻帧、且至少有一个相邻帧与它矛盾——典型是屏幕坐标覆盖物：悬浮按钮、滚动条、鼠标指针、toast）；它会随后续观察涨落，不是单调递增的累计值，也不保证降到零（见 docs/ARCHITECTURE.md §七，以及 issue #2 记录的已知局限）。

## provisional 位图

`provisional/<canvas>/<tileX>_<tileY>.bin` 只在 level 0 存在，与同目录下的 `coverage/*.bin` 完全同布局（row-major，低位先使用）。置位的像素是已覆盖、但世界一致性掩码判定为不一致（在录制时的相邻帧里找不到支持证据）的像素——内容仍然被保留（缺口比猜测更糟），只是标记为瞬态，等待后续一次一致的观察把它覆盖并清除标记。没有置位不代表像素一定正确，只代表它有相邻帧证据支持，或者完全没有可比较的相邻帧（此时按一致处理，例如整段录制仅出现一次的内容）。

## consistency/&lt;frame&gt; ——内部暂存，不导出

`consistency/<frame>` 是 `solve()`（`src/pipeline/solve/solve.ts`，投票环的求值在 `rust/core/src/voting.rs`）位移展开一致性投票（docs/ARCHITECTURE.md §七）的中间结果：每个存在的行是一个 `{ [regionId]: ConsistencyVote }` 记录，`ConsistencyVote` = box（`x0, y0, w, h`）+两张位图`bits`与`clean`，以及可选的独立屏幕证据位图`screen`。`screen`与另两张图同布局，缺省表示无此类证据，不代表无覆盖物。两者都是分析分辨率（不是原生分辨率）下、以 `(x0,y0)` 为原点、`w×h` 的 row-major、低位先使用位图：`bits` 置位表示该分析格结算时判定为不一致，`clean` 置位表示判定为干净（比例阈值的镜像，且要求比较次数 ≥3），两者都不置位表示比较次数不足以下结论——这是三态，不是一份位图（详见 ARCHITECTURE §七）。只有该帧的某个移动区域至少有一格拿到结论（`bits`、`clean`或`screen`任一置位）时才会写这一行，多数帧完全不写。渲染阶段读取它（连同相邻两帧的同一份记录）、按分析因子放大到原生分辨率，驱动 `provisional` 位图（见上）——`consistency/<frame>` 本身只是过程数据，不代表最终瞬态状态，也不按世界坐标或画布坐标组织，只按屏幕/分析坐标。这些行是内部暂存：**保留，不在 `exportProject` 的 ZIP 里导出**（不同于 `scan-features/`、`keyframe/`、`word/`——那些在 `solve()` 结束时就被删除；`consistency/` 会在整个运行结束后继续留在本地存储里，供后续检查/调试用，只是不打包进离线结果）。

## 帧记录

`observations.jsonl` 每行包括零基 frame、秒 time，以及每个层的 canvasId、最终 placement、addedPixels、conflictPixels、uncertainPixels。准确解码模式消费每个可解码的视频 observation；seek 模式是采样观察，并不是原视频帧索引。时间戳保留容器意义，fMP4 第一帧可能非零。

`analysis.jsonl` 有降采样运动场、假设、置信、zoom 检测等；它不是原始全尺寸画面，也不含每个特征点的 256-bit BRIEF 描述子（那些只在处理期间存在于 `scan-features/<frame>`，供回访检索用，解完即删，不进导出）。原文件既未包含，也未做强哈希绑定。

`regions.json` 是自动分层与手动区域的最终记录：每条 `Region` 包含 kind、rect、可选 crop/solid，以及归属掩码——`mask` 以 base64 编码（不是 jsonl 惯用的数字数组），配 `maskWidth`/`maskHeight`（掩码本身的像素尺寸）与 `factor`（原生→分析坐标的整数缩放，查表用 `floor(x/factor)`，不是四舍五入的比例）。

## 时间与诊断

`temporal.jsonl` 的 rect 使用所属画布坐标，记录 chosenFrame / chosenTime / complete / revisions，以及一份 `blocks`：本次时间补丁实际覆盖的绝对 `[bx,by]` 16px 块坐标列表，不是 rect 对应的密集矩形——一个不规则形状的更新不会把整个外接矩形都标记为已合并。complete 指算法选择的区域在一次观察中完整可见，不代表语义视频边界正确或全页面同一时刻。

诊断字段包括 code、severity、message，以及可选 time、frame、canvasId、region、confidence、detail、action。`count` 是该事件自带的计数（例如解码器已经合并过的通知），`occurrences` 是这个诊断代码在本次运行中的累计触发次数——两者分开是为了不让"这一条事件自带的计数"被"运行总数"覆盖掉；单条实时事件用 `occurrences ?? count` 更新该代码的计数。界面警告徽章本身则以 `project.diagnostics`（每个代码的持久化总数）为准，配合 `project.severities`（每个代码见过的最高 severity，由 `Diagnostics.severities` 持久化）：只有已知 severity 的代码才计入徽章，没有已知 severity 的代码不计入，也从不默认当作 warning。UI 可分页查看全部持久化记录，不只是最后几条。若存储已经失败，最后错误可能只存在于 UI / 项目 error，不能宣称其日志一定提交成功。

## 单图与分页

单图 PNG 包含当前画布 bounds 的像素，包括透明孔洞；图内(0,0)对应 bounds.(x,y)。分页 ZIP 每张 `sheet_x_y.json` 给出原生世界坐标与实际宽高。相邻页最多重叠 32px，有意重叠不能当重复错误；重新组合时按世界坐标放置，不要直接把图片首尾追加。

## 诊断码

| 代码                                                                          | 含义                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_ASSUMPTIONS`                                                           | 声明本次重建采用的模型与其局限；`detail` 带 `noise`（本片源声明的每通道解码噪声，单位 RGB 级）、`lossless`、`source`、`codec`，记录世界一致性比较实际用的容差——无损片源为 0（逐像素精确），压缩视频为 10（H.264/VP9 振铃与色度重建余量），见 `MediaInfo.noise` |
| `MEDIA_NOTICE`                                                                | 容器层面的提醒（HDR 等自由文本 demuxer 警告）。`NONSTANDARD_SIGNED_CTTS_V0`（见下）、`TRUNCATED_RECORDING`（文件在 mdat/moof 中途结束）是消息前缀而非诊断码，总以 `MEDIA_NOTICE`、`warning` 出现                                                               |
| `ANALYSIS_PYRAMID`                                                            | 运动分析在缩图尺度进行，输出未跟随降采样                                                                                                                                                                                                                       |
| `APPROXIMATE_DECODER`                                                         | 已明确启用原生 seek 兼容模式；不保证采到视频每一帧，短暂内容可能缺失                                                                                                                                                                                           |
| `COMPUTE_BACKEND`                                                             | 首帧分析后台校准结果（CPU 或 WebGPU box-luma + CPU 配准）；`detail` 带 `calibration`（cpuMS/gpuMS/bitExact）时说明已经拿到过一个 GPU 设备                                                                                                                      |
| `NEGATIVE_TIMESTAMP_SKIPPED`                                                  | 解码器输出了编辑列表起点之前的帧，按容器语义不展示（已计数）                                                                                                                                                                                                   |
| `NONMONOTONIC_TIMESTAMP`                                                      | 容器时间戳倒退，已按解码器展示顺序继续                                                                                                                                                                                                                         |
| `CONTAINER_SIZE_MISMATCH`                                                     | 容器声明尺寸与码流不符，以码流为准                                                                                                                                                                                                                             |
| `DECODE_PREFIX_ONLY`                                                          | 解码中断，只对已解码前缀继续处理。`DECODER_STALLED`（见下）是这类错误消息文本里的前缀，不是它自己的诊断码                                                                                                                                                      |
| `PASS_FRAME_COUNT_MISMATCH`                                                   | 某一遍（scan/solve/render）实际完成的帧数少于该遍预期帧数；结果被标记为 partial，已提交前缀保留                                                                                                                                                                |
| `AUTOMATIC_LAYER_MASK` / `MULTIPLE_SCROLL_LAYERS`                             | 自动分层结果                                                                                                                                                                                                                                                   |
| `MANUAL_UNASSIGNED` / `EXPLICITLY_EXCLUDED_REGION` / `MANUAL_REGION_PRIORITY` | 手动区域相关                                                                                                                                                                                                                                                   |
| `LOW_TEXTURE_UNOBSERVABLE` / `UNOBSERVABLE_FRAME`                             | 该帧（该区域）没有可辨认纹理，不画到任何位置                                                                                                                                                                                                                   |
| `UNRESOLVED_MOTION` / `AMBIGUOUS_PATTERN`                                     | 缺少可靠对齐依据 / 存在多个合理匹配                                                                                                                                                                                                                            |
| `TEMPORAL_UNDERSAMPLING`                                                      | 该帧持续时间偏长；高速移动期间可能存在从未被采集到的区域                                                                                                                                                                                                       |
| `THIN_OVERLAP_STEP`                                                           | 移动过快，位移只由很小的重叠决定                                                                                                                                                                                                                               |
| `TRAJECTORY_CORRECTED`                                                        | 回访证据更强，已改正当前及之后的轨迹（此前像素保持原样）                                                                                                                                                                                                       |
| `PARTIAL_CONTENT_CHANGE`                                                      | 部分区块与整体位移不一致（动画 / 懒加载 / 重排）                                                                                                                                                                                                               |
| `LOW_CONFIDENCE_PLACEMENT`                                                    | 低置信位置推断，对应像素在质量遮罩中标记                                                                                                                                                                                                                       |
| `STICKY_OCCLUSION`                                                            | 顶端纹理支持屏幕固定而非页面位移；本次观察的固定遮挡不写入移动画布，原始参考界面保留在外框呈现中                                                                                                                                                               |
| `RELOCALIZED` / `LOOP_CLOSURE`                                                | 通过历史锚点重新定位 / 加入全局约束                                                                                                                                                                                                                            |
| `INCONSISTENT_LOOP_REJECTED` / `AMBIGUOUS_LOOP`                               | 历史匹配与轨迹冲突或有多解，未强加                                                                                                                                                                                                                             |
| `FRAGMENT_ATTACHED`                                                           | 独立片段被回访证据整体接回已有画布                                                                                                                                                                                                                             |
| `UNPLACED_FRAGMENT` / `SCALE_CHANGE_FRAGMENT`                                 | 无法确认相对位置 / 检测到比例变化，保留独立片段                                                                                                                                                                                                                |
| `TEMPORAL_OR_ALIGNMENT_CONFLICT` / `INCOMPLETE_TEMPORAL_PATCH`                | 重叠区域存在明显差异 / 变化区域从未完整可见                                                                                                                                                                                                                    |
| `MISSING_SCAN_RECORD` / `MISSING_PLAN`                                        | 求解 / 渲染阶段缺少对应的 `scan/`/`plan/` 持久化记录；已停止在已提交的前缀，不当作零位移或空观察                                                                                                                                                               |
| `MEMORY_BUDGET_RAISED`                                                        | 瓦片缓存已从预算允许的块数提高，以容纳一帧触及的全部瓦片；`detail` 带具体块数与估算内存                                                                                                                                                                        |
| `FRAME_MEMORY_PRESSURE`                                                       | 单帧原始像素及参考帧占用已接近所选缓存预算；不会静默降低输出分辨率                                                                                                                                                                                             |
| `GRAPH_RESIDUAL`                                                              | 位置图残差未收敛到亚像素                                                                                                                                                                                                                                       |
| `RELOCALIZATION_BUDGET`                                                       | 重复纹理导致检索预算被截断                                                                                                                                                                                                                                     |
| `NONFINITE_POSE` / `PROCESSING_ERROR` / `PERSISTENCE_ERROR` / `EXPORT_ERROR`  | 错误路径                                                                                                                                                                                                                                                       |
| `NON_SQUARE_PIXELS`                                                           | 容器声明的显示尺寸与存储尺寸不同（非方形像素）；保留原始存储像素，不缩放                                                                                                                                                                                       |
| `PRESENTATION_FRAME`                                                          | 带外框呈现与原始二维内容分别保留；外框来自参考帧，延长部分只是装饰背景，不算已观察内容                                                                                                                                                                         |
| `PRESENTATION_TOO_SPARSE`                                                     | 带外框呈现画布所需瓦片数超过上限，已跳过；核心重建不受影响                                                                                                                                                                                                     |
| `PRESENTATION_REFERENCE_FAILED`                                               | 构建带外框呈现所需的参考帧失败；带外框视图被跳过，核心重建不受影响                                                                                                                                                                                             |
| `PRESENTATION_STAGE_FAILED`                                                   | 带外框呈现阶段整体失败；核心重建结果和状态不受影响                                                                                                                                                                                                             |
| `PYRAMID_FAILED`                                                              | 预览金字塔构建失败；原尺寸 Level 0 瓦片不受影响，仍可查看和导出                                                                                                                                                                                                |
| `ANALYSIS_PREFIX_ONLY`                                                        | 定位或渲染阶段中断；仅对已处理的前缀帧继续                                                                                                                                                                                                                     |
| `PERSISTENCE_PREFIX_ONLY`                                                     | 存储写入失败并已停止；仅已成功写入的前缀帧结果可用                                                                                                                                                                                                             |

以下诊断码只由界面产生（`src/ui/**`），不写入持久化的 `diagnostics.jsonl`，只出现在运行时的诊断列表里：

| 代码                       | 含义                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PREVIOUS_RUN_INTERRUPTED` | 打开页面时发现上一次重建的崩溃记录（`src/ui/flight.ts` 每秒写入 localStorage 的阶段/帧/内存/后台时长），页面被浏览器回收或崩溃、没有收到正常结束信号 |
| `INTERRUPTED_SESSION`      | 从本地存储恢复项目时发现上一次处理没有完成；仅已提交的数据可恢复，不支持断点续算                                                                     |
| `PROBE_FAILED`             | 逐帧解码探测（WebCodecs 读首帧）失败，将尝试浏览器原生播放器读取元数据                                                                               |
| `START_ERROR`              | 开始重建时抛出异常，重建未能开始                                                                                                                     |
| `WORKER_ERROR`             | Worker 报告了一个未被更具体诊断码覆盖的错误                                                                                                          |

区块内部`score`现由RGB双轴梯度评分，不跨运行比较。每次重建使用新的run命名空间；恢复旧打印只预览或导出，不续写旧分数。导出包仍不包含内部score数组，也不改变version 2。

## 原生来源档案（可选扩展）

有争议区域的完整项目增加`sources/`，旧项目没有此目录仍可打开。公共表示是`alternatives/<canvas>/<shard>/<page>.png`原生16×16 patch图集及同名JSON，记录patch位置、frame/time、pose、同内容span及可见性RLE。所有候选都保留，不限于最后选中的来源；`.bin`是小端长度前缀LZ4块内的Postcard v1，PNG/JSON核对不需要Wasm或这个内部解码器。来源档案和透明度样本可能比最终PNG大得多。

`sources/summary.json`记录是否完整、当前阶段、停止/失败、已提交块数、候选/档案数量、阶段耗时和缓存峰值。`source-component`记录跨块共同epoch及完整性；`source-object-state`记录物体角色时段；`source-opacity`保留真实背景/观察样本及反例；`source-provenance`逐像素frame与reason优先于旧块owner和初次渲染temporal数据。frame从0开始；输出像素来自显式frame，span表示等价内容，不表示每个alias具有相同RGBA。

可见性编号：0未知、1页面可见、2遮挡、3范围外、4最终placement明确排除的遮挡。状态4不能被物体运动分类回填为可见。候选归属的附加状态为5（有页面运动支持但归属待定）、6（这种候选被遮挡）、7（被placement排除）、8（没有足够归属证据，不参与输出）。来源reason编号：0未观察、1可见证据、2未获独立佐证（含仅一次观察）、3歧义、4没有确认干净来源、5动态状态不完整、6候选的正文归属不确定。它们不是校准的正确概率；旧provisional位图仍保留原世界一致性语义。

内部KV以`source-state/<canvas>/<sx>_<sy>`保存四个热代表及页数；`source-page/.../<page>`保存其余候选；`source-objects/<frame>`为二进制物体观察块；`source-analysis`、`source-options`（压缩Postcard v1）与`source-blocks`为可重算中间数据，shard成功提交后释放；`source-provenance/<canvas>/<sx>_<sy>/<tx>_<ty>`与对应物理瓦片及CanvasMeta同事务提交。中断后的档案仍可导出，但`completed:false`不能解释为已完成消除遮挡。

新增诊断：`SOURCE_UNRESOLVED`说明歧义及未确认干净来源数；`SOURCE_DYNAMIC_PARTIAL`说明没有共同完整epoch的分量；`SOURCE_TRACKING_LIMIT`说明达到物体工作集上限的帧数。

自动识别的内部固定小区块同时保存其可能的正文坐标候选；外框、贯穿边栏和手动区域不会这样处理。主追踪和辅助追踪独立，辅助物体的region编号为原编号加256，只能标注辅助候选。归属不确定的候选不能新增正文覆盖；一般父层假设不能覆盖已有正文来源，有独立原生表面支持的假设只能打破其他Unknown来源的平局，不能压过Visible来源；不采用的RGBA仍保存在档案中。可见性状态8与范围外不同：前者保留实际观察字节，但不声称它属于正文。

### 原生背景归属证据

来源候选的 visibility 追加状态 9（正文背景归属有支持）、10（替代 parent 假设中的相同支持）及11（支援背景内的小型原生细节）；旧状态 0–8 的数值不变。支持来自当前原生同色连通面与物件边界外、确实随正文移动的纹理。它只解除错误的物件遮挡判断，并在 Unknown 候选平局时优先保留有支持的来源；不算 Visible，不增加动态 epoch 的干净像素数。每个输出仍复制真实候选的 RGBA，canonical placement 排除仍优先。状态11保留独立物件遮挡的否决权。辅助追踪可通过下一帧同世界坐标的原始匹配，为前一帧刚进入画面的表面补足归属证据；小型细节允许单侧裁切，但不跨越背景颜色边界。PNG/JSON 导出附有完整状态说明。
