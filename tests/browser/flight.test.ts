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
      // The printer shakes while it works, and Playwright only clicks a key that holds still; reduced motion stops it.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      await page.evaluate('longScreen.startDemo("comic")');
      // Mid-run, backgrounded for a moment (as when the user switches apps), then killed. The engine's own "暂停"
      // (pause) is used to make sure the run is still genuinely in progress at the moment we simulate the kill:
      // measured, the 'comic' demo reaches project status "complete" only ~2s after the first '#progress-count'
      // update with a frame count in it, so the fixed 1500ms wait below sits inside normal run-to-run timing
      // variance — without pausing, a run occasionally finished (clearing the flight record via flightEnd(),
      // correctly) before the checkpoint, making this test flaky rather than exercising the crash-recorder logic it
      // means to. Pause is honoured at ctx.checkpoint(), which every phase (solve, optimize, render, framing,
      // pyramid — see src/pipeline/context.ts) calls, so it blocks progress deterministically regardless of which
      // phase the run is in or how fast the machine is; it is not lifted, since the page is about to be reloaded
      // (killed) anyway.
      await page.waitForFunction(`/帧/.test(document.querySelector('#progress-count')?.textContent || '')`, null, { timeout: 60000 });
      await page.click('#pause-btn');
      await page.waitForFunction(`document.querySelector('#pause-btn')?.textContent === '继续'`);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(1500);
      const recorded = await page.evaluate(() => JSON.parse(localStorage.getItem('long-screen.flight') || 'null'));
      assert(recorded?.state === 'running' && recorded.phase, `no running record before the kill: ${JSON.stringify(recorded)}`);
      assertEquals(recorded.hiddenTimes, 1);
      assert(recorded.hiddenNow, 'the record must say the page was hidden when it died');
      // A reload fires a real `pagehide` then a real `visibilitychange` to hidden (verified in Chrome and WebKit),
      // on the SAME document.visibilityState this test already forced to 'hidden' above — src/ui/flight.ts must not
      // count that trailing, teardown-only visibilitychange as a second backgrounding, or `hiddenTimes`/`hiddenS`
      // on the record the next load recovers would drift from what was true when the tab actually went to the
      // background. src/ui/main.ts logs the full recovered record via `console.warn('PREVIOUS_RUN_INTERRUPTED',
      // JSON.stringify(interrupted))`; capture that instead of re-deriving it from DOM text.
      const interruptedLogged = new Promise<Record<string, unknown>>((resolve) => {
        page.on('console', (msg) => {
          if (msg.text().startsWith('PREVIOUS_RUN_INTERRUPTED')) {
            resolve(JSON.parse(msg.text().slice('PREVIOUS_RUN_INTERRUPTED '.length)));
          }
        });
      });
      await page.reload();
      await page.waitForFunction('!!window.longScreen');
      await page.waitForFunction(`/PREVIOUS_RUN_INTERRUPTED/.test(${diagnosticText})`, null, { timeout: 10000 });
      const text = await page.evaluate(diagnosticText) as string;
      assert(text.includes('中断') && text.includes('帧转换') && text.includes('后台'), text.slice(0, 400));
      const interrupted = await interruptedLogged;
      // Exactly the hidden count/duration recorded before the reload: the reload's own visibilitychange must not
      // have counted as a second, spurious backgrounding.
      assertEquals(interrupted.hiddenTimes, 1);
      assertEquals(interrupted.hiddenS, recorded.hiddenS);
      assertEquals(await page.evaluate(() => localStorage.getItem('long-screen.flight')), null, 'the report is shown once');
      // A run that finishes: nothing to report on the next load.
      await page.evaluate('longScreen.startDemo("gap")');
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
Deno.test({
  name: 'browser UI: a bfcache round trip (persisted pagehide + pageshow) does not disable the hidden-time recorder',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      await page.evaluate('longScreen.startDemo("comic")');
      await page.waitForFunction(`/帧/.test(document.querySelector('#progress-count')?.textContent || '')`, null, { timeout: 60000 });
      // A bfcache-eligible navigation fires `pagehide` with `persisted: true` (the page is frozen, not unloaded)
      // and, on returning, `pageshow`. src/ui/flight.ts's `visibilitychange` listener must not stay disabled by
      // that pagehide once pageshow has fired — dispatch the pair, then a real backgrounding, and the backgrounding
      // must still be counted.
      await page.evaluate(() => {
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const recorded = await page.evaluate(() => JSON.parse(localStorage.getItem('long-screen.flight') || 'null'));
      assert(recorded?.state === 'running', `no running record after the bfcache round trip: ${JSON.stringify(recorded)}`);
      assertEquals(recorded.hiddenTimes, 1, 'the backgrounding after a persisted pagehide+pageshow must still be recorded');
      assert(recorded.hiddenNow, 'the record must say the page is hidden');
    } finally {
      await h.close();
    }
  },
});
