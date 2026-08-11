// Вложения на планшете (Ф-развитие плана android-tablet-client-2026-08).
//
// Десктопный register/files.ts переиспользовать нельзя: он весь построен вокруг
// ПУТЕЙ на диске — файловые диалоги, кэш скачивания, печать через offscreen-окно,
// открытие Проводника. У WebView ничего этого нет. Поэтому здесь — узкий набор
// каналов поверх того же REST API, что и на десктопе: превью, оригинал, загрузка
// из Blob (из галереи, файлов или камеры) и удаление. Остальные files:*-каналы
// намеренно не регистрируются — шим ответит мягким «недоступно на планшете».
import { getSession } from '../../../electron-app/src/main/services/authService.js';
import { httpAuthed } from '../../../electron-app/src/main/services/httpClient.js';
import type { IpcContext } from '../../../electron-app/src/main/ipc/ipcContext.js';
import { requirePermOrResult } from '../../../electron-app/src/main/ipc/ipcContext.js';

import { ipcMain } from 'electron';

type FileRefLike = { id: string; name: string; size: number; mime?: string };

function formatHttpError(r: { status: number; json?: any; text?: string }): string {
  const reason = r.json?.error ?? r.text ?? '';
  return `HTTP ${r.status}${reason ? `: ${String(reason).slice(0, 200)}` : ''}`;
}

async function bytesToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const byte of buf) binary += String.fromCharCode(byte);
  const mime = blob.type || fallbackMime;
  return `data:${mime};base64,${btoa(binary)}`;
}

export function registerAndroidFilesIpc(ctx: IpcContext): void {
  const apiBase = () => ctx.mgr.getApiBaseUrl();

  // Превью — тот же эндпойнт, что и на десктопе: сервер отдаёт base64 миниатюры.
  ipcMain.handle('files:preview:get', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const fileId = String(args?.fileId || '').trim();
    if (!fileId) return { ok: false, error: 'fileId is empty' };
    const r = await httpAuthed(ctx.sysDb, apiBase(), `/files/${encodeURIComponent(fileId)}/preview`, { method: 'GET' }, { timeoutMs: 30_000 });
    if (!r.ok) return { ok: false, error: `preview ${formatHttpError(r)}` };
    const p = r.json?.preview as { mime?: string; dataBase64?: string } | null | undefined;
    if (!p?.dataBase64) return { ok: true, dataUrl: null };
    return { ok: true, dataUrl: `data:${String(p.mime || 'image/png')};base64,${p.dataBase64}` };
  });

  // Оригинал. Кэша на диске у планшета нет — тянем в память и отдаём data:URL.
  // Яндекс-файлы качаются по подписанной ссылке напрямую, локальные — потоком
  // с backend'а (там нужен Authorization, поэтому берём токен из сессии; httpAuthed
  // выше уже обновил его при необходимости).
  ipcMain.handle('files:original:get', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.view');
    if (!gate.ok) return gate;
    const fileId = String(args?.fileId || '').trim();
    if (!fileId) return { ok: false, error: 'fileId is empty' };
    try {
      const metaRes = await httpAuthed(ctx.sysDb, apiBase(), `/files/${encodeURIComponent(fileId)}/meta`, { method: 'GET' });
      if (!metaRes.ok) return { ok: false, error: `meta ${formatHttpError(metaRes)}` };
      const meta = metaRes.json?.file as FileRefLike | undefined;

      const urlRes = await httpAuthed(ctx.sysDb, apiBase(), `/files/${encodeURIComponent(fileId)}/url`, { method: 'GET' });
      const directUrl = urlRes.ok ? (urlRes.json?.url as string | null | undefined) : null;
      if (directUrl) {
        const r = await fetch(directUrl);
        if (!r.ok) return { ok: false, error: `download HTTP ${r.status}` };
        return { ok: true, dataUrl: await bytesToDataUrl(await r.blob(), meta?.mime || 'application/octet-stream') };
      }

      const session = await getSession(ctx.sysDb).catch(() => null);
      if (!session?.accessToken) return { ok: false, error: 'нет сессии' };
      const base = String(apiBase()).replace(/\/+$/, '');
      const r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      if (!r.ok) return { ok: false, error: `download HTTP ${r.status}` };
      return { ok: true, dataUrl: await bytesToDataUrl(await r.blob(), meta?.mime || 'application/octet-stream') };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // Загрузка из Blob: планшет отдаёт содержимое base64 — пути к файлу у него нет.
  // Крупные файлы (>10 МБ) сервер сам уводит в Яндекс.Диск через /files/yandex/init;
  // на планшете такой сценарий пока не нужен — фото с камеры укладываются в лимит.
  ipcMain.handle(
    'files:uploadBlob',
    async (_e, args: { name: string; mime?: string; dataBase64: string; scope?: { ownerType: string; ownerId: string; category: string } }) => {
      const gate = await requirePermOrResult(ctx, 'files.upload');
      if (!gate.ok) return gate;
      const name = String(args?.name || '').trim();
      const dataBase64 = String(args?.dataBase64 || '');
      if (!name) return { ok: false, error: 'имя файла пустое' };
      if (!dataBase64) return { ok: false, error: 'файл пустой' };
      const r = await httpAuthed(
        ctx.sysDb,
        apiBase(),
        '/files/upload',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            mime: args?.mime ?? null,
            dataBase64,
            ...(args?.scope ? { scope: args.scope } : {}),
          }),
        },
        { timeoutMs: 120_000 },
      );
      if (!r.ok) return { ok: false, error: `upload ${formatHttpError(r)}` };
      if (!r.json?.ok || !r.json?.file) return { ok: false, error: 'bad upload response' };
      return { ok: true, file: r.json.file as FileRefLike };
    },
  );

  ipcMain.handle('files:delete', async (_e, args: { fileId: string }) => {
    const gate = await requirePermOrResult(ctx, 'files.delete');
    if (!gate.ok) return gate;
    const fileId = String(args?.fileId || '').trim();
    if (!fileId) return { ok: false, error: 'fileId is empty' };
    const r = await httpAuthed(ctx.sysDb, apiBase(), `/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    if (!r.ok) return { ok: false, error: `delete ${formatHttpError(r)}` };
    return { ok: true };
  });
}
