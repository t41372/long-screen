import type { Catalog } from '../catalog.ts';
import type { pipelineSections as zh } from '../zh/pipeline.ts';

export const pipelineSections: Catalog<typeof zh> = {
  diag: {
    MODEL_ASSUMPTIONS: {
      message:
        'Reconstruction uses layered panning canvases with geometric loop-closure constraints. Automatic masking and dynamic-region detection are heuristic inference; confidence scores are not calibrated correctness probabilities. World-consistency comparisons run at this source’s declared decode noise of ±{{noise}} levels{{margin}}.',
      marginLossy: ' (headroom for compressed-video ringing/chroma reconstruction)',
      marginLossless: ' (lossless source, exact pixel-for-pixel comparison)',
      action: 'When scale or structure cannot coexist, an independent fragment is kept rather than forcing incompatible states together.',
    },
    APPROXIMATE_DECODER: {
      message:
        '“Approximate · native seek” at {{fps}} Hz was explicitly enabled. Not every frame of the video is guaranteed to be captured; brief content may be missing.',
      action: 'When frame-by-frame coverage must be guaranteed, use a WebCodecs-supported input such as H.264 or VP9.',
    },
    ANALYSIS_PYRAMID: {
      message:
        'Motion analysis caps the long edge at {{size}}px; native-resolution pixels are used for refinement and final compositing, so the output does not follow the downsample.',
    },
    FRAME_MEMORY_PRESSURE: {
      message:
        'One native frame plus its reference frames are close to the selected cache budget. Codec/GPU memory itself is not controlled by the JavaScript cache budget.',
      action:
        'Output resolution is never silently reduced; on memory pressure, already-committed data is kept and the failure is reported.',
    },
    RUN_FAILURE: {
      action: 'Tiles already committed to local storage remain viewable and exportable; the failure was not marked as a success.',
    },
    PERSISTENCE_ERROR: {
      action: 'The storage write also failed; only data committed earlier can be recovered.',
    },
    MEMORY_BUDGET_RAISED: {
      message:
        'The tile cache was raised from the {{from}} tiles the budget allowed to {{to}} tiles (about {{mb}} MB), to hold every tile one frame touches.',
      action:
        'A cache smaller than one frame’s coverage would force every frame to fully re-decode and re-encode all its tiles; lower the recording resolution for a smaller memory footprint.',
    },
    NONFINITE_POSE: {
      message:
        'Placement computation produced a non-finite value. This observation was isolated; the invalid coordinates were not written to the canvas.',
    },
    MISSING_PLAN: {
      message: 'The render stage is missing plan/{{index}}; stopped at the already-committed render prefix.',
      action: 'Check local storage integrity; a missing solve plan is never silently treated as an empty observation.',
    },
    prefixOnly: {
      base: {
        scan: 'Continuing placement and compositing with only the frames decoded so far ({{frames}})',
        solve: 'Continuing rendering with only the frames solved so far ({{frames}})',
        render: 'Keeping results only for the frames rendered so far ({{frames}})',
      },
      suffixPersistence: '; the storage write has stopped.',
      suffixDefault: '.',
    },
    PRESENTATION_TOO_SPARSE: {
      action: 'This canvas’s framed presentation was skipped; the core reconstruction in page coordinates is unaffected.',
    },
    PRESENTATION_FRAME: {
      message:
        'The framed view and the original 2D content are kept separately. The frame comes from a reference frame; the extended portion is decorative background only and does not count as observed content — toolbar icons are never stretched or duplicated. Other panes inside the frame are reference snapshots only.',
    },
    PRESENTATION_STAGE_FAILED: {
      action: 'The framed-presentation stage failed; the core reconstruction result and status in page coordinates are unaffected.',
    },
    PYRAMID_FAILED: {
      action: 'Preview pyramid construction failed; native-size tiles are unaffected and remain viewable and exportable.',
    },
    PASS_FRAME_COUNT_MISMATCH: {
      message: 'The {{pass}} stage only completed {{actual}}/{{expected}} frames; the result was marked partial.',
      action: 'The successfully committed prefix was kept; missing frames are never silently treated as processed.',
    },
    COMPUTE_BACKEND: {
      message: '{{backend}} — {{reason}}. Rust core: {{variant}} build, compute threads: {{threads}} ({{coreReason}}).',
    },
    PRESENTATION_REFERENCE_FAILED: {
      action: 'The framed presentation will be skipped; the core reconstruction in page coordinates is unaffected.',
    },
    LOW_TEXTURE_UNOBSERVABLE: {
      message:
        'The frame lacks recognizable texture. An identical blank frame could equally be a pause or motion over a blank area; the pixels alone cannot distinguish them.',
      action: 'Add distinguishable visible content or record more overlap. Zero displacement here is only a best guess.',
    },
    UNRESOLVED_MOTION: {
      message:
        'This observation lacks a reliable visual-alignment basis. The solve stage will attempt historical relocalization; an independent fragment is kept if it still cannot be placed.',
    },
    AMBIGUOUS_PATTERN: {
      message:
        'A repeating texture with several equally plausible matches was detected; continuity is only a placement prior, not a proven, unique position.',
    },
    TEMPORAL_UNDERSAMPLING: {
      message: 'This frame spans an unusually long duration; areas may exist that were never captured during fast motion.',
    },
    MANUAL_UNASSIGNED: {
      message:
        'The part not covered by manual regions is kept as an independent, low-confidence screen-space observation layer; these pixels are not claimed to have been recovered into page coordinates.',
    },
    EXPLICITLY_EXCLUDED_REGION: {
      message:
        'An “ignore” region was excluded as set manually. That region contributes nothing to the reconstruction; this is not frames being dropped automatically.',
    },
    MANUAL_REGION_PRIORITY: {
      message:
        'Where manual regions overlap, the later-drawn region takes priority; ignored regions are always excluded. Remaining pixels are kept in the unassigned observation layer.',
    },
    AUTOMATIC_LAYER_MASK: {
      message:
        'Automatically split into {{moving}} content region(s) and {{fixed}} fixed-UI region(s). Boundaries come from pixel-motion statistics, not the DOM.',
      action: 'If a mask’s assignment looks wrong, draw a precise scroll region under “Motion regions” and reprocess.',
    },
    MULTIPLE_SCROLL_LAYERS: {
      message: 'Multiple independent scroll regions will each get their own canvas; they are not forced to share one scroll offset.',
    },
    TEMPORAL_OR_ALIGNMENT_CONFLICT: {
      message:
        'After aligning this frame, the overlap area has {{conflicts}} noticeably different pixels in total; this region is one conflicting component within it. Possible causes: animation, content updates, reflow, or registration residual.',
      actionStable:
        'The complete conflicting region was frozen to a single moment where possible; check the orange diagnostics and the original video timestamp.',
      actionRolling:
        'The whole conflicting region is updated with the same frame only when fully visible; it is not the same moment across the whole page.',
    },
    INCOMPLETE_TEMPORAL_PATCH: {
      message:
        'This changed region never appeared complete within one usable viewport; not all of its pixels are guaranteed to come from the same moment.',
      action: 'Observed content and explicit conflict marking are kept; unobserved parts were not invented.',
    },
    MISSING_SCAN_RECORD: {
      message: 'The solve stage is missing scan/{{index}}; stopped at the already-committed solve prefix.',
      action: 'Check local storage integrity; a missing scan record is never treated as zero displacement.',
    },
    GRAPH_RESIDUAL: {
      message: 'The pose graph’s maximum residual is still {{residual}} native pixels; nearby seams may show geometric inconsistency.',
      action: 'Check text and repeating textures near the loop closure. This residual was not hidden.',
    },
    PARTIAL_CONTENT_CHANGE: {
      message:
        'About {{percent}}% of texture blocks disagree with the overall displacement (animation, video, lazy loading, or reflow); the displacement is decided by the consistent blocks, and the conflicting region is handled separately at compositing time.',
    },
    THIN_OVERLAP_STEP: {
      message:
        'The frames moved quickly against each other, leaving only a small overlap to align on. The displacement is drawn from this small piece of evidence; in a periodically repeating layout, an adjacent period could equally explain these pixels.',
      action: 'If a later revisit provides stronger evidence, this whole trajectory segment will be corrected and recorded.',
    },
    LOW_CONFIDENCE_PLACEMENT: {
      messageAmbiguous:
        'A repeating texture lets several displacements explain the pixels; the solution most consistent with motion continuity was used — a best guess, not the only correct alignment.',
      messageLowConfidence: 'This region used a low-confidence placement estimate; the affected pixels are flagged in the quality mask.',
      messageStatic:
        'The two frames are nearly identical but lack a verifiable feature correspondence; treated as a pause (zero displacement) — a best guess.',
      action:
        'The continuous trajectory and any existing anchor were used for a best guess; this is not asserted to be the only correct alignment.',
    },
    UNOBSERVABLE_FRAME: {
      message:
        'This frame has no recognizable texture in this region: a blank frame could equally be a pause or motion over a blank area, and pixels alone cannot distinguish them. It is not painted anywhere.',
      action:
        'If the content after the blank cannot overlap with the prior observation, it is kept as an independent fragment rather than guessing the distance in between.',
    },
    RELOCALIZED: {
      message:
        'Relocalized onto an already-observed canvas via a historical visual anchor; the revisited content was not appended as new long-image extent.',
    },
    SCALE_CHANGE_FRAGMENT: {
      message:
        'Detected an approximately {{scale}}× scale/layout transform; kept as an independent fragment at native pixels — no scaling was quietly blended in.',
      action:
        'The relationship across fragments is not yet confirmed; if a later revisit matches reliably, the fragment will be reattached as a whole. Re-record with more overlap, or isolate the changing component with a manual region.',
    },
    UNPLACED_FRAGMENT: {
      message:
        'Could not confirm the position relative to the original canvas; kept as an independent, separately exportable fragment. The two fragments may overlap, or a genuine gap may exist between them.',
      action:
        'The relationship across fragments is not yet confirmed; if a later revisit matches reliably, the fragment will be reattached as a whole. Re-record with more overlap, or isolate the changing component with a manual region.',
    },
    STICKY_OCCLUSION: {
      message:
        'Texture at the top of the frame indicates screen-fixed UI rather than page movement; this observation’s fixed occlusion is not written into the moving canvas. The original reference UI is kept in the framed presentation.',
    },
    FRAGMENT_ATTACHED: {
      message:
        'Revisit evidence reattached an independent fragment onto an existing canvas as a whole; the relative trajectory within the fragment is unchanged.',
    },
    TRAJECTORY_CORRECTED: {
      message:
        'The previous step had only a small overlap; this frame’s match against already-observed content differs by {{discrepancy}}px and the evidence is stronger — the current position was corrected to this match.',
      action:
        'What was corrected is this frame and the trajectory after it; pixels written earlier are unchanged and may show a seam against the corrected coordinates.',
    },
    LOOP_CLOSURE: {
      message:
        'A reliable historical revisit was found and added as a global position constraint; final compositing uses the corrected trajectory.',
    },
    INCONSISTENT_LOOP_REJECTED: {
      message:
        'The historical match differs from the continuous trajectory by {{discrepancy}}px; the evidence conflicts, so it was not imposed as a loop closure.',
    },
    AMBIGUOUS_LOOP: {
      message:
        'Historical retrieval returned several nearly equally plausible positions; an uncertain loop closure was not imposed as a hard constraint.',
    },
  },
  progress: {
    runPartial: 'An explicitly marked partial reconstruction was saved.',
    runComplete: 'Reconstruction complete; check the diagnostics and unobserved areas.',
    render: 'Compositing native-size tiles from observed evidence; gaps stay transparent.',
    framingStart: 'Preserving the original frame; only the background is extended, without stretching sidebar text or duplicating icons.',
    pyramidBuild: 'Building the on-disk preview pyramid; native-size tiles are unchanged.',
    scanFrame: 'Extracting geometric evidence frame by frame, learning independent motion regions.',
    duplicateReuse: 'An identical observation reused the previous placement; the source frame and timestamp are retained.',
    solveFrame: 'Native-pixel refinement, historical relocalization, and 2D loop-closure constraints.',
    optimizing: 'Optimizing the on-disk pose graph, correcting loop-closure drift.',
  },
  media: {
    CONTAINER_SIZE_MISMATCH:
      'The container declared {{codedWidth}}×{{codedHeight}}, but the bitstream is actually {{bitstreamWidth}}×{{bitstreamHeight}}; the bitstream size is authoritative.',
    NON_SQUARE_PIXELS:
      'This recording declares a non-square pixel aspect ratio (display size {{displayWidth}}×{{displayHeight}}, storage size {{bitstreamWidth}}×{{bitstreamHeight}}); the original stored pixels are kept, unscaled.',
    NEGATIVE_TIMESTAMP_SKIPPED:
      'The decoder produced a frame before the edit list’s start point (a negative timestamp); such frames are not shown, per container semantics.',
    NONMONOTONIC_TIMESTAMP:
      'A container timestamp went backwards; processing continued in the decoder’s presentation order, and no observation was discarded.',
    NONSTANDARD_SIGNED_CTTS_V0:
      'NONSTANDARD_SIGNED_CTTS_V0: This video track’s ctts box is version 0 but contains negative composition-time offsets; ISO 14496-12 only defines negative offsets in version 1. These offsets are treated as signed (a common QuickTime/ReplayKit convention), not as unusually large positive offsets.',
  },
  exports: {
    tilesProgress: 'Exporting native and preview tiles {{n}}',
    zipFinalize: 'Writing the ZIP64 directory and committing the file',
    projectDone: {
      message: 'Exported native-size tiles, the offline viewer, coverage and quality data, source-frame records, and the full diagnostics.',
    },
    encodingSingle: 'Encoding row {{row}} / {{total}} at native scale',
    canvasDone: {
      message: 'Exported a {{width}} × {{height}} native-size PNG; gaps stay transparent.',
    },
    encodingSheet: 'Encoded {{count}} native-size sheet image(s)',
    sheetsDone: {
      messagePaged:
        'Exported as {{count}} native-size sheet image(s); adjacent sheets overlap by up to {{overlap}}px, with coordinates in the manifest.',
      messageOversize:
        'The canvas exceeded the single-image compatible size, so it was explicitly exported as {{count}} native-size sheet image(s) instead; adjacent sheets overlap by up to {{overlap}}px, with coordinates in the manifest.',
    },
  },
  offline: {
    title: 'Offline canvas',
    fit: 'Fit',
    tip: 'Local native-size tiles · drag / scroll to zoom',
    previewLevel: 'Showing preview level {{level}}; zoom in to see native pixels',
    nativeTiles: 'Showing native-size tiles',
    footer:
      'Checkerboard areas are unobserved / have no tiles; confidence is not a correctness probability. See diagnostics.jsonl and observations.jsonl.',
  },
};
