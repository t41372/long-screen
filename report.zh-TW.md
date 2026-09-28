# Long Screen：核心演算法深度審查與驗證報告

**固定提交：`962e4eaee7cd6f8eacdf2d15558b4b8d0389c257`**\
**日期：2026-09-24，America/Phoenix**\
**交付性質：原始碼審查＋獨立演算法 PoC＋原始測量；不是已套入專案的修補版。**

## 1. 結論與證據邊界

目前的 long-screen 已經是「分層、配準、回環校正、來源所有權合成」的重建系統，不是逐幀貼圖。Rust/Wasm、SIMD、多執行緒、WebGPU 灰階降採樣、native-pixel refinement、磁碟化多 pass 流程都已存在。把這些再次列成未來優化，會誤判目前程式的成熟度。[S1][S4][S7][S8][S9]

本次保留四項有正面實驗證據的變更。其中只有「逐列張量」能作為優先的純效率優化；另外三項是有適用範圍及成本的準確性／品質修正。

| 順序    | 修改位置與方向                                                               | 已證實的收益                                                             | 不能據此宣稱的事                                             |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| P1      | `features.rs`：全幅積分張量改為逐列張量                                      | 特徵輸出 parity；480×270 的該類中間緩衝需求下降約 96%；C/Wasm 子流程變快 | 不能把暫存需求當 RSS；不能把 kernel 倍率當影片整體倍率       |
| P1      | `track/odometry.rs`：移除 failed-registration fallback 的固定 7 像素網格盲點 | 21 組局部反例及 8 組帶特徵門檻反例，由錯判 Static 改為 Lost              | 不是所有畫面變化都能偵測；不是追蹤／分層整體成功率           |
| P1 品質 | `compositor.rs`：清晰度改為 RGB、雙軸                                        | 六種通道／方向案例，正確選擇清晰區塊由 1/6 變 6/6                        | 不是一般錄影 MSE 改善率；評分子核心反而較慢                  |
| P2 受限 | `pose_graph.rs`／`pose-graph.ts`：單鏈單回環解析解                           | 正式弱邊權重 0.05 下，目標函數與特定真值誤差改善；獨立 oracle 通過       | 不是一般圖求解器；不能救錯誤回環，也不保證每種真值誤差都變小 |

### 實際做了什麼

審查以 GitHub 固定 commit 的原始碼為準；四項 PoC 的 baseline 是依該程式重述的核心，不是另一個任意較慢演算法。特徵與清晰度重述成 C 並編譯為 WebAssembly；位姿與 fallback 重述成 JavaScript。特徵另有不依賴積分圖／逐列演算法的九點直接計算 oracle，位姿另有密集線性求解 oracle。

**實測環境：** Linux x86_64、Intel Xeon Platinum 8573C、5 個可見邏輯 CPU；Node 22.16.0；Chromium 144.0.7559.96；clang 17.0.0。Node 和 Chromium 同屬 V8 家族，不能當成兩種獨立 JS 引擎的跨引擎證明。

**未完成的驗證：** 此環境沒有 Rust/Deno toolchain，無法編譯、執行上游原專案；亦未跑原專案的錄影解碼→scan→solve→render→PNG 流程。沒有 Mac、iPhone、Windows、Safari、Firefox 實機，沒有 GPU 吞吐、實機電力或全流程 CPU/GPU 利用率測量。遠端工具沒有連線中的設備。這些部分只有原始碼與官方平台文件評估，不標成「通過」。

受管環境拒絕 localhost 導航，所以 Chromium 實驗使用 `about:blank` 的本機記憶體內函式／Wasm 評估；沒有繞過管理政策。它不包含 HTTP 載入、Worker、解碼、儲存、安全來源 API。附帶的 `browser.html`／Worker 是重測入口，這個入口本身未在此環境完成執行。

### 計時規則

輸入建構在計時外；暖機後，以 AB／BA 交替順序測 15 批次，取每次呼叫耗時的批次中位數。對每個函式獨立校準批量，使校準批次至少約 4 ms，以降低瀏覽器時鐘量化的影響；批量與全部樣本保存在 JSON。微基準是重複同一輸入的 warmed-throughput，不代表每次換新影片幀的冷快取成本。

此主機不是專用隔離效能實驗機，批次間仍有波動，沒有聲稱小幅變化都具統計顯著性。特別是 C 與 Rust 的配置器、界限檢查、LLVM 輸出與 JS↔Wasm 邊界不同；C/Wasm 的速度結果是方法可行性證據，不是原 Rust 實測數字。

## 2. 現有核心：哪些設計是對的，哪些限制仍在

### 2.1 系統不是只有一個配準函式

目前流程大致是：

```text
錄影解碼
  → 分析尺寸影像、特徵及全域運動／區域資訊
  → 每區域位移假設、局部 audit、原生像素精修
  → 失追處理、重定位、關鍵幀、回環／位姿校正
  → 依校正座標重播觀測、區塊品質／衝突／所有權合成
  → 分頁輸出與專案儲存
```

粗解析度提出候選、原生解析度做最終驗證，比直接把低解析度位移乘回去更合理。分層與固定 frame 的 presentation 處理，也避免把整個錄影當成同一剛性平面。保留可追溯來源及未解片段，是品質優先系統的重要優點。[S1][S4][S10][S12]

### 2.2 特徵與候選：節省了搜尋，但候選缺失無法靠後處理補回

