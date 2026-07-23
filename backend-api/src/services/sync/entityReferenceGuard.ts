import { and, eq, inArray, isNull } from 'drizzle-orm';

import {
  SyncTableName,
  collectWorkOrderEntityReferences,
  collectWorkOrderUnresolvedTextIssues,
  type EntityReferenceTarget,
  type InvalidReferenceIssue,
} from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes, erpNomenclature, operations } from '../../database/schema.js';
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
  for (const input of workOrderCandidates) {
    const row = input.row as Record<string, unknown>;
    const rowId = String(row.id ?? input.row_id ?? '');
    const incoming = parsePayload(row.meta_json);
    if (!incoming) continue;
    const storedRows = rowId
      ? await db.select({ metaJson: operations.metaJson }).from(operations).where(eq(operations.id, rowId)).limit(1)
      : [];
    const previous = parsePayload(storedRows[0]?.metaJson);
    issues.push(...collectWorkOrderUnresolvedTextIssues(incoming, previous));
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
    const rows = await db
      .select({ id: entities.id, typeCode: entityTypes.code })
      .from(entities)
      .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
      .where(and(inArray(entities.id, ids), isNull(entities.deletedAt), isNull(entityTypes.deletedAt)));
    const typeById = new Map(rows.map((row) => [String(row.id), String(row.typeCode)]));
    for (const reference of changedReferences) {
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

  if (issues.length > 0) throw new Error(`invalid_reference: ${JSON.stringify(issues)}`);
}
