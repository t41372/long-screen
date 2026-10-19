// Records the README demo v2: the production build in real Chrome with the recording dragged onto the printer and Run,
// then the PNG the page exported, shown whole and then panned at a readable size. cut.sh puts the recording itself in
// front (headless Chrome's screencast paints a playing video above any caption, so that part is made with ffmpeg).
// Usage (from the repo root, after `deno task build:prod`):
//   deno run -A scripts/readme-demo/record.ts "$PWD" <work>/rec/screen-recording.mp4 <work>/out
import { chromium } from 'playwright';
import { createHandler } from '../../main.ts';

const [repo, recording, outDir] = Deno.args;
const W = 1280, H = 900;
const recName = recording.split('/').pop()!;
const server = Deno.serve(
  { port: 0, hostname: '127.0.0.1', onListen: () => {} },
  createHandler({ root: `${repo}/dist`, mounts: { '/rec/': recording.replace(/\/[^/]+$/, ''), '/demo/': outDir } }),
);
const base = `http://127.0.0.1:${server.addr.port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  locale: 'en-US',
  colorScheme: 'light',
  acceptDownloads: true,
  // The result page is served beside the app; the demo does not need the app's offline cache.
  serviceWorkers: 'block',
  // The app's CSP would block the string predicates below and the result page's own scripts; the demo stages both.
  bypassCSP: true,
  recordVideo: { dir: outDir, size: { width: W, height: H } },
});
// The save dialog cannot be driven headless; without it the page downloads the file the ordinary way.
await context.addInitScript(() => delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker);
const page = await context.newPage();
const t0 = Date.now();
const marks: Record<string, number> = {};
const mark = (name: string) => {
  marks[name] = (Date.now() - t0) / 1000;
  console.log(name, marks[name]);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
page.on('pageerror', (e) => console.error('pageerror', e));
// The page asks before leaving a finished print; the demo leaves it for the result page.
page.on('dialog', (d) => d.accept());

const caption = `position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:10px 18px;border-radius:999px;
background:rgba(20,20,24,.82);color:#fff;font:600 20px system-ui,sans-serif;white-space:nowrap;z-index:10`;

