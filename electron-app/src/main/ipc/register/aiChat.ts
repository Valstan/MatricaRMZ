import { ipcMain } from 'electron';

import { resolveAiEngineMode, type AiEngineMode } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult } from '../ipcContext.js';
import { consumeIssuedPath } from '../pathOriginRegistry.js';
import {
  aiChatCreate,
  aiChatDelete,
  aiChatList,
  aiChatMeta,
  aiChatSetVerdict,
  aiChatUpdate,
} from '../../services/aiChatService.js';
import { SettingsKey, settingsGetString, settingsSetString } from '../../services/settingsStore.js';
import { ensureLocalEngine, getLocalEngineStatus, stopLocalEngine } from '../../services/localAiEngine.js';
import { getAnswerSource, getEngineBreaker, localEnginePausedForMs, resetEngineBreaker } from '../../services/aiEngineAuto.js';
import { buildEngineDiagnostic } from '../../services/localEngineDiagnostics.js';

const writeError = { ok: false as const, error: 'AI-чат недоступен в режиме просмотра бэкапа' };

/**
 * Режим Ииваныча: «Авто» (по умолчанию) / «Только этот ПК» / «Только сервер».
 * Ручной выбор владельца уважаем, но значение по умолчанию — «Авто»:
 * Ииваныч сначала считает на этом компьютере, и только при неудаче уходит на сервер.
 */
async function engineMode(ctx: IpcContext): Promise<AiEngineMode> {
  const raw = await settingsGetString(ctx.sysDb, SettingsKey.AiEngineMode).catch(() => null);
  return resolveAiEngineMode(raw);
}

export function registerAiChatIpc(ctx: IpcContext) {
  ipcMain.handle('aiChat:list', async () => {
    return await aiChatList(ctx.dataDb());
  });

  ipcMain.handle('aiChat:create', async (_e, args: { questionText: string; filePath?: string }) => {
    if (isViewMode(ctx)) return writeError;
    const gate = await requirePermOrResult(ctx, 'chat.use');
    if (!gate.ok) return gate;
    if (args?.filePath && !consumeIssuedPath(args.filePath)) {
      return { ok: false as const, error: 'путь не из диалога выбора файлов' };
    }
    const mode = await engineMode(ctx);
    const res = await aiChatCreate(ctx.dataDb(), ctx.mgr.getApiBaseUrl(), args, mode, () => {
      // Локальный движок не справился — вопрос уходит на сервер, пинаем синк.
      void ctx.mgr.runOnce().catch(() => undefined);
    });
    // Сервер отвечает сразу, как получит вопрос — не ждём очередного тика синка.
    // Локальный режим на сервер ничего не отправляет, пинать синк незачем.
    if (res.ok && mode === 'prod') void ctx.mgr.runOnce().catch(() => undefined);
    return res;
  });

  ipcMain.handle('aiChat:update', async (_e, args: { id: string; questionText: string }) => {
    if (isViewMode(ctx)) return writeError;
    return await aiChatUpdate(ctx.dataDb(), args);
  });

  ipcMain.handle('aiChat:delete', async (_e, args: { id: string }) => {
    if (isViewMode(ctx)) return writeError;
    return await aiChatDelete(ctx.dataDb(), args);
  });

  ipcMain.handle('aiChat:setVerdict', async (_e, args: { id: string; verdictText: string }) => {
    if (isViewMode(ctx)) return writeError;
    return await aiChatSetVerdict(ctx.dataDb(), args);
  });

  ipcMain.handle('aiChat:meta', async () => {
    return await aiChatMeta(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  // Где считаем ответ и что с локальным движком.
  ipcMain.handle('aiEngine:status', async () => {
    const mode = await engineMode(ctx);
    const breaker = getEngineBreaker();
    return {
      ok: true as const,
      mode,
      ...getLocalEngineStatus(),
      breakerFailures: breaker.failures,
      pausedForMs: localEnginePausedForMs(),
    };
  });

  ipcMain.handle('aiEngine:setMode', async (_e, mode: AiEngineMode) => {
    if (isViewMode(ctx)) return writeError;
    const next = resolveAiEngineMode(mode);
    await settingsSetString(ctx.sysDb, SettingsKey.AiEngineMode, next);
    if (next === 'prod') void stopLocalEngine();
    else void ensureLocalEngine({ apiBaseUrl: ctx.mgr.getApiBaseUrl() });
    return { ok: true as const, mode: next };
  });

  // Диагностика «не заработало»: отчёт копируется в буфер одним нажатием.
  ipcMain.handle('aiEngine:diagnose', async () => {
    const mode = await engineMode(ctx);
    const diag = await buildEngineDiagnostic(mode, getEngineBreaker());
    return { ok: true as const, ...diag };
  });

  // Попробовать локальный движок снова, не дожидаясь конца паузы.
  ipcMain.handle('aiEngine:resetBreaker', async () => {
    resetEngineBreaker();
    const mode = await engineMode(ctx);
    if (mode !== 'prod') void ensureLocalEngine({ apiBaseUrl: ctx.mgr.getApiBaseUrl() });
    return { ok: true as const };
  });

  // Где посчитан ответ по конкретной строке — оператор видит «считал сервер».
  ipcMain.handle('aiEngine:answerSource', async (_e, id: string) => {
    return { ok: true as const, source: getAnswerSource(String(id ?? '')) };
  });
}
