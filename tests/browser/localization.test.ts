// Regenerate the review artifacts: deno test -A tests/browser/localization.test.ts
// Real page + worker + recording: a complete catalogue alone cannot prove language detection, dynamic text,
// print restoration or a usable layout. Keep these checks together with screenshots of the actual user flow.
import { assert, assertEquals } from '@std/assert';
import { CATALOGUES } from '../../src/i18n/index.ts';
import { HTML_LANG, localeDirection, LOCALES } from '../../src/i18n/locales.ts';
import { harness } from './support.ts';

const results = new URL('../../test-results/localization-expanded/', import.meta.url).pathname;

for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name: `browser localization: every language detects, switches and restores in ${browser}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await Deno.mkdir(results, { recursive: true });
      const h = await harness({ browser, locale: 'en-US' });
      const report: unknown[] = [];
      try {
        for (const lng of LOCALES) {
          const context = await h.browser.newContext({ locale: HTML_LANG[lng], viewport: { width: 1440, height: 1000 } });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(String(error)));
          try {
            await page.goto(h.base);
            await page.waitForFunction('!!window.longScreen');
            assertEquals(await page.getAttribute('html', 'lang'), HTML_LANG[lng]);
            assertEquals(await page.getAttribute('html', 'dir'), localeDirection(lng));
            assertEquals(await page.title(), CATALOGUES[lng].page.title);
            assertEquals(await page.inputValue('#language-select'), lng);
            assertEquals(await page.locator('#language-select option').count(), LOCALES.length);
            assertEquals(await page.evaluate(() => localStorage.getItem('long-screen.language')), null, 'detection must not save a choice');

            // A preference saved through the menu wins over the browser language on both pages.
            const next = lng === 'ja' ? 'uk' : 'ja';
            await Promise.all([page.waitForNavigation(), page.selectOption('#language-select', next)]);
            await page.waitForFunction('!!window.longScreen');
            assertEquals(await page.getAttribute('html', 'lang'), HTML_LANG[next]);
            assertEquals(await page.getAttribute('html', 'dir'), localeDirection(next), 'switching away from Arabic resets direction');
            await page.goto(h.base + '/device-check.html');
            await page.waitForFunction(() => !document.documentElement.classList.contains('i18n-pending'));
            assertEquals(await page.title(), CATALOGUES[next].deviceCheck.title);
            // The page translates before loading Wasm. Let its initialization finish before navigating away:
            // WebKit otherwise reports the intentionally cancelled module fetch as an unhandled load error.
            await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#run')?.onclick !== null);
            await page.goto(h.base);
            await page.waitForFunction('!!window.longScreen');
            await Promise.all([page.waitForNavigation(), page.selectOption('#language-select', lng)]);
            await page.waitForFunction('!!window.longScreen');

            if (browser === 'chromium') {
              const widths = lng === 'en' || lng === 'ar' ? [390, 1024, 1440, 1920] : [390, 1440];
              for (const width of widths) {
                await page.setViewportSize({ width, height: 1000 });
                await page.evaluate(() => scrollTo(0, 0));
                await page.screenshot({ animations: 'disabled', path: `${results}${lng}-${width}-home.png`, fullPage: true });
                const layout = await page.evaluate(() => ({
                  width: innerWidth,
                  scrollWidth: document.documentElement.scrollWidth,
                  introWidth: document.querySelector('.intro')!.clientWidth,
                  introScrollWidth: document.querySelector('.intro')!.scrollWidth,
                  stepsBottom: document.querySelector('.steps')!.getBoundingClientRect().bottom,
                }));
                assert(layout.scrollWidth <= layout.width + 1, `${lng}/${width}: horizontal overflow ${JSON.stringify(layout)}`);
                assert(layout.introScrollWidth <= layout.introWidth + 1, `${lng}/${width}: intro text overflow ${JSON.stringify(layout)}`);
                if (['ar', 'hi', 'th'].includes(lng)) {
                  assertEquals(
                    await page.locator('h1').evaluate((el) => getComputedStyle(el).letterSpacing),
                    'normal',
                    `${lng}: script shaping`,
                  );
                }
                if (lng === 'vi') {
                  const font = await page.locator('body').evaluate((el) => getComputedStyle(el).fontFamily);
                  assert(
                    font.includes('system-ui') && !font.includes('Baloo'),
                    'Vietnamese must not mix a partial Latin subset within words',
                  );
                }
                if (lng === 'ar' && width >= 1080) {
                  const placement = await page.evaluate(() => ({
                    intro: document.querySelector('.intro')!.getBoundingClientRect().left,
                    tray: document.querySelector('.tray')!.getBoundingClientRect().right,
                  }));
                  assert(placement.intro > placement.tray, 'Arabic reading order starts with the introduction on the right');
                }
                if (width === 390 || width === 1440) assert(layout.stepsBottom <= 1000, `${lng}/${width}: instructions below fold`);
                await page.click('#knobs-btn');
                await page.locator('details.advanced').evaluate((el: HTMLDetailsElement) => el.open = true);
                await page.screenshot({ animations: 'disabled', path: `${results}${lng}-${width}-settings.png` });
                const clippedSettings = await page.evaluate(() => {
                  const measure = document.createElement('canvas').getContext('2d')!;
                  return [...document.querySelectorAll<HTMLSelectElement>('#knobs select')].flatMap((select) => {
                    const style = getComputedStyle(select);
                    measure.font = style.font;
                    const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
                    const text = select.selectedOptions[0]?.text ?? '';
                    return measure.measureText(text).width > available + 2 ? [text] : [];
                  });
                });
                assertEquals(clippedSettings, [], `${lng}/${width}: selected settings must remain readable`);
                if (lng === 'ar') {
                  assertEquals(await page.locator('#memory').evaluate((el) => getComputedStyle(el).direction), 'ltr', 'number precedes MB');
                }
                await page.keyboard.press('Escape');
              }
              // Use the shipped sample and UI button, so media errors, worker messages and restored canvas names
              // exercise the same locale as the static page. The algorithm and canonical rows are unchanged.
              await page.click('#demo-cta');
              await page.waitForFunction(
                '["complete","partial","error"].includes(longScreen.getProject()?.status)',
                null,
                { timeout: 240000 },
              );
              const project = await page.evaluate('longScreen.getProject()') as {
                id: string;
                status: string;
                renderedFrames: number;
                error?: string;
              };
              assertEquals(project.status, 'complete', project.error);
              assertEquals(project.renderedFrames, 343);
              await page.waitForFunction('!document.querySelector("#export-png").disabled');
              assertEquals(await page.textContent('#status-title'), CATALOGUES[lng].ui.phase.complete);
              assert(
                (await page.textContent('#diagnostics'))?.includes(CATALOGUES[lng].diag.PRESENTATION_FRAME.message) ||
                  (await page.textContent('#diagnostics'))?.includes(
                    CATALOGUES[lng].diag.ANALYSIS_PYRAMID.message.replace('{{size}}', '640'),
                  ),
                `${lng}: expected translated worker diagnostics`,
              );
              for (const width of widths) {
                await page.setViewportSize({ width, height: 1000 });
                await page.screenshot({ animations: 'disabled', path: `${results}${lng}-${width}-demo.png`, fullPage: true });
                await page.click('#note-btn');
                await page.screenshot({ animations: 'disabled', path: `${results}${lng}-${width}-log.png` });
                await page.keyboard.press('Escape');
                await page.click('#expand-btn');
                await page.screenshot({ animations: 'disabled', path: `${results}${lng}-${width}-spread.png` });
                await page.keyboard.press('Escape');
              }
              await page.reload();
              await page.waitForFunction((id) => (globalThis as any).longScreen?.getProject()?.id === id, project.id);
              assertEquals(await page.getAttribute('html', 'lang'), HTML_LANG[lng]);
              assertEquals(await page.getAttribute('html', 'dir'), localeDirection(lng));
              report.push({
                locale: lng,
                htmlLang: HTML_LANG[lng],
                direction: localeDirection(lng),
                renderedFrames: project.renderedFrames,
                status: project.status,
                widths,
                errors,
              });
            } else {
              report.push({ locale: lng, htmlLang: HTML_LANG[lng], direction: localeDirection(lng), errors });
            }
            assertEquals(errors, [], lng);
          } finally {
            await context.close();
          }
        }
      } finally {
        await Deno.writeTextFile(
          `${results}${browser}.json`,
          JSON.stringify({ command: 'deno test -A tests/browser/localization.test.ts', report }, null, 2) + '\n',
        );
        await h.close();
      }
    },
  });
}
