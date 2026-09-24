/** Page-side language selection. Importing this module picks the page's language: an explicit choice saved by the
 *  language menu wins, otherwise the first of the browser's preferred languages the app has a catalogue for, and
 *  English when there is none (any zh-* variant maps to the zh catalogue). Detection itself never saves anything,
 *  so a visitor who has not chosen keeps following the browser's language; only `chooseLocale` persists.
 *
 *  Page bundles only (src/ui/main.ts, src/device-check.ts): it reads navigator and localStorage, which the shared
 *  src/i18n/index.ts must not. The worker learns the language from the page (src/ui/rpc.ts). */
import LanguageDetector from 'i18next-browser-languagedetector';
import { HTML_LANG, i18n, isLocale, type Locale, locale, setLocale, t, translateKey } from './index.ts';

// Page code imports `t` from here rather than from ./index.ts, so language detection below has always run first.
export { displayName } from './names.ts';
export { locale, t, translateKey };

export const LANGUAGE_STORAGE_KEY = 'long-screen.language';

const detector = new LanguageDetector(i18n.services, {
  order: ['localStorage', 'navigator'],
  lookupLocalStorage: LANGUAGE_STORAGE_KEY,
  caches: [],
  // Catalogues are per language, not per region: zh-TW, zh-Hant-HK and zh-CN all select zh, en-GB selects en.
  convertDetectedLanguage: (lng: string) => lng.split('-')[0].toLowerCase(),
});
// Candidates in priority order (the saved choice, then navigator.languages); English when none has a catalogue —
// not i18next's fallbackLng, which stays zh for worker/Deno code and for missing keys.
const detected = detector.detect();
setLocale((Array.isArray(detected) ? detected : [detected]).find(isLocale) ?? 'en');

/** Applies the current language to static markup: `data-i18n` sets textContent, `data-i18n-html` sets innerHTML
 *  (for catalogue strings that carry their own <br>/<span>/<a>; never used with interpolated values), and
 *  `data-i18n-attr="attr:key;attr:key"` sets attributes such as aria-label, title and content. */
export function translatePage(root: Document = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = translateKey(el.dataset.i18n!);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
    el.innerHTML = translateKey(el.dataset.i18nHtml!);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr!.split(';')) {
      const [attribute, key] = pair.split(':').map((s) => s.trim());
      el.setAttribute(attribute, translateKey(key));
    }
  }
  root.documentElement.lang = HTML_LANG[locale()];
  // static/index.html and static/device-check.html hide the page until this has run (see the `i18n-pending` script in
  // each <head>).
  root.documentElement.classList.remove('i18n-pending');
}

/** Saves `lng` as the user's choice and reloads the page in it; the print on screen comes back after the reload like
 *  after any other (src/ui/main.ts restores the print the browser kept). Returns false (after telling the user) when
 *  the browser refuses to store the choice: reloading would then silently come back in the old language. */
export function chooseLocale(lng: Locale): boolean {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
  } catch {
    return false;
  }
  location.reload();
  return true;
}

/** Wires a <select> of locales: shows the current one and switches on change. */
export function wireLanguageSelect(select: HTMLSelectElement, onError: (message: string) => void): void {
  select.value = locale();
  select.onchange = () => {
    const lng = select.value;
    if (!isLocale(lng) || lng === locale()) return;
    if (!chooseLocale(lng)) {
      select.value = locale();
      onError(t('language.saveFailed'));
    }
  };
}
