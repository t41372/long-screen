import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'Rekonstruksi memakai lapisan kanvas yang bergeser, dengan batasan geometris dari kunjungan kembali ke tempat yang sama. Masker otomatis dan deteksi area dinamis merupakan perkiraan heuristik; nilai keyakinan bukan probabilitas kebenaran yang terkalibrasi. Konsistensi koordinat keseluruhan dibandingkan dengan toleransi derau dekode sumber sebesar ±{{noise}} tingkat{{margin}}.',
      marginLossy: ' (toleransi untuk artefak halo (ringing) dan rekonstruksi kroma pada video terkompresi)',
      marginLossless: ' (sumber lossless, perbandingan tepat piksel demi piksel)',
      action: 'Jika skala atau struktur tidak cocok, bagian tersebut disimpan sebagai fragmen terpisah, bukan dipaksakan menyatu.',
    },
    APPROXIMATE_DECODER: {
      message:
        'Mode “Perkiraan · pemutar bawaan” pada {{fps}} Hz telah dipilih. Tidak semua bingkai video dijamin terambil; konten yang muncul sesaat bisa terlewat.',
      action: 'Jika setiap bingkai harus diproses, gunakan format yang didukung WebCodecs, seperti H.264 atau VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'Analisis gerak memakai gambar dengan sisi panjang maksimal {{size}}px. Penyempurnaan dan penggabungan akhir tetap memakai piksel resolusi asli, sehingga hasil tidak ikut diperkecil.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Satu bingkai berukuran asli beserta bingkai acuannya hampir memenuhi batas cache yang dipilih. Memori codec dan GPU tidak dikendalikan oleh batas cache JavaScript.',
      action:
        'Resolusi hasil tidak akan diturunkan diam-diam. Jika memori tidak cukup, data yang sudah tersimpan dipertahankan dan kegagalan dilaporkan.',
    },
    RUN_FAILURE: {
      action:
        'Petak yang sudah tersimpan di penyimpanan lokal tetap dapat dilihat dan diekspor. Kegagalan ini tidak ditandai sebagai keberhasilan.',
    },
    PERSISTENCE_ERROR: { action: 'Penulisan ke penyimpanan juga gagal. Hanya data yang tersimpan sebelumnya yang dapat dipulihkan.' },
    MEMORY_BUDGET_RAISED: {
      message:
        'Cache diperbesar dari batas {{from}} petak menjadi {{to}} petak (sekitar {{mb}} MB), agar semua petak yang disentuh satu bingkai dapat ditampung.',
      action:
        'Jika cache lebih kecil dari cakupan satu bingkai, semua petaknya harus didekode dan dikodekan ulang pada setiap bingkai. Turunkan resolusi rekaman untuk mengurangi penggunaan memori.',
    },
    NONFINITE_POSE: {
      message:
        'Perhitungan posisi menghasilkan nilai yang tidak terbatas atau tidak valid. Pengamatan ini dipisahkan; koordinat yang tidak valid tidak ditulis ke kanvas.',
    },
    MISSING_PLAN: {
      message: 'Tahap perenderan tidak menemukan plan/{{index}} dan berhenti pada bagian yang sudah tersimpan.',
      action: 'Periksa keutuhan penyimpanan lokal. Rencana posisi yang hilang tidak dianggap sebagai pengamatan kosong.',
    },
    prefixOnly: {
      base: {
        scan: 'Melanjutkan penempatan dan penggabungan hanya dengan {{frames}} bingkai yang sudah didekode',
        solve: 'Melanjutkan perenderan hanya dengan {{frames}} bingkai yang posisinya sudah dihitung',
        render: 'Mempertahankan hasil hanya untuk {{frames}} bingkai yang sudah dirender',
      },
      suffixPersistence: '; penulisan ke penyimpanan telah berhenti.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action: 'Tampilan berbingkai kanvas ini dilewati. Rekonstruksi inti dalam koordinat halaman tidak terpengaruh.',
    },
    PRESENTATION_FRAME: {
      message:
        'Tampilan berbingkai dan konten 2D asli disimpan terpisah. Bingkai berasal dari satu bingkai acuan. Bagian yang diperluas hanya berupa latar dekoratif, bukan konten yang benar-benar diamati. Ikon bilah alat tidak diregangkan atau digandakan. Panel lain di dalam bingkai hanya berupa cuplikan acuan.',
    },
    PRESENTATION_STAGE_FAILED: {
      action: 'Pembuatan tampilan berbingkai gagal. Hasil dan status rekonstruksi inti dalam koordinat halaman tidak terpengaruh.',
    },
    PYRAMID_FAILED: {
      action: 'Pembuatan pratinjau bertingkat gagal. Petak berukuran asli tidak terpengaruh dan tetap dapat dilihat serta diekspor.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: 'Tahap {{pass}} hanya menyelesaikan {{actual}} dari {{expected}} bingkai. Hasil ditandai sebagai sebagian.',
      action: 'Bagian yang berhasil disimpan tetap dipertahankan. Bingkai yang hilang tidak dianggap sudah diproses.',
    },
    FRAME_CONVERSION: { message: 'Setiap bingkai hasil dekode diubah menjadi piksel dengan: {{method}}.' },
    HDR_UNCHECKED: {
      message:
        'Ini rekaman HDR ({{transfer}}), tetapi browser tidak menyediakan cara untuk memeriksa konversi warnanya. Hasil mungkin tampak gelap atau pudar.',
      action: 'Jalankan kembali di Chrome atau Safari terbaru.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'Pada bingkai pertama rekaman HDR ini, {{percent}}% piksel lebih terang dari putih biasa dan diperlakukan sebagai putih. Jika hasil tampak terlalu terang, perekam kemungkinan mengatur putih biasa pada kecerahan yang lebih tinggi.',
      action: 'Kembalikan pengaturan putih SDR pada perekam ke 100 nit, atau matikan perekaman HDR.',
    },
    SLOW_CONVERSION: {
      message:
        'Browser ini membutuhkan sekitar {{ms}} milidetik untuk mengubah setiap bingkai menjadi piksel. Konversi saja diperkirakan memakan waktu {{minutes}} menit.',
      action: 'Chrome atau Safari terbaru jauh lebih cepat. Mengonversi rekaman ke H.264 terlebih dahulu juga bisa membantu.',
    },
    REVEAL_SKIPPED: {
      message:
        'Jumlah kanvas terlalu banyak atau ukurannya terlalu besar. Pembersihan elemen penutup seperti kursor, tombol mengambang, dan bilah gulir membutuhkan sekitar {{need}} MB lebih banyak dari memori yang tersisa. Tahap ini dilewati dan piksel hasil gabungan tetap dipertahankan.',
      action:
        'Bagian hasil lainnya tidak terpengaruh. Banyaknya kanvas biasanya berarti sebagian rekaman tidak bisa disambungkan ke bagian sebelumnya. Coba rekaman yang lebih pendek atau komputer dengan memori lebih besar.',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}. Inti Rust: varian {{variant}}, thread komputasi: {{threads}} ({{coreReason}}).',
    },
    PRESENTATION_REFERENCE_FAILED: {
      action: 'Tampilan berbingkai akan dilewati. Rekonstruksi inti dalam koordinat halaman tidak terpengaruh.',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'Bingkai tidak memiliki pola yang dapat dikenali. Bingkai kosong yang sama bisa muncul saat berhenti maupun saat bergerak di area kosong. Piksel saja tidak bisa membedakannya.',
      action:
        'Sertakan konten yang bisa dibedakan atau rekam dengan lebih banyak tumpang tindih. Perpindahan nol di sini hanyalah perkiraan.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Pengamatan ini tidak memiliki dasar visual yang andal untuk penyelarasan. Tahap penentuan posisi akan mencoba mencocokkan dengan pengamatan sebelumnya. Jika tetap tidak bisa ditempatkan, bagian ini disimpan sebagai fragmen terpisah.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'Terdeteksi pola berulang dengan beberapa posisi yang sama masuk akalnya. Kesinambungan gerak hanya menjadi petunjuk posisi, bukan bukti satu posisi yang pasti.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message: 'Bingkai ini berlangsung jauh lebih lama dari biasanya. Mungkin ada bagian yang tidak pernah terekam saat gerakan cepat.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'Bagian di luar area manual disimpan sebagai lapisan pengamatan terpisah dengan keyakinan rendah dalam koordinat layar. Piksel ini tidak dinyatakan sudah dipulihkan ke koordinat halaman.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Area “abaikan” dikeluarkan sesuai pengaturan manual. Area tersebut tidak berkontribusi pada rekonstruksi; ini bukan bingkai yang terlewat secara otomatis.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Jika area manual bertumpang tindih, area yang digambar belakangan diutamakan. Area yang diabaikan selalu dikeluarkan. Piksel sisanya disimpan dalam lapisan pengamatan yang belum ditentukan.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Dipisahkan otomatis menjadi {{moving}} area konten dan {{fixed}} area UI tetap. Batasnya ditentukan dari statistik gerak piksel, bukan DOM.',
      action: 'Jika pembagian area tampak salah, gambar area gulir yang tepat di “Area gerak terpisah”, lalu proses ulang.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: 'Setiap area gulir independen akan mendapat kanvas terpisah. Semuanya tidak dipaksa memakai jarak gulir yang sama.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Setelah bingkai ini diselaraskan, seluruh area tumpang tindih memiliki {{conflicts}} piksel yang berbeda jelas. Area ini adalah salah satu bagian yang berbeda tersebut. Penyebabnya bisa berupa animasi, pembaruan konten, perubahan tata letak, atau sisa galat penyelarasan.',
      actionStable:
        'Sebisa mungkin, seluruh area yang berbeda dikunci pada satu momen. Periksa diagnostik berwarna oranye dan waktu terkait pada video asli.',
      actionRolling:
        'Seluruh area yang berbeda hanya diperbarui dengan satu bingkai saat terlihat utuh. Ini tidak berarti seluruh halaman berasal dari momen yang sama.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Area yang berubah ini tidak pernah terlihat utuh dalam satu tampilan yang dapat digunakan. Tidak semua pikselnya dijamin berasal dari momen yang sama.',
      action: 'Konten yang teramati dan penanda perbedaannya tetap disimpan. Bagian yang tidak terlihat tidak dibuat-buat.',
    },
    MISSING_SCAN_RECORD: {
      message: 'Tahap penentuan posisi tidak menemukan scan/{{index}} dan berhenti pada bagian yang sudah tersimpan.',
      action: 'Periksa keutuhan penyimpanan lokal. Catatan pemindaian yang hilang tidak dianggap sebagai perpindahan nol.',
    },
    GRAPH_RESIDUAL: {
      message:
        'Graf posisi masih memiliki sisa galat maksimum {{residual}} piksel asli. Sambungan di sekitarnya mungkin menunjukkan ketidakselarasan geometris.',
      action: 'Periksa teks dan pola berulang di sekitar tempat yang dikunjungi kembali. Sisa galat ini tidak disembunyikan.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Sekitar {{percent}}% blok berpola tidak sesuai dengan perpindahan keseluruhan, mungkin karena animasi, video, pemuatan tertunda, atau perubahan tata letak. Perpindahan ditentukan dari blok yang konsisten, sementara area yang berbeda ditangani terpisah saat penggabungan.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'Perpindahan antarbingkai terlalu cepat sehingga hanya sedikit area yang bertumpang tindih untuk penyelarasan. Perpindahan dihitung dari bukti yang terbatas ini. Pada tata letak berulang, bagian berulang di sebelahnya juga bisa cocok dengan piksel yang sama.',
      action: 'Jika kunjungan berikutnya memberi bukti yang lebih kuat, seluruh segmen lintasan ini akan dikoreksi dan dicatat.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'Pola berulang memungkinkan beberapa perpindahan yang cocok dengan piksel. Dipilih yang paling sesuai dengan kesinambungan gerak, tetapi itu perkiraan, bukan satu-satunya penyelarasan yang benar.',
      messageLowConfidence: 'Area ini ditempatkan dengan perkiraan berkeyakinan rendah. Piksel terdampak ditandai pada peta kualitas.',
      messageStatic:
        'Kedua bingkai hampir identik, tetapi kecocokan cirinya tidak dapat diverifikasi. Dianggap berhenti dengan perpindahan nol, sebagai perkiraan.',
      action:
        'Lintasan yang berkesinambungan dan acuan yang tersedia dipakai untuk memperkirakan posisi. Penyelarasan ini tidak dinyatakan sebagai satu-satunya yang benar.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'Area pada bingkai ini tidak memiliki pola yang dapat dikenali. Tampilan kosong bisa berarti berhenti atau bergerak di area kosong, dan piksel saja tidak bisa membedakannya. Bingkai ini tidak digambar di mana pun.',
      action:
        'Jika konten setelah bagian kosong tidak bisa bertumpang tindih dengan pengamatan sebelumnya, konten disimpan sebagai fragmen terpisah tanpa menebak jarak di antaranya.',
    },
    RELOCALIZED: {
      message:
        'Posisi ditemukan kembali pada kanvas yang sudah diamati melalui acuan visual sebelumnya. Konten yang dikunjungi ulang tidak ditambahkan sebagai perluasan gambar baru.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Terdeteksi perubahan skala atau tata letak sekitar {{scale}}×. Bagian ini disimpan sebagai fragmen terpisah dengan piksel asli; perubahan skala tidak dicampurkan diam-diam.',
      action:
        'Hubungan antarfragmen belum dipastikan. Jika kunjungan berikutnya cocok dengan andal, fragmen akan disambungkan kembali secara utuh. Rekam ulang dengan lebih banyak tumpang tindih, atau pisahkan komponen yang berubah lewat area manual.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'Posisi terhadap kanvas asli tidak dapat dipastikan. Bagian ini disimpan sebagai fragmen terpisah yang dapat diekspor sendiri. Kedua fragmen mungkin bertumpang tindih atau memang memiliki celah di antaranya.',
      action:
        'Hubungan antarfragmen belum dipastikan. Jika kunjungan berikutnya cocok dengan andal, fragmen akan disambungkan kembali secara utuh. Rekam ulang dengan lebih banyak tumpang tindih, atau pisahkan komponen yang berubah lewat area manual.',
    },
    STICKY_OCCLUSION: {
      message:
        'Pola di bagian atas bingkai menunjukkan UI yang tetap pada layar, bukan gerakan halaman. Bagian penutup yang tetap ini tidak ditulis ke kanvas bergerak. UI acuan asli tetap disimpan dalam tampilan berbingkai.',
    },
    NESTED_LAYER_FOUND: {
      message: 'Sebagian wilayah ini menggulir sendiri: dalam {{frames}} bingkai isinya tidak ikut bergerak bersama wilayah.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'Bukti dari kunjungan ulang menyambungkan seluruh fragmen terpisah ke kanvas yang sudah ada. Lintasan relatif di dalam fragmen tidak berubah.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'Langkah sebelumnya hanya memiliki sedikit tumpang tindih. Pencocokan bingkai ini dengan konten yang sudah diamati berbeda {{discrepancy}}px dan buktinya lebih kuat. Posisi saat ini dikoreksi mengikuti kecocokan tersebut.',
      action:
        'Koreksi hanya berlaku pada bingkai ini dan lintasan setelahnya. Piksel yang sudah ditulis sebelumnya tidak berubah dan mungkin membentuk sambungan yang terlihat terhadap koordinat baru.',
    },
    LOOP_CLOSURE: {
      message:
        'Ditemukan kunjungan ulang yang andal ke lokasi sebelumnya dan ditambahkan sebagai batasan posisi keseluruhan. Penggabungan akhir memakai lintasan yang sudah dikoreksi.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'Kecocokan dengan pengamatan sebelumnya berbeda {{discrepancy}}px dari lintasan berkesinambungan. Karena buktinya bertentangan, kecocokan ini tidak dipaksakan sebagai batasan kunjungan ulang.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'Pencarian pada pengamatan sebelumnya menghasilkan beberapa posisi yang hampir sama masuk akalnya. Kunjungan ulang yang belum pasti tidak dijadikan batasan mutlak.',
    },
  },
  progress: {
    runPartial: 'Rekonstruksi sebagian telah disimpan dan ditandai sebagai hasil yang belum lengkap.',
    runComplete: 'Rekonstruksi selesai. Periksa diagnostik dan bagian yang tidak teramati.',
    render: 'Menggabungkan petak ukuran asli berdasarkan pengamatan. Bagian yang tidak terekam tetap transparan.',
    reveal: {
      learn: 'Memeriksa rekaman lagi untuk menemukan tombol, kolom input, dan bilah gulir yang mengambang di atas halaman.',
      agree: 'Membandingkan tampilan tiap bagian dari waktu ke waktu dan memilih tampilan yang tidak tertutup.',
      relearn: 'Mencari ulang elemen mengambang berdasarkan halaman yang sudah diperiksa.',
      write: 'Mengganti area yang tertutup atau tidak cocok dengan bingkai yang bersih.',
    },
    framingStart: 'Mempertahankan bingkai asli dan hanya memperluas latar, tanpa meregangkan teks bilah samping atau menggandakan ikon.',
    pyramidBuild: 'Membuat pratinjau bertingkat di disk. Petak berukuran asli tidak berubah.',
    scanFrame: 'Mengumpulkan bukti geometris tiap bingkai dan mempelajari area dengan gerakan terpisah.',
    duplicateReuse: 'Pengamatan identik memakai ulang posisi sebelumnya. Bingkai sumber dan penanda waktu tetap disimpan.',
    solveFrame: 'Menyempurnakan pada piksel asli, mencari posisi dari pengamatan sebelumnya, dan menerapkan batasan kunjungan ulang 2D.',
    optimizing: 'Mengoptimalkan graf posisi di disk dan mengoreksi pergeseran pada tempat yang dikunjungi kembali.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: browser ini tidak dapat mendekode codec rekaman ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'Rekaman iPhone dan Mac biasanya memakai HEVC, yang hanya didukung beberapa browser. Gunakan Safari, atau Chrome maupun Edge dengan dekode perangkat keras.',
      prores: 'Browser tidak mendukung dekode ProRes. Ekspor rekaman ke H.264 atau HEVC terlebih dahulu.',
      h264: 'Jenis H.264 ini (4:4:4 atau 10-bit) hanya dapat didekode oleh Chrome. Gunakan Chrome atau ekspor sebagai H.264 biasa.',
      av1: 'AV1 memerlukan browser atau perangkat keras terbaru. Gunakan Chrome terbaru atau ekspor rekaman sebagai H.264.',
      other: 'Gunakan Chrome atau Safari terbaru, atau konversikan rekaman ke H.264 terlebih dahulu.',
    },
    PIXEL_ASPECT_RATIO:
      'Rekaman menyatakan rasio aspek piksel {{num}}:{{den}}. Piksel tersimpan dipertahankan tanpa penskalaan, sehingga rasio tampilannya mungkin berbeda.',
    CONTAINER_SIZE_MISMATCH:
      'Kontainer menyatakan ukuran {{codedWidth}}×{{codedHeight}}, tetapi ukuran aliran bit sebenarnya {{bitstreamWidth}}×{{bitstreamHeight}}. Ukuran aliran bit yang digunakan.',
    NON_SQUARE_PIXELS:
      'Rekaman ini memakai piksel nonpersegi (ukuran tampilan {{displayWidth}}×{{displayHeight}}, ukuran tersimpan {{bitstreamWidth}}×{{bitstreamHeight}}). Piksel asli yang tersimpan dipertahankan tanpa penskalaan.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'Dekoder menghasilkan bingkai sebelum titik awal daftar penyuntingan, dengan penanda waktu negatif. Sesuai aturan kontainer, bingkai tersebut tidak ditampilkan.',
    NONMONOTONIC_TIMESTAMP:
      'Penanda waktu dalam kontainer bergerak mundur. Proses dilanjutkan menurut urutan tampilan dekoder, tanpa membuang pengamatan.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: Kotak ctts pada trek video ini memakai versi 0, tetapi berisi offset waktu komposisi negatif. ISO 14496-12 hanya mendefinisikan offset negatif pada versi 1. Nilai ini diperlakukan sebagai bilangan bertanda, mengikuti praktik umum QuickTime/ReplayKit, bukan sebagai offset positif yang sangat besar.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: File berakhir di dalam kotak {{box}}. Kotak tersebut menyatakan akhir pada byte {{declaredEnd}}, tetapi file hanya berisi {{size}} byte. Rekaman mungkin belum selesai dengan benar atau file terpotong saat disalin maupun ditransfer. Bingkai setelah titik terpotong tidak dapat didekode, sehingga jumlah yang ditemukan lebih sedikit daripada metadata dan hasil akan ditandai sebagai sebagian.',
  },
  exports: {
    tilesProgress: 'Mengekspor petak asli dan pratinjau {{n}}',
    zipFinalize: 'Menulis direktori ZIP64 dan menuntaskan penyimpanan file',
    projectDone: {
      message:
        'Petak berukuran asli, penampil offline, data cakupan dan kualitas, catatan bingkai sumber, serta diagnostik lengkap telah diekspor.',
    },
    encodingSingle: 'Mengodekan baris {{row}} dari {{total}} pada ukuran asli',
    canvasDone: { message: 'PNG ukuran asli {{width}} × {{height}} telah diekspor. Bagian yang tidak terekam tetap transparan.' },
    encodingSheet: '{{count}} gambar bagian berukuran asli telah dikodekan',
    sheetsDone: {
      messagePaged:
        'Diekspor menjadi {{count}} gambar bagian berukuran asli. Bagian yang bersebelahan bertumpang tindih hingga {{overlap}}px; koordinatnya tercatat dalam manifes.',
      messageOversize:
        'Kanvas melebihi ukuran yang kompatibel untuk satu gambar, sehingga diekspor menjadi {{count}} gambar bagian berukuran asli. Bagian yang bersebelahan bertumpang tindih hingga {{overlap}}px; koordinatnya tercatat dalam manifes.',
    },
  },
  offline: {
    title: 'Kanvas offline',
    fit: 'Lihat utuh',
    tip: 'Petak lokal berukuran asli · seret untuk menggeser / gulir untuk memperbesar',
    previewLevel: 'Menampilkan pratinjau tingkat {{level}}. Perbesar untuk melihat piksel asli',
    nativeTiles: 'Menampilkan petak berukuran asli',
    footer:
      'Pola kotak-kotak menandai bagian yang tidak teramati atau tidak memiliki petak. Nilai keyakinan bukan probabilitas kebenaran. Lihat diagnostics.jsonl dan observations.jsonl.',
  },
};
