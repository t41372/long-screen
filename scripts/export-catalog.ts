/** Exports the `diag`, `progress`, `names` and `offline` sections of the zh and en catalogues (src/i18n) to
 *  rust/long-screen/catalog/*.json, where the Rust engine embeds them (rust/long-screen/src/engine/catalog.rs) to word its diagnostics
 *  exactly as the page does, to show region and canvas names in the run's language (src/i18n/names.ts) and to word the
 *  result package's offline viewer; a `viewer` section adds the page's `lang` and `dir` for the locale. The viewer page
 *  itself (src/export/offline.ts `VIEWER_TEMPLATE`), the package README and the manifest's fixed notes go to
 *  catalog/viewer.html, catalog/package-readme.txt and catalog/package-notes.json, which the native result package
 *  (rust/long-screen/src/package.rs) fills and copies.
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
import { HTML_LANG } from '../src/i18n/locales.ts';
import { localeDirection } from '../src/i18n/locales.ts';
import { PACKAGE_NOTES, PACKAGE_README, VIEWER_TEMPLATE } from '../src/export/offline.ts';

type Tree = { [key: string]: string | Tree };
export const CATALOG_SECTIONS = ['diag', 'progress', 'names', 'offline'] as const;
export const CATALOG_DIR = fromFileUrl(new URL('../rust/long-screen/catalog/', import.meta.url));
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
    sections.viewer = { lang: HTML_LANG[locale as 'zh' | 'en'], dir: localeDirection(locale as 'zh' | 'en') };
    return JSON.stringify(sections, null, 2) + '\n';
  };
  return { zh: pick(zh, 'zh'), en: pick(en, 'en') };
}

/** Every file the export writes into CATALOG_DIR, by name, with the text it should hold. */
export function catalogFiles(): Record<string, string> {
  const json = catalogJSON();
  return {
    'zh.json': json.zh,
    'en.json': json.en,
    'viewer.html': VIEWER_TEMPLATE,
    'package-readme.txt': PACKAGE_README,
    'package-notes.json': JSON.stringify(PACKAGE_NOTES, null, 2) + '\n',
  };
}

if (import.meta.main) {
  const checkOnly = Deno.args.includes('--check');
  let stale = false;
  for (const [name, text] of Object.entries(catalogFiles())) {
    const file = `${CATALOG_DIR}${name}`;
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
