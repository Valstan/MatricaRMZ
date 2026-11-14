// Точный поиск двигателя по номеру для модуля «Поиск по файлам».
//
// Модуль ищет номер двигателя в файлах оператора и показывает справа карточку
// из нашей базы. Совпадение должно быть ТОЧНЫМ: план промта прямо запрещает
// «похожее на глаз» (эвристика). Поэтому здесь нет `similar` — только
// канон-ключ документного номера и пара внутреннего клейма.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  formatEngineInternalNumber,
  formatEngineRmzNumber,
  normalizeEngineInternalNumber,
  parseEngineInternalNumberInput,
} from '@matricarmz/shared';

import { attributeDefs, attributeValues, entities } from '../database/schema.js';
import { findEngineDuplicateByNumber, getEngineAttrDefs, getEngineDetails } from './engineService.js';

export type EngineExactLookup = {
  id: string;
  engineNumber: string;
  internalNumberFull: string;
  rmzCode: string;
  matchedBy: 'engine_number' | 'internal_number';
};

export type EngineExactLookupResult = {
  engine: EngineExactLookup | null;
  /** Пояснение оператору, когда точного совпадения нет. */
  note: string | null;
};

export type EngineCharacteristicDef = {
  code: string;
  name: string;
  dataType: string | null;
  sortOrder: number;
};

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Все двигатели с внутренним номером (год — если задан). */
async function findByInternalNumber(
  db: BetterSQLite3Database,
  number: string,
  year: number | null,
): Promise<string[]> {
  const wanted = normalizeEngineInternalNumber(number);
  if (!wanted) return [];
  const defs = await getEngineAttrDefs(db);
  const numberDefId = defs[ENGINE_INTERNAL_NUMBER_CODE];
  const yearDefId = defs[ENGINE_INTERNAL_NUMBER_YEAR_CODE];
  if (!numberDefId || !yearDefId) return [];

  const rows = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .innerJoin(entities, eq(entities.id, attributeValues.entityId))
    .where(
      and(
        inArray(attributeValues.attributeDefId, [numberDefId, yearDefId]),
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
      ),
    );

  const byEngine = new Map<string, { number?: string; year?: number }>();
  for (const row of rows) {
    const id = String(row.entityId);
    const parsed = safeJsonParse(String(row.valueJson ?? ''));
    const text = typeof parsed === 'string' || typeof parsed === 'number' ? String(parsed).trim() : '';
    if (!text) continue;
    const entry = byEngine.get(id) ?? {};
    if (String(row.attributeDefId) === numberDefId) entry.number = text;
    else entry.year = Number(text);
    byEngine.set(id, entry);
  }

  const out: string[] = [];
  for (const [id, entry] of byEngine) {
    if (!entry.number) continue;
    if (normalizeEngineInternalNumber(entry.number) !== wanted) continue;
    if (year != null && Number(entry.year) !== year) continue;
    out.push(id);
  }
  return out;
}

async function describeEngine(
  db: BetterSQLite3Database,
  id: string,
  matchedBy: EngineExactLookup['matchedBy'],
): Promise<EngineExactLookup> {
  const details = await getEngineDetails(db, id);
  const attrs = details.attributes ?? {};
  return {
    id,
    engineNumber: String(attrs.engine_number ?? '').trim(),
    internalNumberFull: formatEngineInternalNumber(
      String(attrs[ENGINE_INTERNAL_NUMBER_CODE] ?? ''),
      attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE] as number | undefined,
    ),
    rmzCode: details.rmzSeq != null ? formatEngineRmzNumber(details.rmzSeq) : '',
    matchedBy,
  };
}

/**
 * Ищет двигатель по номеру из строки поиска. Сначала — документный номер
 * (канон-ключ), потом — внутренний клеймо «41/26». Неоднозначность (номер без
 * года у нескольких двигателей) — не «нашли», а объяснение оператору.
 */
export async function findEngineByExactNumber(
  db: BetterSQLite3Database,
  rawQuery: string,
): Promise<EngineExactLookupResult> {
  const query = String(rawQuery ?? '').trim();
  if (!query) return { engine: null, note: null };

  const byNumber = await findEngineDuplicateByNumber(db, query);
  if (byNumber) {
    return { engine: await describeEngine(db, byNumber.id, 'engine_number'), note: null };
  }

  const parsed = parseEngineInternalNumberInput(query);
  const candidates = await findByInternalNumber(db, parsed.number, parsed.year);
  const [only] = candidates;
  if (candidates.length === 1 && only) {
    return { engine: await describeEngine(db, only, 'internal_number'), note: null };
  }
  if (candidates.length > 1) {
    return {
      engine: null,
      note: `По номеру «${query}» в базе ${candidates.length} двигателя — уточните номер с годом, например «41/26»`,
    };
  }
  return { engine: null, note: null };
}

/**
 * Известные характеристики двигателя — по дефам «Двигатель» из базы: статического
 * каталога в коде нет, а список в проде может отличаться от кода.
 */
export async function listEngineCharacteristicDefs(
  db: BetterSQLite3Database,
): Promise<EngineCharacteristicDef[]> {
  const defs = await getEngineAttrDefs(db);
  const ids = Object.values(defs);
  if (ids.length === 0) return [];
  const rows = await db.select().from(attributeDefs).where(inArray(attributeDefs.id, ids));
  const byId = new Map(Object.entries(defs).map(([code, id]) => [id, code]));
  return rows
    .map((row) => ({
      code: byId.get(String(row.id)) ?? String(row.code),
      name: String(row.name ?? row.code ?? ''),
      dataType: row.dataType != null ? String(row.dataType) : null,
      sortOrder: Number(row.sortOrder ?? 0),
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'));
}
