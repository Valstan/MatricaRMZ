import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import type { ListExportSpec } from '@matricarmz/shared';

import { buildListDocument, buildListWorkbook, exportFileExtension } from './listExportService.js';

const SPEC: ListExportSpec = {
  title: 'Список двигателей',
  filters: ['Вид работ: Укладка вала', 'Поиск: «вал»'],
  meta: 'Выгружено: 19.10.2026 05:12',
  columnWidthsMm: [8, 60, 40, 40, 40, 40, 45],
  columns: [
    { label: '№', kind: 'number' },
    { label: 'Двигатель', kind: 'text' },
    { label: 'Дата этапа', kind: 'date' },
    { label: 'Вид работ', kind: 'text' },
    { label: 'Цех', kind: 'text' },
    { label: 'Наряд', kind: 'text' },
    { label: 'Сумма', kind: 'number' },
  ],
  rows: [
    ['1', '41/26', '19.10.2026', 'Укладка вала', 'Сборка', 'СБ-12', '1 234,56'],
    ['2', '42/26', '19.10.2026 14:30', 'Шлифовка', 'Механика', 'СБ-13', '—'],
    ['3', '007', '31.02.2026', 'Контроль', 'ОТК', '—', '980'],
  ],
  fileBaseName: 'Список двигателей',
};

async function sheetXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const sheet = zip.file('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('в книге нет листа');
  return sheet.async('string');
}

/**
 * Книга, открытая exceljs заново. Собранный файл обязан читаться тем же движком, что его писал, —
 * это единственная проверка «это правда книга», которую можно сделать без Office.
 */
