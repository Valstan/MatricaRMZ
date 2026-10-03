import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  CONTRACT_PAYMENTS_ATTR_CODE,
  parseContractPayments,
  type ContractPayments,
} from '@matricarmz/shared';

import {
  attributeDefs,
  attributeValues,
  entityTypes,
  erpContractPayments,
  erpContractPaymentSlots,
} from '../database/schema.js';

/**
 * Платежи договоров из строгой реплики (план contract-payments-strict-2026-10).
 *
 * Чтение — из `erp_contract_payment_slots` + `erp_contract_payments`, запись — туда же
 * со `sync_status='pending'` (штатный push отвозит таблицей). Правило свежести на
 * переходный период: EAV-атрибут зеркалится в strict триггером на сервере, но pull
 * строгих строк догоняет EAV-значение с задержкой публикатора (~60 с). Поэтому если
 * локальный EAV-атрибут новее строгих строк (старый клиент только что писал), читаем
 * EAV — иначе платёж коллеги был бы невидим минуту. Пишем всегда только в strict.
 */

type SlotRow = typeof erpContractPaymentSlots.$inferSelect;
type PayRow = typeof erpContractPayments.$inferSelect;

async function readEavFreshness(
  db: BetterSQLite3Database,
  contractId: string,
): Promise<{ raw: unknown; updatedAt: number } | null> {
  const rows = (await db
    .select({ valueJson: attributeValues.valueJson, updatedAt: attributeValues.updatedAt })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeValues.attributeDefId, attributeDefs.id))
    .innerJoin(entityTypes, eq(attributeDefs.entityTypeId, entityTypes.id))
    .where(
      and(
        eq(attributeValues.entityId, contractId),
        eq(attributeDefs.code, CONTRACT_PAYMENTS_ATTR_CODE),
        eq(entityTypes.code, 'contract'),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1)) as Array<{ valueJson: unknown; updatedAt: unknown }>;
  const row = rows[0];
  if (!row) return null;
  let raw: unknown = row.valueJson;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return { raw, updatedAt: Number(row.updatedAt ?? 0) };
}

function toContractPayments(slots: SlotRow[], pays: PayRow[]): { payments: ContractPayments; maxUpdatedAt: number } {
  const bySlot = new Map<string, PayRow[]>();
  for (const p of pays) {
    const arr = bySlot.get(String(p.slotId)) ?? [];
    arr.push(p);
    bySlot.set(String(p.slotId), arr);
  }
  let maxUpdatedAt = 0;
  const out: ContractPayments = {
    version: 1,
    slots: slots.map((s) => {
      maxUpdatedAt = Math.max(maxUpdatedAt, Number(s.updatedAt ?? 0));
      const rows = (bySlot.get(String(s.id)) ?? []).map((p) => {
        maxUpdatedAt = Math.max(maxUpdatedAt, Number(p.updatedAt ?? 0));
        return {
          id: String(p.id),
          date: String(p.date ?? ''),
          amountKop: Number(p.amountKop ?? 0),
          kind: p.kind as 'contract_price' | 'advance' | 'extra_advance' | 'final',
          ...(p.note ? { note: String(p.note) } : {}),
          ...(p.countdownStart ? { countdownStart: true as const } : {}),
        };
      });
      return {
        id: String(s.id),
        sectionKey: String(s.sectionKey),
        ...(s.engineBrandId ? { engineBrandId: String(s.engineBrandId) } : {}),
        ...(s.engineId ? { engineId: String(s.engineId) } : {}),
        ...(s.contractPriceKop != null ? { contractPriceKop: Number(s.contractPriceKop) } : {}),
        payments: rows,
      };
    }),
  };
  return { payments: parseContractPayments(out), maxUpdatedAt };
}

export async function readContractPaymentsStrict(
  db: BetterSQLite3Database,
  contractId: string,
): Promise<ContractPayments> {
  const id = String(contractId ?? '').trim();
  if (!id) return parseContractPayments(null);
  const slots = (await db
    .select()
    .from(erpContractPaymentSlots)
    .where(and(eq(erpContractPaymentSlots.contractId, id), isNull(erpContractPaymentSlots.deletedAt)))) as SlotRow[];
  const pays = slots.length > 0
    ? ((await db
      .select()
      .from(erpContractPayments)
      .where(isNull(erpContractPayments.deletedAt))) as PayRow[]).filter((p) =>
      slots.some((s) => String(s.id) === String(p.slotId)),
    )
    : [];
  const strict = toContractPayments(slots, pays);
  const eav = await readEavFreshness(db, id).catch(() => null);
  if (eav && eav.updatedAt > strict.maxUpdatedAt) return parseContractPayments(eav.raw);
  return strict.payments;
}

function sameSlot(a: SlotRow, b: { sectionKey: string; engineBrandId?: string; engineId?: string; contractPriceKop?: number }): boolean {
  return (
    String(a.sectionKey) === String(b.sectionKey) &&
    String(a.engineBrandId ?? '') === String(b.engineBrandId ?? '') &&
    String(a.engineId ?? '') === String(b.engineId ?? '') &&
    Number(a.contractPriceKop ?? -1) === Number(b.contractPriceKop ?? -1)
  );
}

