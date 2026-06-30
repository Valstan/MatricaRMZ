/**
 * Ротация ключа шифрования ledger (`data-key.json`).
 *
 * Что делает:
 *  1. Загружает keyring из `data-key.json` (или создаёт legacy-обёртку для старого формата).
 *  2. Добавляет новый случайный ключ, делает его активным.
 *  3. Перешифровывает все `meta_json` / `payload_json` в `state.json`, которые зашифрованы
 *     старым ключом или enc:v1, на enc:v2 с новым активным ключом.
 *  4. Сохраняет обновлённый `data-key.json` (теперь в keyring-формате) и `state.json`.
 *  5. Делает резервные копии до записи.
 *
 * Что НЕ делает:
 *  - Не трогает файлы в `blocks/` — это append-only история, перешифровка нарушит хэши.
 *  - Не удаляет старые ключи из keyring. Они остаются навсегда, чтобы можно было
 *    перечитать историю блоков при replay/verify (там данные зашифрованы старыми ключами).
 *
 * Безопасность:
 *  - Запускать с остановленным backend (или быть готовым к рестарту после).
 *  - Резервная копия state.json создаётся автоматически: `state.json.bak.<ts>.before-rotate`.
 *
 * Usage:
 *   pnpm --filter @matricarmz/backend-api exec tsx src/scripts/rotateLedgerDataKey.ts
 *   pnpm --filter @matricarmz/backend-api exec tsx src/scripts/rotateLedgerDataKey.ts --dry-run
 *   MATRICA_LEDGER_DIR=/custom/path pnpm ... rotateLedgerDataKey.ts
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  decryptWithKeyring,
  encryptWithKeyring,
  isStaleEncrypted,
  loadKeyring,
  rotateAddNewActiveKey,
  saveKeyring,
} from '../ledger/dataKeyring.js';

const DATA_KEY_FILE = 'data-key.json';
const STATE_FILE = 'state.json';

function resolveLedgerDir(): string {
  return process.env.MATRICA_LEDGER_DIR ? resolve(process.env.MATRICA_LEDGER_DIR) : resolve(process.cwd(), 'ledger');
}

function parseArgs(): { dryRun: boolean } {
  const argv = process.argv.slice(2);
  return { dryRun: argv.includes('--dry-run') };
}

function reencryptStaleStringsInRow(
  row: Record<string, unknown>,
  oldKeyring: Parameters<typeof decryptWithKeyring>[1],
  newKeyring: Parameters<typeof encryptWithKeyring>[1],
): { row: Record<string, unknown>; touched: number } {
  const next = { ...row };
  let touched = 0;
  for (const field of ['meta_json', 'payload_json']) {
    const val = next[field];
    if (typeof val !== 'string') continue;
    if (!isStaleEncrypted(val, newKeyring)) continue;
    // Дешифруем через старый keyring (он содержит и старые ключи, и новый, потому что мы их объединяем);
    // шифруем через newKeyring активным id.
    const plain = decryptWithKeyring(val, oldKeyring);
    next[field] = encryptWithKeyring(plain, newKeyring);
    touched += 1;
  }
  return { row: next, touched };
}

async function main() {
  const { dryRun } = parseArgs();
  const ledgerDir = resolveLedgerDir();
  const keyPath = join(ledgerDir, DATA_KEY_FILE);
  const statePath = join(ledgerDir, STATE_FILE);

  if (!existsSync(keyPath)) {
    console.error(`[rotate] data-key.json не найден по пути ${keyPath}`);
    process.exit(2);
  }
  if (!existsSync(statePath)) {
    console.error(`[rotate] state.json не найден по пути ${statePath}`);
    process.exit(2);
  }

  const current = loadKeyring(keyPath);
  if (!current) {
    console.error('[rotate] data-key.json повреждён или непригоден для чтения');
    process.exit(3);
  }
  console.log(`[rotate] текущий keyring: ${current.keys.length} ключ(ей), activeId=${current.activeId}`);

  const { keyring: rotated, newKeyId } = rotateAddNewActiveKey(current);
  console.log(`[rotate] добавлен новый активный ключ id=${newKeyId} (всего ключей: ${rotated.keys.length})`);

  // Загружаем state.json и проходим все таблицы / строки.
  const stateRaw = readFileSync(statePath, 'utf8');
  const state = JSON.parse(stateRaw) as { tables?: Record<string, Record<string, Record<string, unknown>>> };
  if (!state || typeof state !== 'object' || !state.tables) {
    console.error('[rotate] state.json не содержит секцию `tables`');
    process.exit(4);
  }

  let totalRows = 0;
  let touchedRows = 0;
  let touchedFields = 0;
  for (const tableName of Object.keys(state.tables)) {
    const tableRows = state.tables[tableName] ?? {};
    for (const rowKey of Object.keys(tableRows)) {
      totalRows += 1;
      const original = tableRows[rowKey];
      if (!original || typeof original !== 'object') continue;
      const { row: nextRow, touched } = reencryptStaleStringsInRow(original, rotated, rotated);
      if (touched > 0) {
        touchedRows += 1;
        touchedFields += touched;
        if (!dryRun) tableRows[rowKey] = nextRow;
      }
    }
  }

  console.log(`[rotate] сканировано строк: ${totalRows}; перешифровано полей: ${touchedFields} в ${touchedRows} строках`);

  if (dryRun) {
    console.log('[rotate] --dry-run: записи на диск НЕ выполнены');
    return;
  }

  // Резервная копия state.json и data-key.json
  const ts = Date.now();
  copyFileSync(statePath, `${statePath}.bak.${ts}.before-rotate`);
  copyFileSync(keyPath, `${keyPath}.bak.${ts}.before-rotate`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  saveKeyring(keyPath, rotated);
  console.log(`[rotate] state.json и data-key.json обновлены; бэкапы сохранены с суффиксом .bak.${ts}.before-rotate`);
  console.log('[rotate] следующий шаг: chmod 600 data-key.json и рестарт backend (primary -> health -> secondary).');
}

main().catch((e) => {
  console.error('[rotate] ошибка:', e);
  process.exit(1);
});
