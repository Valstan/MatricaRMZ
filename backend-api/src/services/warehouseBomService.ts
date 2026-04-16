import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { LedgerTableName } from '@matricarmz/ledger';

import { db } from '../database/db.js';
import {
  erpEngineAssemblyBom,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  erpPlannedIncoming,
  erpRegStockBalance,
} from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
type Actor = { id: string; username: string; role?: string };

function nowMs() {
  return Date.now();
}

function normalizeStatus(raw: string | undefined): 'draft' | 'active' | 'archived' {
  const value = String(raw ?? 'draft').trim().toLowerCase();
  if (value === 'active' || value === 'archived') return value;
  return 'draft';
}

function normalizeComponentType(raw: string | undefined): 'sleeve' | 'piston' | 'ring' | 'jacket' | 'head' | 'other' {
  const value = String(raw ?? 'other').trim().toLowerCase();
  if (value === 'sleeve' || value === 'piston' || value === 'ring' || value === 'jacket' || value === 'head') return value;
  return 'other';
}

type BomLineInput = {
  id?: string;
  componentNomenclatureId: string;
  componentType?: string;
  qtyPerUnit: number;
  variantGroup?: string | null;
  isRequired?: boolean;
  priority?: number;
  notes?: string | null;
};

export async function listWarehouseAssemblyBoms(args?: {
  engineNomenclatureId?: string;
  status?: string;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const conditions = [isNull(erpEngineAssemblyBom.deletedAt)];
    if (args?.engineNomenclatureId) {
      conditions.push(eq(erpEngineAssemblyBom.engineNomenclatureId, String(args.engineNomenclatureId)));
    }
    if (args?.status) {
      conditions.push(eq(erpEngineAssemblyBom.status, normalizeStatus(args.status)));
    }
    const headerRows = await db
      .select({
        id: erpEngineAssemblyBom.id,
        name: erpEngineAssemblyBom.name,
        engineNomenclatureId: erpEngineAssemblyBom.engineNomenclatureId,
        version: erpEngineAssemblyBom.version,
        status: erpEngineAssemblyBom.status,
        isDefault: erpEngineAssemblyBom.isDefault,
        notes: erpEngineAssemblyBom.notes,
        createdAt: erpEngineAssemblyBom.createdAt,
        updatedAt: erpEngineAssemblyBom.updatedAt,
        deletedAt: erpEngineAssemblyBom.deletedAt,
        engineCode: erpNomenclature.code,
        engineName: erpNomenclature.name,
      })
      .from(erpEngineAssemblyBom)
      .leftJoin(erpNomenclature, eq(erpNomenclature.id, erpEngineAssemblyBom.engineNomenclatureId))
      .where(and(...conditions))
      .orderBy(desc(erpEngineAssemblyBom.updatedAt), desc(erpEngineAssemblyBom.version));

    const bomIds = headerRows.map((row) => String(row.id));
    const lineCounts = new Map<string, number>();
    if (bomIds.length > 0) {
      const grouped = await db
        .select({
          bomId: erpEngineAssemblyBomLines.bomId,
          count: sql<number>`count(*)`,
        })
        .from(erpEngineAssemblyBomLines)
        .where(and(inArray(erpEngineAssemblyBomLines.bomId, bomIds as any), isNull(erpEngineAssemblyBomLines.deletedAt)))
        .groupBy(erpEngineAssemblyBomLines.bomId);
      for (const row of grouped) {
        lineCounts.set(String(row.bomId), Number(row.count ?? 0));
      }
    }

    return {
      ok: true,
      rows: headerRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        engineNomenclatureId: String(row.engineNomenclatureId),
        engineNomenclatureCode: row.engineCode ? String(row.engineCode) : null,
        engineNomenclatureName: row.engineName ? String(row.engineName) : null,
        version: Number(row.version ?? 1),
        status: String(row.status),
        isDefault: Boolean(row.isDefault),
        notes: row.notes ?? null,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
        linesCount: lineCounts.get(String(row.id)) ?? 0,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function loadBomDetailsById(id: string): Promise<Result<{ bom: { header: Record<string, unknown>; lines: Array<Record<string, unknown>> } }>> {
  const headerRows = await listWarehouseAssemblyBoms();
  if (!headerRows.ok) return headerRows as any;
  const header = headerRows.rows.find((row) => String(row.id) === String(id));
  if (!header) return { ok: false, error: 'BOM не найден' };

  const lines = await db
    .select({
      id: erpEngineAssemblyBomLines.id,
      bomId: erpEngineAssemblyBomLines.bomId,
      componentNomenclatureId: erpEngineAssemblyBomLines.componentNomenclatureId,
      componentNomenclatureCode: erpNomenclature.code,
      componentNomenclatureName: erpNomenclature.name,
      componentType: erpEngineAssemblyBomLines.componentType,
      qtyPerUnit: erpEngineAssemblyBomLines.qtyPerUnit,
      variantGroup: erpEngineAssemblyBomLines.variantGroup,
      isRequired: erpEngineAssemblyBomLines.isRequired,
      priority: erpEngineAssemblyBomLines.priority,
      notes: erpEngineAssemblyBomLines.notes,
      createdAt: erpEngineAssemblyBomLines.createdAt,
      updatedAt: erpEngineAssemblyBomLines.updatedAt,
      deletedAt: erpEngineAssemblyBomLines.deletedAt,
    })
    .from(erpEngineAssemblyBomLines)
    .leftJoin(erpNomenclature, eq(erpNomenclature.id, erpEngineAssemblyBomLines.componentNomenclatureId))
    .where(and(eq(erpEngineAssemblyBomLines.bomId, String(id)), isNull(erpEngineAssemblyBomLines.deletedAt)))
    .orderBy(asc(erpEngineAssemblyBomLines.priority), asc(erpEngineAssemblyBomLines.createdAt));

  return {
    ok: true,
    bom: {
      header,
      lines: lines.map((row) => ({
        id: String(row.id),
        bomId: String(row.bomId),
        componentNomenclatureId: String(row.componentNomenclatureId),
        componentNomenclatureCode: row.componentNomenclatureCode ? String(row.componentNomenclatureCode) : null,
        componentNomenclatureName: row.componentNomenclatureName ? String(row.componentNomenclatureName) : null,
        componentType: String(row.componentType),
        qtyPerUnit: Number(row.qtyPerUnit ?? 0),
        variantGroup: row.variantGroup ?? null,
        isRequired: Boolean(row.isRequired),
        priority: Number(row.priority ?? 100),
        notes: row.notes ?? null,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
      })),
    },
  };
}

export async function getWarehouseAssemblyBom(args: { id: string }): Promise<Result<{ bom: { header: Record<string, unknown>; lines: Array<Record<string, unknown>> } }>> {
  try {
    return await loadBomDetailsById(String(args.id));
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseAssemblyBom(args: {
  id?: string;
  name: string;
  engineNomenclatureId: string;
  version?: number;
  status?: string;
  isDefault?: boolean;
  notes?: string | null;
  lines: BomLineInput[];
  actor: Actor;
}): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id ?? randomUUID());
    const ts = nowMs();
    const status = normalizeStatus(args.status);
    const version = Math.max(1, Math.trunc(Number(args.version ?? 1)));
    const base = {
      name: String(args.name ?? '').trim() || `BOM ${version}`,
      engineNomenclatureId: String(args.engineNomenclatureId),
      version,
      status,
      isDefault: Boolean(args.isDefault),
      notes: args.notes == null ? null : String(args.notes),
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced' as const,
    };

    await db
      .insert(erpEngineAssemblyBom)
      .values({
        id,
        ...base,
        createdAt: ts,
        lastServerSeq: null,
      })
      .onConflictDoUpdate({
        target: erpEngineAssemblyBom.id,
        set: {
          ...base,
        },
      });

    await db
      .update(erpEngineAssemblyBomLines)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(erpEngineAssemblyBomLines.bomId, id), isNull(erpEngineAssemblyBomLines.deletedAt)));

    const normalizedLines = (Array.isArray(args.lines) ? args.lines : [])
      .map((line) => ({
        id: String(line.id ?? randomUUID()),
        bomId: id,
        componentNomenclatureId: String(line.componentNomenclatureId),
        componentType: normalizeComponentType(line.componentType),
        qtyPerUnit: Math.max(0, Math.trunc(Number(line.qtyPerUnit ?? 0))),
        variantGroup: line.variantGroup == null ? null : String(line.variantGroup).trim() || null,
        isRequired: line.isRequired !== false,
        priority: Math.max(0, Math.trunc(Number(line.priority ?? 100))),
        notes: line.notes == null ? null : String(line.notes),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced' as const,
        lastServerSeq: null,
      }))
      .filter((line) => line.componentNomenclatureId);

    if (normalizedLines.length > 0) {
      await db.insert(erpEngineAssemblyBomLines).values(normalizedLines);
    }

    if (status === 'active' && Boolean(args.isDefault)) {
      await db
        .update(erpEngineAssemblyBom)
        .set({ isDefault: false, updatedAt: ts, syncStatus: 'synced' })
        .where(
          and(
            eq(erpEngineAssemblyBom.engineNomenclatureId, String(args.engineNomenclatureId)),
            isNull(erpEngineAssemblyBom.deletedAt),
            eq(erpEngineAssemblyBom.status, 'active'),
            sql`${erpEngineAssemblyBom.id} <> ${id}`,
          ),
        );
    }

    const savedBom = await db.select().from(erpEngineAssemblyBom).where(eq(erpEngineAssemblyBom.id, id)).limit(1);
    if (savedBom[0]) {
      const row = savedBom[0];
      signAndAppendDetailed([
        {
          type: 'upsert',
          table: LedgerTableName.ErpEngineAssemblyBom,
          row_id: String(row.id),
          row: {
            id: String(row.id),
            name: String(row.name),
            engine_nomenclature_id: String(row.engineNomenclatureId),
            version: Number(row.version),
            status: String(row.status),
            is_default: Boolean(row.isDefault),
            notes: row.notes ?? null,
            created_at: Number(row.createdAt),
            updated_at: Number(row.updatedAt),
            deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
            sync_status: String(row.syncStatus ?? 'synced'),
            last_server_seq: row.lastServerSeq == null ? null : Number(row.lastServerSeq),
          },
          actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
          ts,
        },
      ]);
    }

    const savedLines = await db
      .select()
      .from(erpEngineAssemblyBomLines)
      .where(and(eq(erpEngineAssemblyBomLines.bomId, id), isNull(erpEngineAssemblyBomLines.deletedAt)));
    if (savedLines.length > 0) {
      signAndAppendDetailed(
        savedLines.map((line) => ({
          type: 'upsert' as const,
          table: LedgerTableName.ErpEngineAssemblyBomLines,
          row_id: String(line.id),
          row: {
            id: String(line.id),
            bom_id: String(line.bomId),
            component_nomenclature_id: String(line.componentNomenclatureId),
            component_type: String(line.componentType),
            qty_per_unit: Number(line.qtyPerUnit),
            variant_group: line.variantGroup ?? null,
            is_required: Boolean(line.isRequired),
            priority: Number(line.priority),
            notes: line.notes ?? null,
            created_at: Number(line.createdAt),
            updated_at: Number(line.updatedAt),
            deleted_at: line.deletedAt == null ? null : Number(line.deletedAt),
            sync_status: String(line.syncStatus ?? 'synced'),
            last_server_seq: line.lastServerSeq == null ? null : Number(line.lastServerSeq),
          },
          actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
          ts,
        })),
      );
    }

    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function activateWarehouseAssemblyBomAsDefault(args: {
  id: string;
  actor: Actor;
}): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id);
    const current = await db.select().from(erpEngineAssemblyBom).where(and(eq(erpEngineAssemblyBom.id, id), isNull(erpEngineAssemblyBom.deletedAt))).limit(1);
    const row = current[0];
    if (!row) return { ok: false, error: 'BOM не найден' };
    const ts = nowMs();
    await db
      .update(erpEngineAssemblyBom)
      .set({ isDefault: false, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(erpEngineAssemblyBom.engineNomenclatureId, row.engineNomenclatureId), isNull(erpEngineAssemblyBom.deletedAt)));
    await db
      .update(erpEngineAssemblyBom)
      .set({ status: 'active', isDefault: true, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(erpEngineAssemblyBom.id, id));
    const affected = await db
      .select()
      .from(erpEngineAssemblyBom)
      .where(and(eq(erpEngineAssemblyBom.engineNomenclatureId, row.engineNomenclatureId), isNull(erpEngineAssemblyBom.deletedAt)));
    if (affected.length > 0) {
      signAndAppendDetailed(
        affected.map((item) => ({
          type: 'upsert' as const,
          table: LedgerTableName.ErpEngineAssemblyBom,
          row_id: String(item.id),
          row: {
            id: String(item.id),
            name: String(item.name),
            engine_nomenclature_id: String(item.engineNomenclatureId),
            version: Number(item.version),
            status: String(item.status),
            is_default: Boolean(item.isDefault),
            notes: item.notes ?? null,
            created_at: Number(item.createdAt),
            updated_at: Number(item.updatedAt),
            deleted_at: item.deletedAt == null ? null : Number(item.deletedAt),
            sync_status: String(item.syncStatus ?? 'synced'),
            last_server_seq: item.lastServerSeq == null ? null : Number(item.lastServerSeq),
          },
          actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
          ts,
        })),
      );
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function archiveWarehouseAssemblyBom(args: { id: string; actor: Actor }): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id);
    const ts = nowMs();
    await db
      .update(erpEngineAssemblyBom)
      .set({ status: 'archived', isDefault: false, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(erpEngineAssemblyBom.id, id));
    const saved = await db.select().from(erpEngineAssemblyBom).where(eq(erpEngineAssemblyBom.id, id)).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'upsert',
          table: LedgerTableName.ErpEngineAssemblyBom,
          row_id: String(row.id),
          row: {
            id: String(row.id),
            name: String(row.name),
            engine_nomenclature_id: String(row.engineNomenclatureId),
            version: Number(row.version),
            status: String(row.status),
            is_default: Boolean(row.isDefault),
            notes: row.notes ?? null,
            created_at: Number(row.createdAt),
            updated_at: Number(row.updatedAt),
            deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
            sync_status: String(row.syncStatus ?? 'synced'),
            last_server_seq: row.lastServerSeq == null ? null : Number(row.lastServerSeq),
          },
          actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
          ts,
        },
      ]);
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseAssemblyBomHistory(args: {
  engineNomenclatureId: string;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  return listWarehouseAssemblyBoms({ engineNomenclatureId: String(args.engineNomenclatureId) });
}

export async function getWarehouseAssemblyBomPrintPayload(args: {
  id: string;
}): Promise<Result<{ payload: { header: Record<string, unknown>; lines: Array<Record<string, unknown>> } }>> {
  try {
    const details = await loadBomDetailsById(String(args.id));
    if (!details.ok) return details as any;
    return { ok: true, payload: details.bom };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function buildWarehouseBomExpandedForecast(args: {
  engineId: string;
  targetEnginesPerDay?: number;
  horizonDays?: number;
  warehouseIds?: string[];
}): Promise<Result<{ rows: Array<Record<string, unknown>>; warnings: string[] }>> {
  try {
    const engineId = String(args.engineId).trim();
    if (!engineId) return { ok: false, error: 'engineId обязателен' };
    const horizonDays = Math.max(1, Math.min(14, Math.trunc(Number(args.horizonDays ?? 7))));
    const target = Math.max(0, Math.trunc(Number(args.targetEnginesPerDay ?? 1)));
    const totalEngines = target * horizonDays;
    const warehouseSet = Array.isArray(args.warehouseIds) && args.warehouseIds.length > 0 ? new Set(args.warehouseIds.map(String)) : null;

    const bomRows = await db
      .select()
      .from(erpEngineAssemblyBom)
      .where(
        and(
          eq(erpEngineAssemblyBom.engineNomenclatureId, engineId),
          eq(erpEngineAssemblyBom.status, 'active'),
          eq(erpEngineAssemblyBom.isDefault, true),
          isNull(erpEngineAssemblyBom.deletedAt),
        ),
      )
      .orderBy(desc(erpEngineAssemblyBom.updatedAt))
      .limit(1);
    const bom = bomRows[0];
    if (!bom) return { ok: false, error: 'Нет активной default BOM для выбранного двигателя' };

    const lineRows = await db
      .select({
        componentNomenclatureId: erpEngineAssemblyBomLines.componentNomenclatureId,
        componentType: erpEngineAssemblyBomLines.componentType,
        qtyPerUnit: erpEngineAssemblyBomLines.qtyPerUnit,
        variantGroup: erpEngineAssemblyBomLines.variantGroup,
        isRequired: erpEngineAssemblyBomLines.isRequired,
        priority: erpEngineAssemblyBomLines.priority,
        code: erpNomenclature.code,
        name: erpNomenclature.name,
      })
      .from(erpEngineAssemblyBomLines)
      .leftJoin(erpNomenclature, eq(erpNomenclature.id, erpEngineAssemblyBomLines.componentNomenclatureId))
      .where(and(eq(erpEngineAssemblyBomLines.bomId, bom.id), isNull(erpEngineAssemblyBomLines.deletedAt)))
      .orderBy(asc(erpEngineAssemblyBomLines.priority), asc(erpEngineAssemblyBomLines.createdAt));

    const stockRows = await db.select().from(erpRegStockBalance);
    const stockMap = new Map<string, number>();
    for (const row of stockRows) {
      const nomenclatureId = row.nomenclatureId ? String(row.nomenclatureId) : '';
      if (!nomenclatureId) continue;
      if (warehouseSet && !warehouseSet.has(String(row.warehouseId))) continue;
      const available = Math.max(0, Number(row.qty ?? 0) - Number(row.reservedQty ?? 0));
      stockMap.set(nomenclatureId, (stockMap.get(nomenclatureId) ?? 0) + available);
    }

    const now = nowMs();
    const to = now + horizonDays * 24 * 60 * 60 * 1000;
    const incomingRows = await db
      .select()
      .from(erpPlannedIncoming)
      .where(and(isNull(erpPlannedIncoming.deletedAt), sql`${erpPlannedIncoming.expectedDate} >= ${now}`, sql`${erpPlannedIncoming.expectedDate} <= ${to}`));
    const incomingMap = new Map<string, number>();
    for (const row of incomingRows) {
      const nomenclatureId = String(row.nomenclatureId);
      if (!nomenclatureId) continue;
      if (warehouseSet && !warehouseSet.has(String(row.warehouseId))) continue;
      const qty = Math.max(0, Number(row.qty ?? 0));
      if (qty <= 0) continue;
      incomingMap.set(nomenclatureId, (incomingMap.get(nomenclatureId) ?? 0) + qty);
    }

    const rows = lineRows.map((line) => {
      const nomenclatureId = String(line.componentNomenclatureId);
      const requiredQty = Math.max(0, Number(line.qtyPerUnit ?? 0)) * totalEngines;
      const stockQty = stockMap.get(nomenclatureId) ?? 0;
      const plannedIncomingQty = incomingMap.get(nomenclatureId) ?? 0;
      const deficitQty = Math.max(0, requiredQty - stockQty - plannedIncomingQty);
      return {
        componentNomenclatureId: nomenclatureId,
        componentNomenclatureCode: line.code ? String(line.code) : null,
        componentNomenclatureName: line.name ? String(line.name) : null,
        componentType: String(line.componentType),
        qtyPerUnit: Number(line.qtyPerUnit ?? 0),
        requiredQty,
        stockQty,
        plannedIncomingQty,
        deficitQty,
        variantGroup: line.variantGroup ?? null,
        isRequired: Boolean(line.isRequired),
        priority: Number(line.priority ?? 100),
      };
    });

    return { ok: true, rows, warnings: [] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
