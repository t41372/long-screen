# floating 效能審查與實驗紀錄

2026-09-26。本次審查開始時的 HEAD 是 `63763e97b0b86aa200dd03fb24e0b58dc72cd168`；效能基線是當時完整的**未提交改動**，保存在 `test-results/performance-f/before-source.tar.gz`。另以乾淨 main 建立指紋，避免把先前的品質修復誤算成這次效能改動。所有程式改動仍未提交，沒有推送或部署。

測試用的是 `test_case/f.mov`，1876×1272、387 幀、7.392 秒、H.264。SHA-256：`d726dafca0b52aed28bd87cf1b5cdd00ae53ca1270ff8b4156a0da579a3de6a8`。完整的 Chrome 管線包含實際解碼、IndexedDB、原生 Wasm 核心及預覽；每次使用新的持久化 Chrome profile，128 MB 設定、640 分析長邊、8 個 helper threads。計時不含建置、PNG 匯出及輸出雜湊。測量期間沒有同時跑測試套件。

主要結論是延遲來源重建的資料量與反覆編解碼／儲存，而不是原本的配準忽然失速。基線來源回放、分析和套用合計約 178 秒，占全程 93%。它保留 3,166,714 個 16×16 原生候選，單趟遍歷就約 8.1 億個候選像素位置；後續還有可見性反證、透明度與共同 epoch。這些品質判斷有實際作用，不能透過丟掉候選或放寬判斷門檻來取得漂亮數字。

基線 CPU profile 中，候選選擇 `BlockAnalysis::feed` 的 self time 約 18.8 秒，LZ4 壓縮 10.9 秒、解壓 8.8 秒，逐元素的可見性 enum 解析 9.7 秒，連通背景判斷 9.5 秒。這些是取樣值；inclusive time 彼此重疊，不能相加成全程。原本的 scan 與 solve 合計約 10 秒，所以繼續優化特徵或改用 GPU 灰階轉換不會解決主要問題。新的來源域大部分工作仍是序列執行；現有 helper pool 明確禁止 chunk 內配置記憶體，不能直接把會配置 Vec／BTreeMap 的來源函式塞進去。

實驗按假說逐項進行：

| 假說                                                               | 實測及取捨                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同一份候選在標註後立即重新解碼，且未改變的透明度頁仍重新壓縮和寫入 | 改成使用 Rust 中已解析的候選，未分類新像素的頁保留原始 bytes；保留 epoch options 和完整來源選擇。                                                                                                                    |
| 可見性 enum 逐像素反序列化成本過高                                 | 經測試確認 Postcard 的既有 unit-variant tags 都是一個 byte，以 serde_bytes 批次讀取並驗證 tags；保留版本、原始檔案 bytes 和 JSON 名稱，不新增 codec。預先按已知長度配置結果，避免 fallible iterator 收集時多次擴容。 |
| spill 已釋放足夠空間後，不必立即淘汰熱候選                         | 小型重現由 12 次讀取降至 2 次，但 f 的狀態寫回反而略增；撤回這項實驗及專用測試。                                                                                                                                     |
| 回放工作集略超過原本的候選快取配額，造成反覆淘汰與載入             | 輸出 tile cache 已在回放前清空，候選階段可使用與後續模型學習相同的 70% 預算，上限 96 MiB；原本是 45%、上限 64 MiB。預算設定仍為 128 MB。保留此調整，但明確接受下列 Wasm 高水位增加。                                 |

前兩項加上後來撤回的 spill 實驗，f 只降到 185.90 秒，約改善 3%；這不是足以解決問題的結果。重新分配階段配額後先測得 161.41 秒；最終版本的結果如下。

| 指標               | 原始未提交版本   | 最終版本   |
| ------------------ | ---------------- | ---------- |
| 完整管線           | 191.65、186.39 s | 156.15 s   |
| 來源回放           | 58.04 s          | 42.84 s    |
| 來源分析           | 115.05 s         | 95.70 s    |
| 套用結果           | 4.93 s           | 4.17 s     |
| 狀態寫回           | 14,742           | 7,428      |
| 候選封存頁         | 13,383           | 6,739      |
| IndexedDB 寫入耗時 | 23.87 s          | 16.18 s    |
| Wasm 高水位        | 202.31 MiB       | 223.19 MiB |

對兩次原始版本的中位數 189.02 秒，最終耗時縮短 **17.4%**。這是本機 f 的全管線結果；最終版本只計時一次，前一輪 161.41 秒使用尚未改善 Vec 預先配置的版本，不混成最終版的中位數。較大快取減少儲存工作，也增加部分常駐記憶體；這不是免費的加速。Wasm 高水位不等於整個瀏覽器 RSS，128 MB 設定原本也不是程序記憶體硬上限。

