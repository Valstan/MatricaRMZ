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
  directoryWorkshops,
  entities,
  entityTypes,
  erpNomenclature,
  operations,
} from '../../database/schema.js';
import { logWarn } from '../../utils/logger.js';
import type { SyncSkippedRow } from './applyPushBatch.js';
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

/** Ошибки defect-origin для ОДНОГО input'а (не роняют батч — см. partition ниже). */
async function collectDefectOriginIssues(origins: DefectOriginCandidate[]): Promise<string[]> {
  if (origins.length === 0) return [];
  const issues: string[] = [];
  const malformed = origins.find(
    (origin) => !origin.engineId || !origin.conductedVersionId || origin.sourceLineIds.length === 0,
  );
  if (malformed) {
    return [`invalid_defect_origin: ${malformed.path}: обязательны engineId, conductedVersionId и sourceLineIds`];
  }

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
    if (!version) {
      issues.push(`invalid_defect_origin: ${origin.path}.conductedVersionId: версия дефектовки не найдена`);
      continue;
    }
    if (String(version.engineId) !== origin.engineId) {
      issues.push(`invalid_defect_origin: ${origin.path}.engineId: двигатель не соответствует версии дефектовки`);
      continue;
    }
    if (String(version.status) !== 'active') {
      issues.push(`invalid_defect_origin: ${origin.path}.conductedVersionId: версия дефектовки уже заменена`);
      continue;
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
      issues.push(`invalid_defect_origin: ${origin.path}.sourceLineIds: строка ${missingSource} отсутствует в проведённой версии`);
    }
  }
  return issues;
}

const CATALOG_TYPES = new Set<EntityReferenceTarget>(['part', 'nomenclature', 'product', 'service']);

type ReferenceResolver = {
  /** true, если ссылка (id, expectedType) валидна. */
  ok(id: string, expectedType: EntityReferenceTarget | ''): boolean;
  reason(id: string, expectedType: EntityReferenceTarget | ''): 'not_found' | 'wrong_type';
};

/**
 * Единый резолвер ссылок батча. Каталожные типы (деталь/номенклатура/изделие/услуга)
 * живут в erp_nomenclature / directory_parts, а НЕ только в entities (регресс #319).
 * ЦЕХ мигрировал из EAV в directory_workshops ЦЕЛИКОМ (в entities цехов 0) — резолв
 * только по entities давал ложный not_found и заваливал весь push машины (инцидент
 * Я01АТ7829: одна ссылка на «Цех №1» заперла двигатель, его атрибуты и наряды).
 */
async function buildReferenceResolver(ids: string[]): Promise<ReferenceResolver> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) {
    return { ok: () => true, reason: () => 'not_found' };
  }
  const [entityRows, nomenRows, partRows, workshopRows] = await Promise.all([
    db
      .select({ id: entities.id, typeCode: entityTypes.code })
      .from(entities)
      .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
      .where(and(inArray(entities.id, unique), isNull(entities.deletedAt), isNull(entityTypes.deletedAt))),
    db.select({ id: erpNomenclature.id }).from(erpNomenclature).where(and(inArray(erpNomenclature.id, unique), isNull(erpNomenclature.deletedAt))),
    db.select({ id: directoryParts.id }).from(directoryParts).where(and(inArray(directoryParts.id, unique), isNull(directoryParts.deletedAt))),
    db.select({ id: directoryWorkshops.id }).from(directoryWorkshops).where(and(inArray(directoryWorkshops.id, unique), isNull(directoryWorkshops.deletedAt))),
  ]);
  const typeById = new Map(entityRows.map((row) => [String(row.id), String(row.typeCode)]));
  const catalogIds = new Set<string>([...nomenRows, ...partRows].map((r) => String(r.id)));
  for (const entry of entityRows) {
    if (CATALOG_TYPES.has(String(entry.typeCode) as EntityReferenceTarget)) catalogIds.add(String(entry.id));
  }
  const workshopIds = new Set<string>(workshopRows.map((r) => String(r.id)));

  const ok = (id: string, expectedType: EntityReferenceTarget | ''): boolean => {
    if (!expectedType) return typeById.has(id) || catalogIds.has(id) || workshopIds.has(id);
    if (CATALOG_TYPES.has(expectedType)) return catalogIds.has(id);
    if (expectedType === 'workshop') return workshopIds.has(id) || typeById.get(id) === 'workshop';
    return typeById.get(id) === expectedType;
  };
  const reason = (id: string, _expectedType: EntityReferenceTarget | ''): 'not_found' | 'wrong_type' =>
    typeById.has(id) || catalogIds.has(id) || workshopIds.has(id) ? 'wrong_type' : 'not_found';
  return { ok, reason };
}

