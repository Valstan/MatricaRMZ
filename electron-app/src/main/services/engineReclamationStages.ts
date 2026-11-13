import { randomUUID } from 'node:crypto';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  DEFAULT_REPAIR_STAGE_TEMPLATES,
  engineReclamationArrivals,
  engineReclamationShipments,
  RECLAMATION_ARRIVAL_STAGE_CODE,
  RECLAMATION_SHIPPED_STAGE_CODE,
  type EngineReclamationDto,
  type RepairStageTemplate,
} from '@matricarmz/shared';

import { deleteRepairStageRow, listRepairStageRows, saveRepairStageRow } from './repairStageService.js';

/**
 * Приёмка и отправка по рекламации — ЭТАПЫ единого списка.
 *
 * «Приход по рекламации приравнивается к приемке двигателя на заводе» (владелец 11.11.2026)
 * и «надо его в историю ремонта тоже добавить… чтобы и показывалось в истории, и
 * фильтровалось, и было полноценным участником процесса, и в отчётах и в списках»
 * (владелец 13.11.2026): движок, который вернулся по рекламации, приехал на завод — и
 * потом уехал заказчику, и оба события должны быть этапами истории ремонта, а не полями
 * вкладки. Тогда они видны:
 *  · в колонке «этап» / «Текущее состояние» — с подписью «…по рекламации» (видно, что
 *    движок уехал по рекламации);
 *  · в отборе по этапам — отправка по рекламации отвечает на отбор «отгрузка двигателя
 *    заказчику» (см. `stageAnsweringCodes`), а не наоборот;
 *  · в отчёте «Этапы ремонта» и в ленте истории ремонта — обычной строкой этапа.
 *
 * Очередь заездов — источник правды, а этапы — её материализация в истории ремонта.
 * Поэтому материализация ПРИВОДИТСЯ В СООТВЕТСТВИЕ с очередью: рекламация появилась —
 * этапы заведены; дату поменяли — этап переписан; рекламацию убрали — этапы сняты.
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
 * Привести этапы рекламации (приёмка и отправка) к очереди заездов.
 *
 * Идемпотентно: повторный вызов с той же очередью ничего не меняет.
 */
export async function syncEngineReclamationStages(
  db: BetterSQLite3Database,
  engineId: string,
  rows: readonly Pick<EngineReclamationDto, 'queueNo' | 'acceptedAt' | 'shippedAt'>[],
  actor: string,
  templates: readonly RepairStageTemplate[] = DEFAULT_REPAIR_STAGE_TEMPLATES,
): Promise<EngineReclamationStagesResult> {
  const result: EngineReclamationStagesResult = { created: 0, updated: 0, removed: 0, errors: [] };
  const id = String(engineId ?? '').trim();
  if (!id) return result;

  const existing = await listRepairStageRows(db, id);

  // Два этапа одного заезда: приёмка (движок приехал) и отправка (уехал). Каждый живёт по
  // своей дате из очереди и снимается, когда рекламация ушла из очереди.
  const kinds = [
    { code: RECLAMATION_ARRIVAL_STAGE_CODE, items: engineReclamationArrivals(rows) },
    { code: RECLAMATION_SHIPPED_STAGE_CODE, items: engineReclamationShipments(rows) },
  ];

  for (const kind of kinds) {
    if (!templates.some((t) => t.code === kind.code)) {
      result.errors.push(`Этап «${kind.code}» не заведён в справочнике этапов`);
      continue;
    }
    const mine = existing.filter((r) => r.code === kind.code);

    // 1. Завести/переписать строки под текущую очередь.
    for (const item of kind.items) {
      const row = mine.find((r) => r.reclamationQueueNo === item.queueNo) ?? null;
      if (row && row.at === item.at) continue;
      const saved = await saveRepairStageRow(
        db,
        {
          id: row?.id ?? randomUUID(),
          engineId: id,
          code: kind.code,
          atMs: item.at,
          reclamationQueueNo: item.queueNo,
        },
        actor,
        templates,
      );
      if (!saved.ok) result.errors.push(`Рекламация №${item.queueNo}: ${saved.error}`);
      else if (row) result.updated += 1;
      else result.created += 1;
    }

    // 2. Снять строки, чей рекламации в очереди больше нет. Метку `reclamation` носят
    //    только материализации очереди — поставленные руками строки не трогаем.
    const wanted = new Set(kind.items.map((i) => i.queueNo));
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
  }

  return result;
}

/** Подпись этапа приёмки по рекламации — для отчётов и подсказок. */
export function reclamationArrivalStageName(templates: readonly RepairStageTemplate[] = DEFAULT_REPAIR_STAGE_TEMPLATES): string {
  return templateName(templates, RECLAMATION_ARRIVAL_STAGE_CODE);
}

/** Подпись этапа отправки по рекламации — для отчётов и подсказок. */
export function reclamationShippedStageName(templates: readonly RepairStageTemplate[] = DEFAULT_REPAIR_STAGE_TEMPLATES): string {
  return templateName(templates, RECLAMATION_SHIPPED_STAGE_CODE);
}
