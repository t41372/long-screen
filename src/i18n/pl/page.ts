import type { Catalog } from '../catalog.ts';
import type { pageSections as zh } from '../zh/page.ts';

export const pageSections: Catalog<typeof zh> = {
  language: {
    label: 'Język interfejsu',
    saveFailed: 'Nie udało się zapisać języka. Przeglądarka blokuje pamięć lokalną.',
  },
  page: {
    title: 'Long Screen — Z nagrania ekranu w jeden duży obraz',
    description:
      'Zamień nagranie ekranu w jeden duży obraz w oryginalnej rozdzielczości. Przewijaj, przesuwaj widok po skosie, zatrzymuj się i wracaj — nie tylko w dół. Ramka okna i paski stanu zostaną zachowane. Wszystko działa lokalnie w przeglądarce, bez wysyłania plików.',
    closeLabel: 'Zamknij',
    header: {
      brandLabel: 'Strona główna Long Screen',
      slogan: 'DOWOLNY KIERUNEK · JEDEN DUŻY OBRAZ',
      privacy: 'Twoje obrazy zostają na tym urządzeniu',
      helpLabel: 'Pomoc i możliwości',
      star: 'Dodaj gwiazdkę na GitHubie',
      starLabel: 'Dodaj gwiazdkę na GitHubie (otwiera nową kartę)',
      install: 'Zainstaluj aplikację',
      installTitle: 'Zainstaluj Long Screen na tym urządzeniu: otwieraj jak aplikację i korzystaj offline',
    },
    install: {
      title: 'Zainstaluj na tym urządzeniu',
      intro:
        'Long Screen można zainstalować jako aplikację internetową (PWA). Otwiera się z ekranu początkowego lub Docka we własnym oknie i działa bez połączenia z internetem. Nagrania nadal są przetwarzane wyłącznie na tym urządzeniu.',
      iosShare: 'Stuknij przycisk udostępniania w przeglądarce. W Safari znajdziesz go na dolnym pasku narzędzi lub w menu ⋯.',
      iosAdd: 'Przewiń do opcji Dodaj do ekranu początkowego.',
      iosConfirm: 'Stuknij Dodaj.',
      iosInApp: 'Jeśli strona otworzyła się wewnątrz innej aplikacji, np. WeChat lub LINE, najpierw otwórz ją w Safari.',
      macFile: 'Na pasku menu u góry ekranu wybierz Plik → Dodaj do Docka.',
      macConfirm: 'Kliknij Dodaj.',
      offline: 'Po instalacji otwórz aplikację raz z dostępem do internetu. Potem będzie działać offline.',
    },
    hero: {
      heading: 'Z nagrania ekranu<br>w <span class="hl">jeden duży obraz</span>.',
      intro:
        'Nagrywaj ekran podczas przeglądania strony, aplikacji lub projektu graficznego. Przewijaj, przesuwaj widok w dowolnym kierunku i wracaj do wcześniejszych miejsc. Long Screen układa pokazane fragmenty w jeden PNG w oryginalnej rozdzielczości, zachowując ramkę okna i paski stanu. Wszystko działa w przeglądarce, bez wysyłania plików.',
      demoLead: ' Chcesz najpierw zobaczyć efekt?',
      demoChip: 'Wypróbuj przykładowe nagranie',
    },
    steps: {
      ariaLabel: 'Jak to działa',
      recordTitle: 'Nagraj',
      recordBody: 'Nagrywaj ekran, poruszając się po stronie lub aplikacji w dowolny sposób.',
      feedTitle: 'Włóż',
      feedBody: 'Przeciągnij nagranie na ekran drukarki i kliknij Rozpocznij.',
      takeTitle: 'Odbierz',
      takeBody: 'Pobierz jeden obraz w oryginalnej rozdzielczości. Nienagrane miejsca pozostaną puste.',
    },
    press: {
      ariaLabel: 'Drukarka',
      core: 'Wersja silnika',
      build: 'Commit, z którego zbudowano tę stronę',
    },
    screen: {
      dropTitle: 'Upuść nagranie tutaj',
      dropHint: 'lub kliknij, aby wybrać plik · MP4 · MOV · WebM',
    },
    observe: {
      dropTitle: 'Nie wybrano nagrania',
      dropSubtitle: 'MP4 · MOV · WebM · zostaje na tym urządzeniu',
    },
    controls: {
      print: 'Rozpocznij',
      progress: 'Postęp',
      knobs: 'Ustawienia',
      clear: 'Wyczyść',
      clearTitle: 'Usuń nagranie, wynik i jego dziennik z drukarki',
    },
    tray: {
      ariaLabel: 'Podgląd całego obrazu',
      idleTitle: 'Tutaj pojawi się cały obraz',
      story1: 'Nagranie wędruje po stronie…',
      story2: 'Każdy pokazany fragment trafia na swoje miejsce',
      story3: 'Gotowe — jeden duży obraz!',
      story4: 'Na telefonie nagrywaj podczas przewijania w dół…',
      story5: 'Kolejne ekrany łączą się w całość, pasek stanu zostaje jeden',
      story6: 'Zwykłe długie zrzuty ekranu też się sprawdzają!',
    },
    reconstruct: {
      heading: 'Ustawienia przetwarzania',
      sub: 'Domyślne ustawienia zwykle wystarczą. Zmień je w razie potrzeby.',
      policyLabel: 'Konflikty',
      policyStable: 'Zachowaj stabilny widok',
      policyLatest: 'Preferuj nowszy widok',
      framingLabel: 'Ramka',
      framingContext: 'Zachowaj ramkę i interfejs',
      framingRegion: 'Tylko treść i marginesy',
      regionsLabel: 'Obszary ruchu',
      regionsAuto: 'Wykrywane automatycznie ↗',
      advancedSummary: 'Więcej ustawień <span>＋</span>',
      analysisSizeLabel: 'Dłuższy bok do analizy',
      memoryLabel: 'Limit pamięci kafelków',
      computeLabel: 'Przyspieszenie',
      computeAuto: 'Auto · WebGPU / CPU',
      computeWebgpu: 'WebGPU · wyrównanie na CPU',
      computeCpu: 'Tylko CPU',
      computeHint:
        'GPU przekształca zdekodowane klatki w piksele i zmniejsza miniatury do analizy. Dopasowywanie i składanie nadal wykonuje CPU. Tryb Auto najpierw porównuje szybkość obu metod i używa GPU tylko wtedy, gdy jest szybsze.',
      decoderLabel: 'Dekodowanie',
      decoderPrecise: 'Dokładne · WebCodecs',
      decoderCompatibility: 'Przybliżone · odtwarzacz przeglądarki',
      decoderHint:
        'Miniatury do analizy nie zmieniają pikseli wyniku. Pamięć podręczna zawiera tylko gotowe kafelki i automatycznie rośnie, jeśli jedna klatka obejmuje ich więcej, niż się w niej mieści. Dlatego ma niewielki wpływ na szybkość. Nie obejmuje pamięci przeglądarki, dekodera, GPU ani silnika. Tryb „Przybliżone · odtwarzacz przeglądarki” może pominąć treści widoczne tylko przez chwilę.',
      pauseBtn: 'Wstrzymaj',
      stopBtn: 'Zatrzymaj i zapisz',
      footerNote: 'Bez wysyłania · bez obliczeń w chmurze · bez zewnętrznych modeli',
    },
    canvas: {
      ariaLabel: 'Odtworzony obraz',
      selectAriaLabel: 'Wybierz odtworzony obraz',
      waitingOption: 'Oczekiwanie na dane obrazu',
      qualityMask: 'Maska jakości',
      fitTitle: 'Dopasuj do okna',
      fitBtn: 'Dopasuj',
      nativeTitle: 'Oryginalny rozmiar',
      viewerAriaLabel: 'Przesuwany i powiększany obraz 2D z niezaobserwowanymi obszarami',
      zoomOutLabel: 'Pomniejsz',
      zoomInLabel: 'Powiększ',
      expandLabel: 'Rozwiń podgląd',
      emptyTitle: 'Składanie obrazu…',
      emptyBody: 'Każda klatka znajduje swoje miejsce w całości.',
      statusReady: 'Gotowe',
      progressMessageDefault: 'Włóż nagranie → kliknij Rozpocznij → pobierz cały obraz',
      lodLabel: 'Szachownica = miejsce poza nagraniem',
    },
    understand: {
      noteBtn: 'Dziennik',
      heading: 'Dziennik przetwarzania',
      desc: 'Tutaj sprawdzisz, dlaczego fragmenty trafiły w dane miejsca, co zmieniło się na stronie i jakie wystąpiły problemy.',
      framesLabel: 'Liczba złożonych klatek',
      canvasesLabel: 'Liczba niezależnych obrazów',
      coverageBody:
        'Przezroczystość ≠ biała strona <br><small>Te miejsca nie zostały zaobserwowane. Brakująca treść nie jest wymyślana.</small>',
      diagnosticsHeading: 'Diagnostyka',
      filterAriaLabel: 'Filtruj komunikaty diagnostyczne',
      filterAll: 'Wszystkie',
      filterIssues: 'Ostrzeżenia / błędy',
      diagnosticsAriaLabel: 'Diagnostyka przetwarzania',
      diagnosticsEmpty: 'Tutaj pojawią się wskazówki dotyczące położenia, zmiany na stronie, <br>oszacowania i błędy przetwarzania.',
      moreDiagnostics: 'Pokaż więcej komunikatów',
      reportLead: 'Nieprawidłowy wynik lub coś nie działa?',
      reportBtn: 'Zgłoś na GitHubie',
      reportNote:
        'Zgłoszenie zawiera już informacje o przeglądarce i kody ostrzeżeń z tego dziennika. Nigdy nie zawiera nagrania, obrazów ani nazwy pliku. Przed wysłaniem możesz je przeczytać i zmienić.',
    },
    export: {
      downloadPng: 'Pobierz obraz · PNG <span>↓</span>',
      copyPng: 'Kopiuj obraz',
      outputSize: 'Rozmiar wyjściowy',
      originalSize: 'Oryginał · 100%',
      customSize: 'Ustaw dłuższy bok',
      longestEdge: 'Dłuższy bok (px)',
      sizeNote:
        'Dotyczy pobierania i kopiowania. Proporcje pozostają bez zmian; tekst też się zmniejsza. Oryginał, eksport stron i projekt zachowują oryginalny rozmiar.',
      pngNote: 'Jeden PNG w wybranym rozmiarze.',
      advancedSummary: 'Inne opcje eksportu',
      exportProject: 'Eksportuj cały projekt · ZIP',
      projectNote:
        'Kafelki w oryginalnej rozdzielczości, przeglądarka obrazów offline, dane o pokryciu i jakości oraz pełna diagnostyka — do archiwizacji lub analizy problemów.',
      exportSheets: 'Podziel na wiele PNG · ZIP',
      sheetsNote:
        'Dzieli zbyt duży obraz na pliki PNG o obsługiwanych wymiarach, bez obniżania rozdzielczości. Sąsiednie części zachodzą na siebie na 32 px, a manifest zawiera ich współrzędne w całym obrazie.',
      starNudge: 'Przydatne? Dodaj gwiazdkę na GitHubie',
    },
    help: {
      title: 'Obraz o znanym pochodzeniu',
      pixelsHeading: 'Które piksele zostają zachowane?',
      pixelsBody:
        'Tryb dokładny dekoduje klatka po klatce. Każda przetworzona obserwacja ma znacznik czasu i zapis kompozycji. Analiza może używać pomniejszonych obrazów; końcowa kompozycja zachowuje oryginalne piksele. Obrazy do pobrania i skopiowania można potem zmniejszyć.',
      frameHeading: 'Ramka i oryginalne marginesy',
      frameBody:
        'Domyślnie zachowywane są tło, marginesy i puste miejsca całego przewijanego obszaru. Obraz nie jest przycinany do granic tekstu. Widok z ramką zawiera dodatkowo interfejs z jednej klatki odniesienia: tekst w panelach bocznych i ikony pasków narzędzi pojawiają się raz, w oryginalnym rozmiarze. Rozszerzone obszary jedynie przedłużają dekoracyjne tło i nie są zaobserwowaną treścią. Oryginalna warstwa treści zawsze pozostaje dostępna osobno. Inne niezależne panele nie są przedstawiane tak, jakby dzieliły tę samą ścieżkę ruchu.',
      scopeHeading: 'Z samych obrazów nie da się wywnioskować wszystkiego',
      scopeBody:
        'Rozdzielanie warstw ruchu, dopasowywanie powtarzalnych wzorów i przypisywanie dynamicznych obszarów opierają się na wnioskowaniu z obrazu. Zmiany skali, brak wspólnych fragmentów lub niezgodne układy mogą dać niezależne fragmenty, których wzajemne wyrównanie nie jest potwierdzone. Poziom pewności nie jest skalibrowanym prawdopodobieństwem poprawności wyniku.',
      storageHeading: 'Długie nagrania i przechowywanie',
      storageBody:
        'Dekodowanie w trzech przebiegach ogranicza zużycie pamięci kosztem miejsca na dysku i czasu obliczeń. Przeglądarka przechowuje tylko ostatni wynik, najwyżej przez 24 godziny. Wraca on po odświeżeniu lub przypadkowym zamknięciu strony. Po przerwanym przetwarzaniu wracają zapisane wcześniej części, ale nie można wznowić obliczeń od tego miejsca. Nowe przetwarzanie lub przycisk Wyczyść usuwa wynik. Jeśli ma ponad 24 godziny, zostanie usunięty przy następnym otwarciu strony. Pobierz to, co chcesz zachować.',
      privacyHeading: 'Czy nagranie opuszcza to urządzenie?',
      privacyBody:
        'Nie. Dekodowanie, analiza i składanie odbywają się w przeglądarce. Nagranie i wynik pozostają na tym urządzeniu. Po załadowaniu strony możesz kontynuować bez internetu. Witryna pod adresem long-screen.yi-ting.com korzysta z dwóch anonimowych pomiarów. Cloudflare Web Analytics liczy wizyty i otrzymuje tylko adres otwartej strony, źródło wizyty, typ przeglądarki i urządzenia, kraj oraz szybkość ładowania. PostHog mierzy użycie drukarki: jedno zdarzenie przy otwarciu strony, jedno przy rozpoczęciu przetwarzania i jedno przy zakończeniu. Zawierają tylko ustawienia, wersję silnika, kodek, wysokość obrazu i długość nagrania w minutach, przybliżoną liczbę klatek, liczbę wynikowych obrazów, czas przetwarzania i kody diagnostyczne. Każde zdarzenie zawiera też adres strony, źródło wizyty, przeglądarkę i system operacyjny, rozmiar ekranu, język, strefę czasową i kraj. Żadna z usług nie używa plików cookie, a PostHog niczego nie zapisuje w przeglądarce. Żadna nie otrzymuje nagrania, wyniku, nazw plików ani komunikatów błędów. Przy włączonym Do Not Track lub Global Privacy Control PostHog w ogóle się nie ładuje. Kopie hostowane samodzielnie i wersja offline w jednym pliku nie prowadzą pomiarów. Polityka bezpieczeństwa treści pozwala stronie łączyć się tylko z własną witryną i tymi dwiema usługami. Pozostałe połączenia blokuje przeglądarka.',
      browserHeading: 'Przeglądarki i formaty',
      browserBody:
        'Wymagane są IndexedDB, OffscreenCanvas i CompressionStream. Podczas lokalnego programowania HTTP na localhost działa bez certyfikatu. Telefon otwierający adres HTTP w sieci lokalnej może użyć trybu „Przybliżone · odtwarzacz przeglądarki”, który może pomijać klatki. Dokładne dekodowanie WebCodecs i API zapisu na dysku są zwykle dostępne tylko na localhost lub przez HTTPS. Nie ma to związku z wysyłaniem plików. Dokładne dekodowanie wymaga też obsługi danego kodeka przez urządzenie. Kontener MP4, MOV lub WebM nie gwarantuje, że urządzenie odczyta całą jego zawartość.',
      tipsHeading: 'Jak uzyskać lepszy wynik?',
      tipsBody:
        'Zadbaj o wystarczające nakładanie się widoków i poruszaj się wolniej w miejscach z małą liczbą szczegółów. Jeśli panele lub pływające elementy są rozpoznawane błędnie, zaznacz je ręcznie w sekcji „Obszary ruchu” przed rozpoczęciem. Pełny projekt pozwala wyeksportować wszystkie komunikaty diagnostyczne.',
      feedbackHeading: 'Uwagi i kod źródłowy',
      feedbackBody:
        'Long Screen ma otwarty kod na licencji MIT, dostępny na <a href="https://github.com/t41372/long-screen" target="_blank" rel="noopener">GitHubie</a>. Jeśli napotkasz błąd lub nieprawidłowy wynik, <a class="report-link" href="https://github.com/t41372/long-screen/issues/new" target="_blank" rel="noopener">utwórz zgłoszenie</a>. Informacje o przeglądarce i kody ostrzeżeń z dziennika zostaną wpisane automatycznie. Jeśli projekt Ci się przydaje, gwiazdka bardzo nam pomoże.',
      toolsHeading: 'Także poza tą stroną',
      toolsBody:
        'Silnik działa też samodzielnie: w <a href="https://github.com/t41372/long-screen#command-line" target="_blank" rel="noopener">wierszu poleceń</a>, jako <a href="https://github.com/t41372/long-screen#rust-library" target="_blank" rel="noopener">biblioteka Rust</a>, <a href="https://github.com/t41372/long-screen#python-package" target="_blank" rel="noopener">pakiet Python</a> i <a href="https://github.com/t41372/long-screen#typescript-package" target="_blank" rel="noopener">pakiet TypeScript</a> dla innych stron internetowych. Te narzędzia również przetwarzają nagrania wyłącznie na Twoim urządzeniu. Instalację i użycie opisuje README.',
      licenseHeading: 'Licencje open source',
      licenseBody:
        'Kod Long Screen jest udostępniony na licencji MIT. Możesz go bezpłatnie używać, kopiować, zmieniać i rozpowszechniać, sprzedawać lub dołączać do produktów o zamkniętym kodzie, pod warunkiem zachowania informacji o prawach autorskich i <a href="https://github.com/t41372/long-screen/blob/main/LICENSE" target="_blank" rel="noopener">tekstu licencji</a>. Oprogramowanie jest dostarczane bez gwarancji. Zależności dołączone do silnika Wasm i interfejsu wraz z licencjami, a także źródła i licencje logotypów Rust, WebAssembly i GitHub, znajdują się w <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">informacjach o licencjach</a> generowanych podczas budowania.',
    },
    regions: {
      title: 'Wyznacz niezależne obszary ruchu',
      hint:
        'Narysuj prostokąt na obrazie. Każdy obszar treści zostanie odtworzony niezależnie. Niezaznaczone części pozostaną w osobnej warstwie obserwacji, z wyraźnym oznaczeniem niskiej pewności. Obszary oznaczone jako ignorowane będą całkowicie wykluczone.',
      kindMoving: 'Treść · przewijana niezależnie',
      kindFixed: 'Stały interfejs',
      kindIgnore: 'Ignoruj · wyklucz z wyniku',
      clearBtn: 'Przywróć automatyczne wykrywanie',
      saveBtn: 'Zapisz obszary',
    },
    source: {
      title: 'Oryginalna klatka',
    },
    crop: {
      button: 'Przytnij',
      groupLabel: 'Obszar przycięcia',
      left: 'Od lewej',
      top: 'Od góry',
      width: 'Szerokość',
      height: 'Wysokość',
      full: 'Cały obraz',
      cancel: 'Anuluj',
      apply: 'Zastosuj przycięcie',
    },
    footer: {
      stackLead: 'Silnik napisano w języku',
      stackMid: 'i skompilowano do',
      stackTail: 'aby działał bezpośrednio w przeglądarce.',
      stackMore: 'Interfejs w TypeScript · budowanie i testy z Deno',
      linksLabel: 'Linki projektu',
      source: 'Kod na GitHubie',
      report: 'Zgłoś błąd',
      notices: 'Informacje o licencjach',
      trademarks:
        'Nazwy i logotypy Rust, WebAssembly, TypeScript, Deno i GitHub należą do ich właścicieli. Wskazują tylko użyte technologie i nie oznaczają, że ich właściciele popierają ten projekt.',
    },
  },
  deviceCheck: {
    doneTitle: 'Sprawdzanie urządzenia zakończone',
    title: 'Sprawdź urządzenie',
    intro:
      'Mierzy możliwości przeglądarki i urządzenia (izolacja między źródłami, wątki, adapter WebGPU) oraz rzeczywisty koszt użycia GPU:\nprzesłanie klatki RGBA w oryginalnej rozdzielczości do GPU i z powrotem, czas zmniejszania obrazów do analizy oraz zgodność wyników GPU i silnika Rust bajt po bajcie.\nOpcjonalnie wybierz nagranie, aby porównać odciski kafelków po pełnym przetworzeniu na CPU i z wymuszonym WebGPU.\nWszystko odbywa się na tym urządzeniu, bez wysyłania plików. Dane testu nagrania są usuwane po porównaniu. WebGPU wymaga bezpiecznego kontekstu: localhost lub HTTPS.',
    recordingLabel: 'Nagranie (opcjonalnie):',
    runBtn: 'Rozpocznij sprawdzanie',
    loadingReport: 'Wczytywanie silnika…',
  },
};
