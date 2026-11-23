import {
  PRODUCTION_PROGRAM_STATE_LABELS,
  buildProductionProgramPrintModel,
  formatProductionProgramPeriod,
  parseProductionProgramState,
  productionProgramStageText,
  type ProductionProgramPrintInput,
  type ProductionProgramSignatureSlot,
  type ProductionProgramPrintModel,
} from '@matricarmz/shared';

/**
 * Печатная форма производственной программы (ПП) — по образцу «ПП Цех № 1».
 *
 * Метрики образца: A4 landscape, поля 12,7 мм, Times New Roman. Ширины колонок
 * пересчитаны (владелец 23.11.2026): «Примечание» — самая узкая колонка, остальные
 * раздвинуты по ширине содержимого (сумма — печатная ширина полосы 271 мм при
 * полях 12,7 мм).
 *
 * Кегль: **не меньше 14 pt** — требование владельца важнее совпадения с образцом
 * (в образце тело 12 pt, но читать форму на цеховом принтере невозможно).
 *
 * Оформление строк — инлайном (классы не читаются при выгрузке в Word).
 */

/**
 * Ширины колонок в мм — по содержимому, а не по образцу.
 *
 * Колонок шесть (владелец 20.11.2026): «Отгрузка» и «Факторы» убраны — отгрузка
 * видна этапом, а «Факторы» после чистки колонок печатались бы всегда пустыми.
 * Вместо них — «Этап».
 *
 * Пересчёт (владелец 23.11.2026): «Примечание» — самое низкоприоритетное содержимое,
 * поэтому оно ужато (32 мм — это ещё шире жирного заголовка «Примечание», 31 мм), а
 * освободившаяся ширина ушла в остальные колонки — чтобы типичное содержимое
 * печаталось в одну строку.
 *
 * Ширины посчитаны по факту, замером в Chromium (Times New Roman 14 pt, плюс отступы
 * ячейки и границы): «ООО «Малмышский ДМЗ» · *125» — 71,5 мм, «Капитальный
 * ремонт» — 44,7 мм, «Выходной контроль ОТК» — 52,9 мм, «ВТАЗ-3110-65 101» —
 * 38,5 мм, жирный заголовок «Примечание» — 28,0 мм.
 *
 * Сумма ширин держится на 271 мм — это ровно ширина полосы A4 landscape при полях
 * 12,7 мм. Ужимать колонку можно только за счёт других: браузер распределения по
 * содержимому не делает (`table-layout: fixed` + `<colgroup>`), единственный рычаг —
 * эти миллиметры.
 */
const COL_WIDTHS_MM = [17.5, 75.0, 42.5, 48.0, 56.0, 32.0] as const;

const HEADERS = [
  '№ п/п',
  'Организация',
  'Марка и номер двигателя',
  'Состояние',
  'Этап',
  'Примечание',
] as const;

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/**
 * Дата плановой отгрузки — в формате образца («15.11.2026»).
 *
 * Колонки «Отгрузка» в форме больше нет (владелец 20.11.2026): дату этапа
 * печатает сам домен (подпись этапа), а отдельный форматтер даты отгрузки
 * остался бы без единого потребителя.
 */

function stateCell(state: string | null): string {
  // Разбор значения — в домене (там же, где состояние определено): строка из базы
  // может оказаться чем угодно, печатать надо подпись значения, а не саму строку.
  const parsed = parseProductionProgramState(state);
  const label = parsed ? PRODUCTION_PROGRAM_STATE_LABELS[parsed] : '';
  return escapeHtml(label || '—');
}

