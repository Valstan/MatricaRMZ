import 'dotenv/config';

import { parseContractPayments } from '@matricarmz/shared';

import { pool } from '../database/db.js';

// B2-хвост (план contract-payments-strict-2026-10) parity: EAV `contract_payments`
// ↔ строгие таблицы (erp_contract_payment_slots / erp_contract_payments).
//
// Ожидаемое состояние выводится из EAV на TypeScript (parseContractPayments —
// та же независимая реализация, что читает UI), фактическое — из строгих таблиц.
// Независимый вывод ловит и порчу данных, и ошибку самой SQL-функции зеркала.
//
// Read-only. Безопасен на проде.
//
// Usage:
//   pnpm -F @matricarmz/backend-api payments:parity
//   pnpm -F @matricarmz/backend-api payments:parity -- --json
//   pnpm -F @matricarmz/backend-api payments:parity -- --limit 20
//
// Exit code: 0 — расхождений нет; 1 — есть (гейт приёмки cutover).

type Mismatch = { contractId: string; kind: string; expected: unknown; actual: unknown };

function norm(value: unknown): string {
  const cp = parseContractPayments(value);
  const slots = [...cp.slots]
    .map((s) => ({ ...s, payments: [...s.payments].sort((a, b) => a.id.localeCompare(b.id)) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ version: 1 as const, slots });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Форма зеркала: то, что sync_contract_payments физически способна сохранить.
// PK uuid отбрасывает не-uuid id, NOT NULL — null-суммы; трим заметок и строгое
// `true` повторяют SQL дословно. Без этого parity краснел бы на мусоре, которого
// в живых данных нет, но который парсер UI терпит (толерантный парс).
function mirrorForm(raw: unknown): string {
  const cp = parseContractPayments(raw);
  const rawSlots = new Map<string, Record<string, unknown>>();
  const rawPays = new Map<string, Record<string, unknown>>();
  const rawObj = (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw) as {
    slots?: unknown;
  } | null;
  if (rawObj && Array.isArray(rawObj.slots)) {
    for (const s of rawObj.slots) {
      if (!s || typeof s !== 'object') continue;
      const rec = s as Record<string, unknown>;
      const id = String(rec.id ?? '');
      if (id) rawSlots.set(id, rec);
      if (Array.isArray(rec.payments)) {
        for (const p of rec.payments) {
          if (!p || typeof p !== 'object') continue;
          const pr = p as Record<string, unknown>;
          const pid = String(pr.id ?? '');
          if (pid) rawPays.set(pid, pr);
        }
      }
    }
  }
  const slots = cp.slots
    .filter((s) => UUID_RE.test(s.id) && rawSlots.has(s.id))
    .map((s) => ({
      ...s,
      engineBrandId: s.engineBrandId && UUID_RE.test(s.engineBrandId) ? s.engineBrandId : undefined,
      engineId: s.engineId && UUID_RE.test(s.engineId) ? s.engineId : undefined,
      payments: s.payments
        .filter((p) => UUID_RE.test(p.id) && rawPays.get(p.id)?.amountKop != null)
        .map((p) => ({ ...p, ...(p.note ? { note: p.note.trim() } : {}) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ version: 1 as const, slots });
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1] ?? 20) : 20;

  const eav = await pool.query(
    `SELECT e.id AS contract_id, av.value_json AS raw
       FROM entities e
       JOIN entity_types t ON t.id = e.type_id AND t.code = 'contract'
       JOIN attribute_defs ad ON ad.entity_type_id = t.id AND ad.code = 'contract_payments' AND ad.deleted_at IS NULL
       LEFT JOIN attribute_values av ON av.entity_id = e.id AND av.attribute_def_id = ad.id AND av.deleted_at IS NULL`,
  );
  const slots = await pool.query(
    `SELECT id, contract_id, section_key, engine_brand_id, engine_id, contract_price_kop, deleted_at
       FROM erp_contract_payment_slots`,
  );
  const pays = await pool.query(
    `SELECT id, slot_id, date, amount_kop, kind, note, countdown_start, deleted_at
       FROM erp_contract_payments`,
  );

  const paysBySlot = new Map<string, typeof pays.rows>();
  for (const p of pays.rows) {
    const arr = paysBySlot.get(String(p.slot_id)) ?? [];
    arr.push(p);
    paysBySlot.set(String(p.slot_id), arr);
  }
  const slotsByContract = new Map<string, typeof slots.rows>();
  for (const s of slots.rows) {
    const arr = slotsByContract.get(String(s.contract_id)) ?? [];
    arr.push(s);
    slotsByContract.set(String(s.contract_id), arr);
  }

  const mismatches: Mismatch[] = [];
  let withEav = 0;
  let withStrict = 0;
  for (const row of eav.rows as Array<{ contract_id: string; raw: unknown }>) {
    const cid = String(row.contract_id);
    const raw = typeof row.raw === 'string' ? row.raw : row.raw == null ? null : String(row.raw);
    const expected = mirrorForm(raw);
    const liveSlots = (slotsByContract.get(cid) ?? []).filter((s) => s.deleted_at == null);
    if (liveSlots.length > 0) withStrict += 1;
    const actual = norm({
      version: 1,
      slots: liveSlots.map((s) => ({
        id: String(s.id),
        sectionKey: String(s.section_key),
        ...(s.engine_brand_id ? { engineBrandId: String(s.engine_brand_id) } : {}),
        ...(s.engine_id ? { engineId: String(s.engine_id) } : {}),
        ...(s.contract_price_kop != null ? { contractPriceKop: Number(s.contract_price_kop) } : {}),
        payments: ((paysBySlot.get(String(s.id)) ?? []).filter((p) => p.deleted_at == null)).map((p) => ({
          id: String(p.id),
          date: String(p.date ?? ''),
          amountKop: Number(p.amount_kop ?? 0),
          kind: String(p.kind),
          ...(p.note ? { note: String(p.note) } : {}),
          ...(p.countdown_start ? { countdownStart: true } : {}),
        })),
      })),
    });
    if (expected !== norm(null)) withEav += 1;
    if (expected !== actual) {
      mismatches.push({
        contractId: cid,
        kind: liveSlots.length === 0 && expected !== norm(null) ? 'есть EAV, нет strict' : 'состав отличается',
        expected: JSON.parse(expected),
        actual: JSON.parse(actual),
      });
    }
  }
  // Строгие строки без контракта в выборке (контракт удалён жёстко — быть не должно).
  const knownContracts = new Set((eav.rows as Array<{ contract_id: string }>).map((r) => String(r.contract_id)));
  const orphanSlots = slots.rows.filter((s) => !knownContracts.has(String(s.contract_id)));
  for (const s of orphanSlots) {
    mismatches.push({ contractId: String(s.contract_id), kind: 'слот без контракта', expected: null, actual: String(s.id) });
  }

  const ok = mismatches.length === 0;
  if (asJson) {
    console.log(JSON.stringify({ ok, contracts: eav.rows.length, withEav, withStrict, mismatches }, null, 2));
  } else {
    console.log(`Контрактов: ${eav.rows.length}; с EAV-платежами: ${withEav}; со strict-слотами: ${withStrict}`);
    if (ok) {
      console.log('\n✓ Расхождений EAV ↔ строгие таблицы платежей нет.');
    } else {
      console.log(`\n✗ Расхождений: ${mismatches.length} (показаны первые ${Math.min(limit, mismatches.length)})`);
      for (const m of mismatches.slice(0, limit)) {
        console.log(`  ${m.contractId}  ${m.kind}\n     ожидалось: ${JSON.stringify(m.expected)}\n     в таблице: ${JSON.stringify(m.actual)}`);
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
