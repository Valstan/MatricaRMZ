/**
 * Импорт остатков склада СИЗ по отчёту (выгрузка 1С «Остатки товаров»).
 *
 * Задание владельца (промт КАРМАНА #22): «По складу спецодежды: у нас на складе
 * ничего нет, выдачу провести нечем — остатков нет… Остатки приходят отчётом
 * (Excel, остатки на сегодня) — их надо загружать на склад».
 *
 * Ключевые решения:
 * - **Склад СИЗ — отдельная локация** (`warehouse_locations`, код `workwear`).
 *   Отдельной сущности «склад» в проекте нет, локация — единственный справочник;
 *   заводится лениво, при первом импорте, и повторный импорт её не плодит.
 * - **Импорт — корректировка, а не приход.** Строка документа несёт дельту
 *   (остаток отчёта − текущий остаток), поэтому повторная загрузка того же
 *   отчёта даёт нулевую дельту и остаток не удваивается.
 * - **Номенклатура отчёта — торговые позиции завода** («Костюм МОТОР … (96-100/170-176)»).
 *   Приказные строки не переименовываются и не переписываются: мост между слоями —
 *   отдельная работа (план `docs/plans/siz-stock-and-issue-card-2026-11.md`, этап 3).
 */
import { randomUUID } from 'node:crypto';

import {
  parsePpeStockReport,
  PPE_STOCK_WAREHOUSE_CODE,
  PPE_STOCK_WAREHOUSE_NAME,
  splitWorkwearSize,
  type PpeStockReportCell,
} from '@matricarmz/shared';
import { and, eq, isNull } from 'drizzle-orm';
import ExcelJS from 'exceljs';

import { db } from '../database/db.js';
import { erpNomenclature, erpRegStockBalance, warehouseLocations } from '../database/schema.js';
import { sha256Hex, signPpePreviewToken, verifyPpePreviewToken } from './ppeImportService.js';
import { upsertWarehouseLocation } from './warehouseLocationsService.js';
import { createWarehouseDocument, postWarehouseDocument, upsertWarehouseNomenclature } from './warehouseService.js';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
type Actor = { id: string; username: string; role?: string };

/** Код локации склада СИЗ. Тот же код берёт клиентский фильтр остатков. */
export { PPE_STOCK_WAREHOUSE_CODE, PPE_STOCK_WAREHOUSE_NAME };

export const PPE_STOCK_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export type PpeStockImportAction = 'create' | 'match' | 'unchanged';

export type PpeStockImportPreviewRow = {
  /** Номер строки отчёта (для показа оператору). */
  line: number;
  name: string;
  unit: string | null;
  /** Остаток по отчёту. */
  reportQty: number;
  /** Текущий остаток на складе СИЗ. */
  currentQty: number;
  /** Дельта к проведению. */
  delta: number;
  action: PpeStockImportAction;
  nomenclatureId: string | null;
  note: string | null;
};

export type PpeStockImportPreview = {
  /** Дата отчёта (Unix-ms) — если в заголовке она есть. */
  reportDate: number | null;
  /** Строки шапки отчёта (организация, заголовок, отбор). */
  title: string[];
  /** Склад, в который грузим. */
  warehouse: { code: string; name: string; exists: boolean };
  rows: PpeStockImportPreviewRow[];
  summary: {
    total: number;
    create: number;
    match: number;
    unchanged: number;
    /** Позиций с ненулевой дельтой — строк будущего документа. */
    changed: number;
  };
};

export type PpeStockImportApplyReport = {
  docNo: string | null;
  documentId: string | null;
  /** Позиций заведено новых. */
  created: number;
  /** Позиций найдено. */
  matched: number;
  /** Позиций без изменений (остаток совпал). */
  unchanged: number;
  /** Строк проведённого документа. */
  posted: number;
};

function normalizeName(value: string): string {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/ё/g, 'е')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Числа из Excel приходят как number/string/Date — в домен идут примитивы. */
function cellToPrimitive(value: unknown): PpeStockReportCell {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'object' && 'text' in (value as Record<string, unknown>)) {
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' ? text : null;
  }
  if (typeof value === 'object' && 'result' in (value as Record<string, unknown>)) {
    const result = (value as { result?: unknown }).result;
    return typeof result === 'number' || typeof result === 'string' ? result : null;
  }
  return String(value);
}

