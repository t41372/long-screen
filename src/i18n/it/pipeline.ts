import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'La ricostruzione usa livelli di contenuto mobili e vincoli geometrici quando si torna su aree già viste. Le maschere automatiche e il riconoscimento delle aree dinamiche si basano su euristiche; i punteggi di confidenza non sono probabilità calibrate di correttezza. I confronti di coerenza usano il rumore di decodifica dichiarato per questa sorgente: ±{{noise}} livelli{{margin}}.',
      marginLossy: ' (margine per artefatti di compressione e ricostruzione del colore)',
      marginLossless: ' (sorgente senza perdita, confronto esatto pixel per pixel)',
      action: 'Se scale o strutture sono incompatibili, il contenuto resta un frammento indipendente invece di essere unito forzatamente.',
    },
    APPROXIMATE_DECODER: {
      message:
        'È stata attivata esplicitamente la modalità «Approssimata · lettore nativo» a {{fps}} Hz. Non è garantita l’acquisizione di tutti i fotogrammi; i contenuti visibili per poco tempo potrebbero mancare.',
      action: 'Per garantire la lettura di ogni fotogramma, usa una sorgente supportata da WebCodecs, come H.264 o VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'L’analisi del movimento limita il lato lungo a {{size}} px. Affinamento e composizione finale usano i pixel alla risoluzione originale: il risultato non viene ridotto.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Un fotogramma alla risoluzione originale e i suoi riferimenti sono vicini al limite di cache scelto. Il limite JavaScript non controlla la memoria del codec o della GPU.',
      action:
        'La risoluzione del risultato non viene mai ridotta senza avvisare. In caso di memoria insufficiente, i dati già salvati restano disponibili e l’errore viene segnalato.',
    },
    RUN_FAILURE: {
      action:
        'I riquadri già salvati localmente restano visualizzabili ed esportabili. L’elaborazione non riuscita non è stata indicata come completata.',
    },
    PERSISTENCE_ERROR: {
      action: 'Anche la scrittura nell’archivio è fallita. Sono recuperabili solo i dati salvati in precedenza.',
    },
    MEMORY_BUDGET_RAISED: {
      message:
        'La cache è stata ampliata dai {{from}} riquadri consentiti dal limite a {{to}} riquadri, circa {{mb}} MB, per contenere tutti quelli interessati da un singolo fotogramma.',
      action:
        'Una cache più piccola dell’area coperta da un fotogramma obbligherebbe a decodificare e ricodificare tutti i suoi riquadri a ogni passaggio. Riduci la risoluzione della registrazione per usare meno memoria.',
    },
    NONFINITE_POSE: {
      message:
        'Il calcolo della posizione ha prodotto un valore non finito. L’osservazione è stata isolata e le coordinate non valide non sono state applicate all’immagine.',
    },
    MISSING_PLAN: {
      message: 'Manca plan/{{index}} nella fase di rendering. L’elaborazione si è fermata alla parte già salvata.',
      action:
        'Verifica l’integrità dell’archiviazione locale. Un piano di posizionamento mancante non viene mai trattato tacitamente come un’osservazione vuota.',
    },
    prefixOnly: {
      base: {
        scan: 'Posizionamento e composizione proseguono solo con i fotogrammi già decodificati ({{frames}})',
        solve: 'Il rendering prosegue solo con i fotogrammi già posizionati ({{frames}})',
        render: 'Vengono conservati solo i risultati dei fotogrammi già renderizzati ({{frames}})',
      },
      suffixPersistence: '; la scrittura nell’archivio si è interrotta.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action: 'La vista con cornice è stata saltata per questa immagine. La ricostruzione nelle coordinate della pagina resta invariata.',
    },
    PRESENTATION_FRAME: {
      message:
        'La vista con cornice e il contenuto 2D originale sono conservati separatamente. La cornice proviene da un fotogramma di riferimento. Le parti estese sono solo sfondo decorativo e non contano come contenuto osservato: le icone non vengono mai allungate o duplicate. Gli altri pannelli nella cornice sono semplici immagini di riferimento.',
    },
    PRESENTATION_STAGE_FAILED: {
      action:
        'La creazione della vista con cornice non è riuscita. Il risultato e lo stato della ricostruzione nelle coordinate della pagina restano invariati.',
    },
    PYRAMID_FAILED: {
      action:
        'La creazione dei livelli di anteprima non è riuscita. I riquadri alla risoluzione originale restano intatti, visualizzabili ed esportabili.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: 'La fase {{pass}} ha completato solo {{actual}} fotogrammi su {{expected}}. Il risultato è stato indicato come parziale.',
      action:
        'La parte salvata correttamente è stata conservata. I fotogrammi mancanti non vengono mai considerati elaborati senza segnalarlo.',
    },
    FRAME_CONVERSION: {
      message: 'Metodo di conversione dei fotogrammi decodificati in pixel: {{method}}.',
    },
    HDR_UNCHECKED: {
      message:
        'Questa registrazione è HDR ({{transfer}}), ma il browser non consente di verificare la conversione del colore. Il risultato potrebbe apparire scuro o sbiadito.',
      action: 'Riprova con una versione aggiornata di Chrome o Safari.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'Nel primo fotogramma HDR, una parte dei pixel supera la luminosità del bianco ordinario ed è stata riportata al bianco: {{percent}}%. Se il risultato sembra sovraesposto, probabilmente il registratore ha impostato il bianco ordinario a una luminosità più alta.',
      action: 'Riporta il bianco SDR del registratore a 100 nit oppure disattiva la registrazione HDR.',
    },
    SLOW_CONVERSION: {
      message:
        'Il browser impiega circa {{ms}} ms per convertire ogni fotogramma di questa registrazione in pixel. La sola conversione richiederà quindi circa {{minutes}} min.',
      action:
        'Una versione aggiornata di Chrome o Safari è molto più veloce. Può aiutare anche convertire prima la registrazione in H.264.',
    },
    REVEAL_SKIPPED: {
      message:
        'Il risultato contiene troppe immagini indipendenti, o immagini troppo grandi. Rimuovere cursore, pulsanti flottanti e barre di scorrimento richiederebbe circa {{need}} MB in più della memoria disponibile. Questa fase è stata saltata e i pixel composti sono stati conservati.',
      action:
        'Il resto del risultato non cambia. Tante immagini indipendenti indicano spesso che alcune parti non sono state collegate a quelle precedenti. Prova una registrazione più breve o un computer con più memoria.',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}. Motore Rust: variante {{variant}}, thread di calcolo: {{threads}} ({{coreReason}}).',
    },
    PRESENTATION_REFERENCE_FAILED: {
      action: 'La vista con cornice verrà saltata. La ricostruzione nelle coordinate della pagina resta invariata.',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'Il fotogramma non contiene dettagli riconoscibili. Immagini vuote identiche possono indicare una pausa oppure un movimento su un’area vuota: i soli pixel non permettono di distinguerli.',
      action:
        'Includi contenuti riconoscibili o una maggiore sovrapposizione nella registrazione. Lo spostamento nullo, in questo caso, è solo una stima.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Questa osservazione non offre riferimenti visivi affidabili per l’allineamento. La fase di posizionamento proverà a collegarla a immagini precedenti. Se non ci riuscirà, resterà un frammento indipendente.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'È stato rilevato un motivo ripetuto con più corrispondenze ugualmente plausibili. La continuità del movimento aiuta a stimare la posizione, ma non dimostra che sia unica.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message:
        'Questo fotogramma copre un intervallo insolitamente lungo. Un movimento rapido potrebbe aver attraversato aree mai acquisite.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'Le parti non coperte dalle aree manuali restano in un livello di osservazione indipendente, con bassa confidenza, nelle coordinate dello schermo. La loro posizione nella pagina non è considerata ricostruita.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Un’area contrassegnata come «Ignora» è stata esclusa secondo l’impostazione manuale. Non contribuisce alla ricostruzione: non sono stati scartati fotogrammi automaticamente.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Quando le aree manuali si sovrappongono, prevale quella disegnata per ultima. Le aree ignorate sono sempre escluse. I pixel rimanenti restano nel livello di osservazione non assegnato.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Rilevamento automatico: aree di contenuto {{moving}}, aree di interfaccia fissa {{fixed}}. I confini derivano dal movimento dei pixel, non dal DOM.',
      action:
        'Se un’area è stata assegnata male, delimita con precisione la zona scorrevole in «Aree di movimento» e riavvia l’elaborazione.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: 'Ogni area di scorrimento indipendente avrà una propria immagine. Non viene imposto uno spostamento comune.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Dopo l’allineamento, l’area sovrapposta contiene complessivamente {{conflicts}} pixel molto diversi. Questa zona è una delle componenti del conflitto. Possibili cause: animazioni, aggiornamenti del contenuto, cambi di impaginazione o errori residui di allineamento.',
      actionStable:
        'Dove possibile, l’intera zona in conflitto è stata fissata a un unico momento. Controlla i messaggi arancioni e il momento corrispondente nel video originale.',
      actionRolling:
        'L’intera zona in conflitto viene aggiornata dallo stesso fotogramma solo quando è completamente visibile. La pagina nel suo insieme non rappresenta quindi un unico momento.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Questa zona modificata non è mai apparsa per intero in un’inquadratura utilizzabile. Non è garantito che tutti i suoi pixel provengano dallo stesso momento.',
      action:
        'Il contenuto osservato e la segnalazione esplicita del conflitto vengono conservati. Le parti non osservate non sono state inventate.',
    },
    MISSING_SCAN_RECORD: {
      message: 'Manca scan/{{index}} nella fase di posizionamento. L’elaborazione si è fermata alla parte già salvata.',
      action: 'Verifica l’integrità dell’archiviazione locale. Un’osservazione mancante non viene mai interpretata come spostamento nullo.',
    },
    GRAPH_RESIDUAL: {
      message:
        'Lo scarto residuo massimo nel grafo delle posizioni è ancora di {{residual}} pixel originali. Le giunzioni vicine potrebbero presentare incoerenze geometriche.',
      action: 'Controlla testi e motivi ripetuti vicino all’area rivisitata. Questo scarto non è stato nascosto.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Una parte dei blocchi di texture non segue lo spostamento globale, circa {{percent}}%, per esempio a causa di animazioni, video, caricamento differito o cambi di impaginazione. Lo spostamento viene calcolato sui blocchi coerenti; le aree in conflitto sono gestite separatamente durante la composizione.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'Il movimento tra i fotogrammi è ampio e lascia poca sovrapposizione per l’allineamento. La stima dipende da questa piccola area. In un’impaginazione ripetitiva, anche il motivo adiacente potrebbe spiegare gli stessi pixel.',
      action:
        'Se un ritorno successivo offre riferimenti più solidi, l’intero segmento di traiettoria verrà corretto e la correzione registrata.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'Un motivo ripetuto rende plausibili più spostamenti. È stato scelto quello più coerente con la continuità del movimento: è una stima, non la prova che questo sia l’unico allineamento corretto.',
      messageLowConfidence:
        'La posizione di quest’area è stata stimata con bassa confidenza. I pixel interessati sono segnalati nella maschera di qualità.',
      messageStatic:
        'I due fotogrammi sono quasi identici, ma mancano corrispondenze verificabili tra i dettagli. Sono trattati come una pausa, con spostamento nullo. È una stima.',
      action:
        'La traiettoria continua e gli eventuali riferimenti esistenti sono stati usati per stimare la posizione. Non è dimostrato che questo sia l’unico allineamento corretto.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'Quest’area del fotogramma non contiene dettagli riconoscibili. Un’immagine vuota può indicare una pausa o un movimento su una zona vuota: i pixel da soli non permettono di distinguerli. Non viene collocata nell’immagine.',
      action:
        'Se il contenuto dopo l’area vuota non si sovrappone alle osservazioni precedenti, resta un frammento indipendente. La distanza intermedia non viene indovinata.',
    },
    RELOCALIZED: {
      message:
        'Un riferimento visivo precedente ha permesso di ritrovare la posizione su un’immagine già osservata. Il contenuto rivisitato non è stato aggiunto come nuova estensione del risultato.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Rilevata una variazione di scala o impaginazione di circa {{scale}}×. Il contenuto resta un frammento indipendente con i pixel originali, senza ridimensionamenti nascosti nella composizione.',
      action:
        'La relazione tra i frammenti non è ancora confermata. Se un ritorno successivo fornisce una corrispondenza affidabile, il frammento verrà ricollegato per intero. Registra con più sovrapposizione oppure isola la parte che cambia in un’area manuale.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'Non è stato possibile confermare la posizione rispetto all’immagine originale. Il contenuto resta un frammento indipendente, esportabile separatamente. I frammenti potrebbero sovrapporsi oppure essere separati da uno spazio reale.',
      action:
        'La relazione tra i frammenti non è ancora confermata. Se un ritorno successivo fornisce una corrispondenza affidabile, il frammento verrà ricollegato per intero. Registra con più sovrapposizione oppure isola la parte che cambia in un’area manuale.',
    },
    STICKY_OCCLUSION: {
      message:
        'I dettagli in alto indicano un’interfaccia fissa sullo schermo, non un movimento della pagina. Questo elemento sovrapposto non viene aggiunto al contenuto in movimento. L’interfaccia di riferimento resta nella vista con cornice.',
    },
    NESTED_LAYER_FOUND: {
      message:
        'Una parte di questa regione scorre per conto suo: in {{frames}} fotogrammi il suo contenuto non si è mosso con la regione, quindi ha un’immagine propria.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'Un ritorno su contenuti già visti ha permesso di ricollegare un frammento indipendente per intero a un’immagine esistente. La traiettoria relativa all’interno del frammento non cambia.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'Il passaggio precedente aveva poca sovrapposizione. L’allineamento di questo fotogramma con contenuti già osservati differisce di {{discrepancy}} px ed è sostenuto da indizi migliori. La posizione attuale è stata corretta.',
      action:
        'La correzione riguarda questo fotogramma e la traiettoria successiva. I pixel già scritti restano invariati e potrebbero mostrare una giunzione visibile con le coordinate corrette.',
    },
    LOOP_CLOSURE: {
      message:
        'È stato trovato un ritorno affidabile su un’area già vista e aggiunto come vincolo globale di posizione. La composizione finale usa la traiettoria corretta.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'La corrispondenza con le immagini precedenti differisce dalla traiettoria continua di {{discrepancy}} px. Gli indizi sono contraddittori: il ritorno non è stato imposto come vincolo.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'La ricerca tra le immagini precedenti ha trovato più posizioni quasi ugualmente plausibili. Il ritorno incerto non è stato imposto come vincolo rigido.',
    },
  },
  progress: {
    runPartial: 'È stata salvata una ricostruzione esplicitamente indicata come parziale.',
    runComplete: 'Ricostruzione completata. Controlla la diagnostica e le aree non osservate.',
    render: 'Composizione dei riquadri alla risoluzione originale dai contenuti osservati. Le parti mancanti restano trasparenti.',
    reveal: {
      learn: 'Nuova lettura della registrazione per trovare pulsanti, barre di inserimento e barre di scorrimento sovrapposti alla pagina.',
      agree: 'Confronto di ogni area nel tempo: viene preferita una vista senza ostacoli.',
      relearn: 'Nuova individuazione degli elementi flottanti sulla pagina verificata.',
      write: 'Sostituzione delle aree coperte o incoerenti con il fotogramma privo di ostacoli.',
    },
    framingStart: 'Conservazione della cornice originale. Viene esteso solo lo sfondo, senza allungare i testi o duplicare le icone.',
    pyramidBuild: 'Creazione dei livelli di anteprima su disco. I riquadri alla risoluzione originale restano invariati.',
    scanFrame: 'Estrazione dei riferimenti geometrici fotogramma per fotogramma e riconoscimento dei movimenti indipendenti.',
    duplicateReuse:
      'Un’osservazione identica riutilizza il posizionamento precedente. Il fotogramma sorgente e il riferimento temporale vengono conservati.',
    solveFrame: 'Affinamento al pixel, ricerca di posizioni precedenti e vincoli sui ritorni in 2D.',
    optimizing: 'Ottimizzazione del grafo delle posizioni su disco e correzione della deriva nei ritorni.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: questo browser non può decodificare il codec della registrazione ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'Le registrazioni di iPhone e Mac sono spesso in HEVC, supportato solo da alcuni browser. Usa Safari, oppure Chrome o Edge con decodifica hardware.',
      prores: 'Nessun browser decodifica ProRes. Esporta prima la registrazione in H.264 o HEVC.',
      h264: 'Solo Chrome decodifica questa variante di H.264 (4:4:4 o 10 bit). Usa Chrome oppure esporta in H.264 standard.',
      av1: 'AV1 richiede un browser o hardware recente. Usa Chrome aggiornato oppure esporta la registrazione in H.264.',
      other: 'Usa Chrome o Safari aggiornato oppure converti prima la registrazione in H.264.',
    },
    PIXEL_ASPECT_RATIO:
      'La registrazione dichiara un rapporto d’aspetto dei pixel di {{num}}:{{den}}. I pixel memorizzati non vengono ridimensionati, quindi le proporzioni visualizzate potrebbero differire.',
    CONTAINER_SIZE_MISMATCH:
      'Il contenitore dichiara {{codedWidth}}×{{codedHeight}}, ma il flusso video misura {{bitstreamWidth}}×{{bitstreamHeight}}. Fanno fede le dimensioni del flusso.',
    NON_SQUARE_PIXELS:
      'La registrazione dichiara pixel non quadrati: visualizzazione {{displayWidth}}×{{displayHeight}}, memorizzazione {{bitstreamWidth}}×{{bitstreamHeight}}. I pixel originali memorizzati vengono conservati senza ridimensionamento.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'Il decoder ha prodotto un fotogramma precedente all’inizio indicato dalla lista di montaggio, con riferimento temporale negativo. Questi fotogrammi non vengono mostrati, come previsto dal contenitore.',
    NONMONOTONIC_TIMESTAMP:
      'Un riferimento temporale del contenitore è tornato indietro. L’elaborazione è proseguita nell’ordine di presentazione del decoder, senza scartare osservazioni.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: il box ctts di questa traccia video è in versione 0, ma contiene scostamenti temporali di composizione negativi. ISO 14496-12 li definisce solo nella versione 1. Sono interpretati come valori con segno, secondo una convenzione comune di QuickTime/ReplayKit, non come numeri positivi enormi.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: il file termina all’interno del box {{box}}, che dovrebbe finire al byte {{declaredEnd}}, ma il file contiene solo {{size}} byte. La registrazione potrebbe non essersi conclusa correttamente, oppure il file è stato interrotto durante la copia o il trasferimento. I fotogrammi successivi al taglio non sono decodificabili: l’analisi ne troverà meno di quelli indicati nei metadati e il risultato sarà segnalato come parziale.',
  },
  exports: {
    tilesProgress: 'Esportazione dei riquadri originali e di anteprima {{n}}',
    zipFinalize: 'Scrittura della directory ZIP64 e salvataggio del file',
    projectDone: {
      message:
        'Esportati riquadri a risoluzione originale, visualizzatore offline, dati di copertura e qualità, riferimenti ai fotogrammi sorgente e diagnostica completa.',
    },
    encodingSingle: 'Codifica della riga {{row}} / {{total}} alla scala originale',
    canvasDone: {
      message: 'Esportato un PNG di {{width}} × {{height}}. Le parti mancanti restano trasparenti.',
    },
    encodingSheet: 'Immagini parziali codificate alla risoluzione originale: {{count}}',
    sheetsDone: {
      messagePaged:
        'Immagini parziali esportate alla risoluzione originale: {{count}}. Le parti adiacenti si sovrappongono fino a {{overlap}} px; le coordinate sono nel file manifest.',
      messageOversize:
        'L’immagine supera le dimensioni compatibili con un file unico. È stata quindi divisa esplicitamente in parti alla risoluzione originale: {{count}}. Le parti adiacenti si sovrappongono fino a {{overlap}} px; le coordinate sono nel file manifest.',
    },
  },
  offline: {
    title: 'Visualizzatore offline',
    fit: 'Adatta',
    tip: 'Riquadri locali alla risoluzione originale · trascina per spostarti / scorri per ingrandire',
    previewLevel: 'Livello di anteprima {{level}}. Ingrandisci per vedere i pixel originali',
    nativeTiles: 'Visualizzazione dei riquadri alla risoluzione originale',
    footer:
      'La scacchiera indica aree non osservate o senza riquadri. La confidenza non è una probabilità di correttezza. Consulta diagnostics.jsonl e observations.jsonl.',
  },
};
