/**
 * Сбор состояния двигателя для гейта «утильный движок не начинает ремонт»
 * (промт КАРМАНА #170).
 *
 * Модуль НАМЕРЕННО не тянет `engineService`: тот уже тянет `repairStageService`, а гейт
 * стоит именно в воронке записи этапа — статический цикл импортов сломал бы инициализацию.
 * Поэтому читаем ровно то, что гейту нужно, своими запросами:
 *
 *  · флаги статуса карточки («Признан утильным» и соседние) и их даты — EAV;
 *  · утильные детали дефектовки — строки акта (`engine_inventory`), реплика или блоб;
 *  · след снятия утиля из истории ремонта (`scrapResolved`).
 *
 * Правило вынесено в домен (`shared/src/domain/engineScrapStageGate.ts`) — здесь только
 * сбор данных.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  currentVisitStartAt,
  evaluateScrapStageGate,
  isEavFlagSet,
  isScrapCriterionEngineUtil,
  inventoryRowPartId,
  isScrapEngine,
  isScrapResolvedFor,
  latestScrapResolvedAt,
  parseRepairHistoryMeta,
  REPAIR_HISTORY_OPERATION_TYPE,
  type EngineScrapGateDecision,
  type EngineScrapGateState,
  type EngineStageEntry,
  type RepairStageRow,
  type ScrapCriterionPartRef,
} from '@matricarmz/shared';

import { attributeDefs, attributeValues, operations } from '../database/schema.js';
import { readInventoryFlagRowsForOperations } from './engineInventoryLinesReplica.js';
import { loadScrapCriterionIndex } from './scrapCriterionService.js';

/** Статусы, которыми двигатель помечается утильным (глобальный статус карточки). */
const SCRAP_STATUS_CODES = ['status_scrap_confirmed', 'status_rework_sent', 'status_rejected'] as const;

/** Атрибуты карточки, нужные гейту. */
const NEEDED_ATTR_CODES = [
  'engine_number',
  'defect_date',
  ...SCRAP_STATUS_CODES,
  ...SCRAP_STATUS_CODES.map((code) => `${code}_date`),
] as const;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function parseJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(parseJson(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Дата из EAV-атрибута (значение приходит JSON-числом или строкой с числом). */
function attrDate(value: unknown): number | null {
  return numberOf(value);
}

/** Атрибуты двигателя: код → разобранное значение. */
async function readEngineAttrs(
  db: BetterSQLite3Database,
  engineId: string,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const defs = (await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(inArray(attributeDefs.code, [...NEEDED_ATTR_CODES]), isNull(attributeDefs.deletedAt)))) as Array<{
    id: unknown;
    code: unknown;
  }>;
  if (defs.length === 0) return out;
  const idByCode = new Map<string, string>();
  for (const def of defs) {
    const code = text(def.code);
    if (code) idByCode.set(code, String(def.id));
  }
  if (idByCode.size === 0) return out;
  const rows = (await db
    .select({ attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.entityId, engineId),
        inArray(attributeValues.attributeDefId, [...idByCode.values()]),
        isNull(attributeValues.deletedAt),
      ),
    )) as Array<{ attributeDefId: unknown; valueJson: unknown }>;
  for (const row of rows) {
    const code = [...idByCode.entries()].find(([, id]) => id === String(row.attributeDefId))?.[0];
    if (!code) continue;
    out.set(code, parseJson(row.valueJson));
  }
  return out;
}

/**
 * Утильные детали дефектовки — из ПОСЛЕДНЕГО акта двигателя.
 *
 * Строки берутся тем же проходом, что и в списке двигателей (реплика строк листа, иначе
 * блоб акта): иначе гейт видел бы одни детали, а список — другие.
 */
async function readScrapPartsOfDefectAct(
  db: BetterSQLite3Database,
  engineId: string,
): Promise<ScrapCriterionPartRef[]> {
  try {
    const acts = (await db
      .select({ id: operations.id, metaJson: operations.metaJson })
      .from(operations)
      .where(
        and(
          eq(operations.engineEntityId, engineId),
          eq(operations.operationType, 'engine_inventory'),
          isNull(operations.deletedAt),
        ),
      )
      .orderBy(desc(operations.updatedAt))
      .limit(1)) as Array<{ id: unknown; metaJson: unknown }>;
    const act = acts[0];
    if (!act) return [];
    const rowsById = await readInventoryFlagRowsForOperations(db, [
      { id: String(act.id), payload: parseJson(act.metaJson) },
    ]);
    const rows = rowsById.get(String(act.id)) ?? [];
    const out: ScrapCriterionPartRef[] = [];
    for (const row of rows) {
      const scrapQty = Number(row.scrapQty ?? 0);
      if (!Number.isFinite(scrapQty) || scrapQty <= 0) continue;
      const partId = text(inventoryRowPartId(row as unknown as Record<string, unknown>));
      const partName = text(row.partName);
      if (!partId && !partName) continue;
      out.push({ partId: partId || null, partName: partName || null });
    }
    return out;
  } catch {
    // Нет таблиц (старая база, фикстура) — гейт работает по статусам карточки.
    return [];
  }
}

