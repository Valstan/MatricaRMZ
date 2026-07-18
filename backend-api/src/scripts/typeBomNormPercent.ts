import 'dotenv/config';

import { LedgerTableName } from '@matricarmz/ledger';
import { extractBomLineNormPercent } from '@matricarmz/shared';
import { isNull, inArray } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { erpEngineAssemblyBomLines } from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';
import { parseWarehouseBomLineMeta, serializeWarehouseBomLineMeta } from '../services/warehouseBomLineMeta.js';

/**
 * G8 (Ф5): типизация нормы расхода. Импорт УТД-20/В-84 (2026-07-17) положил «% нормы»
 * человеческим текстом в notes BOM-строки («Группа … · норма расхода N%»). Скрипт
 * дочитывает процент из текста и штампует typed `normPercent` в мету `bom_line_meta_v1`
 * (текст сохраняется как был). Идемпотентен: строки с уже заданным normPercent не трогает.
 *
 * Dry-run по умолчанию; --apply мутирует + подписывает изменённые строки в ledger.
 */

const APPLY = process.argv.includes('--apply');

let actor: { id: string; username: string; role: 'superadmin' } = { id: '', username: '', role: 'superadmin' };

async function resolveActor(): Promise<void> {
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from lg.value_json) as username
       from entities e
       join entity_types et on et.id = e.type_id and et.code = 'employee'
       join attribute_defs srd on srd.entity_type_id = et.id and srd.code = 'system_role'
       join attribute_values sr on sr.entity_id = e.id and sr.attribute_def_id = srd.id and sr.deleted_at is null
            and trim(both '"' from sr.value_json) = 'superadmin'
       left join attribute_defs lgd on lgd.entity_type_id = et.id and lgd.code = 'login'
       left join attribute_values lg on lg.entity_id = e.id and lg.attribute_def_id = lgd.id and lg.deleted_at is null
      where e.deleted_at is null
      order by username limit 1`,
  );
  if (!r.rows[0]) throw new Error('no superadmin employee found for actor');
  actor = { id: String(r.rows[0].id), username: String(r.rows[0].username ?? 'superadmin'), role: 'superadmin' };
  console.log(`[type-norm] actor: ${actor.username} (${actor.id.slice(0, 8)})`);
}

async function main() {
  await resolveActor();
  const lines = await db
    .select()
    .from(erpEngineAssemblyBomLines)
    .where(isNull(erpEngineAssemblyBomLines.deletedAt));

  let alreadyTyped = 0;
  let noNormInText = 0;
  const toUpdate: Array<{ id: string; nextNotes: string | null; pct: number }> = [];
  for (const line of lines as Array<Record<string, unknown>>) {
    const rawNotes = line.notes == null ? null : String(line.notes);
    const meta = parseWarehouseBomLineMeta(rawNotes);
    if (meta.normPercent != null) {
      alreadyTyped += 1;
      continue;
    }
    const pct = extractBomLineNormPercent(rawNotes);
    if (pct == null) {
      noNormInText += 1;
      continue;
    }
    toUpdate.push({ id: String(line.id), nextNotes: serializeWarehouseBomLineMeta({ ...meta, normPercent: pct }), pct });
  }
  console.log(
    `[type-norm] строк BOM: ${lines.length}; уже типизировано: ${alreadyTyped}; без нормы в тексте: ${noNormInText}; будет типизировано: ${toUpdate.length}`,
  );
  for (const u of toUpdate.slice(0, 5)) console.log(`  пример: ${u.id.slice(0, 8)} → normPercent=${u.pct}`);
  if (!APPLY || toUpdate.length === 0) {
    console.log(APPLY ? '[type-norm] нечего менять' : '[type-norm] DRY-RUN завершён — запусти с --apply для записи');
    await pool.end();
    return;
  }

  const ts = Date.now();
  for (const u of toUpdate) {
    await db
      .update(erpEngineAssemblyBomLines)
      .set({ notes: u.nextNotes, updatedAt: ts })
      .where(inArray(erpEngineAssemblyBomLines.id, [u.id]));
  }
  const savedRows = await db
    .select()
    .from(erpEngineAssemblyBomLines)
    .where(inArray(erpEngineAssemblyBomLines.id, toUpdate.map((u) => u.id)));
  signAndAppendDetailed(
    (savedRows as Array<Record<string, unknown>>).map((line) => ({
      type: 'upsert' as const,
      table: LedgerTableName.ErpEngineAssemblyBomLines,
      row_id: String(line.id),
      row: {
        id: String(line.id),
        bom_id: String(line.bomId),
        component_nomenclature_id: String(line.componentNomenclatureId),
        component_type: String(line.componentType),
        qty_per_unit: Number(line.qtyPerUnit),
        variant_group: line.variantGroup ?? null,
        is_required: Boolean(line.isRequired),
        priority: Number(line.priority),
        notes: line.notes ?? null,
        created_at: Number(line.createdAt),
        updated_at: Number(line.updatedAt),
        deleted_at: line.deletedAt == null ? null : Number(line.deletedAt),
        sync_status: String(line.syncStatus ?? 'synced'),
        last_server_seq: line.lastServerSeq == null ? null : Number(line.lastServerSeq),
      },
      actor: { userId: actor.id, username: actor.username, role: actor.role },
      ts,
    })),
  );
  console.log(`[type-norm] ✅ APPLY: типизировано ${toUpdate.length}, подписано в ledger ${savedRows.length}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
