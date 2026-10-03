import { ipcMain } from 'electron';
import { eq } from 'drizzle-orm';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { httpAuthed } from '../../services/httpClient.js';
import { erpCounterparties } from '../../database/schema.js';

type Err = { ok: false; error: string };

function base(ctx: IpcContext): string {
  return ctx.mgr.getApiBaseUrl();
}

function toResult<T>(r: { ok: boolean; status: number; json?: unknown; text?: string }): T | Err {
  if (r.ok && r.json && typeof r.json === 'object') return r.json as T;
  if (r.ok) return { ok: true } as unknown as T;
  const errPayload = r.json as { error?: unknown } | null;
  const msg = (errPayload && typeof errPayload.error === 'string' ? errPayload.error : r.text) || `HTTP ${r.status}`;
  return { ok: false, error: String(msg) };
}

type StrictRow = {
  id: string;
  name: string;
  short_name: string | null;
  inn: string | null;
  kpp: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  created_at?: number;
  updated_at?: number;
};

/**
 * Write-through в локальную реплику: дверь пишет на сервер, а карточка читает
 * реплику — без этого экран показывал бы старое до ближайшего pull. Строка
 * помечается SYNCED (не pending): серверную запись уже развозит публикатор
 * словарей, а клиентский пуш этой таблицы отбивается server-managed backstop'ом —
 * pending висел бы в очереди вечно. Приехавший pull перезаписывает строку тем же
 * содержимым; конкурентная правка с другой машины — тоже pull'ом. Дырка одна:
 * сервер принял запись, но публикатор её не разобрал — тогда pull не приедет;
 * за этим следит приёмка публикатора (daily-лог `dictionaries published`).
 */
async function upsertLocal(
  ctx: IpcContext,
  row: StrictRow,
): Promise<void> {
  const now = Date.now();
  const values = {
    id: String(row.id),
    name: String(row.name ?? ''),
    shortName: row.short_name ?? null,
    inn: row.inn ?? null,
    kpp: row.kpp ?? null,
    address: row.address ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    createdAt: Number(row.created_at ?? now),
    updatedAt: Number(row.updated_at ?? now),
    lastServerSeq: null,
    deletedAt: null,
    syncStatus: 'synced',
  };
  await ctx
    .dataDb()
    .insert(erpCounterparties)
    .values(values)
    .onConflictDoUpdate({
      target: erpCounterparties.id,
      set: {
        name: values.name,
        shortName: values.shortName,
        inn: values.inn,
        kpp: values.kpp,
        address: values.address,
        phone: values.phone,
        email: values.email,
        updatedAt: values.updatedAt,
        lastServerSeq: values.lastServerSeq,
        deletedAt: values.deletedAt,
        syncStatus: values.syncStatus,
      },
    });
}

/**
 * Контрагенты — строгая реплика + REST-двери (план contract-cutover-2026-10, C2).
 * Чтение — локальная реплика (офлайн работает), запись — серверная дверь
 * (офис по сети; офлайн-правка отклоняется честной ошибкой, как у доступов R2).
 * Гейты — те же, что у прежнего пути через карточку (`masterdata.view/edit`);
 * сервер требует `contracts.edit`. Секция «Договоры» — префиксом `contracts:`.
 */
export function registerContractsIpc(ctx: IpcContext) {
  ipcMain.handle('contracts:counterparty:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as Err;
    try {
      const rows = await ctx
        .dataDb()
        .select()
        .from(erpCounterparties)
        .where(eq(erpCounterparties.id, String(id ?? '')))
        .limit(1);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row || row.deletedAt != null) return { ok: true as const, row: null };
      return {
        ok: true as const,
        row: {
          id: String(row.id),
          name: String(row.name ?? ''),
          short_name: (row.shortName as string | null) ?? null,
          inn: (row.inn as string | null) ?? null,
          kpp: (row.kpp as string | null) ?? null,
          address: (row.address as string | null) ?? null,
          phone: (row.phone as string | null) ?? null,
          email: (row.email as string | null) ?? null,
          updated_at: Number(row.updatedAt ?? 0),
        },
      };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle('contracts:counterparty:save', async (_e, args: { id: string; fields: Record<string, unknown> }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as Err;
    try {
      const id = String(args?.id ?? '').trim();
      if (!id) return { ok: false as const, error: 'пустой id контрагента' };
      const fields = (args?.fields ?? {}) as Record<string, unknown>;
      const existing = await toResult<{ ok: boolean; row?: unknown }>(
        await httpAuthed(ctx.sysDb, base(ctx), `/counterparties/${encodeURIComponent(id)}`, { method: 'GET' }),
      );
      let saved: { ok: boolean; row?: StrictRow; error?: string };
      if ((existing as { ok?: boolean }).ok) {
        saved = (await toResult(
          await httpAuthed(ctx.sysDb, base(ctx), `/counterparties/${encodeURIComponent(id)}/patch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fields),
          }),
        )) as typeof saved;
      } else {
        saved = (await toResult(
          await httpAuthed(ctx.sysDb, base(ctx), '/counterparties', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, ...fields }),
          }),
        )) as typeof saved;
      }
      if (saved.ok && saved.row) await upsertLocal(ctx, saved.row);
      return saved;
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle('contracts:counterparty:create', async (_e, args: { id?: string; fields: Record<string, unknown> }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as Err;
    try {
      const body = { ...(args?.fields ?? {}), ...(args?.id ? { id: String(args.id) } : {}) };
      // Find-or-create по точному имени (нужен quickCreate из карточки договора):
      // EAV-проверка дублей в renderer новые strict-строки не видит.
      const wanted = String((body as Record<string, unknown>).name ?? '').trim().toLowerCase();
      if (wanted && !body.id) {
        const known = (await ctx.dataDb().select().from(erpCounterparties)) as Array<Record<string, unknown>>;
        const hit = known.find((r) => r.deletedAt == null && String(r.name ?? '').trim().toLowerCase() === wanted);
        if (hit) {
          return {
            ok: true as const,
            existing: true as const,
            row: {
              id: String(hit.id),
              name: String(hit.name ?? ''),
              short_name: (hit.shortName as string | null) ?? null,
              inn: (hit.inn as string | null) ?? null,
              kpp: (hit.kpp as string | null) ?? null,
              address: (hit.address as string | null) ?? null,
              phone: (hit.phone as string | null) ?? null,
              email: (hit.email as string | null) ?? null,
              updated_at: Number(hit.updatedAt ?? 0),
            },
          };
        }
      }
      const saved = (await toResult(
        await httpAuthed(ctx.sysDb, base(ctx), '/counterparties', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )) as { ok: boolean; row?: StrictRow; error?: string };
      if (saved.ok && saved.row) await upsertLocal(ctx, saved.row);
      return saved;
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}
