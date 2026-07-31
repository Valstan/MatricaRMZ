/**
 * Единственная точка записи контрактного атрибута `contract_payments`.
 *
 * Атрибут крупный (все слоты и все платежи контракта в одном JSON), а пишут в него из двух
 * мест: карточка контракта и вкладка «Платежи» карточки двигателя. Карточка контракта до
 * 2026-07-31 писала весь атрибут из React-стейта БЕЗ пере-чтения — два бухгалтера (или даже
 * контракт и двигатель в одной сессии) затирали друг другу деньги. План подсистемы этого
 * требовал (`docs/plans/_archive/engine-payments-2026-07.md` §Сквозные предосторожности),
 * но в карточке контракта требование выполнено не было.
 *
 * Правило: мутация формулируется функцией от СВЕЖЕПРОЧИТАННОГО состояния, а не готовым
 * объектом из стейта. Тогда правка, приехавшая между рендером и кликом, не теряется.
 */

import { CONTRACT_PAYMENTS_ATTR_CODE, parseContractPayments, type ContractPayments } from '@matricarmz/shared';

export type ContractPaymentsMutation = (current: ContractPayments) => ContractPayments;

export type ContractPaymentsWriteResult =
  | { ok: true; next: ContractPayments; changed: boolean }
  | { ok: false; error: string };

async function readEntity(contractId: string): Promise<Record<string, unknown> | null> {
  const entity = (await window.matrica.admin.entities.get(contractId)) as
    | { attributes?: Record<string, unknown> }
    | null;
  return entity?.attributes ?? null;
}

/** Свежие платежи контракта (минуя React-стейт). */
export async function readContractPayments(contractId: string): Promise<ContractPayments> {
  return parseContractPayments((await readEntity(contractId))?.[CONTRACT_PAYMENTS_ATTR_CODE]);
}

/**
 * Прочитать → применить мутацию → записать. `changed: false` означает, что мутация ничего
 * не изменила и записи не было — вызывающему достаточно обновить свой стейт.
 */
export async function mutateContractPayments(
  contractId: string,
  mutate: ContractPaymentsMutation,
  fallbackTypeId?: string,
): Promise<ContractPaymentsWriteResult> {
  try {
    const current = await readContractPayments(contractId);
    const next = mutate(current);
    if (JSON.stringify(next) === JSON.stringify(current)) return { ok: true, next: current, changed: false };
    const r = (await window.matrica.admin.entities.setAttr(
      contractId,
      CONTRACT_PAYMENTS_ATTR_CODE,
      next,
      fallbackTypeId || undefined,
    )) as { ok?: boolean; error?: string } | undefined;
    if (r && r.ok === false) return { ok: false, error: r.error ?? 'не удалось сохранить платежи' };
    return { ok: true, next, changed: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