function rowHtml(model: ProductionProgramPrintModel): string {
  const body: string[] = [];
  for (const group of model.groups) {
    // Шапка группы: организация и номер договора — одна строка на весь план.
    body.push(
      `<tr style="background:#f3f4f6;font-weight:700">` +
        `<td colspan="${HEADERS.length}" style="border:1px solid #111827;padding:4px 6px">${escapeHtml(group.label)}</td>` +
        `</tr>`,
    );
    for (const row of group.rows) {
      // Подсветка — только «готов к отгрузке»: отгруженные строки получают гриф
      // «Отгружен» БЕЗ заливки, иначе весь план «позеленеет» и подсветка перестанет
      // что-то значить (решение владельца).
      const ready = row.highlight === 'ready';
      const bg = ready ? 'background:#dcfce7' : '';
      // Этап — из карточки двигателя. Отгружен без строки этапа — грифом: иначе
      // на бумаге было бы пусто, а двигатель уехал. Правило — в домене: тем же
      // пользуется выгрузка плана в файл, иначе лист и файл разойдутся.
      const stageText = productionProgramStageText(row);
      body.push(
        `<tr style="${bg}">` +
          `<td style="border:1px solid #111827;padding:3px 4px;text-align:center">${row.orderNo}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${escapeHtml(row.organizationLabel)}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${escapeHtml(
            [row.engineMark, row.engineNumber].filter(Boolean).join(' '),
          )}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${stateCell(row.state)}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${escapeHtml(stageText)}</td>` +
          `<td style="border:1px solid #111827;padding:3px 4px">${escapeHtml(row.note)}</td>` +
          `</tr>`,
      );
    }
  }
  if (body.length === 0) {
    body.push(
      `<tr><td colspan="${HEADERS.length}" style="border:1px solid #111827;padding:6px;text-align:center">Строк в плане нет</td></tr>`,
    );
  }
  return body.join('');
}

/**
 * Сетка подписей: должность и ФИО из документа или из карточки сотрудника.
 *
 * Подписи идут ВЕРТИКАЛЬНО в два столбца (владелец 10.11.2026: «подписи размещай не
 * в горизонтальном виде, а и в вертикальном, то есть подписи должны идти друг под
 * дружкой… может быть, в два столбца»): восемь подписей в одну строку занимали
 * половину листа, а в два столбца занимают четверть.
 */
function signaturesHtml(model: ProductionProgramPrintModel, fontSize: number): string {
  const cells = model.signatures.map(
    (s) =>
      `<td style="border:0;padding:0 12px 10px 0;vertical-align:top;width:50%">` +
      `<div style="font-size:${fontSize}pt">${escapeHtml(s.caption)}</div>` +
      `<div style="font-size:${fontSize}pt;border-bottom:1px solid #111827;margin-top:22px">${escapeHtml(s.name)}</div>` +
      `</td>`,
  );
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    const pair = cells.slice(i, i + 2);
    // Нечётная подпись занимает левую половину — вторая ячейка пустая.
    rows.push(`<tr>${pair.join('')}${pair.length === 1 ? '<td style="border:0"></td>' : ''}</tr>`);
  }
  if (rows.length === 0) return '';
  return `<table style="width:100%;border-collapse:collapse;margin-top:14px">${rows.join('')}</table>`;
}

/** Настройки печати формы ПП: кегли и состав подписей. */
export type ProductionProgramPrintOptions = {
  /** Кегль шапки формы (pt). По умолчанию 14. */
  headerFontSize?: number | undefined;
  /** Кегль таблицы строк (pt). По умолчанию 14. */
  tableFontSize?: number | undefined;
  /** Кегль подписей (pt). По умолчанию 14. */
  signatureFontSize?: number | undefined;
  /**
   * Подписи, которые печатаем (слоты целиком). undefined/null — берём из модели.
   * Пустой список — ни одной подписи.
   *
   * Именно слоты, а не должности: должность оператор теперь меняет, и две подписи
   * могут оказаться с одинаковой должностью — фильтр по названию печатал бы не то.
   */
  signatureSlots?: readonly ProductionProgramSignatureSlot[] | null | undefined;
};

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;

