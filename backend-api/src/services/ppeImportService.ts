import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { match1cNomenclature, normalizeLookupCompact } from '@matricarmz/shared';
import { and, eq, isNull } from 'drizzle-orm';
import ExcelJS from 'exceljs';

import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  erpEmployeeCards,
  erpNomenclature,
  ppeAbsences,
  ppeIssueCards,
  ppeIssueEntries,
} from '../database/schema.js';
import { createEntity, setEntityAttribute } from './adminMasterdataService.js';
import { openPpeCard } from './ppeService.js';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
type Actor = { id: string; username: string; role?: string };

// ────────────────────────────────────────────────────────────
// Ожидаемые колонки (утверждены владельцем 2026-10-15).
// Несовпадение шапки — понятная ошибка со списком, а не молчаливый мусор.
// ────────────────────────────────────────────────────────────

/** Лист сотрудников типовой выгрузки ЗУП. */
export const PPE_IMPORT_EMPLOYEE_COLUMNS = [
  'Табельный номер',
  'ФИО',
  'Должность',
  'Подразделение',
  'Пол',
  'Дата рождения',
  'Дата приёма',
  'Дата увольнения',
  'Отпуск с',
  'Отпуск по',
];

/** Лист прошлых выдач. */
export const PPE_IMPORT_ISSUE_COLUMNS = ['Таб. №', 'Номенклатура', 'Артикул', 'Размер', 'Кол-во', 'Дата'];

const EMPLOYEE_REQUIRED = ['табельный номер', 'фио'];
const ISSUE_REQUIRED = ['таб. №', 'дата'];
const ISSUE_NOM_REQUIRED = ['номенклатура', 'артикул'];

const PERSONNEL_ALIASES = ['табельный номер', 'таб. №', 'таб.номер', 'табельный №'];
const FIO_ALIASES = ['фио', 'ф.и.о.', 'фамилия имя отчество'];
const NOM_NAME_ALIASES = ['номенклатура', 'наименование'];
const ARTICLE_ALIASES = ['артикул', 'код'];

export const PPE_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
/** Preview-id живёт 30 минут. */
export const PPE_IMPORT_PREVIEW_TTL_MS = 30 * 60 * 1000;

// ────────────────────────────────────────────────────────────
// Ячейки.
// ────────────────────────────────────────────────────────────

function normHeader(v: unknown): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text.trim();
    if (Array.isArray(o.richText)) {
      return o.richText
        .map((r) => String((r as Record<string, unknown>).text ?? ''))
        .join('')
        .trim();
    }
    return '';
  }
  return String(v).trim();
}

/** Дата Excel (объект), серийный номер, строка dd.mm.yyyy / ISO → Unix-ms. Иначе null. */
export function parseImportDateCell(v: unknown): number | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.getTime();
  if (typeof v === 'number' && Number.isFinite(v) && v > 20000 && v < 80000) {
    return Math.round((v - 25569) * 86_400_000);
  }
  const s = cellText(v);
  if (!s) return null;
  const dmy = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (dmy) {
    const ms = Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), Number(dmy[4] ?? 0), Number(dmy[5] ?? 0), Number(dmy[6] ?? 0));
    return Number.isFinite(ms) ? ms : null;
  }
  const iso = Date.parse(s);
  return Number.isFinite(iso) ? iso : null;
}

/** «М»/«муж…» → M, «Ж»/«жен…» → F, пусто → null, иначе null (с варнингом у вызывателя). */
export function parseImportGender(v: unknown): 'M' | 'F' | null {
  const s = cellText(v).toLowerCase().replace(/^ё/, 'е');
  if (!s) return null;
  if (s.startsWith('м')) return 'M';
  if (s.startsWith('ж')) return 'F';
  return null;
}

function parseImportQty(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  const s = cellText(v).replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Табельный как в personnelKey importEmployeesCsv: цифры без ведущих нулей. */
function personnelKey(v: unknown): string {
  const text = cellText(v);
  if (!text) return '';
  return /^\d+$/.test(text) ? String(Number(text)) : text;
}

// ────────────────────────────────────────────────────────────
// Разбор книги.
// ────────────────────────────────────────────────────────────

export type RawEmployeeRow = {
  line: number;
  personnelNo: string;
  fullName: string;
  position: string;
  department: string;
  genderRaw: string;
  birthRaw: unknown;
  hireRaw: unknown;
  fireRaw: unknown;
  vacFromRaw: unknown;
  vacToRaw: unknown;
};

export type RawIssueRow = {
  line: number;
  personnelNo: string;
  nomName: string;
  article: string;
  size: string;
  qtyRaw: unknown;
  dateRaw: unknown;
};

export type ParsedPpeImport = {
  employeeSheet: string | null;
  issueSheet: string | null;
  employees: RawEmployeeRow[];
  issues: RawIssueRow[];
};

function findHeaderRow(
  ws: ExcelJS.Worksheet,
  required: string[],
  anyOf: string[] = [],
): { row: number; colByHeader: Map<string, number> } | null {
  const maxRow = Math.min(ws.rowCount, 10);
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    const colByHeader = new Map<string, number>();
    for (let c = 1; c <= ws.columnCount; c++) {
      const h = normHeader(cellText(row.getCell(c).value));
      if (h && !colByHeader.has(h)) colByHeader.set(h, c);
    }
    const hasAll = required.every((h) => colByHeader.has(h));
    const hasAny = anyOf.length === 0 || anyOf.some((h) => colByHeader.has(h));
    if (hasAll && hasAny) return { row: r, colByHeader };
  }
  return null;
}

function pick(colByHeader: Map<string, number>, aliases: string[]): number | null {
  for (const a of aliases) {
    const c = colByHeader.get(a);
    if (c != null) return c;
  }
  return null;
}

