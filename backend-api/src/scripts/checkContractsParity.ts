import 'dotenv/config';

import { pool } from '../database/db.js';

// B2 cutover (план contract-cutover-2026-10, шаг C4) parity: EAV ↔ строгие
// таблицы договоров и контрагентов (erp_contracts / erp_counterparties).
//
// Ожидаемое состояние выводится из EAV независимо — тем же маппингом, что
// rebuild_erp_contract / rebuild_erp_counterparty (0084): прямые атрибуты,
// customer_id с фолбэком на sections.primary.customerId и FK-страховкой,
// sections/execution_parts как распарсенные объекты (текстовую jsonb-нормализацию
// зеркала в TS не повторяем — сравниваем parse-формы).
//
// Read-only. Безопасен на проде.
//
// Usage:
//   pnpm -F @matricarmz/backend-api contracts:parity
//   pnpm -F @matricarmz/backend-api contracts:parity -- --json
//   pnpm -F @matricarmz/backend-api contracts:parity -- --limit 20
//
// Exit code: 0 — расхождений нет; 1 — есть (гейт приёмки C5 freeze).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Mismatch = { id: string; kind: string; expected: unknown; actual: unknown };

function asText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === 'string') return parsed.trim() || null;
      return v.trim() || null;
    } catch {
      return v.trim() || null;
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

function asUuid(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return UUID_RE.test(s) ? s : null;
}

function parseObj(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  try {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stable(value: unknown): string {
  return JSON.stringify(canon(value));
}

// Каноническая форма для сравнения: сортировка ключей рекурсивно. Текстовую
// jsonb-нормализацию зеркала (другой порядок + пробелы) в TS не повторяем —
// сравниваем parse-формы.
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = canon((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1] ?? 20) : 20;

  const eav = await pool.query(
    `SELECT e.id AS entity_id, t.code AS type_code, av.value_json AS raw, ad.code AS attr
       FROM entities e
       JOIN entity_types t ON t.id = e.type_id AND t.code IN ('contract', 'customer') AND t.deleted_at IS NULL
       JOIN attribute_defs ad ON ad.entity_type_id = t.id AND ad.deleted_at IS NULL
       LEFT JOIN attribute_values av ON av.entity_id = e.id AND av.attribute_def_id = ad.id AND av.deleted_at IS NULL
      WHERE e.deleted_at IS NULL`,
  );
  const byEntity = new Map<string, { type: string; attrs: Map<string, unknown> }>();
  for (const r of eav.rows as Array<{ entity_id: string; type_code: string; raw: unknown; attr: string }>) {
    const id = String(r.entity_id);
    let rec = byEntity.get(id);
    if (!rec) {
      rec = { type: String(r.type_code), attrs: new Map() };
      byEntity.set(id, rec);
    }
    if (r.raw != null) rec.attrs.set(String(r.attr), r.raw);
  }

  const strictContracts = await pool.query(`SELECT * FROM erp_contracts`);
  const strictParties = await pool.query(`SELECT * FROM erp_counterparties`);
  const contractsById = new Map((strictContracts.rows as Array<{ id: string }>).map((r) => [String(r.id), r]));
  const partiesById = new Map((strictParties.rows as Array<{ id: string }>).map((r) => [String(r.id), r]));
  const livePartyIds = new Set(
    (strictParties.rows as Array<{ id: string; deleted_at: unknown }>)
      .filter((r) => r.deleted_at == null)
      .map((r) => String(r.id)),
  );

  const mismatches: Mismatch[] = [];
  let contracts = 0;
  let parties = 0;

  for (const [id, rec] of byEntity) {
    const a = rec.attrs;
    if (rec.type === 'customer') {
      parties += 1;
      const expected = {
        name: asText(a.get('name')) ?? 'Без названия',
        short_name: asText(a.get('short_name')),
        inn: asText(a.get('inn')),
        kpp: asText(a.get('kpp')),
        address: asText(a.get('address')),
        email: asText(a.get('email')),
        phone: asText(a.get('phone')),
      };
      const s = partiesById.get(id) as Record<string, unknown> | undefined;
      if (!s || (s as { deleted_at: unknown }).deleted_at != null) {
        mismatches.push({ id, kind: 'есть EAV, нет strict', expected, actual: null });
        continue;
      }
      const actual = {
        name: (s.name as string | null) ?? null,
        short_name: (s.short_name as string | null) ?? null,
        inn: (s.inn as string | null) ?? null,
        kpp: (s.kpp as string | null) ?? null,
        address: (s.address as string | null) ?? null,
        email: (s.email as string | null) ?? null,
        phone: (s.phone as string | null) ?? null,
      };
      if (stable(expected) !== stable(actual)) mismatches.push({ id, kind: 'контрагент отличается', expected, actual });
      continue;
    }
    contracts += 1;
    const sections = parseObj(a.get('contract_sections'));
    const primary = (sections?.primary ?? {}) as Record<string, unknown>;
    let customer = asUuid(a.get('customer_id'));
    if (!customer) customer = asUuid(primary.customerId);
    if (customer && !livePartyIds.has(customer)) customer = null;
    const expected = {
      number: asText(a.get('number')),
      internal_number: asText(a.get('internal_number')),
      goz_name: asText(a.get('goz_name')),
      goz_igk: asText(a.get('goz_igk')),
      goz_separate_account_number: asText(a.get('goz_separate_account_number')),
      goz_separate_account_bank: asText(a.get('goz_separate_account_bank')),
      goz_separate_account: asText(a.get('goz_separate_account')),
      signed_at: asMs(a.get('date')),
      due_at: asMs(a.get('due_date')),
      customer_id: customer,
      comment: asText(a.get('comment')),
      sections: sections ?? null,
      execution_parts: parseObj(a.get('contract_execution_parts')),
    };
    const s = contractsById.get(id) as Record<string, unknown> | undefined;
    if (!s || (s as { deleted_at: unknown }).deleted_at != null) {
      mismatches.push({ id, kind: 'есть EAV, нет strict', expected, actual: null });
      continue;
    }
    const actual = {
      number: (s.number as string | null) ?? null,
      internal_number: (s.internal_number as string | null) ?? null,
      goz_name: (s.goz_name as string | null) ?? null,
      goz_igk: (s.goz_igk as string | null) ?? null,
      goz_separate_account_number: (s.goz_separate_account_number as string | null) ?? null,
      goz_separate_account_bank: (s.goz_separate_account_bank as string | null) ?? null,
      goz_separate_account: (s.goz_separate_account as string | null) ?? null,
      signed_at: s.signed_at == null ? null : Number(s.signed_at),
      due_at: s.due_at == null ? null : Number(s.due_at),
      customer_id: (s.customer_id as string | null) ?? null,
      comment: (s.comment as string | null) ?? null,
      sections: parseObj(s.sections_json),
      execution_parts: parseObj(s.execution_parts_json),
    };
    if (stable(expected) !== stable(actual)) mismatches.push({ id, kind: 'договор отличается', expected, actual });
  }

  // Строгие строки без EAV-сущности: дверь всегда пишет EAV-след, зеркало без EAV
  // не создаёт — такая строка означает порванный след.
  const knownIds = new Set(byEntity.keys());
  for (const [id] of contractsById) {
    if (!knownIds.has(id)) mismatches.push({ id, kind: 'strict без EAV-сущности', expected: null, actual: 'erp_contracts' });
  }
  for (const [id] of partiesById) {
    if (!knownIds.has(id)) mismatches.push({ id, kind: 'strict без EAV-сущности', expected: null, actual: 'erp_counterparties' });
  }

  const ok = mismatches.length === 0;
  if (asJson) {
    console.log(JSON.stringify({ ok, contracts, parties, mismatches }, null, 2));
  } else {
    console.log(`Договоров: ${contracts}; контрагентов: ${parties}`);
    if (ok) {
      console.log('\n✓ Расхождений EAV ↔ строгие таблицы договоров нет.');
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
