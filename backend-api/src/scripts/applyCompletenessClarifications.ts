import { existsSync, readFileSync } from 'node:fs';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AttributeDataType, EntityTypeCode } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import type { AuthUser } from '../auth/jwt.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';
import { createEntity, setEntityAttribute, upsertAttributeDef, upsertEntityType } from '../services/adminMasterdataService.js';
import { getRepairChecklistForEngine, listRepairChecklistTemplates, saveRepairChecklistForEngine } from '../services/checklistService.js';
import { createPart, listPartBrandLinks, upsertPartBrandLink } from '../services/partsService.js';

const DEFAULT_CORRECTION_FILES = ['/home/valstan/уточнение1.csv', '/home/valstan/уточнение2.csv'];
const APPLY_SYNC_CONFLICTS = (() => {
  const raw = process.env.MATRICA_IMPORT_ALLOW_SYNC_CONFLICTS?.toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'off', 'no'].includes(raw);
})();
const IGNORE_FAILURES = process.argv.includes('--ignore-failures') || process.env.MATRICA_IMPORT_IGNORE_FAILURES === '1';

type ClarificationPart = {
  qty: number;
  isScrapAll: boolean;
};

type ClarificationEngineRow = {
  supplierRaw: string;
  supplierNormalized: string;
  brandRaw: string;
  brandKey: string;
  brandName: string;
  engineRaw: string;
  engineNumber: string;
  parts: Map<string, ClarificationPart>;
};

type ParsedPartDescriptor = {
  name: string;
  brandAssemblyPairs: Array<{ brandKeys: string[]; assemblyUnitNumber: string }>;
  isScrapAll: boolean;
};

type PartColumnHeader = {
  index: number;
  key: string;
  name: string;
  brandAssemblyPairs: Array<{ brandKeys: string[]; assemblyUnitNumber: string }>;
  isScrapAll: boolean;
};

type CatalogPart = {
  id: string;
  name: string;
  assemblyUnitNumber: string | null;
  key: string;
};

type DefectChecklistRow = {
  part_name: string;
  part_number: string;
  quantity: number;
  repairable_qty: number;
  scrap_qty: number;
};

type CompletenessChecklistRow = {
  part_name: string;
  assembly_unit_number: string;
  quantity: number;
  present: boolean;
  actual_qty: number;
};

function nowMs() {
  return Date.now();
}

function logStage(stage: string, payload?: Record<string, unknown>) {
  const row = payload ? { stage, ...payload } : { stage };
  console.log(`[clarification] ${JSON.stringify(row)}`);
}

function cleanCell(value: string): string {
  return String(value ?? '')
    .replaceAll('\ufeff', '')
    .replaceAll('\u00a0', ' ')
    .replaceAll('\r', '')
    .replaceAll('\n', ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function normalizeToken(value: string): string {
  return cleanCell(value)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/[^a-zа-я0-9]+/gi, '');
}

function normalizeHeaderToken(value: string): string {
  return cleanCell(value)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/\s+/g, ' ');
}

function normalizeCounterparty(value: string): string {
  return cleanCell(value)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function normalizeBrandKey(raw: string): string {
  const base = cleanCell(raw)
    .toUpperCase()
    .replaceAll('Ё', 'Е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/[^0-9A-ZА-Я]+/g, '');

  if (base === 'В59У') return 'В59УМС';
  if (base === 'В462С1') return 'В462С1';
  return base;
}

function canonicalBrandName(raw: string, brandKey: string): string {
  const known: Record<string, string> = {
    В59УМС: 'В-59 УМС',
    В84: 'В-84',
    В84АМС: 'В-84 АМС',
    В84ДТ: 'В-84 ДТ',
    В84МБ1С: 'В-84 МБ-1С',
    В465С: 'В-46-5С',
    В462С1: 'В-46-2С1',
    В461: 'В-46-1',
    В46: 'В-46',
  };
  return known[brandKey] ?? cleanCell(raw).toUpperCase();
}

function normalizeEngineNumber(raw: string): string {
  return cleanCell(raw).replace(/\s*\(\d{4}\s*г\)\s*$/i, '').trim();
}

function detectDelimiter(line: string): ';' | '\t' {
  const semicolonCount = (line.match(/;/g) ?? []).length;
  const tabCount = (line.match(/\t/g) ?? []).length;
  return semicolonCount >= tabCount ? ';' : '\t';
}

function parseDelimitedLine(line: string, delimiter: ';' | '\t'): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      out.push(cleanCell(cur));
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cleanCell(cur));
  return out;
}

function safeJsonParse(value: string | null | undefined): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isServiceHeader(header: string): boolean {
  const normalized = normalizeHeaderToken(header);
  if (!normalized) return true;
  const excluded = ['дата прихода', 'дата отгрузки', 'поставщик', 'марка дв', 'договор', 'номер двигателя', 'изменения от'];
  return excluded.some((x) => normalized.includes(x));
}

function parseNumericQty(value: string): number {
  const text = cleanCell(value);
  if (!text) return 0;
  const m = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return 0;
  const matched = m[1];
  if (!matched) return 0;
  const n = Number(matched.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function partKey(name: string, _assemblyUnitNumber?: string | null): string {
  return normalizeToken(name);
}

function stripHeaderSuffixes(raw: string): string {
  return cleanCell(raw)
    .replace(/,\s*\d+\s*шт\.?\s*/gi, '')
    .replace(/\(\s*100\s*%?\s*зам[^)]*\)\s*/gi, '')
    .replace(/\(\s*100\s*%\s*\)\s*/gi, '')
    .trim();
}

function normalizeAssembly(rawAssembly: string): string {
  return cleanCell(rawAssembly).replace(/^сб\.?\s*/i, '').trim();
}

function parseBrandAssemblyPairs(rawHeader: string): Array<{ brandKeys: string[]; assemblyUnitNumber: string }> {
  const source = stripHeaderSuffixes(cleanCell(rawHeader));
  if (!source) return [];

  const seenByAssembly = new Map<string, Set<string>>();

  const addPair = (assemblyRaw: string, label: string): void => {
    const assemblyUnitNumber = normalizeAssembly(assemblyRaw);
    if (!assemblyUnitNumber) return;

    const chunks = label
      .split(',')
      .map((value) => cleanCell(value))
      .filter((value) => Boolean(value));
    const brandKeys = new Set<string>();

    for (const chunk of chunks) {
      const m = chunk.match(/^(.*?)(В[-\s]*\d{1,3}(?:[-\s]*[А-ЯA-ZА-Яа-я0-9]+)*)\s*$/i);
      if (!m?.[2]) {
        continue;
      }
      const brandKey = normalizeBrandKey(cleanCell(m[2]));
      if (brandKey) brandKeys.add(brandKey);
    }
    const set = seenByAssembly.get(assemblyUnitNumber) ?? new Set<string>();
    for (const key of brandKeys) set.add(key);
    seenByAssembly.set(assemblyUnitNumber, set);
  };

  for (const segment of source.split(';').map((value) => cleanCell(value)).filter(Boolean)) {
    const match = segment.match(/^(.*)\(\s*сб\.?\s*([^)]+)\s*\)\s*$/i);
    if (!match?.[1] || !match?.[2]) continue;
    addPair(match[2], match[1]);
  }

  if (seenByAssembly.size === 0) {
    const lead = source.match(/^((?:Сб\.?\s*)?[0-9][0-9A-Za-zА-Яа-я./,\- ]{3,80})\s+([А-ЯA-ZЁ].+)$/i);
    if (lead?.[1] && lead[2]) {
      addPair(lead[1], lead[2]);
    }
  }

  const brandAssemblyPairs: Array<{ brandKeys: string[]; assemblyUnitNumber: string }> = [];
  for (const [assemblyUnitNumber, keysSet] of seenByAssembly.entries()) {
    brandAssemblyPairs.push({
      brandKeys: [...keysSet].sort((a, b) => a.localeCompare(b)),
      assemblyUnitNumber,
    });
  }

  return brandAssemblyPairs;
}

