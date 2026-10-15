import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  entities,
  erpEmployeeCards,
  erpNomenclature,
  ppeAbsences,
  ppeCardNorms,
  ppeCollectiveLines,
  ppeCollectives,
  ppeGroupMembers,
  ppeGroupNorms,
  ppeGroups,
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
  gender?: 'M' | 'F' | null;
  season?: 'winter' | 'summer' | null;
  isDuty?: boolean;
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

export async function listPpeNormSets(args: { postTitle?: string; gender?: string; season?: string } = {}): Promise<
  Result<{ rows: Array<{ id: string; name: string; postTitle: string | null; departmentId: string | null; gender: string | null; season: string | null; isDuty: boolean; validFrom: number; validTo: number | null; linesCount: number }> }>
> {
  try {
    const conditions = [isNull(ppeNormSets.deletedAt)];
    if (args.postTitle) conditions.push(eq(ppeNormSets.postTitle, args.postTitle));
    if (args.gender) conditions.push(eq(ppeNormSets.gender, args.gender));
    if (args.season) conditions.push(eq(ppeNormSets.season, args.season));
    const sets = await db
      .select({
        id: ppeNormSets.id,
        name: ppeNormSets.name,
        postTitle: ppeNormSets.postTitle,
        departmentId: ppeNormSets.departmentId,
        gender: ppeNormSets.gender,
        season: ppeNormSets.season,
        isDuty: ppeNormSets.isDuty,
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
        departmentId: s.departmentId == null ? null : String(s.departmentId),
        gender: s.gender == null ? null : String(s.gender),
        season: s.season == null ? null : String(s.season),
        isDuty: s.isDuty === true,
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
  Result<{ normSet: { id: string; name: string; postTitle: string | null; departmentId: string | null; gender: string | null; season: string | null; isDuty: boolean; validFrom: number; validTo: number | null; lines: Array<{ id: string; nomenclatureId: string; qty: number; wearMonths: number }> } }>
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
        departmentId: set.departmentId == null ? null : String(set.departmentId),
        gender: set.gender == null ? null : String(set.gender),
        season: set.season == null ? null : String(set.season),
        isDuty: set.isDuty === true,
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
        gender: input.gender ?? null,
        season: input.season ?? null,
        isDuty: input.isDuty === true,
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
    // Сотрудник обязан существовать: строгое erp_employee_cards, иначе EAV-сущность
    // employee (тот же приём, что в signatureDefaultsService: строгая таблица
    // пишется только импортом СИЗ, а люди живут в EAV).
    const strict = await db
      .select({ id: erpEmployeeCards.id })
      .from(erpEmployeeCards)
      .where(and(eq(erpEmployeeCards.id, employeeId as any), isNull(erpEmployeeCards.deletedAt)))
      .limit(1);
    if (!strict[0]) {
      const eav = await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.id, employeeId as any), isNull(entities.deletedAt)))
        .limit(1);
      if (!eav[0]) return { ok: false, error: 'Сотрудник не найден' };
    }
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
      entries: Array<{ id: string; nomenclatureId: string; qty: number; issuedAt: number; documentId: string | null }>;
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
          // document_id nullable с фазы 2 (доввод истории без документа): String(null)
          // дал бы мусорную строку "null" — отдаём честный null.
          documentId: v.documentId == null ? null : String(v.documentId),
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

// ────────────────────────────────────────────────────────────
// Фаза 2: отпуска, группы, транзитивные нормы.
// ────────────────────────────────────────────────────────────

export async function createPpeAbsence(args: { employeeId: string; fromMs: number; toMs: number; kind?: string }): Promise<
  Result<{ id: string }>
> {
  try {
    const employeeId = String(args.employeeId ?? '').trim();
    if (!employeeId) return { ok: false, error: 'employeeId обязателен' };
    const fromMs = Number(args.fromMs);
    const toMs = Number(args.toMs);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { ok: false, error: 'fromMs/toMs обязаны быть числами (Unix-ms)' };
    if (fromMs >= toMs) return { ok: false, error: 'fromMs обязан быть раньше toMs' };
    const emp = await db
      .select({ id: erpEmployeeCards.id })
      .from(erpEmployeeCards)
      .where(and(eq(erpEmployeeCards.id, employeeId as any), isNull(erpEmployeeCards.deletedAt)))
      .limit(1);
    if (!emp[0]) return { ok: false, error: 'Сотрудник не найден в карточках СИЗ (сначала импорт)' };
    const now = Date.now();
    const id = randomUUID();
    await db.insert(ppeAbsences).values({
      id,
      employeeId,
      fromMs,
      toMs,
      kind: String(args.kind ?? 'vacation').trim() || 'vacation',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncStatus: 'pending',
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listPpeAbsences(args: { employeeId?: string } = {}): Promise<
  Result<{ rows: Array<{ id: string; employeeId: string; fromMs: number; toMs: number; kind: string }> }>
> {
  try {
    const conditions = [isNull(ppeAbsences.deletedAt)];
    if (args.employeeId) conditions.push(eq(ppeAbsences.employeeId, args.employeeId));
    const rows = await db.select().from(ppeAbsences).where(and(...conditions));
    return {
      ok: true,
      rows: rows.map((r) => ({
        id: String(r.id),
        employeeId: String(r.employeeId),
        fromMs: Number(r.fromMs),
        toMs: Number(r.toMs),
        kind: String(r.kind),
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deletePpeAbsence(id: string): Promise<Result<{ id: string }>> {
  try {
    const key = String(id ?? '').trim();
    if (!key) return { ok: false, error: 'id обязателен' };
    const now = Date.now();
    const updated = await db
      .update(ppeAbsences)
      .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
      .where(and(eq(ppeAbsences.id, key as any), isNull(ppeAbsences.deletedAt)))
      .returning({ id: ppeAbsences.id });
    if (updated.length === 0) return { ok: false, error: 'Отсутствие не найдено' };
    return { ok: true, id: key };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createPpeGroup(args: { name: string }): Promise<Result<{ id: string }>> {
  try {
    const name = String(args.name ?? '').trim();
    if (!name) return { ok: false, error: 'name обязателен' };
    const now = Date.now();
    const id = randomUUID();
    await db.insert(ppeGroups).values({ id, name, createdAt: now, updatedAt: now, deletedAt: null, syncStatus: 'pending' });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listPpeGroups(): Promise<Result<{ rows: Array<{ id: string; name: string; membersCount: number; normsCount: number }> }>> {
  try {
    const groups = await db.select().from(ppeGroups).where(isNull(ppeGroups.deletedAt));
    const ids = groups.map((g) => String(g.id));
    const members = ids.length
      ? await db
        .select({ groupId: ppeGroupMembers.groupId })
        .from(ppeGroupMembers)
        .where(and(inArray(ppeGroupMembers.groupId, ids as any), isNull(ppeGroupMembers.deletedAt)))
      : [];
    const norms = ids.length
      ? await db
        .select({ groupId: ppeGroupNorms.groupId })
        .from(ppeGroupNorms)
        .where(and(inArray(ppeGroupNorms.groupId, ids as any), isNull(ppeGroupNorms.deletedAt)))
      : [];
    const countBy = (rows: Array<{ groupId: unknown }>) => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(String(r.groupId), (m.get(String(r.groupId)) ?? 0) + 1);
      return m;
    };
    const membersBy = countBy(members);
    const normsBy = countBy(norms);
    return {
      ok: true,
      rows: groups.map((g) => ({
        id: String(g.id),
        name: String(g.name),
        membersCount: membersBy.get(String(g.id)) ?? 0,
        normsCount: normsBy.get(String(g.id)) ?? 0,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deletePpeGroup(id: string): Promise<Result<{ id: string }>> {
  try {
    const key = String(id ?? '').trim();
    if (!key) return { ok: false, error: 'id обязателен' };
    const now = Date.now();
    const updated = await db
      .update(ppeGroups)
      .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
      .where(and(eq(ppeGroups.id, key as any), isNull(ppeGroups.deletedAt)))
      .returning({ id: ppeGroups.id });
    if (updated.length === 0) return { ok: false, error: 'Группа не найдена' };
    return { ok: true, id: key };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function employeeExistsStrict(employeeId: string): Promise<boolean> {
  const rows = await db
    .select({ id: erpEmployeeCards.id })
    .from(erpEmployeeCards)
    .where(and(eq(erpEmployeeCards.id, employeeId as any), isNull(erpEmployeeCards.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

export async function setPpeGroupMembers(args: { groupId: string; employeeIds: string[] }): Promise<Result<{ members: number }>> {
  try {
    const groupId = String(args.groupId ?? '').trim();
    if (!groupId) return { ok: false, error: 'groupId обязателен' };
    const group = await db
      .select({ id: ppeGroups.id })
      .from(ppeGroups)
      .where(and(eq(ppeGroups.id, groupId as any), isNull(ppeGroups.deletedAt)))
      .limit(1);
    if (!group[0]) return { ok: false, error: 'Группа не найдена' };
    const employeeIds = [...new Set((args.employeeIds ?? []).map((v) => String(v).trim()).filter(Boolean))];
    for (const employeeId of employeeIds) {
      if (!(await employeeExistsStrict(employeeId))) return { ok: false, error: `Сотрудник ${employeeId} не найден в карточках СИЗ (сначала импорт)` };
    }
    const now = Date.now();
    await db
      .update(ppeGroupMembers)
      .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
      .where(and(eq(ppeGroupMembers.groupId, groupId as any), isNull(ppeGroupMembers.deletedAt)));
    if (employeeIds.length > 0) {
      await db.insert(ppeGroupMembers).values(
        employeeIds.map((employeeId) => ({
          id: randomUUID(),
          groupId,
          employeeId,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncStatus: 'pending',
        })),
      );
    }
    return { ok: true, members: employeeIds.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getPpeGroupMembers(groupId: string): Promise<Result<{ employeeIds: string[] }>> {
  try {
    const key = String(groupId ?? '').trim();
    if (!key) return { ok: false, error: 'groupId обязателен' };
    const rows = await db
      .select({ employeeId: ppeGroupMembers.employeeId })
      .from(ppeGroupMembers)
      .where(and(eq(ppeGroupMembers.groupId, key as any), isNull(ppeGroupMembers.deletedAt)));
    return { ok: true, employeeIds: rows.map((r) => String(r.employeeId)) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function setPpeGroupNorms(args: { groupId: string; normSetIds: string[] }): Promise<Result<{ norms: number }>> {
  try {
    const groupId = String(args.groupId ?? '').trim();
    if (!groupId) return { ok: false, error: 'groupId обязателен' };
    const group = await db
      .select({ id: ppeGroups.id })
      .from(ppeGroups)
      .where(and(eq(ppeGroups.id, groupId as any), isNull(ppeGroups.deletedAt)))
      .limit(1);
    if (!group[0]) return { ok: false, error: 'Группа не найдена' };
    const normSetIds = [...new Set((args.normSetIds ?? []).map((v) => String(v).trim()).filter(Boolean))];
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
    await db
      .update(ppeGroupNorms)
      .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
      .where(and(eq(ppeGroupNorms.groupId, groupId as any), isNull(ppeGroupNorms.deletedAt)));
    if (normSetIds.length > 0) {
      await db.insert(ppeGroupNorms).values(
        normSetIds.map((normSetId) => ({
          id: randomUUID(),
          groupId,
          normSetId,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncStatus: 'pending',
        })),
      );
    }
    return { ok: true, norms: normSetIds.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getPpeGroupNorms(groupId: string): Promise<Result<{ normSetIds: string[] }>> {
  try {
    const key = String(groupId ?? '').trim();
    if (!key) return { ok: false, error: 'groupId обязателен' };
    const rows = await db
      .select({ normSetId: ppeGroupNorms.normSetId })
      .from(ppeGroupNorms)
      .where(and(eq(ppeGroupNorms.groupId, key as any), isNull(ppeGroupNorms.deletedAt)));
    return { ok: true, normSetIds: rows.map((r) => String(r.normSetId)) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Нормы сотрудника транзитивно: личные привязки открытой карточки +
 * привязки групп, в которых он состоит. Связь группа→норма хранится отдельно
 * (ppe_group_norms), поэтому отзыв нормы у группы отзывает её у людей.
 * Чистое чтение для PR-4 (карточка показывает групповые с пометкой источника).
 */
export async function resolveEmployeeNormSetIds(employeeId: string): Promise<Result<{ personal: string[]; group: string[] }>> {
  try {
    const key = String(employeeId ?? '').trim();
    if (!key) return { ok: false, error: 'employeeId обязателен' };
    const cards = await db
      .select({ id: ppeIssueCards.id })
      .from(ppeIssueCards)
      .where(and(eq(ppeIssueCards.employeeId, key as any), isNull(ppeIssueCards.closedAt), isNull(ppeIssueCards.deletedAt)))
      .limit(1);
    const personal = cards[0]
      ? (
        await db
          .select({ normSetId: ppeCardNorms.normSetId })
          .from(ppeCardNorms)
          .where(and(eq(ppeCardNorms.cardId, String(cards[0].id) as any), isNull(ppeCardNorms.deletedAt)))
      ).map((r) => String(r.normSetId))
      : [];
    const memberships = await db
      .select({ groupId: ppeGroupMembers.groupId })
      .from(ppeGroupMembers)
      .where(and(eq(ppeGroupMembers.employeeId, key as any), isNull(ppeGroupMembers.deletedAt)));
    const groupIds = [...new Set(memberships.map((r) => String(r.groupId)))];
    const group =
      groupIds.length > 0
        ? (
          await db
            .select({ normSetId: ppeGroupNorms.normSetId })
            .from(ppeGroupNorms)
            .where(and(inArray(ppeGroupNorms.groupId, groupIds as any), isNull(ppeGroupNorms.deletedAt)))
        ).map((r) => String(r.normSetId))
        : [];
    return { ok: true, personal: [...new Set(personal)], group: [...new Set(group)] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ────────────────────────────────────────────────────────────
// Фаза 2, PR-3: коллективная выдача и дежурные.
// Коллективная — двухшаговая: черновик плана (шапка + строки сотрудник × позиция),
// затем проведение: один stock_issue на подразделение (строки — агрегат по позициям)
// + персональные следы (ppe_issue_entries) на тот же документ.
// ────────────────────────────────────────────────────────────

export type PpeCollectiveLineInput = {
  employeeId: string;
  nomenclatureId: string;
  qty: number;
};

export async function openCollective(args: {
  id?: string;
  departmentId: string;
  warehouseId: string;
  lines?: PpeCollectiveLineInput[];
}): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id ?? randomUUID()).trim();
    const departmentId = String(args.departmentId ?? '').trim();
    const warehouseId = String(args.warehouseId ?? '').trim();
    if (!departmentId) return { ok: false, error: 'departmentId обязателен (подразделение-МОЛ)' };
    if (!warehouseId) return { ok: false, error: 'warehouseId обязателен (склад выдачи)' };
    const lines = args.lines ?? [];
    for (const [i, line] of lines.entries()) {
      if (!String(line.employeeId ?? '').trim()) return { ok: false, error: `lines[${i}].employeeId обязателен` };
      if (!String(line.nomenclatureId ?? '').trim()) return { ok: false, error: `lines[${i}].nomenclatureId обязателен` };
      if (!Number.isInteger(line.qty) || line.qty <= 0) return { ok: false, error: `lines[${i}].qty должен быть целым больше нуля` };
    }
    const refError = await validateNomenclatureIds(lines.map((l) => l.nomenclatureId));
    if (refError) return { ok: false, error: refError };
    for (const employeeId of [...new Set(lines.map((l) => String(l.employeeId).trim()))]) {
      if (!(await employeeExistsStrict(employeeId))) {
        return { ok: false, error: `Сотрудник ${employeeId} не найден в карточках СИЗ (сначала импорт)` };
      }
    }
    const existing = await db
      .select({ id: ppeCollectives.id, documentId: ppeCollectives.documentId })
      .from(ppeCollectives)
      .where(and(eq(ppeCollectives.id, id as any), isNull(ppeCollectives.deletedAt)))
      .limit(1);
    if (existing[0]?.documentId != null) {
      return { ok: false, error: 'Коллективная выдача уже проведена — правка невозможна' };
    }
    const now = Date.now();
    await db.transaction(async (tx) => {
      if (existing.length > 0) {
        await tx
          .update(ppeCollectives)
          .set({ departmentId, warehouseId, updatedAt: now, syncStatus: 'pending' })
          .where(eq(ppeCollectives.id, id as any));
        await tx
          .update(ppeCollectiveLines)
          .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
          .where(eq(ppeCollectiveLines.collectiveId, id as any));
      } else {
        await tx.insert(ppeCollectives).values({
          id,
          departmentId,
          warehouseId,
          documentId: null,
          distributedAt: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncStatus: 'pending',
        });
      }
      if (lines.length > 0) {
        await tx.insert(ppeCollectiveLines).values(
          lines.map((l) => ({
            id: randomUUID(),
            collectiveId: id,
            employeeId: String(l.employeeId).trim(),
            nomenclatureId: String(l.nomenclatureId).trim(),
            qty: l.qty,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            syncStatus: 'pending',
          })),
        );
      }
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getPpeCollective(id: string): Promise<
  Result<{
    collective: {
      id: string;
      departmentId: string;
      warehouseId: string;
      documentId: string | null;
      distributedAt: number | null;
      lines: Array<{ id: string; employeeId: string; nomenclatureId: string; qty: number }>;
    };
  }>
> {
  try {
    const key = String(id ?? '').trim();
    if (!key) return { ok: false, error: 'id обязателен' };
    const rows = await db
      .select()
      .from(ppeCollectives)
      .where(and(eq(ppeCollectives.id, key as any), isNull(ppeCollectives.deletedAt)))
      .limit(1);
    const collective = rows[0];
    if (!collective) return { ok: false, error: 'Коллективная выдача не найдена' };
    const lines = await db
      .select()
      .from(ppeCollectiveLines)
      .where(and(eq(ppeCollectiveLines.collectiveId, key as any), isNull(ppeCollectiveLines.deletedAt)));
    return {
      ok: true,
      collective: {
        id: String(collective.id),
        departmentId: String(collective.departmentId),
        warehouseId: String(collective.warehouseId),
        documentId: collective.documentId == null ? null : String(collective.documentId),
        distributedAt: collective.distributedAt == null ? null : Number(collective.distributedAt),
        lines: lines.map((l) => ({
          id: String(l.id),
          employeeId: String(l.employeeId),
          nomenclatureId: String(l.nomenclatureId),
          qty: Number(l.qty),
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listPpeCollectives(args: { departmentId?: string } = {}): Promise<
  Result<{
    rows: Array<{
      id: string;
      departmentId: string;
      warehouseId: string;
      documentId: string | null;
      distributedAt: number | null;
      linesCount: number;
      employeesCount: number;
    }>;
  }>
> {
  try {
    const conditions = [isNull(ppeCollectives.deletedAt)];
    if (args.departmentId) conditions.push(eq(ppeCollectives.departmentId, args.departmentId));
    const rows = await db.select().from(ppeCollectives).where(and(...conditions));
    const ids = rows.map((r) => String(r.id));
    const lines = ids.length
      ? await db
          .select({ collectiveId: ppeCollectiveLines.collectiveId, employeeId: ppeCollectiveLines.employeeId })
          .from(ppeCollectiveLines)
          .where(and(inArray(ppeCollectiveLines.collectiveId, ids as any), isNull(ppeCollectiveLines.deletedAt)))
      : [];
    const linesBy = new Map<string, number>();
    const employeesBy = new Map<string, Set<string>>();
    for (const l of lines) {
      const key = String(l.collectiveId);
      linesBy.set(key, (linesBy.get(key) ?? 0) + 1);
      const set = employeesBy.get(key) ?? new Set<string>();
      set.add(String(l.employeeId));
      employeesBy.set(key, set);
    }
    return {
      ok: true,
      rows: rows.map((r) => ({
        id: String(r.id),
        departmentId: String(r.departmentId),
        warehouseId: String(r.warehouseId),
        documentId: r.documentId == null ? null : String(r.documentId),
        distributedAt: r.distributedAt == null ? null : Number(r.distributedAt),
        linesCount: linesBy.get(String(r.id)) ?? 0,
        employeesCount: employeesBy.get(String(r.id))?.size ?? 0,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Проведение коллективной выдачи. Идемпотентно по collective_id: повторный вызов
 * (двойной клик, ретрай) второй документ не создаёт. Проведение фиксируется на
 * коллективе ДО записи следов — чтобы сбой в персональных entries не приводил к
 * повторному списанию склада; расхождение сверяется по documentId (приём issuePpe).
 */
export async function distributeCollective(args: {
  collectiveId: string;
  docNo?: string;
  actor: Actor;
}): Promise<Result<{ documentId: string; entries: number; employees: number; alreadyDistributed: boolean }>> {
  try {
    const collectiveId = String(args.collectiveId ?? '').trim();
    if (!collectiveId) return { ok: false, error: 'collectiveId обязателен' };
    const rows = await db
      .select()
      .from(ppeCollectives)
      .where(and(eq(ppeCollectives.id, collectiveId as any), isNull(ppeCollectives.deletedAt)))
      .limit(1);
    const collective = rows[0];
    if (!collective) return { ok: false, error: 'Коллективная выдача не найдена' };
    const lines = await db
      .select()
      .from(ppeCollectiveLines)
      .where(and(eq(ppeCollectiveLines.collectiveId, collectiveId as any), isNull(ppeCollectiveLines.deletedAt)));
    const employeeIds = [...new Set(lines.map((l) => String(l.employeeId)))];
    if (collective.documentId != null) {
      return {
        ok: true,
        documentId: String(collective.documentId),
        entries: lines.length,
        employees: employeeIds.length,
        alreadyDistributed: true,
      };
    }
    if (lines.length === 0) return { ok: false, error: 'Нет строк распределения — сначала заполните состав выдачи' };
    const refError = await validateNomenclatureIds(lines.map((l) => String(l.nomenclatureId)));
    if (refError) return { ok: false, error: refError };

    const warehouseId = String(collective.warehouseId);
    const aggregated = new Map<string, number>();
    for (const l of lines) {
      const nomenclatureId = String(l.nomenclatureId);
      aggregated.set(nomenclatureId, (aggregated.get(nomenclatureId) ?? 0) + Number(l.qty));
    }
    const now = Date.now();
    const docNo = String(args.docNo ?? '').trim() || makePpeDocNo(now);
    const created = await createWarehouseDocument({
      docType: 'stock_issue',
      docNo,
      docDate: now,
      departmentId: String(collective.departmentId),
      header: { warehouseId },
      lines: [...aggregated].map(([nomenclatureId, qty]) => ({ nomenclatureId, qty, warehouseId })),
      actor: args.actor,
    });
    if (!created.ok) return { ok: false, error: created.error };
    const posted = await postWarehouseDocument({ documentId: created.id, actor: args.actor });
    if (!posted.ok) return { ok: false, error: `Документ ${docNo} создан черновиком, но не проведён: ${posted.error}` };
    await db
      .update(ppeCollectives)
      .set({ documentId: created.id, distributedAt: now, updatedAt: now, syncStatus: 'pending' })
      .where(eq(ppeCollectives.id, collectiveId as any));
    try {
      const cardByEmployee = new Map<string, string>();
      const cards = await db
        .select({ id: ppeIssueCards.id, employeeId: ppeIssueCards.employeeId })
        .from(ppeIssueCards)
        .where(and(inArray(ppeIssueCards.employeeId, employeeIds as any), isNull(ppeIssueCards.closedAt), isNull(ppeIssueCards.deletedAt)));
      for (const c of cards) cardByEmployee.set(String(c.employeeId), String(c.id));
      for (const employeeId of employeeIds) {
        if (cardByEmployee.has(employeeId)) continue;
        const cardId = randomUUID();
        try {
          await db.insert(ppeIssueCards).values({
            id: cardId,
            employeeId,
            openedAt: now,
            closedAt: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            syncStatus: 'pending',
          });
          cardByEmployee.set(employeeId, cardId);
        } catch {
          // Гонка: карточку успел открыть другой запрос — берём открытую.
          const again = await db
            .select({ id: ppeIssueCards.id })
            .from(ppeIssueCards)
            .where(and(eq(ppeIssueCards.employeeId, employeeId as any), isNull(ppeIssueCards.closedAt), isNull(ppeIssueCards.deletedAt)))
            .limit(1);
          if (again[0]) cardByEmployee.set(employeeId, String(again[0].id));
        }
      }
      const noCard = employeeIds.filter((e) => !cardByEmployee.has(e));
      if (noCard.length > 0) throw new Error(`карточка выдачи не открыта: ${noCard.join(', ')}`);
      await db.insert(ppeIssueEntries).values(
        lines.map((l) => ({
          id: randomUUID(),
          cardId: cardByEmployee.get(String(l.employeeId))!,
          nomenclatureId: String(l.nomenclatureId),
          qty: Number(l.qty),
          issuedAt: now,
          documentId: created.id,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncStatus: 'pending',
        })),
      );
    } catch (e) {
      // Склад уже списан проводкой выше; персональные следы дописываются отдельно
      // (тот же приём, что в issuePpe): ошибка учёта не откатывает деньги склада.
      return {
        ok: false,
        error: `Документ ${docNo} проведён, но персональные следы записаны не полностью (documentId ${created.id}): ${String(e)}`,
      };
    }
    return { ok: true, documentId: created.id, entries: lines.length, employees: employeeIds.length, alreadyDistributed: false };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function closeCollective(id: string): Promise<Result<{ id: string }>> {
  try {
    const key = String(id ?? '').trim();
    if (!key) return { ok: false, error: 'id обязателен' };
    const rows = await db
      .select({ id: ppeCollectives.id, documentId: ppeCollectives.documentId })
      .from(ppeCollectives)
      .where(and(eq(ppeCollectives.id, key as any), isNull(ppeCollectives.deletedAt)))
      .limit(1);
    const collective = rows[0];
    if (!collective) return { ok: false, error: 'Коллективная выдача не найдена' };
    if (collective.documentId != null) {
      return { ok: false, error: 'Выдача уже проведена — отмена невозможна, сторнируйте документ склада' };
    }
    const now = Date.now();
    await db
      .update(ppeCollectives)
      .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
      .where(eq(ppeCollectives.id, key as any));
    await db
      .update(ppeCollectiveLines)
      .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' })
      .where(and(eq(ppeCollectiveLines.collectiveId, key as any), isNull(ppeCollectiveLines.deletedAt)));
    return { ok: true, id: key };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Дежурные СИЗ: выдача документом расхода на подразделение набора, без персональных
 * следов (флаг is_duty + department_id в наборе — решение §1.7 плана фазы 2).
 * Возврат — сторно документа склада (существующая операция `reverseWarehouseDocument`),
 * отдельного кода не требует.
 */
export async function issueDutyPpe(args: {
  normSetId: string;
  warehouseId: string;
  docNo?: string;
  actor: Actor;
}): Promise<Result<{ documentId: string }>> {
  try {
    const normSetId = String(args.normSetId ?? '').trim();
    const warehouseId = String(args.warehouseId ?? '').trim();
    if (!normSetId) return { ok: false, error: 'normSetId обязателен' };
    if (!warehouseId) return { ok: false, error: 'warehouseId обязателен (склад выдачи)' };
    const sets = await db
      .select()
      .from(ppeNormSets)
      .where(and(eq(ppeNormSets.id, normSetId as any), isNull(ppeNormSets.deletedAt)))
      .limit(1);
    const set = sets[0];
    if (!set) return { ok: false, error: 'Набор норм не найден' };
    if (set.isDuty !== true) return { ok: false, error: 'Набор не помечен как дежурный' };
    if (set.departmentId == null) return { ok: false, error: 'У дежурного набора не задано подразделение' };
    const lines = await db
      .select()
      .from(ppeNormLines)
      .where(and(eq(ppeNormLines.normSetId, normSetId as any), isNull(ppeNormLines.deletedAt)));
    if (lines.length === 0) return { ok: false, error: 'У дежурного набора нет строк' };
    const now = Date.now();
    const docNo = String(args.docNo ?? '').trim() || makePpeDocNo(now);
    const created = await createWarehouseDocument({
      docType: 'stock_issue',
      docNo,
      docDate: now,
      departmentId: String(set.departmentId),
      header: { warehouseId },
      lines: lines.map((l) => ({ nomenclatureId: String(l.nomenclatureId), qty: Number(l.qty), warehouseId })),
      actor: args.actor,
    });
    if (!created.ok) return { ok: false, error: created.error };
    const posted = await postWarehouseDocument({ documentId: created.id, actor: args.actor });
    if (!posted.ok) return { ok: false, error: `Документ ${docNo} создан черновиком, но не проведён: ${posted.error}` };
    return { ok: true, documentId: created.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
