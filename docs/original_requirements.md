
# Long Screen：核心需求与技术目标

## 项目目标

构建一个**完全运行在浏览器端侧、质量优先的长截图 / 画布重建工具**。

用户选择一段屏幕录影。录影过程中，用户在网页、文档、漫画、Feed 或其他二维内容中移动 viewport。

目标不是简单地把视频帧依次拼接，而是：

> 根据视频中观察到的内容，尽可能重建其背后的连续二维画布（2D canvas）。

最常见的场景是纵向长截图，但核心设计不应假设用户只能持续向下滚动。

系统应尽可能支持：

- 向上、下、左、右移动。
- 斜向移动。
- 停止、回滚、反复查看已经经过的位置。
- 轻微手抖和方向反转。
- 非恒定速度移动。
- 非单调的 2D traversal。
- 部分区域被多次观察。
- 部分区域完全没有被观察。

同一内容无论被看到多少次，最终原则上只应出现一次。

没有实际观察到、也无法可靠推断的内容，不应被伪造。

---

## 核心输入

用户上传本地屏幕录影。

典型输入：

- 手机竖屏录影。
- 桌面横屏录影。
- 30–120 FPS。
- 数分钟甚至 10min+。
- 文件可能 300MB+。
- 页面可能几千到几十万像素长。
- MP4、MOV、WebM 等常见录屏格式。

整个处理过程原则上全部在用户设备上完成。

---

## 用户行为不能做过强假设

用户移动 viewport 时可能：

- 速度非常不稳定。
- 缓慢移动。
- 突然高速 fling。
- 某些内容可能只有 1–2 帧能够看到。
- 停下来休息。
- 停止时产生微小漂移。
- 上下或左右手抖。
- 向前移动后又返回。
- 多次经过相同位置。
- 横向或斜向移动。
- 完全不按照单调路径移动。

这些行为不应天然造成内容重复、缺失或破坏 reconstruction。

---

## 正确性目标

最需要避免的错误：

1. **内容缺失**
   - 视频中实际观察到过的内容没有进入结果。
2. **内容重复**
   - 同一个 canvas region 因为回滚、暂停或重复观察而出现多次。
3. **错误拼接**
   - 不属于同一位置的内容被错误连接。
   - 文字、图片或其他元素产生断裂、错位或重影。
4. **错误确定性**
   - 系统无法可靠判断，但仍把推测结果表现成确定正确。

总体原则：

> 优先生成尽可能好的 best-effort reconstruction，同时明确暴露不确定性。不要因为出现局部困难就轻易放弃整个结果，也不要把猜测伪装成确定事实。

---

## 不完整或不可确定的观察

视频本身可能没有提供足够信息，例如：

- 两帧之间移动距离过大，中间区域没有被任何 frame 捕捉。
- 大面积纯色导致运动无法可靠判断。
- 高度重复的内容存在多个合理 alignment。
- 某段没有足够 overlap。
- 某些区域只被非常短暂或低质量地观察。

系统应尽可能：
1. 使用其他帧、全局上下文、重复观察或其他证据寻找最合理的 reconstruction。
2. 在合理情况下做 best guess。
3. 继续生成其他能够可靠恢复的区域。
4. 对推断区域或不确定区域给出 warning / confidence / diagnostic。

只有在继续生成会造成严重误导、且不存在合理 best-effort 时，才应该真正阻止对应结果。

如果存在真实缺口，不应凭空生成不存在的页面内容。

---

## 页面不是静态图片

实际录屏中可能同时存在：
- 固定顶部栏。
- sticky header。
- OS 状态栏。
- 浏览器 toolbar。
- scrollbar。
- 悬浮按钮。
- popup / modal。
- 输入框和 blinking cursor。
- 鼠标指针。
- toast / notification。
- GIF / CSS animation。
- 正在播放的视频。
- 广告轮播。
- live counters / timestamps。

系统不能假设整个 frame 都属于同一个静态 scrolling layer。

对于这些内容，应尽量推断其合理归属，并生成视觉上和语义上合理的结果。

例如动态视频不应无意识地把多个不同时间点拼成一个明显不可能存在的 frame。

如果只能做近似处理，可以继续生成，但应明确 warning，而不是静默地产生异常结果。

---

## 页面本身可能发生变化

需要考虑：

- lazy-loaded 图片出现。
- 图片加载后改变页面高度。
- Web font 加载导致 reflow。
- 无限滚动继续添加内容。
- virtualized list。
- 内容在录制过程中更新。
- 手机浏览器地址栏收起导致 viewport 改变。
- 手机键盘弹出。
- orientation 改变。
- browser zoom / pinch zoom 改变。
- 页面局部组件重新布局。

这些情况不一定意味着 reconstruction 必须失败。

系统应尽可能利用时间顺序、视觉一致性和全局信息：

- 找出最可能的 canvas structure。
- 选择较一致、较完整或较高质量的 observation。
- 在存在冲突时做合理 best guess。
- 尽量保留可以确定的内容。
- 对发生变化或存在冲突的区域给出 warning。

目标是：

> 尽可能恢复一个有用且合理的最终结果，而不是因为页面不是完全静态就直接放弃。

如果不同时间点的内容确实无法同时成立，应明确指出对应区域存在 temporal inconsistency。

---

## 多滚动区域

