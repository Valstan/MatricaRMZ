/**
 * Выгрузка печатной формы карточки (наряд, акт, табель) в Word.
 *
 * Модель формы живёт в рендерере и отдаёт секции HTML — тем же секциям уходит и печать,
 * поэтому файл собирается из них, а не из второго описания формы: разъехавшийся с листом
 * второй сборщик пришлось бы чинить дважды (и он бы разошёлся — проверено на списках).
 * HTML здесь разбирается крохотным подмножеством: `div/p/h*`, таблицы `table/tr/th/td`,
 * `span`, `br` и подсказки инлайновых стилей (кегль, жирность, выравнивание, подчёркивание
 * подписной линии). Незнакомые теги не ломают разбор — их текст остаётся, тег отбрасывается.
 *
 * Чего избегаем сознательно: точной копии печатного листа. Word не понимает CSS-классов,
 * из которых у форм берутся ширины колонок, поэтому таблицы отдаются ему на автораскладку —
 * содержимое и порядок блоков те же, геометрия может отличаться.
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
type Cell = { runs: Run[]; bold: boolean };
type TableBlock = { kind: 'table'; head: Cell[][]; body: Cell[][]; bordered: boolean };
type Block = ParagraphBlock | TableBlock;

type InlineStyle = { bold: boolean; sizePx: number | null; underline: boolean };

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

function alignOf(style: Record<string, string>, tag: string, isHeaderCell: boolean): Align {
  const v = String(style['text-align'] ?? '');
  if (v === 'center' || v === 'right') return v;
  if (isHeaderCell || tag === 'th') return 'center';
  return 'left';
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4']);

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
    row: Cell[] | null;
    cell: Cell | null;
    inHead: boolean;
  } | null = null;

  const inlineStyle = (): InlineStyle => inline[inline.length - 1] ?? { bold: false, sizePx: null, underline: false };

  const flushParagraph = () => {
    if (paragraph && paragraph.runs.length > 0) blocks.push(paragraph);
    paragraph = null;
  };

  const pushText = (text: string, raw = false) => {
    // Синтетическую подписную линию нельзя ни схлопывать, ни считать пустым текстом:
    // она и есть текст — неразрывные пробелы с подчёркиванием.
    const clean = raw ? text : text.replace(/\s+/g, ' ');
    if (!raw && clean.trim() === '') return;
    const st = inlineStyle();
    if (table) {
      if (!table.row) table.row = [];
      table.cell ??= { runs: [], bold: false };
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
    if (m.index > lastIndex) pushText(source.slice(lastIndex, m.index));
    lastIndex = m.index + m[0].length;

    const closing = m[0].startsWith('</');
    const tag = m[1]!.toLowerCase();
    const attrs = closing ? {} : attrsOf(m[2] ?? '');
    const style = closing ? {} : styleOf(attrs);

    if (closing) {
      if (tag === 'td' || tag === 'th') {
        if (table && table.row) {
          table.row.push(table.cell ?? { runs: [], bold: tag === 'th' });
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
        if (table) {
          if (table.row && table.row.length > 0) (table.inHead ? table.head : table.body).push(table.row);
          if (table.head.length > 0 || table.body.length > 0) {
            blocks.push({ kind: 'table', head: table.head, body: table.body, bordered: table.bordered });
          }
          table = null;
        }
      } else if (tag === 'div' || tag === 'p' || HEADINGS.has(tag)) {
        flushParagraph();
      } else if (tag === 'span' || tag === 'b' || tag === 'strong' || tag === 'u' || tag === 'i' || tag === 'em') {
        inline.pop();
      }
      continue;
    }

    if (tag === 'br') {
      flushParagraph();
    } else if (tag === 'table') {
      flushParagraph();
      table = { head: [], body: [], bordered: true, row: null, cell: null, inHead: false };
    } else if (tag === 'thead') {
      if (table) table.inHead = true;
    } else if (tag === 'tbody') {
      if (table) table.inHead = false;
    } else if (tag === 'tr') {
      if (table) table.row = [];
    } else if (tag === 'td' || tag === 'th') {
      if (table && table.row) table.cell = { runs: [], bold: tag === 'th' };
    } else if (tag === 'div' || tag === 'p' || HEADINGS.has(tag)) {
      flushParagraph();
      const isHeading = HEADINGS.has(tag);
      paragraph = {
        kind: 'paragraph',
        runs: [],
        align: alignOf(style, tag, false),
        muted: String(attrs.class ?? '').includes('muted'),
        bold: isHeading || boldOf(style),
        sizePx: sizeOf(style),
      };
    } else if (tag === 'span' || tag === 'b' || tag === 'strong' || tag === 'u' || tag === 'i' || tag === 'em') {
      const parent = inlineStyle();
      inline.push({
        bold: parent.bold || tag === 'b' || tag === 'strong' || boldOf(style),
        sizePx: sizeOf(style) ?? parent.sizePx,
        underline: parent.underline || tag === 'u' || String(style['border-bottom'] ?? '') !== '',
      });
      // Подписная линия — пустой span с нижней границей: без текста её в Word не нарисовать.
      if (String(style['border-bottom'] ?? '') !== '') pushText(SIGNATURE_LINE, true);
    }
  }
  if (lastIndex < source.length) pushText(source.slice(lastIndex));
  flushParagraph();
  if (table) {
    if (table.row && table.row.length > 0) (table.inHead ? table.head : table.body).push(table.row);
    if (table.head.length > 0 || table.body.length > 0) {
      blocks.push({ kind: 'table', head: table.head, body: table.body, bordered: table.bordered });
    }
  }
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

function cellOf(cell: Cell): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        children: textRuns(cell.runs, false).map((run) => run),
        ...(cell.bold ? { alignment: AlignmentType.CENTER } : {}),
      }),
    ],
  });
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
      alignment:
        block.align === 'center' ? AlignmentType.CENTER : block.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { after: 60 },
    });
  }
  const rows = [
    ...block.head.map((cells) => new TableRow({ tableHeader: true, children: cells.map(cellOf) })),
    ...block.body.map((cells) => new TableRow({ children: cells.map(cellOf) })),
  ];
  return new Table({
    width: { size: CONTENT_TWIPS, type: WidthType.DXA },
    layout: TableLayoutType.AUTOFIT,
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
