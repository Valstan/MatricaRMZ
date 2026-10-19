/**
 * Выгрузка печатной формы карточки (наряд, акт, табель) в Word.
 *
 * Модель формы живёт в рендерере и отдаёт секции HTML — тем же секциям уходит и печать,
 * поэтому файл собирается из них, а не из второго описания формы: разъехавшийся с листом
 * второй сборщик пришлось бы чинить дважды (и он бы разошёлся — проверено на списках).
 * HTML здесь разбирается крохотным подмножеством: `div/p/h*`, таблицы `table/tr/th/td`,
 * `span`, `br`, сущности (`&nbsp;`) и подсказки стилей — инлайновых (кегль, жирность, выравнивание,
 * подчёркивание подписной линии, ширина колонки) и классовых там, где класс называет смысл,
 * а не оформление (`num` — числа вправо, `ctr` — по центру, `muted`). Незнакомые теги не ломают
 * разбор — их текст остаётся, тег отбрасывается. Содержимое `style`/`script`/`head`/`title`/`button`
 * отбрасывается целиком: у актов на выгрузку приходит **целый печатный лист**, а CSS-тексту
 * и экранной кнопке «Печать» в документе места нет.
 *
 * Геометрия: ширины колонок берём из процентов, объявленных самой формой
 * (`<th style="width:34%">` — это пропорции листа), таблицы без единой ширины отдаются Word
 * на автораскладку. Полной копии листа не обещаем: Word не понимает CSS-классов, поэтому кегль
 * и отступы блоков, оформленные только классом, могут отличаться.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import type { CardExportSection, CardExportSpec } from '@matricarmz/shared';

import { APP_NAME, MARGIN_TWIPS, PAGE_TWIPS, xmlSafe } from './exportCommon.js';

const CONTENT_TWIPS = PAGE_TWIPS.portrait.width - MARGIN_TWIPS * 2;
const BORDER_COLOR = '999999';
/** Подписная линия — неразрывные пробелы с подчёркиванием: в Word это и есть линия для росписи. */
const SIGNATURE_LINE = '\u00A0'.repeat(20);

type Align = 'left' | 'center' | 'right';
type Run = { text: string; bold: boolean; sizePx: number | null; underline: boolean };
type ParagraphBlock = { kind: 'paragraph'; runs: Run[]; align: Align; muted: boolean; bold: boolean; sizePx: number | null };
type Cell = { runs: Run[]; bold: boolean; colspan: number; align: Align | null };
type TableBlock = { kind: 'table'; head: Cell[][]; body: Cell[][]; bordered: boolean; widths: number[] };
type Block = ParagraphBlock | TableBlock;

type InlineStyle = { bold: boolean; sizePx: number | null; underline: boolean; text: boolean; line: boolean };

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out[m[1]!.toLowerCase()] = m[3] ?? m[4] ?? '';
  return out;
}

function styleOf(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(attrs.style ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim().toLowerCase();
  }
  return out;
}

function sizeOf(style: Record<string, string>): number | null {
  const v = Number.parseFloat(String(style['font-size'] ?? ''));
  return Number.isFinite(v) ? v : null;
}

function boldOf(style: Record<string, string>): boolean {
  return /^(bold|[6-9]00)$/.test(String(style['font-weight'] ?? ''));
}

function alignOf(style: Record<string, string>, tag: string): Align {
  const v = String(style['text-align'] ?? '');
  if (v === 'center' || v === 'right') return v;
  // Заголовок печатных форм центрируется классом — в документе центр задаём тегом.
  return tag === 'h1' ? 'center' : 'left';
}

/** Выравнивание ячейки: инлайн важнее классовой подсказки, дальше — шапка по центру. */
function cellAlignOf(style: Record<string, string>, isHeader: boolean, className: string): Align | null {
  const v = String(style['text-align'] ?? '');
  if (v === 'center' || v === 'right' || v === 'left') return v;
  const tokens = className.split(/\s+/);
  if (tokens.includes('num')) return 'right';
  if (tokens.includes('ctr')) return 'center';
  return isHeader ? 'center' : null;
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4']);

/**
 * Теги, содержимое которых в документ не переносим. У актов на выгрузку приходит целый печатный
 * лист: `<head><style>` со стилями, `<title>` и кнопка «Печать / PDF» в теле. Текст оттуда —
 * не содержимое формы, и в Word он попал бы мусором (это и была первая поломка актов).
 */
const SKIP_CONTAINERS = new Set(['style', 'script', 'head', 'title', 'button']);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  deg: '°',
};

