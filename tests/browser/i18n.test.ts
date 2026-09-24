// The language the page shows depends on the browser's locale (or a saved choice), never on the shared runtime's
// zh default: a browser whose preferred language is English must see English, an unsupported language must fall
// back to English (not stay stuck showing zh), and a saved choice must survive further reloads regardless of what
// the browser's own locale says. This file exercises that end to end in real Playwright contexts, distinct from
// tests/unit/i18n.test.ts, which only checks the catalogues and the shared runtime in isolation (no navigator, no
// localStorage).
import { assert, assertEquals } from '@std/assert';
import { harness } from './support.ts';
import { zh } from '../../src/i18n/zh/index.ts';

const HAN = /\p{Script=Han}/u;
type Tree = { [key: string]: string | Tree };
const flatten = (tree: Tree, prefix = ''): [string, string][] =>
  Object.entries(tree).flatMap(([k, v]) => typeof v === 'string' ? [[prefix + k, v] as [string, string]] : flatten(v, `${prefix}${k}.`));

Deno.test({
  name: 'browser i18n: an en-US context shows the English UI with no untranslated Chinese',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ locale: 'en-US' });
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      assertEquals(await page.evaluate(() => document.documentElement.lang), 'en');
      assertEquals(await page.title(), 'Long Screen — One big screenshot from a screen recording');
      // textContent, not innerText: the closed dialogs (help, history, regions, source) and every <option> count too.
      const bodyText = await page.evaluate(() => document.body.textContent || '');
      // The language menu always lists both languages by their own name, including "中文" for the zh option —
      // that is not untranslated UI copy, so it is excluded before checking the rest of the page for Han script.
      const withoutLanguageOption = bodyText.replaceAll('中文', '');
      assert(!HAN.test(withoutLanguageOption), withoutLanguageOption);
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: 'browser i18n: the Chinese text static/index.html carries as its no-JS fallback is the zh catalogue text',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      const mismatches = await page.evaluate(async (entries) => {
        const catalogue = new Map(entries);
        const doc = new DOMParser().parseFromString(await (await fetch('./')).text(), 'text/html');
        const out: string[] = [];
        const check = (key: string, actual: string) => {
          if (catalogue.get(key) !== actual) out.push(`${key}: html=${JSON.stringify(actual)} zh=${JSON.stringify(catalogue.get(key))}`);
        };
        for (const el of doc.querySelectorAll<HTMLElement>('[data-i18n]')) check(el.dataset.i18n!, el.textContent || '');
        for (const el of doc.querySelectorAll<HTMLElement>('[data-i18n-html]')) check(el.dataset.i18nHtml!, el.innerHTML);
        for (const el of doc.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
          for (const pair of el.dataset.i18nAttr!.split(';')) {
            const [attribute, key] = pair.split(':').map((s) => s.trim());
            check(key, el.getAttribute(attribute) || '');
          }
        }
        return out;
      }, flatten(zh as Tree));
      assertEquals(mismatches, []);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: 'browser i18n: zh-TW selects the zh catalogue (a zh region, not the default zh-CN)',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ locale: 'zh-TW' });
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      assertEquals(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
      assertEquals(await page.title(), 'Long Screen — 把录屏拼成一整张大截图');
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: 'browser i18n: an unsupported browser language (ja-JP) falls back to English',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ locale: 'ja-JP' });
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      assertEquals(await page.evaluate(() => document.documentElement.lang), 'en');
      assertEquals(await page.title(), 'Long Screen — One big screenshot from a screen recording');
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: 'browser i18n: choosing 中文 from an en-US context reloads into zh and the choice survives a further reload',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ locale: 'en-US' });
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      assertEquals(await page.evaluate(() => document.documentElement.lang), 'en');
      // Choosing 中文 saves the choice and calls location.reload() (src/i18n/page.ts's chooseLocale), a real
      // navigation, not an in-page DOM update.
      await Promise.all([page.waitForNavigation(), page.selectOption('#language-select', 'zh')]);
      await page.waitForFunction('!!window.longScreen');
      assertEquals(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
      assertEquals(await page.evaluate(() => localStorage.getItem('long-screen.language')), 'zh');
      // The browser's own locale (en-US) would otherwise select English again; the saved choice must win.
      await page.reload();
      await page.waitForFunction('!!window.longScreen');
      assertEquals(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: 'browser i18n: the built-in demo leaves no untranslated Chinese in an en-US context',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ locale: 'en-US' });
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      await page.evaluate('longScreen.startDemo("horizontal")');
      await page.waitForFunction(
        '["complete","error","partial"].includes(longScreen.getProject()?.status)',
        null,
        { timeout: 240000 },
      );
      const project = await page.evaluate('longScreen.getProject()') as { status: string; error?: string };
      assertEquals(project.status, 'complete', project.error);
      await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
      const diagnostics = await page.evaluate(() => document.querySelector('#diagnostics')?.textContent || '');
      const statusTitle = await page.evaluate(() => document.querySelector('#status-title')?.textContent || '');
      const progressMessage = await page.evaluate(() => document.querySelector('#progress-message')?.textContent || '');
      const canvasOptions = await page.$$eval('#canvas-select option', (els) => els.map((e) => e.textContent).join(' '));
      for (const [label, text] of Object.entries({ diagnostics, statusTitle, progressMessage, canvasOptions })) {
        assert(!HAN.test(text), `${label}: ${text}`);
      }
      // Switching language reloads the page and reopens the project that was on screen, now named in zh.
      const projectId = await page.evaluate('longScreen.getProject().id');
      await Promise.all([page.waitForNavigation(), page.selectOption('#language-select', 'zh')]);
      await page.waitForFunction(`longScreen.getProject()?.id === ${JSON.stringify(projectId)}`, null, { timeout: 30000 });
      await page.waitForFunction('document.querySelectorAll("#canvas-select option[value]:not([value=\'\'])").length > 0');
      const zhOptions = await page.$$eval('#canvas-select option', (els) => els.map((e) => e.textContent).join(' '));
      assert(HAN.test(zhOptions), zhOptions);
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
