import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Mengamati tiap bingkai dan memisahkan lapisan gerak',
      solving: 'Menentukan posisi keseluruhan dan menyempurnakan pada piksel asli',
      optimizing: 'Mengoreksi akumulasi pergeseran berdasarkan kunjungan ulang',
      rendering: 'Menggabungkan kanvas pada ukuran asli',
      revealing: 'Menghapus elemen yang mengambang di atas halaman',
      framing: 'Mempertahankan bingkai dan rasio aspek asli',
      pyramid: 'Membuat pratinjau yang dapat diperbesar',
      complete: 'Selesai · periksa diagnostik',
      partial: 'Hasil sebagian tersimpan',
      error: 'Terjadi kesalahan saat memproses',
    },
    count: {
      frames_one: '{{frames}} bingkai',
      frames_other: '{{frames}} bingkai',
      framesUnknown: 'Jumlah bingkai belum diketahui',
      regions_one: '{{count}} area manual ↗',
      regions_other: '{{count}} area manual ↗',
    },
    dom: {
      noCompressionStream:
        'Browser ini tidak mendukung CompressionStream untuk mengodekan petak berukuran asli menjadi PNG. Rekonstruksi tidak dapat dimulai.',
    },
    canvases: {
      badgePresentation: 'Tampilan berbingkai · latar tambahan bukan bukti pengamatan',
      badgeFixed: 'Lapisan tetap / pengamatan',
      badgeMoving: 'Lapisan konten 2D',
      badge_one: '{{kind}} · {{count}} petak ukuran asli{{fragment}}',
      badge_other: '{{kind}} · {{count}} petak ukuran asli{{fragment}}',
      fragmentNote: ' · posisi antarfragmen belum dipastikan selaras',
    },
    diagnostics: {
      occurrenceSuffix: ' ({{count}} kejadian sejenis)',
      locateAction: 'Lihat area terdampak / sumber ↗',
      viewSourceAction: 'Lihat momen aslinya ↗',
      emptyFiltered: 'Tidak ada catatan yang sesuai dengan filter ini.',
      emptyDefault: 'Dasar penentuan posisi, perubahan halaman, perkiraan, dan kesalahan proses akan muncul di sini.',
      noOriginalVideo:
        'Video asli tidak disertakan dalam proyek. Pilih kembali rekaman yang sama untuk melihat bingkai berdasarkan waktunya. Hasil gabungan tetap tersimpan di perangkat ini.',
      hashMismatch:
        'Nama dan ukuran file cocok, tetapi hash isinya berbeda dari rekaman sumber proyek ini, sehingga tidak dapat dipakai sebagai bukti bingkai asli. Pilih file rekaman yang benar.',
      sourceCaption: 'Bingkai sumber {{frame}} · {{time}} dtk · {{message}}',
    },
    export: {
      imageSuffix: '-tangkapan-layar',
      savePickerFallback: 'Penyimpanan langsung tidak tersedia. Beralih ke unduhan browser: {{error}}',
      saveRowLabel: 'Simpan {{name}} · {{size}}',
      shareLabel: 'Bagikan / simpan ke Foto',
      shareFailed: 'Tidak dapat membagikan: {{error}}',
      cleanupLabel: 'Hapus salinan sementara setelah menyimpan',
      exportErrorAction: 'Ekspor yang belum selesai tidak ditandai berhasil. Petak proyek yang sudah tersimpan tetap ada di perangkat ini.',
      clipboardUnsupported: 'Browser ini tidak dapat menyalin gambar. Gunakan “Simpan gambar”.',
      copyNoImage: 'Tidak ada gambar yang dihasilkan',
      copyFailedCtor: 'Tidak dapat menyalin: {{error}}. Gunakan “Simpan gambar”.',
      copySuccess: 'Gambar {{width}} × {{height}} tersalin. Anda dapat langsung menempelkannya.',
      copyFailed: 'Tidak dapat menyalin: {{error}}. Gambar mungkin melebihi batas papan klip sistem. Gunakan “Simpan gambar”.',
    },
    crop: {
      buttonCropped: 'Pangkas · {{width}} × {{height}}',
      applied:
        'Diterapkan. Unduhan, salinan, dan ekspor per bagian kini hanya menyertakan area ini ({{width}} × {{height}}). ZIP proyek lengkap tidak dipangkas.',
      removed: 'Pemangkasan dibatalkan. Ekspor kembali menyertakan gambar utuh.',
    },
    main: {
      offscreenMissing: 'Browser ini tidak mendukung OffscreenCanvas, sehingga worker perenderan tidak dapat berjalan.',
      webcodecsMissingToast:
        'Browser ini tidak mendukung WebCodecs. Pilih “Perkiraan · pemutar bawaan” untuk melanjutkan, tetapi beberapa bingkai bisa terlewat.',
      privateStorageToast:
        'Dalam mode privat, proyek hanya disimpan di memori jendela ini dan hilang saat jendela ditutup. Ekspor sebelum menutup jika ingin menyimpannya.',
      noOpfsNoPicker:
        'Browser ini tidak menyediakan OPFS maupun dialog penyimpanan file. Ekspor akan disiapkan di memori (maksimal {{mb}} MB).',
      dbOpenFailed: 'Tidak dapat membuka basis data lokal: {{error}}',
      workerErrorToast: 'Kesalahan worker: {{message}}',
      workerMessageUndecodable: 'Pesan dari worker tidak dapat dibaca. Simpan hasil yang ada, lalu muat ulang halaman.',
      interruptedPhaseWhere: '“{{phase}}”, bingkai {{frames}}',
      interruptedStartPhase: 'tahap awal',
      interruptedHiddenSome: 'halaman berada di latar belakang sekitar {{seconds}} dtk{{stillHidden}}',
      interruptedStillHidden: ' (masih di latar belakang saat terputus)',
      interruptedHiddenNone: 'halaman tetap di depan sepanjang proses',
      interruptedDiagnosticMessage:
        'Rekonstruksi sebelumnya terputus pada {{where}}. Halaman tidak menerima sinyal selesai karena dihentikan oleh browser atau mengalami crash. Proses berjalan selama {{elapsed}} dtk, memori inti {{memory}} MB, {{hidden}}, konversi bingkai: {{conversion}}, inti CPU: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari dapat menghentikan halaman pada penggunaan memori yang jauh lebih rendah saat berada di latar belakang. Biarkan tab ini tetap di depan selama proses yang lama. Catatan lengkap ditulis ke konsol browser.',
      interruptedNotIsolated: ' (tanpa isolasi lintas origin, satu thread)',
      interruptedToast: 'Rekonstruksi sebelumnya terputus pada {{where}} ({{hidden}}). Lihat diagnostik untuk detailnya.',
      unknownValue: 'tidak diketahui',
    },
    run: {
      pausedStatus: 'Dijeda · keadaan di memori tetap tersimpan',
      resumedStatus: 'Melanjutkan',
      pauseLabel: 'Jeda',
      resumeLabel: 'Lanjutkan',
      stopToast: 'Mengakhiri tahap ini, lalu menggabungkan dan menyimpan sebanyak mungkin bagian yang sudah diamati.',
      preparingStatus: 'Menyiapkan dekode per bingkai',
      preparingMessage: 'Membaca kontainer serta memeriksa dukungan codec dan penyimpanan lokal.',
      compatibilityNeedsNative: '“Perkiraan · pemutar bawaan” memerlukan video yang dapat dibaca oleh pemutar bawaan browser.',
      webcodecsHttpBlocked:
        'Browser tidak mengizinkan WebCodecs di alamat HTTP ini. Pilih “Perkiraan · pemutar bawaan” untuk melanjutkan pengujian lokal. Dekode per bingkai memerlukan localhost atau HTTPS. Video tidak diunggah.',
      webcodecsMissing:
        'Browser ini tidak mendukung WebCodecs. Perbarui Safari / iOS atau pilih “Perkiraan · pemutar bawaan”, yang mungkin melewatkan beberapa bingkai.',
      startFailedStatus: 'Rekonstruksi tidak dapat dimulai',
      restoredMessage: 'Ini hasil terakhir Anda. Setelah lewat 24 jam, hasil akan dihapus saat halaman dibuka berikutnya.',
      interruptedStatus: 'Proses terakhir belum selesai',
      interruptedMessage:
        'Ini bagian yang sempat disimpan sebelum proses berhenti. Untuk hasil lengkap, masukkan kembali rekaman dan mulai lagi.',
      waitingCanvasOption: 'Menunggu kanvas direkonstruksi',
    },
    source: {
      busyToast: 'Selesaikan atau hentikan dan simpan proses yang sedang berjalan terlebih dahulu.',
      subtitleReading: '{{size}} · tidak diunggah · membaca kontainer dan bingkai pertama',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · hanya dapat dibaca pemutar bawaan',
      subtitleUnavailable: '{{size}} · dekode per bingkai dan pratinjau bawaan sama-sama tidak tersedia',
      probeFailedMessage: 'Pemeriksaan dekode per bingkai gagal: {{error}}',
      probeFailedAction:
        'Akan mencoba membaca metadata dengan pemutar bawaan browser. Untuk melanjutkan proses, pilih dekode “Perkiraan · pemutar bawaan”.',
      rejectedVideo:
        '“{{name}}” adalah {{kind}}. Format ini tidak dapat dibaca per bingkai oleh browser, sehingga file tidak dibuka. Atur perekam layar agar menyimpan MP4, atau konversikan file ke MP4 dengan HandBrake atau ffmpeg.',
      rejectedOther:
        '“{{name}}” bukan video ({{kind}}), sehingga tidak dibuka. Pilih rekaman layar saat menjelajahi halaman: MP4, MOV, WebM, atau MKV. Di Windows, gunakan Snipping Tool atau Xbox Game Bar (Win+Alt+R); di Mac, tekan ⌘⇧5; di ponsel, gunakan perekam layar bawaan.',
      unreadableToast:
        'Video ini tidak dapat dibaca ({{reason}}). Pastikan rekaman selesai dengan benar dan file sudah disalin atau diunduh sepenuhnya. Jika masih gagal, coba MP4 dengan codec H.264. Penyebab kegagalan dekode per bingkai tercantum dalam diagnostik.',
      kind: {
        empty: 'file kosong',
        heif: 'gambar HEIC/AVIF',
        avi: 'video AVI',
        webp: 'gambar WebP',
        wav: 'file audio WAV',
        riff: 'file RIFF',
        wmv: 'video WMV/ASF',
        flv: 'video FLV',
        mpegps: 'video MPEG-PS',
        ogg: 'file media Ogg',
        gif: 'animasi GIF',
        png: 'gambar PNG',
        jpeg: 'gambar JPEG',
        pdf: 'dokumen PDF',
        zip: 'arsip ZIP atau dokumen Office',
        mp3: 'file audio MP3',
        text: 'file teks',
        mpegts: 'video MPEG-TS',
        unknown: 'file yang tidak dikenali',
      },
    },
    demo: { fileName: 'rekaman-contoh.mp4', loadFailed: 'Rekaman contoh tidak dapat dimuat: {{error}}' },
    feedback: {
      issueBody:
        '**Apa yang terjadi?**\n\n\n**Hasil seperti apa yang Anda harapkan?**\n\n\n**Tentang rekaman** (halaman apa, bagaimana Anda bergerak, dan perkiraan durasinya; tangkapan layar membantu, tetapi sembunyikan informasi pribadi)\n\n\n' +
        '---\nDiisi otomatis oleh Long Screen. Silakan edit atau hapus:\n- Browser: {{browser}}\n- Dibuka dari: {{page}}\n- Inti multithread (terisolasi lintas origin): {{threads}}\n- Peringatan di log proses: {{warnings}}\n',
      portable: 'versi portabel (file lokal)',
      yes: 'ya',
      no: 'tidak',
      none: 'tidak ada',
    },
    viewer: {
      previewLevel: 'Pratinjau L{{level}} (ukuran asli tidak berubah)',
      nativeLevel: 'Piksel asli L0',
      qualityHint: ' · perbesar untuk melihat peta kualitas',
      unobservedHint: ' · biru = tidak ada bukti pengamatan',
      provisionalHint: ' · ungu = konten sementara / elemen yang menutupi',
    },
  },
  names: {
    fixed: 'UI tetap',
    divider: 'Pemisah tetap',
    contentCanvas: 'Kanvas konten {{n}}',
    unassigned: 'Area belum ditentukan · pengamatan dalam koordinat layar',
    contentRegion: 'Area konten {{n}}',
    ignored: 'Diabaikan',
    fragment: 'fragmen belum ditempatkan {{n}}',
    framed: 'dengan bingkai',
  },
};
