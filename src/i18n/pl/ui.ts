import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Analiza klatek i rozdzielanie warstw ruchu',
      solving: 'Ustalanie położenia i dopasowywanie do oryginalnych pikseli',
      optimizing: 'Korygowanie powrotów i narastających przesunięć',
      rendering: 'Składanie obrazu w oryginalnej rozdzielczości',
      revealing: 'Usuwanie elementów zasłaniających stronę',
      framing: 'Zachowywanie ramki i oryginalnych proporcji',
      pyramid: 'Tworzenie podglądu z powiększaniem',
      complete: 'Gotowe · sprawdź diagnostykę',
      partial: 'Zapisano częściowy wynik',
      error: 'Błąd podczas przetwarzania',
    },
    count: {
      frames_one: '{{frames}} klatka',
      frames_other: '{{frames}} klatki',
      frames_few: '{{frames}} klatki',
      frames_many: '{{frames}} klatek',
      framesUnknown: 'Liczba klatek: ?',
      regions_one: '{{count}} własny obszar ↗',
      regions_other: '{{count}} własnego obszaru ↗',
      regions_few: '{{count}} własne obszary ↗',
      regions_many: '{{count}} własnych obszarów ↗',
    },
    dom: {
      noCompressionStream:
        'Ta przeglądarka nie obsługuje CompressionStream, potrzebnego do zapisywania kafelków jako PNG w oryginalnej rozdzielczości. Nie można rozpocząć rekonstrukcji.',
    },
    canvases: {
      badgePresentation: 'Widok z ramką · przedłużone tło nie jest zaobserwowaną treścią',
      badgeFixed: 'Warstwa stała / obserwacji',
      badgeMoving: 'Warstwa treści 2D',
      badge_one: '{{kind}} · {{count}} kafelek w oryginalnej rozdzielczości{{fragment}}',
      badge_other: '{{kind}} · {{count}} kafelka w oryginalnej rozdzielczości{{fragment}}',
      badge_few: '{{kind}} · {{count}} kafelki w oryginalnej rozdzielczości{{fragment}}',
      badge_many: '{{kind}} · {{count}} kafelków w oryginalnej rozdzielczości{{fragment}}',
      fragmentNote: ' · wzajemne wyrównanie fragmentów nie jest potwierdzone',
    },
    diagnostics: {
      occurrenceSuffix: ' (liczba zdarzeń tego typu: {{count}})',
      locateAction: 'Znajdź obszar / zobacz źródło ↗',
      viewSourceAction: 'Zobacz ten moment nagrania ↗',
      emptyFiltered: 'Brak wpisów dla tego filtra.',
      emptyDefault: 'Tutaj pojawią się wskazówki dotyczące położenia, zmiany na stronie, oszacowania i błędy przetwarzania.',
      noOriginalVideo:
        'Projekt nie zawiera oryginalnego nagrania. Wybierz ponownie ten sam plik, aby oglądać konkretne momenty. Złożony wynik nadal jest zapisany na tym urządzeniu.',
      hashMismatch:
        'Nazwa i rozmiar pliku się zgadzają, ale skrót jego zawartości różni się od nagrania użytego w tym projekcie. Ten plik nie może służyć do sprawdzania oryginalnych klatek. Wybierz właściwe nagranie.',
      sourceCaption: 'Klatka źródłowa {{frame}} · {{time}} s · {{message}}',
    },
    export: {
      imageSuffix: '-obraz',
      savePickerFallback: 'Bezpośredni zapis jest niedostępny. Plik zostanie pobrany przez przeglądarkę: {{error}}',
      saveRowLabel: 'Zapisz {{name}} · {{size}}',
      shareLabel: 'Udostępnij / zapisz w Zdjęciach',
      shareFailed: 'Nie udało się udostępnić: {{error}}',
      cleanupLabel: 'Usuń kopię tymczasową po zapisaniu',
      exportErrorAction:
        'Nieukończony eksport nie został oznaczony jako udany. Zapisane wcześniej kafelki projektu pozostają na tym urządzeniu.',
      clipboardUnsupported: 'Ta przeglądarka nie może kopiować obrazów. Użyj opcji „Pobierz obraz”.',
      copyNoImage: 'Nie wygenerowano obrazu',
      copyFailedCtor: 'Kopiowanie nie powiodło się: {{error}}. Użyj opcji „Pobierz obraz”.',
      copySuccess: 'Skopiowano obraz {{width}} × {{height}}. Możesz go teraz wkleić.',
      copyFailed:
        'Kopiowanie nie powiodło się: {{error}}. Obraz może przekraczać pojemność schowka systemowego. Użyj opcji „Pobierz obraz”.',
    },
    crop: {
      buttonCropped: 'Przytnij · {{width}} × {{height}}',
      applied:
        'Zastosowano przycięcie. Pobieranie, kopiowanie i eksport w częściach obejmują teraz tylko ten obszar ({{width}} × {{height}}). Plik ZIP całego projektu nie jest przycinany.',
      removed: 'Usunięto przycięcie. Eksport ponownie obejmuje cały obraz.',
    },
    main: {
      offscreenMissing: 'Ta przeglądarka nie obsługuje OffscreenCanvas. Worker renderowania nie może działać.',
      webcodecsMissingToast:
        'Ta przeglądarka nie obsługuje WebCodecs. Aby kontynuować, wybierz „Przybliżone · odtwarzacz przeglądarki”. Niektóre klatki mogą zostać pominięte.',
      privateStorageToast:
        'Tryb prywatny: projekt jest przechowywany tylko w pamięci tego okna i zniknie po jego zamknięciu. Wyeksportuj go wcześniej, jeśli chcesz go zachować.',
      noOpfsNoPicker:
        'Ta przeglądarka nie udostępnia ani OPFS, ani okna zapisu pliku. Eksport powstanie w pamięci operacyjnej, do {{mb}} MB.',
      dbOpenFailed: 'Nie udało się otworzyć lokalnej bazy danych: {{error}}',
      workerErrorToast: 'Błąd workera: {{message}}',
      workerMessageUndecodable: 'Nie udało się odczytać wiadomości workera. Zachowaj istniejące wyniki i odśwież stronę.',
      interruptedPhaseWhere: '„{{phase}}”, klatka {{frames}}',
      interruptedStartPhase: 'uruchamianie',
      interruptedHiddenSome: 'strona była w tle przez około {{seconds}} s{{stillHidden}}',
      interruptedStillHidden: ' (również w chwili przerwania)',
      interruptedHiddenNone: 'strona przez cały czas była na pierwszym planie',
      interruptedDiagnosticMessage:
        'Poprzednia rekonstrukcja została przerwana. Miejsce przerwania: {{where}}. Strona nie otrzymała sygnału zakończenia; przeglądarka zamknęła ją lub uległa awarii. Czas pracy: {{elapsed}} s, pamięć silnika: {{memory}} MB, {{hidden}}, konwersja klatek: {{conversion}}, rdzenie CPU: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari zamyka strony w tle przy znacznie niższym zużyciu pamięci. Przy dłuższym przetwarzaniu pozostaw tę kartę na pierwszym planie. Pełny raport zapisano w konsoli przeglądarki.',
      interruptedNotIsolated: ' (bez izolacji między źródłami, jeden wątek)',
      interruptedToast: 'Poprzednia rekonstrukcja została przerwana. Etap: {{where}} ({{hidden}}). Szczegóły znajdziesz w diagnostyce.',
      unknownValue: 'brak danych',
    },
    run: {
      pausedStatus: 'Wstrzymano · stan zachowany w pamięci',
      resumedStatus: 'Wznawianie',
      pauseLabel: 'Wstrzymaj',
      resumeLabel: 'Wznów',
      stopToast: 'Kończenie bieżącego etapu. Następnie zostanie złożone i zapisane wszystko, co da się zachować.',
      preparingStatus: 'Przygotowywanie dokładnego dekodowania',
      preparingMessage: 'Odczytywanie kontenera oraz sprawdzanie kodeka i pamięci lokalnej.',
      compatibilityNeedsNative:
        'Tryb „Przybliżone · odtwarzacz przeglądarki” wymaga, aby wbudowany odtwarzacz przeglądarki potrafił odczytać to nagranie.',
      webcodecsHttpBlocked:
        'Pod tym adresem HTTP przeglądarka nie udostępnia WebCodecs. Aby kontynuować lokalny test, wybierz „Przybliżone · odtwarzacz przeglądarki”. Dokładne dekodowanie wymaga localhost lub HTTPS. Nagranie nie jest wysyłane.',
      webcodecsMissing:
        'Ta przeglądarka nie obsługuje WebCodecs. Zaktualizuj Safari / iOS lub wybierz „Przybliżone · odtwarzacz przeglądarki”, które może pominąć niektóre klatki.',
      startFailedStatus: 'Nie udało się rozpocząć rekonstrukcji',
      restoredMessage: 'To Twój ostatni wynik. Gdy będzie miał ponad 24 godziny, zostanie usunięty przy następnym otwarciu strony.',
      interruptedStatus: 'Poprzednie przetwarzanie nie zostało ukończone',
      interruptedMessage: 'To części zapisane przed przerwaniem. Aby uzyskać pełny wynik, włóż ponownie nagranie i rozpocznij od nowa.',
      waitingCanvasOption: 'Oczekiwanie na odtworzony obraz',
    },
    source: {
      busyToast: 'Najpierw zakończ lub zapisz bieżące przetwarzanie.',
      subtitleReading: '{{size}} · bez wysyłania · odczytywanie kontenera i pierwszej klatki',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · dostępne tylko we wbudowanym odtwarzaczu',
      subtitleUnavailable: '{{size}} · brak dokładnego dekodowania i podglądu w odtwarzaczu',
      probeFailedMessage: 'Sprawdzanie dokładnego dekodowania nie powiodło się: {{error}}',
      probeFailedAction:
        'Nastąpi próba odczytania metadanych przez odtwarzacz przeglądarki. Aby kontynuować, wybierz dekodowanie „Przybliżone · odtwarzacz przeglądarki”.',
      rejectedVideo:
        'Nie otwarto pliku „{{name}}”. Rozpoznany typ: {{kind}}. Przeglądarka nie potrafi czytać tego formatu klatka po klatce. Ustaw nagrywanie ekranu w MP4 lub najpierw przekonwertuj plik na MP4 za pomocą HandBrake albo ffmpeg.',
      rejectedOther:
        '„{{name}}” nie jest nagraniem wideo ({{kind}}) i nie został otwarty. Wybierz nagranie ekranu w formacie MP4, MOV, WebM lub MKV. W Windows użyj Narzędzia Wycinanie albo Xbox Game Bar (Win+Alt+R), na Macu naciśnij ⌘⇧5, a na telefonie użyj wbudowanego nagrywania ekranu.',
      unreadableToast:
        'Nie można odczytać tego nagrania ({{reason}}). Sprawdź, czy nagrywanie zakończyło się prawidłowo i czy plik został w całości skopiowany lub pobrany. Jeśli problem pozostaje, spróbuj pliku MP4 z H.264. Diagnostyka wyjaśnia przyczynę niepowodzenia dokładnego dekodowania.',
      kind: {
        empty: 'pusty plik',
        heif: 'obraz HEIC/AVIF',
        avi: 'wideo AVI',
        webp: 'obraz WebP',
        wav: 'plik dźwiękowy WAV',
        riff: 'plik RIFF',
        wmv: 'wideo WMV/ASF',
        flv: 'wideo FLV',
        mpegps: 'wideo MPEG-PS',
        ogg: 'plik multimedialny Ogg',
        gif: 'animacja GIF',
        png: 'obraz PNG',
        jpeg: 'obraz JPEG',
        pdf: 'dokument PDF',
        zip: 'archiwum ZIP lub dokument Office',
        mp3: 'plik dźwiękowy MP3',
        text: 'plik tekstowy',
        mpegts: 'wideo MPEG-TS',
        unknown: 'nierozpoznany plik',
      },
    },
    demo: {
      fileName: 'przykladowe-nagranie.mp4',
      loadFailed: 'Nie udało się wczytać przykładowego nagrania: {{error}}',
    },
    feedback: {
      issueBody:
        '**Co się stało?**\n\n\n**Jaki miał być wynik?**\n\n\n**O nagraniu** (jaka strona, sposób poruszania się, przybliżona długość; zrzut ekranu pomoże, ale ukryj prywatne dane)\n\n\n---\nUzupełnione przez Long Screen. Możesz zmienić lub usunąć:\n- Przeglądarka: {{browser}}\n- Otwarto z: {{page}}\n- Silnik wielowątkowy (izolacja między źródłami): {{threads}}\n- Ostrzeżenia w dzienniku: {{warnings}}\n',
      portable: 'wersja przenośna (plik lokalny)',
      yes: 'tak',
      no: 'nie',
      none: 'brak',
    },
    viewer: {
      previewLevel: 'Podgląd L{{level}} (oryginalny rozmiar bez zmian)',
      nativeLevel: 'Oryginalne piksele L0',
      qualityHint: ' · powiększ, aby zobaczyć maskę jakości',
      unobservedHint: ' · niebieski = brak obserwacji',
      provisionalHint: ' · fioletowy = treść chwilowa / nakładka',
    },
  },
  names: {
    fixed: 'Stały interfejs',
    divider: 'Stały separator',
    contentCanvas: 'Obraz treści {{n}}',
    unassigned: 'Nieprzypisany obszar · obserwacje we współrzędnych ekranu',
    contentRegion: 'Obszar treści {{n}}',
    ignored: 'Ignorowane',
    fragment: 'fragment bez ustalonego położenia {{n}}',
    framed: 'z ramką',
  },
};
