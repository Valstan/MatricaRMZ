// Группировки отчёта «Двигатели на заводе» (заявка владельца 07.10.2026): разложить
// обстановку по заводу по разным разрезам — по дате прихода, по дням на заводе,
// по утилю. Группировка по этапу и по заказчику уже живёт в самих страницах
// (ранг несёт `engineFactoryStage` / подпись заказчика).
//
// Чистые функции: тот же день и тот же месяц — по московскому времени
// (`moscowDayKey`), а не по локальной зоне машины, иначе один и тот же двигатель
// попал бы в разные группы на разных машинах парка.

import { moscowDayKey } from './workSheetDuplicates.js';
import type { GroupKey } from './listGrouping.js';

const MONTH_NAMES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
] as const;

function parseMonth(dayKey: string): { year: number; month: number } | null {
  const parts = String(dayKey ?? '').split('.');
  if (parts.length !== 3) return null;
  const year = Number(parts[2]);
  const month = Number(parts[1]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function monthGroup(atMs: number | null | undefined, prefix: string, emptyLabel: string, emptyRank: number): GroupKey {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs <= 0) {
    return { key: `${prefix}:none`, label: emptyLabel, rank: emptyRank };
  }
  const parsed = parseMonth(moscowDayKey(atMs));
  if (!parsed) return { key: `${prefix}:none`, label: emptyLabel, rank: emptyRank };
  const { year, month } = parsed;
  return {
    key: `${prefix}:${year}-${String(month).padStart(2, '0')}`,
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    rank: -(year * 12 + month),
  };
}

/**
 * Группа «по дате прихода»: календарный месяц прихода («Октябрь 2026»).
 * Порядок — хронологический, старые месяцы выше: отчёт читается как лента времени.
 * Без даты прихода — отдельная группа в конце (у строк «на заводе» её быть не должно,
 * но молча терять такую строку хуже, чем показать её отдельно).
 */
export function arrivalMonthGroup(atMs: number | null | undefined): GroupKey {
  return monthGroup(atMs, 'arrival', 'Без даты прихода', Number.MIN_SAFE_INTEGER);
}

/**
 * Группа «по месяцу приёмки рекламации»: та же календарная сетка, что у прихода
 * («Октябрь 2026»), но свой префикс ключа — иначе группы двух разрезов слиплись бы.
 * Рекламация без даты приёмки — отдельная группа в конце, а не молчаливая потеря.
 */
export function reclamationMonthGroup(atMs: number | null | undefined): GroupKey {
  return monthGroup(atMs, 'reclamation', 'Без даты рекламации', Number.MIN_SAFE_INTEGER);
}

/**
 * Группа «по дням на заводе»: сколько двигатель уже стоит (`engineDaysOnSite`).
 * Порядок — дольше всех стоящие выше: смысл разреза — увидеть залежавшееся.
 */
export function daysOnSiteGroup(days: number | null | undefined): GroupKey {
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
    return { key: 'days:none', label: 'Без даты', rank: -1 };
  }
  if (days <= 30) return { key: 'days:0-30', label: 'До 30 дней', rank: 0 };
  if (days <= 90) return { key: 'days:31-90', label: '1–3 месяца', rank: 1 };
  if (days <= 180) return { key: 'days:91-180', label: '3–6 месяцев', rank: 2 };
  if (days <= 365) return { key: 'days:181-365', label: '6–12 месяцев', rank: 3 };
  return { key: 'days:365+', label: 'Больше года', rank: 4 };
}

/**
 * Группа «по утилю»: сколько утиля всё ещё лежит на заводе и не уехало.
 * Утиль — первым разделом: это и есть ответ на вопрос владельца.
 */
export function plantScrapGroup(isScrap: boolean): GroupKey {
  return isScrap
    ? { key: 'scrap:yes', label: 'Утиль (лежит на заводе)', rank: 1 }
    : { key: 'scrap:no', label: 'В работе', rank: 0 };
}
