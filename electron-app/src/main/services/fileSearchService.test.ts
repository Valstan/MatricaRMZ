import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeSearchSource, searchFileSources } from './fileSearchService.js';
import type { FileSearchSource } from '@matricarmz/shared';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrica-file-search-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function makeExcel(path: string, rows: (string | Date)[][]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Лист1');
  for (const row of rows) ws.addRow(row);
  await wb.xlsx.writeFile(path);
}

async function makeDocx(path: string, paragraphs: string[]): Promise<void> {
  const zip = new JSZip();
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(path, buffer);
}

async function source(path: string): Promise<FileSearchSource> {
  return describeSearchSource(path);
}

describe('searchFileSources', () => {
  it('excel: находит строку целиком с наименованиями столбцов', async () => {
    const path = join(dir, 'акты.xlsx');
    await makeExcel(path, [
      ['№ двигателя', 'Контракт', 'Дата прихода'],
      ['41/26', 'Д-100', new Date(2026, 10, 15)],
    ]);
    const result = await searchFileSources([await source(path)], '41/26');
    expect(result.unreadable).toEqual([]);
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    if (!match || match.kind !== 'excel') throw new Error('ожидался excel-match');
    expect(match.rowNumber).toBe(2);
    expect(match.headers).toEqual(['№ двигателя', 'Контракт', 'Дата прихода']);
    expect(match.values[2]).toBe('15.11.2026');
  });

  it('файл изменён на диске — следующий поиск видит свежую версию', async () => {
    const path = join(dir, 'акты.xlsx');
    await makeExcel(path, [['№ двигателя'], ['41/26']]);
    const first = await searchFileSources([await source(path)], '77/26');
    expect(first.matches).toHaveLength(0);

    await makeExcel(path, [['№ двигателя'], ['77/26']]);
    const second = await searchFileSources([await source(path)], '77/26');
    expect(second.matches).toHaveLength(1);
  });

  it('недоступный файл: путь и требование открыть заново, поиск по остальным продолжается', async () => {
    const good = join(dir, 'акты.xlsx');
    await makeExcel(good, [['№ двигателя'], ['41/26']]);
    const missing = join(dir, 'нет-такого.xlsx');
    const result = await searchFileSources([await source(missing), await source(good)], '41/26');
    expect(result.matches).toHaveLength(1);
    expect(result.unreadable).toHaveLength(1);
    const unreadable = result.unreadable[0];
    if (!unreadable) throw new Error('ожидалась запись о недоступном файле');
    expect(unreadable.path).toBe(missing);
    expect(unreadable.reason).toContain('откройте его заново');
  });

  it('word: находит абзац и помечает, что ниже есть текст', async () => {
    const path = join(dir, 'акт.docx');
    await makeDocx(path, ['Акт по двигателю 41/26 от 15.11.2026', 'Подпись мастера']);
    const result = await searchFileSources([await source(path)], '41/26');
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    if (!match || match.kind !== 'word') throw new Error('ожидался word-match');
    expect(match.text).toContain('41/26');
    expect(match.hasMoreBelow).toBe(true);
  });

  it('текстовый файл ищется по строкам', async () => {
    const path = join(dir, 'notes.txt');
    writeFileSync(path, 'первая строка\nдвигатель 41/26\nтретья строка\n', 'utf8');
    const result = await searchFileSources([await source(path)], '41/26');
    expect(result.matches).toHaveLength(1);
    const textMatch = result.matches[0];
    if (!textMatch) throw new Error('ожидался текстовый match');
    expect(textMatch.kind).toBe('text');
  });

  it('пустой запрос не читает файлы', async () => {
    const path = join(dir, 'акты.xlsx');
    await makeExcel(path, [['№ двигателя'], ['41/26']]);
    const result = await searchFileSources([await source(path)], '   ');
    expect(result.matches).toEqual([]);
    expect(result.scannedFiles).toBe(0);
  });
});

describe('describeSearchSource', () => {
  it('не поддерживаемый формат — понятный отказ', async () => {
    const path = join(dir, 'акты.xls');
    writeFileSync(path, 'x', 'utf8');
    await expect(describeSearchSource(path)).rejects.toThrow(/не поддерживается/);
  });
});
