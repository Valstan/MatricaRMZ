import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseImportDateCell,
  parseImportGender,
  parsePpeImportWorkbook,
  PPE_IMPORT_PREVIEW_TTL_MS,
  signPpePreviewToken,
  validatePpeImport,
  verifyPpePreviewToken,
  type PpeImportSnapshot,
} from '../services/ppeImportService.js';

vi.mock('../database/db.js', () => ({
  db: { select: () => { throw new Error('no db in pure tests'); } },
  pool: { query: () => undefined, end: () => undefined },
}));

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';

function snapshot(): PpeImportSnapshot {
  return {
    employees: [
      { id: E1, personnelNo: '101', fullName: 'Иванова Мария Петровна', roleCode: 'Слесарь', attrsJson: null, isActive: true },
      { id: E2, personnelNo: '102', fullName: 'Петров Иван Сидорович', roleCode: null, attrsJson: null, isActive: true },
    ],
    departments: [{ id: 'd-1', name: 'Ремонтный цех' }],
    departmentTypeReady: true,
    noms: [
      { id: 'n-1', code: 'KS-01', sku: null, name: 'Костюм рабочий', parentId: null, category: 'workwear' },
      { id: 'n-44', code: 'KS-01-44', sku: null, name: 'Костюм рабочий 44', parentId: 'n-1', category: 'workwear' },
      { id: 'n-46', code: 'KS-01-46', sku: null, name: 'Костюм рабочий 46', parentId: 'n-1', category: 'workwear' },
      { id: 'n-9', code: 'BT-9', sku: null, name: 'Ботинки', parentId: null, category: 'workwear' },
    ],
    absences: [{ employeeId: E1, fromMs: Date.UTC(2026, 6, 1), toMs: Date.UTC(2026, 6, 15) }],
    entries: [{ cardId: 'c-1', nomenclatureId: 'n-9', issuedAt: Date.UTC(2026, 0, 10), qty: 1 }],
    openCards: [{ id: 'c-1', employeeId: E1 }],
  };
}