`features.rs` 使用平滑、Shi–Tomasi 角點分數、28 像素 cell、每 cell 最多三點、全域上限 480 點，再做 BRIEF 與 Hamming matching。`motion.rs` 用位移投票、多候選、區塊一致性及原生精修降低誤匹配。[S3][S4]

這是一個清楚的速度／可觀測性取捨：重複紋理、局部細節、只有很薄重疊或低紋理區域，都可能使真實位移沒有進入候選集合。速度 prior、更多合成規則或更精確的 pose solver，不能在沒有正確觀測的情況下創造正確位移。

本次沒有把改描述子、增加特徵數或改成另一種 matcher 列為有效方案：沒有相應真值實驗就無法知道是找回匹配，還是只是增加歧義與成本。

### 2.3 「confidence 高」不等於有校準的正確機率

程式的 confidence、error、agreement 與 rival gates 是啟發式品質指標。專案能力文件亦明確區別這些分數與機率。重複文字／週期圖案可能在錯誤平移下仍有低誤差；一致的錯誤觀測甚至能讓 pose graph 自洽。[S2][S4]

因此不能用平均 confidence 升高來驗收準確性。需要看 native-pixel 真值、missing／invented／mismatched pixels、錯誤 fold、未放置片段與可恢復遮擋污染。這些指標已有部分存在於上游測試設計；本次沒有自行執行它們，也不把上游文件中的通過結果列為本次通過。[S2][S11]

### 2.4 原生像素與來源所有權，不等於位置一定對

合成器以完整區塊替換、覆蓋與 provisional bitset、來源 owner、衝突及 frozen 狀態做選擇，避免無條件 feather blending 把文字變糊。`compositor.rs` 也已具有 SIMD 比較與並行分區處理。[S8]

但這些能保證的主要是「如何採用觀測」，不是「採用的座標永遠正確」。若前面的錯位被接受，原生、未縮放、可追溯的像素仍可能放在錯的位置。清晰度分數若有方向／通道盲點，也會在兩張都可接受的觀測間選錯；第 5 節是本次實際重現的例子。

固定 frame 的外觀重建與內容覆蓋也應分開理解：`framing.rs` 區別來源內容和裝飾性延展。外框填色／延展不是多觀察到的新內容，不能計為內容重建 coverage。[S12]

### 2.5 已知能力邊界，不宣稱此次已解決

上游能力文件仍列有週期紋理 alias、可恢復 overlay 污染、縮放造成不同像素格的片段、動態 toolbar 與 virtualized/reflow 內容等限制；任意巢狀獨立移動區域也不是普遍保證。大型長影片及實體 iPhone/Safari 完整流程，不能從小型合成測試直接推論。[S2]

四項 PoC 不會把系統變成任意動態畫面都能唯一重建的工具。其價值是去除確定的局部缺陷、改善明確的數值問題，並減少不必要的計算及中間儲存。

### 2.6 計算複雜度與常駐狀態：尚不能當成實測瓶頸排序

| 階段                      | 從程式可判定的成本                            | 效率／擴展性含義                                                                          |
| ------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 灰階／降採樣              | 隨原生輸入像素數成長                          | 即使分析圖很小，前面的 native decode／轉換成本仍在                                        |
| 角點評分                  | O(W×H)，舊版另有三張全幅 i64 tensor planes    | 本次唯一同時有輸出等價、scratch 降幅與 kernel 速度收益的熱路徑改動                        |
| BRIEF matching            | O(Fa×Fb×8) 個 32-bit descriptor words         | Fa=Fb=480 時，一次全面比較約處理 184 萬對 word；這不是 184 萬條實際機器指令或每幀固定成本 |
| translation voting／audit | 依 matches、不同位移桶與保留候選數成長        | 位移桶採線性查找時，很多離散 outlier 可提高成本；沒有 profiler 就不把它定為最大瓶頸       |
| native refinement         | 依候選數、有效 patch 點數與搜尋 offset 數成長 | 快速／薄重疊運動增加搜尋難度；提高分析解析度或搜尋半徑並不是免費補強                      |
| pose graph                | 每 pass 隨邊数成長，最多 200 pass             | 低更新量可能提早停止；CSR 建構和持久化不在純 solver 微基準內                              |
| 合成與輸出                | 依觸及的像素／區塊／tile 及 IO 成長           | 品質子評分增加少量單次成本，乘上大量區塊後仍需驗收                                        |

上表來自原始碼的迴圈與資料結構，不是 profile 百分比。[S3][S4][S6][S8][S9] 其中位移桶、matching 或 native 搜尋並沒有本次驗證過的替換方案，因此不把它們列為「改了就會變快」。

另一个常駐記憶體邊界是 `PoseGraph.hydrate()`：它把節點及邊讀入記憶體 Map，優化時還會建立 CSR arrays；磁碟持久化不代表活動圖的 RAM 是固定上限。圖狀態至少隨 V+E 成長，建立 number arrays 再轉 typed arrays 也有暫時重疊。這是與 tile LRU 不同的記憶體來源；本次沒有大影片 RSS 實測，不能用 tensor scratch 的節省量抵銷或掩蓋它。[S6]

## 3. P1 效率：以逐列張量取代三張全幅 64-bit 積分圖

**原始位置：** `rust/core/src/features.rs`。[S3]\
**PoC：** `tensors.c`、`features.mjs`、`oracle.mjs`。

### 問題與改動

