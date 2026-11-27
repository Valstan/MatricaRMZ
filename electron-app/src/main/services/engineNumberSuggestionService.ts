// Подсказки номера двигателя по неполному номеру (промт КАРМАНА #155).
//
// Оператор в строке поиска набирает последние цифры номера («0889» из «Э06АТ0889»)
// и ждёт полный номер из базы — как в списке двигателей.
//
// Источник подсказок — ЛОКАЛЬНАЯ реплика карточек двигателей на этой машине.
// Почему не список двигателей в renderer: список тяжёлый (на планшете и на
// большой базе это лишняя память), а здесь нужен точечный запрос с лимитом.
// Почему не «по набитому номеру на детали» (как в глобальном поиске): это другое
// поле (`stamped_number` в операциях), номером двигателя оно не является.
//
// Номер двигателя лежит в двух местах, и оба читаются:
//   * легаси-EAV — `attribute_values` с кодом `engine_number` (старые карточки);
//   * строгая реплика `erp_engine_cards` (новые карточки пишутся туда, E3b).
// Побеждает более свежая запись — так же, как в `mergeStrictCardAttrs`.

import { and, eq, isNull, like } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  FILE_SEARCH_ENGINE_SUGGEST_LIMIT,
  FILE_SEARCH_ENGINE_SUGGEST_MAX_LIMIT,
  fileSearchEngineQueryDigits,
  formatEngineInternalNumber,
  formatEngineRmzNumber,
  isFileSearchEngineNumberLike,
  rankAllFileSearchEngineSuggestions,
  type FileSearchEngineSuggestion,
} from '@matricarmz/shared';

import { attributeValues, entities, erpEngineCards } from '../database/schema.js';
import { getEngineDetails, getEngineAttrDefs } from './engineService.js';

/**
 * Потолок просмотренных строк на источник. Номеров с одним хвостом может быть
 * много; оператору хватает первых, а база не должна просматриваться целиком на
 * каждый ввод.
 */
const SCAN_LIMIT = 400;

/** Значение атрибута из JSON-строки: `"Э06АТ0889"` → `Э06АТ0889`. */
function readJsonString(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string') return parsed.trim();
    if (typeof parsed === 'number') return String(parsed);
    return '';
  } catch {
    // Значение могли положить без кавычек — берём как есть.
    return text;
  }
}

/** Кандидат: номер и когда он записан (свежий побеждает старый). */
type Candidate = { engineNumber: string; updatedAt: number };

function putCandidate(byId: Map<string, Candidate>, id: string, engineNumber: string, updatedAt: number): void {
  if (!id || !engineNumber) return;
  const prev = byId.get(id);
  if (!prev || updatedAt >= prev.updatedAt) byId.set(id, { engineNumber, updatedAt });
}

/**
 * Кандидаты по цифрам: номер двигателя, в котором эти цифры есть.
 *
 * Ищем в двух местах (EAV и строгая реплика) — иначе половина карточек была бы
 * «не найдена» в зависимости от того, как её когда-то завели.
 */
