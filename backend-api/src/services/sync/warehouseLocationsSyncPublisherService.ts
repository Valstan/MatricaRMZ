/**
 * Публикатор справочника складов и цехов (миграция 0093).
 *
 * Справочник ведут серверные двери (`warehouseLocationsService`) обычными `insert`/`update` —
 * мимо пути записи синхронизации. Такая строка не получает номера журнала, а инкрементальный
 * pull отбирает изменения условием `last_server_seq > since`: в SQL `NULL > n` не TRUE, то есть
 * строка не приезжает клиенту НИКОГДА (тот же разрыв, что закрывает публикатор аккаунтов).
 *
 * Очередь здесь не нужна — в отличие от аккаунтов, строки собирают не триггеры, а наш же код,
 * и признак «не опубликовано» несёт сама строка: `sync_status = 'pending'`. Ставит его дверь
 * при записи, снимает `applyPushBatch`, когда строка реально записана и проштампована seq.
 *
 * Живёт только на primary (singleton): ledger-append не должен идти с двух инстансов сразу.
 */
import { SyncTableName } from '@matricarmz/shared';
import { ne } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { warehouseLocations } from '../../database/schema.js';
import { logError, logInfo } from '../../utils/logger.js';
import { writeSyncChanges, type SyncWriteInput } from './syncWriteService.js';

const PUBLISH_TICK_MS = 60_000;
/** Справочник крошечный (15 строк на 07.09.2026); потолок — страховка, а не режим работы. */
const BATCH_LIMIT = 200;

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'system' } as const;

let running = false;
let timer: NodeJS.Timeout | null = null;

export function toWarehouseLocationInput(r: Record<string, unknown>): SyncWriteInput {
  const deletedAt = r['deletedAt'] == null ? null : Number(r['deletedAt']);
  return {
    type: deletedAt == null ? 'upsert' : 'delete',
    table: SyncTableName.WarehouseLocations,
    row_id: String(r['id']),
    row: {
      id: String(r['id']),
      type: String(r['type']),
      code: String(r['code']),
      name: String(r['name']),
      workshop_id: r['workshopId'] == null ? null : String(r['workshopId']),
      is_active: Boolean(r['isActive']),
      sort_order: Number(r['sortOrder'] ?? 0),
      metadata_json: r['metadataJson'] == null ? null : String(r['metadataJson']),
      created_at: Number(r['createdAt']),
      updated_at: Number(r['updatedAt']),
      deleted_at: deletedAt,
    },
  };
}

/** Один проход: опубликовать строки, помеченные `pending`. Возвращает число опубликованных. */
export async function publishPendingWarehouseLocations(): Promise<number> {
  const rows = await db
    .select()
    .from(warehouseLocations)
    .where(ne(warehouseLocations.syncStatus, 'synced'))
    .limit(BATCH_LIMIT);
  if (rows.length === 0) return 0;

  const inputs = (rows as Array<Record<string, unknown>>).map(toWarehouseLocationInput);
  await writeSyncChanges(inputs, SYSTEM_ACTOR, { allowSyncConflicts: true });
  return inputs.length;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const total = await publishPendingWarehouseLocations();
    if (total > 0) logInfo('warehouse locations published', { rows: total });
  } catch (e) {
    logError('warehouse locations publish failed', { error: String(e) });
  } finally {
    running = false;
  }
}

export function startWarehouseLocationsSyncPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), PUBLISH_TICK_MS);
  timer.unref?.();
  void tick();
  logInfo('warehouse locations sync publisher started', { tickMs: PUBLISH_TICK_MS });
}

export function stopWarehouseLocationsSyncPublisher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
