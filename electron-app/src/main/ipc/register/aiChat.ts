import { ipcMain } from 'electron';

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

const writeError = { ok: false as const, error: 'AI-чат недоступен в режиме просмотра бэкапа' };

async function engineMode(ctx: IpcContext): Promise<'prod' | 'local'> {
  const raw = await settingsGetString(ctx.sysDb, SettingsKey.AiEngineMode).catch(() => null);
  return raw === 'local' ? 'local' : 'prod';
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
    const res = await aiChatCreate(ctx.dataDb(), ctx.mgr.getApiBaseUrl(), args, mode);
    // Сервер отвечает сразу, как получит вопрос — не ждём очередного тика синка.
    // Локальный режим на сервер ничего не отправляет, пинать синк незачем.
    if (res.ok && mode !== 'local') void ctx.mgr.runOnce().catch(() => undefined);
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

  // Контур B: где считать ответ и что с локальным движком.
  ipcMain.handle('aiEngine:status', async () => {
    return { ok: true as const, mode: await engineMode(ctx), ...getLocalEngineStatus() };
  });

  ipcMain.handle('aiEngine:setMode', async (_e, mode: 'prod' | 'local') => {
    if (isViewMode(ctx)) return writeError;
    const next = mode === 'local' ? 'local' : 'prod';
    await settingsSetString(ctx.sysDb, SettingsKey.AiEngineMode, next);
    if (next === 'local') void ensureLocalEngine();
    else void stopLocalEngine();
    return { ok: true as const, mode: next };
  });
}