function resolveAssemblyForBrand(pairs: Array<{ brandKeys: string[]; assemblyUnitNumber: string }>, brandKeyRaw: string): string {
  const targetBrandKey = normalizeBrandKey(brandKeyRaw);
  if (!targetBrandKey) {
    const fallback = pairs.find((p) => p.brandKeys.length === 0);
    return cleanCell(fallback?.assemblyUnitNumber ?? '');
  }
  for (const pair of pairs) {
    if (pair.brandKeys.includes(targetBrandKey)) return cleanCell(pair.assemblyUnitNumber);
  }
  const fallback = pairs.find((p) => p.brandKeys.length === 0);
  return cleanCell(fallback?.assemblyUnitNumber ?? '');
}

function parsePartDescriptor(rawHeader: string): ParsedPartDescriptor | null {
  const source = stripHeaderSuffixes(cleanCell(rawHeader));
  if (!source) return null;

  const brandAssemblyPairs = parseBrandAssemblyPairs(source);
  if (brandAssemblyPairs.length === 0) return null;

  const isScrapAll = /\(\s*100\s*%?\s*зам\)/i.test(rawHeader);
  const nameCandidates = new Set<string>();
  for (const segment of source.split(';').map((value) => cleanCell(value)).filter(Boolean)) {
    const partLabel = segment.replace(/\(\s*сб\.?\s*[^)]+\s*\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!partLabel) continue;

    for (const chunk of partLabel.split(',').map((value) => cleanCell(value)).filter(Boolean)) {
      const m = chunk.match(/^(.*?)(В[-\s]*\d{1,3}(?:[-\s]*[А-ЯA-ZА-Яа-я0-9]+)*)\s*$/i);
      if (!m?.[2]) {
        if (chunk) nameCandidates.add(chunk);
        continue;
      }
      const namePart = cleanCell(m[1] ?? '');
      if (namePart) nameCandidates.add(namePart);
    }
  }

  let name = '';
  for (const candidate of nameCandidates) {
    const cleaned = stripHeaderSuffixes(candidate);
    if (cleaned) {
      name = cleaned;
      break;
    }
  }
  if (!name) {
    const lead = source.match(/^((?:Сб\.?\s*)?[0-9][0-9A-Za-zА-Яа-я./,\- ]{3,80})\s+([А-ЯA-ZЁ].+)$/i);
    if (lead?.[2]) name = stripHeaderSuffixes(lead[2]);
  } else if (/^(?:Сб\.?\s*)?[0-9][0-9A-Za-zА-Яа-я./,\- ]{3,80}\s+/i.test(name)) {
    const lead = name.match(/^((?:Сб\.?\s*)?[0-9][0-9A-Za-zА-Яа-я./,\- ]{3,80})\s+([А-ЯA-ZЁ].+)$/i);
    if (lead?.[2]) name = stripHeaderSuffixes(lead[2]);
  }
  if (!name) return null;

  return {
    name,
    brandAssemblyPairs,
    isScrapAll,
  };
}

function readCsvText(path: string): string {
  const bytes = readFileSync(path);
  const decodeUtf8 = () => {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return '';
    }
  };
  const decodeWin = () => {
    try {
      return new TextDecoder('windows-1251').decode(bytes);
    } catch {
      return '';
    }
  };

  const looksLikeClarificationHeader = (text: string): boolean => {
    const lines = text.split(/\r?\n/);
    const headerLineIndex = lines.findIndex((line) => {
      const normalized = normalizeHeaderToken(line);
      return normalized.includes('марка') && normalized.includes('номер двигателя');
    });
    return headerLineIndex >= 0;
  };

  const utf8Text = decodeUtf8();
  if (utf8Text && looksLikeClarificationHeader(utf8Text)) return utf8Text;

  const winText = decodeWin();
  if (winText && looksLikeClarificationHeader(winText)) return winText;

  if (utf8Text) return utf8Text;
  try {
    return decodeWin();
  } catch {
    return bytes.toString('utf8');
  }
}

function getCorrectionFilePaths(): string[] {
  if (process.argv.length > 2) {
    const args = process.argv
      .slice(2)
      .map((p) => p.trim())
      .filter((p) => Boolean(p) && !p.startsWith('--'));
    if (args.length > 0) return args;
  }
  const envValue = process.env.MATRICA_COMPLETENESS_CORRECTION_FILES?.trim();
  if (envValue) return envValue.split(',').map((p) => p.trim()).filter(Boolean);
  return [...DEFAULT_CORRECTION_FILES];
}

