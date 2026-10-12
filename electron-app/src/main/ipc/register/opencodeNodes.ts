import { ipcMain } from 'electron';

import { normalizeOpencodeNodes } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, viewModeWriteError } from '../ipcContext.js';
import { opencodeNodesList, opencodeNodesSave, probeOpencodeNodes } from '../../services/opencodeNodesStore.js';

// OpenCode-узлы (мандат brain 2026-10-12): реестр локальный (userData, вне git),
// раздел виден только суперадмину — гейт ролью прямо здесь, второй линией после UI.
// В sectionGate PREFIX_RULES канал не заводим: данных разделов он не касается.

type Denied = { ok: false; error: string };

async function superadminOrDenied(ctx: IpcContext): Promise<Denied | null> {
  const viewer = await ctx.currentViewer().catch(() => null);
  const role = String(viewer?.role ?? '').trim().toLowerCase();
  if (role === 'superadmin') return null;
  return { ok: false, error: 'Раздел «OpenCode-узлы» доступен только суперадминистратору' };
}

export function registerOpencodeNodesIpc(ctx: IpcContext) {
  ipcMain.handle('opencodeNodes:list', async () => {
    const denied = await superadminOrDenied(ctx);
    if (denied) return denied;
    return { ok: true as const, nodes: await opencodeNodesList() };
  });

  ipcMain.handle('opencodeNodes:save', async (_e, args: { nodes?: unknown }) => {
    const denied = await superadminOrDenied(ctx);
    if (denied) return denied;
    if (isViewMode(ctx)) return viewModeWriteError();
    return { ok: true as const, nodes: await opencodeNodesSave(normalizeOpencodeNodes(args?.nodes)) };
  });

  ipcMain.handle('opencodeNodes:probe', async () => {
    const denied = await superadminOrDenied(ctx);
    if (denied) return denied;
    return { ok: true as const, probes: await probeOpencodeNodes() };
  });
}
