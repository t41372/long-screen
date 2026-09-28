# 來源重建：遠端審查與效能優化交接

本分支保存待審查的來源重建實作、相關核心修正、測試與設計文件。比較基準為 `63763e97b0b86aa200dd03fb24e0b58dc72cd168`。實作提交為 `edfff432d57b6ddba94cd1e9cc4b3374ec6e599f`。產品程式與量測時逐位元組一致；背景 Markdown 僅整理格式。本次交接沒有改演算法或修復下述問題。

## 優先結論

相對基準，8 段實錄全部變慢，合計 296.48 → 4988.83 秒，耗時 16.83 倍。新增來源階段占現版總耗時 92.9%。40 個合成案例的三次中位數亦全部變慢，逐例 1.10–4.23 倍，中位數合計 32.14 → 66.90 秒（2.08 倍）。

原有流程也有回退：沒有來源回放的 vertical 從 1.331 增至 1.726 秒，horizontal 從 1.154 增至 1.911 秒。實錄扣除已記錄的來源子階段後，其餘階段與開銷合計 352.45 秒；這是時間歸因，並非實際停用來源流程的另一組 A/B。

可攜式原始數值、每例三次合成樣本、實錄的階段與儲存數據、輸入 SHA-256、硬體及 Wasm 指紋保存在 [benchmark JSON](benchmarks/2026-09-26-head-comparison.json)。實錄原檔、CPU profiles、逐瓦片雜湊及完整 logs 留在本機的 `test_case/`、`test-results/head-performance-20260926/`，不隨 Git 分支提供。這份 JSON 不含錄影影格或原生像素。

## 量測與驗證範圍

- Apple M5 Max（18 核心）、64 GB RAM，Chrome 153.0.8010.53，Deno 2.9.7。
- 實錄每段每版測一次，交替版本順序、完全序列執行；各次使用新的普通磁碟 Chrome profile。128 MB 設定、分析長邊 640、自動分層與 compute；16 次均實際選中 threads 核心、8 helpers、CPU 分析後端。
- 計時為 `Engine.run`，含解碼、IndexedDB、全部重建階段、呈現與金字塔；不含建置、開啟媒體、事後瓦片雜湊與匯出。兩版均啟用 CPU profiler。
- 所有 16 次實錄執行均 complete，兩版處理幀數一致，沒有頁面錯誤或失敗請求，並保存了瓦片雜湊。這不表示實錄具有逐像素真值或輸出品質等價。
- 合成使用相同的目前版輸入產生器，交給各版自己的 Engine、核心與 storage；Deno SIMD、CPU、MemoryKV。每個樣本為獨立程序，固定 fixture 暖機後計時，每例每版三次取中位數。geometry-change 按設計回傳 partial，其餘 39 例均 complete。
- 同一實作已通過 `deno task check`、`deno task lint`、`deno task test`（137 個 Rust、363 個 Deno 測試）。本次提交重新跑格式化、型別、lint 與完整單元／場景套件。沒有在本次交接重跑完整瀏覽器套件或實體行動裝置。

## 已知且未修復的正確性問題

`src/pipeline/sources.ts` 的 `DeferredSources.replay()` 直接用分數位姿計算來源 shard 範圍，合成器與 Rust 候選擷取則使用取整後的位姿。寬度 256、`p.x = 0.6` 時，合成輸出覆蓋 x=1..256，但回放只遍歷 shard 0，漏收 shard 1 的最右欄；y 方向亦同。32 像素高的重現輸入中，32 個已渲染像素沒有回放候選；改用等價的 `p.x = 1` 則能收集該欄。

應先建立此邊界行為的回歸，再讓來源遍歷使用與 `Compositor.add()`／`TileHistory::capture_owned()` 一致的光柵位姿；ledger 中的原始分數位姿可繼續保留。最小條件與預期已列於上段，本機重現程式與結果在 `test-results/review/fractional-source-boundary.ts`、`fractional-source-boundary.json`。

## 接手時的重點

