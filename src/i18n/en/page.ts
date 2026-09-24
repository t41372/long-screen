import type { Catalog } from '../catalog.ts';
import type { pageSections as zh } from '../zh/page.ts';

export const pageSections: Catalog<typeof zh> = {
  language: {
    label: 'Interface language',
    saveFailed: 'Could not save the language setting: this browser blocks local storage.',
  },
  page: {
    title: 'Long Screen — One big screenshot from a screen recording',
    description:
      'Turn a screen recording into one full-size big screenshot: scroll, pan, go diagonal, pause or circle back — not just scrolling down. Fixed window frames and status bars are restored. It all runs locally in your browser; nothing is uploaded.',
    closeLabel: 'Close',
    header: {
      brandLabel: 'Long Screen home',
      slogan: 'ANY PATH · ONE BIG SCREENSHOT',
      privacy: 'Pixels never leave this device',
      historyBtn: 'Past prints',
      helpLabel: 'Help and capabilities',
      star: 'Star on GitHub',
      starLabel: 'Star on GitHub (opens in a new tab)',
    },
    hero: {
      heading: 'Turn a screen recording<br>into <span class="hl">one big screenshot</span>.',
      intro:
        'Record your screen while you move around a web page, app, map or design — scroll, pan, go diagonal, circle back. Everything the recording showed is put back in place as one full-size PNG, with fixed window frames and status bars restored. It all runs in your browser; nothing is uploaded.',
      demoLead: ' Want to see it first?',
      demoChip: 'Play a sample recording',
    },
    steps: {
      ariaLabel: 'How it works',
      recordTitle: 'Record',
      recordBody: 'Record the screen while you move around a page, app or map, any way you like.',
      feedTitle: 'Feed it',
      feedBody: "Drop the video on the printer's screen and press Run.",
      takeTitle: 'Take it whole',
      takeBody: 'Take one full-size screenshot; anything never filmed stays empty.',
    },
    press: {
      ariaLabel: 'The printer',
    },
    screen: {
      dropTitle: 'Drop a recording here',
      dropHint: 'or click to choose a file · MP4 · MOV · WebM',
    },
    observe: {
      dropTitle: 'No recording yet',
      dropSubtitle: 'MP4 · MOV · WebM · stays on this device',
    },
    controls: {
      print: 'Run',
      knobs: 'Settings',
      clear: 'Clear',
      clearTitle: 'Clear the printer: take the recording out and clear this result and its log',
    },
    tray: {
      ariaLabel: 'Big screenshot preview',
      idleTitle: 'Your big screenshot comes out here',
      story1: 'The recording wanders around the page…',
      story2: 'Every part it saw goes back in place',
      story3: 'Out comes one big screenshot!',
      story4: 'Scroll down on a phone and record…',
      story5: 'Stitched screen by screen, one status bar',
      story6: 'The classic long screenshot works too!',
    },
    reconstruct: {
      heading: 'Run settings',
      sub: 'The defaults work; turn these only to fine-tune.',
      policyLabel: 'Conflicts',
      policyStable: 'Keep stable view',
      policyLatest: 'Prefer newer view',
      framingLabel: 'Frame',
      framingContext: 'Keep frame · reference UI',
      framingRegion: 'Content and margins only',
      regionsLabel: 'Motion regions',
      regionsAuto: 'Auto-detected ↗',
      advancedSummary: 'More knobs <span>＋</span>',
      analysisSizeLabel: 'Analysis long edge',
      memoryLabel: 'Working cache budget',
      computeLabel: 'Acceleration',
      computeAuto: 'Auto · WebGPU / CPU',
      computeWebgpu: 'WebGPU · CPU align',
      computeCpu: 'CPU only',
      computeHint:
        'The GPU only speeds up the analysis thumbnails; matching and pixel compositing still run on the CPU. Auto mode measures transfer and readback and will not force the GPU when it is slower.',
      decoderLabel: 'Decoding',
      decoderPrecise: 'Exact · WebCodecs',
      decoderCompatibility: 'Approximate · native seek',
      decoderHint:
        "Analysis thumbnails do not change the output pixels. The budget does not include the browser / decoder / GPU's extra memory. “Approximate · native seek” may miss brief content.",
      pauseBtn: 'Pause',
      stopBtn: 'Stop & save',
      storageChecking: 'Checking local storage…',
      persistBtn: 'Keep data',
      footerNote: 'No upload · no cloud inference · no external models',
    },
    canvas: {
      ariaLabel: 'Reconstructed canvas',
      selectAriaLabel: 'Choose reconstructed canvas',
      waitingOption: 'Waiting for observation',
      qualityMask: 'Quality mask',
      fitTitle: 'Fit to window',
      fitBtn: 'Fit',
      nativeTitle: 'Native size',
      viewerAriaLabel: 'Draggable and zoomable sparse 2D canvas',
      zoomOutLabel: 'Zoom out',
      zoomInLabel: 'Zoom in',
      expandLabel: 'Spread it out',
      emptyTitle: 'Stitching…',
      emptyBody: 'Every frame is finding its place in the whole picture.',
      statusReady: 'Ready',
      progressMessageDefault: 'Insert a recording → press Run → take it whole',
      lodLabel: 'Checkerboard = never seen',
    },
    understand: {
      noteBtn: 'Log',
      heading: 'Run log',
      desc: 'Why the printer placed each piece, what changed on the page and what went wrong — all recorded here.',
      framesLabel: 'frames composited',
      canvasesLabel: 'independent canvases',
      coverageBody: 'Transparent ≠ a white page <br><small>Marks space that was never observed; nothing is invented to fill it.</small>',
      diagnosticsHeading: 'Diagnostics',
      filterAriaLabel: 'Filter diagnostics',
      filterAll: 'All',
      filterIssues: 'Warnings / errors',
      diagnosticsAriaLabel: 'Processing diagnostics',
      diagnosticsEmpty: 'Localization evidence, page changes, <br>inferences and processing errors will appear here.',
      moreDiagnostics: 'Load more diagnostics',
      reportLead: 'Wrong result, or something broke?',
      reportBtn: 'Report it on GitHub',
      reportNote:
        'The report comes pre-filled with your browser details and the warning codes from this log. It never includes the recording, its pictures or the file name, and you can read and edit it before you submit.',
    },
    export: {
      downloadPng: 'Take the screenshot · PNG <span>↓</span>',
      copyPng: 'Copy screenshot',
      pngNote: 'One full-size PNG — not scaled down, not split into pages.',
      advancedSummary: 'Other ways to take it',
      exportProject: 'Export full project · ZIP',
      projectNote: 'Native-size tiles + offline viewer + coverage/quality data + full diagnostics, for archiving or troubleshooting.',
      exportSheets: 'Paged export · multiple PNGs (ZIP)',
      sheetsNote:
        'Splits an oversized canvas into multiple native-size PNGs at a compatible size, with a 32px overlap between pages and a world-coordinate manifest; nothing is shrunk.',
      starNudge: 'Found it useful? Star us on GitHub',
    },
    history: {
      title: 'Past prints',
      hint: 'Saved in this browser, not a cloud backup. The original recording is not copied into the project.',
      moreProjects: 'Load more',
    },
    help: {
      title: 'A canvas with a source',
      pixelsHeading: 'Which pixels are kept?',
      pixelsBody:
        'Frame-accurate mode decodes frame by frame. Every completed observation has a timestamp and a compositing record. Analysis can be downscaled; final compositing and export keep the original pixel scale.',
      frameHeading: 'Frame and natural margins',
      frameBody:
        "By default the whole scrollable area's background, margins and whitespace are kept, with no cropping to text bounds. The framed view additionally keeps one frame of reference UI: sidebar text and toolbar icons appear once at native size, and extended areas simply continue the decorative background — they are not reconstruction evidence. The original content layer is always kept separately. Other independent panes are never made to look like they share the same track.",
      scopeHeading: 'This is not “universal page understanding”',
      scopeBody:
        'Motion layering, repeated-texture disambiguation and dynamic-region attribution are all visual inference. Scale changes, non-overlapping or incompatible layouts may become independent fragments; these fragments are never claimed to be aligned with each other. Confidence is not a calibrated probability of correctness.',
      storageHeading: 'Long recordings and storage',
      storageBody:
        'A three-pass decode scan trades disk space and compute time for limited memory. Please keep the page open. Results already committed before an interruption stay on this device, but the current implementation cannot resume from an interrupted frame.',
      browserHeading: 'Browser and formats',
      browserBody:
        'Requires IndexedDB, OffscreenCanvas and CompressionStream. Local development can use HTTP localhost directly, no certificate needed; a phone opening a LAN HTTP address can test with “Approximate · native seek”, but it may miss frames. Browsers generally only open WebCodecs frame-accurate decoding and disk export APIs on localhost or HTTPS — this has nothing to do with uploading. Frame-accurate decoding also needs device support for the specific codec; an MP4/MOV/WebM container does not mean the device can decode everything inside it.',
      tipsHeading: 'How do I get better results?',
      tipsBody:
        'Keep enough overlap; move a little slower over low-texture areas. When multiple panes or floating layers are not identified correctly, draw them by hand under “Motion regions” before processing. All diagnostics can be exported from the full project.',
      feedbackHeading: 'Feedback and source code',
      feedbackBody:
        'Long Screen is open source under the MIT license; the code is on <a href="https://github.com/t41372/long-screen" target="_blank" rel="noopener">GitHub</a>. If you hit a bug or get a wrong result, please <a class="report-link" href="https://github.com/t41372/long-screen/issues/new" target="_blank" rel="noopener">open an issue</a>; it comes pre-filled with your browser details and the warning codes from the run log. If you find it useful, a star on the project helps us a lot.',
      licenseHeading: 'Open-source licenses',
      licenseBody:
        'Besides this project\'s own code, the third-party dependencies bundled into the Wasm core and front-end assets and their licenses, as well as the sources and licenses of the Rust, WebAssembly and GitHub logos on this page, are listed in the <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">open-source notices</a> (generated at build time).',
    },
    regions: {
      title: 'Set independent motion regions',
      hint:
        'Drag a rectangle over the frame. Each “content” region is reconstructed independently. Regions left unmarked stay as a separate, explicitly low-confidence observation layer; “ignore” regions are actively excluded.',
      kindMoving: 'Content · scrolls independently',
      kindFixed: 'Fixed UI',
      kindIgnore: 'Ignore · actively excluded',
      clearBtn: 'Restore auto-detection',
      saveBtn: 'Use these regions',
    },
    source: {
      title: 'Original observation',
    },
    footer: {
      stackLead: 'The core is written in',
      stackMid: 'and compiled to',
      stackTail: 'to run right in your browser.',
      stackMore: 'Interface in TypeScript · built and tested with Deno',
      linksLabel: 'Project links',
      source: 'Source on GitHub',
      report: 'Report a bug',
      notices: 'Open-source notices',
      trademarks:
        'Rust, WebAssembly, TypeScript, Deno and GitHub names and logos belong to their owners. They are shown only to say what this project uses, not to suggest that any of them endorses it.',
    },
  },
  deviceCheck: {
    title: 'Device check',
    intro:
      "Measures what this browser and device offer (cross-origin isolation / threads, WebGPU adapter) and the real cost of the GPU path:\nuploading and reading back one native RGBA frame, and the time and byte-for-byte consistency of analysis downscaling on the GPU versus the Rust core.\nOptional: choose a recording to run the full pipeline on both CPU and forced WebGPU and compare tile fingerprints.\nAll processing happens on this device; nothing is uploaded. A chosen recording's run data is deleted after comparing. WebGPU is only available in a secure context (localhost or HTTPS).",
    recordingLabel: 'Recording (optional):',
    runBtn: 'Run check',
    loadingReport: 'Loading core…',
  },
};
