import { existsSync, readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AttributeDataType, EntityTypeCode, parseContractSections } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities } from '../database/schema.js';
import type { AuthUser } from '../auth/jwt.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';
import { createEntity, setEntityAttribute, upsertAttributeDef, upsertEntityType } from '../services/adminMasterdataService.js';

type ParsedContractRow = {
  sourceFile: string;
  lineNo: number;
  hasFiles: boolean;
  name: string;
  igk: string;
  contractNumber: string;
  separateAccountRaw: string;
  separateAccountNumber: string;
  separateAccountBank: string;
  signedAt: number | null;
  dueAt: number | null;
  comment: string;
};

type ExistingContract = {
  id: string;
  createdAt: number;
  attrs: Record<string, unknown>;
};

type ParsedFileStats = {
  file: string;
  processed: boolean;
  rowsTotal: number;
  rowsAccepted: number;
  rowsSkipped: number;
  note?: string;
};

const SOURCE_FILES = ['/home/valstan/контракты ГОЗ.csv', '/home/valstan/контракты ГОЗ.txt'] as const;

function cleanCell(value: unknown): string {
  return String(value ?? '')
    .replaceAll('\u00a0', ' ')
    .replaceAll('\ufeff', '')
    .replaceAll('\r', '')
    .replaceAll('\n', ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function normalizeToken(value: unknown): string {
  return cleanCell(value)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/[^a-z0-9а-я]+/gi, '');
}

function normalizeHeader(value: unknown): string {
  return cleanCell(value).toLowerCase().replaceAll('ё', 'е').replaceAll(/\s+/g, ' ');
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
    if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((v) => cleanCell(v));
}

function detectDelimiter(line: string): ';' | '\t' {
  const semicolons = (line.match(/;/g) ?? []).length;
  const tabs = (line.match(/\t/g) ?? []).length;
  return semicolons >= tabs ? ';' : '\t';
}

function parseRuDate(raw: string): number | null {
  const value = cleanCell(raw);
  if (!value) return null;
  const m = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;
  if (year < 100) year += 2000;
  const dt = new Date(year, month - 1, day, 0, 0, 0, 0);
  const ts = dt.getTime();
  if (!Number.isFinite(ts)) return null;
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
  return ts;
}

function parseBoolean(raw: string): boolean {
  const value = cleanCell(raw).toLowerCase();
  if (!value) return false;
  if (/^\d+$/.test(value)) return Number(value) > 0;
  return value === 'да' || value === 'yes' || value === 'true' || value === '+' || value === 'y';
}

function parseSeparateAccount(raw: string): { separateAccountNumber: string; separateAccountBank: string } {
  const cleaned = cleanCell(raw);
  if (!cleaned) return { separateAccountNumber: '', separateAccountBank: '' };

  const parts = cleaned.split(',');
  const firstPart = cleanCell(parts[0] ?? '');
  const tail = cleanCell(parts.slice(1).join(','));
  const accountMatch = firstPart.match(/\d{10,32}/) ?? cleaned.match(/\d{10,32}/);
  const separateAccountNumber = accountMatch?.[0] ? cleanCell(accountMatch[0]) : '';
  const separateAccountBank = tail || (separateAccountNumber ? cleanCell(cleaned.replace(separateAccountNumber, '').replace(/^,\s*/, '')) : '');
  return { separateAccountNumber, separateAccountBank };
}

function readTextFile(filePath: string): string {
  const buf = readFileSync(filePath);
  if (filePath.toLowerCase().endsWith('.txt')) {
    try {
      return new TextDecoder('windows-1251').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
  return buf.toString('utf8');
}

function parseContractsFile(filePath: string): { rows: ParsedContractRow[]; stats: ParsedFileStats } {
  if (!existsSync(filePath)) {
    return {
      rows: [],
      stats: { file: filePath, processed: false, rowsTotal: 0, rowsAccepted: 0, rowsSkipped: 0, note: 'файл не найден' },
    };
  }

  const text = readTextFile(filePath);
  const lines = text.split(/\r?\n/);
  const headerLineIdx = lines.findIndex((line) => {
    const h = normalizeHeader(line);
    return h.includes('наименование') && h.includes('игк') && h.includes('номер контракта');
  });
  if (headerLineIdx < 0) {
    return {
      rows: [],
      stats: { file: filePath, processed: false, rowsTotal: 0, rowsAccepted: 0, rowsSkipped: 0, note: 'заголовок не найден' },
    };
  }

  const headerLine = lines[headerLineIdx] ?? '';
  const delimiter = detectDelimiter(headerLine);
  const headers = parseDelimitedLine(headerLine, delimiter);

  const idxHasFiles = headers.findIndex((h) => normalizeHeader(h).includes('есть файлы'));
  const idxName = headers.findIndex((h) => normalizeHeader(h).includes('наименование'));
  const idxIgk = headers.findIndex((h) => normalizeHeader(h) === 'игк' || normalizeHeader(h).includes('игк'));
  const idxContractNumber = headers.findIndex((h) => normalizeHeader(h).includes('номер контракта'));
  const idxSeparateAccount = headers.findIndex((h) => normalizeHeader(h).includes('отдельный счет'));
  const idxDate = headers.findIndex((h) => normalizeHeader(h).includes('дата заключения'));
  const idxDue = headers.findIndex((h) => normalizeHeader(h).includes('плановая дата исполнения'));
  const idxComment = headers.findIndex((h) => normalizeHeader(h).includes('комментар'));

  if (idxName < 0 || idxContractNumber < 0 || idxIgk < 0) {
    return {
      rows: [],
      stats: {
        file: filePath,
        processed: false,
        rowsTotal: 0,
        rowsAccepted: 0,
        rowsSkipped: 0,
        note: 'необходимые колонки не найдены',
      },
    };
  }

  const rows: ParsedContractRow[] = [];
  let rowsTotal = 0;
  let rowsSkipped = 0;

  for (let i = headerLineIdx + 1; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    if (!rawLine.trim()) continue;
    rowsTotal += 1;
    const cols = parseDelimitedLine(rawLine, delimiter);
    if (cols.every((v) => !v)) {
      rowsSkipped += 1;
      continue;
    }

    const name = cleanCell(cols[idxName] ?? '');
    const igk = cleanCell(cols[idxIgk] ?? '');
    const contractNumber = cleanCell(cols[idxContractNumber] ?? '');
    const separateAccountRaw = idxSeparateAccount >= 0 ? cleanCell(cols[idxSeparateAccount] ?? '') : '';
    const signedAt = idxDate >= 0 ? parseRuDate(cleanCell(cols[idxDate] ?? '')) : null;
    const dueAt = idxDue >= 0 ? parseRuDate(cleanCell(cols[idxDue] ?? '')) : null;
    const comment = idxComment >= 0 ? cleanCell(cols[idxComment] ?? '') : '';
    const hasFiles = idxHasFiles >= 0 ? parseBoolean(cleanCell(cols[idxHasFiles] ?? '')) : false;

    // Service rows in source (group headers) should not become contracts.
    if (!contractNumber || !igk) {
      rowsSkipped += 1;
      continue;
    }

    const parsedAccount = parseSeparateAccount(separateAccountRaw);
    rows.push({
      sourceFile: filePath,
      lineNo: i + 1,
      hasFiles,
      name,
      igk,
      contractNumber,
      separateAccountRaw,
      separateAccountNumber: parsedAccount.separateAccountNumber,
      separateAccountBank: parsedAccount.separateAccountBank,
      signedAt,
      dueAt,
      comment,
    });
  }

  return {
    rows,
    stats: {
      file: filePath,
      processed: true,
      rowsTotal,
      rowsAccepted: rows.length,
      rowsSkipped,
    },
  };
}

function contractImportKey(row: Pick<ParsedContractRow, 'contractNumber' | 'igk'>): string {
  return `${normalizeToken(row.contractNumber)}|${normalizeToken(row.igk)}`;
}

function pickBetterText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

function mergeRows(base: ParsedContractRow, next: ParsedContractRow): ParsedContractRow {
  return {
    ...base,
    hasFiles: base.hasFiles || next.hasFiles,
    name: pickBetterText(base.name, next.name),
    igk: pickBetterText(base.igk, next.igk),
    contractNumber: pickBetterText(base.contractNumber, next.contractNumber),
    separateAccountRaw: pickBetterText(base.separateAccountRaw, next.separateAccountRaw),
    separateAccountNumber: pickBetterText(base.separateAccountNumber, next.separateAccountNumber),
    separateAccountBank: pickBetterText(base.separateAccountBank, next.separateAccountBank),
    signedAt: base.signedAt ?? next.signedAt,
    dueAt: base.dueAt ?? next.dueAt,
    comment: pickBetterText(base.comment, next.comment),
  };
}

function parseJsonValue(valueJson: string | null): unknown {
  if (valueJson == null) return null;
  try {
    return JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
}

function jsonComparable(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'string') return `string:${value}`;
  return `json:${JSON.stringify(value)}`;
}

function tryExtractDuplicateId(errorText: string): string | null {
  const m = errorText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return m?.[0] ? String(m[0]) : null;
}

async function ensureActor(): Promise<AuthUser> {
  const superadminId = await getSuperadminUserId();
  if (!superadminId) throw new Error('Пользователь superadmin для импорта контрактов не найден');
  return { id: superadminId, username: 'superadmin', role: 'superadmin' };
}

async function ensureContractInfra(actor: AuthUser): Promise<{ contractTypeId: string }> {
  const type = await upsertEntityType(actor, {
    code: EntityTypeCode.Contract,
    name: 'Контракт',
  });
  if (!type.ok || !type.id) throw new Error('Не удалось подготовить тип сущности контракта');

  const linkToCustomer = JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Customer });
  const desiredDefs: Array<{
    code: string;
    name: string;
    dataType: AttributeDataType;
    sortOrder: number;
    metaJson?: string | null;
  }> = [
    { code: 'goz_name', name: 'Наименование (ГОЗ)', dataType: AttributeDataType.Text, sortOrder: 10 },
    { code: 'number', name: 'Номер контракта', dataType: AttributeDataType.Text, sortOrder: 20 },
    { code: 'goz_igk', name: 'ИГК', dataType: AttributeDataType.Text, sortOrder: 30 },
    { code: 'has_files', name: 'Есть файлы', dataType: AttributeDataType.Boolean, sortOrder: 40 },
    { code: 'date', name: 'Дата заключения контракта', dataType: AttributeDataType.Date, sortOrder: 50 },
    { code: 'due_date', name: 'Плановая дата исполнения контракта', dataType: AttributeDataType.Date, sortOrder: 60 },
    { code: 'goz_separate_account_number', name: 'Отдельный счет (номер)', dataType: AttributeDataType.Text, sortOrder: 70 },
    { code: 'goz_separate_account_bank', name: 'Отдельный счет (банк)', dataType: AttributeDataType.Text, sortOrder: 80 },
    { code: 'goz_separate_account', name: 'Отдельный счет (реквизиты)', dataType: AttributeDataType.Text, sortOrder: 90 },
    { code: 'internal_number', name: 'Внутренний номер', dataType: AttributeDataType.Text, sortOrder: 100 },
    { code: 'customer_id', name: 'Контрагент', dataType: AttributeDataType.Link, sortOrder: 110, metaJson: linkToCustomer },
    { code: 'comment', name: 'Комментарий', dataType: AttributeDataType.Text, sortOrder: 120 },
    { code: 'contract_sections', name: 'Секции контракта', dataType: AttributeDataType.Json, sortOrder: 130 },
  ];

  for (const def of desiredDefs) {
    const upserted = await upsertAttributeDef(actor, {
      entityTypeId: type.id,
      code: def.code,
      name: def.name,
      dataType: def.dataType,
      isRequired: false,
      sortOrder: def.sortOrder,
      metaJson: def.metaJson ?? null,
    });
    if (!upserted.ok || !upserted.id) {
      throw new Error(`Не удалось подготовить атрибут ${def.code} для типа контракта`);
    }
  }

  return { contractTypeId: type.id };
}

async function loadExistingContracts(contractTypeId: string): Promise<Map<string, ExistingContract>> {
  const rows = await db
    .select({ id: entities.id, createdAt: entities.createdAt })
    .from(entities)
    .where(and(eq(entities.typeId, contractTypeId as any), isNull(entities.deletedAt)))
    .limit(100_000);
  if (rows.length === 0) return new Map();

  const contractIds = rows.map((r) => String(r.id));
  const defRows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, contractTypeId as any), isNull(attributeDefs.deletedAt)))
    .limit(1_000);
  const codeByDefId = new Map(defRows.map((d) => [String(d.id), String(d.code)]));
  const defIds = [...codeByDefId.keys()];
  if (defIds.length === 0) return new Map();

  const valueRows = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, contractIds as any),
        inArray(attributeValues.attributeDefId, defIds as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(500_000);

  const out = new Map<string, ExistingContract>();
  for (const row of rows) {
    out.set(String(row.id), { id: String(row.id), createdAt: Number(row.createdAt), attrs: {} });
  }
  for (const row of valueRows) {
    const contract = out.get(String(row.entityId));
    if (!contract) continue;
    const code = codeByDefId.get(String(row.attributeDefId));
    if (!code) continue;
    contract.attrs[code] = parseJsonValue(row.valueJson == null ? null : String(row.valueJson));
  }
  return out;
}