// 1. The app: drop the recording on the printer and run it.
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.addStyleTag({
  content: `#demo-cursor{position:fixed;left:0;top:0;z-index:99999;pointer-events:none;transition:transform .9s cubic-bezier(.45,0,.25,1)}
#demo-cursor svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
#demo-file{position:absolute;left:18px;top:20px;display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;background:#fff;
box-shadow:0 4px 14px rgba(0,0,0,.18);font:600 13px system-ui,sans-serif;color:#333;white-space:nowrap;transition:opacity .25s}
html,body{overflow:hidden!important}
#demo-cursor.click svg{transform:scale(.85);transition:transform .12s}`,
});
await page.evaluate(() => {
  const c = document.createElement('div');
  c.id = 'demo-cursor';
  c.innerHTML =
    `<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2v21l6-5.5 4 8.5 3.5-1.6-4-8.4H19z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
<div id="demo-file" style="opacity:0">🎞️ screen-recording.mp4</div>`;
  c.style.transform = 'translate(1180px, 700px)';
  document.body.appendChild(c);
});
const moveTo = async (x: number, y: number, ms = 900) => {
  await page.evaluate(([x, y, ms]) => {
    const c = document.getElementById('demo-cursor')!;
    c.style.transitionDuration = `${ms}ms`;
    c.style.transform = `translate(${x}px, ${y}px)`;
  }, [x, y, ms]);
  await sleep(ms + 80);
};
const centre = async (sel: string) => {
  const b = (await page.locator(sel).boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2] as const;
};
const click = async () => {
  await page.evaluate(() => document.getElementById('demo-cursor')!.classList.add('click'));
  await sleep(140);
  await page.evaluate(() => document.getElementById('demo-cursor')!.classList.remove('click'));
};
const pin = setInterval(() => page.evaluate(() => window.scrollTo(0, 0)).catch(() => {}), 100);
await sleep(1200);
mark('landing');
await moveTo(1150, 620, 500);
await page.evaluate(() => (document.getElementById('demo-file')!.style.opacity = '1'));
await sleep(300);
const [dx, dy] = await centre('#drop-zone');
await page.evaluate(() => document.getElementById('drop-zone')!.classList.add('dragging'));
await moveTo(dx - 10, dy - 10, 1300);
await sleep(250);
// Drop: the same handler a real drop runs, with the recording as the dropped file.
await page.evaluate(async ([url, name]) => {
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], name, { type: 'video/mp4' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.getElementById('drop-zone')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [`/rec/${recName}`, recName]);
await page.evaluate(() => (document.getElementById('demo-file')!.style.opacity = '0'));
mark('dropped');
await page.waitForFunction(() => !(document.querySelector('#start-btn') as HTMLButtonElement).disabled, null, { timeout: 60000 });
await sleep(1000);
const [sx, sy] = await centre('#start-btn');
await moveTo(sx - 4, sy - 6, 800);
await sleep(200);
await click();
await page.click('#start-btn');
mark('run');
await moveTo(W - 60, H - 40, 900);
await page.waitForFunction('["complete","error","partial"].includes(longScreen.getProject()?.status)', null, { timeout: 900000 });
mark('done');
console.log('status', await page.evaluate('longScreen.getProject()?.status'));
await sleep(1500);
// 2. Download the PNG the page made, the way a user does.
await page.waitForFunction(() => !(document.querySelector('#export-png') as HTMLButtonElement).disabled, null, { timeout: 60000 });
const [px, py] = await centre('#export-png');
await moveTo(px - 30, py - 4, 900);
await click();
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#export-png')]);
await download.saveAs(`${outDir}/print.png`);
mark('exported');
clearInterval(pin);
await sleep(800);

// 3. The print: whole, then panned top to bottom at a readable width.
await Deno.writeTextFile(
  `${outDir}/result.html`,
  `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#2a2b30;overflow:hidden">
<img id="p" src="print.png" style="visibility:hidden;position:absolute;left:50%;top:0;transform-origin:50% 0;box-shadow:0 6px 30px rgba(0,0,0,.45)">
<div style="${caption}">One big screenshot, at full resolution</div></body>`,
);
await page.goto(`${base}/demo/result.html`);
const dims = await page.evaluate(async () => {
  const img = document.getElementById('p') as HTMLImageElement;
  await img.decode();
  return { w: img.naturalWidth, h: img.naturalHeight };
});
console.log('print', dims);
// Whole print, fitted to the window's height with a margin.
const fit = (H - 40) / dims.h;
await page.evaluate(([fit, w]) => {
  const img = document.getElementById('p') as HTMLImageElement;
  img.style.width = `${w * fit}px`;
  img.style.transform = `translate(-50%, 20px)`;
  img.style.visibility = 'visible';
}, [fit, dims.w]);
mark('whole');
await sleep(3000);
// Then three stops at the window's full width, top, middle and bottom: still frames keep the animated image small.
const wide = Math.min(W - 80, dims.w);
const tall = dims.h * wide / dims.w;
mark('pan');
for (const at of [0, 0.5, 1]) {
  await page.evaluate(([wide, dy]) => {
    const img = document.getElementById('p') as HTMLImageElement;
    img.style.width = `${wide}px`;
    img.style.transform = `translate(-50%, ${20 - dy}px)`;
  }, [wide, at * (tall - H + 40)]);
  await sleep(2200);
}
mark('end');
const video = page.video()!;
await context.close();
await video.saveAs(`${outDir}/raw.webm`);
await Deno.writeTextFile(`${outDir}/marks.json`, JSON.stringify(marks, null, 2));
await browser.close();
await server.shutdown();
