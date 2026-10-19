import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Analisi dei fotogrammi e separazione dei movimenti',
      solving: 'Posizionamento globale e affinamento al pixel',
      optimizing: 'Correzione dei ritorni e della deriva accumulata',
      rendering: 'Composizione dell’immagine a risoluzione originale',
      revealing: 'Rimozione degli elementi sovrapposti alla pagina',
      framing: 'Conservazione della cornice e delle proporzioni originali',
      pyramid: 'Creazione dell’anteprima ingrandibile',
      complete: 'Completato · controlla la diagnostica',
      partial: 'Risultato parziale salvato',
      error: 'Errore durante l’elaborazione',
    },
    count: {
      frames_one: '{{frames}} fotogramma',
      frames_other: '{{frames}} fotogrammi',
      frames_many: '{{frames}} fotogrammi',
      framesUnknown: '? fotogrammi',
      regions_one: '{{count}} area personalizzata ↗',
      regions_other: '{{count}} aree personalizzate ↗',
      regions_many: '{{count}} aree personalizzate ↗',
    },
    dom: {
      noCompressionStream:
        'Questo browser non dispone di CompressionStream, necessario per codificare ogni riquadro in PNG a risoluzione originale. La ricostruzione non può iniziare.',
    },
    canvases: {
      badgePresentation: 'Vista con cornice · lo sfondo esteso non è contenuto osservato',
      badgeFixed: 'Livello fisso / di osservazione',
      badgeMoving: 'Livello di contenuto 2D',
      badge_one: '{{kind}} · {{count}} riquadro a risoluzione originale{{fragment}}',
      badge_other: '{{kind}} · {{count}} riquadri a risoluzione originale{{fragment}}',
      badge_many: '{{kind}} · {{count}} riquadri a risoluzione originale{{fragment}}',
      fragmentNote: ' · allineamento tra i frammenti non confermato',
    },
    diagnostics: {
      occurrenceSuffix: ' (occorrenze di questo tipo: {{count}})',
      locateAction: 'Trova l’area / vedi l’originale ↗',
      viewSourceAction: 'Vedi questo momento nel video ↗',
      emptyFiltered: 'Nessuna voce per questo filtro.',
      emptyDefault: 'Qui appariranno indizi di posizionamento, cambiamenti della pagina, stime ed errori di elaborazione.',
      noOriginalVideo:
        'Il video originale non è incluso nel progetto. Seleziona di nuovo la stessa registrazione per vedere i singoli momenti. Il risultato composto è ancora salvato sul dispositivo.',
      hashMismatch:
        'Nome e dimensioni coincidono, ma l’impronta del contenuto è diversa da quella della registrazione usata per il progetto. Questo file non può quindi essere usato per verificare i fotogrammi originali. Scegli la registrazione corretta.',
      sourceCaption: 'Fotogramma originale {{frame}} · {{time}} s · {{message}}',
    },
    export: {
      imageSuffix: '-immagine',
      savePickerFallback: 'Il salvataggio diretto non è disponibile. Verrà usato il download del browser: {{error}}',
      saveRowLabel: 'Salva {{name}} · {{size}}',
      shareLabel: 'Condividi / salva in Foto',
      shareFailed: 'Condivisione non riuscita: {{error}}',
      cleanupLabel: 'Elimina la copia temporanea dopo il salvataggio',
      exportErrorAction:
        'L’esportazione incompleta non è stata indicata come riuscita. I riquadri del progetto già salvati restano su questo dispositivo.',
      clipboardUnsupported: 'Questo browser non può copiare immagini. Usa «Scarica l’immagine».',
      copyNoImage: 'Non è stata generata alcuna immagine',
      copyFailedCtor: 'Copia non riuscita: {{error}}. Usa «Scarica l’immagine».',
      copySuccess: 'Immagine di {{width}} × {{height}} copiata. Ora puoi incollarla.',
      copyFailed:
        'Copia non riuscita: {{error}}. L’immagine potrebbe superare il limite degli appunti di sistema. Usa «Scarica l’immagine».',
    },
    crop: {
      buttonCropped: 'Ritaglia · {{width}} × {{height}}',
      applied:
        'Ritaglio applicato. Download, copie ed esportazioni in più immagini includono solo quest’area ({{width}} × {{height}}). Il file ZIP del progetto completo non viene ritagliato.',
      removed: 'Ritaglio rimosso. Le esportazioni includono di nuovo l’intera immagine.',
    },
    main: {
      offscreenMissing: 'Questo browser non dispone di OffscreenCanvas. Il worker di rendering non può essere eseguito.',
      webcodecsMissingToast:
        'Questo browser non supporta WebCodecs. Per continuare, scegli «Approssimata · lettore nativo»: alcuni fotogrammi potrebbero mancare.',
      privateStorageToast:
        'Navigazione privata: il progetto resta solo nella memoria di questa finestra e scompare quando la chiudi. Esportalo prima di chiudere per conservarlo.',
      noOpfsNoPicker:
        'Questo browser non offre né OPFS né una finestra di salvataggio. L’esportazione verrà generata in memoria, fino a {{mb}} MB.',
      dbOpenFailed: 'Impossibile aprire il database locale: {{error}}',
      workerErrorToast: 'Errore del worker: {{message}}',
      workerMessageUndecodable:
        'Non è stato possibile leggere un messaggio del worker. Conserva i risultati esistenti e ricarica la pagina.',
      interruptedPhaseWhere: '«{{phase}}», fotogramma {{frames}}',
      interruptedStartPhase: 'la fase iniziale',
      interruptedHiddenSome: 'la pagina è rimasta in secondo piano per circa {{seconds}} s{{stillHidden}}',
      interruptedStillHidden: ' (anche al momento dell’interruzione)',
      interruptedHiddenNone: 'la pagina è rimasta sempre in primo piano',
      interruptedDiagnosticMessage:
        'La ricostruzione precedente si è interrotta durante {{where}}. La pagina non ha ricevuto il segnale di completamento: il browser l’ha chiusa o si è arrestato. Durata: {{elapsed}} s, memoria del motore: {{memory}} MB, {{hidden}}, conversione dei fotogrammi: {{conversion}}, core CPU: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari chiude le pagine in secondo piano a una soglia di memoria molto più bassa. Per le elaborazioni lunghe, tieni questa scheda in primo piano. Il resoconto completo è nella console del browser.',
      interruptedNotIsolated: ' (senza isolamento tra origini, un solo thread)',
      interruptedToast:
        'La ricostruzione precedente si è interrotta durante {{where}} ({{hidden}}). Consulta la diagnostica per i dettagli.',
      unknownValue: 'non noto',
    },
    run: {
      pausedStatus: 'In pausa · stato conservato in memoria',
      resumedStatus: 'Ripresa in corso',
      pauseLabel: 'Pausa',
      resumeLabel: 'Riprendi',
      stopToast: 'La fase in corso verrà conclusa, poi verrà composto e salvato tutto ciò che è possibile conservare.',
      preparingStatus: 'Preparazione della decodifica esatta',
      preparingMessage: 'Lettura del contenitore e verifica del codec e dell’archiviazione locale.',
      compatibilityNeedsNative:
        'La modalità «Approssimata · lettore nativo» richiede che il lettore del browser riesca a leggere questo video.',
      webcodecsHttpBlocked:
        'Il browser non abilita WebCodecs a questo indirizzo HTTP. Per continuare la prova locale, scegli «Approssimata · lettore nativo». La decodifica esatta richiede localhost o HTTPS. Il video non viene inviato.',
      webcodecsMissing:
        'Questo browser non supporta WebCodecs. Aggiorna Safari / iOS oppure scegli «Approssimata · lettore nativo», che potrebbe perdere alcuni fotogrammi.',
      startFailedStatus: 'Impossibile avviare la ricostruzione',
      restoredMessage: 'Questo è il tuo ultimo risultato. Superate le 24 ore, verrà eliminato alla successiva apertura della pagina.',
      interruptedStatus: 'L’ultima elaborazione non è terminata',
      interruptedMessage:
        'Queste sono le parti salvate prima dell’interruzione. Per ottenere il risultato completo, inserisci di nuovo la registrazione e riavvia l’elaborazione.',
      waitingCanvasOption: 'In attesa dell’immagine ricostruita',
    },
    source: {
      busyToast: 'Prima termina o salva l’elaborazione in corso.',
      subtitleReading: '{{size}} · nessun invio · lettura del contenitore e del primo fotogramma',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · leggibile solo dal lettore nativo',
      subtitleUnavailable: '{{size}} · decodifica esatta e anteprima nativa non disponibili',
      probeFailedMessage: 'Verifica della decodifica esatta non riuscita: {{error}}',
      probeFailedAction:
        'Verrà provato il lettore nativo del browser per leggere i metadati. Per continuare, scegli la decodifica «Approssimata · lettore nativo».',
      rejectedVideo:
        '«{{name}}» è {{kind}}, un formato che il browser non può leggere fotogramma per fotogramma. Non è stato aperto. Imposta la registrazione dello schermo in MP4 oppure converti prima il file in MP4 con HandBrake o ffmpeg.',
      rejectedOther:
        '«{{name}}» non è un video ({{kind}}) e non è stato aperto. Scegli una registrazione dello schermo in MP4, MOV, WebM o MKV. Su Windows puoi registrare con Strumento di cattura o Xbox Game Bar (Win+Alt+R); su Mac premi ⌘⇧5; sul telefono usa la registrazione dello schermo integrata.',
      unreadableToast:
        'Questo video non è leggibile ({{reason}}). Verifica che la registrazione sia terminata correttamente e che il file sia stato copiato o scaricato per intero. Se il problema persiste, prova un MP4 in H.264. La diagnostica spiega perché la decodifica esatta non è riuscita.',
      kind: {
        empty: 'un file vuoto',
        heif: 'un’immagine HEIC/AVIF',
        avi: 'un video AVI',
        webp: 'un’immagine WebP',
        wav: 'un file audio WAV',
        riff: 'un file RIFF',
        wmv: 'un video WMV/ASF',
        flv: 'un video FLV',
        mpegps: 'un video MPEG-PS',
        ogg: 'un file multimediale Ogg',
        gif: 'un’animazione GIF',
        png: 'un’immagine PNG',
        jpeg: 'un’immagine JPEG',
        pdf: 'un documento PDF',
        zip: 'un archivio ZIP o un documento Office',
        mp3: 'un file audio MP3',
        text: 'un file di testo',
        mpegts: 'un video MPEG-TS',
        unknown: 'un file non riconosciuto',
      },
    },
    demo: {
      fileName: 'registrazione-esempio.mp4',
      loadFailed: 'Impossibile caricare la registrazione di esempio: {{error}}',
    },
    feedback: {
      issueBody:
        '**Cosa è successo?**\n\n\n**Quale risultato ti aspettavi?**\n\n\n**Informazioni sulla registrazione** (quale pagina, come ti sei mosso, durata indicativa; uno screenshot è utile, ma nascondi i dati privati)\n\n\n---\nCompilato da Long Screen. Modifica o elimina liberamente:\n- Browser: {{browser}}\n- Aperto da: {{page}}\n- Motore multithread (isolamento tra origini): {{threads}}\n- Avvisi nel registro: {{warnings}}\n',
      portable: 'versione portatile (file locale)',
      yes: 'sì',
      no: 'no',
      none: 'nessuno',
    },
    viewer: {
      previewLevel: 'Anteprima L{{level}} (dimensioni originali invariate)',
      nativeLevel: 'Pixel originali L0',
      qualityHint: ' · ingrandisci per vedere la maschera di qualità',
      unobservedHint: ' · blu = nessuna osservazione',
      provisionalHint: ' · viola = contenuto temporaneo / sovrapposto',
    },
  },
  names: {
    fixed: 'Interfaccia fissa',
    divider: 'Separatore fisso',
    contentCanvas: 'Immagine di contenuto {{n}}',
    unassigned: 'Area non assegnata · osservazioni nelle coordinate dello schermo',
    contentRegion: 'Area di contenuto {{n}}',
    ignored: 'Ignorato',
    fragment: 'frammento non posizionato {{n}}',
    framed: 'con cornice',
  },
};