1. 先確認新增來源回放、候選分析、透明度模型與儲存成本。`a.mov` 分析 28,321,855 個候選、產生 221,118 次批次寫入，耗時 1795.95 秒；`d.mov` 也有 23,076,047 個候選。新增來源核心目前未使用 helper pool。這些是優先量測的路徑，尚未證明某一個替換方案能達到目標速度。
2. 同時核對原有流程的額外成本，包含 screen voting、RGB／雙軸清晰度及完整 ROI 的靜止 fallback。以階段 profile 驗證，不把特徵子核心加速當作完整管線加速。
3. 保留稀有乾淨觀察、原生來源歸屬、動態共同 epoch、停止與儲存失敗的原子提交。不藉刪除候選、放寬 noise、調高 scenario ratchet 或調低 coverage floor 取得速度數字；遵守 `AGENTS.md` 與 `docs/ARCHITECTURE.md` §十。
4. 每項優化比較同一批輸入、相同核心與記憶體設定，保留完整耗時、輸出／來源差異與可再現 artifact。透明度模型的樣本順序依賴已在 `docs/PERFORMANCE-FLOATING.md` 記錄，改排程或並行前需處理或驗證這項限制。

`report.zh-TW.md` 與 `方案與驗證.md` 是較早的設計／PoC 背景，內文已有各自基準及證據範圍。`docs/PERFORMANCE-FLOATING.md` 的 17.4% 是未提交版本內部的前後比較；本文件的 16.83 倍才是相對上述 HEAD 的完整批次結果。

## 實錄

| 輸入    | HEAD 秒 | 未提交 秒 | 耗時倍率 | 新來源階段 秒 | 新來源占比 | 狀態 HEAD / 未提交  |
| ------- | ------: | --------: | -------: | ------------: | ---------: | ------------------- |
| 0.mov   |    9.90 |     65.37 |    6.61× |         53.03 |      81.1% | complete / complete |
| 0-1.mov |   15.42 |    127.40 |    8.26× |        111.73 |      87.7% | complete / complete |
| a.mov   |   75.72 |   1795.95 |   23.72× |       1702.82 |      94.8% | complete / complete |
| b.mov   |   36.90 |    331.64 |    8.99× |        293.06 |      88.4% | complete / complete |
| c.mov   |   21.55 |    149.02 |    6.91× |        124.58 |      83.6% | complete / complete |
| d.mov   |   71.00 |   1539.60 |   21.69× |       1440.27 |      93.5% | complete / complete |
| e.mov   |   53.87 |    825.00 |   15.32× |        769.54 |      93.3% | complete / complete |
| f.mov   |   12.13 |    154.84 |   12.76× |        141.34 |      91.3% | complete / complete |

實錄總計：296.48 → 4988.83 秒，耗時 16.83×。

### 階段分解

render 欄包含新來源階段；source 欄是其中額外回放／分析／套用／索引的合計。

| 輸入    | scan HEAD→目前 秒 | solve HEAD→目前 秒 | render HEAD→目前 秒 | source 秒 | framing+pyramid HEAD→目前 秒 |
| ------- | ----------------: | -----------------: | ------------------: | --------: | ---------------------------: |
| 0.mov   |       2.42 → 2.27 |        4.96 → 7.51 |        2.24 → 55.29 |     53.03 |                  0.27 → 0.31 |
| 0-1.mov |       2.70 → 2.51 |        7.05 → 8.39 |       5.27 → 116.20 |    111.73 |                  0.40 → 0.30 |
| a.mov   |     21.40 → 21.44 |      23.22 → 27.56 |     28.60 → 1743.54 |   1702.82 |                  2.49 → 3.40 |
| b.mov   |       7.04 → 7.08 |        7.89 → 7.60 |      19.75 → 314.64 |    293.06 |                  2.21 → 2.33 |
| c.mov   |       3.57 → 3.59 |        3.78 → 3.87 |      12.93 → 140.16 |    124.58 |                  1.27 → 1.40 |
| d.mov   |     18.64 → 22.62 |      22.94 → 32.02 |     27.15 → 1482.47 |   1440.27 |                  2.27 → 2.48 |
| e.mov   |     15.08 → 15.17 |      18.31 → 18.87 |      17.40 → 787.72 |    769.54 |                  3.07 → 3.24 |
| f.mov   |       2.29 → 2.28 |        5.55 → 7.81 |       3.97 → 144.44 |    141.34 |                  0.33 → 0.32 |

