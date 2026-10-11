import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  erpEmployeeCards,
  erpNomenclature,
  ppeCardNorms,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLines,
  ppeNormSets,
} from '../database/schema.js';
import { createWarehouseDocument, postWarehouseDocument } from './warehouseService.js';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
type Actor = { id: string; username: string; role?: string };

export type PpeNormLineInput = {
  nomenclatureId: string;
  qty: number;
  wearMonths: number;
};

export type PpeNormSetUpsert = {
  id?: string;
  name: string;
  postTitle?: string | null;
  departmentId?: string | null;
  validFrom?: number;
  validTo?: number | null;
  lines: PpeNormLineInput[];
};

async function validateNomenclatureIds(ids: string[]): Promise<string | null> {
  const unique = [...new Set(ids.map((v) => String(v).trim()).filter(Boolean))];
  if (unique.length === 0) return null;
  const rows = await db
    .select({ id: erpNomenclature.id })
    .from(erpNomenclature)
    .where(and(inArray(erpNomenclature.id, unique as any), isNull(erpNomenclature.deletedAt)));
  const valid = new Set(rows.map((r) => String(r.id)));
  const bad = unique.find((id) => !valid.has(id));
  return bad ? `nomenclatureId: ссылка ${bad} не существует или удалена` : null;
}

export async function listPpeNormSets(args: { postTitle?: string } = {}): Promise<
  Result<{ rows: Array<{ id: string; name: string; postTitle: string | null; validFrom: number; validTo: number | null; linesCount: number }> }>
