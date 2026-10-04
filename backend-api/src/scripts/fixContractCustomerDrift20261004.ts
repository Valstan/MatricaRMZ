/**
 * One-off: договор №8 (08/ГОЗ-26) указывает на УДАЛЁННЫЙ дубль контрагента.
 *
 * Картина (аудит 2026-10-04, contracts:parity = 1 расхождение):
 *   - `erp_contracts.customer_id` = aa9e7d1a… («ООО \"НПФ \"ТЕХНОТРАНС\"», deleted)
 *   - EAV `customer_id` договора = тот же aa9e7d1a…
 *   - `sections_json.primary.customerId` = 5cae91d2… (живой «ООО \"НПФ ТЕХНОТРАНС\"»)
 *
 * Источник правды у договора — EAV (strict — зеркало, rebuild_erp_contract).
 * Лечение: переписать EAV-атрибут `customer_id` договора на живого контрагента;
 * триггер зеркала сам выровняет strict-колонку, паритет снова сойдётся.
 * Запись идёт штатным путём (setEntityAttribute → insertChangeLog), прямой UPDATE
 * оставил бы `last_server_seq = NULL` и правка не доехала бы клиентам.
 *
 * Dry-run по умолчанию:
 *   pnpm -F @matricarmz/backend-api exec tsx src/scripts/fixContractCustomerDrift20261004.ts
 *   pnpm -F @matricarmz/backend-api exec tsx src/scripts/fixContractCustomerDrift20261004.ts --apply
 */
import 'dotenv/config';

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from '../database/db.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';

const CONTRACT_ID = '0ec302da-f042-480b-adff-25fd4fba75b6';
const LIVE_CUSTOMER_ID = '5cae91d2-ee38-4d9b-ae96-71230ae69d3f';
const DEAD_CUSTOMER_ID = 'aa9e7d1a-525c-494b-ab4b-1733f841b723';

const APPLY = process.argv.includes('--apply');

async function main() {
  const r = await pool.query(
    `SELECT av.value_json AS eav_customer, c.customer_id AS strict_customer, c.number
       FROM attribute_values av
       JOIN attribute_defs ad ON ad.id = av.attribute_def_id AND ad.code = 'customer_id' AND ad.deleted_at IS NULL
       JOIN erp_contracts c ON c.id = av.entity_id
      WHERE av.entity_id = $1 AND av.deleted_at IS NULL`,
    [CONTRACT_ID],
  );
  const row = r.rows[0];
  if (!row) {
    console.log('договор не найден — выходим');
    await pool.end();
    return;
  }
  console.log(`договор №${row.number}: EAV customer_id=${row.eav_customer}, strict customer_id=${row.strict_customer}`);
  if (String(row.eav_customer).replaceAll('"', '') === LIVE_CUSTOMER_ID) {
    console.log('уже указывает на живого контрагента — делать нечего');
    await pool.end();
    return;
  }
  if (String(row.eav_customer).replaceAll('"', '') !== DEAD_CUSTOMER_ID) {
    console.log('EAV указывает на НЕОЖИДАННОГО контрагента — стоп, разбираемся руками');
    await pool.end();
    process.exit(2);
  }
  if (!APPLY) {
    console.log(`dry-run: EAV customer_id → ${LIVE_CUSTOMER_ID}. Повторите с --apply.`);
    await pool.end();
    return;
  }
  const ar = await pool.query(
    `select e.id::text as id, trim(both '"' from lg.value_json) as username
       from entities e
       join entity_types t on t.id = e.type_id and t.code = 'employee'
       join attribute_defs sd on sd.entity_type_id = t.id and sd.code = 'system_role' and sd.deleted_at is null
       join attribute_values sr on sr.entity_id = e.id and sr.attribute_def_id = sd.id and sr.deleted_at is null
            and trim(both '"' from sr.value_json) = 'superadmin'
       join attribute_defs ld on ld.entity_type_id = t.id and ld.code = 'login' and ld.deleted_at is null
       left join attribute_values lg on lg.entity_id = e.id and lg.attribute_def_id = ld.id and lg.deleted_at is null
      where e.deleted_at is null
      order by username
      limit 1`,
  );
  if (ar.rows.length === 0) throw new Error('superadmin не найден');
  const actor = { id: String(ar.rows[0].id), username: String(ar.rows[0].username), role: 'superadmin' };
  const res = await setEntityAttribute(actor, CONTRACT_ID, 'customer_id', LIVE_CUSTOMER_ID, {
    allowSyncConflicts: true,
    allowProtectedAttrs: true,
  });
  if (!res.ok) {
    console.error('запись отклонена:', res.error);
    process.exitCode = 1;
  } else {
    console.log('записано: EAV customer_id →', LIVE_CUSTOMER_ID);
  }
  await pool.end();
}

function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return realpathSync(resolve(argv)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
}
