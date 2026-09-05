import 'dotenv/config';

import { LedgerTableName } from '@matricarmz/ledger';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, directoryTools, entities, entityTypes, erpNomenclature, operations } from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';

// Ф1 плана tools-catalog-unify-2026-08-13. Гнать ПОСЛЕ Ф2 (warehouse:migrate-tool-catalog):
// до неё зеркала ещё используются как источники, и скрипт честно ничего не найдёт.
//
// Убирает два остатка предыдущей схемы, где справочником инструмента служили ЭКЗЕМПЛЯРЫ:
//
// 1. Строки `directory_tools`, на которые не ссылается ни одна живая позиция номенклатуры.
//    Это зеркала экземпляров, набитые миграцией 0045; после Ф2 источниками стали наименования,
//    и зеркала повисли. `directory_tools` — единственный резолвер источника в
//    upsertWarehouseNomenclature, поэтому лишние строки там ровно вводят в заблуждение.
//
// 2. Пустые карточки EAV-`tool` — «Новый инструмент» без единого заполненного поля.
//    Появлялись из кнопки создания на номенклатурной странице: она заводила сущность-ЭКЗЕМПЛЯР
//    до строки номенклатуры, и при обрыве оставалась сирота, невидимая во всех списках.
//    Условие сноса намеренно узкое — сносим только заведомо пустое: нет движений, нет ссылки на
//    наименование, нет серийного/табельного номера, нет подразделения. Всё, что хоть чем-то
//    заполнено, остаётся и печатается в отчёт.
//
// Запись — PG + signAndAppendDetailed: без ledger'а клиенты не увидят чистку и вернут строки
// обратно следующей синхронизацией.
//
// Запуск:
//   pnpm -F @matricarmz/backend-api warehouse:cleanup-tool-mirrors
//   pnpm -F @matricarmz/backend-api warehouse:cleanup-tool-mirrors -- --apply

const MEANINGFUL_TOOL_ATTRS = ['tool_catalog_id', 'serial_number', 'tool_number', 'department_id', 'received_at', 'retired_at', 'properties', 'photos'];

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function isFilled(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

async function main() {
  const apply = hasFlag('--apply');
  console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  const ts = Date.now();

  // ---- 1. Осиротевшие зеркала directory_tools ----
  const mirrors = await db.select().from(directoryTools).where(isNull(directoryTools.deletedAt)).limit(20_000);
  const referenced = await db
    .select({ refId: erpNomenclature.directoryRefId })
    .from(erpNomenclature)
    .where(and(eq(erpNomenclature.directoryKind, 'tool'), isNull(erpNomenclature.deletedAt)))
    .limit(20_000);
  const referencedIds = new Set(referenced.map((r) => String(r.refId ?? '')).filter(Boolean));
  const staleMirrors = mirrors.filter((row) => !referencedIds.has(String(row.id)));

  console.log(`\nзеркал directory_tools: ${mirrors.length}, из них используется: ${referencedIds.size}`);
  console.log(`осиротевших зеркал: ${staleMirrors.length}`);
  for (const row of staleMirrors) console.log(`  − ${row.id} «${row.name}»`);

  // ---- 2. Пустые карточки EAV-tool ----
  const typeRows = await db.select({ id: entityTypes.id }).from(entityTypes).where(eq(entityTypes.code, 'tool')).limit(1);
  const toolTypeId = typeRows[0]?.id ? String(typeRows[0].id) : null;

  const emptyTools: Array<{ id: string; name: string }> = [];
  const keptTools: Array<{ id: string; name: string; why: string }> = [];

  if (toolTypeId) {
    const toolRows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.typeId, toolTypeId as any), isNull(entities.deletedAt)))
      .limit(20_000);
    const toolIds = toolRows.map((r) => String(r.id));

    if (toolIds.length > 0) {
      const defs = await db
        .select({ id: attributeDefs.id, code: attributeDefs.code })
        .from(attributeDefs)
        .where(and(eq(attributeDefs.entityTypeId, toolTypeId as any), isNull(attributeDefs.deletedAt)))
        .limit(500);
      const defCodeById = new Map(defs.map((d) => [String(d.id), String(d.code)]));

      const values = await db
        .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
        .from(attributeValues)
        .where(and(inArray(attributeValues.entityId, toolIds), isNull(attributeValues.deletedAt)))
        .limit(200_000);

      const movementRows = await db
        .select({ subjectId: operations.engineEntityId })
        .from(operations)
        .where(and(inArray(operations.engineEntityId, toolIds), eq(operations.operationType, 'tool_movement'), isNull(operations.deletedAt)))
        .limit(50_000);
      const withMovements = new Set(movementRows.map((r) => String(r.subjectId)));

      const attrsById = new Map<string, Record<string, unknown>>();
      for (const v of values) {
        const code = defCodeById.get(String(v.attributeDefId));
        if (!code) continue;
        const bag = attrsById.get(String(v.entityId)) ?? {};
        bag[code] = parseJson(v.valueJson);
        attrsById.set(String(v.entityId), bag);
      }

      for (const id of toolIds) {
        const attrs = attrsById.get(id) ?? {};
        const name = String(attrs.name ?? '').trim() || '(без названия)';
        if (withMovements.has(id)) {
          keptTools.push({ id, name, why: 'есть движения' });
          continue;
        }
        const filled = MEANINGFUL_TOOL_ATTRS.filter((code) => isFilled(attrs[code]));
        if (filled.length > 0) {
          keptTools.push({ id, name, why: `заполнено: ${filled.join(', ')}` });
          continue;
        }
        emptyTools.push({ id, name });
      }
    }
  }

  console.log(`\nпустых карточек инструмента: ${emptyTools.length}`);
  for (const row of emptyTools) console.log(`  − ${row.id} «${row.name}»`);
  console.log(`оставлено (не пустые): ${keptTools.length}`);
  for (const row of keptTools) console.log(`  · ${row.id} «${row.name}» — ${row.why}`);

  if (!apply) {
    console.log('\nDRY-RUN: ничего не записано. Повторить с --apply.');
    return;
  }

  for (const row of staleMirrors) {
    await db.update(directoryTools).set({ deletedAt: ts, updatedAt: ts }).where(eq(directoryTools.id, row.id as any));
    await signAndAppendDetailed([
      {
        type: 'delete',
        table: LedgerTableName.DirectoryTools,
        row_id: String(row.id),
        row: {
          id: String(row.id),
          name: String(row.name),
          is_active: false,
          metadata_json: row.metadataJson ?? null,
          deprecated_at: row.deprecatedAt == null ? null : Number(row.deprecatedAt),
          created_at: Number(row.createdAt),
          updated_at: ts,
          deleted_at: ts,
        },
        actor: { userId: 'system', username: 'system', role: 'system' },
        ts,
      },
    ]);
  }

  for (const row of emptyTools) {
    await db.update(entities).set({ deletedAt: ts, updatedAt: ts }).where(eq(entities.id, row.id as any));
    const saved = await db.select().from(entities).where(eq(entities.id, row.id as any)).limit(1);
    const ent = saved[0];
    if (!ent) continue;
    await signAndAppendDetailed([
      {
        type: 'delete',
        table: LedgerTableName.Entities,
        row_id: String(ent.id),
        row: {
          id: String(ent.id),
          type_id: String(ent.typeId),
          created_at: Number(ent.createdAt),
          updated_at: ts,
          deleted_at: ts,
        },
        actor: { userId: 'system', username: 'system', role: 'system' },
        ts,
      },
    ]);
  }

  console.log(`\nснято зеркал: ${staleMirrors.length}, снято пустых карточек: ${emptyTools.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
