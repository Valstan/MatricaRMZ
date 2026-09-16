import {
  HUMAN_LABEL_DASH,
  HUMAN_LABEL_NO_NUMBER,
  formatWorkSheetValue,
  mergeWorkSheetColumns,
  type WorkSheetColumn,
  type WorkSheetRow,
} from '@matricarmz/shared';

import { escapeHtml, type PrintSection } from './printPreview.js';

/**
 * Печатный бланк ОДНОГО этапа работ (план autumn-2026-program §C5).
 *
 * Зависимости приходят явно, а не замыканием на карточку — образец `enginePrintModel.ts`:
 * печать, живущая внутри страницы, не проверяется ничем.
 *
 * Бланк собирается из САМОЙ СТРОКИ, а не из живого справочника видов работ: строка
 * самоописываема (поле несёт подпись и тип с собой), и офлайн или заархивированный вид
 * работ не должны оставить лист с пустой таблицей. Справочник нужен только ради ПОРЯДКА
 * колонок.
 *
 * Заголовок листа — отдельная секция, а не `title` окна предпросмотра: тот лежит в блоке
 * `no-print` и на бумагу не попадает вовсе.
 */
export type WorkSheetPrintDeps = {
  row: WorkSheetRow;
  /** Колонки живого вида работ; пусто — вид недоступен, порядок берётся из самой строки. */
  liveColumns: readonly WorkSheetColumn[];
  /** Имя цеха из справочника по id; пусто — берётся снимок, записанный в строку. */
  workshopFromDirectory: (id: string) => string;
};

/** Родовая подпись, когда у строки нет имени вида работ. Голое «Этап» запрещено (словарь C1). */
const GENERIC_TITLE = 'Этап работ';

/**
 * Пустое значение — прочерк, а не пустая клетка: это бланк-ОТЧЁТ о сделанном, а не бланк под
 * заполнение ручкой (у актов комплектности обратная конвенция и другая причина).
 * Текст оператора приезжает из чужих документов — экранируем, переносы сохраняем.
 */
function cell(value: string): string {
  const text = String(value ?? '').trim();
  if (!text) return HUMAN_LABEL_DASH;
  return escapeHtml(text).replaceAll('\n', '<br/>');
}

function keyValueTable(rows: Array<[string, string]>): string {
  const body = rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${cell(value)}</td></tr>`).join('\n');
  return `<table><tbody>${body}</tbody></table>`;
}

export function buildWorkSheetPrintModel(deps: WorkSheetPrintDeps): {
  title: string;
  subtitle: string;
  sections: PrintSection[];
} {
  const row = deps.row;
  const typeName = String(row.typeName ?? '').trim() || GENERIC_TITLE;
  const engineNumber = String(row.engineNumber ?? '').trim() || HUMAN_LABEL_NO_NUMBER;
  const date = formatWorkSheetValue({ type: 'date', value: row.at });
  // Цепочка имени цеха — та же, что в списке: справочник свежее, снимок строки выручает без
  // прав на справочник и офлайн. Один только справочник дал бы пустой цех у живой строки,
  // когда карточка открыта не из списка (Ctrl+K, вторая панель) и он ещё не загружен.
  const workshop = deps.workshopFromDirectory(row.workshopId) || row.workshopName || '';

  // У строки без имени вида работ заголовок — просто «Этап работ»: рамка «Этап работ «Этап
  // работ»» читается как ошибка вёрстки.
  const heading = row.typeName?.trim() ? `Этап работ «${escapeHtml(typeName)}»` : GENERIC_TITLE;
  const titleHtml = [
    `<div style="text-align:center;font-size:17px;font-weight:700;margin-bottom:4px">${heading}</div>`,
    `<div style="text-align:center;font-size:12px;color:#6b7280;margin-bottom:12px">Двигатель ${escapeHtml(engineNumber)} · ${escapeHtml(date)}</div>`,
  ].join('\n');

  // Порядок и подписи — как на экране карточки: бланк читается как её бумажная копия.
  const metaHtml = keyValueTable([
    ['Вид работ', typeName],
    ['Двигатель', engineNumber],
    ['Марка', row.engineBrand],
    ['Внутр. №', row.internalNumber],
    // Полное имя и полный номер: подсказка под курсором на бумагу не переносится, а лист
    // уходит наружу — там уместно длинное название.
    ['Заказчик', row.customerFullName || row.customerName],
    ['Договор', row.contractNumber || row.contractShortLabel],
    ['Дата', date],
    ['Цех', workshop],
    // «Кто записал», а не «Исполнитель»: в строке лежит логин, и сервер переписывает его на
    // того, кто правил последним. Назвать это исполнителем значило бы напечатать неправду.
    ['Кто записал', row.performedBy],
  ]);

  const columns = mergeWorkSheetColumns(deps.liveColumns, row.fields);
  const byCode = new Map(row.fields.map((f) => [f.code, f]));
  const fieldsHtml = columns.length
    ? `<table><thead><tr><th style="width:45%">Поле</th><th>Значение</th></tr></thead><tbody>${columns
        .map((col) => {
          const field = byCode.get(col.code);
          const value = field ? formatWorkSheetValue(field) : '';
          return `<tr><th>${escapeHtml(col.label || col.code)}</th><td>${cell(value)}</td></tr>`;
        })
        .join('\n')}</tbody></table>`
    : '';

  const signHtml = [
    '<div style="display:flex;gap:24px;margin-top:18px;font-size:12px">',
    '<div style="flex:1">Работу выполнил: <span style="display:inline-block;min-width:150px;border-bottom:1px solid #111827"></span> /<span style="display:inline-block;min-width:120px;border-bottom:1px solid #111827"></span>/</div>',
    '<div>Дата: «____» ____________ 20___ г.</div>',
    '</div>',
  ].join('\n');

  const sections: PrintSection[] = [
    { id: 'title', title: 'Заголовок', html: titleHtml, hideTitle: true },
    { id: 'meta', title: 'Реквизиты', html: metaHtml, hideTitle: true },
  ];
  // Пустых блоков не печатаем: пустая секция вывела бы на лист «Нет данных».
  if (fieldsHtml) sections.push({ id: 'fields', title: 'Поля вида работ', html: fieldsHtml });
  if (String(row.note ?? '').trim()) {
    sections.push({ id: 'note', title: 'Примечание', html: `<div>${cell(row.note)}</div>` });
  }
  sections.push({ id: 'sign', title: 'Подпись', html: signHtml, hideTitle: true });

  return {
    title: `${row.typeName?.trim() ? `Этап работ «${typeName}»` : GENERIC_TITLE} · ${engineNumber}`,
    subtitle: date,
    sections,
  };
}
