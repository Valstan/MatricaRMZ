import { sql } from 'drizzle-orm';

import {
  buildEngineOutputResult,
  ENGINE_OUTPUT_METRIC_ATTR,
  type AnalyticsBucket,
  type EngineOutputMetric,
  type EngineOutputResult,
  type EngineOutputRow,
} from '@matricarmz/shared';

import { db } from '../database/db.js';

const METRICS: EngineOutputMetric[] = ['shipped', 'repaired', 'arrived'];
const BUCKETS: AnalyticsBucket[] = ['day', 'week', 'month'];
const REPORT_TZ = 'Europe/Moscow';

type Result<T> = { ok: true } & T | { ok: false; error: string };

function ymd(value: string | undefined, fallbackDaysAgo: number): string {
  const s = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.now() - fallbackDaysAgo * 86_400_000;
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ }).format(new Date(ms));
}

/**
 * Engine output over time, one series per engine brand. Counts engines whose chosen
 * lifecycle date (shipping/repaired/arrival) falls in [from, to], bucketed in MSK.
 * History is read straight from the engine EAV lifecycle — no snapshots needed.
 */
export async function getEngineOutputAnalytics(args?: {
  metric?: EngineOutputMetric;
  bucket?: AnalyticsBucket;
  from?: string;
  to?: string;
  workshopId?: string;
}): Promise<Result<{ result: EngineOutputResult }>> {
  const metric: EngineOutputMetric = METRICS.includes(args?.metric as EngineOutputMetric) ? (args!.metric as EngineOutputMetric) : 'shipped';
  const bucket: AnalyticsBucket = BUCKETS.includes(args?.bucket as AnalyticsBucket) ? (args!.bucket as AnalyticsBucket) : 'month';
  const from = ymd(args?.from, 365);
  const to = ymd(args?.to, 0);
  if (from > to) return { ok: false, error: 'Период задан неверно: «с» позже «по».' };
  // Optional «цех» filter (warehouse-analytics C2): restrict to engines whose
  // workshop_id (directory_workshops id, captured on the engine card) matches.
  const workshopId = String(args?.workshopId ?? '').trim() || null;

  const metricAttr = ENGINE_OUTPUT_METRIC_ATTR[metric];
  // Inclusive day bounds in MSK → epoch-ms range used to filter the bigint date attr.
  const fromMs = Date.parse(`${from}T00:00:00+03:00`);
  const toMs = Date.parse(`${to}T23:59:59.999+03:00`);

  try {
    const agg = await db.execute(sql`
      with defs as (
        select ad.code, ad.id
        from attribute_defs ad
        join entity_types t on t.id = ad.entity_type_id
        where t.code = 'engine' and ad.deleted_at is null
          and ad.code in (${metricAttr}, 'engine_brand_id', 'engine_brand', 'is_scrap', 'workshop_id')
      ),
      eng as (
        select e.id
        from entities e
        join entity_types t on t.id = e.type_id
        where t.code = 'engine' and e.deleted_at is null
      ),
      dt as (
        select av.entity_id, (av.value_json)::bigint as ts
        from attribute_values av
        where av.attribute_def_id = (select id from defs where code = ${metricAttr})
          and av.deleted_at is null
          and av.value_json ~ '^[0-9]+$'
          and (av.value_json)::bigint between ${fromMs} and ${toMs}
      ),
      brand_link as (
        select av.entity_id, trim(both '"' from av.value_json) as brand_id
        from attribute_values av
        where av.attribute_def_id = (select id from defs where code = 'engine_brand_id')
          and av.deleted_at is null and av.value_json is not null and av.value_json <> 'null'
      ),
      brand_text as (
        select av.entity_id, trim(both '"' from av.value_json) as brand_name
        from attribute_values av
        where av.attribute_def_id = (select id from defs where code = 'engine_brand')
          and av.deleted_at is null
      ),
      ws as (
        select av.entity_id, trim(both '"' from av.value_json) as wsid
        from attribute_values av
        where av.attribute_def_id = (select id from defs where code = 'workshop_id')
          and av.deleted_at is null and av.value_json is not null and av.value_json <> 'null'
      ),
      scrap_flag as (
        select av.entity_id
        from attribute_values av
        where av.attribute_def_id = (select id from defs where code = 'is_scrap')
          and av.deleted_at is null and av.value_json = 'true'
      )
      select
        bl.brand_id as brand_id,
        coalesce(bt.brand_name, '') as brand_text,
        to_char(date_trunc(${bucket}, to_timestamp(dt.ts / 1000) at time zone ${REPORT_TZ}), 'YYYY-MM-DD') as bucket,
        count(*)::int as value,
        count(*) filter (where sf.entity_id is not null)::int as scrap
      from eng e
      join dt on dt.entity_id = e.id
      left join brand_link bl on bl.entity_id = e.id
      left join brand_text bt on bt.entity_id = e.id
      left join ws on ws.entity_id = e.id
      left join scrap_flag sf on sf.entity_id = e.id
      where (${workshopId}::text is null or ws.wsid = ${workshopId})
      group by bl.brand_id, bt.brand_name, bucket
    `);

    // Resolve brand link ids → canonical brand name (engine_brand entity 'name' attr).
    const brandNames = await db.execute(sql`
      select e.id::text as id, trim(both '"' from av.value_json) as name
      from entities e
      join entity_types t on t.id = e.type_id and t.code = 'engine_brand'
      join attribute_defs ad on ad.entity_type_id = t.id and ad.code = 'name' and ad.deleted_at is null
      join attribute_values av on av.entity_id = e.id and av.attribute_def_id = ad.id and av.deleted_at is null
      where e.deleted_at is null
    `);
    const nameById = new Map<string, string>();
    for (const r of brandNames.rows as Array<{ id: string; name: string }>) {
      if (r.id) nameById.set(String(r.id), String(r.name ?? '').trim());
    }

    const rows: EngineOutputRow[] = (agg.rows as Array<{ brand_id: string | null; brand_text: string; bucket: string; value: number; scrap: number }>).map((r) => {
      const brandId = r.brand_id ? String(r.brand_id) : null;
      const resolved = (brandId && nameById.get(brandId)) || String(r.brand_text ?? '').trim();
      return {
        brandId,
        brandName: resolved || '(без марки)',
        bucket: String(r.bucket),
        value: Number(r.value) || 0,
        scrap: Number(r.scrap) || 0,
      };
    });

    const result = buildEngineOutputResult(rows, { metric, bucket, from, to });

    // C3: per-workshop «выпустил / осталось» snapshot (only for a single shop).
    if (workshopId) {
      const sum = await db.execute(sql`
        with defs as (
          select ad.code, ad.id from attribute_defs ad
          join entity_types t on t.id = ad.entity_type_id
          where t.code = 'engine' and ad.deleted_at is null
            and ad.code in ('workshop_id', 'shipping_date', 'status_customer_sent', 'status_repaired')
        ),
        ws as (
          select av.entity_id from attribute_values av
          where av.attribute_def_id = (select id from defs where code = 'workshop_id')
            and av.deleted_at is null and trim(both '"' from av.value_json) = ${workshopId}
        ),
        ship as (
          select av.entity_id, (av.value_json)::bigint as ts from attribute_values av
          where av.attribute_def_id = (select id from defs where code = 'shipping_date')
            and av.deleted_at is null and av.value_json ~ '^[0-9]+$'
        ),
        sent as (
          select av.entity_id from attribute_values av
          where av.attribute_def_id = (select id from defs where code = 'status_customer_sent')
            and av.deleted_at is null and av.value_json = 'true'
        ),
        rep as (
          select av.entity_id from attribute_values av
          where av.attribute_def_id = (select id from defs where code = 'status_repaired')
            and av.deleted_at is null and av.value_json = 'true'
        )
        select
          count(*) filter (where s.ts between ${fromMs} and ${toMs})::int as shipped_in_window,
          count(*) filter (where se.entity_id is null)::int as on_hand,
          count(*) filter (where se.entity_id is null and r.entity_id is not null)::int as repaired_not_shipped,
          count(*) filter (where se.entity_id is null and r.entity_id is null)::int as in_progress
        from ws
        left join ship s on s.entity_id = ws.entity_id
        left join sent se on se.entity_id = ws.entity_id
        left join rep r on r.entity_id = ws.entity_id
      `);
      const row = sum.rows?.[0] as { shipped_in_window?: number; on_hand?: number; repaired_not_shipped?: number; in_progress?: number } | undefined;

      // «Отдал»: межцеховые передачи из этого цеха за период (operations.workshop_transfer).
      const handed = await db.execute(sql`
        select count(*)::int as cnt
        from operations o
        where o.deleted_at is null
          and o.operation_type = 'workshop_transfer'
          and o.meta_json is not null
          and (o.meta_json::jsonb ->> 'fromWorkshopId') = ${workshopId}
          and o.performed_at between ${fromMs} and ${toMs}
      `);
      const handedOff = Number((handed.rows?.[0] as { cnt?: number } | undefined)?.cnt ?? 0);

      result.workshopSummary = {
        workshopId,
        shippedInWindow: Number(row?.shipped_in_window ?? 0),
        onHand: Number(row?.on_hand ?? 0),
        repairedNotShipped: Number(row?.repaired_not_shipped ?? 0),
        inProgress: Number(row?.in_progress ?? 0),
        handedOff,
      };
    }

    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
