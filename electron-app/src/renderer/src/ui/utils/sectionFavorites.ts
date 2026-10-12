import { resolveMenuTab, type MenuTabId } from '../layout/Tabs.js';

/** Переключить раздел в избранном. Чистая — тестируется напрямую. */
export function toggleSectionFavoriteId(ids: readonly MenuTabId[], id: MenuTabId): MenuTabId[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** Санитайзер ответа моста: только известные разделы меню, без дублей. */
export function sanitizeSectionFavoriteIds(raw: unknown): MenuTabId[] {
  if (!Array.isArray(raw)) return [];
  const out: MenuTabId[] = [];
  for (const value of raw) {
    const id = resolveMenuTab(String(value ?? '').trim());
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}
