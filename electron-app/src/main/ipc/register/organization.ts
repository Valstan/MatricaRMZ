import { asc, desc, isNull } from 'drizzle-orm';
import { ipcMain } from 'electron';

import type { GiftRecordDto, GiftRecordSaveDto, OrgEventDto, OrgEventSaveDto } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, viewModeWriteError } from '../ipcContext.js';
import { erpGiftRecords, erpOrgEvents } from '../../database/schema.js';
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
 * Организационный модуль — клиентский контур.
 *
 * Мероприятия и журнал выдачи живут в pull-only реплике (`erp_org_events`,
 * `erp_gift_records`, владение server): чтение — из локальной SQLite. Запись —
 * только серверной дверью REST `/organization` (права `organization.view` / `.edit`
 * проверяет сервер).
 */
export function registerOrganizationIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle(
    'organization:list',
    async (): Promise<Result<{ events: OrgEventDto[]; gifts: GiftRecordDto[] }>> => {
      try {
        const db = ctx.dataDb();
        const events = await db
          .select()
          .from(erpOrgEvents)
          .where(isNull(erpOrgEvents.deletedAt))
          .orderBy(desc(erpOrgEvents.eventDate), asc(erpOrgEvents.title));
        const gifts = await db
          .select()
          .from(erpGiftRecords)
          .where(isNull(erpGiftRecords.deletedAt))
          .orderBy(desc(erpGiftRecords.givenAt), asc(erpGiftRecords.title));
        return {
          ok: true,
          events: events.map((r) => ({
            id: String(r.id),
            title: String(r.title),
            kind: String(r.kind),
            eventDate: r.eventDate == null ? null : Number(r.eventDate),
            description: String(r.description ?? ''),
            selectionsJson: r.selectionsJson == null ? null : String(r.selectionsJson),
            createdAt: Number(r.createdAt),
            updatedAt: Number(r.updatedAt),
          })),
          gifts: gifts.map((r) => ({
            id: String(r.id),
            eventId: r.eventId == null ? null : String(r.eventId),
            recipientKind: String(r.recipientKind),
            recipientEmployeeId: r.recipientEmployeeId == null ? null : String(r.recipientEmployeeId),
            recipientChildId: r.recipientChildId == null ? null : String(r.recipientChildId),
            kind: String(r.kind),
            title: String(r.title ?? ''),
            place: String(r.place ?? ''),
            givenAt: r.givenAt == null ? null : Number(r.givenAt),
            note: String(r.note ?? ''),
            createdAt: Number(r.createdAt),
            updatedAt: Number(r.updatedAt),
          })),
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  ipcMain.handle(
    'organization:saveEvent',
    async (_e, args: OrgEventSaveDto & { id?: string | null }): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const id = String(args?.id ?? '').trim();
      const body: Record<string, unknown> = {
        title: args?.title ?? '',
        kind: args?.kind ?? 'other',
        eventDate: args?.eventDate ?? null,
        description: args?.description ?? null,
        selections: args?.selections ?? [],
      };
      return toResult(
        await httpAuthed(ctx.sysDb, base(), id ? `/organization/events/${id}` : '/organization/events', {
          method: id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    },
  );

  ipcMain.handle(
    'organization:removeEvent',
    async (_e, id: string): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/organization/events/${String(id ?? '')}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
  );

  ipcMain.handle(
    'organization:saveGift',
    async (_e, args: GiftRecordSaveDto & { id?: string | null }): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const id = String(args?.id ?? '').trim();
      const body: Record<string, unknown> = {
        eventId: args?.eventId ?? null,
        recipientKind: args?.recipientKind ?? 'child',
        recipientEmployeeId: args?.recipientEmployeeId ?? null,
        recipientChildId: args?.recipientChildId ?? null,
        kind: args?.kind ?? 'gift',
        title: args?.title ?? '',
        place: args?.place ?? '',
        givenAt: args?.givenAt ?? null,
        note: args?.note ?? null,
      };
      return toResult(
        await httpAuthed(ctx.sysDb, base(), id ? `/organization/gifts/${id}` : '/organization/gifts', {
          method: id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    },
  );

  ipcMain.handle(
    'organization:removeGift',
    async (_e, id: string): Promise<Result<{ id: string }>> => {
      if (isViewMode(ctx)) return viewModeWriteError();
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/organization/gifts/${String(id ?? '')}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
  );
}
