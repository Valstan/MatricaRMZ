import { randomUUID } from 'node:crypto';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  DEFAULT_REPAIR_STAGE_TEMPLATES,
  engineReclamationArrivals,
  RECLAMATION_ARRIVAL_STAGE_CODE,
  type EngineReclamationDto,
  type RepairStageTemplate,
} from '@matricarmz/shared';

import { deleteRepairStageRow, listRepairStageRows, saveRepairStageRow } from './repairStageService.js';

/**
 * Приёмка по рекламации — ЭТАП единого списка (владелец 11.11.2026).
 *
 * «Приход по рекламации приравнивается к приемке двигателя на заводе»: движок, который
 * вернулся по рекламации, приехал на завод — и этот приезд должен быть этапом истории
 * ремонта, а не отдельной строчкой «Приём по рекламации №1» в ленте. Тогда он виден:
 *  · в колонке «этап» / «Текущее состояние» — с подписью «Приемка двигателя на завод
 *    по рекламации» (видно, что движок приехал по рекламации);
 *  · в отборе по этапам — приёмка по рекламации отвечает на отбор «приёмка двигателя
 *    на завод» (см. `stageAnsweringCodes`), а не наоборот;
 *  · в отчёте «Этапы ремонта» и в ленте истории ремонта — обычной строкой этапа.
 *
 * Очередь заездов — источник правды, а этап — её материализация в истории ремонта.
 * Поэтому материалзация ПРИВОДИТСЯ В СООТВЕТСТВИЕ с очередью: рекламация появилась —
 * этап заведён; дату приёма поменяли — этап переписан; рекламацию убрали — этап снят.
 * Строка, поставленная руками, метки не несёт и очередью не управляется.
 *
 * Запись идёт по общему пути `saveRepairStageRow` — со всеми гейтами (субординация
 * дат, дубль по дню, возврат назад). Поэтому ошибки возвращаются списком: очередь на
 * сервере уже принята, а этап — её след; молчать об отказе нельзя.
 */

export type EngineReclamationStagesResult = {
  /** Заведено новых строк этапа. */
  created: number;
  /** Переписаны даты существующих строк. */
  updated: number;
  /** Сняты строки, чья рекламация ушла из очереди. */
  removed: number;
  /** Отказы гейтов записи — по одному на строку. */
  errors: string[];
};

function templateName(templates: readonly RepairStageTemplate[], code: string): string {
  return templates.find((t) => t.code === code)?.name ?? code;
}

/**
 * Привести этапы приёмки по рекламации к очереди заездов.
 *
 * Идемпотентно: повторный вызов с той же очередью ничего не меняет.
 */
export async function syncEngineReclamationStages(
  db: BetterSQLite3Database,
  engineId: string,
  rows: readonly Pick<EngineReclamationDto, 'queueNo' | 'acceptedAt'>[],
  actor: string,
  templates: readonly RepairStageTemplate[] = DEFAULT_REPAIR_STAGE_TEMPLATES,
): Promise<EngineReclamationStagesResult> {
  const result: EngineReclamationStagesResult = { created: 0, updated: 0, removed: 0, errors: [] };
  const id = String(engineId ?? '').trim();
  if (!id) return result;

  const hasTemplate = templates.some((t) => t.code === RECLAMATION_ARRIVAL_STAGE_CODE);
  if (!hasTemplate) {
    result.errors.push(`Этап «${RECLAMATION_ARRIVAL_STAGE_CODE}» не заведён в справочнике этапов`);
    return result;
  }

  const arrivals = engineReclamationArrivals(rows);
  const existing = await listRepairStageRows(db, id);
  const mine = existing.filter((r) => r.code === RECLAMATION_ARRIVAL_STAGE_CODE);

  // 1. Завести/переписать строки под текущую очередь.
  for (const arrival of arrivals) {
    const row = mine.find((r) => r.reclamationQueueNo === arrival.queueNo) ?? null;
    if (row && row.at === arrival.at) continue;
    if (row) {
      const saved = await saveRepairStageRow(
        db,
        {
          id: row.id,
          engineId: id,
          code: RECLAMATION_ARRIVAL_STAGE_CODE,
          atMs: arrival.at,
          reclamationQueueNo: arrival.queueNo,
        },
        actor,
        templates,
      );
      if (!saved.ok) result.errors.push(`Рекламация №${arrival.queueNo}: ${saved.error}`);
      else result.updated += 1;
      continue;
    }
    const saved = await saveRepairStageRow(
      db,
      {
        id: randomUUID(),
        engineId: id,
        code: RECLAMATION_ARRIVAL_STAGE_CODE,
        atMs: arrival.at,
        reclamationQueueNo: arrival.queueNo,
      },
      actor,
      templates,
    );
    if (!saved.ok) result.errors.push(`Рекламация №${arrival.queueNo}: ${saved.error}`);
    else result.created += 1;
  }

  // 2. Снять строки, чей рекламации в очереди больше нет. Метку `reclamation` носят
  //    только материализации очереди — поставленные руками строки не трогаем.
  const wanted = new Set(arrivals.map((a) => a.queueNo));
  for (const row of mine) {
    if (row.reclamationQueueNo == null) continue;
    if (wanted.has(row.reclamationQueueNo)) continue;
    const removed = await deleteRepairStageRow(db, row.id);
    if (!removed.ok) {
      result.errors.push(`Рекламация №${row.reclamationQueueNo}: ${removed.error}`);
      continue;
    }
    result.removed += 1;
  }

  return result;
}

/** Подпись этапа приёмки по рекламации — для отчётов и подсказок. */
export function reclamationArrivalStageName(templates: readonly RepairStageTemplate[] = DEFAULT_REPAIR_STAGE_TEMPLATES): string {
  return templateName(templates, RECLAMATION_ARRIVAL_STAGE_CODE);
}
