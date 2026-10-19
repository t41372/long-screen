import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: '프레임별 분석 및 독립적으로 움직이는 영역 감지',
      solving: '전체 위치 맞추기 및 원본 픽셀 단위 조정',
      optimizing: '같은 위치를 다시 방문한 정보를 바탕으로 누적 오차 보정',
      rendering: '원본 크기로 캔버스 합성',
      revealing: '페이지 위에 떠 있는 UI 제거',
      framing: '창 테두리와 원래 종횡비 유지',
      pyramid: '확대 가능한 미리보기 생성',
      complete: '완료 · 진단 정보를 확인하세요',
      partial: '부분 결과 저장됨',
      error: '처리 중 오류 발생',
    },
    count: {
      frames_one: '{{frames}}프레임',
      frames_other: '{{frames}}프레임',
      framesUnknown: '프레임 수 알 수 없음',
      regions_one: '지정한 영역 {{count}}개 ↗',
      regions_other: '지정한 영역 {{count}}개 ↗',
    },
    dom: {
      noCompressionStream:
        '이 브라우저는 CompressionStream을 지원하지 않습니다. 원본 크기 타일을 PNG로 변환할 수 없어 처리를 시작할 수 없습니다.',
    },
    canvases: {
      badgePresentation: '테두리 포함 보기 · 늘린 배경은 관측 근거가 아닙니다',
      badgeFixed: '고정 UI / 관측 레이어',
      badgeMoving: '2D 콘텐츠 레이어',
      badge_one: '{{kind}} · 원본 크기 타일 {{count}}개{{fragment}}',
      badge_other: '{{kind}} · 원본 크기 타일 {{count}}개{{fragment}}',
      fragmentNote: ' · 조각 사이의 위치 관계는 확인되지 않았습니다',
    },
    diagnostics: {
      occurrenceSuffix: ' (같은 유형 {{count}}건)',
      locateAction: '해당 영역 / 원본 보기 ↗',
      viewSourceAction: '녹화의 해당 시점 보기 ↗',
      emptyFiltered: '이 조건에 맞는 기록이 없습니다.',
      emptyDefault: '위치 정렬 근거, 내용 변화, 추정 결과와 처리 오류가 여기에 표시됩니다.',
      noOriginalVideo:
        '프로젝트에 원본 영상이 포함되어 있지 않습니다. 해당 시점의 프레임을 보려면 같은 녹화를 다시 선택하세요. 합성 결과는 이 기기에 저장되어 있습니다.',
      hashMismatch:
        '파일 이름과 크기는 같지만, 내용의 해시가 이 프로젝트에 사용한 녹화와 달라 원본 참조 자료로 사용할 수 없습니다. 올바른 녹화 파일을 선택하세요.',
      sourceCaption: '원본 프레임 {{frame}} · {{time}}초 · {{message}}',
    },
    export: {
      imageSuffix: '-스크린샷',
      savePickerFallback: '직접 저장할 수 없어 브라우저 다운로드로 전환합니다: {{error}}',
      saveRowLabel: '{{name}} 저장 · {{size}}',
      shareLabel: '공유 / 사진에 저장',
      shareFailed: '공유하지 못했습니다: {{error}}',
      cleanupLabel: '저장 후 임시 사본 삭제',
      exportErrorAction: '내보내기가 완료되지 않았습니다. 이미 저장된 프로젝트 타일은 이 기기에 남아 있습니다.',
      clipboardUnsupported: '이 브라우저에서는 이미지를 복사할 수 없습니다. ‘이미지 저장’을 이용하세요.',
      copyNoImage: '이미지가 생성되지 않았습니다',
      copyFailedCtor: '복사하지 못했습니다: {{error}}. ‘이미지 저장’을 이용하세요.',
      copySuccess: '{{width}} × {{height}} 이미지를 복사했습니다. 바로 붙여넣을 수 있습니다.',
      copyFailed: '복사하지 못했습니다: {{error}}. 이미지가 시스템 클립보드 한도를 넘었을 수 있습니다. ‘이미지 저장’을 이용하세요.',
    },
    crop: {
      buttonCropped: '자르기 · {{width}} × {{height}}',
      applied:
        '적용했습니다. 이제 다운로드, 복사, 분할 저장에는 이 부분({{width}} × {{height}})만 포함됩니다. 전체 프로젝트 ZIP은 잘리지 않습니다.',
      removed: '자르기를 해제했습니다. 다시 이미지 전체를 저장합니다.',
    },
    main: {
      offscreenMissing: '이 브라우저는 OffscreenCanvas를 지원하지 않아 렌더링 워커를 실행할 수 없습니다.',
      webcodecsMissingToast:
        '이 브라우저는 WebCodecs를 지원하지 않습니다. ‘근사 · 기본 플레이어’를 선택하면 처리할 수 있지만 프레임을 놓칠 수 있습니다.',
      privateStorageToast:
        '비공개 탐색에서는 프로젝트가 이 창의 메모리에만 보관되며, 창을 닫으면 사라집니다. 결과를 보관하려면 닫기 전에 내보내세요.',
      noOpfsNoPicker: '이 브라우저는 OPFS와 파일 저장 대화상자를 지원하지 않아 메모리에서 내보내기를 준비합니다(최대 {{mb}} MB).',
      dbOpenFailed: '로컬 데이터베이스를 열지 못했습니다: {{error}}',
      workerErrorToast: '워커 오류: {{message}}',
      workerMessageUndecodable: '워커의 메시지를 읽을 수 없습니다. 현재 결과를 저장한 뒤 새로고침하세요.',
      interruptedPhaseWhere: '‘{{phase}}’ 단계의 {{frames}}번째 프레임',
      interruptedStartPhase: '시작 단계',
      interruptedHiddenSome: '페이지가 약 {{seconds}}초 동안 백그라운드에 있었습니다{{stillHidden}}',
      interruptedStillHidden: ' (중단 시점에도 백그라운드 상태)',
      interruptedHiddenNone: '페이지가 계속 포그라운드에 있었습니다',
      interruptedDiagnosticMessage:
        '이전 작업이 {{where}}에서 중단되었고, 페이지가 완료 신호를 받지 못했습니다(브라우저가 페이지를 종료했거나 충돌했습니다). 실행 시간: {{elapsed}}초, 코어 메모리: {{memory}} MB, {{hidden}}, 프레임 변환: {{conversion}}, CPU 코어: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari는 페이지가 백그라운드로 가면 훨씬 적은 메모리 사용량에서도 페이지를 종료할 수 있습니다. 오래 걸리는 작업 중에는 이 탭을 앞에 두세요. 전체 기록은 브라우저 콘솔에 남겼습니다.',
      interruptedNotIsolated: ' (교차 출처 격리 없음, 단일 스레드)',
      interruptedToast: '이전 작업이 {{where}}에서 중단되었습니다({{hidden}}). 자세한 내용은 진단 정보를 확인하세요.',
      unknownValue: '알 수 없음',
    },
    run: {
      pausedStatus: '일시 정지됨 · 메모리 상태 유지 중',
      resumedStatus: '다시 시작하는 중',
      pauseLabel: '일시 정지',
      resumeLabel: '계속',
      stopToast: '현재 단계를 마치고, 처리한 부분을 최대한 합성해 저장합니다.',
      preparingStatus: '프레임별 디코딩 준비 중',
      preparingMessage: '영상 컨테이너를 읽고 코덱 지원 여부와 로컬 저장소를 확인합니다.',
      compatibilityNeedsNative: '‘근사 · 기본 플레이어’를 사용하려면 브라우저의 기본 플레이어가 이 영상을 읽을 수 있어야 합니다.',
      webcodecsHttpBlocked:
        '이 HTTP 주소에서는 WebCodecs를 사용할 수 없습니다. 로컬 테스트를 계속하려면 ‘근사 · 기본 플레이어’를 선택하세요. 프레임별 디코딩에는 localhost 또는 HTTPS가 필요합니다. 영상은 업로드하지 않습니다.',
      webcodecsMissing:
        '이 브라우저는 WebCodecs를 지원하지 않습니다. Safari / iOS를 업데이트하거나 ‘근사 · 기본 플레이어’를 선택하세요. 근사 모드에서는 프레임을 놓칠 수 있습니다.',
      startFailedStatus: '처리를 시작하지 못했습니다',
      restoredMessage: '지난번 결과입니다. 24시간이 지나면 다음에 페이지를 열 때 삭제됩니다.',
      interruptedStatus: '지난 작업이 끝나지 않았습니다',
      interruptedMessage: '중단되기 전에 저장된 부분입니다. 전체 결과를 얻으려면 녹화를 다시 넣고 실행하세요.',
      waitingCanvasOption: '캔버스 재구성 대기 중',
    },
    source: {
      busyToast: '먼저 현재 작업을 완료하거나 중지 후 저장하세요.',
      subtitleReading: '{{size}} · 업로드 없음 · 컨테이너와 첫 프레임 확인 중',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · 기본 플레이어로만 읽을 수 있음',
      subtitleUnavailable: '{{size}} · 프레임별 디코딩과 기본 미리보기 모두 사용할 수 없음',
      probeFailedMessage: '프레임별 디코딩 확인에 실패했습니다: {{error}}',
      probeFailedAction:
        '브라우저 기본 플레이어로 영상 정보를 읽어 봅니다. 처리를 계속하려면 디코딩 방식에서 ‘근사 · 기본 플레이어’를 선택하세요.',
      rejectedVideo:
        '‘{{name}}’ 파일은 {{kind}}입니다. 브라우저가 이 형식을 프레임별로 읽을 수 없어 열지 않았습니다. 화면 녹화의 저장 형식을 MP4로 설정하거나 HandBrake 또는 ffmpeg로 MP4로 변환하세요.',
      rejectedOther:
        '‘{{name}}’ 파일은 {{kind}}이며 영상이 아니므로 열지 않았습니다. 페이지를 이동하며 녹화한 화면 영상(MP4, MOV, WebM, MKV)을 선택하세요. Windows에서는 캡처 도구나 Xbox Game Bar(Win+Alt+R), Mac에서는 ⌘⇧5, 휴대폰에서는 기본 화면 녹화 기능을 사용할 수 있습니다.',
      unreadableToast:
        '이 영상을 읽을 수 없습니다({{reason}}). 녹화가 정상적으로 끝났고 파일 복사나 다운로드가 완료되었는지 확인하세요. 계속 실패하면 H.264 MP4로 시도해 보세요. 프레임별 디코딩이 실패한 이유는 진단 정보에서 확인할 수 있습니다.',
      kind: {
        empty: '빈 파일',
        heif: 'HEIC/AVIF 이미지',
        avi: 'AVI 영상',
        webp: 'WebP 이미지',
        wav: 'WAV 오디오 파일',
        riff: 'RIFF 파일',
        wmv: 'WMV/ASF 영상',
        flv: 'FLV 영상',
        mpegps: 'MPEG-PS 영상',
        ogg: 'Ogg 미디어 파일',
        gif: 'GIF 애니메이션',
        png: 'PNG 이미지',
        jpeg: 'JPEG 이미지',
        pdf: 'PDF 문서',
        zip: 'ZIP 압축 파일 또는 Office 문서',
        mp3: 'MP3 오디오 파일',
        text: '텍스트 파일',
        mpegts: 'MPEG-TS 영상',
        unknown: '형식을 알 수 없는 파일',
      },
    },
    demo: { fileName: '예제-녹화.mp4', loadFailed: '예제 녹화를 불러오지 못했습니다: {{error}}' },
    feedback: {
      issueBody:
        '**어떤 문제가 발생했나요?**\n\n\n**어떤 결과를 기대했나요?**\n\n\n**녹화에 대해 알려 주세요** (어떤 페이지인지, 어떻게 움직였는지, 대략적인 길이. 스크린샷이 있으면 도움이 되지만 개인정보는 가려 주세요)\n\n\n' +
        '---\nLong Screen이 자동으로 입력했습니다. 자유롭게 수정하거나 삭제하세요:\n- 브라우저: {{browser}}\n- 열린 페이지: {{page}}\n- 멀티스레드 코어(교차 출처 격리): {{threads}}\n- 처리 로그의 경고: {{warnings}}\n',
      portable: '포터블 버전 (로컬 파일)',
      yes: '예',
      no: '아니요',
      none: '없음',
    },
    viewer: {
      previewLevel: '미리보기 L{{level}} (원본 크기 유지)',
      nativeLevel: '원본 픽셀 L0',
      qualityHint: ' · 확대하면 품질 마스크가 보입니다',
      unobservedHint: ' · 파랑 = 관측 근거 없음',
      provisionalHint: ' · 보라 = 일시적인 내용 / 겹쳐진 UI',
    },
  },
  names: {
    fixed: '고정 UI',
    divider: '고정 구분선',
    contentCanvas: '콘텐츠 캔버스 {{n}}',
    unassigned: '미지정 영역 · 화면 좌표의 관측',
    contentRegion: '콘텐츠 영역 {{n}}',
    ignored: '제외됨',
    fragment: '위치 미확정 조각 {{n}}',
    framed: '테두리 포함',
  },
};
