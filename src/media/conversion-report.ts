/** What a frame converter's first-frame report (`FrameConverter.report`) means for the person running the print: an
 *  info diagnostic naming the conversion, and warnings for what the converter could not do well — an HDR recording
 *  whose colours could not be checked, one whose SDR white sits higher than the 100 nits assumed (its whites clip),
 *  and a conversion slow enough to dominate the run. The worker records them as diagnostics on the scan's first frame;
 *  the page shows the warnings when a file is picked, from the probe's report. */
import { t } from '../i18n/index.ts';
import type { ConversionReport, Diagnostic, MediaInfo } from '../types.ts';

/** Conversions per frame over a whole run (scan, solve, render and the reveal passes each read the recording):
 *  3,712 for the 593 frames of a 3024 × 2018 HDR recording, measured in WebKit. */
const CONVERSIONS_PER_FRAME = 6;
/** Estimated conversion time above which a run is called slow, in seconds. */
const SLOW_SECONDS = 120;
/** Share of the first frame's pixels above SDR white beyond which the white is taken to sit higher than assumed: an
 *  iPhone screen recording had 0.3 % (a few highlights), while OBS, whose SDR white defaults to 300 nits, would put
 *  every white background there. */
const ABOVE_WHITE_SHARE = 0.05;

export function conversionDiagnostics(report: ConversionReport, info: MediaInfo): Diagnostic[] {
  const out: Diagnostic[] = [{
    code: 'FRAME_CONVERSION',
    severity: 'info',
    message: t('diag.FRAME_CONVERSION.message', { method: report.method }),
    detail: report,
  }];
  if (report.hdr && !report.hdr.verified) {
    out.push({
      code: 'HDR_UNCHECKED',
      severity: 'warning',
      message: t('diag.HDR_UNCHECKED.message', { transfer: report.hdr.transfer.toUpperCase() }),
      action: t('diag.HDR_UNCHECKED.action'),
    });
  }
  if (report.hdr?.aboveShare !== undefined && report.hdr.aboveShare > ABOVE_WHITE_SHARE) {
    out.push({
      code: 'HDR_ABOVE_WHITE',
      severity: 'warning',
      message: t('diag.HDR_ABOVE_WHITE.message', { percent: Math.round(report.hdr.aboveShare * 100) }),
      action: t('diag.HDR_ABOVE_WHITE.action'),
      detail: { aboveShare: report.hdr.aboveShare },
    });
  }
  const frames = info.frameCount ?? Math.round(info.duration * 30);
  const seconds = report.ms === undefined ? 0 : report.ms * frames * CONVERSIONS_PER_FRAME / 1000;
  if (seconds > SLOW_SECONDS) {
    out.push({
      code: 'SLOW_CONVERSION',
      severity: 'warning',
      message: t('diag.SLOW_CONVERSION.message', { ms: Math.round(report.ms!), minutes: Math.round(seconds / 60) }),
      action: t('diag.SLOW_CONVERSION.action'),
      detail: { ms: report.ms, frames, estimatedSeconds: Math.round(seconds) },
    });
  }
  return out;
}
