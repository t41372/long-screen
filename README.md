# Long Screen

**从本地屏幕录影恢复稀疏二维画布。**

纯客户端静态 Web 项目：一层薄 TypeScript（界面、Worker RPC、浏览器 I/O、编排）包着一个 Rust 编译成 WebAssembly 的核心，承担全部算法。包含视频解封装、逐帧解码、运动分层、历史重定位、磁盘位置图、原分辨率瓦片合成、质量诊断和离线导出。没有上传接口、云端推理、OCR、模型下载。工具链是 Deno；核心的构建工具链是 rustup/cargo（第一次构建自动安装，见下）。

> 请把它当作具有可检查证据的视觉重建系统，不是对任意录屏都能证明正确的页面恢复器。自动分层、重定位、动态区域检测仍是启发式。**流程完成不等于结果被证明正确。** 实测范围与未实现的能力见 [能力边界](docs/CAPABILITIES.md) 与 [测试说明](docs/TESTING.md)。

## 运行

需要 [Deno](https://deno.com) 2.x 和 [rustup](https://rustup.rs)。没有 `npm install`、没有 API key，运行时不需要互联网。构建会编译 Rust 核心：`rust/rust-toolchain.toml` 固定了 Rust 版本、wasm32 目标和所需组件，第一次构建时由 rustup 自动下载安装。

```sh
deno task start      # 缺少 dist/ 时自动构建，然后在 4173 提供静态文件
```

打开 `http://localhost:4173`。左侧可以直接运行内置演示（与测试套件使用同一批带真值的合成场景），也可以选择自己的录屏。

```sh
deno task build:core # 只编译 Rust 核心到 rust/target/{scalar,simd,threads}
deno task build      # 构建 Rust 核心 + 打包 TS 到 dist/（测试/开发用，带 test harness 与 source map）
deno task build:prod # 同上，去掉 test harness 与 source map，供生产部署
deno task check      # 全量类型检查
deno task test       # 单元 + 场景端到端测试（纯 Deno，无浏览器；先构建核心）
deno task coverage   # 同上并强制核心目录的覆盖率门槛
deno task test:browser   # 真实 Chrome + Playwright WebKit 中的解码、重建、界面与导出测试
deno task fixtures   # 用 ffmpeg 生成缺失的编码测试样本（已存在的文件不会被覆盖）
deno task fingerprint    # 逐场景、逐持久化行的字节级指纹工具，见 docs/TESTING.md
```

浏览器测试（`deno task test:browser`）需要 Google Chrome（Playwright 自带的 Chromium 不含 H.264）和 Playwright 的 WebKit：`npx playwright@1.58.2 install webkit`（需要 Node.js；版本与 `deno.json` 里的 `playwright` 一致）。`deno task fixtures` 需要 ffmpeg。

主应用使用 ES modules 和 Worker，需要静态文件服务器，不能直接双击 `dist/index.html`。**本机开发直接用 HTTP localhost，不需要配置证书。** 手机访问电脑的局域网 HTTP IP 也可打开应用、运行演示，并使用“近似 · 原生 seek”模式测试本地视频（浏览器须能播放该视频，可能漏帧）。浏览器通常只在安全来源开放 WebCodecs 精确解码和 OPFS 磁盘导出；`localhost` 算安全来源，局域网 IP 不算，因此手机验证这些能力需用 HTTPS，例如 GitHub Pages。应用按实际 API 能力启用功能，不会仅因 HTTP 拒绝运行；这些浏览器限制与上传无关，所有处理仍在本机。导出的**结果包**不同：解压后可直接打开其中的 `index.html` 离线查看。

## 使用

选择录屏 → 可选指定独立运动区域 → 重建 → 选择画布并检查质量遮罩 / 诊断 → 导出。

选择文件后，应用会用 WebCodecs 直接解出第一帧来读取真实的编码、尺寸、旋转和帧数；不依赖浏览器 `<video>` 元素能否渲染该容器。原生播放器只用于兼容模式和“查看原始时刻”。

自动模式分开保留移动内容与固定界面；多个独立 pane 各有自己的坐标系。不能确认位置的观察成为可导出的独立片段，不会在主长图末尾强行追加；若之后的回访给出可靠证据，片段会被整体接回并记录。透明处表示没有可用观察，不表示白色页面。

## 导出

**完整项目 ZIP64**：原尺寸 PNG 瓦片、预览金字塔、离线查看器、像素覆盖位图、块级置信 / 冲突 / 来源帧、每个处理帧的贡献记录、运动分析日志、位置图与全部诊断。原视频不复制进项目。

**当前画布 PNG / 分页**：适合尺寸直接流式编码成 PNG；超过兼容尺寸时输出多张原尺寸 PNG，附世界坐标与 32px 重叠说明。不静默缩小。

优先写入用户选择的文件；不支持该接口时用 OPFS 写临时文件再下载。无磁盘写出路径时明确失败，不回退成把整个输出拼进 RAM。

## 部署

`deno task build:prod` 产出的 `dist/` 是静态站点，上传到任何遵守 `_headers` 文件的静态托管（Cloudflare Pages、Netlify；`static/_headers` 原样复制并设置线程构建需要的 COOP/COEP/CORP 响应头，以及缓存策略）即可，不再是 GitHub Pages——后者不能设置自定义响应头，会导致页面不跨源隔离、Wasm 核心退回单线程构建（仍能运行，只是没有线程加速）。**托管方必须在 304 响应上也带上这三个头**，不能只在 200 上带：开发服务器（`deno task start`）对每个响应都重新附加，但静态托管各自的行为不一定一致——一次 304 上缺 CORP 头曾经打断 WebKit 私密浏览下的下载流程（见提交历史 "dev server re-applies COOP/COEP/CORP to every response"）；`_headers` 文件本身对 304 是否生效因托管商而异，部署时请在真实主机上核实（用浏览器开发者工具看一次带 `If-None-Match` 的重复请求，确认 304 响应也带着三个头）。

## 架构

```text
File / Blob（分段随机读取，8 × 256KiB 页面）
  → MP4 / MOV / fMP4 / WebM 解封装（含 QuickTime 有符号 ctts）
  → WebCodecs（PTS、B 帧、背压、释放 VideoFrame）→ RGBA
  → 第一遍：逐帧运动证据 + 全局区域学习 → 磁盘
  → 第二遍：分层定位、原像素精修、历史重定位、位置图 → 磁盘
  → 第三遍：校正坐标、像素所有权、时间冲突 → 有限 LRU 瓦片缓存
  → IndexedDB 原图瓦片 / 覆盖位图 / 诊断
```

解码是唯一依赖浏览器 API 的一步：`FrameSource` 产出 `RGBA` 而不是 canvas，供之后各遍使用。配准、分层、位置图、合成、瓦片编解码等算法全部在 `rust/core` 编译成的 Wasm 核心里；TypeScript 是围绕它的薄壳（界面、Worker RPC、I/O、编排）。Deno 测试与浏览器加载的是同一份核心，因此 Deno 里验证过的算法行为就是浏览器里的行为。详见 [架构文档](docs/ARCHITECTURE.md)（十一、十二节是当前逐模块归属与刻意留在 TS 的清单）；历史迁移过程记录在 [docs/history/2026-09-rust-migration-log.md](docs/history/2026-09-rust-migration-log.md)（已完结，不代表当前状态）。

## 目录

```text
rust/core       Rust 核心源码；编译为 core.wasm / core.simd.wasm / core.threads.wasm 三种构建
src/core        围绕核心的 TS 薄壳：配准、分层、位置图、关键帧、合成、光栅、加载与选择构建（src/core/wasm/**）
src/media       容器解析、范围读取、WebCodecs 解码
src/codec       PNG 编解码的 TS 编排层，chunk/CRC 校验通过核心
src/pipeline    三遍引擎的编排（scan/solve/render）；冲突判定与位姿图优化本身都已在 Rust 核心，这里是调用顺序与 KV I/O
src/storage     IndexedDB / 内存 KV、瓦片、诊断
src/synthetic   合成场景、渲染器、真值校验器（同时是内置演示）
src/export      ZIP64（借助 npm 包 client-zip）、PNG 分页、离线查看器
src/ui          界面与瓦片查看器
scripts         构建（build.ts/build-core.sh）、基准、指纹、样本生成等工具脚本
static          COOP/COEP `_headers`、开发用 harness 页面等静态资源
tests/unit      纯 Deno 单元测试、场景端到端测试、`tests/unit/parity/` 下的 TS↔Rust 字节级对照
tests/support   测试用核心加载、场景真值校验、冻结的 parity 参照实现（tests/support/reference/）
tests/browser   Playwright 驱动真实 Chrome + WebKit
```

许可证 MIT。
