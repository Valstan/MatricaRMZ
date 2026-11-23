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
 * Метрики образца: A4 landscape, поля 12,7 мм, Times New Roman, семь колонок
 * шириной 15,7 / 47,8 / 62,0 / 39,5 / 28,1 / 43,0 / 34,8 мм (в сумме — печатная
 * ширина полосы 271 мм при полях 12,7 мм).
 *
 * Кегль: **не меньше 14 pt** — требование владельца важнее совпадения с образцом
 * (в образце тело 12 pt, но читать форму на цеховом принтере невозможно).
 *
 * Оформление строк — инлайном (классы не читаются при выгрузке в Word).
 */

/**
 * Ширины колонок в мм — из образца.
 *
 * Колонок стало шесть (владелец 20.11.2026): «Отгрузка» и «Факторы» убраны —
 * отгрузка видна этапом, а «Факторы» после чистки колонок печатались бы всегда
 * пустыми. Вместо них — «Этап». Ширина освободившегося места ушла в «Примечание»
 * (там теперь всё, что неясно: в колонке «Факторы» писали именно это).
 *
 * **Пересобраны по заказу владельца 23.11.2026 (промт #72):** «Примечание» ужато,
 * остальные колонки — в одну строку.
 *
 * Ширины посчитаны по **типичным значениям** при 14 pt Times (≈2,4 мм на знак,
 * +2,6 мм полей ячейки), а не «на глаз»:
 *
 * | Колонка | Что в неё влезает | Нужно | Стало |
 * |---|---|---|---|
 * | № п/п | шапка «№ п/п» | 15,3 | 15,7 |
 * | Организация | «ООО «Заказчик» · 239» | 57 | 58,0 |
 * | Марка и номер двигателя | **шапка** (на 62 мм переносилась на две строки) | 62,7 | 64,0 |
 * | Состояние | «Капитальный ремонт» | 47 | 48,0 |
 * | Этап | «Выходной контроль ОТК» | 55 | 55,0 |
 * | Примечание | свободный текст — единственная колонка с переносом | — | **30,3** |
 *
 * Сумма — те же **271 мм** (полоса A4 landscape при полях 12,7 мм): сумма не
 * «примерно», а точно ширина полосы, иначе таблица уезжает на второй лист.
 */
const COL_WIDTHS_MM = [15.7, 58.0, 64.0, 48.0, 55.0, 30.3] as const;

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

/** База стиля ячейки строки плана. */
const CELL_STYLE = 'border:1px solid #111827;padding:3px 4px';

/**
 * Ячейка, которая держит **одну строку** (промт #72: «остальные колонки — в одну
 * строку»).
 *
 * Ширины колонок считаются руками (`table-layout: fixed` + `<colgroup>`), поэтому
 * длинное значение либо вылезет за границу ячейки, либо распишет строку на две
 * строки — и «шапка + строки» превратится в кашу. Многоточие честнее молчаливого
 * обрезания: видно, что значение не поместилось.
 */
function oneLineCellStyle(extra?: string): string {
  const base = extra ? `${CELL_STYLE};${extra}` : CELL_STYLE;
  return `${base};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
}

/**
 * Тело таблицы: каждый контракт — отдельный `<tbody>`.
 *
 * `<tbody>` — единица разрыва страницы в HTML-таблицах. Пока все контракты лежали
 * в одном `<tbody>`, единицы разрыва не было вовсе: блок контракта рвался по
 * строкам как попало, а его шапка могла остаться внизу страницы («висячая» шапка).
 * Заказ владельца 23.11.2026: «если блок контракта не помещается на странице и
 * делится на две — перенести его целиком на следующую страницу».
 *
 * Чего правило не может: блок длиннее страницы (контракт с десятками двигателей)
 * неразрывным не станет — движок всё равно разорвёт. Правило работает для блоков,
 * которые влезают.
 */
function bodiesHtml(model: ProductionProgramPrintModel): string {
  if (model.groups.length === 0) {
    return (
      `<tbody><tr><td colspan="${HEADERS.length}" style="border:1px solid #111827;padding:6px;text-align:center">Строк в плане нет</td></tr></tbody>`
    );
  }
  const bodies: string[] = [];
  for (const group of model.groups) {
    const rows: string[] = [];
    // Шапка группы: организация и номер договора — одна строка на весь план.
    // `break-after: avoid` — не отрывать шапку от своих строк: иначе она уезжает
    // вниз страницы одна, а двигатели — на следующую.
    rows.push(
      `<tr style="background:#f3f4f6;font-weight:700;break-after:avoid;page-break-after:avoid">` +
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
      // «Примечание» — единственная колонка, которой разрешено переноситься:
      // это свободный текст, обрезать его на бумаге нельзя (в нём — причина
      // ошибки строки, см. D-246), поэтому его ужали, но не запретили перенос.
      rows.push(
        `<tr style="${bg}">` +
          `<td style="${oneLineCellStyle('text-align:center')}">${row.orderNo}</td>` +
          `<td style="${oneLineCellStyle()}">${escapeHtml(row.organizationLabel)}</td>` +
          `<td style="${oneLineCellStyle()}">${escapeHtml(
            [row.engineMark, row.engineNumber].filter(Boolean).join(' '),
          )}</td>` +
          `<td style="${oneLineCellStyle()}">${stateCell(row.state)}</td>` +
          `<td style="${oneLineCellStyle()}">${escapeHtml(stageText)}</td>` +
          `<td style="${CELL_STYLE}">${escapeHtml(row.note)}</td>` +
          `</tr>`,
      );
    }
    bodies.push(`<tbody>${rows.join('')}</tbody>`);
  }
  return bodies.join('');
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
  return `<table class="pp-signatures" style="width:100%;border-collapse:collapse;margin-top:14px">${rows.join('')}</table>`;
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
      // Заголовок — одна строка (промт #72): ширины колонок рассчитаны под него,
      // а перенос сделал бы шапку выше и сбил «шапка + строки».
      `<th style="border:1px solid #111827;padding:4px 5px;font-size:${tableSize}pt;text-align:center;white-space:nowrap;${i === 1 || i === 5 ? 'text-align:left' : ''}">${escapeHtml(h)}</th>`,
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
/* Разрывы страниц (владелец 23.11.2026): блок контракта и блок подписей не делятся
   между страницами. Единица разрыва — тело таблицы (tbody, по группе); правило держит
   и строки. Блок длиннее страницы разорвётся всё равно — это не правило, а физика
   листа. */
table.pp-table tbody { break-inside: avoid; page-break-inside: avoid; }
table.pp-table tr { break-inside: avoid; page-break-inside: avoid; }
table.pp-signatures { break-inside: avoid; page-break-inside: avoid; }
table.pp-signatures tr { break-inside: avoid; page-break-inside: avoid; }
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
${bodiesHtml(model)}
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