/** Разметку форм пишет `escapeHtml`, поэтому в тексте живут сущности (`&#039;`, `&nbsp;`).
 *  В Word они должны прийти символами: второй сборщик текста, который бы их разворачивал,
 *  расходился бы с этим. Неизвестную сущность оставляем как есть — молча портить её хуже. */
function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body.startsWith('#x') || body.startsWith('#X');
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code)) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Кегль заголовка, когда форма задала его только классом: у печатных актов `h1` — 17px. */
function headingPx(tag: string): number {
  return tag === 'h1' ? 17 : tag === 'h2' ? 15 : 14;
}

/** Доля ширины из инлайнового `width:N%`: так формы объявляют пропорции колонок для печати. */
function percentOf(style: Record<string, string>): number | null {
  const m = /^([\d.]+)%$/.exec(String(style.width ?? '').trim());
  const v = m ? Number.parseFloat(m[1]!) : Number.NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Ширины колонок таблицы в процентах. Объявленные формы приводятся к 100% (пропорции листа
 * сохраняются), недостающие колонки делят остаток; если не объявлено ни одной — таблица уходит
 * Word на автораскладку (`null`).
 */
function resolveColumnWidths(declared: readonly (number | null)[], columns: number): number[] | null {
  const widths = Array.from({ length: columns }, (_, i) => declared[i] ?? null);
  const known = widths.filter((v): v is number => v !== null && v > 0);
  if (known.length === 0) return null;
  const sum = known.reduce((a, b) => a + b, 0);
  const missing = widths.length - known.length;
  if (missing === 0) return widths.map((v) => ((v as number) * 100) / sum);
  const rest = 100 - sum;
  if (rest <= 0) return null;
  const share = rest / missing;
  return widths.map((v) => (v !== null && v > 0 ? v : share));
}

/** Разбор подмножества HTML: линейный проход по тегам, текст складывается в абзацы или ячейки. */
export function parseCardHtml(html: string): Block[] {
  const blocks: Block[] = [];
  const inline: InlineStyle[] = [];
  const source = String(html ?? '');

  let paragraph: ParagraphBlock | null = null;
  let table: {
    head: Cell[][];
    body: Cell[][];
    bordered: boolean;
    widths: (number | null)[];
    row: Cell[] | null;
    cell: Cell | null;
    inHead: boolean;
  } | null = null;
  /** Глубина отброшенного контейнера: внутри него не читаем ни теги, ни текст. */
  let skipDepth = 0;

  const emptyInline = (): InlineStyle => ({ bold: false, sizePx: null, underline: false, text: false, line: false });
  const inlineStyle = (): InlineStyle => inline[inline.length - 1] ?? emptyInline();

  const flushParagraph = () => {
    if (paragraph && paragraph.runs.length > 0) blocks.push(paragraph);
    paragraph = null;
  };

  const newCell = (bold: boolean): Cell => ({ runs: [], bold, colspan: 1, align: null });

  const flushTable = () => {
    if (!table) return;
    if (table.row && table.row.length > 0) (table.inHead ? table.head : table.body).push(table.row);
    const { head, body } = table;
    if (head.length > 0 || body.length > 0) {
      const columns = Math.max(...[...head, ...body].map((row) => row.reduce((n, c) => n + Math.max(1, c.colspan), 0)));
      blocks.push({
        kind: 'table',
        head,
        body,
        bordered: table.bordered,
        widths: resolveColumnWidths(table.widths, columns) ?? [],
      });
    }
    table = null;
  };

  const pushText = (text: string, raw = false, forced?: InlineStyle) => {
    // Синтетическую подписную линию нельзя ни схлопывать, ни считать пустым текстом:
    // она и есть текст — неразрывные пробелы с подчёркиванием. Сущности разворачиваются
    // после схлопывания пробелов, чтобы `&nbsp;` не стал обычным пробелом.
    const clean = raw ? text : decodeEntities(text.replace(/\s+/g, ' '));
    if (!raw && clean.trim() === '') return;
    const st = forced ?? inlineStyle();
    for (const frame of inline) frame.text = true;
    if (table) {
      if (!table.row) table.row = [];
      table.cell ??= newCell(false);
      table.cell.runs.push({ text: clean, bold: st.bold, sizePx: st.sizePx, underline: st.underline });
      return;
    }
    paragraph ??= { kind: 'paragraph', runs: [], align: 'left', muted: false, bold: false, sizePx: null };
    paragraph.runs.push({
      text: clean,
      bold: paragraph.bold || st.bold,
      sizePx: st.sizePx ?? paragraph.sizePx,
      underline: st.underline,
    });
  };

  let lastIndex = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(source)) !== null) {
    const closing = m[0].startsWith('</');
    const tag = m[1]!.toLowerCase();
    const skipping = skipDepth > 0;
    if (!skipping && m.index > lastIndex) pushText(source.slice(lastIndex, m.index));
    lastIndex = m.index + m[0].length;

    if (skipping || SKIP_CONTAINERS.has(tag)) {
      if (SKIP_CONTAINERS.has(tag)) skipDepth = Math.max(0, skipDepth + (closing ? -1 : 1));
      // Отбрасываемый контейнер обрывает абзац: текст до кнопки и после неё — разные абзацы.
      if (!skipping && !closing) flushParagraph();
      continue;
    }

    const attrs = closing ? {} : attrsOf(m[2] ?? '');
    const style = closing ? {} : styleOf(attrs);
    const isInlineTag = tag === 'span' || tag === 'b' || tag === 'strong' || tag === 'u' || tag === 'i' || tag === 'em';

    if (closing) {
      if (tag === 'td' || tag === 'th') {
        if (table && table.row) {
          table.row.push(table.cell ?? newCell(tag === 'th'));
          table.cell = null;
        }
      } else if (tag === 'tr') {
        if (table && table.row) {
          (table.inHead ? table.head : table.body).push(table.row);
          table.row = null;
        }
      } else if (tag === 'thead' || tag === 'tbody') {
        if (table) table.inHead = false;
      } else if (tag === 'table') {
        flushTable();
      } else if (tag === 'div' || tag === 'p' || HEADINGS.has(tag)) {
        flushParagraph();
      } else if (isInlineTag) {
        const frame = inline.pop();
        // Подписную линию в Word рисует только подчёркнутый текст: у пустого span с нижней
        // границей появляется заполнитель, а у заполненного (ФИО, дата) значение в строке
        // уже есть — линии поверх него не место.
        if (frame?.line && !frame.text) pushText(SIGNATURE_LINE, true, { ...frame, underline: true });
      }
      continue;
    }

    if (tag === 'br') {
      flushParagraph();
    } else if (tag === 'table') {
      flushParagraph();
      table = { head: [], body: [], bordered: true, widths: [], row: null, cell: null, inHead: false };
    } else if (tag === 'thead') {
      if (table) table.inHead = true;
    } else if (tag === 'tbody') {
      if (table) table.inHead = false;
    } else if (tag === 'tr') {
      if (table) table.row = [];
    } else if (tag === 'td' || tag === 'th') {
      if (table && table.row) {
        const isHeader = tag === 'th';
        table.cell = {
          runs: [],
          bold: isHeader,
          colspan: Math.max(1, Number.parseInt(String(attrs.colspan ?? '1'), 10) || 1),
          align: cellAlignOf(style, isHeader, String(attrs.class ?? '')),
        };
        const pct = percentOf(style);
        if (pct !== null && table.widths[table.row.length] == null) table.widths[table.row.length] = pct;
      }
    } else if (tag === 'div' || tag === 'p' || HEADINGS.has(tag)) {
      flushParagraph();
      const isHeading = HEADINGS.has(tag);
      paragraph = {
        kind: 'paragraph',
        runs: [],
        align: alignOf(style, tag),
        muted: String(attrs.class ?? '').includes('muted'),
        bold: isHeading || boldOf(style),
        sizePx: sizeOf(style) ?? (isHeading ? headingPx(tag) : null),
      };
    } else if (isInlineTag) {
      const parent = inlineStyle();
      const borderBottom =
        String(style['border-bottom'] ?? '') !== '' || String(style['border-bottom-width'] ?? '') !== '';
      inline.push({
        bold: parent.bold || tag === 'b' || tag === 'strong' || boldOf(style),
        sizePx: sizeOf(style) ?? parent.sizePx,
        underline: parent.underline || tag === 'u' || borderBottom,
        text: false,
        line: borderBottom,
      });
    }
  }
  if (lastIndex < source.length) pushText(source.slice(lastIndex));
  flushParagraph();
  flushTable();
  return blocks;
}

