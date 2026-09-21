/** Bundles the browser app with `deno bundle` and copies static assets into dist/. No npm, no CDN, no runtime dependencies.
 *  Builds into a staging directory and swaps it in on success, so a failed build never deletes a working dist/. */
import { copy, ensureDir } from '@std/fs';
const entries: [string, string][] = [['src/ui/main.ts', 'assets/main.js'], ['src/worker.ts', 'assets/worker.js'], [
  'src/testkit.ts',
  'assets/testkit.js',
]];
const minify = Deno.args.includes('--minify');
const staging = 'dist.build';
await Deno.remove(staging, { recursive: true }).catch(() => {});
await ensureDir(`${staging}/assets`);
try {
  for (const [input, output] of entries) {
    const target = `${staging}/${output}`;
    const args = ['bundle', '--platform', 'browser', '--sourcemap=linked', '--quiet', ...(minify ? ['--minify'] : []), '-o', target, input];
    const result = await new Deno.Command(Deno.execPath(), { args, stdout: 'inherit', stderr: 'piped' }).output();
    const stderr = new TextDecoder().decode(result.stderr).split('\n').filter((l) => l && !l.includes('experimental')).join('\n');
    if (stderr) {
      console.error(stderr);
    }
    if (!result.success) {
      console.error(`Bundling ${input} failed.`);
      await Deno.remove(staging, { recursive: true }).catch(() => {});
      Deno.exit(result.code);
    }
    const bytes = (await Deno.stat(target)).size;
    console.log(`${input} → dist/${output} (${(bytes / 1024).toFixed(1)} KB)`);
  }
  await copy('static', staging, { overwrite: true });
  // Swap the finished build in. Everything above ran against `staging`; dist/ keeps serving the previous build
  // until this point, so a bundling failure above never leaves dist/ deleted or half-written.
  await Deno.remove('dist', { recursive: true }).catch(() => {});
  await Deno.rename(staging, 'dist');
  console.log('Built dist/ — no runtime dependencies, no CDN, no upload endpoint.');
} catch (error) {
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  throw error;
}
