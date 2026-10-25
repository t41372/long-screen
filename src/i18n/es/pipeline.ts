import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'La reconstrucción usa lienzos por capas que se desplazan y restricciones geométricas al cerrar recorridos. Las máscaras automáticas y la detección de zonas dinámicas se basan en heurísticas; las puntuaciones de confianza no son probabilidades calibradas de corrección. La coherencia en coordenadas globales se compara con el ruido de decodificación declarado por la fuente: ±{{noise}} niveles{{margin}}.',
      marginLossy: ' (margen para las oscilaciones de compresión y la reconstrucción del color)',
      marginLossless: ' (fuente sin pérdidas, comparación exacta píxel a píxel)',
      action: 'Si la escala o la estructura son incompatibles, se conserva un fragmento independiente sin forzar la unión.',
    },
    APPROXIMATE_DECODER: {
      message:
        'Se activó expresamente «Aproximada · saltos nativos» a {{fps}} Hz. No se garantiza la captura de todos los fotogramas; puede faltar contenido que aparece brevemente.',
      action: 'Si necesitas cubrir todos los fotogramas, usa una entrada compatible con WebCodecs, como H.264 o VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'El análisis de movimiento limita el lado mayor a {{size}}px. El ajuste fino y la composición final usan los píxeles originales: el resultado no se reduce.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Un fotograma a tamaño original y sus referencias casi alcanzan el límite de caché elegido. Ese límite de JavaScript no controla la memoria del decodificador ni de la GPU.',
      action:
        'La resolución de salida nunca se reduce sin avisar. Si falta memoria, se conservan los datos ya guardados y se informa del fallo.',
    },
    RUN_FAILURE: {
      action: 'Los bloques ya guardados en el almacenamiento local se pueden seguir viendo y exportando. El fallo no se marcó como éxito.',
    },
    PERSISTENCE_ERROR: {
      action: 'También falló la escritura en el almacenamiento. Solo se pueden recuperar los datos guardados anteriormente.',
    },
    MEMORY_BUDGET_RAISED: {
      message:
        'La caché pasó de los {{from}} bloques permitidos a {{to}} bloques (unos {{mb}} MB) para alojar todos los que abarca un fotograma.',
      action:
        'Una caché menor que el área de un fotograma obligaría a decodificar y codificar de nuevo todos sus bloques en cada paso. Para usar menos memoria, reduce la resolución de la grabación.',
    },
    NONFINITE_POSE: {
      message:
        'El cálculo de posición produjo un valor no finito. Esta observación se aisló y sus coordenadas inválidas no se escribieron en el lienzo.',
    },
    MISSING_PLAN: {
      message: 'Falta plan/{{index}} en la fase de renderizado. El proceso se detuvo en el último punto guardado.',
      action: 'Comprueba la integridad del almacenamiento local. Un plan de ubicación ausente no se trata como una observación vacía.',
    },
    prefixOnly: {
      base: {
        scan: 'La ubicación y la composición continúan solo con los {{frames}} fotogramas ya decodificados',
        solve: 'El renderizado continúa solo con los {{frames}} fotogramas ya ubicados',
        render: 'Solo se conservan los resultados de los {{frames}} fotogramas ya renderizados',
      },
      suffixPersistence: '; la escritura en el almacenamiento se ha detenido.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action: 'Se omitió la vista con marco de este lienzo. La reconstrucción principal en coordenadas de página no se ve afectada.',
    },
    PRESENTATION_FRAME: {
      message:
        'La vista con marco y el contenido 2D original se guardan por separado. El marco procede de un fotograma de referencia; su ampliación es solo fondo decorativo y no cuenta como contenido observado. Los iconos de la barra de herramientas no se estiran ni se duplican. Los demás paneles dentro del marco son solo instantáneas de referencia.',
    },
    PRESENTATION_STAGE_FAILED: {
      action:
        'Falló la creación de la vista con marco. El resultado y el estado de la reconstrucción principal en coordenadas de página no se ven afectados.',
    },
    PYRAMID_FAILED: {
      action:
        'No se pudo crear la vista previa por niveles. Los bloques a tamaño original no se ven afectados y se pueden seguir viendo y exportando.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: 'La fase {{pass}} solo completó {{actual}} de {{expected}} fotogramas. El resultado se marcó como parcial.',
      action: 'Se conservó la parte guardada correctamente. Los fotogramas que faltan no se dieron por procesados.',
    },
    FRAME_CONVERSION: { message: 'Método para convertir los fotogramas decodificados en píxeles: {{method}}.' },
    HDR_UNCHECKED: {
      message:
        'Esta grabación es HDR ({{transfer}}), pero el navegador no permite comprobar la conversión de color. La captura podría verse oscura o deslavada.',
      action: 'Vuelve a procesarla en una versión actualizada de Chrome o Safari.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'En el primer fotograma HDR, el {{percent}}% de los píxeles supera el brillo del blanco normal y se ha tratado como blanco. Si la captura parece sobreexpuesta, es probable que la grabadora haya asignado al blanco normal un brillo más alto.',
      action: 'Configura el blanco SDR de la grabadora a 100 nits o desactiva la grabación HDR.',
    },
    SLOW_CONVERSION: {
      message:
        'Este navegador tarda unos {{ms}} ms en convertir cada fotograma en píxeles. Solo la conversión de toda la grabación llevará unos {{minutes}} min.',
      action: 'Una versión actualizada de Chrome o Safari es mucho más rápida. También ayuda convertir antes la grabación a H.264.',
    },
    REVEAL_SKIPPED: {
      message:
        'Esta captura tiene demasiados lienzos o son demasiado grandes. Quitar las superposiciones (cursor, botones flotantes y barras de desplazamiento) necesitaría unos {{need}} MB más de la memoria disponible. Se omitió ese paso y se conservaron los píxeles ya unidos.',
      action:
        'El resto del resultado no se ve afectado. Tantos lienzos suelen indicar que algunas partes no se pudieron unir con las anteriores. Prueba una grabación más corta o un equipo con más memoria.',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}. Motor Rust: variante {{variant}}, hilos de cálculo: {{threads}} ({{coreReason}}).',
    },
    PRESENTATION_REFERENCE_FAILED: {
      action: 'Se omitirá la vista con marco. La reconstrucción principal en coordenadas de página no se ve afectada.',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'El fotograma no tiene suficiente textura reconocible. Dos fotogramas en blanco idénticos pueden indicar una pausa o un movimiento por una zona vacía; los píxeles por sí solos no permiten distinguirlo.',
      action:
        'Incluye contenido visible que se pueda distinguir o graba con más solapamiento. Asumir desplazamiento cero aquí es solo la mejor estimación disponible.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Esta observación no tiene referencias visuales fiables para alinearse. La fase de ubicación intentará compararla con contenido anterior; si no lo consigue, se conservará como fragmento independiente.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'Se detectó una textura repetida con varias coincidencias igual de plausibles. La continuidad orienta la ubicación, pero no demuestra una posición única.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message:
        'Este fotograma abarca un intervalo inusualmente largo. Durante un movimiento rápido pueden haber quedado zonas sin capturar.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'El área no cubierta por las zonas manuales se conserva como una capa independiente de baja confianza, en coordenadas de pantalla. No se afirma que esos píxeles se hayan ubicado en las coordenadas de la página.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Se excluyó una zona de «ignorar» según la selección manual. Esa zona no aporta contenido a la reconstrucción; no se trata de una omisión automática de fotogramas.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Si las zonas manuales se solapan, tiene prioridad la dibujada al final. Las zonas ignoradas siempre se excluyen. Los píxeles restantes se conservan en la capa de observación sin asignar.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Zonas detectadas: {{moving}} de contenido y {{fixed}} de interfaz fija. Los límites se basan en estadísticas de movimiento de los píxeles, no en el DOM.',
      action:
        'Si una máscara no corresponde a la zona correcta, delimita el área desplazable en «Zonas de movimiento» y vuelve a procesar.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: 'Cada zona de desplazamiento independiente tendrá su propio lienzo. No se les impone un desplazamiento común.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Tras alinear este fotograma, el área solapada contiene {{conflicts}} píxeles claramente distintos. Esta zona es uno de los componentes en conflicto. Puede deberse a animaciones, actualizaciones, cambios de distribución o errores residuales de alineación.',
      actionStable:
        'Siempre que fue posible, toda la zona en conflicto se fijó a un único momento. Revisa los diagnósticos naranjas y la marca de tiempo del video original.',
      actionRolling:
        'La zona completa en conflicto solo se actualiza con un mismo fotograma cuando está totalmente visible. No significa que toda la página corresponda al mismo instante.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Esta zona cambiante nunca apareció completa en una vista utilizable. No se puede garantizar que todos sus píxeles procedan del mismo instante.',
      action:
        'Se conservan el contenido observado y las marcas explícitas de conflicto. No se inventó contenido para las partes no observadas.',
    },
    MISSING_SCAN_RECORD: {
      message: 'Falta scan/{{index}} en la fase de ubicación. El proceso se detuvo en el último punto guardado.',
      action: 'Comprueba la integridad del almacenamiento local. Un registro de análisis ausente no se trata como desplazamiento cero.',
    },
    GRAPH_RESIDUAL: {
      message:
        'El error residual máximo del grafo de posiciones sigue siendo de {{residual}} píxeles originales. Puede haber incoherencias geométricas en las uniones cercanas.',
      action: 'Revisa el texto y las texturas repetidas cerca del cierre del recorrido. Este error residual se ha registrado expresamente.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Aproximadamente el {{percent}}% de los bloques de textura no coincide con el desplazamiento general, por animaciones, video, carga diferida o cambios de distribución. El desplazamiento se calcula con los bloques coherentes y la zona en conflicto se trata por separado al componer.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'El movimiento entre fotogramas dejó muy poco solapamiento para alinearlos. El desplazamiento se deduce de esa pequeña referencia. En un diseño periódico, la repetición adyacente también podría explicar los mismos píxeles.',
      action:
        'Si una visita posterior aporta referencias más sólidas, se corregirá todo este tramo de la trayectoria y quedará registrado.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'La textura repetida admite varios desplazamientos posibles. Se eligió el más coherente con la continuidad del movimiento: es la mejor estimación disponible, no la única alineación correcta demostrada.',
      messageLowConfidence:
        'La ubicación de esta zona se estimó con baja confianza. Los píxeles afectados están señalados en la máscara de calidad.',
      messageStatic:
        'Los dos fotogramas son casi idénticos, pero no tienen correspondencias verificables. Se han tratado como una pausa, con desplazamiento cero: es solo la mejor estimación disponible.',
      action:
        'Se usaron la trayectoria continua y los puntos de referencia existentes para estimar la posición. No se afirma que sea la única alineación correcta.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'Este fotograma no tiene textura reconocible en esta zona. Un fotograma en blanco puede indicar una pausa o un movimiento por un área vacía; los píxeles por sí solos no permiten distinguirlo. No se pinta en ninguna posición.',
      action:
        'Si el contenido posterior al área vacía no se solapa con observaciones anteriores, se conserva como fragmento independiente, sin adivinar la distancia intermedia.',
    },
    RELOCALIZED: {
      message:
        'Se volvió a ubicar el contenido en un lienzo ya observado mediante una referencia visual anterior. El contenido revisitado no se añadió como una nueva extensión de la captura.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Se detectó un cambio de escala o distribución de aproximadamente {{scale}}×. Se conservó un fragmento independiente con sus píxeles originales, sin mezclar escalas sin aviso.',
      action:
        'La relación entre fragmentos aún no está confirmada. Si una visita posterior ofrece una coincidencia fiable, se unirá el fragmento completo. Vuelve a grabar con más solapamiento o aísla el elemento cambiante con una zona manual.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'No se pudo confirmar la posición respecto al lienzo original. Se conservó un fragmento independiente que se puede exportar por separado. Los fragmentos pueden solaparse o tener un hueco real entre ellos.',
      action:
        'La relación entre fragmentos aún no está confirmada. Si una visita posterior ofrece una coincidencia fiable, se unirá el fragmento completo. Vuelve a grabar con más solapamiento o aísla el elemento cambiante con una zona manual.',
    },
    STICKY_OCCLUSION: {
      message:
        'La textura de la parte superior indica una interfaz fija en pantalla, no un movimiento de la página. Esa obstrucción fija no se escribe en el lienzo móvil. La interfaz de referencia original se conserva en la vista con marco.',
    },
    NESTED_LAYER_FOUND: {
      message:
        'Una parte de esta región se desplaza por su cuenta: en {{frames}} fotogramas su contenido no se movió con la región, así que tiene su propia imagen.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'Las referencias de una nueva visita permitieron unir un fragmento independiente completo a un lienzo existente. La trayectoria relativa dentro del fragmento no cambia.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'El paso anterior tenía muy poco solapamiento. La coincidencia de este fotograma con contenido ya observado difiere en {{discrepancy}}px y tiene referencias más sólidas. La posición actual se corrigió según esa coincidencia.',
      action:
        'Se corrigieron este fotograma y la trayectoria posterior. Los píxeles escritos antes no cambian y pueden mostrar una unión visible con las coordenadas corregidas.',
    },
    LOOP_CLOSURE: {
      message:
        'Se encontró una coincidencia fiable con una visita anterior y se añadió como restricción global de posición. La composición final utiliza la trayectoria corregida.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'La coincidencia histórica difiere de la trayectoria continua en {{discrepancy}}px. Como las referencias se contradicen, no se impuso como cierre de recorrido.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'La búsqueda histórica encontró varias posiciones casi igual de plausibles. El cierre de recorrido incierto no se impuso como una restricción obligatoria.',
    },
  },
  progress: {
    runPartial: 'Se guardó la reconstrucción disponible y se marcó como parcial.',
    runComplete: 'Reconstrucción terminada. Revisa los diagnósticos y las zonas no observadas.',
    render: 'Componiendo bloques a tamaño original con el contenido observado. Los huecos quedan transparentes.',
    reveal: {
      learn: 'Revisando de nuevo la grabación para encontrar botones, campos de entrada y barras que flotan sobre la página.',
      agree: 'Comparando cada zona a lo largo del tiempo y dando prioridad a las vistas sin obstrucciones.',
      relearn: 'Volviendo a identificar los elementos flotantes con la página ya comprobada.',
      write: 'Sustituyendo las zonas tapadas o incoherentes por el fotograma despejado.',
    },
    framingStart: 'Conservando el marco original. Solo se amplía el fondo, sin estirar el texto lateral ni duplicar iconos.',
    pyramidBuild: 'Creando en disco los niveles de vista previa. Los bloques a tamaño original no cambian.',
    scanFrame: 'Analizando la geometría fotograma a fotograma e identificando zonas de movimiento independiente.',
    duplicateReuse: 'Una observación idéntica reutilizó la posición anterior. Se conservan el fotograma de origen y su marca de tiempo.',
    solveFrame: 'Afinando posiciones con píxeles originales, buscando coincidencias anteriores y aplicando cierres de recorrido 2D.',
    optimizing: 'Optimizando el grafo de posiciones en disco y corrigiendo el error acumulado al cerrar recorridos.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: este navegador no puede decodificar el códec de la grabación ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'Las grabaciones de iPhone y Mac suelen usar HEVC, que solo algunos navegadores pueden decodificar. Usa Safari, o Chrome o Edge con decodificación por hardware.',
      prores: 'Ningún navegador decodifica ProRes. Primero exporta la grabación como H.264 o HEVC.',
      h264: 'Solo Chrome decodifica este tipo de H.264 (4:4:4 o 10 bits). Usa Chrome o exporta la grabación como H.264 estándar.',
      av1: 'AV1 necesita un navegador o hardware reciente. Usa Chrome actualizado o exporta la grabación como H.264.',
      other: 'Usa Chrome o Safari actualizado, o convierte antes la grabación a H.264.',
    },
    PIXEL_ASPECT_RATIO:
      'La grabación declara una relación de aspecto de píxel de {{num}}:{{den}}. Se conservan los píxeles almacenados sin escalarlos, así que la proporción mostrada puede variar.',
    CONTAINER_SIZE_MISMATCH:
      'El contenedor declara {{codedWidth}}×{{codedHeight}}, pero el flujo de video tiene {{bitstreamWidth}}×{{bitstreamHeight}}. Se usa el tamaño real del flujo.',
    NON_SQUARE_PIXELS:
      'La grabación declara píxeles no cuadrados: tamaño de visualización {{displayWidth}}×{{displayHeight}}, tamaño almacenado {{bitstreamWidth}}×{{bitstreamHeight}}. Se conservan los píxeles almacenados originales, sin escalarlos.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'El decodificador produjo un fotograma anterior al inicio de la lista de edición, con una marca de tiempo negativa. Esos fotogramas no se muestran, según las reglas del contenedor.',
    NONMONOTONIC_TIMESTAMP:
      'Una marca de tiempo del contenedor retrocedió. El proceso continuó en el orden de presentación del decodificador y no se descartó ninguna observación.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: La caja ctts de esta pista de video es de versión 0, pero contiene desfases negativos de tiempo de composición. ISO 14496-12 solo los define en la versión 1. Se interpretan como valores con signo, siguiendo la práctica habitual de QuickTime y ReplayKit, y no como valores positivos anormalmente grandes.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: El archivo termina dentro de la caja {{box}}. Esta declara que acaba en el byte {{declaredEnd}}, pero el archivo solo tiene {{size}} bytes. Puede que la grabación no terminara correctamente o que el archivo se truncara al copiarlo o transferirlo. Los fotogramas posteriores al corte no se pueden decodificar, por lo que el análisis encontrará menos de los indicados en los metadatos y el resultado se marcará como parcial.',
  },
  exports: {
    tilesProgress: 'Exportando bloques originales y de vista previa {{n}}',
    zipFinalize: 'Escribiendo el directorio ZIP64 y guardando el archivo',
    projectDone: {
      message:
        'Se exportaron los bloques a tamaño original, el visor sin conexión, los datos de cobertura y calidad, los registros de fotogramas de origen y todos los diagnósticos.',
    },
    encodingSingle: 'Codificando fila {{row}} de {{total}} a tamaño original',
    canvasDone: { message: 'Se exportó un PNG de {{width}} × {{height}} a tamaño original. Los huecos siguen transparentes.' },
    encodingSheet: 'Páginas codificadas a tamaño original: {{count}}',
    sheetsDone: {
      messagePaged:
        'Se exportaron {{count}} páginas a tamaño original. Las páginas adyacentes se solapan hasta {{overlap}}px; las coordenadas figuran en el manifiesto.',
      messageOversize:
        'El lienzo superaba el tamaño compatible con una sola imagen, así que se exportó en {{count}} páginas a tamaño original. Las páginas adyacentes se solapan hasta {{overlap}}px; las coordenadas figuran en el manifiesto.',
    },
  },
  offline: {
    title: 'Lienzo sin conexión',
    fit: 'Ajustar',
    tip: 'Bloques locales a tamaño original · arrastra para mover / usa la rueda para ampliar',
    previewLevel: 'Vista previa de nivel {{level}}. Acerca la vista para ver los píxeles originales',
    nativeTiles: 'Mostrando bloques a tamaño original',
    footer:
      'La cuadrícula indica zonas no observadas o sin bloques. La confianza no es una probabilidad de corrección. Consulta diagnostics.jsonl y observations.jsonl.',
  },
};