function halfPoints(sizePx: number | null): number {
  if (sizePx === null) return 20;
  if (sizePx <= 12) return 18;
  if (sizePx <= 15) return 20;
  if (sizePx <= 18) return 24;
  return 28;
}

function textRuns(runs: readonly Run[], muted: boolean): TextRun[] {
  return runs.map(
    (r) =>
      new TextRun({
        text: xmlSafe(r.text),
        size: halfPoints(r.sizePx),
        ...(r.bold ? { bold: true } : {}),
        ...(r.underline ? { underline: {} } : {}),
        ...(muted ? { color: '666666', italics: true } : {}),
      }),
  );
}

/** Ширины колонок таблицы в twips: проценты форм переводятся в печатную область A4 портрет. */
function columnTwips(block: TableBlock): number[] | null {
  const widths = block.widths;
  if (widths.length === 0) return null;
  const total = widths.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  // Нижний порог — чтобы вырожденное объявление (`width:0.1%`) не дало невидимую колонку.
  return widths.map((p) => Math.max(240, Math.round((CONTENT_TWIPS * p) / total)));
}

function alignmentOf(align: Align) {
  return align === 'center' ? AlignmentType.CENTER : align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
}

function cellOf(cell: Cell, widthTwips: number | null): TableCell {
  const align = cell.align ?? (cell.bold ? 'center' : 'left');
  return new TableCell({
    ...(widthTwips ? { width: { size: widthTwips, type: WidthType.DXA } } : {}),
    ...(cell.colspan > 1 ? { columnSpan: cell.colspan } : {}),
    children: [new Paragraph({ children: textRuns(cell.runs, false), alignment: alignmentOf(align) })],
  });
}

