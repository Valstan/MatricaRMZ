import 'dotenv/config';

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { LedgerStore, type LedgerState } from '@matricarmz/ledger';

import { db, pool } from '../database/db.js';
import { decryptRowSensitiveWithKeyring, encryptRowSensitiveWithKeyring, loadKeyring } from '../ledger/dataKeyring.js';
import { PG_SYNC_TABLES } from '../services/sync/pgSyncTables.js';
import {
  CHAIN_BOOKKEEPING_FIELDS,
  backupDirAllowed,
  buildProjectionFromPg,
  diffStates,
  formatTableDiff,
  parseResnapshotArgs,
  type Row,
} from './resnapshotLedgerStatePlan.js';

// ledger:resnapshot-state — переснимает проекцию state.json из PostgreSQL.
//
// ЗАЧЕМ. Решение владельца 2026-09-04 (вариант А): истина — PostgreSQL, цепочка блоков —
// журнал. Второй прогон rebuild-state показал, что проекция отстала от цепочки на ~5,6 тыс.
// строк ещё в эпоху гонки, а сама цепочка держит блок-призрак (1000 транзакций, которых нет
// ни в PG, ни в проекции) и не знает о записях мимо ledger'а. Единственный источник, с которым
// живут клиенты (/state/snapshot, /state/changes), — PostgreSQL; проекция обязана совпадать с ним.
//
// ЧТО ДЕЛАЕТ. Без --apply: строит проекцию из PG (те же таблицы и та же DTO-форма, что у
// /state/snapshot — общая карта PG_SYNC_TABLES), сверяет с живым state.json по ОТКРЫТОМУ тексту
// и печатает потабличный отчёт. Ничего не пишет в леджер.
// С --apply: копирует живой state.json в --backup-dir (обязательно СНАРУЖИ каталога леджера),
// пишет новую проекцию через замок леджера (LedgerStore.saveState — та же атомарная запись,
// что у сервиса) и пересобирает checkpoint.json. Если за время работы head цепочки сдвинулся,
// проекция возвращается из бэкапа и код возврата 1: транзакции, приехавшие в окно между
// чтением PG и записью, в снимок не попали бы.
//
// ЧЕГО НЕ ДЕЛАЕТ. Не трогает блоки, index.json, ключи. Не импортирует ledgerService
// (getLedgerStore чинит state.json на месте — это мутация, не чтение). Таблицы без
// PG-источника (release_registry) берутся из живой проекции; при --chain-rebuilt <файл
// rebuild-state --out> в них добираются строки, которых в проекции нет или которые в цепочке
// новее — для этих таблиц цепочка единственный писатель.
//
// С --chain-rebuilt печатается и ВТОРОЙ отчёт — «цепочка ↔ PG» по PG-таблицам, по открытому
// тексту, без серверных штампов (last_server_seq, sync_status). Это единственное место, где
// цепочка сверяется с истиной: rebuild-state сам с данными не сверяется (вариант А — цепочка
// журнал, а не истина). «Только в цепочке» = попытки, которых истина не приняла, или строки,
// жёстко удалённые из PG; «только в PG» = записи мимо ledger'а; «разные» = PG новее.
//
// ЗАПУСК (на проде — вне окна ночного бэкапа):
//   corepack pnpm -F @matricarmz/backend-api ledger:resnapshot-state                       # только сверка
//   corepack pnpm -F @matricarmz/backend-api ledger:resnapshot-state -- --chain-rebuilt /tmp/rebuilt.json
//   corepack pnpm -F @matricarmz/backend-api ledger:resnapshot-state -- --apply --backup-dir ~/ledger-fix-backup-YYYYMMDD
//
// КОДЫ ВОЗВРАТА: 0 — сверка напечатана / запись выполнена и head не сдвинулся;
//                1 — head сдвинулся, проекция возвращена из бэкапа; 2 — отказ до начала работы.

const STATE_FILE = 'state.json';
const DATA_KEY_FILE = 'data-key.json';

