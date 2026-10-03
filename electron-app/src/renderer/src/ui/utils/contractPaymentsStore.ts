/**
 * Единственная точка чтения/записи платежей договора.
 *
 * Источник правды — строгие таблицы `erp_contract_payment_slots` /
 * `erp_contract_payments` (план contract-payments-strict-2026-10): чтение и запись идут
 * мостом `contractPayments:*` в локальную SQLite, дальше штатный синк. EAV-атрибут
 * `contract_payments` больше не пишется отсюда (запись закрыта).
 *
 * Правило пере-чтения сохранено: мутация формулируется функцией от
 * СВЕЖЕПРОЧИТАННОГО состояния, а не готовым объектом из стейта.
 */

import { parseContractPayments, type ContractPayments } from '@matricarmz/shared';

export type ContractPaymentsMutation = (current: ContractPayments) => ContractPayments;

export type ContractPaymentsWriteResult =
  | { ok: true; next: ContractPayments; changed: boolean }
  | { ok: false; error: string };

/** Свежие платежи контракта (минуя React-стейт). */
export async function readContractPayments(contractId: string): Promise<ContractPayments> {
  const r = (await window.matrica.contractPayments.get(contractId)) as
    | { ok: boolean; payments?: unknown; error?: string }
    | null;
  if (!r || r.ok !== true) return parseContractPayments(null);
  return parseContractPayments(r.payments);
}

/**
 * Прочитать → применить мутацию → записать. `changed: false` означает, что мутация ничего
 * не изменила и записи не было — вызывающему достаточно обновить свой стейт.
 */
export async function mutateContractPayments(
  contractId: string,
  mutate: ContractPaymentsMutation,
  _fallbackTypeId?: string,
): Promise<ContractPaymentsWriteResult> {
  try {
    const current = await readContractPayments(contractId);
    const next = mutate(current);
    if (JSON.stringify(next) === JSON.stringify(current)) return { ok: true, next: current, changed: false };
    const r = (await window.matrica.contractPayments.save({ contractId, next })) as
      | { ok: boolean; payments?: unknown; error?: string }
      | undefined;
    if (!r || r.ok !== true) return { ok: false, error: String(r?.error ?? 'не удалось сохранить платежи') };
    return { ok: true, next: parseContractPayments(r.payments), changed: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