品質驗證保留了原有門檻。25 個合成場景的最終瓦片、來源歸屬、幾何、診斷與回傳 project 都一致；總共 20 筆 persisted-row 指紋不同：floating 的 5 個 shard 改變分頁邊界、3 份透明度模型的樣本紀錄改變，以及來源統計／Wasm 高水位。`fingerprint-explanations.json` 列出每一筆差異及原因。沒有降低任何 scenario ratchet 或 coverage floor。乾淨 main 對最終版本的完整差異另存於 `main-to-final.json`；其中原有的一致性、合成與來源域差異來自開始時已存在的品質修復，新增效能改動則以這份開始快照逐項對照。

實錄 f 的 1876×13814 長圖只有兩個像素改變，不能說逐位元組相同。它們都更接近錄影中的獨立原生觀測：

| 世界座標     | 原值 → 新值（灰階） | 排除懸浮 UI 後的錄影觀測                                                                         |
| ------------ | ------------------- | ------------------------------------------------------------------------------------------------ |
| (678, 1889)  | 12 → 44             | 幀 83–122、不同原生位姿，主要為 42–46；新值誤差大多 0–3，舊值 29–42。                            |
| (1520, 5927) | 44 → 253            | 幀 162–166、5 個不同位姿，為 255、238、251、237、253；新值與多個獨立觀測一致，舊值誤差 193–211。 |

`audit-changed-pixels.py` 使用 ffprobe 讀取原尺寸，ffmpeg 使用 `-fps_mode passthrough` 保留 VFR 幀序；採用最終 canonical placement，排除 f 中已知浮窗／陰影所在的畫面區域，只使用原生 y∈[30,980) 的觀測。這是對這兩個變更像素的獨立佐證，不是聲稱整張實錄都有 ground truth。所有幀的實際色值與位置都在 `budget-pixel-audit.json`；最終輸出另與這輪結果核對。

完成的檢查：

- `deno task test`：137 個 Rust 測試、363 個 Deno 測試通過。
- `LONGSCREEN_CORE=scalar` 與 `LONGSCREEN_CORE=threads`：parity、sources、source-resolution、core-memory 各 68 個測試通過；預設 SIMD 已由完整套件覆蓋。
- `deno task check`、`deno task lint`、`deno task fmt` 通過。
- Chrome 和 WebKit 的 reconstruction／export capability 測試各一個通過；f 的端到端效能與 PNG 匯出在 Chrome 驗證。
- 完整瀏覽器套件沒有重跑；文件中那兩個已知 WebKit 失敗不在這次篩選內，也不把它們標成通過。沒有測 iPhone 或宣稱 d/e 的提速比例。

重現主要結果：

```sh
deno run -A scripts/benchmark-pipeline.ts --input test_case/f.mov --persistent --verify-tiles --export-canvases --output test-results/performance-f/recheck
deno run -A scripts/fingerprint-scenarios.ts test-results/performance-f/recheck-fingerprint.json
deno run -A scripts/compare-fingerprints.ts test-results/performance-f/before-fingerprint.json test-results/performance-f/recheck-fingerprint.json
python3 test-results/performance-f/audit-changed-pixels.py
```

指紋比較預期回報上述封存／統計差異，不能只以 exit code 判斷品質。基線快照可解到獨立目錄、執行 `deno task build:core` 後，使用 benchmark 的 `--root` 重現；本次額外的 `benchmark-preserved.ts` 僅讓建置使用保存的三份 Wasm，避免基線重測時重新編譯。原始 JSON、分段 CPU profiles、PNG、來源資料、指紋和測試 logs 都在 `test-results/performance-f/`，`validation.json` 整理了指令與結果。

仍需另案處理的是透明度模型對樣本順序的依賴。較大快取改變頁界，跨區塊樣本合併順序隨之改變；`PixelModel::observe` 會保留先到的支持樣本，因而讓只改快取大小也能改變少量像素。本次兩處變化都改善，合成真值也沒有退步，但未來若要進一步改排程或並行，應先讓每個模型的訓練順序由來源座標／幀號決定，而不是由磁碟分頁決定。這個現象已由 f 重現，不是臆測的異常輸入防禦；本次沒有順便重寫模型。

來源分析仍然占主要時間。下一步值得研究的是保留每個區塊候選順序的計算批次與更長的原生資料生命週期，再量測收益；不能把目前的啟發式品質流程簡單關掉，也沒有足夠證據承諾回到十多秒。現有 f 仍有 225 幀觸及物體追蹤上限的診斷，這次沒有移除或掩蓋它。
