// Word-вложение к ответу ИИваныча: тот же текст ответа, собранный в .docx,
// прикладывается К КАЖДОМУ ответу по умолчанию (решение владельца 2026-08-17) —
// пользователи открывают его, правят под себя и печатают. Если пользователь
// попросил другой формат и модель уже приложила файл (например .xlsx через
// attach_table), docx не дублируется.
//
// Маркдаун разбирается нарочно примитивно (заголовки, списки, таблицы, жирный
// текст) — этого хватает для ответов ИИваныча, а тянуть полноценный
// markdown-парсер ради вложения незачем.
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

const MAX_TABLE_ROWS = 500;

function inlineRuns(text: string): TextRun[] {
  // **жирный** — единственный инлайн, который реально встречается в ответах.
  const runs: TextRun[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true }));
    } else {
      runs.push(new TextRun({ text: part.replace(/[*_`]/g, '') }));
    }
  }
  return runs.length > 0 ? runs : [new TextRun({ text })];
}

function tableFromMarkdown(lines: string[]): Table {
  const rows = lines
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.slice(0, MAX_TABLE_ROWS).map(
      (cells, idx) =>
        new TableRow({
          children: cells.map(
            (cell) =>
              new TableCell({
                children: [new Paragraph({ children: idx === 0 ? [new TextRun({ text: cell, bold: true })] : inlineRuns(cell) })],
              }),
          ),
        }),
    ),
  });
}

export async function buildAnswerDocx(args: { question: string; answerMarkdown: string }): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  children.push(new Paragraph({ text: 'Ответ ИИваныча', heading: HeadingLevel.HEADING_1 }));
  if (args.question.trim()) {
    children.push(new Paragraph({ children: [new TextRun({ text: `Вопрос: ${args.question.trim()}`, italics: true })] }));
    children.push(new Paragraph({ text: '' }));
  }

  const lines = args.answerMarkdown.replace(/\r\n/g, '\n').split('\n');
  let tableBuf: string[] = [];
  const flushTable = () => {
    if (tableBuf.length > 0) {
      children.push(tableFromMarkdown(tableBuf));
      children.push(new Paragraph({ text: '' }));
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
      const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4] as const;
      children.push(new Paragraph({ children: inlineRuns(h[2]), heading: levels[h[1].length - 1] ?? HeadingLevel.HEADING_4 }));
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
