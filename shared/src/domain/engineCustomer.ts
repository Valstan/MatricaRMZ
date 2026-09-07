/**
 * Заказчик двигателя — одно правило на всю программу (решение владельца 07.09.2026).
 *
 * **Источник истины — договор.** Заказчик не прибивается к карточке двигателя гвоздями: двигатель
 * перецепили на другой договор — заказчик обязан поехать за ним сам, без ручной правки и без
 * задним числом прокинутых значений. Поэтому договор читается первым, а не вторым.
 *
 * **Поле карточки остаётся запасным путём, и это не вкус, а замер.** На проде 07.09.2026:
 * 1371 двигатель с договором (у 1358 заполнено и поле карточки, и у 12 из них оно уже
 * разошлось с договором — ровно тот случай, ради которого правило и меняется), но **1149
 * двигателей несут заказчика ТОЛЬКО в карточке, договора у них нет вовсе**. Правило «всегда из
 * договора» стёрло бы заказчика у этих 1149 — поэтому карточка читается, когда договора нет.
 *
 * `source` возвращается наружу, чтобы интерфейс мог показать, откуда взято значение: подпись
 * «из договора» отличается от «указано в карточке», и оператор не гадает, почему поле не
 * редактируется.
 */
export type EngineCustomerSource = 'contract' | 'card' | 'none';

export type EngineCustomerRef = {
  /** Договор двигателя (`contract_id`). */
  contractId?: string | null;
  /** Заказчик, записанный в самой карточке (`customer_id` / `counterparty_id`). */
  customerId?: string | null;
};

export function resolveEngineCustomer(
  engine: EngineCustomerRef | null | undefined,
  contractCustomerById: ReadonlyMap<string, string>,
): { id: string; source: EngineCustomerSource } {
  const contractId = String(engine?.contractId ?? '').trim();
  if (contractId) {
    const fromContract = String(contractCustomerById.get(contractId) ?? '').trim();
    if (fromContract) return { id: fromContract, source: 'contract' };
  }
  const fromCard = String(engine?.customerId ?? '').trim();
  if (fromCard) return { id: fromCard, source: 'card' };
  return { id: '', source: 'none' };
}
