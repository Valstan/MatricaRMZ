import 'dotenv/config';

import { pool } from '../database/db.js';

// B4 трека B, шаг E1 (план engine-cards-strict-2026-10) parity: EAV ↔
// erp_engine_cards. Ожидаемое выводится из EAV тем же маппингом, что
// rebuild_erp_engine_card (0105): прямые атрибуты, uuid с защитой от мусора,
// флаги по isEavFlagSet, даты числом.
//
// Read-only. Безопасен на проде.
//
// Usage:
//   pnpm -F @matricarmz/backend-api engines:parity
//   pnpm -F @matricarmz/backend-api engines:parity -- --json
//   pnpm -F @matricarmz/backend-api engines:parity -- --limit 20
//
// Exit code: 0 — расхождений нет; 1 — есть (гейт приёмки E4/E5).

type Mismatch = { id: string; kind: string; expected: unknown; actual: unknown };

function asText(v: unknown): string | null {
  // Дословно, как eav_attr_text (без трима — зеркало данные не чинит):
  // JSON-строка разворачивается, пустое даёт NULL.
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === 'string') return parsed === '' ? null : parsed;
      return v === '' ? null : v;
    } catch {
      return v === '' ? null : v;
    }
  }
  return String(v);
}

function asMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuid(v: unknown): string | null {
  const s = String(v ?? '').trim();
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === 'string') return UUID_RE.test(parsed.trim()) ? parsed.trim() : null;
  } catch {
    /* не JSON — ниже */
  }
  return UUID_RE.test(s) ? s : null;
}

function asFlag(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === 'boolean') return parsed;
      if (typeof parsed === 'number') return parsed === 1;
      if (typeof parsed === 'string') {
        const t = parsed.trim().toLowerCase();
        return t === 'true' || t === '1';
      }
      return false;
    } catch {
      const t = v.trim().toLowerCase();
      return t === 'true' || t === '1';
    }
  }
  return false;
}

