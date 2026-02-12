import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { LedgerTableName } from '@matricarmz/ledger';

import { db } from '../database/db.js';
import {
  erpDocumentHeaders,
  erpDocumentLines,
  erpContracts,
  erpCounterparties,
  erpEmployeeCards,
  erpJournalDocuments,
  erpPartCards,
  erpPartTemplates,
  erpRegContractSettlement,
  erpRegPartUsage,
  erpRegStockBalance,
  erpToolCards,
  erpToolTemplates,
} from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';

const MASTERDATA_MODULES = ['parts', 'tools', 'counterparties', 'contracts', 'employees'] as const;
type MasterdataModule = (typeof MASTERDATA_MODULES)[number];

function isModuleName(v: string): v is MasterdataModule {
  return MASTERDATA_MODULES.includes(v as MasterdataModule);
}

function nowMs() {
  return Date.now();
}

type DictionaryRow = {
  id: string;
  code: string;
  name: string;
  specJson?: string | null;
  attrsJson?: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
};

type CardRow = {
  id: string;
  templateId?: string | null;
  serialNo?: string | null;
  cardNo?: string | null;
  attrsJson?: string | null;
  status?: string | null;
  fullName?: string | null;
  roleCode?: string | null;
  personnelNo?: string | null;
  createdAt: number;
  updatedAt: number;
};