原碼為 `gx²`、`gy²`、`gx·gy` 各建立一張 `(W+1)×(H+1)` 的 64-bit 積分圖；但角點評分只查固定 3×3 視窗。任意尺寸方框查詢的通用能力，在這個固定視窗上用不到。

候選保留原來的 blur、角點公式、cell／margin／門檻、抑制半徑與穩定排序，只替換張量計算：先算每列三像素的水平和，以三列環形緩衝取得 3×3 的張量，再用 28 列 score band 維持原有的逐 cell NMS 順序。

```text
tensor_xx = box3x3(gx*gx)
tensor_yy = box3x3(gy*gy)
tensor_xy = box3x3(gx*gy)
score = (xx + yy - sqrt((xx-yy)^2 + 4*xy^2)) / 2
```

8-bit 灰階的 `|gx|、|gy| ≤ 255`；3×3 和的絕對值上限為 `9×255² = 585225`，因此局部張量可以用 signed 32-bit。進入平方、開根號等 score 計算之前轉為 f64，不能在 i32 裡先平方。

### 記憶體收益是什麼

舊的三個 tensor planes 需要 `24×(W+1)×(H+1)` bytes；PoC 新的 ring＋score band 需要 `260×W` bytes。480×270 時是 **3,128,424 → 124,800 bytes，減少 96.0%**。

這是所需中間配置量的算術比較，不是量得的 RSS；原圖、平滑圖、候選與描述子沒有因此消失。PoC 為了公平交替計時，在同一 arena 同時保留兩種 scratch，故實際 process RSS 甚至不會隨兩種呼叫切換而下降。舊側未計入小型 cell local buffer，這個比較沒有透過省略新 score band 誇大收益。

### 正確性驗證

每種 scalar / SIMD-enabled 建置各 180 個 parity 檢查：包含小於 descriptor margin 的影像、奇數尺寸、文字／噪聲／棋盤／常數影像、整數與小數 ROI，以及 48 個額外隨機種子的未排序候選順序。比較的不只是點數，還包括座標、score、排序／截斷後的 BRIEF 描述子。

另有 24 個獨立 oracle 案例直接對九個梯度取和，不走積分圖或 ring。Node 與 Chromium 都通過。這比只把同一個函式改名當 oracle 更有意義，但仍不是與上游 Rust 二進位直接逐位元比對。

### 時間實測：480×270

以下時間單位為 ms，範圍只含 **blur＋張量建立＋評分＋每 cell NMS**，不含 JS 全域排序、BRIEF、matching、解碼或完整追蹤。

| 環境     | 建置   | 內容  | Baseline ms | Candidate ms | 速度倍率 |
| -------- | ------ | ----- | ----------- | ------------ | -------- |
| Node     | scalar | noise | 2.2278      | 1.9149       | 1.16×    |
| Node     | scalar | text  | 2.3023      | 1.8939       | 1.22×    |
| Node     | simd   | noise | 2.3625      | 1.6610       | 1.42×    |
| Node     | simd   | text  | 3.6698      | 2.8559       | 1.28×    |
| Chromium | scalar | noise | 2.3875      | 2.0750       | 1.15×    |
| Chromium | scalar | text  | 2.3750      | 2.0000       | 1.19×    |
| Chromium | simd   | noise | 2.3625      | 1.8125       | 1.30×    |
| Chromium | simd   | text  | 2.2375      | 1.6625       | 1.35×    |

全部尺寸／內容的 48 筆環境×建置×工作負載中位數在附錄 A；不是只保留最好的個案。小幅收益及主機波動應和完整樣本一起看。採用 SIMD-enabled 建置不表示此函式的每一個迴圈都一定被向量化。

### 如何放回上游

在 Rust 特徵核心裡替換 tensor scratch，維持現有 ABI；保留 28-row score band 以避免順序改變造成相同分數角點換人。scalar、SIMD、threads 三種上游建置的輸出都要和改前 Rust 比對。NMS tie-breaking、`score > 100`、margin、descriptor 取樣與 sorting 的既有語義不能順手改掉。

這是最值得先合併的 PoC，但不能把約 1.3 倍 kernel 加速換算成影片也快 30%。若它佔總時間比例為 p、其速度倍率為 s，理論總倍率只有 `1 / ((1-p) + p/s)`；p 在本次沒有量到。

## 4. P1 準確性：修掉 failed-registration fallback 的固定網格盲點

**原始位置：** `rust/core/src/track/odometry.rs`；上游 gate 位於 `src/pipeline/solve/track.ts`。[S5][S13]\
**PoC：** `fallback.mjs`、`fallback-reach.mjs`。

### 可重現的錯誤

在沒有可信位移候選時，原碼每隔 7 像素取一點，計算目前與上一影格的灰階差；平均差不大於 5，就回傳 Static。抽樣位置是固定的，並非可涵蓋所有相位的判斷。

只要所有舊抽樣點相同，格子之間如何變化都會被忽略。ROI 有 mask 且有效抽樣數為零時，原來的除數保護亦可讓結果變成 Static，而不是「沒有足夠觀測」。

21 組不同尺寸／7 種相位的反例驗證了局部分支。為避免只用「完全無角點、會先被 blind gate 擋掉」的例子，又加了 8 組 240×160 影像：前後各有 120 個擷取特徵，保留每個舊抽樣點相同，但其它像素獨立變化。候選匹配沒有可達至少四個 support 的一致位移，因此通過 textured 門檻也不能取得可接受的 motion model；舊分支仍回 Static，新分支回 Lost。