function parseClarificationFile(path: string): { rows: ClarificationEngineRow[]; partHeaders: Map<string, PartColumnHeader> } {
  const text = readCsvText(path);
  const lines = text.split(/\r?\n/);
  const headerLineIndex = lines.findIndex((line) => {
    const normalized = normalizeHeaderToken(line);
    return normalized.includes('марка') && normalized.includes('номер двигателя');
  });
  if (headerLineIndex < 0) {
    throw new Error(`Не найден заголовок в файле ${path}`);
  }

  const headerLine = lines[headerLineIndex] ?? '';
  const delimiter = detectDelimiter(headerLine);
  const headerCells = parseDelimitedLine(headerLine, delimiter);

  const brandCol = headerCells.findIndex((h) => normalizeHeaderToken(h).includes('марка') && normalizeHeaderToken(h).includes('дв'));
  const engineCol = headerCells.findIndex((h) => normalizeHeaderToken(h).includes('номер двигателя'));
  const supplierCol = headerCells.findIndex((h) => normalizeHeaderToken(h).includes('поставщик'));
  if (brandCol < 0 || engineCol < 0) {
    throw new Error(`Не найдены обязательные колонки в файле ${path}`);
  }

  const partColumns: PartColumnHeader[] = [];
  for (let i = engineCol + 1; i < headerCells.length; i += 1) {
    const header = headerCells[i] ?? '';
    if (isServiceHeader(header)) continue;
    const parsed = parsePartDescriptor(header);
    if (!parsed) continue;
    partColumns.push({
      index: i,
      key: partKey(parsed.name),
      name: parsed.name,
      brandAssemblyPairs: parsed.brandAssemblyPairs,
      isScrapAll: parsed.isScrapAll,
    });
  }

  if (partColumns.length === 0) {
    throw new Error(`В файле ${path} не найдены колонки с деталями`);
  }

  const partHeaders = new Map<string, PartColumnHeader>();
  for (const p of partColumns) partHeaders.set(p.key, p);

  const rows: ClarificationEngineRow[] = [];

  for (let i = headerLineIndex + 1; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    if (!rawLine.trim()) continue;

    const columns = parseDelimitedLine(rawLine, delimiter);
    if (columns.every((cell) => !cell)) continue;

    const brandRaw = cleanCell(columns[brandCol] ?? '');
    const engineRaw = cleanCell(columns[engineCol] ?? '');
    const supplierRaw = supplierCol >= 0 ? cleanCell(columns[supplierCol] ?? '') : '';
    if (!brandRaw || !engineRaw) continue;

    const brandKey = normalizeBrandKey(brandRaw);
    const engineNumber = normalizeEngineNumber(engineRaw);
    if (!brandKey || !engineNumber) continue;

    const rowParts = new Map<string, ClarificationPart>();
    for (const part of partColumns) {
      const rawQty = cleanCell(columns[part.index] ?? '');
      const qty = parseNumericQty(rawQty);
      if (!rawQty || qty <= 0) continue;

      const existing = rowParts.get(part.key);
      const mergedQty = existing ? Math.max(existing.qty, qty) : qty;
      rowParts.set(part.key, {
        qty: mergedQty,
        isScrapAll: existing ? existing.isScrapAll || part.isScrapAll : part.isScrapAll,
      });
    }

    if (rowParts.size === 0) continue;

    rows.push({
      supplierRaw,
      supplierNormalized: normalizeCounterparty(supplierRaw),
      brandRaw,
      brandKey,
      brandName: canonicalBrandName(brandRaw, brandKey),
      engineRaw,
      engineNumber,
      parts: rowParts,
    });
  }

  return { rows, partHeaders };
}

function extractDuplicateIdFromError(errorText: string): string | null {
  const match = String(errorText ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match?.[0] ?? null;
}

function normalizeValueForCompare(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return String(value);
}

function collectRowsByEngineAndBrand(rows: ClarificationEngineRow[]): Map<string, ClarificationEngineRow> {
  const out = new Map<string, ClarificationEngineRow>();

  for (const row of rows) {
    const key = `${row.engineNumber}::${row.brandKey}`;
    const existing = out.get(key);

    if (!existing) {
      out.set(key, {
        supplierRaw: row.supplierRaw,
        supplierNormalized: row.supplierNormalized,
        brandRaw: row.brandRaw,
        brandKey: row.brandKey,
        brandName: row.brandName,
        engineRaw: row.engineRaw,
        engineNumber: row.engineNumber,
        parts: new Map(row.parts),
      });
      continue;
    }

    if (!existing.supplierRaw && row.supplierRaw) existing.supplierRaw = row.supplierRaw;
    if (!existing.supplierNormalized && row.supplierNormalized) existing.supplierNormalized = row.supplierNormalized;

    for (const [partKey, info] of row.parts.entries()) {
      const existingPart = existing.parts.get(partKey);
      existing.parts.set(partKey, {
        qty: Math.max(existingPart?.qty ?? 0, info.qty),
        isScrapAll: (existingPart?.isScrapAll ?? false) || info.isScrapAll,
      });
    }
  }

  return out;
}

function mergePartDescriptors(acc: Map<string, PartColumnHeader>, add: Map<string, PartColumnHeader>) {
  for (const [key, h] of add) {
    const existing = acc.get(key);
    if (!existing) {
      acc.set(key, h);
      continue;
    }

    if (!existing.isScrapAll && h.isScrapAll) existing.isScrapAll = true;

    const existingPairsByAssembly = new Map<string, Set<string>>();
    for (const existingPair of existing.brandAssemblyPairs) {
      existingPairsByAssembly.set(existingPair.assemblyUnitNumber, new Set(existingPair.brandKeys));
    }
    for (const pair of h.brandAssemblyPairs) {
      const keys = existingPairsByAssembly.get(pair.assemblyUnitNumber) ?? new Set<string>();
      for (const brandKey of pair.brandKeys) keys.add(brandKey);
      existingPairsByAssembly.set(pair.assemblyUnitNumber, keys);
    }
    existing.brandAssemblyPairs = [...existingPairsByAssembly.entries()].map(([assemblyUnitNumber, brandKeys]) => ({
      assemblyUnitNumber,
      brandKeys: [...brandKeys].sort((a, b) => a.localeCompare(b)),
    }));
  }
}

function partRowsFromDescriptor(
  map: Map<string, PartColumnHeader>,
): Map<string, ParsedPartDescriptor> {
  const out = new Map<string, ParsedPartDescriptor>();
  for (const h of map.values()) {
    out.set(h.key, { name: h.name, brandAssemblyPairs: h.brandAssemblyPairs, isScrapAll: h.isScrapAll });
  }
  return out;
}

function sortRowsForCompare<T extends Record<string, unknown>>(rows: T[], keys: string[]): T[] {
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const av = String(a[key] ?? '');
      const bv = String(b[key] ?? '');
      const cmp = av.localeCompare(bv, 'ru');
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function mapChecklistRows(rawRows: unknown, kind: 'defect' | 'completeness') {
  if (!Array.isArray(rawRows)) return [];
  if (kind === 'defect') {
    const out: DefectChecklistRow[] = [];
    for (const row of rawRows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      out.push({
        part_name: String(r.part_name ?? ''),
        part_number: String(r.part_number ?? ''),
        quantity: Number(r.quantity ?? 0) || 0,
        repairable_qty: Number(r.repairable_qty ?? 0) || 0,
        scrap_qty: Number(r.scrap_qty ?? 0) || 0,
      });
    }
    return out;
  }

  const out: CompletenessChecklistRow[] = [];
  for (const row of rawRows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    out.push({
      part_name: String(r.part_name ?? ''),
      assembly_unit_number: String(r.assembly_unit_number ?? ''),
      quantity: Number(r.quantity ?? 0) || 0,
      present: Boolean(r.present),
      actual_qty: Number(r.actual_qty ?? 0) || 0,
    });
  }
  return out;
}

function areChecklistMetaEqual(existingPayload: unknown, engineBrand: string, engineNumber: string): boolean {
  if (!existingPayload || typeof existingPayload !== 'object') return false;
  const payload = existingPayload as Record<string, unknown>;
  const answers = payload.answers;
  if (!answers || typeof answers !== 'object') return false;
  const ans = answers as Record<string, unknown>;
  const answerBrand = ans.engine_brand;
  const answerNumber = ans.engine_number;
  if (!answerBrand || !answerNumber || typeof answerBrand !== 'object' || typeof answerNumber !== 'object') return false;
  const brandValue = (answerBrand as { value?: unknown }).value;
  const numberValue = (answerNumber as { value?: unknown }).value;
  if (brandValue == null || numberValue == null) return false;
  return String(brandValue) === String(engineBrand) && String(numberValue) === String(engineNumber);
}

function areDefectRowsEqual(existingPayload: unknown, expectedRows: DefectChecklistRow[]): boolean {
  if (!existingPayload || typeof existingPayload !== 'object') return false;
  const payload = existingPayload as Record<string, unknown>;
  const answers = payload.answers;
  if (!answers || typeof answers !== 'object') return false;
  const ans = answers as Record<string, unknown>;
  if (!ans.defect_items || typeof ans.defect_items !== 'object') return false;
  const answer = ans.defect_items as { rows?: unknown };
  const existingRows = mapChecklistRows(answer.rows, 'defect');
  if (!existingRows.every((row): row is DefectChecklistRow => 'repairable_qty' in row)) {
    return false;
  }
  const sortedExpected = sortRowsForCompare(expectedRows, ['part_number', 'part_name']);
  const sortedExisting = sortRowsForCompare(existingRows, ['part_number', 'part_name']);
  return JSON.stringify(sortedExisting) === JSON.stringify(sortedExpected);
}

function areCompletenessRowsEqual(existingPayload: unknown, expectedRows: CompletenessChecklistRow[]): boolean {
  if (!existingPayload || typeof existingPayload !== 'object') return false;
  const payload = existingPayload as Record<string, unknown>;
  const answers = payload.answers;
  if (!answers || typeof answers !== 'object') return false;
  const ans = answers as Record<string, unknown>;
  if (!ans.completeness_items || typeof ans.completeness_items !== 'object') return false;
  const answer = ans.completeness_items as { rows?: unknown };
  const existingRows = mapChecklistRows(answer.rows, 'completeness');
  if (!existingRows.every((row): row is CompletenessChecklistRow => 'actual_qty' in row)) {
    return false;
  }
  const sortedExpected = sortRowsForCompare(expectedRows, ['part_name', 'assembly_unit_number']);
  const sortedExisting = sortRowsForCompare(existingRows, ['part_name', 'assembly_unit_number']);
  return JSON.stringify(sortedExisting) === JSON.stringify(sortedExpected);
}
async function loadTypeIdByCode(code: string): Promise<string> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);

  if (!rows[0]?.id) throw new Error(`Не найден тип сущностей: ${code}`);
  return String(rows[0].id);
}

