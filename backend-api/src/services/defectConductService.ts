import { createHash, randomUUID } from 'node:crypto';

import {
  WAREHOUSE_LOCATION_REPAIR_FUND,
  WAREHOUSE_LOCATION_SCRAP,
  type DefectConductLineInput,
  type DefectConductRequest,
  type DefectPartEventType,
} from '@matricarmz/shared';
import { and, desc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  defectConductedVersions,
  defectPartEvents,
  defectPartInstances,
  erpDocumentHeaders,
  erpDocumentLines,
  erpJournalDocuments,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
  operations,
} from '../database/schema.js';
import { resolveWarehouseLocationIdsByCodes } from './warehouseLocationsService.js';
import { emitOperationSyncChange, resolvePartIdToNomenclatureMap } from './workOrderClosingService.js';

type Actor = { id: string; username: string; role?: string };
type ResolvedLine = DefectConductLineInput & { nomenclatureId: string; stampedNumber: string };
type Snapshot = { engineId: string; draftRevision: string; lines: ResolvedLine[] };

export function normalizeDefectSerialNumber(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

function normalizeQty(value: number): number {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function canonicalSnapshot(snapshot: Snapshot): string {
  return JSON.stringify({
    engineId: snapshot.engineId,
    draftRevision: snapshot.draftRevision,
    lines: snapshot.lines
      .map((line) => ({
        sourceLineId: line.sourceLineId,
        partId: line.partId,
        partLabel: line.partLabel,
        nomenclatureId: line.nomenclatureId,
        stampedNumber: line.stampedNumber,
        repairableQty: line.repairableQty,
        scrapQty: line.scrapQty,
        replaceQty: line.replaceQty,
        replenishmentMethod: line.replenishmentMethod ?? null,
        defectDescription: line.defectDescription ?? '',
      }))
      .sort((a, b) => a.sourceLineId.localeCompare(b.sourceLineId, 'ru')),
  });
}

function parseSnapshot(value: string): Snapshot | null {
  try {
    const parsed = JSON.parse(value) as Snapshot;
    return parsed && Array.isArray(parsed.lines) ? parsed : null;
  } catch {
    return null;
  }
}

function quantitiesByLocation(lines: ResolvedLine[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of lines) {
    if (line.repairableQty > 0) {
      const key = `${line.nomenclatureId}:${WAREHOUSE_LOCATION_REPAIR_FUND}`;
      result.set(key, (result.get(key) ?? 0) + line.repairableQty);
    }
    if (line.scrapQty > 0) {
      const key = `${line.nomenclatureId}:${WAREHOUSE_LOCATION_SCRAP}`;
      result.set(key, (result.get(key) ?? 0) + line.scrapQty);
    }
  }
  return result;
}

function legacyIntakeQuantities(rows: Array<{ operationType: string; metaJson: string | null }>): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    let parsed: { items?: Array<{ nomenclatureId?: string; qty?: number }> } | null = null;
    try {
      parsed = row.metaJson ? JSON.parse(row.metaJson) : null;
    } catch {
      parsed = null;
    }
    const location = row.operationType === 'scrap_intake' ? WAREHOUSE_LOCATION_SCRAP : WAREHOUSE_LOCATION_REPAIR_FUND;
    for (const item of parsed?.items ?? []) {
      const nomenclatureId = String(item.nomenclatureId ?? '').trim();
      const qty = normalizeQty(Number(item.qty));
      if (!nomenclatureId || qty <= 0) continue;
      const key = `${nomenclatureId}:${location}`;
      result.set(key, Math.max(result.get(key) ?? 0, qty));
    }
  }
  return result;
}

function initialStatus(line: ResolvedLine): { status: string; locationCode: string | null } {
  if (line.scrapQty > 0) return { status: 'scrapped', locationCode: WAREHOUSE_LOCATION_SCRAP };
  if (line.replaceQty > 0) return { status: 'replacement_required', locationCode: null };
  return { status: 'in_fund', locationCode: WAREHOUSE_LOCATION_REPAIR_FUND };
}

