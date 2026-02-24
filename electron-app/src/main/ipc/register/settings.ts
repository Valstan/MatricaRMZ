import { ipcMain, net } from 'electron';
import type { UiControlSettings } from '@matricarmz/shared';
import {
  DEFAULT_UI_CONTROL_SETTINGS,
  UI_DEFAULTS_VERSION,
  sanitizeUiControlSettings,
} from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { getSession } from '../../services/authService.js';
import { SettingsKey, settingsGetBoolean, settingsGetString, settingsSetBoolean, settingsSetString } from '../../services/settingsStore.js';

const THEMES = new Set(['auto', 'light', 'dark']);
const CHAT_SIDES = new Set(['left', 'right']);

type TabsLayoutPrefs = {
  order?: string[];
  hidden?: string[];
  trashIndex?: number | null;
  groupOrder?: string[];
  hiddenGroups?: string[];
  collapsedGroups?: string[];
  activeGroup?: string | null;
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

function joinUrl(base: string, path: string) {
  const b = String(base ?? '').trim().replace(/\/+$/, '');
  const p = String(path ?? '').trim().replace(/^\/+/, '');
  return `${b}/${p}`;
}

async function fetchJsonWithAuth(
  ctx: IpcContext,
  args: { path: string; method?: 'GET' | 'PATCH'; body?: unknown },
): Promise<any | null> {
  const apiBaseUrl = String(ctx.mgr.getApiBaseUrl() ?? '').trim();
  if (!apiBaseUrl) return null;
  const session = await getSession(ctx.sysDb).catch(() => null);
  const token = String(session?.accessToken ?? '').trim();
  if (!token) return null;
  const res = await net.fetch(joinUrl(apiBaseUrl, args.path), {
    method: args.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(args.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });
  if (!res.ok) return null;
  return await res.json().catch(() => null);
}

async function fetchClientGlobalDefaults(ctx: IpcContext): Promise<{ globalDefaults: UiControlSettings; uiDefaultsVersion: number }> {
  const apiBaseUrl = String(ctx.mgr.getApiBaseUrl() ?? '').trim();
  const clientId = String((await settingsGetString(ctx.sysDb, SettingsKey.ClientId)) ?? '').trim();
  if (!apiBaseUrl || !clientId) {
    return { globalDefaults: DEFAULT_UI_CONTROL_SETTINGS, uiDefaultsVersion: UI_DEFAULTS_VERSION };
  }
  const url = joinUrl(apiBaseUrl, `/client/settings?clientId=${encodeURIComponent(clientId)}`);
  const res = await net.fetch(url);
  if (!res.ok) return { globalDefaults: DEFAULT_UI_CONTROL_SETTINGS, uiDefaultsVersion: UI_DEFAULTS_VERSION };
  const json = (await res.json().catch(() => null)) as any;
  const rawSettings = json?.settings?.uiGlobalSettingsJson;
  const rawVersion = Number(json?.settings?.uiDefaultsVersion ?? UI_DEFAULTS_VERSION);
  if (!rawSettings) return { globalDefaults: DEFAULT_UI_CONTROL_SETTINGS, uiDefaultsVersion: rawVersion };
  try {
    return {
      globalDefaults: sanitizeUiControlSettings(JSON.parse(String(rawSettings))),
      uiDefaultsVersion: Number.isFinite(rawVersion) ? rawVersion : UI_DEFAULTS_VERSION,
    };
  } catch {
    return { globalDefaults: DEFAULT_UI_CONTROL_SETTINGS, uiDefaultsVersion: UI_DEFAULTS_VERSION };
  }
}

function safeTabsLayout(value: unknown): TabsLayoutPrefs | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as TabsLayoutPrefs;
  const order = Array.isArray(raw.order) ? raw.order.map((x) => String(x)) : undefined;
  const hidden = Array.isArray(raw.hidden) ? raw.hidden.map((x) => String(x)) : undefined;
  const groupOrder = Array.isArray(raw.groupOrder) ? raw.groupOrder.map((x) => String(x)) : undefined;
  const hiddenGroups = Array.isArray(raw.hiddenGroups) ? raw.hiddenGroups.map((x) => String(x)) : undefined;
  const collapsedGroups = Array.isArray(raw.collapsedGroups) ? raw.collapsedGroups.map((x) => String(x)) : undefined;
  const trashIndex = raw.trashIndex == null ? null : Number(raw.trashIndex);
  const activeGroup = raw.activeGroup == null ? null : String(raw.activeGroup);
  return {
    ...(order ? { order } : {}),
    ...(hidden ? { hidden } : {}),
    ...(groupOrder ? { groupOrder } : {}),
    ...(hiddenGroups ? { hiddenGroups } : {}),
    ...(collapsedGroups ? { collapsedGroups } : {}),
    ...(activeGroup != null ? { activeGroup } : {}),
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

  ipcMain.handle('ui:control:get', async () => {
    try {
      const globalPayload = await fetchClientGlobalDefaults(ctx);
      const appliedVersion = Number((await settingsGetString(ctx.sysDb, SettingsKey.UiDefaultsVersionApplied)) ?? 0);
      if (globalPayload.uiDefaultsVersion > (Number.isFinite(appliedVersion) ? appliedVersion : 0)) {
        await settingsSetString(ctx.sysDb, SettingsKey.UiDefaultsVersionApplied, String(globalPayload.uiDefaultsVersion)).catch(() => {});
      }
      const effective = globalPayload.globalDefaults;
      return {
        ok: true,
        uiDefaultsVersion: Number(globalPayload.uiDefaultsVersion ?? UI_DEFAULTS_VERSION),
        globalDefaults: globalPayload.globalDefaults,
        effective,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('ui:control:setGlobal', async (_e, args: { uiSettings: unknown; bumpVersion?: boolean }) => {
    try {
      const safeSettings = sanitizeUiControlSettings(args?.uiSettings ?? DEFAULT_UI_CONTROL_SETTINGS);
      const res = await fetchJsonWithAuth(ctx, {
        path: '/auth/ui-settings/global',
        method: 'PATCH',
        body: { uiSettings: safeSettings, bumpVersion: args?.bumpVersion !== false },
      });
      if (!res?.ok) return { ok: false, error: String(res?.error ?? 'request failed') };
      const globalDefaults = sanitizeUiControlSettings(res.globalDefaults ?? safeSettings);
      return {
        ok: true,
        uiDefaultsVersion: Number(res.uiDefaultsVersion ?? UI_DEFAULTS_VERSION),
        globalDefaults,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // ui:control:setUser removed — user-managed UI settings are disabled.
}