async function loadAttrDefsByType(entityTypeId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId), isNull(attributeDefs.deletedAt)))
    .orderBy(attributeDefs.sortOrder)
    .limit(1000);

  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.code) out.set(String(row.code), String(row.id));
  }
  return out;
}

async function ensureSuperadminActor(): Promise<AuthUser> {
  const id = await getSuperadminUserId();
  if (!id) throw new Error('Не найден superadmin user');
  return { id, username: 'superadmin', role: 'superadmin' } as AuthUser;
}

async function ensureBrandInfra(actor: AuthUser): Promise<{ id: string; nameDefId: string }> {
  const typeResult = await upsertEntityType(actor, {
    code: EntityTypeCode.EngineBrand,
    name: 'Марка двигателя',
  });

  if (!typeResult.ok || !typeResult.id) throw new Error('Не удалось подготовить тип марка двигателя');
  const typeId = typeResult.id;

  const nameDef = await upsertAttributeDef(actor, {
    entityTypeId: typeId,
    code: 'name',
    name: 'Наименование',
    dataType: AttributeDataType.Text,
    sortOrder: 10,
  });

  if (!nameDef.ok || !nameDef.id) throw new Error('Не удалось подготовить атрибут name у марок');
  return { id: typeId, nameDefId: String(nameDef.id) };
}

async function ensureCustomerInfra(actor: AuthUser): Promise<{ id: string; nameDefId: string }> {
  const typeResult = await upsertEntityType(actor, {
    code: EntityTypeCode.Customer,
    name: 'Контрагенты',
  });
  if (!typeResult.ok || !typeResult.id) throw new Error('Не удалось подготовить тип контрагентов');

  const typeId = typeResult.id;
  const nameDef = await upsertAttributeDef(actor, {
    entityTypeId: typeId,
    code: 'name',
    name: 'Наименование',
    dataType: AttributeDataType.Text,
    sortOrder: 10,
  });
  if (!nameDef.ok || !nameDef.id) throw new Error('Не удалось подготовить атрибут name у контрагентов');
  return { id: typeId, nameDefId: String(nameDef.id) };
}

async function ensureEngineInfra(actor: AuthUser): Promise<{ typeId: string; defs: Map<string, string> }> {
  const typeResult = await upsertEntityType(actor, {
    code: EntityTypeCode.Engine,
    name: 'Двигатель',
  });
  if (!typeResult.ok || !typeResult.id) throw new Error('Не удалось подготовить тип двигателя');

  const engineTypeId = typeResult.id;
  await upsertAttributeDef(actor, {
    entityTypeId: engineTypeId,
    code: 'engine_number',
    name: 'Номер двигателя',
    dataType: AttributeDataType.Text,
    sortOrder: 10,
  });
  await upsertAttributeDef(actor, {
    entityTypeId: engineTypeId,
    code: 'engine_brand',
    name: 'Марка двигателя',
    dataType: AttributeDataType.Text,
    sortOrder: 20,
  });
  await upsertAttributeDef(actor, {
    entityTypeId: engineTypeId,
    code: 'engine_brand_id',
    name: 'Марка двигателя (справочник)',
    dataType: AttributeDataType.Link,
    sortOrder: 25,
    metaJson: JSON.stringify({ linkTargetTypeCode: EntityTypeCode.EngineBrand }),
  });
  await upsertAttributeDef(actor, {
    entityTypeId: engineTypeId,
    code: 'customer_id',
    name: 'Контрагент',
    dataType: AttributeDataType.Link,
    sortOrder: 30,
    metaJson: JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Customer }),
  });

  const defs = await loadAttrDefsByType(engineTypeId);
  return { typeId: engineTypeId, defs };
}

