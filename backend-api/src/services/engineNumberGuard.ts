// Canonical engine uniqueness check: two engine numbers are "the same" iff
// normalizeLookupCompact() of both match (single normalizer shared with
// client-side search, see shared/src/domain/lookupNormalize.ts).
// Leaf module: imported by both adminMasterdataService (write gate) and
// engineDedupeService (merge pass) — keep it free of service imports.
import {
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  engineInternalNumberKey,
  isValidEngineInternalNumberYear,
  normalizeLookupCompact,
  type EngineInternalNumberDuplicate,
} from '@matricarmz/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';

export type EngineDuplicate = { id: string; engineNumber: string };

// Осознанные дубли номера (план reclamation-mvp-2026-07 Ф2): «повторный заезд» и
// «коллизия номера». Носители флага обходят запрет дублей и исключаются из склейки.
export const DEDUPE_EXEMPT_FLAG_CODES = ['repeat_arrival_flag', 'number_collision_flag'] as const;

function parseBoolAttr(valueJson: string | null | undefined): boolean {
  if (valueJson == null) return false;
  try {
    const parsed = JSON.parse(String(valueJson));
    return parsed === true || parsed === 'true' || parsed === 1;
  } catch {
    return String(valueJson).trim() === 'true';
  }
}

/** Ids живых двигателей с repeat_arrival_flag/number_collision_flag = true. */
export async function loadDedupeExemptEngineIds(): Promise<Set<string>> {
  const rows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .innerJoin(entities, eq(entities.id, attributeValues.entityId))
    .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
    .where(
      and(
        eq(entityTypes.code, 'engine'),
        inArray(attributeDefs.code, [...DEDUPE_EXEMPT_FLAG_CODES]),
        isNull(attributeDefs.deletedAt),
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
        isNull(entityTypes.deletedAt),
      ),
    )
    .limit(200_000);
  const out = new Set<string>();
  for (const r of rows) {
    if (parseBoolAttr(r.valueJson)) out.add(String(r.entityId));
  }
  return out;
}

/** У конкретного двигателя стоит флаг осознанного дубля (обход запрета номера). */
export async function engineHasDuplicateBypassFlag(entityId: string): Promise<boolean> {
  const rows = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .where(
      and(
        eq(attributeValues.entityId, entityId),
        inArray(attributeDefs.code, [...DEDUPE_EXEMPT_FLAG_CODES]),
        isNull(attributeDefs.deletedAt),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(10);
  return rows.some((r) => parseBoolAttr(r.valueJson));
}

function parseTextAttr(valueJson: string | null | undefined): string {
  if (valueJson == null) return '';
  try {
    const parsed = JSON.parse(String(valueJson));
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return String(valueJson).trim();
  }
}

/**
 * Значение скалярного атрибута как текст. Отдельно от parseTextAttr: год номера лежит
 * числом (dataType=number), а parseTextAttr отдаёт '' на всём, что не строка.
 */
function parseScalarAttr(valueJson: string | null | undefined): string {
  if (valueJson == null) return '';
  try {
    const parsed = JSON.parse(String(valueJson));
    if (typeof parsed === 'string') return parsed.trim();
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return String(parsed);
    return '';
  } catch {
    return String(valueJson).trim();
  }
}

/** Текущее значение атрибута двигателя (гейт пары дочитывает второй её элемент). */
async function readEngineAttrText(entityId: string, code: string): Promise<string> {
  const rows = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .where(
      and(
        eq(attributeValues.entityId, entityId),
        eq(attributeDefs.code, code),
        isNull(attributeDefs.deletedAt),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? parseScalarAttr(rows[0].valueJson) : '';
}

export async function readEngineInternalNumberValue(entityId: string): Promise<string> {
  return readEngineAttrText(entityId, ENGINE_INTERNAL_NUMBER_CODE);
}

export async function readEngineInternalNumberYear(entityId: string): Promise<number | null> {
  const raw = await readEngineAttrText(entityId, ENGINE_INTERNAL_NUMBER_YEAR_CODE);
  const year = Number(raw);
  return isValidEngineInternalNumberYear(year) ? year : null;
}

/**
 * Дубль внутреннего номера двигателя. Ключ — пара (номер, год): нумерация в журнале
 * дефектовки ежегодно сбрасывается, поэтому «41» уникален только внутри своего года.
 */
export async function findEngineInternalNumberDuplicate(
  internalNumber: string,
  internalNumberYear: unknown,
  excludeEntityId?: string,
): Promise<EngineInternalNumberDuplicate | null> {
  const key = engineInternalNumberKey(String(internalNumber ?? ''), internalNumberYear);
  if (!key) return null;

  const rows = await db
    .select({
      entityId: attributeValues.entityId,
      code: attributeDefs.code,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .innerJoin(entities, eq(entities.id, attributeValues.entityId))
    .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
    .where(
      and(
        eq(entityTypes.code, 'engine'),
        inArray(attributeDefs.code, [
          ENGINE_INTERNAL_NUMBER_CODE,
          ENGINE_INTERNAL_NUMBER_YEAR_CODE,
          'engine_number',
          'engine_brand',
        ]),
        isNull(attributeDefs.deletedAt),
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
        isNull(entityTypes.deletedAt),
      ),
    )
    .limit(200_000);

  const byEngine = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const id = String(r.entityId);
    if (excludeEntityId && id === excludeEntityId) continue;
    const value = parseScalarAttr(r.valueJson);
    if (!value) continue;
    const entry = byEngine.get(id) ?? {};
    entry[String(r.code)] = value;
    byEngine.set(id, entry);
  }

  for (const [id, entry] of byEngine) {
    const number = entry[ENGINE_INTERNAL_NUMBER_CODE] ?? '';
    const year = Number(entry[ENGINE_INTERNAL_NUMBER_YEAR_CODE] ?? NaN);
    if (!number || !isValidEngineInternalNumberYear(year)) continue;
    if (engineInternalNumberKey(number, year) !== key) continue;
    return {
      id,
      internalNumber: number,
      internalNumberYear: year,
      engineNumber: entry['engine_number'] ?? '',
      engineBrand: entry['engine_brand'] ?? '',
    };
  }
  return null;
}

export async function findEngineDuplicateByNumber(
  engineNumber: string,
  excludeEntityId?: string,
): Promise<EngineDuplicate | null> {
  const key = normalizeLookupCompact(String(engineNumber ?? ''));
  if (!key) return null;

  const rows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .innerJoin(entities, eq(entities.id, attributeValues.entityId))
    .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
    .where(
      and(
        eq(entityTypes.code, 'engine'),
        eq(attributeDefs.code, 'engine_number'),
        isNull(attributeDefs.deletedAt),
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
        isNull(entityTypes.deletedAt),
      ),
    )
    .limit(200_000);

  for (const r of rows) {
    const id = String(r.entityId);
    if (excludeEntityId && id === excludeEntityId) continue;
    const num = parseTextAttr(r.valueJson);
    if (num && normalizeLookupCompact(num) === key) return { id, engineNumber: num };
  }
  return null;
}
