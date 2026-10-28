import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'La reconstitution utilise des couches de contenu mobiles et des contraintes géométriques lors des retours sur une zone déjà vue. Les masques automatiques et la détection des zones dynamiques reposent sur des heuristiques ; les scores de confiance ne sont pas des probabilités mesurées d’exactitude. Les comparaisons de cohérence utilisent le bruit de décodage déclaré pour cette source, soit ±{{noise}} niveaux{{margin}}.',
      marginLossy: ' (tolérance aux artefacts de compression et à la reconstruction des couleurs)',
      marginLossless: ' (source sans perte, comparaison exacte pixel par pixel)',
      action:
        'Si des échelles ou des structures sont incompatibles, un fragment indépendant est conservé au lieu de forcer leur assemblage.',
    },
    APPROXIMATE_DECODER: {
      message:
        'Le mode « Approximatif · lecteur natif » à {{fps}} Hz a été activé explicitement. Il ne garantit pas de capturer toutes les images de la vidéo ; des contenus très brefs peuvent manquer.',
      action: 'Pour garantir une lecture image par image, utilisez une source compatible WebCodecs, par exemple en H.264 ou VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'L’analyse du mouvement limite le grand côté à {{size}} px. L’ajustement et l’assemblage final utilisent les pixels à leur résolution d’origine : le résultat n’est pas réduit.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Une image à sa taille d’origine et ses images de référence approchent de la limite du cache choisie. Cette limite JavaScript ne contrôle pas la mémoire du codec ni du GPU.',
      action:
        'La résolution du résultat n’est jamais réduite sans le signaler. En cas de manque de mémoire, les données déjà enregistrées sont conservées et l’échec est signalé.',
    },
    RUN_FAILURE: {
      action:
        'Les tuiles déjà enregistrées localement restent consultables et exportables. L’échec n’a pas été présenté comme une réussite.',
    },
    PERSISTENCE_ERROR: {
      action: 'L’écriture dans le stockage a également échoué. Seules les données enregistrées auparavant peuvent être récupérées.',
    },
    MEMORY_BUDGET_RAISED: {
      message:
        'Le cache est passé de {{from}} tuiles, selon la limite choisie, à {{to}} tuiles (environ {{mb}} Mo), pour contenir toutes les tuiles touchées par une seule image.',
      action:
        'Un cache plus petit que la surface couverte par une image obligerait à décoder et réencoder toutes ses tuiles à chaque fois. Réduisez la résolution de l’enregistrement pour utiliser moins de mémoire.',
    },
    NONFINITE_POSE: {
      message:
        'Le calcul de position a produit une valeur non finie. Cette observation a été isolée et les coordonnées invalides n’ont pas été appliquées à l’image.',
    },
    MISSING_PLAN: {
      message: 'Le plan plan/{{index}} manque à l’étape de rendu. Le traitement s’est arrêté à la dernière partie déjà enregistrée.',
      action: 'Vérifiez l’intégrité du stockage local. Un plan manquant n’est jamais assimilé silencieusement à une observation vide.',
    },
    prefixOnly: {
      base: {
        scan: 'Poursuite du positionnement et de l’assemblage avec les seules images déjà décodées ({{frames}})',
        solve: 'Poursuite du rendu avec les seules images déjà positionnées ({{frames}})',
        render: 'Conservation du résultat pour les seules images déjà rendues ({{frames}})',
      },
      suffixPersistence: ' ; l’écriture dans le stockage s’est arrêtée.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action: 'La vue encadrée a été ignorée pour cette image. La reconstitution dans les coordonnées de la page reste intacte.',
    },
    PRESENTATION_FRAME: {
      message:
        'La vue encadrée et le contenu 2D d’origine sont conservés séparément. Le cadre provient d’une image de référence. Seul le fond décoratif est prolongé, sans être considéré comme du contenu observé ; les icônes ne sont jamais étirées ni dupliquées. Les autres panneaux du cadre sont de simples vues de référence.',
    },
    PRESENTATION_STAGE_FAILED: {
      action:
        'La création de la vue encadrée a échoué. Le résultat et l’état de la reconstitution dans les coordonnées de la page restent inchangés.',
    },
    PYRAMID_FAILED: {
      action:
        'La création des niveaux d’aperçu a échoué. Les tuiles à leur taille d’origine restent intactes, consultables et exportables.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: 'L’étape {{pass}} n’a terminé que {{actual}} images sur {{expected}}. Le résultat a été signalé comme partiel.',
      action:
        'La partie déjà enregistrée a été conservée. Les images manquantes ne sont jamais considérées comme traitées sans le signaler.',
    },
    FRAME_CONVERSION: {
      message: 'Méthode de conversion des images décodées en pixels : {{method}}.',
    },
    HDR_UNCHECKED: {
      message:
        'Cet enregistrement est en HDR ({{transfer}}), mais ce navigateur ne permet pas de vérifier la conversion des couleurs. La capture peut paraître trop sombre ou délavée.',
      action: 'Relancez le traitement dans une version récente de Chrome ou Safari.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'Dans la première image HDR, {{percent}} % des pixels sont plus lumineux que le blanc ordinaire et ont été ramenés au blanc. Si le résultat paraît surexposé, l’enregistreur a probablement placé le blanc ordinaire à une luminosité trop élevée.',
      action: 'Réglez le blanc SDR de l’enregistreur sur 100 nits ou désactivez l’enregistrement HDR.',
    },
    SLOW_CONVERSION: {
      message:
        'Ce navigateur met environ {{ms}} ms à convertir chaque image de cette vidéo en pixels. La conversion seule prendra donc environ {{minutes}} min.',
      action: 'Une version récente de Chrome ou Safari est bien plus rapide. Convertir d’abord la vidéo en H.264 peut aussi aider.',
    },
    REVEAL_SKIPPED: {
      message:
        'Le résultat contient trop d’images indépendantes, ou des images trop grandes. Retirer les éléments superposés (curseur, boutons flottants, barres de défilement) nécessiterait environ {{need}} Mo de plus que la mémoire disponible. Cette étape a été ignorée et les pixels assemblés ont été conservés.',
      action:
        'Le reste du résultat est intact. Un grand nombre d’images indépendantes indique souvent que certaines parties n’ont pas pu être raccordées aux précédentes. Essayez une vidéo plus courte ou un ordinateur disposant de plus de mémoire.',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}. Moteur Rust : version {{variant}}, threads de calcul : {{threads}} ({{coreReason}}).',
    },
    PRESENTATION_REFERENCE_FAILED: {
      action: 'La vue encadrée ne sera pas créée. La reconstitution dans les coordonnées de la page reste intacte.',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'L’image manque de détails reconnaissables. Deux images vides identiques peuvent correspondre à une pause ou à un déplacement sur une zone vide ; les pixels seuls ne permettent pas de trancher.',
      action:
        'Incluez des repères visibles ou davantage de chevauchement dans l’enregistrement. L’absence de déplacement n’est ici qu’une estimation.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Cette observation ne fournit pas de repère visuel fiable pour l’alignement. Le positionnement tentera de la raccorder à des images antérieures. Si cela échoue, elle restera un fragment indépendant.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'Un motif répété admet plusieurs correspondances aussi plausibles. La continuité du mouvement aide à estimer la position, mais ne prouve pas qu’elle soit unique.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message:
        'Cette image couvre une durée anormalement longue. Un mouvement rapide peut avoir traversé des zones qui n’ont jamais été capturées.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'Les parties hors des zones tracées manuellement sont conservées dans une couche d’observation indépendante, peu fiable, aux coordonnées de l’écran. Leur position dans la page n’est pas considérée comme retrouvée.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Une zone marquée « ignorer » a été exclue selon votre réglage. Elle ne contribue pas à la reconstitution ; il ne s’agit pas d’images supprimées automatiquement.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Lorsque des zones manuelles se chevauchent, la dernière tracée est prioritaire. Les zones ignorées sont toujours exclues. Les pixels restants sont conservés dans la couche d’observation non attribuée.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Détection automatique — zones de contenu : {{moving}} ; zones d’interface fixe : {{fixed}}. Les limites sont déduites du mouvement des pixels, pas du DOM.',
      action:
        'Si une zone est mal attribuée, tracez précisément la zone défilante dans « Zones de mouvement », puis relancez le traitement.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: 'Chaque zone de défilement indépendante aura sa propre image. Un même déplacement ne leur est pas imposé.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Après alignement, la zone de chevauchement contient au total {{conflicts}} pixels nettement différents. Cette zone est l’une des composantes du conflit. Causes possibles : animation, mise à jour du contenu, réorganisation de la page ou imprécision de l’alignement.',
      actionStable:
        'Dans la mesure du possible, toute la zone en conflit a été figée à un même instant. Consultez les diagnostics orange et le moment correspondant dans la vidéo.',
      actionRolling:
        'La zone en conflit n’est mise à jour à partir d’une même image que lorsqu’elle est entièrement visible. La page complète ne représente donc pas un instant unique.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Cette zone modifiée n’a jamais été entièrement visible dans une vue exploitable. Il n’est pas garanti que tous ses pixels proviennent du même instant.',
      action: 'Le contenu observé et le signalement du conflit sont conservés. Les parties non observées n’ont pas été inventées.',
    },
    MISSING_SCAN_RECORD: {
      message:
        'L’observation scan/{{index}} manque à l’étape de positionnement. Le traitement s’est arrêté à la dernière partie déjà enregistrée.',
      action: 'Vérifiez l’intégrité du stockage local. Une observation manquante n’est jamais assimilée à un déplacement nul.',
    },
    GRAPH_RESIDUAL: {
      message:
        'L’écart résiduel maximal du graphe de positions reste de {{residual}} pixels d’origine. Des incohérences géométriques peuvent apparaître aux raccords proches.',
      action: 'Vérifiez les textes et les motifs répétés près de la zone revisitée. Cet écart n’a pas été masqué.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Environ {{percent}} % des blocs de texture ne suivent pas le déplacement global (animation, vidéo, chargement différé ou réorganisation de la page). Le déplacement est calculé à partir des blocs cohérents ; les zones en conflit sont traitées séparément à l’assemblage.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'Le déplacement entre les images est rapide et laisse peu de chevauchement pour l’alignement. L’estimation repose sur cette petite zone. Dans une mise en page répétitive, le motif voisin pourrait tout aussi bien expliquer ces pixels.',
      action:
        'Si un retour ultérieur fournit de meilleurs repères, tout ce segment de trajectoire sera corrigé et la correction sera consignée.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'Un motif répété permet plusieurs déplacements plausibles. Celui qui suit le mieux la continuité du mouvement a été retenu. C’est une estimation, pas un alignement dont l’unicité serait prouvée.',
      messageLowConfidence:
        'Le positionnement de cette zone repose sur une estimation peu fiable. Les pixels concernés sont signalés dans le masque de qualité.',
      messageStatic:
        'Les deux images sont presque identiques, mais aucun repère ne permet de confirmer leur correspondance. Elles sont considérées comme une pause, avec déplacement nul. Cela reste une estimation.',
      action:
        'La continuité de la trajectoire et les repères disponibles ont servi à estimer la position. Il n’est pas établi que cet alignement soit le seul correct.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'Cette zone ne contient aucun détail reconnaissable. Une image vide peut correspondre à une pause ou à un déplacement sur une zone vide ; les pixels seuls ne permettent pas de trancher. Elle n’a été placée nulle part.',
      action:
        'Si le contenu qui suit la zone vide ne recoupe aucune observation précédente, il reste un fragment indépendant. La distance intermédiaire n’est pas devinée.',
    },
    RELOCALIZED: {
      message:
        'Un repère visuel antérieur a permis de retrouver la position sur une image déjà observée. Le contenu revisité n’a pas été ajouté comme une nouvelle extension de la capture.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Un changement d’échelle ou de mise en page d’environ {{scale}}× a été détecté. Il est conservé en fragment indépendant, avec ses pixels d’origine, sans redimensionnement masqué dans l’assemblage.',
      action:
        'La relation entre les fragments n’est pas encore confirmée. Un retour ultérieur fiable permettra de rattacher le fragment entier. Réenregistrez avec plus de chevauchement ou isolez le composant qui change dans une zone manuelle.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'La position par rapport à l’image d’origine n’a pas pu être confirmée. Le contenu reste un fragment indépendant, exportable séparément. Les fragments peuvent se chevaucher ou être réellement séparés par un espace.',
      action:
        'La relation entre les fragments n’est pas encore confirmée. Un retour ultérieur fiable permettra de rattacher le fragment entier. Réenregistrez avec plus de chevauchement ou isolez le composant qui change dans une zone manuelle.',
    },
    STICKY_OCCLUSION: {
      message:
        'Les détails en haut de l’image indiquent une interface fixe à l’écran, et non un mouvement de la page. Cette zone masquante n’est pas ajoutée au contenu mobile. L’interface de référence reste dans la vue encadrée.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'Un retour sur une zone déjà vue a permis de rattacher un fragment entier à une image existante. La trajectoire relative à l’intérieur du fragment reste inchangée.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'L’étape précédente ne disposait que d’un faible chevauchement. L’alignement de cette image sur un contenu déjà observé diffère de {{discrepancy}} px et repose sur de meilleurs repères. La position actuelle a été corrigée.',
      action:
        'La correction concerne cette image et la suite de la trajectoire. Les pixels déjà écrits restent inchangés et peuvent présenter un raccord visible avec les coordonnées corrigées.',
    },
    LOOP_CLOSURE: {
      message:
        'Un retour fiable sur une zone déjà vue a été trouvé et ajouté aux contraintes de position globales. L’assemblage final utilisera la trajectoire corrigée.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'La correspondance avec une image antérieure diffère de la trajectoire continue de {{discrepancy}} px. Les indices étant contradictoires, elle n’a pas été imposée comme contrainte de retour.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'La recherche parmi les images antérieures a trouvé plusieurs positions presque aussi plausibles. Ce retour incertain n’a pas été imposé comme contrainte stricte.',
    },
  },
  progress: {
    runPartial: 'Une reconstitution explicitement signalée comme partielle a été enregistrée.',
    runComplete: 'Reconstitution terminée. Vérifiez les diagnostics et les zones non observées.',
    render: 'Assemblage des tuiles à leur taille d’origine à partir du contenu observé. Les zones manquantes restent transparentes.',
    reveal: {
      learn: 'Nouvelle lecture de la vidéo pour repérer les boutons, barres de saisie et barres de défilement qui masquent la page.',
      agree: 'Comparaison de chaque zone au fil du temps pour retenir une vue sans obstacle.',
      relearn: 'Nouvelle détection des éléments flottants à partir de la page vérifiée.',
      write: 'Remplacement des zones masquées ou incohérentes par une image dégagée.',
    },
    framingStart: 'Conservation du cadre d’origine. Seul le fond est prolongé, sans étirer les textes ni dupliquer les icônes.',
    pyramidBuild: 'Création des niveaux d’aperçu sur disque. Les tuiles à leur taille d’origine restent inchangées.',
    scanFrame: 'Extraction des repères géométriques image par image et détection des mouvements indépendants.',
    duplicateReuse: 'Une observation identique reprend le positionnement précédent. L’image source et son horodatage sont conservés.',
    solveFrame: 'Ajustement au pixel près, recherche de positions antérieures et contraintes de retour en 2D.',
    optimizing: 'Optimisation du graphe de positions sur disque et correction de la dérive lors des retours.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC : ce navigateur ne peut pas décoder le codec de cet enregistrement ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'Les iPhone et Mac enregistrent souvent en HEVC, pris en charge par certains navigateurs seulement. Utilisez Safari, ou Chrome ou Edge avec décodage matériel.',
      prores: 'Aucun navigateur ne décode ProRes. Exportez d’abord la vidéo en H.264 ou HEVC.',
      h264: 'Seul Chrome décode cette variante de H.264 (4:4:4 ou 10 bits). Utilisez Chrome ou exportez en H.264 standard.',
      av1: 'AV1 nécessite un navigateur ou du matériel récent. Utilisez Chrome à jour ou exportez la vidéo en H.264.',
      other: 'Utilisez Chrome ou Safari à jour, ou convertissez d’abord la vidéo en H.264.',
    },
    PIXEL_ASPECT_RATIO:
      'L’enregistrement déclare des pixels au format {{num}}:{{den}}. Les pixels stockés restent sans redimensionnement ; les proportions affichées peuvent donc différer.',
    CONTAINER_SIZE_MISMATCH:
      'Le conteneur indique {{codedWidth}}×{{codedHeight}}, mais le flux vidéo mesure réellement {{bitstreamWidth}}×{{bitstreamHeight}}. Les dimensions du flux font référence.',
    NON_SQUARE_PIXELS:
      'Cet enregistrement déclare des pixels non carrés (affichage {{displayWidth}}×{{displayHeight}}, stockage {{bitstreamWidth}}×{{bitstreamHeight}}). Les pixels stockés d’origine sont conservés sans redimensionnement.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'Le décodeur a produit une image antérieure au début défini par la liste de montage, avec un horodatage négatif. Conformément aux règles du conteneur, ces images ne sont pas affichées.',
    NONMONOTONIC_TIMESTAMP:
      'Un horodatage du conteneur revient en arrière. Le traitement continue dans l’ordre de présentation du décodeur ; aucune observation n’a été supprimée.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0 : la boîte ctts de cette piste vidéo est en version 0, mais contient des décalages temporels de composition négatifs. ISO 14496-12 ne les définit qu’en version 1. Ils sont interprétés comme des valeurs signées, selon une convention courante de QuickTime/ReplayKit, et non comme de très grandes valeurs positives.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING : le fichier s’arrête à l’intérieur de sa boîte {{box}}. Celle-ci devrait se terminer à l’octet {{declaredEnd}}, mais le fichier ne contient que {{size}} octets. L’enregistrement s’est peut-être mal terminé, ou la copie ou le transfert a été interrompu. Les images après la coupure ne peuvent pas être décodées. L’analyse trouvera donc moins d’images que n’en indiquent les métadonnées et le résultat sera signalé comme partiel.',
  },
  exports: {
    tilesProgress: 'Export des tuiles d’origine et d’aperçu {{n}}',
    zipFinalize: 'Écriture du répertoire ZIP64 et enregistrement du fichier',
    projectDone: {
      message:
        'Export terminé : tuiles à leur taille d’origine, visionneuse hors ligne, données de couverture et de qualité, traces des images sources et diagnostics complets.',
    },
    encodingSingle: 'Encodage de la ligne {{row}} / {{total}} à la taille d’origine',
    canvasDone: {
      message: 'PNG de {{width}} × {{height}} exporté. Les zones manquantes restent transparentes.',
    },
    encodingSheet: 'Images partielles encodées à leur taille d’origine : {{count}}',
    sheetsDone: {
      messagePaged:
        'Export en images partielles à leur taille d’origine : {{count}}. Les images voisines se chevauchent sur {{overlap}} px au maximum ; leurs coordonnées figurent dans le manifeste.',
      messageOversize:
        'L’image dépasse les dimensions compatibles avec un fichier unique. Elle a donc été exportée en {{count}} images partielles à leur taille d’origine. Les images voisines se chevauchent sur {{overlap}} px au maximum ; leurs coordonnées figurent dans le manifeste.',
    },
  },
  offline: {
    title: 'Image hors ligne',
    fit: 'Adapter',
    tip: 'Tuiles locales à leur taille d’origine · faites glisser / utilisez la molette pour zoomer',
    previewLevel: 'Niveau d’aperçu {{level}}. Agrandissez pour voir les pixels d’origine',
    nativeTiles: 'Affichage des tuiles à leur taille d’origine',
    footer:
      'Le damier indique une zone non observée ou sans tuile. La confiance n’est pas une probabilité d’exactitude. Consultez diagnostics.jsonl et observations.jsonl.',
  },
};
