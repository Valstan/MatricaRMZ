// Т2 (docs/plans/parts-articul-acts-2026-06.md): operator-driven search & merge of
// duplicate directory parts (детали номенклатуры). Reuses the engine-dedupe shape
// (#313/#315): canonical key = Т1 identity pair (name, артикул), merged_into
// tombstone, reference repointing — but the operator decides what merges and who
// survives (no auto-merge job: parts are not mass-produced by offline races the
// way engine numbers are).
//
// Key model fact (verified on prod snapshot): a part's paired erp_nomenclature row
// shares the SAME uuid as the directory_parts row, so every consumer (stock
// registers, BOM lines, document lines, acts' __part_id meta) references one id —
// repointing loser→survivor is a single-id sweep.
import { LedgerTableName } from '@matricarmz/ledger';
import {
  SyncTableName,
  WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART,
  groupDirectoryPartDuplicates,
  type PartMetadata,
  type PartSpecBrandLink,
} from '@matricarmz/shared';

import { and, eq, inArray, isNull, like } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  directoryParts,
  erpDocumentLines,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
  operations,
} from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
type Actor = { id: string; username: string; role: string };

function nowMs() {
  return Date.now();
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseMetadata(raw: string | null | undefined): PartMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PartMetadata) : {};
  } catch {
    return {};
  }
}

function serializeMetadata(metadata: PartMetadata): string | null {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) clean[key] = value;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

export type DirectoryPartDedupeUsage = {
  stockBalances: number;
  stockMovements: number;
  bomLines: number;
  docLines: number;
  brandLinks: number;
  hasNomenclature: boolean;
};

export type DirectoryPartDedupeGroupRow = {
  id: string;
  name: string;
  code: string | null;
  isActive: boolean;
  createdAt: number;
  usage: DirectoryPartDedupeUsage;
};

export async function analyzeDirectoryPartDuplicates(): Promise<
  Result<{
    groups: Array<{ kind: 'exact' | 'code-collision' | 'fuzzy'; parts: DirectoryPartDedupeGroupRow[] }>;
    totalParts: number;
  }>
