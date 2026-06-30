import 'dotenv/config';

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { erpNomenclature, directoryParts } from '../database/schema.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';

/**
 * Phase 3.8 WS-A2 — reconcile code/name divergence between id-identical
 * erp_nomenclature (synced master, client list) and directory_parts (live-HTTP
 * part-spec card). Owner decision 2026-06-17 ("имена + продвинуть 22 артикула").
 *
 * Two fixes (additive, surgical):
 *  1. NAME: where erp_nomenclature.name != directory_parts.name → set
 *     directory_parts.name = nomenclature.name (nomenclature canonical; directory
 *     held truncated/junk like «комплек»). directory_parts is server-only
 *     (live-HTTP, NOT synced) → plain UPDATE, no ledger, instantly visible.
 *  2. CODE PROMOTE: where directory_parts.code is a REAL article and
 *     erp_nomenclature.code is a synthetic placeholder (^(DET|NM)-) → set
 *     nomenclature.code = directory.code so the synced client list shows the real
 *     article. erp_nomenclature IS synced → write THROUGH recordSyncChanges
 *     (ledger → index → PG, bumps last_server_seq) so clients pull it.
 *     erp_nomenclature.code is GLOBALLY unique (non-partial index incl. deleted)
 *     → skip any code already used by another row (collision = manual merge).
 *
 * MATRICA_SYNC_GUARD=strict не требуется (используем штатный write-путь).
 * Dry-run by default; pass --apply to mutate. Run on prod after the release pull;
 * pg_dump erp_nomenclature + directory_parts beforehand.
 */
const APPLY = process.argv.includes('--apply');
const SYNTHETIC = /^(DET|NM)-/;
const actor = { id: 'system', username: 'system', role: 'system' as const };

type Row = { id: string; nCode: string | null; dCode: string | null; nName: string | null; dName: string | null };

async function main() {
  // id-identity rows, both active, with code or name divergence
  const rows: Row[] = (
    await db
      .select({ id: erpNomenclature.id, nCode: erpNomenclature.code, dCode: directoryParts.code, nName: erpNomenclature.name, dName: directoryParts.name })
      .from(erpNomenclature)
      .innerJoin(directoryParts, eq(directoryParts.id, erpNomenclature.id))
      .where(and(isNull(erpNomenclature.deletedAt), isNull(directoryParts.deletedAt)))
  )
    .map((r) => ({ id: String(r.id), nCode: r.nCode ?? null, dCode: r.dCode ?? null, nName: r.nName ?? null, dName: r.dName ?? null }))
    .filter((r) => r.nCode !== r.dCode || r.nName !== r.dName);

  const nameFixes = rows.filter((r) => (r.nName ?? '') !== (r.dName ?? '') && (r.nName ?? '').trim() !== '');
  const codeCandidates = rows.filter(
    (r) => (r.dCode ?? '').trim() !== '' && r.dCode !== r.nCode && SYNTHETIC.test(r.nCode ?? ''),
  );

  // collision check against the global unique index (includes soft-deleted rows)
  const promote: Row[] = [];
  const collide: Row[] = [];
  for (const r of codeCandidates) {
    const dup = await db
      .select({ c: sql<number>`count(*)` })
      .from(erpNomenclature)
      .where(and(eq(erpNomenclature.code, r.dCode as string), ne(erpNomenclature.id, r.id as any)));
    (Number(dup[0]?.c ?? 0) > 0 ? collide : promote).push(r);
  }

  console.log(`[reconcile] divergent id-identity rows: ${rows.length}`);
  console.log(`[reconcile] NAME fixes (directory.name <- nomenclature.name): ${nameFixes.length}`);
  console.log(`[reconcile] CODE promote (nomenclature.code <- directory.code): ${promote.length}`);
  console.log(`[reconcile] CODE collisions (skip → manual merge): ${collide.length}`);
  for (const r of collide) console.log(`   collision: id=${r.id.slice(0, 8)} dCode=${r.dCode} name=${r.dName}`);

  if (!APPLY) {
    console.log('[reconcile] DRY-RUN (pass --apply to mutate)');
    await pool.end();
    return;
  }

  const ts = Date.now();
  let nameDone = 0;
  for (const r of nameFixes) {
    await db.update(directoryParts).set({ name: r.nName as string, updatedAt: ts }).where(eq(directoryParts.id, r.id as any));
    nameDone += 1;
  }

  let codeDone = 0;
  for (const r of promote) {
    const cur = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, r.id as any)).limit(1);
    if (!cur[0]) continue;
    const dto = SyncTableRegistry.toSyncRow(SyncTableName.ErpNomenclature, cur[0] as Record<string, unknown>);
    dto.code = r.dCode;
    dto.updated_at = ts;
    await recordSyncChanges(actor, [{ tableName: SyncTableName.ErpNomenclature, rowId: r.id, op: 'upsert', payload: dto }]);
    codeDone += 1;
  }

  console.log(`[reconcile] APPLIED: names=${nameDone} codes=${codeDone} (collisions skipped=${collide.length})`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('[reconcile] fatal', e);
  await pool.end();
  process.exit(1);
});