function samePay(
  a: PayRow,
  b: { date: string; amountKop: number; kind: string; note?: string; countdownStart?: boolean },
): boolean {
  return (
    String(a.date ?? '') === String(b.date ?? '') &&
    Number(a.amountKop ?? 0) === Number(b.amountKop ?? 0) &&
    String(a.kind) === String(b.kind) &&
    String(a.note ?? '') === String(b.note ?? '') &&
    Boolean(a.countdownStart) === Boolean(b.countdownStart ?? false)
  );
}

/**
 * Дифф `next` против реплики: вставка/правка/гашение строк со статусом pending.
 * id слотов и платежей стабильны (uuid из JSON/генератора UI) — матчим по ним.
 * Возвращает, была ли запись (нетронутое состояние не пишется — как было у EAV-стора).
 */
export async function saveContractPaymentsStrict(
  db: BetterSQLite3Database,
  contractId: string,
  next: ContractPayments,
  nowMs: number,
): Promise<{ changed: boolean }> {
  const id = String(contractId ?? '').trim();
  if (!id) throw new Error('contractId пуст');
  const now = Number(nowMs) > 0 ? Math.trunc(Number(nowMs)) : Date.now();
  let changed = false;
  const liveSlots = (await db
    .select()
    .from(erpContractPaymentSlots)
    .where(and(eq(erpContractPaymentSlots.contractId, id), isNull(erpContractPaymentSlots.deletedAt)))) as SlotRow[];
  const livePays = (await db.select().from(erpContractPayments).where(isNull(erpContractPayments.deletedAt))) as PayRow[];
  const paysBySlot = new Map<string, PayRow[]>();
  for (const p of livePays) {
    if (!liveSlots.some((s) => String(s.id) === String(p.slotId))) continue;
    const arr = paysBySlot.get(String(p.slotId)) ?? [];
    arr.push(p);
    paysBySlot.set(String(p.slotId), arr);
  }
  const nextIds = new Set((next.slots ?? []).map((s) => String(s.id)));
  for (const slot of next.slots ?? []) {
    const slotId = String(slot.id ?? '').trim();
    if (!slotId) continue;
    const cur = liveSlots.find((s) => String(s.id) === slotId);
    if (!cur) {
      await db.insert(erpContractPaymentSlots).values({
        id: slotId,
        contractId: id,
        sectionKey: String(slot.sectionKey),
        engineBrandId: slot.engineBrandId ? String(slot.engineBrandId) : null,
        engineId: slot.engineId ? String(slot.engineId) : null,
        contractPriceKop: slot.contractPriceKop ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        lastServerSeq: null,
        syncStatus: 'pending',
      } as any);
      changed = true;
    } else if (!sameSlot(cur, slot as never)) {
      await db
        .update(erpContractPaymentSlots)
        .set({
          sectionKey: String(slot.sectionKey),
          engineBrandId: slot.engineBrandId ? String(slot.engineBrandId) : null,
          engineId: slot.engineId ? String(slot.engineId) : null,
          contractPriceKop: slot.contractPriceKop ?? null,
          updatedAt: now,
          syncStatus: 'pending',
        } as any)
        .where(eq(erpContractPaymentSlots.id, slotId));
      changed = true;
    }
    const curPays = paysBySlot.get(slotId) ?? [];
    const nextPays = slot.payments ?? [];
    const nextPayIds = new Set(nextPays.map((p) => String(p.id)));
    for (const pay of nextPays) {
      const payId = String(pay.id ?? '').trim();
      if (!payId) continue;
      const curPay = curPays.find((p) => String(p.id) === payId);
      const want = {
        date: String(pay.date ?? ''),
        amountKop: Number(pay.amountKop ?? 0),
        kind: String(pay.kind),
        ...(pay.note ? { note: String(pay.note) } : {}),
        ...(pay.countdownStart ? { countdownStart: true as const } : {}),
      };
      if (!curPay) {
        await db.insert(erpContractPayments).values({
          id: payId,
          slotId,
          date: want.date,
          amountKop: want.amountKop,
          kind: want.kind,
          note: (want as { note?: string }).note ?? null,
          countdownStart: Boolean((want as { countdownStart?: boolean }).countdownStart ?? false),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          lastServerSeq: null,
          syncStatus: 'pending',
        } as any);
        changed = true;
      } else if (!samePay(curPay, want)) {
        await db
          .update(erpContractPayments)
          .set({
            slotId,
            date: want.date,
            amountKop: want.amountKop,
            kind: want.kind,
            note: (want as { note?: string }).note ?? null,
            countdownStart: Boolean((want as { countdownStart?: boolean }).countdownStart ?? false),
            updatedAt: now,
            syncStatus: 'pending',
          } as any)
          .where(eq(erpContractPayments.id, payId));
        changed = true;
      }
    }
    for (const curPay of curPays) {
      if (nextPayIds.has(String(curPay.id))) continue;
      await db
        .update(erpContractPayments)
        .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' } as any)
        .where(eq(erpContractPayments.id, String(curPay.id)));
      changed = true;
    }
  }
  for (const cur of liveSlots) {
    if (nextIds.has(String(cur.id))) continue;
    await db
      .update(erpContractPaymentSlots)
      .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' } as any)
      .where(eq(erpContractPaymentSlots.id, String(cur.id)));
    changed = true;
    for (const p of paysBySlot.get(String(cur.id)) ?? []) {
      await db
        .update(erpContractPayments)
        .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' } as any)
        .where(eq(erpContractPayments.id, String(p.id)));
    }
  }
  return { changed };
}
