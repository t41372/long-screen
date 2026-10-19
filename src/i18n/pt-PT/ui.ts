import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'A analisar fotogramas e a separar camadas em movimento',
      solving: 'A posicionar o conteúdo e a aperfeiçoar os píxeis originais',
      optimizing: 'A corrigir reencontros e desvios acumulados',
      rendering: 'A compor a área no tamanho original',
      revealing: 'A remover elementos que flutuam sobre a página',
      framing: 'A preservar a moldura e as proporções originais',
      pyramid: 'A criar uma pré-visualização com zoom',
      complete: 'Concluído · verifique os diagnósticos',
      partial: 'Resultados parciais guardados',
      error: 'Ocorreu um erro no processamento',
    },
    count: {
      frames_one: '{{frames}} fotograma',
      frames_other: '{{frames}} fotogramas',
      frames_many: '{{frames}} fotogramas',
      framesUnknown: '? fotogramas',
      regions_one: '{{count}} área personalizada ↗',
      regions_other: '{{count}} áreas personalizadas ↗',
      regions_many: '{{count}} áreas personalizadas ↗',
    },
    dom: {
      noCompressionStream:
        'Este navegador não tem CompressionStream, necessário para codificar cada bloco no tamanho original em PNG. Não é possível iniciar a reconstrução.',
    },
    canvases: {
      badgePresentation: 'Com moldura · o fundo ampliado não veio da gravação',
      badgeFixed: 'Camada fixa / de observação',
      badgeMoving: 'Camada de conteúdo 2D',
      badge_one: '{{kind}} · {{count}} bloco no tamanho original{{fragment}}',
      badge_other: '{{kind}} · {{count}} blocos no tamanho original{{fragment}}',
      badge_many: '{{kind}} · {{count}} blocos no tamanho original{{fragment}}',
      fragmentNote: ' · o alinhamento entre fragmentos não foi confirmado',
    },
    diagnostics: {
      occurrenceSuffix: ' (ocorrências deste tipo: {{count}})',
      locateAction: 'Ver área afetada / imagem original ↗',
      viewSourceAction: 'Ver o momento original ↗',
      emptyFiltered: 'Nenhum registo com este filtro.',
      emptyDefault: 'As decisões de posicionamento, mudanças na página, inferências e erros aparecerão aqui.',
      noOriginalVideo:
        'O vídeo original não está incluído no projeto. Escolha novamente a gravação correspondente para consultar os momentos indicados. O resultado composto continua guardado neste dispositivo.',
      hashMismatch:
        'O nome e o tamanho do ficheiro correspondem, mas o hash do conteúdo é diferente do da gravação usada neste projeto. Por isso, não será usado como evidência do momento original. Escolha o ficheiro correto.',
      sourceCaption: 'Fotograma original {{frame}} · {{time}} s · {{message}}',
    },
    export: {
      imageSuffix: '-captura',
      savePickerFallback: 'Não é possível guardar diretamente. Será usada a transferência pelo navegador: {{error}}',
      saveRowLabel: 'Guardar {{name}} · {{size}}',
      shareLabel: 'Partilhar / guardar em Fotografias',
      shareFailed: 'Não foi possível partilhar: {{error}}',
      cleanupLabel: 'Apagar cópia temporária após guardar',
      exportErrorAction:
        'A exportação não terminou e não foi marcada como concluída. Os blocos do projeto já guardados continuam neste dispositivo.',
      clipboardUnsupported: 'Este navegador não permite copiar imagens. Use «Transferir captura».',
      copyNoImage: 'Nenhuma imagem foi gerada',
      copyFailedCtor: 'Não foi possível copiar: {{error}}. Use «Transferir captura».',
      copySuccess: 'Captura de {{width}} × {{height}} copiada. Já pode colá-la.',
      copyFailed:
        'Não foi possível copiar: {{error}}. A imagem pode ultrapassar o limite da área de transferência. Use «Transferir captura».',
    },
    crop: {
      buttonCropped: 'Recorte · {{width}} × {{height}}',
      applied:
        'Recorte aplicado. As transferências, cópias e exportações por páginas passam a incluir apenas esta área ({{width}} × {{height}}). O ZIP do projeto completo não é recortado.',
      removed: 'Recorte removido. As exportações voltam a incluir a captura inteira.',
    },
    main: {
      offscreenMissing: 'Este navegador não tem OffscreenCanvas. O worker de renderização não pode ser executado.',
      webcodecsMissingToast:
        'Este navegador não tem WebCodecs. Escolha «Aproximada · leitor nativo» para continuar, mas alguns fotogramas podem ser perdidos.',
      privateStorageToast:
        'Navegação privada: o projeto fica apenas na memória desta janela e desaparece ao fechá-la. Exporte antes de fechar se quiser guardar.',
      noOpfsNoPicker:
        'Este navegador não tem OPFS nem uma caixa de diálogo para guardar ficheiros. A exportação será gerada na memória, com limite de {{mb}} MB.',
      dbOpenFailed: 'Não foi possível abrir a base de dados local: {{error}}',
      workerErrorToast: 'Erro no worker: {{message}}',
      workerMessageUndecodable: 'Não foi possível interpretar uma mensagem do worker. Preserve os resultados atuais e recarregue a página.',
      interruptedPhaseWhere: '«{{phase}}», fotograma {{frames}}',
      interruptedStartPhase: 'fase inicial',
      interruptedHiddenSome: 'a página esteve em segundo plano durante cerca de {{seconds}} s{{stillHidden}}',
      interruptedStillHidden: ' (ainda estava em segundo plano na interrupção)',
      interruptedHiddenNone: 'a página esteve sempre em primeiro plano',
      interruptedDiagnosticMessage:
        'A reconstrução anterior foi interrompida em {{where}}. A página não recebeu o sinal de conclusão: o navegador descartou-a ou a página bloqueou. Tempo decorrido: {{elapsed}} s; memória do núcleo: {{memory}} MB; {{hidden}}; conversão de fotogramas: {{conversion}}; núcleos de CPU: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'O Safari aplica um limite de memória muito inferior às páginas em segundo plano e pode descartá-las. Mantenha este separador em primeiro plano durante processamentos longos. O registo completo foi gravado na consola do navegador.',
      interruptedNotIsolated: ' (sem isolamento entre origens, uma única thread)',
      interruptedToast: 'A reconstrução anterior foi interrompida em {{where}} ({{hidden}}). Consulte os diagnósticos.',
      unknownValue: 'desconhecido',
    },
    run: {
      pausedStatus: 'Em pausa · estado mantido na memória',
      resumedStatus: 'A retomar',
      pauseLabel: 'Pausa',
      resumeLabel: 'Continuar',
      stopToast: 'A terminar a etapa atual, compor e guardar o máximo possível do conteúdo observado.',
      preparingStatus: 'A preparar a descodificação exata',
      preparingMessage: 'A ler o contentor e a verificar o suporte para o codec e o armazenamento local.',
      compatibilityNeedsNative: 'O modo «Aproximada · leitor nativo» precisa que o leitor do navegador consiga ler este vídeo.',
      webcodecsHttpBlocked:
        'O navegador não disponibiliza WebCodecs neste endereço HTTP. Pode continuar o teste local com «Aproximada · leitor nativo». A descodificação exata exige localhost ou HTTPS. O vídeo não é enviado.',
      webcodecsMissing:
        'Este navegador não tem WebCodecs. Atualize o Safari ou o iOS, ou escolha «Aproximada · leitor nativo», que pode perder alguns fotogramas.',
      startFailedStatus: 'Não foi possível iniciar a reconstrução',
      restoredMessage: 'Este é o seu último resultado. Após 24 horas, será apagado da próxima vez que a página abrir.',
      interruptedStatus: 'O último processamento não terminou',
      interruptedMessage:
        'Esta é a parte guardada antes da interrupção. Para obter o resultado completo, volte a adicionar a gravação e recomece.',
      waitingCanvasOption: 'A aguardar a reconstrução de uma área',
    },
    source: {
      busyToast: 'Termine ou guarde o processamento atual primeiro.',
      subtitleReading: '{{size}} · sem envio · a ler o contentor e o primeiro fotograma',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · apenas o leitor nativo consegue ler',
      subtitleUnavailable: '{{size}} · descodificação exata e pré-visualização nativa indisponíveis',
      probeFailedMessage: 'Falha na verificação da descodificação exata: {{error}}',
      probeFailedAction:
        'Os metadados serão lidos com o leitor do navegador, se possível. Para continuar, escolha «Aproximada · leitor nativo» como modo de descodificação.',
      rejectedVideo:
        '«{{name}}» é {{kind}}. O navegador não consegue ler este formato fotograma a fotograma, pelo que não foi aberto. Configure o gravador para guardar em MP4 ou converta o ficheiro com HandBrake ou ffmpeg.',
      rejectedOther:
        '«{{name}}» não é um vídeo ({{kind}}), pelo que não foi aberto. Escolha uma gravação do ecrã feita enquanto percorre uma página: MP4, MOV, WebM ou MKV. No Windows, use a Ferramenta de Recorte ou a Xbox Game Bar (Win+Alt+R); no Mac, prima ⌘⇧5; no telemóvel, use a gravação do ecrã do sistema.',
      unreadableToast:
        'Não foi possível ler este vídeo ({{reason}}). Verifique se a gravação terminou corretamente e se o ficheiro foi copiado ou transferido na íntegra. Se continuar a falhar, experimente um MP4 com H.264. Os diagnósticos explicam por que razão a descodificação exata falhou.',
      kind: {
        empty: 'um ficheiro vazio',
        heif: 'uma imagem HEIC/AVIF',
        avi: 'um vídeo AVI',
        webp: 'uma imagem WebP',
        wav: 'um ficheiro de áudio WAV',
        riff: 'um ficheiro RIFF',
        wmv: 'um vídeo WMV/ASF',
        flv: 'um vídeo FLV',
        mpegps: 'um vídeo MPEG-PS',
        ogg: 'um ficheiro multimédia Ogg',
        gif: 'uma animação GIF',
        png: 'uma imagem PNG',
        jpeg: 'uma imagem JPEG',
        pdf: 'um documento PDF',
        zip: 'um ficheiro ZIP ou documento do Office',
        mp3: 'um ficheiro de áudio MP3',
        text: 'um ficheiro de texto',
        mpegts: 'um vídeo MPEG-TS',
        unknown: 'um ficheiro não reconhecido',
      },
    },
    demo: {
      fileName: 'gravacao-de-exemplo.mp4',
      loadFailed: 'Não foi possível carregar a gravação de exemplo: {{error}}',
    },
    feedback: {
      issueBody:
        '**O que aconteceu?**\n\n\n**Qual era o resultado esperado?**\n\n\n**Sobre a gravação** (que página gravou, como se deslocou e quanto tempo durou; uma captura ajuda, mas oculte informações privadas)\n\n\n---\nPreenchido pelo Long Screen. Pode editar ou apagar:\n- Navegador: {{browser}}\n- Página de origem: {{page}}\n- Núcleo com várias threads (isolamento entre origens): {{threads}}\n- Avisos no registo: {{warnings}}\n',
      portable: 'versão portátil (ficheiro local)',
      yes: 'sim',
      no: 'não',
      none: 'nenhum',
    },
    viewer: {
      previewLevel: 'Pré-visualização L{{level}} (tamanho original preservado)',
      nativeLevel: 'Píxeis originais L0',
      qualityHint: ' · amplie para ver a máscara de qualidade',
      unobservedHint: ' · azul = sem evidência de observação',
      provisionalHint: ' · roxo = conteúdo passageiro ou sobreposto',
    },
  },
  names: {
    fixed: 'Interface fixa',
    divider: 'Divisor fixo',
    contentCanvas: 'Área de conteúdo {{n}}',
    unassigned: 'Área não definida · observações em coordenadas do ecrã',
    contentRegion: 'Região de conteúdo {{n}}',
    ignored: 'Ignorado',
    fragment: 'fragmento sem posição {{n}}',
    framed: 'com moldura',
  },
};
