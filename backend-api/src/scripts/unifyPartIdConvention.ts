/**
 * Phase 3.7 WS4 — унификация G1: ref-only детали → id-тождество.
 *
 * 27 номенклатур имеют `directory_ref_id`, указывающий на ОТДЕЛЬНУЮ живую строку
 * `directory_parts` (id ref-строки == старый part-entity id ≠ nomenclature.id) — двойная
 * конвенция G1. Целевая модель: деталь марки живёт на id-тождественной строке
 * (`directory_parts.id == erp_nomenclature.id`).
 *
 * Заземлено на проде (read-only, 2026-06-07): внешних ссылок на ref-id НЕТ
 * (склад/BOM/контракты ключуются по nomenclature_id; единственная ссылка — EAV
 * `part_engine_brand.part_id`, отмирающий keyspace). ⇒ перепривязка НЕ нужна, только
 * перенос spec/brand-links на id-тождественную строку.
 *
 * На каждую из ref-only:
 *   1. читает ref-строку (id=ref_id): code/templateId/dimensions/brandLinks/metadata;
 *   2. мержит в id-тождественную (id=nom_id) — union brand-links по engineBrandId;
 *      непустые поля id-тождественной строки имеют приоритет, иначе берётся из ref;
 *   3. retire ref-строки (soft-delete);
 *   4. зануляет `erp_nomenclature.directory_ref_id` (становится тождеством).
 *
 * Dry-run по умолчанию. Флаги: --apply | --json | --samples=N
 *   pnpm -F @matricarmz/backend-api warehouse:unify-part-id-convention            # dry-run
 *   pnpm -F @matricarmz/backend-api warehouse:unify-part-id-convention --apply
 */
import 'dotenv/config';

import { pool } from '../database/db.js';
import {
  getWarehouseNomenclaturePartSpec,
  upsertWarehouseNomenclaturePartSpec,
} from '../services/warehouseService.js';
import type { PartSpec, PartSpecBrandLink, PartMetadata } from '@matricarmz/shared';

const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');
const samplesArg = process.argv.find((x) => x.startsWith('--samples='));
const SAMPLES = samplesArg ? Math.max(0, Number(samplesArg.split('=')[1]) || 0) : 30;

type RefOnly = { nomId: string; refId: string; nomName: string; refName: string };

async function loadRefOnly(): Promise<RefOnly[]> {
  const res = await pool.query(
    `select n.id::text nom_id, n.directory_ref_id::text ref_id, n.name nom_name, dp.name ref_name
       from erp_nomenclature n
       join directory_parts dp on dp.id = n.directory_ref_id and dp.deleted_at is null
      where n.deleted_at is null and n.directory_ref_id is not null and n.directory_ref_id <> n.id
      order by n.name`,
  );
  return res.rows.map((r) => ({
    nomId: String(r.nom_id),
    refId: String(r.ref_id),
    nomName: String(r.nom_name ?? ''),
    refName: String(r.ref_name ?? ''),
  }));
}

function mergeSpec(idIdentity: PartSpec | null, ref: PartSpec): { spec: PartSpec; addedLinks: number } {
  const base: PartSpec = idIdentity ?? { code: null, dimensions: [], brandLinks: [] };
  const present = new Set(base.brandLinks.map((l) => String(l.engineBrandId)));
  const merged: PartSpecBrandLink[] = [...base.brandLinks];
  let added = 0;
  for (const l of ref.brandLinks) {
    if (present.has(String(l.engineBrandId))) continue;
    present.add(String(l.engineBrandId));
    merged.push(l);
    added += 1;
  }
  return {
    spec: {
      code: base.code ?? ref.code ?? null,
      dimensions: base.dimensions.length ? base.dimensions : ref.dimensions,
      brandLinks: merged,
    },
    addedLinks: added,
  };
}

async function main() {
  const startedAt = Date.now();
  const refOnly = await loadRefOnly();

  const stat = {
    refOnly: refOnly.length,
    idIdentityCollision: 0,
    brandLinksMerged: 0,
    retired: 0,
    refsNulled: 0,
    applied: 0,
    errors: [] as string[],
  };
  const samples: Array<{ nom: string; nomId: string; refId: string; collision: boolean; addLinks: number }> = [];

  for (const r of refOnly) {
    try {
      const refCur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: r.refId });
      const idCur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: r.nomId });
      const refSpec = refCur.ok && refCur.spec ? refCur.spec : { code: null, templateId: null, dimensions: [], brandLinks: [] };
      const idSpec = idCur.ok ? idCur.spec : null;
      const collision = idSpec != null;
      if (collision) stat.idIdentityCollision += 1;

      const { spec, addedLinks } = mergeSpec(idSpec, refSpec);
      stat.brandLinksMerged += addedLinks;

      // metadata: prefer id-identity's; carry ref's only when id-identity has none.
      const refMeta = (refCur.ok ? refCur.metadata : null) as PartMetadata | null;
      const idMeta = (idCur.ok ? idCur.metadata : null) as PartMetadata | null;
      const metaToWrite = idMeta && Object.keys(idMeta).length ? idMeta : refMeta && Object.keys(refMeta).length ? refMeta : undefined;

      if (samples.length < SAMPLES) samples.push({ nom: r.nomName, nomId: r.nomId, refId: r.refId, collision, addLinks: addedLinks });

      if (APPLY) {
        const up = await upsertWarehouseNomenclaturePartSpec({
          nomenclatureId: r.nomId,
          spec,
          ...(metaToWrite ? { metadata: metaToWrite } : {}),
        });
        if (!up.ok) throw new Error(`upsert id-identity ${r.nomId}: ${up.error}`);
        const ts = Date.now();
        await pool.query(
          `update directory_parts set deleted_at = $2, is_active = false, updated_at = $2 where id = $1 and deleted_at is null`,
          [r.refId, ts],
        );
        await pool.query(`update erp_nomenclature set directory_ref_id = null, updated_at = $2 where id = $1`, [r.nomId, ts]);
        stat.applied += 1;
        stat.retired += 1;
        stat.refsNulled += 1;
      }
    } catch (e) {
      stat.errors.push(`${r.nomId} (ref ${r.refId}): ${String(e)}`);
    }
  }

  const report = { mode: APPLY ? 'apply' : 'dry-run', ...stat, samples, elapsedMs: Date.now() - startedAt };
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[ws4-g1] mode=${report.mode}`);
    console.log(
      `[ws4-g1] ref-only=${stat.refOnly} collision(id-identity exists)=${stat.idIdentityCollision} brand-links-merged=${stat.brandLinksMerged}${APPLY ? ` applied=${stat.applied} retired=${stat.retired} refs-nulled=${stat.refsNulled}` : ''}`,
    );
    for (const s of samples) console.log(`  ${s.nom} | nom ${s.nomId} ← ref ${s.refId}${s.collision ? ' [COLLISION]' : ''} +${s.addLinks} links`);
    if (stat.errors.length) for (const e of stat.errors) console.log(`  ERROR ${e}`);
    if (!APPLY && stat.refOnly > 0) console.log('\nDry-run. Перезапустите с --apply (после pg_dump) для унификации.');
  }
}

void main()
  .catch((e) => {
    console.error('[ws4-g1] ошибка', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
