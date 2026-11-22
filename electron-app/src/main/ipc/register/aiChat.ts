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
import { localLinkStatus, runLocalAnswer } from '../../services/localMiniMaxService.js';

const writeError = { ok: false as const, error: 'AI-чат недоступен в режиме просмотра бэкапа' };

/**
 * ИИваныч считает локально, когда этот компьютер умеет (D-243/D-244): модуль MiniMax
 * на машине оператора берёт аккаунт у «Кармана» и отвечает молча. Не умеет — считает
 * сервер, как раньше.
 */
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
    // Claim локального звена: пока этот компьютер держит вопрос, серверный воркер
    // его не берёт — иначе ответили бы оба, а платный DeepSeek сгорел бы впустую.
    const status = localLinkStatus();
    const claimLocal = status.configured && status.state !== 'no_accounts' && status.state !== 'broken';
    const res = await aiChatCreate(ctx.dataDb(), ctx.mgr.getApiBaseUrl(), { ...args, claimLocal });
    // Сервер отвечает сразу, как получит вопрос — не ждём очередного тика синка.
    if (res.ok) void ctx.mgr.runOnce().catch(() => undefined);
    if (res.ok && claimLocal) {
      const questionText = String(args?.questionText ?? '');
      void runLocalAnswer({
        db: ctx.dataDb(),
        id: res.id,
        questionText,
        runSync: () => void ctx.mgr.runOnce().catch(() => undefined),
      });
    }
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

  /** Состояние локального звена: панель показывает, кто считает — этот компьютер или сервер. */
  ipcMain.handle('aiChat:localStatus', async () => {
    return { ok: true as const, status: localLinkStatus() };
  });
}