function buildContractIndices(existing: Map<string, ExistingContract>): {
  byExact: Map<string, ExistingContract[]>;
  byNumber: Map<string, ExistingContract[]>;
} {
  const all = [...existing.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });

  const byExact = new Map<string, ExistingContract[]>();
  const byNumber = new Map<string, ExistingContract[]>();
  for (const contract of all) {
    const number = cleanCell(contract.attrs.number);
    const igk = cleanCell(contract.attrs.goz_igk);
    if (number) {
      const numberKey = normalizeToken(number);
      const arrByNumber = byNumber.get(numberKey) ?? [];
      arrByNumber.push(contract);
      byNumber.set(numberKey, arrByNumber);
    }
    if (number && igk) {
      const exactKey = `${normalizeToken(number)}|${normalizeToken(igk)}`;
      const arrByExact = byExact.get(exactKey) ?? [];
      arrByExact.push(contract);
      byExact.set(exactKey, arrByExact);
    }
  }
  return { byExact, byNumber };
}

function pickContractIdForRow(
  row: ParsedContractRow,
  index: { byExact: Map<string, ExistingContract[]>; byNumber: Map<string, ExistingContract[]> },
): { id: string | null; ambiguous: boolean } {
  const exactKey = contractImportKey(row);
  const exactMatches = index.byExact.get(exactKey) ?? [];
  if (exactMatches.length === 1) {
    return { id: exactMatches[0]?.id ?? null, ambiguous: false };
  }
  if (exactMatches.length > 1) {
    // Unsafe to choose one automatically: keep import idempotent and predictable.
    return { id: null, ambiguous: true };
  }

  const numberMatches = index.byNumber.get(normalizeToken(row.contractNumber)) ?? [];
  if (numberMatches.length === 1) {
    return { id: numberMatches[0]?.id ?? null, ambiguous: false };
  }
  if (numberMatches.length > 1) {
    // Same contract number can exist in malformed historical data.
    return { id: null, ambiguous: true };
  }
  return { id: null, ambiguous: false };
}

