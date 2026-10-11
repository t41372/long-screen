/** Structured diagnostics from the engine (`rust/engine/src/diagnostic.rs`), decoded from their `bytes.ts` records
 *  (`rust/wasm/src/diagnostic.rs`). They carry a code and numbers, never text: the pipeline formats them with the
 *  page's catalogue. */
import type { Rect, Severity } from '../../types.ts';
import type { ByteReader } from './bytes.ts';

export interface EngineDiagnostic {
  code: string;
  severity: Severity;
  frame?: number;
  time?: number;
  params: Record<string, number>;
  canvasId?: string;
  confidence?: number;
  region?: Rect;
  detail?: unknown;
}

const SEVERITIES: Severity[] = ['info', 'warning', 'error'];

export function readDiagnostics(r: ByteReader): EngineDiagnostic[] {
  const out: EngineDiagnostic[] = [];
  for (let n = r.u32(), i = 0; i < n; i++) out.push(readDiagnostic(r));
  return out;
}

/** One diagnostic, without the count. */
export function readDiagnostic(r: ByteReader): EngineDiagnostic {
  {
    const code = r.str(), severity = SEVERITIES[r.u32()];
    const hasFrame = r.u32(), frame = r.u32(), hasTime = r.u32(), time = r.f64();
    const params: Record<string, number> = {};
    for (let p = r.u32(), k = 0; k < p; k++) {
      const name = r.str();
      params[name] = r.f64();
    }
    const d: EngineDiagnostic = { code, severity, ...(hasFrame ? { frame } : {}), ...(hasTime ? { time } : {}), params };
    if (r.u32()) d.canvasId = r.str();
    if (r.u32()) d.confidence = r.f64();
    if (r.u32()) d.region = { x: r.f64(), y: r.f64(), width: r.f64(), height: r.f64() };
    if (r.u32()) d.detail = readValue(r);
    return d;
  }
}

/** A `detail` payload; object fields keep their order. */
function readValue(r: ByteReader): unknown {
  switch (r.u8()) {
    case 0:
      return r.f64();
    case 1:
      return r.u8() !== 0;
    case 2:
      return r.str();
    case 4:
      return Array.from({ length: r.u32() }, () => readValue(r));
    default: {
      const o: Record<string, unknown> = {};
      for (let n = r.u32(); n > 0; n--) {
        const name = r.str();
        o[name] = readValue(r);
      }
      return o;
    }
  }
}
