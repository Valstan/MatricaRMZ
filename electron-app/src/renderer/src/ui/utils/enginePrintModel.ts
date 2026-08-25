import type { EngineTimelineItem } from '@matricarmz/shared';

import { escapeHtml, type PrintSection } from './printPreview.js';

/**
 * Печатная модель карточки двигателя (план reclamation-tab-redesign-2026-08).
 *
 * Зависимости приходят явно, а не замыканием на состояние карточки: печать двигателя
 * до сих пор жила внутри страницы на 2500 строк и потому не проверялась ничем. Образец —
 * `woPrintModel.ts` у нарядов.
 */
export type EngineReclamationPrintDeps = {
  engineLabel: string;
  /** Строки раздела «Основное» — карточка отдаёт их в том же порядке, что показывает. */
  mainRows: Array<[string, string]>;
  timeline: EngineTimelineItem[];
  reclamation: {
    acceptedDate: string;
    defectDescription: string;
    actualDefect: string;
    defectNature: string;
    actNumber: string;
    actDate: string;
    shippedDate: string;
    comment: string;
  };
  formatDateTime: (ms: number) => string;
};

const DASH = '—';

/** Текст оператора приезжает из чужих документов — экранируем, переносы сохраняем. */
function cell(value: string): string {
  const text = String(value ?? '').trim();
  if (!text) return DASH;
  return escapeHtml(text).replaceAll('\n', '<br/>');
}

function keyValueTable(rows: Array<[string, string]>): string {
  const body = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${cell(value)}</td></tr>`)
    .join('\n');
  return `<table><tbody>${body}</tbody></table>`;
}

function timelineTable(items: EngineTimelineItem[], formatDateTime: (ms: number) => string): string {
  if (items.length === 0) return '<div class="muted">По этому двигателю нет зафиксированных событий</div>';
  const rows = items
    .map((it) => {
      const when = escapeHtml(formatDateTime(it.at));
      const what = cell(it.statusLabel ? `${it.label} (${it.statusLabel})` : it.label);
      const note = cell(it.note ?? '');
      const who = cell(it.performedBy && it.performedBy !== 'local' ? it.performedBy : '');
      return `<tr><td>${when}</td><td>${what}</td><td>${note}</td><td>${who}</td></tr>`;
    })
    .join('\n');
  return `<table><thead><tr><th>Когда</th><th>Событие</th><th>Примечание</th><th>Ответственный</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function buildEngineReclamationPrintModel(deps: EngineReclamationPrintDeps): {
  title: string;
  subtitle?: string;
  sections: PrintSection[];
} {
  const r = deps.reclamation;
  const engineLabel = String(deps.engineLabel ?? '').trim();
  return {
    title: `Карточка двигателя ${engineLabel}`.trim(),
    ...(engineLabel ? { subtitle: `Номер: ${engineLabel}` } : {}),
    sections: [
      { id: 'main', title: 'Основное', html: keyValueTable(deps.mainRows) },
      { id: 'history', title: 'История ремонта', html: timelineTable(deps.timeline, deps.formatDateTime) },
      {
        id: 'reclamation',
        title: 'Рекламация',
        html: keyValueTable([
          ['Дата приёмки по рекламации', r.acceptedDate],
          ['Описание дефекта изделия', r.defectDescription],
          ['Фактически установленный дефект', r.actualDefect],
          ['Установленный характер дефекта', r.defectNature],
          ['Номер акта исследования', r.actNumber],
          ['Дата акта исследования', r.actDate],
          ['Дата отправки заказчику', r.shippedDate],
          ['Комментарий', r.comment],
        ]),
      },
    ],
  };
}
