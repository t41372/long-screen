import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Videobilder analysieren und Bewegungsebenen erkennen',
      solving: 'Positionen bestimmen und pixelgenau verfeinern',
      optimizing: 'Wiederbesuche abgleichen und Drift korrigieren',
      rendering: 'Bildfläche in Originalgröße zusammensetzen',
      revealing: 'Überlagernde Elemente entfernen',
      framing: 'Rahmen und ursprüngliches Seitenverhältnis erhalten',
      pyramid: 'Zoombare Vorschau erstellen',
      complete: 'Fertig · bitte Diagnosen prüfen',
      partial: 'Teilergebnis gespeichert',
      error: 'Fehler bei der Verarbeitung',
    },
    count: {
      frames_one: '{{frames}} Videobild',
      frames_other: '{{frames}} Videobilder',
      framesUnknown: '? Videobilder',
      regions_one: '{{count}} eigener Bereich ↗',
      regions_other: '{{count}} eigene Bereiche ↗',
    },
    dom: {
      noCompressionStream:
        'Diesem Browser fehlt CompressionStream zum Kodieren der Kacheln als PNG in Originalgröße. Die Rekonstruktion kann nicht starten.',
    },
    canvases: {
      badgePresentation: 'Gerahmte Ansicht · erweiterter Hintergrund ist kein beobachteter Inhalt',
      badgeFixed: 'Feste Ebene / Beobachtungsebene',
      badgeMoving: '2D-Inhaltsebene',
      badge_one: '{{kind}} · {{count}} Kachel in Originalgröße{{fragment}}',
      badge_other: '{{kind}} · {{count}} Kacheln in Originalgröße{{fragment}}',
      fragmentNote: ' · Ausrichtung der Fragmente zueinander unbestätigt',
    },
    diagnostics: {
      occurrenceSuffix: ' ({{count}} Vorkommnisse dieser Art)',
      locateAction: 'Betroffenen Bereich / Quelle ansehen ↗',
      viewSourceAction: 'Zeitpunkt im Original ansehen ↗',
      emptyFiltered: 'Keine Einträge für diesen Filter.',
      emptyDefault: 'Hinweise zur Positionierung, Änderungen auf der Seite, Schätzungen und Verarbeitungsfehler erscheinen hier.',
      noOriginalVideo:
        'Die Originalaufnahme ist nicht im Projekt enthalten. Wähle dieselbe Aufnahme erneut, um einzelne Zeitpunkte anzusehen. Das zusammengesetzte Ergebnis ist weiterhin lokal gespeichert.',
      hashMismatch:
        'Name und Größe stimmen überein, der Datei-Hash aber nicht. Der Inhalt weicht von der Aufnahme ab, aus der dieses Projekt erstellt wurde. Diese Datei kann deshalb nicht als Bildquelle verwendet werden. Wähle bitte die richtige Aufnahme.',
      sourceCaption: 'Quellbild {{frame}} · {{time}} s · {{message}}',
    },
    export: {
      imageSuffix: '-bild',
      savePickerFallback: 'Direktes Speichern ist nicht verfügbar. Stattdessen wird der Browser-Download verwendet: {{error}}',
      saveRowLabel: '{{name}} speichern · {{size}}',
      shareLabel: 'Teilen / in Fotos sichern',
      shareFailed: 'Teilen fehlgeschlagen: {{error}}',
      cleanupLabel: 'Temporäre Kopie nach dem Speichern löschen',
      exportErrorAction:
        'Der unvollständige Export wurde nicht als erfolgreich markiert. Bereits gespeicherte Projektkacheln bleiben auf diesem Gerät.',
      clipboardUnsupported: 'Dieser Browser kann keine Bilder kopieren. Verwende „Bild speichern“.',
      copyNoImage: 'Es wurde kein Bild erzeugt',
      copyFailedCtor: 'Kopieren fehlgeschlagen: {{error}}. Verwende „Bild speichern“.',
      copySuccess: 'Bild mit {{width}} × {{height}} Pixeln kopiert. Du kannst es jetzt einfügen.',
      copyFailed:
        'Kopieren fehlgeschlagen: {{error}}. Das Bild überschreitet möglicherweise die Kapazität der Zwischenablage. Verwende „Bild speichern“.',
    },
    crop: {
      buttonCropped: 'Zuschneiden · {{width}} × {{height}}',
      applied:
        'Zuschnitt angewendet. Downloads, Kopien und aufgeteilte Exporte enthalten jetzt nur diesen Bereich ({{width}} × {{height}}). Die ZIP-Datei des vollständigen Projekts bleibt unbeschnitten.',
      removed: 'Zuschnitt entfernt. Exporte enthalten wieder das ganze Bild.',
    },
    main: {
      offscreenMissing: 'Diesem Browser fehlt OffscreenCanvas. Der Render-Worker kann nicht ausgeführt werden.',
      webcodecsMissingToast:
        'Dieser Browser unterstützt WebCodecs nicht. Wähle „Näherungsweise · nativer Player“, um fortzufahren. Dabei können Videobilder fehlen.',
      privateStorageToast:
        'Privates Surfen: Das Projekt bleibt nur im Arbeitsspeicher dieses Fensters und geht beim Schließen verloren. Exportiere es vorher, um es zu behalten.',
      noOpfsNoPicker:
        'Dieser Browser bietet weder OPFS noch einen Speicherdialog. Der Export wird im Arbeitsspeicher erzeugt, bis zu {{mb}} MB.',
      dbOpenFailed: 'Lokale Datenbank konnte nicht geöffnet werden: {{error}}',
      workerErrorToast: 'Worker-Fehler: {{message}}',
      workerMessageUndecodable: 'Eine Worker-Nachricht konnte nicht gelesen werden. Sichere vorhandene Ergebnisse und lade die Seite neu.',
      interruptedPhaseWhere: '„{{phase}}“, Videobild {{frames}}',
      interruptedStartPhase: 'der Startphase',
      interruptedHiddenSome: 'die Seite war etwa {{seconds}} s im Hintergrund{{stillHidden}}',
      interruptedStillHidden: ' (auch zum Zeitpunkt der Unterbrechung)',
      interruptedHiddenNone: 'die Seite blieb durchgehend im Vordergrund',
      interruptedDiagnosticMessage:
        'Die vorherige Rekonstruktion wurde bei {{where}} unterbrochen. Die Seite hat kein Abschlusssignal erhalten; der Browser hat sie beendet oder ist abgestürzt. Laufzeit: {{elapsed}} s, Speicher des Rechenkerns: {{memory}} MB, {{hidden}}, Bildkonvertierung: {{conversion}}, CPU-Kerne: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari beendet Seiten im Hintergrund schon bei deutlich geringerem Speicherbedarf. Halte diesen Tab bei längeren Läufen im Vordergrund. Der vollständige Bericht steht in der Browserkonsole.',
      interruptedNotIsolated: ' (ohne Cross-Origin-Isolation, ein Thread)',
      interruptedToast: 'Die vorherige Rekonstruktion wurde bei {{where}} unterbrochen ({{hidden}}). Details stehen in den Diagnosen.',
      unknownValue: 'unbekannt',
    },
    run: {
      pausedStatus: 'Pausiert · Zustand bleibt im Speicher',
      resumedStatus: 'Wird fortgesetzt',
      pauseLabel: 'Pausieren',
      resumeLabel: 'Fortsetzen',
      stopToast: 'Die aktuelle Phase wird beendet. Danach wird so viel wie möglich zusammengesetzt und gespeichert.',
      preparingStatus: 'Exakte Dekodierung vorbereiten',
      preparingMessage: 'Container lesen sowie Codec-Unterstützung und lokalen Speicher prüfen.',
      compatibilityNeedsNative:
        '„Näherungsweise · nativer Player“ funktioniert nur, wenn der Player des Browsers diese Aufnahme lesen kann.',
      webcodecsHttpBlocked:
        'Auf dieser HTTP-Adresse stellt der Browser WebCodecs nicht bereit. Zum lokalen Testen kannst du „Näherungsweise · nativer Player“ wählen. Exakte Dekodierung benötigt localhost oder HTTPS. Die Aufnahme wird nicht hochgeladen.',
      webcodecsMissing:
        'Dieser Browser unterstützt WebCodecs nicht. Aktualisiere Safari / iOS oder wähle „Näherungsweise · nativer Player“. Dabei können Videobilder fehlen.',
      startFailedStatus: 'Rekonstruktion konnte nicht starten',
      restoredMessage:
        'Dies ist dein letztes Ergebnis. Sobald es älter als 24 Stunden ist, wird es beim nächsten Öffnen der Seite gelöscht.',
      interruptedStatus: 'Der letzte Lauf wurde nicht abgeschlossen',
      interruptedMessage:
        'Diese Teile wurden vor der Unterbrechung gespeichert. Für das vollständige Ergebnis lege die Aufnahme erneut ein und starte noch einmal.',
      waitingCanvasOption: 'Warten auf rekonstruierte Bildfläche',
    },
    source: {
      busyToast: 'Beende oder speichere zuerst den aktuellen Lauf.',
      subtitleReading: '{{size}} · kein Upload · Container und erstes Videobild werden gelesen',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · nur im nativen Player lesbar',
      subtitleUnavailable: '{{size}} · weder exakte Dekodierung noch native Vorschau verfügbar',
      probeFailedMessage: 'Prüfung der exakten Dekodierung fehlgeschlagen: {{error}}',
      probeFailedAction:
        'Long Screen versucht nun, die Metadaten mit dem nativen Player des Browsers zu lesen. Wähle zum Fortfahren „Näherungsweise · nativer Player“ als Dekodierung.',
      rejectedVideo:
        '„{{name}}“ ist {{kind}}. Der Browser kann dieses Format nicht Bild für Bild lesen, daher wurde die Datei nicht geöffnet. Stelle deinen Bildschirmrekorder auf MP4 um oder wandle die Datei zuerst mit HandBrake oder ffmpeg in MP4 um.',
      rejectedOther:
        '„{{name}}“ ist keine Videoaufnahme ({{kind}}) und wurde nicht geöffnet. Wähle eine Bildschirmaufnahme als MP4, MOV, WebM oder MKV. Unter Windows kannst du mit dem Snipping Tool oder der Xbox Game Bar (Win+Alt+R) aufnehmen, auf dem Mac mit ⌘⇧5 und auf dem Handy mit der eingebauten Bildschirmaufnahme.',
      unreadableToast:
        'Diese Aufnahme ist nicht lesbar ({{reason}}). Prüfe, ob die Aufnahme korrekt beendet und die Datei vollständig kopiert oder heruntergeladen wurde. Falls es weiterhin nicht klappt, versuche eine MP4-Datei mit H.264. Die Diagnosen erklären, warum die exakte Dekodierung scheiterte.',
      kind: {
        empty: 'eine leere Datei',
        heif: 'ein HEIC-/AVIF-Bild',
        avi: 'ein AVI-Video',
        webp: 'ein WebP-Bild',
        wav: 'eine WAV-Audiodatei',
        riff: 'eine RIFF-Datei',
        wmv: 'ein WMV-/ASF-Video',
        flv: 'ein FLV-Video',
        mpegps: 'ein MPEG-PS-Video',
        ogg: 'eine Ogg-Mediendatei',
        gif: 'eine GIF-Animation',
        png: 'ein PNG-Bild',
        jpeg: 'ein JPEG-Bild',
        pdf: 'ein PDF-Dokument',
        zip: 'ein ZIP-Archiv oder Office-Dokument',
        mp3: 'eine MP3-Audiodatei',
        text: 'eine Textdatei',
        mpegts: 'ein MPEG-TS-Video',
        unknown: 'eine nicht erkannte Datei',
      },
    },
    demo: {
      fileName: 'beispielaufnahme.mp4',
      loadFailed: 'Die Beispielaufnahme konnte nicht geladen werden: {{error}}',
    },
    feedback: {
      issueBody:
        '**Was ist passiert?**\n\n\n**Was hast du erwartet?**\n\n\n**Zur Aufnahme** (welche Seite, welche Bewegungen, ungefähre Dauer; ein Screenshot hilft, aber bitte private Inhalte unkenntlich machen)\n\n\n---\nVon Long Screen ausgefüllt, frei bearbeitbar oder löschbar:\n- Browser: {{browser}}\n- Geöffnet über: {{page}}\n- Mehrere Rechenthreads (Cross-Origin-Isolation): {{threads}}\n- Warnungen im Protokoll: {{warnings}}\n',
      portable: 'portable Version (lokale Datei)',
      yes: 'ja',
      no: 'nein',
      none: 'keine',
    },
    viewer: {
      previewLevel: 'Vorschau L{{level}} (Originalgröße unverändert)',
      nativeLevel: 'Originalpixel L0',
      qualityHint: ' · zum Anzeigen der Qualitätsmaske vergrößern',
      unobservedHint: ' · blau = nicht beobachtet',
      provisionalHint: ' · violett = vorübergehender / überlagernder Inhalt',
    },
  },
  names: {
    fixed: 'Feste Oberfläche',
    divider: 'Feste Trennlinie',
    contentCanvas: 'Inhaltsfläche {{n}}',
    unassigned: 'Nicht zugewiesener Bereich · Beobachtungen in Bildschirmkoordinaten',
    contentRegion: 'Inhaltsbereich {{n}}',
    ignored: 'Ignoriert',
    fragment: 'nicht positioniertes Fragment {{n}}',
    framed: 'gerahmt',
  },
};
