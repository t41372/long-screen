/** Structured diagnostics from the engine (`rust/engine/src/diagnostic.rs`), decoded from their `bytes.ts` records
 *  (`rust/wasm/src/diagnostic.rs`). They carry a code and numbers, never text: the pipeline formats them with the
 *  page's catalogue. */
import type { Severity } from '../../types.ts';
import type { ByteReader } from './bytes.ts';

export interface EngineDiagnostic {
  code: string;
  severity: Severity;
  frame?: number;
  time?: number;
  params: Record<string, number>;
}

const SEVERITIES: Severity[] = ['info', 'warning', 'error'];

export function readDiagnostics(r: ByteReader): EngineDiagnostic[] {
  const out: EngineDiagnostic[] = [];
  for (let n = r.u32(), i = 0; i < n; i++) {
    const code = r.str(), severity = SEVERITIES[r.u32()];
    const hasFrame = r.u32(), frame = r.u32(), hasTime = r.u32(), time = r.f64();
    const params: Record<string, number> = {};
    for (let p = r.u32(), k = 0; k < p; k++) {
      const name = r.str();
      params[name] = r.f64();
    }
    out.push({ code, severity, ...(hasFrame ? { frame } : {}), ...(hasTime ? { time } : {}), params });
  }
  return out;
}
