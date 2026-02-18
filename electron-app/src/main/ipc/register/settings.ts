import { ipcMain, net } from 'electron';

import type { IpcContext } from '../ipcContext.js';
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

type UiDisplayButtonState = 'active' | 'inactive';
type UiDisplayButtonTarget = 'departmentButtons' | 'sectionButtons';
type UiDisplayTarget = UiDisplayButtonTarget | 'listFont' | 'cardFont';

type UiDisplayButtonStyle = {
  fontSize: number;
  width: number;
  height: number;
  paddingX: number;
  paddingY: number;
  gap: number;
};

type UiDisplayButtonConfig = {
  active: UiDisplayButtonStyle;
  inactive: UiDisplayButtonStyle;
};

type UiDisplayPrefs = {
  selectedTarget: UiDisplayTarget;
  selectedButtonState: UiDisplayButtonState;
  departmentButtons: UiDisplayButtonConfig;
  sectionButtons: UiDisplayButtonConfig;
  listFontSize: number;
  cardFontSize: number;
};

const DEFAULT_UI_DISPLAY_PREFS: UiDisplayPrefs = {
  selectedTarget: 'departmentButtons',
  selectedButtonState: 'active',
  departmentButtons: {
    active: { fontSize: 26, width: 240, height: 152, paddingX: 16, paddingY: 5, gap: 8 },
    inactive: { fontSize: 26, width: 240, height: 152, paddingX: 16, paddingY: 5, gap: 8 },
  },
  sectionButtons: {
    active: { fontSize: 24, width: 200, height: 64, paddingX: 18, paddingY: 8, gap: 6 },
    inactive: { fontSize: 24, width: 200, height: 64, paddingX: 18, paddingY: 8, gap: 6 },
  },
  listFontSize: 14,
  cardFontSize: 14,
};

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeButtonStyle(raw: unknown, fallback: UiDisplayButtonStyle): UiDisplayButtonStyle {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const value = raw as Record<string, unknown>;
  return {
    fontSize: clampNumber(value.fontSize, fallback.fontSize, 10, 48),
    width: clampNumber(value.width, fallback.width, 60, 480),
    height: clampNumber(value.height, fallback.height, 24, 280),
    paddingX: clampNumber(value.paddingX, fallback.paddingX, 0, 60),
    paddingY: clampNumber(value.paddingY, fallback.paddingY, 0, 40),
    gap: clampNumber(value.gap, fallback.gap, 0, 60),
  };
}

function safeButtonConfig(raw: unknown, fallback: UiDisplayButtonConfig): UiDisplayButtonConfig {
  if (!raw || typeof raw !== 'object') {
    return {
      active: { ...fallback.active },
      inactive: { ...fallback.inactive },
    };
  }
  const value = raw as Record<string, unknown>;
  return {
    active: safeButtonStyle(value.active, fallback.active),
    inactive: safeButtonStyle(value.inactive, fallback.inactive),
  };
}

function safeUiDisplayPrefs(raw: unknown): UiDisplayPrefs {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const selectedTargetRaw = String(value.selectedTarget ?? DEFAULT_UI_DISPLAY_PREFS.selectedTarget);
  const selectedTarget: UiDisplayTarget = ['departmentButtons', 'sectionButtons', 'listFont', 'cardFont'].includes(selectedTargetRaw)
    ? (selectedTargetRaw as UiDisplayTarget)
    : DEFAULT_UI_DISPLAY_PREFS.selectedTarget;
  const selectedButtonStateRaw = String(value.selectedButtonState ?? DEFAULT_UI_DISPLAY_PREFS.selectedButtonState);
  const selectedButtonState: UiDisplayButtonState =
    selectedButtonStateRaw === 'inactive' ? 'inactive' : 'active';
  return {
    selectedTarget,
    selectedButtonState,
    departmentButtons: safeButtonConfig(value.departmentButtons, DEFAULT_UI_DISPLAY_PREFS.departmentButtons),
    sectionButtons: safeButtonConfig(value.sectionButtons, DEFAULT_UI_DISPLAY_PREFS.sectionButtons),
    listFontSize: clampNumber(value.listFontSize, DEFAULT_UI_DISPLAY_PREFS.listFontSize, 10, 48),
    cardFontSize: clampNumber(value.cardFontSize, DEFAULT_UI_DISPLAY_PREFS.cardFontSize, 10, 48),
  };
}

function parseUiDisplayPrefs(raw: string | null): UiDisplayPrefs {
  if (!raw) return { ...DEFAULT_UI_DISPLAY_PREFS };
  try {
    const parsed = JSON.parse(raw);
    return safeUiDisplayPrefs(parsed);
  } catch {
    return { ...DEFAULT_UI_DISPLAY_PREFS };
  }
}

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

async function pushUiDisplayPrefsRemote(args: { apiBaseUrl: string; clientId: string; payloadJson: string }) {
  const res = await net.fetch(joinUrl(args.apiBaseUrl, '/client/settings/ui-display'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: args.clientId,
      uiDisplayPrefs: args.payloadJson,
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
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
    const displayPrefs = parseUiDisplayPrefs(await settingsGetString(ctx.sysDb, SettingsKey.UiDisplayPrefs));
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
      displayPrefs,
      tabsLayout,
    };
  });

  ipcMain.handle(
    'ui:prefs:set',
    async (_e, args: { theme?: string; chatSide?: string; enterAsTab?: boolean; userId?: string; tabsLayout?: TabsLayoutPrefs | null; displayPrefs?: UiDisplayPrefs | null }) => {
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
      const currentDisplayPrefs = parseUiDisplayPrefs(await settingsGetString(ctx.sysDb, SettingsKey.UiDisplayPrefs));
      const nextDisplayPrefs = args.displayPrefs == null ? currentDisplayPrefs : safeUiDisplayPrefs(args.displayPrefs);
      const nextDisplayPrefsJson = JSON.stringify(nextDisplayPrefs);
      await settingsSetString(ctx.sysDb, SettingsKey.UiTheme, safeTheme);
      await settingsSetString(ctx.sysDb, SettingsKey.UiChatSide, safeChatSide);
      await settingsSetBoolean(ctx.sysDb, SettingsKey.UiEnterAsTab, enterAsTab);
      await settingsSetString(ctx.sysDb, SettingsKey.UiDisplayPrefs, nextDisplayPrefsJson);

      const userId = String(args.userId ?? '').trim();
      const nextLayout = safeTabsLayout(args.tabsLayout);
      if (userId && nextLayout) {
        const raw = await settingsGetString(ctx.sysDb, SettingsKey.UiTabsLayout);
        const data = parseTabsLayout(raw);
        data[userId] = nextLayout;
        await settingsSetString(ctx.sysDb, SettingsKey.UiTabsLayout, JSON.stringify(data));
      }

      if (args.displayPrefs != null) {
        const apiBaseUrl = String(ctx.mgr.getApiBaseUrl() ?? '').trim();
        const clientId = String((await settingsGetString(ctx.sysDb, SettingsKey.ClientId)) ?? '').trim();
        if (apiBaseUrl && clientId) {
          await pushUiDisplayPrefsRemote({
            apiBaseUrl,
            clientId,
            payloadJson: nextDisplayPrefsJson,
          }).catch((e) => {
            ctx.logToFile(`ui display prefs remote push failed: ${String(e)}`);
          });
        }
      }

      return { ok: true, theme: safeTheme, chatSide: safeChatSide, enterAsTab, displayPrefs: nextDisplayPrefs, tabsLayout: nextLayout };
    },
  );
}
