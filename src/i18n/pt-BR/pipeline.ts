import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'A reconstrução usa superfícies em camadas que se deslocam, com restrições geométricas quando o percurso reencontra uma área já vista. As máscaras automáticas e a detecção de áreas dinâmicas são inferências heurísticas; as pontuações de confiança não são probabilidades calibradas de acerto. A comparação em coordenadas globais usa o ruído de decodificação declarado pela fonte, em níveis de intensidade: ±{{noise}}{{margin}}.',
      marginLossy: ' (margem para oscilações de compressão e reconstrução de crominância)',
      marginLossless: ' (fonte sem perdas, comparação exata pixel a pixel)',
      action: 'Quando a escala ou a estrutura são incompatíveis, um fragmento independente é preservado, sem forçar a união.',
    },
    APPROXIMATE_DECODER: {
      message:
        'O modo “Aproximada · player nativo” foi ativado manualmente a {{fps}} Hz. Não há garantia de capturar todos os quadros; conteúdo que aparece por pouco tempo pode ficar de fora.',
      action: 'Para garantir a cobertura quadro a quadro, use uma entrada compatível com WebCodecs, como H.264 ou VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'A análise de movimento limita o lado maior a {{size}}px. O refinamento e a composição final usam os pixels na resolução original, sem reduzir o resultado.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Um quadro no tamanho original e seus quadros de referência estão perto do limite de cache escolhido. Esse limite do JavaScript não controla a memória do decodificador nem da GPU.',
      action:
        'A resolução de saída nunca é reduzida sem aviso. Se faltar memória, os dados já salvos são preservados e a falha é informada.',
    },
    RUN_FAILURE: {
      action:
        'Os blocos já gravados no armazenamento local continuam disponíveis para consulta e exportação. A falha não foi marcada como sucesso.',
    },
    PERSISTENCE_ERROR: { action: 'A gravação no armazenamento também falhou. Só é possível recuperar os dados salvos anteriormente.' },
    MEMORY_BUDGET_RAISED: {
      message:
        'Para comportar todos os blocos usados por um quadro, a capacidade do cache aumentou de {{from}} para {{to}}, cerca de {{mb}} MB.',
      action:
        'Um cache menor que a cobertura de um quadro obrigaria a decodificar e codificar todos os seus blocos novamente a cada quadro. Para usar menos memória, reduza a resolução da gravação.',
    },
    NONFINITE_POSE: {
      message:
        'O cálculo de posição produziu um valor não finito. Esta observação foi isolada e as coordenadas inválidas não foram aplicadas à área de composição.',
    },
    MISSING_PLAN: {
      message: 'A etapa de renderização não encontrou plan/{{index}} e parou no último ponto salvo.',
      action: 'Confira a integridade do armazenamento local. Um plano de posicionamento ausente não é tratado como uma observação vazia.',
    },
    prefixOnly: {
      base: {
        scan: 'O posicionamento e a composição continuam apenas com os quadros já decodificados ({{frames}})',
        solve: 'A renderização continua apenas com os quadros já posicionados ({{frames}})',
        render: 'Serão mantidos apenas os resultados dos quadros já renderizados ({{frames}})',
      },
      suffixPersistence: '; a gravação no armazenamento parou.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action: 'A versão com moldura desta área não foi gerada. A reconstrução principal em coordenadas da página não foi afetada.',
    },
    PRESENTATION_FRAME: {
      message:
        'A versão com moldura e o conteúdo 2D original são guardados separadamente. A moldura vem de um quadro de referência; a parte ampliada é apenas fundo decorativo e não conta como conteúdo observado. Os ícones da barra de ferramentas não são esticados nem duplicados. Os outros painéis dentro da moldura são apenas imagens de referência.',
    },
    PRESENTATION_STAGE_FAILED: {
      action:
        'A criação da versão com moldura falhou. O resultado e o estado da reconstrução principal em coordenadas da página não foram afetados.',
    },
    PYRAMID_FAILED: {
      action:
        'Não foi possível criar os níveis de prévia. Os blocos no tamanho original não foram afetados e continuam disponíveis para consulta e exportação.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: 'A etapa {{pass}} não processou todos os quadros: {{actual}} de {{expected}}. O resultado foi marcado como parcial.',
      action: 'A parte já salva foi mantida. Os quadros ausentes não foram considerados processados.',
    },
    FRAME_CONVERSION: { message: 'Método usado para converter cada quadro decodificado em pixels: {{method}}.' },
    HDR_UNCHECKED: {
      message:
        'Esta gravação é HDR ({{transfer}}), mas o navegador não permite conferir a conversão de cores. A captura pode ficar escura ou desbotada.',
      action: 'Processe de novo em uma versão atualizada do Chrome ou Safari.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'No primeiro quadro HDR, {{percent}}% dos pixels são mais claros que o branco comum e foram tratados como branco. Se a captura parecer superexposta, o gravador provavelmente atribuiu um brilho maior ao branco comum.',
      action: 'Ajuste o branco SDR do gravador para 100 nits ou desative a gravação HDR.',
    },
    SLOW_CONVERSION: {
      message:
        'Este navegador leva cerca de {{ms}} ms para converter cada quadro em pixels. Só a conversão da gravação inteira levará cerca de {{minutes}} min.',
      action: 'Uma versão atualizada do Chrome ou Safari é bem mais rápida. Converter a gravação para H.264 antes também ajuda.',
    },
    REVEAL_SKIPPED: {
      message:
        'Esta captura tem áreas demais ou muito grandes. A remoção de sobreposições, como cursor, botões flutuantes e barras de rolagem, exigiria cerca de {{need}} MB além da memória disponível. Essa etapa foi pulada e os pixels já unidos foram preservados.',
      action:
        'O restante do resultado não foi afetado. Muitas áreas costumam indicar que partes da gravação não puderam ser unidas às anteriores. Uma gravação mais curta ou um computador com mais memória pode ajudar.',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}. Núcleo Rust: variante {{variant}}, threads de processamento: {{threads}} ({{coreReason}}).',
    },
    PRESENTATION_REFERENCE_FAILED: {
      action: 'A versão com moldura não será gerada. A reconstrução principal em coordenadas da página não foi afetada.',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'O quadro não tem textura reconhecível suficiente. Quadros vazios idênticos podem indicar uma pausa ou movimento por uma área em branco; os pixels sozinhos não permitem distinguir.',
      action:
        'Inclua conteúdo visível que possa ser distinguido ou grave com mais sobreposição. O deslocamento zero aqui é apenas a melhor estimativa disponível.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Esta observação não tem uma referência visual confiável para alinhamento. A etapa de posicionamento tentará compará-la com conteúdo anterior; se ainda não for possível posicionar, ela será mantida como fragmento independente.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'Foi detectada uma textura repetida com várias correspondências igualmente plausíveis. A continuidade ajuda a estimar a posição, mas não comprova uma posição única.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message:
        'Este quadro cobre um intervalo de tempo incomumente longo. Durante movimentos rápidos, algumas áreas podem não ter sido capturadas.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'A parte fora das áreas marcadas manualmente é mantida como uma camada independente de observação, com baixa confiança, em coordenadas de tela. Não se afirma que esses pixels tenham sido posicionados nas coordenadas da página.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Uma área de “ignorar” foi excluída conforme a seleção manual. Ela não contribui para a reconstrução; isso não é uma perda automática de quadros.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Quando áreas manuais se sobrepõem, a desenhada por último tem prioridade. Áreas ignoradas são sempre excluídas. Os demais pixels ficam na camada de observação não definida.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Áreas detectadas automaticamente: {{moving}} de conteúdo e {{fixed}} de interface fixa. Os limites vêm das estatísticas de movimento dos pixels, não do DOM.',
      action:
        'Se uma máscara estiver atribuída à área errada, marque a região de rolagem com precisão em “Áreas de movimento” e processe de novo.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message:
        'Cada área com rolagem independente terá sua própria superfície de composição. Elas não são forçadas a compartilhar o mesmo deslocamento.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Após o alinhamento deste quadro, foram encontrados pixels claramente diferentes na sobreposição: {{conflicts}} no total. Esta região é um dos componentes em conflito. As causas podem incluir animação, atualização de conteúdo, mudança de layout ou erro residual de alinhamento.',
      actionStable:
        'Sempre que possível, a área inteira em conflito foi fixada em um único momento. Confira os diagnósticos laranja e o momento correspondente no vídeo original.',
      actionRolling:
        'A área inteira em conflito só é atualizada com o mesmo quadro quando está totalmente visível. Isso não significa que a página toda corresponda ao mesmo instante.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Esta área em mudança nunca apareceu inteira em uma imagem utilizável. Não é possível garantir que todos os seus pixels venham do mesmo instante.',
      action:
        'O conteúdo observado e as marcações explícitas de conflito foram preservados. As partes não observadas não foram inventadas.',
    },
    MISSING_SCAN_RECORD: {
      message: 'A etapa de posicionamento não encontrou scan/{{index}} e parou no último ponto salvo.',
      action: 'Confira a integridade do armazenamento local. Um registro de análise ausente não é tratado como deslocamento zero.',
    },
    GRAPH_RESIDUAL: {
      message:
        'O erro residual máximo do grafo de posições, medido em pixels originais, ainda é de {{residual}}. As junções próximas podem apresentar inconsistência geométrica.',
      action: 'Confira o texto e as texturas repetidas perto do reencontro do percurso. Esse erro residual foi registrado, não ocultado.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Cerca de {{percent}}% dos blocos de textura discordam do deslocamento geral, por animação, vídeo, carregamento sob demanda ou mudança de layout. O deslocamento é determinado pelos blocos consistentes, e a área em conflito é tratada separadamente na composição.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'O movimento rápido entre quadros deixou pouca sobreposição para o alinhamento. O deslocamento foi deduzido dessa pequena referência. Em um layout que se repete, a repetição vizinha também poderia explicar os mesmos pixels.',
      action:
        'Se uma nova passagem trouxer evidências mais fortes, todo esse trecho da trajetória será corrigido e a alteração será registrada.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'A textura repetida permite que vários deslocamentos expliquem os pixels. Foi escolhida a solução mais consistente com a continuidade do movimento: a melhor estimativa disponível, não a única possibilidade correta.',
      messageLowConfidence:
        'A posição desta área foi estimada com baixa confiança. Os pixels afetados estão marcados na máscara de qualidade.',
      messageStatic:
        'Os dois quadros são quase idênticos, mas faltam correspondências verificáveis. Foram tratados como uma pausa, com deslocamento zero: apenas a melhor estimativa disponível.',
      action:
        'A trajetória contínua e as referências existentes foram usadas para estimar a posição. Não se afirma que seja o único alinhamento correto.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'Este quadro não tem textura reconhecível nesta área. Uma imagem em branco pode indicar pausa ou movimento sobre uma área vazia; os pixels sozinhos não permitem distinguir. Ele não é desenhado em nenhuma posição.',
      action:
        'Se o conteúdo após a área vazia não tiver sobreposição com o que já foi observado, será mantido como fragmento independente, sem adivinhar a distância entre eles.',
    },
    RELOCALIZED: {
      message:
        'O conteúdo foi reposicionado em uma área já observada usando uma referência visual anterior. O trecho revisitado não foi acrescentado como uma nova extensão da captura.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Foi detectada uma transformação de escala ou layout de aproximadamente {{scale}}×. O conteúdo foi preservado como fragmento independente, com os pixels originais, sem misturar escalas sem aviso.',
      action:
        'A relação entre os fragmentos ainda não foi confirmada. Se uma nova passagem permitir uma correspondência confiável, o fragmento será unido por inteiro. Grave novamente com mais sobreposição ou isole o componente que muda usando uma área manual.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'Não foi possível confirmar a posição em relação à área original. Foi preservado um fragmento independente, que pode ser exportado separadamente. Os fragmentos podem se sobrepor ou ter uma lacuna real entre eles.',
      action:
        'A relação entre os fragmentos ainda não foi confirmada. Se uma nova passagem permitir uma correspondência confiável, o fragmento será unido por inteiro. Grave novamente com mais sobreposição ou isole o componente que muda usando uma área manual.',
    },
    STICKY_OCCLUSION: {
      message:
        'A textura no topo indica uma interface fixa na tela, não movimento da página. Essa obstrução fixa não é gravada na camada móvel. A interface original de referência é preservada na versão com moldura.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'As evidências de uma nova passagem permitiram unir um fragmento independente inteiro a uma área existente. A trajetória relativa dentro do fragmento não mudou.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'O passo anterior tinha pouca sobreposição. A correspondência deste quadro com conteúdo já observado difere em {{discrepancy}}px e tem evidências mais fortes. A posição atual foi corrigida com base nela.',
      action:
        'A correção afeta este quadro e a trajetória seguinte. Os pixels gravados antes permanecem iguais e podem formar uma junção visível com as coordenadas corrigidas.',
    },
    LOOP_CLOSURE: {
      message:
        'Foi encontrada uma correspondência confiável com uma passagem anterior e adicionada como restrição global de posição. A composição final usa a trajetória corrigida.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'A correspondência histórica difere da trajetória contínua em {{discrepancy}}px. As evidências entram em conflito, então ela não foi imposta como restrição de fechamento do percurso.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'A busca no histórico encontrou várias posições quase igualmente plausíveis. O fechamento incerto do percurso não foi imposto como restrição obrigatória.',
    },
  },
  progress: {
    runPartial: 'A reconstrução disponível foi salva e marcada como parcial.',
    runComplete: 'Reconstrução concluída. Confira os diagnósticos e as áreas não observadas.',
    render: 'Compondo os blocos no tamanho original com o conteúdo observado. As lacunas ficam transparentes.',
    reveal: {
      learn: 'Revendo a gravação para encontrar botões, campos de entrada e barras de rolagem que flutuam sobre a página.',
      agree: 'Comparando cada parte da página ao longo do tempo e priorizando as imagens sem obstruções.',
      relearn: 'Identificando novamente os elementos flutuantes com a página já conferida.',
      write: 'Substituindo áreas cobertas ou inconsistentes pelo quadro sem obstrução.',
    },
    framingStart: 'Preservando a moldura original. Só o fundo é ampliado, sem esticar o texto lateral nem duplicar ícones.',
    pyramidBuild: 'Criando os níveis de prévia no disco. Os blocos no tamanho original não mudam.',
    scanFrame: 'Analisando a geometria quadro a quadro e identificando áreas de movimento independente.',
    duplicateReuse: 'Uma observação idêntica reutilizou a posição anterior. O quadro de origem e sua marca de tempo foram mantidos.',
    solveFrame:
      'Refinando com os pixels originais, buscando correspondências anteriores e aplicando restrições de fechamento do percurso em 2D.',
    optimizing: 'Otimizando o grafo de posições no disco e corrigindo os desvios acumulados nos reencontros do percurso.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: este navegador não consegue decodificar o codec da gravação ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'Gravações de iPhone e Mac costumam usar HEVC, que só alguns navegadores decodificam. Use Safari, ou Chrome ou Edge com decodificação por hardware.',
      prores: 'Nenhum navegador decodifica ProRes. Primeiro exporte a gravação como H.264 ou HEVC.',
      h264: 'Só o Chrome decodifica este tipo de H.264 (4:4:4 ou 10 bits). Use Chrome ou exporte como H.264 comum.',
      av1: 'AV1 exige um navegador ou hardware recente. Use o Chrome atualizado ou exporte a gravação como H.264.',
      other: 'Use Chrome ou Safari atualizado, ou converta a gravação para H.264 primeiro.',
    },
    PIXEL_ASPECT_RATIO:
      'A gravação declara uma proporção de pixel de {{num}}:{{den}}. Os pixels armazenados são mantidos sem redimensionamento, então a proporção exibida pode ser diferente.',
    CONTAINER_SIZE_MISMATCH:
      'O contêiner declara {{codedWidth}}×{{codedHeight}}, mas o fluxo de vídeo tem {{bitstreamWidth}}×{{bitstreamHeight}}. O tamanho real do fluxo é o que vale.',
    NON_SQUARE_PIXELS:
      'A gravação declara pixels não quadrados: tamanho de exibição {{displayWidth}}×{{displayHeight}}, tamanho armazenado {{bitstreamWidth}}×{{bitstreamHeight}}. Os pixels originais armazenados são mantidos sem redimensionamento.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'O decodificador produziu um quadro anterior ao início da lista de edição, com marca de tempo negativa. Esses quadros não são exibidos, conforme as regras do contêiner.',
    NONMONOTONIC_TIMESTAMP:
      'Uma marca de tempo do contêiner voltou para trás. O processamento continuou na ordem de apresentação do decodificador, sem descartar observações.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: A caixa ctts desta faixa de vídeo é da versão 0, mas contém deslocamentos negativos de tempo de composição. A ISO 14496-12 só define deslocamentos negativos na versão 1. Eles são tratados como valores com sinal, seguindo a prática comum do QuickTime e ReplayKit, e não como valores positivos anormalmente grandes.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: O arquivo termina dentro da caixa {{box}}, que declara terminar no byte {{declaredEnd}}, mas o arquivo tem apenas {{size}} bytes. A gravação pode não ter terminado corretamente, ou o arquivo pode ter sido cortado durante a cópia ou transferência. Os quadros após o corte não podem ser decodificados. A análise encontrará menos quadros do que os metadados indicam e o resultado será marcado como parcial.',
  },
  exports: {
    tilesProgress: 'Exportando blocos originais e de prévia: {{n}}',
    zipFinalize: 'Gravando o diretório ZIP64 e salvando o arquivo',
    projectDone: {
      message:
        'Foram exportados os blocos no tamanho original, o visualizador offline, os dados de cobertura e qualidade, os registros dos quadros de origem e os diagnósticos completos.',
    },
    encodingSingle: 'Codificando linha {{row}} de {{total}} no tamanho original',
    canvasDone: { message: 'PNG de {{width}} × {{height}} exportado no tamanho original. As lacunas continuam transparentes.' },
    encodingSheet: 'Páginas codificadas no tamanho original: {{count}}',
    sheetsDone: {
      messagePaged:
        'Exportação por páginas concluída. Total de imagens no tamanho original: {{count}}. Páginas vizinhas se sobrepõem em até {{overlap}}px; as coordenadas estão no manifesto.',
      messageOversize:
        'A área ultrapassou o tamanho compatível com uma única imagem e foi exportada por páginas. Total de imagens no tamanho original: {{count}}. Páginas vizinhas se sobrepõem em até {{overlap}}px; as coordenadas estão no manifesto.',
    },
  },
  offline: {
    title: 'Visualização offline',
    fit: 'Ajustar',
    tip: 'Blocos locais no tamanho original · arraste para mover / role para ampliar',
    previewLevel: 'Mostrando o nível de prévia {{level}}. Amplie para ver os pixels originais',
    nativeTiles: 'Mostrando os blocos no tamanho original',
    footer:
      'Áreas em xadrez não foram observadas ou não têm blocos. A confiança não é uma probabilidade de acerto. Consulte diagnostics.jsonl e observations.jsonl.',
  },
};
