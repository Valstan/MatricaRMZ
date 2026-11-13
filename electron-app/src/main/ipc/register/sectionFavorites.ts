import { ipcMain } from 'electron';
import { DEFAULT_SECTION_FAVORITES, resolveMenuTab, type MenuTabId } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { SettingsKey, settingsGetString, settingsSetString } from '../../services/settingsStore.js';

const SECTION_USER_SCOPE_FALLBACK = '__global__';

function resolveUserScope(rawUserId: unknown): string {
  const userId = String(rawUserId ?? '').trim();
  return userId || SECTION_USER_SCOPE_FALLBACK;
}

function parseByScope(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // ignore broken JSON
  }
  return {};
}

/** Только известные разделы меню, без дублей и мусора — как sanitizePresetIds у отчётов. */
export function sanitizeSectionFavoriteIds(ids: unknown): MenuTabId[] {
  if (!Array.isArray(ids)) return [];
  const out: MenuTabId[] = [];
  for (const value of ids) {
    const id = resolveMenuTab(String(value ?? '').trim());
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * Состояние избранного одного оператора: `ids` — что он выбрал, `off` — какие
 * ДЕФОЛТНЫЕ разделы он снял сам (владелец 13.11.2026: «по умолчанию для всех»).
 * Старая запись — просто массив: это `ids` без снятых дефолтов.
 */
export type ScopeFavorites = { ids: MenuTabId[]; off: MenuTabId[] };

function parseScopeFavorites(raw: unknown): ScopeFavorites {
  if (Array.isArray(raw)) return { ids: sanitizeSectionFavoriteIds(raw), off: [] };
  if (raw && typeof raw === 'object') {
    const obj = raw as { ids?: unknown; off?: unknown };
    // `off` касается только дефолтов: чужой ключ в нём не должен прятать выбор оператора.
    const off = sanitizeSectionFavoriteIds(obj.off).filter((id) => DEFAULT_SECTION_FAVORITES.includes(id));
    return { ids: sanitizeSectionFavoriteIds(obj.ids), off };
  }
  return { ids: [], off: [] };
}

/**
 * Что оператор видит в левой панели: дефолтные разделы (список двигателей и список
 * контрактов) плюс его собственные, минус те дефолты, которые он снял сам.
 */
export function effectiveSectionFavoriteIds(state: ScopeFavorites): MenuTabId[] {
  const off = new Set(state.off);
  const out: MenuTabId[] = [];
  for (const id of [...DEFAULT_SECTION_FAVORITES, ...state.ids]) {
    if (off.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export function registerSectionFavoritesIpc(ctx: IpcContext) {
  // Личные настройки интерфейса (прецедент drafts:*): гейта по праву нет,
  // чужое не трогается — scope привязан к userId вызывающего.
  ipcMain.handle('sections:favoritesGet', async (_e, args?: { userId?: string }) => {
    const scope = resolveUserScope(args?.userId);
    const raw = await settingsGetString(ctx.sysDb, SettingsKey.SectionFavorites);
    const byScope = parseByScope(raw);
    const state = parseScopeFavorites(byScope[scope]);
    return { ok: true as const, ids: effectiveSectionFavoriteIds(state) };
  });

  ipcMain.handle('sections:favoritesSet', async (_e, args?: { userId?: string; ids?: string[] }) => {
    const scope = resolveUserScope(args?.userId);
    const raw = await settingsGetString(ctx.sysDb, SettingsKey.SectionFavorites);
    const byScope = parseByScope(raw);
    const ids = sanitizeSectionFavoriteIds(args?.ids ?? []);
    // Присланный список — это то, что оператор видит. Дефолты, которых в нём нет,
    // он снял сам: запоминаем их отдельно, иначе «по умолчанию» вернулось бы
    // при следующем входе и снятие было бы фикцией.
    const off = DEFAULT_SECTION_FAVORITES.filter((id) => !ids.includes(id));
    byScope[scope] = { ids, off };
    await settingsSetString(ctx.sysDb, SettingsKey.SectionFavorites, JSON.stringify(byScope));
    return { ok: true as const, ids };
  });
}