### 儲存成本

`storage.usage` 是瀏覽器在重建結束後估計的 origin 儲存用量；不代表處理中的最高磁碟占用，也不代表 RAM。

| 輸入    | 保留儲存 HEAD→目前 MiB | 批次寫入 HEAD→目前 | 寫入累計 HEAD→目前 秒 | 分析候選數 |
| ------- | ---------------------: | -----------------: | --------------------: | ---------: |
| 0.mov   |           16.8 → 202.6 |        507 → 4,710 |           0.72 → 6.68 |  1,618,153 |
| 0-1.mov |           21.8 → 438.4 |      2,717 → 7,563 |          3.78 → 11.44 |  1,604,543 |
| a.mov   |          29.4 → 4269.4 |    4,490 → 221,118 |         5.06 → 288.37 | 28,321,855 |
| b.mov   |          29.9 → 1138.8 |     2,930 → 37,838 |          4.00 → 49.81 |  4,286,609 |
| c.mov   |           18.7 → 510.5 |     2,358 → 22,628 |          2.86 → 25.98 |  1,918,628 |
| d.mov   |          30.6 → 4585.7 |    5,323 → 201,768 |         5.03 → 256.87 | 23,076,047 |
| e.mov   |          38.9 → 1222.7 |    4,446 → 152,602 |          3.50 → 91.08 | 19,240,881 |
| f.mov   |           24.8 → 341.6 |     1,583 → 15,243 |          1.67 → 16.45 |  3,166,714 |

## 合成案例（三次中位數）

