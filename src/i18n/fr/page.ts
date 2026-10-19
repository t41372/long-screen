import type { Catalog } from '../catalog.ts';
import type { pageSections as zh } from '../zh/page.ts';

export const pageSections: Catalog<typeof zh> = {
  language: {
    label: 'Langue de l’interface',
    saveFailed: 'Impossible d’enregistrer la langue choisie : ce navigateur bloque le stockage local.',
  },
  page: {
    title: 'Long Screen — Une capture complète à partir d’un enregistrement d’écran',
    description:
      'Transformez un enregistrement d’écran en une seule grande capture à sa taille d’origine. Faites défiler, déplacez-vous en diagonale, marquez une pause ou revenez en arrière. Le cadre de la fenêtre et les barres d’état sont conservés. Tout se passe dans votre navigateur, sans aucun envoi de fichier.',
    closeLabel: 'Fermer',
    header: {
      brandLabel: 'Accueil de Long Screen',
      slogan: 'TOUS LES PARCOURS · UNE SEULE CAPTURE',
      privacy: 'Vos images restent sur cet appareil',
      helpLabel: 'Aide et fonctionnalités',
      star: 'Mettre une étoile sur GitHub',
      starLabel: 'Mettre une étoile sur GitHub (nouvel onglet)',
      install: 'Installer l’app',
      installTitle: 'Installer Long Screen sur cet appareil : une application web qui fonctionne aussi hors connexion',
    },
    install: {
      title: 'Installer sur cet appareil',
      intro:
        'Long Screen s’installe comme une application web (PWA). Ouvrez-la depuis l’écran d’accueil ou le Dock, dans sa propre fenêtre, même hors connexion. Les enregistrements restent traités uniquement sur cet appareil.',
      iosShare: 'Touchez le bouton de partage du navigateur. Dans Safari, il se trouve dans la barre d’outils en bas ou dans le menu ⋯.',
      iosAdd: 'Faites défiler le menu jusqu’à Sur l’écran d’accueil.',
      iosConfirm: 'Touchez Ajouter.',
      iosInApp: 'Si la page s’est ouverte dans une autre app, comme WeChat ou LINE, ouvrez-la d’abord dans Safari.',
      macFile: 'Dans la barre des menus en haut de l’écran, choisissez Fichier → Ajouter au Dock.',
      macConfirm: 'Cliquez sur Ajouter.',
      offline: 'Après l’installation, ouvrez l’app une fois avec une connexion Internet. Elle fonctionnera ensuite hors connexion.',
    },
    hero: {
      heading: 'Un enregistrement d’écran.<br><span class="hl">Une capture complète</span>.',
      intro:
        'Enregistrez votre écran en parcourant une page web, une app ou une maquette : faites défiler, déplacez-vous dans toutes les directions, revenez en arrière. Long Screen rassemble ce qui apparaît dans la vidéo en un seul PNG à sa taille d’origine, avec le cadre de la fenêtre et les barres d’état. Tout se passe dans votre navigateur, sans aucun envoi de fichier.',
      demoLead: ' Envie de voir le résultat ?',
      demoChip: 'Essayer un exemple',
    },
    steps: {
      ariaLabel: 'Comment ça marche',
      recordTitle: 'Enregistrez',
      recordBody: 'Filmez votre écran en parcourant une page ou une app, dans la direction de votre choix.',
      feedTitle: 'Déposez',
      feedBody: 'Déposez la vidéo sur l’écran de l’imprimante, puis cliquez sur Lancer.',
      takeTitle: 'Récupérez',
      takeBody: 'Une seule capture à sa taille d’origine. Les zones non filmées restent vides.',
    },
    press: {
      ariaLabel: 'L’imprimante',
      core: 'Version du moteur',
      build: 'Commit utilisé pour construire cette page',
    },
    screen: {
      dropTitle: 'Déposez un enregistrement ici',
      dropHint: 'ou cliquez pour choisir un fichier · MP4 · MOV · WebM',
    },
    observe: {
      dropTitle: 'Aucun enregistrement',
      dropSubtitle: 'MP4 · MOV · WebM · reste sur cet appareil',
    },
    controls: {
      print: 'Lancer',
      progress: 'Progression',
      knobs: 'Réglages',
      clear: 'Effacer',
      clearTitle: 'Retirer l’enregistrement et effacer le résultat ainsi que son journal',
    },
    tray: {
      ariaLabel: 'Aperçu de la capture complète',
      idleTitle: 'Votre capture complète apparaîtra ici',
      story1: 'La vidéo parcourt la page dans tous les sens…',
      story2: 'Chaque zone filmée retrouve sa place',
      story3: 'Et voilà une seule grande capture !',
      story4: 'Sur téléphone, filmez en faisant défiler…',
      story5: 'Les écrans s’assemblent, la barre d’état reste unique',
      story6: 'Les captures tout en longueur, ça marche aussi !',
    },
    reconstruct: {
      heading: 'Réglages du traitement',
      sub: 'Les réglages par défaut conviennent. Ajustez-les si nécessaire.',
      policyLabel: 'Conflits',
      policyStable: 'Garder une vue stable',
      policyLatest: 'Préférer la vue récente',
      framingLabel: 'Cadre',
      framingContext: 'Garder le cadre et l’interface',
      framingRegion: 'Contenu et marges seulement',
      regionsLabel: 'Zones de mouvement',
      regionsAuto: 'Détection automatique ↗',
      advancedSummary: 'Réglages avancés <span>＋</span>',
      analysisSizeLabel: 'Grand côté des images d’analyse',
      memoryLabel: 'Limite du cache des tuiles',
      computeLabel: 'Accélération',
      computeAuto: 'Auto · WebGPU / CPU',
      computeWebgpu: 'WebGPU · alignement CPU',
      computeCpu: 'CPU uniquement',
      computeHint:
        'Le GPU convertit les images décodées en pixels et réduit les vignettes d’analyse. L’alignement et l’assemblage restent sur le CPU. Le mode Auto mesure d’abord les deux méthodes et n’utilise le GPU que s’il est plus rapide.',
      decoderLabel: 'Décodage',
      decoderPrecise: 'Exact · WebCodecs',
      decoderCompatibility: 'Approximatif · lecteur natif',
      decoderHint:
        'Les vignettes d’analyse ne changent pas les pixels du résultat. Le cache ne contient que les tuiles terminées et s’agrandit automatiquement lorsqu’une image dépasse sa capacité ; son effet sur la vitesse est donc limité. La mémoire du navigateur, du décodeur, du GPU et du moteur n’y est pas comptée. Le mode « Approximatif · lecteur natif » peut manquer des contenus très brefs.',
      pauseBtn: 'Pause',
      stopBtn: 'Arrêter et enregistrer',
      footerNote: 'Aucun envoi · aucun calcul dans le cloud · aucun modèle externe',
    },
    canvas: {
      ariaLabel: 'Image reconstituée',
      selectAriaLabel: 'Choisir l’image reconstituée',
      waitingOption: 'En attente d’images',
      qualityMask: 'Masque de qualité',
      fitTitle: 'Adapter à la fenêtre',
      fitBtn: 'Adapter',
      nativeTitle: 'Taille d’origine',
      viewerAriaLabel: 'Image 2D avec zones vides, déplaçable et zoomable',
      zoomOutLabel: 'Réduire',
      zoomInLabel: 'Agrandir',
      expandLabel: 'Agrandir l’aperçu',
      emptyTitle: 'Assemblage…',
      emptyBody: 'Chaque image de la vidéo trouve sa place dans la capture.',
      statusReady: 'Prêt',
      progressMessageDefault: 'Déposez une vidéo → cliquez sur Lancer → récupérez la capture',
      lodLabel: 'Damier = zone non filmée',
    },
    understand: {
      noteBtn: 'Journal',
      heading: 'Journal du traitement',
      desc: 'Le placement des images, les changements sur la page et les problèmes rencontrés : tout est consigné ici.',
      framesLabel: 'Total d’images assemblées',
      canvasesLabel: 'Total d’images indépendantes',
      coverageBody:
        'Transparent ≠ page blanche <br><small>Ces zones n’ont jamais été observées. Rien n’est inventé pour les remplir.</small>',
      diagnosticsHeading: 'Diagnostics',
      filterAriaLabel: 'Filtrer les diagnostics',
      filterAll: 'Tous',
      filterIssues: 'Avertissements / erreurs',
      diagnosticsAriaLabel: 'Diagnostics du traitement',
      diagnosticsEmpty: 'Repères d’alignement, changements sur la page, <br>estimations et erreurs de traitement apparaîtront ici.',
      moreDiagnostics: 'Afficher plus de diagnostics',
      reportLead: 'Un résultat incorrect ou un problème ?',
      reportBtn: 'Le signaler sur GitHub',
      reportNote:
        'Le signalement contient déjà les informations sur votre navigateur et les codes d’avertissement de ce journal. Il ne contient jamais la vidéo, ses images ni le nom du fichier. Vous pouvez le relire et le modifier avant de l’envoyer.',
    },
    export: {
      downloadPng: 'Télécharger la capture · PNG <span>↓</span>',
      copyPng: 'Copier la capture',
      pngNote: 'Un seul PNG à sa taille d’origine, sans réduction ni découpage.',
      advancedSummary: 'Autres formats d’export',
      exportProject: 'Exporter le projet complet · ZIP',
      projectNote:
        'Tuiles à leur taille d’origine, visionneuse hors ligne, données de couverture et de qualité, diagnostics complets : pour archiver ou analyser un problème.',
      exportSheets: 'Exporter en plusieurs PNG · ZIP',
      sheetsNote:
        'Découpe une image trop grande en plusieurs PNG de taille compatible, sans réduire leur résolution. Les images se chevauchent sur 32 px et leurs coordonnées dans l’image complète sont indiquées dans un manifeste.',
      starNudge: 'Utile ? Ajoutez une étoile sur GitHub',
    },
    help: {
      title: 'Une capture dont on connaît l’origine',
      pixelsHeading: 'Quels pixels sont conservés ?',
      pixelsBody:
        'Le mode exact décode la vidéo image par image. Chaque observation terminée est associée à un horodatage et à une trace de son assemblage. L’analyse peut utiliser des images réduites ; l’assemblage final et l’export conservent les pixels à leur taille d’origine.',
      frameHeading: 'Le cadre et les marges d’origine',
      frameBody:
        'Par défaut, le fond, les marges et les espaces vides de toute la zone défilante sont conservés, sans recadrage autour du texte. La vue encadrée conserve aussi une image de référence de l’interface : les textes des panneaux latéraux et les icônes des barres d’outils apparaissent une seule fois, à leur taille d’origine. Seul le fond décoratif est prolongé ; il ne constitue pas du contenu observé. Le contenu reconstitué reste toujours disponible séparément. Les autres panneaux indépendants ne sont jamais présentés comme s’ils partageaient le même déplacement.',
      scopeHeading: 'L’image ne permet pas de tout comprendre',
      scopeBody:
        'La séparation des mouvements, le choix entre motifs répétés et l’identification des zones dynamiques reposent sur des déductions visuelles. Les changements d’échelle, les vues sans chevauchement ou les mises en page incompatibles peuvent donner des fragments indépendants, dont l’alignement n’est pas confirmé. Le niveau de confiance n’est pas une probabilité mesurée que le résultat soit correct.',
      storageHeading: 'Enregistrements longs et stockage',
      storageBody:
        'Le traitement décode la vidéo en trois passes pour limiter la mémoire utilisée, au prix de temps de calcul et d’espace disque. Le navigateur ne conserve que le dernier résultat, pendant 24 heures au maximum. Il réapparaît après un rechargement ou une fermeture accidentelle ; si le traitement a été interrompu, seules les parties déjà enregistrées reviennent, sans possibilité de reprendre le calcul. Relancer le traitement ou cliquer sur Effacer le supprime. Au-delà de 24 heures, il est supprimé à la prochaine ouverture de la page. Téléchargez ce que vous souhaitez garder.',
      privacyHeading: 'Mon enregistrement quitte-t-il cet appareil ?',
      privacyBody:
        'Non. Le décodage, l’analyse et l’assemblage ont lieu dans votre navigateur. La vidéo et la capture restent sur cet appareil ; une fois la page chargée, vous pouvez poursuivre hors connexion. Le site hébergé (long-screen.yi-ting.com) utilise deux mesures anonymes. Cloudflare Web Analytics mesure les visites et ne reçoit que la page consultée, la provenance de la visite, le type de navigateur et d’appareil, le pays et la vitesse de chargement. PostHog mesure l’utilisation de l’imprimante : un événement à l’ouverture de la page, un au lancement du traitement et un à sa fin. Ils contiennent uniquement les réglages, la version du moteur, le codec, la hauteur et la durée en minutes de la vidéo, un nombre approximatif d’images, le nombre d’images produites, le temps de traitement et les codes de diagnostic. Chaque événement contient aussi l’adresse de la page, la provenance de la visite, le navigateur et le système d’exploitation, la taille de l’écran, la langue, le fuseau horaire et le pays. Aucun des deux services n’utilise de cookies et PostHog ne stocke rien dans votre navigateur. Aucun ne reçoit la vidéo, la capture, les noms de fichiers ni les messages d’erreur. Si Do Not Track ou Global Privacy Control est activé, PostHog ne se charge pas. Les versions hébergées par vos soins et la version hors ligne en un seul fichier ne mesurent rien. La politique de sécurité du contenu limite les connexions de la page à son propre site et à ces deux services ; le navigateur bloque les autres.',
      browserHeading: 'Navigateurs et formats',
      browserBody:
        'IndexedDB, OffscreenCanvas et CompressionStream sont nécessaires. En développement local, HTTP sur localhost fonctionne sans certificat. Sur téléphone, une adresse HTTP du réseau local permet de tester le mode « Approximatif · lecteur natif », qui peut manquer des images. En général, le décodage exact WebCodecs et les API d’export sur disque ne sont disponibles que sur localhost ou en HTTPS ; cela n’implique aucun envoi de fichier. Le décodage exact dépend aussi des codecs pris en charge par l’appareil. Un fichier MP4, MOV ou WebM peut contenir un codec que l’appareil ne sait pas décoder.',
      tipsHeading: 'Comment améliorer le résultat ?',
      tipsBody:
        'Gardez un chevauchement suffisant entre les images et déplacez-vous plus lentement dans les zones peu détaillées. Si des panneaux ou des éléments flottants sont mal identifiés, délimitez-les dans « Zones de mouvement » avant de lancer le traitement. Le projet complet permet d’exporter tous les diagnostics.',
      feedbackHeading: 'Retours et code source',
      feedbackBody:
        'Long Screen est un logiciel libre sous licence MIT. Son code est sur <a href="https://github.com/t41372/long-screen" target="_blank" rel="noopener">GitHub</a>. En cas de bug ou de résultat incorrect, <a class="report-link" href="https://github.com/t41372/long-screen/issues/new" target="_blank" rel="noopener">ouvrez un ticket</a> : les informations sur votre navigateur et les codes d’avertissement du journal y sont déjà renseignés. Une étoile sur le projet est aussi une belle façon de le soutenir.',
      toolsHeading: 'Au-delà de cette page',
      toolsBody:
        'Le moteur fonctionne aussi de façon autonome : en <a href="https://github.com/t41372/long-screen#command-line" target="_blank" rel="noopener">ligne de commande</a>, sous forme de <a href="https://github.com/t41372/long-screen#rust-library" target="_blank" rel="noopener">bibliothèque Rust</a>, de <a href="https://github.com/t41372/long-screen#python-package" target="_blank" rel="noopener">paquet Python</a> ou de <a href="https://github.com/t41372/long-screen#typescript-package" target="_blank" rel="noopener">paquet TypeScript</a> pour d’autres pages web. Ces outils traitent eux aussi les enregistrements uniquement sur votre machine. Le README décrit leur installation et leur utilisation.',
      licenseHeading: 'Licences des logiciels libres',
      licenseBody:
        'Le code de Long Screen est sous licence MIT : vous pouvez l’utiliser, le copier, le modifier, le redistribuer gratuitement ou le vendre, et l’intégrer à un produit propriétaire, à condition de conserver la mention de copyright et le <a href="https://github.com/t41372/long-screen/blob/main/LICENSE" target="_blank" rel="noopener">texte de la licence</a>. Il est fourni en l’état, sans garantie. Les dépendances incluses dans le moteur Wasm et l’interface, leurs licences, ainsi que les sources et licences des logos Rust, WebAssembly et GitHub figurent dans les <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">mentions des logiciels libres</a>, générées lors de la compilation.',
    },
    regions: {
      title: 'Délimiter les zones de mouvement',
      hint:
        'Tracez un rectangle sur l’image. Chaque zone « contenu » sera reconstituée séparément. Les parties non marquées restent dans une couche d’observation distincte, signalée comme peu fiable. Les zones « ignorer » sont entièrement exclues.',
      kindMoving: 'Contenu · défile indépendamment',
      kindFixed: 'Interface fixe',
      kindIgnore: 'Ignorer · exclure du résultat',
      clearBtn: 'Rétablir la détection automatique',
      saveBtn: 'Utiliser ces zones',
    },
    source: {
      title: 'Image source',
    },
    crop: {
      button: 'Recadrer',
      groupLabel: 'Zone de recadrage',
      left: 'Gauche',
      top: 'Haut',
      width: 'Largeur',
      height: 'Hauteur',
      full: 'Image entière',
      cancel: 'Annuler',
      apply: 'Appliquer',
    },
    footer: {
      stackLead: 'Le moteur est écrit en',
      stackMid: 'et compilé en',
      stackTail: 'pour fonctionner dans votre navigateur.',
      stackMore: 'Interface en TypeScript · compilation et tests avec Deno',
      linksLabel: 'Liens du projet',
      source: 'Code sur GitHub',
      report: 'Signaler un bug',
      notices: 'Mentions des logiciels libres',
      trademarks:
        'Les noms et logos Rust, WebAssembly, TypeScript, Deno et GitHub appartiennent à leurs propriétaires. Ils indiquent les technologies utilisées, sans suggérer leur approbation du projet.',
    },
  },
  deviceCheck: {
    doneTitle: 'Vérification de l’appareil — terminée',
    title: 'Vérifier cet appareil',
    intro:
      'Mesure les capacités du navigateur et de l’appareil (isolation entre origines, threads, adaptateur WebGPU), ainsi que le coût réel du traitement GPU :\ntransfert aller-retour d’une image RGBA à sa taille d’origine, temps de réduction des images d’analyse et comparaison octet par octet entre le GPU et le moteur Rust.\nVous pouvez aussi choisir une vidéo pour comparer les empreintes des tuiles après un traitement complet sur CPU et sur WebGPU forcé.\nTout se passe sur cet appareil, sans envoi de fichier. Les données du test vidéo sont supprimées après comparaison. WebGPU nécessite un contexte sécurisé (localhost ou HTTPS).',
    recordingLabel: 'Enregistrement (facultatif) :',
    runBtn: 'Lancer la vérification',
    loadingReport: 'Chargement du moteur…',
  },
};