function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = canon((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

const stable = (v: unknown): string => JSON.stringify(canon(v));

const TEXT_CODES = [
  'engine_number', 'engine_internal_number', 'engine_brand',
  'contract_section_number', 'scrap_reason',
  'reclamation_customer_reason', 'reclamation_actual_defect', 'reclamation_defect_nature',
  'reclamation_act_number', 'reclamation_comment', 'reclamation_verdict', 'reclamation_repair_status',
  'arrival_invoice', 'shipment_invoice', 'engine_note',
  'docs_state', 'docs_track_or_act', 'docs_note',
] as const;

const MS_CODES = [
  'arrival_date',
  'status_rework_sent_date', 'status_scrap_confirmed_date', 'status_repair_started_date',
  'status_repaired_date', 'status_customer_sent_date', 'status_customer_accepted_date',
  'status_storage_received_date', 'status_rejected_date',
  'reclamation_accepted_date', 'reclamation_verdict_date', 'reclamation_shipped_date',
  'docs_aspvr_contractor_date', 'docs_vp_sent_date', 'docs_vp_returned_date',
  'docs_aspvr_customer_scan_date', 'docs_aspvr_customer_original_date',
  'docs_aspvr_signed_customer_date', 'docs_return_scan_date', 'docs_return_original_date',
] as const;

const FLAG_CODES = [
  'status_rework_sent', 'status_scrap_confirmed', 'status_repair_started', 'status_repaired',
  'status_customer_sent', 'status_customer_accepted', 'status_storage_received', 'status_rejected',
  'reclamation_flag', 'repeat_arrival_flag', 'number_collision_flag', 'docs_aspvr_customer_received',
] as const;

const UUID_CODES = ['engine_brand_id', 'customer_id', 'contract_id', 'workshop_id', 'previous_arrival_id', 'merged_into'] as const;

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1] ?? 20) : 20;

  const eav = await pool.query(
    `SELECT e.id AS entity_id, av.value_json AS raw, ad.code AS attr
       FROM entities e
       JOIN entity_types t ON t.id = e.type_id AND t.code = 'engine' AND t.deleted_at IS NULL
       JOIN attribute_defs ad ON ad.entity_type_id = t.id AND ad.deleted_at IS NULL
       LEFT JOIN attribute_values av ON av.entity_id = e.id AND av.attribute_def_id = ad.id AND av.deleted_at IS NULL
      WHERE e.deleted_at IS NULL`,
  );
  const byEntity = new Map<string, Map<string, unknown>>();
  for (const r of eav.rows as Array<{ entity_id: string; raw: unknown; attr: string }>) {
    const id = String(r.entity_id);
    let rec = byEntity.get(id);
    if (!rec) {
      rec = new Map();
      byEntity.set(id, rec);
    }
    if (r.raw != null) rec.set(String(r.attr), r.raw);
  }

  const strict = await pool.query(`SELECT * FROM erp_engine_cards`);
  const cardsById = new Map((strict.rows as Array<{ id: string }>).map((r) => [String(r.id), r as Record<string, unknown>]));

  const mismatches: Mismatch[] = [];
  let engines = 0;
  let withCards = 0;

  for (const [id, attrs] of byEntity) {
    engines += 1;
    const expected: Record<string, unknown> = {};
    for (const code of TEXT_CODES) expected[code] = asText(attrs.get(code));
    for (const code of MS_CODES) expected[code] = asMs(attrs.get(code));
    for (const code of FLAG_CODES) expected[code] = asFlag(attrs.get(code));
    for (const code of UUID_CODES) expected[code] = asUuid(attrs.get(code));
    expected.engine_internal_number_year = asMs(attrs.get('engine_internal_number_year'));
    const s = cardsById.get(id);
    if (!s || (s as { deleted_at: unknown }).deleted_at != null) {
      mismatches.push({ id, kind: 'есть EAV, нет strict', expected, actual: null });
      continue;
    }
    withCards += 1;
    const actual: Record<string, unknown> = {};
    for (const code of TEXT_CODES) actual[code] = (s[code] as string | null) ?? null;
    for (const code of MS_CODES) actual[code] = s[code] == null ? null : Number(s[code]);
    for (const code of FLAG_CODES) actual[code] = Boolean(s[code]);
    for (const code of UUID_CODES) actual[code] = (s[code] as string | null) ?? null;
    actual.engine_internal_number_year = s.engine_internal_number_year == null ? null : Number(s.engine_internal_number_year);
    if (stable(expected) !== stable(actual)) mismatches.push({ id, kind: 'карточка отличается', expected, actual });
  }

  const knownIds = new Set(byEntity.keys());
  for (const [id, s] of cardsById) {
    if (knownIds.has(id)) continue;
    // Тумстоун карточки без живой EAV-сущности — сошедшееся удаление (сущность
    // снесена, зеркало погасило карточку), а не расхождение. Живая strict-строка
    // без сущности — наоборот, настоящее расхождение (след не доехал).
    if ((s as { deleted_at: unknown }).deleted_at != null) continue;
    mismatches.push({ id, kind: 'strict без EAV-сущности', expected: null, actual: 'erp_engine_cards' });
  }

  const ok = mismatches.length === 0;
  if (asJson) {
    console.log(JSON.stringify({ ok, engines, withCards, mismatches }, null, 2));
  } else {
    console.log(`Двигателей: ${engines}; со strict-карточками: ${withCards}`);
    if (ok) {
      console.log('\n✓ Расхождений EAV ↔ строгие карточки двигателей нет.');
    } else {
      console.log(`\n✗ Расхождений: ${mismatches.length} (показаны первые ${Math.min(limit, mismatches.length)})`);
      for (const m of mismatches.slice(0, limit)) {
        console.log(`  ${m.id}  ${m.kind}\n     ожидалось: ${JSON.stringify(m.expected)}\n     в таблице: ${JSON.stringify(m.actual)}`);
      }
    }
  }

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error(String(e));
  await pool.end().catch(() => undefined);
  process.exit(2);
});
