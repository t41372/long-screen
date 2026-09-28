# 来源重建：效能与正确性改进

起点是 `d69238c90f125b98669f34ad3d7b81d58c480952`，对照checkout固定在该head。原始MOV、Deno和Rust都在本机，实际执行Engine、Wasm、浏览器及实录验证；没有推送或部署。

## 核心判断

审查报告对主要成本的归因成立。初次f实测162.24秒，其中source replay 44.22秒、analysis 100.35秒、materialize 4.16秒，保留3,166,714个候选。profile中feed的采样self time为18.72秒、page_connected为9.60秒、LZ4压缩7.70秒、解压6.49秒；这些采样项不是互不重叠的阶段总和。模型与其他来源判断仍占显著成本，不能靠省几次transaction解释整个回退。

三项定点问题均确认并修复：分数位姿的shard枚举统一到`resolveRasterPose`；未写回的archive不再占写入批次预算；Learning的field标签解析回typed key，保留canonical标签语义和样本次序。

## 已采用的改动

- 一页一个decoded handle，frame discovery与annotation/learning共用解码；异常、停止及正常退出均释放，learning产生独立样本后立即释放原页。必要的跨阶段barrier保留。
- annotation没有改变visibility时，不压缩、不重写archive；opacity只计算真实待写字节。
- 候选RGBA使用不可变共享payload与写时复制。只共享完全相同的原生字节，纯色palette只保留有界弱引用；frame、pose、visibility、quality、spans和exposures仍属于各自观察。
- state/page v2对完全相同的RGBA与visibility建立字典，保留所有观察及原顺序；继续读取v1。LRU沿用原逻辑计费，避免共享/编码改变分页和模型顺序。逻辑工作集计费不等于浏览器RSS或精确堆字节。
- 完全相同的分析输入可以复用前次计算，但仍记录当前epoch option与候选计数；更早的来源、质量、noise或证据变化会重新判断。完全均匀的256像素决策可执行一次再复制；任一像素状态不同就走逐像素路径。
- 原生16×16证据扫描按互不重叠的行使用现有helper pool。所有输出先在主instance配置，chunk内没有配置、锁或模型更新；后续物体追踪与模型次序不变。
- 连通背景先检查全帧能否达到既有的八个纹理证据门槛；不可能达到时跳过flood fill。达到门槛的分量不再重复计算多余的纹理计数。
- 模型依赖索引覆盖实际object fringe与field边界，不局限于能够提供训练样本的位置。无有效模型交集、没有新反证，且佐证前后所有RGBA、来源frame、reason及内容类型相同的shard复用原选择。所有训练观察仍保留，不用“没检测到物体”代替安全证明。

这些改动没有抽帧、top-K丢弃、放宽阈值、裁边、平滑或生成RGB。候选收集前的完整最终选择认证仍未实现；本轮分流主要减少后续重复计算，不应描述成已完成三级自动重建架构。

实录f还揭露了表示改动中的计费陷阱：`collect<Result<Vec<_>, _>>`丢失精确的长度下界，使少量热候选容器按四个元素扩容，而旧loader按实际长度配置。这曾把f的archive pages从6,739改变为6,727，进而令model fields从301变成302，虽然PNG及旧瓦片证据散列完全相同。已改为精确预配置，并加入v1/v2 loader工作集计费一致的回归：修复前主机测试相差1,536 bytes，修复后相同。对应实验保留在`final-f/`，不会作为最终通过的结果；最终验收另外比较所有来源行，包括模型和逐像素provenance。

## 未采用的实验

固定逐帧直接封存通过了跨cache budget的页次序检查，但改变了alias/候选次序与热状态契约。实验在若干案例遇到空观察区块的处理问题，phone尾端另有1,654个可恢复像素未还原，未保留此实现。补丁、失败输出与逐像素位置在`test-results/source-optimization/journal-experiment/`。这不是一项可用“保留全部样本所以必然等价”放行的改动，也不能把该实验的时间当作已交付收益。

另以测试适配器尝试只保留最终provisional/conflict/frozen区块。13个原生反例的普通真值检查均未出现新增缺失或可恢复鬼影；floating剔除701/4,022个原始争议块。然而这些旗标不能证明被删观察不再提供跨shard模型训练证据，phone的学习atlas之外也需要单独检查，所以未将这个开关并入生产。探针与结果在`probe-final-flags.ts`和`final-flags-probe.json`。

## 正确性与格式核对

`--source-content`将来源state/page完整还原成canonical v1后散列，包含公开patch-sheet JSON未列出的source state与exposures；同时保留`rawRows`，不隐藏真实落盘格式变化。首轮25个场景、14,082笔资料中，规范化后只有13笔source-summary不同，其他像素、证据、模型、候选及诊断行一致。原始字节差异另有165笔source-page与170笔source-state，原因是v2字典格式；统计增加跳过/未改页数、scratch行数与内存/档案字节变化。

