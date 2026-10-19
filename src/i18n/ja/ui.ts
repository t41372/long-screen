import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'フレームごとの解析と、個別に動く領域の検出',
      solving: '全体の位置合わせと、元の解像度での微調整',
      optimizing: '同じ場所への再訪を基に位置のずれを補正',
      rendering: '元の解像度でキャンバスを合成',
      revealing: 'ページに重なる UI を取り除いています',
      framing: 'ウインドウ枠と元の縦横比を保持',
      pyramid: 'ズームできるプレビューを作成',
      complete: '完了 · 診断情報をご確認ください',
      partial: '途中までの結果を保存しました',
      error: '処理中にエラーが発生しました',
    },
    count: {
      frames_one: '{{frames}}フレーム',
      frames_other: '{{frames}}フレーム',
      framesUnknown: 'フレーム数不明',
      regions_one: '{{count}}領域を指定済み ↗',
      regions_other: '{{count}}領域を指定済み ↗',
    },
    dom: {
      noCompressionStream:
        'このブラウザーは CompressionStream に対応していません。元の解像度の各タイルを PNG に変換できないため、処理を開始できません。',
    },
    canvases: {
      badgePresentation: '枠付き表示 · 延長した背景は観測の根拠になりません',
      badgeFixed: '固定 UI / 観測レイヤー',
      badgeMoving: '2Dコンテンツレイヤー',
      badge_one: '{{kind}} · 原寸タイル{{count}}枚{{fragment}}',
      badge_other: '{{kind}} · 原寸タイル{{count}}枚{{fragment}}',
      fragmentNote: ' · 断片同士の位置関係は未確定です',
    },
    diagnostics: {
      occurrenceSuffix: '（同種の記録が{{count}}件）',
      locateAction: '該当箇所・元のフレームを見る ↗',
      viewSourceAction: '録画の該当時刻を見る ↗',
      emptyFiltered: 'この条件に一致する記録はありません。',
      emptyDefault: '位置合わせの根拠、内容の変化、推定結果やエラーがここに表示されます。',
      noOriginalVideo:
        'プロジェクトには元の動画が含まれていません。該当時刻のフレームを見るには、同じ録画をもう一度選んでください。合成結果はこの端末に保存されています。',
      hashMismatch:
        'ファイル名とサイズは一致しますが、内容のハッシュがこのプロジェクトの元の録画と異なるため、参照用には使えません。正しい録画ファイルを選んでください。',
      sourceCaption: '元のフレーム {{frame}} · {{time}}秒 · {{message}}',
    },
    export: {
      imageSuffix: '-スクリーンショット',
      savePickerFallback: '直接保存できないため、ブラウザーのダウンロードに切り替えます：{{error}}',
      saveRowLabel: '{{name}} を保存 · {{size}}',
      shareLabel: '共有 / 写真に保存',
      shareFailed: '共有できませんでした：{{error}}',
      cleanupLabel: '保存後に一時コピーを削除',
      exportErrorAction: '書き出しは完了していません。保存済みのプロジェクトタイルは、この端末に残っています。',
      clipboardUnsupported: 'このブラウザーでは画像をコピーできません。「画像を保存」をお使いください。',
      copyNoImage: '画像が生成されませんでした',
      copyFailedCtor: 'コピーできませんでした：{{error}}。「画像を保存」をお使いください。',
      copySuccess: '{{width}} × {{height}} の画像をコピーしました。そのまま貼り付けられます。',
      copyFailed:
        'コピーできませんでした：{{error}}。画像がクリップボードの上限を超えている可能性があります。「画像を保存」をお使いください。',
    },
    crop: {
      buttonCropped: '切り抜き · {{width}} × {{height}}',
      applied:
        '切り抜きを適用しました。保存、コピー、分割保存の対象はこの範囲（{{width}} × {{height}}）になります。プロジェクト全体の ZIP は切り抜きません。',
      removed: '切り抜きを解除しました。画像全体を保存します。',
    },
    main: {
      offscreenMissing: 'このブラウザーは OffscreenCanvas に対応していないため、描画ワーカーを実行できません。',
      webcodecsMissingToast:
        'このブラウザーは WebCodecs に対応していません。「近似 · 標準プレーヤー」を選ぶと処理できますが、フレームを取りこぼすことがあります。',
      privateStorageToast:
        'プライベートブラウズでは、プロジェクトはこのウインドウのメモリにだけ保存され、閉じると消えます。残したい結果は閉じる前に保存してください。',
      noOpfsNoPicker: 'このブラウザーは OPFS とファイル保存ダイアログに対応していないため、メモリ上で書き出します（最大{{mb}} MB）。',
      dbOpenFailed: '端末内のデータベースを開けませんでした：{{error}}',
      workerErrorToast: 'ワーカーのエラー：{{message}}',
      workerMessageUndecodable: 'ワーカーからのメッセージを読み取れませんでした。現在の結果を保存してから再読み込みしてください。',
      interruptedPhaseWhere: '「{{phase}}」の{{frames}}フレーム目',
      interruptedStartPhase: '開始処理',
      interruptedHiddenSome: 'ページは約{{seconds}}秒間バックグラウンドにありました{{stillHidden}}',
      interruptedStillHidden: '（中断時もバックグラウンドでした）',
      interruptedHiddenNone: 'ページは常に最前面にありました',
      interruptedDiagnosticMessage:
        '前回の処理は{{where}}で中断され、ページは完了通知を受け取りませんでした（ブラウザーによるページの破棄、またはクラッシュ）。実行時間：{{elapsed}}秒、コアのメモリ：{{memory}} MB、{{hidden}}、フレーム変換：{{conversion}}、CPU コア数：{{cores}}{{isolation}}。',
      interruptedDiagnosticAction:
        'Safari はページがバックグラウンドになると、より低いメモリ使用量でもページを破棄することがあります。長い処理中はこのタブを最前面に保ってください。詳細はブラウザーのコンソールに記録しました。',
      interruptedNotIsolated: '（クロスオリジン分離なし・シングルスレッド）',
      interruptedToast: '前回の処理は{{where}}で中断されました（{{hidden}}）。詳しくは診断情報をご覧ください。',
      unknownValue: '不明',
    },
    run: {
      pausedStatus: '一時停止中 · メモリ上の状態を保持しています',
      resumedStatus: '再開しています',
      pauseLabel: '一時停止',
      resumeLabel: '再開',
      stopToast: '現在の工程を終了し、処理できた部分をできるだけ合成して保存します。',
      preparingStatus: 'フレーム単位のデコードを準備中',
      preparingMessage: '動画の構造、コーデックへの対応状況、端末内の保存領域を確認しています。',
      compatibilityNeedsNative: '「近似 · 標準プレーヤー」を使うには、ブラウザー標準のプレーヤーでこの動画を読める必要があります。',
      webcodecsHttpBlocked:
        'この HTTP アドレスでは WebCodecs を使えません。ローカルで試すには「近似 · 標準プレーヤー」を選べます。フレーム単位のデコードには localhost または HTTPS が必要です。動画はアップロードしません。',
      webcodecsMissing:
        'このブラウザーは WebCodecs に対応していません。Safari / iOS を更新するか、「近似 · 標準プレーヤー」を選んでください。近似モードではフレームを取りこぼすことがあります。',
      startFailedStatus: '処理を開始できませんでした',
      restoredMessage: '前回の結果を表示しています。24時間を過ぎると、次にページを開いたときに削除されます。',
      interruptedStatus: '前回の処理は完了していません',
      interruptedMessage: '停止前に保存できた部分を表示しています。全体を処理するには、録画をもう一度セットして開始してください。',
      waitingCanvasOption: 'キャンバスの再構成待ち',
    },
    source: {
      busyToast: '先に現在の処理を完了するか、停止して保存してください。',
      subtitleReading: '{{size}} · アップロードなし · 動画の構造と最初のフレームを確認中',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · 標準プレーヤーでのみ読み取り可能',
      subtitleUnavailable: '{{size}} · フレーム単位のデコードと標準プレビューのどちらも利用できません',
      probeFailedMessage: 'フレーム単位のデコード確認に失敗しました：{{error}}',
      probeFailedAction:
        'ブラウザー標準のプレーヤーで動画情報の読み取りを試します。処理を続けるには、デコード方式に「近似 · 標準プレーヤー」を選んでください。',
      rejectedVideo:
        '「{{name}}」は{{kind}}です。この形式はブラウザーでフレーム単位に読み取れないため、開けませんでした。録画の保存形式を MP4 に設定するか、HandBrake や ffmpeg で MP4 に変換してください。',
      rejectedOther:
        '「{{name}}」は動画ではなく{{kind}}のため、開けませんでした。ページを移動しながら録った画面録画（MP4、MOV、WebM、MKV）を選んでください。Windows では Snipping Tool や Xbox Game Bar（Win+Alt+R）、Mac では ⌘⇧5、スマホでは標準の画面収録機能で録画できます。',
      unreadableToast:
        'この動画を読み取れません（{{reason}}）。録画が正常に終了し、ファイルのコピーやダウンロードが完了しているか確認してください。解決しない場合は H.264 の MP4 をお試しください。フレーム単位のデコードが失敗した理由は診断情報にあります。',
      kind: {
        empty: '空のファイル',
        heif: 'HEIC/AVIF 画像',
        avi: 'AVI 動画',
        webp: 'WebP 画像',
        wav: 'WAV 音声',
        riff: 'RIFF ファイル',
        wmv: 'WMV/ASF 動画',
        flv: 'FLV 動画',
        mpegps: 'MPEG-PS 動画',
        ogg: 'Ogg メディアファイル',
        gif: 'GIF アニメーション',
        png: 'PNG 画像',
        jpeg: 'JPEG 画像',
        pdf: 'PDF 文書',
        zip: 'ZIP アーカイブまたは Office 文書',
        mp3: 'MP3 音声',
        text: 'テキストファイル',
        mpegts: 'MPEG-TS 動画',
        unknown: '形式不明のファイル',
      },
    },
    demo: { fileName: 'サンプル録画.mp4', loadFailed: 'サンプル録画を読み込めませんでした：{{error}}' },
    feedback: {
      issueBody:
        '**何が起きましたか？**\n\n\n**期待していた動作は？**\n\n\n**録画について**（どんなページを、どのように動かして、どのくらいの長さで録ったか。画像があると助かりますが、個人情報は隠してください）\n\n\n' +
        '---\nLong Screen が自動入力しました。自由に編集・削除できます：\n- ブラウザー：{{browser}}\n- 開いたページ：{{page}}\n- マルチスレッドコア（クロスオリジン分離）：{{threads}}\n- 処理ログの警告：{{warnings}}\n',
      portable: 'ポータブル版（ローカルファイル）',
      yes: 'はい',
      no: 'いいえ',
      none: 'なし',
    },
    viewer: {
      previewLevel: 'プレビュー L{{level}}（原寸データはそのまま）',
      nativeLevel: '原寸ピクセル L0',
      qualityHint: ' · 拡大すると品質マスクが見えます',
      unobservedHint: ' · 青 = 観測の根拠なし',
      provisionalHint: ' · 紫 = 一時的な表示 / 重なった UI',
    },
  },
  names: {
    fixed: '固定 UI',
    divider: '固定の区切り',
    contentCanvas: 'コンテンツキャンバス {{n}}',
    unassigned: '未指定領域 · 画面座標の観測',
    contentRegion: 'コンテンツ領域 {{n}}',
    ignored: '除外',
    fragment: '位置未確定の断片 {{n}}',
    framed: '枠付き',
  },
};