function ledgerDir(): string {
  const raw = (process.env.MATRICA_LEDGER_DIR ?? '').trim();
  if (!raw) throw new Error('MATRICA_LEDGER_DIR не задан. Инструмент не угадывает каталог леджера.');
  const dir = resolve(raw);
  if (!existsSync(dir)) throw new Error(`каталог леджера не найден: ${dir}`);
  return dir;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

async function readPgTables(): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const [table, entry] of Object.entries(PG_SYNC_TABLES)) {
    const rows = (await db.select().from(entry.drizzle)) as Row[];
    out[table] = rows.map((r) => entry.toSyncRow(r));
    console.log(`  … PG ${table}: ${rows.length}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseResnapshotArgs(process.argv.slice(2));
  const dir = ledgerDir();
  const statePath = join(dir, STATE_FILE);
  if (!existsSync(statePath)) throw new Error(`state.json не найден: ${statePath}`);
  const keyring = loadKeyring(join(dir, DATA_KEY_FILE));
  if (!keyring) throw new Error(`data-key.json не найден в ${dir} — без keyring нельзя ни зашифровать новую проекцию, ни прочитать старую`);

  let backupDir = '';
  if (args.apply) {
    backupDir = resolve(args.backupDir);
    if (!backupDirAllowed(backupDir, dir, relative)) {
      throw new Error(`--backup-dir указывает внутрь каталога леджера (${backupDir}): файл уехал бы в ночной бэкап, а с префиксом state.json.bak. стал бы кандидатом на автовосстановление`);
    }
    mkdirSync(backupDir, { recursive: true });
  }

  const chainRebuilt = args.chainRebuiltPath
    ? ((readJson<{ state?: LedgerState }>(resolve(args.chainRebuiltPath)).state ?? null) as LedgerState | null)
    : null;
  if (args.chainRebuiltPath && !chainRebuilt) throw new Error(`--chain-rebuilt: в файле нет секции state (ожидается вывод rebuild-state --out)`);

  console.log(`ledger:resnapshot-state — ${args.apply ? 'ЗАПИСЬ проекции из PostgreSQL' : 'только сверка, ничего не меняет'}`);
  console.log(`  каталог леджера: ${dir}`);

  const store = new LedgerStore(dir);
  const headBefore = store.loadIndex().lastHeight;
  const started = process.hrtime.bigint();

  const pgTables = await readPgTables();
  const live = readJson<LedgerState>(statePath);
  const built = buildProjectionFromPg({
    pgTables,
    live,
    chainRebuilt,
    encryptRow: (row) => encryptRowSensitiveWithKeyring(row, keyring),
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`собрано за ${(elapsedMs / 1000).toFixed(1)} с, RSS ${mb(process.memoryUsage().rss)} МБ`);
  console.log(`  из PostgreSQL: ${built.fromPg.length} таблиц; из живой проекции: ${built.keptFromLive.join(', ') || '—'}`);
  for (const [t, n] of Object.entries(built.mergedFromChain)) console.log(`  из цепочки добрано в ${t}: ${n}`);

  const decrypt = (row: Row) => decryptRowSensitiveWithKeyring(row, keyring);
  const diffs = diffStates(built.state, live, decrypt);
  console.log(`\nСВЕРКА новой проекции (слева, PG) с живым state.json (справа), по открытому тексту:`);
  if (diffs.length === 0) console.log('  расхождений нет');
  for (const d of diffs) console.log('  ' + formatTableDiff(d).replace(/\n/g, '\n  '));
  let chainDiffs: ReturnType<typeof diffStates> | null = null;
  if (chainRebuilt) {
    chainDiffs = diffStates(chainRebuilt, built.state, decrypt, { ignoreFields: CHAIN_BOOKKEEPING_FIELDS, tables: built.fromPg });
    console.log(`\nСВЕРКА цепочки (слева, rebuild-state) с PG-проекцией (справа), по открытому тексту, без серверных штампов (${CHAIN_BOOKKEEPING_FIELDS.join(', ')}):`);
    if (chainDiffs.length === 0) console.log('  цепочка и PG совпадают по PG-таблицам');
    for (const d of chainDiffs) console.log('  ' + formatTableDiff(d, { left: 'цепочка', right: 'PG' }).replace(/\n/g, '\n  '));
  }
  if (args.reportPath) {
    writeFileSync(
      resolve(args.reportPath),
      JSON.stringify({ kind: 'matricarmz-ledger-resnapshot-report', at: Date.now(), headBefore, diffs, ...(chainDiffs ? { chainVsPg: chainDiffs } : {}) }, null, 2),
    );
    console.log(`отчёт: ${resolve(args.reportPath)}`);
  }

  if (!args.apply) {
    console.log('\nБез --apply запись не выполняется.');
    return;
  }

  const ts = Date.now();
  const backupPath = join(backupDir, `state.json.${ts}.before-resnapshot`);
  copyFileSync(statePath, backupPath);
  console.log(`\nбэкап живой проекции: ${backupPath} (${mb(statSync(backupPath).size)} МБ)`);

  store.saveState(built.state);
  const headAfter = store.loadIndex().lastHeight;
  if (headAfter !== headBefore) {
    store.saveState(readJson<LedgerState>(backupPath));
    console.log(`head сдвинулся за время работы (${headBefore} → ${headAfter}) — проекция ВОЗВРАЩЕНА из бэкапа. Повторите на затишье.`);
    process.exitCode = 1;
    return;
  }
  const checkpoint = store.buildCheckpoint();
  console.log(`state.json переснят: ${mb(statSync(statePath).size)} МБ; head ${headAfter}; checkpoint lastHeight=${checkpoint.lastHeight} stateHash=${checkpoint.stateHash.slice(0, 12)}…`);
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