async function reopenWorkbook(spec: ListExportSpec): Promise<ExcelJS.Worksheet> {
  const bytes = await buildListWorkbook(spec);
  const workbook = new ExcelJS.Workbook();
  // exceljs объявляет Buffer как `interface Buffer extends ArrayBuffer`, а Node-овский Buffer —
  // это view над буфером, поэтому отдаём сам ArrayBuffer.
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await workbook.xlsx.load(arrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('лист не открылся');
  return sheet;
}

describe('выгрузка списка в Excel', () => {
  it('шапка, отбор и первая колонка «№» на месте', async () => {
    const sheet = await reopenWorkbook(SPEC);
    const values = (row: number) =>
      sheet.getRow(row).values instanceof Array ? (sheet.getRow(row).values as unknown[]).slice(1) : [];

    expect(sheet.getCell('A1').value).toBe('Список двигателей');
    expect(sheet.getCell('A2').value).toBe('Вид работ: Укладка вала');
    expect(sheet.getCell('A3').value).toBe('Поиск: «вал»');
    expect(sheet.getCell('A4').value).toBe('Выгружено: 19.10.2026 05:12');
    expect(values(6)).toEqual(['№', 'Двигатель', 'Дата этапа', 'Вид работ', 'Цех', 'Наряд', 'Сумма']);
    expect(sheet.getCell('A7').value).toBe(1);
    expect(values(7)[1]).toBe('41/26');
  });

  it('числа и даты уходят значениями, а не текстом', async () => {
    const xml = await sheetXml(await buildListWorkbook(SPEC));
    // Сумма — число: в Excel по колонке считается СУММ, а не склеивается текст.
    expect(xml).toContain('<v>1234.56</v>');
    // 19.10.2026 — дата: порядковый номер Excel, а не строка.
    const dateCell = /<c r="C7"[^>]*>([\s\S]*?)<\/c>/.exec(xml)?.[1] ?? '';
    expect(dateCell).toContain('<v>');
    expect(dateCell).not.toContain('t="s"');
    expect(dateCell).not.toContain('19.10.2026');
  });

  it('неразобранное остаётся текстом и не превращается в мусор', async () => {
    const sheet = await reopenWorkbook(SPEC);
    // «Артикул» из одних цифр остаётся текстом — нули не теряются.
    expect(sheet.getCell('B9').value).toBe('007');
    // «31.02.2026» не существует: в дату не превращаем и в соседний день не сдвигаем.
    expect(sheet.getCell('C9').value).toBe('31.02.2026');
    // Прочерк вместо суммы — текст, как и на экране.
    expect(sheet.getCell('G8').value).toBe('—');
  });

  it('форматы чисел и дат описаны в стилях книги', async () => {
    const zip = await JSZip.loadAsync(await buildListWorkbook(SPEC));
    const styles = await zip.file('xl/styles.xml')?.async('string');
    expect(styles).toBeDefined();
    expect(styles).toContain('#,##0.###');
    expect(styles).toContain('dd.mm.yyyy');
  });

  it('шапка закреплена и включён автофильтр', async () => {
    const xml = await sheetXml(await buildListWorkbook(SPEC));
    // Закреплены и шапка, и строки отбора над ней: при прокрутке видно, чей это список.
    expect(xml).toMatch(/<pane[^>]*state="frozen"/);
    expect(xml).toMatch(/<pane[^>]*ySplit="6"/);
    expect(xml).toContain('<autoFilter ref="A6:G9"');
  });
});

async function documentXml(spec: ListExportSpec): Promise<string> {
  const zip = await JSZip.loadAsync(await buildListDocument(spec));
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('в документе нет word/document.xml');
  return xml;
}

describe('выгрузка списка в Word', () => {
  it('ширины таблицы — в твипах: проценты Word 2007 не понимает (M80)', async () => {
    const xml = await documentXml(SPEC);
    expect(xml).toContain('w:type="dxa"');
    expect(xml).not.toContain('w:type="pct"');
  });

  it('сумма колонок сходится с шириной таблицы', async () => {
    const xml = await documentXml(SPEC);
    const tableWidth = /<w:tblW w:type="dxa" w:w="(\d+)"\/>/.exec(xml)?.[1];
    const columns = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
    expect(tableWidth).toBeDefined();
    expect(columns).toHaveLength(SPEC.columns.length);
    expect(columns.reduce((sum, w) => sum + w, 0)).toBe(Number(tableWidth));
    // Ширины берутся от планировщика печати, а не делятся поровну: «№» уже «Двигателя».
    expect(columns[0]).toBeLessThan(columns[1]!);
  });

  it('документ не кончается таблицей — иначе Word объявляет файл повреждённым', async () => {
    const xml = await documentXml(SPEC);
    expect(xml.indexOf('</w:tbl>')).toBeGreaterThan(-1);
    expect(xml.slice(xml.lastIndexOf('</w:tbl>'))).toContain('<w:p');
  });

  it('содержимое списка и отбор попадают в документ', async () => {
    const xml = await documentXml(SPEC);
    expect(xml).toContain('Список двигателей');
    expect(xml).toContain('Поиск: «вал»');
    expect(xml).toContain('41/26');
    expect(xml).toContain('1 234,56');
  });

  it('управляющие символы не доезжают до XML', async () => {
    const xml = await documentXml({
      ...SPEC,
      rows: [['1', 'двигатель\u0001с\u0008 браком', '19.10.2026', 'Укладка', 'Сборка', 'СБ-1', '10']],
    });
    expect(xml).toContain('двигательс браком');
    for (const code of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x1f]) {
      expect(xml, `в документе остался управляющий символ U+${code.toString(16).padStart(4, '0')}`).not.toContain(
        String.fromCharCode(code),
      );
    }
  });

  it('широкий список печатается альбомной страницей', async () => {
    const xml = await documentXml(SPEC);
    expect(xml).toContain('<w:pgSz w:w="16838" w:h="11906"');
  });

  it('без ширин от планировщика таблица всё равно собирается', async () => {
    const { columnWidthsMm: _drop, ...noWidths } = SPEC;
    const xml = await documentXml(noWidths);
    expect(xml).toContain('w:type="dxa"');
    expect(xml).not.toContain('w:type="pct"');
  });

  it('в списке без колонок отказываем честно, а не собираем пустой файл', async () => {
    await expect(buildListDocument({ ...SPEC, columns: [], rows: [] })).rejects.toThrow(/колонк/);
    await expect(buildListWorkbook({ ...SPEC, columns: [], rows: [] })).rejects.toThrow(/колонк/);
  });
});

describe('расширение файла', () => {
  it('соответствует формату', () => {
    expect(exportFileExtension('xlsx')).toBe('.xlsx');
    expect(exportFileExtension('docx')).toBe('.docx');
  });
});
