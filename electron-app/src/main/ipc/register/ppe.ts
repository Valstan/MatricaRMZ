import { ipcMain } from 'electron';
import { isNull } from 'drizzle-orm';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import { httpAuthed } from '../../services/httpClient.js';
import { erpEmployeeCards } from '../../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

function toResult<T>(r: { ok: boolean; status: number; json?: unknown; text?: string }): Result<T> {
  if (r.ok && r.json && typeof r.json === 'object') return r.json as Result<T>;
  if (r.ok) return { ok: true } as Ok<T>;
  const errPayload = r.json as { error?: unknown } | null;
  const msg = (errPayload && typeof errPayload.error === 'string' ? errPayload.error : r.text) || `HTTP ${r.status}`;
  return { ok: false, error: String(msg) };
}

/**
 * Кладовщик (СИЗ) живёт только на сервере (REST `/ppe/*`), в реплику нормы и
 * карточки попадают pull'ом для отчётов, но UI читает/пишет напрямую — как
 * приказы о ценах (servicePricing.ts). Права те же, что у справочников ERP,
 * выдача — как проведение документа (создаёт и сразу проводит stock_issue).
 */
export function registerPpeIpc(ctx: IpcContext) {
  const base = () => ctx.mgr.getApiBaseUrl();

  ipcMain.handle('ppe:norms:list', async (_e, args?: { postTitle?: string; gender?: string; season?: string }) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    const params = new URLSearchParams();
    if (args?.postTitle) params.set('postTitle', args.postTitle);
    if (args?.gender) params.set('gender', args.gender);
    if (args?.season) params.set('season', args.season);
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/norms${qs}`, { method: 'GET' }));
  });

  ipcMain.handle('ppe:norms:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/norms/${encodeURIComponent(String(id || ''))}`, { method: 'GET' }));
  });

  ipcMain.handle(
    'ppe:norms:upsert',
    async (
      _e,
      args: {
        id?: string;
        name: string;
        postTitle?: string | null;
        departmentId?: string | null;
        gender?: 'M' | 'F' | null;
        season?: 'winter' | 'summer' | null;
        isDuty?: boolean;
        validFrom?: number;
        validTo?: number | null;
        lines: Array<{ nomenclatureId: string; qty: number; wearMonths: number }>;
      },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
      if (!gate.ok) return gate as Err;
      return toResult(
        await httpAuthed(ctx.sysDb, base(), '/ppe/norms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        }),
      );
    },
  );

  ipcMain.handle('ppe:cards:open', async (_e, args: { employeeId: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(
      await httpAuthed(ctx.sysDb, base(), '/ppe/cards/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      }),
    );
  });

  ipcMain.handle('ppe:cards:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/cards/${encodeURIComponent(String(id || ''))}`, { method: 'GET' }));
  });

  // Список карточек СИЗ — строка на сотрудника (а не на карточку): считает сервер, чтобы
  // «пора выдавать» в списке и в карточке шло из одного ядра (shared/ppe).
  ipcMain.handle('ppe:cards:overview', async () => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), '/ppe/cards/overview', { method: 'GET' }));
  });

  ipcMain.handle('ppe:cards:byEmployee', async (_e, employeeId: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(
      await httpAuthed(ctx.sysDb, base(), `/ppe/cards/by-employee/${encodeURIComponent(String(employeeId || ''))}`, { method: 'GET' }),
    );
  });

  ipcMain.handle('ppe:cards:assignNorms', async (_e, args: { cardId: string; normSetIds: string[] }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(
      await httpAuthed(ctx.sysDb, base(), `/ppe/cards/${encodeURIComponent(String(args?.cardId || ''))}/norms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normSetIds: args?.normSetIds ?? [] }),
      }),
    );
  });

  ipcMain.handle('ppe:cards:close', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(
      await httpAuthed(ctx.sysDb, base(), `/ppe/cards/${encodeURIComponent(String(id || ''))}/close`, { method: 'POST' }),
    );
  });

  ipcMain.handle(
    'ppe:cards:issue',
    async (_e, args: { cardId: string; warehouseId: string; docNo?: string; lines: Array<{ nomenclatureId: string; qty: number }> }) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'erp.documents.post');
      if (!gate.ok) return gate as Err;
      return toResult(
        await httpAuthed(ctx.sysDb, base(), `/ppe/cards/${encodeURIComponent(String(args?.cardId || ''))}/issue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ warehouseId: args?.warehouseId, docNo: args?.docNo, lines: args?.lines ?? [] }),
        }),
      );
    },
  );

  // ────────────────────────────────────────────────────────────
  // Фаза 2: отпуска, группы, коллективная выдача, дежурные, импорт.
  // Гейты повторяют REST-роуты: чтение — view справочников, правка — edit,
  // выдача документом — проведение документов.
  // ────────────────────────────────────────────────────────────

  function postJson(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') {
    return httpAuthed(ctx.sysDb, base(), path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  ipcMain.handle('ppe:absences:list', async (_e, args?: { employeeId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    const qs = args?.employeeId ? `?employeeId=${encodeURIComponent(args.employeeId)}` : '';
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/absences${qs}`, { method: 'GET' }));
  });

  ipcMain.handle('ppe:absences:create', async (_e, args: { employeeId: string; fromMs: number; toMs: number; kind?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await postJson('/ppe/absences', args));
  });

  ipcMain.handle('ppe:absences:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/absences/${encodeURIComponent(String(id || ''))}`, { method: 'DELETE' }));
  });

  ipcMain.handle('ppe:groups:list', async () => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), '/ppe/groups', { method: 'GET' }));
  });

  ipcMain.handle('ppe:groups:create', async (_e, args: { name: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await postJson('/ppe/groups', args));
  });

  ipcMain.handle('ppe:groups:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/groups/${encodeURIComponent(String(id || ''))}`, { method: 'DELETE' }));
  });

  ipcMain.handle('ppe:groups:members:get', async (_e, groupId: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/groups/${encodeURIComponent(String(groupId || ''))}/members`, { method: 'GET' }));
  });

  ipcMain.handle('ppe:groups:members:set', async (_e, args: { groupId: string; employeeIds: string[] }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await postJson(`/ppe/groups/${encodeURIComponent(String(args?.groupId || ''))}/members`, { employeeIds: args?.employeeIds ?? [] }, 'PUT'));
  });

  ipcMain.handle('ppe:groups:norms:get', async (_e, groupId: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/groups/${encodeURIComponent(String(groupId || ''))}/norms`, { method: 'GET' }));
  });

  ipcMain.handle('ppe:groups:norms:set', async (_e, args: { groupId: string; normSetIds: string[] }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await postJson(`/ppe/groups/${encodeURIComponent(String(args?.groupId || ''))}/norms`, { normSetIds: args?.normSetIds ?? [] }, 'PUT'));
  });

  ipcMain.handle('ppe:employees:normSets', async (_e, employeeId: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/employees/${encodeURIComponent(String(employeeId || ''))}/norm-sets`, { method: 'GET' }));
  });

  // Сотрудники СИЗ (PR-6) — из реплики `erp_employee_cards`, не из EAV-списка
  // `employees:list`: строгая серверная дверь модуля знает только эти id, и карточка,
  // открытая на EAV-сотруднике, падала бы «Сотрудник не найден» уже при выдаче.
  // Реплика — тот же источник, что у отчётов СИЗ: имя в отчёте и в пикере совпадает.
  ipcMain.handle('ppe:employees:list', async () => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    try {
      const rows = await ctx
        .dataDb()
        .select({
          id: erpEmployeeCards.id,
          fullName: erpEmployeeCards.fullName,
          personnelNo: erpEmployeeCards.personnelNo,
          roleCode: erpEmployeeCards.roleCode,
          isActive: erpEmployeeCards.isActive,
        })
        .from(erpEmployeeCards)
        .where(isNull(erpEmployeeCards.deletedAt))
        .orderBy(erpEmployeeCards.fullName);
      return { ok: true as const, employees: rows.map((r) => ({ ...r, id: String(r.id), fullName: String(r.fullName) })) };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle('ppe:collectives:list', async (_e, args?: { departmentId?: string }) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    const qs = args?.departmentId ? `?departmentId=${encodeURIComponent(args.departmentId)}` : '';
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/collectives${qs}`, { method: 'GET' }));
  });

  ipcMain.handle('ppe:collectives:get', async (_e, id: string) => {
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
    if (!gate.ok) return gate as Err;
    return toResult(await httpAuthed(ctx.sysDb, base(), `/ppe/collectives/${encodeURIComponent(String(id || ''))}`, { method: 'GET' }));
  });

  ipcMain.handle(
    'ppe:collectives:open',
    async (
      _e,
      args: { id?: string; departmentId: string; warehouseId: string; lines?: Array<{ employeeId: string; nomenclatureId: string; qty: number }> },
    ) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
      if (!gate.ok) return gate as Err;
      return toResult(await postJson('/ppe/collectives', args));
    },
  );

  ipcMain.handle('ppe:collectives:distribute', async (_e, args: { collectiveId: string; docNo?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.documents.post');
    if (!gate.ok) return gate as Err;
    return toResult(await postJson(`/ppe/collectives/${encodeURIComponent(String(args?.collectiveId || ''))}/distribute`, { docNo: args?.docNo }));
  });

  ipcMain.handle('ppe:collectives:close', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await postJson(`/ppe/collectives/${encodeURIComponent(String(id || ''))}/close`, {}));
  });

  ipcMain.handle('ppe:duty:issue', async (_e, args: { normSetId: string; warehouseId: string; docNo?: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.documents.post');
    if (!gate.ok) return gate as Err;
    return toResult(await postJson('/ppe/duty/issue', args));
  });

  ipcMain.handle('ppe:import:preview', async (_e, args: { filename: string; contentBase64: string }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    return toResult(await postJson('/ppe/import/preview', args));
  });

  ipcMain.handle('ppe:import:apply', async (_e, args: { previewId: string; contentBase64: string; dryRun?: boolean }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'erp.dictionary.edit');
    if (!gate.ok) return gate as Err;
    const result = await toResult<{ imported?: number; created?: number; updated?: number }>(await postJson('/ppe/import/apply', args));
    // Импорт ЗУП заводит сотрудников; primary доводит их до журнала пинком публикатора,
    // а клиент ждёт прогон сразу — иначе страницы СИЗ до ближайшего тика видели бы пустые
    // пикеры. Ждём, а не запускаем в фоне (образец — afterNomenclatureWrite в erp.ts);
    // ошибка синка не отменяет удавшийся импорт.
    if (result.ok && args?.dryRun !== true) await ctx.mgr.runOnce().catch(() => undefined);
    return result;
  });
}
