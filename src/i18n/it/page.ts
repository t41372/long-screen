import type { Catalog } from '../catalog.ts';
import type { pageSections as zh } from '../zh/page.ts';

export const pageSections: Catalog<typeof zh> = {
  language: {
    label: 'Lingua dell’interfaccia',
    saveFailed: 'Impossibile salvare la lingua scelta: il browser blocca l’archiviazione locale.',
  },
  page: {
    title: 'Long Screen — Da una registrazione dello schermo a un’unica grande immagine',
    description:
      'Trasforma una registrazione dello schermo in un’unica grande immagine a risoluzione originale. Scorri, spostati in diagonale, fermati o torna indietro: non serve andare solo verso il basso. Cornici delle finestre e barre di stato vengono conservate. Tutto avviene nel browser, senza inviare file.',
    closeLabel: 'Chiudi',
    header: {
      brandLabel: 'Pagina iniziale di Long Screen',
      slogan: 'OGNI PERCORSO · UN’UNICA GRANDE IMMAGINE',
      privacy: 'Le tue immagini restano su questo dispositivo',
      helpLabel: 'Guida e funzionalità',
      star: 'Lascia una stella su GitHub',
      starLabel: 'Lascia una stella su GitHub (si apre in una nuova scheda)',
      install: 'Installa l’app',
      installTitle: 'Installa Long Screen su questo dispositivo: si apre come un’app e funziona anche offline',
    },
    install: {
      title: 'Installa su questo dispositivo',
      intro:
        'Puoi installare Long Screen come app web (PWA). Si apre dalla schermata Home o dal Dock, in una finestra dedicata, e funziona anche senza connessione. Le registrazioni vengono comunque elaborate solo su questo dispositivo.',
      iosShare: 'Tocca il pulsante Condividi del browser. In Safari si trova nella barra degli strumenti in basso o nel menu ⋯.',
      iosAdd: 'Scorri fino ad Aggiungi alla schermata Home.',
      iosConfirm: 'Tocca Aggiungi.',
      iosInApp: 'Se la pagina si è aperta all’interno di un’altra app, come WeChat o LINE, aprila prima in Safari.',
      macFile: 'Nella barra dei menu in alto, scegli File → Aggiungi al Dock.',
      macConfirm: 'Fai clic su Aggiungi.',
      offline: 'Dopo l’installazione, apri l’app una volta con una connessione Internet. Da quel momento potrai usarla offline.',
    },
    hero: {
      heading: 'Da una registrazione dello schermo<br>a <span class="hl">un’unica grande immagine</span>.',
      intro:
        'Registra lo schermo mentre esplori una pagina web, un’app o un progetto grafico: scorri, spostati in ogni direzione, torna indietro. Long Screen rimette al loro posto i contenuti mostrati nel video e li riunisce in un PNG a risoluzione originale, conservando cornici e barre di stato. Tutto avviene nel browser, senza inviare file.',
      demoLead: ' Vuoi vedere come funziona?',
      demoChip: 'Prova una registrazione di esempio',
    },
    steps: {
      ariaLabel: 'Come funziona',
      recordTitle: 'Registra',
      recordBody: 'Registra lo schermo mentre ti muovi in una pagina o in un’app, nella direzione che preferisci.',
      feedTitle: 'Inserisci',
      feedBody: 'Trascina il video sullo schermo della stampante e premi Avvia.',
      takeTitle: 'Scarica',
      takeBody: 'Ottieni un’unica immagine a risoluzione originale. Le parti mai registrate restano vuote.',
    },
    press: {
      ariaLabel: 'La stampante',
      core: 'Versione del motore',
      build: 'Commit da cui è stata creata questa pagina',
    },
    screen: {
      dropTitle: 'Trascina qui una registrazione',
      dropHint: 'o fai clic per scegliere un file · MP4 · MOV · WebM',
    },
    observe: {
      dropTitle: 'Nessuna registrazione',
      dropSubtitle: 'MP4 · MOV · WebM · resta su questo dispositivo',
    },
    controls: {
      print: 'Avvia',
      progress: 'Avanzamento',
      knobs: 'Impostazioni',
      clear: 'Svuota',
      clearTitle: 'Rimuovi la registrazione ed elimina questo risultato e il relativo registro',
    },
    tray: {
      ariaLabel: 'Anteprima dell’immagine completa',
      idleTitle: 'La tua immagine completa apparirà qui',
      story1: 'La registrazione esplora la pagina…',
      story2: 'Ogni parte ripresa ritrova il suo posto',
      story3: 'Ecco un’unica grande immagine!',
      story4: 'Sul telefono, registra mentre scorri verso il basso…',
      story5: 'Schermata dopo schermata, con una sola barra di stato',
      story6: 'Funziona anche per i classici screenshot lunghi!',
    },
    reconstruct: {
      heading: 'Impostazioni di elaborazione',
      sub: 'Le impostazioni predefinite vanno già bene. Modificale solo se necessario.',
      policyLabel: 'Conflitti',
      policyStable: 'Mantieni una vista stabile',
      policyLatest: 'Preferisci la vista più recente',
      framingLabel: 'Cornice',
      framingContext: 'Mantieni cornice e interfaccia',
      framingRegion: 'Solo contenuto e margini',
      regionsLabel: 'Aree di movimento',
      regionsAuto: 'Rilevamento automatico ↗',
      advancedSummary: 'Altre impostazioni <span>＋</span>',
      analysisSizeLabel: 'Lato lungo per l’analisi',
      memoryLabel: 'Limite cache dei riquadri',
      computeLabel: 'Accelerazione',
      computeAuto: 'Auto · WebGPU / CPU',
      computeWebgpu: 'WebGPU · allineamento CPU',
      computeCpu: 'Solo CPU',
      computeHint:
        'La GPU converte i fotogrammi decodificati in pixel e riduce le miniature per l’analisi. Allineamento e composizione restano sulla CPU. Auto misura prima le prestazioni di entrambi i metodi e usa la GPU solo se è più veloce.',
      decoderLabel: 'Decodifica',
      decoderPrecise: 'Esatta · WebCodecs',
      decoderCompatibility: 'Approssimata · lettore nativo',
      decoderHint:
        'Le miniature di analisi non modificano i pixel del risultato. La cache contiene solo i riquadri completati e si amplia da sola quando un fotogramma ne interessa più di quanti ne possa contenere: influisce quindi poco sulla velocità. Non include la memoria usata da browser, decoder, GPU e motore. La modalità «Approssimata · lettore nativo» può perdere contenuti visibili per poco tempo.',
      pauseBtn: 'Pausa',
      stopBtn: 'Interrompi e salva',
      footerNote: 'Nessun invio · nessuna elaborazione nel cloud · nessun modello esterno',
    },
    canvas: {
      ariaLabel: 'Immagine ricostruita',
      selectAriaLabel: 'Scegli l’immagine ricostruita',
      waitingOption: 'In attesa di immagini',
      qualityMask: 'Maschera di qualità',
      fitTitle: 'Adatta alla finestra',
      fitBtn: 'Adatta',
      nativeTitle: 'Dimensioni originali',
      viewerAriaLabel: 'Superficie 2D con aree vuote, trascinabile e ingrandibile',
      zoomOutLabel: 'Riduci',
      zoomInLabel: 'Ingrandisci',
      expandLabel: 'Espandi l’anteprima',
      emptyTitle: 'Composizione in corso…',
      emptyBody: 'Ogni fotogramma trova il suo posto nell’immagine completa.',
      statusReady: 'Pronto',
      progressMessageDefault: 'Inserisci una registrazione → premi Avvia → scarica l’immagine',
      lodLabel: 'Scacchiera = area mai ripresa',
    },
    understand: {
      noteBtn: 'Registro',
      heading: 'Registro di elaborazione',
      desc:
        'Perché ogni parte è stata collocata in quel punto, cosa è cambiato nella pagina e quali problemi si sono verificati: è tutto qui.',
      framesLabel: 'Numero di fotogrammi assemblati',
      canvasesLabel: 'Numero di immagini indipendenti',
      coverageBody: 'Trasparente ≠ pagina bianca <br><small>Indica aree mai osservate: non viene inventato nulla per riempirle.</small>',
      diagnosticsHeading: 'Diagnostica',
      filterAriaLabel: 'Filtra la diagnostica',
      filterAll: 'Tutto',
      filterIssues: 'Avvisi / errori',
      diagnosticsAriaLabel: 'Diagnostica di elaborazione',
      diagnosticsEmpty: 'Qui appariranno indizi di posizionamento, cambiamenti della pagina, <br>stime ed errori di elaborazione.',
      moreDiagnostics: 'Mostra altri messaggi',
      reportLead: 'Il risultato non è corretto o qualcosa non funziona?',
      reportBtn: 'Segnala su GitHub',
      reportNote:
        'La segnalazione contiene già i dettagli del browser e i codici di avviso di questo registro. Non include mai la registrazione, le immagini o il nome del file. Puoi leggerla e modificarla prima di inviarla.',
    },
    export: {
      downloadPng: 'Scarica l’immagine · PNG <span>↓</span>',
      copyPng: 'Copia l’immagine',
      pngNote: 'Un solo PNG a risoluzione originale, senza riduzioni né suddivisioni.',
      advancedSummary: 'Altre opzioni di esportazione',
      exportProject: 'Esporta il progetto completo · ZIP',
      projectNote:
        'Riquadri a risoluzione originale, visualizzatore offline, dati di copertura e qualità e diagnostica completa, per archiviare il risultato o analizzare un problema.',
      exportSheets: 'Dividi in più PNG · ZIP',
      sheetsNote:
        'Divide un’immagine troppo grande in più PNG di dimensioni compatibili, senza ridurne la risoluzione. Le parti si sovrappongono di 32 px e un file manifest ne riporta le coordinate nell’immagine completa.',
      starNudge: 'Ti è utile? Lascia una stella su GitHub',
    },
    help: {
      title: 'Un’immagine di cui conosci l’origine',
      pixelsHeading: 'Quali pixel vengono conservati?',
      pixelsBody:
        'La modalità esatta decodifica il video fotogramma per fotogramma. Ogni osservazione completata conserva un riferimento temporale e un resoconto della composizione. L’analisi può usare immagini ridotte; la composizione finale e l’esportazione mantengono i pixel alla scala originale.',
      frameHeading: 'Cornice e margini originali',
      frameBody:
        'Per impostazione predefinita vengono mantenuti sfondo, margini e spazi vuoti dell’intera area scorrevole, senza ritagliare attorno al testo. La vista con cornice conserva anche l’interfaccia di un fotogramma di riferimento: testi delle barre laterali e icone compaiono una sola volta, nelle dimensioni originali. Le aree estese proseguono soltanto lo sfondo decorativo e non sono contenuto osservato. Il livello del contenuto originale resta sempre disponibile separatamente. Gli altri pannelli indipendenti non vengono mai presentati come se condividessero lo stesso movimento.',
      scopeHeading: 'Le immagini non raccontano tutto',
      scopeBody:
        'Separare i movimenti, distinguere motivi ripetuti e attribuire le aree dinamiche richiede deduzioni visive. Cambi di scala, viste senza sovrapposizione o impaginazioni incompatibili possono diventare frammenti indipendenti, il cui allineamento reciproco non è confermato. Il livello di confidenza non è una probabilità calibrata che il risultato sia corretto.',
      storageHeading: 'Registrazioni lunghe e archiviazione',
      storageBody:
        'La decodifica in tre passaggi limita l’uso della memoria, al costo di spazio su disco e tempo di calcolo. Il browser conserva solo il risultato più recente, per un massimo di 24 ore. Ricompare dopo un ricaricamento o una chiusura accidentale; se l’elaborazione si è interrotta, ricompaiono le parti già salvate, ma non è possibile riprendere da quel punto. Un nuovo avvio o il pulsante Svuota lo eliminano. Superate le 24 ore, viene cancellato alla successiva apertura della pagina. Scarica ciò che vuoi conservare.',
      privacyHeading: 'La registrazione esce da questo dispositivo?',
      privacyBody:
        'No. Decodifica, analisi e composizione avvengono nel browser: registrazione e risultato restano su questo dispositivo. Una volta caricata la pagina puoi continuare anche offline. Il sito ospitato (long-screen.yi-ting.com) usa due sistemi di misurazione anonima. Cloudflare Web Analytics conta le visite e riceve soltanto la pagina aperta, la provenienza della visita, il tipo di browser e dispositivo, il paese e la velocità di caricamento. PostHog misura l’uso della stampante: un evento all’apertura della pagina, uno all’avvio dell’elaborazione e uno alla fine. Contengono solo impostazioni, versione del motore, codec, altezza e durata in minuti della registrazione, numero approssimativo di fotogrammi, numero di immagini prodotte, tempo impiegato e codici diagnostici. Ogni evento include anche indirizzo della pagina, provenienza della visita, browser e sistema operativo, dimensioni dello schermo, lingua, fuso orario e paese. Nessuno dei due usa cookie e PostHog non memorizza nulla nel browser. Nessuno riceve registrazioni, risultati, nomi di file o messaggi d’errore. Se Do Not Track o Global Privacy Control sono attivi, PostHog non viene caricato. Le copie ospitate autonomamente e la versione offline in un solo file non raccolgono misurazioni. La Content Security Policy della pagina consente connessioni solo al sito stesso e a questi due servizi; il browser blocca tutte le altre.',
      browserHeading: 'Browser e formati',
      browserBody:
        'Servono IndexedDB, OffscreenCanvas e CompressionStream. Per lo sviluppo locale, HTTP su localhost funziona senza certificati. Da un telefono, un indirizzo HTTP della rete locale consente di provare «Approssimata · lettore nativo», ma alcuni fotogrammi potrebbero mancare. In genere i browser rendono disponibili la decodifica esatta WebCodecs e le API di esportazione su disco solo su localhost o HTTPS: non significa che i file vengano inviati. La decodifica esatta richiede anche che il dispositivo supporti il codec specifico. Un contenitore MP4, MOV o WebM non garantisce che il dispositivo possa decodificarne il contenuto.',
      tipsHeading: 'Come posso migliorare il risultato?',
      tipsBody:
        'Mantieni una buona sovrapposizione tra le immagini e muoviti più lentamente nelle zone con pochi dettagli. Se pannelli o elementi sovrapposti non vengono riconosciuti bene, disegnali manualmente in «Aree di movimento» prima di avviare. Il progetto completo include tutti i messaggi diagnostici.',
      feedbackHeading: 'Segnalazioni e codice sorgente',
      feedbackBody:
        'Long Screen è open source con licenza MIT. Il codice è su <a href="https://github.com/t41372/long-screen" target="_blank" rel="noopener">GitHub</a>. Se trovi un errore o ottieni un risultato sbagliato, <a class="report-link" href="https://github.com/t41372/long-screen/issues/new" target="_blank" rel="noopener">apri una segnalazione</a>: i dettagli del browser e i codici di avviso del registro sono già inseriti. Se il progetto ti è utile, una stella ci aiuta molto.',
      toolsHeading: 'Anche fuori da questa pagina',
      toolsBody:
        'Il motore funziona anche in modo autonomo: da <a href="https://github.com/t41372/long-screen#command-line" target="_blank" rel="noopener">riga di comando</a>, come <a href="https://github.com/t41372/long-screen#rust-library" target="_blank" rel="noopener">libreria Rust</a>, <a href="https://github.com/t41372/long-screen#python-package" target="_blank" rel="noopener">pacchetto Python</a> e <a href="https://github.com/t41372/long-screen#typescript-package" target="_blank" rel="noopener">pacchetto TypeScript</a> per altre pagine web. Anche questi strumenti elaborano le registrazioni soltanto sul tuo dispositivo. Il README spiega come installarli e usarli.',
      licenseHeading: 'Licenze open source',
      licenseBody:
        'Il codice di Long Screen è distribuito con licenza MIT: puoi usarlo, copiarlo, modificarlo, ridistribuirlo gratuitamente, venderlo o integrarlo in prodotti a codice chiuso, purché le copie conservino l’avviso di copyright e il <a href="https://github.com/t41372/long-screen/blob/main/LICENSE" target="_blank" rel="noopener">testo della licenza</a>. È fornito così com’è, senza garanzie. Le dipendenze incluse nel motore Wasm e nell’interfaccia, le relative licenze e le fonti e licenze dei loghi Rust, WebAssembly e GitHub sono elencate negli <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">avvisi open source</a>, generati durante la compilazione.',
    },
    regions: {
      title: 'Definisci le aree di movimento',
      hint:
        'Traccia un rettangolo sull’immagine. Ogni area di contenuto viene ricostruita separatamente. Le parti non contrassegnate restano in un livello di osservazione indipendente, indicato come poco affidabile. Le aree da ignorare vengono escluse del tutto.',
      kindMoving: 'Contenuto · scorre indipendentemente',
      kindFixed: 'Interfaccia fissa',
      kindIgnore: 'Ignora · escludi dal risultato',
      clearBtn: 'Ripristina il rilevamento automatico',
      saveBtn: 'Salva le aree',
    },
    source: {
      title: 'Fotogramma originale',
    },
    crop: {
      button: 'Ritaglia',
      groupLabel: 'Area di ritaglio',
      left: 'Sinistra',
      top: 'Alto',
      width: 'Larghezza',
      height: 'Altezza',
      full: 'Immagine intera',
      cancel: 'Annulla',
      apply: 'Applica ritaglio',
    },
    footer: {
      stackLead: 'Il motore è scritto in',
      stackMid: 'e compilato in',
      stackTail: 'per funzionare direttamente nel browser.',
      stackMore: 'Interfaccia in TypeScript · compilazione e test con Deno',
      linksLabel: 'Link del progetto',
      source: 'Codice su GitHub',
      report: 'Segnala un errore',
      notices: 'Avvisi open source',
      trademarks:
        'Nomi e loghi di Rust, WebAssembly, TypeScript, Deno e GitHub appartengono ai rispettivi titolari. Indicano soltanto le tecnologie utilizzate e non implicano il loro sostegno al progetto.',
    },
  },
  deviceCheck: {
    doneTitle: 'Verifica del dispositivo completata',
    title: 'Verifica del dispositivo',
    intro:
      'Misura le capacità del browser e del dispositivo (isolamento tra origini, thread, adattatore WebGPU) e il costo effettivo del percorso GPU:\ntrasferimento di andata e ritorno di un fotogramma RGBA a risoluzione originale, tempi della riduzione per l’analisi e corrispondenza byte per byte tra GPU e motore Rust.\nPuoi anche scegliere una registrazione per confrontare le impronte dei riquadri dopo l’elaborazione completa su CPU e su WebGPU forzato.\nTutto viene elaborato su questo dispositivo, senza invio di file. I dati del test sulla registrazione vengono eliminati dopo il confronto. WebGPU richiede un contesto sicuro: localhost o HTTPS.',
    recordingLabel: 'Registrazione (facoltativa):',
    runBtn: 'Avvia la verifica',
    loadingReport: 'Caricamento del motore…',
  },
};
