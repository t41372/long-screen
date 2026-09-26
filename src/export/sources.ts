/** Source alternatives are exported as ordinary native PNG patch sheets plus JSON. Internal compressed
 * archives are also retained, while the public sheets need neither Wasm nor a special deserializer. */
import { core } from '../core/wasm.ts';
import { iterate, type KV } from '../storage/db.ts';
import { sourceKey, type StoredSourceTile } from '../storage/sources.ts';
import { pad } from '../core/math.ts';
import { utf8 } from '../codec/crc.ts';
import type { ZipWriter } from './zip.ts';
export async function exportSources(db: KV, zip: ZipWriter): Promise<void> {
  const summary = await db.get('source-summary');
  if (!summary) return;
  await zip.add('sources/summary.json', utf8(JSON.stringify(summary, null, 2)));
  await zip.add(
    'sources/README.txt',
    utf8(
      'Native source alternatives\n\nEach PNG contains 16 x 16 native patches, packed left to right. Its JSON sidecar gives each patch rectangle, world block, source frame/time, pose, aliases and visibility runs. World block coordinates use the 256px source shard named by the directory; block indices are row-major. Visibility runs are [start,length,state], with 0 unknown, 1 page-visible, 2 occluded, 3 outside, 4 excluded by the canonical placement, 5 tentative parent source supported by page motion, 6 occluded tentative-parent source, 7 placement-excluded tentative-parent source, 8 excluded parent hypothesis, 9 native background connected to textured page-motion witnesses outside object footprints, 10 the same background support within a tentative parent hypothesis, 11 small native details surrounded by a supported parent surface (independent object occlusion still wins). States 9, 10 and 11 remain uncertain; they never count as a visible dynamic-epoch witness. Pixels are actual observations, never averaged. component records choose one common observed time for dynamic content; incomplete components retain partial/uncertain status. provenance records map every resolved pixel to its actual source frame and reason (0 unobserved, 1 visible witness, 2 uncorroborated observation, 3 ambiguous, 4 no confirmed clean source, 5 dynamic partial, 6 uncertain parent affiliation). The per-pixel source records supersede the original block-owner and first-render temporal records wherever present. The legacy provisional bit plane retains its world-consistency meaning; source reasons are the more detailed deferred classification, not a calibrated correctness probability. Opacity records contain the actual background/observation samples used to classify a tracked fringe, never generated output colours. Original recording frame indices are zero-based. A span records equivalent observed content; the patch bytes belong to the explicit frame, not every alias. Object region IDs above 255 denote auxiliary parent hypotheses; subtract 256 to obtain the original region code. Their masks never alter primary ownership. Internal .bin archives are LZ4 size-prefixed blocks containing Postcard v1. The PNG/JSON representation is independently inspectable.\n',
    ),
  );
  for await (const { value: row } of iterate<StoredSourceTile>(db, 'source-state/')) {
    const key = sourceKey(row);
    for (let page = 0; page <= row.pages; page++) {
      const state = page === row.pages, id = state ? 'state' : pad(page), ordinal = state ? -1 : page;
      const data = state ? row.state : await db.get<Uint8Array>(`source-page/${key}/${id}`);
      if (!data) throw new Error(`Missing source alternatives ${key}/${id}.`);
      const path = `sources/alternatives/${key}/${id}`;
      await zip.add(`${path}.png`, core().sourceArchiveExport(data, ordinal, true));
      await zip.add(`${path}.json`, core().sourceArchiveExport(data, ordinal, false));
      await zip.add(`${path}.bin`, data);
    }
  }
  for (const prefix of ['source-provenance/', 'source-component/', 'source-object-state/']) {
    for await (const { key, value } of iterate(db, prefix)) {
      await zip.add(
        `sources/${key}.json`,
        utf8(JSON.stringify(value, (_, v) => ArrayBuffer.isView(v) ? Array.from(v as unknown as number[]) : v)),
      );
    }
  }
  for await (const { key, value } of iterate<{ data: Uint8Array; validPixels: number }>(db, 'source-opacity/')) {
    await zip.add(`sources/${key}.json`, core().sourceOpacityExport(value.data));
  }
}
