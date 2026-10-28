/**
 * Гейт «карточку двигателя нельзя удалить без причины» — серверная половина правила
 * владельца от 27.10.2026. До 28.10 правило держал только клиент (`engine:delete`
 * отбивает пустую причину), и это оказалось дырой: карточки, удалённые с клиента
 * версии 3.90.0, легли в реестр номеров без ответа «зачем» — актор и время есть,
 * причина потеряна навсегда. На живых данных это уже случилось шесть раз в день
 * выката 3.91.0.
 *
 * Причина живёт в существующем канале — `audit_log` (`action='engine.delete'`,
 * `payload_json.reason`), отдельного поля в контракте нет. Поэтому гейт не спрашивает
 * клиента повторно, а сверяет: есть ли к этой карточке запись с непустой причиной —
 * в этом же батче или уже в PG (очередь могла разделить удаление и аудит на два пуша).
 *
 * Отказ — per-row skip (очередь клиента не отравляется, `engine_delete_reason_required`),
 * как и у прочих pre-sign гейтов: подписанная в ledger строка разъехалась бы с PG.
 */
import { SyncTableName } from '@matricarmz/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { auditLog, entityTypes } from '../../database/schema.js';
import { logWarn } from '../../utils/logger.js';
import type { SyncSkippedRow } from './applyPushBatch.js';
import type { SyncWriteInput } from './syncWriteService.js';

export const ENGINE_DELETE_REASON_REQUIRED = 'engine_delete_reason_required';

const DELETE_ACTION = 'engine.delete';
const ENGINE_ENTITY_TYPE = 'engine';

function rowOf(input: SyncWriteInput): Record<string, unknown> | undefined {
  return input.row as Record<string, unknown> | undefined;
}

function isEntityDelete(input: SyncWriteInput): boolean {
  if (input.table !== SyncTableName.Entities) return false;
  const row = rowOf(input);
  return input.type === 'delete' || row?.deleted_at != null;
}

function reasonOf(payload: unknown): string {
  try {
    const parsed = JSON.parse(String(payload ?? '{}')) as { reason?: unknown };
    return String(parsed.reason ?? '').trim();
  } catch {
    return '';
  }
}

async function loadEngineTypeIds(): Promise<Set<string>> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, ENGINE_ENTITY_TYPE), isNull(entityTypes.deletedAt)));
  return new Set(rows.map((r) => String(r.id)));
}

/** Причины, приехавшие в этом же батче: клиент пишет аудит рядом с удалением. */
function reasonsInBatch(inputs: SyncWriteInput[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const input of inputs) {
    if (input.table !== SyncTableName.AuditLog) continue;
    const row = rowOf(input);
    if (!row || String(row.action ?? '') !== DELETE_ACTION || row.deleted_at != null) continue;
    const entityId = String(row.entity_id ?? '');
    if (!entityId) continue;
    const reason = reasonOf(row.payload_json);
    if (reason) out.set(entityId, reason);
  }
  return out;
}

/** Причины, осевшие в PG раньше: аудит мог уехать отдельным пушем. */
async function reasonsStored(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ entityId: auditLog.entityId, payload: auditLog.payloadJson })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, DELETE_ACTION),
        inArray(auditLog.entityId, ids as never[]),
        isNull(auditLog.deletedAt),
      ),
    );
  for (const r of rows) {
    const entityId = String(r.entityId ?? '');
    const reason = reasonOf(r.payload);
    if (entityId && reason && !out.has(entityId)) out.set(entityId, reason);
  }
  return out;
}

export async function partitionEngineDeletesByReason(
  inputs: SyncWriteInput[],
): Promise<{ allowed: SyncWriteInput[]; skipped: SyncSkippedRow[] }> {
  const deletes = inputs.filter(isEntityDelete);
  if (deletes.length === 0) return { allowed: inputs, skipped: [] };

  const engineTypeIds = await loadEngineTypeIds();
  const engineDeletes = deletes.filter((input) => {
    const typeId = String(rowOf(input)?.type_id ?? '');
    return typeId !== '' && engineTypeIds.has(typeId);
  });
  if (engineDeletes.length === 0) return { allowed: inputs, skipped: [] };

  const ids = engineDeletes.map((input) => String(rowOf(input)?.id ?? input.row_id ?? ''));
  const fromBatch = reasonsInBatch(inputs);
  const missingFromBatch = ids.filter((id) => !fromBatch.has(id));
  const fromDb = await reasonsStored(missingFromBatch);

  const withoutReason = new Set<string>();
  for (const id of ids) {
    if (fromBatch.get(id) || fromDb.get(id)) continue;
    withoutReason.add(id);
  }
  if (withoutReason.size === 0) return { allowed: inputs, skipped: [] };

  const allowed: SyncWriteInput[] = [];
  const skipped: SyncSkippedRow[] = [];
  for (const input of inputs) {
    const id = String(rowOf(input)?.id ?? input.row_id ?? '');
    if (!withoutReason.has(id) || !isEntityDelete(input)) {
      allowed.push(input);
      continue;
    }
    logWarn('engine delete gated: no reason', { rowId: id });
    skipped.push({ table: input.table, row_id: id, reason: ENGINE_DELETE_REASON_REQUIRED });
  }
  return { allowed, skipped };
}
