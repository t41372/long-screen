import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Quan sát từng khung hình và tách lớp chuyển động',
      solving: 'Định vị toàn cục và tinh chỉnh theo điểm ảnh gốc',
      optimizing: 'Hiệu chỉnh vị trí quay lại và sai lệch tích lũy',
      rendering: 'Ghép vùng ảnh ở kích thước gốc',
      revealing: 'Loại bỏ các thành phần nổi trên trang',
      framing: 'Giữ viền cửa sổ và tỷ lệ khung hình gốc',
      pyramid: 'Tạo ảnh xem trước có thể thu phóng',
      complete: 'Hoàn tất · hãy xem thông tin chẩn đoán',
      partial: 'Đã lưu kết quả một phần',
      error: 'Có lỗi trong quá trình xử lý',
    },
    count: {
      frames_one: '{{frames}} khung hình',
      frames_other: '{{frames}} khung hình',
      framesUnknown: 'Chưa rõ số khung hình',
      regions_one: '{{count}} vùng tự chọn ↗',
      regions_other: '{{count}} vùng tự chọn ↗',
    },
    dom: {
      noCompressionStream:
        'Trình duyệt này không có CompressionStream để mã hóa từng ô ảnh ở kích thước gốc thành PNG, nên không thể bắt đầu tái dựng.',
    },
    canvases: {
      badgePresentation: 'Bản có viền · phần nền mở rộng không phải dữ liệu quan sát',
      badgeFixed: 'Lớp cố định / quan sát',
      badgeMoving: 'Lớp nội dung 2D',
      badge_one: '{{kind}} · {{count}} ô ảnh kích thước gốc{{fragment}}',
      badge_other: '{{kind}} · {{count}} ô ảnh kích thước gốc{{fragment}}',
      fragmentNote: ' · chưa xác nhận vị trí giữa các mảnh',
    },
    diagnostics: {
      occurrenceSuffix: ' ({{count}} lần cùng loại)',
      locateAction: 'Xem vùng liên quan / khung hình gốc ↗',
      viewSourceAction: 'Xem thời điểm trong bản gốc ↗',
      emptyFiltered: 'Không có bản ghi nào khớp bộ lọc này.',
      emptyDefault: 'Căn cứ định vị, thay đổi trên trang, suy đoán và lỗi xử lý sẽ xuất hiện ở đây.',
      noOriginalVideo:
        'Dự án không chứa video gốc. Hãy chọn lại đúng bản quay để xem khung hình theo dấu thời gian. Ảnh đã ghép vẫn được lưu trên thiết bị.',
      hashMismatch:
        'Tên và kích thước tệp khớp, nhưng mã băm nội dung khác với bản quay dùng để tạo dự án này, nên không thể dùng làm nguồn đối chiếu. Hãy chọn đúng tệp quay màn hình.',
      sourceCaption: 'Khung hình gốc {{frame}} · {{time}} giây · {{message}}',
    },
    export: {
      imageSuffix: '-anh-chup',
      savePickerFallback: 'Không thể lưu trực tiếp, đang chuyển sang tải xuống qua trình duyệt: {{error}}',
      saveRowLabel: 'Lưu {{name}} · {{size}}',
      shareLabel: 'Chia sẻ / lưu vào Ảnh',
      shareFailed: 'Không thể chia sẻ: {{error}}',
      cleanupLabel: 'Xóa bản sao tạm sau khi lưu',
      exportErrorAction: 'Lượt xuất chưa hoàn tất không được đánh dấu là thành công. Các ô ảnh dự án đã lưu vẫn còn trên thiết bị.',
      clipboardUnsupported: 'Trình duyệt này không sao chép được hình ảnh. Hãy dùng “Lưu ảnh”.',
      copyNoImage: 'Chưa tạo được ảnh',
      copyFailedCtor: 'Không thể sao chép: {{error}}. Hãy dùng “Lưu ảnh”.',
      copySuccess: 'Đã sao chép ảnh {{width}} × {{height}}. Bạn có thể dán ngay.',
      copyFailed: 'Không thể sao chép: {{error}}. Ảnh có thể vượt giới hạn bộ nhớ tạm của hệ thống. Hãy dùng “Lưu ảnh”.',
    },
    crop: {
      buttonCropped: 'Cắt ảnh · {{width}} × {{height}}',
      applied:
        'Đã áp dụng. Tải xuống, sao chép và lưu theo phần giờ chỉ lấy vùng này ({{width}} × {{height}}). Tệp ZIP toàn bộ dự án không bị cắt.',
      removed: 'Đã bỏ vùng cắt. Các lần xuất sẽ lấy toàn bộ ảnh trở lại.',
    },
    main: {
      offscreenMissing: 'Trình duyệt này không có OffscreenCanvas, nên worker dựng ảnh không thể chạy.',
      webcodecsMissingToast:
        'Trình duyệt này không có WebCodecs. Bạn có thể chọn “Gần đúng · trình phát có sẵn”, nhưng có thể bị bỏ sót khung hình.',
      privateStorageToast:
        'Trong chế độ duyệt riêng tư, dự án chỉ nằm trong bộ nhớ của cửa sổ này và sẽ mất khi đóng cửa sổ. Hãy xuất trước khi đóng nếu muốn giữ lại.',
      noOpfsNoPicker: 'Trình duyệt này không có OPFS hay hộp thoại lưu tệp. Dữ liệu xuất sẽ được tạo trong bộ nhớ (tối đa {{mb}} MB).',
      dbOpenFailed: 'Không thể mở cơ sở dữ liệu cục bộ: {{error}}',
      workerErrorToast: 'Lỗi worker: {{message}}',
      workerMessageUndecodable: 'Không thể đọc thông điệp từ worker. Hãy lưu kết quả hiện có rồi tải lại trang.',
      interruptedPhaseWhere: '“{{phase}}”, khung hình {{frames}}',
      interruptedStartPhase: 'bước khởi động',
      interruptedHiddenSome: 'trang đã ở chế độ nền khoảng {{seconds}} giây{{stillHidden}}',
      interruptedStillHidden: ' (vẫn ở nền lúc bị ngắt)',
      interruptedHiddenNone: 'trang luôn ở phía trước trong suốt quá trình',
      interruptedDiagnosticMessage:
        'Lượt tái dựng trước bị ngắt tại {{where}}; trang không nhận được tín hiệu hoàn tất do bị trình duyệt đóng hoặc gặp sự cố. Đã chạy {{elapsed}} giây, bộ nhớ lõi {{memory}} MB, {{hidden}}, chuyển đổi khung hình: {{conversion}}, số lõi CPU: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari có thể đóng trang ở mức sử dụng bộ nhớ thấp hơn nhiều khi trang chạy nền. Hãy giữ thẻ này ở phía trước khi xử lý lâu. Bản ghi đầy đủ đã được ghi vào bảng điều khiển của trình duyệt.',
      interruptedNotIsolated: ' (không cách ly chéo nguồn, đơn luồng)',
      interruptedToast: 'Lượt tái dựng trước bị ngắt tại {{where}} ({{hidden}}). Xem thông tin chẩn đoán để biết chi tiết.',
      unknownValue: 'không rõ',
    },
    run: {
      pausedStatus: 'Đã tạm dừng · giữ nguyên trạng thái trong bộ nhớ',
      resumedStatus: 'Đang tiếp tục',
      pauseLabel: 'Tạm dừng',
      resumeLabel: 'Tiếp tục',
      stopToast: 'Đang kết thúc bước hiện tại, ghép và lưu tối đa phần đã quan sát được.',
      preparingStatus: 'Đang chuẩn bị giải mã từng khung hình',
      preparingMessage: 'Đang đọc tệp chứa video, kiểm tra hỗ trợ codec và bộ nhớ cục bộ.',
      compatibilityNeedsNative: '“Gần đúng · trình phát có sẵn” yêu cầu trình phát của trình duyệt đọc được video này.',
      webcodecsHttpBlocked:
        'Trình duyệt không cho dùng WebCodecs ở địa chỉ HTTP này. Bạn có thể chọn “Gần đúng · trình phát có sẵn” để tiếp tục thử cục bộ. Giải mã từng khung hình cần localhost hoặc HTTPS. Video không được tải lên mạng.',
      webcodecsMissing:
        'Trình duyệt này không có WebCodecs. Hãy cập nhật Safari / iOS hoặc chọn “Gần đúng · trình phát có sẵn”, nhưng cách này có thể bỏ sót khung hình.',
      startFailedStatus: 'Không thể bắt đầu tái dựng',
      restoredMessage: 'Đây là kết quả gần nhất. Sau 24 giờ, kết quả sẽ bị xóa vào lần mở trang tiếp theo.',
      interruptedStatus: 'Lượt xử lý trước chưa hoàn tất',
      interruptedMessage: 'Đây là phần đã lưu trước khi dừng. Để có kết quả đầy đủ, hãy thêm lại bản quay và chạy lại.',
      waitingCanvasOption: 'Đang chờ tái dựng vùng ảnh',
    },
    source: {
      busyToast: 'Hãy hoàn tất hoặc dừng và lưu lượt xử lý hiện tại trước.',
      subtitleReading: '{{size}} · không tải lên mạng · đang đọc tệp chứa video và khung hình đầu',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · chỉ trình phát có sẵn đọc được',
      subtitleUnavailable: '{{size}} · không thể giải mã từng khung hình hay xem trước bằng trình phát có sẵn',
      probeFailedMessage: 'Kiểm tra giải mã từng khung hình thất bại: {{error}}',
      probeFailedAction:
        'Sẽ thử đọc thông tin video bằng trình phát có sẵn của trình duyệt. Để tiếp tục xử lý, chọn cách giải mã “Gần đúng · trình phát có sẵn”.',
      rejectedVideo:
        '“{{name}}” là {{kind}}, định dạng mà trình duyệt không thể đọc theo từng khung hình nên chưa được mở. Hãy đặt ứng dụng quay màn hình lưu ở dạng MP4 hoặc chuyển tệp sang MP4 bằng HandBrake hay ffmpeg.',
      rejectedOther:
        '“{{name}}” không phải video ({{kind}}) nên chưa được mở. Hãy chọn bản quay màn hình khi di chuyển trong trang: MP4, MOV, WebM hoặc MKV. Trên Windows, dùng Công cụ Cắt hoặc Xbox Game Bar (Win+Alt+R); trên Mac, nhấn ⌘⇧5; trên điện thoại, dùng tính năng quay màn hình có sẵn.',
      unreadableToast:
        'Không thể đọc video này ({{reason}}). Hãy kiểm tra xem quá trình quay đã kết thúc đúng cách và tệp đã được sao chép hoặc tải xuống đầy đủ chưa. Nếu vẫn lỗi, thử tệp MP4 dùng H.264. Thông tin chẩn đoán có lý do giải mã từng khung hình thất bại.',
      kind: {
        empty: 'tệp rỗng',
        heif: 'ảnh HEIC/AVIF',
        avi: 'video AVI',
        webp: 'ảnh WebP',
        wav: 'tệp âm thanh WAV',
        riff: 'tệp RIFF',
        wmv: 'video WMV/ASF',
        flv: 'video FLV',
        mpegps: 'video MPEG-PS',
        ogg: 'tệp phương tiện Ogg',
        gif: 'ảnh động GIF',
        png: 'ảnh PNG',
        jpeg: 'ảnh JPEG',
        pdf: 'tài liệu PDF',
        zip: 'tệp nén ZIP hoặc tài liệu Office',
        mp3: 'tệp âm thanh MP3',
        text: 'tệp văn bản',
        mpegts: 'video MPEG-TS',
        unknown: 'tệp không nhận diện được',
      },
    },
    demo: { fileName: 'ban-quay-mau.mp4', loadFailed: 'Không thể tải bản quay mẫu: {{error}}' },
    feedback: {
      issueBody:
        '**Đã xảy ra chuyện gì?**\n\n\n**Bạn mong đợi kết quả như thế nào?**\n\n\n**Thông tin về bản quay** (trang nào, cách di chuyển, thời lượng ước tính; ảnh chụp sẽ giúp ích nhưng hãy che thông tin riêng tư)\n\n\n' +
        '---\nLong Screen tự điền phần này. Bạn có thể sửa hoặc xóa:\n- Trình duyệt: {{browser}}\n- Mở từ: {{page}}\n- Lõi đa luồng (cách ly chéo nguồn): {{threads}}\n- Cảnh báo trong nhật ký xử lý: {{warnings}}\n',
      portable: 'bản dùng ngay (tệp cục bộ)',
      yes: 'có',
      no: 'không',
      none: 'không có',
    },
    viewer: {
      previewLevel: 'Xem trước L{{level}} (giữ nguyên kích thước gốc)',
      nativeLevel: 'Điểm ảnh gốc L0',
      qualityHint: ' · phóng to để xem bản đồ chất lượng',
      unobservedHint: ' · xanh lam = không có dữ liệu quan sát',
      provisionalHint: ' · tím = nội dung tạm thời / lớp che phủ',
    },
  },
  names: {
    fixed: 'Giao diện cố định',
    divider: 'Dải phân cách cố định',
    contentCanvas: 'Vùng ảnh nội dung {{n}}',
    unassigned: 'Vùng chưa chỉ định · quan sát theo tọa độ màn hình',
    contentRegion: 'Vùng nội dung {{n}}',
    ignored: 'Bỏ qua',
    fragment: 'mảnh chưa định vị {{n}}',
    framed: 'có viền',
  },
};
