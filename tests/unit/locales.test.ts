import { assertEquals } from '@std/assert';
import { isolateLtr, localeDirection, resolveLocale } from '../../src/i18n/locales.ts';

// Browser language tags must retain Chinese script, accept regional variants, and let unsupported preferences
// fall through to the next language. An explicit script takes precedence over the region.
Deno.test('i18n: browser language tags resolve without losing Chinese script', () => {
  const cases = {
    zh: 'zh',
    'zh-CN': 'zh',
    'zh-SG': 'zh',
    'zh-TW': 'zh-Hant',
    'zh-HK': 'zh-Hant',
    'zh-MO': 'zh-Hant',
    'zh-Hant': 'zh-Hant',
    'zh-Hant-CN': 'zh-Hant',
    'zh-Hans-TW': 'zh',
    'ZH-hant-hk': 'zh-Hant',
    'en-GB': 'en',
    'ja-JP': 'ja',
    'ko-KR': 'ko',
    'ru-RU': 'ru',
    'uk-UA': 'uk',
    'fr-CA': 'fr',
    'de-AT': 'de',
    'es-MX': 'es',
    pt: 'pt-BR',
    'pt-BR': 'pt-BR',
    'PT-br': 'pt-BR',
    'pt-PT': 'pt-PT',
    'pt-AO': 'pt-PT',
    'pt-MZ': 'pt-PT',
    'pt-Latn-PT': 'pt-PT',
    'id-ID': 'id',
    'vi-VN': 'vi',
    'tr-TR': 'tr',
    'it-IT': 'it',
    'pl-PL': 'pl',
    'th-TH': 'th',
    'nl-BE': 'nl',
    'hi-IN': 'hi',
    'ar-SA': 'ar',
    'ar-EG': 'ar',
    'sv-SE': undefined,
    '': undefined,
  };
  for (const [tag, expected] of Object.entries(cases)) assertEquals(resolveLocale(tag), expected, tag);
});

Deno.test('i18n: technical dimensions keep their LTR order inside Arabic labels without changing other locales', () => {
  assertEquals(isolateLtr('2400 × 1500', 'ar'), '\u20662400 × 1500\u2069');
  assertEquals(isolateLtr('2400 × 1500', 'en'), '2400 × 1500');
  assertEquals(isolateLtr('2400 × 1500', 'zh'), '2400 × 1500');
});

Deno.test('i18n: Arabic uses RTL while other catalogue directions remain LTR', () => {
  assertEquals(localeDirection('ar'), 'rtl');
  for (const lng of ['en', 'zh-Hant', 'pt-BR', 'pt-PT', 'hi', 'th'] as const) assertEquals(localeDirection(lng), 'ltr');
});
