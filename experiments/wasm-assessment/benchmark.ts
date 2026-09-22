import { chromium, webkit } from 'playwright';
import { fromFileUrl, join } from '@std/path';

const root = fromFileUrl(new URL('../../', import.meta.url));
const output = join(root, 'test-results/wasm-assessment');
await Deno.mkdir(output, { recursive: true });
const bundle = join(output, 'experiment.js');
const build = await new Deno.Command(Deno.execPath(), {
  args: ['bundle', '--platform', 'browser', '--quiet', '-o', bundle, join(root, 'experiments/wasm-assessment/experiment.ts')],
}).output();
if (!build.success) throw new Error(new TextDecoder().decode(build.stderr));
const wasm = await Deno.readFile(
  join(root, 'experiments/wasm-assessment/target/wasm32-unknown-unknown/release/long_screen_wasm_assessment.wasm'),
);
const wasmSHA256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', wasm)), (b) => b.toString(16).padStart(2, '0')).join('');
const script = await Deno.readFile(bundle);
const hostname = Deno.args.includes('--lan-http')
  ? Deno.networkInterfaces().find((i) => i.family === 'IPv4' && !i.address.startsWith('127.'))?.address
  : '127.0.0.1';
if (!hostname) throw new Error('No LAN IPv4 interface for non-secure HTTP verification');
const server = Deno.serve({ port: 0, hostname, onListen: () => {} }, (request) => {
  const path = new URL(request.url).pathname;
  if (path === '/experiment.js') return new Response(script, { headers: { 'content-type': 'text/javascript' } });
  if (path === '/assessment.wasm') return new Response(wasm, { headers: { 'content-type': 'application/wasm' } });
  return new Response('<!doctype html><script type="module" src="/experiment.js"></script>', { headers: { 'content-type': 'text/html' } });
});
try {
  for (const name of ['chromium', 'webkit'] as const) {
    const browser = await (name === 'chromium'
      ? chromium.launch({ headless: true, executablePath: Deno.env.get('LONGSCREEN_CHROME') || undefined })
      : webkit.launch({ headless: true }));
    try {
      const page = await browser.newPage();
      await page.goto(`http://${hostname}:${server.addr.port}/`);
      await page.waitForFunction('typeof runAssessment === "function"');
      const result = await page.evaluate(async () => ({
        browser: navigator.userAgent,
        isSecureContext,
        crossOriginIsolated,
        results: await (globalThis as any).runAssessment(new Uint8Array(await (await fetch('/assessment.wasm')).arrayBuffer())),
      }));
      if (Deno.args.includes('--lan-http') && result.isSecureContext) {
        throw new Error('LAN HTTP unexpectedly secure');
      }
      await Deno.writeTextFile(
        join(output, `${name}.json`),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            host: Deno.build,
            wasmSHA256,
            ...result,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ name, ...result }));
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.shutdown();
}
