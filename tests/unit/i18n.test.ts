// The website catalogues and what depends on them: every key the static pages reference exists in every
// catalogue, catalogues agree on keys and interpolation variables, plural categories are complete, and Latin,
// Cyrillic and Korean translations have no untranslated Chinese. Persisted canonical names translate completely,
// and the shared runtime starts in zh whatever the host
// locale is (Deno exposes navigator.language, which the shared module must not read).
import { assert, assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { zh } from '../../src/i18n/zh/index.ts';
import { en } from '../../src/i18n/en/index.ts';
import { CATALOGUES, DEFAULT_LOCALE, locale, setLocale, t, translateKey } from '../../src/i18n/index.ts';
import { HTML_LANG, type Locale } from '../../src/i18n/locales.ts';
import { displayName, manualRegionName } from '../../src/i18n/names.ts';
import { offlineViewer } from '../../src/export/offline.ts';

type Tree = { [key: string]: string | Tree };
const HAN = /\p{Script=Han}/u;

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}
const catalogues = Object.fromEntries(Object.entries(CATALOGUES).map(([name, tree]) => [name, flatten(tree as Tree)]));
const variables = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort();

Deno.test('i18n: exported viewer carries language and direction without changing physical canvas coordinates', () => {
  const canvas = { id: 'c1', name: '内容画布 1', bounds: { x: -20, y: 10, width: 2400, height: 1500 } };
  try {
    for (const lng of ['en', 'ar'] as const) {
      setLocale(lng);
      const html = offlineViewer({ canvases: [canvas], tileSize: 512 });
      assert(html.includes(`<html lang="${lng}" dir="${lng === 'ar' ? 'rtl' : 'ltr'}">`));
      assert(html.includes(JSON.stringify(canvas.bounds)), 'coordinates must remain in the original space');
      assert(html.includes('direction:ltr'), 'pixels and technical values retain their direction');
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
      new Function(script); // Validate the emitted standalone JavaScript, including escaped bidi controls.
    }
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

Deno.test('i18n: every catalogue has exactly the zh keys', () => {
  for (const [name, catalogue] of Object.entries(catalogues)) {
    const keys = [...catalogue.keys()].filter((key) => !/_(zero|two|few|many)$/.test(key));
    assertEquals(keys.sort(), [...catalogues.zh.keys()].sort(), name);
    for (const key of catalogue.keys()) {
      const base = key.replace(/_(zero|two|few|many)$/, '_other');
      assert(catalogues.zh.has(base), `${name}: unexpected key ${key}`);
    }
  }
});

Deno.test('i18n: translations use the same interpolation variables as zh', () => {
  for (const [name, catalogue] of Object.entries(catalogues)) {
    for (const [key, text] of catalogue) {
      const base = key.replace(/_(zero|two|few|many)$/, '_other');
      assertEquals(variables(text), variables(catalogues.zh.get(base)!), `${name}: ${key}`);
    }
  }
});

Deno.test('i18n: every locale provides and selects all of its plural forms without falling back to Chinese', () => {
  try {
    for (const [name, catalogue] of Object.entries(catalogues)) {
      const lng = name as Locale;
      setLocale(lng);
      const rules = new Intl.PluralRules(HTML_LANG[lng]);
      for (const key of catalogues.zh.keys()) {
        if (!key.endsWith('_other')) continue;
        const base = key.slice(0, -6);
        for (const category of rules.resolvedOptions().pluralCategories) {
          assert(catalogue.has(`${base}_${category}`), `${name}: missing ${base}_${category}`);
        }
        for (const count of [0, 1, 2, 5, 11, 21, 22, 25, 101, 1.5, 1_000_000]) {
          const template = catalogue.get(`${base}_${rules.select(count)}`)!;
          const values: Record<string, string> = { count: String(count), frames: String(count), kind: 'PNG', fragment: '' };
          const expected = template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
          assertEquals(
            t(base as 'ui.count.frames', { count, frames: count, kind: 'PNG', fragment: '' }),
            expected,
            `${name}: ${base}/${count}`,
          );
        }
      }
    }
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

Deno.test('i18n: translated HTML keeps the original tags, attributes and links', () => {
  const tags = (text: string) => text.match(/<[^>]+>/g) ?? [];
  for (const [name, catalogue] of Object.entries(catalogues)) {
    for (const [key, text] of catalogues.zh) {
      assertEquals(tags(catalogue.get(key)!), tags(text), `${name}: ${key}`);
    }
  }
});

Deno.test('i18n: plural pairs are complete, and identical in zh so a count never changes zh text', () => {
  for (const [name, catalogue] of Object.entries(catalogues)) {
    for (const key of catalogue.keys()) {
      const plural = /^(.*)_(one|other)$/.exec(key);
      if (!plural) continue;
      assert(catalogue.has(`${plural[1]}_one`) && catalogue.has(`${plural[1]}_other`), `${name}: ${key} has no pair`);
      if (name === 'zh') assertEquals(catalogue.get(`${plural[1]}_one`), catalogue.get(`${plural[1]}_other`), key);
    }
  }
});

Deno.test('i18n: non-Han catalogues have no untranslated Chinese', () => {
  for (const name of Object.keys(catalogues).filter((name) => !['zh', 'zh-Hant', 'ja'].includes(name))) {
    for (const [key, text] of catalogues[name]) {
      assert(!HAN.test(text), `${name}/${key}: ${text}`);
    }
  }
});

Deno.test('i18n: every data-i18n key in the static pages exists in every catalogue', async () => {
  for (const page of ['index.html', 'device-check.html']) {
    const html = await Deno.readTextFile(fromFileUrl(new URL(`../../static/${page}`, import.meta.url)));
    const keys = [
      ...[...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1]),
      ...[...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((pair) => pair.split(':')[1].trim())),
    ];
    for (const key of keys) {
      for (const [name, catalogue] of Object.entries(catalogues)) {
        assert(catalogue.has(key), `${page}: ${key} missing from ${name}`);
      }
    }
  }
});

Deno.test('i18n: the shared runtime starts in zh and switches synchronously', () => {
  assertEquals(locale(), DEFAULT_LOCALE);
  assertEquals(translateKey('page.title'), zh.page.title);
  try {
    setLocale('en');
    assertEquals(translateKey('page.title'), en.page.title);
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});

Deno.test('i18n: canonical region and canvas names translate completely', () => {
  const names = [
    '固定界面',
    '固定分隔界面',
    '内容画布 3',
    '未指定区域 · 屏幕坐标观察',
    manualRegionName('moving', 2),
    manualRegionName('fixed', 1),
    manualRegionName('ignore', 1),
    '内容画布 1 · 未定位片段 2',
    '内容画布 1 · 保留外框',
    '未指定区域 · 屏幕坐标观察 · 未定位片段 4 · 保留外框',
  ];
  for (const name of names) assertEquals(displayName(name), name, 'zh shows the persisted name');
  try {
    setLocale('en');
    for (const name of names) assert(!HAN.test(displayName(name)), `${name} → ${displayName(name)}`);
    assertEquals(displayName('内容画布 1 · 未定位片段 2 · 保留外框'), 'Content canvas 1 · unplaced fragment 2 · framed');
    assertEquals(displayName('recording.mov'), 'recording.mov');
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
});
