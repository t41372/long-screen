// The Rust engine words its diagnostics from rust/engine/catalog/*.json, a copy of the diag and progress catalogue
// sections. This fails when that copy no longer matches src/i18n, so a wording change cannot reach the page and miss
// the native engine (or the reverse).
import { assertEquals } from '@std/assert';
import { CATALOG_DIR, catalogJSON } from '../../scripts/export-catalog.ts';

Deno.test('catalog export: rust/engine/catalog matches the TypeScript catalogues (run deno task export-catalog)', async () => {
  for (const [locale, text] of Object.entries(catalogJSON())) {
    assertEquals(await Deno.readTextFile(`${CATALOG_DIR}${locale}.json`), text, `${locale}.json is out of date`);
  }
});
