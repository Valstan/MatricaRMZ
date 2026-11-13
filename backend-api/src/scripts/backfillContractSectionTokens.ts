import 'dotenv/config';

import { pool } from '../database/db.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';

// contracts:backfill-section-tokens — приведение раздела ДС к канону «ДС N» (владелец
// 13.11.2026: «55 движков в старом формате ДС — чинить миграцией»).
//
// ЗАЧЕМ. `contract_section_number` (раздел договора, к которому привязан двигатель) на проде
// лежит в четырёх видах (проверено 12.11.2026 на 578 заполненных строках):
//
//   • «ДС 1»…«ДС 5»  — канон приложения (`isContractAddonToken`), 199 движков;
//   • «primary»     — основной договор, 276 движков;
//   • пусто          — раздела нет, 40 движков;
//   • голые числа «1»–«4» — наследие старого импорта: номер ДС без слова «ДС», 55 движков;
//   • номер договора в поле раздела — мусор импорта, 8 движков (владелец решение не принял —
//     скрипт их только считает и показывает, но НЕ трогает).
//
// Голые числа приложение ДС-ами не считает (`isContractAddonToken` — это /^ДС\s/), поэтому
// у таких двигателей в колонке «Договор» показывается номер договора без «/N», а кружок в
// ячейке один зелёный вместо двух. После приведения к канону появится «/N» и второй кружок.
//
// ПОЧЕМУ СКРИПТ, А НЕ SQL-МИГРАЦИЯ. Источник правды — EAV, а список двигателей читает его
// локально; серверные EAV-строки доезжают до клиентов только через журнал синхронизации
// (`recordSyncChanges` → `ledger_tx_index`). Правка EAV напрямую в SQL обновила бы только
// сервер, а парк увидел бы старое значение. Поэтому пишем через серверную дверь атрибута
// (`setEntityAttribute`) — она пишет и EAV, и журнал; клиенты забирают значение обычным
// pull'ом. Зеркало `erp_engine_cards` пересобирается триггером само.
//
// ИДЕНТИЧНОСТЬ. Скрипт идемпотентен: значение «ДС N» уже канон, повторный прогон его не
// трогает. Голые номера и мусор различаются по виду, а не по списку.
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

/** Голое число — наследие старого импорта: номер ДС без слова «ДС». */
function isBareNumber(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

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

  const bare: Array<{ engineId: string; from: string; to: string }> = [];
  let canon = 0;
  let primary = 0;
  let empty = 0;
  const junk: Array<{ engineId: string; value: string }> = [];
  for (const row of res.rows) {
    const value = textOf(row.value_json);
    if (!value) {
      empty += 1;
      continue;
    }
    if (/^ДС\s/.test(value)) {
      canon += 1;
      continue;
    }
    if (value === 'primary') {
      primary += 1;
      continue;
    }
    if (isBareNumber(value)) {
      bare.push({ engineId: row.engine_id, from: value, to: `ДС ${value}` });
      continue;
    }
    // Всё прочее — мусор импорта (в поле раздела номер договора). Владелец решение не принял:
    // показываем, но НЕ трогаем.
    junk.push({ engineId: row.engine_id, value });
  }

  console.log(`  всего с разделом: ${res.rows.length}`);
  console.log(`  по канону («ДС N»): ${canon}; основной договор («primary»): ${primary}; пусто: ${empty}`);
  console.log(`  к приведению (голые номера): ${bare.length}`);
  console.log(`  мусор (номер договора в поле раздела) — НЕ трогаем, решение владельца нужно: ${junk.length}`);

  const actor = { id: 'server', username: 'contracts:backfill-section-tokens', role: 'system' };
  let fixed = 0;
  const failed: Array<{ engineId: string; error: string }> = [];
  for (const item of bare) {
    if (!args.apply) {
      fixed += 1;
      continue;
    }
    const written = await setEntityAttribute(actor, item.engineId, ATTR, item.to, { allowSyncConflicts: true });
    if (!written.ok) {
      failed.push({ engineId: item.engineId, error: written.error });
      continue;
    }
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
