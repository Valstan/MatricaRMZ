import { and, eq, inArray, isNull } from 'drizzle-orm';

import {
  SyncTableName,
  collectWorkOrderEntityReferences,
  collectWorkOrderUnresolvedTextIssues,
  type EntityReferenceTarget,
  type InvalidReferenceIssue,
} from '@matricarmz/shared';

import { db } from '../../database/db.js';
import {
  assemblyShortageApprovals,
  attributeDefs,
  attributeValues,
  defectConductedVersions,
  directoryParts,
  entities,
  entityTypes,
  erpNomenclature,
  operations,
} from '../../database/schema.js';
import type { SyncWriteInput } from './syncWriteService.js';

function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const SERVER_MANAGED_WORK_ORDER_FIELDS = [
  'repairIssued',
  'withdrawnAt',
  'withdrawnReason',
  'withdrawnAuto',
  'assemblyIssueState',
  'assemblyShortageApproval',
  'linkedDocumentId',
] as const;

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

type DefectOriginCandidate = {
  path: string;
  engineId: string;
  conductedVersionId: string;
  sourceLineIds: string[];
};

function readDefectOrigin(value: unknown, path: string): DefectOriginCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const engineId = String(raw.engineId ?? '').trim();
  const conductedVersionId = String(raw.conductedVersionId ?? '').trim();
  const sourceLineIds = Array.isArray(raw.sourceLineIds)
    ? [...new Set(raw.sourceLineIds.map((entry) => String(entry ?? '').trim()).filter(Boolean))]
    : [];
  if (!engineId && !conductedVersionId && sourceLineIds.length === 0) return null;
  return { path, engineId, conductedVersionId, sourceLineIds };
}

function changedDefectOrigins(
  incomingItems: unknown[],
  previousItems: unknown[],
  collectionPath: string,
): DefectOriginCandidate[] {
  const result: DefectOriginCandidate[] = [];
  for (const [index, rawItem] of incomingItems.entries()) {
    const item = rawItem && typeof rawItem === 'object' ? (rawItem as Record<string, unknown>) : {};
    const previousRaw = previousItems[index];
    const previousItem = previousRaw && typeof previousRaw === 'object' ? (previousRaw as Record<string, unknown>) : {};
    if (sameJsonValue(item.defectOrigin, previousItem.defectOrigin)) continue;
    const origin = readDefectOrigin(item.defectOrigin, `${collectionPath}[${index}].defectOrigin`);
    if (origin) result.push(origin);
  }
  return result;
}

async function validateDefectOrigins(origins: DefectOriginCandidate[]): Promise<void> {
  if (origins.length === 0) return;
  const malformed = origins.find(
    (origin) => !origin.engineId || !origin.conductedVersionId || origin.sourceLineIds.length === 0,
  );
  if (malformed) throw new Error(`invalid_defect_origin: ${malformed.path}: обязательны engineId, conductedVersionId и sourceLineIds`);

  const versionIds = [...new Set(origins.map((origin) => origin.conductedVersionId))];
  const rows = await db
    .select({
      id: defectConductedVersions.id,
      engineId: defectConductedVersions.engineId,
      status: defectConductedVersions.status,
      snapshotJson: defectConductedVersions.snapshotJson,
    })
    .from(defectConductedVersions)
    .where(inArray(defectConductedVersions.id, versionIds));
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const origin of origins) {
    const version = byId.get(origin.conductedVersionId);
    if (!version) throw new Error(`invalid_defect_origin: ${origin.path}.conductedVersionId: версия дефектовки не найдена`);
    if (String(version.engineId) !== origin.engineId) {
      throw new Error(`invalid_defect_origin: ${origin.path}.engineId: двигатель не соответствует версии дефектовки`);
    }
    if (String(version.status) !== 'active') {
      throw new Error(`invalid_defect_origin: ${origin.path}.conductedVersionId: версия дефектовки уже заменена`);
    }
    const snapshot = parsePayload(version.snapshotJson);
    const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
    const sourceIds = new Set(
      lines
        .map((line) => (line && typeof line === 'object' ? String((line as Record<string, unknown>).sourceLineId ?? '').trim() : ''))
        .filter(Boolean),
    );
    const missingSource = origin.sourceLineIds.find((sourceLineId) => !sourceIds.has(sourceLineId));
    if (missingSource) {
      throw new Error(`invalid_defect_origin: ${origin.path}.sourceLineIds: строка ${missingSource} отсутствует в проведённой версии`);
    }
  }
}

