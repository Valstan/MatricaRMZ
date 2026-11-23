import { ipcMain } from 'electron';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { httpAuthed } from '../../services/httpClient.js';
import { httpFailureText } from '../../services/httpFailureText.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

function toResult<T>(r: { ok: boolean; status: number; json?: unknown; text?: string }): Result<T> {
  if (r.ok && r.json && typeof r.json === 'object') return r.json as Result<T>;
  if (r.ok) return { ok: true } as Ok<T>;
  const msg = httpFailureText(r);
  return { ok: false, error: String(msg) };
}

/**
 * Модуль печатных форм — клиентский контур.
 *
 * Шаблоны и документы живут на сервере (таблицы вне sync-контракта), поэтому клиент
 * ходит по REST — так же, как за шаблонами печати СИЗ. Читать шаблоны может всякий,
 * кто печатает (`print_forms.view`); править свой личный — `print_forms.edit`.
 */
export function registerPrintFormsIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle(
    'printForms:templates:list',
    async (_e, args: { entityKey?: string }): Promise<Result<{ rows: unknown[] }>> => {
      const gate = await requirePermOrResult(ctx, 'print_forms.view');
      if (!gate.ok) return gate as Err;
      const qs = new URLSearchParams();
      const entityKey = String(args?.entityKey ?? '').trim();
      if (entityKey) qs.set('entityKey', entityKey);
      const suffix = qs.toString();
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/print-forms/templates${suffix ? `?${suffix}` : ''}`, {
          method: 'GET',
        }),
      );
    },
  );

  ipcMain.handle(
    'printForms:templates:save',
    async (
      _e,
      args: {
        id?: string;
        ownerId?: 'shared' | 'personal';
        entityKey: string;
        formKey?: string;
        name: string;
        layoutJson: string;
        isDefault?: boolean;
      },
    ): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'print_forms.edit');
      if (!gate.ok) return gate as Err;
      return toResult(
        await httpAuthed(ctx.sysDb, base(), '/print-forms/templates', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args ?? {}),
        }),
      );
    },
  );

  ipcMain.handle(
    'printForms:templates:delete',
    async (_e, id: string): Promise<Result<{ deleted: true }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'print_forms.edit');
      if (!gate.ok) return gate as Err;
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/print-forms/templates/${encodeURIComponent(String(id || ''))}`, {
          method: 'DELETE',
        }),
      );
    },
  );

  ipcMain.handle(
    'printForms:documents:list',
    async (_e, args: { scope?: 'inbox' | 'sent' | 'drafts' }): Promise<Result<{ rows: unknown[] }>> => {
      const qs = new URLSearchParams({ scope: String(args?.scope ?? 'inbox') });
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/print-forms/documents?${qs.toString()}`, { method: 'GET' }),
      );
    },
  );

  ipcMain.handle(
    'printForms:documents:incomingCount',
    async (): Promise<Result<{ count: number }>> =>
      toResult(
        await httpAuthed(ctx.sysDb, base(), '/print-forms/documents/incoming-count', { method: 'GET' }),
      ),
  );

  ipcMain.handle(
    'printForms:documents:create',
    async (
      _e,
      args: {
        entityKey: string;
        formKey?: string;
        templateId?: string | null;
        title: string;
        valuesJson?: string;
        layoutJson?: string;
        note?: string;
      },
    ): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      return toResult(
        await httpAuthed(ctx.sysDb, base(), '/print-forms/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args ?? {}),
        }),
      );
    },
  );

  ipcMain.handle(
    'printForms:documents:send',
    async (
      _e,
      args: { id: string; recipientId?: string | null; recipientUsername: string; note?: string },
    ): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const id = String(args?.id ?? '');
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/print-forms/documents/${encodeURIComponent(id)}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipientId: args?.recipientId ?? null,
            recipientUsername: args?.recipientUsername ?? '',
            note: args?.note ?? '',
          }),
        }),
      );
    },
  );

  ipcMain.handle(
    'printForms:documents:decide',
    async (
      _e,
      args: { id: string; decision: 'accepted' | 'rejected'; note?: string },
    ): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const id = String(args?.id ?? '');
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/print-forms/documents/${encodeURIComponent(id)}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: args?.decision, note: args?.note ?? '' }),
        }),
      );
    },
  );

  ipcMain.handle(
    'printForms:documents:delete',
    async (_e, id: string): Promise<Result<{ deleted: true }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/print-forms/documents/${encodeURIComponent(String(id || ''))}`, {
          method: 'DELETE',
        }),
      );
    },
  );
}
