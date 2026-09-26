/** Stream native opacity witnesses through small persisted fields. This pass never decodes a frame
 * or supplies an output colour: it annotates the already archived candidates, then reruns selection. */
import { core } from '../core/wasm.ts';
import type { SourceEvidence } from '../core/wasm/sources-opacity.ts';
import { iterate, type KV } from '../storage/db.ts';
import { sourceKey, sourcePages, type StoredSourceTile } from '../storage/sources.ts';
import { SourceWrites } from './source-storage.ts';
import type { RunContext } from './context.ts';
import { pad } from '../core/math.ts';
import { SourceModelFits, SourceModels, type StoredOpacityField as StoredField } from '../storage/source-models.ts';
export interface OpacityStats {
  fields: number;
  pixels: number;
  classified: number;
  bytes: number;
  peakCoreBytes: number;
  peakModelBytes: number;
  modelWrites: number;
  peakFitBytes: number;
  visibilityConflicts: number;
}
export async function refineSourceOpacity(
  ctx: RunContext,
  canvasId: string,
  size: number,
  evidence: (data: Uint8Array, page: number) => Promise<SourceEvidence>,
  store: KV = ctx.store,
): Promise<OpacityStats> {
  const stats: OpacityStats = {
    fields: 0,
    pixels: 0,
    classified: 0,
    bytes: 0,
    peakCoreBytes: core().memoryBytes,
    peakModelBytes: 0,
    modelWrites: 0,
    peakFitBytes: 0,
    visibilityConflicts: 0,
  };
  const checkpoint = async () => {
    await ctx.checkpoint();
    if (ctx.stopRequested) ctx.honourStop();
    return !ctx.stopped;
  };
  const models = new SourceModels(
    store,
    `source-opacity/${canvasId}/`,
    ctx.noise,
    Math.max(2, Math.min(96, ctx.project.settings.memoryMB * .70)) * 1024 * 1024,
  );
  try {
    for await (const { value: row } of iterate<StoredSourceTile>(store, `source-state/${canvasId}/`)) {
      if (!await checkpoint()) return stats;
      const saved = (await store.get<Uint8Array>(`source-analysis/${sourceKey(row)}`))!;
      const reference = core().sourceAnalysis(size, row.x, row.y, ctx.noise, saved);
      try {
        if (reference.needsRefutation()) {
          for await (const page of sourcePages(store, row)) reference.corroborate(page.data, page.page);
          for await (const page of sourcePages(store, row)) stats.visibilityConflicts += reference.refute(page.data, page.page);
        }
        for await (const page of sourcePages(store, row)) {
          const witnesses = await evidence(page.data, page.page);
          let learning: ReturnType<typeof reference.opacityLearning>;
          try {
            learning = reference.opacityLearning(page.data, page.page, { size, tx: row.x, ty: row.y, evidence: witnesses });
          } finally {
            witnesses.free();
          }
          try {
            for (const key of learning.keys()) await models.merge(learning, key);
            stats.peakCoreBytes = Math.max(stats.peakCoreBytes, core().memoryBytes);
          } finally {
            learning.free();
          }
        }
        await store.putMany([
          { key: 'source-analysis/' + sourceKey(row), value: reference.state() },
          { key: 'source-blocks/' + sourceKey(row), value: reference.summary() },
        ]);
      } finally {
        reference.free();
      }
    }
    await models.flush();
  } finally {
    stats.peakModelBytes = models.peakBytes;
    stats.modelWrites = models.writes;
    models.free();
  }
  for await (const row of iterate<StoredField>(store, `source-opacity/${canvasId}/`)) {
    const validPixels = core().sourceOpacityValid(row.value.data, ctx.noise);
    stats.bytes += row.value.data.byteLength;
    if (validPixels) {
      stats.fields++;
      stats.pixels += validPixels;
    }
    await store.put(row.key, { ...row.value, validPixels });
  }
  if (!stats.fields) return stats;
  const fields = new SourceModelFits(
    store,
    `source-opacity/${canvasId}/`,
    ctx.noise,
    Math.max(2, Math.min(32, ctx.project.settings.memoryMB * .20)) * 1024 * 1024,
  );
  try {
    for await (const { value: row } of iterate<StoredSourceTile>(store, `source-state/${canvasId}/`)) {
      if (!await checkpoint()) return stats;
      const key = sourceKey(row), saved = (await store.get<Uint8Array>(`source-analysis/${key}`))!;
      const reference = core().sourceAnalysis(size, row.x, row.y, ctx.noise, saved),
        resolved = core().sourceAnalysis(size, row.x, row.y, ctx.noise);
      const writes = new SourceWrites(store);
      const classifiedBefore = stats.classified;
      let rechecked: ReturnType<ReturnType<typeof core>['sourceAnalysis']> | undefined;
      try {
        resolved.copyBaseline(reference);
        for await (const page of sourcePages(store, row)) {
          const witnesses = await evidence(page.data, page.page);
          let annotation: ReturnType<ReturnType<typeof core>['sourceOpacityAnnotation']>;
          try {
            annotation = core().sourceOpacityAnnotation(page.data, page.page, { size, tx: row.x, ty: row.y, evidence: witnesses });
          } finally {
            witnesses.free();
          }
          let data: Uint8Array;
          let classified = 0;
          try {
            for (const key of annotation.keys()) {
              const field = await fields.get(key);
              if (field) classified += reference.applyFittedOpacity(annotation, key, field, ctx.noise);
            }
            stats.classified += classified;
            // Most pages contain no newly classified pixels. Preserve their exact archive bytes;
            // selection can read the native entries without encoding and immediately decoding them.
            resolved.feedOpacity(annotation, page.page);
            data = classified ? annotation.archive() : page.data;
            stats.peakCoreBytes = Math.max(stats.peakCoreBytes, core().memoryBytes);
          } finally {
            annotation.free();
          }
          const options = resolved.options();
          await writes.add([
            ...(classified ? [{ key: page.key, value: page.page < 0 ? { ...row, state: data } : data }] : []),
            {
              key: `source-options/${key}/${page.page < 0 ? 'state' : pad(page.page)}`,
              value: { page: page.page, data: options },
            },
          ], data.byteLength + options.byteLength);
        }
        await writes.flush();
        // Classification can leave a formerly repeated hypothesis supported by just one weak
        // observation. Reconsider it with the new negatives, without learning from its own verdict.
        if (stats.classified > classifiedBefore && resolved.needsRefutation()) {
          const updated = (await store.get<StoredSourceTile>(`source-state/${key}`))!;
          for await (const page of sourcePages(store, updated)) resolved.corroborate(page.data, page.page);
          let changed = 0;
          for await (const page of sourcePages(store, updated)) changed += resolved.refute(page.data, page.page);
          stats.visibilityConflicts += changed;
          if (changed) {
            rechecked = core().sourceAnalysis(size, row.x, row.y, ctx.noise);
            rechecked.copyBaseline(resolved);
            for await (const page of sourcePages(store, updated)) {
              rechecked.feed(page.data, page.page);
              // Visibility and epoch options did not change; existing page addresses remain valid.
              rechecked.options();
            }
            if (rechecked.needsRefutation()) {
              for await (const page of sourcePages(store, updated)) rechecked.corroborate(page.data, page.page);
            }
          }
        }
        const selected = rechecked ?? resolved;
        await store.putMany([{ key: `source-analysis/${key}`, value: selected.state() }, {
          key: `source-blocks/${key}`,
          value: selected.summary(),
        }]);
      } finally {
        rechecked?.free();
        reference.free();
        resolved.free();
      }
    }
  } finally {
    stats.peakFitBytes = fields.peakBytes;
    fields.free();
  }
  return stats;
}
