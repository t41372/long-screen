# 稀疏画布结果包

格式：`long-screen/sparse-canvas`，version 1。

`manifest.json` 保存项目、设置、媒体尺寸 / 名称 / 字节数、各画布原生坐标边界。每个独立画布有自己的坐标原点；fragment 之间没有声明空间邻接关系。bounds 是外接矩形，不是“全部被观察”的保证。

```text
index.html                              可直接离线打开的查看器
manifest.json                           全局描述
README.txt                              阅读说明
tiles/<canvas>/<level>/<tileX>_<tileY>.png
coverage/<canvas>/<tileX>_<tileY>.bin
quality/<canvas>/<tileX>_<tileY>.json
observations.jsonl                      每个完成合成帧的决定
analysis.jsonl                          每帧运动分析记录
poses.jsonl                             校正前后关键帧位置
pose-edges.jsonl                        持久化邻接约束（双向）
temporal.jsonl                          冲突区域与选择时刻
attachments.jsonl                       被回访证据整体接回主画布的片段及其刚性位移
diagnostics.jsonl                       持久化诊断
graph-summary.json                     优化残差与回环数量
memory-stats.json                      瓦片缓存计数与预算说明
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

`observedPixels` 是覆盖数量。`conflictPixels` 是处理期间多次观察产生的累计差异计数，**不是最终图中互不重复的坏像素个数**。`uncertainPixels` 记录不确定观察首次补入的像素，后续质量改变并不使它成为严格最终错误统计。

## 帧记录

`observations.jsonl` 每行包括零基 frame、秒 time，以及每个层的 canvasId、最终 placement、addedPixels、conflictPixels、uncertainPixels。准确解码模式消费每个可解码的视频 observation；seek 模式是采样观察，并不是原视频帧索引。时间戳保留容器意义，fMP4 第一帧可能非零。

`analysis.jsonl` 有降采样运动场、假设、置信、zoom 检测等；它不是原始全尺寸画面。原文件既未包含，也未做强哈希绑定。

## 时间与诊断

`temporal.jsonl` 的 rect 使用所属画布坐标，记录 chosenFrame / chosenTime / complete / revisions。complete 指算法选择的区域在一次观察中完整可见，不代表语义视频边界正确或全页面同一时刻。

诊断字段包括 code、severity、message，以及可选 time、frame、canvasId、region、confidence、detail、action。UI 可分页查看全部持久化记录，不只是最后几条。若存储已经失败，最后错误可能只存在于 UI / 项目 error，不能宣称其日志一定提交成功。

## 单图与分页

单图 PNG 包含当前画布 bounds 的像素，包括透明孔洞；图内(0,0)对应 bounds.(x,y)。分页 ZIP 每张 `sheet_x_y.json` 给出原生世界坐标与实际宽高。相邻页最多重叠 32px，有意重叠不能当重复错误；重新组合时按世界坐标放置，不要直接把图片首尾追加。

## 诊断码

| 代码 | 含义 |
|---|---|
| `MODEL_ASSUMPTIONS` | 声明本次重建采用的模型与其局限 |
| `MEDIA_NOTICE` | 容器层面的提醒（非方形像素、HDR 等） |
| `ANALYSIS_PYRAMID` | 运动分析在缩图尺度进行，输出未跟随降采样 |
| `NEGATIVE_TIMESTAMP_SKIPPED` | 解码器输出了编辑列表起点之前的帧，按容器语义不展示（已计数） |
| `NONMONOTONIC_TIMESTAMP` | 容器时间戳倒退，已按解码器展示顺序继续 |
| `CONTAINER_SIZE_MISMATCH` | 容器声明尺寸与码流不符，以码流为准 |
| `DECODE_PREFIX_ONLY` | 解码中断，只对已解码前缀继续处理 |
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