> {
  try {
    const conditions = [isNull(ppeNormSets.deletedAt)];
    if (args.postTitle) conditions.push(eq(ppeNormSets.postTitle, args.postTitle));
    const sets = await db
      .select({
        id: ppeNormSets.id,
        name: ppeNormSets.name,
        postTitle: ppeNormSets.postTitle,
        validFrom: ppeNormSets.validFrom,
        validTo: ppeNormSets.validTo,
      })
      .from(ppeNormSets)
      .where(and(...conditions));
    const lines = sets.length
      ? await db
          .select({ normSetId: ppeNormLines.normSetId })
          .from(ppeNormLines)
          .where(and(inArray(ppeNormLines.normSetId, sets.map((s) => s.id) as any), isNull(ppeNormLines.deletedAt)))
      : [];
    const countBySet = new Map<string, number>();
    for (const l of lines) countBySet.set(String(l.normSetId), (countBySet.get(String(l.normSetId)) ?? 0) + 1);
    return {
      ok: true,
      rows: sets.map((s) => ({
        id: String(s.id),
        name: String(s.name),
        postTitle: s.postTitle == null ? null : String(s.postTitle),
        validFrom: Number(s.validFrom),
        validTo: s.validTo == null ? null : Number(s.validTo),
        linesCount: countBySet.get(String(s.id)) ?? 0,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getPpeNormSet(id: string): Promise<
  Result<{ normSet: { id: string; name: string; postTitle: string | null; validFrom: number; validTo: number | null; lines: Array<{ id: string; nomenclatureId: string; qty: number; wearMonths: number }> } }>
> {
  try {
    const rows = await db.select().from(ppeNormSets).where(and(eq(ppeNormSets.id, id as any), isNull(ppeNormSets.deletedAt))).limit(1);
    const set = rows[0];
    if (!set) return { ok: false, error: 'Набор норм не найден' };
    const lines = await db
      .select()
      .from(ppeNormLines)
      .where(and(eq(ppeNormLines.normSetId, id as any), isNull(ppeNormLines.deletedAt)));
    return {
      ok: true,
      normSet: {
        id: String(set.id),
        name: String(set.name),
        postTitle: set.postTitle == null ? null : String(set.postTitle),
        validFrom: Number(set.validFrom),
        validTo: set.validTo == null ? null : Number(set.validTo),
        lines: lines.map((l) => ({
          id: String(l.id),
          nomenclatureId: String(l.nomenclatureId),
          qty: Number(l.qty),
          wearMonths: Number(l.wearMonths),
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertPpeNormSet(input: PpeNormSetUpsert): Promise<Result<{ id: string }>> {
  try {
    const id = String(input.id ?? randomUUID()).trim();
    const name = String(input.name ?? '').trim();
    if (!name) return { ok: false, error: 'name обязателен' };
    if (input.lines.length === 0) return { ok: false, error: 'Набор норм должен содержать хотя бы одну строку' };
    for (const [i, line] of input.lines.entries()) {
      if (!Number.isInteger(line.qty) || line.qty <= 0) return { ok: false, error: `lines[${i}].qty должен быть целым больше нуля` };
      if (!Number.isInteger(line.wearMonths) || line.wearMonths <= 0) {
        return { ok: false, error: `lines[${i}].wearMonths должен быть целым больше нуля` };
      }
    }
    const refError = await validateNomenclatureIds(input.lines.map((l) => l.nomenclatureId));
    if (refError) return { ok: false, error: refError };
    const now = Date.now();
    await db.transaction(async (tx) => {
      const existing = await tx.select({ id: ppeNormSets.id }).from(ppeNormSets).where(eq(ppeNormSets.id, id as any)).limit(1);
      const values = {
        name,
        postTitle: input.postTitle ?? null,
        departmentId: input.departmentId ?? null,
        validFrom: input.validFrom ?? now,
        validTo: input.validTo ?? null,
        updatedAt: now,
        deletedAt: null,
        syncStatus: 'pending',
      };
      if (existing.length > 0) {
        await tx.update(ppeNormSets).set(values).where(eq(ppeNormSets.id, id as any));
        await tx.update(ppeNormLines).set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' }).where(eq(ppeNormLines.normSetId, id as any));
      } else {
        await tx.insert(ppeNormSets).values({ id, ...values, createdAt: now });
      }
      await tx.insert(ppeNormLines).values(
        input.lines.map((l) => ({
          id: randomUUID(),
          normSetId: id,
          nomenclatureId: String(l.nomenclatureId),
          qty: l.qty,
          wearMonths: l.wearMonths,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncStatus: 'pending',
        })),
      );
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function openPpeCard(args: { employeeId: string }): Promise<Result<{ id: string }>> {
  try {
    const employeeId = String(args.employeeId ?? '').trim();
    if (!employeeId) return { ok: false, error: 'employeeId обязателен' };
    const emp = await db
      .select({ id: erpEmployeeCards.id })
      .from(erpEmployeeCards)
      .where(and(eq(erpEmployeeCards.id, employeeId as any), isNull(erpEmployeeCards.deletedAt)))
      .limit(1);
    if (!emp[0]) return { ok: false, error: 'Сотрудник не найден' };
    const now = Date.now();
    const id = randomUUID();
    try {
      await db.insert(ppeIssueCards).values({
        id,
        employeeId,
        openedAt: now,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        syncStatus: 'pending',
      });
    } catch {
      return { ok: false, error: 'У сотрудника уже есть открытая карточка выдачи СИЗ' };
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function assignCardNorms(args: { cardId: string; normSetIds: string[] }): Promise<Result<{ assigned: number }>> {
  try {
    const cardId = String(args.cardId ?? '').trim();
    const normSetIds = [...new Set((args.normSetIds ?? []).map((v) => String(v).trim()).filter(Boolean))];
    if (!cardId) return { ok: false, error: 'cardId обязателен' };
    const card = await db
      .select({ id: ppeIssueCards.id, closedAt: ppeIssueCards.closedAt })
      .from(ppeIssueCards)
      .where(and(eq(ppeIssueCards.id, cardId as any), isNull(ppeIssueCards.deletedAt)))
      .limit(1);
    if (!card[0]) return { ok: false, error: 'Карточка не найдена' };
    if (card[0].closedAt != null) return { ok: false, error: 'Карточка закрыта — нормы не назначаются' };
    if (normSetIds.length > 0) {
      const sets = await db
        .select({ id: ppeNormSets.id })
        .from(ppeNormSets)
        .where(and(inArray(ppeNormSets.id, normSetIds as any), isNull(ppeNormSets.deletedAt)));
      const valid = new Set(sets.map((s) => String(s.id)));
      const bad = normSetIds.find((v) => !valid.has(v));
      if (bad) return { ok: false, error: `Набор норм ${bad} не существует или удалён` };
    }
    const now = Date.now();
    const existing = await db
      .select({ normSetId: ppeCardNorms.normSetId })
      .from(ppeCardNorms)
      .where(and(eq(ppeCardNorms.cardId, cardId as any), isNull(ppeCardNorms.deletedAt)));
    const have = new Set(existing.map((r) => String(r.normSetId)));
    const fresh = normSetIds.filter((v) => !have.has(v));
    if (fresh.length > 0) {
      await db.insert(ppeCardNorms).values(
        fresh.map((normSetId) => ({
          id: randomUUID(),
          cardId,
          normSetId,
          assignedAt: now,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncStatus: 'pending',
        })),
      );
    }
    return { ok: true, assigned: fresh.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getPpeCard(args: { cardId?: string; employeeId?: string }): Promise<
  Result<{
    card: {
      id: string;
      employeeId: string;
      openedAt: number;
      closedAt: number | null;
      norms: Array<{ normSetId: string; name: string; assignedAt: number }>;
      entries: Array<{ id: string; nomenclatureId: string; qty: number; issuedAt: number; documentId: string }>;
    };
  }>
> {
  try {
    const byCard = String(args.cardId ?? '').trim();
    const byEmployee = String(args.employeeId ?? '').trim();
    if (!byCard && !byEmployee) return { ok: false, error: 'Нужен cardId или employeeId' };
    const cardRows = byCard
      ? await db.select().from(ppeIssueCards).where(and(eq(ppeIssueCards.id, byCard as any), isNull(ppeIssueCards.deletedAt))).limit(1)
      : await db
          .select()
          .from(ppeIssueCards)
          .where(and(eq(ppeIssueCards.employeeId, byEmployee as any), isNull(ppeIssueCards.closedAt), isNull(ppeIssueCards.deletedAt)))
          .limit(1);
    const card = cardRows[0];
    if (!card) return { ok: false, error: 'Карточка не найдена' };
    const links = await db
      .select({ normSetId: ppeCardNorms.normSetId, assignedAt: ppeCardNorms.assignedAt, name: ppeNormSets.name })
      .from(ppeCardNorms)
      .innerJoin(ppeNormSets, eq(ppeNormSets.id, ppeCardNorms.normSetId))
      .where(and(eq(ppeCardNorms.cardId, card.id as any), isNull(ppeCardNorms.deletedAt), isNull(ppeNormSets.deletedAt)));
    const entries = await db
      .select()
      .from(ppeIssueEntries)
      .where(and(eq(ppeIssueEntries.cardId, card.id as any), isNull(ppeIssueEntries.deletedAt)));
    return {
      ok: true,
      card: {
        id: String(card.id),
        employeeId: String(card.employeeId),
        openedAt: Number(card.openedAt),
        closedAt: card.closedAt == null ? null : Number(card.closedAt),
        norms: links.map((l) => ({ normSetId: String(l.normSetId), name: String(l.name), assignedAt: Number(l.assignedAt) })),
        entries: entries.map((v) => ({
          id: String(v.id),
          nomenclatureId: String(v.nomenclatureId),
          qty: Number(v.qty),
          issuedAt: Number(v.issuedAt),
          documentId: String(v.documentId),
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function closePpeCard(args: { cardId: string }): Promise<Result<{ id: string }>> {
  try {
    const cardId = String(args.cardId ?? '').trim();
    if (!cardId) return { ok: false, error: 'cardId обязателен' };
    const now = Date.now();
    const updated = await db
      .update(ppeIssueCards)
      .set({ closedAt: now, updatedAt: now, syncStatus: 'pending' })
      .where(and(eq(ppeIssueCards.id, cardId as any), isNull(ppeIssueCards.deletedAt), isNull(ppeIssueCards.closedAt)))
      .returning({ id: ppeIssueCards.id });
    if (updated.length === 0) return { ok: false, error: 'Карточка не найдена или уже закрыта' };
    return { ok: true, id: cardId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function makePpeDocNo(now: number): string {
  const d = new Date(now);
  const pad = (v: number) => String(v).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return `PPE-${stamp}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

export async function issuePpe(args: {
  cardId: string;
  warehouseId: string;
  lines: Array<{ nomenclatureId: string; qty: number }>;
  actor: Actor;
  docNo?: string;
}): Promise<Result<{ documentId: string; entries: number }>> {
  try {
    const cardId = String(args.cardId ?? '').trim();
    const warehouseId = String(args.warehouseId ?? '').trim();
    if (!cardId) return { ok: false, error: 'cardId обязателен' };
    if (!warehouseId) return { ok: false, error: 'warehouseId обязателен (склад выдачи)' };
    if (!args.lines || args.lines.length === 0) return { ok: false, error: 'Нужна хотя бы одна строка выдачи' };
    for (const [i, line] of args.lines.entries()) {
      if (!String(line.nomenclatureId ?? '').trim()) return { ok: false, error: `lines[${i}]: номенклатура обязательна` };
      if (!Number.isInteger(line.qty) || line.qty <= 0) return { ok: false, error: `lines[${i}].qty должен быть целым больше нуля` };
    }
    const card = await db
      .select({ id: ppeIssueCards.id, closedAt: ppeIssueCards.closedAt })
      .from(ppeIssueCards)
      .where(and(eq(ppeIssueCards.id, cardId as any), isNull(ppeIssueCards.deletedAt)))
      .limit(1);
    if (!card[0]) return { ok: false, error: 'Карточка не найдена' };
    if (card[0].closedAt != null) return { ok: false, error: 'Карточка закрыта — выдача невозможна' };
    const refError = await validateNomenclatureIds(args.lines.map((l) => l.nomenclatureId));
    if (refError) return { ok: false, error: refError };

    const now = Date.now();
    const docNo = String(args.docNo ?? '').trim() || makePpeDocNo(now);
    const created = await createWarehouseDocument({
      docType: 'stock_issue',
      docNo,
      docDate: now,
      header: { warehouseId },
      lines: args.lines.map((l) => ({ nomenclatureId: String(l.nomenclatureId), qty: l.qty, warehouseId })),
      actor: args.actor,
    });
    if (!created.ok) return { ok: false, error: created.error };
    const posted = await postWarehouseDocument({ documentId: created.id, actor: args.actor });
    if (!posted.ok) return { ok: false, error: `Документ ${docNo} создан черновиком, но не проведён: ${posted.error}` };
    try {
      await db.insert(ppeIssueEntries).values(
        args.lines.map((l) => ({
          id: randomUUID(),
          cardId,
          nomenclatureId: String(l.nomenclatureId),
          qty: l.qty,
          issuedAt: now,
          documentId: created.id,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncStatus: 'pending',
        })),
      );
    } catch (e) {
      // Склад уже списан проводкой выше; след выдачи дописывается отдельно, чтобы
      // ошибка учёта не откатывала деньги склада. Сверка — по documentId.
      return { ok: false, error: `Документ ${docNo} проведён, но след выдачи не записан (documentId ${created.id}): ${String(e)}` };
    }
    return { ok: true, documentId: created.id, entries: args.lines.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
