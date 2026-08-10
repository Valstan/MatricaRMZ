// Excel-вложение к ответу ИИваныча: движок отдаёт таблицу структурой (tool attach_table),
// сервер собирает из неё .xlsx. Без этого прямой режим потерял бы файловые ответы,
// которые умела облачная рутина.
import ExcelJS from 'exceljs';

export type AnswerTable = {
  filename: string;
  columns: string[];
  rows: string[][];
};

const MAX_ROWS = 5_000;
const MAX_COL_WIDTH = 60;

export async function buildAnswerWorkbook(table: AnswerTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ИИваныч';
  const ws = wb.addWorksheet('Ответ');

  ws.addRow(table.columns).font = { bold: true };
  for (const row of table.rows.slice(0, MAX_ROWS)) {
    ws.addRow(table.columns.map((_, i) => row[i] ?? ''));
  }

  table.columns.forEach((title, i) => {
    const longest = table.rows.slice(0, MAX_ROWS).reduce((max, r) => Math.max(max, String(r[i] ?? '').length), title.length);
    ws.getColumn(i + 1).width = Math.min(MAX_COL_WIDTH, Math.max(10, longest + 2));
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}
