import { HTML_LANG, locale, t } from '../i18n/index.ts';
import { displayName } from '../i18n/names.ts';
import { localeDirection } from '../i18n/locales.ts';
/** The offline viewer page with its per-export values left as `%%NAME%%` placeholders (LANG, DIR, TITLE, FIT, TIP,
 *  MANIFEST, STRINGS, RTL). `scripts/export-catalog.ts` copies it verbatim to rust/long-screen/catalog/viewer.html, from
 *  which the native result package fills the same page (rust/long-screen/src/package.rs), so the two never drift. */
export const VIEWER_TEMPLATE =
  `<!doctype html><html lang="%%LANG%%" dir="%%DIR%%"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Long Screen · %%TITLE%%</title>
 <style>*{box-sizing:border-box}body{margin:0;background:#eeeee8;color:#263b33;font:14px system-ui;height:100vh;height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr) auto}header{display:flex;flex-wrap:wrap;align-items:center;gap:18px;padding:12px 24px;background:#faf9f4;border-bottom:1px solid #ddd}h1{font-size:19px;white-space:nowrap;margin:0;direction:ltr;unicode-bidi:isolate}select,button{padding:9px;border:1px solid #ccc;background:white;border-radius:8px}select{flex:1;min-width:80px}button{flex:none}canvas{display:block;width:100%;height:100%;min-height:0;touch-action:none;direction:ltr}footer{background:#faf9f4;padding:9px 18px;font-size:12px;line-height:1.5;max-height:25vh;overflow:auto}small{margin-inline-start:auto}#native{direction:ltr;unicode-bidi:isolate}@media(max-width:640px){header{gap:8px;padding:8px}small{display:none}}</style>
 <header><h1>▥ Long Screen</h1><select id="layers"></select><button id="fit">%%FIT%%</button><button id="native">1:1</button><small>%%TIP%%</small></header><canvas id="view"></canvas><footer id="status"></footer>
 <script>const M=%%MANIFEST%%,T=%%STRINGS%%,RTL=%%RTL%%;const ltr=s=>RTL?'\\u2066'+s+'\\u2069':s;const C=document.getElementById('view'),X=C.getContext('2d'),S=document.getElementById('layers'),status=document.getElementById('status');let meta,scale=1,ox=0,oy=0,down,cache=new Map(),pending=0,scheduled=false;for(const m of M.canvases){const o=document.createElement('option');o.value=m.id;o.textContent=m.name+' · '+ltr(m.bounds.width+'×'+m.bounds.height);S.append(o)}
 function choose(){meta=M.canvases.find(m=>m.id===S.value);cache.clear();fit()}function fit(){if(!meta)return;scale=Math.min(C.clientWidth/(meta.bounds.width+64),C.clientHeight/(meta.bounds.height+64));ox=(C.clientWidth-meta.bounds.width*scale)/2-meta.bounds.x*scale;oy=(C.clientHeight-meta.bounds.height*scale)/2-meta.bounds.y*scale;draw()}
 function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;draw()})}}
 function draw(){const d=devicePixelRatio||1,w=C.clientWidth,h=C.clientHeight;C.width=Math.round(w*d);C.height=Math.round(h*d);X.scale(d,d);for(let y=0;y<h;y+=20)for(let x=0;x<w;x+=20){X.fillStyle=((x+y)/20)%2?'#e5e6df':'#eeeee8';X.fillRect(x,y,20,20)}if(!meta)return;const level=Math.max(0,Math.min(meta.maxLevel,Math.floor(Math.log2(1/scale)))),unit=M.tileSize*2**level,loX=Math.max(Math.floor(meta.bounds.x/unit),Math.floor(-ox/scale/unit)),hiX=Math.min(Math.floor((meta.bounds.x+meta.bounds.width-1)/unit),Math.floor((w-ox)/scale/unit)),loY=Math.max(Math.floor(meta.bounds.y/unit),Math.floor(-oy/scale/unit)),hiY=Math.min(Math.floor((meta.bounds.y+meta.bounds.height-1)/unit),Math.floor((h-oy)/scale/unit));for(let ty=loY;ty<=hiY;ty++)for(let tx=loX;tx<=hiX;tx++){const key=meta.id+'/'+level+'/'+tx+'_'+ty;let entry=cache.get(key);if(entry===undefined&&pending<8){const im=new Image();cache.set(key,im);pending++;im.onload=()=>{pending--;schedule()};im.onerror=()=>{pending--;cache.set(key,null);schedule()};im.src='tiles/'+key+'.png';entry=im;}if(entry&&entry.complete&&entry.naturalWidth)X.drawImage(entry,ox+tx*unit*scale,oy+ty*unit*scale,unit*scale,unit*scale)}while(cache.size>128)cache.delete(cache.keys().next().value);status.textContent=ltr((scale*100).toFixed(1)+'%')+' · '+(level?T.previewLevel.replace('{{level}}',level):T.nativeTiles)+' · '+T.footer}
 C.onwheel=e=>{e.preventDefault();const r=C.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,k=Math.exp(-e.deltaY*.001);scale=Math.min(12,Math.max(.00001,scale*k));ox=x-(x-ox)*k;oy=y-(y-oy)*k;draw()};C.onpointerdown=e=>{down={x:e.clientX,y:e.clientY};C.setPointerCapture(e.pointerId)};C.onpointermove=e=>{if(down){ox+=e.clientX-down.x;oy+=e.clientY-down.y;down={x:e.clientX,y:e.clientY};draw()}};C.onpointerup=()=>down=null;S.onchange=choose;document.getElementById('fit').onclick=fit;document.getElementById('native').onclick=()=>{const x=C.clientWidth/2,y=C.clientHeight/2;ox=x-(x-ox)/scale;oy=y-(y-oy)/scale;scale=1;draw()};window.onresize=draw;choose();</script></html>`;

