// Word-вложение к ответу ИИваныча: тот же текст ответа, собранный в .docx,
// прикладывается К КАЖДОМУ ответу по умолчанию (решение владельца 2026-08-17) —
// пользователи открывают его, правят под себя и печатают. Если пользователь
// попросил другой формат и модель уже приложила файл (например .xlsx через
// attach_table), docx не дублируется.
//
// Маркдаун разбирается нарочно примитивно (заголовки, списки, таблицы, жирный
// текст) — этого хватает для ответов ИИваныча, а тянуть полноценный
// markdown-парсер ради вложения незачем.
//
// Совместимость с Word 2007 (стоит у части операторов завода) проверена
// COM-открытием: ширина таблицы только в твипах, пустых таблиц не бывает, текст
// чистится от недопустимых в XML символов. Подробности — у соответствующих мест.
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

const MAX_TABLE_ROWS = 500;
/** Ширина полосы набора A4 в твипах: 11906 − 1440 − 1440 (поля по умолчанию). */
const CONTENT_WIDTH_TWIPS = 9026;

/** Управляющие символы и C1-диапазон, недопустимые в XML 1.0. */
// eslint-disable-next-line no-control-regex -- ровно эти символы мы и вырезаем
const XML_CONTROL_CHARS = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]', 'g');
const XML_LONE_HIGH_SURROGATE = new RegExp('[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])', 'g');
const XML_LONE_LOW_SURROGATE = new RegExp('(^|[^\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]', 'g');

/**
 * Убирает символы, недопустимые в XML 1.0 (управляющие, кроме табуляции и
 * переводов строки, и непарные суррогаты). Ответ движка изредка их содержит, и
 * тогда Word отвергает файл целиком: «Недопустимый знак xml» — проверено
 * COM-открытием 2026-08-17.
 */
function xmlSafe(text: string): string {
  return String(text ?? '')
    .replace(XML_CONTROL_CHARS, '')
    .replace(XML_LONE_HIGH_SURROGATE, '')
    .replace(XML_LONE_LOW_SURROGATE, '$1');
}

function inlineRuns(text: string): TextRun[] {
  // **жирный** — единственный инлайн, который реально встречается в ответах.
  const runs: TextRun[] = [];
  const parts = xmlSafe(text).split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true }));
    } else {
      runs.push(new TextRun({ text: part.replace(/[*_`]/g, '') }));
    }
  }
  return runs.length > 0 ? runs : [new TextRun({ text: xmlSafe(text) })];
}

function tableFromMarkdown(lines: string[]): Table | null {
  const rows = lines
    .map((l) =>
      l
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim()),
    )
    .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
  // Таблица без строк — невалидный <w:tbl>, Word объявляет повреждённым весь файл.
  if (rows.length === 0) return null;
  return new Table({
    // Ширина в ТВИПАХ, не в процентах: Word 2007 не понимает
    // `w:tblW w:type="pct" w:w="100%"` и отказывается открывать документ
    // («Файл поврежден») — воспроизведено COM-открытием 2026-08-17.
    width: { size: CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
    rows: rows.slice(0, MAX_TABLE_ROWS).map(
      (cells, idx) =>
        new TableRow({
          children: (cells.length > 0 ? cells : ['']).map(
            (cell) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: idx === 0 ? [new TextRun({ text: xmlSafe(cell), bold: true })] : inlineRuns(cell),
                  }),
                ],
              }),
          ),
        }),
    ),
  });
}

export async function buildAnswerDocx(args: { question: string; answerMarkdown: string }): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  children.push(new Paragraph({ text: 'Ответ ИИваныча', heading: HeadingLevel.HEADING_1 }));
  const question = xmlSafe(String(args.question ?? '')).trim();
  if (question) {
    children.push(new Paragraph({ children: [new TextRun({ text: `Вопрос: ${question}`, italics: true })] }));
    children.push(new Paragraph({ text: '' }));
  }

  const lines = String(args.answerMarkdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let tableBuf: string[] = [];
  const flushTable = () => {
    if (tableBuf.length > 0) {
      const table = tableFromMarkdown(tableBuf);
      if (table) {
        children.push(table);
        // Абзац после таблицы обязателен: таблица последним элементом секции
        // тоже ломает открытие документа.
        children.push(new Paragraph({ text: '' }));
      }
      tableBuf = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableBuf.push(line.trim());
      continue;
    }
    flushTable();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h?.[1] && h[2] != null) {
      const levels = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
      ] as const;
      children.push(
        new Paragraph({ children: inlineRuns(h[2]), heading: levels[h[1].length - 1] ?? HeadingLevel.HEADING_4 }),
      );
      continue;
    }
    const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li?.[1] != null) {
      children.push(new Paragraph({ children: inlineRuns(li[1]), bullet: { level: 0 } }));
      continue;
    }
    if (!line.trim()) {
      children.push(new Paragraph({ text: '' }));
      continue;
    }
    children.push(new Paragraph({ children: inlineRuns(line) }));
  }
  flushTable();

  const doc = new Document({
    creator: 'ИИваныч',
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