function issueReason(issue: InvalidReferenceIssue): string {
  return `invalid_reference: ${JSON.stringify([issue])}`;
}

/**
 * Ссылочная целостность ledger-батча (per-row).
 *
 * Раньше любая невалидная ссылка кидала throw и валила ВЕСЬ submit (HTTP 400):
 * одна отравленная строка в очереди клиента навсегда блокировала push всей машины —
 * ни одна другая запись (включая совершенно чужие ей сущности) не доезжала до
 * сервера, а оператор ничего не видел. Теперь провинившаяся строка уходит в
 * denied (как в authz-гейте), остальной батч живёт. Клиент держит denied-строки
 * pending и ретраит — если ссылка дозреет (сущность доедет позже), строка уедет сама.
 */
export async function partitionByReferenceIntegrity(
  inputs: SyncWriteInput[],
): Promise<{ allowed: SyncWriteInput[]; denied: SyncSkippedRow[] }> {
  const deniedByInput = new Map<SyncWriteInput, string>();
  const deny = (input: SyncWriteInput, reason: string) => {
    if (!deniedByInput.has(input)) deniedByInput.set(input, reason);
  };

  const workOrderCandidates = inputs.filter((input) => {
    const row = input.row as Record<string, unknown> | undefined;
    return input.table === SyncTableName.Operations && row && String(row.operation_type ?? '') === 'work_order';
  });
  const supplyRequestCandidates = inputs.filter((input) => {
    const row = input.row as Record<string, unknown> | undefined;
    return input.table === SyncTableName.Operations && row && String(row.operation_type ?? '') === 'supply_request';
  });
  const attributeValueCandidates = inputs.filter((input) => input.table === SyncTableName.AttributeValues && input.row);
  if (workOrderCandidates.length === 0 && supplyRequestCandidates.length === 0 && attributeValueCandidates.length === 0) {
    return { allowed: inputs, denied: [] };
  }

  type ChangedReference = { input: SyncWriteInput; path: string; expectedType: EntityReferenceTarget; referenceId: string };
  const changedReferences: ChangedReference[] = [];
  // Отложенная инвалидация shortage-approvals: только для строк, которые в итоге прошли.
  const shortageInvalidation: string[] = [];

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
      if (changedServerField) {
        deny(input, `server_managed_field: ${changedServerField}`);
        continue;
      }
      if (previous.repairIssued === true && !sameJsonValue(incoming.assemblyMaterialHash, previous.assemblyMaterialHash)) {
        deny(input, 'server_managed_field: assemblyMaterialHash');
        continue;
      }
      if (!sameJsonValue(incoming.assemblyMaterialHash, previous.assemblyMaterialHash)) {
        shortageInvalidation.push(rowId);
      }
    }
    const textIssues = collectWorkOrderUnresolvedTextIssues(incoming, previous);
    if (textIssues.length > 0) {
      deny(input, issueReason(textIssues[0]!));
      continue;
    }
    const originIssues = await collectDefectOriginIssues(
      changedDefectOrigins(
        Array.isArray(incoming.freeWorks) ? incoming.freeWorks : [],
        Array.isArray(previous?.freeWorks) ? previous.freeWorks : [],
        'freeWorks',
      ),
    );
    if (originIssues.length > 0) {
      deny(input, originIssues[0]!);
      continue;
    }
    const previousByPath = new Map(
      collectWorkOrderEntityReferences(previous ?? {}).map((reference) => [reference.path, reference]),
    );
    for (const reference of collectWorkOrderEntityReferences(incoming)) {
      const before = previousByPath.get(reference.path);
      if (!before || before.referenceId !== reference.referenceId || before.expectedType !== reference.expectedType) {
        changedReferences.push({ input, ...reference });
      }
    }
  }

  for (const input of supplyRequestCandidates) {
    if (deniedByInput.has(input)) continue;
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
    const originIssues = await collectDefectOriginIssues(changedDefectOrigins(incomingItems, previousItems, 'items'));
    if (originIssues.length > 0) {
      deny(input, originIssues[0]!);
      continue;
    }
    let deniedHere = false;
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
          deny(input, issueReason({ path: `items[${index}].productId`, expectedType: 'nomenclature', referenceId: null, reason: 'unresolved_text' }));
          deniedHere = true;
          break;
        }
      }
      if (id && id !== String(previousItem.productId ?? '').trim()) {
        changedReferences.push({ input, path: `items[${index}].productId`, expectedType: 'nomenclature', referenceId: id });
      }
    }
    if (deniedHere) continue;

    const headerReferences = [
      { path: 'departmentId', expectedType: 'department' as const, id: String(incoming.departmentId ?? '').trim() },
      { path: 'workshopId', expectedType: 'workshop' as const, id: String(incoming.workshopId ?? '').trim() },
      { path: 'sectionId', expectedType: 'section' as const, id: String(incoming.sectionId ?? '').trim() },
    ];
    for (const reference of headerReferences) {
      if (!reference.id || reference.id === String(previous?.[reference.path] ?? '').trim()) continue;
      changedReferences.push({ input, path: reference.path, expectedType: reference.expectedType, referenceId: reference.id });
    }
  }

  type LinkCheck = { input: SyncWriteInput; path: string; expectedType: EntityReferenceTarget | ''; id: string };
  const linkChecks: LinkCheck[] = [];
  for (const input of attributeValueCandidates) {
    if (deniedByInput.has(input)) continue;
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
      deny(input, issueReason({ path: `attribute_values.${rowId}.value_json`, expectedType: 'nomenclature', referenceId: null, reason: 'unresolved_text' }));
      continue;
    }
    const ids = (Array.isArray(rawValue) ? rawValue : [rawValue])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
    if (ids.length === 0) continue;
    const meta = parsePayload(def.metaJson);
    const expectedType = String(meta?.linkTargetTypeCode ?? '').trim() as EntityReferenceTarget | '';
    for (const id of ids) {
      linkChecks.push({ input, path: `attribute_values.${rowId}.value_json`, expectedType, id });
    }
  }

  const resolver = await buildReferenceResolver([
    ...changedReferences.map((r) => r.referenceId),
    ...linkChecks.map((c) => c.id),
  ]);

  for (const reference of changedReferences) {
    if (deniedByInput.has(reference.input)) continue;
    if (!resolver.ok(reference.referenceId, reference.expectedType)) {
      deny(
        reference.input,
        issueReason({
          path: reference.path,
          expectedType: reference.expectedType,
          referenceId: reference.referenceId,
          reason: resolver.reason(reference.referenceId, reference.expectedType),
        }),
      );
    }
  }
  for (const check of linkChecks) {
    if (deniedByInput.has(check.input)) continue;
    if (!resolver.ok(check.id, check.expectedType)) {
      deny(
        check.input,
        issueReason({
          path: check.path,
          expectedType: check.expectedType || 'nomenclature',
          referenceId: check.id,
          reason: resolver.reason(check.id, check.expectedType),
        }),
      );
    }
  }

  const allowed = inputs.filter((input) => !deniedByInput.has(input));
  const allowedIds = new Set(allowed.map((input) => String((input.row as Record<string, unknown> | undefined)?.id ?? input.row_id ?? '')));
  const invalidateIds = shortageInvalidation.filter((id) => allowedIds.has(id));
  if (invalidateIds.length > 0) {
    await db
      .update(assemblyShortageApprovals)
      .set({ status: 'invalidated', invalidatedAt: Date.now() })
      .where(
        and(
          inArray(assemblyShortageApprovals.operationId, invalidateIds),
          inArray(assemblyShortageApprovals.status, ['requested', 'approved']),
        ),
      );
  }

  const denied: SyncSkippedRow[] = [...deniedByInput.entries()].map(([input, reason]) => ({
    table: input.table,
    row_id: String((input.row as Record<string, unknown> | undefined)?.id ?? input.row_id ?? ''),
    reason,
  }));
  if (denied.length > 0) {
    logWarn('sync reference rows skipped', {
      count: denied.length,
      sample: denied.slice(0, 3).map((d) => `${d.table}:${d.row_id}:${d.reason.slice(0, 120)}`),
    });
  }
  return { allowed, denied };
}