async function loadCustomerByNormalizedName(customerTypeId: string, customerNameDefId: string): Promise<Map<string, string>> {
  const customerRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, customerTypeId), isNull(entities.deletedAt)))
    .limit(200_000);

  const customerIds = customerRows.map((row) => String(row.id));
  if (customerIds.length === 0) return new Map();

  const values = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, customerIds as any), eq(attributeValues.attributeDefId, customerNameDefId), isNull(attributeValues.deletedAt)))
    .limit(200_000);

  const map = new Map<string, string>();
  for (const row of values) {
    const parsed = safeJsonParse(row.valueJson == null ? null : String(row.valueJson));
    if (typeof parsed !== 'string') continue;
    const normalized = normalizeCounterparty(parsed);
    if (!normalized) continue;
    if (!map.has(normalized)) map.set(normalized, String(row.entityId));
  }
  return map;
}

async function loadBrandByKey(brandTypeId: string, brandNameDefId: string): Promise<Map<string, string>> {
  const brandRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, brandTypeId), isNull(entities.deletedAt)))
    .limit(200_000);

  const brandIds = brandRows.map((row) => String(row.id));
  if (brandIds.length === 0) return new Map();

  const values = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, brandIds as any), eq(attributeValues.attributeDefId, brandNameDefId), isNull(attributeValues.deletedAt)))
    .limit(200_000);

  const map = new Map<string, string>();
  for (const row of values) {
    const parsed = safeJsonParse(row.valueJson == null ? null : String(row.valueJson));
    if (typeof parsed !== 'string') continue;
    const key = normalizeBrandKey(parsed);
    if (!key) continue;
    if (!map.has(key)) map.set(key, String(row.entityId));
  }
  return map;
}

async function loadPartCatalog(): Promise<Map<string, CatalogPart>> {
  const partTypeId = await loadTypeIdByCode(EntityTypeCode.Part);
  const defByCode = await loadAttrDefsByType(partTypeId);
  const nameDefId = defByCode.get('name');
  if (!nameDefId) {
    return new Map();
  }

  const asmDefId = defByCode.get('assembly_unit_number') ?? null;

  const partRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, partTypeId), isNull(entities.deletedAt)))
    .limit(500_000);

  const partIds = partRows.map((row) => String(row.id));
  if (partIds.length === 0) return new Map();

  const values = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, partIds as any),
        inArray(attributeValues.attributeDefId, [nameDefId, asmDefId].filter(Boolean) as string[]),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1_000_000);

  const byPart = new Map<string, Record<string, unknown>>();
  for (const row of values) {
    const map = byPart.get(String(row.entityId)) ?? {};
    const defCode = row.attributeDefId === nameDefId ? 'name' : row.attributeDefId === asmDefId ? 'assembly_unit_number' : null;
    if (!defCode) continue;
    map[defCode] = safeJsonParse(row.valueJson == null ? null : String(row.valueJson));
    byPart.set(String(row.entityId), map);
  }

  const out = new Map<string, CatalogPart>();
  for (const row of partRows) {
    const data = byPart.get(String(row.id)) ?? {};
    const name = typeof data.name === 'string' ? data.name : '';
    if (!name) continue;

    const assemblyUnitNumber = typeof data.assembly_unit_number === 'string' ? (data.assembly_unit_number as string) : null;
    const key = partKey(name);
    out.set(key, {
      id: String(row.id),
      name,
      assemblyUnitNumber,
      key,
    });
  }

  return out;
}

async function loadEngineIdByNumber(): Promise<Map<string, string>> {
  const engineTypeId = await loadTypeIdByCode(EntityTypeCode.Engine);
  const defs = await loadAttrDefsByType(engineTypeId);
  const engineNumberDefId = defs.get('engine_number');
  if (!engineNumberDefId) return new Map();

  const engineRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, engineTypeId), isNull(entities.deletedAt)))
    .limit(500_000);

  const engineIds = engineRows.map((row) => String(row.id));
  if (engineIds.length === 0) return new Map();

  const values = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(inArray(attributeValues.entityId, engineIds as any), eq(attributeValues.attributeDefId, engineNumberDefId), isNull(attributeValues.deletedAt)),
    )
    .limit(500_000);

  const byId = new Map<string, string>();
  for (const row of values) {
    const raw = safeJsonParse(row.valueJson == null ? null : String(row.valueJson));
    if (typeof raw !== 'string') continue;
    const normalized = normalizeEngineNumber(raw);
    if (!normalized) continue;
    if (!byId.has(normalized)) byId.set(normalized, String(row.entityId));
  }

  return byId;
}

async function loadEngineAttributeCache(engineIds: string[]): Promise<Map<string, Map<string, unknown>>> {
  if (engineIds.length === 0) return new Map();
  const engineTypeId = await loadTypeIdByCode(EntityTypeCode.Engine);
  const defs = await loadAttrDefsByType(engineTypeId);
  const defIds = [defs.get('engine_number'), defs.get('engine_brand'), defs.get('engine_brand_id'), defs.get('customer_id')].filter(Boolean);
  if (defIds.length === 0) return new Map();

  const byDef: { [id: string]: string } = {};
  for (const [code, id] of defs.entries()) {
    if (['engine_number', 'engine_brand', 'engine_brand_id', 'customer_id'].includes(code)) byDef[id] = code;
  }

  const rows = await db
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, engineIds as any), inArray(attributeValues.attributeDefId, defIds as string[]), isNull(attributeValues.deletedAt)))
    .limit(1_000_000);

  const out = new Map<string, Map<string, unknown>>();
  for (const row of rows) {
    const code = byDef[String(row.attributeDefId)];
    if (!code) continue;
    const map = out.get(String(row.entityId)) ?? new Map<string, unknown>();
    const parsed = safeJsonParse(row.valueJson == null ? null : String(row.valueJson));
    map.set(code, parsed);
    out.set(String(row.entityId), map);
  }

  return out;
}

