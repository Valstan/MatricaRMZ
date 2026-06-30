import { sql } from 'drizzle-orm';

import type {
  WorkshopEngineRoute,
  WorkshopEngineRouteStep,
  WorkshopStatsResult,
  WorkshopStatsRow,
} from '@matricarmz/shared';

import { db } from '../database/db.js';

const REPORT_TZ = 'Europe/Moscow';
const WORK_ORDER_OP_TYPE = 'work_order';
const MAX_ROUTE_ENGINES = 100;

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

function ymd(value: string | undefined, fallbackDaysAgo: number): string {
  const s = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.now() - fallbackDaysAgo * 86_400_000;
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ }).format(new Date(ms));
}

/**
 * Phase 0 «Статистика цехов»: per-workshop labor + engine passage from work orders.
 * The work order already stamps workshop + engine + labor at source, so this is a pure
 * read aggregation — zero migration, fills in as more workshops adopt order-writing.
 */
export async function getWorkshopStats(args?: {
  from?: string;
  to?: string;
  workshopId?: string;
}): Promise<Result<{ result: WorkshopStatsResult }>> {
  const from = ymd(args?.from, 365);
  const to = ymd(args?.to, 0);
  if (from > to) return { ok: false, error: 'Период задан неверно: «с» позже «по».' };
  const workshopId = String(args?.workshopId ?? '').trim() || null;
  const fromMs = Date.parse(`${from}T00:00:00+03:00`);
  const toMs = Date.parse(`${to}T23:59:59.999+03:00`);

  try {
    // Workshop id → name (all non-deleted, to label rows and count silent shops).
    const wsRows = await db.execute(sql`
      select id::text as id, name, is_active as active
      from directory_workshops
      where deleted_at is null
    `);
    const wsName = new Map<string, string>();
    let activeCount = 0;
    for (const r of wsRows.rows as Array<{ id: string; name: string | null; active: boolean }>) {
      wsName.set(String(r.id), String(r.name ?? '').trim() || '(без названия)');
      if (r.active) activeCount += 1;
    }

    // Per-workshop aggregate: orders (stages), distinct engines (passage), labor sum.
    const agg = await db.execute(sql`
      with wo as (
        select o.id, o.engine_entity_id,
               (o.meta_json::jsonb ->> 'workshopId') as workshop_id,
               coalesce((o.meta_json::jsonb ->> 'totalAmountRub')::numeric, 0) as amount
        from operations o
        where o.deleted_at is null
          and o.operation_type = ${WORK_ORDER_OP_TYPE}
          and o.meta_json is not null
          and coalesce(o.performed_at, o.created_at) between ${fromMs} and ${toMs}
      )
      select workshop_id,
             count(distinct id)::int as orders,
             count(distinct engine_entity_id)::int as engines,
             coalesce(sum(amount), 0)::float8 as labor_rub
      from wo
      where workshop_id is not null and workshop_id <> ''
      group by workshop_id
    `);

    // Distinct crew members per workshop (lateral over the crew[] array).
    const crewAgg = await db.execute(sql`
      with wo as (
        select o.id,
               (o.meta_json::jsonb ->> 'workshopId') as workshop_id,
               (o.meta_json::jsonb -> 'crew') as crew
        from operations o
        where o.deleted_at is null
          and o.operation_type = ${WORK_ORDER_OP_TYPE}
          and o.meta_json is not null
          and coalesce(o.performed_at, o.created_at) between ${fromMs} and ${toMs}
      ),
      members as (
        select distinct wo.workshop_id, (c ->> 'employeeId') as emp
        from wo, lateral jsonb_array_elements(coalesce(wo.crew, '[]'::jsonb)) c
        where wo.workshop_id is not null and wo.workshop_id <> '' and (c ->> 'employeeId') is not null
      )
      select workshop_id, count(*)::int as crew
      from members
      group by workshop_id
    `);
    const crewByWs = new Map<string, number>();
    for (const r of crewAgg.rows as Array<{ workshop_id: string; crew: number }>) {
      crewByWs.set(String(r.workshop_id), Number(r.crew) || 0);
    }

    const rows: WorkshopStatsRow[] = (agg.rows as Array<{
      workshop_id: string;
      orders: number;
      engines: number;
      labor_rub: number;
    }>)
      .map((r) => ({
        workshopId: String(r.workshop_id),
        workshopName: wsName.get(String(r.workshop_id)) ?? '(неизвестный цех)',
        orders: Number(r.orders) || 0,
        engines: Number(r.engines) || 0,
        laborRub: Math.round((Number(r.labor_rub) || 0) * 100) / 100,
        crew: crewByWs.get(String(r.workshop_id)) ?? 0,
      }))
      .sort((a, b) => b.orders - a.orders || a.workshopName.localeCompare(b.workshopName, 'ru'));

    const silent = Math.max(0, activeCount - rows.length);
    const coverageNote =
      rows.length === 0
        ? 'За период ни один цех не выписывал нарядов — показывать нечего. Захват наполняется по мере того, как цеха начинают вести наряды.'
        : `Показаны только цеха, выписывающие наряды (${rows.length} из ${activeCount} активных${silent > 0 ? `; ${silent} пока молчат` : ''}). Это не весь завод — картина наполняется по мере adoption нарядов.`;

    const result: WorkshopStatsResult = { from, to, rows, coverageNote };

    // Engine routes for the selected workshop: each engine touched here, with its full
    // time-ordered sequence of work orders across workshops (the «нить» / Q5 route).
    if (workshopId) {
      const routeRows = await db.execute(sql`
        with wo as (
          select o.id, o.engine_entity_id::text as engine_id,
                 (o.meta_json::jsonb ->> 'workshopId') as workshop_id,
                 coalesce(o.performed_at, o.created_at) as ts,
                 coalesce((o.meta_json::jsonb ->> 'workOrderNumber')::int, 0) as wo_number,
                 coalesce((o.meta_json::jsonb ->> 'totalAmountRub')::numeric, 0)::float8 as amount
          from operations o
          where o.deleted_at is null
            and o.operation_type = ${WORK_ORDER_OP_TYPE}
            and o.meta_json is not null
            and coalesce(o.performed_at, o.created_at) between ${fromMs} and ${toMs}
        ),
        touched as (
          select distinct engine_id from wo
          where workshop_id = ${workshopId}
          limit ${MAX_ROUTE_ENGINES}
        )
        select wo.engine_id, wo.workshop_id, wo.ts, wo.wo_number, wo.amount
        from wo
        join touched t on t.engine_id = wo.engine_id
        order by wo.engine_id, wo.ts asc
      `);

      const engineIds = Array.from(
        new Set((routeRows.rows as Array<{ engine_id: string }>).map((r) => String(r.engine_id))),
      );
      const engineName = new Map<string, string>();
      if (engineIds.length > 0) {
        const names = await db.execute(sql`
          select e.id::text as id, trim(both '"' from av.value_json) as name
          from entities e
          join entity_types t on t.id = e.type_id and t.code = 'engine'
          join attribute_defs ad on ad.entity_type_id = t.id and ad.code = 'name' and ad.deleted_at is null
          join attribute_values av on av.entity_id = e.id and av.attribute_def_id = ad.id and av.deleted_at is null
          where e.id in (${sql.join(engineIds.map((eid) => sql`${eid}::uuid`), sql`, `)}) and e.deleted_at is null
        `);
        for (const r of names.rows as Array<{ id: string; name: string }>) {
          engineName.set(String(r.id), String(r.name ?? '').trim());
        }
      }

      const byEngine = new Map<string, WorkshopEngineRouteStep[]>();
      for (const r of routeRows.rows as Array<{
        engine_id: string;
        workshop_id: string;
        ts: number;
        wo_number: number;
        amount: number;
      }>) {
        const id = String(r.engine_id);
        const steps = byEngine.get(id) ?? [];
        steps.push({
          workshopId: String(r.workshop_id),
          workshopName: wsName.get(String(r.workshop_id)) ?? '(неизвестный цех)',
          performedAt: Number(r.ts) || 0,
          workOrderNumber: Number(r.wo_number) || 0,
          amountRub: Math.round((Number(r.amount) || 0) * 100) / 100,
        });
        byEngine.set(id, steps);
      }
      const routes: WorkshopEngineRoute[] = Array.from(byEngine.entries()).map(([engineId, steps]) => ({
        engineId,
        engineName: engineName.get(engineId) || `двигатель ${engineId.slice(0, 8)}`,
        steps,
      }));

      result.selected = { workshopId, routes };
    }

    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
