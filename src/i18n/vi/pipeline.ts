import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'Quá trình tái dựng dùng nhiều lớp ảnh tịnh tiến cùng ràng buộc hình học từ việc quay lại cùng một vị trí. Tạo mặt nạ tự động và nhận diện vùng động đều là suy đoán theo kinh nghiệm; điểm tin cậy không phải xác suất đúng đã được hiệu chuẩn. Tính nhất quán trong hệ tọa độ toàn ảnh được so sánh với mức nhiễu giải mã đã khai báo của nguồn là ±{{noise}} mức{{margin}}.',
      marginLossy: ' (chừa sai số cho viền giả (ringing) và phục hồi tín hiệu màu của video nén mất dữ liệu)',
      marginLossless: ' (nguồn không mất dữ liệu, so sánh chính xác từng điểm ảnh)',
      action: 'Khi tỷ lệ hoặc cấu trúc không tương thích, công cụ giữ thành mảnh riêng thay vì ép ghép các trạng thái không khớp.',
    },
    APPROXIMATE_DECODER: {
      message:
        'Đã chọn chế độ “Gần đúng · trình phát có sẵn” ở {{fps}} Hz. Không bảo đảm lấy được mọi khung hình của video; nội dung xuất hiện thoáng qua có thể bị thiếu.',
      action: 'Nếu cần bảo đảm xử lý từng khung hình, hãy dùng đầu vào mà WebCodecs hỗ trợ, như H.264 hoặc VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'Ảnh phân tích chuyển động có cạnh dài tối đa {{size}}px. Tinh chỉnh và ghép cuối cùng vẫn dùng điểm ảnh ở độ phân giải gốc, nên ảnh đầu ra không bị thu nhỏ theo.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Một khung hình gốc cùng các khung hình tham chiếu gần chạm giới hạn bộ đệm đã chọn. Giới hạn bộ đệm JavaScript không kiểm soát bộ nhớ riêng của codec và GPU.',
      action: 'Độ phân giải đầu ra không bị âm thầm giảm. Khi thiếu bộ nhớ, dữ liệu đã lưu được giữ lại và lỗi được báo rõ.',
    },
    RUN_FAILURE: { action: 'Các ô ảnh đã lưu vào bộ nhớ cục bộ vẫn xem và xuất được. Lượt xử lý lỗi không được đánh dấu là thành công.' },
    PERSISTENCE_ERROR: { action: 'Ghi vào bộ nhớ cũng thất bại. Chỉ có thể khôi phục dữ liệu đã lưu thành công trước đó.' },
    MEMORY_BUDGET_RAISED: {
      message: 'Đã tăng bộ đệm từ giới hạn {{from}} ô ảnh lên {{to}} ô (khoảng {{mb}} MB), để chứa đủ mọi ô mà một khung hình chạm tới.',
      action:
        'Nếu bộ đệm nhỏ hơn phạm vi của một khung hình, mỗi khung hình sẽ buộc phải giải mã rồi mã hóa lại toàn bộ ô ảnh liên quan. Hãy giảm độ phân giải bản quay để dùng ít bộ nhớ hơn.',
    },
    NONFINITE_POSE: {
      message:
        'Phép tính vị trí sinh ra giá trị không hữu hạn. Lần quan sát này được tách riêng; tọa độ không hợp lệ không được ghi vào vùng ảnh.',
    },
    MISSING_PLAN: {
      message: 'Bước dựng ảnh thiếu plan/{{index}}, nên đã dừng ở phần dựng xong và lưu thành công.',
      action: 'Hãy kiểm tra tính toàn vẹn của bộ nhớ cục bộ. Kế hoạch định vị bị thiếu không được coi là một lần quan sát rỗng.',
    },
    prefixOnly: {
      base: {
        scan: 'Tiếp tục định vị và ghép chỉ với {{frames}} khung hình đã giải mã',
        solve: 'Tiếp tục dựng ảnh chỉ với {{frames}} khung hình đã tính được vị trí',
        render: 'Chỉ giữ kết quả của {{frames}} khung hình đã dựng',
      },
      suffixPersistence: '; việc ghi vào bộ nhớ đã dừng.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action: 'Đã bỏ qua bản có viền của vùng ảnh này. Kết quả tái dựng chính theo tọa độ trang không bị ảnh hưởng.',
    },
    PRESENTATION_FRAME: {
      message:
        'Bản có viền và nội dung 2D gốc được giữ riêng. Viền lấy từ một khung hình tham chiếu; phần kéo dài chỉ là nền trang trí, không tính là nội dung đã quan sát. Biểu tượng trên thanh công cụ không bị kéo giãn hay nhân bản. Các khung khác bên trong viền chỉ là ảnh chụp tại thời điểm tham chiếu.',
    },
    PRESENTATION_STAGE_FAILED: {
      action: 'Tạo bản có viền thất bại. Kết quả và trạng thái tái dựng chính theo tọa độ trang không bị ảnh hưởng.',
    },
    PYRAMID_FAILED: { action: 'Không tạo được hệ ảnh xem trước nhiều mức. Các ô ảnh gốc không bị ảnh hưởng và vẫn xem, xuất được.' },
    PASS_FRAME_COUNT_MISMATCH: {
      message: 'Bước {{pass}} chỉ hoàn tất {{actual}}/{{expected}} khung hình; kết quả được đánh dấu là chưa đầy đủ.',
      action: 'Đã giữ phần lưu thành công. Khung hình bị thiếu không bị âm thầm coi là đã xử lý.',
    },
    FRAME_CONVERSION: { message: 'Mỗi khung hình đã giải mã được chuyển thành điểm ảnh bằng: {{method}}.' },
    HDR_UNCHECKED: {
      message:
        'Đây là bản quay HDR ({{transfer}}), nhưng trình duyệt không cho kiểm tra phép chuyển đổi màu. Ảnh kết quả có thể bị tối hoặc bạc màu.',
      action: 'Hãy chạy lại bằng Chrome hoặc Safari mới nhất.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'Trong khung hình đầu của bản quay HDR này, {{percent}}% điểm ảnh sáng hơn màu trắng thông thường và được tính là trắng. Nếu ảnh bị cháy sáng, có thể ứng dụng quay đã đặt màu trắng thông thường ở độ sáng cao hơn.',
      action: 'Đặt mức trắng SDR của ứng dụng quay về 100 nit, hoặc tắt quay HDR.',
    },
    SLOW_CONVERSION: {
      message:
        'Trình duyệt này cần khoảng {{ms}} ms để chuyển mỗi khung hình thành điểm ảnh, nên riêng bước chuyển đổi sẽ mất khoảng {{minutes}} phút.',
      action: 'Chrome hoặc Safari mới nhất nhanh hơn nhiều. Chuyển bản quay sang H.264 trước cũng có thể giúp ích.',
    },
    REVEAL_SKIPPED: {
      message:
        'Có quá nhiều vùng ảnh hoặc vùng ảnh quá lớn. Việc loại bỏ con trỏ, nút nổi và thanh cuộn cần thêm khoảng {{need}} MB so với bộ nhớ còn lại, nên bước này được bỏ qua và giữ nguyên điểm ảnh đã ghép.',
      action:
        'Phần còn lại của kết quả không bị ảnh hưởng. Nhiều vùng ảnh thường có nghĩa là một số đoạn không ghép được vào nội dung trước đó. Hãy thử bản quay ngắn hơn hoặc máy có nhiều bộ nhớ hơn.',
    },
    COMPUTE_BACKEND: { message: '{{backend}} — {{reason}}. Lõi Rust: bản {{variant}}, số luồng tính toán: {{threads}} ({{coreReason}}).' },
    PRESENTATION_REFERENCE_FAILED: { action: 'Sẽ bỏ qua bản có viền. Kết quả tái dựng chính theo tọa độ trang không bị ảnh hưởng.' },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'Khung hình thiếu họa tiết có thể nhận diện. Các khung hình trống giống nhau có thể xuất hiện khi dừng lại hoặc khi di chuyển trên vùng trống; chỉ dựa vào điểm ảnh thì không thể phân biệt.',
      action:
        'Hãy đưa nội dung dễ phân biệt vào màn hình hoặc quay với nhiều phần chồng lấp hơn. Độ dịch chuyển bằng 0 ở đây chỉ là ước đoán.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Lần quan sát này thiếu căn cứ hình ảnh đủ tin cậy để căn chỉnh. Bước tính vị trí sẽ thử đối chiếu với những lần quan sát trước; nếu vẫn chưa định vị được, phần này được giữ thành mảnh riêng.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'Phát hiện họa tiết lặp lại với nhiều vị trí khớp hợp lý như nhau. Tính liên tục chỉ là gợi ý khi đặt vị trí, không chứng minh được một vị trí duy nhất.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message: 'Khung hình này kéo dài bất thường. Có thể có vùng chưa từng được ghi lại trong lúc di chuyển nhanh.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'Phần nằm ngoài các vùng đánh dấu thủ công được giữ thành lớp quan sát riêng có độ tin cậy thấp theo tọa độ màn hình. Không coi những điểm ảnh này là đã được khôi phục về tọa độ trang.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Vùng “bỏ qua” được loại theo thiết lập thủ công. Vùng này không đóng góp vào kết quả tái dựng; đây không phải khung hình bị tự động bỏ sót.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Khi các vùng thủ công chồng nhau, vùng vẽ sau được ưu tiên. Vùng bỏ qua luôn bị loại. Điểm ảnh còn lại được giữ trong lớp quan sát chưa chỉ định.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Tự động tách thành {{moving}} vùng nội dung và {{fixed}} vùng giao diện cố định. Ranh giới được suy ra từ thống kê chuyển động điểm ảnh, không phải DOM.',
      action: 'Nếu phân vùng có vẻ sai, hãy vẽ chính xác vùng cuộn trong “Vùng di chuyển độc lập” rồi xử lý lại.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: 'Mỗi vùng cuộn độc lập được ghép thành một vùng ảnh riêng, không bị ép dùng chung một độ dịch chuyển khi cuộn.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Sau khi căn chỉnh khung hình này, toàn bộ phần chồng lấp có tổng cộng {{conflicts}} điểm ảnh khác biệt rõ rệt. Vùng này là một phần trong số đó. Nguyên nhân có thể là hoạt ảnh, nội dung cập nhật, bố cục thay đổi hoặc sai số căn chỉnh còn lại.',
      actionStable:
        'Khi có thể, toàn bộ vùng khác biệt được cố định vào một thời điểm. Hãy xem dấu chẩn đoán màu cam và thời điểm tương ứng trong video gốc.',
      actionRolling:
        'Chỉ khi toàn bộ vùng khác biệt hiện rõ, vùng đó mới được cập nhật cùng một khung hình. Điều này không có nghĩa là cả trang thuộc cùng một thời điểm.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Vùng thay đổi này chưa từng xuất hiện trọn vẹn trong một khung nhìn dùng được. Không thể bảo đảm mọi điểm ảnh của nó đều thuộc cùng một thời điểm.',
      action: 'Đã giữ nội dung quan sát được và đánh dấu rõ chỗ không khớp. Phần chưa quan sát không được tự tạo thêm.',
    },
    MISSING_SCAN_RECORD: {
      message: 'Bước tính vị trí thiếu scan/{{index}}, nên đã dừng ở phần tính xong và lưu thành công.',
      action: 'Hãy kiểm tra tính toàn vẹn của bộ nhớ cục bộ. Bản ghi quét bị thiếu không được coi là độ dịch chuyển bằng 0.',
    },
    GRAPH_RESIDUAL: {
      message: 'Đồ thị vị trí còn sai số dư tối đa {{residual}} điểm ảnh gốc. Mối nối gần đó có thể bị lệch hình học.',
      action: 'Hãy kiểm tra chữ và họa tiết lặp gần vị trí quay lại. Sai số dư này được báo rõ, không bị che giấu.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Khoảng {{percent}}% khối họa tiết không khớp với độ dịch chuyển chung, có thể do hoạt ảnh, video, tải nội dung muộn hoặc bố cục đổi. Độ dịch chuyển được tính từ các khối nhất quán; vùng không khớp được xử lý riêng khi ghép ảnh.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'Khoảng dịch chuyển giữa các khung hình lớn, chỉ còn ít phần chồng lấp để căn chỉnh. Độ dịch chuyển được suy ra từ căn cứ hạn chế này. Với bố cục lặp lại theo chu kỳ, phần lặp bên cạnh cũng có thể tạo ra cùng những điểm ảnh đó.',
      action: 'Nếu lần quay lại sau cung cấp căn cứ chắc chắn hơn, toàn bộ đoạn quỹ đạo này sẽ được hiệu chỉnh và ghi lại.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'Họa tiết lặp lại khiến nhiều độ dịch chuyển đều phù hợp với điểm ảnh. Công cụ chọn phương án nhất quán nhất với chuyển động liên tục; đây là ước đoán, không phải cách căn chỉnh đúng duy nhất.',
      messageLowConfidence:
        'Vùng này được đặt theo vị trí ước tính có độ tin cậy thấp. Điểm ảnh liên quan đã được đánh dấu trên bản đồ chất lượng.',
      messageStatic:
        'Hai khung hình gần như giống nhau nhưng không có đặc điểm tương ứng có thể xác minh. Công cụ tạm coi là dừng lại, với độ dịch chuyển bằng 0.',
      action: 'Vị trí được ước tính từ quỹ đạo liên tục và điểm neo hiện có. Công cụ không khẳng định đây là cách căn chỉnh đúng duy nhất.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'Vùng này của khung hình không có họa tiết nhận diện được. Màn hình trống có thể là đang dừng hoặc đang di chuyển qua vùng trống; chỉ dựa vào điểm ảnh thì không thể phân biệt. Khung hình này không được vẽ vào đâu.',
      action:
        'Nếu nội dung sau đoạn trống không chồng lấp được với quan sát trước đó, nó được giữ thành mảnh riêng thay vì đoán khoảng cách ở giữa.',
    },
    RELOCALIZED: {
      message:
        'Đã tìm lại vị trí trên vùng ảnh từng quan sát nhờ điểm neo hình ảnh trước đó. Nội dung quay lại không bị nối thêm thành phần mở rộng mới của ảnh.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Phát hiện thay đổi tỷ lệ hoặc bố cục khoảng {{scale}}×. Phần này được giữ thành mảnh riêng ở điểm ảnh gốc, không âm thầm trộn thêm ảnh đã đổi tỷ lệ.',
      action:
        'Chưa xác nhận được quan hệ giữa các mảnh. Nếu lần quay lại sau khớp đủ tin cậy, cả mảnh sẽ được nối lại. Hãy ghi hình lại với nhiều phần chồng lấp hơn, hoặc tách phần đang thay đổi bằng vùng thủ công.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'Không xác nhận được vị trí so với vùng ảnh gốc, nên phần này được giữ thành mảnh độc lập và có thể xuất riêng. Hai mảnh có thể chồng nhau, hoặc thực sự có khoảng trống ở giữa.',
      action:
        'Chưa xác nhận được quan hệ giữa các mảnh. Nếu lần quay lại sau khớp đủ tin cậy, cả mảnh sẽ được nối lại. Hãy ghi hình lại với nhiều phần chồng lấp hơn, hoặc tách phần đang thay đổi bằng vùng thủ công.',
    },
    STICKY_OCCLUSION: {
      message:
        'Họa tiết ở đầu khung hình cho thấy đây là giao diện cố định theo màn hình, không phải trang đang di chuyển. Phần che phủ cố định này không được ghi vào vùng ảnh chuyển động. Giao diện tham chiếu gốc vẫn được giữ trong bản có viền.',
    },
    FRAGMENT_ATTACHED: {
      message: 'Căn cứ từ lần quay lại đã nối toàn bộ mảnh độc lập vào vùng ảnh hiện có. Quỹ đạo tương đối bên trong mảnh không thay đổi.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'Bước trước chỉ có ít phần chồng lấp. Vị trí khớp của khung hình này với nội dung đã quan sát lệch {{discrepancy}}px nhưng có căn cứ chắc hơn, nên vị trí hiện tại được sửa theo kết quả khớp này.',
      action:
        'Chỉ khung hình này và quỹ đạo phía sau được sửa. Điểm ảnh đã ghi trước đó giữ nguyên, nên có thể thấy đường nối với tọa độ đã hiệu chỉnh.',
    },
    LOOP_CLOSURE: {
      message: 'Đã xác nhận lần quay lại vị trí cũ và thêm vào ràng buộc vị trí toàn cục. Bước ghép cuối dùng quỹ đạo đã hiệu chỉnh.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'Vị trí khớp với khung hình cũ lệch {{discrepancy}}px so với quỹ đạo liên tục. Do căn cứ mâu thuẫn, vị trí này không được ép thành ràng buộc quay lại.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'Tìm kiếm trong các khung hình cũ trả về nhiều vị trí gần như hợp lý ngang nhau. Vị trí quay lại chưa chắc chắn không được áp thành ràng buộc cứng.',
    },
  },
  progress: {
    runPartial: 'Đã lưu phần tái dựng và ghi rõ đây là kết quả chưa đầy đủ.',
    runComplete: 'Tái dựng hoàn tất. Hãy xem thông tin chẩn đoán và những vùng chưa được quan sát.',
    render: 'Đang ghép ô ảnh ở kích thước gốc từ nội dung đã quan sát. Khoảng trống được giữ trong suốt.',
    reveal: {
      learn: 'Đang xem lại bản quay để tìm nút, ô nhập liệu và thanh cuộn nổi trên trang.',
      agree: 'Đang so sánh từng phần của trang theo thời gian và ưu tiên hình ảnh không bị che.',
      relearn: 'Đang tìm lại các thành phần nổi dựa trên trang đã kiểm tra.',
      write: 'Đang thay vùng bị che hoặc không khớp bằng khung hình không bị che.',
    },
    framingStart: 'Đang giữ viền gốc và chỉ mở rộng phần nền, không kéo giãn chữ ở thanh bên hay nhân bản biểu tượng.',
    pyramidBuild: 'Đang tạo hệ ảnh xem trước nhiều mức trên đĩa. Các ô ảnh gốc giữ nguyên.',
    scanFrame: 'Đang thu thập căn cứ hình học từng khung hình và nhận diện vùng di chuyển độc lập.',
    duplicateReuse: 'Quan sát giống hệt dùng lại vị trí trước đó. Khung hình nguồn và dấu thời gian vẫn được giữ.',
    solveFrame: 'Đang tinh chỉnh theo điểm ảnh gốc, định vị lại bằng ảnh cũ và áp dụng ràng buộc quay lại trong 2D.',
    optimizing: 'Đang tối ưu đồ thị vị trí trên đĩa và hiệu chỉnh sai lệch tại những chỗ quay lại.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: trình duyệt này không giải mã được codec của bản quay ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'Bản quay trên iPhone và Mac thường dùng HEVC, chỉ một số trình duyệt giải mã được. Hãy dùng Safari, hoặc Chrome/Edge có giải mã phần cứng.',
      prores: 'Trình duyệt không giải mã được ProRes. Hãy xuất bản quay sang H.264 hoặc HEVC trước.',
      h264: 'Chỉ Chrome giải mã được loại H.264 này (4:4:4 hoặc 10 bit). Hãy dùng Chrome hoặc xuất sang H.264 thông thường.',
      av1: 'AV1 cần trình duyệt hoặc phần cứng mới. Hãy dùng Chrome mới nhất hoặc xuất bản quay sang H.264.',
      other: 'Hãy dùng Chrome hoặc Safari mới nhất, hoặc chuyển bản quay sang H.264 trước.',
    },
    PIXEL_ASPECT_RATIO:
      'Bản quay khai báo tỷ lệ điểm ảnh {{num}}:{{den}}. Điểm ảnh đã lưu được giữ nguyên, không đổi tỷ lệ, nên hình dạng hiển thị có thể khác.',
    CONTAINER_SIZE_MISMATCH:
      'Tệp chứa khai báo {{codedWidth}}×{{codedHeight}}, nhưng luồng bit thực tế là {{bitstreamWidth}}×{{bitstreamHeight}}. Công cụ dùng kích thước của luồng bit.',
    NON_SQUARE_PIXELS:
      'Bản quay khai báo điểm ảnh không vuông (kích thước hiển thị {{displayWidth}}×{{displayHeight}}, kích thước lưu {{bitstreamWidth}}×{{bitstreamHeight}}). Điểm ảnh gốc đã lưu được giữ nguyên, không đổi tỷ lệ.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'Bộ giải mã tạo khung hình trước điểm bắt đầu của danh sách biên tập, có dấu thời gian âm. Các khung hình này không được hiển thị theo quy tắc của tệp chứa.',
    NONMONOTONIC_TIMESTAMP:
      'Dấu thời gian trong tệp chứa đi lùi. Quá trình tiếp tục theo thứ tự hiển thị của bộ giải mã và không bỏ quan sát nào.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: Hộp ctts của luồng video này là phiên bản 0 nhưng có độ lệch thời gian hiển thị âm. ISO 14496-12 chỉ định nghĩa độ lệch âm ở phiên bản 1. Các giá trị được xử lý như số có dấu theo cách dùng phổ biến của QuickTime/ReplayKit, không phải số dương lớn bất thường.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: Tệp kết thúc giữa hộp {{box}}. Hộp khai báo điểm cuối ở byte {{declaredEnd}}, nhưng tệp chỉ có {{size}} byte. Bản quay có thể chưa kết thúc đúng cách hoặc tệp bị cắt trong lúc sao chép hay truyền. Không thể giải mã khung hình sau chỗ bị cắt, nên số khung hình quét được ít hơn siêu dữ liệu và kết quả sẽ được đánh dấu là chưa đầy đủ.',
  },
  exports: {
    tilesProgress: 'Đang xuất ô ảnh gốc và ô xem trước {{n}}',
    zipFinalize: 'Đang ghi thư mục ZIP64 và hoàn tất lưu tệp',
    projectDone: {
      message:
        'Đã xuất ô ảnh gốc, trình xem ngoại tuyến, dữ liệu phạm vi ghi hình và chất lượng, bản ghi khung hình nguồn, cùng toàn bộ chẩn đoán.',
    },
    encodingSingle: 'Đang mã hóa hàng {{row}} / {{total}} ở kích thước gốc',
    canvasDone: { message: 'Đã xuất PNG {{width}} × {{height}} ở kích thước gốc. Khoảng trống vẫn trong suốt.' },
    encodingSheet: 'Đã mã hóa {{count}} ảnh từng phần ở kích thước gốc',
    sheetsDone: {
      messagePaged:
        'Đã xuất thành {{count}} ảnh từng phần ở kích thước gốc. Các phần liền kề chồng lên nhau tối đa {{overlap}}px, với tọa độ trong tệp kê khai.',
      messageOversize:
        'Vùng ảnh vượt kích thước tương thích cho một ảnh, nên đã xuất thành {{count}} ảnh từng phần ở kích thước gốc. Các phần liền kề chồng lên nhau tối đa {{overlap}}px, với tọa độ trong tệp kê khai.',
    },
  },
  offline: {
    title: 'Vùng ảnh ngoại tuyến',
    fit: 'Xem toàn bộ',
    tip: 'Ô ảnh gốc trên thiết bị · kéo để di chuyển / cuộn để thu phóng',
    previewLevel: 'Đang xem mức {{level}}. Phóng to để xem điểm ảnh gốc',
    nativeTiles: 'Đang hiển thị ô ảnh ở kích thước gốc',
    footer:
      'Ô bàn cờ là phần chưa được quan sát hoặc không có ô ảnh. Độ tin cậy không phải xác suất đúng. Xem diagnostics.jsonl và observations.jsonl.',
  },
};
