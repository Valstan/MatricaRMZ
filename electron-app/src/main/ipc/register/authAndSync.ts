import { BrowserWindow, app, ipcMain, net, shell } from 'electron';
import { hostname } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SyncTableName, formatPendingExportReport, formatStuckPendingReport } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import {
  authChangePassword,
  authLogin,
  authLoginSuggest,
  authLogout,
  authProfileGet,
  authProfileUpdate,
  authUiProfileGet,
  authUiProfileSet,
  authRegister,
  authStatus,
  authSync,
  presenceMe,
} from '../../services/authService.js';
import { loginMruRecent, loginMruRecord } from '../../services/loginMruService.js';
import { softDeleteOperation } from '../../services/operationService.js';
import { SettingsKey, settingsGetNumber, settingsGetString, settingsSetString } from '../../services/settingsStore.js';
import { parseBlockedRows, serializeBlockedRows } from '../../services/sync/blockedRows.js';
import { httpAuthed } from '../../services/httpClient.js';
import { httpFailureText } from '../../services/httpFailureText.js';
import { resetLocalDatabase, resetSyncState } from '../../services/syncService.js';
import { readPendingExportState } from '../../services/sync/pendingExportState.js';
import { AUTO_SYNC_MS } from '../../services/syncControl.js';
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
      if (res.ok) await loginMruRecord(args.username, res.fullName);
      return res;
    })(),
  );
  ipcMain.handle('auth:loginSuggest', async (_e, args: { q: string }) =>
    authLoginSuggest(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl(), q: String(args?.q ?? '') }),
  );
  ipcMain.handle('auth:loginMru', async () => {
    const entries = await loginMruRecent(10);
    return { ok: true as const, logins: entries.map((e) => e.login), entries };
  });
  ipcMain.handle('auth:register', async (_e, args: { login: string; password: string; fullName: string; position: string }) =>
    (async () => {
      const res = await authRegister(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl(), ...args });
      if (res.ok) await loginMruRecord(args.login, args.fullName);
      return res;
    })(),
  );
  ipcMain.handle('auth:logout', async (_e, args: { refreshToken?: string }) =>
    authLogout(ctx.sysDb, {
      apiBaseUrl: ctx.mgr.getApiBaseUrl(),
      ...(args.refreshToken ? { refreshToken: args.refreshToken } : {}),
    }),
  );
  ipcMain.handle('auth:changePassword', async (_e, args: { currentPassword: string; newPassword: string }) =>
    authChangePassword(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl(), currentPassword: args.currentPassword, newPassword: args.newPassword }),
  );
  ipcMain.handle('auth:profileGet', async () => authProfileGet(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl() }));
  ipcMain.handle(
    'auth:profileUpdate',
    async (_e, args: {
      fullName?: string | null;
      position?: string | null;
      sectionName?: string | null;
      chatDisplayName?: string | null;
      telegramLogin?: string | null;
      maxLogin?: string | null;
    }) => authProfileUpdate(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl(), ...args }),
  );
  ipcMain.handle('auth:uiProfileGet', async () => authUiProfileGet(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl() }));
  ipcMain.handle('auth:uiProfileSet', async (_e, args: { profile: unknown }) =>
    authUiProfileSet(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl(), profile: args?.profile }),
  );
  ipcMain.handle('presence:me', async () => presenceMe(ctx.sysDb, { apiBaseUrl: ctx.mgr.getApiBaseUrl() }));

  // Sync
  ipcMain.handle('sync:run', async () => {
    if (isViewMode(ctx)) return { ok: false as const, pushed: 0, pulled: 0, serverCursor: 0, error: 'view mode' };
    const startedAt = Date.now();
    const emitSyncProgress = (payload: unknown) => {
      try {
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) win.webContents.send('sync:progress', payload);
        });
      } catch {
        // ignore
      }
    };
    return ctx.mgr.runOnce({
      progress: {
        mode: 'incremental',
        startedAt,
        onProgress: emitSyncProgress as any,
      },
    });
  });
  ipcMain.handle('sync:status', async () => ctx.mgr.getStatus());
  // Отбросить локальную rejected-строку (09.10.2026): сервер её никогда не примет
  // (permanent), оператор выбрал не чинить, а убрать. Пока только operations:
  // надгробие уезжает штатным push; остальным — отказ с объяснением, не молча.
  ipcMain.handle('sync:dropRejectedRow', async (_e, args: { table: string; rowId: string }) => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode' };
    const table = String(args?.table ?? '');
    const rowId = String(args?.rowId ?? '').trim();
    if (!rowId) return { ok: false as const, error: 'Нет id строки' };
    if (table !== SyncTableName.Operations) {
      return { ok: false as const, error: 'Отбросить можно только строку операций (этапы, записи истории)' };
    }
    try {
      const dropped = await softDeleteOperation(ctx.dataDb(), rowId);
      if (!dropped) return { ok: false as const, error: 'Строка не найдена или уже удалена' };
      const raw = await settingsGetString(ctx.dataDb(), SettingsKey.SyncBlockedRows).catch(() => null);
      const rest = parseBlockedRows(raw).filter((r) => !(r.table === table && r.id === rowId));
      await settingsSetString(ctx.dataDb(), SettingsKey.SyncBlockedRows, serializeBlockedRows(rest)).catch(() => {});
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
  // Сообщить администратору о застрявшей очереди (кнопка в баннере, 18.11.2026).
  //
  // Отчёт уходит СЕРВЕРУ, а не в чат парка: сервер знает, кто супер-админ, и кладёт
  // сообщение ему в чат и во внешние каналы (Telegram, МАКС). Оператор при этом
  // ничего не пишет сам и не должен знать, кто администратор.
  ipcMain.handle('sync:stuckPending:report', async () => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'режим просмотра' };
    const status = ctx.mgr.getStatus();
    const stuck = status.stuckPending;
    if (!stuck || !(stuck.count > 0)) return { ok: false as const, error: 'застрявших записей нет' };
    const clientId = String((await settingsGetString(ctx.dataDb(), SettingsKey.ClientId)) ?? '').trim();
    if (!clientId) return { ok: false as const, error: 'не известен id машины' };
    // Текст отчёта собираем на клиенте ДО отправки: если канал перехватил антивирус
    // (инцидент 23.11.2026 — страница Kaspersky вместо ответа сервера), отчёт всё равно
    // должен попасть к администратору — хотя бы через буфер обмена.
    const reportText = formatStuckPendingReport({
      clientId,
      clientName: hostname(),
      operator: { username: 'оператор этой машины' },
      stuck: {
        count: stuck.count,
        oldestPendingAt: stuck.oldestPendingAt ?? null,
        thresholdMinutes: stuck.thresholdMinutes,
        byTable: stuck.byTable ?? [],
        lastError: status.lastError ?? null,
        lastSyncAt: status.lastSyncAt ?? null,
      },
      trigger: 'manual',
      appVersion: app.getVersion(),
    });
    try {
      const res = await httpAuthed(
        ctx.dataDb(),
        ctx.mgr.getApiBaseUrl(),
        '/diagnostics/stuck-pending/report',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId,
            count: stuck.count,
            oldestPendingAt: stuck.oldestPendingAt ?? null,
            thresholdMinutes: stuck.thresholdMinutes,
            byTable: stuck.byTable ?? [],
            lastError: status.lastError ?? null,
            lastSyncAt: status.lastSyncAt ?? null,
            appVersion: app.getVersion(),
            hostName: hostname(),
          }),
        },
        { timeoutMs: 20_000, attempts: 2 },
      );
      if (!res.ok) {
        // Тело ответа целиком в текст оператору не годится: это может быть страница
        // антивируса на 170 КБ (инцидент 23.11.2026). Короткая причина + текст отчёта,
        // который можно скопировать и отдать администратору другим каналом.
        return { ok: false as const, error: httpFailureText(res), reportText };
      }
      return {
        ok: true as const,
        alerted: res.json?.alerted === true,
        reason: (res.json?.reason ?? null) as string | null,
        text: (res.json?.text ?? '') as string,
        chatSent: res.json?.chatSent === true,
      };
    } catch (e) {
      return { ok: false as const, error: String(e), reportText };
    }
  });
  // Отчёт по неотправленным данным, выгруженным в файл на машине (кнопка в баннере).
  //
  // Отчёт НЕ уходит на сервер: сами данные лежат на машине оператора, и администратору
  // нужен файл, а не строка в чате. Поэтому канал только собирает текст — оператор
  // копирует его и прикладывает файл сам.
  ipcMain.handle('sync:pendingExport:report', async () => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'режим просмотра' };
    // Читаем остатки напрямую, а не из статуса движка: статус едет из воркера раз в
    // секунду, а оператор жмёт кнопку сразу после перезапуска — и должен увидеть правду.
    const summary = await readPendingExportState(app.getPath('userData'));
    if (summary.files.length === 0) return { ok: false as const, error: 'выгрузок нет' };
    const clientId = String((await settingsGetString(ctx.dataDb(), SettingsKey.ClientId)) ?? '').trim();
    const text = formatPendingExportReport({ clientId, summary, appVersion: app.getVersion() });
    return { ok: true as const, text };
  });

  // Показать файл-выгрузку в Проводнике: оператор должен отдать файл администратору, а
  // искать его в папке AppData вручную не всякий догадается.
  ipcMain.handle('sync:pendingExport:reveal', async (_e, args: { name?: string }) => {
    const name = String(args?.name ?? '').trim();
    // Имя приходит из интерфейса — пускаем только наши файлы выгрузки и только из папки
    // данных программы (произвольные пути открывать нельзя).
    if (!/^pending-export-[A-Za-z0-9._-]+\.json$/.test(name)) return { ok: false as const, error: 'не тот файл' };
    const target = join(app.getPath('userData'), name);
    if (!existsSync(target)) return { ok: false as const, error: 'файл не найден' };
    try {
      shell.showItemInFolder(target);
    } catch {
      // Планшета: файловой системы у WebView нет, показать файл негде. Оператору
      // нужен честный ответ, а не падение канала (план #114, шаг 30).
      return {
        ok: false as const,
        error: 'На планшете нет файловой системы: файл выгрузки хранится внутри приложения и не переживает очистку данных. Отдайте данные администратору с ПК.',
      };
    }
    return { ok: true as const };
  });

  ipcMain.handle('sync:reset', async () => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode' };
    await resetSyncState(ctx.sysDb);
    return { ok: true as const };
  });
  ipcMain.handle('sync:fullPull', async () => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode' };
    const emitSyncProgress = (payload: unknown) => {
      try {
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) win.webContents.send('sync:progress', payload);
        });
      } catch {
        // ignore
      }
    };
    try {
      const startedAt = Date.now();
      const lastDuration = await settingsGetNumber(ctx.sysDb, SettingsKey.LastFullPullDurationMs, 0);
      const estimateMs = Math.max(60_000, Math.min(15 * 60_000, lastDuration || 180_000));
      emitSyncProgress({
        mode: 'force_full_pull',
        state: 'start',
        startedAt,
        elapsedMs: 0,
        estimateMs,
        etaMs: estimateMs,
        progress: 0,
        stage: 'prepare',
        detail: 'подготовка синхронизации',
      });
      await resetSyncState(ctx.sysDb);
      return await ctx.mgr.runOnce({
        fullPull: { reason: 'force_full_pull', startedAt, estimateMs, onProgress: emitSyncProgress },
      });
    } catch (e) {
      return { ok: false as const, pushed: 0, pulled: 0, serverCursor: 0, error: String(e) };
    }
  });
  ipcMain.handle('sync:resetLocalDb', async () => {
    if (isViewMode(ctx)) return { ok: false as const, error: 'view mode' };
    // Движок в отдельном процессе держит своё соединение SQLite: файл нельзя удалять,
    // пока он открыт. Просим его закрыться, и только потом сбрасываем базу.
    await ctx.mgr.releaseDatabase();
    // Процесс чтений тоже держит соединение с тем же файлом — гасим и его.
    ctx.engineList.dispose();
    const res = await resetLocalDatabase(ctx.sysDb, 'ui');
    if (!res.ok) {
      ctx.mgr.startAuto(AUTO_SYNC_MS);
      return res;
    }
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
        aiEnabled: json?.features?.aiEnabled !== false,
      };
    } catch (e) {
      return { ok: false as const, url, error: String(e) };
    } finally {
      clearTimeout(t);
    }
  });
}


