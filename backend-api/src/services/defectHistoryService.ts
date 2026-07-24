import { randomUUID } from 'node:crypto';

import type { WorkOrderWorkLine } from '@matricarmz/shared';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../database/db.js';
import { defectConductedVersions, defectPartEvents, defectPartInstances } from '../database/schema.js';

type Actor = { id: string; username: string };

export async function recordDefectRepairReturn(args: {
  engineId: string;
  workOrderOperationId: string;
  documentId: string;
  lines: WorkOrderWorkLine[];
  actor: Actor;
}) {
  const linkedLines = args.lines.filter((line) => line.defectOrigin && line.qty > 0);
  if (linkedLines.length === 0) return { ok: true as const, recorded: 0 };
  try {
    const recorded = await db.transaction(async (tx) => {
      let count = 0;
      for (const line of linkedLines) {
        const origin = line.defectOrigin!;
        if (origin.engineId !== args.engineId) throw new Error('Связь строки ремонта указывает на другой двигатель');
        const versions = await tx
          .select({ id: defectConductedVersions.id, status: defectConductedVersions.status })
          .from(defectConductedVersions)
          .where(and(eq(defectConductedVersions.id, origin.conductedVersionId), eq(defectConductedVersions.engineId, args.engineId)))
          .limit(1);
        if (!versions[0] || versions[0].status !== 'active') throw new Error('Проведённая версия дефектовки для строки ремонта не действует');
        const sources = await tx
          .select()
          .from(defectPartEvents)
          .where(and(
            eq(defectPartEvents.conductedVersionId, origin.conductedVersionId),
            inArray(defectPartEvents.sourceLineId, origin.sourceLineIds),
            eq(defectPartEvents.eventType, 'sent_to_repair'),
          ));
        if (sources.length === 0) throw new Error('Не найдены исходные строки дефектовки для возврата из ремонта');
        let remaining = Math.max(0, Math.trunc(line.qty));
        for (const source of sources) {
          if (remaining <= 0) break;
          const qty = Math.min(remaining, Number(source.qty));
          await tx.insert(defectPartEvents).values({
            id: randomUUID(), engineId: args.engineId, conductedVersionId: origin.conductedVersionId,
            sourceLineId: source.sourceLineId, nomenclatureId: source.nomenclatureId, instanceId: source.instanceId,
            eventType: 'repaired', qty,
            payloadJson: JSON.stringify({ workOrderOperationId: args.workOrderOperationId, documentId: args.documentId }),
            occurredAt: Date.now(), occurredBy: args.actor.id,
          });
          if (source.instanceId) {
            await tx.update(defectPartInstances).set({ currentStatus: 'repaired', updatedAt: Date.now() }).where(eq(defectPartInstances.id, source.instanceId));
          }
          remaining -= qty;
          count += 1;
        }
        if (remaining > 0) throw new Error('Количество возврата из ремонта превышает проведённое основание дефектовки');
      }
      return count;
    });
    return { ok: true as const, recorded };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}
