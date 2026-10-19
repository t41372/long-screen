import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Analyse des images et séparation des mouvements',
      solving: 'Positionnement global et ajustement au pixel près',
      optimizing: 'Correction des retours et de la dérive cumulée',
      rendering: 'Assemblage à la taille d’origine',
      revealing: 'Suppression des éléments qui masquent la page',
      framing: 'Conservation du cadre et des proportions d’origine',
      pyramid: 'Création de l’aperçu zoomable',
      complete: 'Terminé · consultez les diagnostics',
      partial: 'Résultat partiel enregistré',
      error: 'Une erreur a interrompu le traitement',
    },
    count: {
      frames_one: '{{frames}} image',
      frames_other: '{{frames}} images',
      frames_many: '{{frames}} images',
      framesUnknown: '? images',
      regions_one: '{{count}} zone personnalisée ↗',
      regions_other: '{{count}} zones personnalisées ↗',
      regions_many: '{{count}} zones personnalisées ↗',
    },
    dom: {
      noCompressionStream:
        'Ce navigateur ne dispose pas de CompressionStream, nécessaire pour encoder chaque tuile en PNG à sa taille d’origine. La reconstitution ne peut pas démarrer.',
    },
    canvases: {
      badgePresentation: 'Vue encadrée · le fond prolongé n’est pas du contenu observé',
      badgeFixed: 'Couche fixe / d’observation',
      badgeMoving: 'Couche de contenu 2D',
      badge_one: '{{kind}} · {{count}} tuile à sa taille d’origine{{fragment}}',
      badge_other: '{{kind}} · {{count}} tuiles à leur taille d’origine{{fragment}}',
      badge_many: '{{kind}} · {{count}} tuiles à leur taille d’origine{{fragment}}',
      fragmentNote: ' · alignement des fragments non confirmé',
    },
    diagnostics: {
      occurrenceSuffix: ' ({{count}} occurrences de ce type)',
      locateAction: 'Localiser la zone / voir la source ↗',
      viewSourceAction: 'Voir ce moment dans la vidéo ↗',
      emptyFiltered: 'Aucune entrée pour ce filtre.',
      emptyDefault: 'Repères d’alignement, changements sur la page, estimations et erreurs de traitement apparaîtront ici.',
      noOriginalVideo:
        'La vidéo d’origine n’est pas incluse dans le projet. Sélectionnez à nouveau le même enregistrement pour consulter un moment précis. Le résultat assemblé est toujours enregistré sur cet appareil.',
      hashMismatch:
        'Le nom et la taille du fichier correspondent, mais pas son empreinte : son contenu diffère de la vidéo utilisée pour ce projet. Il ne peut donc pas servir de source pour vérifier les images. Choisissez le bon enregistrement.',
      sourceCaption: 'Image source {{frame}} · {{time}} s · {{message}}',
    },
    export: {
      imageSuffix: '-capture',
      savePickerFallback: 'L’enregistrement direct est indisponible. Téléchargement via le navigateur : {{error}}',
      saveRowLabel: 'Enregistrer {{name}} · {{size}}',
      shareLabel: 'Partager / enregistrer dans Photos',
      shareFailed: 'Échec du partage : {{error}}',
      cleanupLabel: 'Supprimer la copie temporaire après l’enregistrement',
      exportErrorAction: 'L’export inachevé n’a pas été signalé comme réussi. Les tuiles déjà enregistrées restent sur cet appareil.',
      clipboardUnsupported: 'Ce navigateur ne peut pas copier d’images. Utilisez « Télécharger la capture ».',
      copyNoImage: 'Aucune image n’a été générée',
      copyFailedCtor: 'Échec de la copie : {{error}}. Utilisez « Télécharger la capture ».',
      copySuccess: 'Image de {{width}} × {{height}} copiée. Vous pouvez la coller.',
      copyFailed:
        'Échec de la copie : {{error}}. L’image dépasse peut-être la capacité du presse-papiers. Utilisez « Télécharger la capture ».',
    },
    crop: {
      buttonCropped: 'Recadrer · {{width}} × {{height}}',
      applied:
        'Recadrage appliqué. Les téléchargements, copies et exports en plusieurs images ne prennent plus que cette zone ({{width}} × {{height}}). Le ZIP du projet complet reste entier.',
      removed: 'Recadrage supprimé. Les exports reprennent toute l’image.',
    },
    main: {
      offscreenMissing: 'Ce navigateur ne dispose pas d’OffscreenCanvas. Le worker de rendu ne peut pas fonctionner.',
      webcodecsMissingToast:
        'WebCodecs est indisponible dans ce navigateur. Choisissez « Approximatif · lecteur natif » pour continuer ; certaines images peuvent manquer.',
      privateStorageToast:
        'Navigation privée : le projet reste uniquement en mémoire dans cette fenêtre et disparaît à sa fermeture. Exportez-le avant de fermer pour le conserver.',
      noOpfsNoPicker:
        'Ce navigateur ne dispose ni d’OPFS ni d’une boîte de dialogue d’enregistrement. L’export sera généré en mémoire, jusqu’à {{mb}} Mo.',
      dbOpenFailed: 'Impossible d’ouvrir la base de données locale : {{error}}',
      workerErrorToast: 'Erreur du worker : {{message}}',
      workerMessageUndecodable: 'Un message du worker est illisible. Enregistrez les résultats existants, puis rechargez la page.',
      interruptedPhaseWhere: '« {{phase}} », image {{frames}}',
      interruptedStartPhase: 'la phase de démarrage',
      interruptedHiddenSome: 'la page est restée en arrière-plan environ {{seconds}} s{{stillHidden}}',
      interruptedStillHidden: ' (encore en arrière-plan lors de l’interruption)',
      interruptedHiddenNone: 'la page est restée au premier plan',
      interruptedDiagnosticMessage:
        'La reconstitution précédente a été interrompue pendant {{where}}. La page n’a reçu aucun signal de fin ; le navigateur l’a fermée ou a planté. Durée : {{elapsed}} s, mémoire du moteur : {{memory}} Mo, {{hidden}}, conversion des images : {{conversion}}, cœurs CPU : {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari ferme les pages en arrière-plan à un seuil de mémoire bien plus bas. Gardez cet onglet au premier plan pour les traitements longs. Le rapport complet figure dans la console du navigateur.',
      interruptedNotIsolated: ' (sans isolation entre origines, un seul thread)',
      interruptedToast:
        'La reconstitution précédente a été interrompue pendant {{where}} ({{hidden}}). Consultez les diagnostics pour en savoir plus.',
      unknownValue: 'inconnu',
    },
    run: {
      pausedStatus: 'En pause · état conservé en mémoire',
      resumedStatus: 'Reprise en cours',
      pauseLabel: 'Pause',
      resumeLabel: 'Reprendre',
      stopToast: 'Fin de la phase en cours, puis assemblage et enregistrement de tout ce qui peut être conservé.',
      preparingStatus: 'Préparation du décodage exact',
      preparingMessage: 'Lecture du conteneur, vérification du codec et du stockage local.',
      compatibilityNeedsNative: 'Le mode « Approximatif · lecteur natif » nécessite que le lecteur du navigateur puisse lire cette vidéo.',
      webcodecsHttpBlocked:
        'Ce navigateur n’active pas WebCodecs à cette adresse HTTP. Pour poursuivre le test local, choisissez « Approximatif · lecteur natif ». Le décodage exact nécessite localhost ou HTTPS. La vidéo n’est pas envoyée.',
      webcodecsMissing:
        'WebCodecs est indisponible dans ce navigateur. Mettez Safari / iOS à jour ou choisissez « Approximatif · lecteur natif » ; certaines images peuvent manquer.',
      startFailedStatus: 'Impossible de lancer la reconstitution',
      restoredMessage: 'Voici votre dernier résultat. Après 24 heures, il sera supprimé à la prochaine ouverture de la page.',
      interruptedStatus: 'Le traitement précédent n’a pas abouti',
      interruptedMessage:
        'Voici ce qui a été enregistré avant l’interruption. Pour obtenir le résultat complet, remettez la vidéo et relancez le traitement.',
      waitingCanvasOption: 'En attente de l’image reconstituée',
    },
    source: {
      busyToast: 'Terminez ou enregistrez d’abord le traitement en cours.',
      subtitleReading: '{{size}} · aucun envoi · lecture du conteneur et de la première image',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · lecture possible uniquement avec le lecteur natif',
      subtitleUnavailable: '{{size}} · décodage exact et aperçu natif indisponibles',
      probeFailedMessage: 'La vérification du décodage exact a échoué : {{error}}',
      probeFailedAction:
        'Long Screen va essayer de lire les métadonnées avec le lecteur du navigateur. Pour poursuivre, choisissez le décodage « Approximatif · lecteur natif ».',
      rejectedVideo:
        '« {{name}} » est {{kind}}, un format que le navigateur ne peut pas lire image par image. Il n’a pas été ouvert. Réglez votre enregistreur d’écran sur MP4 ou convertissez d’abord le fichier en MP4 avec HandBrake ou ffmpeg.',
      rejectedOther:
        '« {{name}} » n’est pas une vidéo ({{kind}}) et n’a pas été ouvert. Choisissez un enregistrement d’écran au format MP4, MOV, WebM ou MKV. Sous Windows, utilisez l’Outil Capture d’écran ou Xbox Game Bar (Win+Alt+R) ; sur Mac, appuyez sur ⌘⇧5 ; sur téléphone, utilisez l’enregistreur d’écran intégré.',
      unreadableToast:
        'Cette vidéo est illisible ({{reason}}). Vérifiez que l’enregistrement s’est bien terminé et que le fichier a été entièrement copié ou téléchargé. Si le problème persiste, essayez un MP4 en H.264. Les diagnostics expliquent l’échec du décodage exact.',
      kind: {
        empty: 'un fichier vide',
        heif: 'une image HEIC/AVIF',
        avi: 'une vidéo AVI',
        webp: 'une image WebP',
        wav: 'un fichier audio WAV',
        riff: 'un fichier RIFF',
        wmv: 'une vidéo WMV/ASF',
        flv: 'une vidéo FLV',
        mpegps: 'une vidéo MPEG-PS',
        ogg: 'un fichier multimédia Ogg',
        gif: 'une animation GIF',
        png: 'une image PNG',
        jpeg: 'une image JPEG',
        pdf: 'un document PDF',
        zip: 'une archive ZIP ou un document Office',
        mp3: 'un fichier audio MP3',
        text: 'un fichier texte',
        mpegts: 'une vidéo MPEG-TS',
        unknown: 'un fichier non reconnu',
      },
    },
    demo: {
      fileName: 'enregistrement-exemple.mp4',
      loadFailed: 'Impossible de charger la vidéo d’exemple : {{error}}',
    },
    feedback: {
      issueBody:
        '**Que s’est-il passé ?**\n\n\n**Quel résultat attendiez-vous ?**\n\n\n**À propos de l’enregistrement** (page enregistrée, déplacements, durée approximative ; une capture est utile, mais masquez les informations privées)\n\n\n---\nRenseigné par Long Screen, à modifier ou supprimer librement :\n- Navigateur : {{browser}}\n- Ouvert depuis : {{page}}\n- Moteur multithread (isolation entre origines) : {{threads}}\n- Avertissements du journal : {{warnings}}\n',
      portable: 'version portable (fichier local)',
      yes: 'oui',
      no: 'non',
      none: 'aucun',
    },
    viewer: {
      previewLevel: 'Aperçu L{{level}} (taille d’origine inchangée)',
      nativeLevel: 'Pixels d’origine L0',
      qualityHint: ' · agrandissez pour voir le masque de qualité',
      unobservedHint: ' · bleu = aucune observation',
      provisionalHint: ' · violet = contenu temporaire / superposé',
    },
  },
  names: {
    fixed: 'Interface fixe',
    divider: 'Séparateur fixe',
    contentCanvas: 'Image de contenu {{n}}',
    unassigned: 'Zone non attribuée · observations aux coordonnées de l’écran',
    contentRegion: 'Zone de contenu {{n}}',
    ignored: 'Ignoré',
    fragment: 'fragment non positionné {{n}}',
    framed: 'avec cadre',
  },
};