/** Книга → строки первого листа, у которого есть шапка отчёта. */
async function readStockReportRows(buffer: Buffer): Promise<Result<{ sheet: string; rows: PpeStockReportCell[][] }>> {
  if (!buffer || buffer.length === 0) return { ok: false, error: 'Пустой файл' };
  if (buffer.length > PPE_STOCK_IMPORT_MAX_BYTES) return { ok: false, error: 'Файл больше 10 МБ' };
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return { ok: false, error: 'Не xlsx: не удалось разобрать книгу' };
  }

  const sheets: Array<{ sheet: string; rows: PpeStockReportCell[][]; found: number }> = [];
  wb.eachSheet((ws) => {
    const rows: PpeStockReportCell[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: PpeStockReportCell[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellToPrimitive(row.getCell(c).value));
      rows.push(cells);
    }
    const report = parsePpeStockReport(rows);
    sheets.push({ sheet: ws.name, rows, found: report.rows.length });
  });

  const best = sheets.reduce<(typeof sheets)[number] | null>(
    (acc, item) => (acc === null || item.found > acc.found ? item : acc),
    null,
  );

  if (!best) return { ok: false, error: 'В книге нет листов' };
  const report = parsePpeStockReport(best.rows);
  if (report.rows.length === 0) {
    return {
      ok: false,
      error: 'Шапка не распознана: отчёт об остатках ждёт колонки «Номенклатура», «Единица», «Количество», «Сумма»',
    };
  }
  return { ok: true, sheet: best.sheet, rows: best.rows };
}

type NomenclatureRow = { id: string; name: string; code: string };

async function loadWorkwearNomenclature(): Promise<NomenclatureRow[]> {
  const rows = await db
    .select({ id: erpNomenclature.id, name: erpNomenclature.name, code: erpNomenclature.code })
    .from(erpNomenclature)
    .where(and(isNull(erpNomenclature.deletedAt), eq(erpNomenclature.category, 'workwear')))
    .limit(20_000);
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? ''), code: String(row.code ?? '') }));
}

async function resolveStockLocation(): Promise<{ id: string | null; exists: boolean }> {
  const rows = await db
    .select({ id: warehouseLocations.id })
    .from(warehouseLocations)
    .where(and(eq(warehouseLocations.code, PPE_STOCK_WAREHOUSE_CODE), isNull(warehouseLocations.deletedAt)))
    .limit(1);
  return rows[0] ? { id: String(rows[0].id), exists: true } : { id: null, exists: false };
}

async function loadBalances(locationId: string | null): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!locationId) return map;
  const rows = await db
    .select({ nomenclatureId: erpRegStockBalance.nomenclatureId, qty: erpRegStockBalance.qty })
    .from(erpRegStockBalance)
    .where(eq(erpRegStockBalance.warehouseLocationId, locationId))
    .limit(50_000);
  for (const row of rows) map.set(String(row.nomenclatureId), Number(row.qty ?? 0));
  return map;
}

/**
 * Сопоставление позиции отчёта с номенклатурой:
 * 1) точное совпадение названия (нормализованное);
 * 2) совпадение базы + размера — если в справочнике есть вариант этой базы с таким размером.
 * Иначе позиция заводится новая.
 */
function matchNomenclature(
  name: string,
  pool: NomenclatureRow[],
  byName: Map<string, NomenclatureRow>,
): { row: NomenclatureRow | null; via: 'exact' | 'base' | null } {
  const normalized = normalizeName(name);
  const exact = byName.get(normalized);
  if (exact) return { row: exact, via: 'exact' };

  const split = splitWorkwearSize(name);
  if (!split.size) return { row: null, via: null };
  const base = byName.get(normalizeName(split.base));
  if (!base) return { row: null, via: null };
  const sizeToken = normalizeName(split.size);
  const variant = pool.find(
    (row) => row.id !== base.id && normalizeName(row.name).includes(sizeToken) && normalizeName(row.name).includes(normalizeName(split.base)),
  );
  return variant ? { row: variant, via: 'base' } : { row: null, via: null };
}

async function buildPlan(
  reportRows: ReturnType<typeof parsePpeStockReport>['rows'],
  pool: NomenclatureRow[],
  balances: Map<string, number>,
): Promise<PpeStockImportPreviewRow[]> {
  const byName = new Map<string, NomenclatureRow>();
  for (const row of pool) {
    const key = normalizeName(row.name);
    if (!byName.has(key)) byName.set(key, row);
  }

  const plan: PpeStockImportPreviewRow[] = [];
  for (const [index, row] of reportRows.entries()) {
    const matched = matchNomenclature(row.name, pool, byName);
    const currentQty = matched.row ? (balances.get(matched.row.id) ?? 0) : 0;
    const delta = row.qty - currentQty;
    const action: PpeStockImportAction = !matched.row ? 'create' : delta === 0 ? 'unchanged' : 'match';
    plan.push({
      line: index + 1,
      name: row.name,
      unit: row.unit,
      reportQty: row.qty,
      currentQty,
      delta,
      action,
      nomenclatureId: matched.row?.id ?? null,
      note: matched.row ? null : 'позиции нет в справочнике — будет заведена',
    });
  }
  return plan;
}

