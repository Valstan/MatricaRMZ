function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

export function resolveEngineShippingState(attrs: Record<string, unknown>): { shippingDate: number | null; onSite: boolean } {
  const explicitShippingDate = asNumberOrNull(attrs.shipping_date);
  const customerSentDate = asNumberOrNull(attrs.status_customer_sent_date);
  const customerAcceptedDate = asNumberOrNull(attrs.status_customer_accepted_date);
  const customerSent = isTruthyFlag(attrs.status_customer_sent);
  const customerAccepted = isTruthyFlag(attrs.status_customer_accepted);
  // Статус-дата «Отправлен заказчику» первична — это то, что правит карточка двигателя.
  // Прямой shipping_date — замороженный февральский импорт-legacy; берём его ТОЛЬКО как
  // исторический фолбэк, иначе отчёт/фильтр показывают импортное значение и игнорируют
  // правки карточки (тот же dual-source-баг, что в listEngines — 2Ж03АТ0479).
  const shippingDate = customerSentDate ?? customerAcceptedDate ?? explicitShippingDate;
  const leftFactory = shippingDate != null || customerSent || customerAccepted;
  return { shippingDate, onSite: !leftFactory };
}