對這些 8 組，舊法檢查 805 點、差異為零；新法在掃過 2400 像素後已可保守確定 Lost。這是「前置特徵門檻＋matching 必要條件＋fallback」的重述驗證，仍不是完整 scan／solve／render 的重跑。

### 實作方式

只改失敗後的 fallback：逐像素掃分析尺寸 ROI，維持目前的 region-membership 篩選及平均差門檻 5。若沒有有效樣本，回 Lost。原生像素映射與合法 ROI 範圍沿用既有呼叫約束，不另改座標定義。

為避免每個明顯變動畫面都掃到底，使用可證明安全的單方向提早結束：設 ROI 最多可能有 M 個像素，累積絕對差為 D。一旦 `D > 5×M`，後續差值非負，而實際有效樣本數至多 M，故完整平均差必定大於 5，可以立即回 Lost。反向不成立：不能因目前差值小就提早宣告 Static。

這保留完整掃描的判斷，不是用另一套抽樣猜測取代原抽樣。PoC 與完整逐像素 oracle 對照的 500 組隨機、小數 ROI、mask 案例全數一致；180 組靜止／小噪聲控制保留 Static，空 mask 另有 guard。

### 成本：這不是速度優化

時間單位為 ms。`changed` 為整體明顯變化，可早停；`static` 須完整檢查。

| 環境     | 分析尺寸 | 工作負載 | 舊網格 ms | 完整語義／早停 ms |
| -------- | -------- | -------- | --------- | ----------------- |
| Node     | 480×270  | changed  | 0.0082    | 0.0207            |
| Node     | 480×270  | static   | 0.0080    | 0.3656            |
| Node     | 960×540  | changed  | 0.0351    | 0.0830            |
| Node     | 960×540  | static   | 0.0512    | 2.0661            |
| Chromium | 480×270  | changed  | 0.0110    | 0.0275            |
| Chromium | 480×270  | static   | 0.0102    | 0.4467            |
| Chromium | 960×540  | changed  | 0.0383    | 0.1000            |
| Chromium | 960×540  | static   | 0.0458    | 3.1000            |

因此這是一個以較多計算換取可靠度的修正。它位於失配 fallback，而不是每個成功追蹤影格強制多掃一次。但若影片頻繁進入 fallback，或分析尺寸很大，成本可能累積；不能把每次呼叫看似小於一毫秒就說成「免費」。

### 效果邊界

它消除固定 7 像素網格導致的漏看，以及無樣本仍判靜止的問題；沒有改變全域平均門檻。很小的局部變化、灰階等亮度的色彩變化，仍可能低於門檻。Lost 也不是解出真實位移，後續仍應按既有失追、重定位／片段與 warning 機制處理，不能硬把 Lost 改成隨機位移。

## 5. P1 品質：清晰度分數不能只看紅色、只看水平方向

**原始位置：** `rust/core/src/compositor.rs`。[S8]\
**PoC：** `sharpness.c`、`sharpness.mjs`。

### 根因與反例

目前 sharpness 子項取紅色通道的水平方向中央差分，再乘 0.15、上限 12，加入區塊品質分數。因此只有綠／藍通道上的細節，或主要沿垂直方向變化的細節，可能完全不提供 sharpness 加分。

PoC 構造 R／G／B 三個通道乘 x／y 兩個變化方向，共六類 16×16 完整區塊。先存入該通道 75 的模糊觀測，再輸入 0／150、每兩像素一帶的清晰觀測；兩者 confidence 一樣為 0.9，edge bonus 相同。每像素 RGB 平均絕對差恰為 25，不會觸發原來嚴格 `>25` 的 mismatch 門檻；因此測到的是「相容觀測中的品質選擇」，不是繞過衝突保護。

舊法僅 R/x 類別選清晰觀測，其餘五類保留模糊觀測；新法六類都選對。以明確指定的清晰觀測為真值，五個失敗案例的區塊 RGB MSE 為 **1875 → 0**。

### 候選分數

每個像素取六種梯度絕對值的最大值：

```text
g = max(abs(dxR), abs(dyR), abs(dxG), abs(dyG), abs(dxB), abs(dyB))
sharpnessBonus = min(12, mean(g) * 0.15)
```

用最大值而非六項直接相加，使每像素仍在 0…255，保留舊分數量級。保留完整覆蓋、conflict、frozen、confidence／edge score、`newScore > oldScore + 4` 等所有替換門檻。不能為了讓新分數看起來有效就把其它保護關掉。

12 組反向順序控制（先清晰、後模糊）、120 組小幅噪聲控制與四個邊界案例通過。小噪聲測試只涵蓋 ±2，沒有聲稱強烈 chroma noise 或所有動態內容都不會騙過這個度量。

### 成本與取捨

下表是每 16×16 區塊的 **評分子核心**，單位為 µs；不含整個 compositor。

| 環境     | 建置   | 舊評分 µs | 新評分 µs | 成本比    |
| -------- | ------ | --------- | --------- | --------- |
| Node     | scalar | 0.4948    | 2.3182    | 4.68×成本 |
| Node     | simd   | 0.4555    | 2.5465    | 5.59×成本 |
| Chromium | scalar | 0.3000    | 1.6750    | 5.58×成本 |
| Chromium | simd   | 0.2812    | 1.4750    | 5.24×成本 |