export async function listErpDictionary(moduleName: string): Promise<{ ok: true; rows: DictionaryRow[] } | { ok: false; error: string }> {
  try {
    if (!isModuleName(moduleName)) return { ok: false, error: `Unknown module: ${moduleName}` };
    if (moduleName === 'parts') {
      const rows = await db.select().from(erpPartTemplates).where(isNull(erpPartTemplates.deletedAt)).orderBy(asc(erpPartTemplates.name));
      return { ok: true, rows: rows as any };
    }
    if (moduleName === 'tools') {
      const rows = await db.select().from(erpToolTemplates).where(isNull(erpToolTemplates.deletedAt)).orderBy(asc(erpToolTemplates.name));
      return { ok: true, rows: rows as any };
    }
    if (moduleName === 'counterparties') {
      const rows = await db.select().from(erpCounterparties).where(isNull(erpCounterparties.deletedAt)).orderBy(asc(erpCounterparties.name));
      return { ok: true, rows: rows as any };
    }
    if (moduleName === 'contracts') {
      const rows = await db.select().from(erpContracts).where(isNull(erpContracts.deletedAt)).orderBy(asc(erpContracts.name));
      return { ok: true, rows: rows as any };
    }
    if (moduleName === 'employees') {
      const rows = await db.select().from(erpEmployeeCards).where(isNull(erpEmployeeCards.deletedAt)).orderBy(asc(erpEmployeeCards.fullName));
      return {
        ok: true,
        rows: (rows as any[]).map((r) => ({
          id: String(r.id),
          code: String(r.personnelNo ?? ''),
          name: String(r.fullName ?? ''),
          attrsJson: r.attrsJson ?? null,
          isActive: !!r.isActive,
          createdAt: Number(r.createdAt),
          updatedAt: Number(r.updatedAt),
        })),
      };
    }
    return { ok: true, rows: [] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertErpDictionary(moduleName: string, args: { id?: string; code: string; name: string; payloadJson?: string | null }) {
  try {
    if (!isModuleName(moduleName)) return { ok: false as const, error: `Unknown module: ${moduleName}` };
    const id = String(args.id || randomUUID());
    const ts = nowMs();

    if (moduleName === 'parts') {
      await db
        .insert(erpPartTemplates)
        .values({ id, code: args.code, name: args.name, specJson: args.payloadJson ?? null, isActive: true, createdAt: ts, updatedAt: ts, deletedAt: null })
        .onConflictDoUpdate({
          target: erpPartTemplates.id,
          set: { code: args.code, name: args.name, specJson: args.payloadJson ?? null, updatedAt: ts, deletedAt: null },
        });
      return { ok: true as const, id };
    }
    if (moduleName === 'tools') {
      await db
        .insert(erpToolTemplates)
        .values({ id, code: args.code, name: args.name, specJson: args.payloadJson ?? null, isActive: true, createdAt: ts, updatedAt: ts, deletedAt: null })
        .onConflictDoUpdate({
          target: erpToolTemplates.id,
          set: { code: args.code, name: args.name, specJson: args.payloadJson ?? null, updatedAt: ts, deletedAt: null },
        });
      return { ok: true as const, id };
    }
    if (moduleName === 'counterparties') {
      await db
        .insert(erpCounterparties)
        .values({ id, code: args.code, name: args.name, attrsJson: args.payloadJson ?? null, isActive: true, createdAt: ts, updatedAt: ts, deletedAt: null })
        .onConflictDoUpdate({
          target: erpCounterparties.id,
          set: { code: args.code, name: args.name, attrsJson: args.payloadJson ?? null, updatedAt: ts, deletedAt: null },
        });
      return { ok: true as const, id };
    }
    if (moduleName === 'contracts') {
      await db
        .insert(erpContracts)
        .values({
          id,
          code: args.code,
          name: args.name,
          counterpartyId: null,
          startsAt: null,
          endsAt: null,
          attrsJson: args.payloadJson ?? null,
          isActive: true,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: erpContracts.id,
          set: { code: args.code, name: args.name, attrsJson: args.payloadJson ?? null, updatedAt: ts, deletedAt: null },
        });
      return { ok: true as const, id };
    }
    if (moduleName === 'employees') {
      await db
        .insert(erpEmployeeCards)
        .values({
          id,
          personnelNo: args.code,
          fullName: args.name,
          roleCode: null,
          attrsJson: args.payloadJson ?? null,
          isActive: true,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: erpEmployeeCards.id,
          set: { personnelNo: args.code, fullName: args.name, attrsJson: args.payloadJson ?? null, updatedAt: ts, deletedAt: null },
        });
      return { ok: true as const, id };
    }
    return { ok: false as const, error: 'Unsupported module for dictionary' };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function listErpCards(moduleName: string): Promise<{ ok: true; rows: CardRow[] } | { ok: false; error: string }> {
  try {
    if (!isModuleName(moduleName)) return { ok: false, error: `Unknown module: ${moduleName}` };
    if (moduleName === 'parts') {
      const rows = await db.select().from(erpPartCards).where(isNull(erpPartCards.deletedAt)).orderBy(asc(erpPartCards.updatedAt));
      return { ok: true, rows: rows as any };
    }
    if (moduleName === 'tools') {
      const rows = await db.select().from(erpToolCards).where(isNull(erpToolCards.deletedAt)).orderBy(asc(erpToolCards.updatedAt));
      return { ok: true, rows: rows as any };
    }
    if (moduleName === 'employees') {
      const rows = await db.select().from(erpEmployeeCards).where(isNull(erpEmployeeCards.deletedAt)).orderBy(asc(erpEmployeeCards.fullName));
      return {
        ok: true,
        rows: (rows as any[]).map((r) => ({
          id: String(r.id),
          fullName: String(r.fullName),
          personnelNo: r.personnelNo ? String(r.personnelNo) : null,
          roleCode: r.roleCode ? String(r.roleCode) : null,
          attrsJson: r.attrsJson ?? null,
          createdAt: Number(r.createdAt),
          updatedAt: Number(r.updatedAt),
        })),
      };
    }
    return { ok: true, rows: [] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertErpCard(
  moduleName: string,
  args: {
    id?: string;
    templateId?: string | null;
    serialNo?: string | null;
    cardNo?: string | null;
    status?: string | null;
    payloadJson?: string | null;
    fullName?: string | null;
    personnelNo?: string | null;
    roleCode?: string | null;
  },
) {
  try {
    if (!isModuleName(moduleName)) return { ok: false as const, error: `Unknown module: ${moduleName}` };
    const id = String(args.id || randomUUID());
    const ts = nowMs();

    if (moduleName === 'parts') {
      if (!args.templateId) return { ok: false as const, error: 'templateId is required for parts card' };
      const exists = await db
        .select({ id: erpPartTemplates.id })
        .from(erpPartTemplates)
        .where(and(eq(erpPartTemplates.id, args.templateId), isNull(erpPartTemplates.deletedAt)))
        .limit(1);
      if (!exists[0]) return { ok: false as const, error: 'Part template not found' };

      await db
        .insert(erpPartCards)
        .values({
          id,
          templateId: args.templateId,
          serialNo: args.serialNo ?? null,
          cardNo: args.cardNo ?? null,
          attrsJson: args.payloadJson ?? null,
          status: args.status ?? 'active',
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: erpPartCards.id,
          set: {
            templateId: args.templateId,
            serialNo: args.serialNo ?? null,
            cardNo: args.cardNo ?? null,
            attrsJson: args.payloadJson ?? null,
            status: args.status ?? 'active',
            updatedAt: ts,
            deletedAt: null,
          },
        });
      return { ok: true as const, id };
    }

    if (moduleName === 'tools') {
      if (!args.templateId) return { ok: false as const, error: 'templateId is required for tools card' };
      const exists = await db
        .select({ id: erpToolTemplates.id })
        .from(erpToolTemplates)
        .where(and(eq(erpToolTemplates.id, args.templateId), isNull(erpToolTemplates.deletedAt)))
        .limit(1);
      if (!exists[0]) return { ok: false as const, error: 'Tool template not found' };

      await db
        .insert(erpToolCards)
        .values({
          id,
          templateId: args.templateId,
          serialNo: args.serialNo ?? null,
          cardNo: args.cardNo ?? null,
          attrsJson: args.payloadJson ?? null,
          status: args.status ?? 'active',
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: erpToolCards.id,
          set: {
            templateId: args.templateId,
            serialNo: args.serialNo ?? null,
            cardNo: args.cardNo ?? null,
            attrsJson: args.payloadJson ?? null,
            status: args.status ?? 'active',
            updatedAt: ts,
            deletedAt: null,
          },
        });
      return { ok: true as const, id };
    }

    if (moduleName === 'employees') {
      const fullName = String(args.fullName ?? '').trim();
      if (!fullName) return { ok: false as const, error: 'fullName is required for employee card' };
      await db
        .insert(erpEmployeeCards)
        .values({
          id,
          personnelNo: args.personnelNo ?? null,
          fullName,
          roleCode: args.roleCode ?? null,
          attrsJson: args.payloadJson ?? null,
          isActive: true,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: erpEmployeeCards.id,
          set: {
            personnelNo: args.personnelNo ?? null,
            fullName,
            roleCode: args.roleCode ?? null,
            attrsJson: args.payloadJson ?? null,
            updatedAt: ts,
            deletedAt: null,
          },
        });
      return { ok: true as const, id };
    }

    return { ok: false as const, error: 'Unsupported module for cards' };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function createErpDocument(args: {
  docType: string;
  docNo: string;
  docDate?: number;
  departmentId?: string | null;
  authorId?: string | null;
  payloadJson?: string | null;
  lines: Array<{ partCardId?: string | null; qty: number; price?: number | null; payloadJson?: string | null }>;
}) {
  try {
    const ts = nowMs();
    const docId = randomUUID();
    const docDate = Number(args.docDate ?? ts);
    await db.insert(erpDocumentHeaders).values({
      id: docId,
      docType: String(args.docType || 'parts_issue'),
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
    const lines = (args.lines ?? []).map((line, idx) => ({
      id: randomUUID(),
      headerId: docId,
      lineNo: idx + 1,
      partCardId: line.partCardId ?? null,
      qty: Math.trunc(Number(line.qty || 0)),
      price: line.price == null ? null : Math.trunc(Number(line.price)),
      payloadJson: line.payloadJson ?? null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    }));
    if (lines.length > 0) await db.insert(erpDocumentLines).values(lines);
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: docId,
      eventType: 'created',
      eventPayloadJson: JSON.stringify({ docType: args.docType, lines: lines.length }),
      eventAt: ts,
    });
    return { ok: true as const, id: docId };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function listErpDocuments(args?: { status?: string; docType?: string }) {
  try {
    const rows = await db.select().from(erpDocumentHeaders).where(isNull(erpDocumentHeaders.deletedAt)).orderBy(asc(erpDocumentHeaders.docDate));
    const filtered = rows.filter((r) => {
      if (args?.status && String(r.status) !== String(args.status)) return false;
      if (args?.docType && String(r.docType) !== String(args.docType)) return false;
      return true;
    });
    return { ok: true as const, rows: filtered };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function postErpDocument(args: { documentId: string; actor: { id: string; username: string; role?: string } }) {
  try {
    const ts = nowMs();
    const header = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    if (!header[0]) return { ok: false as const, error: 'Document not found' };
    if (String(header[0].status) === 'posted') return { ok: true as const, id: args.documentId, posted: true };

    const lines = await db
      .select()
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.documentId), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));

    const partIds = Array.from(new Set(lines.map((l) => String(l.partCardId ?? '')).filter(Boolean)));
    const existingStocks =
      partIds.length === 0
        ? []
        : await db
            .select()
            .from(erpRegStockBalance)
            .where(inArray(erpRegStockBalance.partCardId, partIds as any));
    const stockByPart = new Map<string, { id: string; qty: number; warehouseId: string }>();
    for (const row of existingStocks as any[]) stockByPart.set(String(row.partCardId), { id: String(row.id), qty: Number(row.qty), warehouseId: String(row.warehouseId) });

    const docType = String(header[0].docType);
    const deltaSign = docType === 'parts_receipt' ? 1 : docType === 'parts_issue' || docType === 'parts_writeoff' ? -1 : 0;
    const ledgerRows: Array<{ table: LedgerTableName; row: Record<string, unknown>; rowId: string }> = [];

    for (const line of lines as any[]) {
      const partCardId = String(line.partCardId ?? '');
      if (!partCardId) continue;
      const qty = Math.max(0, Math.trunc(Number(line.qty ?? 0)));
      const delta = qty * deltaSign;
      const cur = stockByPart.get(partCardId);
      const nextQty = (cur?.qty ?? 0) + delta;
      if (cur) {
        await db.update(erpRegStockBalance).set({ qty: nextQty, updatedAt: ts }).where(eq(erpRegStockBalance.id, cur.id));
        ledgerRows.push({
          table: LedgerTableName.ErpRegStockBalance,
          rowId: cur.id,
          row: { id: cur.id, part_card_id: partCardId, warehouse_id: cur.warehouseId, qty: nextQty, updated_at: ts },
        });
      } else {
        const stockId = randomUUID();
        await db.insert(erpRegStockBalance).values({ id: stockId, partCardId, warehouseId: 'default', qty: nextQty, updatedAt: ts });
        ledgerRows.push({
          table: LedgerTableName.ErpRegStockBalance,
          rowId: stockId,
          row: { id: stockId, part_card_id: partCardId, warehouse_id: 'default', qty: nextQty, updated_at: ts },
        });
      }

      if (docType === 'parts_issue' && qty > 0) {
        const usageId = randomUUID();
        const payload = (() => {
          try {
            return line.payloadJson ? JSON.parse(String(line.payloadJson)) : {};
          } catch {
            return {};
          }
        })() as any;
        await db.insert(erpRegPartUsage).values({
          id: usageId,
          partCardId,
          engineId: payload?.engineId ? String(payload.engineId) : null,
          documentLineId: String(line.id),
          qty,
          usedAt: ts,
        });
        ledgerRows.push({
          table: LedgerTableName.ErpRegPartUsage,
          rowId: usageId,
          row: { id: usageId, part_card_id: partCardId, engine_id: payload?.engineId ?? null, document_line_id: String(line.id), qty, used_at: ts },
        });
      }
    }

    const headerPayload = (() => {
      try {
        return header[0].payloadJson ? JSON.parse(String(header[0].payloadJson)) : {};
      } catch {
        return {};
      }
    })() as any;
    const contractId = headerPayload?.contractId ? String(headerPayload.contractId) : '';
    if (contractId) {
      const amount = (lines as any[]).reduce((sum, l) => sum + Math.max(0, Number(l.qty ?? 0)) * Math.max(0, Number(l.price ?? 0)), 0);
      const regId = randomUUID();
      await db.insert(erpRegContractSettlement).values({
        id: regId,
        contractId,
        documentHeaderId: args.documentId,
        amount: Math.trunc(amount),
        direction: docType === 'parts_receipt' ? 'debit' : 'credit',
        at: ts,
      });
      ledgerRows.push({
        table: LedgerTableName.ErpRegContractSettlement,
        rowId: regId,
        row: { id: regId, contract_id: contractId, document_header_id: args.documentId, amount: Math.trunc(amount), direction: docType === 'parts_receipt' ? 'debit' : 'credit', at: ts },
      });
    }

    await db
      .update(erpDocumentHeaders)
      .set({ status: 'posted', postedAt: ts, updatedAt: ts })
      .where(eq(erpDocumentHeaders.id, args.documentId));
    const journalId = randomUUID();
    await db.insert(erpJournalDocuments).values({
      id: journalId,
      documentHeaderId: args.documentId,
      eventType: 'posted',
      eventPayloadJson: JSON.stringify({ by: args.actor.username }),
      eventAt: ts,
    });

    const txPayloads = [
      {
        type: 'upsert' as const,
        table: LedgerTableName.ErpDocumentHeaders,
        row_id: args.documentId,
        row: { id: args.documentId, status: 'posted', posted_at: ts, updated_at: ts },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      },
      {
        type: 'upsert' as const,
        table: LedgerTableName.ErpJournalDocuments,
        row_id: journalId,
        row: { id: journalId, document_header_id: args.documentId, event_type: 'posted', event_payload_json: JSON.stringify({ by: args.actor.username }), event_at: ts },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      },
      ...ledgerRows.map((r) => ({
        type: 'upsert' as const,
        table: r.table,
        row_id: r.rowId,
        row: r.row,
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      })),
    ];
    signAndAppendDetailed(txPayloads);

    return { ok: true as const, id: args.documentId, posted: true };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}