/** Момент последнего снятия утиля по истории ремонта (гасит источник того же момента). */
async function readScrapResolvedAt(db: BetterSQLite3Database, engineId: string): Promise<number | null> {
  try {
    const rows = (await db
      .select({ metaJson: operations.metaJson })
      .from(operations)
      .where(
        and(
          eq(operations.engineEntityId, engineId),
          eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )) as Array<{ metaJson: unknown }>;
    const metas = rows.map((row) => parseRepairHistoryMeta(typeof row.metaJson === 'string' ? row.metaJson : null));
    return latestScrapResolvedAt(metas);
  } catch {
    return null;
  }
}

/** Этапы двигателя как записи для правила «текущий заезд» (`engineCurrentPass`). */
function toStageEntries(rows: readonly RepairStageRow[]): EngineStageEntry[] {
  return rows
    .filter((row) => text(row.code))
    .map((row) => ({
      code: text(row.code),
      name: text(row.name) || text(row.code),
      at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0,
      pass: typeof row.pass === 'number' && row.pass > 1 ? row.pass : 1,
    }));
}

/**
 * Состояние двигателя для гейта.
 *
 * Утиль двигателя — ТОТ ЖЕ признак, что в списке (красная строка): глобальный статус
 * карточки ИЛИ утиль по детали-критерию (метка на карточке детали, `scrapCriterion.ts`).
 * Формула одна — иначе гейт и список разойдутся, и оператор увидит «утильный» рядом с
 * этапом, который программа только что завела.
 */
export async function readEngineScrapGateState(
  db: BetterSQLite3Database,
  engineId: string,
  stageRows: readonly RepairStageRow[],
): Promise<EngineScrapGateState> {
  const id = text(engineId);
  const attrs = await readEngineAttrs(db, id);

  // Глобальный статус утиля: тот же набор флагов, что у `isScrapEngine`.
  const flags = {
    status_scrap_confirmed: isEavFlagSet(attrs.get('status_scrap_confirmed')),
    status_rework_sent: isEavFlagSet(attrs.get('status_rework_sent')),
  } as Record<string, boolean>;
  const rejected = isEavFlagSet(attrs.get('status_rejected'));
  const statusScrapMarked = isScrapEngine(flags as never) || rejected;

  // Даты источников утиля: дата статуса важнее даты акта (статус — решение оператора).
  const statusAt =
    attrDate(attrs.get('status_scrap_confirmed_date')) ??
    attrDate(attrs.get('status_rework_sent_date')) ??
    attrDate(attrs.get('status_rejected_date'));

  // Утиль по детали: деталь-критерий, ушедшая в утиль по последнему акту.
  const scrapParts = await readScrapPartsOfDefectAct(db, id);
  const scrapResolvedAt = await readScrapResolvedAt(db, id);
  const defectDate = attrDate(attrs.get('defect_date'));
  let criterionScrappedLive = false;
  try {
    const index = await loadScrapCriterionIndex(db);
    criterionScrappedLive = isScrapCriterionEngineUtil(
      scrapParts.map((part) => ({
        partId: index.nomenclatureToPart.get(String(part.partId ?? '')) ?? part.partId ?? null,
        partName: part.partName ?? null,
      })),
      index.set,
      { scrapResolvedAt, sourceAt: defectDate },
    );
  } catch {
    // Набор критериев недоступен (старая база) — работаем по статусу карточки.
  }

  // Боковая ветка «Утиль и брак» — тоже источник утиля. Снятие утиля гасит её, если
  // оно не старше источника (та же формула, что в списке двигателей).
  const scrapBranchAt = stageRows
    .filter((row) => text(row.code) === 'scrap_branch')
    .map((row) => (typeof row.at === 'number' && row.at > 0 ? row.at : null))
    .filter((at): at is number => at != null)
    .sort((a, b) => b - a)[0] ?? null;
  const scrapBranchLive = scrapBranchAt != null && !isScrapResolvedFor(scrapResolvedAt, scrapBranchAt);

  const scrapAt = statusAt ?? (criterionScrappedLive ? defectDate : null) ?? scrapBranchAt;
  const isScrap = statusScrapMarked || criterionScrappedLive || scrapBranchLive;

  const partLabels = scrapParts
    .map((part) => text(part.partName))
    .filter((name) => name.length > 0);

  return {
    isScrap,
    scrapAt,
    partLabel: partLabels[0] ?? null,
    partId: text(scrapParts[0]?.partId) || null,
    scrapPartLabels: partLabels,
    engineNumber: text(attrs.get('engine_number')) || null,
  };
}

/**
 * Решение гейта для этапа `stageCode` двигателя `engineId`.
 *
 * `stageRows` — строки этапов двигателя (их уже прочитал вызывающий): из них считается
 * начало текущего заезда.
 */
export async function resolveScrapStageGate(
  db: BetterSQLite3Database,
  engineId: string,
  stageRows: readonly RepairStageRow[],
  stageCode: string,
  stageName: string,
): Promise<EngineScrapGateDecision> {
  const state = await readEngineScrapGateState(db, engineId, stageRows);
  const currentVisitFrom = currentVisitStartAt(toStageEntries(stageRows));
  return evaluateScrapStageGate({ state, stageCode, stageName, currentVisitFrom });
}
