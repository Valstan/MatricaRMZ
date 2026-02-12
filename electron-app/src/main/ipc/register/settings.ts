import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { SettingsKey, settingsGetBoolean, settingsGetString, settingsSetBoolean, settingsSetString } from '../../services/settingsStore.js';

const THEMES = new Set(['auto', 'light', 'dark']);
const CHAT_SIDES = new Set(['left', 'right']);

type TabsLayoutPrefs = {
  order?: string[];
  hidden?: string[];
  trashIndex?: number | null;
};

function parseTabsLayout(raw: string | null): Record<string, TabsLayoutPrefs> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, TabsLayoutPrefs>;
  } catch {
    // ignore invalid data
  }
  return {};
}

function safeTabsLayout(value: unknown): TabsLayoutPrefs | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as TabsLayoutPrefs;
  const order = Array.isArray(raw.order) ? raw.order.map((x) => String(x)) : undefined;
  const hidden = Array.isArray(raw.hidden) ? raw.hidden.map((x) => String(x)) : undefined;
  const trashIndex = raw.trashIndex == null ? null : Number(raw.trashIndex);
  return {
    ...(order ? { order } : {}),
    ...(hidden ? { hidden } : {}),
    trashIndex: Number.isFinite(trashIndex ?? NaN) ? trashIndex : null,
  };
}

export function registerSettingsIpc(ctx: IpcContext) {
  ipcMain.handle('ui:prefs:get', async (_e, args?: { userId?: string }) => {
    const theme = (await settingsGetString(ctx.sysDb, SettingsKey.UiTheme)) ?? 'auto';
    const chatSide = (await settingsGetString(ctx.sysDb, SettingsKey.UiChatSide)) ?? 'right';
    const enterAsTab = await settingsGetBoolean(ctx.sysDb, SettingsKey.UiEnterAsTab, false);
    const userId = String(args?.userId ?? '').trim();
    let tabsLayout: TabsLayoutPrefs | null = null;
    if (userId) {
      const raw = await settingsGetString(ctx.sysDb, SettingsKey.UiTabsLayout);
      const data = parseTabsLayout(raw);
      tabsLayout = data[userId] ?? null;
    }
    return {
      ok: true,
      theme: THEMES.has(theme) ? theme : 'auto',
      chatSide: CHAT_SIDES.has(chatSide) ? chatSide : 'right',
      enterAsTab,
      tabsLayout,
    };
  });

  ipcMain.handle(
    'ui:prefs:set',
    async (_e, args: { theme?: string; chatSide?: string; enterAsTab?: boolean; userId?: string; tabsLayout?: TabsLayoutPrefs | null }) => {
      const currentTheme = (await settingsGetString(ctx.sysDb, SettingsKey.UiTheme)) ?? 'auto';
      const currentChatSide = (await settingsGetString(ctx.sysDb, SettingsKey.UiChatSide)) ?? 'right';
      const currentEnterAsTab = await settingsGetBoolean(ctx.sysDb, SettingsKey.UiEnterAsTab, false);
      const theme =
        args.theme == null ? String(currentTheme).trim() || 'auto' : String(args.theme ?? '').trim() || 'auto';
      const chatSide =
        args.chatSide == null ? String(currentChatSide).trim() || 'right' : String(args.chatSide ?? '').trim() || 'right';
      const enterAsTab = args.enterAsTab == null ? currentEnterAsTab : args.enterAsTab === true;
      const safeTheme = THEMES.has(theme) ? theme : 'auto';
      const safeChatSide = CHAT_SIDES.has(chatSide) ? chatSide : 'right';
      await settingsSetString(ctx.sysDb, SettingsKey.UiTheme, safeTheme);
      await settingsSetString(ctx.sysDb, SettingsKey.UiChatSide, safeChatSide);
      await settingsSetBoolean(ctx.sysDb, SettingsKey.UiEnterAsTab, enterAsTab);

      const userId = String(args.userId ?? '').trim();
      const nextLayout = safeTabsLayout(args.tabsLayout);
      if (userId && nextLayout) {
        const raw = await settingsGetString(ctx.sysDb, SettingsKey.UiTabsLayout);
        const data = parseTabsLayout(raw);
        data[userId] = nextLayout;
        await settingsSetString(ctx.sysDb, SettingsKey.UiTabsLayout, JSON.stringify(data));
      }

      return { ok: true, theme: safeTheme, chatSide: safeChatSide, enterAsTab, tabsLayout: nextLayout };
    },
  );
}