> {
  try {
    const rows = await db
      .select({
        id: directoryParts.id,
        name: directoryParts.name,
        code: directoryParts.code,
        isActive: directoryParts.isActive,
        createdAt: directoryParts.createdAt,
        brandLinksJson: directoryParts.brandLinksJson,
      })
      .from(directoryParts)
      .where(isNull(directoryParts.deletedAt));

    const groups = groupDirectoryPartDuplicates(
      rows.map((r) => ({ id: String(r.id), name: String(r.name ?? ''), code: r.code ?? null })),
    );
    if (groups.length === 0) return { ok: true, groups: [], totalParts: rows.length };

    const candidateIds = Array.from(new Set(groups.flatMap((g) => g.ids)));
    const byId = new Map(rows.map((r) => [String(r.id), r]));

    const usageById = new Map<string, DirectoryPartDedupeUsage>();
    for (const id of candidateIds) {
      const row = byId.get(id);
      usageById.set(id, {
        stockBalances: 0,
        stockMovements: 0,
        bomLines: 0,
        docLines: 0,
        brandLinks: row ? parseJsonArray<PartSpecBrandLink>(row.brandLinksJson).length : 0,
        hasNomenclature: false,
      });
    }
    const bump = (id: string | null | undefined, field: keyof DirectoryPartDedupeUsage) => {
      const usage = id ? usageById.get(String(id)) : undefined;
      if (usage && typeof usage[field] === 'number') (usage[field] as number) += 1;
    };
    const balances = await db
      .select({ nomenclatureId: erpRegStockBalance.nomenclatureId })
      .from(erpRegStockBalance)
      .where(inArray(erpRegStockBalance.nomenclatureId, candidateIds as any));
    for (const b of balances) bump(b.nomenclatureId, 'stockBalances');
    const movements = await db
      .select({ nomenclatureId: erpRegStockMovements.nomenclatureId })
      .from(erpRegStockMovements)
      .where(inArray(erpRegStockMovements.nomenclatureId, candidateIds as any));
    for (const m of movements) bump(m.nomenclatureId, 'stockMovements');
    const bomLines = await db
      .select({ componentNomenclatureId: erpEngineAssemblyBomLines.componentNomenclatureId })
      .from(erpEngineAssemblyBomLines)
      .where(
        and(
          inArray(erpEngineAssemblyBomLines.componentNomenclatureId, candidateIds as any),
          isNull(erpEngineAssemblyBomLines.deletedAt),
        ),
      );
    for (const l of bomLines) bump(l.componentNomenclatureId, 'bomLines');
    const docLines = await db
      .select({ nomenclatureId: erpDocumentLines.nomenclatureId })
      .from(erpDocumentLines)
      .where(inArray(erpDocumentLines.nomenclatureId, candidateIds as any));
    for (const l of docLines) bump(l.nomenclatureId, 'docLines');
    const noms = await db
      .select({ id: erpNomenclature.id })
      .from(erpNomenclature)
      .where(and(inArray(erpNomenclature.id, candidateIds as any), isNull(erpNomenclature.deletedAt)));
    for (const n of noms) {
      const usage = usageById.get(String(n.id));
      if (usage) usage.hasNomenclature = true;
    }

    const outGroups = groups.map((g) => ({
      kind: g.kind,
      parts: g.ids
        .map((id) => {
          const row = byId.get(id);
          return {
            id,
            name: String(row?.name ?? ''),
            code: row?.code ?? null,
            isActive: Boolean(row?.isActive),
            createdAt: Number(row?.createdAt ?? 0),
            usage: usageById.get(id) ?? {
              stockBalances: 0,
              stockMovements: 0,
              bomLines: 0,
              docLines: 0,
              brandLinks: 0,
              hasNomenclature: false,
            },
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.createdAt - b.createdAt),
    }));
    // Exact first, then code collisions, then fuzzy; larger groups first within a kind.
    const kindRank = (k: 'exact' | 'code-collision' | 'fuzzy') => (k === 'exact' ? 0 : k === 'code-collision' ? 1 : 2);
    outGroups.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.parts.length - a.parts.length);
    return { ok: true, groups: outGroups, totalParts: rows.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export type DirectoryPartsMergeReport = {
  survivorId: string;
  merged: Array<{
    loserId: string;
    repointed: { stockBalances: number; stockMovements: number; bomLines: number; docLines: number; operations: number };
    bomLinesDropped: number;
    brandLinksAdded: number;
  }>;
  fills: string[];
  conflicts: string[];
};

const ledgerActor = (actor: Actor) => ({ userId: actor.id, username: actor.username, role: actor.role ?? 'user' });

function nomenclatureLedgerRow(row: typeof erpNomenclature.$inferSelect, ts: number) {
  return {
    id: String(row.id),
    code: String(row.code),
    sku: row.sku ?? null,
    name: String(row.name),
    item_type: String(row.itemType),
    category: row.category ?? null,
    directory_kind: row.directoryKind ?? null,
    directory_ref_id: row.directoryRefId ?? null,
    group_id: row.groupId,
    unit_id: row.unitId,
    barcode: row.barcode,
    min_stock: row.minStock,
    max_stock: row.maxStock,
    default_brand_id: row.defaultBrandId ?? null,
    is_serial_tracked: Boolean(row.isSerialTracked),
    default_warehouse_id: row.defaultWarehouseId,
    spec_json: row.specJson,
    is_active: Boolean(row.isActive),
    created_at: Number(row.createdAt),
    updated_at: ts,
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
  };
}

function balanceLedgerRow(row: typeof erpRegStockBalance.$inferSelect) {
  return {
    id: String(row.id),
    nomenclature_id: row.nomenclatureId,
    part_card_id: row.partCardId,
    warehouse_location_id: row.warehouseLocationId ?? null,
    qty: Number(row.qty),
    reserved_qty: Number(row.reservedQty ?? 0),
    updated_at: Number(row.updatedAt),
  };
}

function movementLedgerRow(row: typeof erpRegStockMovements.$inferSelect) {
  return {
    id: String(row.id),
    nomenclature_id: String(row.nomenclatureId),
    warehouse_location_id: row.warehouseLocationId ?? null,
    document_header_id: row.documentHeaderId,
    movement_type: String(row.movementType),
    qty: Number(row.qty),
    direction: String(row.direction),
    engine_id: row.engineId,
    counterparty_id: row.counterpartyId,
    reason: row.reason,
    performed_at: Number(row.performedAt),
    performed_by: row.performedBy,
    prev_hash: row.prevHash,
    self_hash: row.selfHash,
    created_at: Number(row.createdAt),
  };
}

function bomLineLedgerRow(row: typeof erpEngineAssemblyBomLines.$inferSelect, ts: number) {
  return {
    id: String(row.id),
    bom_id: String(row.bomId),
    component_nomenclature_id: String(row.componentNomenclatureId),
    component_type: String(row.componentType),
    qty_per_unit: Number(row.qtyPerUnit),
    variant_group: row.variantGroup ?? null,
    is_required: Boolean(row.isRequired),
    priority: Number(row.priority),
    notes: row.notes ?? null,
    created_at: Number(row.createdAt),
    updated_at: ts,
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

function operationSyncPayload(row: typeof operations.$inferSelect, ts: number) {
  return {
    id: String(row.id),
    engine_entity_id: String(row.engineEntityId),
    operation_type: String(row.operationType),
    status: String(row.status),
    note: row.note ?? null,
    performed_at: row.performedAt == null ? null : Number(row.performedAt),
    performed_by: row.performedBy ?? null,
    meta_json: row.metaJson ?? null,
    created_at: Number(row.createdAt),
    updated_at: ts,
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
  };
}

// Rewrite every "__part_id"/"__brand_part_id" string equal to loserId inside the
// operation meta JSON (acts' inventory/defect/completeness rows keep the picked
// part id in these row meta-keys). Exported for tests.
export function rewriteMetaPartIds(metaJson: string, loserId: string, survivorId: string): string | null {
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if ((key === '__part_id' || key === '__brand_part_id') && value === loserId) {
          out[key] = survivorId;
          changed = true;
        } else {
          out[key] = walk(value);
        }
      }
      return out;
    }
    return node;
  };
  try {
    const rewritten = walk(JSON.parse(metaJson));
    return changed ? JSON.stringify(rewritten) : null;
  } catch {
    return null;
  }
}

const META_MERGE_FIELDS: Array<keyof PartMetadata> = [
  'description',
  'assemblyUnitNumber',
  'engineNodeId',
  'purchaseDate',
  'supplierId',
  'contractId',
];

export async function mergeDirectoryParts(args: {
  survivorId: string;
  mergedIds: string[];
  actor: Actor;
}): Promise<Result<{ report: DirectoryPartsMergeReport }>> {
  try {
    const survivorId = String(args.survivorId ?? '').trim();
    const mergedIds = Array.from(new Set((args.mergedIds ?? []).map((x) => String(x).trim()).filter(Boolean)));
    if (!survivorId) return { ok: false, error: 'survivorId обязателен' };
    if (mergedIds.length === 0) return { ok: false, error: 'mergedIds пуст' };
    if (mergedIds.includes(survivorId)) return { ok: false, error: 'survivor не может входить в mergedIds' };

    const allIds = [survivorId, ...mergedIds];
    const rows = await db
      .select()
      .from(directoryParts)
      .where(and(inArray(directoryParts.id, allIds as any), isNull(directoryParts.deletedAt)));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const survivor = byId.get(survivorId);
    if (!survivor) return { ok: false, error: `survivor не найден или удалён: ${survivorId}` };
    for (const id of mergedIds) {
      if (!byId.get(id)) return { ok: false, error: `деталь не найдена или уже удалена: ${id}` };
    }

    // Heal-not-error: the survivor needs a paired nomenclature card (складская карточка)
    // because stock / BOM / document rows FK to erp_nomenclature.id and we repoint them
    // onto the survivor. If the survivor has none but a loser does, ADOPT that donor's
    // card: soft-delete the donor's nomenclature (which frees its code — safe since
    // migration 0066 made erp_nomenclature_code_uq partial WHERE deleted_at IS NULL) and
    // create the survivor's mirror with that code inside the same transaction. Before 0066
    // this was impossible (the soft-deleted donor kept holding the code) so the merge
    // errored out and asked the operator to re-pick the survivor.
    const nomRows = await db
      .select()
      .from(erpNomenclature)
      .where(and(inArray(erpNomenclature.id, allIds as any), isNull(erpNomenclature.deletedAt)));
    const nomById = new Map(nomRows.map((r) => [String(r.id), r]));
    const donorNomLoserId = nomById.has(survivorId) ? null : mergedIds.find((id) => nomById.has(id)) ?? null;

    const report: DirectoryPartsMergeReport = { survivorId, merged: [], fills: [], conflicts: [] };
    const ts = nowMs();
    const actorRow = ledgerActor(args.actor);

    // --- 1) Field merge into survivor (code / dimensions / metadata / brand links) ---
    let survivorCode = survivor.code ?? null;
    let survivorDimensions = survivor.dimensionsJson ?? null;
    const survivorMeta = parseMetadata(survivor.metadataJson);
    const survivorLinks = parseJsonArray<PartSpecBrandLink>(survivor.brandLinksJson);
    const linkByBrand = new Map(survivorLinks.map((l) => [String(l.engineBrandId ?? ''), l]));
    const brandLinksAddedByLoser = new Map<string, number>();

    for (const loserId of mergedIds) {
      const loser = byId.get(loserId)!;
      const loserCode = loser.code ?? null;
      if (loserCode) {
        if (!survivorCode) {
          survivorCode = loserCode;
          report.fills.push(`артикул: «${loserCode}» (из ${loser.name})`);
        } else if (String(survivorCode).trim() !== String(loserCode).trim()) {
          report.conflicts.push(`артикул: survivor=«${survivorCode}» vs «${loserCode}» (${loser.name}) — оставлен survivor`);
        }
      }
      if (!survivorDimensions && loser.dimensionsJson) {
        survivorDimensions = loser.dimensionsJson;
        report.fills.push('размеры: взяты из поглощаемой');
      }
      const loserMeta = parseMetadata(loser.metadataJson);
      for (const field of META_MERGE_FIELDS) {
        const sv = survivorMeta[field];
        const lv = loserMeta[field];
        if (lv == null || lv === '') continue;
        if (sv == null || sv === '') {
          (survivorMeta as Record<string, unknown>)[field] = lv;
          report.fills.push(`${field}: «${String(lv)}»`);
        } else if (String(sv) !== String(lv)) {
          report.conflicts.push(`${field}: survivor=«${String(sv)}» vs «${String(lv)}» — оставлен survivor`);
        }
      }
      let added = 0;
      for (const link of parseJsonArray<PartSpecBrandLink>(loser.brandLinksJson)) {
        const key = String(link.engineBrandId ?? '');
        if (!linkByBrand.has(key)) {
          linkByBrand.set(key, link);
          added += 1;
        }
      }
      brandLinksAddedByLoser.set(loserId, added);
    }

    const allLedgerPayloads: Array<{
      type: 'upsert' | 'delete';
      table: LedgerTableName;
      row_id: string;
      row: Record<string, unknown>;
      actor: typeof actorRow;
      ts: number;
    }> = [];
    const allOpSyncChanges: Parameters<typeof recordSyncChanges>[1] = [];

    // Atomicity: every direct PG mutation of the merge runs inside ONE transaction,
    // so a mid-merge failure rolls back wholesale instead of leaving the catalogue
    // half-repointed. Ledger/sync writes can't join this tx (their pipeline opens
    // its own), so they are accumulated here and flushed AFTER the commit — on
    // rollback they never run, keeping the immutable log in step with PG.
    await db.transaction(async (tx) => {
      await tx
        .update(directoryParts)
        .set({
          code: survivorCode,
          dimensionsJson: survivorDimensions,
          metadataJson: serializeMetadata(survivorMeta),
          brandLinksJson: linkByBrand.size ? JSON.stringify(Array.from(linkByBrand.values())) : null,
          updatedAt: ts,
        })
        .where(eq(directoryParts.id, survivorId));

      // Heal: survivor lacks a складская карточка → adopt the donor loser's nomenclature.
      // Soft-delete the donor's card first (frees the code under the partial unique 0066),
      // then create the survivor's mirror with that code. The donor's id is recorded so the
      // per-loser loop below does not soft-delete it twice. Ledger emits are accumulated and
      // flushed post-commit like every other merge mutation.
      const adoptedDonorNomIds = new Set<string>();
      if (donorNomLoserId) {
        const donorNom = nomById.get(donorNomLoserId)!;
        await tx
          .update(erpNomenclature)
          .set({ isActive: false, deletedAt: ts, updatedAt: ts })
          .where(eq(erpNomenclature.id, donorNomLoserId));
        allLedgerPayloads.push({
          type: 'delete',
          table: LedgerTableName.ErpNomenclature,
          row_id: donorNomLoserId,
          row: nomenclatureLedgerRow({ ...donorNom, isActive: false, deletedAt: ts }, ts),
          actor: actorRow,
          ts,
        });
        adoptedDonorNomIds.add(donorNomLoserId);

        const survivorNomRow = {
          id: survivorId,
          code: survivorCode ?? `DET-${survivorId.slice(0, 8).toUpperCase()}`,
          sku: null,
          name: String(survivor.name ?? '').trim() || `Деталь ${survivorId.slice(0, 8)}`,
          itemType: donorNom.itemType ?? 'product',
          category: donorNom.category ?? null,
          directoryKind: 'part',
          directoryRefId: survivorId,
          groupId: donorNom.groupId ?? null,
          unitId: donorNom.unitId ?? null,
          barcode: null,
          minStock: donorNom.minStock ?? null,
          maxStock: donorNom.maxStock ?? null,
          defaultBrandId: donorNom.defaultBrandId ?? null,
          isSerialTracked: Boolean(donorNom.isSerialTracked),
          defaultWarehouseId: donorNom.defaultWarehouseId ?? null,
          specJson: JSON.stringify({
            source: WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART,
            partId: survivorId,
            ...(survivorCode ? { article: survivorCode } : {}),
          }),
          componentTypeId: donorNom.componentTypeId ?? null,
          isActive: true,
          syncStatus: 'synced',
          lastServerSeq: null,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        };
        await tx.insert(erpNomenclature).values(survivorNomRow as any);
        allLedgerPayloads.push({
          type: 'upsert',
          table: LedgerTableName.ErpNomenclature,
          row_id: survivorId,
          row: nomenclatureLedgerRow(survivorNomRow as any, ts),
          actor: actorRow,
          ts,
        });
        report.fills.push('складская карточка: создана для главной детали (перенесена с поглощаемой)');
      }

      for (const loserId of mergedIds) {
        const repointed = { stockBalances: 0, stockMovements: 0, bomLines: 0, docLines: 0, operations: 0 };
        let bomLinesDropped = 0;
        const ledgerPayloads: Array<{
          type: 'upsert' | 'delete';
          table: LedgerTableName;
          row_id: string;
          row: Record<string, unknown>;
          actor: typeof actorRow;
          ts: number;
        }> = [];

        const loserNom = nomById.get(loserId);

        // --- stock balances: repoint, merging same-location rows by qty ---
        const loserBalances = await tx.select().from(erpRegStockBalance).where(eq(erpRegStockBalance.nomenclatureId, loserId));
        for (const lb of loserBalances) {
          const sb = (
            await tx
              .select()
              .from(erpRegStockBalance)
              .where(
                and(
                  eq(erpRegStockBalance.nomenclatureId, survivorId),
                  lb.warehouseLocationId == null
                    ? isNull(erpRegStockBalance.warehouseLocationId)
                    : eq(erpRegStockBalance.warehouseLocationId, lb.warehouseLocationId),
                ),
              )
              .limit(1)
          )[0];
          if (sb) {
            await tx
              .update(erpRegStockBalance)
              .set({ qty: Number(sb.qty) + Number(lb.qty), reservedQty: Number(sb.reservedQty ?? 0) + Number(lb.reservedQty ?? 0), updatedAt: ts })
              .where(eq(erpRegStockBalance.id, sb.id));
            await tx.delete(erpRegStockBalance).where(eq(erpRegStockBalance.id, lb.id));
            ledgerPayloads.push({
              type: 'delete',
              table: LedgerTableName.ErpRegStockBalance,
              row_id: String(lb.id),
              row: balanceLedgerRow(lb),
              actor: actorRow,
              ts,
            });
            const updated = (await tx.select().from(erpRegStockBalance).where(eq(erpRegStockBalance.id, sb.id)).limit(1))[0];
            if (updated) {
              ledgerPayloads.push({
                type: 'upsert',
                table: LedgerTableName.ErpRegStockBalance,
                row_id: String(updated.id),
                row: balanceLedgerRow(updated),
                actor: actorRow,
                ts,
              });
            }
          } else {
            await tx.update(erpRegStockBalance).set({ nomenclatureId: survivorId, updatedAt: ts }).where(eq(erpRegStockBalance.id, lb.id));
            const updated = (await tx.select().from(erpRegStockBalance).where(eq(erpRegStockBalance.id, lb.id)).limit(1))[0];
            if (updated) {
              ledgerPayloads.push({
                type: 'upsert',
                table: LedgerTableName.ErpRegStockBalance,
                row_id: String(updated.id),
                row: balanceLedgerRow(updated),
                actor: actorRow,
                ts,
              });
            }
          }
          repointed.stockBalances += 1;
        }

        // --- stock movements: plain repoint ---
        const loserMovements = await tx.select().from(erpRegStockMovements).where(eq(erpRegStockMovements.nomenclatureId, loserId));
        for (const mv of loserMovements) {
          await tx.update(erpRegStockMovements).set({ nomenclatureId: survivorId }).where(eq(erpRegStockMovements.id, mv.id));
          ledgerPayloads.push({
            type: 'upsert',
            table: LedgerTableName.ErpRegStockMovements,
            row_id: String(mv.id),
            row: { ...movementLedgerRow(mv), nomenclature_id: survivorId },
            actor: actorRow,
            ts,
          });
          repointed.stockMovements += 1;
        }

        // --- BOM lines: repoint; drop the loser line if the survivor is already in that BOM ---
        const loserBomLines = await tx
          .select()
          .from(erpEngineAssemblyBomLines)
          .where(and(eq(erpEngineAssemblyBomLines.componentNomenclatureId, loserId), isNull(erpEngineAssemblyBomLines.deletedAt)));
        for (const line of loserBomLines) {
          const existing = (
            await tx
              .select({ id: erpEngineAssemblyBomLines.id })
              .from(erpEngineAssemblyBomLines)
              .where(
                and(
                  eq(erpEngineAssemblyBomLines.bomId, line.bomId),
                  eq(erpEngineAssemblyBomLines.componentNomenclatureId, survivorId),
                  isNull(erpEngineAssemblyBomLines.deletedAt),
                ),
              )
              .limit(1)
          )[0];
          if (existing) {
            await tx
              .update(erpEngineAssemblyBomLines)
              .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
              .where(eq(erpEngineAssemblyBomLines.id, line.id));
            ledgerPayloads.push({
              type: 'delete',
              table: LedgerTableName.ErpEngineAssemblyBomLines,
              row_id: String(line.id),
              row: { ...bomLineLedgerRow(line, ts), deleted_at: ts },
              actor: actorRow,
              ts,
            });
            bomLinesDropped += 1;
            report.conflicts.push(`BOM ${line.bomId}: survivor уже в спецификации — строка поглощаемой удалена`);
          } else {
            await tx
              .update(erpEngineAssemblyBomLines)
              .set({ componentNomenclatureId: survivorId, updatedAt: ts, syncStatus: 'synced' })
              .where(eq(erpEngineAssemblyBomLines.id, line.id));
            ledgerPayloads.push({
              type: 'upsert',
              table: LedgerTableName.ErpEngineAssemblyBomLines,
              row_id: String(line.id),
              row: { ...bomLineLedgerRow(line, ts), component_nomenclature_id: survivorId },
              actor: actorRow,
              ts,
            });
            repointed.bomLines += 1;
          }
        }

        // --- document lines: server-side, plain repoint ---
        const docLineRows = await tx
          .select({ id: erpDocumentLines.id })
          .from(erpDocumentLines)
          .where(eq(erpDocumentLines.nomenclatureId, loserId));
        for (const dl of docLineRows) {
          await tx.update(erpDocumentLines).set({ nomenclatureId: survivorId, updatedAt: ts }).where(eq(erpDocumentLines.id, dl.id));
          repointed.docLines += 1;
        }

        // --- acts: rewrite __part_id / __brand_part_id in operations meta ---
        const opsRows = await tx
          .select()
          .from(operations)
          .where(and(isNull(operations.deletedAt), like(operations.metaJson, `%${loserId}%`)));
        // Accumulate operation sync-changes; they are recorded ONCE after the tx
        // commits (recordSyncChanges runs its own ledger/PG pipeline and cannot join
        // this transaction). Batching also avoids the per-act ledger churn that
        // previously dominated merge time (and caused the client timeout/retry).
        for (const op of opsRows) {
          if (!op.metaJson) continue;
          const rewritten = rewriteMetaPartIds(op.metaJson, loserId, survivorId);
          if (!rewritten) continue;
          await tx.update(operations).set({ metaJson: rewritten, updatedAt: ts, syncStatus: 'synced' }).where(eq(operations.id, op.id));
          allOpSyncChanges.push({
            tableName: SyncTableName.Operations,
            rowId: String(op.id),
            op: 'upsert',
            payload: operationSyncPayload({ ...op, metaJson: rewritten }, ts),
          });
          repointed.operations += 1;
        }

        // --- soft-delete the loser nomenclature + tombstone the loser part ---
        // (skip if this loser was the heal donor — its nomenclature is already soft-deleted)
        if (loserNom && !adoptedDonorNomIds.has(loserId)) {
          await tx.update(erpNomenclature).set({ isActive: false, deletedAt: ts, updatedAt: ts }).where(eq(erpNomenclature.id, loserId));
          const deleted = (await tx.select().from(erpNomenclature).where(eq(erpNomenclature.id, loserId)).limit(1))[0];
          if (deleted) {
            ledgerPayloads.push({
              type: 'delete',
              table: LedgerTableName.ErpNomenclature,
              row_id: loserId,
              row: nomenclatureLedgerRow(deleted, ts),
              actor: actorRow,
              ts,
            });
          }
        }
        const loserMeta = parseMetadata(byId.get(loserId)!.metadataJson);
        (loserMeta as Record<string, unknown>).mergedInto = survivorId;
        (loserMeta as Record<string, unknown>).mergedAt = ts;
        await tx
          .update(directoryParts)
          .set({ isActive: false, metadataJson: serializeMetadata(loserMeta), deletedAt: ts, updatedAt: ts })
          .where(eq(directoryParts.id, loserId));

        if (ledgerPayloads.length > 0) allLedgerPayloads.push(...ledgerPayloads);

        report.merged.push({ loserId, repointed, bomLinesDropped, brandLinksAdded: brandLinksAddedByLoser.get(loserId) ?? 0 });
        logInfo('directory parts merge', {
          survivorId,
          loserId,
          actor: args.actor.username,
          ...repointed,
          bomLinesDropped,
        });
      }

      // --- survivor mirror sync: the merge may have filled the survivor's code, or the
      // mirror's code/name may be stale vs the directory part — bring the existing
      // erp_nomenclature mirror in step. Runs AFTER the loser loop so a code inherited
      // from a loser is already freed by that loser's soft-deleted mirror (partial
      // unique 0066).
      const survivorNom = nomById.get(survivorId);
      if (survivorNom) {
        const nextCode = survivorCode ?? String(survivorNom.code);
        const nextName = String(survivor.name ?? '').trim() || String(survivorNom.name);
        if (String(survivorNom.code) !== nextCode || String(survivorNom.name) !== nextName) {
          let nextSpecJson = survivorNom.specJson ?? null;
          if (survivorCode && nextSpecJson) {
            try {
              const spec = JSON.parse(nextSpecJson);
              if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
                nextSpecJson = JSON.stringify({ ...spec, article: survivorCode });
              }
            } catch {
              // keep the mirror's specJson as-is if it is not valid JSON
            }
          }
          await tx
            .update(erpNomenclature)
            .set({ code: nextCode, name: nextName, specJson: nextSpecJson, updatedAt: ts })
            .where(eq(erpNomenclature.id, survivorId));
          allLedgerPayloads.push({
            type: 'upsert',
            table: LedgerTableName.ErpNomenclature,
            row_id: survivorId,
            row: nomenclatureLedgerRow({ ...survivorNom, code: nextCode, name: nextName, specJson: nextSpecJson } as any, ts),
            actor: actorRow,
            ts,
          });
          report.fills.push(`складская карточка: зеркало синхронизировано (код «${nextCode}», имя «${nextName}»)`);
        }
      }
    });

    // Flush ledger + sync AFTER the PG transaction committed. If the tx threw,
    // execution never reaches here (outer catch returns ok:false) and nothing was
    // written to the immutable log — it never reflects a merge that didn't land.
    if (allLedgerPayloads.length > 0) signAndAppendDetailed(allLedgerPayloads);
    if (allOpSyncChanges.length > 0) {
      await recordSyncChanges(args.actor, allOpSyncChanges, { allowSyncConflicts: true });
    }

    return { ok: true, report };
  } catch (e) {
    logWarn('directory parts merge failed', { error: String(e) });
    return { ok: false, error: String(e) };
  }
}
