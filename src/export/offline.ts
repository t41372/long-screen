import { HTML_LANG, locale, t } from '../i18n/index.ts';
import { displayName } from '../i18n/names.ts';
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
  return `<!doctype html><html lang="${
    HTML_LANG[locale()]
  }"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Long Screen · ${
    text(t('offline.title'))
  }</title>
 <style>*{box-sizing:border-box}body{margin:0;background:#eeeee8;color:#263b33;font:14px system-ui}header{height:64px;display:flex;align-items:center;gap:18px;padding:12px 24px;background:#faf9f4;border-bottom:1px solid #ddd}h1{font-size:19px;white-space:nowrap}select,button{padding:9px;border:1px solid #ccc;background:white;border-radius:8px}canvas{position:absolute;top:64px;left:0;width:100%;height:calc(100% - 100px);touch-action:none}footer{position:fixed;bottom:0;height:36px;left:0;right:0;background:#faf9f4;padding:9px 18px;font-size:12px}small{margin-left:auto}@media(max-width:640px){header{gap:8px;padding:8px}small{display:none}}</style>
 <header><h1>▥ Long Screen</h1><select id="layers"></select><button id="fit">${
    text(t('offline.fit'))
  }</button><button id="native">1:1</button><small>${
    text(t('offline.tip'))
  }</small></header><canvas id="view"></canvas><footer id="status"></footer>
 <script>const M=${safe},T=${safeT};const C=document.getElementById('view'),X=C.getContext('2d'),S=document.getElementById('layers'),status=document.getElementById('status');let meta,scale=1,ox=0,oy=0,down,cache=new Map(),pending=0,scheduled=false;for(const m of M.canvases){const o=document.createElement('option');o.value=m.id;o.textContent=m.name+' · '+m.bounds.width+'×'+m.bounds.height;S.append(o)}
 function choose(){meta=M.canvases.find(m=>m.id===S.value);cache.clear();fit()}function fit(){if(!meta)return;scale=Math.min(C.clientWidth/(meta.bounds.width+64),C.clientHeight/(meta.bounds.height+64));ox=(C.clientWidth-meta.bounds.width*scale)/2-meta.bounds.x*scale;oy=(C.clientHeight-meta.bounds.height*scale)/2-meta.bounds.y*scale;draw()}
 function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;draw()})}}
 function draw(){const d=devicePixelRatio||1,w=C.clientWidth,h=C.clientHeight;C.width=Math.round(w*d);C.height=Math.round(h*d);X.scale(d,d);for(let y=0;y<h;y+=20)for(let x=0;x<w;x+=20){X.fillStyle=((x+y)/20)%2?'#e5e6df':'#eeeee8';X.fillRect(x,y,20,20)}if(!meta)return;const level=Math.max(0,Math.min(meta.maxLevel,Math.floor(Math.log2(1/scale)))),unit=M.tileSize*2**level,loX=Math.max(Math.floor(meta.bounds.x/unit),Math.floor(-ox/scale/unit)),hiX=Math.min(Math.floor((meta.bounds.x+meta.bounds.width-1)/unit),Math.floor((w-ox)/scale/unit)),loY=Math.max(Math.floor(meta.bounds.y/unit),Math.floor(-oy/scale/unit)),hiY=Math.min(Math.floor((meta.bounds.y+meta.bounds.height-1)/unit),Math.floor((h-oy)/scale/unit));for(let ty=loY;ty<=hiY;ty++)for(let tx=loX;tx<=hiX;tx++){const key=meta.id+'/'+level+'/'+tx+'_'+ty;let entry=cache.get(key);if(entry===undefined&&pending<8){const im=new Image();cache.set(key,im);pending++;im.onload=()=>{pending--;schedule()};im.onerror=()=>{pending--;cache.set(key,null);schedule()};im.src='tiles/'+key+'.png';entry=im;}if(entry&&entry.complete&&entry.naturalWidth)X.drawImage(entry,ox+tx*unit*scale,oy+ty*unit*scale,unit*scale,unit*scale)}while(cache.size>128)cache.delete(cache.keys().next().value);status.textContent=(scale*100).toFixed(1)+'% · '+(level?T.previewLevel.replace('{{level}}',level):T.nativeTiles)+' · '+T.footer}
 C.onwheel=e=>{e.preventDefault();const r=C.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,k=Math.exp(-e.deltaY*.001);scale=Math.min(12,Math.max(.00001,scale*k));ox=x-(x-ox)*k;oy=y-(y-oy)*k;draw()};C.onpointerdown=e=>{down={x:e.clientX,y:e.clientY};C.setPointerCapture(e.pointerId)};C.onpointermove=e=>{if(down){ox+=e.clientX-down.x;oy+=e.clientY-down.y;down={x:e.clientX,y:e.clientY};draw()}};C.onpointerup=()=>down=null;S.onchange=choose;document.getElementById('fit').onclick=fit;document.getElementById('native').onclick=()=>{const x=C.clientWidth/2,y=C.clientHeight/2;ox=x-(x-ox)/scale;oy=y-(y-oy)/scale;scale=1;draw()};window.onresize=draw;choose();</script></html>`;
}
