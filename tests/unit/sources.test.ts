import '../support/core.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { core } from '../../src/core/wasm.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import { SourceStore, type StoredSourceTile } from '../../src/storage/sources.ts';
import { SourceStorage, SourceWrites } from '../../src/pipeline/source-storage.ts';
import { StorageError } from '../../src/pipeline/context.ts';

// Fused analysis must preserve hot-state metadata, spilled entry addresses, candidate order, and
// drained epoch options. An unchanged opacity page must remain usable without a codec round trip.
Deno.test('source analysis: resident annotations match archive round trips for hot and spilled candidates', () => {
  const tile = core().sourceTile(32, -1, 2, 0, new Uint8Array(4).fill(1));
  const roles = core().sourceRoles([]), evidence = core().sourceEvidence([], roles);
  const labels = new Uint8Array(1024).fill(1);
  try {
    for (let frame = 0; frame < 7; frame++) {
      const data = new Uint8ClampedArray(4096);
      for (let i = 0; i < 1024; i++) data.set([frame * 29, i % 251, 83, 255], i * 4);
      tile.capture({ width: 32, height: 32, data }, labels, labels, {
        frame,
        time: frame / 30,
        poseX: -32,
        poseY: 64,
        code: 1,
        quality: 100 - frame,
      });
    }
    for (const [page, data] of [[0, tile.spill()!], [-1, tile.state()]] as const) {
      const roundtrip = core().sourceAnalysis(32, -1, 2, 0), fused = core().sourceAnalysis(32, -1, 2, 0);
      const opacity = core().sourceOpacityAnnotation(data, page, { size: 32, tx: -1, ty: 2, evidence });
      const opacityRoundtrip = core().sourceAnalysis(32, -1, 2, 0), opacityFused = core().sourceAnalysis(32, -1, 2, 0);
      try {
        const annotated = core().sourceArchiveAnnotate(data, page, 32, -1, 2, evidence);
        roundtrip.feed(annotated, page);
        assertEquals(fused.annotate(data, page, 32, -1, 2, evidence), annotated);
        assertEquals(fused.options(), roundtrip.options());
        assertEquals(fused.state(), roundtrip.state());
        assertEquals(opacity.archive(), data);
        opacityRoundtrip.feed(opacity.archive(), page);
        opacityFused.feedOpacity(opacity, page);
        assertEquals(opacityFused.options(), opacityRoundtrip.options());
        assertEquals(opacityFused.state(), opacityRoundtrip.state());
      } finally {
        roundtrip.free();
        fused.free();
        opacity.free();
        opacityRoundtrip.free();
        opacityFused.free();
      }
    }
  } finally {
    tile.free();
    evidence.free();
    roles.free();
  }
});

Deno.test('source write batches: a failed transaction retains the archive and dependent options for retry', async () => {
  class Unavailable extends MemoryKV {
    fail = true;
    override async putMany(rows: import('../../src/storage/db.ts').Row[]): Promise<void> {
      if (this.fail) throw new DOMException('', 'QuotaExceededError');
      await super.putMany(rows);
    }
  }
  const db = new Unavailable(), writes = new SourceWrites(new SourceStorage(db));
  const archive = new Uint8Array([1, 2, 3]), options = new Uint8Array([4, 5]);
  await writes.add([{ key: 'source-page/c/0_0/0', value: archive }, { key: 'source-options/c/0_0/0', value: options }], 5);
  await assertRejects(() => writes.flush(), StorageError, 'QuotaExceededError');
  assertEquals(db.data.size, 0);
  db.fail = false;
  await writes.flush();
  await writes.flush();
  assertEquals(await db.get('source-page/c/0_0/0'), archive);
  assertEquals(await db.get('source-options/c/0_0/0'), options);
  assertEquals(db.data.size, 2);
});

Deno.test('source storage: a quota exception with an empty message retains its actionable error name', async () => {
  class FullStorage extends MemoryKV {
    override async putMany(): Promise<void> {
      throw new DOMException('', 'QuotaExceededError');
    }
  }
  await assertRejects(() => new SourceStorage(new FullStorage()).putMany([]), StorageError, 'QuotaExceededError');
});

