import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        '重建採用分層平移畫布，並以幾何迴環約束校正位置。自動遮罩與動態區域辨識屬於啟發式推論；可信度分數不等於經過校準的正確機率。世界座標下的一致性比較，依這段來源影片宣告的解碼雜訊 ±{{noise}} 階執行{{margin}}。',
      marginLossy: '（預留壓縮影片振鈴與色度重建的誤差）',
      marginLossless: '（無損來源，逐像素精確比對）',
      action: '比例或結構不相容時，會保留為獨立片段，不會強行拼接。',
    },
    APPROXIMATE_DECODER: {
      message: '已手動啟用 {{fps}} Hz 的「近似 · 原生跳轉」模式。無法保證擷取影片的每一個影格，短暫出現的內容可能遺漏。',
      action: '若需要逐格涵蓋所有內容，請使用 WebCodecs 支援的輸入格式，例如 H.264 或 VP9。',
    },
    ANALYSIS_PYRAMID: {
      message: '移動分析使用的影像長邊上限為 {{size}}px；精修與最終合成仍使用原始解析度的像素，輸出不會跟著縮小。',
    },
    FRAME_MEMORY_PRESSURE: {
      message: '單一原始影格與參考影格的記憶體用量已接近所選快取上限。解碼器與 GPU 本身使用的記憶體不受 JavaScript 快取上限控制。',
      action: '不會自行降低輸出解析度。若記憶體不足，會保留已儲存的資料並回報失敗。',
    },
    RUN_FAILURE: {
      action: '已寫入本機儲存空間的圖塊仍可查看與匯出；這次失敗未被標記為成功。',
    },
    PERSISTENCE_ERROR: { action: '資料寫入也失敗了，只有先前成功儲存的部分可以復原。' },
    MEMORY_BUDGET_RAISED: {
      message: '為了容納一個影格涵蓋的所有圖塊，圖塊快取已從原上限的 {{from}} 個增加到 {{to}} 個（約 {{mb}} MB）。',
      action: '若快取小於一個影格的涵蓋範圍，每處理一個影格都必須重新解碼並編碼所有圖塊。如需減少記憶體用量，請降低錄影解析度。',
    },
    NONFINITE_POSE: {
      message: '位置計算產生了非有限數值。已將這筆觀測獨立保留，無效座標未寫入畫布。',
    },
    MISSING_PLAN: {
      message: '繪製階段缺少 plan/{{index}}，已停在先前成功儲存的位置。',
      action: '請檢查本機儲存資料是否完整；缺少的定位計畫不會被直接當成空白觀測。',
    },
    prefixOnly: {
      base: {
        scan: '只使用已解碼的前 {{frames}} 個影格繼續定位與合成',
        solve: '只使用已定位的前 {{frames}} 個影格繼續繪製',
        render: '只保留已繪製的前 {{frames}} 個影格結果',
      },
      suffixPersistence: '；資料寫入已停止。',
      suffixDefault: '。',
    },
    PRESENTATION_TOO_SPARSE: {
      action: '已略過這張畫布的外框處理；以頁面座標重建的核心結果不受影響。',
    },
    PRESENTATION_FRAME: {
      message:
        '含外框的版本與原始二維內容會分別保留。外框來自參考影格，延伸部分僅為裝飾背景，不算觀測到的內容；工具列圖示不會被拉伸或重複。外框中的其他窗格僅為參考快照。',
    },
    PRESENTATION_STAGE_FAILED: {
      action: '外框處理失敗；以頁面座標重建的核心結果與狀態不受影響。',
    },
    PYRAMID_FAILED: {
      action: '無法產生多層預覽；原尺寸圖塊不受影響，仍可查看與匯出。',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: '{{pass}} 階段只完成 {{actual}}／{{expected}} 個影格，結果已標記為不完整。',
      action: '已保留先前成功儲存的部分；缺少的影格不會被當成已處理。',
    },
    FRAME_CONVERSION: { message: '解碼後的影格使用以下方式轉成像素：{{method}}。' },
    HDR_UNCHECKED: {
      message: '這是 HDR 錄影（{{transfer}}），但這個瀏覽器無法驗證色彩轉換，產生的截圖可能偏暗或褪色。',
      action: '請使用最新版 Chrome 或 Safari 重新處理。',
    },
    HDR_ABOVE_WHITE: {
      message:
        '這段 HDR 錄影的第一個影格中，有 {{percent}}% 的像素比一般白色更亮，已按白色處理。若截圖看起來過曝，可能是錄影軟體將一般內容的白色設在較高亮度。',
      action: '請將錄影軟體的 SDR 白色亮度設回 100 尼特，或關閉 HDR 錄製。',
    },
    SLOW_CONVERSION: {
      message: '這個瀏覽器將每個影格轉成像素約需 {{ms}} 毫秒，光是轉換整段錄影就約需 {{minutes}} 分鐘。',
      action: '最新版 Chrome 或 Safari 的轉換速度會快很多，也可以先將錄影轉成 H.264。',
    },
    REVEAL_SKIPPED: {
      message:
        '這次產生的畫布太多或太大，清除覆蓋內容（游標、浮動按鈕、捲軸）所需的記憶體比剩餘容量多出約 {{need}} MB，因此已略過這個步驟，保留原本拼接的像素。',
      action: '其他結果不受影響。畫布過多通常表示部分錄影無法與前後內容接合；可以縮短錄影，或改用記憶體較大的電腦。',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}。Rust 核心：{{variant}} 版本，{{threads}} 個運算執行緒（{{coreReason}}）。',
    },
    PRESENTATION_REFERENCE_FAILED: {
      action: '將略過外框處理；以頁面座標重建的核心結果不受影響。',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message: '這個影格缺少可辨識的紋理。兩個相同的空白影格，可能代表暫停，也可能是在空白區域移動，光靠像素無法區分。',
      action: '請增加可辨識的可見內容，或讓錄影前後有更多重疊。此處採用零位移只是目前最合理的推測。',
    },
    UNRESOLVED_MOTION: {
      message: '這筆觀測缺少可靠的影像對齊依據。定位階段會嘗試與先前內容重新比對；若仍無法定位，就保留為獨立片段。',
    },
    AMBIGUOUS_PATTERN: {
      message: '偵測到重複紋理，有多種同樣合理的對應位置。移動的連續性只能提供定位線索，無法證明某個位置是唯一正解。',
    },
    TEMPORAL_UNDERSAMPLING: {
      message: '這個影格涵蓋的時間較長，快速移動時可能經過了未被擷取的區域。',
    },
    MANUAL_UNASSIGNED: {
      message: '手動框選範圍之外的部分，會以螢幕座標保留為獨立的低可信度觀測圖層，不代表這些像素已成功定位到頁面座標。',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message: '已依手動設定排除「忽略」區域。這個區域不會出現在重建結果中，並非系統自動遺漏影格。',
    },
    MANUAL_REGION_PRIORITY: {
      message: '手動區域重疊時，以後畫的區域為準；設為忽略的區域一律排除。其餘像素會保留在未指定的觀測圖層中。',
    },
    AUTOMATIC_LAYER_MASK: {
      message: '已自動區分為 {{moving}} 個內容區域與 {{fixed}} 個固定介面區域。邊界來自像素移動的統計結果，而非 DOM。',
      action: '若遮罩的區域歸屬不正確，請到「獨立移動的區域」精確框選捲動範圍，再重新處理。',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: '多個獨立捲動區域會各自建立畫布，不會強制共用同一個捲動位移。',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        '這個影格對齊後，重疊範圍共有 {{conflicts}} 個明顯不同的像素；此區域是其中一個衝突區塊。原因可能是動畫、內容更新、版面重排，或對齊後的殘餘誤差。',
      actionStable: '已盡可能將完整的衝突區域固定在同一時刻，請查看橘色診斷標記與原始影片的對應時間。',
      actionRolling: '只有在衝突區域完整可見時，才會用同一影格更新整個區域；整張頁面不一定來自同一時刻。',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message: '這個變動區域未曾完整出現在任何可用畫面中，因此無法保證所有像素來自同一時刻。',
      action: '已保留觀測到的內容並明確標記衝突，未憑空補上沒錄到的部分。',
    },
    MISSING_SCAN_RECORD: {
      message: '定位階段缺少 scan/{{index}}，已停在先前成功儲存的位置。',
      action: '請檢查本機儲存資料是否完整；缺少的掃描記錄不會被當成零位移。',
    },
    GRAPH_RESIDUAL: {
      message: '位置圖的最大殘餘誤差仍為 {{residual}} 個原始像素，附近接縫可能有幾何不一致的情況。',
      action: '請檢查迴環附近的文字與重複紋理。這項誤差已如實記錄。',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        '約 {{percent}}% 的紋理區塊與整體位移不一致，可能來自動畫、影片、延遲載入或版面重排。位移由一致的區塊決定，衝突區域會在合成時另行處理。',
    },
    THIN_OVERLAP_STEP: {
      message:
        '兩個影格之間移動太快，只剩很小的重疊範圍可供對齊。位移是根據這一小塊內容推算的；遇到週期性重複的版面，相鄰週期也可能符合這些像素。',
      action: '若稍後重訪時取得更可靠的依據，會校正整段軌跡並留下記錄。',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous: '重複紋理使多種位移都能符合這些像素，因此採用最符合連續移動的解。這是目前最合理的推測，不代表唯一正確的對齊方式。',
      messageLowConfidence: '這個區域的位置推斷可信度較低，相關像素會在品質遮罩中標示。',
      messageStatic: '兩個影格幾乎相同，但缺少可驗證的對應特徵，因此暫以暫停（零位移）處理，這只是目前最合理的推測。',
      action: '已根據連續軌跡與既有錨點做出最佳推測，不代表這是唯一正確的對齊方式。',
    },
    UNOBSERVABLE_FRAME: {
      message: '這個影格在此區域沒有可辨識的紋理：空白可能代表暫停，也可能是在空白區域移動，光靠像素無法區分，因此不會將它繪製到任何位置。',
      action: '若空白之後的內容無法與先前觀測重疊，就會保留為獨立片段，不猜測中間的距離。',
    },
    RELOCALIZED: {
      message: '已透過先前的影像錨點重新定位到既有畫布，重訪的內容不會被當成新內容加長截圖。',
    },
    SCALE_CHANGE_FRAGMENT: {
      message: '偵測到約 {{scale}}× 的比例或版面變化，已按原始像素保留為獨立片段，未自行縮放後混合。',
      action: '片段之間的關係尚未確認。若後續重訪時能可靠地比對，會將片段完整接回。重新錄製時請增加重疊，或用手動區域將變動元件分開。',
    },
    UNPLACED_FRAGMENT: {
      message: '無法確認與原畫布的相對位置，已保留為可個別匯出的獨立片段。兩個片段可能重疊，也可能確實相隔一段未錄到的內容。',
      action: '片段之間的關係尚未確認。若後續重訪時能可靠地比對，會將片段完整接回。重新錄製時請增加重疊，或用手動區域將變動元件分開。',
    },
    STICKY_OCCLUSION: {
      message:
        '畫面頂端的紋理顯示這是固定在螢幕上的介面，而非頁面位移。這筆觀測中的固定遮擋不會寫入移動畫布；原始參考介面會保留在含外框的版本中。',
    },
    NESTED_LAYER_FOUND: {
      message: '這個區域裡有一塊自己捲動的容器：它的內容有 {{frames}} 個影格沒有跟著區域移動，所以另外拼成一張長圖。',
    },
    FRAGMENT_ATTACHED: {
      message: '根據重訪時的影像依據，已將獨立片段完整接回既有畫布。片段內部的相對軌跡保持不變。',
    },
    TRAJECTORY_CORRECTED: {
      message: '上一步只有很小的重疊範圍；這個影格與既有內容的比對結果相差 {{discrepancy}}px，而且依據更可靠，因此已據此校正目前位置。',
      action: '校正範圍是這個影格與之後的軌跡；先前寫入的像素維持原樣，與校正後的座標之間可能出現接縫。',
    },
    LOOP_CLOSURE: {
      message: '已找到可靠的歷史重訪對應，並加入全域位置約束；最終合成會使用校正後的軌跡。',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message: '歷史比對結果與連續軌跡相差 {{discrepancy}}px。兩項依據互相衝突，因此未強制套用為迴環約束。',
    },
    AMBIGUOUS_LOOP: {
      message: '歷史搜尋找到數個同樣合理的位置，未將這個不確定的迴環設為強制約束。',
    },
  },
  progress: {
    runPartial: '已儲存拼接完成的部分，並標記為不完整。',
    runComplete: '拼好了。請查看診斷記錄，以及棋盤格標示的未錄製區域。',
    render: '正在按原尺寸拼接錄到的畫面，沒錄到的地方保持透明。',
    reveal: {
      learn: '重新查看錄影，找出浮在頁面上的按鈕、輸入列與捲軸。',
      agree: '比對各個區域在不同時間的樣貌，優先保留未被遮住的畫面。',
      relearn: '根據核對後的頁面，再次辨識浮動元素。',
      write: '將被遮住或不一致的區域換成清楚的影格。',
    },
    framingStart: '正在還原視窗外框，只延伸背景，不拉伸側邊欄文字或重複圖示。',
    pyramidBuild: '正在產生多層預覽，原尺寸圖塊維持不變。',
    scanFrame: '逐格分析錄影，找出獨立移動的區域。',
    duplicateReuse: '這筆觀測與前一筆完全相同，沿用先前的位置，並保留來源影格與時間戳記。',
    solveFrame: '以原始像素精修位置、比對歷史畫面，並套用二維迴環約束。',
    optimizing: '正在最佳化儲存於磁碟的位置圖，校正迴環中的累積位移誤差。',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: 這個瀏覽器無法解碼錄影的編碼格式（{{codec}}）。{{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc: 'iPhone 與 Mac 的錄影通常使用 HEVC，只有部分瀏覽器支援。請改用 Safari，或支援硬體解碼的 Chrome、Edge。',
      prores: '瀏覽器不支援 ProRes 解碼，請先將錄影匯出為 H.264 或 HEVC。',
      h264: '這種 H.264（4:4:4 或 10 位元）只有 Chrome 能解碼。請改用 Chrome，或將影片匯出為一般的 H.264。',
      av1: 'AV1 需要較新的瀏覽器或硬體。請改用最新版 Chrome，或將錄影匯出為 H.264。',
      other: '請改用最新版 Chrome 或 Safari，或先將錄影轉成 H.264。',
    },
    PIXEL_ASPECT_RATIO: '錄影宣告的像素長寬比為 {{num}}:{{den}}。原始儲存像素會保留且不縮放，因此顯示比例可能不同。',
    CONTAINER_SIZE_MISMATCH:
      '容器宣告的尺寸為 {{codedWidth}}×{{codedHeight}}，但位元串流的實際尺寸為 {{bitstreamWidth}}×{{bitstreamHeight}}，將以位元串流為準。',
    NON_SQUARE_PIXELS:
      '錄影宣告的像素不是正方形（顯示尺寸 {{displayWidth}}×{{displayHeight}}，儲存尺寸 {{bitstreamWidth}}×{{bitstreamHeight}}）。將保留原始儲存像素，不做縮放。',
    NEGATIVE_TIMESTAMP_SKIPPED: '解碼器輸出了位於編輯清單起點之前的影格（時間戳記為負值），依容器規則不顯示這些影格。',
    NONMONOTONIC_TIMESTAMP: '容器的時間戳記出現倒退，已依解碼器的顯示順序繼續處理，未捨棄任何觀測。',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: 這段影片軌道的 ctts box 為 version 0，卻包含負的合成時間偏移；ISO 14496-12 只在 version 1 定義負偏移。這些偏移已按帶正負號數值處理，符合 QuickTime／ReplayKit 的常見做法，未將它們當成異常大的正偏移。',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: 檔案在 {{box}} box 內提前結束。這個 box 宣告結束於第 {{declaredEnd}} 位元組，但檔案只有 {{size}} 位元組。錄影可能未正常結束，或檔案在複製、傳輸時被截斷。截斷位置之後的影格無法解碼，因此掃描到的影格會少於中繼資料所列數量，結果將標記為不完整。',
  },
  exports: {
    tilesProgress: '正在匯出原圖與預覽圖塊 {{n}}',
    zipFinalize: '正在寫入 ZIP64 目錄並儲存檔案',
    projectDone: { message: '已匯出原尺寸圖塊、離線檢視器、覆蓋範圍與品質資料、來源影格記錄，以及完整診斷。' },
    encodingSingle: '正在以原尺寸編碼第 {{row}}／{{total}} 列',
    canvasDone: { message: '已匯出 {{width}} × {{height}} 的 PNG，未錄到的部分保持透明。' },
    encodingSheet: '已編碼 {{count}} 張原尺寸分頁圖片',
    sheetsDone: {
      messagePaged: '已分頁匯出為 {{count}} 張原尺寸圖片，相鄰頁面最多重疊 {{overlap}}px，座標請見 manifest 清單。',
      messageOversize:
        '畫布超過單張圖片的相容尺寸，已改為匯出 {{count}} 張原尺寸分頁圖片。相鄰頁面最多重疊 {{overlap}}px，座標請見 manifest 清單。',
    },
  },
  offline: {
    title: '離線畫布',
    fit: '看全圖',
    tip: '本機原尺寸圖塊 · 拖曳移動／滾輪縮放',
    previewLevel: '目前顯示第 {{level}} 層預覽，放大可查看原始像素',
    nativeTiles: '目前顯示原尺寸圖塊',
    footer: '棋盤格代表未觀測到或沒有圖塊的區域；可信度不等於正確機率。詳情請見 diagnostics.jsonl 與 observations.jsonl。',
  },
};
