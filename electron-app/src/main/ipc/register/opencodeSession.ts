import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, viewModeWriteError } from '../ipcContext.js';
import { clearAgentSessionRef, ensureAgentSession, loadAgentSessionRef } from '../../services/opencodeAgentSession.js';
import { deleteOpencodeSession, getOpencodeSession } from '../../services/opencodeSessionClient.js';

// Фоновая агентская сессия своего узла (D10, слайс 2): одна на клиент.
// Раздел виден только суперадмину — гейт ролью прямо здесь, как у реестра узлов.

type Denied = { ok: false; error: string };

async function superadminOrDenied(ctx: IpcContext): Promise<Denied | null> {
  const viewer = await ctx.currentViewer().catch(() => null);
  const role = String(viewer?.role ?? '').trim().toLowerCase();
  if (role === 'superadmin') return null;
  return { ok: false, error: 'Фоновая сессия доступна только суперадминистратору' };
}

export function registerOpencodeSessionIpc(ctx: IpcContext) {
  ipcMain.handle('opencodeSession:ensure', async () => {
    const denied = await superadminOrDenied(ctx);
    if (denied) return denied;
    if (isViewMode(ctx)) return viewModeWriteError();
    return ensureAgentSession();
  });

  ipcMain.handle('opencodeSession:status', async () => {
    const denied = await superadminOrDenied(ctx);
    if (denied) return denied;
    const saved = await loadAgentSessionRef();
    if (!saved) return { ok: true as const, sessionId: null, valid: false };
    const check = await getOpencodeSession(saved.sessionId);
    if (!check.ok) return check;
    return { ok: true as const, sessionId: saved.sessionId, valid: check.session !== null };
  });

  ipcMain.handle('opencodeSession:remove', async () => {
    const denied = await superadminOrDenied(ctx);
    if (denied) return denied;
    if (isViewMode(ctx)) return viewModeWriteError();
    const saved = await loadAgentSessionRef();
    if (saved) {
      const r = await deleteOpencodeSession(saved.sessionId);
      if (!r.ok) return r;
      await clearAgentSessionRef();
    }
    return { ok: true as const };
  });
}
