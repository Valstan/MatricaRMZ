import {
  CONTRACT_ACTIVITY_WINDOW_MS,
  collectContractActivityAlerts,
  parseContractSections,
  type ContractActivityAlert,
} from '@matricarmz/shared';

// Shared loader for the «Мой круг» contract / ДС activity reminders. Used both by HistoryPage
// (to render the alert list) and by App (to drive the «Мой круг» bell badge), so the two never
// disagree on what counts as a notification. Derived purely from createdAt within a 3-day window
// → self-extinguishing, no read-state. Only recently-touched contracts are fetched (updatedAt in
// window) to keep the per-contract detail reads bounded. Returns alerts newest-first.
export async function loadContractActivityAlerts(): Promise<ContractActivityAlert[]> {
  const types = await window.matrica.admin.entityTypes.list();
  const type = (types as Array<{ id?: string; code?: string }>).find((t) => String(t.code) === 'contract');
  if (!type?.id) return [];
  const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
  const now = Date.now();
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter(
      (r) =>
        Number.isFinite(Number((r as { updatedAt?: number }).updatedAt)) &&
        now - Number((r as { updatedAt?: number }).updatedAt) <= CONTRACT_ACTIVITY_WINDOW_MS,
    )
    .slice(0, 30);
  const alerts: ContractActivityAlert[] = [];
  for (const row of candidates) {
    const id = String((row as { id?: string }).id ?? '');
    if (!id) continue;
    const detail = await window.matrica.admin.entities.get(id).catch(() => null);
    if (!detail) continue;
    const attrs = (detail as { attributes?: Record<string, unknown> }).attributes ?? {};
    const sections = parseContractSections(attrs);
    const number =
      String(sections.primary.number || (row as { displayName?: string }).displayName || '').trim() || id.slice(0, 8);
    const createdAt = (detail as { createdAt?: number }).createdAt;
    alerts.push(
      ...collectContractActivityAlerts({
        contractId: id,
        contractNumber: number,
        contractCreatedAt: typeof createdAt === 'number' ? createdAt : null,
        sections,
        now,
      }),
    );
  }
  alerts.sort((a, b) => b.createdAt - a.createdAt);
  return alerts;
}
