import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { SettingsKey, settingsGetString, settingsSetString } from '../../services/settingsStore.js';

const THEMES = new Set(['auto', 'light', 'dark']);
const CHAT_SIDES = new Set(['left', 'right']);

export function registerSettingsIpc(ctx: IpcContext) {
  ipcMain.handle('ui:prefs:get', async () => {
    const theme = (await settingsGetString(ctx.sysDb, SettingsKey.UiTheme)) ?? 'auto';
    const chatSide = (await settingsGetString(ctx.sysDb, SettingsKey.UiChatSide)) ?? 'right';
    return {
      ok: true,
      theme: THEMES.has(theme) ? theme : 'auto',
      chatSide: CHAT_SIDES.has(chatSide) ? chatSide : 'right',
    };
  });

  ipcMain.handle('ui:prefs:set', async (_e, args: { theme?: string; chatSide?: string }) => {
    const theme = String(args.theme ?? '').trim() || 'auto';
    const chatSide = String(args.chatSide ?? '').trim() || 'right';
    const safeTheme = THEMES.has(theme) ? theme : 'auto';
    const safeChatSide = CHAT_SIDES.has(chatSide) ? chatSide : 'right';
    await settingsSetString(ctx.sysDb, SettingsKey.UiTheme, safeTheme);
    await settingsSetString(ctx.sysDb, SettingsKey.UiChatSide, safeChatSide);
    return { ok: true, theme: safeTheme, chatSide: safeChatSide };
  });
}