// Failure cases: spill followed by LRU reload, tiny working budgets, paused identical observations,
// and a disk failure during a state+archive transaction. Payload/provenance must survive all of them.
Deno.test('source store: native alternatives survive spill, eviction, and reload with a bounded active cache', async () => {
  const db = new MemoryKV(), store = new SourceStore(db, 16, 0, 8_000);
  const labels = new Uint8Array(16 * 16).fill(1), visibility = new Uint8Array(16 * 16).fill(1);
  try {
    for (let frame = 0; frame < 12; frame++) {
      for (let x = 0; x < 6; x++) {
        const address = { canvasId: 'c', x, y: 0 };
        const data = new Uint8ClampedArray(16 * 16 * 4);
        for (let i = 0; i < data.length; i += 4) data.set([frame * 17, x, 30, 255], i);
        await store.capture(address, new Uint8Array([1]), { width: 16, height: 16, data }, labels, visibility, {
          frame,
          time: frame / 30,
          poseX: x * 16,
          poseY: 0,
          code: 1,
          quality: 100,
        });
      }
    }
    await store.flush();
    assert(store.archivePages > 0);
    assert(store.peakResidentBytes <= Math.max(store.budgetBytes, store.largestTileBytes));
    for (let x = 0; x < 6; x++) {
      const row = (await db.get<StoredSourceTile>(`source-state/c/${x}_0`))!;
      assert(row.pages > 0);
      const loaded = core().sourceTile(16, x, 0, 0, new Uint8Array([1]), row.state);
      try {
        assertEquals(loaded.stats().candidates, 4);
        assertEquals(loaded.stats().pages, row.pages);
      } finally {
        loaded.free();
      }
      for (let page = 0; page < row.pages; page++) {
        assert((await db.get<Uint8Array>(`source-page/c/${x}_0/${String(page).padStart(10, '0')}`))!.byteLength > 0);
      }
    }
  } finally {
    store.free();
  }
});

Deno.test('source store: a failed archive transaction is retried before another capture mutates its snapshot', async () => {
  class FailingKV extends MemoryKV {
    fail = false;
    override async putMany(rows: import('../../src/storage/db.ts').Row[]): Promise<void> {
      if (this.fail) {
        this.fail = false;
        throw new Error('disk temporarily unavailable');
      }
      await super.putMany(rows);
    }
  }
  const db = new FailingKV(), store = new SourceStore(db, 16, 0, 100_000);
  const labels = new Uint8Array(256).fill(1), visibility = labels.slice(), address = { canvasId: 'c', x: 0, y: 0 };
  const capture = async (frame: number) => {
    const data = new Uint8ClampedArray(1024).fill(frame * 17);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    await store.capture(address, new Uint8Array([1]), { width: 16, height: 16, data }, labels, visibility, {
      frame,
      time: frame,
      poseX: 0,
      poseY: 0,
      code: 1,
      quality: 1,
    });
  };
  try {
    for (let i = 0; i < 6; i++) await capture(i);
    db.fail = true;
    try {
      await store.flush();
      throw new Error('expected injected failure');
    } catch (error) {
      assertEquals((error as Error).message, 'disk temporarily unavailable');
    }
    await capture(6);
    await store.flush();
    const row = (await db.get<StoredSourceTile>('source-state/c/0_0'))!;
    const analysis = core().sourceAnalysis(16, 0, 0, 0);
    try {
      for (let page = 0; page < row.pages; page++) {
        analysis.feed((await db.get<Uint8Array>(`source-page/c/0_0/${String(page).padStart(10, '0')}`))!, page);
      }
      analysis.feed(row.state, -1);
      assertEquals(analysis.summary()[0].candidates, 7);
    } finally {
      analysis.free();
    }
  } finally {
    store.free();
  }
});

Deno.test('source capture: per-frame sticky occlusions remain negative evidence during replay', () => {
  const tile = core().sourceTile(16, 0, 0, 0, new Uint8Array([1])), analysis = core().sourceAnalysis(16, 0, 0, 0);
  try {
    const pixels = new Uint8ClampedArray(1024).fill(255), labels = new Uint8Array(256).fill(1);
    tile.capture({ width: 16, height: 16, data: pixels }, labels, labels, {
      frame: 0,
      time: 0,
      poseX: 0,
      poseY: 0,
      code: 1,
      quality: 1,
      occlusions: [{ x: 0, y: 0, width: 16, height: 16 }],
    });
    analysis.feed(tile.state(), -1);
    assert(analysis.block(0).reasons.every((r) => r === 4), 'known sticky occlusions must not be promoted by the replay mask');
  } finally {
    tile.free();
    analysis.free();
  }
});
