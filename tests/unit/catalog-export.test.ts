// The Rust engine words its diagnostics, names canvases and fills the result package's offline viewer from
// rust/long-screen/catalog/ (a copy of the diag, progress, names and offline catalogue sections, the viewer page and the
// package README). This fails when that copy no longer matches src/i18n, so a wording change
// cannot reach the page and miss the native engine (or the reverse).
import { assertEquals } from '@std/assert';
import { CATALOG_DIR, catalogFiles } from '../../scripts/export-catalog.ts';

Deno.test('catalog export: rust/long-screen/catalog matches the TypeScript catalogues (run deno task export-catalog)', async () => {
  for (const [name, text] of Object.entries(catalogFiles())) {
    assertEquals(await Deno.readTextFile(`${CATALOG_DIR}${name}`), text, `${name} is out of date`);
  }
});