合成floating的候选仍为92,940个、archive pages仍为24页，候选封存页从7,143,532降至2,718,020 bytes。这里不把模型或整个IndexedDB占用混进archive pages，也不把旧CPU计时当成本轮加速比例。

Chrome和WebKit的floating Engine、IndexedDB、鬼影真值及原尺寸PNG导出均通过，见`browser-*.json/png`。实录f不具有整图逐像素真值，因此其质量验收是和原分支完整输出及证据逐位比较，而不是宣称所有真实录影都已正确。

## 实录量测与限制

早期共用解码版本的f输出与证据散列相同，但wall time为236.59秒；一次连续对照又为原head 258.10秒、当时版本333.41秒，连未改动的replay都从58.00变到95.95秒。已将此波动原样保留，不能筛掉较慢结果后宣称加速；最终版本另做重复控制组。

另测顺序解码加Wasm上传：Chrome两遍2.546/2.460秒，WebKit两遍1.163/1.001秒；每遍387帧。独立的非计时遍历逐帧RGBA SHA-256相同（各浏览器内部比较，没有宣称跨浏览器色值相同）。因此额外video replay确实值得做架构PoC，但这只测了decode/upload成本，不包括按原候选顺序处理、metadata调度、模型barrier、存活期及完整alternatives导出，不能当作已实现的引擎加速。

## 最终f对照与仍未完成的目标

最终连续A/B见`verified-f/baseline.json`与`verified-f/current.json`，汇总在`verified-comparison.json`。计时不包含build、验证散列与导出。完整11,258笔source行的SHA-256均为`fef646e0556c332b14047722310c2660878debdc45480efd6a169205d21d6527`；原生瓦片像素、覆盖及旧来源证据也逐位相同。候选3,166,714个、archive pages 6,739页、state writes 7,428次，模型301个field、454,914个有效像素和所有来源reason计数均与原head相同。

| 指标            |       原head |     最终版本 |
| --------------- | -----------: | -----------: |
| 完整管线        |    190.345 s |    155.992 s |
| 来源回放        |     50.019 s |     38.655 s |
| 来源分析        |    118.620 s |     96.234 s |
| 来源应用        |      5.114 s |      4.184 s |
| 候选封存页bytes |  239,151,416 |  220,250,870 |
| Wasm高水位      | 223.1875 MiB | 221.1875 MiB |

这次配对耗时下降18.0%（1.22×），archive pages字节下降7.9%。5,243页初次annotation不再重写，77个shard省略无依赖的opacity重选。Wasm只减少2 MiB，不是显著的全程序RAM降低。之前所有波动较大的数据保留，不能把单次最终对照泛化成八段实录或不同设备的加速保证。

**尚未达到“接近旧算法速度”的目标。** 大量历史争议仍会先提取为候选；本轮没有减少f的候选总数，也没有实现候选提取前的完整低成本认证。后续应优先验证metadata/原始压缩视频引用的流式方案，以及保留训练依赖的最终选择认证，而不是继续累加小的常数优化。需要明确canonical观察顺序、工作集与原视频24小时生命周期，验证每次重解码的原生RGBA，并保留完整alternatives和provenance；不能仅删除历史争议或调整内存阈值来宣称完成。

最终检查：145个Rust测试、364个Deno测试通过；scalar与threads的parity/source/memory组合各69个通过，SIMD由完整套件覆盖；Chrome/WebKit各一项来源重建与导出E2E通过。`check`、`lint`及`fmt`通过。日志与源码快照在`verification/`。

## 复现

所有本轮原始数据在`test-results/source-optimization/`，f输入SHA-256为`d726dafca0b52aed28bd87cf1b5cdd00ae53ca1270ff8b4156a0da579a3de6a8`。

```sh
deno task test
deno task check
deno task lint
LONGSCREEN_CORE=scalar deno test --allow-read --allow-write --allow-env tests/unit/parity tests/unit/sources.test.ts tests/unit/source-resolution.test.ts tests/unit/core-memory.test.ts
LONGSCREEN_CORE=threads deno test --allow-read --allow-write --allow-env tests/unit/parity tests/unit/sources.test.ts tests/unit/source-resolution.test.ts tests/unit/core-memory.test.ts
deno test -A tests/browser/sources.test.ts
deno run -A scripts/fingerprint-scenarios.ts test-results/source-optimization/recheck.json --source-content
deno run -A scripts/compare-fingerprints.ts test-results/source-optimization/before-fingerprint.json test-results/source-optimization/recheck.json
deno run -A scripts/benchmark-pipeline.ts --input test_case/f.mov --passes 2 --persistent --verify-tiles --verify-sources --export-canvases --output test-results/source-optimization/recheck-f
deno run -A scripts/benchmark-source-replay.ts f.mov chromium
deno run -A scripts/benchmark-source-replay.ts f.mov webkit
```

指纹比较仍会因上述统计行返回非零；逐行说明而不是忽略exit code。没有改动scenario ratchet或coverage floor；未重跑包含已知WebKit超时的完整浏览器套件，未验证实体iPhone。