新分數明顯增加成本。這項應以品質修正的身份採用，不應宣傳為加速。它是否值得在所有影像上預設啟用，需要上游實片的品質／耗時回歸；本次確認的是方向與通道盲點被消除，不是一般影片一定更清楚。

### 放回專案時不可忽略的狀態問題

已持久化的區塊分數可能使用舊定義；舊圖的 score 不能直接當成新定義下可比較的分數。整合時需明確區分評分版本，或在新規則下從觀測重算／重繪，不能只是把新函式換進去後繼續比較舊 score。PoC 使用同一評分規則評估同一組前後觀測，沒有假裝完成舊專案資料遷移。

## 6. P2 數值品質：單鏈單回環的受限解析求解

**原始位置：** `rust/core/src/pose_graph.rs`、`src/core/pose-graph.ts`、`rust/core/src/track/verdicts.rs`。[S6][S14]\
**PoC：** `pose.mjs`、`pose-guard.mjs`。

### 問題不是「沒有回環初始化」

原碼已按真實 odometry chain 的 next 指標分攤 closure error，不是完全從未校正的位置做盲目迭代；這是重要的既有改良。之後採前後交替 Gauss–Seidel、Huber 閾值 6、最多 200 pass，以單 pass 最大節點改變量小於 0.04 作為停止條件。

但小更新量不代表已達到加權目標最小值。尤其 closure seed 依 frame 比例分攤，而弱邊應比可靠邊吸收更多殘差，初值不一定符合加權解。上游 `odometry_weight(true)` 是 **0.05**，一般為 1。報告數字使用這個正式權重，不使用更極端、非目前正常呼叫規則的微小權重來誇大改善。

### 僅在已驗證的拓撲上採用

候選只接受：整張待解圖為一條連通 odometry chain、一個 pinned root、恰好一條 root-to-last loop、正且有限的權重和有效位移。分叉、多回環、多 anchor、缺節點、額外邊、非有限值等一律拒絕，交回原 solver。

設第 i 條 odometry 邊量測為 `d_i`、權重為 `w_i`；loop 量測為 `d_L`、權重為 `w_L`：

```text
C = d_L - sum(d_i)
S = 1/w_L + sum(1/w_i)
epsilon_i = C / (w_i*S)
x_(i+1) = x_i + d_i + epsilon_i
loop_residual = -C / (w_L*S)
```

x/y 共用 S，各自計算 C。求解後檢查所有 **二維殘差範數**都不超過 6；此時整個解在 Huber 的二次區間內，WLS 解也是該凸 Huber 目標的最優解。超過閾值就退回原 solver，不能把本公式擴張為一般 robust 圖求解器。

### 正式權重的真值案例

以下 n 是 odometry 邊數，節點數為 n+1。真值是往返平移鏈，量測在一條弱邊多了 2 像素誤差，loop 量測正確；其它權重為 1，loop 權重為 5。初始位置沿用上游式 closure seed。

| n 條邊 | 舊 pass 數 | 舊最大真值誤差 px | 新最大真值誤差 px | 真值誤差下降 | 加權目標下降 |
| ------ | ---------- | ----------------- | ----------------- | ------------ | ------------ |
| 16     | 6          | 0.8666            | 0.5227            | 39.7%        | 27.3%        |
| 32     | 2          | 1.0370            | 0.7109            | 31.4%        | 28.3%        |
| 64     | 1          | 1.1293            | 0.8942            | 20.8%        | 19.0%        |
| 1024   | 1          | 1.1565            | 1.1373            | 1.7%         | 1.5%         |

n=64 時，最大節點真值誤差為 **1.1293 → 0.8942 px**；n=1024 時只從 **1.1565 → 1.1373 px**。長鏈下仍可能有約一像素的真值偏差，因為求解器只能按現有權重最小化目標，並不知道哪條量測真的錯。

必須補充兩個容易誤讀的地方。第一，新解可以讓低權重邊的最大未加權殘差變大，同時總加權目標變小，這不矛盾。第二，權重全部為 1 的控制組裡，目標仍改善，但最大真值誤差可略增；**目標最優不等於每個真值指標最優**。這個控制組沒有隱藏，保存在原始 JSON。

### 數值驗證與效率範圍

100 個小型鏈與獨立密集 Gaussian elimination oracle 對照通過；80 個 2D 案例的 normal-equation residual 小於 1e-9，實测最大約 3.9e-14；12 類不符條件的輸入正確拒絕。

`pose.mjs` 的時間是 1D 純求解核心比較，baseline 從預先算好的上游式 seed 複製後迭代；seed 建構不在計時裡。候選為解析解。這些核心微基準有速度收益，但 **沒有包含 2D admission／圖遍歷／CSR／IndexedDB／checkpoint 成本**，因此不把它宣稱為 pose graph 端到端加速。

整合只在上述整張圖符合條件時，在 `optimize()` 中走 fast path；保留既有 connect 初始化、一般 solver、輸出回寫與 correction 插值語義。把它擴展至多 component、多回環或一般 sparse solver，不在本次已驗證方案範圍內。

## 7. 硬體利用率：依現有程式做判讀，沒有虛構裝置數字

### 7.1 為什麼「CPU 忙、GPU 不忙」不能直接判為 bug

`compute.ts` 的 WebGPU 工作主要是灰階降採樣，不是整條配準與合成流程。程式已校準 CPU 和 GPU 的完整 upload／dispatch／readback 時間，並有首次正確性比較、損失／錯誤 fallback、buffer 重用，以及 resident buffer 上傳路徑。未達到設定收益門檻就回 CPU，是合理的既有策略。[S7]

