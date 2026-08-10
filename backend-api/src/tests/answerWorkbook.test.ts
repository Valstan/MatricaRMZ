import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';

import { buildAnswerWorkbook } from '../services/ai/answerWorkbook.js';

describe('buildAnswerWorkbook', () => {
  it('пишет шапку и строки в том же порядке, что и колонки', async () => {
    const bytes = await buildAnswerWorkbook({
      filename: 'Остатки',
      columns: ['Номенклатура', 'Кол-во'],
      rows: [
        ['Вкладыш коренной', '12'],
        ['Кольцо поршневое', '340'],
      ],
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Ответ');
    expect(ws).toBeDefined();
    expect(ws!.getRow(1).values).toEqual([undefined, 'Номенклатура', 'Кол-во']);
    expect(ws!.getRow(2).values).toEqual([undefined, 'Вкладыш коренной', '12']);
    expect(ws!.getRow(3).values).toEqual([undefined, 'Кольцо поршневое', '340']);
  });

  it('добивает короткие строки пустыми ячейками — сдвига колонок нет', async () => {
    const bytes = await buildAnswerWorkbook({
      filename: 'Пробел',
      columns: ['A', 'B', 'C'],
      rows: [['1'], ['1', '2', '3']],
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Ответ')!;
    expect(ws.getRow(2).getCell(1).value).toBe('1');
    expect(ws.getRow(2).getCell(3).value ?? '').toBe('');
    expect(ws.getRow(3).getCell(3).value).toBe('3');
  });
});
