import { app, ipcMain, net } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import {
  authChangePassword,
  authLogin,
  authLogout,
  authProfileGet,
  authProfileUpdate,
  authRegister,
  authStatus,
  authSync,
  presenceMe,
} from '../../services/authService.js';
import { SettingsKey, settingsGetString, settingsSetString } from '../../services/settingsStore.js';
import { resetLocalDatabase, resetSyncState } from '../../services/syncService.js';
import { isViewMode } from '../ipcContext.js';

export function registerAuthAndSyncIpc(ctx: IpcContext) {
  // Auth
  ipcMain.handle('auth:status', async () => authStatus(ctx.sysDb));
  ipcMain.handle('auth:sync', async () => {
    const res = await authSync(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl() });
    // Note: logging is managed by client settings (admin panel). Avoid overriding here.
    return res;
  });
  ipcMain.handle('auth:login', async (_e, args: { username: string; password: string }) =>
    (async () => {
      const res = await authLogin(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl(), username: args.username, password: args.password });
      // Note: logging is managed by client settings (admin panel). Avoid overriding here.
      return res;
    })(),
  );
  ipcMain.handle('auth:register', async (_e, args: { login: string; password: string; fullName: string; position: string }) =>
    authRegister(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl(), ...args }),
  );
  ipcMain.handle('auth:logout', async (_e, args: { refreshToken?: string }) =>
    authLogout(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl(), refreshToken: args.refreshToken }),
  );
  ipcMain.handle('auth:changePassword', async (_e, args: { currentPassword: string; newPassword: string }) =>
    authChangePassword(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl(), currentPassword: args.currentPassword, newPassword: args.newPassword }),
  );
  ipcMain.handle('auth:profileGet', async () => authProfileGet(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl() }));
  ipcMain.handle(
    'auth:profileUpdate',
    async (_e, args: { fullName?: string | null; position?: string | null; sectionName?: string | null; chatDisplayName?: string | null }) =>
      authProfileUpdate(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl(), ...args }),
  );
  ipcMain.handle('presence:me', async () => presenceMe(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl() }));

  // Sync
  ipcMain.handle('sync:run', async () => {
    if (isViewMode(ctx)) return { ok: false as const, pushed: 0, pulled: 0, serverCursor: 0, error: 'view mode' };
    return ctx.mgr.runOnce();
  });
  ipcMain.handle('sync:status', async () => ctx.mgr.getStatus());
  ipcMain.handle('sync:reset', async () => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode' };
    await resetSyncState(ctx.sysDb);
    return { ok: true as const };
  });
  ipcMain.handle('sync:resetLocalDb', async () => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode' };
    ctx.mgr.stopAuto();
    const res = await resetLocalDatabase(ctx.sysDb, 'ui');
    if (!res.ok) return res;
    setTimeout(() => {
      try {
        app.relaunch();
      } catch {
        // ignore
      }
      app.exit(0);
    }, 500);
    return { ok: true as const, restarting: true };
  });
  ipcMain.handle('sync:config:get', async () => {
    try {
      const v = await settingsGetString(ctx.sysDb, SettingsKey.ApiBaseUrl);
      return { ok: true, apiBaseUrl: v ?? ctx.mgr.getApiBaseUrl() };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  ipcMain.handle('sync:config:set', async (_e, args: { apiBaseUrl: string }) => {
    try {
      const v = String(args.apiBaseUrl ?? '').trim();
      if (!v) return { ok: false, error: 'apiBaseUrl is empty' };
      await settingsSetString(ctx.sysDb, SettingsKey.ApiBaseUrl, v);
      ctx.mgr.setApiBaseUrl(v);
      ctx.logToFile(`sync apiBaseUrl set: ${v}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // Backend health (version compatibility check)
  ipcMain.handle('server:health', async () => {
    const base = ctx.mgr.getApiBaseUrl();
    const url = `${String(base ?? '').trim().replace(/\/+$/, '')}/health`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('timeout')), 10_000);
    try {
      const r = await net.fetch(url, { method: 'GET', signal: ac.signal as any });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return { ok: false as const, url, error: `health HTTP ${r.status}: ${text || 'no body'}` };
      }
      const json = (await r.json().catch(() => ({}))) as any;
      return {
        ok: true as const,
        url,
        serverOk: json?.ok === true,
        version: typeof json?.version === 'string' ? json.version : null,
        buildDate: typeof json?.buildDate === 'string' ? json.buildDate : null,
      };
    } catch (e) {
      return { ok: false as const, url, error: String(e) };
    } finally {
      clearTimeout(t);
    }
  });
}