因此在特徵、matching、原生 patch refinement、pose graph 或 IO 比較重時，GPU 使用率不高並不意外。要評估是否利用好硬體，應看完成相同品質重建所需的時間、峰值記憶體與能量，不是把所有單元推到 100%。本次沒有實機 GPU／能量 profiler，無法把這段原始碼分析換算成確定的利用率缺口。

### 7.2 多執行緒也已存在

Rust pool 與 raster／compositor 中的平行工作切分已經存在；某些 raster 和區塊比較路徑也已有顯式 SIMD。caller 等待 helper 完成時含 busy-spin，所以 CPU 顯示忙碌可能包含等待，而不全是有效像素計算。這是程式行為的判讀，不是本次量出的浪費功率。[S8][S9]

本報告沒有把一個未證實更快、更省電的排程改寫列作有效方案。四項保留 PoC 都不要求新增 SharedArrayBuffer、更多 Worker 或 GPU API，所以可以在現有 scalar fallback 上整合，再按原有建置能力使用 SIMD／threads。

### 7.3 解碼和記憶體預算不可漏算

`source.ts` 會檢查實際 codec config，處理解碼背壓與輸出幾何，對不支持或途中尺寸改變採明確路徑。多 pass 架構的 decode／轉換／磁碟成本不是 tensor kernel 微基準能代表的。[S1][S10]

WebCodecs 的 `hardwareAcceleration` 只是 hint，不是硬體解碼保證；config 支援度與實際裝置、codec 有關。只把選項改成 prefer-hardware，不能當作已驗證的效能優化。[W2]

同理，tile/cache 的軟體預算不是瀏覽器整體 RSS：decoded frames、Wasm heap 高水位、GPU buffer、Canvas 與暫存資源都可能在預算之外。上游能力文件也有這個區別。[S2] 本次 tensor 改動可確定減少該類 scratch 的必要配置量，卻沒有證明手機 peak RSS 或 OOM 率降低多少。

## 8. Mac、iPhone、Windows、Linux 的相容性評估

四項候選的共同選擇是：維持 CPU／Wasm 可執行路徑，不新增必備的 GPU 或共享記憶體能力。這能減少平台依賴，但不等於未測試的平台已通過。

| 目標                  | 本次實測                     | 整合時需特別核對的邊界                                                           |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| Mac Safari            | 無實機                       | 上游 scalar/SIMD parity、實際 codec／VideoFrame 轉換、長影片記憶體、安全來源功能 |
| Mac Chrome            | 無實機                       | 不能把 Linux Chromium 的 x86 數字外推到 Apple Silicon；CPU/GPU 校準保留          |
| Mac Firefox           | 無實機                       | 以實際 API/config 探測為準，不按瀏覽器名稱假定 GPU、codec 和共享記憶體           |
| iPhone Safari         | 無實機                       | HTTPS 部署、實際編解碼、峰值記憶體、長流程與生命週期；不能用桌面 WebKit 代替驗收 |
| iPhone Chrome         | 無實機                       | 手機瀏覽器品牌不等於桌面 Chrome 能力，需測實際安裝版本／引擎／API                |
| iPhone Firefox        | 無實機                       | 同樣不能外推桌面 Firefox；純 kernel 通過不代表可以載入、解碼與輸出 App           |
| Windows Chrome        | 無實機                       | codec／GPU adapter／driver、安全來源；純 CPU 候選不依賴新增 GPU 功能             |
| Windows Firefox       | 無實機                       | 原有 scalar/SIMD fallback、codec 與儲存路徑實測                                  |
| Linux Chrome/Chromium | Chromium 144：僅本機 kernels | 不包含原 App、GPU、threads、Worker、解碼與 IO；也不能當成所有 Linux 配置通過     |
| Linux Firefox         | 無實機                       | 本次沒有 SpiderMonkey 的 parity 或計時證據                                       |

WebGPU 仍需檢查安全來源、實際 adapter/device 能否取得以及特徵／限制；僅存在 `navigator.gpu` 不代表可執行或較快。[W1] 可跨 Worker 分享的 SharedArrayBuffer／shared Wasm memory 亦有安全來源與 cross-origin isolation 條件，不能把缺少 threads 當成演算法本身失敗。[W3]

iOS 也不能不加條件地寫成「任何地方所有第三方瀏覽器永遠同一引擎」：Apple 已有區域性的替代引擎 entitlement 規則。對工程驗收而言，按實際安裝環境測試比按品牌推論可靠。[W4]

這張表是目標覆蓋與限制說明，不是捏造的相容性打勾表。附帶 `browser.html` 可匯出環境、kernel 結果及部分 API 探測，方便補齊目標設備資料；它不包含實際解碼或 GPU benchmark。

## 9. 合併順序與驗收條件

**先做逐列張量與 fallback。** 前者不改判斷語義，最適合以原 Rust differential parity 阻擋回歸；後者修正可明確重現的錯判，需將新 fixture 轉入原追蹤測試，確認 Static→Lost 後的片段／warning 行為，而不是只改 expected value。

**清晰度修正接著做，但要同步處理 score 語義版本。** 六方向／通道選擇測試只是最低門檻；原有衝突／遮擋／provisional／frozen 回歸必須保持，且在真實壓縮影片上確認沒有明顯增加誤替換。由於評分子核心成本增加，不得跳過 render 分階段耗時。