| 案例                                | HEAD 秒 | 未提交 秒 | 耗時倍率 | 來源階段 秒 | 狀態 HEAD / 未提交  |
| ----------------------------------- | ------: | --------: | -------: | ----------: | ------------------- |
| traversal                           |   1.253 |     3.140 |    2.51× |       1.054 | complete / complete |
| vertical                            |   1.331 |     1.726 |    1.30× |       0.000 | complete / complete |
| horizontal                          |   1.154 |     1.911 |    1.66× |       0.000 | complete / complete |
| diagonal                            |   1.209 |     1.690 |    1.40× |       0.000 | complete / complete |
| fling                               |   0.530 |     1.155 |    2.18× |       0.466 | complete / complete |
| revisit                             |   1.788 |     2.405 |    1.35× |       0.000 | complete / complete |
| panes                               |   1.104 |     1.585 |    1.44× |       0.000 | complete / complete |
| gap                                 |   1.347 |     2.167 |    1.61× |       0.000 | complete / complete |
| dynamic                             |   1.354 |     3.463 |    2.56× |       1.285 | complete / complete |
| lazy-load                           |   1.167 |     2.426 |    2.08× |       0.841 | complete / complete |
| zoom                                |   0.866 |     1.865 |    2.15× |       0.593 | complete / complete |
| blank                               |   0.528 |     0.789 |    1.49× |       0.000 | complete / complete |
| repeated-list                       |   2.220 |     3.158 |    1.42× |       0.000 | complete / complete |
| repeated-list-reversal              |   3.049 |     4.299 |    1.41× |       0.000 | complete / complete |
| comic                               |   1.393 |     1.536 |    1.10× |       0.000 | complete / complete |
| phone                               |   0.914 |     3.663 |    4.01× |       2.559 | complete / complete |
| vfr                                 |   0.642 |     1.415 |    2.20× |       0.515 | complete / complete |
| retina                              |   1.393 |     3.886 |    2.79× |       1.965 | complete / complete |
| factor4                             |   0.968 |     2.521 |    2.60× |       1.380 | complete / complete |
| geometry-change                     |   0.309 |     0.446 |    1.45× |       0.000 | partial / partial   |
| toolbar-collapse                    |   0.904 |     2.733 |    3.03× |       1.010 | complete / complete |
| chrome-everything                   |   1.323 |     3.703 |    2.80× |       1.861 | complete / complete |
| floating                            |   1.888 |     7.115 |    3.77× |       4.009 | complete / complete |
| glimpse                             |   0.506 |     0.642 |    1.27× |       0.000 | complete / complete |
| fixture                             |   0.221 |     0.444 |    2.01× |       0.147 | complete / complete |
| source/once-clean                   |   0.146 |     0.441 |    3.03× |       0.291 | complete / complete |
| source/once-clean-shared-background |   0.123 |     0.521 |    4.23× |       0.393 | complete / complete |
| source/long-pause                   |   0.179 |     0.702 |    3.93× |       0.522 | complete / complete |
| source/same-pose-disappearance      |   0.117 |     0.398 |    3.41× |       0.274 | complete / complete |
| source/following-page-overlay       |   0.142 |     0.445 |    3.12× |       0.299 | complete / complete |
| source/arriving-page-overlay        |   0.144 |     0.395 |    2.74× |       0.247 | complete / complete |
| source/moving-pointer               |   0.143 |     0.279 |    1.95× |       0.134 | complete / complete |
| source/translucent-scrollbar        |   0.144 |     0.223 |    1.54× |       0.079 | complete / complete |
| source/fading-scrollbar             |   0.147 |     0.224 |    1.52× |       0.079 | complete / complete |
| source/no-boundary-header           |   0.122 |     0.414 |    3.38× |       0.287 | complete / complete |
| source/partial-union                |   0.148 |     0.272 |    1.84× |       0.123 | complete / complete |
| dynamic-epochs                      |   0.148 |     0.226 |    1.53× |       0.080 | complete / complete |
| dynamic-partial                     |   0.158 |     0.312 |    1.97× |       0.151 | complete / complete |
| unpin                               |   0.531 |     1.336 |    2.52× |       0.568 | complete / complete |
| independent-panes                   |   0.385 |     0.829 |    2.15× |       0.360 | complete / complete |

逐案例中位數合計：32.14 → 66.90 秒，耗時 2.08×。

## 遠端重現

先準備基準提交的乾淨 checkout，並在兩份 checkout 各自執行 `deno task build`。例如將基準放在 `../long-screen-head`。在當地主機安裝 Google Chrome，以下以 `LONGSCREEN_CHANNEL=chrome` 選取；也可用 `LONGSCREEN_CHROME` 指定其執行檔。使用本分支的同一支 benchmark 腳本，分開指定兩個 root；輸出像素與證據本來就可能改變，應保存差異供審查。

```sh
deno task check
deno task lint
deno task test

# 原始錄影需另行取得，檔案 SHA-256 見 benchmark JSON。
LONGSCREEN_CHANNEL=chrome \
  deno run -A scripts/benchmark-pipeline.ts --input test_case/a.mov \
  --root ../long-screen-head --passes 1 --persistent --verify-tiles \
  --output test-results/remote-review/a/head

LONGSCREEN_CHANNEL=chrome \
  deno run -A scripts/benchmark-pipeline.ts --input test_case/a.mov \
  --root . --passes 1 --persistent --verify-tiles \
  --output test-results/remote-review/a/candidate

# 無實錄時，先以相同核心跑現有場景及來源反例；不能將缺素材算成實錄驗證通過。
deno test --allow-read --allow-write --allow-env tests/unit/scenarios-1.test.ts \
  tests/unit/scenarios-2.test.ts tests/unit/scenarios-3.test.ts \
  tests/unit/scenarios-4.test.ts tests/unit/source-resolution.test.ts
```

在不同硬體上應重建自身基準，使用同機 A/B 的倍率與輸出品質比較；本機的秒數不是跨主機性能承諾。完整 40 例的三次樣本與結果已入庫；本次額外量測的驅動程式留在本機 `test-results/head-performance-20260926/`。