async function setAttributeWithRetry(
  actor: AuthUser,
  entityId: string,
  code: string,
  value: unknown,
  options: { touchEntity?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const touchEntity = options.touchEntity ?? false;
  let res: { ok: boolean; error?: string };
  try {
    res = await setEntityAttribute(actor, entityId, code, value, {
      touchEntity,
      allowSyncConflicts: false,
    });
  } catch (error) {
    if (APPLY_SYNC_CONFLICTS && String(error).includes('sync_conflict')) {
      try {
        res = await setEntityAttribute(actor, entityId, code, value, {
          touchEntity,
          allowSyncConflicts: true,
        });
      } catch (retryError) {
        return { ok: false, error: String(retryError) };
      }
    } else {
      return { ok: false, error: String(error) };
    }
  }

  if (!res.ok && APPLY_SYNC_CONFLICTS && String(res.error).includes('sync_conflict')) {
    res = await setEntityAttribute(actor, entityId, code, value, {
      touchEntity,
      allowSyncConflicts: true,
    });
  }

  return res;
}

async function upsertChecklistsForEngine(
  engineId: string,
  row: ClarificationEngineRow,
  partHeaders: Map<string, PartColumnHeader>,
  catalog: Map<string, CatalogPart>,
  templates: {
    defectTemplateId: string;
    defectTemplateVersion: number;
    completenessTemplateId: string;
    completenessTemplateVersion: number;
  },
  actor: AuthUser,
): Promise<{ updated: boolean }> {
  const defectRows: DefectChecklistRow[] = [];
  const completenessRows: CompletenessChecklistRow[] = [];

  for (const [key, partInfo] of row.parts.entries()) {
    const header = partHeaders.get(key);
    const catalogPart = catalog.get(key);
    const partName = header?.name || catalogPart?.name || '';
    const resolvedAssembly = cleanCell(resolveAssemblyForBrand(header?.brandAssemblyPairs ?? [], row.brandKey));
    const partNumber = resolvedAssembly || catalogPart?.assemblyUnitNumber || '';
    const qty = partInfo.qty;
    const scrapQty = partInfo.isScrapAll ? qty : 0;
    const repairableQty = Math.max(qty - scrapQty, 0);

    defectRows.push({
      part_name: partName,
      part_number: partNumber,
      quantity: qty,
      repairable_qty: repairableQty,
      scrap_qty: scrapQty,
    });

    completenessRows.push({
      part_name: partName,
      assembly_unit_number: partNumber,
      quantity: qty,
      present: qty > 0,
      actual_qty: qty,
    });
  }

  const expectedDefectRows = sortRowsForCompare(defectRows, ['part_number', 'part_name']);
  const expectedCompletenessRows = sortRowsForCompare(completenessRows, ['part_name', 'assembly_unit_number']);

  const existingDefect = await getRepairChecklistForEngine(engineId, 'defect');
  if (!existingDefect.ok) {
    throw new Error(`Не удалось прочитать дефектовку для двигателя ${row.engineNumber}: ${existingDefect.error}`);
  }

  const existingCompleteness = await getRepairChecklistForEngine(engineId, 'completeness');
  if (!existingCompleteness.ok) {
    throw new Error(`Не удалось прочитать комплектность для двигателя ${row.engineNumber}: ${existingCompleteness.error}`);
  }

  const existingDefectPayload = existingDefect.payload;
  const existingCompletenessPayload = existingCompleteness.payload;

  const needDefectUpdate =
    !existingDefectPayload ||
    !areChecklistMetaEqual(existingDefectPayload, row.brandName, row.engineNumber) ||
    !areDefectRowsEqual(existingDefectPayload, expectedDefectRows);

  const needCompletenessUpdate =
    !existingCompletenessPayload ||
    !areChecklistMetaEqual(existingCompletenessPayload, row.brandName, row.engineNumber) ||
    !areCompletenessRowsEqual(existingCompletenessPayload, expectedCompletenessRows);

  if (!needDefectUpdate && !needCompletenessUpdate) return { updated: false };

  if (needDefectUpdate) {
    const payload = {
      kind: 'repair_checklist' as const,
      templateId: templates.defectTemplateId,
      templateVersion: templates.defectTemplateVersion,
      stage: 'defect',
      engineEntityId: engineId,
      filledBy: actor.username,
      filledAt: nowMs(),
      answers: {
        engine_brand: { kind: 'text' as const, value: row.brandName },
        engine_number: { kind: 'text' as const, value: row.engineNumber },
        defect_items: { kind: 'table' as const, rows: expectedDefectRows },
      },
      attachments: existingDefectPayload?.attachments ?? [],
    };

    const saved = await saveRepairChecklistForEngine({
      engineId,
      stage: 'defect',
      operationId: existingDefect.operationId,
      payload: payload as any,
      actor: { id: actor.id, username: actor.username },
      allowSyncConflicts: false,
    });

    if (!saved.ok && APPLY_SYNC_CONFLICTS && String(saved.error).includes('sync_conflict')) {
      const savedWithRetry = await saveRepairChecklistForEngine({
        engineId,
        stage: 'defect',
        operationId: existingDefect.operationId,
        payload: payload as any,
        actor: { id: actor.id, username: actor.username },
        allowSyncConflicts: true,
      });
      if (!savedWithRetry.ok) {
        throw new Error(`Не удалось сохранить дефектовку двигателя ${row.engineNumber}: ${savedWithRetry.error}`);
      }
    } else if (!saved.ok) {
      throw new Error(`Не удалось сохранить дефектовку двигателя ${row.engineNumber}: ${saved.error}`);
    }
  }

  if (needCompletenessUpdate) {
    const payload = {
      kind: 'repair_checklist' as const,
      templateId: templates.completenessTemplateId,
      templateVersion: templates.completenessTemplateVersion,
      stage: 'completeness',
      engineEntityId: engineId,
      filledBy: actor.username,
      filledAt: nowMs(),
      answers: {
        engine_brand: { kind: 'text' as const, value: row.brandName },
        engine_number: { kind: 'text' as const, value: row.engineNumber },
        completeness_items: { kind: 'table' as const, rows: expectedCompletenessRows },
      },
      attachments: existingCompletenessPayload?.attachments ?? [],
    };

    const saved = await saveRepairChecklistForEngine({
      engineId,
      stage: 'completeness',
      operationId: existingCompleteness.operationId,
      payload: payload as any,
      actor: { id: actor.id, username: actor.username },
      allowSyncConflicts: false,
    });

    if (!saved.ok && APPLY_SYNC_CONFLICTS && String(saved.error).includes('sync_conflict')) {
      const savedWithRetry = await saveRepairChecklistForEngine({
        engineId,
        stage: 'completeness',
        operationId: existingCompleteness.operationId,
        payload: payload as any,
        actor: { id: actor.id, username: actor.username },
        allowSyncConflicts: true,
      });
      if (!savedWithRetry.ok) {
        throw new Error(`Не удалось сохранить акт комплектности двигателя ${row.engineNumber}: ${savedWithRetry.error}`);
      }
    } else if (!saved.ok) {
      throw new Error(`Не удалось сохранить акт комплектности двигателя ${row.engineNumber}: ${saved.error}`);
    }
  }

  return { updated: true };
}

async function ensureCounterpartyByName(
  supplierNormalized: string,
  supplierRaw: string,
  customerTypeId: string,
  customerNameDefId: string,
  existingByNormalized: Map<string, string>,
  actor: AuthUser,
): Promise<string | null> {
  if (!supplierNormalized) return null;
  const existing = existingByNormalized.get(supplierNormalized);
  if (existing) return existing;

  const created = await createEntity(actor, customerTypeId);
  if (!created.ok || !created.id) {
    throw new Error(`Не удалось создать контрагента: ${supplierRaw}`);
  }

  const setRes = await setAttributeWithRetry(actor, created.id, 'name', supplierRaw, { touchEntity: false });
  if (!setRes.ok) {
    const duplicateId = extractDuplicateIdFromError(setRes.error ?? '');
    if (duplicateId) {
      existingByNormalized.set(supplierNormalized, duplicateId);
      return duplicateId;
    }
    throw new Error(`Не удалось установить наименование контрагента ${supplierRaw}: ${setRes.error}`);
  }

  existingByNormalized.set(supplierNormalized, created.id);
  return created.id;
}

async function ensureBrandByKey(
  brandKey: string,
  brandName: string,
  brandTypeId: string,
  existingByKey: Map<string, string>,
  actor: AuthUser,
): Promise<string> {
  const existing = existingByKey.get(brandKey);
  if (existing) return existing;

  const created = await createEntity(actor, brandTypeId);
  if (!created.ok || !created.id) throw new Error(`Не удалось создать марку двигателя: ${brandName}`);

  const setRes = await setAttributeWithRetry(actor, created.id, 'name', brandName, { touchEntity: false });
  if (!setRes.ok) {
    const duplicateId = extractDuplicateIdFromError(setRes.error ?? '');
    if (duplicateId) {
      existingByKey.set(brandKey, duplicateId);
      return duplicateId;
    }
    throw new Error(`Не удалось установить наименование марки ${brandName}: ${setRes.error}`);
  }

  existingByKey.set(brandKey, created.id);
  return created.id;
}

async function ensurePartForRow(
  partKeyValue: string,
  descriptor: ParsedPartDescriptor,
  targetBrandId: string,
  targetBrandKey: string,
  desiredQty: number,
  catalog: Map<string, CatalogPart>,
  actor: AuthUser,
): Promise<{ created: boolean; changed: boolean }> {
  const rec = catalog.get(partKeyValue);
  const resolvedAssembly = cleanCell(resolveAssemblyForBrand(descriptor.brandAssemblyPairs, targetBrandKey) || rec?.assemblyUnitNumber || 'не указан');

  if (!rec) {
    const created = await createPart({
      actor,
      attributes: {
        name: descriptor.name,
      },
    });

    if (!created.ok) {
      const duplicateId = extractDuplicateIdFromError(created.error ?? '');
      if (!duplicateId) throw new Error(`Не удалось создать деталь ${descriptor.name}: ${created.error}`);

      const fallback: CatalogPart = {
        id: duplicateId,
        name: descriptor.name,
        assemblyUnitNumber: resolvedAssembly || null,
        key: partKeyValue,
      };
      catalog.set(partKeyValue, fallback);
      const upserted = await upsertPartBrandLink({
        actor,
        partId: duplicateId,
        engineBrandId: targetBrandId,
        assemblyUnitNumber: resolvedAssembly,
        quantity: Math.max(0, Math.floor(desiredQty)),
      });
      if (!upserted.ok) throw new Error(`Не удалось создать связь детали ${descriptor.name} с брендом: ${upserted.error}`);
      return { created: false, changed: true };
    }

    const upserted = await upsertPartBrandLink({
      actor,
      partId: created.part.id,
      engineBrandId: targetBrandId,
      assemblyUnitNumber: resolvedAssembly,
      quantity: Math.max(0, Math.floor(desiredQty)),
    });
    if (!upserted.ok) {
      throw new Error(`Не удалось создать связь детали ${descriptor.name} с брендом: ${upserted.error}`);
    }

    const createdPart: CatalogPart = {
      id: created.part.id,
      name: descriptor.name,
      assemblyUnitNumber: resolvedAssembly || null,
      key: partKeyValue,
    };
    catalog.set(partKeyValue, createdPart);
    return { created: true, changed: true };
  }

  let changed = false;
  const existingLinks = await listPartBrandLinks({ partId: rec.id });
  if (!existingLinks.ok) {
    throw new Error(`Не удалось загрузить существующие связи детали ${rec.id}: ${existingLinks.error}`);
  }
  const existingLink = existingLinks.brandLinks.find((link) => link.engineBrandId === targetBrandId);
  const targetQty = Math.floor(desiredQty);

  if (existingLink) {
    const normalizedDesiredQty = Number.isFinite(targetQty) ? targetQty : 0;
    const desiredAssembly = resolvedAssembly || existingLink.assemblyUnitNumber || 'не указан';
    changed = existingLink.assemblyUnitNumber !== desiredAssembly || existingLink.quantity !== normalizedDesiredQty;
    if (changed) {
      const upserted = await upsertPartBrandLink({
        actor,
        partId: rec.id,
        linkId: existingLink.id,
        engineBrandId: targetBrandId,
        assemblyUnitNumber: desiredAssembly,
        quantity: normalizedDesiredQty,
      });
      if (!upserted.ok) {
        throw new Error(`Не удалось обновить связь детали ${rec.id}: ${upserted.error}`);
      }
    }
  } else {
    const upserted = await upsertPartBrandLink({
      actor,
      partId: rec.id,
      engineBrandId: targetBrandId,
      assemblyUnitNumber: resolvedAssembly,
      quantity: Math.max(0, Math.floor(desiredQty)),
    });
    if (!upserted.ok) {
      throw new Error(`Не удалось создать связь детали ${rec.id} с брендом: ${upserted.error}`);
    }
    changed = true;
  }

  return { created: false, changed };
}

async function main() {
  const actor = await ensureSuperadminActor();
  const startedAt = nowMs();

  const correctionFiles = getCorrectionFilePaths();
  const missingFiles = correctionFiles.filter((path) => !existsSync(path));
  if (missingFiles.length > 0) {
    throw new Error(`Не найдены файлы: ${missingFiles.join(', ')}`);
  }

  await ensureBrandInfra(actor);
  await ensureCustomerInfra(actor);
  await ensureEngineInfra(actor);

  const brandTypeId = await loadTypeIdByCode(EntityTypeCode.EngineBrand);
  const customerTypeId = await loadTypeIdByCode(EntityTypeCode.Customer);
  const brandDefs = await loadAttrDefsByType(brandTypeId);
  const customerNameDefId = brandDefs.get('name') ?? (await loadAttrDefsByType(customerTypeId)).get('name') ?? '';

  const brandNameDefId = brandDefs.get('name');
  if (!brandNameDefId || !customerNameDefId) {
    throw new Error('Некорректная схема справочников (код атрибута name).');
  }

  const parsedRows: ClarificationEngineRow[] = [];
  const aggregatedPartHeaders = new Map<string, PartColumnHeader>();
  for (const filePath of correctionFiles) {
    const parsed = parseClarificationFile(filePath);
    parsedRows.push(...parsed.rows);
    mergePartDescriptors(aggregatedPartHeaders, parsed.partHeaders);
    logStage('parsed-file', {
      file: filePath,
      rows: parsed.rows.length,
      partColumns: parsed.partHeaders.size,
    });
  }

  if (parsedRows.length === 0) {
    throw new Error('В файлах уточнений не найдено строк с деталями');
  }

  const mergedRowsByEngineBrand = collectRowsByEngineAndBrand(parsedRows);
  const rows = [...mergedRowsByEngineBrand.values()];

  if (rows.length === 0) {
    throw new Error('После дедупликации строк не осталось данных');
  }

  const partCatalog = await loadPartCatalog();
  const brandMap = await loadBrandByKey(brandTypeId, brandNameDefId);
  const customerMap = await loadCustomerByNormalizedName(customerTypeId, customerNameDefId);

  const partDescriptors = partRowsFromDescriptor(aggregatedPartHeaders);

  let createdBrands = 0;
  let createdCounterparties = 0;
  let reusedCounterparties = 0;
  let createdParts = 0;
  let updatedParts = 0;
  let failedPartRows = 0;

  const targetQtyByBrand = new Map<string, Map<string, ClarificationPart>>();
  for (const row of rows) {
    const existing = targetQtyByBrand.get(row.brandKey) ?? new Map<string, ClarificationPart>();
    for (const [partKeyValue, partInfo] of row.parts.entries()) {
      const existingPart = existing.get(partKeyValue);
      existing.set(partKeyValue, {
        qty: Math.max(existingPart?.qty ?? 0, partInfo.qty),
        isScrapAll: (existingPart?.isScrapAll ?? false) || partInfo.isScrapAll,
      });
    }
    targetQtyByBrand.set(row.brandKey, existing);
  }

  for (const row of rows) {
    await ensureBrandByKey(row.brandKey, row.brandName, brandTypeId, brandMap, actor);
    if (!brandMap.has(row.brandKey)) {
      createdBrands += 1;
    }

    const supplierId = row.supplierNormalized
      ? await ensureCounterpartyByName(
          row.supplierNormalized,
          row.supplierRaw,
          customerTypeId,
          customerNameDefId,
          customerMap,
          actor,
        )
      : null;

    if (supplierId && !customerMap.has(row.supplierNormalized)) {
      createdCounterparties += 1;
    }
    if (row.supplierNormalized) reusedCounterparties += 1;
  }

  for (const [brandKey, byPart] of targetQtyByBrand.entries()) {
    const brandId = brandMap.get(brandKey);
    if (!brandId) {
      throw new Error(`Не найден id марки ${brandKey} после предварительной загрузки/создания`);
    }

    for (const [partKeyValue, value] of byPart.entries()) {
      const descriptor = partDescriptors.get(partKeyValue);
      if (!descriptor) continue;
      try {
        const result = await ensurePartForRow(partKeyValue, descriptor, brandId, brandKey, value.qty, partCatalog, actor);
        createdParts += result.created ? 1 : 0;
        updatedParts += result.changed ? 1 : 0;
      } catch (error) {
        if (!IGNORE_FAILURES) throw error;
        failedPartRows += 1;
        logStage('part-row-failed', {
          brandKey,
          partKey: partKeyValue,
          partName: descriptor.name,
          error: String(error),
        });
      }
    }
  }

  const engineIdByNumber = await loadEngineIdByNumber();
  const targetEngineIds = rows
    .map((row) => engineIdByNumber.get(row.engineNumber))
    .filter((value): value is string => Boolean(value));

  const engineAttributeCache = await loadEngineAttributeCache(targetEngineIds);

  const defectTemplates = await listRepairChecklistTemplates('defect');
  const completenessTemplates = await listRepairChecklistTemplates('completeness');
  if (!defectTemplates.ok || defectTemplates.templates.length === 0) throw new Error('Не удалось получить шаблон дефектовки');
  if (!completenessTemplates.ok || completenessTemplates.templates.length === 0) throw new Error('Не удалось получить шаблон комплектоности');

  const defectTemplate = defectTemplates.templates[0];
  const completenessTemplate = completenessTemplates.templates[0];
  if (!defectTemplate || !completenessTemplate) {
    throw new Error('Не удалось получить шаблоны чеклистов');
  }

  const templates = {
    defectTemplateId: defectTemplate.id,
    defectTemplateVersion: (typeof (defectTemplate as { version?: unknown }).version === 'number' ? defectTemplate.version : 1) ?? 1,
    completenessTemplateId: completenessTemplate.id,
    completenessTemplateVersion: (typeof (completenessTemplate as { version?: unknown }).version === 'number' ? completenessTemplate.version : 1) ?? 1,
  };

  let enginesUpdated = 0;
  let engineAttrChanges = 0;
  let checklistsUpdated = 0;
  let enginesMissing = 0;
  const missingEngineNumbers: string[] = [];

  for (const row of rows) {
    const engineId = engineIdByNumber.get(row.engineNumber);
    if (!engineId) {
      enginesMissing += 1;
      missingEngineNumbers.push(row.engineNumber);
      continue;
    }

    const brandId = brandMap.get(row.brandKey);
    if (!brandId) {
      throw new Error(`Не найден id марки ${row.brandKey} после предварительной загрузки/создания`);
    }

    const customerId = row.supplierNormalized ? customerMap.get(row.supplierNormalized) ?? null : null;
    const attrCache = engineAttributeCache.get(engineId) ?? new Map<string, unknown>();

    const targetAttributes: Array<[string, unknown]> = [];
    if (normalizeValueForCompare(attrCache.get('engine_brand')) !== normalizeValueForCompare(row.brandName)) {
      targetAttributes.push(['engine_brand', row.brandName]);
    }
    if (normalizeValueForCompare(attrCache.get('engine_brand_id')) !== normalizeValueForCompare(brandId)) {
      targetAttributes.push(['engine_brand_id', brandId]);
    }
    if (customerId && normalizeValueForCompare(attrCache.get('customer_id')) !== normalizeValueForCompare(customerId)) {
      targetAttributes.push(['customer_id', customerId]);
    }

    for (const [code, value] of targetAttributes) {
      const res = await setAttributeWithRetry(actor, engineId, code, value, { touchEntity: false });
      if (!res.ok) throw new Error(`Не удалось обновить атрибут двигателя ${row.engineNumber}: ${res.error}`);
      engineAttrChanges += 1;
    }
    if (targetAttributes.length > 0) enginesUpdated += 1;

    const updated = await upsertChecklistsForEngine(engineId, row, aggregatedPartHeaders, partCatalog, templates, actor);
    if (updated.updated) {
      checklistsUpdated += 1;
      enginesUpdated += 1;
    }
  }

  const endedAt = nowMs();
  logStage('result', {
    files: correctionFiles,
    rowsParsed: parsedRows.length,
    rowsMerged: rows.length,
    createdBrands,
    createdCounterparties,
    reusedCounterparties,
    createdParts,
    updatedParts,
    failedPartRows,
    engineAttrChanges,
    enginesUpdated,
    enginesMissing,
    checklistsUpdated,
    missingEngineNumbers: missingEngineNumbers.slice(0, 20),
    elapsedMs: endedAt - startedAt,
  });
}

main().catch((error) => {
  console.error('[clarification] failed', error);
  process.exit(1);
});
