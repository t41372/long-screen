/** Renders the installed app's icons into static/icons/: the printer from static/icon.svg (the favicon) on the page's
 *  desk colour, as PNGs, because Android's install check and iOS's home screen do not take an SVG. Headless Chrome
 *  rasterises them, a dev-time dependency only (as in scripts/make-demo.ts); the PNGs are committed, so a deploy
 *  never needs a rasteriser.
 *
 *  - icon-192.png, icon-512.png: manifest `purpose: any`, a rounded tile with see-through corners, shown as is in
 *    desktop app lists and wherever a launcher does not mask icons.
 *  - maskable-512.png: manifest `purpose: maskable`, edge to edge, the printer inside the central circle of 40%
 *    radius that every Android mask shape keeps.
 *  - apple-touch-icon.png (180 px): edge to edge and opaque; iOS rounds the corners itself and would fill
 *    transparency with black.
 *
 *  `deno task icons` rewrites all four. */
import { chromium } from 'playwright';
import { fromFileUrl } from '@std/path';

const dir = fromFileUrl(new URL('../static/icons/', import.meta.url));
const favicon = await Deno.readTextFile(fromFileUrl(new URL('../static/icon.svg', import.meta.url)));
// The printer's shapes, including strokes, fit inside x 3–38, y 4–36 of the 40×40 favicon.
const mark = favicon.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const DESK = '#f6efe4';

/** One icon at 512×512: `scale` is how many pixels one unit of the favicon's 40×40 box takes, `radius` the tile's
 *  corner radius (0 for edge to edge). */
function icon(scale: number, radius: number): string {
  const cx = 20.5, cy = 20; // centre of the printer's extent in favicon units
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="${radius}" fill="${DESK}"/>` +
    `<g transform="translate(${256 - cx * scale} ${256 - cy * scale}) scale(${scale})">${mark}</g></svg>`;
}

// Maskable: half the diagonal of the 35×32 extent is ~24 units, so 8 px a unit keeps it ~190 px from the centre,
// inside the 204.8 px safe circle.
const icons: { name: string; size: number; svg: string }[] = [
  { name: 'icon-192.png', size: 192, svg: icon(11, 112) },
  { name: 'icon-512.png', size: 512, svg: icon(11, 112) },
  { name: 'maskable-512.png', size: 512, svg: icon(8, 0) },
  { name: 'apple-touch-icon.png', size: 180, svg: icon(10, 0) },
];

await Deno.mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const { name, size, svg } of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const src = `data:image/svg+xml;base64,${btoa(svg)}`;
    await page.setContent(`<body style="margin:0"><img src="${src}" width="${size}" height="${size}" style="display:block"></body>`);
    await page.waitForFunction('document.images[0].complete');
    await page.screenshot({ path: `${dir}${name}`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`static/icons/${name} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
