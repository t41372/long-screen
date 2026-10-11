/** Exports the `diag`, `progress` and `names` sections of the zh and en catalogues (src/i18n) to
 *  rust/engine/catalog/*.json, where the Rust engine embeds them (rust/engine/src/catalog.rs) to word its diagnostics
 *  exactly as the page does and to show region and canvas names in the run's language (src/i18n/names.ts).
 *
 *  Usage: deno task export-catalog          rewrite the JSON files
 *         deno task export-catalog --check  exit 1 if they are out of date (tests/unit/catalog-export.test.ts does the same)
 *
 *  The Rust formatter implements only plain `{{name}}` placeholders, so the export refuses any text in these sections
 *  that uses more of i18next than that: nesting (`$t(…)`), formatters (`{{value, format}}`), unescaped placeholders
 *  (`{{- name}}`) or plural keys (`_one`, `_other`, …). Supporting one of those means extending the formatter first. */
import { fromFileUrl } from '@std/path';
import { zh } from '../src/i18n/zh/index.ts';
import { en } from '../src/i18n/en/index.ts';

type Tree = { [key: string]: string | Tree };
export const CATALOG_SECTIONS = ['diag', 'progress', 'names'] as const;
export const CATALOG_DIR = fromFileUrl(new URL('../rust/engine/catalog/', import.meta.url));
const PLURAL = /_(zero|one|two|few|many|other)$/;

function check(tree: Tree, path: string): void {
  for (const [key, value] of Object.entries(tree)) {
    const at = `${path}.${key}`;
    if (PLURAL.test(key)) throw new Error(`${at}: plural keys are not supported by the Rust formatter`);
    if (typeof value !== 'string') {
      check(value, at);
      continue;
    }
    if (value.includes('$t(')) throw new Error(`${at}: nesting ($t) is not supported by the Rust formatter`);
    for (const [, name] of value.matchAll(/\{\{(.+?)\}\}/g)) {
      if (name.trimStart().startsWith('-') || name.includes(',')) {
        throw new Error(`${at}: {{${name}}} is not a plain placeholder`);
      }
    }
  }
}

/** The JSON text each catalogue file should hold. */
export function catalogJSON(): Record<'zh' | 'en', string> {
  const pick = (catalogue: Record<string, unknown>, locale: string): string => {
    const sections: Tree = {};
    for (const name of CATALOG_SECTIONS) {
      sections[name] = catalogue[name] as Tree;
      check(sections[name] as Tree, `${locale}.${name}`);
    }
    return JSON.stringify(sections, null, 2) + '\n';
  };
  return { zh: pick(zh, 'zh'), en: pick(en, 'en') };
}

if (import.meta.main) {
  const checkOnly = Deno.args.includes('--check');
  let stale = false;
  for (const [locale, text] of Object.entries(catalogJSON())) {
    const file = `${CATALOG_DIR}${locale}.json`;
    let current: string | undefined;
    try {
      current = await Deno.readTextFile(file);
    } catch { /* missing: written below, or stale in --check mode */ }
    if (current === text) continue;
    if (checkOnly) {
      console.error(`${file} is out of date; run deno task export-catalog`);
      stale = true;
    } else {
      await Deno.mkdir(CATALOG_DIR, { recursive: true });
      await Deno.writeTextFile(file, text);
      console.log(`wrote ${file}`);
    }
  }
  if (stale) Deno.exit(1);
}