/** Строка таблицы: ширина ячейки — сумма колонок, которые она накрывает (`colspan`). */
function tableRowOf(cells: Cell[], widths: number[] | null, header: boolean): TableRow {
  const children: TableCell[] = [];
  let column = 0;
  for (const cell of cells) {
    const span = Math.max(1, cell.colspan);
    children.push(cellOf(cell, widths ? widths.slice(column, column + span).reduce((a, b) => a + b, 0) : null));
    column += span;
  }
  return new TableRow({ ...(header ? { tableHeader: true } : {}), children });
}

const BORDERED = {
  top: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
  bottom: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
  left: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
  right: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
  insideVertical: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
} as const;

function documentChild(block: Block): Paragraph | Table {
  if (block.kind === 'paragraph') {
    return new Paragraph({
      children: textRuns(block.runs, block.muted),
      alignment: alignmentOf(block.align),
      spacing: { after: 60 },
    });
  }
  // Ширины объявила сама форма (пропорции листа) — держим их жёстко; иначе таблица
  // уходит Word на автораскладку, как и раньше.
  const widths = columnTwips(block);
  const rows = [
    ...block.head.map((cells) => tableRowOf(cells, widths, true)),
    ...block.body.map((cells) => tableRowOf(cells, widths, false)),
  ];
  return new Table({
    width: { size: CONTENT_TWIPS, type: WidthType.DXA },
    layout: widths ? TableLayoutType.FIXED : TableLayoutType.AUTOFIT,
    ...(widths ? { columnWidths: widths } : {}),
    ...(block.bordered ? { borders: BORDERED } : {}),
    rows,
  });
}

export async function buildCardDocument(spec: CardExportSpec): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  for (const section of spec.sections as CardExportSection[]) {
    if (!section.hideTitle && String(section.title ?? '').trim() !== '') {
      children.push(
        new Paragraph({ children: [new TextRun({ text: xmlSafe(section.title), bold: true, size: 24 })], spacing: { after: 80 } }),
      );
    }
    for (const block of parseCardHtml(section.html)) children.push(documentChild(block));
    if (children.length > 0 && children[children.length - 1] instanceof Table) children.push(new Paragraph({ text: '' }));
  }
  // Пустой абзац в конце обязателен и после таблицы, и у документа, кончающегося таблицей (M80).
  children.push(new Paragraph({ text: '' }));

  const doc = new Document({
    creator: APP_NAME,
    title: xmlSafe(spec.title),
    sections: [
      {
        properties: {
          page: { size: PAGE_TWIPS.portrait, margin: { top: MARGIN_TWIPS, bottom: MARGIN_TWIPS, left: MARGIN_TWIPS, right: MARGIN_TWIPS } },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
