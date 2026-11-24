import {
  PRODUCTION_PROGRAM_STATE_LABELS,
  buildProductionProgramPrintModel,
  formatProductionProgramPeriod,
  productionProgramStageText,
  type ProductionProgramPrintInput,
} from '@matricarmz/shared';

import type { ListPrintColumn } from '../components/ListPrintDialog.js';
import { buildListExportSpec } from './listExportSpec.js';
import { planListPrintLayout } from './listPrintLayout.js';
import { formatMomentLabel } from './printPreview.js';

/**
 * Выгрузка плана ПП в Word/Excel, письмо и буфер обмена — из ТОЙ ЖЕ модели печати,
 * что и печатный лист (`buildProductionProgramPrintModel`).
 *
 * Своего сборщика файла в модуле нет намеренно: файл собирает общий экспортёр
 * (`window.matrica.exports.list`), а модель строк — общий слой печати списков
 * (`buildListExportSpec`). Второй сборщик в ПП разъехался бы с листом, и чинить
 * пришлось бы дважды.
 */

/** Сколько строк меряем, чтобы предположить ширины колонок в Word: дальше картина не меняется. */
const LAYOUT_SAMPLE_ROWS = 200;

/**
 * Сколько строк уходит в буфер обмена. План может быть на сотни двигателей, а буфер
 * обмена режет такой текст в одних редакторах и не режет в других — лучше сказать
 * оператору, что список обрезан, чем отдать молча половину.
 */
export const CLIPBOARD_ROW_LIMIT = 5000;

/** Строка плана, разложенная для выгрузки: то, что видит оператор, без служебных полей. */
export type ProductionProgramExportRow = {
  /** Сквозной «№ п/п» по программе (шапки групп номер не занимают). */
  orderNo: number;
  /** «№ п/п» внутри своего договора — так же, как на экране. */
  inContractNo: number;
  /** Живая подпись «Организация»: заказчик и номер договора. */
  organization: string;
  /** Наименование договора — шапка группы на экране и на листе. */
  contract: string;
  /** Марка и номер двигателя. */
  engine: string;
  /** Этап: подпись с датой («Сборка двигателя · 12.11.2026») или «Отгружен». */
  stage: string;
  /** Состояние строки плана — подпись, а не значение из базы. */
  state: string;
  note: string;
};

/**
 * Строки плана для выгрузки — из модели печати.
 *
 * Порядок групп и строк внутри них сохраняется: сквозной «№ п/п» и номер внутри
 * договора на экране считаются ровно так же (`productionProgramNumbering`), поэтому
 * файл и лист не разойдутся ни в одной цифре.
 *
 * Номер внутри договора берётся **из модели печати** (`row.inContractNo`), а не
 * считается здесь заново: своя считалка в выгрузке — это ровно та причина, по
 * которой файл и лист расходились между собой.
 */
export function buildProductionProgramExportRows(input: ProductionProgramPrintInput): ProductionProgramExportRow[] {
  const model = buildProductionProgramPrintModel(input);
  const out: ProductionProgramExportRow[] = [];
  for (const group of model.groups) {
    for (const row of group.rows) {
      out.push({
        orderNo: row.orderNo,
        inContractNo: row.inContractNo,
        organization: row.organizationLabel,
        contract: group.label,
        engine: [row.engineMark, row.engineNumber].filter(Boolean).join(' '),
        stage: productionProgramStageText(row),
        state: row.state ? PRODUCTION_PROGRAM_STATE_LABELS[row.state] : '',
        note: row.note,
      });
    }
  }
  return out;
}

/**
 * Колонки выгрузки — те же, что на экране плана.
 *
 * Сквозного «№ п/п» среди них нет: его первым добавляет общий сборщик спеки
 * (`buildListExportSpec`) — по позиции строки, а по позиции она и сквозная.
 */
export function productionProgramExportFields(): ListPrintColumn<ProductionProgramExportRow>[] {
  return [
    { id: 'inContractNo', label: '№ в договоре', printValue: (row) => String(row.inContractNo) },
    { id: 'organization', label: 'Организация', printValue: (row) => row.organization },
    { id: 'contract', label: 'Договор', printValue: (row) => row.contract },
    { id: 'engine', label: 'Двигатель', printValue: (row) => row.engine },
    { id: 'stage', label: 'Этап', printValue: (row) => row.stage },
    { id: 'state', label: 'Состояние', printValue: (row) => row.state },
    { id: 'note', label: 'Примечание', printValue: (row) => row.note },
  ];
}

/** Название файла: план и период — иначе в папке «Планы» лежит десяток «План.docx». */
export function productionProgramFileBaseName(input: ProductionProgramPrintInput): string {
  return `${input.title} ${formatProductionProgramPeriod(input.period)}`;
}

/**
 * Спека для общего экспортёра (`window.matrica.exports.list`).
 *
 * Ширины колонок считает планировщик печати — тот же, что у списков: документ в Word
 * повторяет раскладку листа, а не раскладывается заново по-своему.
 */
export function buildProductionProgramExportSpec(input: ProductionProgramPrintInput): {
  spec: ReturnType<typeof buildListExportSpec>;
  rows: ProductionProgramExportRow[];
  fields: ListPrintColumn<ProductionProgramExportRow>[];
} {
  const rows = buildProductionProgramExportRows(input);
  const fields = productionProgramExportFields();
  const sample = rows.slice(0, LAYOUT_SAMPLE_ROWS);
  const plan = planListPrintLayout({
    columns: fields.map((field) => ({
      label: field.label,
      valueChars: sample.reduce((max, row) => Math.max(max, field.printValue(row).length), 0),
    })),
  });

  const spec = buildListExportSpec({
    title: productionProgramFileBaseName(input),
    fields,
    rows,
    filters: [
      `Цех: ${String(input.shop ?? '').trim() || '—'}`,
      `Период: ${formatProductionProgramPeriod(input.period)}`,
      `Двигателей в плане: ${rows.length}`,
    ],
    columnWidthsMm: plan.widthsMm,
    fileBaseName: productionProgramFileBaseName(input),
    meta: `Выгружено: ${formatMomentLabel(new Date())}`,
  });

  return {
    spec: {
      ...spec,
      // Номера — числа: иначе Excel сортирует «10» перед «9», а это план, а не список.
      columns: spec.columns.map((column) =>
        column.label === '№ в договоре' ? { ...column, kind: 'number' as const } : column,
      ),
    },
    rows,
    fields,
  };
}

/**
 * Текст плана для буфера обмена: шапка и строки через табуляцию.
 *
 * Такой текст вставляется в Excel и в Word таблицей одним движением — в отличие от
 * «Колонка: значение | Колонка: значение», который разбирать пришлось бы руками.
 */
export function buildProductionProgramClipboardText(
  input: ProductionProgramPrintInput,
  limit = CLIPBOARD_ROW_LIMIT,
): string {
  const rows = buildProductionProgramExportRows(input);
  const fields = productionProgramExportFields();
  const clean = (value: string): string => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  const lines: string[] = [['№ п/п', ...fields.map((field) => field.label)].join('\t')];
  for (const row of rows.slice(0, limit)) {
    lines.push(
      [String(row.orderNo), ...fields.map((field) => clean(field.printValue(row)))].join('\t'),
    );
  }
  if (rows.length > limit) {
    lines.push(`… и ещё ${rows.length - limit} строк — полный список в файле выгрузки`);
  }
  return lines.join('\n');
}
