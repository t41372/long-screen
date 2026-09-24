// The catalogues (src/i18n/{zh,en}) and what depends on them: every key the static pages reference exists in every
// catalogue, catalogues agree on keys and on interpolation variables, the English catalogue has no untranslated
// Chinese, persisted canonical names translate completely, and the shared runtime starts in zh whatever the host
// locale is (Deno exposes navigator.language, which the shared module must not read).
import { assert, assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { zh } from '../../src/i18n/zh/index.ts';
import { en } from '../../src/i18n/en/index.ts';
import { DEFAULT_LOCALE, locale, setLocale, translateKey } from '../../src/i18n/index.ts';
import { displayName, manualRegionName } from '../../src/i18n/names.ts';

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
const catalogues = { zh: flatten(zh as Tree), en: flatten(en as Tree) };
const variables = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort();

Deno.test('i18n: every catalogue has exactly the zh keys', () => {
  assertEquals([...catalogues.en.keys()].sort(), [...catalogues.zh.keys()].sort());
});

Deno.test('i18n: translations use the same interpolation variables as zh', () => {
  for (const [key, text] of catalogues.zh) {
    assertEquals(variables(catalogues.en.get(key)!), variables(text), key);
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

Deno.test('i18n: the English catalogue has no untranslated Chinese', () => {
  for (const [key, text] of catalogues.en) {
    assert(!HAN.test(text), `${key}: ${text}`);
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
