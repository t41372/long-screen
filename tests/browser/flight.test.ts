import { assert, assertEquals } from '@std/assert';
import { harness } from './support.ts';
// The crash recorder, end to end in the app: a run the page never saw end (here the page is reloaded mid-run, as
// Safari does when it reclaims a tab) must be reported once on the next load, with the phase it died in; a run that
// ends normally must leave nothing to report. Failure modes: no record written before the kill (the first write only
// after a phase change), a record that survives a finished run and raises a false alarm, a report shown twice, or
// the hidden-time accounting missing a backgrounded tab.
const diagnosticText = `[...document.querySelectorAll('#diagnostics .diagnostic, #diagnostics > *')].map((e) => e.textContent).join('\\n')`;
Deno.test({
  name: 'browser UI: a run killed mid-way is reported once on the next load; a finished run leaves nothing behind',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      await page.selectOption('#demo-select', 'comic');
      await page.click('#demo-btn');
      // Mid-run, backgrounded for a moment (as when the user switches apps), then killed.
      await page.waitForFunction(`/帧/.test(document.querySelector('#progress-count')?.textContent || '')`, null, { timeout: 60000 });
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(1500);
      const recorded = await page.evaluate(() => JSON.parse(localStorage.getItem('long-screen.flight') || 'null'));
      assert(recorded?.state === 'running' && recorded.phase, `no running record before the kill: ${JSON.stringify(recorded)}`);
      assertEquals(recorded.hiddenTimes, 1);
      assert(recorded.hiddenNow, 'the record must say the page was hidden when it died');
      await page.reload();
      await page.waitForFunction('!!window.longScreen');
      await page.waitForFunction(`/PREVIOUS_RUN_INTERRUPTED/.test(${diagnosticText})`, null, { timeout: 10000 });
      const text = await page.evaluate(diagnosticText) as string;
      assert(text.includes('中断') && text.includes('帧转换') && text.includes('后台'), text.slice(0, 400));
      assertEquals(await page.evaluate(() => localStorage.getItem('long-screen.flight')), null, 'the report is shown once');
      // A run that finishes: nothing to report on the next load.
      await page.selectOption('#demo-select', 'gap');
      await page.click('#demo-btn');
      await page.waitForFunction(
        'longScreen.getProject()?.name === "demo-gap.generated" && ["complete","error","partial"].includes(longScreen.getProject()?.status)',
        null,
        { timeout: 240000 },
      );
      await page.waitForTimeout(500);
      assertEquals(await page.evaluate(() => localStorage.getItem('long-screen.flight')), null, 'a finished run leaves no record');
      await page.reload();
      await page.waitForFunction('!!window.longScreen');
      await page.waitForTimeout(1000);
      assert(!/PREVIOUS_RUN_INTERRUPTED/.test(await page.evaluate(diagnosticText) as string), 'false alarm after a finished run');
      // A kill aborts the worker's run without its finally blocks, which is exactly the case being reported.
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
