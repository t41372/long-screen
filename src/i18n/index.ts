/** The one i18next instance of this JS realm (the page, each worker and Deno each get their own copy) and its typed
 *  `t()`. The catalogues are bundled inline, so initialisation is synchronous and `t()` works at module top level.
 *
 *  This module never looks at `navigator` or storage: Deno has `navigator.language`, so a shared module that read it
 *  would make unit tests, scenario fingerprints and exported text depend on the host's locale. It starts in
 *  DEFAULT_LOCALE (zh, the language the pipeline's persisted text has always been written in) and changes only when
 *  told to — by src/i18n/page.ts's detection on the page, and by the page's `locale` message in the worker. */
import i18next from 'i18next';
import { zh } from './zh/index.ts';
import { en } from './en/index.ts';

export const LOCALES = ['zh', 'en'] as const;
export type Locale = typeof LOCALES[number];
export const DEFAULT_LOCALE: Locale = 'zh';
/** The `<html lang>` value each locale's text is written in: the zh catalogue is Simplified Chinese. */
export const HTML_LANG: Record<Locale, string> = { zh: 'zh-CN', en: 'en' };

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof zh };
  }
}

export const i18n = i18next.createInstance();
void i18n.init({
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...LOCALES],
  resources: { zh: { translation: zh }, en: { translation: en } },
  initAsync: false,
  // Every translated string lands in textContent, an attribute or a log row, never in innerHTML with an
  // interpolated value, so i18next's HTML escaping would only corrupt values such as file names.
  interpolation: { escapeValue: false },
});

export const t = i18n.t.bind(i18n) as typeof i18n.t;

/** `t()` for a key that is only known at runtime (a `data-i18n` attribute in static HTML). The key-parity test in
 *  tests/unit/i18n.test.ts proves every such key exists in every catalogue. `fallback` is returned (i18next's
 *  `defaultValue`) when no catalogue has the key; without it a missing key comes back as the key itself. */
export const translateKey = (key: string, fallback?: string): string =>
  (i18n.t as unknown as (key: string, options?: { defaultValue: string }) => string)(
    key,
    fallback === undefined ? undefined : { defaultValue: fallback },
  );

export const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

export const locale = (): Locale => isLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;

/** Synchronous with inline resources: the next `t()` call already answers in `lng`. */
export function setLocale(lng: Locale): void {
  void i18n.changeLanguage(lng);
}
