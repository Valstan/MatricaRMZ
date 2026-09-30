import 'dotenv/config';

import {
  ENGINE_INVENTORY_STAGE,
  SyncTableName,
  SyncTableRegistry,
  inventoryRawRowsFromPayload,
} from '@matricarmz/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { operations } from '../database/schema.js';
import {
  countLiveLinesByOperations,
  pickSheetDedupeSurvivors,
  type SheetDedupeHead,
} from '../services/engineInventoryLinesService.js';
import { writeSyncChanges } from '../services/sync/syncWriteService.js';

// engine-inventory:dedup-sheets — мягко удаляет дубли листов engine_inventory (G4 плана
// engine-inventory-lines-2026-09 и осенней программы). У двигателя с >1 живым листом
// живёт свежайший по updated_at (его и показывает клиент), остальные получают deleted_at.
// Удаление мягкое и обратимое (снятие deleted_at возвращает лист), но apply всё равно
// идёт только под явный OK владельца в том же ходе (#025, прод-мутация).
//
// Что спрячется вместе с листом — печатается dry-run построчно: строк в JSON листа и
// живых строк таблицы (удаление листа гасит и их через вывод — desired=[] для
// удалённого). Листы-дубли строк таблицы обычно не имеют (бэкфилл брал свежайший на
// двигатель), но клиент E2.3 мог дописать строки и в старый — такие кандидаты видны
// в отчёте колонкой live_lines.
// Счётчик M122: кандидаты с created_at ≥ выката v3.25.0 (2026-09-10) — новые дубли,
// которых после фикса отложенного создания быть не должно.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api engine-inventory:dedup-sheets            # dry-run
//   corepack pnpm -F @matricarmz/backend-api engine-inventory:dedup-sheets -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

const CUTOVER_3_25_0_MS = Date.UTC(2026, 8, 10);

function parseArgs(argv: string[]): { apply: boolean; engine: string | null } {
  const out = { apply: false, engine: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') out.apply = true;
    else if (a === '--engine') out.engine = String(argv[++i] ?? '').trim() || null;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`engine-inventory:dedup-sheets — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  // Страницами: полный select 2447 листов по 48–255 КБ + readExistingLines на 290 тыс.
  // строк роняют V8 на боксе (OOM dry-run strip 30.09). Лёгкие heads копим, payload
  // после подсчёта json_rows отпускаем.
  const PAGE = 200;
  const conds = [eq(operations.operationType, ENGINE_INVENTORY_STAGE as any), isNull(operations.deletedAt)];
  if (args.engine) conds.push(eq(operations.engineEntityId, args.engine as any));
  const heads: SheetDedupeHead[] = [];
  const allIds: string[] = [];
  let sheetTotal = 0;
  for (let offset = 0; ; offset += PAGE) {
    const page = (await db.select().from(operations).where(and(...conds)).limit(PAGE).offset(offset)) as any[];
    if (page.length === 0) break;
    sheetTotal += page.length;
    for (const s of page) {
      const meta = s.metaJson == null ? null : String(s.metaJson);
      const payload = safeParse(meta);
      const id = String(s.id);
      allIds.push(id);
      heads.push({
        id,
        engine_entity_id: String(s.engineEntityId),
        created_at: Number(s.createdAt ?? 0),
        updated_at: Number(s.updatedAt ?? 0),
        json_rows: payload && typeof payload === 'object' ? inventoryRawRowsFromPayload(payload).length : -1,
        live_lines: 0,
      });
    }
  }
  const liveCounts = await countLiveLinesByOperations(allIds);
  for (const h of heads) h.live_lines = liveCounts.get(h.id) ?? 0;
  const byId = new Map(heads.map((h) => [h.id, h]));
  const plans = pickSheetDedupeSurvivors(heads);
  const deleteIds = plans.flatMap((p) => p.delete_ids);

  console.log(`  живых листов: ${sheetTotal}, двигателей с дублями: ${plans.length}, кандидатов на удаление: ${deleteIds.length}`);
  let post325 = 0;
  for (const p of plans) {
    for (const id of p.delete_ids) {
      const h = byId.get(id)!;
      const fresh = h.created_at >= CUTOVER_3_25_0_MS ? ' [M122: создан после 3.25!]' : '';
      if (h.created_at >= CUTOVER_3_25_0_MS) post325++;
      console.log(`  - ${p.engine_entity_id} keep ${p.keep_id.slice(0, 8)} del ${id.slice(0, 8)} json_rows=${h.json_rows} live_lines=${h.live_lines}${fresh}`);
    }
  }
  console.log(`  счётчик M122 (кандидаты, созданные после выката 3.25): ${post325}`);

  if (!args.apply) {
    console.log('\nБез --apply запись не выполняется.');
    return;
  }
  if (deleteIds.length === 0) {
    console.log('Удалять нечего.');
    return;
  }

  const ts = Date.now();
  const actor = { id: 'server', username: 'engine-inventory:dedup-sheets', role: 'system' };
  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < deleteIds.length; i += BATCH) {
    const chunk = deleteIds.slice(i, i + BATCH);
    const batchRows = (await db
      .select()
      .from(operations)
      .where(inArray(operations.id, chunk as any))) as any[];
    const batchById = new Map(batchRows.map((s) => [String(s.id), s]));
    const rows = chunk.map((id) => {
      const dto = SyncTableRegistry.toSyncRow(SyncTableName.Operations, batchById.get(id)) as Record<string, unknown>;
      return {
        type: 'delete' as const,
        table: SyncTableName.Operations,
        row: { ...dto, deleted_at: ts, updated_at: ts, sync_status: 'synced' },
        row_id: id,
      };
    });
    const r = await writeSyncChanges(rows, actor, { allowSyncConflicts: true });
    done += chunk.length;
    console.log(`  записано ${done}/${deleteIds.length} (транзакций журнала: ${r.ledgerApplied})`);
  }
  console.log('Готово. Откат — снятием deleted_at у перечисленных id напрямую в PG (до ближайшего pull клиентов).');
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
