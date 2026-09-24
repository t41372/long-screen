/** Owns the project key layout: `project/<id>`, `project-index/<created ISO>/<id>` and the `run/<id>/` namespace
 *  that holds a project's canvases, tiles and diagnostics. Everything that touches a project's keys — worker.ts's
 *  history/open/delete handlers and device-check.ts's cleanup — goes through here, so the three key families can
 *  never drift out of sync again (a hand-rolled delete that forgets `project-index/` or `project/` leaves a ghost
 *  entry in the app's history forever, since neither key family is ever swept independently).
 *  Key shapes must stay byte-identical to src/pipeline/engine.ts persist() (`project/${id}`,
 *  `project-index/${created}/${id}`) and to the `run/${id}/` namespace Engine opens its store under — this module
 *  does not replace that write path, only mirrors its layout for reads and deletes. */
import type { KV, Row } from './db.ts';
import { deletePrefix, iterate, Namespace } from './db.ts';
import type { Project } from '../types.ts';

export const projectKey = (id: string): string => `project/${id}`;
export const projectIndexKey = (created: string, id: string): string => `project-index/${created}/${id}`;
export const runPrefix = (id: string): string => `run/${id}/`;
export const runStore = (db: KV, id: string): Namespace => new Namespace(db, runPrefix(id));

/** Newest-first project history, one page at a time. `project-index/<created ISO>/<id>` is written on a run's
 *  first persist and gives cheap newest-first order; pre-existing projects (written before the index existed) have
 *  no index row, so once the index page runs dry this falls back to scanning `project/` directly, deduping against
 *  every id the index has ever produced so a legacy project already returned by an earlier index page never
 *  resurfaces on a later legacy page. */
export async function listProjects(db: KV, options: { after?: string; limit?: number } = {}): Promise<Row<Project>[]> {
  const limit = options.limit ?? 30;
  const after = options.after, legacyContinuation = after?.startsWith('project/');
  const indexRows = legacyContinuation ? [] : await db.scan<string>('project-index/', { after, limit, reverse: true });
  const seen = new Set<string>(), rows: Row<Project>[] = [];
  for (const row of indexRows) {
    const project = await db.get<Project>(projectKey(row.value));
    if (project) {
      rows.push({ key: row.key, value: project });
      seen.add(row.value);
    }
  }
  if (indexRows.length < limit) {
    // project/ holds every project's record, indexed or not, so this legacy scan can re-surface a project an
    // earlier index page already returned; resolve the account's complete indexed-id set here (not just this
    // page's `seen`) so dedup carries across pages instead of resetting on every call.
    for await (const row of iterate<string>(db, 'project-index/', false, 256)) {
      seen.add(row.value);
    }
    const legacyAfter = legacyContinuation ? after : undefined;
    const legacy = await db.scan<Project>('project/', { after: legacyAfter, limit: limit - rows.length, reverse: true });
    for (const row of legacy) {
      if (!seen.has(row.value.id)) {
        rows.push(row);
      }
    }
  }
  return rows;
}

/** Deletes all three key families a project can own: the `run/<id>/` namespace (canvases, tiles, diagnostics —
 *  everything Engine.persist() and the tile/diagnostic writers put under it), the `project/<id>` record, and the
 *  `project-index/<created>/<id>` history row. Deleting only `run/<id>/` (the previous device-check.ts behaviour)
 *  leaves `project/<id>` and `project-index/<created>/<id>` behind: an empty project that still shows up in history. */
export async function deleteProject(db: KV, id: string): Promise<void> {
  const project = await db.get<Project>(projectKey(id));
  await deletePrefix(db, runPrefix(id));
  await db.delete(projectKey(id));
  if (project) {
    await db.delete(projectIndexKey(project.created, id));
  }
}