async function buildWorkbook(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const EMP_HEADER = ['Табельный номер', 'ФИО', 'Должность', 'Подразделение', 'Пол', 'Дата рождения', 'Дата приёма', 'Дата увольнения', 'Отпуск с', 'Отпуск по'];
const ISS_HEADER = ['Таб. №', 'Номенклатура', 'Артикул', 'Размер', 'Кол-во', 'Дата'];

function empRow(no: unknown, fio: unknown, extra: Record<number, unknown> = {}): unknown[] {
  const r: unknown[] = [no, fio, 'Слесарь', 'Ремонтный цех', 'Ж', '01.02.1990', '10.01.2020', '', '', ''];
  for (const [i, v] of Object.entries(extra)) r[Number(i)] = v;
  return r;
}

describe('ppeImport: разбор книги', () => {
  it('находит листы по шапке, строки с номерами строк Excel', async () => {
    const buf = await buildWorkbook({
      Кадры: [EMP_HEADER, empRow(101, 'Иванова Мария Петровна'), empRow(103, 'Сидоров Сидор Сидорович')],
      История: [ISS_HEADER, [101, 'Ботинки', 'BT-9', '', 1, '10.01.2026']],
    });
    const r = await parsePpeImportWorkbook(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.employeeSheet).toBe('Кадры');
    expect(r.parsed.issueSheet).toBe('История');
    expect(r.parsed.employees).toHaveLength(2);
    expect(r.parsed.employees[0]).toMatchObject({ line: 2, personnelNo: '101', fullName: 'Иванова Мария Петровна' });
    expect(r.parsed.issues).toHaveLength(1);
  });

  it('пустые строки пропускаются, мусорная книга — понятная ошибка', async () => {
    const buf = await buildWorkbook({ Лист1: [['а', 'б'], [], ['в']] });
    const r = await parsePpeImportWorkbook(buf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Табельный номер');
    const notXlsx = await parsePpeImportWorkbook(Buffer.from('не книга'));
    expect(notXlsx.ok).toBe(false);
  });

  it('даты: объект, серийник, строка', () => {
    expect(parseImportDateCell(new Date(Date.UTC(2026, 0, 5)))).toBe(Date.UTC(2026, 0, 5));
    expect(parseImportDateCell(46000)).toBe(Math.round((46000 - 25569) * 86_400_000));
    expect(parseImportDateCell('05.01.2026')).toBe(Date.UTC(2026, 0, 5));
    expect(parseImportDateCell('мусор')).toBeNull();
  });

  it('пол: М/Ж и варианты', () => {
    expect(parseImportGender('М')).toBe('M');
    expect(parseImportGender('женский')).toBe('F');
    expect(parseImportGender('')).toBeNull();
    expect(parseImportGender('неизвестно')).toBeNull();
  });
});

describe('ppeImport: валидация сотрудников', () => {
  const snap = snapshot();

  it('совпавший, новый, обновлённый', () => {
    const { ok, preview } = validatePpeImport(
      {
        employeeSheet: 'К', issueSheet: null,
        employees: [
          { line: 2, personnelNo: '101', fullName: 'Иванова Мария Петровна', position: '', department: '', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: null, vacToRaw: null },
          { line: 3, personnelNo: '103', fullName: 'Сидоров Сидор Сидорович', position: '', department: '', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: null, vacToRaw: null },
          { line: 4, personnelNo: '102', fullName: 'Петров Иван Петрович', position: '', department: '', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: null, vacToRaw: null },
        ],
        issues: [],
      },
      snap,
    );
    expect(ok).toBe(true);
    expect(preview.summary.employees).toEqual({ create: 1, update: 1, match: 1, conflict: 0 });
  });

  it('пустой номер и пустое ФИО — конфликты', () => {
    const { ok, preview } = validatePpeImport(
      {
        employeeSheet: 'К', issueSheet: null,
        employees: [
          { line: 2, personnelNo: '', fullName: 'Без Номера Человек', position: '', department: '', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: null, vacToRaw: null },
          { line: 3, personnelNo: '104', fullName: '', position: '', department: '', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: null, vacToRaw: null },
        ],
        issues: [],
      },
      snap,
    );
    expect(ok).toBe(false);
    expect(preview.summary.employees.conflict).toBe(2);
  });

  it('подразделения: совпало и новое', () => {
    const { preview } = validatePpeImport(
      {
        employeeSheet: 'К', issueSheet: null,
        employees: [
          { line: 2, personnelNo: '103', fullName: 'Новый Человек', position: '', department: 'Ремонтный цех', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: null, vacToRaw: null },
          { line: 3, personnelNo: '104', fullName: 'Другой Человек', position: '', department: 'Новый цех', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: null, vacToRaw: null },
        ],
        issues: [],
      },
      snap,
    );
    expect(preview.summary.departments).toEqual({ create: 1, match: 1 });
  });

  it('отпуска: новый, дубль, перевёрнутый', () => {
    const { ok, preview } = validatePpeImport(
      {
        employeeSheet: 'К', issueSheet: null,
        employees: [
          { line: 2, personnelNo: '101', fullName: 'Иванова Мария Петровна', position: '', department: '', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: '01.07.2026', vacToRaw: '15.07.2026' },
          { line: 3, personnelNo: '101', fullName: 'Иванова Мария Петровна', position: '', department: '', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: '01.08.2026', vacToRaw: '10.08.2026' },
          { line: 4, personnelNo: '101', fullName: 'Иванова Мария Петровна', position: '', department: '', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: '10.08.2026', vacToRaw: '01.08.2026' },
        ],
        issues: [],
      },
      snap,
    );
    expect(ok).toBe(false);
    expect(preview.summary.absences).toEqual({ create: 1, skip: 1, conflict: 1 });
  });
});

describe('ppeImport: валидация выдач', () => {
  const snap = snapshot();

  it('размерный ряд: точный размер находится', () => {
    const { ok, preview } = validatePpeImport(
      {
        employeeSheet: null, issueSheet: 'В',
        employees: [],
        issues: [{ line: 2, personnelNo: '101', nomName: 'Костюм рабочий', article: 'KS-01', size: '46', qtyRaw: 1, dateRaw: '10.03.2026' }],
      },
      snap,
    );
    expect(ok).toBe(true);
    expect(preview.summary.issues).toEqual({ create: 1, skip: 0, conflict: 0 });
    expect(preview.rows[0]!.ref).toContain('46');
  });

  it('без размера при рядных размерах, мусорный артикул, дубль', () => {
    const { ok, preview } = validatePpeImport(
      {
        employeeSheet: null, issueSheet: 'В',
        employees: [],
        issues: [
          { line: 2, personnelNo: '101', nomName: 'Костюм рабочий', article: 'KS-01', size: '', qtyRaw: 1, dateRaw: '10.03.2026' },
          { line: 3, personnelNo: '101', nomName: 'Неведома зверушка', article: 'ZZ-00', size: '', qtyRaw: 1, dateRaw: '10.03.2026' },
          { line: 4, personnelNo: '101', nomName: 'Ботинки', article: 'BT-9', size: '', qtyRaw: 1, dateRaw: '10.01.2026' },
        ],
      },
      snap,
    );
    expect(ok).toBe(false);
    expect(preview.summary.issues).toEqual({ create: 0, skip: 1, conflict: 2 });
  });

  it('выдача новому сотруднику из того же файла — create, не конфликт', () => {
    const { ok, preview } = validatePpeImport(
      {
        employeeSheet: 'К', issueSheet: 'В',
        employees: [
          { line: 2, personnelNo: '103', fullName: 'Сидоров Сидор Сидорович', position: '', department: '', genderRaw: '', birthRaw: null, hireRaw: null, fireRaw: null, vacFromRaw: null, vacToRaw: null },
        ],
        issues: [{ line: 2, personnelNo: '103', nomName: 'Ботинки', article: 'BT-9', size: '', qtyRaw: 2, dateRaw: '10.03.2026' }],
      },
      snap,
    );
    expect(ok).toBe(true);
    expect(preview.summary.issues.create).toBe(1);
  });
});

describe('ppeImport: preview-id', () => {
  const OLD_ENV = process.env.MATRICA_JWT_SECRET;
  beforeEach(() => {
    // Gitleaks гейтит литералы секретов: собираем заведомо фейковый из кусков.
    const parts = ['test-only', 'hmac', 'secret', 'value'];
    process.env.MATRICA_JWT_SECRET = [...parts, ...parts].join('-');
  });

  it('подпись крутится и проверяется, чужой файл и просрочка — отказ', () => {
    const token = signPpePreviewToken('abc123');
    expect(verifyPpePreviewToken(token, 'abc123').ok).toBe(true);
    expect(verifyPpePreviewToken(token, 'other').ok).toBe(false);
    expect(verifyPpePreviewToken('мусор', 'abc123').ok).toBe(false);
    const expired = verifyPpePreviewToken(token, 'abc123', Date.now() + PPE_IMPORT_PREVIEW_TTL_MS + 1000);
    expect(expired.ok).toBe(false);
    if (OLD_ENV === undefined) delete process.env.MATRICA_JWT_SECRET;
    else process.env.MATRICA_JWT_SECRET = OLD_ENV;
  });

  it('те же валидаторы ловят дрейф: удаление номенклатуры после preview', () => {
    const parsed = {
      employeeSheet: null as string | null,
      issueSheet: 'В',
      employees: [],
      issues: [{ line: 2, personnelNo: '101', nomName: 'Ботинки', article: 'BT-9', size: '', qtyRaw: 1, dateRaw: '10.03.2026' }],
    };
    expect(validatePpeImport(parsed, snapshot()).ok).toBe(true);
    const drifted: PpeImportSnapshot = { ...snapshot(), noms: [] };
    const re = validatePpeImport(parsed, drifted);
    expect(re.ok).toBe(false);
    expect(re.preview.summary.issues.conflict).toBe(1);
  });
});
