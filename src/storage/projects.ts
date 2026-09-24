/** Owns the project key layout: `project/<id>`, `project-index/<created ISO>/<id>` and the `run/<id>/` namespace
 *  that holds a project's canvases, tiles and diagnostics. Everything that deletes a project's keys — worker.ts's
 *  sweep and device-check.ts's cleanup — goes through here, so the three key families never drift out of sync.
 *  The app keeps no history, only the latest print (keepLatest); `project-index/` is no longer written (it
 *  listed that history), and deletes still clear it.
 *  Key shapes must stay byte-identical to src/pipeline/context.ts persist() (`project/${id}`) and to the `run/${id}/`
 *  namespace Engine opens its store under — this module does not replace that write path, only mirrors its layout
 *  for reads and deletes. */
import type { KV } from './db.ts';
import { deletePrefix, iterate, Namespace } from './db.ts';
import type { Project } from '../types.ts';

export const projectKey = (id: string): string => `project/${id}`;
export const projectIndexKey = (created: string, id: string): string => `project-index/${created}/${id}`;
export const runPrefix = (id: string): string => `run/${id}/`;
export const runStore = (db: KV, id: string): Namespace => new Namespace(db, runPrefix(id));

/** The browser keeps one print, and only for a while: the newest project, if it was written less than `maxAgeMs`
 *  ago, stays (so a reload, a closed tab or a run the browser killed mid-way can bring it back); everything else is
 *  deleted, except prints another tab still holds (`held`), which are neither deleted nor returned. Returns the
 *  project kept for this page. */
export async function keepLatest(
  db: KV,
  options: { maxAgeMs: number; held?: ReadonlySet<string>; now?: number },
): Promise<Project | undefined> {
  const held = options.held ?? new Set<string>(), now = options.now ?? Date.now();
  let latest: Project | undefined;
  for await (const { value } of iterate<Project>(db, 'project/', false, 64)) {
    if (!held.has(value.id) && (!latest || value.updated > latest.updated)) {
      latest = value;
    }
  }
  const keep = latest && now - Date.parse(latest.updated) < options.maxAgeMs ? latest : undefined;
  await sweepProjects(db, keep ? [...held, keep.id] : held);
  return keep;
}

/** Deletes every project not in `keep`. Works from the `run/` namespaces as well as the `project/` records, so rows a
 *  crashed run wrote before its first persist go too, and so do the `project-index/` rows older versions wrote for
 *  the history list they used to keep. */
export async function sweepProjects(db: KV, keep: readonly string[] | ReadonlySet<string> = []): Promise<void> {
  const kept = new Set(keep);
  for (const prefix of ['run/', 'project/']) {
    let after: string | undefined;
    while (true) {
      const [row] = await db.scan(prefix, { after, limit: 1 });
      if (!row) {
        break;
      }
      const id = row.key.slice(prefix.length).split('/')[0];
      if (!kept.has(id)) {
        await deleteProject(db, id);
      }
      after = `${prefix}${id}/\uffff`;
    }
  }
  const stale: string[] = [];
  for await (const row of iterate<string>(db, 'project-index/', false, 256)) {
    if (!kept.has(row.value)) {
      stale.push(row.key);
    }
  }
  await db.deleteMany(stale);
}

/** Deletes all three key families a project can own: the `run/<id>/` namespace (canvases, tiles, diagnostics —
 *  everything Context.persist() (src/pipeline/context.ts) and the tile/diagnostic writers put under it), the
 *  `project/<id>` record, and the `project-index/<created>/<id>` row older versions wrote. */
export async function deleteProject(db: KV, id: string): Promise<void> {
  const project = await db.get<Project>(projectKey(id));
  await deletePrefix(db, runPrefix(id));
  await db.delete(projectKey(id));
  if (project) {
    await db.delete(projectIndexKey(project.created, id));
  }
}
