/** Native opacity model handles. Model fields and candidate pages are streamed through KV by the
 * pipeline; this adapter only owns their buffers and lifetimes. */
import type { Core } from './core.ts';
import { FreeGuard } from './memory.ts';
import { sourceBytes, type SourceEvidence, sourceJSON } from './sources.ts';
export type { SourceEvidence } from './sources.ts';
export interface OpacityDescriptor {
  size: number;
  tx: number;
  ty: number;
  evidence: SourceEvidence;
}
function prepare(core: Core, data: Uint8Array, desc: OpacityDescriptor): [number, number, number, number] {
  const meta = new TextEncoder().encode(JSON.stringify({ ...desc, evidence: desc.evidence.handle })),
    [ptr, json] = core.scratch([data.length, meta.length]);
  core.writeBytes(ptr, data);
  core.writeBytes(json, meta);
  return [ptr, data.length, json, meta.length];
}
export class OpacityLearning {
  private guard = new FreeGuard();
  readonly handle: number;
  constructor(private core: Core, analysis: number, data: Uint8Array, page: number, desc: OpacityDescriptor) {
    const [ptr, len, json, jsonLen] = prepare(core, data, desc);
    this.handle = core.check(core.exports.ls_sources_opacity_learn(analysis, ptr, len, page, json, jsonLen), 'opacity witnesses');
  }
  keys(): string[] {
    return sourceJSON(this.core, this.core.exports.ls_sources_opacity_keys(this.handle, 0));
  }
  free(): void {
    this.guard.once(() => this.core.exports.ls_sources_opacity_free(this.handle, 0));
  }
}
export class OpacityAnnotation {
  private guard = new FreeGuard();
  private handle: number;
  constructor(private core: Core, data: Uint8Array, page: number, desc: OpacityDescriptor) {
    const [ptr, len, json, jsonLen] = prepare(core, data, desc);
    this.handle = core.check(core.exports.ls_sources_opacity_prepare(ptr, len, page, json, jsonLen), 'opacity candidates');
  }
  keys(): string[] {
    return sourceJSON(this.core, this.core.exports.ls_sources_opacity_keys(this.handle, 1));
  }
  applyFitted(analysis: number, key: string, field: FittedOpacityField, noise: number): number {
    const name = new TextEncoder().encode(key), [ptr] = this.core.scratch([name.length]);
    this.core.writeBytes(ptr, name);
    return this.core.check(
      this.core.exports.ls_sources_opacity_fitted_apply(this.handle, analysis, ptr, name.length, field.handle, noise),
      'fitted opacity visibility',
    );
  }
  archive(): Uint8Array<ArrayBuffer> {
    return sourceBytes(this.core, this.core.exports.ls_sources_opacity_archive(this.handle));
  }
  feed(analysis: number, page: number): void {
    this.core.check(this.core.exports.ls_sources_opacity_feed(this.handle, analysis, page), 'analyze opacity candidates');
  }
  free(): void {
    this.guard.once(() => this.core.exports.ls_sources_opacity_free(this.handle, 1));
  }
}
export function opacityValid(core: Core, data: Uint8Array, noise: number): number {
  const [ptr] = core.scratch([data.length]);
  core.writeBytes(ptr, data);
  return core.check(core.exports.ls_sources_opacity_valid(ptr, data.length, noise), 'opacity validity');
}
export function opacityExport(core: Core, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const [ptr] = core.scratch([data.length]);
  core.writeBytes(ptr, data);
  return sourceBytes(core, core.exports.ls_sources_opacity_export(ptr, data.length));
}

export class OpacityField {
  private guard = new FreeGuard();
  private handle: number;
  constructor(private core: Core, data?: Uint8Array) {
    const [ptr] = core.scratch([data?.length ?? 0]);
    if (data) core.writeBytes(ptr, data);
    this.handle = core.check(core.exports.ls_sources_opacity_field_new(ptr, data?.length ?? 0), 'opacity field');
  }
  merge(learning: OpacityLearning, key: string, noise: number): boolean {
    const name = new TextEncoder().encode(key), [ptr] = this.core.scratch([name.length]);
    this.core.writeBytes(ptr, name);
    return this.core.check(
      this.core.exports.ls_sources_opacity_field_merge(this.handle, learning.handle, ptr, name.length, noise),
      'update opacity field',
    ) !== 0;
  }
  bytes(): number {
    return this.core.check(this.core.exports.ls_sources_opacity_field_bytes(this.handle), 'opacity field bytes');
  }
  state(): Uint8Array<ArrayBuffer> {
    return sourceBytes(this.core, this.core.exports.ls_sources_opacity_field_state(this.handle));
  }
  free(): void {
    this.guard.once(() => this.core.exports.ls_sources_opacity_field_free(this.handle));
  }
}

export class FittedOpacityField {
  readonly handle: number;
  private guard = new FreeGuard();
  constructor(private core: Core, data: Uint8Array, noise: number) {
    const [ptr] = core.scratch([data.length]);
    core.writeBytes(ptr, data);
    this.handle = core.check(core.exports.ls_sources_opacity_fitted_new(ptr, data.length, noise), 'fitted opacity field');
  }
  bytes(): number {
    return this.core.check(this.core.exports.ls_sources_opacity_fitted_bytes(this.handle), 'fitted opacity bytes');
  }
  free(): void {
    this.guard.once(() => this.core.exports.ls_sources_opacity_fitted_free(this.handle));
  }
}
