import { assert, assertEquals } from '@std/assert';
import { harness, realRecordings } from './support.ts';
const truth = JSON.parse(await Deno.readTextFile(new URL('../fixtures/truth.json', import.meta.url)));
Deno.test({ name: 'browser: WebCodecs decodes every fixture container in presentation order, including ReplayKit-style negative ctts', sanitizeOps: false, sanitizeResources: false, fn: async () => {
    const h = await harness();
    try {
        await h.page.goto(h.base + '/harness.html');
        await h.page.waitForFunction('!!window.longScreenKit');
        for (const name of ['scroll.mp4', 'scroll.mov', 'fragmented.mp4', 'scroll.webm', 'negative-cts.mov', 'negative-cts-v0.mov']) {
            const r = await h.page.evaluate(async (name: string) => {
                const kit = (window as any).longScreenKit, blob = await (await fetch('/fixtures/' + name)).blob(), file = new File([blob], name);
                const source = await kit.openMedia(file);
                let count = 0, last = -Infinity, mono = true, first: number | undefined;
                for await (const f of source.frames()) {
                    if (f.time < last)
                        mono = false;
                    first ??= f.time;
                    last = f.time;
                    if (f.image.width !== 320 || f.image.height !== 240 || f.image.data.length !== 320 * 240 * 4)
                        throw new Error('frame geometry');
                    count++;
                }
                source.dispose();
                return { frames: count, first, last, mono, codec: source.info.codec, notices: source.info.notices };
            }, name);
            assertEquals(r.frames, truth.frames, name);
            assert(r.mono, `${name}: presentation order`);
            assertEquals(r.notices, [], name);
            assert(r.last < 2, `${name}: last pts ${r.last}`);
        }
        assertEquals(h.errors, []);
        assertEquals(h.external, []);
    }
    finally {
        await h.close();
    }
} });
Deno.test({ name: 'browser: real recordings in test_case/ decode completely (skipped when absent)', sanitizeOps: false, sanitizeResources: false, fn: async () => {
    const names = await realRecordings();
    if (!names.length) {
        console.log('skip: no recordings in test_case/');
        return;
    }
    const h = await harness();
    try {
        await h.page.goto(h.base + '/harness.html');
        await h.page.waitForFunction('!!window.longScreenKit');
        for (const name of names) {
            const r = await h.page.evaluate(async (name: string) => {
                const kit = (window as any).longScreenKit, blob = await (await fetch('/test_case/' + name)).blob(), file = new File([blob], name);
                const demux = await kit.openDemuxer(file);
                let packets = 0;
                for await (const _ of demux.packets())
                    packets++;
                const source = await kit.openMedia(file), t0 = performance.now();
                let count = 0, last = -Infinity, mono = true;
                for await (const f of source.frames()) {
                    if (f.time < last)
                        mono = false;
                    last = f.time;
                    count++;
                }
                source.dispose();
                return { packets, frames: count, mono, last, seconds: Math.round((performance.now() - t0) / 100) / 10, info: source.info };
            }, name);
            console.log(name, JSON.stringify({ ...r, info: { w: r.info.width, h: r.info.height, codec: r.info.codec, notices: r.info.notices } }));
            assertEquals(r.frames, r.packets, `${name}: every packet became a frame`);
            assert(r.mono, `${name}: presentation order`);
            assert(r.last <= r.info.duration + .1, `${name}: timestamps inside the recording`);
        }
    }
    finally {
        await h.close();
    }
} });
