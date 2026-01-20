import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { SupplyRequestPayload, SupplyRequestStatus } from '@matricarmz/shared';
import { SystemIds } from '@matricarmz/shared';

import { auditLog, operations } from '../database/schema.js';

// Важно: engine_entity_id в sync контракте — UUID. Для заявок используем фиксированный UUID “контейнера”.
const SUPPLY_REQUESTS_CONTAINER_ID = SystemIds.SupplyRequestsContainerEntityId;
const SUPPLY_REQUESTS_OPERATION_TYPE = 'supply_request';

function nowMs() {
  return Date.now();
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeSearch(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function monthKeyFromMs(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function audit(db: BetterSQLite3Database, actor: string, action: string, payload: any) {
  const ts = nowMs();
  await db.insert(auditLog).values({
    id: randomUUID(),
    actor,
    action,
    entityId: payload?.operationId ? String(payload.operationId) : null,
    tableName: 'operations',
    payloadJson: JSON.stringify(payload ?? null),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
}

export async function listSupplyRequests(
  db: BetterSQLite3Database,
  args?: { q?: string; month?: string },
): Promise<
  | {
      ok: true;
      requests: {
        id: string;
        requestNumber: string;
        compiledAt: number;
        status: SupplyRequestStatus;
        title: string;
        departmentId: string;
        workshopId: string | null;
        sectionId: string | null;
        updatedAt: number;
      }[];
    }
  | { ok: false; error: string }
> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.engineEntityId, SUPPLY_REQUESTS_CONTAINER_ID),
          eq(operations.operationType, SUPPLY_REQUESTS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .orderBy(desc(operations.updatedAt))
      .limit(3000);

    const qNorm = args?.q ? normalizeSearch(args.q) : '';
    const month = args?.month ? String(args.month).trim() : '';

    const out: any[] = [];
    for (const r of rows as any[]) {
      const raw = r.metaJson ? String(r.metaJson) : '';
      if (!raw) continue;
      const parsed = safeJsonParse(raw) as any;
      if (!parsed || typeof parsed !== 'object' || parsed.kind !== 'supply_request') continue;

      const compiledAt = Number(parsed.compiledAt ?? r.performedAt ?? r.createdAt);
      const mKey = Number.isFinite(compiledAt) ? monthKeyFromMs(compiledAt) : '';
      if (month && mKey !== month) continue;

      const title = String(parsed.title ?? r.note ?? '');
      const requestNumber = String(parsed.requestNumber ?? '');
      const hay = qNorm
        ? normalizeSearch(
            [
              requestNumber,
              title,
              r.note ?? '',
              JSON.stringify(parsed.items ?? []),
              JSON.stringify(parsed.auditTrail ?? []),
            ].join(' '),
          )
        : '';
      if (qNorm && !hay.includes(qNorm)) continue;

      out.push({
        id: String(r.id),
        requestNumber,
        compiledAt: Number.isFinite(compiledAt) ? compiledAt : Number(r.createdAt),
        status: String(parsed.status ?? r.status ?? 'draft') as SupplyRequestStatus,
        title,
        departmentId: String(parsed.departmentId ?? ''),
        workshopId: parsed.workshopId ? String(parsed.workshopId) : null,
        sectionId: parsed.sectionId ? String(parsed.sectionId) : null,
        updatedAt: Number(r.updatedAt),
      });
    }

    return { ok: true as const, requests: out };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function getSupplyRequest(
  db: BetterSQLite3Database,
  id: string,
): Promise<{ ok: true; payload: SupplyRequestPayload } | { ok: false; error: string }> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.id, id),
          eq(operations.engineEntityId, SUPPLY_REQUESTS_CONTAINER_ID),
          eq(operations.operationType, SUPPLY_REQUESTS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .limit(1);
    const r = (rows as any[])[0];
    if (!r) return { ok: false as const, error: 'Заявка не найдена' };
    const parsed = safeJsonParse(String(r.metaJson ?? '')) as any;
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== 'supply_request') return { ok: false as const, error: 'Некорректный metaJson' };
    return { ok: true as const, payload: parsed as SupplyRequestPayload };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

async function nextRequestNumber(db: BetterSQLite3Database, compiledAt: number): Promise<string> {
  const d = new Date(compiledAt);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const prefix = `Z-${y}-${m}-${day}-`;

  // берем последние записи и ищем максимум суффикса по текущей дате
  const rows = await db
    .select({ metaJson: operations.metaJson })
    .from(operations)
    .where(
      and(
        eq(operations.engineEntityId, SUPPLY_REQUESTS_CONTAINER_ID),
        eq(operations.operationType, SUPPLY_REQUESTS_OPERATION_TYPE),
        isNull(operations.deletedAt),
      ),
    )
    .orderBy(desc(operations.createdAt))
    .limit(500);

  let max = 0;
  for (const r of rows as any[]) {
    const parsed = r.metaJson ? (safeJsonParse(String(r.metaJson)) as any) : null;
    if (!parsed || parsed.kind !== 'supply_request') continue;
    const n = String(parsed.requestNumber ?? '');
    if (!n.startsWith(prefix)) continue;
    const suffix = n.slice(prefix.length);
    const num = Number(suffix);
    if (Number.isFinite(num)) max = Math.max(max, num);
  }

  const next = String(max + 1).padStart(4, '0');
  return `${prefix}${next}`;
}

export async function createSupplyRequest(
  db: BetterSQLite3Database,
  actor: string,
): Promise<{ ok: true; id: string; payload: SupplyRequestPayload } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const id = randomUUID();
    const requestNumber = await nextRequestNumber(db, ts);

    const payload: SupplyRequestPayload = {
      kind: 'supply_request',
      version: 2,
      operationId: id,
      requestNumber,
      compiledAt: ts,
      acceptedAt: null,
      fulfilledAt: null,
      title: '',
      status: 'draft',
      departmentId: '',
      workshopId: null,
      sectionId: null,
      items: [],
      signedByHead: null,
      approvedByDirector: null,
      acceptedBySupply: null,
      auditTrail: [{ at: ts, by: actor, action: 'create' }],
    };

    await db.insert(operations).values({
      id,
      engineEntityId: SUPPLY_REQUESTS_CONTAINER_ID,
      operationType: SUPPLY_REQUESTS_OPERATION_TYPE,
      status: payload.status,
      note: payload.title || `Заявка ${payload.requestNumber}`,
      performedAt: payload.compiledAt,
      performedBy: actor?.trim() ? actor.trim() : 'local',
      metaJson: JSON.stringify(payload),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });

    await audit(db, actor, 'supply_request.create', payload);
    return { ok: true as const, id, payload };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function deleteSupplyRequest(db: BetterSQLite3Database, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const rows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.id, id),
          eq(operations.engineEntityId, SUPPLY_REQUESTS_CONTAINER_ID),
          eq(operations.operationType, SUPPLY_REQUESTS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) return { ok: false, error: 'Заявка не найдена' };

    const parsed = safeJsonParse(String((rows as any[])[0]?.metaJson ?? '')) as any;
    const actor = String((rows as any[])[0]?.performedBy ?? '').trim() || 'local';

    await db
      .update(operations)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' })
      .where(eq(operations.id, id));

    await audit(db, actor, 'supply_request.delete', parsed && typeof parsed === 'object' ? parsed : { operationId: id });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function updateSupplyRequest(
  db: BetterSQLite3Database,
  args: { id: string; payload: SupplyRequestPayload; actor: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const note = args.payload.title?.trim()
      ? `Заявка ${args.payload.requestNumber}: ${args.payload.title.trim()}`
      : `Заявка ${args.payload.requestNumber}`;

    const payload = {
      ...args.payload,
      operationId: args.id,
      auditTrail: [...(args.payload.auditTrail ?? []), { at: ts, by: args.actor, action: 'update' }],
    } satisfies SupplyRequestPayload;

    await db
      .update(operations)
      .set({
        status: payload.status,
        note,
        performedAt: payload.compiledAt,
        metaJson: JSON.stringify(payload),
        updatedAt: ts,
        syncStatus: 'pending',
      })
      .where(
        and(
          eq(operations.id, args.id),
          eq(operations.engineEntityId, SUPPLY_REQUESTS_CONTAINER_ID),
          eq(operations.operationType, SUPPLY_REQUESTS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      );
    // IMPORTANT: do NOT write audit_log on each autosave/update.
    // SupplyRequestDetailsPage autosaves frequently; high-level audit is recorded
    // when the user finishes editing / changes status / deletes the request.
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function transitionSupplyRequest(
  db: BetterSQLite3Database,
  args: { id: string; action: 'sign' | 'director_approve' | 'accept' | 'fulfill_full' | 'fulfill_partial'; actor: string; note?: string | null },
): Promise<{ ok: true; payload: SupplyRequestPayload } | { ok: false; error: string }> {
  try {
    const cur = await getSupplyRequest(db, args.id);
    if (!cur.ok) return cur;
    const ts = nowMs();

    const p = { ...cur.payload };
    const auditTrail = [...(p.auditTrail ?? [])];
    const addTrail = (action: string) => auditTrail.push({ at: ts, by: args.actor, action, note: args.note ?? null });

    const sig = { username: args.actor, signedAt: ts };

    switch (args.action) {
      case 'sign': {
        if (p.status !== 'draft') return { ok: false as const, error: 'Можно подписать только заявку в статусе Черновик' };
        p.status = 'signed';
        p.signedByHead = sig;
        addTrail('sign');
        break;
      }
      case 'director_approve': {
        if (p.status !== 'signed') return { ok: false as const, error: 'Одобрение директора доступно только после подписи' };
        p.status = 'director_approved';
        p.approvedByDirector = sig;
        addTrail('director_approve');
        break;
      }
      case 'accept': {
        if (p.status !== 'director_approved') return { ok: false as const, error: 'Принять к исполнению можно только после одобрения директора' };
        p.status = 'accepted';
        p.acceptedAt = ts;
        p.acceptedBySupply = sig;
        addTrail('accept');
        break;
      }
      case 'fulfill_full': {
        if (p.status !== 'accepted') return { ok: false as const, error: 'Исполнение доступно только после принятия к исполнению' };
        p.status = 'fulfilled_full';
        p.fulfilledAt = ts;
        addTrail('fulfill_full');
        break;
      }
      case 'fulfill_partial': {
        if (p.status !== 'accepted') return { ok: false as const, error: 'Исполнение доступно только после принятия к исполнению' };
        p.status = 'fulfilled_partial';
        p.fulfilledAt = ts;
        addTrail('fulfill_partial');
        break;
      }
      default:
        return { ok: false as const, error: `unknown action: ${String((args as any).action)}` };
    }

    p.auditTrail = auditTrail;

    const upd = await updateSupplyRequest(db, { id: args.id, payload: p, actor: args.actor });
    if (!upd.ok) return upd;
    await audit(db, args.actor, 'supply_request.transition', {
      operationId: args.id,
      requestNumber: p.requestNumber,
      title: p.title ?? '',
      fromStatus: cur.payload.status,
      toStatus: p.status,
      action: args.action,
      note: args.note ?? null,
      departmentId: p.departmentId ?? '',
      workshopId: p.workshopId ?? null,
      sectionId: p.sectionId ?? null,
    });
    return { ok: true as const, payload: p };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}


