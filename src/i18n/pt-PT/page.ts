import type { Catalog } from '../catalog.ts';
import type { pageSections as zh } from '../zh/page.ts';

export const pageSections: Catalog<typeof zh> = {
  language: {
    label: 'Idioma da interface',
    saveFailed: 'Não foi possível guardar o idioma: o navegador bloqueia o armazenamento local.',
  },
  page: {
    title: 'Long Screen — Da gravação de ecrã a uma captura completa',
    description:
      'Transforme uma gravação do ecrã numa única captura no tamanho original: desloque-se em qualquer direção, na diagonal, pare ou volte atrás. A moldura da janela e as barras de estado fixas também são preservadas. Tudo é processado no navegador, sem enviar ficheiros.',
    closeLabel: 'Fechar',
    header: {
      brandLabel: 'Página inicial do Long Screen',
      slogan: 'QUALQUER CAMINHO · UMA SÓ CAPTURA',
      privacy: 'As suas imagens ficam neste dispositivo',
      helpLabel: 'Ajuda e funcionalidades',
      star: 'Dê uma estrela no GitHub',
      starLabel: 'Dê uma estrela no GitHub (abre noutro separador)',
      install: 'Instalar aplicação',
      installTitle:
        'Instale o Long Screen neste dispositivo como aplicação web (PWA): abre numa janela própria e funciona sem ligação à Internet',
    },
    install: {
      title: 'Instalar neste dispositivo',
      intro:
        'O Long Screen pode ser instalado como aplicação web (PWA). Abre a partir do ecrã principal ou da Dock, numa janela própria, e funciona sem ligação à Internet. As gravações continuam a ser processadas apenas neste dispositivo.',
      iosShare: 'Toque no botão Partilhar do navegador. No Safari, está na barra inferior ou no menu ⋯.',
      iosAdd: 'Procure a opção «Adicionar ao ecrã principal».',
      iosConfirm: 'Toque em «Adicionar».',
      iosInApp: 'Se esta página abriu dentro de outra aplicação, como o WeChat ou o LINE, abra-a primeiro no Safari.',
      macFile: 'Na barra de menus, no topo do ecrã, escolha Ficheiro → Adicionar à Dock.',
      macConfirm: 'Clique em «Adicionar».',
      offline: 'Após a instalação, abra uma vez com ligação à Internet. Depois, pode usar sem ligação.',
    },
    hero: {
      heading: 'De uma gravação do ecrã<br>a <span class="hl">uma captura completa</span>.',
      intro:
        'Grave o ecrã enquanto percorre uma página, uma aplicação ou um design: em qualquer direção, na diagonal ou voltando atrás. Tudo o que apareceu na gravação é colocado no seu lugar num único PNG no tamanho original, com a moldura da janela e as barras de estado fixas. Tudo no navegador, sem enviar ficheiros.',
      demoLead: ' Quer ver o resultado?',
      demoChip: 'Reproduzir um exemplo',
    },
    steps: {
      ariaLabel: 'Como funciona',
      recordTitle: 'Grave o ecrã',
      recordBody: 'Grave enquanto percorre uma página ou uma aplicação, na direção que quiser.',
      feedTitle: 'Coloque o vídeo',
      feedBody: 'Arraste o vídeo para o ecrã da impressora e clique em «Começar».',
      takeTitle: 'Guarde a captura',
      takeBody: 'Obtenha uma captura completa, no tamanho original. O que não foi gravado fica vazio.',
    },
    press: {
      ariaLabel: 'A impressora',
      core: 'Versão da biblioteca do núcleo',
      build: 'Commit usado para gerar esta página',
    },
    screen: {
      dropTitle: 'Arraste uma gravação para aqui',
      dropHint: 'ou clique para escolher um ficheiro · MP4 · MOV · WebM',
    },
    observe: {
      dropTitle: 'Ainda não há nenhuma gravação',
      dropSubtitle: 'MP4 · MOV · WebM · fica neste dispositivo',
    },
    controls: {
      print: 'Começar',
      progress: 'Progresso',
      knobs: 'Definições',
      clear: 'Limpar',
      clearTitle: 'Limpar a impressora: remover a gravação, o resultado e o registo deste processamento',
    },
    tray: {
      ariaLabel: 'Pré-visualização da captura completa',
      idleTitle: 'A sua captura completa sai por aqui',
      story1: 'A gravação passeia pela página…',
      story2: 'Cada parte volta ao seu lugar',
      story3: 'Pronto: uma captura completa!',
      story4: 'Grave enquanto percorre o ecrã do telemóvel…',
      story5: 'Tudo unido, uma só barra de estado',
      story6: 'Capturas longas também funcionam!',
    },
    reconstruct: {
      heading: 'Definições de processamento',
      sub: 'As predefinições funcionam bem. Altere-as apenas se precisar de afinar o resultado.',
      policyLabel: 'Quando o conteúdo muda',
      policyStable: 'Manter a imagem mais estável',
      policyLatest: 'Preferir a imagem mais recente',
      framingLabel: 'Moldura',
      framingContext: 'Manter moldura e interface fixa',
      framingRegion: 'Só conteúdo e margens',
      regionsLabel: 'Áreas de movimento',
      regionsAuto: 'Deteção automática ↗',
      advancedSummary: 'Mais definições <span>＋</span>',
      analysisSizeLabel: 'Lado maior da análise',
      memoryLabel: 'Limite da cache de blocos',
      computeLabel: 'Aceleração',
      computeAuto: 'Automática · WebGPU / CPU',
      computeWebgpu: 'WebGPU · alinhamento na CPU',
      computeCpu: 'Apenas CPU',
      computeHint:
        'A GPU converte cada fotograma descodificado em píxeis e gera as miniaturas de análise; a procura de correspondências e a composição continuam na CPU. O modo automático mede ambas as opções e só usa a GPU se for mais rápida.',
      decoderLabel: 'Descodificação',
      decoderPrecise: 'Exata · WebCodecs',
      decoderCompatibility: 'Aproximada · leitor nativo',
      decoderHint:
        'As miniaturas de análise não alteram os píxeis do resultado. A cache guarda apenas blocos já compostos e aumenta automaticamente se um fotograma precisar de mais espaço, pelo que quase não afeta a velocidade. A memória usada pelo navegador, pelo descodificador, pela GPU e pelo núcleo não conta para este limite. O modo «Aproximada · leitor nativo» pode omitir conteúdo que aparece por breves instantes.',
      pauseBtn: 'Pausa',
      stopBtn: 'Parar e guardar',
      footerNote: 'Sem envio de ficheiros · sem inferência na nuvem · sem modelos externos',
    },
    canvas: {
      ariaLabel: 'Área reconstruída',
      selectAriaLabel: 'Escolher área reconstruída',
      waitingOption: 'A aguardar conteúdo',
      qualityMask: 'Mostrar qualidade',
      fitTitle: 'Ajustar à janela',
      fitBtn: 'Ajustar',
      nativeTitle: 'Tamanho original',
      viewerAriaLabel: 'Área bidimensional com espaços vazios, que permite arrastar e ampliar',
      zoomOutLabel: 'Diminuir zoom',
      zoomInLabel: 'Aumentar zoom',
      expandLabel: 'Expandir visualização',
      emptyTitle: 'A juntar as imagens…',
      emptyBody: 'Cada fotograma está a encontrar o seu lugar na imagem completa.',
      statusReady: 'Tudo pronto',
      progressMessageDefault: 'Adicione uma gravação → clique em Começar → guarde a captura',
      lodLabel: 'Xadrez = área não gravada',
    },
    understand: {
      noteBtn: 'Registo',
      heading: 'Registo do processamento',
      desc: 'Aqui fica registado onde cada parte foi colocada, o que mudou na página e quais problemas apareceram.',
      framesLabel: 'fotogramas compostos',
      canvasesLabel: 'total de áreas',
      coverageBody:
        'Transparente ≠ página branca<br><small>Indica uma área que não foi observada. Nada é inventado para preenchê-la.</small>',
      diagnosticsHeading: 'Diagnósticos',
      filterAriaLabel: 'Filtrar diagnósticos',
      filterAll: 'Todos',
      filterIssues: 'Avisos / erros',
      diagnosticsAriaLabel: 'Diagnósticos do processamento',
      diagnosticsEmpty: 'As decisões de posicionamento, mudanças na página,<br>inferências e erros aparecerão aqui.',
      moreDiagnostics: 'Carregar mais diagnósticos',
      reportLead: 'O resultado não ficou bem ou algo falhou?',
      reportBtn: 'Comunicar no GitHub',
      reportNote:
        'O relatório inclui os dados do navegador e os códigos de aviso deste registo. Não inclui a gravação, as suas imagens nem o nome do ficheiro. Pode revê-lo e editá-lo antes de enviar.',
    },
    export: {
      downloadPng: 'Transferir captura · PNG <span>↓</span>',
      copyPng: 'Copiar captura',
      pngNote: 'Um único PNG no tamanho original, sem reduzir nem dividir em páginas.',
      advancedSummary: 'Outras formas de exportar',
      exportProject: 'Exportar projeto completo · ZIP',
      projectNote:
        'Blocos no tamanho original, visualizador sem ligação, dados de cobertura e qualidade e diagnósticos completos, para arquivar ou investigar problemas.',
      exportSheets: 'Exportar por páginas · vários PNGs (ZIP)',
      sheetsNote:
        'Divide uma área demasiado grande em vários PNGs de tamanho compatível, sem reduzir os píxeis. As páginas sobrepõem-se em 32px e incluem um manifesto com as coordenadas globais.',
      starNudge: 'Foi útil? Dê uma estrela no GitHub',
    },
    help: {
      title: 'Uma captura com origem conhecida',
      pixelsHeading: 'Que píxeis são preservados?',
      pixelsBody:
        'O modo exato descodifica fotograma a fotograma. Cada observação concluída tem uma marca temporal e um registo de composição. A análise pode usar imagens reduzidas; a composição final e a exportação mantêm a escala original dos píxeis.',
      frameHeading: 'Moldura e margens originais',
      frameBody:
        'Por predefinição, preservam-se o fundo, as margens e os espaços em branco de toda a área deslocável, sem recortar até aos limites do texto. A versão com moldura também mantém a interface de um fotograma de referência: o texto lateral e os ícones da barra de ferramentas aparecem uma vez, no tamanho original. As áreas ampliadas apenas prolongam o fundo decorativo e não são evidência de reconstrução. A camada de conteúdo original é sempre guardada separadamente. Os outros painéis independentes não são apresentados como se seguissem a mesma trajetória.',
      scopeHeading: 'Nem tudo pode ser deduzido pela imagem',
      scopeBody:
        'Separar camadas em movimento, distinguir texturas repetidas e identificar a qual área pertence um conteúdo dinâmico exige inferências visuais. Mudanças de escala, áreas sem sobreposição ou layouts incompatíveis podem gerar fragmentos independentes. Não se afirma que esses fragmentos estejam alinhados entre si. A pontuação de confiança não é uma probabilidade calibrada de o resultado estar correto.',
      storageHeading: 'Gravações longas e armazenamento',
      storageBody:
        'A descodificação é feita em três passagens, usando espaço em disco e tempo de processamento para limitar o consumo de memória. O navegador guarda apenas o último resultado, durante um máximo de 24 horas. Se recarregar ou fechar a página por engano, o resultado reaparece ao abri-la; se o processamento foi interrompido, recupera-se a parte já guardada, mas não é possível continuar a partir desse ponto. Começar de novo ou clicar em «Limpar» apaga o resultado. Após 24 horas, será eliminado da próxima vez que a página abrir. Transfira o que quiser guardar.',
      privacyHeading: 'A minha gravação sai deste dispositivo?',
      privacyBody:
        'Não. A descodificação, a análise e a composição acontecem no navegador. Nem a gravação nem a captura saem deste dispositivo, e pode continuar sem ligação à Internet depois de a página carregar. O site alojado em long-screen.yi-ting.com utiliza dois serviços de estatísticas anónimas. O Cloudflare Web Analytics conta visitas e recebe apenas a página aberta, a origem da visita, o tipo de navegador e dispositivo, o país e a velocidade de carregamento. O PostHog conta as utilizações da impressora: um evento ao abrir a página, um ao iniciar o processamento e outro ao terminar. Estes eventos contêm apenas as definições, a versão do núcleo, o codec da gravação, a altura e a duração em minutos, um intervalo aproximado de fotogramas, o número de imagens geradas, o tempo gasto e os códigos de diagnóstico. Cada evento também inclui o endereço da página, a origem da visita, o navegador e o sistema operativo, o tamanho do ecrã, o idioma, o fuso horário e o país. Nenhum dos dois usa cookies; o PostHog também não guarda nada no navegador. Nenhum recebe gravações, capturas, nomes de ficheiros ou mensagens de erro. Com Do Not Track ou Global Privacy Control ativado, o PostHog nem sequer é carregado. As cópias que alojar por sua conta e a versão de ficheiro único para uso sem ligação não recolhem estatísticas. A Política de Segurança de Conteúdo (CSP) permite ligações apenas ao próprio site e a estes dois serviços; o navegador bloqueia qualquer outra.',
      browserHeading: 'Navegadores e formatos',
      browserBody:
        'São necessários IndexedDB, OffscreenCanvas e CompressionStream. No desenvolvimento local, pode usar HTTP em localhost sem certificado. Num telemóvel que aceda a um endereço HTTP da rede local, pode testar com «Aproximada · leitor nativo», mas alguns fotogramas podem ser omitidos. Em geral, os navegadores só disponibilizam o WebCodecs e as API de exportação para disco em localhost ou HTTPS. Isto não tem relação com enviar ficheiros. A descodificação exata também exige que o dispositivo suporte o codec específico: um contentor MP4, MOV ou WebM não garante que todo o seu conteúdo possa ser descodificado.',
      tipsHeading: 'Como melhorar o resultado?',
      tipsBody:
        'Mantenha sobreposição suficiente entre as imagens e desloque-se mais devagar em áreas com pouca textura. Se vários painéis ou elementos flutuantes não forem identificados corretamente, marque-os manualmente em «Áreas de movimento» antes de processar. O projeto completo inclui todos os diagnósticos.',
      feedbackHeading: 'Comentários e código-fonte',
      feedbackBody:
        'O Long Screen é um projeto de código aberto com licença MIT. O código está no <a href="https://github.com/t41372/long-screen" target="_blank" rel="noopener">GitHub</a>. Se encontrar um erro ou um resultado incorreto, <a class="report-link" href="https://github.com/t41372/long-screen/issues/new" target="_blank" rel="noopener">comunique o problema</a>; o relatório inclui os dados do navegador e os códigos de aviso do registo. Se o projeto lhe for útil, dar uma estrela ajuda-nos muito.',
      toolsHeading: 'Além desta página',
      toolsBody:
        'O motor desta página também funciona de forma independente: como <a href="https://github.com/t41372/long-screen#command-line" target="_blank" rel="noopener">ferramenta de linha de comandos</a>, <a href="https://github.com/t41372/long-screen#rust-library" target="_blank" rel="noopener">biblioteca Rust</a> e <a href="https://github.com/t41372/long-screen#python-package" target="_blank" rel="noopener">pacote Python</a>, e como <a href="https://github.com/t41372/long-screen#typescript-package" target="_blank" rel="noopener">pacote TypeScript</a> para outras páginas web. Todos processam as gravações apenas no seu computador. O README explica como instalar e usar cada opção.',
      licenseHeading: 'Licenças de código aberto',
      licenseBody:
        'O código do próprio Long Screen usa a licença MIT: pode usá-lo, copiá-lo, modificá-lo e redistribuí-lo gratuitamente, vendê-lo ou incluí-lo em produtos de código fechado, desde que as cópias mantenham o aviso de direitos de autor e o <a href="https://github.com/t41372/long-screen/blob/main/LICENSE" target="_blank" rel="noopener">texto da licença</a>. O software é fornecido no estado em que se encontra, sem garantias. As dependências de terceiros incluídas no núcleo Wasm e nos recursos da interface, as respetivas licenças e as fontes e licenças dos logótipos de Rust, WebAssembly e GitHub estão nos <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">avisos de código aberto</a>, gerados na compilação.',
    },
    regions: {
      title: 'Definir áreas de movimento independente',
      hint:
        'Arraste para desenhar um retângulo sobre o fotograma. Cada área de «conteúdo» é reconstruída separadamente. As áreas não marcadas ficam numa camada de observação independente, com baixa confiança. As áreas de «ignorar» são excluídas explicitamente.',
      kindMoving: 'Conteúdo · movimento independente',
      kindFixed: 'Interface fixa',
      kindIgnore: 'Ignorar · excluir da reconstrução',
      clearBtn: 'Restaurar deteção automática',
      saveBtn: 'Usar estas áreas',
    },
    source: {
      title: 'Imagem original da gravação',
    },
    crop: {
      button: 'Recortar',
      groupLabel: 'Área de recorte',
      left: 'Esquerda',
      top: 'Topo',
      width: 'Largura',
      height: 'Altura',
      full: 'Captura inteira',
      cancel: 'Cancelar',
      apply: 'Aplicar recorte',
    },
    footer: {
      stackLead: 'O núcleo é escrito em',
      stackMid: 'e compilado para',
      stackTail: 'para funcionar no navegador.',
      stackMore: 'Interface em TypeScript · compilação e testes com Deno',
      linksLabel: 'Ligações do projeto',
      source: 'Código no GitHub',
      report: 'Comunicar um problema',
      notices: 'Avisos de código aberto',
      trademarks:
        'Os nomes e logótipos de Rust, WebAssembly, TypeScript, Deno e GitHub pertencem aos respetivos titulares. Apenas identificam as tecnologias utilizadas; não significam que estas organizações apoiam o projeto.',
    },
  },
  deviceCheck: {
    doneTitle: 'Verificação do dispositivo — concluída',
    title: 'Verificação do dispositivo',
    intro:
      'Mede as capacidades do navegador e do dispositivo (isolamento entre origens, threads e adaptador WebGPU) e o custo real de usar a GPU:\ntransferir um fotograma RGBA no tamanho original para a GPU e lê-lo de volta, além do tempo e da correspondência byte a byte ao gerar miniaturas de análise na GPU e no núcleo Rust.\nOpcionalmente, escolha uma gravação para executar todo o processo na CPU e com WebGPU forçado, comparando as impressões digitais dos blocos.\nTudo é processado neste dispositivo, sem enviar ficheiros. Os dados da gravação são apagados após a comparação. WebGPU só está disponível num contexto seguro (localhost ou HTTPS).',
    recordingLabel: 'Gravação (opcional):',
    runBtn: 'Iniciar verificação',
    loadingReport: 'A carregar o núcleo…',
  },
};
