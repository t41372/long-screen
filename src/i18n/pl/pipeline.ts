import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'Rekonstrukcja korzysta z przesuwanych warstw obrazu i warunków geometrycznych dla powrotów do wcześniej widzianych miejsc. Automatyczne maskowanie i wykrywanie obszarów dynamicznych opierają się na heurystykach. Poziomy pewności nie są skalibrowanym prawdopodobieństwem poprawności. Porównania spójności uwzględniają szum dekodowania podany dla tego źródła. Zakres w poziomach jasności: ±{{noise}}{{margin}}.',
      marginLossy: ' (zapas na artefakty kompresji i odtwarzania kolorów)',
      marginLossless: ' (źródło bezstratne, dokładne porównanie piksel po pikselu)',
      action: 'Jeśli skale lub układy są niezgodne, treść pozostaje osobnym fragmentem zamiast wymuszonego połączenia.',
    },
    APPROXIMATE_DECODER: {
      message:
        'Świadomie włączono tryb „Przybliżone · odtwarzacz przeglądarki” z częstotliwością {{fps}} Hz. Nie gwarantuje on odczytania każdej klatki. Krótko widoczne treści mogą zostać pominięte.',
      action: 'Jeśli potrzebujesz odczytania każdej klatki, użyj źródła obsługiwanego przez WebCodecs, np. H.264 lub VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'Analiza ruchu ogranicza dłuższy bok do {{size}} px. Dokładne dopasowanie i końcowe składanie używają oryginalnych pikseli, więc wynik nie jest pomniejszany.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Jedna klatka w oryginalnej rozdzielczości wraz z klatkami odniesienia niemal wyczerpuje wybrany limit pamięci podręcznej. Limit JavaScript nie kontroluje pamięci kodeka ani GPU.',
      action:
        'Rozdzielczość wyniku nigdy nie jest zmniejszana bez powiadomienia. Przy braku pamięci zapisane dane zostają zachowane, a błąd jest zgłaszany.',
    },
    RUN_FAILURE: {
      action: 'Zapisane lokalnie kafelki nadal można oglądać i eksportować. Nieudane przetwarzanie nie zostało oznaczone jako udane.',
    },
    PERSISTENCE_ERROR: {
      action: 'Zapis do pamięci trwałej również się nie powiódł. Można odzyskać tylko dane zapisane wcześniej.',
    },
    MEMORY_BUDGET_RAISED: {
      message:
        'Pamięć podręczna została zwiększona z {{from}} do {{to}} kafelków, czyli do około {{mb}} MB, aby pomieścić wszystkie kafelki objęte jedną klatką.',
      action:
        'Mniejsza pamięć podręczna wymuszałaby ponowne dekodowanie i kodowanie wszystkich kafelków dla każdej klatki. Obniż rozdzielczość nagrania, aby zmniejszyć zużycie pamięci.',
    },
    NONFINITE_POSE: {
      message:
        'Obliczenie położenia dało wartość nieskończoną lub nieokreśloną. Obserwację odizolowano, a nieprawidłowych współrzędnych nie zastosowano do obrazu.',
    },
    MISSING_PLAN: {
      message: 'Na etapie renderowania brakuje plan/{{index}}. Przetwarzanie zatrzymano na części zapisanej wcześniej.',
      action: 'Sprawdź spójność pamięci lokalnej. Brakujący plan położenia nigdy nie jest po cichu uznawany za pustą obserwację.',
    },
    prefixOnly: {
      base: {
        scan: 'Ustalanie położenia i składanie będą kontynuowane tylko dla już zdekodowanych klatek ({{frames}})',
        solve: 'Renderowanie będzie kontynuowane tylko dla klatek o ustalonym położeniu ({{frames}})',
        render: 'Zachowany zostanie wynik tylko dla już wyrenderowanych klatek ({{frames}})',
      },
      suffixPersistence: '; zapis do pamięci trwałej został przerwany.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action: 'Pominięto widok z ramką dla tego obrazu. Właściwa rekonstrukcja we współrzędnych strony pozostaje bez zmian.',
    },
    PRESENTATION_FRAME: {
      message:
        'Widok z ramką i oryginalna treść 2D są zachowane osobno. Ramka pochodzi z klatki odniesienia. Rozszerzone części są tylko dekoracyjnym tłem i nie liczą się jako zaobserwowana treść. Ikony nigdy nie są rozciągane ani powielane. Inne panele w ramce są jedynie widokami odniesienia.',
    },
    PRESENTATION_STAGE_FAILED: {
      action: 'Nie udało się utworzyć widoku z ramką. Wynik i stan właściwej rekonstrukcji we współrzędnych strony pozostają bez zmian.',
    },
    PYRAMID_FAILED: {
      action:
        'Nie udało się utworzyć poziomów podglądu. Kafelki w oryginalnej rozdzielczości pozostają bez zmian i nadal można je oglądać oraz eksportować.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: 'Etap {{pass}} nie objął wszystkich klatek. Ukończono: {{actual}} / {{expected}}. Wynik oznaczono jako częściowy.',
      action: 'Zachowano poprawnie zapisany początek wyniku. Brakujące klatki nigdy nie są po cichu uznawane za przetworzone.',
    },
    FRAME_CONVERSION: {
      message: 'Metoda przekształcania zdekodowanych klatek w piksele: {{method}}.',
    },
    HDR_UNCHECKED: {
      message:
        'To nagranie HDR ({{transfer}}), ale przeglądarka nie pozwala sprawdzić konwersji kolorów. Wynik może być zbyt ciemny lub wyblakły.',
      action: 'Spróbuj ponownie w aktualnej wersji Chrome lub Safari.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'W pierwszej klatce HDR {{percent}}% pikseli jest jaśniejszych od zwykłej bieli i zostało potraktowanych jako białe. Jeśli wynik wygląda na prześwietlony, rejestrator najpewniej ustawił zwykłą biel na wyższy poziom jasności.',
      action: 'Ustaw biel SDR rejestratora z powrotem na 100 nitów lub wyłącz nagrywanie HDR.',
    },
    SLOW_CONVERSION: {
      message:
        'Przeglądarka potrzebuje około {{ms}} ms na przekształcenie jednej klatki tego nagrania w piksele. Sama konwersja zajmie więc około {{minutes}} min.',
      action: 'Aktualna wersja Chrome lub Safari działa znacznie szybciej. Pomóc może też wcześniejsza konwersja nagrania na H.264.',
    },
    REVEAL_SKIPPED: {
      message:
        'Wynik zawiera zbyt wiele niezależnych obrazów lub są one zbyt duże. Usunięcie nakładek, takich jak kursor, pływające przyciski i paski przewijania, wymagałoby około {{need}} MB ponad dostępną pamięć. Pominięto ten etap i zachowano złożone piksele.',
      action:
        'Pozostała część wyniku nie ulega zmianie. Duża liczba obrazów zwykle oznacza, że części nagrania nie udało się połączyć z wcześniejszymi. Pomóc może krótsze nagranie lub komputer z większą ilością pamięci.',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}. Silnik Rust: wariant {{variant}}, wątki obliczeniowe: {{threads}} ({{coreReason}}).',
    },
    PRESENTATION_REFERENCE_FAILED: {
      action: 'Widok z ramką zostanie pominięty. Właściwa rekonstrukcja we współrzędnych strony pozostaje bez zmian.',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'Klatka nie zawiera rozpoznawalnych szczegółów. Identyczny pusty obraz może oznaczać zatrzymanie lub ruch nad pustym obszarem. Same piksele nie pozwalają tego rozróżnić.',
      action:
        'Uwzględnij rozpoznawalne elementy lub większe nakładanie się widoków w nagraniu. Zerowe przesunięcie jest tutaj tylko oszacowaniem.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Ta obserwacja nie daje wiarygodnych punktów odniesienia do wyrównania. Etap ustalania położenia spróbuje dopasować ją do wcześniejszych obrazów. Jeśli to się nie uda, pozostanie niezależnym fragmentem.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'Wykryto powtarzalny wzór z kilkoma równie wiarygodnymi dopasowaniami. Ciągłość ruchu pomaga oszacować położenie, ale nie dowodzi jego jednoznaczności.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message:
        'Ta klatka obejmuje nietypowo długi czas. Przy szybkim ruchu mogły zostać przebyte obszary, których nigdy nie zarejestrowano.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'Części poza ręcznie wyznaczonymi obszarami pozostają w niezależnej warstwie obserwacji o niskiej pewności, we współrzędnych ekranu. Ich położenie na stronie nie jest uznawane za odtworzone.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Obszar oznaczony jako „Ignoruj” został wykluczony zgodnie z ręcznym ustawieniem. Nie wnosi nic do rekonstrukcji. Nie oznacza to automatycznego odrzucania klatek.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Gdy ręczne obszary nakładają się na siebie, pierwszeństwo ma narysowany później. Obszary ignorowane są zawsze wykluczone. Pozostałe piksele trafiają do nieprzypisanej warstwy obserwacji.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Automatyczny podział: liczba obszarów treści — {{moving}}, liczba obszarów stałego interfejsu — {{fixed}}. Granice wynikają ze statystyk ruchu pikseli, a nie z DOM.',
      action:
        'Jeśli przypisanie jest nieprawidłowe, dokładnie zaznacz przewijany obszar w sekcji „Obszary ruchu” i przetwórz nagranie ponownie.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: 'Każdy niezależnie przewijany obszar otrzyma własny obraz. Nie będzie im narzucane wspólne przesunięcie.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Po wyrównaniu klatki łączna liczba wyraźnie różniących się pikseli w części wspólnej wynosi {{conflicts}}. Ten obszar jest jednym ze spójnych składników konfliktu. Możliwe przyczyny to animacja, zmiana treści, zmiana układu lub pozostały błąd dopasowania.',
      actionStable:
        'W miarę możliwości cały obszar konfliktu utrwalono z jednego momentu. Sprawdź pomarańczowe komunikaty i odpowiedni moment oryginalnego nagrania.',
      actionRolling:
        'Cały obszar konfliktu jest aktualizowany z tej samej klatki tylko wtedy, gdy widać go w całości. Nie oznacza to jednego wspólnego momentu dla całej strony.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Ten zmieniony obszar nigdy nie był w całości widoczny w użytecznej klatce. Nie ma gwarancji, że wszystkie jego piksele pochodzą z tego samego momentu.',
      action: 'Zaobserwowana treść i wyraźne oznaczenie konfliktu pozostają zachowane. Niewidziane części nie zostały wymyślone.',
    },
    MISSING_SCAN_RECORD: {
      message: 'Na etapie ustalania położenia brakuje scan/{{index}}. Przetwarzanie zatrzymano na części zapisanej wcześniej.',
      action: 'Sprawdź spójność pamięci lokalnej. Brakująca obserwacja nigdy nie jest uznawana za zerowe przesunięcie.',
    },
    GRAPH_RESIDUAL: {
      message:
        'Maksymalna pozostała rozbieżność w grafie położeń, w oryginalnych pikselach: {{residual}}. Pobliskie łączenia mogą mieć niespójną geometrię.',
      action: 'Sprawdź tekst i powtarzalne wzory w pobliżu ponownie odwiedzonego obszaru. Ta rozbieżność nie została ukryta.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Około {{percent}}% bloków tekstury nie zgadza się z ogólnym przesunięciem, np. z powodu animacji, wideo, opóźnionego ładowania lub zmiany układu. Przesunięcie wyznaczają zgodne bloki, a obszary konfliktu są obsługiwane osobno podczas składania.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'Duży ruch między klatkami pozostawił niewielką część wspólną do wyrównania. Przesunięcie oszacowano na podstawie tego małego obszaru. Przy powtarzalnym układzie sąsiedni wzór mógłby równie dobrze wyjaśniać te piksele.',
      action:
        'Jeśli późniejszy powrót dostarczy lepszych punktów odniesienia, cały ten odcinek ścieżki zostanie poprawiony, a korekta odnotowana.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'Powtarzalny wzór dopuszcza kilka przesunięć pasujących do pikseli. Wybrano najbardziej zgodne z ciągłością ruchu. To oszacowanie, a nie dowód na jedyne poprawne wyrównanie.',
      messageLowConfidence: 'Położenie tego obszaru oszacowano z niską pewnością. Piksele tego obszaru są zaznaczone na masce jakości.',
      messageStatic:
        'Klatki są niemal identyczne, ale nie mają szczegółów pozwalających potwierdzić dopasowanie. Potraktowano je jako zatrzymanie, z zerowym przesunięciem. To tylko oszacowanie.',
      action: 'Do oszacowania użyto ciągłości ścieżki i dostępnych punktów odniesienia. Wyrównanie nie jest uznawane za jedyne poprawne.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'W tym obszarze klatki nie ma rozpoznawalnych szczegółów. Pusty obraz może oznaczać zatrzymanie lub ruch nad pustą przestrzenią, a same piksele nie pozwalają tego rozróżnić. Nie zostanie nigdzie umieszczony.',
      action:
        'Jeśli treść za pustym obszarem nie ma wspólnej części z wcześniejszą obserwacją, pozostanie niezależnym fragmentem. Odległość między nimi nie będzie zgadywana.',
    },
    RELOCALIZED: {
      message:
        'Wcześniejszy punkt odniesienia pozwolił odnaleźć położenie na już obserwowanym obrazie. Ponownie odwiedzona treść nie została dopisana jako nowa część wydłużająca wynik.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Wykryto zmianę skali lub układu około {{scale}}×. Zachowano ją jako niezależny fragment z oryginalnymi pikselami, bez ukrytego skalowania przy składaniu.',
      action:
        'Relacja między fragmentami nie jest jeszcze potwierdzona. Jeśli późniejszy powrót da wiarygodne dopasowanie, fragment zostanie dołączony w całości. Nagraj ponownie z większym nakładaniem się widoków lub wydziel zmieniający się element ręcznym obszarem.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'Nie udało się potwierdzić położenia względem pierwotnego obrazu. Treść zachowano jako niezależny fragment, który można osobno wyeksportować. Fragmenty mogą się nakładać albo może je dzielić rzeczywista luka.',
      action:
        'Relacja między fragmentami nie jest jeszcze potwierdzona. Jeśli późniejszy powrót da wiarygodne dopasowanie, fragment zostanie dołączony w całości. Nagraj ponownie z większym nakładaniem się widoków lub wydziel zmieniający się element ręcznym obszarem.',
    },
    STICKY_OCCLUSION: {
      message:
        'Szczegóły u góry klatki wskazują na interfejs nieruchomy względem ekranu, a nie na ruch strony. Ten zasłaniający element nie trafia do ruchomej warstwy treści. Oryginalny interfejs odniesienia pozostaje w widoku z ramką.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'Powrót do wcześniej widzianej treści pozwolił dołączyć niezależny fragment w całości do istniejącego obrazu. Względna ścieżka wewnątrz fragmentu nie zmieniła się.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'Poprzedni krok miał niewielką część wspólną. Dopasowanie tej klatki do znanej treści różni się o {{discrepancy}} px i ma mocniejsze podstawy. Bieżące położenie zostało poprawione.',
      action:
        'Korekta obejmuje tę klatkę i dalszą ścieżkę. Wcześniej zapisane piksele nie zmieniają się, więc na styku z poprawionymi współrzędnymi może być widoczne łączenie.',
    },
    LOOP_CLOSURE: {
      message:
        'Wykryto wiarygodny powrót do wcześniej widzianego obszaru i dodano go jako warunek globalnego położenia. Końcowe składanie użyje poprawionej ścieżki.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'Dopasowanie do wcześniejszych obrazów różni się od ciągłej ścieżki o {{discrepancy}} px. Wskazówki są sprzeczne, dlatego nie narzucono go jako warunku zamknięcia pętli.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'Wyszukiwanie we wcześniejszych obrazach dało kilka niemal równie wiarygodnych położeń. Niepewny powrót nie został narzucony jako sztywny warunek.',
    },
  },
  progress: {
    runPartial: 'Zapisano rekonstrukcję wyraźnie oznaczoną jako częściowa.',
    runComplete: 'Rekonstrukcja zakończona. Sprawdź diagnostykę i niezaobserwowane obszary.',
    render: 'Składanie kafelków w oryginalnej rozdzielczości z zaobserwowanej treści. Luki pozostają przezroczyste.',
    reveal: {
      learn: 'Ponowne odczytywanie nagrania w celu znalezienia przycisków, pól wprowadzania i pasków przewijania zasłaniających stronę.',
      agree: 'Porównywanie wyglądu każdej części strony w czasie. Pierwszeństwo ma niezasłonięty widok.',
      relearn: 'Ponowne wykrywanie pływających elementów na podstawie sprawdzonej strony.',
      write: 'Zastępowanie zasłoniętych lub niedopasowanych obszarów niezasłoniętą klatką.',
    },
    framingStart: 'Zachowywanie oryginalnej ramki. Przedłużane jest tylko tło, bez rozciągania tekstu i powielania ikon.',
    pyramidBuild: 'Tworzenie poziomów podglądu na dysku. Kafelki w oryginalnej rozdzielczości pozostają bez zmian.',
    scanFrame: 'Zbieranie wskazówek geometrycznych klatka po klatce i wykrywanie niezależnych obszarów ruchu.',
    duplicateReuse: 'Identyczna obserwacja korzysta z poprzedniego położenia. Klatka źródłowa i znacznik czasu zostają zachowane.',
    solveFrame: 'Dopasowywanie do oryginalnych pikseli, odnajdywanie wcześniejszych położeń i ustalanie warunków powrotów w 2D.',
    optimizing: 'Optymalizowanie grafu położeń na dysku i korygowanie narastających przesunięć przy powrotach.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: ta przeglądarka nie potrafi zdekodować kodeka nagrania ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'iPhone i Mac zwykle nagrywają w HEVC, obsługiwanym tylko przez niektóre przeglądarki. Użyj Safari albo Chrome lub Edge z dekodowaniem sprzętowym.',
      prores: 'Żadna przeglądarka nie dekoduje ProRes. Najpierw wyeksportuj nagranie jako H.264 lub HEVC.',
      h264: 'Ten wariant H.264 (4:4:4 lub 10-bitowy) dekoduje tylko Chrome. Użyj Chrome lub wyeksportuj nagranie jako zwykłe H.264.',
      av1: 'AV1 wymaga nowej przeglądarki lub sprzętu. Użyj aktualnego Chrome albo wyeksportuj nagranie jako H.264.',
      other: 'Użyj aktualnego Chrome lub Safari albo najpierw przekonwertuj nagranie na H.264.',
    },
    PIXEL_ASPECT_RATIO:
      'Nagranie deklaruje proporcje pikseli {{num}}:{{den}}. Zapisane piksele pozostają bez skalowania, więc proporcje wyświetlanego obrazu mogą się różnić.',
    CONTAINER_SIZE_MISMATCH:
      'Kontener podaje {{codedWidth}}×{{codedHeight}}, ale strumień wideo ma faktycznie {{bitstreamWidth}}×{{bitstreamHeight}}. Obowiązują wymiary strumienia.',
    NON_SQUARE_PIXELS:
      'Nagranie deklaruje niekwadratowe piksele: wyświetlanie {{displayWidth}}×{{displayHeight}}, zapis {{bitstreamWidth}}×{{bitstreamHeight}}. Oryginalne zapisane piksele zostają zachowane bez skalowania.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'Dekoder zwrócił klatkę sprzed początku określonego listą edycji, z ujemnym znacznikiem czasu. Zgodnie z regułami kontenera takie klatki nie są pokazywane.',
    NONMONOTONIC_TIMESTAMP:
      'Znacznik czasu w kontenerze cofnął się. Przetwarzanie kontynuowano w kolejności prezentacji dekodera, bez odrzucania obserwacji.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: blok ctts tej ścieżki wideo ma wersję 0, ale zawiera ujemne przesunięcia czasu kompozycji. ISO 14496-12 definiuje je dopiero w wersji 1. Są odczytywane jako liczby ze znakiem zgodnie z powszechną konwencją QuickTime/ReplayKit, a nie jako bardzo duże wartości dodatnie.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: plik kończy się wewnątrz bloku {{box}}. Blok powinien kończyć się na bajcie {{declaredEnd}}, lecz plik ma tylko {{size}} bajtów. Nagrywanie mogło nie zakończyć się poprawnie albo plik został ucięty podczas kopiowania lub przesyłania. Dalszych klatek nie można zdekodować. Analiza znajdzie więc mniej klatek, niż podają metadane, a wynik zostanie oznaczony jako częściowy.',
  },
  exports: {
    tilesProgress: 'Eksportowanie kafelków oryginalnych i podglądu {{n}}',
    zipFinalize: 'Zapisywanie katalogu ZIP64 i zatwierdzanie pliku',
    projectDone: {
      message:
        'Wyeksportowano kafelki w oryginalnej rozdzielczości, przeglądarkę obrazów offline, dane o pokryciu i jakości, zapisy klatek źródłowych oraz pełną diagnostykę.',
    },
    encodingSingle: 'Kodowanie wiersza {{row}} / {{total}} w oryginalnej skali',
    canvasDone: {
      message: 'Wyeksportowano PNG {{width}} × {{height}} w oryginalnej rozdzielczości. Luki pozostają przezroczyste.',
    },
    encodingSheet: 'Liczba zakodowanych części w oryginalnej rozdzielczości: {{count}}',
    sheetsDone: {
      messagePaged:
        'Eksport w częściach o oryginalnej rozdzielczości. Liczba części: {{count}}. Sąsiednie obrazy nakładają się maksymalnie na {{overlap}} px, a ich współrzędne podano w manifeście.',
      messageOversize:
        'Obraz przekroczył obsługiwany rozmiar pojedynczego pliku, dlatego wyeksportowano go w częściach o oryginalnej rozdzielczości. Liczba części: {{count}}. Sąsiednie obrazy nakładają się maksymalnie na {{overlap}} px, a ich współrzędne podano w manifeście.',
    },
  },
  offline: {
    title: 'Przeglądarka obrazów offline',
    fit: 'Dopasuj',
    tip: 'Lokalne kafelki w oryginalnej rozdzielczości · przeciągnij, aby przesunąć / przewiń, aby powiększyć',
    previewLevel: 'Poziom podglądu {{level}}. Powiększ, aby zobaczyć oryginalne piksele',
    nativeTiles: 'Wyświetlanie kafelków w oryginalnej rozdzielczości',
    footer:
      'Szachownica oznacza brak obserwacji lub kafelków. Poziom pewności nie jest prawdopodobieństwem poprawności. Zobacz diagnostics.jsonl i observations.jsonl.',
  },
};
