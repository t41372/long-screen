/** Plan common dynamic epochs before materialization. Each source shard is decoded once even when
 * many disconnected components intersect it; candidate data remains on disk between shards. */
import { core, type SourceBlockAddress, type SourceComponent, type SourceEpoch } from '../core/wasm.ts';
import { iterate, type KV } from '../storage/db.ts';
import { sourcePages, type StoredSourceTile } from '../storage/sources.ts';
import { pad } from '../core/math.ts';
export interface OptionsPage {
  page: number;
  data: Uint8Array;
}
interface ComponentEpoch {
  canvasId: string;
  component: SourceComponent;
  epoch: SourceEpoch;
}
interface Target {
  block: number;
  frame: number;
  component: number;
  complete: boolean;
}
export class SourceEpochs {
  components = 0;
  partialComponents = 0;
  private targets = new Map<string, Target[]>();
  constructor(
    private store: KV,
    private size: number,
    private noise: number,
    private latest: boolean,
    private checkpoint: () => Promise<boolean>,
  ) {}
  async resolve(canvasId: string, components: SourceComponent[]): Promise<void> {
    for (const component of components) {
      if (!await this.checkpoint()) return;
      await this.planComponent(canvasId, component);
    }
    for (const [key, targets] of this.targets) {
      if (!await this.checkpoint()) return;
      const row = (await this.store.get<StoredSourceTile>(`source-state/${key}`))!;
      const saved = (await this.store.get<Uint8Array>(`source-analysis/${key}`))!;
      const analysis = core().sourceAnalysis(this.size, row.x, row.y, this.noise, saved);
      try {
        for (const t of targets) analysis.missing(t.block, t.frame, t.component);
        for await (const page of sourcePages(this.store, row)) analysis.epoch(page.data, page.page, targets);
        await this.store.put(`source-analysis/${key}`, analysis.state());
      } finally {
        analysis.free();
      }
    }
    this.targets.clear();
  }
  private groupBlocks(component: SourceComponent): Map<string, SourceBlockAddress[]> {
    const groups = new Map<string, SourceBlockAddress[]>();
    for (const block of component.blocks) {
      const key = `${block.tx}_${block.ty}`, list = groups.get(key) ?? [];
      list.push(block);
      groups.set(key, list);
    }
    return groups;
  }
  private async planComponent(canvasId: string, component: SourceComponent): Promise<void> {
    const groups = this.groupBlocks(component), sweep = core().sourceEpochSweep();
    let epoch: SourceEpoch;
    try {
      for (const block of component.blocks) sweep.add(block.expected, []);
      for (const [key, blocks] of groups) {
        for await (const { value: options } of iterate<OptionsPage>(this.store, `source-options/${canvasId}/${key}/`)) {
          sweep.addPage(options.data, blocks);
        }
      }
      epoch = sweep.choose(this.latest);
    } finally {
      sweep.free();
    }
    this.components++;
    if (!epoch.complete) this.partialComponents++;
    await this.store.put(`source-component/${canvasId}/${pad(component.id)}`, { canvasId, component, epoch } satisfies ComponentEpoch);
    if (epoch.frame === null) return;
    for (const [tileKey, blocks] of groups) {
      const key = `${canvasId}/${tileKey}`, targets = this.targets.get(key) ?? [];
      for (const b of blocks) targets.push({ block: b.block, frame: epoch.frame, component: component.id, complete: epoch.complete });
      this.targets.set(key, targets);
    }
  }
}
