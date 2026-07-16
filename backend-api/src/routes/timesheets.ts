import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  addTimesheetRows,
  createTimesheet,
  deleteTimesheet,
  getTimesheet,
  listTimesheetCodes,
  listTimesheetDepartments,
  listTimesheets,
  removeTimesheetRow,
  reorderTimesheetRows,
  setTimesheetCells,
  updateTimesheet,
} from '../services/timesheetService.js';

export const timesheetsRouter = Router();
timesheetsRouter.use(requireAuth);

const actorOf = (req: unknown): string | null => {
  const u = (req as { user?: { username?: string } }).user;
  return u?.username?.trim() ? u.username.trim() : null;
};

// GET /codes — справочник кодов Т-13 (для палитры). Раньше /:id, иначе перехватит.
timesheetsRouter.get('/codes', requirePermission(PermissionCode.TimesheetView), async (_req, res) => {
  const r = await listTimesheetCodes();
  return res.status(r.ok ? 200 : 400).json(r);
});

// GET /departments — подразделения для выбора области табеля (под timesheet-правами, не HR).
// Тоже до /:id, иначе :id перехватит "departments".
timesheetsRouter.get('/departments', requirePermission(PermissionCode.TimesheetView), async (_req, res) => {
  const r = await listTimesheetDepartments();
  return res.status(r.ok ? 200 : 400).json(r);
});

timesheetsRouter.get('/', requirePermission(PermissionCode.TimesheetView), async (req, res) => {
  const r = await listTimesheets({
    ...(typeof req.query.workshopId === 'string' && req.query.workshopId ? { workshopId: req.query.workshopId } : {}),
    ...(typeof req.query.departmentId === 'string' && req.query.departmentId ? { departmentId: req.query.departmentId } : {}),
    ...(req.query.year ? { year: Number(req.query.year) } : {}),
    actor: actorOf(req),
  });
  return res.status(r.ok ? 200 : 400).json(r);
});

timesheetsRouter.post('/', requirePermission(PermissionCode.TimesheetEdit), async (req, res) => {
  // Scope = workshop XOR department (exactly one). Department-scoped timesheets cover org
  // units like ОПП that are not цеха.
  const schema = z
    .object({
      workshopId: z.string().uuid().optional(),
      departmentId: z.string().uuid().optional(),
      year: z.number().int().min(2000).max(2100),
      month: z.number().int().min(1).max(12),
      weekMode: z.union([z.literal(5), z.literal(6)]).optional(),
      shiftHours: z.number().positive().max(24).optional(),
    })
    .refine((d) => !!d.workshopId !== !!d.departmentId, {
      message: 'Укажите ровно одну область табеля: цех или подразделение',
    });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const r = await createTimesheet({
    ...(parsed.data.workshopId !== undefined ? { workshopId: parsed.data.workshopId } : {}),
    ...(parsed.data.departmentId !== undefined ? { departmentId: parsed.data.departmentId } : {}),
    year: parsed.data.year,
    month: parsed.data.month,
    ...(parsed.data.weekMode !== undefined ? { weekMode: parsed.data.weekMode } : {}),
    ...(parsed.data.shiftHours !== undefined ? { shiftHours: parsed.data.shiftHours } : {}),
    createdBy: actorOf(req),
  });
  return res.status(r.ok ? 200 : 400).json(r);
});

timesheetsRouter.get('/:id', requirePermission(PermissionCode.TimesheetView), async (req, res) => {
  const r = await getTimesheet(String(req.params.id || ''), actorOf(req));
  return res.status(r.ok ? 200 : 400).json(r);
});

timesheetsRouter.put('/:id', requirePermission(PermissionCode.TimesheetEdit), async (req, res) => {
  const schema = z.object({
    status: z.enum(['draft', 'closed']).optional(),
    weekMode: z.union([z.literal(5), z.literal(6)]).optional(),
    normHours: z.number().nullable().optional(),
    allowOthersEdit: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const r = await updateTimesheet({
    id: String(req.params.id || ''),
    actor: actorOf(req),
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.weekMode !== undefined ? { weekMode: parsed.data.weekMode } : {}),
    ...(parsed.data.normHours !== undefined ? { normHours: parsed.data.normHours } : {}),
    ...(parsed.data.allowOthersEdit !== undefined ? { allowOthersEdit: parsed.data.allowOthersEdit } : {}),
  });
  return res.status(r.ok ? 200 : 400).json(r);
});

timesheetsRouter.delete('/:id', requirePermission(PermissionCode.TimesheetEdit), async (req, res) => {
  const r = await deleteTimesheet({ id: String(req.params.id || ''), actor: actorOf(req) });
  return res.status(r.ok ? 200 : 400).json(r);
});

timesheetsRouter.post('/:id/rows', requirePermission(PermissionCode.TimesheetEdit), async (req, res) => {
  const schema = z.object({
    employees: z.array(
      z.object({ employeeId: z.string().uuid(), tabNumber: z.string().nullable().optional(), position: z.string().nullable().optional() }),
    ),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const r = await addTimesheetRows({
    timesheetId: String(req.params.id || ''),
    actor: actorOf(req),
    employees: parsed.data.employees.map((e) => ({
      employeeId: e.employeeId,
      ...(e.tabNumber !== undefined ? { tabNumber: e.tabNumber } : {}),
      ...(e.position !== undefined ? { position: e.position } : {}),
    })),
  });
  return res.status(r.ok ? 200 : 400).json(r);
});

timesheetsRouter.put('/:id/rows-order', requirePermission(PermissionCode.TimesheetEdit), async (req, res) => {
  const schema = z.object({ rowIds: z.array(z.string().uuid()).min(1).max(2_000) });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const r = await reorderTimesheetRows({ timesheetId: String(req.params.id || ''), rowIds: parsed.data.rowIds, actor: actorOf(req) });
  return res.status(r.ok ? 200 : 400).json(r);
});

timesheetsRouter.delete('/rows/:rowId', requirePermission(PermissionCode.TimesheetEdit), async (req, res) => {
  const r = await removeTimesheetRow({ rowId: String(req.params.rowId || ''), actor: actorOf(req) });
  return res.status(r.ok ? 200 : 400).json(r);
});

timesheetsRouter.put('/rows/:rowId/cells', requirePermission(PermissionCode.TimesheetEdit), async (req, res) => {
  const schema = z.object({
    cells: z.array(
      z.object({ day: z.number().int().min(1).max(31), code: z.string().nullable().optional(), hours: z.number().nullable().optional(), comment: z.string().nullable().optional() }),
    ),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const r = await setTimesheetCells({
    rowId: String(req.params.rowId || ''),
    actor: actorOf(req),
    cells: parsed.data.cells.map((c) => ({
      day: c.day,
      ...(c.code !== undefined ? { code: c.code } : {}),
      ...(c.hours !== undefined ? { hours: c.hours } : {}),
      ...(c.comment !== undefined ? { comment: c.comment } : {}),
    })),
  });
  return res.status(r.ok ? 200 : 400).json(r);
});
