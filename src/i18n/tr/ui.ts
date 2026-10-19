import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Kareler inceleniyor, hareket katmanları belirleniyor',
      solving: 'Konumlar belirleniyor, özgün piksellerle hassaslaştırılıyor',
      optimizing: 'Geri dönüş eşleşmeleri ve biriken sapma düzeltiliyor',
      rendering: 'Tuval özgün boyutunda birleştiriliyor',
      revealing: 'Sayfanın üstünü örten öğeler kaldırılıyor',
      framing: 'Çerçeve ve özgün oranlar korunuyor',
      pyramid: 'Yakınlaştırılabilir önizleme hazırlanıyor',
      complete: 'Tamamlandı · tanılamayı kontrol edin',
      partial: 'Kısmi sonuç saklandı',
      error: 'İşlem sırasında hata oluştu',
    },
    count: {
      frames_one: '{{frames}} kare',
      frames_other: '{{frames}} kare',
      framesUnknown: '? kare',
      regions_one: '{{count}} özel bölge ↗',
      regions_other: '{{count}} özel bölge ↗',
    },
    dom: {
      noCompressionStream:
        'Bu tarayıcıda CompressionStream yok. Özgün boyutlu her görüntü bloğunu PNG’ye dönüştürmek için bu özellik gerekiyor; birleştirme başlatılamıyor.',
    },
    canvases: {
      badgePresentation: 'Çerçeveli görünüm · uzatılan arka plan kayıttan alınmamıştır',
      badgeFixed: 'Sabit katman / gözlem katmanı',
      badgeMoving: 'İki boyutlu içerik katmanı',
      badge_one: '{{kind}} · özgün boyutta {{count}} görüntü bloğu{{fragment}}',
      badge_other: '{{kind}} · özgün boyutta {{count}} görüntü bloğu{{fragment}}',
      fragmentNote: ' · parçaların birbiriyle hizalandığı doğrulanmadı',
    },
    diagnostics: {
      occurrenceSuffix: ' (bu türden {{count}} kayıt)',
      locateAction: 'İlgili alanı / kaynak görüntüyü göster ↗',
      viewSourceAction: 'Kayıttaki anı göster ↗',
      emptyFiltered: 'Bu filtreye uyan kayıt yok.',
      emptyDefault: 'Konum eşleştirmeleri, sayfa değişiklikleri, tahminler ve işlem hataları burada görünecek.',
      noOriginalVideo:
        'Özgün video projeye dahil değildir. Belirli bir anı görmek için aynı kaydı yeniden seçin. Birleştirilmiş sonuç hâlâ cihazınızda saklanıyor.',
      hashMismatch:
        'Dosyanın adı ve boyutu eşleşiyor, ancak içerik özeti bu projenin oluşturulduğu kayıttan farklı. Bu nedenle dosya, kaynak görüntüyü doğrulamak için kullanılamaz. Doğru kayıt dosyasını seçin.',
      sourceCaption: 'Kaynak kare {{frame}} · {{time}} sn · {{message}}',
    },
    export: {
      imageSuffix: '-ekran-goruntusu',
      savePickerFallback: 'Doğrudan kaydetme kullanılamıyor. Tarayıcı indirmesi kullanılacak: {{error}}',
      saveRowLabel: '{{name}} dosyasını kaydet · {{size}}',
      shareLabel: 'Paylaş / fotoğraflara kaydet',
      shareFailed: 'Paylaşılamadı: {{error}}',
      cleanupLabel: 'Kaydettikten sonra geçici kopyayı sil',
      exportErrorAction: 'Dışa aktarma tamamlanmadı ve başarılı sayılmadı. Daha önce saklanan proje blokları bu cihazda duruyor.',
      clipboardUnsupported: 'Bu tarayıcı görüntü kopyalamayı desteklemiyor. “Görüntüyü kaydet”i kullanın.',
      copyNoImage: 'Görüntü oluşturulmadı',
      copyFailedCtor: 'Kopyalanamadı: {{error}}. “Görüntüyü kaydet”i kullanın.',
      copySuccess: '{{width}} × {{height}} boyutundaki görüntü kopyalandı. Şimdi yapıştırabilirsiniz.',
      copyFailed: 'Kopyalanamadı: {{error}}. Görüntü, sistem panosunun boyut sınırını aşıyor olabilir. “Görüntüyü kaydet”i kullanın.',
    },
    crop: {
      buttonCropped: 'Kırpma · {{width}} × {{height}}',
      applied:
        'Tamam. İndirme, kopyalama ve parçalara bölerek dışa aktarma artık yalnızca bu alanı ({{width}} × {{height}}) kullanacak. Projenin tamamını içeren ZIP kırpılmaz.',
      removed: 'Kırpma kaldırıldı. Dışa aktarmalarda yeniden tüm görüntü kullanılacak.',
    },
    main: {
      offscreenMissing: 'Bu tarayıcıda OffscreenCanvas yok; görüntüyü birleştiren arka plan işçisi çalışamıyor.',
      webcodecsMissingToast: 'Bu tarayıcıda WebCodecs yok. “Yaklaşık · video oynatıcı”yı seçin; bazı kareler atlanabilir.',
      privateStorageToast:
        'Gizli gezinme: proje yalnızca bu pencerenin belleğinde tutulur ve pencere kapanınca kaybolur. Saklamak için kapatmadan önce dışa aktarın.',
      noOpfsNoPicker: 'Bu tarayıcıda OPFS veya dosya kaydetme penceresi yok. Dışa aktarma bellekte oluşturulacak (en fazla {{mb}} MB).',
      dbOpenFailed: 'Yerel veritabanı açılamadı: {{error}}',
      workerErrorToast: 'Arka plan işçisi hatası: {{message}}',
      workerMessageUndecodable: 'Arka plan işçisinden gelen bir ileti okunamadı. Mevcut sonuçları kaydedip sayfayı yenileyin.',
      interruptedPhaseWhere: '“{{phase}}” aşamasında, {{frames}}. karede',
      interruptedStartPhase: 'başlangıç aşamasında',
      interruptedHiddenSome: 'sayfa yaklaşık {{seconds}} sn arka planda kaldı{{stillHidden}}',
      interruptedStillHidden: ' (kesinti sırasında da arka plandaydı)',
      interruptedHiddenNone: 'sayfa tüm süre boyunca ön planda kaldı',
      interruptedDiagnosticMessage:
        'Önceki birleştirme {{where}} kesildi. Sayfa tamamlanma sinyali almadı: tarayıcı sayfayı bellekten çıkarmış veya çökmüş olabilir. Geçen süre: {{elapsed}} sn; çekirdek belleği: {{memory}} MB; {{hidden}}; kare dönüşümü: {{conversion}}; CPU çekirdeği: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari, arka plana geçen sayfalarda bellek sınırını ciddi ölçüde düşürür. Uzun işlemlerde bu sekmeyi ön planda tutun. Ayrıntılı kayıt tarayıcı konsoluna yazıldı.',
      interruptedNotIsolated: ' (kaynaklar arası yalıtım yok, tek iş parçacığı)',
      interruptedToast: 'Önceki birleştirme {{where}} kesildi ({{hidden}}). Ayrıntılar için tanılamaya bakın.',
      unknownValue: 'bilinmiyor',
    },
    run: {
      pausedStatus: 'Duraklatıldı · bellekteki durum korunuyor',
      resumedStatus: 'Devam ediliyor',
      pauseLabel: 'Duraklat',
      resumeLabel: 'Devam et',
      stopToast: 'Mevcut aşama tamamlanıyor. İşlenebilen görüntülerin mümkün olduğunca büyük bölümü birleştirilip saklanacak.',
      preparingStatus: 'Kare kare çözme hazırlanıyor',
      preparingMessage: 'Kapsayıcı okunuyor; kodek desteği ve yerel depolama kontrol ediliyor.',
      compatibilityNeedsNative: '“Yaklaşık · video oynatıcı” için tarayıcının yerleşik oynatıcısı bu videoyu okuyabilmelidir.',
      webcodecsHttpBlocked:
        'Tarayıcı bu HTTP adresinde WebCodecs’e izin vermiyor. Yerel denemeye devam etmek için “Yaklaşık · video oynatıcı”yı seçebilirsiniz. Kare kare çözme için localhost veya HTTPS gerekir. Video sunucuya yüklenmez.',
      webcodecsMissing:
        'Bu tarayıcıda WebCodecs yok. Safari / iOS’i güncelleyin veya “Yaklaşık · video oynatıcı”yı seçin; bu seçenek kare atlayabilir.',
      startFailedStatus: 'Birleştirme başlatılamadı',
      restoredMessage: 'Bu, son sonucunuz. 24 saat dolduktan sonra sayfayı bir sonraki açışınızda silinecek.',
      interruptedStatus: 'Önceki işlem tamamlanmadı',
      interruptedMessage: 'Burada işlem durmadan önce saklanan bölüm var. Tam sonuç için kaydı yeniden ekleyip başlatın.',
      waitingCanvasOption: 'Tuvalin birleştirilmesi bekleniyor',
    },
    source: {
      busyToast: 'Önce mevcut işlemi tamamlayın veya sonucu saklayın.',
      subtitleReading: '{{size}} · sunucuya yüklenmez · kapsayıcı ve ilk kare okunuyor',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · yalnızca yerleşik oynatıcıyla okunabilir',
      subtitleUnavailable: '{{size}} · kare kare çözme ve yerleşik önizleme kullanılamıyor',
      probeFailedMessage: 'Kare kare çözme denemesi başarısız: {{error}}',
      probeFailedAction:
        'Üstveriyi okumak için tarayıcının yerleşik oynatıcısı denenecek. İşleme devam etmek için “Yaklaşık · video oynatıcı”yı seçin.',
      rejectedVideo:
        '“{{name}}” açılmadı: tarayıcı bu biçimi ({{kind}}) kare kare okuyamıyor. Ekran kaydedicinizi MP4 kaydedecek şekilde ayarlayın veya dosyayı önce HandBrake ya da ffmpeg ile MP4’e dönüştürün.',
      rejectedOther:
        '“{{name}}” bir video değil ({{kind}}), bu yüzden açılmadı. Sayfada gezinirken alınmış bir ekran kaydı seçin: MP4, MOV, WebM veya MKV. Windows’ta Ekran Alıntısı Aracı veya Xbox Game Bar (Win+Alt+R), Mac’te ⌘⇧5, telefonda yerleşik ekran kaydı özelliğini kullanabilirsiniz.',
      unreadableToast:
        'Bu video okunamıyor ({{reason}}). Kaydın düzgün tamamlandığını ve dosyanın eksiksiz kopyalandığını veya indirildiğini kontrol edin. Sorun sürerse H.264 kodekli bir MP4 deneyin. Kare kare çözmenin neden başarısız olduğu tanılamada yazıyor.',
      kind: {
        empty: 'boş dosya',
        heif: 'HEIC/AVIF görüntüsü',
        avi: 'AVI videosu',
        webp: 'WebP görüntüsü',
        wav: 'WAV ses dosyası',
        riff: 'RIFF dosyası',
        wmv: 'WMV/ASF videosu',
        flv: 'FLV videosu',
        mpegps: 'MPEG-PS videosu',
        ogg: 'Ogg medya dosyası',
        gif: 'GIF animasyonu',
        png: 'PNG görüntüsü',
        jpeg: 'JPEG görüntüsü',
        pdf: 'PDF belgesi',
        zip: 'ZIP arşivi veya Office belgesi',
        mp3: 'MP3 ses dosyası',
        text: 'metin dosyası',
        mpegts: 'MPEG-TS videosu',
        unknown: 'tanınmayan dosya türü',
      },
    },
    demo: { fileName: 'ornek-kayit.mp4', loadFailed: 'Örnek kayıt yüklenemedi: {{error}}' },
    feedback: {
      issueBody:
        '**Ne oldu?**\n\n\n**Ne olmasını bekliyordunuz?**\n\n\n**Kayıt hakkında** (hangi sayfa, nasıl hareket ettiniz, yaklaşık süre; ekran görüntüsü yardımcı olur, ancak özel bilgileri gizleyin)\n\n\n---\nLong Screen tarafından eklendi. İsterseniz değiştirin veya silin:\n- Tarayıcı: {{browser}}\n- Açıldığı yer: {{page}}\n- Çok iş parçacıklı çekirdek (kaynaklar arası yalıtım): {{threads}}\n- İşlem günlüğündeki uyarılar: {{warnings}}\n',
      portable: 'taşınabilir sürüm (yerel dosya)',
      yes: 'evet',
      no: 'hayır',
      none: 'yok',
    },
    viewer: {
      previewLevel: 'Önizleme düzeyi L{{level}} (özgün boyut değişmez)',
      nativeLevel: 'Özgün pikseller L0',
      qualityHint: ' · kalite haritası için yakınlaştırın',
      unobservedHint: ' · mavi = kayıtta gözlenmedi',
      provisionalHint: ' · mor = geçici içerik / üstte duran öğeler',
    },
  },
  names: {
    fixed: 'Sabit arayüz',
    divider: 'Sabit ayırıcı',
    contentCanvas: 'İçerik tuvali {{n}}',
    unassigned: 'Atanmamış alan · ekran koordinatlarında gözlemler',
    contentRegion: 'İçerik bölgesi {{n}}',
    ignored: 'Hariç tutuldu',
    fragment: 'konumu belirlenemeyen parça {{n}}',
    framed: 'çerçeveli',
  },
};
