/** Text the worker-side code (src/pipeline, src/core, src/media, src/export) writes into diagnostics, progress
 *  events, export results and the exported offline viewer, in the locale the page sent the worker. Persisted rows
 *  keep the language they were written in.
 *
 *  `diag` keys are the diagnostic's `code`, holding `message`/`action` (and, where one code has several
 *  wordings, a piece per wording — see the call sites in src/pipeline/**, src/core/compositor.ts). */
export const pipelineSections = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        '重建采用分层平移画布与几何回环约束。自动遮罩和动态区域属于启发式推断；置信分数不是经过校准的正确概率。世界一致性比较按本片源声明的解码噪声 ±{{noise}} 级执行{{margin}}。',
      marginLossy: '（压缩视频的振铃/色度重建余量）',
      marginLossless: '（无损片源，逐像素精确比较）',
      action: '比例或结构无法共存时会保留独立片段，不把不相容的状态强行拼接。',
    },
    APPROXIMATE_DECODER: {
      message: '已明确启用 {{fps}} Hz 原生 seek 兼容模式。不能保证采到视频的每一帧，短暂内容可能缺失。',
      action: '需要逐帧覆盖保证时，使用 WebCodecs 支持的 H.264、VP9 等输入。',
    },
    ANALYSIS_PYRAMID: {
      message: '运动分析的长边上限为 {{size}}px；原分辨率像素用于精修和最终合成，输出没有跟随降采样。',
    },
    FRAME_MEMORY_PRESSURE: {
      message: '单帧原始像素及参考帧占用已接近所选缓存预算。解码器/GPU 自身内存不受 JavaScript 缓存预算控制。',
      action: '不会静默降低输出分辨率；内存不足时保留已提交数据并报告失败。',
    },
    RUN_FAILURE: {
      action: '已经提交到本地存储的瓦片仍可查看和导出；没有把失败标记成成功。',
    },
    PERSISTENCE_ERROR: {
      action: '存储写入也失败；仅先前成功提交的数据可恢复。',
    },
    MEMORY_BUDGET_RAISED: {
      message: '瓦片缓存从预算允许的 {{from}} 块提高到 {{to}} 块（约 {{mb}} MB），以容纳一帧触及的全部瓦片。',
      action: '小于单帧覆盖范围的缓存会让每一帧都完整地重新解码与编码所有瓦片；如需更低内存，请降低录屏分辨率。',
    },
    NONFINITE_POSE: {
      message: '定位计算产生无效数值。已隔离此观察，未将无效坐标写入画布。',
    },
    MISSING_PLAN: {
      message: '渲染阶段缺少 plan/{{index}}；已停止在已提交的渲染前缀。',
      action: '检查本地存储完整性；缺失的求解计划不会被静默当作空观察。',
    },
    prefixOnly: {
      base: {
        scan: '仅对已经解码的前 {{frames}} 帧继续定位和合成',
        solve: '仅对已经求解的前 {{frames}} 帧继续渲染',
        render: '仅对已经渲染的前 {{frames}} 帧保留结果',
      },
      suffixPersistence: '；存储写入已停止。',
      suffixDefault: '。',
    },
    PRESENTATION_TOO_SPARSE: {
      action: '该画布的带外框呈现被跳过；页面坐标下的核心重建不受影响。',
    },
    PRESENTATION_FRAME: {
      message:
        '带外框视图与原始二维内容分别保留。外框来自参考帧，延长部分仅为装饰背景，不算作已观察内容；不会拉伸或复制工具栏图标。其他 pane 在外框中只是参考快照。',
    },
    PRESENTATION_STAGE_FAILED: {
      action: '带外框呈现阶段失败；页面坐标下的核心重建结果和状态不受影响。',
    },
    PYRAMID_FAILED: {
      action: '预览金字塔构建失败；原尺寸瓦片不受影响，仍可正常查看和导出。',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: '{{pass}} 阶段只完成 {{actual}}/{{expected}} 帧；结果被标记为 partial。',
      action: '已保留成功提交的前缀；缺失的帧不会被静默当作已处理。',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}。Rust 核心：{{variant}} 构建，{{threads}} 个计算线程（{{coreReason}}）。',
    },
    PRESENTATION_REFERENCE_FAILED: {
      action: '带外框呈现将被跳过；页面坐标下的核心重建不受影响。',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message: '画面缺乏可辨认纹理。完全相同的空白帧既可能是暂停，也可能是在空白区域移动；像素本身无法区分。',
      action: '增加有区分度的可见内容或录制更多重叠。零位移只是 best guess。',
    },
    UNRESOLVED_MOTION: {
      message: '这一观察缺少可靠的视觉对齐依据。定位阶段将尝试历史重定位；仍无法定位时保留独立片段。',
    },
    AMBIGUOUS_PATTERN: {
      message: '检测到具有多种合理匹配的重复纹理；连续性只是定位先验，不是已证实的唯一位置。',
    },
    TEMPORAL_UNDERSAMPLING: {
      message: '此帧持续时间较长；高速移动期间可能存在从未被采集到的区域。',
    },
    MANUAL_UNASSIGNED: {
      message: '手动区域未覆盖的部分被保留为独立的低置信屏幕坐标观察层，没有宣称这些像素已恢复到页面坐标。',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message: '按手动设置排除了“忽略”区域。该区域不会贡献到重建结果，这不是自动丢帧。',
    },
    MANUAL_REGION_PRIORITY: {
      message: '手动区域重叠时，后绘制区域优先；忽略区域始终排除。其余像素保留在未指定观察层。',
    },
    AUTOMATIC_LAYER_MASK: {
      message: '自动划分出 {{moving}} 个内容区域和 {{fixed}} 个固定界面区域。边界来自像素运动统计，而不是 DOM。',
      action: '若遮罩归属不合理，可在“区域”里画出精确滚动区后重新处理。',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: '多个独立滚动区将分别建立画布，不强制共享一个 scroll offset。',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message: '本帧对齐后的重叠区域共有 {{conflicts}} 个明显不同的像素；此区域是其中一个冲突分量。可能是动画、内容更新、重排或配准残差。',
      actionStable: '已尽量冻结单一时刻的完整冲突区域；查看橙色诊断和原视频时间点。',
      actionRolling: '仅在完整可见时用同一帧更新整块冲突区域；并非全页面同一时刻。',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message: '这个变化区域从未完整地出现在一个可用视口中；无法保证其所有像素来自同一时刻。',
      action: '保留已观察内容和明确冲突标记，没有填造未观察部分。',
    },
    MISSING_SCAN_RECORD: {
      message: '求解阶段缺少 scan/{{index}}；已停止在已提交的求解前缀。',
      action: '检查本地存储完整性；缺失的扫描记录不会被当作零位移。',
    },
    GRAPH_RESIDUAL: {
      message: '位置图最大残差仍有 {{residual}} 原像素；相关接缝可能存在几何不一致。',
      action: '检查回环附近的文字与重复纹理。该残差没有被隐藏。',
    },
    PARTIAL_CONTENT_CHANGE: {
      message: '约 {{percent}}% 的纹理区块与整体位移不一致（动画、视频、懒加载或重排）；位移由一致区块决定，冲突区域在合成时单独处理。',
    },
    THIN_OVERLAP_STEP: {
      message: '两帧之间移动很快，只剩很小的重叠可供对齐。位移取自这一小块证据；在周期性排版中，相邻周期同样能解释这些像素。',
      action: '若之后的回访给出更强的证据，这段轨迹会被整体改正并记录。',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous: '重复纹理使多个位移都能解释像素；采用与运动连续性最一致的解，这是 best guess 而非唯一正确对齐。',
      messageLowConfidence: '这一区域采用了低置信度的位置推断；相关像素会在质量遮罩中标记。',
      messageStatic: '两帧几乎相同但缺少可验证的特征对应；按暂停（零位移）处理，这是 best guess。',
      action: '连续轨迹和已有锚点用于 best guess，不代表唯一正确对齐。',
    },
    UNOBSERVABLE_FRAME: {
      message: '这一帧在该区域没有可辨认纹理：空白帧既可能是暂停，也可能是在空白区域移动，像素本身无法区分。它不会被画到任何位置。',
      action: '若空白之后的内容无法与之前的观察重叠，将保留为独立片段，而不是猜测中间距离。',
    },
    RELOCALIZED: {
      message: '通过历史视觉锚点重新定位到已观察画布，未把回访内容追加成长图。',
    },
    SCALE_CHANGE_FRAGMENT: {
      message: '检测到约 {{scale}}× 的比例/布局变换，已按原像素保留独立片段；没有偷偷缩放混合。',
      action: '跨片段关系尚未证实；后续回访若能可靠匹配，片段会被整体接回。重新录制时增加重叠，或用区域设置隔离变化组件。',
    },
    UNPLACED_FRAGMENT: {
      message: '无法确认与原画布的相对位置，已保留独立可导出片段。两个片段之间可能重叠，也可能存在真实缺口。',
      action: '跨片段关系尚未证实；后续回访若能可靠匹配，片段会被整体接回。重新录制时增加重叠，或用区域设置隔离变化组件。',
    },
    STICKY_OCCLUSION: {
      message: '顶端纹理支持屏幕固定而非页面位移；本次观察的固定遮挡不写入移动画布。原始参考界面保留在外框呈现中。',
    },
    FRAGMENT_ATTACHED: {
      message: '回访证据把一个独立片段整体接回了已有画布；片段内的相对轨迹保持不变。',
    },
    TRAJECTORY_CORRECTED: {
      message: '上一步只有很小的重叠，本帧与已观察内容的匹配相差 {{discrepancy}}px 且证据更强；已按这一匹配改正当前位置。',
      action: '被改正的是本帧及之后的轨迹；此前写入的像素保持原样，可能与改正后的坐标存在接缝。',
    },
    LOOP_CLOSURE: {
      message: '发现可靠的历史重访，已加入全局位置约束；最终合成使用校正后的轨迹。',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message: '历史匹配与连续轨迹相差 {{discrepancy}}px；证据冲突，未强加为回环。',
    },
    AMBIGUOUS_LOOP: {
      message: '历史检索有多个接近的合理位置；没有把不确定回环当作硬约束。',
    },
  },
  progress: {
    runPartial: '已保存明确标记的部分重建。',
    runComplete: '重建已完成；请检查诊断与未观察区域。',
    render: '按观察证据合成原尺寸瓦片；缺口保持透明。',
    framingStart: '保留原始外框；只延伸背景，不拉伸侧栏文字或重复图标。',
    pyramidBuild: '正在建立磁盘预览金字塔；原尺寸瓦片保持不变。',
    scanFrame: '逐帧提取几何证据，学习独立运动区域。',
    duplicateReuse: '完全相同的观察复用定位；保留源帧与时间记录。',
    solveFrame: '原像素精修、历史重定位与二维回环约束。',
    optimizing: '优化磁盘中的位置图，校正回环漂移。',
  },
  media: {
    CONTAINER_SIZE_MISMATCH: '容器声明 {{codedWidth}}×{{codedHeight}}，码流实际为 {{bitstreamWidth}}×{{bitstreamHeight}}；以码流尺寸为准。',
    NON_SQUARE_PIXELS:
      '该录屏声明非方形像素长宽比（显示尺寸 {{displayWidth}}×{{displayHeight}}，存储尺寸 {{bitstreamWidth}}×{{bitstreamHeight}}）；保留原始存储像素，不做缩放。',
    NEGATIVE_TIMESTAMP_SKIPPED: '解码器输出了位于编辑列表起点之前（负时间戳）的帧；按容器语义不展示这些帧。',
    NONMONOTONIC_TIMESTAMP: '容器时间戳出现倒退；已按解码器的展示顺序继续处理，未丢弃观察。',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: 该视频轨道的 ctts box 是 version 0，但包含负的合成时间偏移；ISO 14496-12 仅在 version 1 中定义负偏移。这些偏移按有符号处理（QuickTime/ReplayKit 的常见写法），未被当作异常大的正偏移。',
  },
  exports: {
    tilesProgress: '导出原图与预览瓦片 {{n}}',
    zipFinalize: '写入 ZIP64 目录并提交文件',
    projectDone: {
      message: '已导出原尺寸瓦片、离线查看器、覆盖与质量数据、源帧记录和完整诊断。',
    },
    encodingSingle: '无缩放编码 {{row}} / {{total}} 行',
    canvasDone: {
      message: '已导出 {{width}} × {{height}} 原尺寸 PNG，缺口保持透明。',
    },
    encodingSheet: '已编码 {{count}} 张原尺寸分页图片',
    sheetsDone: {
      messagePaged: '已按分页导出为 {{count}} 张原尺寸图片；相邻页最多重叠 {{overlap}}px，坐标见 manifest。',
      messageOversize: '画布超过单张兼容尺寸，已明确改为 {{count}} 张原尺寸图片；相邻页最多重叠 {{overlap}}px，坐标见 manifest。',
    },
  },
  offline: {
    title: '离线画布',
    fit: '适应',
    tip: '本地原尺寸瓦片 · 拖动 / 滚轮缩放',
    previewLevel: '显示预览层 {{level}}，放大可见原像素',
    nativeTiles: '显示原尺寸瓦片',
    footer: '棋盘区域未被观察 / 无瓦片；置信度不是正确概率。查看 diagnostics.jsonl 与 observations.jsonl。',
  },
};