/** The README.txt of a result package; exported to rust/long-screen/catalog/package-readme.txt like the viewer. */
export const PACKAGE_README =
  'Long Screen — offline reconstruction\n\nUnzip everything, then open index.html. Level-zero PNG tiles preserve native output resolution. Missing tiles and transparent pixels are unobserved holes, not white page content. Independent fragments are not asserted to be adjacent. The original video is NOT included: retain it for source-time comparisons. observations.jsonl records every processed source frame and chosen placement; diagnostics.jsonl contains warnings. quality/*.json stores 16px-block heuristic quality, conflict markers, and source-frame ownership. provisional/*.bin marks covered pixels the world-consistency mask could not corroborate against a neighbouring frame (screen-space overlay/dynamic burn-in still awaiting a later consistent observation), same bit layout as coverage/*.bin. Pixel coverage bits are least-significant-bit first. Pyramids are previews only. regions.json holds the full region definitions (including their masks, base64-encoded) that produced canvases[].layer.\n';

/** The fixed text of a result package's manifest.json and quality/*.json; exported to
 *  rust/long-screen/catalog/package-notes.json like the viewer. */
export const PACKAGE_NOTES = {
  format: 'long-screen/sparse-canvas',
  version: 2,
  presentation:
    'Canvases with kind=presentation are framed views, not independent reconstructed worlds. Their opaque decorative extensions have NO evidence coverage; see canvas.presentation. Original moving and fixed canvases are retained.',
  coordinates: 'Native source pixels. Each independent canvas has its own origin.',
  holes: 'Transparent pixels were not observed; the enclosing bounding rectangle is not a coverage guarantee.',
  levels: 'Level 0 is native resolution; levels 1+ are explicitly downsampled previews.',
  confidence: 'Heuristic, uncalibrated, not a correctness probability.',
  ownerFrameEncoding: '0 = unassigned; otherwise zero-based source frame index + 1. Block-level representative, not per-pixel provenance.',
} as const;

/** `template` with every `%%NAME%%` replaced by `values.NAME`, in one pass (a value is never scanned again). */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/%%([A-Z]+)%%/g, (match, name: string) => Object.hasOwn(values, name) ? values[name] : match);
}

/** A self-contained file:// viewer. It reads tiles as images; no server or JSON fetch is needed. Translated at
 *  export time (the locale active on the worker when the export ran) — the generated HTML has no i18next of its
 *  own, so every string it shows is resolved here, before being baked into the page: canvas/layer names via
 *  displayName() (never the persisted canonical name), and the one status string still assembled at RUNTIME in the
 *  viewer's own vanilla JS (it depends on a JS variable, `level`) via a small `T` constants object with a
 *  `{{level}}` placeholder, replaced with plain string substitution client-side. */
export function offlineViewer(manifest: unknown): string {
  const named =
    manifest && typeof manifest === 'object' && 'canvases' in manifest && Array.isArray((manifest as { canvases: unknown }).canvases)
      ? { ...manifest, canvases: (manifest as { canvases: { name: string }[] }).canvases.map((c) => ({ ...c, name: displayName(c.name) })) }
      : manifest;
  const safe = JSON.stringify(named).replace(/</g, '\\u003c');
  const text = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const safeT = JSON.stringify({
    previewLevel: t('offline.previewLevel'),
    nativeTiles: t('offline.nativeTiles'),
    footer: t('offline.footer'),
  }).replace(/</g, '\\u003c');
  return fillTemplate(VIEWER_TEMPLATE, {
    LANG: HTML_LANG[locale()],
    DIR: localeDirection(locale()),
    TITLE: text(t('offline.title')),
    FIT: text(t('offline.fit')),
    TIP: text(t('offline.tip')),
    MANIFEST: safe,
    STRINGS: safeT,
    RTL: String(localeDirection(locale()) === 'rtl'),
  });
}
