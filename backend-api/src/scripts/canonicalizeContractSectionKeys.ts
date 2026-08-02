/**
 * Перевод ключа секции контракта на стабильный `primary`.
 *
 * Исторически ключом основной секции служил САМ номер договора — редактируемое поле
 * карточки. Правка номера молча отвязывала слоты с платежами (`contract_payments.slots[].sectionKey`)
 * и привязки двигателей (EAV `contract_section_number`): сохранённые строки оставались
 * прежними, а секция уже называлась иначе. Клиент с этой ветки канонизирует ключ на
 * чтении и пишет `primary`, так что данные чинятся сами по мере сохранений; скрипт
 * приводит к канону разом всё, что лежит в базе.
 *
 * Ключи ДС («ДС {seq}») уже стабильны и не трогаются.
 *
 * ⚠️ Запускать ТОЛЬКО после того, как парк клиентов обновится: версия без канонизации
 * читает `primary` как незнакомую секцию и покажет двигатель «без привязки».
 *
 * Записи идут штатным путём (`setEntityAttribute` → recordSyncChanges), поэтому доезжают
 * клиентам инкрементальным sync — прямой UPDATE этого не делает (GOTCHAS M6/M8).
 *
 * Dry-run по умолчанию. Флаги:
 *   --apply              — выполнить запись
 *   --actor=<username>   — актор change_log (по умолчанию: первый superadmin)
 *
 *   pnpm -F @matricarmz/backend-api contracts:canonicalize-section-keys
 *   pnpm -F @matricarmz/backend-api contracts:canonicalize-section-keys --apply
 */
import 'dotenv/config';

import { canonicalContractSectionKey, PRIMARY_CONTRACT_SECTION_KEY } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;

type Actor = { id: string; username: string; role: 'admin' | 'superadmin' };

function log(...args: unknown[]) {
  console.log(...args);
}

async function getAttrDefIds(code: string): Promise<string[]> {
  const r = await pool.query(
    'select id from attribute_defs where code=$1 and deleted_at is null',
    [code],
  );
  return r.rows.map((row: { id: string }) => String(row.id));
}

async function resolveActor(): Promise<Actor> {
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from lg.value_json) as username
       from entities e
       join attribute_defs sd on sd.code='system_role' and sd.deleted_at is null
       join attribute_values sr on sr.entity_id=e.id and sr.attribute_def_id=sd.id and sr.deleted_at is null
            and trim(both '"' from sr.value_json)='superadmin'
       join attribute_defs ld on ld.code='login' and ld.deleted_at is null
       left join attribute_values lg on lg.entity_id=e.id and lg.attribute_def_id=ld.id and lg.deleted_at is null
      where e.deleted_at is null
      order by username`,
  );
  if (r.rows.length === 0) throw new Error('no superadmin employee found — pass --actor=<username>');
  const pick = ACTOR_OVERRIDE
    ? r.rows.find((x: { username: string }) => String(x.username) === ACTOR_OVERRIDE)
    : r.rows[0];
  if (!pick) throw new Error(`--actor=${ACTOR_OVERRIDE} is not a superadmin`);
  return { id: String(pick.id), username: String(pick.username), role: 'superadmin' };
}

/** Слоты контрактов: ключи, не равные канону, переписываем внутри того же JSON. */
async function migrateContractPayments(actor: Actor): Promise<{ contracts: number; slots: number }> {
  const defIds = await getAttrDefIds('contract_payments');
  if (defIds.length === 0) return { contracts: 0, slots: 0 };
  const r = await pool.query(
    `select entity_id::text as entity_id, value_json
       from attribute_values
      where attribute_def_id = any($1::uuid[]) and deleted_at is null and value_json is not null`,
    [defIds],
  );
  let contracts = 0;
  let slots = 0;
  for (const row of r.rows as Array<{ entity_id: string; value_json: string }>) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value_json);
    } catch {
      log(`  ! ${row.entity_id}: contract_payments не парсится — пропуск`);
      continue;
    }
    const cp = parsed as { version?: number; slots?: Array<Record<string, unknown>> };
    if (!cp || !Array.isArray(cp.slots)) continue;
    let touched = 0;
    const nextSlots = cp.slots.map((slot) => {
      const raw = String(slot.sectionKey ?? '');
      const canonical = canonicalContractSectionKey(raw);
      if (!canonical || canonical === raw) return slot;
      touched += 1;
      return { ...slot, sectionKey: canonical };
    });
    if (touched === 0) continue;
    contracts += 1;
    slots += touched;
    log(`  ${row.entity_id}: слотов к переписи ${touched} из ${cp.slots.length}`);
    if (APPLY) {
      await setEntityAttribute(actor, row.entity_id, 'contract_payments', { ...cp, slots: nextSlots }, {
        allowSyncConflicts: true,
      });
    }
  }
  return { contracts, slots };
}

/** Привязки двигателей: значение атрибута заменяем на канон. */
async function migrateEngineBindings(actor: Actor): Promise<{ engines: number }> {
  const defIds = await getAttrDefIds('contract_section_number');
  if (defIds.length === 0) return { engines: 0 };
  const r = await pool.query(
    `select entity_id::text as entity_id, value_json
       from attribute_values
      where attribute_def_id = any($1::uuid[]) and deleted_at is null
        and value_json is not null and value_json <> 'null'`,
    [defIds],
  );
  let engines = 0;
  for (const row of r.rows as Array<{ entity_id: string; value_json: string }>) {
    let raw: string;
    try {
      const parsed: unknown = JSON.parse(row.value_json);
      raw = typeof parsed === 'string' ? parsed : String(parsed ?? '');
    } catch {
      raw = String(row.value_json ?? '');
    }
    const canonical = canonicalContractSectionKey(raw);
    if (!canonical || canonical === raw.trim()) continue;
    engines += 1;
    log(`  ${row.entity_id}: «${raw}» → «${canonical}»`);
    if (APPLY) {
      await setEntityAttribute(actor, row.entity_id, 'contract_section_number', canonical, {
        allowSyncConflicts: true,
      });
    }
  }
  return { engines };
}

async function main() {
  const actor = await resolveActor();
  log(`Режим: ${APPLY ? 'APPLY (запись)' : 'DRY-RUN (только отчёт)'}; актор: ${actor.username}`);
  log(`Канон основной секции: «${PRIMARY_CONTRACT_SECTION_KEY}»; ключи ДС не трогаем.`);

  log('\nСлоты контрактов (contract_payments):');
  const payments = await migrateContractPayments(actor);
  log(`  итого: контрактов ${payments.contracts}, слотов ${payments.slots}`);

  log('\nПривязки двигателей (contract_section_number):');
  const bindings = await migrateEngineBindings(actor);
  log(`  итого: двигателей ${bindings.engines}`);

  if (!APPLY && (payments.slots > 0 || bindings.engines > 0)) {
    log('\nЗапись не выполнялась. Повторить с --apply (идемпотентно: повторный запуск даст 0/0).');
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
