import 'dotenv/config';

import { planContractSectionToken, type ContractSectionTokenKind } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';

// contracts:backfill-section-tokens — приведение раздела ДС к канону (владелец
// 13.11.2026: «55 движков в старом формате ДС — чинить миграцией», а 8 движков с
// номером договора в поле раздела — перенести в «основной договор»).
//
// ЗАЧЕМ. `contract_section_number` (раздел договора, к которому привязан двигатель) на проде
// лежит в четырёх видах (проверено 12.11.2026 на 578 заполненных строках):
//
//   • «ДС 1»…«ДС 5»  — канон приложения (`isContractAddonToken`), 199 движков;
//   • «primary»     — основной договор, 276 движков;
//   • пусто          — раздела нет, 40 движков;
//   • голые числа «1»–«4» — наследие старого импорта: номер ДС без слова «ДС», 55 движков;
//   • номер договора в поле раздела — мусор импорта, 8 движков.
//
// ПЕРЕНОС ОДНО, ПРАВИЛО ОДНО. Разбор значения — доменное правило
// `planContractSectionToken` (`shared/src/domain/contract.ts`): голое число — это номер ДС
// («3» → «ДС 3»), всё прочее не-ДС — основной договор (`primary`). Тот же разбор стоит в
// `contracts:canonicalize-section-keys`, поэтому два скрипта не могут разойтись и порезать
// данные по-разному.
//
// ПОЧЕМУ СКРИПТ, А НЕ SQL-МИГРАЦИЯ. Источник правды — EAV, а список двигателей читает его
// локально; серверные EAV-строки доезжают до клиентов только через журнал синхронизации
// (`recordSyncChanges` → `ledger_tx_index`). Правка EAV напрямую в SQL обновила бы только
// сервер, а парк увидел бы старое значение. Поэтому пишем через серверную дверь атрибута
// (`setEntityAttribute`) — она пишет и EAV, и журнал; клиенты забирают значение обычным
// pull'ом. Зеркало `erp_engine_cards` пересобирается триггером само.
//
// ИДЕНТИЧНОСТЬ. Скрипт идемпотентен: канон повторный прогон не трогает, а «ДС N» и
// «primary» — уже целевые значения.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api contracts:backfill-section-tokens            # dry-run
//   corepack pnpm -F @matricarmz/backend-api contracts:backfill-section-tokens -- --apply
//
// Код возврата: 0 — ок; 2 — отказ/ошибка.

const ATTR = 'contract_section_number';

type Row = { engine_id: string; value_json: string | null };

function parseArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const a of argv) {
    if (a === '--apply') apply = true;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return { apply };
}

function textOf(valueJson: string | null): string {
  if (valueJson == null) return '';
  try {
    const parsed = JSON.parse(valueJson) as unknown;
    if (parsed == null) return '';
    return typeof parsed === 'string' ? parsed.trim() : String(parsed).trim();
  } catch {
    return String(valueJson).trim();
  }
}

type Fix = { engineId: string; from: string; to: string; kind: ContractSectionTokenKind };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`contracts:backfill-section-tokens — ${args.apply ? 'РЕЖИМ ЗАПИСИ' : 'dry-run, ничего не меняется'}`);

  const res = await pool.query<Row>(
    `SELECT av.entity_id::text AS engine_id, av.value_json
       FROM attribute_values av
       JOIN attribute_defs ad ON ad.id = av.attribute_def_id
       JOIN entities e ON e.id = av.entity_id
       JOIN entity_types t ON t.id = e.type_id
      WHERE t.code = 'engine'
        AND ad.code = $1
        AND av.deleted_at IS NULL
        AND e.deleted_at IS NULL`,
    [ATTR],
  );

  const counts: Record<ContractSectionTokenKind, number> = {
    empty: 0,
    addon: 0,
    primary: 0,
    'bare-number': 0,
    foreign: 0,
  };
  const fixes: Fix[] = [];
  for (const row of res.rows) {
    const plan = planContractSectionToken(textOf(row.value_json));
    counts[plan.kind] += 1;
    if (plan.next != null && plan.next !== plan.current) {
      fixes.push({ engineId: row.engine_id, from: plan.current, to: plan.next, kind: plan.kind });
    }
  }

  console.log(`  всего с разделом: ${res.rows.length}`);
  console.log(`  по канону («ДС N»): ${counts.addon}; основной договор («primary»): ${counts.primary}; пусто: ${counts.empty}`);
  console.log(`  к приведению: голые номера → «ДС N»: ${counts['bare-number']}; номер договора в поле раздела → «primary»: ${counts.foreign}`);

  const actor = { id: 'server', username: 'contracts:backfill-section-tokens', role: 'system' };
  let fixed = 0;
  const failed: Array<{ engineId: string; error: string }> = [];
  for (const item of fixes) {
    if (!args.apply) {
      console.log(`    ${item.engineId}: «${item.from}» → «${item.to}»`);
      fixed += 1;
      continue;
    }
    const written = await setEntityAttribute(actor, item.engineId, ATTR, item.to, { allowSyncConflicts: true });
    if (!written.ok) {
      failed.push({ engineId: item.engineId, error: written.error });
      continue;
    }
    console.log(`    ${item.engineId}: «${item.from}» → «${item.to}»`);
    fixed += 1;
  }

  console.log(`  ${args.apply ? 'приведено' : 'к приведению'}: ${fixed}`);
  if (failed.length > 0) {
    console.log(`  НЕ удалось привести: ${failed.length}`);
    for (const f of failed.slice(0, 10)) console.log(`    ${f.engineId}: ${f.error}`);
  }
  if (!args.apply) console.log('  (повторить с --apply, чтобы записать)');
  if (failed.length > 0) process.exitCode = 2;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error('Ошибка переноса раздела ДС:', e);
    process.exit(2);
  });
