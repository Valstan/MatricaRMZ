import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import {
  notesBurningCount,
  notesDelete,
  notesHide,
  notesList,
  notesReorder,
  notesShare,
  notesUnshare,
  notesUpsert,
  notesUsersList,
} from '../../services/notesService.js';

export function registerNotesIpc(ctx: IpcContext) {
  ipcMain.handle('notes:usersList', async () => {
    return await notesUsersList(ctx.sysDb, ctx.mgr.getApiBaseUrl());
  });

  ipcMain.handle('notes:list', async () => {
    return await notesList(ctx.dataDb());
  });

  ipcMain.handle('notes:upsert', async (_e, args) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'notes disabled in backup mode' };
    return await notesUpsert(ctx.dataDb(), args);
  });

  ipcMain.handle('notes:delete', async (_e, args) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'notes disabled in backup mode' };
    return await notesDelete(ctx.dataDb(), args);
  });

  ipcMain.handle('notes:share', async (_e, args) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'notes disabled in backup mode' };
    return await notesShare(ctx.dataDb(), args);
  });

  ipcMain.handle('notes:unshare', async (_e, args) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'notes disabled in backup mode' };
    return await notesUnshare(ctx.dataDb(), args);
  });

  ipcMain.handle('notes:hide', async (_e, args) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'notes disabled in backup mode' };
    return await notesHide(ctx.dataDb(), args);
  });

  ipcMain.handle('notes:reorder', async (_e, args) => {
    if (ctx.mode().mode !== 'live') return { ok: false as const, error: 'notes disabled in backup mode' };
    return await notesReorder(ctx.dataDb(), args);
  });

  ipcMain.handle('notes:burningCount', async () => {
    return await notesBurningCount(ctx.dataDb());
  });
}