**受限 pose fast path 最後做。** 嚴格 admission、2D residual guard、固定 root、不符條件回退原 solver 都是必要部分。效益較前兩項窄，不應為它重寫一般圖或讓輸出／持久化語義失去一致性。

上游驗收至少要把兩類測試分開：數值等價修改與原 baseline 比；刻意修正錯誤的行為要與真值比。讓所有測試繼續模仿舊錯誤，不是品質保證。跨平台的最終放行還需真實影片、native 輸出、missing／invented／mismatched、frame 可見性與峰值記憶體等端到端資料；本包未提供那些結果。

## 10. 重現與交付清單

所有保留方案都有可執行 PoC 和 assertion，不只有散文設計。執行方式見 `README.md`；`node poc/run-all.mjs` 不需網路或 npm 套件，附有 C 原始碼、預編譯 scalar/SIMD Wasm、build script、Node runner 與 Chromium runner。

| 證據                                     | 每次 suite 的內容            |
| ---------------------------------------- | ---------------------------- |
| feature parity                           | scalar 180、SIMD-enabled 180 |
| independent tensor oracle                | 24                           |
| fallback branch adversarial fixtures     | 21                           |
| fallback textured-gate/matching fixtures | 8                            |
| dense-vs-bounded fallback oracle         | 500                          |
| fallback static/noise controls           | 180，另空 mask guard         |
| sharpness quality cases                  | 6，另 132 控制與 4 邊界      |
| pose independent dense oracle            | 100                          |
| pose 2D guards                           | 80 有效案例、12 類拒絕案例   |

以上是不同性質的檢查數量，不能相加成「影片準確率」。Node 與 Chromium 各跑相同 suite，也不把相同 fixture 重複跑兩次就說成資料集翻倍。

`results/node.json`、`results/chromium.json` 為最終權威測量檔。時間戳使用 UTC，因此顯示 2026-09-25；換算 America/Phoenix 仍為 2026-09-24。只有本報告保留的四項方案進入交付包；沒有把無明確收益的探索性構想混成推薦。

## 附錄 A：完整特徵效能表

單位 ms。這是固定工作負載的批次中位數；粗體或表格位置不代表任何一項是全 App 效能。Node 的主機波動在個別工作負載較明顯，請保留完整原始樣本，不只讀倍率。

| 環境     | 建置   | 尺寸    | 內容  | 舊 ms   | 新 ms  | 倍率   |
| -------- | ------ | ------- | ----- | ------- | ------ | ------ |
| Node     | scalar | 240×160 | noise | 0.5616  | 0.5064 | 1.109× |
| Node     | scalar | 240×160 | text  | 0.6136  | 0.5527 | 1.110× |
| Node     | scalar | 480×270 | noise | 2.2278  | 1.9149 | 1.163× |
| Node     | scalar | 480×270 | text  | 2.3023  | 1.8939 | 1.216× |
| Node     | scalar | 481×271 | noise | 2.3853  | 1.9180 | 1.244× |
| Node     | scalar | 481×271 | text  | 2.3386  | 1.9180 | 1.219× |
| Node     | scalar | 480×480 | noise | 4.0900  | 3.6136 | 1.132× |
| Node     | scalar | 480×480 | text  | 4.1166  | 3.4165 | 1.205× |
| Node     | scalar | 640×360 | noise | 4.1909  | 3.4666 | 1.209× |
| Node     | scalar | 640×360 | text  | 4.1362  | 3.3841 | 1.222× |
| Node     | scalar | 960×540 | noise | 10.1672 | 8.1439 | 1.248× |
| Node     | scalar | 960×540 | text  | 10.0482 | 8.3576 | 1.202× |
| Node     | simd   | 240×160 | noise | 0.5355  | 0.4363 | 1.227× |
| Node     | simd   | 240×160 | text  | 0.6104  | 0.4425 | 1.379× |
| Node     | simd   | 480×270 | noise | 2.3625  | 1.6610 | 1.422× |
| Node     | simd   | 480×270 | text  | 3.6698  | 2.8559 | 1.285× |
| Node     | simd   | 481×271 | noise | 2.2678  | 1.9956 | 1.136× |
| Node     | simd   | 481×271 | text  | 2.3098  | 1.5294 | 1.510× |
| Node     | simd   | 480×480 | noise | 6.2121  | 5.9020 | 1.053× |
| Node     | simd   | 480×480 | text  | 4.7980  | 3.5337 | 1.358× |
| Node     | simd   | 640×360 | noise | 5.5723  | 4.1502 | 1.343× |
| Node     | simd   | 640×360 | text  | 5.1647  | 4.0108 | 1.288× |
| Node     | simd   | 960×540 | noise | 11.8157 | 8.8804 | 1.331× |
| Node     | simd   | 960×540 | text  | 12.7584 | 8.1270 | 1.570× |
| Chromium | scalar | 240×160 | noise | 0.6625  | 0.5500 | 1.205× |
| Chromium | scalar | 240×160 | text  | 0.6625  | 0.5750 | 1.152× |
| Chromium | scalar | 480×270 | noise | 2.3875  | 2.0750 | 1.151× |
| Chromium | scalar | 480×270 | text  | 2.3750  | 2.0000 | 1.188× |
| Chromium | scalar | 481×271 | noise | 2.4625  | 2.0125 | 1.224× |
| Chromium | scalar | 481×271 | text  | 2.5125  | 1.9875 | 1.264× |
| Chromium | scalar | 480×480 | noise | 4.3500  | 3.7500 | 1.160× |
| Chromium | scalar | 480×480 | text  | 4.3500  | 3.5875 | 1.213× |
| Chromium | scalar | 640×360 | noise | 4.3625  | 3.6750 | 1.187× |
| Chromium | scalar | 640×360 | text  | 4.2375  | 3.6250 | 1.169× |
| Chromium | scalar | 960×540 | noise | 11.1667 | 8.4000 | 1.329× |
| Chromium | scalar | 960×540 | text  | 10.6000 | 8.3333 | 1.272× |
| Chromium | simd   | 240×160 | noise | 0.6000  | 0.4562 | 1.315× |
| Chromium | simd   | 240×160 | text  | 0.5875  | 0.4500 | 1.306× |
| Chromium | simd   | 480×270 | noise | 2.3625  | 1.8125 | 1.303× |
| Chromium | simd   | 480×270 | text  | 2.2375  | 1.6625 | 1.346× |
| Chromium | simd   | 481×271 | noise | 2.3375  | 1.8125 | 1.290× |
| Chromium | simd   | 481×271 | text  | 2.2625  | 1.7375 | 1.302× |
| Chromium | simd   | 480×480 | noise | 4.5375  | 3.3500 | 1.354× |
| Chromium | simd   | 480×480 | text  | 4.3375  | 3.3125 | 1.309× |
| Chromium | simd   | 640×360 | noise | 4.4250  | 3.2750 | 1.351× |
| Chromium | simd   | 640×360 | text  | 4.3000  | 3.2000 | 1.344× |
| Chromium | simd   | 960×540 | noise | 11.2000 | 7.5667 | 1.480× |
| Chromium | simd   | 960×540 | text  | 11.1333 | 7.6000 | 1.465× |

