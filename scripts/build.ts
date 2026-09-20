/** Bundles the browser app with `deno bundle` and copies static assets into dist/. No npm, no CDN, no runtime dependencies. */
import { copy, ensureDir } from '@std/fs';
const entries: [string, string][] = [['src/ui/main.ts', 'dist/assets/main.js'], ['src/worker.ts', 'dist/assets/worker.js'], ['src/testkit.ts', 'dist/assets/testkit.js']];
const minify = Deno.args.includes('--minify');
await Deno.remove('dist', { recursive: true }).catch(() => { });
await ensureDir('dist/assets');
for (const [input, output] of entries) {
    const args = ['bundle', '--platform', 'browser', '--sourcemap=linked', '--quiet', ...(minify ? ['--minify'] : []), '-o', output, input];
    const result = await new Deno.Command(Deno.execPath(), { args, stdout: 'inherit', stderr: 'piped' }).output();
    const stderr = new TextDecoder().decode(result.stderr).split('\n').filter(l => l && !l.includes('experimental')).join('\n');
    if (stderr)
        console.error(stderr);
    if (!result.success) {
        console.error(`Bundling ${input} failed.`);
        Deno.exit(result.code);
    }
    const bytes = (await Deno.stat(output)).size;
    console.log(`${input} → ${output} (${(bytes / 1024).toFixed(1)} KB)`);
}
await copy('static', 'dist', { overwrite: true });
console.log('Built dist/ — no runtime dependencies, no CDN, no upload endpoint.');
