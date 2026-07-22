import 'dotenv/config';

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { LedgerTableName } from '@matricarmz/ledger';

import { db, pool } from '../database/db.js';
import { erpNomenclature, directoryParts } from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';

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
 *     nomenclature.code = directory.code so the client list shows the real article.
 *     Пишем канонически: прямой UPDATE в PG + signAndAppendDetailed (как
 *     upsertWarehouseNomenclature). НЕ recordSyncChanges: applyPushBatch не имеет
 *     веток для erp_*-таблиц, поэтому тот путь подписывает ledger и молча ничего не
 *     приземляет в PG, откуда клиенты и читают (выучено вживую 2026-07-12 в
 *     linkNomenclatureToPart.ts). ⚠️ Прогон 2026-07-12 шёл по сломанному пути —
 *     «18 промоутнутых артикулов» в PG, скорее всего, не приземлились; проверить
 *     SELECT'ом и при необходимости прогнать заново.
 *     Уникальность code — partial (`deleted_at is null AND code <> ''`, PG 0075),
 *     поэтому коллизию ищем среди ЖИВЫХ строк (занято = ручной merge).
 *
 * Промоут артикулов дублируется в `warehouse:blank-synthetic-codes` (он делает
 * PROMOTE перед BLANK, иначе реальный артикул терялся бы навсегда) — гнать этот
 * скрипт до него не обязательно.
 * Dry-run by default; pass --apply to mutate. Run on prod after the release pull;
 * pg_dump erp_nomenclature + directory_parts beforehand.
 */
const APPLY = process.argv.includes('--apply');
const SYNTHETIC = /^(DET|NM)-/;

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
  // dCode обязан быть РЕАЛЬНЫМ артикулом: без этой проверки скрипт переносил бы
  // синтетику из карточки в зеркало и объявлял это «промоутом».
  const codeCandidates = rows
    .map((r) => ({ ...r, dCode: (r.dCode ?? '').trim() }))
    .filter((r) => r.dCode !== '' && !SYNTHETIC.test(r.dCode) && r.dCode !== r.nCode && SYNTHETIC.test(r.nCode ?? ''));

  // collision check под партиал-уникальный индекс (deleted_at is null AND code <> ''):
  // занятость проверяем только среди ЖИВЫХ строк, soft-deleted уникальности не держат.
  const promote: Row[] = [];
  const collide: Row[] = [];
  for (const r of codeCandidates) {
    const dup = await db
      .select({ c: sql<number>`count(*)` })
      .from(erpNomenclature)
      .where(
        and(
          eq(erpNomenclature.code, r.dCode as string),
          ne(erpNomenclature.id, r.id as any),
          isNull(erpNomenclature.deletedAt),
        ),
      );
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
    await db
      .update(erpNomenclature)
      .set({ code: String(r.dCode), updatedAt: ts })
      .where(eq(erpNomenclature.id, r.id as any));
    const saved = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, r.id as any)).limit(1);
    const row = saved[0] as Record<string, any> | undefined;
    if (!row) continue;
    signAndAppendDetailed([
      {
        type: 'upsert',
        table: LedgerTableName.ErpNomenclature,
        row_id: r.id,
        row: {
          id: String(row.id),
          code: String(row.code),
          sku: row.sku ?? null,
          name: String(row.name),
          item_type: String(row.itemType),
          category: row.category ?? null,
          directory_kind: row.directoryKind ?? null,
          directory_ref_id: row.directoryRefId ?? null,
          group_id: row.groupId,
          unit_id: row.unitId,
          barcode: row.barcode,
          min_stock: row.minStock,
          max_stock: row.maxStock,
          default_brand_id: row.defaultBrandId ?? null,
          is_serial_tracked: Boolean(row.isSerialTracked),
          default_warehouse_id: row.defaultWarehouseId,
          spec_json: row.specJson,
          is_active: Boolean(row.isActive),
          created_at: Number(row.createdAt),
          updated_at: Number(row.updatedAt),
          deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
        },
        actor: { userId: 'system', username: 'system', role: 'system' },
        ts,
      },
    ]);
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