export async function enforceEntityReferenceIntegrity(inputs: SyncWriteInput[]): Promise<void> {
  const workOrderCandidates = inputs.filter((input) => {
    const row = input.row as Record<string, unknown> | undefined;
    return input.table === SyncTableName.Operations && row && String(row.operation_type ?? '') === 'work_order';
  });
  const supplyRequestCandidates = inputs.filter((input) => {
    const row = input.row as Record<string, unknown> | undefined;
    return input.table === SyncTableName.Operations && row && String(row.operation_type ?? '') === 'supply_request';
  });
  const attributeValueCandidates = inputs.filter((input) => input.table === SyncTableName.AttributeValues && input.row);
  if (workOrderCandidates.length === 0 && supplyRequestCandidates.length === 0 && attributeValueCandidates.length === 0) return;

  const issues: InvalidReferenceIssue[] = [];
  const changedReferences: ReturnType<typeof collectWorkOrderEntityReferences> = [];
  const defectOrigins: DefectOriginCandidate[] = [];
  for (const input of workOrderCandidates) {
    const row = input.row as Record<string, unknown>;
    const rowId = String(row.id ?? input.row_id ?? '');
    const incoming = parsePayload(row.meta_json);
    if (!incoming) continue;
    const storedRows = rowId
      ? await db.select({ metaJson: operations.metaJson }).from(operations).where(eq(operations.id, rowId)).limit(1)
      : [];
    const previous = parsePayload(storedRows[0]?.metaJson);
    if (previous) {
      const changedServerField = SERVER_MANAGED_WORK_ORDER_FIELDS.find((field) => !sameJsonValue(incoming[field], previous[field]));
      if (changedServerField) throw new Error(`server_managed_field: ${changedServerField}`);
      if (previous.repairIssued === true && !sameJsonValue(incoming.assemblyMaterialHash, previous.assemblyMaterialHash)) {
        throw new Error('server_managed_field: assemblyMaterialHash');
      }
      if (!sameJsonValue(incoming.assemblyMaterialHash, previous.assemblyMaterialHash)) {
        await db
          .update(assemblyShortageApprovals)
          .set({ status: 'invalidated', invalidatedAt: Date.now() })
          .where(
            and(
              eq(assemblyShortageApprovals.operationId, rowId),
              inArray(assemblyShortageApprovals.status, ['requested', 'approved']),
            ),
          );
      }
    }
    issues.push(...collectWorkOrderUnresolvedTextIssues(incoming, previous));
    defectOrigins.push(
      ...changedDefectOrigins(
        Array.isArray(incoming.freeWorks) ? incoming.freeWorks : [],
        Array.isArray(previous?.freeWorks) ? previous.freeWorks : [],
        'freeWorks',
      ),
    );
    const previousByPath = new Map(
      collectWorkOrderEntityReferences(previous ?? {}).map((reference) => [reference.path, reference]),
    );
    for (const reference of collectWorkOrderEntityReferences(incoming)) {
      const before = previousByPath.get(reference.path);
      if (!before || before.referenceId !== reference.referenceId || before.expectedType !== reference.expectedType) {
        changedReferences.push(reference);
      }
    }
  }


  for (const input of supplyRequestCandidates) {
    const row = input.row as Record<string, unknown>;
    const rowId = String(row.id ?? input.row_id ?? '');
    const incoming = parsePayload(row.meta_json);
    if (!incoming) continue;
    const storedRows = rowId
      ? await db.select({ metaJson: operations.metaJson }).from(operations).where(eq(operations.id, rowId)).limit(1)
      : [];
    const previous = parsePayload(storedRows[0]?.metaJson);

    const incomingItems = Array.isArray(incoming.items) ? incoming.items : [];
    const previousItems = Array.isArray(previous?.items) ? previous.items : [];
    defectOrigins.push(...changedDefectOrigins(incomingItems, previousItems, 'items'));
    const changedProductIds: Array<{ path: string; id: string }> = [];
    for (const [index, rawItem] of incomingItems.entries()) {
      const item = rawItem && typeof rawItem === 'object' ? (rawItem as Record<string, unknown>) : {};
      const previousRaw = previousItems[index];
      const previousItem = previousRaw && typeof previousRaw === 'object' ? (previousRaw as Record<string, unknown>) : {};
      const id = String(item.productId ?? '').trim();
      const name = String(item.name ?? '').trim();
      if (!id && name) {
        const unchangedLegacy =
          !String(previousItem.productId ?? '').trim() && String(previousItem.name ?? '').trim() === name;
        if (!unchangedLegacy) {
          issues.push({
            path: `items[${index}].productId`,
            expectedType: 'nomenclature',
            referenceId: null,
            reason: 'unresolved_text',
          });
        }
      }
      if (id && id !== String(previousItem.productId ?? '').trim()) {
        changedProductIds.push({ path: `items[${index}].productId`, id });
      }
    }

    const headerReferences = [
      { path: 'departmentId', expectedType: 'department' as const, id: String(incoming.departmentId ?? '').trim() },
      { path: 'workshopId', expectedType: 'workshop' as const, id: String(incoming.workshopId ?? '').trim() },
      { path: 'sectionId', expectedType: 'section' as const, id: String(incoming.sectionId ?? '').trim() },
    ];
    for (const reference of headerReferences) {
      if (!reference.id || reference.id === String(previous?.[reference.path] ?? '').trim()) continue;
      changedReferences.push({
        path: reference.path,
        expectedType: reference.expectedType,
        referenceId: reference.id,
      });
    }

    if (changedProductIds.length > 0) {
      const ids = [...new Set(changedProductIds.map((reference) => reference.id))];
      const [nomenclatureRows, entityRows] = await Promise.all([
        db
          .select({ id: erpNomenclature.id })
          .from(erpNomenclature)
          .where(and(inArray(erpNomenclature.id, ids), isNull(erpNomenclature.deletedAt))),
        db
          .select({ id: entities.id, typeCode: entityTypes.code })
          .from(entities)
          .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
          .where(and(inArray(entities.id, ids), isNull(entities.deletedAt), isNull(entityTypes.deletedAt))),
      ]);
      const validIds = new Set(nomenclatureRows.map((entry) => String(entry.id)));
      for (const entry of entityRows) {
        if (['nomenclature', 'part', 'product', 'service'].includes(String(entry.typeCode))) validIds.add(String(entry.id));
      }
      for (const reference of changedProductIds) {
        if (!validIds.has(reference.id)) {
          issues.push({
            path: reference.path,
            expectedType: 'nomenclature',
            referenceId: reference.id,
            reason: 'not_found',
          });
        }
      }
    }
  }

  for (const input of attributeValueCandidates) {
    const row = input.row as Record<string, unknown>;
    const rowId = String(row.id ?? input.row_id ?? '');
    const valueJson = typeof row.value_json === 'string' ? row.value_json : 'null';
    const storedRows = rowId
      ? await db.select({ valueJson: attributeValues.valueJson }).from(attributeValues).where(eq(attributeValues.id, rowId)).limit(1)
      : [];
    if (String(storedRows[0]?.valueJson ?? 'null') === valueJson) continue;

    const defId = String(row.attribute_def_id ?? '').trim();
    if (!defId) continue;
    const defs = await db.select().from(attributeDefs).where(and(eq(attributeDefs.id, defId), isNull(attributeDefs.deletedAt))).limit(1);
    const def = defs[0];
    if (!def || String(def.dataType) !== 'link') continue;
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(valueJson);
    } catch {
      issues.push({
        path: `attribute_values.${rowId}.value_json`,
        expectedType: 'nomenclature',
        referenceId: null,
        reason: 'unresolved_text',
      });
      continue;
    }
    const ids = (Array.isArray(rawValue) ? rawValue : [rawValue])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
    if (ids.length === 0) continue;
    const meta = parsePayload(def.metaJson);
    const expectedType = String(meta?.linkTargetTypeCode ?? '').trim() as EntityReferenceTarget;
    const rows = await db
      .select({ id: entities.id, typeCode: entityTypes.code })
      .from(entities)
      .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
      .where(and(inArray(entities.id, [...new Set(ids)]), isNull(entities.deletedAt), isNull(entityTypes.deletedAt)));
    const typeById = new Map(rows.map((entry) => [String(entry.id), String(entry.typeCode)]));
    for (const id of ids) {
      const actualType = typeById.get(id);
      if (!actualType) {
        issues.push({
          path: `attribute_values.${rowId}.value_json`,
          expectedType: expectedType || 'nomenclature',
          referenceId: id,
          reason: 'not_found',
        });
      } else if (expectedType && actualType !== expectedType) {
        issues.push({
          path: `attribute_values.${rowId}.value_json`,
          expectedType,
          referenceId: id,
          reason: 'wrong_type',
        });
      }
    }
  }

  if (changedReferences.length > 0) {
    const ids = [...new Set(changedReferences.map((reference) => reference.referenceId))];
    // Каталожные ссылки (деталь/номенклатура/изделие/услуга) резолвятся в erp_nomenclature /
    // directory_parts, а НЕ в entities: детали мигрировали из EAV в directory_parts. Раньше гард
    // искал ВСЕ ссылки только в entities → любой partId в наряде падал 'not_found' (регресс #319,
    // блокировал сохранение сборочных нарядов). Заявки уже резолвили productId так же (см. выше).
    const [entityRows, nomenRows, partRows] = await Promise.all([
      db
        .select({ id: entities.id, typeCode: entityTypes.code })
        .from(entities)
        .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
        .where(and(inArray(entities.id, ids), isNull(entities.deletedAt), isNull(entityTypes.deletedAt))),
      db.select({ id: erpNomenclature.id }).from(erpNomenclature).where(and(inArray(erpNomenclature.id, ids), isNull(erpNomenclature.deletedAt))),
      db.select({ id: directoryParts.id }).from(directoryParts).where(and(inArray(directoryParts.id, ids), isNull(directoryParts.deletedAt))),
    ]);
    const typeById = new Map(entityRows.map((row) => [String(row.id), String(row.typeCode)]));
    const CATALOG_TYPES = new Set<EntityReferenceTarget>(['part', 'nomenclature', 'product', 'service']);
    const catalogIds = new Set<string>([...nomenRows, ...partRows].map((r) => String(r.id)));
    for (const entry of entityRows) if (CATALOG_TYPES.has(String(entry.typeCode) as EntityReferenceTarget)) catalogIds.add(String(entry.id));
    for (const reference of changedReferences) {
      if (CATALOG_TYPES.has(reference.expectedType)) {
        if (!catalogIds.has(reference.referenceId)) {
          issues.push({ path: reference.path, expectedType: reference.expectedType, referenceId: reference.referenceId, reason: 'not_found' });
        }
        continue;
      }
      const actualType = typeById.get(reference.referenceId);
      if (!actualType) {
        issues.push({
          path: reference.path,
          expectedType: reference.expectedType,
          referenceId: reference.referenceId,
          reason: 'not_found',
        });
      } else if (actualType !== reference.expectedType) {
        issues.push({
          path: reference.path,
          expectedType: reference.expectedType,
          referenceId: reference.referenceId,
          reason: 'wrong_type',
        });
      }
    }
  }

  await validateDefectOrigins(defectOrigins);

  if (issues.length > 0) throw new Error(`invalid_reference: ${JSON.stringify(issues)}`);
}
