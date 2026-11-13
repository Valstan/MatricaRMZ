import React from 'react';

/**
 * Подсказка «расширить поиск» — одна на все экраны (владелец 13.11.2026, промты КАРМАНА #10 + #14).
 *
 * Смысл: в строгом режиме список не находит — оператор должен знать, чем найти. Раньше
 * подсказка была на двух экранах (список двигателей и Ctrl+K), а на остальных пустая
 * выдача молчала, и «похожие» выглядело как отсутствующая возможность.
 */
export const SEARCH_MODE_HINT = 'Нажмите «≈ Похожие», чтобы показать близкие: опечатки, часть слова, другая раскладка.';

/**
 * Текст пустой выдачи. В строгом режиме — с подсказкой, в «похожем» — нечего предлагать.
 * Пустое поле — тоже нечего: подсказка про поиск без запроса сбивает с толку.
 *
 * `base` — что писать, когда выдача пуста и подсказка не нужна («Нет контрагентов»,
 * «Нет данных»): пустая выдача без запроса — это не «ничего не найдено», это «список пуст».
 */
export function searchModeEmptyText(similar: boolean, query: string, base = 'Ничего не найдено'): string {
  if (similar || !query.trim()) return base;
  const stem = base.endsWith('.') ? base : `${base}.`;
  return `${stem} ${SEARCH_MODE_HINT}`;
}

/** Строка-подсказка под полем поиска: выдача пуста и режим строгий. */
export function SearchModeEmptyHint(props: { similar: boolean; query: string }) {
  if (props.similar || !props.query.trim()) return null;
  return (
    <div data-search-hint="similar" style={{ color: 'var(--muted)', fontSize: 13 }}>
      {SEARCH_MODE_HINT}
    </div>
  );
}