export function buildDefectInitialEvents(
  line: Pick<DefectConductLineInput, 'repairableQty' | 'scrapQty' | 'replaceQty' | 'replenishmentMethod'>,
): Array<{ type: DefectPartEventType; qty: number }> {
  const result: Array<{ type: DefectPartEventType; qty: number }> = [];
  if (line.repairableQty > 0) result.push({ type: 'classified_repairable', qty: line.repairableQty });
  if (line.scrapQty > 0) result.push({ type: 'classified_scrap', qty: line.scrapQty });
  if (line.replaceQty > 0) {
    result.push({ type: 'replacement_required', qty: line.replaceQty });
    if (line.replenishmentMethod === 'purchase') result.push({ type: 'purchase_requested', qty: line.replaceQty });
    if (line.replenishmentMethod === 'customer') result.push({ type: 'customer_requested', qty: line.replaceQty });
    if (line.replenishmentMethod === 'own_repair') result.push({ type: 'sent_to_repair', qty: line.replaceQty });
  }
  return result;
}

export async function conductDefect(args: DefectConductRequest & { actor: Actor }) {
  const engineId = String(args.engineId ?? '').trim();
  const operationId = String(args.operationId ?? '').trim();
  const draftRevision = String(args.draftRevision ?? '').trim();
  if (!engineId || !operationId || !draftRevision) return { ok: false as const, error: 'Не заданы двигатель, operation ID или ревизия черновика' };

  const normalizedInput = args.lines.map((line, index) => ({
    sourceLineId: String(line.sourceLineId ?? '').trim() || `line-${index + 1}`,
    partId: String(line.partId ?? '').trim(),
    partLabel: String(line.partLabel ?? '').trim(),
    stampedNumber: String(line.stampedNumber ?? '').normalize('NFKC').trim(),
    repairableQty: normalizeQty(line.repairableQty),
    scrapQty: normalizeQty(line.scrapQty),
    replaceQty: normalizeQty(line.replaceQty),
    ...(line.replenishmentMethod ? { replenishmentMethod: line.replenishmentMethod } : {}),
    ...(line.defectDescription?.trim() ? { defectDescription: line.defectDescription.trim() } : {}),
  })).filter((line) => line.partId && line.repairableQty + line.scrapQty + line.replaceQty > 0);
  if (normalizedInput.length === 0) return { ok: false as const, error: 'В дефектовке нет строк для проведения' };

  const partIds = [...new Set(normalizedInput.map((line) => line.partId))];
  const nomenclatureByPart = await resolvePartIdToNomenclatureMap(partIds);
  const mappedIds = [...new Set(nomenclatureByPart.values())];
  const existingNomenclature = mappedIds.length > 0
    ? await db.select({ id: erpNomenclature.id }).from(erpNomenclature).where(and(inArray(erpNomenclature.id, mappedIds as any), isNull(erpNomenclature.deletedAt)))
    : [];
  const existingNomenclatureIds = new Set(existingNomenclature.map((row) => String(row.id)));
  const unresolved = normalizedInput.filter((line) => {
    const nomenclatureId = nomenclatureByPart.get(line.partId);
    return !nomenclatureId || !existingNomenclatureIds.has(nomenclatureId);
  });
  if (unresolved.length > 0) {
    return { ok: false as const, error: `Не найдена номенклатура для строк: ${unresolved.map((line) => line.partLabel || line.partId).join(', ')}` };
  }
  const lines: ResolvedLine[] = normalizedInput.map((line) => ({
    ...line,
    nomenclatureId: nomenclatureByPart.get(line.partId)!,
  }));
  const duplicateSerials = new Set<string>();
  const seenSerials = new Set<string>();
  for (const line of lines) {
    if (!line.stampedNumber) continue;
    const key = `${line.nomenclatureId}:${normalizeDefectSerialNumber(line.stampedNumber)}`;
    if (seenSerials.has(key)) duplicateSerials.add(line.stampedNumber);
    seenSerials.add(key);
  }
  if (duplicateSerials.size > 0) return { ok: false as const, error: `Личный номер повторяется в дефектовке: ${[...duplicateSerials].join(', ')}` };

  const snapshot: Snapshot = { engineId, draftRevision, lines };
  const snapshotJson = canonicalSnapshot(snapshot);
  const snapshotHash = createHash('sha256').update(snapshotJson).digest('hex');
  const locations = await resolveWarehouseLocationIdsByCodes([WAREHOUSE_LOCATION_REPAIR_FUND, WAREHOUSE_LOCATION_SCRAP]);
  const repairLocationId = locations.get(WAREHOUSE_LOCATION_REPAIR_FUND);
  const scrapLocationId = locations.get(WAREHOUSE_LOCATION_SCRAP);
  if (!repairLocationId || !scrapLocationId) return { ok: false as const, error: 'Не настроены системные локации ремфонда и утиля' };

  try {
    const result = await db.transaction(async (tx) => {
      const repeated = await tx.select().from(defectConductedVersions).where(eq(defectConductedVersions.operationId, operationId)).limit(1);
      if (repeated[0]) {
        if (repeated[0].snapshotHash !== snapshotHash) throw new Error('operation ID уже использован для другого снимка дефектовки');
        return { versionRow: repeated[0], unchanged: true };
      }

      const activeRows = await tx
        .select()
        .from(defectConductedVersions)
        .where(and(eq(defectConductedVersions.engineId, engineId), eq(defectConductedVersions.status, 'active')))
        .orderBy(desc(defectConductedVersions.version))
        .limit(1)
        .for('update');
      const active = activeRows[0];
      if (active?.snapshotHash === snapshotHash) return { versionRow: active, unchanged: true };

      const targetQty = quantitiesByLocation(lines);
      let priorQty = new Map<string, number>();
      if (active) {
        const priorSnapshot = parseSnapshot(active.snapshotJson);
        if (!priorSnapshot) throw new Error('Предыдущая проведённая версия повреждена');
        priorQty = quantitiesByLocation(priorSnapshot.lines);
        const changedNomenclature = [...new Set([...targetQty.keys(), ...priorQty.keys()].map((key) => key.split(':')[0]!))];
        if (changedNomenclature.length > 0 && active.documentHeaderId) {
          const downstream = await tx
            .select({ id: erpRegStockMovements.id })
            .from(erpRegStockMovements)
            .where(and(
              eq(erpRegStockMovements.engineId, engineId),
              gt(erpRegStockMovements.performedAt, active.conductedAt),
              inArray(erpRegStockMovements.nomenclatureId, changedNomenclature as any),
              or(isNull(erpRegStockMovements.documentHeaderId), ne(erpRegStockMovements.documentHeaderId, active.documentHeaderId)),
            ))
            .limit(1);
          if (downstream[0]) throw new Error('Результат дефектовки уже использован последующим документом. Сначала оформите корректирующее складское движение.');
        }
      } else {
        const legacyRows = await tx
          .select({ operationType: operations.operationType, metaJson: operations.metaJson })
          .from(operations)
          .where(and(eq(operations.engineEntityId, engineId), inArray(operations.operationType, ['repair_fund_intake', 'scrap_intake']), isNull(operations.deletedAt)));
        priorQty = legacyIntakeQuantities(legacyRows);
      }

      const allKeys = [...new Set([...targetQty.keys(), ...priorQty.keys()])];
      const versionId = randomUUID();
      const documentId = randomUUID();
      const now = Date.now();
      const version = Number(active?.version ?? 0) + 1;
      const locationIdByCode = new Map<string, string>([
        [WAREHOUSE_LOCATION_REPAIR_FUND, repairLocationId],
        [WAREHOUSE_LOCATION_SCRAP, scrapLocationId],
      ]);
      const deltas = allKeys.map((key) => {
        const separator = key.lastIndexOf(':');
        return {
          nomenclatureId: key.slice(0, separator),
          locationCode: key.slice(separator + 1),
          qty: (targetQty.get(key) ?? 0) - (priorQty.get(key) ?? 0),
        };
      }).filter((item) => item.qty !== 0);

      for (const delta of deltas) {
        const locationId = locationIdByCode.get(delta.locationCode)!;
        await tx.insert(erpRegStockBalance).values({
          id: randomUUID(), nomenclatureId: delta.nomenclatureId, partCardId: null,
          warehouseLocationId: locationId, qty: 0, reservedQty: 0, updatedAt: now,
        }).onConflictDoNothing();
        const balances = await tx
          .select()
          .from(erpRegStockBalance)
          .where(and(eq(erpRegStockBalance.nomenclatureId, delta.nomenclatureId), eq(erpRegStockBalance.warehouseLocationId, locationId)))
          .limit(1)
          .for('update');
        const balance = balances[0];
        if (!balance) throw new Error('Не удалось заблокировать складской остаток');
        const nextQty = Number(balance.qty) + delta.qty;
        if (nextQty < Number(balance.reservedQty)) {
          throw new Error(`Перепроведение уменьшает остаток ниже зарезервированного: ${delta.nomenclatureId}`);
        }
        await tx.update(erpRegStockBalance).set({ qty: nextQty, updatedAt: now }).where(eq(erpRegStockBalance.id, balance.id));
      }

      const removedInstanceOperationIds: string[] = [];
      if (active) {
        const priorInstances = await tx
          .select({ id: defectPartInstances.id, reservedDocumentId: defectPartInstances.reservedDocumentId })
          .from(defectPartInstances)
          .where(eq(defectPartInstances.currentVersionId, active.id));
        if (priorInstances.some((item) => item.reservedDocumentId)) {
          throw new Error('Перепроведение заблокировано: номерной экземпляр уже зарезервирован сборочным нарядом');
        }
        removedInstanceOperationIds.push(...priorInstances.map((item) => String(item.id)));
        await tx.update(defectConductedVersions).set({ status: 'reversed', reversedAt: now }).where(eq(defectConductedVersions.id, active.id));
        await tx.update(defectPartInstances).set({ currentStatus: 'reversed', currentLocationId: null, updatedAt: now }).where(eq(defectPartInstances.currentVersionId, active.id));
        if (priorInstances.length > 0) {
          await tx.update(operations).set({ deletedAt: now, updatedAt: now }).where(inArray(operations.id, priorInstances.map((item) => item.id) as any));
        }
      }
      await tx.insert(erpDocumentHeaders).values({
        id: documentId, docType: 'engine_dismantling', docNo: `DEF-${engineId.slice(0, 8)}-${version}`,
        docDate: now, status: 'posted', authorId: null, departmentId: null, workshopId: null,
        payloadJson: JSON.stringify({ module: 'parts_movement_v1', engineId, defectConductedVersionId: versionId, snapshotHash }),
        createdAt: now, updatedAt: now, postedAt: now, deletedAt: null,
      });
      await tx.insert(defectConductedVersions).values({
        id: versionId, engineId, version, operationId, draftRevision, snapshotHash, snapshotJson,
        documentHeaderId: documentId, status: 'active', replacesVersionId: active?.id ?? null,
        conductedBy: args.actor.id, conductedAt: now, reversedAt: null,
      });
      const documentLines = lines.flatMap((line) => [
        ...(line.repairableQty > 0 ? [{ line, qty: line.repairableQty, locationCode: WAREHOUSE_LOCATION_REPAIR_FUND }] : []),
        ...(line.scrapQty > 0 ? [{ line, qty: line.scrapQty, locationCode: WAREHOUSE_LOCATION_SCRAP }] : []),
      ]);
      if (documentLines.length > 0) {
        await tx.insert(erpDocumentLines).values(documentLines.map((item, index) => ({
          id: randomUUID(), headerId: documentId, lineNo: index + 1, partCardId: null,
          nomenclatureId: item.line.nomenclatureId, qty: item.qty, price: null,
          payloadJson: JSON.stringify({ nomenclatureId: item.line.nomenclatureId, engineId, targetLocation: item.locationCode, sourceLineId: item.line.sourceLineId }),
          createdAt: now, updatedAt: now, deletedAt: null,
        })));
      }
      if (deltas.length > 0) {
        await tx.insert(erpRegStockMovements).values(deltas.map((delta) => ({
          id: randomUUID(), nomenclatureId: delta.nomenclatureId,
          warehouseLocationId: locationIdByCode.get(delta.locationCode)!, documentHeaderId: documentId,
          movementType: delta.qty > 0
            ? delta.locationCode === WAREHOUSE_LOCATION_SCRAP ? 'dismantle_scrap_in' : 'dismantle_in'
            : 'defect_reconduct_reversal',
          qty: Math.abs(delta.qty), direction: delta.qty > 0 ? 'in' : 'out', engineId,
          counterpartyId: null, reason: `Проведение дефектовки, версия ${version}`,
          performedAt: now, performedBy: args.actor.username, prevHash: null, selfHash: null, createdAt: now,
        })));
      }
      await tx.insert(erpJournalDocuments).values({
        id: randomUUID(), documentHeaderId: documentId, eventType: 'posted',
        eventPayloadJson: JSON.stringify({ by: args.actor.username, defectConductedVersionId: versionId }), eventAt: now,
      });

      const instanceOperationIds: string[] = [];
      for (const line of lines) {
        let instanceId: string | null = null;
        if (line.stampedNumber) {
          const serialNormalized = normalizeDefectSerialNumber(line.stampedNumber);
          const existingRows = await tx
            .select()
            .from(defectPartInstances)
            .where(and(eq(defectPartInstances.nomenclatureId, line.nomenclatureId), eq(defectPartInstances.serialNormalized, serialNormalized)))
            .limit(1)
            .for('update');
          const existing = existingRows[0];
          if (existing && String(existing.sourceEngineId) !== engineId) {
            throw new Error(`Личный номер «${line.stampedNumber}» уже принадлежит другой детали этой номенклатуры`);
          }
          if (existing?.reservedDocumentId) {
            throw new Error(`Личный номер «${line.stampedNumber}» уже зарезервирован сборочным нарядом`);
          }
          const state = initialStatus(line);
          instanceId = existing ? String(existing.id) : randomUUID();
          instanceOperationIds.push(instanceId);
          const locationId = state.locationCode ? locationIdByCode.get(state.locationCode)! : null;
          if (existing) {
            await tx.update(defectPartInstances).set({
              serialDisplay: line.stampedNumber, currentLocationId: locationId,
              currentStatus: state.status, currentVersionId: versionId, updatedAt: now,
            }).where(eq(defectPartInstances.id, existing.id));
          } else {
            await tx.insert(defectPartInstances).values({
              id: instanceId, nomenclatureId: line.nomenclatureId, serialNormalized,
              serialDisplay: line.stampedNumber, sourceEngineId: engineId, currentLocationId: locationId,
              currentStatus: state.status, currentVersionId: versionId, createdAt: now, updatedAt: now,
            });
          }
          const classification = line.scrapQty > 0 ? 'scrap' : line.replaceQty > 0 ? 'replace' : 'repairable';
          const instancePayload = {
            kind: 'repair_fund_instance', engineEntityId: engineId, nomenclatureId: line.nomenclatureId,
            partId: line.partId, partLabel: line.partLabel, stampedNumber: line.stampedNumber,
            classification, status: state.status === 'in_fund' ? 'in_fund' : state.status === 'scrapped' ? 'scrapped' : 'replaced',
            capturedAt: now, capturedBy: args.actor.username,
          };
          await tx.insert(operations).values({
            id: instanceId, engineEntityId: engineId, operationType: 'repair_fund_instance', status: 'event',
            note: `${line.partLabel || 'Деталь'} №${line.stampedNumber}`, performedAt: now, performedBy: args.actor.username,
            metaJson: JSON.stringify(instancePayload), createdAt: now, updatedAt: now, deletedAt: null, syncStatus: 'pending',
          }).onConflictDoUpdate({
            target: operations.id,
            set: { note: `${line.partLabel || 'Деталь'} №${line.stampedNumber}`, performedAt: now, performedBy: args.actor.username, metaJson: JSON.stringify(instancePayload), updatedAt: now, deletedAt: null, syncStatus: 'pending' },
          });
        }
        const specs = buildDefectInitialEvents(line);
        if (specs.length > 0) {
          await tx.insert(defectPartEvents).values(specs.map((spec) => ({
            id: randomUUID(), engineId, conductedVersionId: versionId, sourceLineId: line.sourceLineId,
            nomenclatureId: line.nomenclatureId, instanceId, eventType: spec.type, qty: spec.qty,
            payloadJson: JSON.stringify({
              partId: line.partId, partLabel: line.partLabel, stampedNumber: line.stampedNumber || null,
              replenishmentMethod: line.replenishmentMethod ?? null, defectDescription: line.defectDescription ?? '',
            }),
            occurredAt: now, occurredBy: args.actor.id,
          })));
        }
      }

      await tx.insert(operations).values({
        id: operationId, engineEntityId: engineId, operationType: 'defect_conducted', status: 'event',
        note: `Дефектовка проведена, версия ${version}`, performedAt: now, performedBy: args.actor.username,
        metaJson: JSON.stringify({ kind: 'defect_conducted', versionId, version, snapshotHash, documentId }),
        createdAt: now, updatedAt: now, deletedAt: null, syncStatus: 'pending',
      });
      return {
        versionRow: { id: versionId, engineId, version, operationId, draftRevision, snapshotHash, documentHeaderId: documentId, status: 'active', conductedAt: now, reversedAt: null },
        unchanged: false,
        instanceOperationIds: [...new Set([...removedInstanceOperationIds, ...instanceOperationIds])],
      };
    });

    if (!result.unchanged) {
      await emitOperationSyncChange(operationId, args.actor);
      if ('instanceOperationIds' in result) {
        for (const instanceOperationId of result.instanceOperationIds) {
          await emitOperationSyncChange(instanceOperationId, args.actor);
        }
      }
    }
    return { ok: true as const, unchanged: result.unchanged, version: result.versionRow };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listDefectConductedVersions(engineId: string) {
  const rows = await db.select().from(defectConductedVersions).where(eq(defectConductedVersions.engineId, engineId)).orderBy(desc(defectConductedVersions.version));
  return { ok: true as const, versions: rows.map((row) => ({
    id: String(row.id), engineId: String(row.engineId), version: Number(row.version), operationId: String(row.operationId),
    draftRevision: row.draftRevision, snapshotHash: row.snapshotHash, documentHeaderId: row.documentHeaderId ? String(row.documentHeaderId) : null,
    status: String(row.status) as 'active' | 'reversed', conductedAt: Number(row.conductedAt), reversedAt: row.reversedAt == null ? null : Number(row.reversedAt),
  })) };
}

export async function listDefectPartHistory(engineId: string) {
  const rows = await db.select().from(defectPartEvents).where(eq(defectPartEvents.engineId, engineId)).orderBy(desc(defectPartEvents.occurredAt));
  return { ok: true as const, events: rows.map((row) => {
    let payload: Record<string, unknown> | null = null;
    try { payload = row.payloadJson ? JSON.parse(row.payloadJson) : null; } catch { payload = null; }
    return {
      id: String(row.id), engineId: String(row.engineId), conductedVersionId: String(row.conductedVersionId), sourceLineId: row.sourceLineId,
      nomenclatureId: String(row.nomenclatureId), instanceId: row.instanceId ? String(row.instanceId) : null,
      eventType: String(row.eventType), qty: Number(row.qty), payload, occurredAt: Number(row.occurredAt), occurredBy: String(row.occurredBy),
    };
  }) };
}

export async function listAvailableDefectPartInstances(args: { nomenclatureIds: string[] }) {
  const nomenclatureIds = [...new Set(args.nomenclatureIds.map((id) => String(id).trim()).filter(Boolean))];
  if (nomenclatureIds.length === 0) return { ok: true as const, instances: [] };
  const rows = await db
    .select()
    .from(defectPartInstances)
    .where(
      and(
        inArray(defectPartInstances.nomenclatureId, nomenclatureIds),
        inArray(defectPartInstances.currentStatus, ['in_fund', 'repaired', 'returned_from_assembly']),
      ),
    )
    .orderBy(defectPartInstances.serialDisplay);
  return {
    ok: true as const,
    instances: rows.map((row) => ({
      id: String(row.id),
      nomenclatureId: String(row.nomenclatureId),
      serialDisplay: row.serialDisplay,
      sourceEngineId: String(row.sourceEngineId),
      currentLocationId: row.currentLocationId ? String(row.currentLocationId) : null,
      currentStatus: row.currentStatus,
      currentVersionId: String(row.currentVersionId),
      reservedDocumentId: row.reservedDocumentId ? String(row.reservedDocumentId) : null,
    })),
  };
}

export async function listIssuedDefectPartInstances(engineId: string) {
  const issuedEvents = await db
    .select({ instanceId: defectPartEvents.instanceId })
    .from(defectPartEvents)
    .where(and(eq(defectPartEvents.engineId, engineId), eq(defectPartEvents.eventType, 'issued_to_assembly')));
  const ids = [...new Set(issuedEvents.map((event) => String(event.instanceId ?? '')).filter(Boolean))];
  if (ids.length === 0) return { ok: true as const, instances: [] };
  const rows = await db
    .select()
    .from(defectPartInstances)
    .where(and(inArray(defectPartInstances.id, ids), eq(defectPartInstances.currentStatus, 'issued_to_assembly')))
    .orderBy(defectPartInstances.serialDisplay);
  return {
    ok: true as const,
    instances: rows.map((row) => ({
      id: String(row.id), nomenclatureId: String(row.nomenclatureId), serialDisplay: row.serialDisplay,
      sourceEngineId: String(row.sourceEngineId), currentLocationId: row.currentLocationId ? String(row.currentLocationId) : null,
      currentStatus: row.currentStatus, currentVersionId: String(row.currentVersionId),
      reservedDocumentId: row.reservedDocumentId ? String(row.reservedDocumentId) : null,
    })),
  };
}
