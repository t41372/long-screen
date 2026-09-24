import type { Catalog } from '../catalog.ts';
import type { uiSections as zh } from '../zh/ui.ts';

export const uiSections: Catalog<typeof zh> = {
  ui: {
    phase: {
      scanning: 'Frame-by-frame observation and motion layering',
      solving: 'Global localization and native-pixel refinement',
      optimizing: 'Correcting loop closure and cumulative drift',
      rendering: 'Compositing the native-size sparse canvas',
      framing: 'Keeping the frame and original aspect ratio',
      pyramid: 'Building a zoomable preview',
      complete: 'Complete · check diagnostics',
      partial: 'Partial results saved',
      error: 'Processing hit an error',
    },
    count: {
      frames_one: '{{frames}} frame',
      frames_other: '{{frames}} frames',
      framesUnknown: '? frames',
      regions_one: '{{count}} custom region ↗',
      regions_other: '{{count}} custom regions ↗',
    },
    dom: {
      noCompressionStream:
        'This browser is missing CompressionStream, which encodes every native-size tile to PNG; reconstruction cannot start.',
      storageUnavailable: 'This browser does not report a storage quota; local reconstruction is unaffected',
      storageUsage: '{{used}} used locally / {{quota}} quota available',
      storageQueryFailedStatus: 'This browser does not report a storage quota',
      storageQueryFailed: 'Could not query storage quota: {{error}}',
    },
    canvases: {
      badgePresentation: 'Framed presentation · extended background is not observation evidence',
      badgeFixed: 'Fixed / observation layer',
      badgeMoving: '2D content layer',
      badge_one: '{{kind}} · {{count}} native-size tile{{fragment}}',
      badge_other: '{{kind}} · {{count}} native-size tiles{{fragment}}',
      fragmentNote: ' · fragments are not confirmed to align',
    },
    diagnostics: {
      occurrenceSuffix: ' ({{count}} occurrences of this kind)',
      locateAction: 'Locate affected area / view source ↗',
      viewSourceAction: 'View original moment ↗',
      emptyFiltered: 'No records under this filter.',
      emptyDefault: 'Localization evidence, page changes, inferences and processing errors will appear here.',
      noOriginalVideo:
        'The original video is not included in the project. Choose the matching recording again to view by timestamp; the composited result is still saved locally.',
      hashMismatch:
        'The chosen file matches by name and size, but its content hash does not match the recording this project was built from, so it is refused as source-moment evidence. Please choose the correct recording file.',
      sourceCaption: 'Source frame {{frame}} · {{time}}s · {{message}}',
    },
    export: {
      imageSuffix: '-long-image',
      savePickerFallback: 'Direct save is unavailable; using the browser download instead: {{error}}',
      saveRowLabel: 'Save {{name}} · {{size}}',
      shareLabel: 'Share / save to Photos',
      shareFailed: 'Share failed: {{error}}',
      cleanupLabel: 'Clean up temporary copy after saving',
      exportErrorAction: 'An unfinished export was not marked as successful. Project tiles already committed are still on this device.',
      clipboardUnsupported: 'This browser cannot copy images; use “Download long image” instead.',
      copyNoImage: 'No image was generated',
      copyFailedCtor: 'Copy failed: {{error}}. Use “Download long image” instead.',
      copySuccess: 'Copied a {{width}} × {{height}} long image; paste it directly.',
      copyFailed: 'Copy failed: {{error}}. The image may exceed the system clipboard limit; use “Download long image” instead.',
    },
    history: {
      busyToast: 'Finish the current run first.',
      interruptedStatus: 'Processing was interrupted · viewing committed results',
      restoredMessage: 'Local results restored; the original video was not copied into the project.',
      interruptedDiagnosticMessage:
        'The previous run did not finish. Only committed data can be recovered; reprocessing needs the original video again — resuming from an interruption is not supported yet.',
      rowSub: '{{date}} · {{frames}} · {{status}}',
      deleteConfirm: 'Delete the local project “{{name}}” and all its tiles?',
      openBtn: 'Open',
      deleteBtn: 'Delete',
      noProjects: 'No local projects yet.',
    },
    main: {
      persistUnsupported:
        'This browser does not support requesting persistent storage; local reconstruction still works — save important results somewhere that supports export.',
      persistGranted: 'The browser granted persistent storage; clearing site data will still delete projects.',
      persistDenied: 'The browser did not grant persistent storage. Export important results to avoid automatic eviction.',
      offscreenMissing: 'This browser is missing OffscreenCanvas; the render worker cannot run.',
      webcodecsMissingToast: 'This browser has no WebCodecs. Choose “Approximate · native seek” explicitly; it may miss frames.',
      privateStorageToast:
        "Private browsing: the project is only kept in this window's memory and disappears when the window closes; export before closing to keep it.",
      noOpfsNoPicker: 'This browser has neither OPFS nor a file-save dialog; export will be generated in memory (up to {{mb}} MB).',
      dbOpenFailed: 'Could not open the local database: {{error}}',
      workerErrorToast: 'Worker error: {{message}}',
      workerMessageUndecodable: 'A worker message could not be decoded. Keep the existing results and reload.',
      interruptedPhaseWhere: '“{{phase}}”, frame {{frames}}',
      interruptedStartPhase: 'the starting phase',
      interruptedHiddenSome: 'the page was in the background for about {{seconds}}s{{stillHidden}}',
      interruptedStillHidden: ' (still in the background at the time of interruption)',
      interruptedHiddenNone: 'the page stayed in the foreground the whole time',
      interruptedDiagnosticMessage:
        'The previous reconstruction was interrupted in {{where}}; the page never received a completion signal (the browser evicted or crashed the page). It had run for {{elapsed}}s, core memory {{memory}} MB, {{hidden}}, frame conversion: {{conversion}}, CPU cores: {{cores}}{{isolation}}.',
      interruptedDiagnosticAction:
        'Safari evicts a page at a much lower memory limit once it goes to the background: keep this tab in the foreground for long-running processing. The full record was written to the browser console.',
      interruptedNotIsolated: ' (not cross-origin isolated, single-threaded)',
      interruptedToast: 'The previous reconstruction was interrupted in {{where}} ({{hidden}}). See diagnostics for details.',
      unknownValue: 'unknown',
    },
    run: {
      pausedStatus: 'Paused · memory state retained',
      resumedStatus: 'Resuming',
      pauseLabel: 'Pause',
      resumeLabel: 'Resume',
      stopToast: 'Ending the current phase and compositing and saving as much of the observation as possible.',
      preparingStatus: 'Preparing frame-accurate decoding',
      preparingMessage: 'Reading the container and checking codec support and local storage.',
      compatibilityNeedsNative: "“Approximate · native seek” needs the browser's native player to be able to read this video.",
      webcodecsHttpBlocked:
        'The browser does not open WebCodecs on this HTTP address. You can choose “Approximate · native seek” to keep testing locally; frame-accurate decoding needs localhost or HTTPS. The video is not uploaded.',
      webcodecsMissing:
        'This browser has no WebCodecs. Update Safari / iOS, or explicitly choose “Approximate · native seek”, which may miss frames.',
      startFailedStatus: 'Could not start reconstruction',
      waitingCanvasOption: 'Waiting for canvas to reconstruct',
    },
    source: {
      busyToast: 'Finish or save the current run first.',
      subtitleReading: '{{size}} · not uploaded · reading container and first frame',
      subtitleDetailed: '{{width}} × {{height}} · {{duration}} · {{frames}} · {{codec}} · {{size}}',
      subtitleNativeOnly: '{{width}} × {{height}} · {{duration}} · {{size}} · readable by the native player only',
      subtitleUnavailable: '{{size}} · neither frame-accurate decoding nor native preview is available',
      probeFailedMessage: 'Frame-accurate decode probing failed: {{error}}',
      probeFailedAction:
        "Will try the browser's native player to read metadata. To keep processing, choose “Approximate · native seek” for decoding.",
    },
    viewer: {
      previewLevel: 'Preview L{{level}} (native size unchanged)',
      nativeLevel: 'Native pixels L0',
      qualityHint: ' · zoom in to see the quality mask',
      unobservedHint: ' · blue = no observation evidence',
      provisionalHint: ' · purple = transient / overlay content',
    },
  },
  names: {
    fixed: 'Fixed UI',
    divider: 'Fixed divider',
    contentCanvas: 'Content canvas {{n}}',
    unassigned: 'Unassigned area · screen-space observations',
    contentRegion: 'Content region {{n}}',
    ignored: 'Ignored',
    fragment: 'unplaced fragment {{n}}',
    framed: 'framed',
  },
};
