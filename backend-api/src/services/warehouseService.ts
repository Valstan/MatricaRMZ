import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { LedgerTableName } from '@matricarmz/ledger';

import { db } from '../database/db.js';
import {
  erpDocumentHeaders,
  erpDocumentLines,
  erpJournalDocuments,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
} from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';

const STOCK_DOC_TYPES = ['stock_receipt', 'stock_issue', 'stock_transfer', 'stock_writeoff', 'stock_inventory'] as const;
type StockDocType = (typeof STOCK_DOC_TYPES)[number];

type ResultOk<T> = { ok: true } & T;
type ResultErr = { ok: false; error: string };
type Result<T> = ResultOk<T> | ResultErr;

type Actor = { id: string; username: string; role?: string };

type DocLineInput = {
  qty: number;
  price?: number | null;
  partCardId?: string | null;
  nomenclatureId?: string | null;
  payloadJson?: string | null;
};

type PlannedMovement = {
  nomenclatureId: string;
  warehouseId: string;
  movementType: string;
  direction: 'in' | 'out';
  qty: number;
  delta: number;
  reason: string | null;
  counterpartyId: string | null;
};

function nowMs() {
  return Date.now();
}

function isStockDocType(value: string): value is StockDocType {
  return (STOCK_DOC_TYPES as readonly string[]).includes(value);
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function strField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  const asNum = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(asNum) ? asNum : undefined;
}