async function collectEngineNumberCandidates(
  db: BetterSQLite3Database,
  digits: string,
): Promise<FileSearchEngineSuggestion[]> {
  const byId = new Map<string, Candidate>();

  // Легаси-EAV.
  const defs = await getEngineAttrDefs(db).catch(() => ({}) as Record<string, string>);
  const numberDefId = defs['engine_number'];
  if (numberDefId) {
    const rows = await db
      .select({
        entityId: attributeValues.entityId,
        valueJson: attributeValues.valueJson,
        updatedAt: attributeValues.updatedAt,
      })
      .from(attributeValues)
      .innerJoin(entities, eq(entities.id, attributeValues.entityId))
      .where(
        and(
          eq(attributeValues.attributeDefId, numberDefId),
          isNull(attributeValues.deletedAt),
          isNull(entities.deletedAt),
          like(attributeValues.valueJson, `%${digits}%`),
        ),
      )
      .limit(SCAN_LIMIT);
    for (const row of rows) {
      const engineNumber = readJsonString(row.valueJson);
      if (!engineNumber) continue;
      putCandidate(byId, String(row.entityId), engineNumber, Number(row.updatedAt ?? 0));
    }
  }

  // Строгая реплика карточек.
  const strictRows = await db
    .select({
      id: erpEngineCards.id,
      engineNumber: erpEngineCards.engineNumber,
      updatedAt: erpEngineCards.updatedAt,
    })
    .from(erpEngineCards)
    .where(and(isNull(erpEngineCards.deletedAt), like(erpEngineCards.engineNumber, `%${digits}%`)))
    .limit(SCAN_LIMIT);
  for (const row of strictRows) {
    const engineNumber = String(row.engineNumber ?? '').trim();
    if (!engineNumber) continue;
    putCandidate(byId, String(row.id), engineNumber, Number(row.updatedAt ?? 0));
  }

  return [...byId.entries()].map(([id, value]) => ({ id, engineNumber: value.engineNumber }));
}

/**
 * Ответ сервиса подсказок.
 *
 * `total` — сколько всего нашлось совпадений в базе, а не только сколько
 * показали: иначе подвал выпадашки не может честно сказать «показаны первые
 * 20 из 27» (решение владельца 27.11.2026).
 */
export type FileSearchEngineSuggestionResult = {
  /** Подсказки к показу — по порядку выдачи, не больше лимита. */
  suggestions: FileSearchEngineSuggestion[];
  /** Сколько всего нашлось совпадений. */
  total: number;
};

/**
 * Подсказки по неполному номеру двигателя.
 *
 * Порядок выдачи — доменный (точное → суффикс → вхождение), потолок — лимит.
 * Ввод, не похожий на номер, подсказок не даёт: оператор ищет слово — выпадашка
 * с номерами только мешала бы.
 */
export async function suggestEnginesByNumberFragment(
  db: BetterSQLite3Database,
  args: { q: string; limit?: number },
): Promise<FileSearchEngineSuggestionResult> {
  const raw = String(args?.q ?? '');
  if (!isFileSearchEngineNumberLike(raw)) return { suggestions: [], total: 0 };
  const digits = fileSearchEngineQueryDigits(raw);
  if (!digits) return { suggestions: [], total: 0 };

  const rawLimit = Number(args?.limit ?? FILE_SEARCH_ENGINE_SUGGEST_LIMIT);
  const limit = Math.min(Math.max(Math.trunc(rawLimit) || 0, 1), FILE_SEARCH_ENGINE_SUGGEST_MAX_LIMIT);

  const candidates = await collectEngineNumberCandidates(db, digits);
  // Сначала ВСЯ выдача: из неё и лимит, и честное «всего нашлось».
  const rankedAll = rankAllFileSearchEngineSuggestions(candidates, digits);
  const total = rankedAll.length;
  const ranked = rankedAll.slice(0, limit);

  const out: FileSearchEngineSuggestion[] = [];
  for (const item of ranked) {
    // Карточку читаем каноническим способом (EAV + строгая реплика, свежее
    // побеждает): подсказка должна показывать тот же номер, что и карточка.
    const details = await getEngineDetails(db, item.id).catch(() => null);
    const attrs = details?.attributes ?? {};
    const engineNumber = String(attrs.engine_number ?? '').trim() || item.engineNumber;
    const internalNumberFull = formatEngineInternalNumber(
      String(attrs[ENGINE_INTERNAL_NUMBER_CODE] ?? ''),
      attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE] as number | undefined,
    );
    const rmzCode = details?.rmzSeq != null ? formatEngineRmzNumber(details.rmzSeq) : '';
    out.push({
      id: item.id,
      engineNumber,
      ...(internalNumberFull ? { internalNumberFull } : {}),
      ...(rmzCode ? { rmzCode } : {}),
    });
  }
  return { suggestions: out, total };
}
