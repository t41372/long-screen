import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Analisando quadros e separando camadas em movimento',
      solving: 'Posicionando o conteúdo e refinando os pixels originais',
      optimizing: 'Corrigindo reencontros e desvios acumulados',
      rendering: 'Compondo a área no tamanho original',
      revealing: 'Removendo elementos que flutuam sobre a página',
      framing: 'Preservando a moldura e as proporções originais',
      pyramid: 'Criando uma prévia com zoom',
      complete: 'Concluído · confira os diagnósticos',
      partial: 'Resultados parciais salvos',
      error: 'Ocorreu um erro no processamento',
    },
    count: {
      frames_one: '{{frames}} quadro',
      frames_other: '{{frames}} quadros',
      frames_many: '{{frames}} quadros',
      framesUnknown: '? quadros',
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
      emptyFiltered: 'Nenhum registro com este filtro.',
      emptyDefault: 'As decisões de posicionamento, mudanças na página, inferências e erros aparecerão aqui.',
      noOriginalVideo:
        'O vídeo original não está incluído no projeto. Escolha novamente a gravação correspondente para consultar os momentos indicados. O resultado composto continua salvo neste dispositivo.',
      hashMismatch:
        'O nome e o tamanho do arquivo correspondem, mas o hash do conteúdo é diferente da gravação usada neste projeto. Por isso, ele não será usado como evidência do momento original. Escolha o arquivo correto.',
      sourceCaption: 'Quadro original {{frame}} · {{time}} s · {{message}}',
    },
    export: {
      imageSuffix: '-captura',
      savePickerFallback: 'Não é possível salvar diretamente. Usando o download do navegador: {{error}}',
      saveRowLabel: 'Salvar {{name}} · {{size}}',
      shareLabel: 'Compartilhar / salvar em Fotos',
      shareFailed: 'Não foi possível compartilhar: {{error}}',
      cleanupLabel: 'Apagar cópia temporária após salvar',
      exportErrorAction:
        'A exportação não terminou e não foi marcada como concluída. Os blocos do projeto já salvos continuam neste dispositivo.',
      clipboardUnsupported: 'Este navegador não permite copiar imagens. Use “Baixar captura”.',
      copyNoImage: 'Nenhuma imagem foi gerada',
      copyFailedCtor: 'Não foi possível copiar: {{error}}. Use “Baixar captura”.',
      copySuccess: 'Captura de {{width}} × {{height}} copiada. Agora é só colar.',
      copyFailed: 'Não foi possível copiar: {{error}}. A imagem pode ultrapassar o limite da área de transferência. Use “Baixar captura”.',
    },
    crop: {
      buttonCropped: 'Recorte · {{width}} × {{height}}',
      applied:
        'Recorte aplicado. Downloads, cópias e exportações por páginas agora incluem apenas esta área ({{width}} × {{height}}). O ZIP do projeto completo não é recortado.',
      removed: 'Recorte removido. As exportações voltam a incluir a captura inteira.',
    },
    main: {
      offscreenMissing: 'Este navegador não tem OffscreenCanvas. O worker de renderização não pode ser executado.',
      webcodecsMissingToast:
        'Este navegador não tem WebCodecs. Escolha “Aproximada · player nativo” para continuar, mas alguns quadros podem ser perdidos.',
      privateStorageToast:
        'Navegação privada: o projeto fica apenas na memória desta janela e desaparece ao fechá-la. Exporte antes de fechar se quiser guardar.',
      noOpfsNoPicker:
        'Este navegador não tem OPFS nem uma caixa de diálogo para salvar arquivos. A exportação será gerada na memória, com limite de {{mb}} MB.',
      dbOpenFailed: 'Não foi possível abrir o banco de dados local: {{error}}',
      workerErrorToast: 'Erro no worker: {{message}}',
      workerMessageUndecodable: 'Não foi possível interpretar uma mensagem do worker. Preserve os resultados atuais e recarregue a página.',
      interruptedPhaseWhere: '“{{phase}}”, quadro {{frames}}',
      interruptedStartPhase: 'fase inicial',
      interruptedHiddenSome: 'a página ficou em segundo plano por cerca de {{seconds}} s{{stillHidden}}',
      interruptedStillHidden: ' (ainda estava em segundo plano na interrupção)',
      interruptedHiddenNone: 'a página ficou em primeiro plano o tempo todo',
      interruptedDiagnosticMessage:
        'A reconstrução anterior foi interrompida em {{where}}. A página não recebeu o sinal de conclusão: o navegador a descartou ou ela travou. Tempo decorrido: {{elapsed}} s; memória do núcleo: {{memory}} MB; {{hidden}}; conversão de quadros: {{conversion}}; núcleos de CPU: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'O Safari aplica um limite de memória muito menor a páginas em segundo plano e pode descartá-las. Mantenha esta aba em primeiro plano durante processamentos longos. O registro completo foi gravado no console do navegador.',
      interruptedNotIsolated: ' (sem isolamento entre origens, uma única thread)',
      interruptedToast: 'A reconstrução anterior foi interrompida em {{where}} ({{hidden}}). Consulte os diagnósticos.',
      unknownValue: 'desconhecido',
    },
    run: {
      pausedStatus: 'Em pausa · estado mantido na memória',
      resumedStatus: 'Retomando',
      pauseLabel: 'Pausar',
      resumeLabel: 'Continuar',
      stopToast: 'Finalizando a etapa atual e compondo e salvando o máximo possível do conteúdo observado.',
      preparingStatus: 'Preparando a decodificação exata',
      preparingMessage: 'Lendo o contêiner e verificando o suporte ao codec e o armazenamento local.',
      compatibilityNeedsNative: 'O modo “Aproximada · player nativo” precisa que o player do navegador consiga ler este vídeo.',
      webcodecsHttpBlocked:
        'O navegador não libera WebCodecs neste endereço HTTP. Você pode continuar o teste local com “Aproximada · player nativo”. A decodificação exata exige localhost ou HTTPS. O vídeo não é enviado.',
      webcodecsMissing:
        'Este navegador não tem WebCodecs. Atualize o Safari ou o iOS, ou escolha “Aproximada · player nativo”, que pode perder alguns quadros.',
      startFailedStatus: 'Não foi possível iniciar a reconstrução',
      restoredMessage: 'Este é seu último resultado. Após 24 horas, ele será apagado na próxima vez que a página abrir.',
      interruptedStatus: 'O último processamento não terminou',
      interruptedMessage:
        'Esta é a parte salva antes da interrupção. Para obter o resultado completo, coloque a gravação de novo e recomece.',
      waitingCanvasOption: 'Aguardando a reconstrução de uma área',
    },
    source: {
      busyToast: 'Termine ou salve o processamento atual primeiro.',
      subtitleReading: '{{size}} · sem upload · lendo o contêiner e o primeiro quadro',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · somente o player nativo consegue ler',
      subtitleUnavailable: '{{size}} · decodificação exata e prévia nativa indisponíveis',
      probeFailedMessage: 'Falha na verificação da decodificação exata: {{error}}',
      probeFailedAction:
        'Os metadados serão lidos com o player do navegador, se possível. Para continuar, escolha “Aproximada · player nativo” como modo de decodificação.',
      rejectedVideo:
        '“{{name}}” é {{kind}}. O navegador não consegue ler esse formato quadro a quadro, por isso ele não foi aberto. Configure o gravador para salvar em MP4 ou converta o arquivo com HandBrake ou ffmpeg.',
      rejectedOther:
        '“{{name}}” não é um vídeo ({{kind}}), por isso não foi aberto. Escolha uma gravação de tela percorrendo uma página: MP4, MOV, WebM ou MKV. No Windows, use a Ferramenta de Captura ou a Xbox Game Bar (Win+Alt+R); no Mac, pressione ⌘⇧5; no celular, use a gravação de tela do sistema.',
      unreadableToast:
        'Não foi possível ler este vídeo ({{reason}}). Confira se a gravação terminou corretamente e se o arquivo foi copiado ou baixado por completo. Se continuar falhando, tente um MP4 com H.264. Os diagnósticos explicam por que a decodificação exata falhou.',
      kind: {
        empty: 'um arquivo vazio',
        heif: 'uma imagem HEIC/AVIF',
        avi: 'um vídeo AVI',
        webp: 'uma imagem WebP',
        wav: 'um arquivo de áudio WAV',
        riff: 'um arquivo RIFF',
        wmv: 'um vídeo WMV/ASF',
        flv: 'um vídeo FLV',
        mpegps: 'um vídeo MPEG-PS',
        ogg: 'um arquivo de mídia Ogg',
        gif: 'uma animação GIF',
        png: 'uma imagem PNG',
        jpeg: 'uma imagem JPEG',
        pdf: 'um documento PDF',
        zip: 'um arquivo ZIP ou documento do Office',
        mp3: 'um arquivo de áudio MP3',
        text: 'um arquivo de texto',
        mpegts: 'um vídeo MPEG-TS',
        unknown: 'um arquivo não reconhecido',
      },
    },
    demo: { fileName: 'gravacao-de-exemplo.mp4', loadFailed: 'Não foi possível carregar a gravação de exemplo: {{error}}' },
    feedback: {
      issueBody:
        '**O que aconteceu?**\n\n\n**Qual era o resultado esperado?**\n\n\n**Sobre a gravação** (qual página, como você se moveu e quanto tempo durou; uma captura ajuda, mas esconda informações privadas)\n\n\n' +
        '---\nPreenchido pelo Long Screen. Edite ou apague como preferir:\n- Navegador: {{browser}}\n- Página de origem: {{page}}\n- Núcleo com várias threads (isolamento entre origens): {{threads}}\n- Avisos no registro: {{warnings}}\n',
      portable: 'versão portátil (arquivo local)',
      yes: 'sim',
      no: 'não',
      none: 'nenhum',
    },
    viewer: {
      previewLevel: 'Prévia L{{level}} (tamanho original preservado)',
      nativeLevel: 'Pixels originais L0',
      qualityHint: ' · amplie para ver a máscara de qualidade',
      unobservedHint: ' · azul = sem evidência de observação',
      provisionalHint: ' · roxo = conteúdo passageiro ou sobreposto',
    },
  },
  names: {
    fixed: 'Interface fixa',
    divider: 'Divisor fixo',
    contentCanvas: 'Área de conteúdo {{n}}',
    unassigned: 'Área não definida · observações em coordenadas de tela',
    contentRegion: 'Região de conteúdo {{n}}',
    ignored: 'Ignorado',
    fragment: 'fragmento sem posição {{n}}',
    framed: 'com moldura',
  },
};
