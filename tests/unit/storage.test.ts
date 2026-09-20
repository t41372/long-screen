import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { deletePrefix, iterate, MemoryKV, Namespace } from '../../src/storage/db.ts';
import { countCovered, covered, markCovered, pngTileCodec, QUALITY_BLOCK, TileStore, tileKey, type StoredTile, type TileIndex } from '../../src/storage/tiles.ts';
import { Diagnostics } from '../../src/storage/diagnostics.ts';
import { encodeRGBA } from '../../src/codec/png.ts';
import type { CanvasMeta, Diagnostic } from '../../src/types.ts';
Deno.test('MemoryKV: sorted scans with prefix, after, limit and reverse; namespaces isolate prefixes; deletePrefix is scoped', async () => {
    const base = new MemoryKV(), a = new Namespace(base, 'a/'), b = new Namespace(base, 'b/');
    for (let i = 0; i < 75; i++)
        await a.put('item/' + String(i).padStart(3, '0'), i);
    await b.put('item/1', 'keep');
    await a.putMany([{ key: 'item/x', value: 'x' }]);
    await a.put('item/x', 'x2');
    assertEquals(await a.get('item/x'), 'x2');
    assertEquals(await a.get('missing'), undefined);
    const rows = [];
    for await (const row of iterate(a, 'item/', false, 7))
        rows.push(row);
    assertEquals(rows.length, 76);
    assertEquals(rows[74].value, 74);
    const reverse = await a.scan('item/', { reverse: true, limit: 3 });
    assertEquals(reverse.map(r => r.key), ['item/x', 'item/074', 'item/073']);
    const reverseAfter = await a.scan('item/', { reverse: true, limit: 2, after: 'item/010' });
    assertEquals(reverseAfter.map(r => r.key), ['item/009', 'item/008']);
    const forwardAfter = await a.scan('item/', { after: 'item/072', limit: 10 });
    assertEquals(forwardAfter.map(r => r.key), ['item/073', 'item/074', 'item/x']);
    assertEquals((await a.scan('nothing/')).length, 0);
    assertEquals((await base.scan('a/item/07', { limit: 100 })).length, 5);
    await a.delete('item/x');
    await a.delete('item/x');
    assertEquals(await a.get('item/x'), undefined);
    await deletePrefix(a, 'item/');
    assertEquals((await a.scan('item/')).length, 0);
    assertEquals(await b.get('item/1'), 'keep');
    await b.putMany([]);
    const empty = [];
    for await (const row of iterate(b, 'zzz/'))
        empty.push(row);
    assertEquals(empty.length, 0);
});
Deno.test('tiles: LRU eviction persists dirty tiles, huge sparse coordinates round-trip losslessly through PNG', async () => {
    const db = new MemoryKV(), tiles = new TileStore(db, 256, 8);
    assertEquals(tiles.maxTiles, 8);
    assertThrows(() => new TileStore(db, 100));
    const positions: { x: number; y: number }[] = [];
    for (let i = 0; i < 12; i++) {
        const x = (i % 2 ? 1 : -1) * (100000 + i * 37), y = (i % 3 ? 1 : -1) * (100000 + i * 23);
        positions.push({ x, y });
        const t = await tiles.get('huge', x, y);
        t.pixels.set([i, 77, 123, 255], 0);
        markCovered(t, 0);
        t.dirty = true;
    }
    assert(tiles.peakResidentTiles <= tiles.maxTiles);
    await tiles.flush();
    for (let i = 0; i < positions.length; i++) {
        const t = await tiles.get('huge', positions[i].x, positions[i].y);
        assert(covered(t, 0) && t.pixels[0] === i && t.pixels[3] === 255 && t.existed);
        assert(!covered(t, 1));
    }
    let count = 0;
    for await (const _ of iterate<TileIndex>(db, 'tile-index/huge/0/'))
        count++;
    assertEquals(count, 12);
    const payload = await tiles.payload('huge', 0, positions[0].x, positions[0].y);
    assert(payload && payload.blob.size > 0);
    assertEquals(await tiles.payload('huge', 0, 5, 5), undefined);
    assertEquals(tileKey('c', 1, 2, 3), 'c/1/2_3');
    assertEquals(countCovered(new Uint8Array([0xff, 0x01])), 9);
    await tiles.clear();
});
Deno.test('tiles: codec rejects mismatched stored sizes; pyramid halves observed tiles into previews', async () => {
    const wrong = new Blob([await encodeRGBA({ width: 4, height: 4, data: new Uint8ClampedArray(64) })]);
    await assertRejects(() => pngTileCodec.decode(wrong, 8), Error, 'expected 8×8');
    const db = new MemoryKV(), tiles = new TileStore(db, 64, 64);
    for (const [x, y] of [[0, 0], [1, 1], [3, 0]]) {
        const t = await tiles.get('c', x, y);
        for (let i = 0; i < 64 * 64; i++) {
            t.pixels.set([200, 100, 50, 255], i * 4);
            markCovered(t, i);
        }
        t.dirty = true;
    }
    await tiles.flush();
    const meta: CanvasMeta = { id: 'c', layer: 'l', name: 'c', kind: 'moving', bounds: { x: 0, y: 0, width: 256, height: 128 }, tileCount: 3, observedPixels: 0, uncertainPixels: 0, conflictPixels: 0, maxLevel: 0, fragment: 0, firstTime: 0, lastTime: 0 };
    let progress = 0;
    await tiles.buildPyramid(meta, async () => { progress++; });
    assertEquals(meta.maxLevel, 2);
    assert(progress >= 3);
    const parent = await db.get<StoredTile>(`tile/${tileKey('c', 1, 0, 0)}`);
    assert(parent);
    const decoded = await pngTileCodec.decode(parent.blob, 64);
    assertEquals([...decoded.subarray(0, 4)], [200, 100, 50, 255]);
    assertEquals(decoded[(40 * 64 + 40) * 4 + 3], 255);
    assertEquals(decoded[(10 * 64 + 40) * 4 + 3], 0);
    const top = await db.get<StoredTile>(`tile/${tileKey('c', 2, 0, 0)}`);
    assert(top);
    assertEquals((await db.scan('pyramid-todo/', { limit: 10 })).length, 0);
    const flat: CanvasMeta = { ...meta, id: 'small', maxLevel: 0, bounds: { x: 0, y: 0, width: 10, height: 10 } };
    await tiles.buildPyramid(flat, async () => { });
    assertEquals(flat.maxLevel, 0);
    assertEquals(QUALITY_BLOCK, 16);
});
Deno.test('diagnostics: every event is journaled, callbacks are throttled per code, counts and flush are exact', async () => {
    const db = new MemoryKV(), sent: Diagnostic[] = [], d = new Diagnostics(db, e => sent.push(e));
    for (let i = 0; i < 30; i++)
        await d.emit({ code: 'A', severity: 'info', message: 'a' });
    await d.emit({ code: 'B', severity: 'warning', message: 'b' });
    assertEquals(d.counts, { A: 30, B: 1 });
    assertEquals(sent.filter(e => e.code === 'A').length, 1);
    assertEquals(sent[0].count, 1);
    await d.flush();
    await d.flush();
    assertEquals((await db.scan('diagnostic/', { limit: 100 })).length, 31);
});
