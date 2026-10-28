// Shell: turns the solve session's structured diagnostics into the rows the journal has always stored — the
// catalogue text, and each code's fields in the order its row has always had them.
import type { Diagnostic } from '../../types.ts';
import type { EngineDiagnostic } from '../../core/wasm.ts';
import { BUDGET_MESSAGE } from '../../core/keyframes.ts';
import { t } from '../../i18n/index.ts';

export function solveDiagnostic(d: EngineDiagnostic): Diagnostic {
  const { code, time, frame, canvasId, confidence, region, detail, params } = d;
  switch (code) {
    case 'PARTIAL_CONTENT_CHANGE':
      return {
        code,
        severity: 'info',
        time,
        frame,
        canvasId,
        message: t('diag.PARTIAL_CONTENT_CHANGE.message', { percent: params.percent }),
      };
    case 'THIN_OVERLAP_STEP':
      return {
        code,
        severity: 'warning',
        time,
        frame,
        canvasId,
        confidence,
        message: t('diag.THIN_OVERLAP_STEP.message'),
        action: t('diag.THIN_OVERLAP_STEP.action'),
      };
    case 'LOW_CONFIDENCE_PLACEMENT':
      // A tracked step carries the placed rectangle; a static one does not.
      return region
        ? {
          code,
          severity: 'warning',
          time,
          frame,
          canvasId,
          confidence,
          region,
          message: params.ambiguous
            ? t('diag.LOW_CONFIDENCE_PLACEMENT.messageAmbiguous')
            : t('diag.LOW_CONFIDENCE_PLACEMENT.messageLowConfidence'),
          action: t('diag.LOW_CONFIDENCE_PLACEMENT.action'),
          ...(detail ? { detail } : {}),
        }
        : { code, severity: 'warning', time, frame, canvasId, confidence, message: t('diag.LOW_CONFIDENCE_PLACEMENT.messageStatic') };
    case 'UNOBSERVABLE_FRAME':
      return {
        code,
        severity: 'warning',
        time,
        frame,
        canvasId: canvasId || undefined,
        message: t('diag.UNOBSERVABLE_FRAME.message'),
        action: t('diag.UNOBSERVABLE_FRAME.action'),
      };
    case 'RELOCALIZED':
      return { code, severity: 'info', canvasId, time, frame, confidence, detail, message: t('diag.RELOCALIZED.message') };
    case 'SCALE_CHANGE_FRAGMENT':
      return {
        code,
        severity: 'warning',
        canvasId,
        time,
        frame,
        confidence,
        detail,
        message: t('diag.SCALE_CHANGE_FRAGMENT.message', { scale: params.scale.toFixed(2) }),
        action: t('diag.SCALE_CHANGE_FRAGMENT.action'),
      };
    case 'UNPLACED_FRAGMENT':
      return {
        code,
        severity: 'warning',
        canvasId,
        time,
        frame,
        confidence,
        detail: undefined,
        message: t('diag.UNPLACED_FRAGMENT.message'),
        action: t('diag.UNPLACED_FRAGMENT.action'),
      };
    case 'NONFINITE_POSE':
      return { code, severity: 'error', time, frame, message: t('diag.NONFINITE_POSE.message') };
    case 'STICKY_OCCLUSION':
      return { code, severity: 'info', frame, time, canvasId, region, message: t('diag.STICKY_OCCLUSION.message') };
    case 'NESTED_LAYER_FOUND':
      return {
        code,
        severity: 'info',
        canvasId,
        region,
        detail,
        message: t('diag.NESTED_LAYER_FOUND.message', { frames: params.frames }),
      };
    case 'FRAGMENT_ATTACHED':
      return { code, severity: 'info', canvasId, time, frame, confidence, detail, message: t('diag.FRAGMENT_ATTACHED.message') };
    case 'TRAJECTORY_CORRECTED':
      return {
        code,
        severity: 'warning',
        time,
        frame,
        canvasId,
        confidence,
        detail,
        message: t('diag.TRAJECTORY_CORRECTED.message', { discrepancy: params.discrepancy.toFixed(1) }),
        action: t('diag.TRAJECTORY_CORRECTED.action'),
      };
    case 'LOOP_CLOSURE':
      return { code, severity: 'info', canvasId, time, frame, confidence, message: t('diag.LOOP_CLOSURE.message') };
    case 'INCONSISTENT_LOOP_REJECTED':
      return {
        code,
        severity: 'warning',
        time,
        frame,
        canvasId,
        message: t('diag.INCONSISTENT_LOOP_REJECTED.message', { discrepancy: params.discrepancy.toFixed(1) }),
        confidence,
      };
    case 'AMBIGUOUS_LOOP':
      return { code, severity: 'warning', time, frame, canvasId, message: t('diag.AMBIGUOUS_LOOP.message') };
    case 'RELOCALIZATION_BUDGET':
      // Not in the catalogue: the English sentence the journal has always stored.
      return { code, severity: 'warning', message: BUDGET_MESSAGE };
    default:
      throw new Error(`CORE_BAD_ARGUMENT: unknown solve diagnostic ${code}.`);
  }
}
