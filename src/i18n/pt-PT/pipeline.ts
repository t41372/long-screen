import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'A reconstrução usa superfícies em camadas que se deslocam, com restrições geométricas quando o percurso reencontra uma área já vista. As máscaras automáticas e a deteção de áreas dinâmicas são inferências heurísticas; as pontuações de confiança não são probabilidades calibradas de acerto. A comparação em coordenadas globais usa o ruído de descodificação declarado pela fonte, em níveis de intensidade: ±{{noise}}{{margin}}.',
      marginLossy: ' (margem para oscilações de compressão e reconstrução de crominância)',
      marginLossless: ' (fonte sem perdas, comparação exata píxel a píxel)',
      action: 'Quando a escala ou a estrutura são incompatíveis, um fragmento independente é preservado, sem forçar a união.',
    },
    APPROXIMATE_DECODER: {
      message:
        'O modo «Aproximada · leitor nativo» foi ativado manualmente a {{fps}} Hz. Não há garantia de capturar todos os fotogramas; conteúdo que aparece por pouco tempo pode ficar de fora.',
      action: 'Para garantir a cobertura fotograma a fotograma, use uma entrada compatível com WebCodecs, como H.264 ou VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'A análise de movimento limita o lado maior a {{size}}px. O refinamento e a composição final usam os píxeis na resolução original, sem reduzir o resultado.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'Um fotograma no tamanho original e os respetivos fotogramas de referência estão perto do limite de memória escolhido para a cache. Esse limite do JavaScript não controla a memória do descodificador nem da GPU.',
      action:
        'A resolução de saída nunca é reduzida sem aviso. Se faltar memória, os dados já guardados são preservados e a falha é informada.',
    },
    RUN_FAILURE: {
      action:
        'Os blocos já gravados no armazenamento local continuam disponíveis para consulta e exportação. A falha não foi marcada como sucesso.',
    },
    PERSISTENCE_ERROR: {
      action: 'A gravação no armazenamento também falhou. Só é possível recuperar os dados guardados anteriormente.',
    },
    MEMORY_BUDGET_RAISED: {
      message:
        'Para acomodar todos os blocos usados por um fotograma, a capacidade da cache aumentou de {{from}} para {{to}}, cerca de {{mb}} MB.',
      action:
        'Uma cache menor que a cobertura de um fotograma obrigaria a descodificar e codificar todos os seus blocos novamente a cada fotograma. Para usar menos memória, reduza a resolução da gravação.',
    },
    NONFINITE_POSE: {
      message:
        'O cálculo de posição produziu um valor não finito. Esta observação foi isolada e as coordenadas inválidas não foram aplicadas à área de composição.',
    },
    MISSING_PLAN: {
      message: 'A etapa de renderização não encontrou plan/{{index}} e parou no último ponto guardado.',
      action: 'Verifique a integridade do armazenamento local. Um plano de posicionamento ausente não é tratado como uma observação vazia.',
    },
    prefixOnly: {
      base: {
        scan: 'O posicionamento e a composição continuam apenas com os fotogramas já descodificados ({{frames}})',
        solve: 'A renderização continua apenas com os fotogramas já posicionados ({{frames}})',
        render: 'Serão mantidos apenas os resultados dos fotogramas já renderizados ({{frames}})',
      },
      suffixPersistence: '; a gravação no armazenamento parou.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action: 'A versão com moldura desta área não foi gerada. A reconstrução principal em coordenadas da página não foi afetada.',
    },
    PRESENTATION_FRAME: {
      message:
        'A versão com moldura e o conteúdo 2D original são guardados separadamente. A moldura vem de um fotograma de referência; a parte ampliada é apenas fundo decorativo e não conta como conteúdo observado. Os ícones da barra de ferramentas não são esticados nem duplicados. Os outros painéis dentro da moldura são apenas imagens de referência.',
    },
    PRESENTATION_STAGE_FAILED: {
      action:
        'A criação da versão com moldura falhou. O resultado e o estado da reconstrução principal em coordenadas da página não foram afetados.',
    },
    PYRAMID_FAILED: {
      action:
        'Não foi possível criar os níveis de pré-visualização. Os blocos no tamanho original não foram afetados e continuam disponíveis para consulta e exportação.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: 'A etapa {{pass}} não processou todos os fotogramas: {{actual}} de {{expected}}. O resultado foi marcado como parcial.',
      action: 'A parte já guardada foi mantida. Os fotogramas ausentes não foram considerados processados.',
    },
    FRAME_CONVERSION: {
      message: 'Método usado para converter cada fotograma descodificado em píxeis: {{method}}.',
    },
    HDR_UNCHECKED: {
      message:
        'Esta gravação é HDR ({{transfer}}), mas o navegador não permite verificar a conversão de cores. A captura pode ficar escura ou desbotada.',
      action: 'Processe de novo numa versão atualizada do Chrome ou Safari.',
    },
    HDR_ABOVE_WHITE: {
      message:
        'No primeiro fotograma HDR, {{percent}}% dos píxeis são mais claros que o branco comum e foram tratados como branco. Se a captura parecer sobre-exposta, o gravador provavelmente atribuiu um brilho maior ao branco comum.',
      action: 'Ajuste o branco SDR do gravador para 100 nits ou desative a gravação HDR.',
    },
    SLOW_CONVERSION: {
      message:
        'Este navegador leva cerca de {{ms}} ms para converter cada fotograma em píxeis. Só a conversão da gravação inteira levará cerca de {{minutes}} min.',
      action: 'Uma versão atualizada do Chrome ou Safari é muito mais rápida. Converter previamente a gravação para H.264 também ajuda.',
    },
    REVEAL_SKIPPED: {
      message:
        'Esta captura tem demasiadas áreas ou áreas muito grandes. A remoção de sobreposições, como o cursor, os botões flutuantes e as barras de deslocamento, exigiria cerca de {{need}} MB além da memória disponível. Essa etapa foi ignorada e os píxeis já unidos foram preservados.',
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
        'O fotograma não tem textura reconhecível suficiente. Fotogramas vazios idênticos podem indicar uma pausa ou movimento por uma área em branco; só os píxeis não permitem distinguir as duas situações.',
      action:
        'Inclua conteúdo visível que possa ser distinguido ou grave com mais sobreposição. O deslocamento zero aqui é apenas a melhor estimativa disponível.',
    },
    UNRESOLVED_MOTION: {
      message:
        'Esta observação não tem uma referência visual fiável para alinhamento. A etapa de posicionamento tentará compará-la com conteúdo anterior; se ainda não for possível posicionar, ela será mantida como fragmento independente.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'Foi detetada uma textura repetida com várias correspondências igualmente plausíveis. A continuidade ajuda a estimar a posição, mas não comprova uma posição única.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message:
        'Este fotograma cobre um intervalo de tempo invulgarmente longo. Durante movimentos rápidos, algumas áreas podem não ter sido capturadas.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'A parte fora das áreas marcadas manualmente é mantida como uma camada independente de observação, com baixa confiança, em coordenadas do ecrã. Não se afirma que esses píxeis tenham sido posicionados nas coordenadas da página.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'Uma área de «ignorar» foi excluída conforme a seleção manual. Ela não contribui para a reconstrução; isso não é uma perda automática de fotogramas.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Quando as áreas manuais se sobrepõem, a desenhada por último tem prioridade. Áreas ignoradas são sempre excluídas. Os restantes píxeis ficam na camada de observação não definida.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Áreas detetadas automaticamente: {{moving}} de conteúdo e {{fixed}} de interface fixa. Os limites vêm das estatísticas de movimento dos píxeis, não do DOM.',
      action:
        'Se uma máscara estiver atribuída à área errada, marque a região de deslocamento com precisão em «Áreas de movimento» e processe de novo.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message:
        'Cada área com deslocamento independente terá a sua própria superfície de composição. Elas não são forçadas a partilhar o mesmo deslocamento.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'Após o alinhamento deste fotograma, foram encontrados píxeis claramente diferentes na sobreposição: {{conflicts}} no total. Esta região é um dos componentes em conflito. As causas podem incluir animação, atualização de conteúdo, alteração da disposição ou erro residual de alinhamento.',
      actionStable:
        'Sempre que possível, a área inteira em conflito foi fixada num único momento. Verifique os diagnósticos laranja e o momento correspondente no vídeo original.',
      actionRolling:
        'A área inteira em conflito só é atualizada com o mesmo fotograma quando está totalmente visível. Isso não significa que a página toda corresponda ao mesmo instante.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'Esta área em mudança nunca apareceu inteira numa imagem utilizável. Não é possível garantir que todos os seus píxeis venham do mesmo instante.',
      action:
        'O conteúdo observado e as marcações explícitas de conflito foram preservados. As partes não observadas não foram inventadas.',
    },
    MISSING_SCAN_RECORD: {
      message: 'A etapa de posicionamento não encontrou scan/{{index}} e parou no último ponto guardado.',
      action: 'Verifique a integridade do armazenamento local. Um registo de análise ausente não é tratado como deslocamento zero.',
    },
    GRAPH_RESIDUAL: {
      message:
        'O erro residual máximo do grafo de posições, medido em píxeis originais, ainda é de {{residual}}. As junções próximas podem apresentar inconsistência geométrica.',
      action: 'Verifique o texto e as texturas repetidas perto do reencontro do percurso. Esse erro residual foi registado, não ocultado.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'Cerca de {{percent}}% dos blocos de textura discordam do deslocamento geral, por animação, vídeo, carregamento diferido ou mudança de layout. O deslocamento é determinado pelos blocos consistentes, e a área em conflito é tratada separadamente na composição.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'O movimento rápido entre fotogramas deixou pouca sobreposição para o alinhamento. O deslocamento foi deduzido dessa pequena referência. Num layout que se repete, a repetição vizinha também poderia explicar os mesmos píxeis.',
      action:
        'Se uma nova passagem trouxer evidências mais fortes, todo este segmento da trajetória será corrigido e a alteração será registada.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'A textura repetida permite que vários deslocamentos expliquem os píxeis. Foi escolhida a solução mais consistente com a continuidade do movimento: a melhor estimativa disponível, não a única possibilidade correta.',
      messageLowConfidence:
        'A posição desta área foi estimada com baixa confiança. Os píxeis afetados estão marcados na máscara de qualidade.',
      messageStatic:
        'Os dois fotogramas são quase idênticos, mas faltam correspondências verificáveis. Foram tratados como uma pausa, com deslocamento zero: apenas a melhor estimativa disponível.',
      action:
        'A trajetória contínua e as referências existentes foram usadas para estimar a posição. Não se afirma que seja o único alinhamento correto.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'Este fotograma não tem textura reconhecível nesta área. Uma imagem em branco pode indicar uma pausa ou movimento sobre uma área vazia; só os píxeis não permitem distinguir as duas situações. O fotograma não é desenhado em nenhuma posição.',
      action:
        'Se o conteúdo após a área vazia não tiver sobreposição com o que já foi observado, será mantido como fragmento independente, sem adivinhar a distância entre eles.',
    },
    RELOCALIZED: {
      message:
        'O conteúdo foi reposicionado numa área já observada usando uma referência visual anterior. O segmento revisitado não foi acrescentado como uma nova extensão da captura.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Foi detetada uma transformação de escala ou disposição de aproximadamente {{scale}}×. O conteúdo foi preservado como fragmento independente, com os píxeis originais, sem misturar escalas sem aviso.',
      action:
        'A relação entre os fragmentos ainda não foi confirmada. Se uma nova passagem permitir uma correspondência fiável, o fragmento será unido por inteiro. Grave novamente com mais sobreposição ou isole o componente que muda usando uma área manual.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'Não foi possível confirmar a posição em relação à área original. Foi preservado um fragmento independente, que pode ser exportado separadamente. Os fragmentos podem sobrepor-se ou ter uma lacuna real entre eles.',
      action:
        'A relação entre os fragmentos ainda não foi confirmada. Se uma nova passagem permitir uma correspondência fiável, o fragmento será unido por inteiro. Grave novamente com mais sobreposição ou isole o componente que muda usando uma área manual.',
    },
    STICKY_OCCLUSION: {
      message:
        'A textura no topo indica uma interface fixa no ecrã, não movimento da página. Essa obstrução fixa não é gravada na camada móvel. A interface original de referência é preservada na versão com moldura.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'As evidências de uma nova passagem permitiram unir um fragmento independente inteiro a uma área existente. A trajetória relativa dentro do fragmento não mudou.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'O passo anterior tinha pouca sobreposição. A correspondência deste fotograma com conteúdo já observado difere em {{discrepancy}}px e tem evidências mais fortes. A posição atual foi corrigida com base nela.',
      action:
        'A correção afeta este fotograma e a trajetória seguinte. Os píxeis gravados antes permanecem iguais e podem formar uma junção visível com as coordenadas corrigidas.',
    },
    LOOP_CLOSURE: {
      message:
        'Foi encontrada uma correspondência fiável com uma passagem anterior e adicionada como restrição global de posição. A composição final usa a trajetória corrigida.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'A correspondência histórica difere da trajetória contínua em {{discrepancy}}px. As evidências entram em conflito, então ela não foi imposta como restrição de fecho do percurso.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'A procura no histórico encontrou várias posições quase igualmente plausíveis. O fecho incerto do percurso não foi imposto como restrição obrigatória.',
    },
  },
  progress: {
    runPartial: 'A reconstrução disponível foi guardada e marcada como parcial.',
    runComplete: 'Reconstrução concluída. Verifique os diagnósticos e as áreas não observadas.',
    render: 'A compor os blocos no tamanho original com o conteúdo observado. As lacunas ficam transparentes.',
    reveal: {
      learn: 'A rever a gravação para encontrar botões, campos de entrada e barras de deslocamento que flutuam sobre a página.',
      agree: 'A comparar cada parte da página ao longo do tempo, dando prioridade às imagens sem obstruções.',
      relearn: 'A identificar novamente os elementos flutuantes com a página já verificada.',
      write: 'A substituir áreas cobertas ou inconsistentes pelo fotograma sem obstrução.',
    },
    framingStart: 'A preservar a moldura original. Só o fundo é ampliado, sem esticar o texto lateral nem duplicar ícones.',
    pyramidBuild: 'A criar os níveis de pré-visualização no disco. Os blocos no tamanho original não mudam.',
    scanFrame: 'A analisar a geometria fotograma a fotograma e a identificar áreas de movimento independente.',
    duplicateReuse:
      'Uma observação idêntica reutilizou a posição anterior. O fotograma de origem e a respetiva marca temporal foram mantidos.',
    solveFrame:
      'A aperfeiçoar as posições com os píxeis originais, procurar correspondências anteriores e aplicar restrições de fecho do percurso em 2D.',
    optimizing: 'A otimizar o grafo de posições no disco e a corrigir os desvios acumulados nos reencontros do percurso.',
  },
  media: {
    UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC: este navegador não consegue descodificar o codec da gravação ({{codec}}). {{advice}}',
    UNSUPPORTED_ADVICE: {
      hevc:
        'Gravações de iPhone e Mac costumam usar HEVC, que só alguns navegadores descodificam. Use Safari, ou Chrome ou Edge com descodificação por hardware.',
      prores: 'Nenhum navegador descodifica ProRes. Primeiro exporte a gravação como H.264 ou HEVC.',
      h264: 'Só o Chrome descodifica este tipo de H.264 (4:4:4 ou 10 bits). Use Chrome ou exporte como H.264 comum.',
      av1: 'AV1 exige um navegador ou hardware recente. Use o Chrome atualizado ou exporte a gravação como H.264.',
      other: 'Use Chrome ou Safari atualizado, ou converta a gravação para H.264 primeiro.',
    },
    PIXEL_ASPECT_RATIO:
      'A gravação declara uma proporção de píxel de {{num}}:{{den}}. Os píxeis armazenados são mantidos sem redimensionamento, pelo que a proporção apresentada pode ser diferente.',
    CONTAINER_SIZE_MISMATCH:
      'O contentor declara {{codedWidth}}×{{codedHeight}}, mas o fluxo de vídeo tem {{bitstreamWidth}}×{{bitstreamHeight}}. Será usado o tamanho real do fluxo.',
    NON_SQUARE_PIXELS:
      'A gravação declara píxeis não quadrados: tamanho de apresentação {{displayWidth}}×{{displayHeight}}, tamanho armazenado {{bitstreamWidth}}×{{bitstreamHeight}}. Os píxeis originais armazenados são mantidos sem redimensionamento.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'O descodificador produziu um fotograma anterior ao início da lista de edição, com marca temporal negativa. Estes fotogramas não são apresentados, conforme as regras do contentor.',
    NONMONOTONIC_TIMESTAMP:
      'Uma marca temporal do contentor voltou para trás. O processamento continuou na ordem de apresentação do descodificador, sem descartar observações.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: A caixa ctts desta pista de vídeo é da versão 0, mas contém deslocamentos negativos de tempo de composição. A ISO 14496-12 só define deslocamentos negativos na versão 1. Eles são tratados como valores com sinal, seguindo a prática comum do QuickTime e ReplayKit, e não como valores positivos anormalmente grandes.',
    TRUNCATED_RECORDING:
      'TRUNCATED_RECORDING: O ficheiro termina dentro da caixa {{box}}, que declara terminar no byte {{declaredEnd}}, mas o ficheiro tem apenas {{size}} bytes. A gravação pode não ter terminado corretamente, ou o ficheiro pode ter sido cortado durante a cópia ou transferência. Os fotogramas após o corte não podem ser descodificados. A análise encontrará menos fotogramas do que os metadados indicam e o resultado será marcado como parcial.',
  },
  exports: {
    tilesProgress: 'A exportar blocos originais e de pré-visualização: {{n}}',
    zipFinalize: 'A escrever o diretório ZIP64 e a guardar o ficheiro',
    projectDone: {
      message:
        'Foram exportados os blocos no tamanho original, o visualizador sem ligação, os dados de cobertura e qualidade, os registos dos fotogramas de origem e os diagnósticos completos.',
    },
    encodingSingle: 'A codificar a linha {{row}} de {{total}} no tamanho original',
    canvasDone: {
      message: 'PNG de {{width}} × {{height}} exportado. As lacunas continuam transparentes.',
    },
    encodingSheet: 'Páginas codificadas no tamanho original: {{count}}',
    sheetsDone: {
      messagePaged:
        'Exportação por páginas concluída. Total de imagens no tamanho original: {{count}}. As páginas adjacentes sobrepõem-se até {{overlap}}px; as coordenadas estão no manifesto.',
      messageOversize:
        'A área ultrapassou o tamanho compatível com uma única imagem e foi exportada por páginas. Total de imagens no tamanho original: {{count}}. As páginas adjacentes sobrepõem-se até {{overlap}}px; as coordenadas estão no manifesto.',
    },
  },
  offline: {
    title: 'Visualização sem ligação',
    fit: 'Ajustar',
    tip: 'Blocos locais no tamanho original · arraste para mover / use a roda para ampliar',
    previewLevel: 'A mostrar o nível de pré-visualização {{level}}. Amplie para ver os píxeis originais',
    nativeTiles: 'A mostrar os blocos no tamanho original',
    footer:
      'Áreas em xadrez não foram observadas ou não têm blocos. A confiança não é uma probabilidade de acerto. Consulte diagnostics.jsonl e observations.jsonl.',
  },
};