部分应用不存在唯一的全局 scroll offset，例如：

- Slack / Discord。
- Chat UI。
- spreadsheet。
- code editor。
- modal 内部 scrolling。
- 左右 pane 独立滚动。
- nested scroll containers。

系统设计不应从根本上依赖：

> 整个 frame 只有一个 scrolling layer。

如果多个区域独立运动，应尽可能识别和重建它们各自观察到的内容。

对于无法完整恢复的复杂情况，仍应尽可能保留可靠部分并给出 diagnostic，而不是静默地产生错误结果。

---

## 内容类型

系统应尽量 general，不依赖 DOM 或特定网站结构。

需要处理：

- 几乎全是文字的长文章。
- 大量图片。
- 长条漫画。
- Social feed。
- code。
- 混合文字 / 图片 / 视频内容。
- 高度重复的列表。
- 大面积空白区域。
- 横向和二维内容。

输入只有视频 pixels。

OCR、语义模型或其他高级信息可以作为辅助，但不应成为基本正确性的唯一来源。

---

## Motion Blur 与录屏质量

主要输入是软件生成的 screen recording，而不是相机拍摄屏幕，因此传统 camera motion blur 通常不是主要问题。

仍需考虑：

- frame drop。
- temporal undersampling。
- 编码压缩 artefact。
- app 自己产生的视觉 motion blur。
- 极高速移动造成 observation 不足。
- duplicate frames。
- variable frame timing。

---

## 大文件与端侧运行

运行环境：

- Desktop Chrome。
- Desktop Safari。
- Android Chrome。
- iPhone / iPad Safari。

必须重点考虑移动设备。

输入可能：

- 300MB+。
- 10min+。
- 30–120fps。

架构不能依赖：

- 把整个视频完整读入 JS memory。
- 保存所有 decoded full-resolution frames。
- 创建一个无限增长的巨大 Canvas。
- 输出尺寸随内容长度线性占用主内存。

处理过程应尽量保持 bounded memory，并能处理逻辑尺寸远大于设备可用 RAM 的输入和输出。

---

## 超大二维输出

最终 reconstructed canvas 可能：

- 非常长。
- 非常宽。
- 同时非常宽和非常高。
- 只覆盖一个较大二维空间中的部分区域。

需要处理：

- 浏览器 Canvas dimension / memory limitation。
- 图片格式 dimension limitation。
- 编码器 limitation。
- 手机 RAM limitation。
- viewer 无法打开超大图片。

必要时可以：

- 自动切成多张图片。
- 使用二维 tile。
- 优先寻找合理切点。
- 无法避免切断视觉内容时使用适量 overlap。
- 对没有被观察到的二维区域保留明确的 hole / missing region。
- 提供适合查看或重新组合的输出形式。

不要静默 downscale 导致质量损失。

---

## Explicit over implicit

这是整个项目最重要的原则之一。

**Whatever happens, show it.**

不要：

- swallow errors。
- silent degradation。
- fake success。
- silently guess uncertain content。
- silently discard relevant observations。
- silently resize / downscale。
- silently ignore unsupported codec。
- silently accept low-confidence reconstruction。

但这不意味着遇到问题就停止。

更合适的行为是：

> Best effort first, explicit warning always.

如果系统进行了推断、近似、冲突解决或质量降级，应告诉用户：

- 发生了什么。
- 哪些区域受到影响。
- 系统采用了什么 best guess。
- 结果的不确定性有多高。
- 如果有必要，用户怎样重新录制可以得到更好的结果。

一个带有明确 warning 的有用结果，通常优于完全不给结果。

---

## 安全模型

这是一个纯客户端静态 Web 工具。

用户处理的是自己选择的本地视频。

不需要为了防止用户“攻击自己的浏览器环境”而设计复杂安全层。

不要加入与实际 threat model 无关的限制或过度防御。

---

## 实现自由

以上内容是**产品需求和问题定义，而不是预先指定的算法方案**。
请自主决定具体实现。

如果存在比需求文档暗示的方案更好的设计，应优先选择更好的方案。

尤其认真考虑：

> 是否应将问题建模为「从 video observations 重建 latent 2D canvas」，而不是传统 sequential screenshot stitching。

纵向长截图可以被视为这一问题的常见特例，而不应成为限制整个系统架构的基本假设。

---

## 完成标准

实现应能够可靠处理常见真实录屏行为，包括：

- 连续纵向滚动。
- 横向移动。
- 二维 viewport movement。
- 非恒定速度。
- pause。
- 轻微手抖。
- 往回移动后继续。
- 同一区域反复经过。
- 高速移动。
- fixed / sticky / floating UI。
- 动态内容。
- 页面局部变化。
- 多滚动区域。
- 超长或超大的输入与输出。
- sparse / partially observed 2D canvas。

并且：

- 已观察内容不应无故缺失。
- 同一内容不应无故重复。
- 不确定性和 best guess 必须能够被发现，而不是隐藏。
- 页面变化或复杂动态场景应优先尝试合理 reconstruction，而不是简单放弃。
- 大文件处理不能依赖把整个输入或输出常驻 RAM。
- 当完美结果不可实现时，应尽可能输出最高质量的部分结果，并清楚说明 limitations。

对于不影响核心目标的次要决策，请直接做合理判断并继续实现，不需要因为每个小问题停止等待确认。