export async function listWarehouseNomenclature(args?: {
  search?: string;
  itemType?: string;
  groupId?: string;
  isActive?: boolean;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const search = String(args?.search ?? '').trim().toLowerCase();
    const rows = await db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt)).orderBy(asc(erpNomenclature.name));
    const filtered = rows.filter((row) => {
      if (args?.itemType && String(row.itemType) !== String(args.itemType)) return false;
      if (args?.groupId && String(row.groupId ?? '') !== String(args.groupId)) return false;
      if (args?.isActive !== undefined && Boolean(row.isActive) !== Boolean(args.isActive)) return false;
      if (!search) return true;
      const hay = `${String(row.code ?? '')} ${String(row.name ?? '')} ${String(row.barcode ?? '')}`.toLowerCase();
      return hay.includes(search);
    });
    return { ok: true, rows: filtered as Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseNomenclature(args: {
  id?: string;
  code: string;
  name: string;
  itemType?: string;
  groupId?: string | null;
  unitId?: string | null;
  barcode?: string | null;
  minStock?: number | null;
  maxStock?: number | null;
  defaultWarehouseId?: string | null;
  specJson?: string | null;
  isActive?: boolean;
}): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id || randomUUID());
    const ts = nowMs();
    const normalized = {
      code: String(args.code).trim(),
      name: String(args.name).trim(),
      itemType: String(args.itemType || 'material'),
      groupId: args.groupId ?? null,
      unitId: args.unitId ?? null,
      barcode: args.barcode ?? null,
      minStock: args.minStock == null ? null : Math.trunc(Number(args.minStock)),
      maxStock: args.maxStock == null ? null : Math.trunc(Number(args.maxStock)),
      defaultWarehouseId: args.defaultWarehouseId ?? null,
      specJson: args.specJson ?? null,
      isActive: args.isActive ?? true,
    };
    await db
      .insert(erpNomenclature)
      .values({ id, ...normalized, createdAt: ts, updatedAt: ts, deletedAt: null })
      .onConflictDoUpdate({ target: erpNomenclature.id, set: { ...normalized, updatedAt: ts, deletedAt: null } });
    const saved = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, id)).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'upsert',
          table: LedgerTableName.ErpNomenclature,
          row_id: id,
          row: {
            id: String(row.id),
            code: String(row.code),
            name: String(row.name),
            item_type: String(row.itemType),
            group_id: row.groupId,
            unit_id: row.unitId,
            barcode: row.barcode,
            min_stock: row.minStock,
            max_stock: row.maxStock,
            default_warehouse_id: row.defaultWarehouseId,
            spec_json: row.specJson,
            is_active: Boolean(row.isActive),
            created_at: Number(row.createdAt),
            updated_at: Number(row.updatedAt),
            deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
          },
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts,
        },
      ]);
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteWarehouseNomenclature(args: { id: string }): Promise<Result<{ id: string }>> {
  try {
    const ts = nowMs();
    await db.update(erpNomenclature).set({ isActive: false, deletedAt: ts, updatedAt: ts }).where(eq(erpNomenclature.id, args.id));
    const saved = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, args.id)).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'delete',
          table: LedgerTableName.ErpNomenclature,
          row_id: String(row.id),
          row: {
            id: String(row.id),
            code: String(row.code),
            name: String(row.name),
            item_type: String(row.itemType),
            group_id: row.groupId,
            unit_id: row.unitId,
            barcode: row.barcode,
            min_stock: row.minStock,
            max_stock: row.maxStock,
            default_warehouse_id: row.defaultWarehouseId,
            spec_json: row.specJson,
            is_active: false,
            created_at: Number(row.createdAt),
            updated_at: ts,
            deleted_at: ts,
          },
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts,
        },
      ]);
    }
    return { ok: true, id: args.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseStock(args?: {
  warehouseId?: string;
  nomenclatureId?: string;
  search?: string;
  lowStockOnly?: boolean;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const rows = await db.select().from(erpRegStockBalance).orderBy(asc(erpRegStockBalance.warehouseId));
    const nomenclatureIds = Array.from(new Set(rows.map((row) => row.nomenclatureId).filter((v): v is string => typeof v === 'string' && v.length > 0)));
    const nomenclatureRows =
      nomenclatureIds.length === 0
        ? []
        : await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds), isNull(erpNomenclature.deletedAt)));
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    const search = String(args?.search ?? '').trim().toLowerCase();
    const filtered = rows
      .filter((row) => {
        if (args?.warehouseId && String(row.warehouseId) !== String(args.warehouseId)) return false;
        if (args?.nomenclatureId && String(row.nomenclatureId ?? '') !== String(args.nomenclatureId)) return false;
        const n = row.nomenclatureId ? nomenclatureById.get(String(row.nomenclatureId)) : undefined;
        if (search) {
          const hay = `${String(n?.code ?? '')} ${String(n?.name ?? '')} ${String(row.warehouseId)}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        if (args?.lowStockOnly) {
          const min = Number(n?.minStock ?? NaN);
          if (!Number.isFinite(min)) return false;
          if (Number(row.qty) > min) return false;
        }
        return true;
      })
      .map((row) => {
        const n = row.nomenclatureId ? nomenclatureById.get(String(row.nomenclatureId)) : undefined;
        return {
          ...row,
          nomenclatureCode: n?.code ?? null,
          nomenclatureName: n?.name ?? null,
          itemType: n?.itemType ?? null,
          minStock: n?.minStock ?? null,
          maxStock: n?.maxStock ?? null,
        };
      });
    return { ok: true, rows: filtered as Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseDocuments(args?: {
  docType?: string;
  status?: string;
  fromDate?: number;
  toDate?: number;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const rows = await db
      .select()
      .from(erpDocumentHeaders)
      .where(isNull(erpDocumentHeaders.deletedAt))
      .orderBy(desc(erpDocumentHeaders.docDate), desc(erpDocumentHeaders.createdAt));
    const filtered = rows.filter((row) => {
      if (!isStockDocType(String(row.docType))) return false;
      if (args?.docType && String(row.docType) !== String(args.docType)) return false;
      if (args?.status && String(row.status) !== String(args.status)) return false;
      if (args?.fromDate !== undefined && Number(row.docDate) < Number(args.fromDate)) return false;
      if (args?.toDate !== undefined && Number(row.docDate) > Number(args.toDate)) return false;
      return true;
    });
    return { ok: true, rows: filtered as Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getWarehouseDocument(args: {
  id: string;
}): Promise<Result<{ header: Record<string, unknown>; lines: Array<Record<string, unknown>> }>> {
  try {
    const headerRows = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.id), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headerRows[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (!isStockDocType(String(header.docType))) return { ok: false, error: 'Документ не складского типа' };
    const lines = await db
      .select()
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.id), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));
    return { ok: true, header: header as Record<string, unknown>, lines: lines as Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createWarehouseDocument(args: {
  id?: string;
  docType: string;
  docNo: string;
  docDate?: number;
  departmentId?: string | null;
  authorId?: string | null;
  payloadJson?: string | null;
  lines: DocLineInput[];
  actor: Actor;
}): Promise<Result<{ id: string }>> {
  try {
    if (!isStockDocType(String(args.docType))) return { ok: false, error: 'Неподдерживаемый тип складского документа' };
    const ts = nowMs();
    const id = String(args.id || randomUUID());
    const docDate = Math.trunc(Number(args.docDate ?? ts));
    if (args.id) {
      const existing = await db
        .select({ id: erpDocumentHeaders.id, status: erpDocumentHeaders.status })
        .from(erpDocumentHeaders)
        .where(and(eq(erpDocumentHeaders.id, id), isNull(erpDocumentHeaders.deletedAt)))
        .limit(1);
      if (!existing[0]) return { ok: false, error: 'Документ для обновления не найден' };
      if (String(existing[0].status) === 'posted') return { ok: false, error: 'Нельзя редактировать проведенный документ' };
      await db
        .update(erpDocumentHeaders)
        .set({
          docType: String(args.docType),
          docNo: String(args.docNo),
          docDate,
          authorId: args.authorId ?? null,
          departmentId: args.departmentId ?? null,
          payloadJson: args.payloadJson ?? null,
          updatedAt: ts,
        })
        .where(eq(erpDocumentHeaders.id, id));
      await db.update(erpDocumentLines).set({ deletedAt: ts, updatedAt: ts }).where(and(eq(erpDocumentLines.headerId, id), isNull(erpDocumentLines.deletedAt)));
    } else {
      await db.insert(erpDocumentHeaders).values({
        id,
        docType: String(args.docType),
        docNo: String(args.docNo),
        docDate,
        status: 'draft',
        authorId: args.authorId ?? null,
        departmentId: args.departmentId ?? null,
        payloadJson: args.payloadJson ?? null,
        createdAt: ts,
        updatedAt: ts,
        postedAt: null,
        deletedAt: null,
      });
    }
    const lines = args.lines.map((line, idx) => {
      const base = parseJsonObject(line.payloadJson ?? null);
      const payload = {
        ...base,
        ...(line.nomenclatureId ? { nomenclatureId: line.nomenclatureId } : {}),
      };
      return {
        id: randomUUID(),
        headerId: id,
        lineNo: idx + 1,
        partCardId: line.partCardId ?? null,
        qty: Math.max(0, Math.trunc(Number(line.qty))),
        price: line.price == null ? null : Math.trunc(Number(line.price)),
        payloadJson: Object.keys(payload).length > 0 ? JSON.stringify(payload) : null,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
      };
    });
    if (lines.length > 0) await db.insert(erpDocumentLines).values(lines);
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: id,
      eventType: args.id ? 'updated' : 'created',
      eventPayloadJson: JSON.stringify({ docType: args.docType, by: args.actor.username, lines: lines.length }),
      eventAt: ts,
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function postWarehouseDocument(args: {
  documentId: string;
  actor: Actor;
}): Promise<Result<{ id: string; posted: boolean }>> {
  try {
    const ts = nowMs();
    const headers = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headers[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (!isStockDocType(String(header.docType))) return { ok: false, error: 'Документ не складского типа' };
    if (String(header.status) === 'posted') return { ok: true, id: args.documentId, posted: true };

    const headerPayload = parseJsonObject(header.payloadJson ?? null);
    const lines = await db
      .select()
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.documentId), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));
    const planned: PlannedMovement[] = [];

    for (const line of lines) {
      const qty = Math.max(0, Math.trunc(Number(line.qty ?? 0)));
      if (qty <= 0) continue;
      const payload = parseJsonObject(line.payloadJson ?? null);
      const nomenclatureId = strField(payload, 'nomenclatureId');
      if (!nomenclatureId) return { ok: false, error: `В строке ${line.lineNo} не задана номенклатура` };
      const reason = strField(payload, 'reason') ?? strField(headerPayload, 'reason') ?? null;
      const counterpartyId = strField(headerPayload, 'counterpartyId') ?? null;

      if (String(header.docType) === 'stock_receipt') {
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'receipt', direction: 'in', qty, delta: qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_issue') {
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'issue', direction: 'out', qty, delta: -qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_writeoff') {
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'writeoff', direction: 'out', qty, delta: -qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_transfer') {
        const fromWarehouseId = strField(payload, 'fromWarehouseId') ?? strField(headerPayload, 'fromWarehouseId');
        const toWarehouseId = strField(payload, 'toWarehouseId') ?? strField(headerPayload, 'toWarehouseId');
        if (!fromWarehouseId || !toWarehouseId) return { ok: false, error: `В строке ${line.lineNo} не заполнены склады перемещения` };
        planned.push({ nomenclatureId, warehouseId: fromWarehouseId, movementType: 'transfer_out', direction: 'out', qty, delta: -qty, reason, counterpartyId });
        planned.push({ nomenclatureId, warehouseId: toWarehouseId, movementType: 'transfer_in', direction: 'in', qty, delta: qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_inventory') {
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        const adjustment = numField(payload, 'adjustmentQty');
        const bookQty = numField(payload, 'bookQty');
        const actualQty = numField(payload, 'actualQty');
        const delta = adjustment !== undefined ? Math.trunc(adjustment) : bookQty !== undefined && actualQty !== undefined ? Math.trunc(actualQty - bookQty) : qty;
        if (delta === 0) continue;
        planned.push({
          nomenclatureId,
          warehouseId,
          movementType: delta > 0 ? 'inventory_surplus' : 'inventory_shortage',
          direction: delta > 0 ? 'in' : 'out',
          qty: Math.abs(delta),
          delta,
          reason,
          counterpartyId,
        });
      }
    }

    const nomenclatureIds = Array.from(new Set(planned.map((item) => item.nomenclatureId)));
    const existingNomenclature =
      nomenclatureIds.length === 0
        ? []
        : await db.select({ id: erpNomenclature.id }).from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds), isNull(erpNomenclature.deletedAt)));
    if (existingNomenclature.length !== nomenclatureIds.length) return { ok: false, error: 'Не найдена часть номенклатуры документа' };

    const balanceByKey = new Map<string, { id: string; qty: number; reservedQty: number }>();
    for (const movement of planned) {
      const key = `${movement.nomenclatureId}::${movement.warehouseId}`;
      if (balanceByKey.has(key)) continue;
      const balanceRows = await db
        .select()
        .from(erpRegStockBalance)
        .where(and(eq(erpRegStockBalance.nomenclatureId, movement.nomenclatureId), eq(erpRegStockBalance.warehouseId, movement.warehouseId)))
        .limit(1);
      const balance = balanceRows[0];
      balanceByKey.set(key, {
        id: balance?.id ? String(balance.id) : randomUUID(),
        qty: Number(balance?.qty ?? 0),
        reservedQty: Number(balance?.reservedQty ?? 0),
      });
    }

    for (const movement of planned) {
      const key = `${movement.nomenclatureId}::${movement.warehouseId}`;
      const current = balanceByKey.get(key);
      if (!current) return { ok: false, error: 'Ошибка подготовки баланса' };
      const nextQty = current.qty + movement.delta;
      if (nextQty < 0) return { ok: false, error: `Недостаточно остатка для ${movement.nomenclatureId} на складе ${movement.warehouseId}` };
      current.qty = nextQty;
    }

    for (const movement of planned) {
      const key = `${movement.nomenclatureId}::${movement.warehouseId}`;
      const current = balanceByKey.get(key);
      if (!current) continue;
      const existing = await db.select({ id: erpRegStockBalance.id }).from(erpRegStockBalance).where(eq(erpRegStockBalance.id, current.id)).limit(1);
      if (existing[0]) {
        await db.update(erpRegStockBalance).set({ qty: current.qty, reservedQty: current.reservedQty, updatedAt: ts }).where(eq(erpRegStockBalance.id, current.id));
      } else {
        await db.insert(erpRegStockBalance).values({
          id: current.id,
          nomenclatureId: movement.nomenclatureId,
          partCardId: null,
          warehouseId: movement.warehouseId,
          qty: current.qty,
          reservedQty: current.reservedQty,
          updatedAt: ts,
        });
      }
      await db.insert(erpRegStockMovements).values({
        id: randomUUID(),
        nomenclatureId: movement.nomenclatureId,
        warehouseId: movement.warehouseId,
        documentHeaderId: args.documentId,
        movementType: movement.movementType,
        qty: movement.qty,
        direction: movement.direction,
        counterpartyId: movement.counterpartyId,
        reason: movement.reason,
        performedAt: ts,
        performedBy: args.actor.username,
        createdAt: ts,
      });
    }

    await db.update(erpDocumentHeaders).set({ status: 'posted', postedAt: ts, updatedAt: ts }).where(eq(erpDocumentHeaders.id, args.documentId));
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: args.documentId,
      eventType: 'posted',
      eventPayloadJson: JSON.stringify({ by: args.actor.username }),
      eventAt: ts,
    });
    const ledgerPayloads: Array<{
      type: 'upsert';
      table: LedgerTableName;
      row_id: string;
      row: Record<string, unknown>;
      actor: { userId: string; username: string; role: string };
      ts: number;
    }> = [];
    const balanceRows = await db
      .select()
      .from(erpRegStockBalance)
      .where(inArray(erpRegStockBalance.id, Array.from(new Set(Array.from(balanceByKey.values()).map((item) => item.id))) as any));
    for (const balance of balanceRows) {
      ledgerPayloads.push({
        type: 'upsert',
        table: LedgerTableName.ErpRegStockBalance,
        row_id: String(balance.id),
        row: {
          id: String(balance.id),
          nomenclature_id: balance.nomenclatureId,
          part_card_id: balance.partCardId,
          warehouse_id: String(balance.warehouseId),
          qty: Number(balance.qty),
          reserved_qty: Number(balance.reservedQty ?? 0),
          updated_at: Number(balance.updatedAt),
        },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      });
    }
    const movementRows = await db
      .select()
      .from(erpRegStockMovements)
      .where(eq(erpRegStockMovements.documentHeaderId, args.documentId));
    for (const movement of movementRows) {
      ledgerPayloads.push({
        type: 'upsert',
        table: LedgerTableName.ErpRegStockMovements,
        row_id: String(movement.id),
        row: {
          id: String(movement.id),
          nomenclature_id: String(movement.nomenclatureId),
          warehouse_id: String(movement.warehouseId),
          document_header_id: movement.documentHeaderId,
          movement_type: String(movement.movementType),
          qty: Number(movement.qty),
          direction: String(movement.direction),
          counterparty_id: movement.counterpartyId,
          reason: movement.reason,
          performed_at: Number(movement.performedAt),
          performed_by: movement.performedBy,
          created_at: Number(movement.createdAt),
        },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      });
    }
    if (ledgerPayloads.length > 0) signAndAppendDetailed(ledgerPayloads);
    return { ok: true, id: args.documentId, posted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseMovements(args?: {
  nomenclatureId?: string;
  warehouseId?: string;
  documentHeaderId?: string;
  fromDate?: number;
  toDate?: number;
  limit?: number;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const rows = await db.select().from(erpRegStockMovements).orderBy(desc(erpRegStockMovements.performedAt));
    const filtered = rows.filter((row) => {
      if (args?.nomenclatureId && String(row.nomenclatureId) !== String(args.nomenclatureId)) return false;
      if (args?.warehouseId && String(row.warehouseId) !== String(args.warehouseId)) return false;
      if (args?.documentHeaderId && String(row.documentHeaderId ?? '') !== String(args.documentHeaderId)) return false;
      if (args?.fromDate !== undefined && Number(row.performedAt) < Number(args.fromDate)) return false;
      if (args?.toDate !== undefined && Number(row.performedAt) > Number(args.toDate)) return false;
      return true;
    });
    const limit = Math.max(1, Math.min(2000, Number(args?.limit ?? 500)));
    return { ok: true, rows: filtered.slice(0, limit) as Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
