import { ipcMain } from 'electron';
import { resolveMenuTab, type MenuTabId } from '@matricarmz/shared';

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

export function registerSectionFavoritesIpc(ctx: IpcContext) {
  // Личные настройки интерфейса (прецедент drafts:*): гейта по праву нет,
  // чужое не трогается — scope привязан к userId вызывающего.
  ipcMain.handle('sections:favoritesGet', async (_e, args?: { userId?: string }) => {
    const scope = resolveUserScope(args?.userId);
    const raw = await settingsGetString(ctx.sysDb, SettingsKey.SectionFavorites);
    const byScope = parseByScope(raw);
    return { ok: true as const, ids: sanitizeSectionFavoriteIds(byScope[scope]) };
  });

  ipcMain.handle('sections:favoritesSet', async (_e, args?: { userId?: string; ids?: string[] }) => {
    const scope = resolveUserScope(args?.userId);
    const raw = await settingsGetString(ctx.sysDb, SettingsKey.SectionFavorites);
    const byScope = parseByScope(raw);
    const ids = sanitizeSectionFavoriteIds(args?.ids ?? []);
    byScope[scope] = ids;
    await settingsSetString(ctx.sysDb, SettingsKey.SectionFavorites, JSON.stringify(byScope));
    return { ok: true as const, ids };
  });
}
