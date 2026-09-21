# 稀疏画布结果包

格式：`long-screen/sparse-canvas`，version 2。`project` 内嵌的 `schema` 字段是内部存储层版本（scan-time 特征改为 `scan-features/<frame>` 独立行，不再内联在 ScanRecord 上），与本导出格式的 `version` 是两回事。

`manifest.json` 保存项目、设置、媒体尺寸 / 名称 / 字节数、各画布原生坐标边界。每个独立画布有自己的坐标原点；fragment 之间没有声明空间邻接关系。bounds 是外接矩形，不是“全部被观察”的保证。

```text
index.html                              可直接离线打开的查看器
manifest.json                           全局描述
README.txt                              阅读说明
tiles/<canvas>/<level>/<tileX>_<tileY>.png
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

`observedPixels` 是覆盖数量。`conflictPixels` 是处理期间多次观察产生的累计差异计数，**不是最终图中互不重复的坏像素个数**。`uncertainPixels` 记录不确定观察首次补入的像素，后续质量改变并不使它成为严格最终错误统计。`provisionalPixels` 是当前仍未被修复的瞬态像素净数（世界一致性掩码找不到支持它的相邻帧、且至少有一个相邻帧与它矛盾——典型是屏幕坐标覆盖物：悬浮按钮、滚动条、鼠标指针、toast）；它会随后续观察涨落，不是单调递增的累计值，也不保证降到零（见 docs/ARCHITECTURE.md §七、docs/HANDOFF.md 的已知局限）。

## provisional 位图

`provisional/<canvas>/<tileX>_<tileY>.bin` 只在 level 0 存在，与同目录下的 `coverage/*.bin` 完全同布局（row-major，低位先使用）。置位的像素是已覆盖、但世界一致性掩码判定为不一致（在录制时的相邻帧里找不到支持证据）的像素——内容仍然被保留（缺口比猜测更糟），只是标记为瞬态，等待后续一次一致的观察把它覆盖并清除标记。没有置位不代表像素一定正确，只代表它有相邻帧证据支持，或者完全没有可比较的相邻帧（此时按一致处理，例如整段录制仅出现一次的内容）。

## consistency/&lt;frame&gt; ——内部暂存，不导出

`consistency/<frame>` 是 `Engine.solve()` 位移展开一致性投票（docs/ARCHITECTURE.md §七）的中间结果：每个存在的行是一个 `{ [regionId]: { x0, y0, w, h, bits } }` 记录，`bits` 是分析分辨率（不是原生分辨率）下、以 `(x0,y0)` 为原点、`w×h` 的 row-major、低位先使用位图，置位表示该分析格在结算时判定为不一致。只有该帧的某个移动区域至少有一格被判定不一致时才会写这一行，多数帧完全不写。渲染阶段读取它、按分析因子放大到原生分辨率，与 ±1 帧掩码取逻辑或后驱动 `provisional` 位图（见上）——`consistency/<frame>` 本身只是过程数据，不代表最终瞬态状态，也不按世界坐标或画布坐标组织，只按屏幕/分析坐标。这些行是内部暂存：**保留，不在 `exportProject` 的 ZIP 里导出**（不同于 `scan-features/`、`keyframe/`、`word/`——那些在 `solve()` 结束时就被删除；`consistency/` 会在整个运行结束后继续留在本地存储里，供后续检查/调试用，只是不打包进离线结果）。

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

| 代码 | 含义 |
|---|---|
| `MODEL_ASSUMPTIONS` | 声明本次重建采用的模型与其局限；`detail` 带 `noise`（本片源声明的每通道解码噪声，单位 RGB 级）、`lossless`、`source`、`codec`，记录世界一致性比较实际用的容差——无损片源为 0（逐像素精确），压缩视频为 10（H.264/VP9 振铃与色度重建余量），见 `MediaInfo.noise` |
| `MEDIA_NOTICE` | 容器层面的提醒（HDR 等自由文本 demuxer 警告）。`NONSTANDARD_SIGNED_CTTS_V0`（见下）是这条消息文本里的前缀，不是它自己的诊断码——它总是以 `MEDIA_NOTICE`、severity `warning` 出现 |
| `ANALYSIS_PYRAMID` | 运动分析在缩图尺度进行，输出未跟随降采样 |
| `COMPUTE_BACKEND` | 首帧分析后台校准结果（CPU 或 WebGPU box-luma + CPU 配准）；`detail` 带 `calibration`（cpuMS/gpuMS/bitExact）时说明已经拿到过一个 GPU 设备 |
| `NEGATIVE_TIMESTAMP_SKIPPED` | 解码器输出了编辑列表起点之前的帧，按容器语义不展示（已计数） |
| `NONMONOTONIC_TIMESTAMP` | 容器时间戳倒退，已按解码器展示顺序继续 |
| `CONTAINER_SIZE_MISMATCH` | 容器声明尺寸与码流不符，以码流为准 |
| `DECODE_PREFIX_ONLY` | 解码中断，只对已解码前缀继续处理。`DECODER_STALLED`（见下）是这类错误消息文本里的前缀，不是它自己的诊断码 |
| `AUTOMATIC_LAYER_MASK` / `MULTIPLE_SCROLL_LAYERS` | 自动分层结果 |
| `MANUAL_UNASSIGNED` / `EXPLICITLY_EXCLUDED_REGION` / `MANUAL_REGION_PRIORITY` | 手动区域相关 |
| `LOW_TEXTURE_UNOBSERVABLE` / `UNOBSERVABLE_FRAME` | 该帧（该区域）没有可辨认纹理，不画到任何位置 |
| `UNRESOLVED_MOTION` / `AMBIGUOUS_PATTERN` | 缺少可靠对齐依据 / 存在多个合理匹配 |
| `THIN_OVERLAP_STEP` | 移动过快，位移只由很小的重叠决定 |
| `TRAJECTORY_CORRECTED` | 回访证据更强，已改正当前及之后的轨迹（此前像素保持原样） |
| `PARTIAL_CONTENT_CHANGE` | 部分区块与整体位移不一致（动画 / 懒加载 / 重排） |
| `LOW_CONFIDENCE_PLACEMENT` | 低置信位置推断，对应像素在质量遮罩中标记 |
| `RELOCALIZED` / `LOOP_CLOSURE` | 通过历史锚点重新定位 / 加入全局约束 |
| `INCONSISTENT_LOOP_REJECTED` / `AMBIGUOUS_LOOP` | 历史匹配与轨迹冲突或有多解，未强加 |
| `FRAGMENT_ATTACHED` | 独立片段被回访证据整体接回已有画布 |
| `UNPLACED_FRAGMENT` / `SCALE_CHANGE_FRAGMENT` | 无法确认相对位置 / 检测到比例变化，保留独立片段 |
| `TEMPORAL_OR_ALIGNMENT_CONFLICT` / `INCOMPLETE_TEMPORAL_PATCH` | 重叠区域存在明显差异 / 变化区域从未完整可见 |
| `GRAPH_RESIDUAL` | 位置图残差未收敛到亚像素 |
| `RELOCALIZATION_BUDGET` | 重复纹理导致检索预算被截断 |
| `NONFINITE_POSE` / `PROCESSING_ERROR` / `PERSISTENCE_ERROR` / `EXPORT_ERROR` | 错误路径 |
| `NON_SQUARE_PIXELS` | 容器声明的显示尺寸与存储尺寸不同（非方形像素）；保留原始存储像素，不缩放 |
| `PRESENTATION_FRAME` | 带外框呈现与原始二维内容分别保留；外框来自参考帧，延长部分只是装饰背景，不算已观察内容 |
| `PRESENTATION_TOO_SPARSE` | 带外框呈现画布所需瓦片数超过上限，已跳过；核心重建不受影响 |
| `PRESENTATION_REFERENCE_FAILED` | 构建带外框呈现所需的参考帧失败；带外框视图被跳过，核心重建不受影响 |
| `PRESENTATION_STAGE_FAILED` | 带外框呈现阶段整体失败；核心重建结果和状态不受影响 |
| `PYRAMID_FAILED` | 预览金字塔构建失败；原尺寸 Level 0 瓦片不受影响，仍可查看和导出 |
| `ANALYSIS_PREFIX_ONLY` | 定位或渲染阶段中断；仅对已处理的前缀帧继续 |
| `PERSISTENCE_PREFIX_ONLY` | 存储写入失败并已停止；仅已成功写入的前缀帧结果可用 |
