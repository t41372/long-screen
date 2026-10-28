import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'De reconstructie gebruikt bewegende canvaslagen met geometrische beperkingen bij terugkeer naar eerder gezien beeld. Automatische maskers en herkenning van veranderende gebieden zijn heuristische schattingen. Betrouwbaarheidsscores zijn geen gekalibreerde kansen op juistheid. Vergelijkingen in het gezamenlijke coördinatenstelsel houden rekening met de opgegeven decodeerruis van deze bron: ±{{noise}} niveaus{{margin}}.',
      marginLossy: ' (marge voor compressieranden en herstel van kleurinformatie)',
      marginLossless: ' (verliesvrije bron, exacte vergelijking per pixel)',
      action:
        'Als schaal of structuur niet samengaan, blijft het gebied een apart fragment. Onverenigbare beelden worden niet geforceerd samengevoegd.',
    },
    APPROXIMATE_DECODER: {
      message:
        '‘Benaderend · videospeler’ is bewust ingeschakeld met {{fps}} Hz. Niet elk videoframe wordt gegarandeerd meegenomen; kort zichtbare inhoud kan ontbreken.',
      action: 'Moet elk frame worden meegenomen? Gebruik dan invoer met een codec die WebCodecs ondersteunt, zoals H.264 of VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'Voor bewegingsanalyse is de lange zijde begrensd op {{size}} px. Verfijning en uiteindelijke samenvoeging gebruiken de oorspronkelijke pixels; de uitvoer wordt niet verkleind.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Eén frame op ware grootte met zijn referentieframes vult bijna het gekozen cachebudget. Geheugen van codec en GPU valt niet onder het JavaScript-cachebudget.',
      action:
        'De uitvoerresolutie wordt nooit ongemerkt verlaagd. Bij geheugentekort blijven opgeslagen gegevens behouden en wordt de fout gemeld.',
    },
    RUN_FAILURE: {
      action: 'Lokaal opgeslagen tegels blijven te bekijken en te exporteren. De fout is niet als geslaagde verwerking gemarkeerd.',
    },
    PERSISTENCE_ERROR: { action: 'Ook het schrijven naar de opslag mislukte. Alleen eerder opgeslagen gegevens kunnen worden hersteld.' },
    MEMORY_BUDGET_RAISED: {
      message:
        'Het aantal tegels in de cache is verhoogd: {{from}} → {{to}} (ongeveer {{mb}} MB), zodat alle tegels die één frame raakt erin passen.',
      action:
        'Een cache kleiner dan het bereik van één frame zou voor elk frame alle betrokken tegels opnieuw moeten decoderen en coderen. Verlaag de opnameresolutie om minder geheugen te gebruiken.',
    },
    NONFINITE_POSE: {
      message:
        'De positieberekening leverde een niet-eindige waarde op. Deze waarneming is apart gehouden; de ongeldige coördinaten zijn niet op het canvas geschreven.',
    },
    MISSING_PLAN: {
      message: 'Bij het samenstellen ontbreekt plan/{{index}}. De verwerking is gestopt bij het laatst opgeslagen deel.',
      action:
        'Controleer de lokale opslag op beschadiging. Een ontbrekend plaatsingsplan wordt nooit stilzwijgend als lege waarneming behandeld.',
    },
    prefixOnly: {
      base: {
        scan: 'Plaatsen en samenvoegen gaan verder met alleen de al gedecodeerde frames ({{frames}})',
        solve: 'Samenstellen gaat verder met alleen de frames waarvan de positie is bepaald ({{frames}})',
        render: 'Alleen het al samengestelde deel blijft bewaard; aantal frames: {{frames}}',
      },
      suffixPersistence: '; schrijven naar de opslag is gestopt.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action: 'De weergave met kader is voor dit canvas overgeslagen. De reconstructie in paginacoördinaten blijft intact.',
    },
    PRESENTATION_FRAME: {
      message:
        'De weergave met kader en de oorspronkelijke tweedimensionale inhoud worden apart bewaard. Het kader komt uit een referentieframe. De uitbreiding is alleen decoratieve achtergrond, geen waargenomen inhoud. Werkbalkpictogrammen worden nooit uitgerekt of herhaald. Andere panelen binnen het kader zijn alleen momentopnames uit het referentieframe.',
    },
    PRESENTATION_STAGE_FAILED: {
      action:
        'De weergave met kader kon niet worden gemaakt. Het resultaat en de status van de reconstructie in paginacoördinaten blijven ongewijzigd.',
    },
    PYRAMID_FAILED: {
      action: 'De voorbeeldpiramide kon niet worden opgebouwd. Tegels op ware grootte blijven intact, te bekijken en te exporteren.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: 'Fase {{pass}}: verwerkte frames {{actual}}/{{expected}}. Het resultaat is als gedeeltelijk gemarkeerd.',
      action: 'Het succesvol opgeslagen begin blijft bewaard. Ontbrekende frames worden nooit stilzwijgend als verwerkt beschouwd.',
    },
    FRAME_CONVERSION: { message: 'Gedecodeerde frames worden omgezet in pixels via: {{method}}.' },
    HDR_UNCHECKED: {
      message:
        'Dit is een HDR-opname ({{transfer}}), maar deze browser kan de kleuromzetting niet controleren. Het resultaat kan daardoor donker of flets zijn.',
      action: 'Verwerk de opname opnieuw in een recente versie van Chrome of Safari.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'In het eerste frame van deze HDR-opname is {{percent}}% van de pixels helderder dan gewoon wit. Die pixels zijn als wit behandeld. Lijkt het resultaat overbelicht, dan heeft de recorder gewoon wit waarschijnlijk op een hogere helderheid gezet.',
      action: 'Zet SDR-wit in de recorder terug op 100 nits of schakel HDR-opname uit.',
    },
    SLOW_CONVERSION: {
      message:
        'Deze browser heeft ongeveer {{ms}} ms nodig om elk frame in pixels om te zetten. Alleen die omzetting zal al ongeveer {{minutes}} min duren.',
      action: 'Een recente versie van Chrome of Safari is veel sneller. De opname eerst omzetten naar H.264 kan ook helpen.',
    },
    REVEAL_SKIPPED: {
      message:
        'Dit resultaat bevat te veel of te grote canvassen. Het verwijderen van cursor, zwevende knoppen en schuifbalken zou ongeveer {{need}} MB meer geheugen vergen dan beschikbaar is. Die stap is overgeslagen; de samengevoegde pixels zijn behouden.',
      action:
        'De rest van het resultaat blijft intact. Veel canvassen wijzen er meestal op dat delen niet aan eerdere beelden konden worden gekoppeld. Een kortere opname of een computer met meer geheugen kan helpen.',
    },
    COMPUTE_BACKEND: { message: '{{backend}} — {{reason}}. Rust-kern: {{variant}}-versie, rekenthreads: {{threads}} ({{coreReason}}).' },
    PRESENTATION_REFERENCE_FAILED: {
      action: 'De weergave met kader wordt overgeslagen. De reconstructie in paginacoördinaten blijft intact.',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'Het frame bevat te weinig herkenbare details. Twee identieke lege frames kunnen zowel een pauze als beweging over een leeg gebied betekenen. Pixels alleen kunnen dat niet onderscheiden.',
      action: 'Neem meer herkenbare inhoud op of zorg voor meer overlap. Geen verplaatsing aannemen is hier slechts de beste schatting.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Deze waarneming heeft geen betrouwbare visuele basis voor uitlijning. Bij het bepalen van de positie wordt gezocht naar eerdere overeenkomsten. Lukt plaatsen dan nog niet, dan blijft het een apart fragment.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'Een herhaald patroon levert meerdere even aannemelijke overeenkomsten op. Een doorgaande beweging helpt een positie te schatten, maar bewijst niet dat die positie uniek en juist is.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message: 'Dit frame beslaat een ongewoon lange tijd. Bij snelle beweging kunnen gebieden buiten de opname zijn gevallen.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'Het deel buiten de handmatig gemarkeerde gebieden blijft een aparte waarnemingslaag in schermcoördinaten, met lage betrouwbaarheid. Er wordt niet beweerd dat deze pixels in paginacoördinaten zijn hersteld.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Een gebied met ‘Uitsluiten’ is volgens de handmatige instelling weggelaten. Het draagt niet bij aan de reconstructie; dit is geen automatisch overslaan van frames.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Waar handmatige gebieden overlappen, heeft het laatst getekende gebied voorrang. Uitgesloten gebieden worden altijd weggelaten. Overige pixels blijven in de niet-toegewezen waarnemingslaag.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Automatisch herkende inhoudsgebieden: {{moving}}; vaste interfacegebieden: {{fixed}}. De grenzen zijn bepaald uit pixelbewegingen, niet uit het DOM.',
      action: 'Klopt een gebied niet? Teken het scrolgebied precies in bij ‘Bewegende gebieden’ en verwerk de opname opnieuw.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: 'Elk onafhankelijk scrolgebied krijgt een eigen canvas. Ze worden niet gedwongen dezelfde verplaatsing te volgen.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Na uitlijning is het aantal duidelijk afwijkende pixels in de overlap {{conflicts}}. Dit gebied is één conflicterend onderdeel daarvan. Mogelijke oorzaken zijn animatie, bijgewerkte inhoud, gewijzigde indeling of resterende uitlijnfouten.',
      actionStable:
        'Waar mogelijk is het hele conflicterende gebied vastgezet op één moment. Bekijk de oranje diagnostische markeringen en het bijbehorende tijdstip in de opname.',
      actionRolling:
        'Het hele conflicterende gebied wordt alleen vanuit hetzelfde frame bijgewerkt als het volledig zichtbaar is. Niet de hele pagina komt daardoor uit hetzelfde moment.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Dit veranderde gebied was nooit volledig zichtbaar in één bruikbaar beeld. Niet alle pixels komen dus gegarandeerd uit hetzelfde moment.',
      action: 'Waargenomen inhoud en expliciete conflictmarkeringen zijn behouden. Niet-waargenomen delen zijn niet verzonnen.',
    },
    MISSING_SCAN_RECORD: {
      message: 'Bij het bepalen van posities ontbreekt scan/{{index}}. De verwerking is gestopt bij het laatst opgeslagen deel.',
      action: 'Controleer de lokale opslag op beschadiging. Een ontbrekend scanrecord wordt nooit behandeld als nul verplaatsing.',
    },
    GRAPH_RESIDUAL: {
      message:
        'De maximale restafwijking in de positiegraaf is nog {{residual}} px op ware grootte. Nabije naden kunnen geometrisch afwijken.',
      action: 'Controleer tekst en herhaalde patronen rond het terugkeerpunt. Deze restafwijking is niet verborgen.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Ongeveer {{percent}}% van de textuurblokken wijkt af van de algemene verplaatsing, bijvoorbeeld door animatie, video, later geladen inhoud of een gewijzigde indeling. De overeenstemmende blokken bepalen de verplaatsing. Het conflicterende gebied wordt bij het samenvoegen apart behandeld.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'Tussen de frames was een grote verplaatsing, met weinig overlap voor uitlijning. De positie is op dat kleine stukje bewijs gebaseerd. In een herhaalde indeling kan een aangrenzende herhaling dezelfde pixels verklaren.',
      action: 'Levert een later bezoek sterker bewijs op, dan wordt dit hele trajectdeel gecorrigeerd en vastgelegd.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'Een herhaald patroon past bij meerdere verplaatsingen. Gekozen is wat het best aansluit op de doorgaande beweging: een schatting, niet de enige mogelijke uitlijning.',
      messageLowConfidence: 'Dit gebied is geplaatst met lage betrouwbaarheid. De betrokken pixels zijn op de kwaliteitskaart gemarkeerd.',
      messageStatic:
        'De frames zijn bijna identiek, maar herkenningspunten konden niet betrouwbaar worden gekoppeld. Dit is behandeld als een pauze met nul verplaatsing: een schatting.',
      action:
        'Het doorlopende traject en aanwezige ankerpunten zijn gebruikt voor de beste schatting. Die wordt niet als de enige juiste uitlijning gepresenteerd.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'Dit frame heeft in dit gebied geen herkenbare details. Een leeg frame kan een pauze betekenen of beweging over een leeg gebied; pixels alleen maken dat onderscheid niet. Het gebied is nergens op het canvas geplaatst.',
      action:
        'Kan de inhoud na het lege gebied niet met eerdere waarnemingen worden verbonden, dan blijft die een apart fragment. De afstand ertussen wordt niet geraden.',
    },
    RELOCALIZED: {
      message:
        'De positie is teruggevonden op een bestaand canvas via een visueel anker uit eerdere beelden. Opnieuw bezochte inhoud is niet als een nieuw stuk aan de lange afbeelding toegevoegd.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Er is een verandering van schaal of indeling van ongeveer {{scale}}× gevonden. Het gebied blijft een apart fragment op ware grootte; er is niet ongemerkt geschaald.',
      action:
        'De onderlinge positie van de fragmenten is nog niet bevestigd. Bij een betrouwbare latere overeenkomst wordt het fragment als geheel gekoppeld. Neem opnieuw op met meer overlap of markeer het veranderende onderdeel als apart gebied.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'De positie ten opzichte van het oorspronkelijke canvas kon niet worden bevestigd. Het gebied blijft een apart, los te exporteren fragment. De fragmenten kunnen overlappen, maar er kan ook echt een gat tussen zitten.',
      action:
        'De onderlinge positie van de fragmenten is nog niet bevestigd. Bij een betrouwbare latere overeenkomst wordt het fragment als geheel gekoppeld. Neem opnieuw op met meer overlap of markeer het veranderende onderdeel als apart gebied.',
    },
    STICKY_OCCLUSION: {
      message:
        'Details boven in het frame wijzen op een vaste interface in plaats van paginabeweging. Deze vaste bedekking is niet in het bewegende canvas opgenomen. De oorspronkelijke interface blijft bewaard in de weergave met kader.',
    },
    NESTED_LAYER_FOUND: {
      message:
        'Een deel van dit gebied scrolt zelfstandig: in {{frames}} frames bewoog de inhoud niet mee met het gebied, dus het krijgt een eigen afbeelding.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'Een later bezoek gaf genoeg bewijs om een los fragment als geheel aan een bestaand canvas te koppelen. Het relatieve traject binnen het fragment is ongewijzigd.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'De vorige stap had weinig overlap. De overeenkomst van dit frame met eerder waargenomen inhoud wijkt {{discrepancy}} px af en is beter onderbouwd. De huidige positie is daarop gecorrigeerd.',
      action:
        'Dit frame en het traject erna zijn gecorrigeerd. Eerder geschreven pixels zijn niet veranderd; bij de overgang naar de nieuwe coördinaten kan een naad zichtbaar zijn.',
    },
    LOOP_CLOSURE: {
      message:
        'Een betrouwbare terugkeer naar eerder gezien beeld is gevonden en toegevoegd als globale positiebeperking. De uiteindelijke samenvoeging gebruikt het gecorrigeerde traject.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'De overeenkomst met eerder beeld wijkt {{discrepancy}} px af van het doorgaande traject. De aanwijzingen spreken elkaar tegen. Daarom is deze overeenkomst niet als verplichte terugkeerkoppeling toegepast.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'Zoeken in eerdere beelden leverde meerdere bijna even aannemelijke posities op. Een onzekere terugkeerkoppeling is niet als harde beperking opgelegd.',
    },
  },
  progress: {
    runPartial: 'Een resultaat met expliciete vermelding van onvolledige reconstructie is bewaard.',
    runComplete: 'Reconstructie voltooid. Controleer de diagnostiek en de niet-waargenomen gebieden.',
    render: 'Waargenomen pixels samenvoegen tot tegels op ware grootte. Gaten blijven transparant.',
    reveal: {
      learn: 'De opname opnieuw bekijken om knoppen, invoerbalken en schuifbalken boven de pagina te vinden.',
      agree: 'Vergelijken hoe elk deel van de pagina er door de tijd uitzag. Een onbelemmerd beeld krijgt voorrang.',
      relearn: 'Zwevende elementen opnieuw zoeken ten opzichte van de gecontroleerde pagina.',
      write: 'Bedekte of afwijkende gebieden vervangen door het schone frame.',
    },
    framingStart:
      'Het oorspronkelijke kader behouden. Alleen de achtergrond wordt verlengd; zijbalktekst wordt niet uitgerekt en pictogrammen worden niet herhaald.',
    pyramidBuild: 'De voorbeeldpiramide op schijf opbouwen. Tegels op ware grootte blijven ongewijzigd.',
    scanFrame: 'Frame voor frame geometrische aanwijzingen verzamelen en onafhankelijke bewegingsgebieden bepalen.',
    duplicateReuse: 'Een identieke waarneming hergebruikt de vorige positie. Het bronframe en tijdstip blijven bewaard.',
    solveFrame:
      'Verfijnen met oorspronkelijke pixels, posities in eerdere beelden terugvinden en terugkeerkoppelingen in twee dimensies bepalen.',
    optimizing: 'De positiegraaf op schijf optimaliseren en opgelopen afwijkingen met terugkeerpunten corrigeren.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: deze browser kan de codec van deze opname niet decoderen ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'Opnames van iPhone en Mac gebruiken meestal HEVC. Niet alle browsers ondersteunen dat. Gebruik Safari, of Chrome of Edge met hardwaredecodering.',
      prores: 'Browsers kunnen ProRes niet decoderen. Exporteer de opname eerst als H.264 of HEVC.',
      h264: 'Alleen Chrome decodeert dit type H.264 (4:4:4 of 10-bit). Gebruik Chrome of exporteer als gewone H.264.',
      av1: 'AV1 vereist een recente browser of geschikte hardware. Gebruik een recente versie van Chrome of exporteer de opname als H.264.',
      other: 'Gebruik een recente versie van Chrome of Safari, of zet de opname eerst om naar H.264.',
    },
    PIXEL_ASPECT_RATIO:
      'De opname vermeldt een pixelverhouding van {{num}}:{{den}}. De opgeslagen pixels blijven ongeschaald, waardoor de zichtbare beeldverhouding kan afwijken.',
    CONTAINER_SIZE_MISMATCH:
      'De container vermeldt {{codedWidth}}×{{codedHeight}}, maar de videostream is {{bitstreamWidth}}×{{bitstreamHeight}}. De afmetingen van de videostream worden gebruikt.',
    NON_SQUARE_PIXELS:
      'De opname vermeldt niet-vierkante pixels: weergave {{displayWidth}}×{{displayHeight}}, opslag {{bitstreamWidth}}×{{bitstreamHeight}}. De oorspronkelijke opgeslagen pixels blijven ongeschaald.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'De decoder leverde een frame vóór het beginpunt van de editlijst, met een negatief tijdstip. Volgens de containerregels worden zulke frames niet getoond.',
    NONMONOTONIC_TIMESTAMP:
      'Een tijdstip in de container ging achteruit. De verwerking is doorgegaan in de presentatievolgorde van de decoder; geen waarneming is weggegooid.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: het ctts-blok van dit videospoor is versie 0, maar bevat negatieve verschuivingen van de presentatietijd. ISO 14496-12 definieert die alleen voor versie 1. Ze worden als getallen met een teken gelezen, zoals gebruikelijk bij QuickTime/ReplayKit, niet als uitzonderlijk grote positieve waarden.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: het bestand eindigt binnen het blok {{box}}. Dat blok vermeldt eindbyte {{declaredEnd}}, maar de bestandsgrootte is slechts {{size}} byte. De opname is mogelijk niet goed afgerond of het bestand is afgebroken bij kopiëren of overzetten. Frames na het afbreekpunt kunnen niet worden gedecodeerd. De scan vindt daardoor minder frames dan de metadata vermelden en het resultaat wordt als gedeeltelijk gemarkeerd.',
  },
  exports: {
    tilesProgress: 'Oorspronkelijke tegels en voorbeeldtegels exporteren: {{n}}',
    zipFinalize: 'ZIP64-inhoudsopgave schrijven en bestand opslaan',
    projectDone: {
      message:
        'Tegels op ware grootte, offline viewer, dekkings- en kwaliteitsgegevens, bronframeregistraties en volledige diagnostiek zijn geëxporteerd.',
    },
    encodingSingle: 'Rij {{row}} / {{total}} coderen op ware grootte',
    canvasDone: { message: 'PNG van {{width}} × {{height}} geëxporteerd. Gaten blijven transparant.' },
    encodingSheet: 'Gecodeerde delen op ware grootte: {{count}}',
    sheetsDone: {
      messagePaged:
        'Geëxporteerde delen op ware grootte: {{count}}. Aangrenzende delen overlappen maximaal {{overlap}} px; de coördinaten staan in het manifest.',
      messageOversize:
        'Het canvas is te groot voor één breed ondersteunde afbeelding en is daarom expliciet in delen geëxporteerd. Aantal delen op ware grootte: {{count}}. Aangrenzende delen overlappen maximaal {{overlap}} px; de coördinaten staan in het manifest.',
    },
  },
  offline: {
    title: 'Offline canvas',
    fit: 'Passend',
    tip: 'Lokale tegels op ware grootte · slepen / scrollen om te zoomen',
    previewLevel: 'Voorbeeldniveau {{level}}. Zoom in om oorspronkelijke pixels te zien.',
    nativeTiles: 'Tegels op ware grootte worden getoond',
    footer:
      'Dambordgebieden zijn niet waargenomen of hebben geen tegels. Betrouwbaarheid is geen kans op juistheid. Zie diagnostics.jsonl en observations.jsonl.',
  },
};