## 附錄 B：純 1D pose 求解時間

單位 µs；使用正式 weak weight=0.05，排除 initializer 建構、2D admission、圖 IO。不能拿下列倍率宣稱上游整個 pose graph 已加速。

| 環境     | n 條邊 | GS µs    | 解析解 µs | 核心倍率 |
| -------- | ------ | -------- | --------- | -------- |
| Node     | 16     | 3.4891   | 1.2820    | 2.72×    |
| Node     | 32     | 2.5695   | 1.1494    | 2.24×    |
| Node     | 64     | 2.6279   | 0.9333    | 2.82×    |
| Node     | 256    | 7.0206   | 3.3443    | 2.10×    |
| Node     | 1024   | 25.1912  | 7.1963    | 3.50×    |
| Node     | 4096   | 95.6099  | 27.7809   | 3.44×    |
| Node     | 10000  | 250.6886 | 68.0424   | 3.68×    |
| Chromium | 16     | 2.9687   | 0.7227    | 4.11×    |
| Chromium | 32     | 2.5000   | 1.6016    | 1.56×    |
| Chromium | 64     | 2.0312   | 0.9570    | 2.12×    |
| Chromium | 256    | 7.1875   | 3.4375    | 2.09×    |
| Chromium | 1024   | 28.1250  | 13.1250   | 2.14×    |
| Chromium | 4096   | 175.0000 | 50.6250   | 3.46×    |
| Chromium | 10000  | 245.0000 | 96.2500   | 2.55×    |

## 來源與版本定位

所有 S 類來源固定至同一 commit；不是浮動 main 分支。來源中的上游實驗結果屬作者記錄，並不等於本次執行結果。W 類官方平台文件核對於本次審查。

**S1** [README.md](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/README.md)。

**S2** [docs/CAPABILITIES.md](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/docs/CAPABILITIES.md)。

**S3** [rust/core/src/features.rs](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/rust/core/src/features.rs)；[tests/support/reference/kernels.ts](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/tests/support/reference/kernels.ts)。

**S4** [rust/core/src/motion.rs](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/rust/core/src/motion.rs)。

**S5** [rust/core/src/track/odometry.rs](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/rust/core/src/track/odometry.rs)。

**S6** [rust/core/src/pose_graph.rs](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/rust/core/src/pose_graph.rs)；[src/core/pose-graph.ts](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/src/core/pose-graph.ts)。

**S7** [src/core/compute.ts](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/src/core/compute.ts)。

**S8** [rust/core/src/compositor.rs](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/rust/core/src/compositor.rs)。

**S9** [rust/core/src/pool.rs](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/rust/core/src/pool.rs)；[rust/core/src/raster.rs](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/rust/core/src/raster.rs)。

**S10** [src/media/source.ts](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/src/media/source.ts)。

**S11** [docs/TESTING.md](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/docs/TESTING.md)。

**S12** [rust/core/src/framing.rs](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/rust/core/src/framing.rs)。

**S13** [src/pipeline/solve/track.ts](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/src/pipeline/solve/track.ts)。

**S14** [rust/core/src/track/verdicts.rs](https://github.com/t41372/long-screen/blob/962e4eaee7cd6f8eacdf2d15558b4b8d0389c257/rust/core/src/track/verdicts.rs)。

**W1** [MDN — WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)。

**W2** [MDN — VideoDecoder.configure](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure)。

**W3** [MDN — SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)。

**W4** [Apple — Alternative browser engines in the EU](https://developer.apple.com/support/alternative-browser-engines/)。