export async function parsePpeImportWorkbook(buffer: Buffer): Promise<Result<{ parsed: ParsedPpeImport }>> {
  try {
    if (!buffer || buffer.length === 0) return { ok: false, error: 'Пустой файл' };
    if (buffer.length > PPE_IMPORT_MAX_BYTES) return { ok: false, error: 'Файл больше 10 МБ' };
    let wb: ExcelJS.Workbook;
    try {
      wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      return { ok: false, error: 'Не xlsx: не удалось разобрать книгу' };
    }
    let employeeSheet: string | null = null;
    let issueSheet: string | null = null;
    const heads: {
      emp: { row: number; colByHeader: Map<string, number> } | null;
      iss: { row: number; colByHeader: Map<string, number> } | null;
    } = { emp: null, iss: null };
    wb.eachSheet((ws) => {
      if (!heads.emp) {
        const found = findHeaderRow(ws, EMPLOYEE_REQUIRED);
        if (found) {
          heads.emp = found;
          employeeSheet = ws.name;
        }
      }
      if (!heads.iss) {
        const found = findHeaderRow(ws, ISSUE_REQUIRED, ISSUE_NOM_REQUIRED);
        if (found) {
          heads.iss = found;
          issueSheet = ws.name;
        }
      }
    });
    const empHead = heads.emp;
    const issHead = heads.iss;
    if (!empHead && !issHead) {
      return {
        ok: false,
        error: `Шапка не распознана: лист сотрудников ждёт колонки ${PPE_IMPORT_EMPLOYEE_COLUMNS.join(', ')}; лист выдач — ${PPE_IMPORT_ISSUE_COLUMNS.join(', ')}`,
      };
    }
    const parsed: ParsedPpeImport = { employeeSheet, issueSheet, employees: [], issues: [] };
    if (empHead) {
      const ws = wb.getWorksheet(employeeSheet!)!;
      const cols = empHead.colByHeader;
      const cNo = pick(cols, PERSONNEL_ALIASES)!;
      const cFio = pick(cols, FIO_ALIASES)!;
      const cPos = pick(cols, ['должность']);
      const cDep = pick(cols, ['подразделение']);
      const cSex = pick(cols, ['пол']);
      const cBirth = pick(cols, ['дата рождения']);
      const cHire = pick(cols, ['дата приёма', 'дата приема']);
      const cFire = pick(cols, ['дата увольнения']);
      const cVacFrom = pick(cols, ['отпуск с']);
      const cVacTo = pick(cols, ['отпуск по']);
      for (let r = empHead.row + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const cells = [cNo, cFio, cPos, cDep, cSex, cBirth, cHire, cFire, cVacFrom, cVacTo]
          .filter((c): c is number => c != null)
          .map((c) => row.getCell(c).value);
        if (cells.every((v) => cellText(v) === '' && !(v instanceof Date) && typeof v !== 'number')) continue;
        parsed.employees.push({
          line: r,
          personnelNo: personnelKey(row.getCell(cNo).value),
          fullName: cellText(row.getCell(cFio).value).replace(/\s+/g, ' '),
          position: cPos == null ? '' : cellText(row.getCell(cPos).value),
          department: cDep == null ? '' : cellText(row.getCell(cDep).value).replace(/\s+/g, ' '),
          genderRaw: cSex == null ? '' : cellText(row.getCell(cSex).value),
          birthRaw: cBirth == null ? null : row.getCell(cBirth).value,
          hireRaw: cHire == null ? null : row.getCell(cHire).value,
          fireRaw: cFire == null ? null : row.getCell(cFire).value,
          vacFromRaw: cVacFrom == null ? null : row.getCell(cVacFrom).value,
          vacToRaw: cVacTo == null ? null : row.getCell(cVacTo).value,
        });
      }
    }
    if (issHead) {
      const ws = wb.getWorksheet(issueSheet!)!;
      const cols = issHead.colByHeader;
      const cNo = pick(cols, PERSONNEL_ALIASES)!;
      const cNom = pick(cols, NOM_NAME_ALIASES);
      const cArt = pick(cols, ARTICLE_ALIASES);
      const cSize = pick(cols, ['размер']);
      const cQty = pick(cols, ['кол-во', 'количество', 'колво']);
      const cDate = pick(cols, ['дата'])!;
      for (let r = issHead.row + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const probe = [cNo, cNom, cArt, cSize, cQty, cDate]
          .filter((c): c is number => c != null)
          .map((c) => row.getCell(c).value);
        if (probe.every((v) => cellText(v) === '' && !(v instanceof Date) && typeof v !== 'number')) continue;
        parsed.issues.push({
          line: r,
          personnelNo: personnelKey(row.getCell(cNo).value),
          nomName: cNom == null ? '' : cellText(row.getCell(cNom).value),
          article: cArt == null ? '' : cellText(row.getCell(cArt).value),
          size: cSize == null ? '' : cellText(row.getCell(cSize).value),
          qtyRaw: cQty == null ? null : row.getCell(cQty).value,
          dateRaw: row.getCell(cDate).value,
        });
      }
    }
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ────────────────────────────────────────────────────────────
// Снапшот и валидация (одни валидаторы для preview и apply).
// ────────────────────────────────────────────────────────────

export type PpeImportSnapshot = {
  employees: Array<{ id: string; personnelNo: string | null; fullName: string; roleCode: string | null; attrsJson: string | null; isActive: boolean }>;
  departments: Array<{ id: string; name: string }>;
  departmentTypeReady: boolean;
  noms: Array<{ id: string; code: string; sku: string | null; name: string; parentId: string | null; category: string | null }>;
  absences: Array<{ employeeId: string; fromMs: number; toMs: number }>;
  entries: Array<{ cardId: string; nomenclatureId: string; issuedAt: number; qty: number }>;
  openCards: Array<{ id: string; employeeId: string }>;
};

export type PpeImportPreviewRow = {
  line: number;
  sheet: string;
  kind: 'employee' | 'department' | 'absence' | 'issue';
  action: 'create' | 'update' | 'match' | 'exists' | 'conflict';
  ref: string;
  warnings: string[];
  error?: string;
};

export type PpeImportPreview = {
  rows: PpeImportPreviewRow[];
  summary: {
    employees: { create: number; update: number; match: number; conflict: number };
    departments: { create: number; match: number };
    absences: { create: number; skip: number; conflict: number };
    issues: { create: number; skip: number; conflict: number };
  };
};

function deptNorm(v: string): string {
  return v.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function safeJsonParseAttrs(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Размер и номенклатура строки выдачи — ОДНО правило для preview и apply.
 *
 * Пока это правило жило в двух местах, оно разъехалось: предпросмотр обещал
 * «создастся» с базовой позицией и предупреждением (размер указан, а ряда у
 * позиции нет — обычное дело для перчаток и очков), а применение молча
 * пропускало такую строку. Оператор видел расход обещания и итога и не знал,
 * почему. Оба конца зовут этот хелпер — разъехаться снова не смогут.
 */
export function resolveIssueNomenclature(args: {
  baseName: string;
  baseId: string;
  size: string | null;
  children: Array<{ id: string; name: string }>;
}): { ok: true; nomId: string; warning: string | null } | { ok: false; error: string } {
  const sizeKey = normalizeLookupCompact(args.size ?? '');
  if (!sizeKey) {
    if (args.children.length > 0) return { ok: false, error: `у «${args.baseName}» есть размеры — укажите размер` };
    return { ok: true, nomId: args.baseId, warning: null };
  }
  if (args.children.length === 0) {
    return { ok: true, nomId: args.baseId, warning: `размер «${args.size}» указан, но у позиции нет размерного ряда — взята базовая` };
  }
  const exact = args.children.filter((c) => normalizeLookupCompact(c.name) === sizeKey);
  const containing = exact.length > 0 ? exact : args.children.filter((c) => normalizeLookupCompact(c.name).includes(sizeKey));
  if (containing.length === 1) return { ok: true, nomId: containing[0]!.id, warning: null };
  return {
    ok: false,
    error: `размер «${args.size}» ${containing.length === 0 ? 'не найден' : 'неоднозначен'} среди вариантов «${args.baseName}»`,
  };
}

export function validatePpeImport(parsed: ParsedPpeImport, snapshot: PpeImportSnapshot): { ok: boolean; preview: PpeImportPreview } {
  const rows: PpeImportPreviewRow[] = [];
  const summary: PpeImportPreview['summary'] = {
    employees: { create: 0, update: 0, match: 0, conflict: 0 },
    departments: { create: 0, match: 0 },
    absences: { create: 0, skip: 0, conflict: 0 },
    issues: { create: 0, skip: 0, conflict: 0 },
  };
  const bump = (kind: 'employees' | 'departments' | 'absences' | 'issues', action: PpeImportPreviewRow['action']) => {
    const s = summary[kind];
    if (action === 'create') (s as { create: number }).create++;
    else if (action === 'update') (s as { update: number }).update++;
    else if (action === 'match') (s as { match: number }).match++;
    else if (action === 'exists') (s as { skip: number }).skip++;
    else if (action === 'conflict') (s as { conflict: number }).conflict++;
  };

  const byPersonnel = new Map<string, Array<(typeof snapshot.employees)[number]>>();
  for (const e of snapshot.employees) {
    if (!e.personnelNo) continue;
    byPersonnel.set(e.personnelNo, [...(byPersonnel.get(e.personnelNo) ?? []), e]);
  }
  const byName = new Map<string, Array<(typeof snapshot.employees)[number]>>();
  for (const e of snapshot.employees) {
    const k = normalizeLookupCompact(e.fullName);
    if (!k) continue;
    byName.set(k, [...(byName.get(k) ?? []), e]);
  }
  const deptByNorm = new Map(snapshot.departments.map((d) => [deptNorm(d.name), d]));
  const openCardByEmployee = new Map(snapshot.openCards.map((c) => [c.employeeId, c.id]));
  // Ключ сотрудника внутри файла: табельный, иначе ФИО (для строк без номера).
  const fileEmployeeKey = (personnelNo: string, fullName: string) =>
    personnelNo ? `tab:${personnelNo}` : `fio:${normalizeLookupCompact(fullName)}`;
  // Разрешение сотрудника файла → strict-карточка (id) или 'new:<key>' для создаваемых.
  const resolvedEmployeeId = new Map<string, string>();

  for (const emp of parsed.employees) {
    const sheet = parsed.employeeSheet ?? 'Сотрудники';
    const warnings: string[] = [];
    if (!emp.personnelNo) {
      rows.push({ line: emp.line, sheet, kind: 'employee', action: 'conflict', ref: emp.fullName || '(без ФИО)', warnings, error: 'пустой табельный номер' });
      bump('employees', 'conflict');
      continue;
    }
    if (!emp.fullName) {
      rows.push({ line: emp.line, sheet, kind: 'employee', action: 'conflict', ref: `таб. ${emp.personnelNo}`, warnings, error: 'пустое ФИО' });
      bump('employees', 'conflict');
      continue;
    }
    const gender = parseImportGender(emp.genderRaw);
    if (emp.genderRaw && !gender) warnings.push(`пол «${emp.genderRaw}» не распознан — условие нормы не выставится`);
    const birth = emp.birthRaw == null || cellText(emp.birthRaw) === '' ? null : parseImportDateCell(emp.birthRaw);
    if (emp.birthRaw != null && cellText(emp.birthRaw) !== '' && birth == null) warnings.push('дата рождения не распознана');
    const hire = emp.hireRaw == null || cellText(emp.hireRaw) === '' ? null : parseImportDateCell(emp.hireRaw);
    if (emp.hireRaw != null && cellText(emp.hireRaw) !== '' && hire == null) warnings.push('дата приёма не распознана');
    const fire = emp.fireRaw == null || cellText(emp.fireRaw) === '' ? null : parseImportDateCell(emp.fireRaw);
    if (emp.fireRaw != null && cellText(emp.fireRaw) !== '' && fire == null) warnings.push('дата увольнения не распознана');
    if (fire != null && fire < Date.now()) warnings.push('уволен — карточка будет неактивна');

    const key = fileEmployeeKey(emp.personnelNo, emp.fullName);
    const personnelMatches = byPersonnel.get(emp.personnelNo) ?? [];
    let cardId: string | null = null;
    let action: 'create' | 'update' | 'match' | 'conflict' = 'create';
    let error: string | undefined;
    if (personnelMatches.length === 1) {
      const found = personnelMatches[0]!;
      cardId = found.id;
      action = normalizeLookupCompact(found.fullName) === normalizeLookupCompact(emp.fullName) ? 'match' : 'update';
    } else if (personnelMatches.length > 1) {
      action = 'conflict';
      error = `таб. № ${emp.personnelNo} уже у нескольких карточек — сверьте глазами`;
    } else {
      const nameMatches = byName.get(normalizeLookupCompact(emp.fullName)) ?? [];
      const safe = nameMatches.filter((c) => {
        if (c.personnelNo && c.personnelNo !== emp.personnelNo) return false;
        if (birth != null) {
          const attrs = safeJsonParseAttrs(c.attrsJson);
          const cardBirth = typeof attrs.birthDate === 'number' ? attrs.birthDate : null;
          if (cardBirth != null && cardBirth !== birth) return false;
        }
        return true;
      });
      if (safe.length === 1 && nameMatches.length === 1) {
        cardId = safe[0]!.id;
        action = 'match';
      } else if (nameMatches.length > 0) {
        action = 'conflict';
        error = `«${emp.fullName}» совпало с существующей карточкой, но табельный/рождение не позволяют безопасно выбрать — сверьте глазами`;
      }
    }
    if (action === 'conflict') {
      rows.push({ line: emp.line, sheet, kind: 'employee', action, ref: emp.fullName, warnings, ...(error ? { error } : {}) });
      bump('employees', 'conflict');
      continue;
    }
    resolvedEmployeeId.set(key, cardId ?? `new:${key}`);
    rows.push({ line: emp.line, sheet, kind: 'employee', action, ref: emp.fullName, warnings });
    bump('employees', action);

    if (emp.department) {
      const dep = deptByNorm.get(deptNorm(emp.department));
      if (dep) {
        rows.push({ line: emp.line, sheet, kind: 'department', action: 'match', ref: dep.name, warnings: [] });
        bump('departments', 'match');
      } else if (snapshot.departmentTypeReady) {
        rows.push({ line: emp.line, sheet, kind: 'department', action: 'create', ref: emp.department, warnings: [] });
        bump('departments', 'create');
      } else {
        warnings.push(`подразделение «${emp.department}» сохранится текстом: нет типа department`);
      }
    }

    const vacFrom = emp.vacFromRaw == null || cellText(emp.vacFromRaw) === '' ? null : parseImportDateCell(emp.vacFromRaw);
    const vacTo = emp.vacToRaw == null || cellText(emp.vacToRaw) === '' ? null : parseImportDateCell(emp.vacToRaw);
    if ((emp.vacFromRaw != null && cellText(emp.vacFromRaw) !== '' && vacFrom == null) || (emp.vacToRaw != null && cellText(emp.vacToRaw) !== '' && vacTo == null)) {
      rows.push({ line: emp.line, sheet, kind: 'absence', action: 'conflict', ref: emp.fullName, warnings: [], error: 'даты отпуска не распознаны' });
      bump('absences', 'conflict');
    } else if (vacFrom != null && vacTo != null) {
      if (vacFrom >= vacTo) {
        rows.push({ line: emp.line, sheet, kind: 'absence', action: 'conflict', ref: emp.fullName, warnings: [], error: '«Отпуск с» позже «Отпуск по»' });
        bump('absences', 'conflict');
      } else if (cardId && snapshot.absences.some((a) => a.employeeId === cardId && a.fromMs === vacFrom && a.toMs === vacTo)) {
        rows.push({ line: emp.line, sheet, kind: 'absence', action: 'exists', ref: emp.fullName, warnings: [] });
        bump('absences', 'exists');
      } else {
        rows.push({ line: emp.line, sheet, kind: 'absence', action: 'create', ref: emp.fullName, warnings: [] });
        bump('absences', 'create');
      }
    }
  }

  const nomCandidates = snapshot.noms.map((n) => ({ id: n.id, name: n.name, article: n.code || n.sku || '' }));
  const childrenByParent = new Map<string, Array<(typeof snapshot.noms)[number]>>();
  for (const n of snapshot.noms) {
    if (!n.parentId) continue;
    childrenByParent.set(n.parentId, [...(childrenByParent.get(n.parentId) ?? []), n]);
  }

  for (const iss of parsed.issues) {
    const sheet = parsed.issueSheet ?? 'Выдачи';
    const warnings: string[] = [];
    const conflict = (error: string) => {
      rows.push({ line: iss.line, sheet, kind: 'issue', action: 'conflict', ref: iss.nomName || iss.article || `таб. ${iss.personnelNo}`, warnings, error });
      bump('issues', 'conflict');
    };
    if (!iss.personnelNo) {
      conflict('пустой табельный номер');
      continue;
    }
    const qty = parseImportQty(iss.qtyRaw);
    if (qty == null) {
      conflict('количество обязано быть целым больше нуля');
      continue;
    }
    const issuedAt = parseImportDateCell(iss.dateRaw);
    if (issuedAt == null) {
      conflict('дата выдачи не распознана');
      continue;
    }
    if (issuedAt > Date.now()) warnings.push('дата выдачи в будущем');
    // Сотрудник: сначала свои строки файла, иначе снапшот.
    const empKey = fileEmployeeKey(iss.personnelNo, '');
    let employeeId = resolvedEmployeeId.get(empKey) ?? null;
    if (!employeeId) {
      const pm = byPersonnel.get(iss.personnelNo) ?? [];
      if (pm.length === 1) employeeId = pm[0]!.id;
      else {
        conflict(`сотрудник с таб. № ${iss.personnelNo} не разрешился`);
        continue;
      }
    }
    if (!iss.nomName && !iss.article) {
      conflict('пустые и номенклатура, и артикул');
      continue;
    }
    const matched = match1cNomenclature([{ article: iss.article, name: iss.nomName, unit: '', qty }], nomCandidates);
    if (matched.ambiguous.length > 0) {
      conflict('номенклатура неоднозначна — уточните артикул');
      continue;
    }
    if (matched.matched.length === 0) {
      conflict(`«${iss.nomName || iss.article}» не сопоставлено с номенклатурой`);
      continue;
    }
    const base = snapshot.noms.find((n) => n.id === matched.matched[0]!.nom.id)!;
    const children = childrenByParent.get(base.id) ?? [];
    const resolved = resolveIssueNomenclature({
      baseName: base.name,
      baseId: base.id,
      size: iss.size,
      children: children.map((c) => ({ id: c.id, name: c.name })),
    });
    if (!resolved.ok) {
      conflict(resolved.error);
      continue;
    }
    if (resolved.warning) warnings.push(resolved.warning);
    const nomId = resolved.nomId;
    const nom = snapshot.noms.find((n) => n.id === nomId)!;
    if (nom.category != null && nom.category !== 'workwear') warnings.push(`«${nom.name}» не из спецодежды (категория ${nom.category})`);
    else if (nom.category == null) warnings.push(`у «${nom.name}» не указана категория`);
    const cardId = employeeId.startsWith('new:') ? null : openCardByEmployee.get(employeeId) ?? null;
    const dupe = cardId != null && snapshot.entries.some((e) => e.cardId === cardId && e.nomenclatureId === nomId && e.issuedAt === issuedAt && e.qty === qty);
    if (dupe) {
      rows.push({ line: iss.line, sheet, kind: 'issue', action: 'exists', ref: `${nom.name}, ${qty} шт`, warnings });
      bump('issues', 'exists');
    } else {
      rows.push({ line: iss.line, sheet, kind: 'issue', action: 'create', ref: `${nom.name}, ${qty} шт`, warnings });
      bump('issues', 'create');
    }
  }

  const ok = !rows.some((r) => r.action === 'conflict');
  return { ok, preview: { rows, summary } };
}

// ────────────────────────────────────────────────────────────
// Preview-id: stateless HMAC(sha256 файла + время), 30 минут.
// ────────────────────────────────────────────────────────────

function importSecret(): Buffer {
  const s = process.env.MATRICA_JWT_SECRET ?? '';
  if (s.trim().length < 32) throw new Error('MATRICA_JWT_SECRET is not configured (must be 32+ chars)');
  return Buffer.from(s, 'utf8');
}

export function signPpePreviewToken(fileHash: string): string {
  const t = Date.now();
  const sig = createHmac('sha256', importSecret()).update(`${fileHash}.${t}`).digest('hex');
  return Buffer.from(JSON.stringify({ h: fileHash, t, s: sig }), 'utf8').toString('base64url');
}

export function verifyPpePreviewToken(token: string, fileHash: string, now: number = Date.now()): Result<{ issuedAt: number }> {
  try {
    const p = JSON.parse(Buffer.from(String(token ?? ''), 'base64url').toString('utf8')) as { h?: unknown; t?: unknown; s?: unknown };
    if (typeof p.h !== 'string' || typeof p.t !== 'number' || typeof p.s !== 'string') return { ok: false, error: 'неверный previewId' };
    if (p.h !== fileHash) return { ok: false, error: 'файл не совпадает с preview: загрузите файл заново' };
    const expected = createHmac('sha256', importSecret()).update(`${p.h}.${p.t}`).digest();
    const actual = Buffer.from(p.s, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, error: 'неверная подпись previewId' };
    if (now - p.t > PPE_IMPORT_PREVIEW_TTL_MS) return { ok: false, error: 'preview просрочен (30 минут): обновите preview' };
    if (p.t > now + 60_000) return { ok: false, error: 'неверное время previewId' };
    return { ok: true, issuedAt: p.t };
  } catch {
    return { ok: false, error: 'неверный previewId' };
  }
}

export function sha256Hex(buffer: Buffer): string {
  const h = createHash('sha256');
  h.update(buffer);
  return h.digest('hex');
}

// ────────────────────────────────────────────────────────────
// Снапшот и применение.
// ────────────────────────────────────────────────────────────

export async function loadPpeImportSnapshot(): Promise<PpeImportSnapshot> {
  const employees = await db
    .select({ id: erpEmployeeCards.id, personnelNo: erpEmployeeCards.personnelNo, fullName: erpEmployeeCards.fullName, roleCode: erpEmployeeCards.roleCode, attrsJson: erpEmployeeCards.attrsJson, isActive: erpEmployeeCards.isActive })
    .from(erpEmployeeCards)
    .where(isNull(erpEmployeeCards.deletedAt));
  const typeRows = await db.select({ id: entityTypes.id }).from(entityTypes).where(and(eq(entityTypes.code, 'department'), isNull(entityTypes.deletedAt))).limit(1);
  const departmentTypeId = typeRows[0] ? String(typeRows[0].id) : null;
  let departments: PpeImportSnapshot['departments'] = [];
  if (departmentTypeId) {
    const defRows = await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, departmentTypeId as never), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
      .limit(1);
    const nameDefId = defRows[0] ? String(defRows[0].id) : null;
    if (nameDefId) {
      const depRows = await db
        .select({ id: entities.id, valueJson: attributeValues.valueJson })
        .from(entities)
        .innerJoin(attributeValues, and(eq(attributeValues.entityId, entities.id), eq(attributeValues.attributeDefId, nameDefId as never), isNull(attributeValues.deletedAt)))
        .where(and(eq(entities.typeId, departmentTypeId as never), isNull(entities.deletedAt)));
      departments = depRows.map((r) => ({ id: String(r.id), name: safeJsonString(r.valueJson) }));
    }
  }
  const noms = await db
    .select({ id: erpNomenclature.id, code: erpNomenclature.code, sku: erpNomenclature.sku, name: erpNomenclature.name, parentId: erpNomenclature.parentNomenclatureId, category: erpNomenclature.category, isActive: erpNomenclature.isActive })
    .from(erpNomenclature)
    .where(isNull(erpNomenclature.deletedAt));
  const absences = await db
    .select({ employeeId: ppeAbsences.employeeId, fromMs: ppeAbsences.fromMs, toMs: ppeAbsences.toMs })
    .from(ppeAbsences)
    .where(isNull(ppeAbsences.deletedAt));
  const entries = await db
    .select({ cardId: ppeIssueEntries.cardId, nomenclatureId: ppeIssueEntries.nomenclatureId, issuedAt: ppeIssueEntries.issuedAt, qty: ppeIssueEntries.qty })
    .from(ppeIssueEntries)
    .where(isNull(ppeIssueEntries.deletedAt));
  const openCards = await db
    .select({ id: ppeIssueCards.id, employeeId: ppeIssueCards.employeeId })
    .from(ppeIssueCards)
    .where(and(isNull(ppeIssueCards.closedAt), isNull(ppeIssueCards.deletedAt)));
  return {
    employees: employees.map((e) => ({
      id: String(e.id),
      personnelNo: e.personnelNo == null ? null : String(e.personnelNo),
      fullName: String(e.fullName),
      roleCode: e.roleCode == null ? null : String(e.roleCode),
      attrsJson: e.attrsJson == null ? null : String(e.attrsJson),
      isActive: e.isActive === true,
    })),
    departments,
    departmentTypeReady: departmentTypeId != null,
    noms: noms
      .filter((n) => n.isActive !== false)
      .map((n) => ({
        id: String(n.id),
        code: String(n.code ?? ''),
        sku: n.sku == null ? null : String(n.sku),
        name: String(n.name),
        parentId: n.parentId == null ? null : String(n.parentId),
        category: n.category == null ? null : String(n.category),
      })),
    absences: absences.map((a) => ({ employeeId: String(a.employeeId), fromMs: Number(a.fromMs), toMs: Number(a.toMs) })),
    entries: entries.map((e) => ({ cardId: String(e.cardId), nomenclatureId: String(e.nomenclatureId), issuedAt: Number(e.issuedAt), qty: Number(e.qty) })),
    openCards: openCards.map((c) => ({ id: String(c.id), employeeId: String(c.employeeId) })),
  };
}

function safeJsonString(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  try {
    const parsed: unknown = JSON.parse(s);
    return typeof parsed === 'string' ? parsed : s;
  } catch {
    return s;
  }
}

export type PpeImportApplyReport = {
  dryRun: boolean;
  employees: { created: string[]; updated: string[]; matched: number };
  departments: { created: string[]; matched: number };
  absences: { created: number; skipped: number };
  cards: { opened: number };
  entries: { created: number; skipped: number };
};

async function ensureDepartmentByName(name: string, actor: Actor): Promise<{ id: string; created: boolean } | null> {
  const typeRows = await db.select({ id: entityTypes.id }).from(entityTypes).where(and(eq(entityTypes.code, 'department'), isNull(entityTypes.deletedAt))).limit(1);
  if (!typeRows[0]) return null;
  const typeId = String(typeRows[0].id);
  const defRows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as never), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (!defRows[0]) return null;
  const nameDefId = String(defRows[0].id);
  const existing = await db
    .select({ id: entities.id, valueJson: attributeValues.valueJson })
    .from(entities)
    .innerJoin(attributeValues, and(eq(attributeValues.entityId, entities.id), eq(attributeValues.attributeDefId, nameDefId as never), isNull(attributeValues.deletedAt)))
    .where(and(eq(entities.typeId, typeId as never), isNull(entities.deletedAt)));
  const want = deptNorm(name);
  const hit = existing.find((r) => deptNorm(safeJsonString(r.valueJson)) === want);
  if (hit) return { id: String(hit.id), created: false };
  const created = await createEntity(actor, typeId);
  if (!created.ok || !created.id) throw new Error('не удалось создать подразделение');
  const set = await setEntityAttribute(actor, created.id, 'name', name);
  if (!set.ok) throw new Error(`не удалось назвать подразделение: ${set.error}`);
  return { id: created.id, created: true };
}

async function ensureOpenCardId(employeeId: string): Promise<string> {
  const open = await db
    .select({ id: ppeIssueCards.id })
    .from(ppeIssueCards)
    .where(and(eq(ppeIssueCards.employeeId, employeeId as never), isNull(ppeIssueCards.closedAt), isNull(ppeIssueCards.deletedAt)))
    .limit(1);
  if (open[0]) return String(open[0].id);
  const created = await openPpeCard({ employeeId });
  if (created.ok) return created.id;
  const retry = await db
    .select({ id: ppeIssueCards.id })
    .from(ppeIssueCards)
    .where(and(eq(ppeIssueCards.employeeId, employeeId as never), isNull(ppeIssueCards.closedAt), isNull(ppeIssueCards.deletedAt)))
    .limit(1);
  if (retry[0]) return String(retry[0].id);
  throw new Error(`не удалось открыть карточку: ${created.error}`);
}

export async function applyPpeImportPreview(args: {
  previewId: string;
  contentBase64: string;
  dryRun?: boolean;
  actor: Actor;
}): Promise<Result<{ report: PpeImportApplyReport }>> {
  try {
    const raw = String(args.contentBase64 ?? '');
    if (!raw) return { ok: false, error: 'contentBase64 обязателен' };
    let buffer: Buffer;
    try {
      buffer = Buffer.from(raw, 'base64');
    } catch {
      return { ok: false, error: 'contentBase64 не base64' };
    }
    if (buffer.length === 0 || buffer.length > PPE_IMPORT_MAX_BYTES) return { ok: false, error: 'файл пуст или больше 10 МБ' };
    const fileHash = sha256Hex(buffer);
    const verified = verifyPpePreviewToken(args.previewId, fileHash);
    if (!verified.ok) return verified;
    const parsed = await parsePpeImportWorkbook(buffer);
    if (!parsed.ok) return parsed;
    const snapshot = await loadPpeImportSnapshot();
    const { ok, preview } = validatePpeImport(parsed.parsed, snapshot);
    if (!ok) {
      const first = preview.rows.filter((r) => r.action === 'conflict').slice(0, 10);
      return {
        ok: false,
        error: `данные изменились после preview — обновите preview (${preview.rows.filter((r) => r.action === 'conflict').length} конфликтов): ${first.map((r) => `строка ${r.line}: ${r.error ?? r.ref}`).join('; ')}`,
      };
    }
    const dryRun = args.dryRun === true;
    const report: PpeImportApplyReport = {
      dryRun,
      employees: { created: [], updated: [], matched: 0 },
      departments: { created: [], matched: 0 },
      absences: { created: 0, skipped: 0 },
      cards: { opened: 0 },
      entries: { created: 0, skipped: 0 },
    };
    if (dryRun) {
      for (const row of preview.rows) {
        if (row.kind === 'employee' && row.action === 'create') report.employees.created.push(row.ref);
        if (row.kind === 'employee' && row.action === 'update') report.employees.updated.push(row.ref);
        if (row.kind === 'employee' && row.action === 'match') report.employees.matched++;
        if (row.kind === 'department' && row.action === 'create') report.departments.created.push(row.ref);
        if (row.kind === 'department' && row.action === 'match') report.departments.matched++;
        if (row.kind === 'absence' && row.action === 'create') report.absences.created++;
        if (row.kind === 'absence' && row.action === 'exists') report.absences.skipped++;
        if (row.kind === 'issue' && row.action === 'create') report.entries.created++;
        if (row.kind === 'issue' && row.action === 'exists') report.entries.skipped++;
      }
      return { ok: true, report };
    }

    const now = Date.now();
    const deptIdByNorm = new Map<string, string>();
    for (const d of snapshot.departments) deptIdByNorm.set(deptNorm(d.name), d.id);
    const cardIdByEmployee = new Map<string, string>();
    // Фаза 1: подразделения и сотрудники (идемпотентно: повторный прогон находит созданное).
    for (const emp of parsed.parsed.employees) {
      if (emp.department && !deptIdByNorm.has(deptNorm(emp.department))) {
        const ensured = await ensureDepartmentByName(emp.department, args.actor);
        if (ensured) {
          deptIdByNorm.set(deptNorm(emp.department), ensured.id);
          if (ensured.created) report.departments.created.push(emp.department);
          else report.departments.matched++;
        }
      }
      const gender = parseImportGender(emp.genderRaw);
      const birth = emp.birthRaw == null || cellText(emp.birthRaw) === '' ? null : parseImportDateCell(emp.birthRaw);
      const hire = emp.hireRaw == null || cellText(emp.hireRaw) === '' ? null : parseImportDateCell(emp.hireRaw);
      const fire = emp.fireRaw == null || cellText(emp.fireRaw) === '' ? null : parseImportDateCell(emp.fireRaw);
      const isActive = !(fire != null && fire < now);
      const position = emp.position || null;
      const depId = emp.department ? (deptIdByNorm.get(deptNorm(emp.department)) ?? null) : null;
      const attrs: Record<string, unknown> = {};
      if (emp.department) attrs.department = emp.department;
      if (depId) attrs.departmentId = depId;
      if (gender) attrs.gender = gender;
      if (birth != null) attrs.birthDate = birth;
      if (hire != null) attrs.hireDate = hire;
      if (fire != null) attrs.fireDate = fire;
      const attrsJson = Object.keys(attrs).length > 0 ? JSON.stringify(attrs) : null;
      const existing = await db
        .select()
        .from(erpEmployeeCards)
        .where(and(eq(erpEmployeeCards.personnelNo, emp.personnelNo), isNull(erpEmployeeCards.deletedAt)))
        .limit(1);
      const strict = existing[0] ?? null;
      if (strict) {
        const id = String(strict.id);
        const patch: Record<string, unknown> = {};
        if (String(strict.fullName) !== emp.fullName) patch.fullName = emp.fullName;
        if ((strict.roleCode == null ? null : String(strict.roleCode)) !== position) patch.roleCode = position;
        if ((strict.attrsJson == null ? null : String(strict.attrsJson)) !== attrsJson) patch.attrsJson = attrsJson;
        if (strict.isActive !== isActive) patch.isActive = isActive;
        if (Object.keys(patch).length > 0) {
          // PR-6: правка карточки — тоже новость для зеркала клиента.
          patch.syncStatus = 'pending';
          await db.update(erpEmployeeCards).set({ ...patch, updatedAt: now }).where(eq(erpEmployeeCards.id, id as never));
          report.employees.updated.push(emp.fullName);
        } else {
          report.employees.matched++;
        }
        cardIdByEmployee.set(id, id);
      } else {
        const id = randomUUID();
        await db.insert(erpEmployeeCards).values({
          id: id as never,
          personnelNo: emp.personnelNo,
          fullName: emp.fullName,
          roleCode: position,
          attrsJson,
          isActive,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          // PR-6: строка входит в sync-контракт — публикатор зеркала доведёт её
          // до журнала (пикеры СИЗ и отчёты читают реплику клиента).
          syncStatus: 'pending',
        });
        report.employees.created.push(emp.fullName);
        cardIdByEmployee.set(id, id);
      }
    }
    // Фаза 2: отпуска (пропуск существующих того же диапазона).
    for (const emp of parsed.parsed.employees) {
      const vacFrom = emp.vacFromRaw == null || cellText(emp.vacFromRaw) === '' ? null : parseImportDateCell(emp.vacFromRaw);
      const vacTo = emp.vacToRaw == null || cellText(emp.vacToRaw) === '' ? null : parseImportDateCell(emp.vacToRaw);
      if (vacFrom == null || vacTo == null || vacFrom >= vacTo) continue;
      const live = await db.select({ id: erpEmployeeCards.id }).from(erpEmployeeCards).where(and(eq(erpEmployeeCards.personnelNo, emp.personnelNo), isNull(erpEmployeeCards.deletedAt))).limit(1);
      if (!live[0]) continue;
      const employeeId = String(live[0].id);
      const dup = await db
        .select({ id: ppeAbsences.id })
        .from(ppeAbsences)
        .where(and(eq(ppeAbsences.employeeId, employeeId as never), eq(ppeAbsences.fromMs, vacFrom as never), eq(ppeAbsences.toMs, vacTo as never), isNull(ppeAbsences.deletedAt)))
        .limit(1);
      if (dup[0]) {
        report.absences.skipped++;
        continue;
      }
      await db.insert(ppeAbsences).values({
        id: randomUUID() as never,
        employeeId: employeeId as never,
        fromMs: vacFrom as never,
        toMs: vacTo as never,
        kind: 'vacation',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        syncStatus: 'pending',
      });
      report.absences.created++;
    }
    // Фаза 3: прошлые выдачи (entries с document_id NULL; карточки дооткрываются).
    const nomById = new Map(snapshot.noms.map((n) => [n.id, n]));
    for (const iss of parsed.parsed.issues) {
      const qty = parseImportQty(iss.qtyRaw);
      const issuedAt = parseImportDateCell(iss.dateRaw);
      if (qty == null || issuedAt == null) continue;
      const live = await db.select({ id: erpEmployeeCards.id }).from(erpEmployeeCards).where(and(eq(erpEmployeeCards.personnelNo, iss.personnelNo), isNull(erpEmployeeCards.deletedAt))).limit(1);
      if (!live[0]) continue;
      const employeeId = String(live[0].id);
      const candidates = snapshot.noms.map((n) => ({ id: n.id, name: n.name, article: n.code || n.sku || '' }));
      const matched = match1cNomenclature([{ article: iss.article, name: iss.nomName, unit: '', qty }], candidates);
      if (matched.matched.length !== 1 || matched.ambiguous.length > 0) continue;
      const base = nomById.get(matched.matched[0]!.nom.id);
      if (!base) continue;
      const resolved = resolveIssueNomenclature({
        baseName: base.name,
        baseId: base.id,
        size: iss.size,
        children: snapshot.noms.filter((n) => n.parentId === base.id).map((c) => ({ id: c.id, name: c.name })),
      });
      
      // Тот же хелпер, что у предпросмотра: строка придёт ровно в том виде, как её
      // обещал preview (в т.ч. «размер без размерного ряда» → базовая позиция).
      if (!resolved.ok) continue;
      const nomId = resolved.nomId;
      const cardId = await ensureOpenCardId(employeeId);
      
      if (!cardIdByEmployee.has(cardId)) {
        cardIdByEmployee.set(cardId, cardId);
        report.cards.opened++;
      }
      const dup = await db
        .select({ id: ppeIssueEntries.id })
        .from(ppeIssueEntries)
        .where(
          and(
            eq(ppeIssueEntries.cardId, cardId as never),
            eq(ppeIssueEntries.nomenclatureId, nomId as never),
            eq(ppeIssueEntries.issuedAt, issuedAt as never),
            eq(ppeIssueEntries.qty, qty as never),
            isNull(ppeIssueEntries.deletedAt),
          ),
        )
        .limit(1);
      
      if (dup[0]) {
        report.entries.skipped++;
        continue;
      }
      await db.insert(ppeIssueEntries).values({
        id: randomUUID() as never,
        cardId: cardId as never,
        nomenclatureId: nomId as never,
        qty,
        issuedAt: issuedAt as never,
        documentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        syncStatus: 'pending',
      });
      report.entries.created++;
      
    }
    return { ok: true, report };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function previewPpeImport(args: { filename: string; contentBase64: string }): Promise<
  Result<{ previewId: string; expiresAt: number; sheets: { employees: string | null; issues: string | null }; preview: PpeImportPreview }>
> {
  try {
    const raw = String(args.contentBase64 ?? '');
    if (!raw) return { ok: false, error: 'contentBase64 обязателен' };
    let buffer: Buffer;
    try {
      buffer = Buffer.from(raw, 'base64');
    } catch {
      return { ok: false, error: 'contentBase64 не base64' };
    }
    if (buffer.length === 0 || buffer.length > PPE_IMPORT_MAX_BYTES) return { ok: false, error: 'файл пуст или больше 10 МБ' };
    const parsed = await parsePpeImportWorkbook(buffer);
    if (!parsed.ok) return parsed;
    const snapshot = await loadPpeImportSnapshot();
    const { preview } = validatePpeImport(parsed.parsed, snapshot);
    const fileHash = sha256Hex(buffer);
    const previewId = signPpePreviewToken(fileHash);
    return {
      ok: true,
      previewId,
      expiresAt: Date.now() + PPE_IMPORT_PREVIEW_TTL_MS,
      sheets: { employees: parsed.parsed.employeeSheet, issues: parsed.parsed.issueSheet },
      preview,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
