/**
 * Ф5 актов двигателя: per-деталь статусы ремонта.
 *
 *  - события `part_status_event` (GAP-6, история переходов) — локальная запись
 *    'in_repair' при создании ремнаряда из дефектовки; 'ready_for_assembly' пишет
 *    backend при закрытии наряда и приезжает синком;
 *  - производные статусы строк (GAP-4) — деривация из Repair-нарядов
 *    (`deriveEngineRepairPartStates`), без хранимого поля в строке списка.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  buildPartStatusEventNote,
  deriveEngineRepairPartStates,
  parsePartStatusEventPayload,
  PART_STATUS_EVENT_TYPE,
  type EngineRepairPartState,
  type PartStatusEventPayload,
} from '@matricarmz/shared';

import { operations } from '../database/schema.js';

const WORK_ORDERS_OPERATION_TYPE = 'work_order';

function nowMs() {
  return Date.now();
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export type EnginePartStatusEventRecord = PartStatusEventPayload & {
  operationId: string;
  at: number;
  by: string;
};

export async function saveInRepairPartStatusEvents(
  db: BetterSQLite3Database,
  args: {
    engineId: string;
    items: Array<{ partId: string; partLabel: string; qty: number }>;
    workOrderOperationId: string;
    workOrderNumber: number;
    actor: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const by = args.actor?.trim() ? args.actor.trim() : 'local';
    for (const item of args.items) {
      const payload: PartStatusEventPayload = {
        kind: 'part_status_event',
        engineEntityId: args.engineId,
        partId: item.partId,
        partLabel: item.partLabel,
        qty: item.qty,
        status: 'in_repair',
        workOrderOperationId: args.workOrderOperationId,
        workOrderNumber: args.workOrderNumber,
      };
      await db.insert(operations).values({
        id: randomUUID(),
        engineEntityId: args.engineId,
        operationType: PART_STATUS_EVENT_TYPE,
        status: 'event',
        note: buildPartStatusEventNote(payload),
        performedAt: ts,
        performedBy: by,
        metaJson: JSON.stringify(payload),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      });
    }
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function listEnginePartStatusEvents(
  db: BetterSQLite3Database,
  engineId: string,
): Promise<{ ok: true; events: EnginePartStatusEventRecord[] } | { ok: false; error: string }> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(
        and(eq(operations.engineEntityId, engineId), eq(operations.operationType, PART_STATUS_EVENT_TYPE), isNull(operations.deletedAt)),
      )
      .orderBy(desc(operations.performedAt))
      .limit(500);
    const events: EnginePartStatusEventRecord[] = [];
    for (const r of rows as any[]) {
      const payload = parsePartStatusEventPayload(r.metaJson ? String(r.metaJson) : null);
      if (!payload) continue;
      events.push({
        ...payload,
        operationId: String(r.id),
        at: Number(r.performedAt) || Number(r.createdAt) || 0,
        by: String(r.performedBy ?? ''),
      });
    }
    return { ok: true as const, events };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function listEngineRepairPartStates(
  db: BetterSQLite3Database,
  engineId: string,
): Promise<{ ok: true; states: Record<string, EngineRepairPartState> } | { ok: false; error: string }> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(and(eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE), isNull(operations.deletedAt)))
      .orderBy(desc(operations.updatedAt))
      .limit(5000);
    const ops: Array<{ operationId: string; status: string; updatedAt: number; rawPayload: Record<string, unknown> }> = [];
    for (const r of rows as any[]) {
      const parsed = safeJsonParse(r.metaJson ? String(r.metaJson) : '');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      ops.push({
        operationId: String(r.id),
        status: String(r.status ?? 'open'),
        updatedAt: Number(r.updatedAt) || 0,
        rawPayload: parsed as Record<string, unknown>,
      });
    }
    const states = deriveEngineRepairPartStates(ops, engineId);
    return { ok: true as const, states: Object.fromEntries(states) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}
