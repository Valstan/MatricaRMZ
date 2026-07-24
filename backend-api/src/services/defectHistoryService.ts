import { randomUUID } from 'node:crypto';

import type { DefectOrigin, WorkOrderWorkLine } from '@matricarmz/shared';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../database/db.js';
import { defectConductedVersions, defectPartEvents, defectPartInstances, erpDocumentLines } from '../database/schema.js';

type Actor = { id: string; username: string };

function parseObject(value: string | null): Record<string, unknown> | null {
  try {
    const parsed = value ? JSON.parse(value) as unknown : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseDefectOrigin(value: unknown): DefectOrigin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const engineId = String(raw.engineId ?? '').trim();
  const conductedVersionId = String(raw.conductedVersionId ?? '').trim();
  const sourceLineIds = Array.isArray(raw.sourceLineIds)
    ? [...new Set(raw.sourceLineIds.map((entry) => String(entry ?? '').trim()).filter(Boolean))]
    : [];
  return engineId && conductedVersionId && sourceLineIds.length > 0
    ? { engineId, conductedVersionId, sourceLineIds }
    : null;
}

export async function recordDefectIncomingReceipt(args: {
  documentId: string;
  docType: 'purchase_receipt' | 'customer_supplied';
  actor: Actor;
}) {
  const targetEvent = args.docType === 'customer_supplied' ? 'customer_supplied' : 'purchased';
  try {
    const recorded = await db.transaction(async (tx) => {
      const lines = await tx
        .select({ qty: erpDocumentLines.qty, nomenclatureId: erpDocumentLines.nomenclatureId, payloadJson: erpDocumentLines.payloadJson })
        .from(erpDocumentLines)
        .where(eq(erpDocumentLines.headerId, args.documentId));
      let count = 0;
      for (const line of lines) {
        const payload = parseObject(line.payloadJson);
        const origin = parseDefectOrigin(payload?.defectOrigin);
        if (!origin) continue;
        const versions = await tx
          .select({ id: defectConductedVersions.id, engineId: defectConductedVersions.engineId, status: defectConductedVersions.status })
          .from(defectConductedVersions)
          .where(eq(defectConductedVersions.id, origin.conductedVersionId))
          .limit(1);
        const version = versions[0];
        if (!version || String(version.engineId) !== origin.engineId || version.status !== 'active') {
          throw new Error('Поступление ссылается на недействующую версию дефектовки');
        }
        const nomenclatureId = String(line.nomenclatureId ?? payload?.nomenclatureId ?? '').trim();
        const sources = await tx
          .select()
          .from(defectPartEvents)
          .where(and(
            eq(defectPartEvents.conductedVersionId, origin.conductedVersionId),
            inArray(defectPartEvents.sourceLineId, origin.sourceLineIds),
            eq(defectPartEvents.eventType, 'replacement_required'),
            eq(defectPartEvents.nomenclatureId, nomenclatureId),
          ));
        if (sources.length === 0) throw new Error('Не найдены исходные строки дефектовки для поступления');
        const prior = await tx
          .select()
          .from(defectPartEvents)
          .where(and(
            eq(defectPartEvents.conductedVersionId, origin.conductedVersionId),
            inArray(defectPartEvents.sourceLineId, origin.sourceLineIds),
            inArray(defectPartEvents.eventType, ['purchased', 'customer_supplied', 'repaired']),
            eq(defectPartEvents.nomenclatureId, nomenclatureId),
          ));
        const alreadyRecordedForDocument = prior.some((event) => {
          const eventPayload = parseObject(event.payloadJson);
          return String(eventPayload?.documentId ?? '') === args.documentId;
        });
        if (alreadyRecordedForDocument) continue;
        let remaining = Math.max(0, Math.trunc(Number(line.qty)));
        const usedBySource = new Map<string, number>();
        for (const event of prior) usedBySource.set(event.sourceLineId, (usedBySource.get(event.sourceLineId) ?? 0) + Number(event.qty));
        for (const source of sources) {
          if (remaining <= 0) break;
          const available = Math.max(0, Number(source.qty) - (usedBySource.get(source.sourceLineId) ?? 0));
          const qty = Math.min(remaining, available);
          if (qty <= 0) continue;
          await tx.insert(defectPartEvents).values({
            id: randomUUID(), engineId: origin.engineId, conductedVersionId: origin.conductedVersionId,
            sourceLineId: source.sourceLineId, nomenclatureId: source.nomenclatureId, instanceId: null,
            eventType: targetEvent, qty,
            payloadJson: JSON.stringify({ documentId: args.documentId, docType: args.docType }),
            occurredAt: Date.now(), occurredBy: args.actor.id,
          });
          remaining -= qty;
          count += 1;
        }
        if (remaining > 0) throw new Error('Количество поступления превышает потребность проведённой дефектовки');
      }
      return count;
    });
    return { ok: true as const, recorded };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

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

export async function recordAssemblyReturnInstances(args: {
  engineId: string;
  documentId: string;
  lines: Array<{ nomenclatureId: string; mode: 'rework' | 'scrap'; instanceIds?: string[] }>;
  actor: Actor;
}) {
  const selected = args.lines.flatMap((line) => (line.instanceIds ?? []).map((id) => ({ id, line })));
  if (selected.length === 0) return { ok: true as const, recorded: 0 };
  if (new Set(selected.map((item) => item.id)).size !== selected.length) {
    return { ok: false as const, error: 'Один номерной экземпляр указан в нескольких строках возврата' };
  }
  try {
    const recorded = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(defectPartInstances)
        .where(inArray(defectPartInstances.id, selected.map((item) => item.id)))
        .for('update');
      const byId = new Map(rows.map((row) => [String(row.id), row]));
      let count = 0;
      for (const item of selected) {
        const instance = byId.get(item.id);
        if (!instance) throw new Error(`Номерной экземпляр не найден: ${item.id}`);
        if (String(instance.nomenclatureId) !== item.line.nomenclatureId) {
          throw new Error(`Экземпляр ${instance.serialDisplay} относится к другой номенклатуре`);
        }
        const events = await tx.select().from(defectPartEvents).where(eq(defectPartEvents.instanceId, instance.id));
        const alreadyRecorded = events.some((event) => {
          const payload = parseObject(event.payloadJson);
          return String(payload?.documentId ?? '') === args.documentId &&
            (event.eventType === 'returned_from_assembly' || event.eventType === 'written_off_again');
        });
        if (alreadyRecorded) continue;
        const issued = [...events]
          .sort((left, right) => Number(right.occurredAt) - Number(left.occurredAt))
          .find((event) => event.eventType === 'issued_to_assembly');
        if (!issued || String(issued.engineId) !== args.engineId || instance.currentStatus !== 'issued_to_assembly') {
          throw new Error(`Экземпляр ${instance.serialDisplay} не числится в сборке выбранного двигателя`);
        }
        const eventType = item.line.mode === 'scrap' ? 'written_off_again' : 'returned_from_assembly';
        await tx.insert(defectPartEvents).values({
          id: randomUUID(), engineId: args.engineId, conductedVersionId: instance.currentVersionId,
          sourceLineId: issued.sourceLineId, nomenclatureId: instance.nomenclatureId, instanceId: instance.id,
          eventType, qty: 1, payloadJson: JSON.stringify({ documentId: args.documentId }),
          occurredAt: Date.now(), occurredBy: args.actor.id,
        });
        await tx.update(defectPartInstances).set({
          currentStatus: item.line.mode === 'scrap' ? 'scrapped' : 'returned_from_assembly',
          currentLocationId: null,
          updatedAt: Date.now(),
        }).where(eq(defectPartInstances.id, instance.id));
        count += 1;
      }
      return count;
    });
    return { ok: true as const, recorded };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function validateAssemblyReturnInstances(args: {
  engineId: string;
  lines: Array<{ nomenclatureId: string; qty: number; instanceIds?: string[] }>;
}) {
  const selected = args.lines.flatMap((line) => (line.instanceIds ?? []).map((id) => ({ id, line })));
  if (selected.length === 0) return { ok: true as const };
  if (new Set(selected.map((item) => item.id)).size !== selected.length) {
    return { ok: false as const, error: 'Один номерной экземпляр указан в нескольких строках возврата' };
  }
  const overfilled = args.lines.find((line) => (line.instanceIds?.length ?? 0) > Math.max(0, Math.trunc(line.qty)));
  if (overfilled) return { ok: false as const, error: 'Номерных экземпляров выбрано больше количества возврата' };
  const rows = await db.select().from(defectPartInstances).where(inArray(defectPartInstances.id, selected.map((item) => item.id)));
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const item of selected) {
    const instance = byId.get(item.id);
    if (!instance) return { ok: false as const, error: `Номерной экземпляр не найден: ${item.id}` };
    if (String(instance.nomenclatureId) !== item.line.nomenclatureId || instance.currentStatus !== 'issued_to_assembly') {
      return { ok: false as const, error: `Экземпляр ${instance.serialDisplay} не числится в выбранной строке сборки` };
    }
    const issued = await db
      .select({ engineId: defectPartEvents.engineId })
      .from(defectPartEvents)
      .where(and(eq(defectPartEvents.instanceId, item.id), eq(defectPartEvents.eventType, 'issued_to_assembly')));
    if (!issued.some((event) => String(event.engineId) === args.engineId)) {
      return { ok: false as const, error: `Экземпляр ${instance.serialDisplay} выдан на другой двигатель` };
    }
  }
  return { ok: true as const };
}
