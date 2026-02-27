export const LINK_OPEN_LABELS: Record<string, string> = {
  customer: 'Открыть карточку контрагента',
  contract: 'Открыть карточку контракта',
  engine_brand: 'Открыть карточку марки двигателя',
};

export function getLinkOpenLabel(typeCode: string): string {
  return LINK_OPEN_LABELS[typeCode] ?? `Открыть ${typeCode}`;
}

export function openLinkedEntity(typeCode: string, entityId: string) {
  const id = entityId.trim();
  const code = typeCode.trim();
  if (!id || !code) return;
  try {
    const payload = { typeCode: code, entityId: id, at: Date.now() };
    localStorage.setItem('diagnostics.openEntity', JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent('diagnostics:open-entity', { detail: payload }));
  } catch {
    // ignore
  }
}