export async function previewPpeStockImport(args: {
  filename: string;
  contentBase64: string;
}): Promise<Result<{ previewId: string; expiresAt: number; preview: PpeStockImportPreview }>> {
  try {
    const buffer = Buffer.from(String(args.contentBase64 ?? ''), 'base64');
    const read = await readStockReportRows(buffer);
    if (!read.ok) return read;

    const report = parsePpeStockReport(read.rows);
    const pool = await loadWorkwearNomenclature();
    const location = await resolveStockLocation();
    const balances = await loadBalances(location.id);
    const plan = await buildPlan(report.rows, pool, balances);

    const preview: PpeStockImportPreview = {
      reportDate: report.reportDate,
      title: report.title,
      warehouse: { code: PPE_STOCK_WAREHOUSE_CODE, name: PPE_STOCK_WAREHOUSE_NAME, exists: location.exists },
      rows: plan,
      summary: {
        total: plan.length,
        create: plan.filter((row) => row.action === 'create').length,
        match: plan.filter((row) => row.action === 'match').length,
        unchanged: plan.filter((row) => row.action === 'unchanged').length,
        changed: plan.filter((row) => row.delta !== 0).length,
      },
    };

    return { ok: true, previewId: signPpePreviewToken(sha256Hex(buffer)), expiresAt: Date.now() + 30 * 60 * 1000, preview };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Код позиции: уникальный среди живых строк справочника. */
async function makeStockNomenclatureCode(name: string): Promise<string> {
  const base = `PPE-ST-${randomUUID().slice(0, 8).toUpperCase()}`;
  const rows = await db
    .select({ id: erpNomenclature.id })
    .from(erpNomenclature)
    .where(and(eq(erpNomenclature.code, base), isNull(erpNomenclature.deletedAt)))
    .limit(1);
  if (rows[0]) return makeStockNomenclatureCode(name);
  return base;
}

export async function applyPpeStockImport(args: {
  previewId: string;
  contentBase64: string;
  actor: Actor;
}): Promise<Result<{ report: PpeStockImportApplyReport }>> {
  try {
    const buffer = Buffer.from(String(args.contentBase64 ?? ''), 'base64');
    const verified = verifyPpePreviewToken(String(args.previewId ?? ''), sha256Hex(buffer));
    if (!verified.ok) return { ok: false, error: 'Проверка файла истекла — проверьте файл заново' };

    const read = await readStockReportRows(buffer);
    if (!read.ok) return read;
    const report = parsePpeStockReport(read.rows);

    // Склад СИЗ — отдельная локация; заводится при первом импорте.
    let location = await resolveStockLocation();
    if (!location.id) {
      const created = await upsertWarehouseLocation({
        type: 'regular',
        code: PPE_STOCK_WAREHOUSE_CODE,
        name: PPE_STOCK_WAREHOUSE_NAME,
        isActive: true,
      });
      if (!created.ok) return { ok: false, error: `Склад СИЗ не заведён: ${created.error}` };
      location = { id: created.id, exists: true };
    }

    const pool = await loadWorkwearNomenclature();
    const balances = await loadBalances(location.id);
    const plan = await buildPlan(report.rows, pool, balances);

    let created = 0;
    let matched = 0;
    let unchanged = 0;
    const lines: Array<{
      nomenclatureId: string;
      qty: number;
      adjustmentQty: number;
      bookQty: number;
      actualQty: number;
      warehouseId: string;
    }> = [];

    for (const row of plan) {
      let nomenclatureId = row.nomenclatureId;
      if (!nomenclatureId) {
        const code = await makeStockNomenclatureCode(row.name);
        const upsert = await upsertWarehouseNomenclature({
          code,
          name: row.name,
          itemType: 'material',
          category: 'workwear',
          isActive: true,
        });
        if (!upsert.ok) return { ok: false, error: `Позиция «${row.name}» не заведена: ${upsert.error}` };
        nomenclatureId = upsert.id;
        created += 1;
      } else {
        matched += 1;
      }
      if (row.delta === 0) {
        unchanged += 1;
        continue;
      }
      lines.push({
        nomenclatureId,
        qty: Math.abs(row.delta),
        adjustmentQty: row.delta,
        bookQty: row.currentQty,
        actualQty: row.reportQty,
        warehouseId: PPE_STOCK_WAREHOUSE_CODE,
      });
    }

    if (lines.length === 0) {
      // Остатки совпали с отчётом — документ не создаём (повторная загрузка не удваивает остаток).
      return {
        ok: true,
        report: { docNo: null, documentId: null, created, matched, unchanged, posted: 0 },
      };
    }

    const now = Date.now();
    const stamp = new Date(now);
    const pad = (v: number) => String(v).padStart(2, '0');
    const docNo = `PPE-ST-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${randomUUID().slice(0, 6).toUpperCase()}`;

    const createdDoc = await createWarehouseDocument({
      docType: 'stock_inventory',
      docNo,
      docDate: now,
      header: { warehouseId: PPE_STOCK_WAREHOUSE_CODE, reason: 'Остатки по отчёту' },
      lines,
      actor: args.actor,
    });
    if (!createdDoc.ok) return { ok: false, error: createdDoc.error };

    const posted = await postWarehouseDocument({ documentId: createdDoc.id, actor: args.actor });
    if (!posted.ok) {
      return { ok: false, error: `Документ ${docNo} создан черновиком, но не проведён: ${posted.error}` };
    }

    return {
      ok: true,
      report: { docNo, documentId: createdDoc.id, created, matched, unchanged, posted: lines.length },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