function clampFontSize(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

/** Печатный HTML производственной программы. */
export function productionProgramPrintHtml(
  input: ProductionProgramPrintInput,
  options?: ProductionProgramPrintOptions,
): string {
  const model = buildProductionProgramPrintModel(
    options?.signatureSlots ? { ...input, signatureSlots: options.signatureSlots } : input,
  );
  const headerSize = clampFontSize(options?.headerFontSize, DEFAULT_FONT_SIZE);
  const tableSize = clampFontSize(options?.tableFontSize, DEFAULT_FONT_SIZE);
  const signatureSize = clampFontSize(options?.signatureFontSize, DEFAULT_FONT_SIZE);
  const colgroup = `<colgroup>${COL_WIDTHS_MM.map((w) => `<col style="width:${w}mm"/>`).join('')}</colgroup>`;
  const header = HEADERS.map(
    (h, i) =>
      `<th style="border:1px solid #111827;padding:4px 5px;font-size:${tableSize}pt;text-align:center;${i === 1 || i === 5 || i === 6 ? 'text-align:left' : ''}">${escapeHtml(h)}</th>`,
  ).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${escapeHtml(model.title)}</title>
<style>
@page { size: A4 landscape; margin: 12.7mm; }
body { margin: 0; font-family: "Times New Roman", Times, serif; font-size: ${tableSize}pt; color: #111827; }
.pp-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.pp-approver { text-align: right; font-size: ${headerSize}pt; }
.pp-title { text-align: center; font-size: ${headerSize + 2}pt; font-weight: 700; margin: 6px 0 2px 0; }
.pp-period { text-align: center; font-size: ${headerSize}pt; margin-bottom: 8px; }
table.pp-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.pp-table th { background: #f3f4f6; }
/* Длинное значение переносится по словам, а не обрезается: «одна строка» не должна
   превращаться в «значение потеряно». Слово без пробелов (номер двигателя, ИНН) при
   этом переносится по границе — таблица фиксированной ширины, иначе он вылезает
   за колонку и ломает всю строку. */
table.pp-table td, table.pp-table th { overflow-wrap: break-word; }
</style>
</head><body>
<div class="pp-head">
  <div style="font-size:${headerSize}pt">${escapeHtml(model.shop)}</div>
  <div class="pp-approver">
    <div>${escapeHtml(model.approver.title)}</div>
    <div style="margin-top:20px">${escapeHtml(model.approver.position)}</div>
    <div style="border-bottom:1px solid #111827;margin-top:14px">${escapeHtml(model.approver.fullName)}</div>
  </div>
</div>
<div class="pp-title">${escapeHtml(model.title)}</div>
<div class="pp-period">${escapeHtml(model.periodLabel)} · двигателей в плане: ${model.engineCount}</div>
<table class="pp-table">
${colgroup}
<thead><tr>${header}</tr></thead>
<tbody>${rowHtml(model)}</tbody>
</table>
${signaturesHtml(model, signatureSize)}
</body></html>`;
}

/** Подпись плана отдельной строкой — для заголовка окна печати. */
export function productionProgramPrintTitle(input: ProductionProgramPrintInput): string {
  const period = formatProductionProgramPeriod(input.period);
  return `${input.title} — ${period}`;
}

/**
 * Печать формы ПП: окно с готовым документом и `print()` из открывающего окна
 * (inline-скрипты в document.write-окне Electron не исполняются — тот же приём,
 * что в `printSectionsDirect`).
 *
 * Это ПРЯМАЯ печать без превью. Оператору нужен промежуточный этап (владелец
 * 10.11.2026: «нужен промежуточный этап, чтобы можно было редактировать форму
 * печати галочками»), поэтому кнопка «Печать» открывает окно превью
 * (`ProductionProgramPrintPreview`), а сюда попадают уже утверждённые настройки.
 */
export function openProductionProgramPrint(
  input: ProductionProgramPrintInput,
  options?: ProductionProgramPrintOptions,
): boolean {
  const html = productionProgramPrintHtml(input, options);
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => {
    w.addEventListener('afterprint', () => w.close());
    w.focus();
    w.print();
  }, 100);
  return true;
}
