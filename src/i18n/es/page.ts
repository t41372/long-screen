import type { Catalog } from '../catalog.ts';
import type { pageSections as zh } from '../zh/page.ts';

export const pageSections: Catalog<typeof zh> = {
  language: {
    label: 'Idioma de la interfaz',
    saveFailed: 'No se pudo guardar el idioma: el navegador bloquea el almacenamiento local.',
  },
  page: {
    title: 'Long Screen — De una grabación de pantalla a una captura completa',
    description:
      'Convierte una grabación de pantalla en una sola captura a tamaño original: desplázate en cualquier dirección, en diagonal, detente o vuelve atrás. También recupera los marcos de ventana y las barras de estado fijas. Todo se procesa en tu navegador, sin subir archivos.',
    closeLabel: 'Cerrar',
    header: {
      brandLabel: 'Inicio de Long Screen',
      slogan: 'CUALQUIER RECORRIDO · UNA SOLA CAPTURA',
      privacy: 'Tus imágenes se quedan en este dispositivo',
      helpLabel: 'Ayuda y funciones',
      star: 'Danos una estrella en GitHub',
      starLabel: 'Danos una estrella en GitHub (se abre en otra pestaña)',
      install: 'Instalar aplicación',
      installTitle: 'Instala Long Screen en este dispositivo como aplicación web (PWA): se abre como una app y funciona sin conexión',
    },
    install: {
      title: 'Instalar en este dispositivo',
      intro:
        'Puedes instalar Long Screen como aplicación web (PWA). Se abre desde la pantalla de inicio o el Dock, en su propia ventana, y funciona sin conexión. Las grabaciones se siguen procesando solo en este dispositivo.',
      iosShare: 'Toca el botón de compartir del navegador. En Safari está en la barra inferior o en el menú ⋯.',
      iosAdd: 'Busca la opción «Añadir a pantalla de inicio».',
      iosConfirm: 'Toca «Añadir».',
      iosInApp: 'Si abriste esta página dentro de otra app, como WeChat o LINE, ábrela primero en Safari.',
      macFile: 'En la barra de menús de la parte superior de la pantalla, elige Archivo → Añadir al Dock.',
      macConfirm: 'Haz clic en «Añadir».',
      offline: 'Después de instalarla, ábrela una vez con conexión. A partir de entonces podrás usarla sin conexión.',
    },
    hero: {
      heading: 'De una grabación de pantalla<br>a <span class="hl">una sola captura completa</span>.',
      intro:
        'Graba la pantalla mientras recorres una web, una app o un diseño: en cualquier dirección, en diagonal o volviendo sobre tus pasos. Lo que aparece en la grabación se coloca en su sitio para formar un solo PNG a tamaño original, con los marcos y las barras de estado fijas. Todo se procesa en tu navegador, sin subir archivos.',
      demoLead: ' ¿Quieres verlo antes?',
      demoChip: 'Reproducir un ejemplo',
    },
    steps: {
      ariaLabel: 'Cómo funciona',
      recordTitle: 'Graba',
      recordBody: 'Graba la pantalla mientras recorres una web o una app, en la dirección que quieras.',
      feedTitle: 'Pon el video',
      feedBody: 'Arrastra el video a la pantalla de la impresora y pulsa «Empezar».',
      takeTitle: 'Llévate la captura',
      takeBody: 'Obtén una sola captura a tamaño original. Lo que no grabaste queda vacío.',
    },
    press: {
      ariaLabel: 'La impresora',
      core: 'Versión de la biblioteca del motor',
      build: 'Commit con el que se creó esta página',
    },
    screen: {
      dropTitle: 'Arrastra aquí una grabación',
      dropHint: 'o haz clic para elegir un archivo · MP4 · MOV · WebM',
    },
    observe: {
      dropTitle: 'Aún no hay ninguna grabación',
      dropSubtitle: 'MP4 · MOV · WebM · no sale de este dispositivo',
    },
    controls: {
      print: 'Empezar',
      progress: 'Progreso',
      knobs: 'Ajustes',
      clear: 'Vaciar',
      clearTitle: 'Vaciar la impresora: retirar la grabación y borrar este resultado y su registro',
    },
    tray: {
      ariaLabel: 'Vista previa de la captura completa',
      idleTitle: 'Tu captura completa saldrá por aquí',
      story1: 'La grabación recorre la página…',
      story2: 'Cada parte vuelve a su sitio',
      story3: '¡Una sola captura completa!',
      story4: 'Desliza hacia abajo y graba…',
      story5: 'Todo unido, una sola barra de estado',
      story6: '¡También crea capturas largas!',
    },
    reconstruct: {
      heading: 'Ajustes de procesamiento',
      sub: 'Los ajustes iniciales funcionan bien. Cámbialos si necesitas afinar el resultado.',
      policyLabel: 'Si el contenido cambia',
      policyStable: 'Conservar la vista más estable',
      policyLatest: 'Preferir la vista más reciente',
      framingLabel: 'Marco',
      framingContext: 'Conservar marco e interfaz fija',
      framingRegion: 'Solo contenido y márgenes',
      regionsLabel: 'Zonas de movimiento',
      regionsAuto: 'Detección automática ↗',
      advancedSummary: 'Más ajustes <span>＋</span>',
      analysisSizeLabel: 'Lado mayor del análisis',
      memoryLabel: 'Límite de caché de bloques',
      computeLabel: 'Aceleración',
      computeAuto: 'Automática · WebGPU / CPU',
      computeWebgpu: 'WebGPU · alineación en CPU',
      computeCpu: 'Solo CPU',
      computeHint:
        'La GPU convierte cada fotograma decodificado en píxeles y genera las miniaturas de análisis; la búsqueda de coincidencias y la composición siguen en la CPU. El modo automático mide ambas opciones y solo usa la GPU si resulta más rápida.',
      decoderLabel: 'Decodificación',
      decoderPrecise: 'Exacta · WebCodecs',
      decoderCompatibility: 'Aproximada · saltos nativos',
      decoderHint:
        'Las miniaturas de análisis no alteran los píxeles del resultado. La caché solo guarda bloques ya compuestos y se amplía si un fotograma necesita más espacio, por lo que apenas influye en la velocidad. No incluye la memoria del navegador, el decodificador, la GPU ni el motor. El modo «Aproximada · saltos nativos» puede omitir contenido que aparece brevemente.',
      pauseBtn: 'Pausar',
      stopBtn: 'Detener y guardar',
      footerNote: 'Sin subidas · sin inferencia en la nube · sin modelos externos',
    },
    canvas: {
      ariaLabel: 'Lienzo reconstruido',
      selectAriaLabel: 'Elegir lienzo reconstruido',
      waitingOption: 'Aún no hay resultados',
      qualityMask: 'Mostrar calidad',
      fitTitle: 'Ajustar a la ventana',
      fitBtn: 'Ajustar',
      nativeTitle: 'Tamaño original',
      viewerAriaLabel: 'Lienzo bidimensional que permite arrastrar y ampliar, con zonas vacías',
      zoomOutLabel: 'Alejar',
      zoomInLabel: 'Acercar',
      expandLabel: 'Ampliar vista',
      emptyTitle: 'Uniendo imágenes…',
      emptyBody: 'Cada fotograma está encontrando su sitio en la imagen completa.',
      statusReady: 'Todo listo',
      progressMessageDefault: 'Añade una grabación → pulsa Empezar → llévate la captura',
      lodLabel: 'Cuadrícula = zona no grabada',
    },
    understand: {
      noteBtn: 'Registro',
      heading: 'Registro del proceso',
      desc: 'Aquí queda constancia de dónde se coloca cada parte, qué cambió en la página y qué problemas surgieron.',
      framesLabel: 'fotogramas compuestos',
      canvasesLabel: 'lienzos independientes',
      coverageBody:
        'Transparente ≠ página en blanco<br><small>Indica una zona que no se observó. No se inventa contenido para rellenarla.</small>',
      diagnosticsHeading: 'Diagnósticos',
      filterAriaLabel: 'Filtrar diagnósticos',
      filterAll: 'Todos',
      filterIssues: 'Avisos / errores',
      diagnosticsAriaLabel: 'Diagnósticos del proceso',
      diagnosticsEmpty:
        'Aquí aparecerán las decisiones de ubicación, los cambios de contenido,<br>las inferencias y los errores de procesamiento.',
      moreDiagnostics: 'Cargar más diagnósticos',
      reportLead: '¿El resultado no está bien o algo falló?',
      reportBtn: 'Informar en GitHub',
      reportNote:
        'El informe incluye los datos de tu navegador y los códigos de aviso de este registro. Nunca incluye la grabación, sus imágenes ni el nombre del archivo. Puedes revisarlo y editarlo antes de enviarlo.',
    },
    export: {
      downloadPng: 'Descargar captura · PNG <span>↓</span>',
      copyPng: 'Copiar captura',
      outputSize: 'Tamaño de salida',
      originalSize: 'Original · 100%',
      customSize: 'Definir lado más largo',
      longestEdge: 'Lado más largo (px)',
      sizeNote:
        'Se aplica a descargas y copias. Mantiene las proporciones; el texto también se reduce. El original, las páginas y el proyecto conservan su tamaño original.',
      pngNote: 'Un PNG con el tamaño de salida elegido.',
      advancedSummary: 'Otras formas de exportar',
      exportProject: 'Exportar proyecto completo · ZIP',
      projectNote:
        'Bloques a tamaño original, visor sin conexión, datos de cobertura y calidad y todos los diagnósticos, para archivar o investigar problemas.',
      exportSheets: 'Exportar por páginas · varios PNG (ZIP)',
      sheetsNote:
        'Divide los lienzos demasiado grandes en varios PNG de tamaño compatible, sin reducir sus píxeles. Las páginas se solapan 32px e incluyen un manifiesto con sus coordenadas en el lienzo global.',
      starNudge: '¿Te resultó útil? Danos una estrella en GitHub',
    },
    help: {
      title: 'Una captura con trazabilidad',
      pixelsHeading: '¿Qué píxeles se conservan?',
      pixelsBody:
        'El modo preciso decodifica fotograma a fotograma. Cada observación procesada tiene una marca de tiempo y un registro de composición. El análisis puede usar imágenes reducidas; la composición final conserva los píxeles originales. Las descargas y copias se pueden reducir después.',
      frameHeading: 'Marco y márgenes originales',
      frameBody:
        'Por defecto se conservan el fondo, los márgenes y los espacios en blanco de toda el área desplazable, sin recortar hasta los bordes del texto. La vista con marco añade la interfaz de un fotograma de referencia: el texto de la barra lateral y los iconos aparecen una sola vez, a tamaño original. Las zonas ampliadas solo prolongan el fondo decorativo y no cuentan como contenido reconstruido. La capa de contenido original siempre se conserva aparte. Los demás paneles independientes no se presentan como si compartieran una misma trayectoria.',
      scopeHeading: 'La imagen no permite saberlo todo',
      scopeBody:
        'Separar capas en movimiento, distinguir texturas repetidas y atribuir zonas dinámicas exige inferencias visuales. Los cambios de escala, las zonas sin solapamiento o los diseños incompatibles pueden dar lugar a fragmentos independientes; no se afirma que esos fragmentos estén alineados entre sí. El nivel de confianza no es una probabilidad calibrada de que el resultado sea correcto.',
      storageHeading: 'Grabaciones largas y almacenamiento',
      storageBody:
        'Se realizan tres pasadas de decodificación: se usa espacio en disco y tiempo de cálculo para limitar el consumo de memoria. El navegador conserva solo el último resultado durante un máximo de 24 horas. Si recargas o cierras la página por accidente, reaparece al abrirla; si el proceso se interrumpió, se recupera lo que alcanzó a guardar, pero no se puede continuar desde ese punto. Empezar otro proceso o pulsar «Vaciar» lo elimina. Pasadas 24 horas, se borra la próxima vez que abras la página. Descarga lo que quieras conservar.',
      privacyHeading: '¿Mi grabación sale de este dispositivo?',
      privacyBody:
        'No. La decodificación, el análisis y la composición se realizan en tu navegador. Ni la grabación ni la captura salen de este dispositivo, y puedes seguir trabajando sin conexión una vez cargada la página. El sitio alojado en long-screen.yi-ting.com utiliza dos sistemas de estadísticas anónimas. Cloudflare Web Analytics cuenta visitas y solo recibe la página abierta, el origen de la visita, el tipo de navegador y dispositivo, el país y la velocidad de carga. PostHog cuenta los usos de la impresora: registra un evento al abrir la página, otro al empezar un proceso y otro al terminar. Solo incluyen los ajustes, la versión del motor, el códec de la grabación, su altura y duración en minutos, una cantidad aproximada de fotogramas, el número de imágenes generadas, el tiempo empleado y los códigos de diagnóstico. Cada evento también incluye la dirección de la página, el origen de la visita, el navegador y el sistema operativo, el tamaño de pantalla, el idioma, la zona horaria y el país. Ninguno usa cookies; PostHog tampoco guarda datos en tu navegador. Ninguno recibe grabaciones, capturas, nombres de archivo ni mensajes de error. Si activas Do Not Track o Global Privacy Control, PostHog ni siquiera se carga. Las copias que alojes por tu cuenta y la versión sin conexión de un solo archivo no recopilan estadísticas. La política de seguridad de contenido (CSP) solo permite conexiones al propio sitio y a estos dos servicios; el navegador bloquea cualquier otra.',
      browserHeading: 'Navegadores y formatos',
      browserBody:
        'Se necesitan IndexedDB, OffscreenCanvas y CompressionStream. Para desarrollo local puedes usar HTTP en localhost, sin certificado. Desde un teléfono conectado a una dirección HTTP de la red local, puedes probar con «Aproximada · saltos nativos», aunque puede omitir fotogramas. Normalmente los navegadores solo habilitan WebCodecs y las API de exportación a disco en localhost o HTTPS; esto no tiene relación con subir archivos. La decodificación exacta también requiere que el dispositivo admita el códec concreto: que un archivo sea MP4, MOV o WebM no garantiza que se pueda decodificar todo su contenido.',
      tipsHeading: '¿Cómo puedo mejorar el resultado?',
      tipsBody:
        'Deja suficiente solapamiento entre vistas y muévete algo más despacio por las zonas con poca textura. Si no se detectan bien varios paneles o capas flotantes, márcalos a mano en «Zonas de movimiento» antes de procesar. El proyecto completo incluye todos los diagnósticos.',
      feedbackHeading: 'Comentarios y código fuente',
      feedbackBody:
        'Long Screen es de código abierto, con licencia MIT. El código está en <a href="https://github.com/t41372/long-screen" target="_blank" rel="noopener">GitHub</a>. Si encuentras un error o un resultado incorrecto, <a class="report-link" href="https://github.com/t41372/long-screen/issues/new" target="_blank" rel="noopener">abre una incidencia</a>; incluirá los datos del navegador y los códigos de aviso del registro. Si te resulta útil, darle una estrella al proyecto nos ayuda mucho.',
      toolsHeading: 'También fuera de esta página',
      toolsBody:
        'El motor funciona también por separado: como <a href="https://github.com/t41372/long-screen#command-line" target="_blank" rel="noopener">herramienta de línea de comandos</a>, <a href="https://github.com/t41372/long-screen#rust-library" target="_blank" rel="noopener">biblioteca de Rust</a> y <a href="https://github.com/t41372/long-screen#python-package" target="_blank" rel="noopener">paquete de Python</a>, y como <a href="https://github.com/t41372/long-screen#typescript-package" target="_blank" rel="noopener">paquete de TypeScript</a> para otras páginas web. Todos procesan las grabaciones solo en tu equipo. El README explica cómo instalarlos y usarlos.',
      licenseHeading: 'Licencias de código abierto',
      licenseBody:
        'El código propio de Long Screen usa la licencia MIT: puedes usarlo, copiarlo, modificarlo y redistribuirlo gratis, venderlo o integrarlo en productos de código cerrado, siempre que conserves el aviso de derechos de autor y el <a href="https://github.com/t41372/long-screen/blob/main/LICENSE" target="_blank" rel="noopener">texto de la licencia</a>. Se ofrece tal cual, sin garantías. Las dependencias de terceros incluidas en el motor Wasm y los recursos de la interfaz, sus licencias y las fuentes y licencias de los logotipos de Rust, WebAssembly y GitHub aparecen en los <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">avisos de código abierto</a>, generados al compilar.',
    },
    regions: {
      title: 'Definir zonas de movimiento independiente',
      hint:
        'Arrastra para dibujar un rectángulo sobre el fotograma. Cada zona de «contenido» se reconstruye por separado. Las áreas sin marcar se conservan como una capa de observación independiente de baja confianza. Las zonas de «ignorar» se excluyen expresamente.',
      kindMoving: 'Contenido · movimiento independiente',
      kindFixed: 'Interfaz fija',
      kindIgnore: 'Ignorar · excluir de la reconstrucción',
      clearBtn: 'Restaurar detección automática',
      saveBtn: 'Usar estas zonas',
    },
    source: { title: 'Imagen original de la grabación' },
    crop: {
      button: 'Recortar',
      groupLabel: 'Área de recorte',
      left: 'Izquierda',
      top: 'Arriba',
      width: 'Ancho',
      height: 'Alto',
      full: 'Captura completa',
      cancel: 'Cancelar',
      apply: 'Aplicar recorte',
    },
    footer: {
      stackLead: 'El motor está escrito en',
      stackMid: 'y compilado a',
      stackTail: 'para ejecutarse en tu navegador.',
      stackMore: 'Interfaz en TypeScript · compilación y pruebas con Deno',
      linksLabel: 'Enlaces del proyecto',
      source: 'Código en GitHub',
      report: 'Informar de un error',
      notices: 'Avisos de código abierto',
      trademarks:
        'Los nombres y logotipos de Rust, WebAssembly, TypeScript, Deno y GitHub pertenecen a sus respectivos titulares. Solo indican las tecnologías utilizadas; no implican que respalden este proyecto.',
    },
  },
  deviceCheck: {
    doneTitle: 'Comprobación del dispositivo — completada',
    title: 'Comprobar dispositivo',
    intro:
      'Mide las capacidades del navegador y del dispositivo (aislamiento entre orígenes, hilos y adaptador WebGPU) y el coste real de usar la GPU:\ntransferir un fotograma RGBA a tamaño original a la GPU y leerlo de vuelta, además del tiempo y la coincidencia byte a byte al reducir imágenes para el análisis en la GPU y en el motor Rust.\nOpcionalmente, elige una grabación para ejecutar todo el proceso en la CPU y con WebGPU forzado, y comparar las huellas de los bloques.\nTodo se procesa en este dispositivo, sin subir archivos. Los datos de la grabación se eliminan después de la comparación. WebGPU solo está disponible en un contexto seguro (localhost o HTTPS).',
    recordingLabel: 'Grabación (opcional):',
    runBtn: 'Iniciar comprobación',
    loadingReport: 'Cargando motor…',
  },
};
