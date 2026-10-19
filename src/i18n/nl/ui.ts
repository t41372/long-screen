import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Frames analyseren en bewegingslagen bepalen',
      solving: 'Posities bepalen en verfijnen met oorspronkelijke pixels',
      optimizing: 'Terugkeerpunten en opgelopen afwijkingen corrigeren',
      rendering: 'Canvas samenstellen op ware grootte',
      revealing: 'Zwevende elementen verwijderen',
      framing: 'Kader en oorspronkelijke verhoudingen behouden',
      pyramid: 'Zoombaar voorbeeld opbouwen',
      complete: 'Voltooid · controleer de diagnostiek',
      partial: 'Gedeeltelijk resultaat bewaard',
      error: 'Fout tijdens verwerking',
    },
    count: {
      frames_one: '{{frames}} frame',
      frames_other: '{{frames}} frames',
      framesUnknown: '? frames',
      regions_one: '{{count}} handmatig gebied ↗',
      regions_other: '{{count}} handmatige gebieden ↗',
    },
    dom: {
      noCompressionStream:
        'Deze browser heeft geen CompressionStream. Dat is nodig om elke tegel op ware grootte als PNG op te slaan. De reconstructie kan niet starten.',
    },
    canvases: {
      badgePresentation: 'Met kader · uitgebreide achtergrond is geen waargenomen inhoud',
      badgeFixed: 'Vaste laag / waarnemingslaag',
      badgeMoving: 'Tweedimensionale inhoudslaag',
      badge_one: '{{kind}} · {{count}} tegel op ware grootte{{fragment}}',
      badge_other: '{{kind}} · {{count}} tegels op ware grootte{{fragment}}',
      fragmentNote: ' · onderlinge uitlijning van fragmenten is niet bevestigd',
    },
    diagnostics: {
      occurrenceSuffix: ' (aantal meldingen van dit type: {{count}})',
      locateAction: 'Betrokken gebied / bronbeeld bekijken ↗',
      viewSourceAction: 'Moment in de opname bekijken ↗',
      emptyFiltered: 'Geen meldingen voor dit filter.',
      emptyDefault: 'Hier verschijnen gegevens over uitlijning, paginawijzigingen, schattingen en verwerkingsfouten.',
      noOriginalVideo:
        'De oorspronkelijke video zit niet in het project. Kies dezelfde opname opnieuw om een tijdstip te bekijken. Het samengestelde resultaat staat nog steeds lokaal opgeslagen.',
      hashMismatch:
        'De naam en grootte komen overeen, maar de inhoudshash wijkt af van de opname waarmee dit project is gemaakt. Dit bestand kan daarom niet als bronbewijs dienen. Kies de juiste opname.',
      sourceCaption: 'Bronframe {{frame}} · {{time}} s · {{message}}',
    },
    export: {
      imageSuffix: '-screenshot',
      savePickerFallback: 'Rechtstreeks opslaan is niet beschikbaar. De browserdownload wordt gebruikt: {{error}}',
      saveRowLabel: '{{name}} bewaren · {{size}}',
      shareLabel: 'Delen / opslaan in Foto’s',
      shareFailed: 'Delen mislukt: {{error}}',
      cleanupLabel: 'Tijdelijke kopie na het bewaren verwijderen',
      exportErrorAction:
        'De export is niet afgerond en niet als geslaagd gemarkeerd. Al opgeslagen projecttegels staan nog op dit apparaat.',
      clipboardUnsupported: 'Deze browser kan geen afbeeldingen kopiëren. Gebruik ‘Screenshot bewaren’.',
      copyNoImage: 'Er is geen afbeelding gemaakt',
      copyFailedCtor: 'Kopiëren mislukt: {{error}}. Gebruik ‘Screenshot bewaren’.',
      copySuccess: 'Afbeelding van {{width}} × {{height}} gekopieerd. Je kunt hem nu plakken.',
      copyFailed: 'Kopiëren mislukt: {{error}}. Mogelijk is de afbeelding te groot voor het klembord. Gebruik ‘Screenshot bewaren’.',
    },
    crop: {
      buttonCropped: 'Uitsnede · {{width}} × {{height}}',
      applied:
        'Klaar. Downloads, kopieën en exports in delen gebruiken nu alleen deze uitsnede ({{width}} × {{height}}). De ZIP van het volledige project wordt niet bijgesneden.',
      removed: 'Uitsnede verwijderd. Exports gebruiken weer het hele beeld.',
    },
    main: {
      offscreenMissing: 'Deze browser heeft geen OffscreenCanvas. De achtergrondtaak voor het samenstellen kan niet starten.',
      webcodecsMissingToast: 'Deze browser heeft geen WebCodecs. Kies zelf ‘Benaderend · videospeler’; daarbij kunnen frames ontbreken.',
      privateStorageToast:
        'Privémodus: het project blijft alleen in het geheugen van dit venster en verdwijnt zodra je het sluit. Exporteer eerst wat je wilt bewaren.',
      noOpfsNoPicker:
        'Deze browser heeft geen OPFS en geen dialoogvenster om bestanden op te slaan. De export wordt in het geheugen gemaakt (maximaal {{mb}} MB).',
      dbOpenFailed: 'De lokale database kon niet worden geopend: {{error}}',
      workerErrorToast: 'Fout in achtergrondtaak: {{message}}',
      workerMessageUndecodable:
        'Een bericht van de achtergrondtaak kon niet worden gelezen. Bewaar je huidige resultaten en herlaad de pagina.',
      interruptedPhaseWhere: '‘{{phase}}’, frame {{frames}}',
      interruptedStartPhase: 'de opstartfase',
      interruptedHiddenSome: 'de pagina stond ongeveer {{seconds}} s op de achtergrond{{stillHidden}}',
      interruptedStillHidden: ' (ook nog op het moment van onderbreken)',
      interruptedHiddenNone: 'de pagina bleef steeds op de voorgrond',
      interruptedDiagnosticMessage:
        'De vorige reconstructie werd onderbroken tijdens {{where}}. De pagina ontving geen voltooiingssignaal: de browser heeft haar uit het geheugen verwijderd of is vastgelopen. Verstreken tijd: {{elapsed}} s; kerngeheugen: {{memory}} MB; {{hidden}}; frameconversie: {{conversion}}; CPU-kernen: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari verlaagt de geheugenlimiet sterk zodra een pagina naar de achtergrond gaat. Houd dit tabblad bij lange verwerkingen op de voorgrond. Het volledige verslag staat in de browserconsole.',
      interruptedNotIsolated: ' (geen cross-origin-isolatie, één thread)',
      interruptedToast: 'De vorige reconstructie werd onderbroken tijdens {{where}} ({{hidden}}). Zie de diagnostiek voor details.',
      unknownValue: 'onbekend',
    },
    run: {
      pausedStatus: 'Gepauzeerd · toestand in geheugen bewaard',
      resumedStatus: 'Verwerking hervatten',
      pauseLabel: 'Pauzeren',
      resumeLabel: 'Hervatten',
      stopToast: 'De huidige fase wordt afgerond. Zoveel mogelijk waargenomen inhoud wordt samengesteld en bewaard.',
      preparingStatus: 'Nauwkeurige decodering voorbereiden',
      preparingMessage: 'Container lezen, codec-ondersteuning en lokale opslag controleren.',
      compatibilityNeedsNative: 'Voor ‘Benaderend · videospeler’ moet de ingebouwde videospeler van je browser deze video kunnen lezen.',
      webcodecsHttpBlocked:
        'De browser staat WebCodecs niet toe op dit HTTP-adres. Kies ‘Benaderend · videospeler’ om lokaal verder te testen. Nauwkeurige decodering vereist localhost of HTTPS. Je video wordt niet geüpload.',
      webcodecsMissing:
        'Deze browser heeft geen WebCodecs. Werk Safari / iOS bij of kies zelf ‘Benaderend · videospeler’. Daarbij kunnen frames ontbreken.',
      startFailedStatus: 'Reconstructie kon niet starten',
      restoredMessage: 'Dit is je laatste resultaat. Na 24 uur wordt het verwijderd zodra je deze pagina opnieuw opent.',
      interruptedStatus: 'De vorige verwerking is niet afgerond',
      interruptedMessage:
        'Dit is wat er voor het stoppen is bewaard. Voeg de opname opnieuw toe en start nogmaals voor het volledige resultaat.',
      waitingCanvasOption: 'Wachten op het samengestelde canvas',
    },
    source: {
      busyToast: 'Rond de huidige verwerking eerst af of bewaar het resultaat.',
      subtitleReading: '{{size}} · geen upload · container en eerste frame lezen',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · alleen leesbaar met de ingebouwde videospeler',
      subtitleUnavailable: '{{size}} · nauwkeurige decodering en videovoorbeeld zijn niet beschikbaar',
      probeFailedMessage: 'Nauwkeurige decodering kon niet worden getest: {{error}}',
      probeFailedAction:
        'De ingebouwde videospeler wordt geprobeerd om metadata te lezen. Kies ‘Benaderend · videospeler’ om verder te verwerken.',
      rejectedVideo:
        '‘{{name}}’ is niet geopend: dit formaat ({{kind}}) kan de browser niet frame voor frame lezen. Stel je recorder in op MP4 of zet het bestand eerst om naar MP4 met HandBrake of ffmpeg.',
      rejectedOther:
        '‘{{name}}’ is geen video ({{kind}}) en is niet geopend. Kies een schermopname van het bewegen door een pagina: MP4, MOV, WebM of MKV. Op Windows kun je opnemen met het Knipprogramma of Xbox Game Bar (Win+Alt+R), op een Mac met ⌘⇧5 en op je telefoon met de ingebouwde schermrecorder.',
      unreadableToast:
        'Deze video kan niet worden gelezen ({{reason}}). Controleer of de opname goed is afgerond en het bestand volledig is gekopieerd of gedownload. Probeer anders een MP4 met H.264. De diagnostiek vermeldt waarom nauwkeurige decodering mislukte.',
      kind: {
        empty: 'leeg bestand',
        heif: 'HEIC/AVIF-afbeelding',
        avi: 'AVI-video',
        webp: 'WebP-afbeelding',
        wav: 'WAV-audiobestand',
        riff: 'RIFF-bestand',
        wmv: 'WMV/ASF-video',
        flv: 'FLV-video',
        mpegps: 'MPEG-PS-video',
        ogg: 'Ogg-mediabestand',
        gif: 'GIF-animatie',
        png: 'PNG-afbeelding',
        jpeg: 'JPEG-afbeelding',
        pdf: 'PDF-document',
        zip: 'ZIP-archief of Office-document',
        mp3: 'MP3-audiobestand',
        text: 'tekstbestand',
        mpegts: 'MPEG-TS-video',
        unknown: 'onbekend bestandstype',
      },
    },
    demo: { fileName: 'voorbeeldopname.mp4', loadFailed: 'De voorbeeldopname kon niet worden geladen: {{error}}' },
    feedback: {
      issueBody:
        '**Wat gebeurde er?**\n\n\n**Wat had je verwacht?**\n\n\n**Over de opname** (welke pagina, hoe je bewoog, ongeveer hoe lang; een screenshot helpt, maar verberg privégegevens)\n\n\n---\nIngevuld door Long Screen; pas gerust aan of verwijder:\n- Browser: {{browser}}\n- Geopend vanaf: {{page}}\n- Kern met meerdere threads (cross-origin-isolatie): {{threads}}\n- Waarschuwingen in het logboek: {{warnings}}\n',
      portable: 'offline versie (lokaal bestand)',
      yes: 'ja',
      no: 'nee',
      none: 'geen',
    },
    viewer: {
      previewLevel: 'Voorbeeldniveau L{{level}} (ware grootte blijft behouden)',
      nativeLevel: 'Oorspronkelijke pixels L0',
      qualityHint: ' · zoom in voor de kwaliteitskaart',
      unobservedHint: ' · blauw = niet waargenomen',
      provisionalHint: ' · paars = tijdelijke inhoud / bedekkende elementen',
    },
  },
  names: {
    fixed: 'Vaste interface',
    divider: 'Vaste scheidingsbalk',
    contentCanvas: 'Inhoudscanvas {{n}}',
    unassigned: 'Niet-toegewezen gebied · waarnemingen in schermcoördinaten',
    contentRegion: 'Inhoudsgebied {{n}}',
    ignored: 'Uitgesloten',
    fragment: 'ongeplaatst fragment {{n}}',
    framed: 'met kader',
  },
};
