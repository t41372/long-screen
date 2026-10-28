import type { Catalog } from '../catalog.ts';
import type { pageSections as zh } from '../zh/page.ts';

export const pageSections: Catalog<typeof zh> = {
  language: {
    label: 'Sprache der Oberfläche',
    saveFailed: 'Die Sprache konnte nicht gespeichert werden, weil dieser Browser den lokalen Speicher blockiert.',
  },
  page: {
    title: 'Long Screen — Aus einer Bildschirmaufnahme wird ein großes Bild',
    description:
      'Mache aus einer Bildschirmaufnahme ein großes Bild in Originalgröße. Scrolle, schwenke, bewege dich diagonal oder kehre zurück. Fensterrahmen und Statusleisten bleiben erhalten. Alles läuft lokal in deinem Browser, ohne Upload.',
    closeLabel: 'Schließen',
    header: {
      brandLabel: 'Long Screen Startseite',
      slogan: 'JEDER WEG · EIN GROSSES BILD',
      privacy: 'Deine Bilder bleiben auf diesem Gerät',
      helpLabel: 'Hilfe und Funktionen',
      star: 'Stern auf GitHub vergeben',
      starLabel: 'Stern auf GitHub vergeben (öffnet einen neuen Tab)',
      install: 'App installieren',
      installTitle: 'Long Screen auf diesem Gerät installieren: als eigene App öffnen und offline nutzen',
    },
    install: {
      title: 'Auf diesem Gerät installieren',
      intro:
        'Long Screen lässt sich als Web-App (PWA) installieren. Sie öffnet sich vom Home-Bildschirm oder Dock in einem eigenen Fenster und funktioniert auch offline. Aufnahmen werden weiterhin nur auf diesem Gerät verarbeitet.',
      iosShare: 'Tippe im Browser auf die Teilen-Taste. In Safari findest du sie unten in der Symbolleiste oder unter ⋯.',
      iosAdd: 'Scrolle zu „Zum Home-Bildschirm“.',
      iosConfirm: 'Tippe auf „Hinzufügen“.',
      iosInApp: 'Falls die Seite in einer anderen App geöffnet wurde, etwa WeChat oder LINE, öffne sie zuerst in Safari.',
      macFile: 'Wähle oben in der Menüleiste „Ablage“ → „Zum Dock hinzufügen“.',
      macConfirm: 'Klicke auf „Hinzufügen“.',
      offline: 'Öffne die App nach der Installation einmal mit Internetverbindung. Danach funktioniert sie offline.',
    },
    hero: {
      heading: 'Aus einer Bildschirmaufnahme<br>wird <span class="hl">ein großes Bild</span>.',
      intro:
        'Nimm deinen Bildschirm auf, während du eine Webseite, App oder einen Entwurf erkundest: scrolle, schwenke, bewege dich diagonal oder kehre zurück. Long Screen setzt die gezeigten Bereiche zu einer PNG-Datei in Originalgröße zusammen, einschließlich Fensterrahmen und Statusleisten. Alles läuft in deinem Browser, ohne Upload.',
      demoLead: ' Erst einmal ausprobieren?',
      demoChip: 'Beispielaufnahme starten',
    },
    steps: {
      ariaLabel: 'So funktioniert’s',
      recordTitle: 'Aufnehmen',
      recordBody: 'Nimm den Bildschirm auf und bewege dich nach Belieben durch eine Seite oder App.',
      feedTitle: 'Einlegen',
      feedBody: 'Ziehe die Aufnahme auf den Bildschirm des Druckers und klicke auf „Starten“.',
      takeTitle: 'Mitnehmen',
      takeBody: 'Speichere ein großes Bild in Originalgröße. Nicht gefilmte Bereiche bleiben leer.',
    },
    press: {
      ariaLabel: 'Der Drucker',
      core: 'Version des Rechenkerns',
      build: 'Commit, aus dem diese Seite erstellt wurde',
    },
    screen: {
      dropTitle: 'Aufnahme hier ablegen',
      dropHint: 'oder Datei per Klick auswählen · MP4 · MOV · WebM',
    },
    observe: {
      dropTitle: 'Noch keine Aufnahme',
      dropSubtitle: 'MP4 · MOV · WebM · bleibt auf diesem Gerät',
    },
    controls: {
      print: 'Starten',
      progress: 'Fortschritt',
      knobs: 'Einstellungen',
      clear: 'Leeren',
      clearTitle: 'Aufnahme entfernen und dieses Ergebnis samt Protokoll löschen',
    },
    tray: {
      ariaLabel: 'Vorschau des Gesamtbilds',
      idleTitle: 'Hier erscheint dein Gesamtbild',
      story1: 'Die Aufnahme wandert über die Seite…',
      story2: 'Jeder gezeigte Bereich findet seinen Platz',
      story3: 'Fertig ist ein großes Bild!',
      story4: 'Auf dem Handy nach unten scrollen und aufnehmen…',
      story5: 'Bild für Bild zusammengesetzt, mit nur einer Statusleiste',
      story6: 'Klassische lange Screenshots gehen natürlich auch!',
    },
    reconstruct: {
      heading: 'Verarbeitung einstellen',
      sub: 'Die Voreinstellungen passen meist. Hier kannst du sie bei Bedarf anpassen.',
      policyLabel: 'Bei Änderungen',
      policyStable: 'Stabile Ansicht behalten',
      policyLatest: 'Neuere Ansicht bevorzugen',
      framingLabel: 'Rahmen',
      framingContext: 'Rahmen und Oberfläche',
      framingRegion: 'Nur Inhalt und Ränder',
      regionsLabel: 'Bewegungsbereiche',
      regionsAuto: 'Automatisch erkannt ↗',
      advancedSummary: 'Weitere Einstellungen <span>＋</span>',
      analysisSizeLabel: 'Lange Kante der Analysebilder',
      memoryLabel: 'Limit des Kachel-Caches',
      computeLabel: 'Beschleunigung',
      computeAuto: 'Auto · WebGPU / CPU',
      computeWebgpu: 'WebGPU · CPU-Ausrichtung',
      computeCpu: 'Nur CPU',
      computeHint:
        'Die GPU wandelt dekodierte Videobilder in Pixel um und verkleinert die Analysebilder. Ausrichtung und Zusammensetzen laufen weiter auf der CPU. „Auto“ misst zuerst beide Wege und nutzt die GPU nur, wenn sie schneller ist.',
      decoderLabel: 'Dekodierung',
      decoderPrecise: 'Exakt · WebCodecs',
      decoderCompatibility: 'Näherungsweise · nativer Player',
      decoderHint:
        'Die Größe der Analysebilder verändert die Ausgabepixel nicht. Der Cache enthält nur fertige Kacheln und wächst automatisch, wenn ein Videobild mehr Kacheln berührt, als hineinpassen. Deshalb beeinflusst er die Geschwindigkeit kaum. Speicher für Browser, Decoder, GPU und Rechenkern zählt nicht dazu. „Näherungsweise · nativer Player“ kann kurz sichtbare Inhalte verpassen.',
      pauseBtn: 'Pausieren',
      stopBtn: 'Stoppen und speichern',
      footerNote: 'Kein Upload · keine Cloud-Berechnung · keine externen Modelle',
    },
    canvas: {
      ariaLabel: 'Rekonstruiertes Bild',
      selectAriaLabel: 'Rekonstruiertes Bild auswählen',
      waitingOption: 'Warten auf Bilddaten',
      qualityMask: 'Qualitätsmaske',
      fitTitle: 'An Fenster anpassen',
      fitBtn: 'Einpassen',
      nativeTitle: 'Originalgröße',
      viewerAriaLabel: 'Verschiebbare und zoombare 2D-Bildfläche mit unbeobachteten Bereichen',
      zoomOutLabel: 'Verkleinern',
      zoomInLabel: 'Vergrößern',
      expandLabel: 'Vorschau vergrößern',
      emptyTitle: 'Wird zusammengesetzt…',
      emptyBody: 'Jedes Videobild findet seinen Platz im Gesamtbild.',
      statusReady: 'Bereit',
      progressMessageDefault: 'Aufnahme einlegen → Starten → Gesamtbild speichern',
      lodLabel: 'Schachbrett = nicht aufgenommen',
    },
    understand: {
      noteBtn: 'Protokoll',
      heading: 'Verarbeitungsprotokoll',
      desc: 'Warum Bildteile hier gelandet sind, was sich auf der Seite geändert hat und welche Probleme auftraten, steht hier.',
      framesLabel: 'Anzahl zusammengesetzter Videobilder',
      canvasesLabel: 'Anzahl unabhängiger Bildflächen',
      coverageBody:
        'Transparent ≠ weiße Seite <br><small>Diese Bereiche wurden nie aufgenommen. Fehlende Inhalte werden nicht erfunden.</small>',
      diagnosticsHeading: 'Diagnosen',
      filterAriaLabel: 'Diagnosen filtern',
      filterAll: 'Alle',
      filterIssues: 'Warnungen / Fehler',
      diagnosticsAriaLabel: 'Verarbeitungsdiagnosen',
      diagnosticsEmpty: 'Hinweise zur Positionierung, Änderungen auf der Seite, <br>Schätzungen und Verarbeitungsfehler erscheinen hier.',
      moreDiagnostics: 'Weitere Diagnosen laden',
      reportLead: 'Falsches Ergebnis oder ein Fehler?',
      reportBtn: 'Auf GitHub melden',
      reportNote:
        'Die Meldung enthält bereits Angaben zu deinem Browser und die Warncodes aus diesem Protokoll. Aufnahme, Bilder und Dateiname sind nie enthalten. Vor dem Absenden kannst du alles prüfen und bearbeiten.',
    },
    export: {
      downloadPng: 'Bild speichern · PNG <span>↓</span>',
      copyPng: 'Bild kopieren',
      outputSize: 'Ausgabegröße',
      originalSize: 'Original · 100%',
      customSize: 'Längste Seite festlegen',
      longestEdge: 'Längste Seite (px)',
      sizeNote:
        'Gilt für Downloads und Kopien. Das Seitenverhältnis bleibt gleich; auch Text wird kleiner. Original, Seitenausgabe und Projekt behalten die Originalgröße.',
      pngNote: 'Eine PNG-Datei in der gewählten Ausgabegröße.',
      advancedSummary: 'Weitere Exportmöglichkeiten',
      exportProject: 'Ganzes Projekt exportieren · ZIP',
      projectNote:
        'Kacheln in Originalgröße, Offline-Viewer, Abdeckungs- und Qualitätsdaten sowie alle Diagnosen zum Archivieren oder zur Fehlersuche.',
      exportSheets: 'In mehrere PNGs aufteilen · ZIP',
      sheetsNote:
        'Teilt übergroße Bilder in PNG-Dateien mit kompatiblen Abmessungen auf, ohne sie zu verkleinern. Die Teilbilder überlappen sich um 32 px. Ein Manifest enthält ihre Koordinaten im Gesamtbild.',
      starNudge: 'Hilfreich? Gib uns einen Stern auf GitHub',
    },
    help: {
      title: 'Ein Bild mit nachvollziehbarer Herkunft',
      pixelsHeading: 'Welche Pixel bleiben erhalten?',
      pixelsBody:
        'Der bildgenaue Modus decodiert jedes Einzelbild. Jede verarbeitete Beobachtung hat einen Zeitstempel und einen Kompositionsnachweis. Die Analyse kann verkleinerte Bilder nutzen; die fertige Komposition behält die Originalpixel. Downloads und Kopien können anschließend verkleinert werden.',
      frameHeading: 'Rahmen und ursprüngliche Ränder',
      frameBody:
        'Standardmäßig bleiben Hintergrund, Ränder und Leerflächen des gesamten scrollbaren Bereichs erhalten. Es wird nicht auf Textgrenzen zugeschnitten. Die gerahmte Ansicht enthält zusätzlich die Oberfläche aus einem Referenzbild: Texte in Seitenleisten und Symbole in Werkzeugleisten erscheinen einmal in Originalgröße. Erweiterte Flächen setzen lediglich den dekorativen Hintergrund fort und gelten nicht als beobachteter Inhalt. Die ursprüngliche Inhaltsebene bleibt immer separat erhalten. Andere unabhängige Bereiche werden nie so dargestellt, als teilten sie dieselbe Bewegung.',
      scopeHeading: 'Bilder lassen nicht alles erkennen',
      scopeBody:
        'Das Trennen von Bewegungsebenen, das Zuordnen wiederholter Muster und das Erkennen dynamischer Bereiche beruhen auf visuellen Schlussfolgerungen. Maßstabsänderungen, fehlende Überlappung oder unvereinbare Layouts können zu unabhängigen Fragmenten führen. Deren Ausrichtung zueinander gilt nicht als bestätigt. Ein Konfidenzwert ist keine kalibrierte Wahrscheinlichkeit dafür, dass das Ergebnis stimmt.',
      storageHeading: 'Lange Aufnahmen und Speicher',
      storageBody:
        'Drei Dekodierdurchläufe begrenzen den Arbeitsspeicherbedarf, benötigen dafür aber Rechenzeit und Speicherplatz. Der Browser behält nur das neueste Ergebnis, höchstens 24 Stunden lang. Nach einem Neuladen oder versehentlichen Schließen erscheint es wieder. Wurde die Verarbeitung unterbrochen, kommen die bereits gespeicherten Teile zurück; fortsetzen lässt sich der Lauf nicht. Ein neuer Lauf oder „Leeren“ löscht das Ergebnis. Ist es älter als 24 Stunden, wird es beim nächsten Öffnen der Seite gelöscht. Lade herunter, was du behalten möchtest.',
      privacyHeading: 'Verlässt meine Aufnahme dieses Gerät?',
      privacyBody:
        'Nein. Dekodierung, Analyse und Zusammensetzen laufen im Browser. Aufnahme und Ergebnis bleiben auf diesem Gerät. Sobald die Seite geladen ist, kannst du auch offline weiterarbeiten. Die gehostete Seite (long-screen.yi-ting.com) nutzt zwei anonyme Messdienste. Cloudflare Web Analytics zählt Besuche und erfährt nur die aufgerufene Seite, die Herkunft des Besuchs, Browser- und Gerätetyp, Land und Ladegeschwindigkeit. PostHog misst die Nutzung des Druckers: ein Ereignis beim Öffnen der Seite sowie je eines beim Start und Ende eines Laufs. Enthalten sind nur Einstellungen, Version des Rechenkerns, Codec, Bildhöhe und Aufnahmedauer in Minuten, ungefähre Bildanzahl, Anzahl der erzeugten Bilder, Verarbeitungsdauer und Diagnosecodes. Jedes Ereignis enthält außerdem Seitenadresse, Herkunft des Besuchs, Browser, Betriebssystem, Bildschirmgröße, Sprache, Zeitzone und Land. Beide Dienste kommen ohne Cookies aus; PostHog speichert nichts in deinem Browser. Keiner erhält deine Aufnahme, das Ergebnis, Dateinamen oder Fehlermeldungen. Bei aktiviertem Do Not Track oder Global Privacy Control wird PostHog gar nicht geladen. Selbst gehostete Kopien und die Offline-Version als einzelne Datei erfassen nichts. Die Content Security Policy erlaubt Verbindungen nur zur eigenen Seite und diesen beiden Diensten. Alles andere blockiert der Browser.',
      browserHeading: 'Browser und Formate',
      browserBody:
        'Benötigt werden IndexedDB, OffscreenCanvas und CompressionStream. Für lokale Entwicklung funktioniert HTTP auf localhost direkt, ohne Zertifikat. Ein Handy kann eine HTTP-Adresse im lokalen Netz mit „Näherungsweise · nativer Player“ testen; dabei können jedoch Videobilder fehlen. Die exakte WebCodecs-Dekodierung und APIs zum Speichern auf Datenträgern sind meist nur auf localhost oder per HTTPS verfügbar. Das hat nichts mit einem Upload zu tun. Für exakte Dekodierung muss das Gerät außerdem den jeweiligen Codec unterstützen. Ein MP4-, MOV- oder WebM-Container garantiert nicht, dass sein Inhalt dekodiert werden kann.',
      tipsHeading: 'Wie wird das Ergebnis besser?',
      tipsBody:
        'Achte auf genügend Überlappung und bewege dich in detailarmen Bereichen etwas langsamer. Werden mehrere Teilbereiche oder schwebende Elemente falsch erkannt, zeichne sie vor dem Start unter „Bewegungsbereiche“ ein. Alle Diagnosen sind im vollständigen Projektexport enthalten.',
      feedbackHeading: 'Rückmeldungen und Quellcode',
      feedbackBody:
        'Long Screen ist Open Source unter der MIT-Lizenz. Den Code findest du auf <a href="https://github.com/t41372/long-screen" target="_blank" rel="noopener">GitHub</a>. Bei einem Fehler oder falschen Ergebnis <a class="report-link" href="https://github.com/t41372/long-screen/issues/new" target="_blank" rel="noopener">erstelle bitte ein Issue</a>. Angaben zu deinem Browser und die Warncodes aus dem Protokoll sind bereits eingetragen. Wenn dir das Projekt hilft, freuen wir uns über einen Stern.',
      toolsHeading: 'Auch ohne diese Seite',
      toolsBody:
        'Der Rechenkern lässt sich auch eigenständig nutzen: über die <a href="https://github.com/t41372/long-screen#command-line" target="_blank" rel="noopener">Kommandozeile</a>, als <a href="https://github.com/t41372/long-screen#rust-library" target="_blank" rel="noopener">Rust-Bibliothek</a>, als <a href="https://github.com/t41372/long-screen#python-package" target="_blank" rel="noopener">Python-Paket</a> und als <a href="https://github.com/t41372/long-screen#typescript-package" target="_blank" rel="noopener">TypeScript-Paket</a> für andere Webseiten. Auch dort werden Aufnahmen nur auf deinem eigenen Gerät verarbeitet. Installation und Nutzung sind in der README beschrieben.',
      licenseHeading: 'Open-Source-Lizenzen',
      licenseBody:
        'Der eigene Code von Long Screen steht unter der MIT-Lizenz. Du darfst ihn kostenlos nutzen, kopieren, verändern, weitergeben, verkaufen und in nicht quelloffene Produkte einbauen, solange Kopien den Urheberrechtshinweis und den <a href="https://github.com/t41372/long-screen/blob/main/LICENSE" target="_blank" rel="noopener">Lizenztext</a> enthalten. Er wird ohne Gewährleistung bereitgestellt. Die Abhängigkeiten im Wasm-Kern und in der Oberfläche, ihre Lizenzen sowie Quellen und Lizenzen der Rust-, WebAssembly- und GitHub-Logos stehen in den <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">Open-Source-Hinweisen</a>, die beim Build erzeugt werden.',
    },
    regions: {
      title: 'Unabhängige Bewegungsbereiche festlegen',
      hint:
        'Ziehe ein Rechteck über das Bild. Jeder Inhaltsbereich wird unabhängig rekonstruiert. Nicht markierte Bereiche bleiben als eigene Beobachtungsebene mit ausdrücklich geringer Konfidenz erhalten. Als „Ignorieren“ markierte Bereiche werden vollständig ausgeschlossen.',
      kindMoving: 'Inhalt · unabhängig scrollbar',
      kindFixed: 'Feste Oberfläche',
      kindIgnore: 'Ignorieren · vollständig ausschließen',
      clearBtn: 'Automatische Erkennung wiederherstellen',
      saveBtn: 'Bereiche übernehmen',
    },
    source: {
      title: 'Originalbild',
    },
    crop: {
      button: 'Zuschneiden',
      groupLabel: 'Bildausschnitt',
      left: 'Links',
      top: 'Oben',
      width: 'Breite',
      height: 'Höhe',
      full: 'Ganzes Bild',
      cancel: 'Abbrechen',
      apply: 'Zuschnitt anwenden',
    },
    footer: {
      stackLead: 'Der Rechenkern ist in',
      stackMid: 'geschrieben und wird zu',
      stackTail: 'kompiliert, um direkt im Browser zu laufen.',
      stackMore: 'Oberfläche in TypeScript · mit Deno gebaut und getestet',
      linksLabel: 'Projektlinks',
      source: 'Quellcode auf GitHub',
      report: 'Fehler melden',
      notices: 'Open-Source-Hinweise',
      trademarks:
        'Die Namen und Logos von Rust, WebAssembly, TypeScript, Deno und GitHub gehören ihren jeweiligen Inhabern. Sie zeigen nur, welche Technologien das Projekt verwendet, und bedeuten keine Unterstützung durch diese Organisationen.',
    },
  },
  deviceCheck: {
    doneTitle: 'Geräteprüfung — abgeschlossen',
    title: 'Gerät prüfen',
    intro:
      'Misst die Fähigkeiten von Browser und Gerät (Cross-Origin-Isolation, Threads, WebGPU-Adapter) sowie den tatsächlichen Aufwand des GPU-Pfads:\nHin- und Rückübertragung eines RGBA-Bilds in Originalgröße sowie Laufzeit und bytegenaue Übereinstimmung der Analyseverkleinerung auf GPU und Rust-Kern.\nOptional kannst du eine Aufnahme wählen, um die gesamte Verarbeitung auf CPU und erzwungenem WebGPU auszuführen und Kachel-Fingerabdrücke zu vergleichen.\nAlles wird auf diesem Gerät verarbeitet, ohne Upload. Laufdaten der gewählten Aufnahme werden nach dem Vergleich gelöscht. WebGPU ist nur in einem sicheren Kontext verfügbar (localhost oder HTTPS).',
    recordingLabel: 'Aufnahme (optional):',
    runBtn: 'Prüfung starten',
    loadingReport: 'Rechenkern wird geladen…',
  },
};