async function setIfChanged(actor: AuthUser, contract: ExistingContract, code: string, value: unknown): Promise<void> {
  const prev = contract.attrs[code];
  if (jsonComparable(prev) === jsonComparable(value)) return;
  const setResult = await setEntityAttribute(actor, contract.id, code, value);
    if (!setResult.ok) {
      throw new Error(`Не удалось установить ${code} для контракта ${contract.id}: ${setResult.error ?? 'неизвестная ошибка'}`);
  }
  contract.attrs[code] = value;
}

async function main() {
  const startedAt = Date.now();
  const actor = await ensureActor();

  const fileStats: ParsedFileStats[] = [];
  const importedRows: ParsedContractRow[] = [];
  for (const filePath of SOURCE_FILES) {
    const parsed = parseContractsFile(filePath);
    fileStats.push(parsed.stats);
    importedRows.push(...parsed.rows);
  }
  if (importedRows.length === 0) {
    throw new Error('Не найдено ни одной строки контракта в источниках');
  }

  const mergedByKey = new Map<string, ParsedContractRow>();
  for (const row of importedRows) {
    const key = contractImportKey(row);
    const cur = mergedByKey.get(key);
    if (cur) {
      mergedByKey.set(key, mergeRows(cur, row));
    } else {
      mergedByKey.set(key, row);
    }
  }
  const rows = [...mergedByKey.values()].sort((a, b) => a.contractNumber.localeCompare(b.contractNumber, 'ru'));

  const { contractTypeId } = await ensureContractInfra(actor);
  const existing = await loadExistingContracts(contractTypeId);
  const index = buildContractIndices(existing);

  let createdContracts = 0;
  let updatedContracts = 0;
  let ambiguousMatches = 0;
  let skippedRows = 0;
  const unresolved: string[] = [];

  for (const row of rows) {
    try {
      const picked = pickContractIdForRow(row, index);
      if (picked.ambiguous) {
        ambiguousMatches += 1;
        skippedRows += 1;
        unresolved.push(`${row.contractNumber} [${row.igk}] (ambiguous existing match)`);
        continue;
      }

      let contract = picked.id ? existing.get(picked.id) ?? null : null;
      if (!contract) {
        const created = await createEntity(actor, contractTypeId);
        if (!created.ok || !created.id) {
          skippedRows += 1;
          unresolved.push(`${row.contractNumber} (не удалось создать)`);
          continue;
        }
        contract = { id: created.id, createdAt: Date.now(), attrs: {} };
        existing.set(contract.id, contract);
        createdContracts += 1;
      }

      await setIfChanged(actor, contract, 'number', row.contractNumber);
      await setIfChanged(actor, contract, 'goz_igk', row.igk);
      await setIfChanged(actor, contract, 'goz_name', row.name);
      await setIfChanged(actor, contract, 'has_files', row.hasFiles);

      if (row.signedAt != null) await setIfChanged(actor, contract, 'date', row.signedAt);
      if (row.dueAt != null) await setIfChanged(actor, contract, 'due_date', row.dueAt);
      if (row.separateAccountRaw) await setIfChanged(actor, contract, 'goz_separate_account', row.separateAccountRaw);
      if (row.separateAccountNumber) await setIfChanged(actor, contract, 'goz_separate_account_number', row.separateAccountNumber);
      if (row.separateAccountBank) await setIfChanged(actor, contract, 'goz_separate_account_bank', row.separateAccountBank);
      if (row.comment) await setIfChanged(actor, contract, 'comment', row.comment);

      const existingInternal = cleanCell(contract.attrs.internal_number);
      if (!existingInternal) {
        await setIfChanged(actor, contract, 'internal_number', row.contractNumber);
      }

      const sections = parseContractSections(contract.attrs);
      const primaryNumber = cleanCell(sections.primary.number) || row.contractNumber;
      const primarySignedAt = row.signedAt ?? sections.primary.signedAt;
      const primaryDueAt = row.dueAt ?? sections.primary.dueAt;
      const primaryInternal = cleanCell(sections.primary.internalNumber) || cleanCell(contract.attrs.internal_number) || row.contractNumber;
      const nextSections = {
        ...sections,
        primary: {
          ...sections.primary,
          number: primaryNumber,
          signedAt: primarySignedAt,
          dueAt: primaryDueAt,
          internalNumber: primaryInternal,
        },
      };
      await setIfChanged(actor, contract, 'contract_sections', nextSections);

      updatedContracts += 1;
    } catch (e) {
      skippedRows += 1;
      const duplicateId = tryExtractDuplicateId(String(e));
      const duplicateMsg = duplicateId ? `, duplicateId=${duplicateId}` : '';
      unresolved.push(`${row.contractNumber} [${row.igk}] (${String(e)}${duplicateMsg})`);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log('[import-contracts-goz] выполнено');
  console.log(
    JSON.stringify(
      {
        files: fileStats,
        parsedRows: importedRows.length,
        uniqueContractsBySourceData: rows.length,
        db: {
          createdContracts,
          updatedContracts,
          ambiguousMatches,
          skippedRows,
        },
        unresolvedPreview: unresolved.slice(0, 30),
        unresolvedTotal: unresolved.length,
        elapsedMs,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error('[import-contracts-goz] ошибка', error);
  process.exit(1);
});
