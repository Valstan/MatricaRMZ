import 'dotenv/config';

import {
  ENGINE_INVENTORY_STAGE,
  SyncTableName,
  SyncTableRegistry,
  inventoryLineKeys,
  inventoryRawRowsFromPayload,
} from '@matricarmz/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { operations } from '../database/schema.js';
import {
  countLiveLinesByOperations,
  pickSheetDedupeSurvivors,
  readExistingLines,
  type SheetDedupeHead,
} from '../services/engineInventoryLinesService.js';
import { writeSyncChanges } from '../services/sync/syncWriteService.js';

// engine-inventory:dedup-sheets — мягко удаляет дубли листов engine_inventory (G4 плана
// engine-inventory-lines-2026-09 и осенней программы). У двигателя с >1 живым листом
// живёт свежайший по updated_at (его и показывает клиент), остальные получают deleted_at.
// Удаление мягкое и обратимое (снятие deleted_at возвращает лист), но apply всё равно
// идёт только под явный OK владельца в том же ходе (#025, прод-мутация).
//
// Удаляем только бесспорное: пустые сироты (0 строк, 0 линий) и ПОКРЫТЫЕ дубли — все
// ключи строк дубля есть у хранителя (по его эффективным строкам: живые линии таблицы,
// иначе JSON). РАСХОДЯЩИЕСЯ (у дубля ключи, которых нет у хранителя) НЕ удаляем даже
// под OK без разбора: это может быть правка, внесённая в старый лист мимо свежего
// (офлайн на двух машинах), и её строки нигде больше не живут.
// Порядок apply с E3: сравнение берёт эффективные строки хранителя (живые линии
// таблицы, иначе JSON). Помеченный strip-ом хранитель без линий даёт пустое множество —
// дубли при нём честно расходятся, а не покрываются. Отдельного порядка не требуется,
// но чистить дубли раньше strip дешевле (меньше листов стрипать).
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

  // Классификация кандидатов: сирота (пусто везде) / покрыт (все ключи строк дубля
  // есть у хранителя — удаление ничего не прячет) / расходится (у дубля свои ключи —
  // НЕ удаляем даже под apply, только loud-отчёт). Эффективные ключи листа: живые
  // линии таблицы, если они есть, иначе JSON (помеченный лист без линий — пустое
  // множество: сравнение честно говорит «расходится», а не «покрыт»).
  const keeperByDelete = new Map<string, string>();
  for (const p of plans) for (const id of p.delete_ids) keeperByDelete.set(id, p.keep_id);
  const isOrphan = (h: SheetDedupeHead) => h.json_rows === 0 && h.live_lines === 0;
  const needKeysIds = [
    ...new Set([...keeperByDelete.values(), ...deleteIds.filter((id) => !isOrphan(byId.get(id)!))]),
  ];
  const metaById = new Map<string, unknown>();
  for (let i = 0; i < needKeysIds.length; i += 500) {
    const chunk = needKeysIds.slice(i, i + 500);
    const rows = (await db
      .select({ id: operations.id, metaJson: operations.metaJson })
      .from(operations)
      .where(inArray(operations.id, chunk as any))) as any[];
    for (const r of rows) {
      const m = r.metaJson == null ? null : String(r.metaJson);
      let p: unknown = null;
      try {
        p = m ? JSON.parse(m) : null;
      } catch {
        p = null;
      }
      metaById.set(String(r.id), p);
    }
  }
  const tableKeysByOp = new Map<string, Set<string>>();
  const withLines = needKeysIds.filter((id) => (byId.get(id)?.live_lines ?? 0) > 0);
  for (let i = 0; i < withLines.length; i += 50) {
    const existing = await readExistingLines(withLines.slice(i, i + 50));
    for (const [opId, lines] of existing) {
      tableKeysByOp.set(
        opId,
        new Set(lines.filter((l) => l.deleted_at == null).map((l) => l.line_key)),
      );
    }
  }
  const effectiveKeys = (id: string): Set<string> => {
    if (tableKeysByOp.has(id)) return tableKeysByOp.get(id)!;
    const p = metaById.get(id);
    if (!p || typeof p !== 'object') return new Set();
    return new Set(inventoryLineKeys(inventoryRawRowsFromPayload(p)));
  };
  const verdictById = new Map<string, 'orphan' | 'covered' | 'diverged'>();
  for (const id of deleteIds) {
    const h = byId.get(id)!;
    if (isOrphan(h)) {
      verdictById.set(id, 'orphan');
      continue;
    }
    const dk = effectiveKeys(id);
    const kk = effectiveKeys(keeperByDelete.get(id)!);
    verdictById.set(id, [...dk].every((k) => kk.has(k)) ? 'covered' : 'diverged');
  }

  console.log(`  живых листов: ${sheetTotal}, двигателей с дублями: ${plans.length}, кандидатов на удаление: ${deleteIds.length}`);
  const counts = { orphan: 0, covered: 0, diverged: 0 };
  let post325 = 0;
  const divergedLines: string[] = [];
  for (const p of plans) {
    for (const id of p.delete_ids) {
      const h = byId.get(id)!;
      const verdict = verdictById.get(id)!;
      counts[verdict]++;
      const fresh = h.created_at >= CUTOVER_3_25_0_MS ? ' [M122: создан после 3.25!]' : '';
      if (h.created_at >= CUTOVER_3_25_0_MS) post325++;
      const line = `  - ${p.engine_entity_id} keep ${p.keep_id.slice(0, 8)} del ${id.slice(0, 8)} json_rows=${h.json_rows} live_lines=${h.live_lines} [${verdict}]${fresh}`;
      if (verdict === 'diverged') divergedLines.push(line);
      else console.log(line);
    }
  }
  console.log(`  вердикты: сироты ${counts.orphan}, покрыты ${counts.covered}, РАСХОДЯТСЯ ${counts.diverged} (не удаляем)`);
  if (divergedLines.length > 0) {
    console.log('  --- расходящиеся дубли (оставляем, смотреть вручную) ---');
    for (const line of divergedLines) console.log(line);
  }
  console.log(`  счётчик M122 (кандидаты, созданные после выката 3.25): ${post325}`);

  if (!args.apply) {
    console.log('\nБез --apply запись не выполняется.');
    return;
  }
  // Apply удаляет только бесспорное (сироты + покрытые); расходящиеся остаются
  // стоять даже под --apply — их разбирать вручную поштучно.
  const applyIds = deleteIds.filter((id) => verdictById.get(id) !== 'diverged');
  const skippedDiverged = deleteIds.length - applyIds.length;
  if (skippedDiverged > 0) console.log(`  расходящихся ${skippedDiverged} — пропускаем, остаются жить`);
  if (applyIds.length === 0) {
    console.log('Удалять нечего.');
    return;
  }

  const ts = Date.now();
  const actor = { id: 'server', username: 'engine-inventory:dedup-sheets', role: 'system' };
  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < applyIds.length; i += BATCH) {
    const chunk = applyIds.slice(i, i + BATCH);
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
    console.log(`  записано ${done}/${applyIds.length} (транзакций журнала: ${r.ledgerApplied})`);
  }
  console.log('Готово. Откат — снятием deleted_at у перечисленных id напрямую в PG (до ближайшего pull клиентов).');
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
