/**
 * Ремфонд Ф3: чтение номерных экземпляров деталей двигателя из локального SQLite.
 * Записи (`operations`, `operationType='repair_fund_instance'`) пишет backend при
 * захвате с дефектовки и приезжают синком. Зеркало `listEnginePartStatusEvents`.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { parseRepairFundInstancePayload, REPAIR_FUND_INSTANCE_TYPE, type RepairFundInstancePayload } from '@matricarmz/shared';

import { operations } from '../database/schema.js';

export type EngineStampedInstanceRecord = RepairFundInstancePayload & { operationId: string; at: number };

export async function listEngineStampedInstances(
  db: BetterSQLite3Database,
  engineId: string,
): Promise<{ ok: true; instances: EngineStampedInstanceRecord[] } | { ok: false; error: string }> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.engineEntityId, String(engineId ?? '').trim()),
          eq(operations.operationType, REPAIR_FUND_INSTANCE_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .orderBy(desc(operations.performedAt))
      .limit(1000);
    const instances: EngineStampedInstanceRecord[] = [];
    for (const r of rows as any[]) {
      const payload = parseRepairFundInstancePayload(r.metaJson ? String(r.metaJson) : null);
      if (!payload) continue;
      instances.push({ ...payload, operationId: String(r.id), at: Number(r.performedAt) || Number(r.createdAt) || 0 });
    }
    return { ok: true as const, instances };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}
