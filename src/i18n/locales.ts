/** Website locales. Keep native names in the menu so visitors can find their language from any translation. */
export const LOCALES = [
  'zh',
  'zh-Hant',
  'en',
  'ja',
  'ko',
  'ru',
  'uk',
  'fr',
  'de',
  'es',
  'pt-BR',
  'pt-PT',
  'id',
  'vi',
  'tr',
  'it',
  'pl',
  'th',
  'nl',
  'hi',
  'ar',
] as const;
export type Locale = typeof LOCALES[number];
export const DEFAULT_LOCALE: Locale = 'zh';
export const LANGUAGE_NAMES: Record<Locale, string> = {
  zh: '简体中文',
  'zh-Hant': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
  uk: 'Українська',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  id: 'Bahasa Indonesia',
  vi: 'Tiếng Việt',
  tr: 'Türkçe',
  it: 'Italiano',
  pl: 'Polski',
  th: 'ไทย',
  nl: 'Nederlands',
  hi: 'हिन्दी',
  ar: 'العربية',
};
/** The Traditional Chinese catalogue uses Taiwan terminology, and also serves other Hant preferences. */
export const HTML_LANG: Record<Locale, string> = {
  zh: 'zh-CN',
  'zh-Hant': 'zh-Hant',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  ru: 'ru',
  uk: 'uk',
  fr: 'fr',
  de: 'de',
  es: 'es',
  'pt-BR': 'pt-BR',
  'pt-PT': 'pt-PT',
  id: 'id',
  vi: 'vi',
  tr: 'tr',
  it: 'it',
  pl: 'pl',
  th: 'th',
  nl: 'nl',
  hi: 'hi',
  ar: 'ar',
};

export const localeDirection = (lng: Locale): 'ltr' | 'rtl' => lng === 'ar' ? 'rtl' : 'ltr';

/** Display-only technical groups (dimensions, ratios): keep their order inside an RTL sentence. */
export const isolateLtr = (value: string, lng: Locale): string => localeDirection(lng) === 'rtl' ? `\u2066${value}\u2069` : value;

export const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

/** Resolve a browser preference without consulting browser globals; callers decide preference order/fallback. */
export function resolveLocale(tag: string): Locale | undefined {
  const [language, ...subtags] = tag.toLowerCase().split('-');
  if (language === 'zh') {
    if (subtags.includes('hant')) return 'zh-Hant';
    if (subtags.includes('hans')) return 'zh';
    return subtags.some((part) => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh';
  }
  // Unqualified Portuguese follows the Brazilian catalogue. Explicit Portugal and other Lusophone regional
  // preferences use the European terminology; both regional choices remain distinct in saved preferences.
  if (language === 'pt') {
    return subtags.some((part) => ['pt', 'ao', 'cv', 'gw', 'mo', 'mz', 'st', 'tl'].includes(part)) ? 'pt-PT' : 'pt-BR';
  }
  return isLocale(language) ? language : undefined;
}
