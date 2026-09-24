/** Display names for regions and canvases. The names the pipeline persists are a closed zh vocabulary, not text in
 *  the viewer's language: the Rust core and src/core/wasm/regions.ts name auto-detected regions (固定界面, 固定分隔界面
 *  — which rust/core/src/regions/crops.rs also matches on — and 内容画布 N), src/core/layers.ts names the unassigned
 *  layer, src/ui/regions.ts names manual regions, and solve/state.ts and core/framing.ts append the fragment and
 *  framed-presentation suffixes. Keeping them canonical keeps persisted projects, parity oracles and scenario
 *  fingerprints independent of the UI language; they are translated here, at display time, which also covers
 *  projects saved before the UI had a second language. A name outside the vocabulary is shown as stored. */
import { zh } from './zh/index.ts';
import { DEFAULT_LOCALE, locale, t } from './index.ts';

const SEPARATOR = ' · ';
const canonical = zh.names;
const numbered = (template: string) => new RegExp(`^${template.replace('{{n}}', '(\\d+)')}$`);
const CONTENT_CANVAS = numbered(canonical.contentCanvas);
const CONTENT_REGION = numbered(canonical.contentRegion);
const FRAGMENT = numbered(canonical.fragment);

/** The canonical (persisted) name of a manual region, whatever language the UI is in. */
export function manualRegionName(kind: 'moving' | 'fixed' | 'ignore', n: number): string {
  return kind === 'moving' ? canonical.contentRegion.replace('{{n}}', String(n)) : kind === 'fixed' ? canonical.fixed : canonical.ignored;
}

const EXACT = new Map(
  [
    [canonical.fixed, 'names.fixed'],
    [canonical.divider, 'names.divider'],
    [canonical.unassigned, 'names.unassigned'],
    [canonical.ignored, 'names.ignored'],
  ] as const,
);

function base(name: string): string {
  const key = EXACT.get(name);
  if (key) return t(key);
  const canvas = CONTENT_CANVAS.exec(name);
  if (canvas) return t('names.contentCanvas', { n: canvas[1] });
  const region = CONTENT_REGION.exec(name);
  if (region) return t('names.contentRegion', { n: region[1] });
  return name;
}

/** `name` in the current UI language: base name, then an optional unplaced-fragment suffix, then an optional
 *  framed-presentation suffix, each translated independently. */
export function displayName(name: string): string {
  if (locale() === DEFAULT_LOCALE) return name;
  const suffixes: string[] = [];
  let rest = name;
  if (rest.endsWith(SEPARATOR + canonical.framed)) {
    rest = rest.slice(0, -(SEPARATOR + canonical.framed).length);
    suffixes.unshift(t('names.framed'));
  }
  const cut = rest.lastIndexOf(SEPARATOR);
  const fragment = cut >= 0 ? FRAGMENT.exec(rest.slice(cut + SEPARATOR.length)) : null;
  if (fragment) {
    rest = rest.slice(0, cut);
    suffixes.unshift(t('names.fragment', { n: fragment[1] }));
  }
  return [base(rest), ...suffixes].join(SEPARATOR);
}
