import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'Birleştirmede, iki eksende hareket edebilen tuval katmanları ve daha önce görülen yerlere dönüşleri bağlayan geometrik kısıtlar kullanılır. Otomatik maskeleme ve değişen bölge algılama sezgisel çıkarımlardır; güven puanları doğruluğu ölçülmüş olasılıklar değildir. Ortak koordinat sistemindeki tutarlılık, bu kaynak için belirtilen ±{{noise}} düzeyindeki çözme gürültüsüyle karşılaştırılır{{margin}}.',
      marginLossy: ' (sıkıştırma haleleri ve renk bilgisinin yeniden oluşturulması için tolerans)',
      marginLossless: ' (kayıpsız kaynak, piksel piksel kesin karşılaştırma)',
      action: 'Ölçek veya yapı birbiriyle uyuşmuyorsa görüntüler zorla birleştirilmez; bağımsız bir parça saklanır.',
    },
    APPROXIMATE_DECODER: {
      message:
        '“Yaklaşık · video oynatıcı” modu {{fps}} Hz ile özellikle etkinleştirildi. Videonun her karesinin alınması garanti edilmez; kısa süre görünen içerik eksik kalabilir.',
      action: 'Her karenin alınması gerekiyorsa H.264 veya VP9 gibi WebCodecs’in desteklediği bir kodekle kaydedilmiş video kullanın.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'Hareket analizinde uzun kenar {{size}} piksel ile sınırlıdır. Hassaslaştırma ve son birleştirme özgün çözünürlükteki pikselleri kullanır; analiz kopyasının küçültülmesi sonucu küçültmez.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Özgün boyutta bir kare ve referans kareleri, seçilen önbellek sınırına yaklaşıyor. Kodek ve GPU belleği, JavaScript önbellek sınırına dahil değildir.',
      action: 'Sonuç çözünürlüğü sessizce düşürülmez. Bellek yetersizliğinde daha önce saklanan veriler korunur ve hata bildirilir.',
    },
    RUN_FAILURE: {
      action:
        'Yerel depolamaya yazılmış görüntü blokları görüntülenebilir ve dışa aktarılabilir. Başarısız işlem başarılı olarak işaretlenmedi.',
    },
    PERSISTENCE_ERROR: { action: 'Depolamaya yazma da başarısız oldu. Yalnızca daha önce kaydedilen veriler kurtarılabilir.' },
    MEMORY_BUDGET_RAISED: {
      message:
        'Bir karenin etkilediği tüm blokları sığdırmak için görüntü bloğu önbelleği {{from}} bloktan {{to}} bloğa çıkarıldı (yaklaşık {{mb}} MB).',
      action:
        'Önbellek bir karenin kapsadığı alandan küçük olsaydı her karede tüm ilgili blokları yeniden çözmek ve kodlamak gerekirdi. Daha az bellek kullanmak için kayıt çözünürlüğünü düşürün.',
    },
    NONFINITE_POSE: { message: 'Konum hesabı sonlu olmayan bir değer üretti. Bu gözlem ayrıldı; geçersiz koordinatlar tuvale yazılmadı.' },
    MISSING_PLAN: {
      message: 'Birleştirme aşamasında plan/{{index}} eksik. İşlem, daha önce saklanan bölümün sonunda durduruldu.',
      action: 'Yerel depolamanın bütünlüğünü kontrol edin. Eksik konum planı sessizce boş gözlem sayılmaz.',
    },
    prefixOnly: {
      base: {
        scan: 'Yerleştirme ve birleştirmeye yalnızca şimdiye kadar çözülen karelerle devam ediliyor ({{frames}})',
        solve: 'Birleştirmeye yalnızca konumu belirlenmiş karelerle devam ediliyor ({{frames}})',
        render: 'Yalnızca şimdiye kadar birleştirilmiş karelerin sonuçları korunuyor ({{frames}})',
      },
      suffixPersistence: '; depolamaya yazma durdu.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: { action: 'Bu tuvalin çerçeveli görünümü atlandı. Sayfa koordinatlarındaki temel birleştirme etkilenmedi.' },
    PRESENTATION_FRAME: {
      message:
        'Çerçeveli görünüm ve özgün iki boyutlu içerik ayrı saklanır. Çerçeve bir referans karesinden gelir; uzatılan bölüm yalnızca dekoratif arka plandır ve gözlenen içerik sayılmaz. Araç çubuğu simgeleri uzatılmaz veya çoğaltılmaz. Çerçeve içindeki diğer paneller yalnızca referans karesinden alınan anlık görüntülerdir.',
    },
    PRESENTATION_STAGE_FAILED: {
      action: 'Çerçeveli görünüm oluşturulamadı. Sayfa koordinatlarındaki temel birleştirme sonucu ve durumu etkilenmedi.',
    },
    PYRAMID_FAILED: {
      action: 'Önizleme piramidi oluşturulamadı. Özgün boyutlu görüntü blokları etkilenmedi; görüntülenebilir ve dışa aktarılabilir.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: '{{pass}} aşamasında tamamlanan kare: {{actual}}/{{expected}}. Sonuç kısmi olarak işaretlendi.',
      action: 'Başarıyla saklanan başlangıç bölümü korundu. Eksik kareler sessizce işlenmiş sayılmaz.',
    },
    FRAME_CONVERSION: { message: 'Çözülen kareleri piksellere dönüştürme yöntemi: {{method}}.' },
    HDR_UNCHECKED: {
      message:
        'Bu bir HDR kaydı ({{transfer}}), ancak tarayıcı renk dönüşümünü doğrulamaya izin vermiyor. Sonuç koyu veya soluk görünebilir.',
      action: 'Güncel bir Chrome veya Safari sürümünde yeniden deneyin.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'Bu HDR kaydının ilk karesindeki piksellerin %{{percent}} kadarı normal beyazdan daha parlak ve beyaz kabul edildi. Sonuç fazla aydınlıksa kayıt uygulaması normal beyazı daha yüksek parlaklığa yerleştirmiş olabilir.',
      action: 'Kayıt uygulamasında SDR beyazını 100 nite ayarlayın veya HDR kaydını kapatın.',
    },
    SLOW_CONVERSION: {
      message:
        'Bu tarayıcı her kareyi piksellere dönüştürmek için yaklaşık {{ms}} ms harcıyor. Yalnızca dönüştürme yaklaşık {{minutes}} dakika sürecek.',
      action: 'Güncel Chrome veya Safari çok daha hızlıdır. Kaydı önceden H.264’e dönüştürmek de yardımcı olabilir.',
    },
    REVEAL_SKIPPED: {
      message:
        'Bu sonuçta çok fazla veya çok büyük tuval var. İmleç, yüzer düğmeler ve kaydırma çubuklarını temizlemek için kullanılabilir belleğe ek olarak yaklaşık {{need}} MB gerekiyor. Bu adım atlandı, birleştirilen pikseller korundu.',
      action:
        'Sonucun geri kalanı etkilenmedi. Çok sayıda tuval genellikle kaydın bazı bölümlerinin önceki görüntülere bağlanamadığını gösterir. Daha kısa bir kayıt veya daha fazla belleği olan bir bilgisayar yardımcı olabilir.',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}. Rust çekirdeği: {{variant}} derlemesi, hesaplama iş parçacığı: {{threads}} ({{coreReason}}).',
    },
    PRESENTATION_REFERENCE_FAILED: { action: 'Çerçeveli görünüm atlanacak. Sayfa koordinatlarındaki temel birleştirme etkilenmedi.' },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'Karede ayırt edilebilir ayrıntı yok. Aynı görünen boş kareler hem duraklamayı hem boş bir alanda hareket etmeyi gösterebilir; yalnızca piksellerden bunları ayırmak mümkün değildir.',
      action:
        'Daha fazla ayırt edilebilir içerik kaydedin veya kareler arasında daha çok örtüşme bırakın. Burada sıfır yer değiştirme yalnızca en iyi tahmindir.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Bu gözlemi hizalamak için güvenilir görsel dayanak yok. Konum belirleme aşamasında önceki karelerde eşleşme aranacak. Yine yerleştirilemezse bağımsız parça olarak saklanacak.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'Birden fazla eşit derecede olası eşleşme veren tekrarlı bir desen algılandı. Hareketin sürekliliği yalnızca konum tahminine yardımcıdır; tek ve kesin bir konum kanıtı değildir.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message: 'Bu kare olağan dışı uzun bir süreyi kapsıyor. Hızlı hareket sırasında hiç kaydedilmemiş alanlar olabilir.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'Elle belirlenen bölgelerin dışında kalan bölüm, ekran koordinatlarında bağımsız ve güven düzeyi düşük bir gözlem katmanı olarak saklanır. Bu piksellerin sayfa koordinatlarına yerleştirildiği iddia edilmez.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Elle “Hariç tut” olarak belirlenen bölge işleme alınmadı. Bu bölge sonuca katkıda bulunmaz; bu durum karelerin otomatik atlanması değildir.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Elle çizilen bölgeler örtüştüğünde daha sonra çizilen önceliklidir. Hariç tutulan bölgeler her zaman dışarıda kalır. Kalan pikseller atanmamış gözlem katmanında korunur.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Otomatik algılanan içerik bölgesi: {{moving}}; sabit arayüz bölgesi: {{fixed}}. Sınırlar DOM’dan değil, piksel hareketi istatistiklerinden çıkarıldı.',
      action: 'Bölge yanlış görünüyorsa “Hareket bölgeleri” bölümünde kaydırma alanını tam olarak çizin ve yeniden işleyin.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: 'Bağımsız kaydırılan her bölge için ayrı tuval oluşturulur. Hepsine aynı kaydırma miktarı uygulanmaz.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Bu kare hizalandıktan sonra örtüşme alanında toplam {{conflicts}} piksel belirgin biçimde farklı. Bu bölge, o alanın içindeki çatışmalı parçalardan biridir. Olası nedenler: animasyon, içerik güncellemesi, sayfa düzeninin değişmesi veya kalan hizalama hatası.',
      actionStable:
        'Mümkün olduğunda çatışmalı bölgenin tamamı tek bir andan alındı. Turuncu tanılama işaretlerini ve özgün videodaki ilgili anı kontrol edin.',
      actionRolling:
        'Çatışmalı bölgenin tamamı yalnızca bütünüyle görünür olduğunda aynı kareden güncellenir. Sayfanın tamamı aynı ana ait değildir.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Değişen bu bölge, kullanılabilir tek bir görüntüde hiçbir zaman bütünüyle görünmedi. Tüm piksellerinin aynı ana ait olduğu garanti edilemez.',
      action: 'Gözlenen içerik ve açık çatışma işaretleri korundu. Görünmeyen bölümler uydurulmadı.',
    },
    MISSING_SCAN_RECORD: {
      message: 'Konum belirleme aşamasında scan/{{index}} eksik. İşlem, daha önce saklanan bölümün sonunda durduruldu.',
      action: 'Yerel depolamanın bütünlüğünü kontrol edin. Eksik tarama kaydı sıfır yer değiştirme olarak kabul edilmez.',
    },
    GRAPH_RESIDUAL: {
      message:
        'Konum grafiğindeki en büyük artık hata hâlâ özgün ölçekte {{residual}} piksel. Yakın birleşim yerlerinde geometrik uyumsuzluk görülebilir.',
      action: 'Geri dönüş eşleşmesinin çevresindeki metin ve tekrarlı desenleri kontrol edin. Bu artık hata gizlenmedi.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Doku bloklarının yaklaşık %{{percent}} kadarı genel hareketle uyuşmuyor. Nedeni animasyon, video, gecikmeli yükleme veya düzen değişikliği olabilir. Yer değiştirme tutarlı bloklardan belirlenir; çatışmalı bölge birleştirme sırasında ayrı ele alınır.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'Kareler arasında hızlı hareket oldu ve hizalama için az örtüşme kaldı. Yer değiştirme bu sınırlı kanıttan çıkarıldı. Düzen tekrar ediyorsa komşu tekrar da aynı pikselleri açıklayabilir.',
      action: 'Daha sonraki bir geri dönüş daha güçlü kanıt sağlarsa bu hareket bölümünün tamamı düzeltilip kayda geçirilecek.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'Tekrarlı desen, aynı pikselleri açıklayan birden çok yer değiştirmeye izin veriyor. Hareketin sürekliliğine en uygun olan kullanıldı. Bu bir tahmindir, tek doğru hizalama değildir.',
      messageLowConfidence:
        'Bu bölge güven düzeyi düşük bir konum tahminiyle yerleştirildi. Etkilenen pikseller kalite haritasında işaretlendi.',
      messageStatic:
        'İki kare neredeyse aynı, ancak ayrıntı eşleşmesi doğrulanamıyor. En iyi tahmin olarak duraklama, yani sıfır yer değiştirme kabul edildi.',
      action: 'En iyi tahmin için kesintisiz hareket yolu ve mevcut dayanaklar kullanıldı. Bunun tek doğru hizalama olduğu iddia edilmez.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'Karenin bu bölgesinde ayırt edilebilir ayrıntı yok. Boş kare duraklama da olabilir, boş alanda hareket de; yalnızca piksellerle ayırt edilemez. Bu bölge tuvale çizilmedi.',
      action: 'Boşluktan sonraki içerik önceki gözlemle örtüştürülemezse bağımsız parça olarak saklanır; aradaki mesafe tahmin edilmez.',
    },
    RELOCALIZED: {
      message:
        'Önceki karelerdeki görsel bir dayanakla mevcut tuval üzerindeki konum yeniden bulundu. Tekrar ziyaret edilen içerik, uzun görüntüye yeni bir alanmış gibi eklenmedi.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Yaklaşık {{scale}}× ölçek veya düzen değişimi algılandı. Bölge özgün piksellerle bağımsız parça olarak saklandı; gizli bir ölçekleme uygulanmadı.',
      action:
        'Parçaların birbirine göre konumu henüz doğrulanmadı. Daha sonraki bir geri dönüşte güvenilir eşleşme bulunursa parça bütünüyle bağlanacak. Daha çok örtüşme bırakarak yeniden kaydedin veya değişen öğeyi elle ayrı bölge olarak belirleyin.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'Özgün tuvale göre konum doğrulanamadı. Bölge bağımsız ve ayrıca dışa aktarılabilir bir parça olarak saklandı. İki parça örtüşüyor olabilir veya aralarında gerçek bir boşluk bulunabilir.',
      action:
        'Parçaların birbirine göre konumu henüz doğrulanmadı. Daha sonraki bir geri dönüşte güvenilir eşleşme bulunursa parça bütünüyle bağlanacak. Daha çok örtüşme bırakarak yeniden kaydedin veya değişen öğeyi elle ayrı bölge olarak belirleyin.',
    },
    STICKY_OCCLUSION: {
      message:
        'Karenin üstündeki ayrıntılar, sayfa hareketi yerine ekrana sabitlenmiş bir arayüze işaret ediyor. Bu sabit örtü hareketli tuvale yazılmadı. Özgün referans arayüz çerçeveli görünümde korundu.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'Tekrar ziyaret sırasında elde edilen kanıtla bağımsız parça mevcut tuvale bütünüyle bağlandı. Parçanın içindeki göreli hareket yolu değişmedi.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'Önceki adımda az örtüşme vardı. Bu karenin önceden gözlenen içerikle eşleşmesi {{discrepancy}} piksel farklı ve daha güçlü kanıta dayanıyor. Geçerli konum bu eşleşmeye göre düzeltildi.',
      action:
        'Bu karenin konumu ve sonrasındaki hareket yolu düzeltildi. Daha önce yazılmış pikseller değişmedi; düzeltilmiş koordinatlarla sınırda birleşim izi görülebilir.',
    },
    LOOP_CLOSURE: {
      message:
        'Daha önce görülen alana güvenilir bir geri dönüş bulundu ve genel konum kısıtı olarak eklendi. Son birleştirme düzeltilmiş hareket yolunu kullanır.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'Önceki görüntüyle eşleşme, kesintisiz hareket yolundan {{discrepancy}} piksel sapıyor. Kanıtlar çeliştiği için bu eşleşme zorunlu bir geri dönüş bağlantısı olarak uygulanmadı.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'Önceki gözlemlerde arama, neredeyse eşit derecede olası birkaç konum verdi. Belirsiz geri dönüş eşleşmesi kesin bir kısıt olarak uygulanmadı.',
    },
  },
  progress: {
    runPartial: 'Kısmi olduğu açıkça işaretlenen birleştirme sonucu saklandı.',
    runComplete: 'Birleştirme tamamlandı. Tanılamayı ve kayıtta görünmeyen alanları kontrol edin.',
    render: 'Gözlenen pikseller özgün boyutlu bloklarda birleştiriliyor. Boşluklar saydam kalıyor.',
    reveal: {
      learn: 'Sayfanın üzerinde duran düğmeler, giriş çubukları ve kaydırma çubukları için kayıt yeniden inceleniyor.',
      agree: 'Her alanın zaman içindeki görünümü karşılaştırılıyor. Önü kapatılmamış görünüm tercih ediliyor.',
      relearn: 'Doğrulanan sayfa üzerinde üstte duran öğeler yeniden bulunuyor.',
      write: 'Örtülü veya uyuşmayan alanlar temiz kareyle değiştiriliyor.',
    },
    framingStart: 'Özgün çerçeve korunuyor. Yan çubuk metni uzatılmadan ve simgeler çoğaltılmadan yalnızca arka plan genişletiliyor.',
    pyramidBuild: 'Diskte önizleme piramidi oluşturuluyor. Özgün boyutlu görüntü blokları değişmiyor.',
    scanFrame: 'Kare kare geometrik kanıt toplanıyor, bağımsız hareket bölgeleri belirleniyor.',
    duplicateReuse: 'Aynı gözlem için önceki konum yeniden kullanıldı. Kaynak kare ve zaman damgası korundu.',
    solveFrame: 'Özgün piksellerle hassaslaştırma, önceki karelerde konum bulma ve iki boyutlu geri dönüş eşleştirmeleri yapılıyor.',
    optimizing: 'Diskteki konum grafiği iyileştiriliyor, geri dönüş eşleşmeleriyle biriken sapma düzeltiliyor.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: bu tarayıcı kaydın kodeğini çözemiyor ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'iPhone ve Mac kayıtları genellikle HEVC kullanır; her tarayıcı bunu çözemez. Safari veya donanım çözme destekli Chrome ya da Edge kullanın.',
      prores: 'Tarayıcılar ProRes çözemez. Önce kaydı H.264 veya HEVC olarak dışa aktarın.',
      h264: 'Bu H.264 türünü (4:4:4 veya 10 bit) yalnızca Chrome çözer. Chrome kullanın veya normal H.264 olarak dışa aktarın.',
      av1: 'AV1 için güncel tarayıcı veya uygun donanım gerekir. Güncel Chrome kullanın ya da kaydı H.264’e dönüştürün.',
      other: 'Güncel Chrome veya Safari kullanın ya da kaydı önce H.264’e dönüştürün.',
    },
    PIXEL_ASPECT_RATIO:
      'Kayıtta piksel en-boy oranı {{num}}:{{den}} olarak belirtilmiş. Depolanan pikseller ölçeklenmeden korunur; görüntüleme oranı farklı olabilir.',
    CONTAINER_SIZE_MISMATCH:
      'Kapsayıcıda {{codedWidth}}×{{codedHeight}} yazıyor, ancak video akışı {{bitstreamWidth}}×{{bitstreamHeight}} boyutunda. Video akışının boyutu kullanılıyor.',
    NON_SQUARE_PIXELS:
      'Kayıt kare olmayan pikseller bildiriyor: görüntüleme boyutu {{displayWidth}}×{{displayHeight}}, depolama boyutu {{bitstreamWidth}}×{{bitstreamHeight}}. Depolanan özgün pikseller ölçeklenmeden korunuyor.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'Video çözücü, düzenleme listesinin başlangıcından önceye ait, negatif zaman damgalı bir kare üretti. Kapsayıcı kuralları gereği bu kareler gösterilmez.',
    NONMONOTONIC_TIMESTAMP:
      'Kapsayıcıdaki bir zaman damgası geriye gitti. İşlem çözücünün gösterim sırasıyla devam etti; hiçbir gözlem atılmadı.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: bu video izinin ctts kutusu sürüm 0, ancak negatif gösterim zamanı farkları içeriyor. ISO 14496-12 negatif farkları yalnızca sürüm 1’de tanımlar. Bu değerler, yaygın QuickTime/ReplayKit kullanımına uygun olarak işaretli sayılar şeklinde okunuyor; çok büyük pozitif farklar olarak yorumlanmıyor.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: dosya {{box}} kutusunun içinde bitiyor. Kutunun bildirilen sonu {{declaredEnd}}. bayt, ancak dosya yalnızca {{size}} bayt. Kayıt düzgün tamamlanmamış veya dosya kopyalama ya da aktarım sırasında kesilmiş olabilir. Kesintiden sonraki kareler çözülemez. Bu nedenle taramada üstveride yazandan daha az kare bulunur ve sonuç kısmi olarak işaretlenir.',
  },
  exports: {
    tilesProgress: 'Özgün görüntü ve önizleme blokları dışa aktarılıyor: {{n}}',
    zipFinalize: 'ZIP64 dizini yazılıyor ve dosya kaydediliyor',
    projectDone: {
      message:
        'Özgün boyutlu görüntü blokları, çevrimdışı görüntüleyici, kapsam ve kalite verileri, kaynak kare kayıtları ve tüm tanılama verileri dışa aktarıldı.',
    },
    encodingSingle: 'Özgün ölçekte kodlanan satır: {{row}} / {{total}}',
    canvasDone: { message: '{{width}} × {{height}} boyutunda özgün ölçekli PNG dışa aktarıldı. Boşluklar saydam kaldı.' },
    encodingSheet: 'Özgün boyutta {{count}} parça kodlandı',
    sheetsDone: {
      messagePaged:
        'Özgün boyutta {{count}} parça olarak dışa aktarıldı. Komşu parçalar en fazla {{overlap}} piksel örtüşür; koordinatlar manifest dosyasındadır.',
      messageOversize:
        'Tuval tek bir görüntü için uyumlu boyutu aştığından, açıkça özgün boyutta {{count}} parçaya bölünerek dışa aktarıldı. Komşu parçalar en fazla {{overlap}} piksel örtüşür; koordinatlar manifest dosyasındadır.',
    },
  },
  offline: {
    title: 'Çevrimdışı tuval',
    fit: 'Sığdır',
    tip: 'Yerel, özgün boyutlu görüntü blokları · sürükleyin / yakınlaştırmak için kaydırın',
    previewLevel: 'Önizleme düzeyi {{level}} gösteriliyor. Özgün pikseller için yakınlaştırın.',
    nativeTiles: 'Özgün boyutlu görüntü blokları gösteriliyor',
    footer:
      'Dama desenli alanlar gözlenmemiştir veya görüntü bloğu yoktur. Güven puanı doğruluk olasılığı değildir. diagnostics.jsonl ve observations.jsonl dosyalarına bakın.',
  },
};
