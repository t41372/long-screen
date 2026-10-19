import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Analizando fotogramas y separando capas en movimiento',
      solving: 'Ubicando el contenido y afinando con los píxeles originales',
      optimizing: 'Corrigiendo recorridos cerrados y errores acumulados',
      rendering: 'Componiendo el lienzo a tamaño original',
      revealing: 'Quitando elementos que flotan sobre la página',
      framing: 'Conservando el marco y las proporciones originales',
      pyramid: 'Creando una vista previa con zoom',
      complete: 'Completado · revisa los diagnósticos',
      partial: 'Resultados parciales guardados',
      error: 'Se produjo un error durante el proceso',
    },
    count: {
      frames_one: '{{frames}} fotograma',
      frames_other: '{{frames}} fotogramas',
      frames_many: '{{frames}} fotogramas',
      framesUnknown: '? fotogramas',
      regions_one: '{{count}} zona personalizada ↗',
      regions_other: '{{count}} zonas personalizadas ↗',
      regions_many: '{{count}} zonas personalizadas ↗',
    },
    dom: {
      noCompressionStream:
        'Este navegador no tiene CompressionStream, necesario para codificar cada bloque a tamaño original en PNG. No se puede iniciar la reconstrucción.',
    },
    canvases: {
      badgePresentation: 'Vista con marco · el fondo ampliado no procede de la grabación',
      badgeFixed: 'Capa fija / de observación',
      badgeMoving: 'Capa de contenido 2D',
      badge_one: '{{kind}} · {{count}} bloque a tamaño original{{fragment}}',
      badge_other: '{{kind}} · {{count}} bloques a tamaño original{{fragment}}',
      badge_many: '{{kind}} · {{count}} bloques a tamaño original{{fragment}}',
      fragmentNote: ' · no se ha confirmado la alineación entre fragmentos',
    },
    diagnostics: {
      occurrenceSuffix: ' ({{count}} casos de este tipo)',
      locateAction: 'Ver zona afectada / imagen original ↗',
      viewSourceAction: 'Ver el momento original ↗',
      emptyFiltered: 'No hay registros con este filtro.',
      emptyDefault:
        'Aquí aparecerán las decisiones de ubicación, los cambios de contenido, las inferencias y los errores de procesamiento.',
      noOriginalVideo:
        'El proyecto no incluye el video original. Vuelve a elegir la grabación correspondiente para verla por marca de tiempo. El resultado compuesto sigue guardado en este dispositivo.',
      hashMismatch:
        'El nombre y el tamaño del archivo coinciden, pero su hash de contenido no corresponde a la grabación de este proyecto. No se usará como prueba del momento original. Elige el archivo correcto.',
      sourceCaption: 'Fotograma original {{frame}} · {{time}} s · {{message}}',
    },
    export: {
      imageSuffix: '-captura',
      savePickerFallback: 'No se puede guardar directamente. Se usará la descarga del navegador: {{error}}',
      saveRowLabel: 'Guardar {{name}} · {{size}}',
      shareLabel: 'Compartir / guardar en Fotos',
      shareFailed: 'No se pudo compartir: {{error}}',
      cleanupLabel: 'Borrar la copia temporal después de guardar',
      exportErrorAction:
        'La exportación no terminó y no se marcó como completada. Los bloques del proyecto ya guardados siguen en este dispositivo.',
      clipboardUnsupported: 'Este navegador no permite copiar imágenes. Usa «Descargar captura».',
      copyNoImage: 'No se generó ninguna imagen',
      copyFailedCtor: 'No se pudo copiar: {{error}}. Usa «Descargar captura».',
      copySuccess: 'Captura de {{width}} × {{height}} copiada. Ya puedes pegarla.',
      copyFailed: 'No se pudo copiar: {{error}}. La imagen puede superar el límite del portapapeles. Usa «Descargar captura».',
    },
    crop: {
      buttonCropped: 'Recorte · {{width}} × {{height}}',
      applied:
        'Recorte aplicado. Las descargas, copias y exportaciones por páginas incluirán solo esta zona ({{width}} × {{height}}). El ZIP del proyecto completo no se recorta.',
      removed: 'Recorte eliminado. Las exportaciones vuelven a incluir toda la captura.',
    },
    main: {
      offscreenMissing: 'Este navegador no tiene OffscreenCanvas. El worker de renderizado no puede ejecutarse.',
      webcodecsMissingToast:
        'Este navegador no tiene WebCodecs. Elige «Aproximada · saltos nativos» para continuar, aunque puede omitir fotogramas.',
      privateStorageToast:
        'Navegación privada: el proyecto solo se conserva en la memoria de esta ventana y desaparece al cerrarla. Expórtalo antes si quieres guardarlo.',
      noOpfsNoPicker:
        'Este navegador no tiene OPFS ni un diálogo para guardar archivos. La exportación se generará en memoria, con un máximo de {{mb}} MB.',
      dbOpenFailed: 'No se pudo abrir la base de datos local: {{error}}',
      workerErrorToast: 'Error del worker: {{message}}',
      workerMessageUndecodable: 'No se pudo interpretar un mensaje del worker. Conserva los resultados actuales y recarga la página.',
      interruptedPhaseWhere: '«{{phase}}», fotograma {{frames}}',
      interruptedStartPhase: 'la fase inicial',
      interruptedHiddenSome: 'la página estuvo en segundo plano unos {{seconds}} s{{stillHidden}}',
      interruptedStillHidden: ' (seguía en segundo plano al interrumpirse)',
      interruptedHiddenNone: 'la página permaneció en primer plano todo el tiempo',
      interruptedDiagnosticMessage:
        'La reconstrucción anterior se interrumpió en {{where}}. La página no recibió la señal de finalización: el navegador la descartó o sufrió un fallo. Habían transcurrido {{elapsed}} s, la memoria del motor era de {{memory}} MB, {{hidden}}, conversión de fotogramas: {{conversion}}, núcleos de CPU: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari impone un límite de memoria mucho menor a las páginas en segundo plano y puede descartarlas. Mantén esta pestaña en primer plano durante los procesos largos. El registro completo está en la consola del navegador.',
      interruptedNotIsolated: ' (sin aislamiento entre orígenes, un solo hilo)',
      interruptedToast: 'La reconstrucción anterior se interrumpió en {{where}} ({{hidden}}). Consulta los diagnósticos.',
      unknownValue: 'desconocido',
    },
    run: {
      pausedStatus: 'En pausa · estado conservado en memoria',
      resumedStatus: 'Reanudando',
      pauseLabel: 'Pausar',
      resumeLabel: 'Continuar',
      stopToast: 'Terminando la fase actual y componiendo y guardando todo el contenido observado que sea posible.',
      preparingStatus: 'Preparando la decodificación exacta',
      preparingMessage: 'Leyendo el contenedor y comprobando el códec y el almacenamiento local.',
      compatibilityNeedsNative: 'El modo «Aproximada · saltos nativos» necesita que el reproductor del navegador pueda leer este video.',
      webcodecsHttpBlocked:
        'El navegador no habilita WebCodecs en esta dirección HTTP. Puedes seguir probando en local con «Aproximada · saltos nativos». La decodificación exacta necesita localhost o HTTPS; el video no se sube.',
      webcodecsMissing:
        'Este navegador no tiene WebCodecs. Actualiza Safari o iOS, o elige «Aproximada · saltos nativos», que puede omitir fotogramas.',
      startFailedStatus: 'No se pudo iniciar la reconstrucción',
      restoredMessage: 'Este es tu último resultado. Pasadas 24 horas, se eliminará la próxima vez que abras la página.',
      interruptedStatus: 'El último proceso no terminó',
      interruptedMessage:
        'Esto es lo que se guardó antes de la interrupción. Para obtener el resultado completo, vuelve a añadir la grabación y procésala de nuevo.',
      waitingCanvasOption: 'Esperando a reconstruir un lienzo',
    },
    source: {
      busyToast: 'Primero termina o guarda el proceso actual.',
      subtitleReading: '{{size}} · sin subir archivos · leyendo el contenedor y el primer fotograma',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · solo lo puede leer el reproductor nativo',
      subtitleUnavailable: '{{size}} · no hay decodificación exacta ni vista previa nativa disponibles',
      probeFailedMessage: 'Falló la comprobación de decodificación exacta: {{error}}',
      probeFailedAction:
        'Se intentarán leer los metadatos con el reproductor del navegador. Para continuar, elige «Aproximada · saltos nativos» como modo de decodificación.',
      rejectedVideo:
        '«{{name}}» es {{kind}}. El navegador no puede leer ese formato fotograma a fotograma, así que no se abrió. Configura la grabadora para guardar en MP4 o convierte el archivo con HandBrake o ffmpeg.',
      rejectedOther:
        '«{{name}}» no es un video ({{kind}}), así que no se abrió. Elige una grabación de pantalla mientras recorres una página: MP4, MOV, WebM o MKV. En Windows puedes grabar con Recortes o Xbox Game Bar (Win+Alt+R); en Mac, con ⌘⇧5; en el teléfono, con la grabación de pantalla del sistema.',
      unreadableToast:
        'No se puede leer este video ({{reason}}). Comprueba que la grabación terminó correctamente y que el archivo se copió o descargó por completo. Si sigue fallando, prueba un MP4 con H.264. Los diagnósticos explican por qué falló la decodificación exacta.',
      kind: {
        empty: 'un archivo vacío',
        heif: 'una imagen HEIC/AVIF',
        avi: 'un video AVI',
        webp: 'una imagen WebP',
        wav: 'un archivo de audio WAV',
        riff: 'un archivo RIFF',
        wmv: 'un video WMV/ASF',
        flv: 'un video FLV',
        mpegps: 'un video MPEG-PS',
        ogg: 'un archivo multimedia Ogg',
        gif: 'una animación GIF',
        png: 'una imagen PNG',
        jpeg: 'una imagen JPEG',
        pdf: 'un documento PDF',
        zip: 'un archivo ZIP o un documento de Office',
        mp3: 'un archivo de audio MP3',
        text: 'un archivo de texto',
        mpegts: 'un video MPEG-TS',
        unknown: 'un archivo no reconocido',
      },
    },
    demo: { fileName: 'grabacion-de-ejemplo.mp4', loadFailed: 'No se pudo cargar la grabación de ejemplo: {{error}}' },
    feedback: {
      issueBody:
        '**¿Qué ocurrió?**\n\n\n**¿Qué esperabas que ocurriera?**\n\n\n**Sobre la grabación** (qué página grabaste, cómo te desplazaste y cuánto duraba; una captura ayuda, pero oculta los datos privados)\n\n\n' +
        '---\nDatos añadidos por Long Screen. Puedes editarlos o borrarlos:\n- Navegador: {{browser}}\n- Página de origen: {{page}}\n- Motor con varios hilos (aislamiento entre orígenes): {{threads}}\n- Avisos del registro: {{warnings}}\n',
      portable: 'versión portátil (archivo local)',
      yes: 'sí',
      no: 'no',
      none: 'ninguno',
    },
    viewer: {
      previewLevel: 'Vista previa L{{level}} (sin cambiar el tamaño original)',
      nativeLevel: 'Píxeles originales L0',
      qualityHint: ' · acerca la vista para ver la máscara de calidad',
      unobservedHint: ' · azul = sin datos de observación',
      provisionalHint: ' · morado = contenido transitorio o superpuesto',
    },
  },
  names: {
    fixed: 'Interfaz fija',
    divider: 'Separador fijo',
    contentCanvas: 'Lienzo de contenido {{n}}',
    unassigned: 'Zona sin asignar · observaciones en coordenadas de pantalla',
    contentRegion: 'Zona de contenido {{n}}',
    ignored: 'Ignorado',
    fragment: 'fragmento sin ubicar {{n}}',
    framed: 'con marco',
  },
};
