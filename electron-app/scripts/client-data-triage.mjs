#!/usr/bin/env node
/**
 * Разбор снимка клиента «Матрица РМЗ» — почему введённое не уходит на сервер.
 *
 * Вход: КОПИЯ папки `%APPDATA%\MatricaRMZ\` с машины оператора (файл БД, `-wal`, `-shm`,
 * `pending-export-*.json`, логи). Снимок НЕ правится: база открывается на копии во
 * временной папке, оригинал не трогаем.
 *
 * Что делает (план КАРМАНА #83, шаг 2 «диагностика по снимку»):
 *   1. перечисляет, что в папке;
 *   2. считает неотправленные строки в файлах экспорта (`pending-export-*.json`);
 *   3. считает строки в очереди синка по локальной БД (`sync_status`): `pending` и
 *      карантин `errored`;
 *   4. вытаскивает из логов важные строки: `schema rebuild`, `pending export saved`,
 *      `pending replay partial`;
 *   5. раскладывает данные по трём состояниям (а)/(б)/(в) — по ним и решается, что чинить.
 *
 * Значения строк не выводит: только таблицы, количества и коды (ПДн — по D-041).
 *
 *   node electron-app/scripts/client-data-triage.mjs <путь к папке снимка>
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Проверка инструмента на синтетической копии папки оператора.
 *
 * Зачем: инструмент читает снимок, которого у нас нет (машина оператора выключена), —
 * а проверить его надо сейчас, до того как он понадобится. Синтетическая копия — это
 * ровно то, что приедет с машины: `matricarmz.sqlite` + `pending-export-*.json` + лог.
 *
 * Проверка идёт ЧЕРЕЗ сам инструмент (тот же файл, отдельным процессом): так проверяется
 * не только разбор, но и весь путь «скопировал снимок → прочитал → отдал вывод».
 */
function buildSyntheticSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), 'client-data-triage-selftest-'));
  const Database = require('better-sqlite3');
  const db = new Database(join(dir, 'matricarmz.sqlite'));
  db.exec(`
    create table settings (key text primary key, value text);
    create table entities (id text primary key not null, type_id text, updated_at integer not null, deleted_at integer, sync_status text);
    create table attribute_values (id text primary key not null, entity_id text, attribute_def_id text, value_json text, updated_at integer not null, deleted_at integer, sync_status text);
  `);
  const insSetting = db.prepare('insert into settings (key, value) values (?, ?)');
  insSetting.run('ClientSchemaVersion', '17');
  insSetting.run('ServerSchemaHash', 'abc123');
  db.prepare('insert into entities (id, type_id, updated_at, sync_status) values (?, ?, ?, ?)').run(
    'ent-1',
    'type-1',
    1700000000000,
    'pending',
  );
  db.prepare('insert into entities (id, type_id, updated_at, sync_status) values (?, ?, ?, ?)').run(
    'ent-2',
    'type-1',
    1700000100000,
    'synced',
  );
  db.prepare(
    'insert into attribute_values (id, entity_id, attribute_def_id, value_json, updated_at, sync_status) values (?, ?, ?, ?, ?, ?)',
  ).run('av-1', 'ent-1', 'def-1', '"x"', 1700000200000, 'error');
  db.close();

  writeFileSync(
    join(dir, 'pending-export-2026-11-24T10-00-00-000Z.json'),
    JSON.stringify({
      version: 1,
      exportedAt: 1700000500000,
      appVersion: '3.135.0',
      reason: 'schema_mismatch',
      packs: [
        { table: 'entities', rows: [{ id: 'ent-3', type_id: 'type-1', updated_at: 1700000400000 }] },
        { table: 'attribute_values', rows: [{ id: 'av-2', entity_id: 'ent-1', updated_at: 1700000450000 }] },
      ],
    }),
    'utf8',
  );

  writeFileSync(
    join(dir, 'client.log'),
    [
      'schema rebuild: missing migrations 17 -> 18',
      'pending export saved rows=42 file=pending-export-2026-11-24T10-00-00-000Z.json',
      'pending replay partial restored=40 failed=2 file kept: pending-export-2026-11-24T10-00-00-000Z.json',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

function selfTest() {
  const dir = buildSyntheticSnapshot();
  try {
    const out = execFileSync(process.execPath, [process.argv[1], dir], { encoding: 'utf8' });
    console.log(out);
    const checks = [
      ['версия схемы клиента прочитана', /ClientSchemaVersion=17/.test(out)],
      ['хеш схемы сервера прочитан', /ServerSchemaHash=abc123/.test(out)],
      ['pending посчитан', /pending \(ждёт отправки\): 1/.test(out)],
      ['карантин посчитан', /errored \(карантин — клиент сам не воскресит\): 1/.test(out)],
      ['строки в файле экспорта посчитаны', /строк: 2/.test(out)],
      ['версия выгрузки видна', /приложение 3\.135\.0/.test(out)],
      ['пересборка в логе найдена', /schema rebuild: missing migrations 17 -> 18/.test(out)],
      ['частичный реплей найден', /pending replay partial/.test(out)],
      ['вывод по трём состояниям есть', /\(а\) в локальной БД/.test(out) && /\(б\) только в файлах экспорта/.test(out)],
    ];
    console.log('--- self-test ---');
    let failed = 0;
    for (const [name, ok] of checks) {
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
      if (!ok) failed += 1;
    }
    if (failed > 0) {
      console.error(`self-test: провалено ${failed} проверок`);
      process.exit(1);
    }
    console.log(`self-test: все ${checks.length} проверок пройдены (синтетическая копия ${dir})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const folder = process.argv[2];
if (process.argv[2] === '--self-test') {
  selfTest();
  process.exit(0);
}
if (!folder) {
  console.error('Укажи папку со снимком: node electron-app/scripts/client-data-triage.mjs <путь>');
  console.error('Проверка инструмента на синтетической копии: node electron-app/scripts/client-data-triage.mjs --self-test');
  process.exit(2);
}
if (!existsSync(folder)) {
  console.error(`Папки нет: ${folder}`);
  process.exit(2);
}

const nameOf = (p) => p.split(/[\\/]/).pop();
const sizeOf = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};
const human = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} КБ` : `${bytes} Б`;

const entries = readdirSync(folder, { withFileTypes: true });
console.log(`Снимок клиента: ${folder}`);
console.log('\nФайлы:');
for (const e of entries) {
  if (!e.isFile()) continue;
  console.log(`  ${e.name} — ${human(sizeOf(join(folder, e.name)))}`);
}

// ── 1. Файлы экспорта неотправленных строк ──────────────────────────────────
let exportRows = 0;
const exportByTable = new Map();
const exportFiles = entries.filter((e) => e.isFile() && /^pending-export-.*\.json$/i.test(e.name)).map((e) => e.name);
if (exportFiles.length) {
  console.log('\nНеотправленные строки в файлах экспорта (pending-export):');
  for (const f of exportFiles) {
    let data;
    try {
      data = JSON.parse(readFileSync(join(folder, f), 'utf8'));
    } catch (e) {
      console.log(`  ${f} — не разобран: ${String(e).slice(0, 120)}`);
      continue;
    }
    const packs = Array.isArray(data?.packs) ? data.packs : [];
    let rows = 0;
    const byTable = new Map();
    for (const p of packs) {
      const n = Array.isArray(p?.rows) ? p.rows.length : 0;
      rows += n;
      byTable.set(String(p?.table ?? '?'), n);
    }
    exportRows += rows;
    for (const [t, n] of byTable) exportByTable.set(t, (exportByTable.get(t) ?? 0) + n);
    console.log(`  ${f} — приложение ${data?.appVersion ?? '?'}, выгружено ${data?.exportedAt ?? '?'}, паков: ${packs.length}, строк: ${rows}`);
    for (const [t, n] of byTable) console.log(`      ${t}: ${n}`);
  }
} else {
  console.log('\nНеотправленные строки в файлах экспорта: файлов нет');
}

// ── 2. Локальная БД: очередь синка и карантин ────────────────────────────────
const dbName = entries.find((e) => e.isFile() && e.name === 'matricarmz.sqlite')?.name;
const pendingByTable = new Map();
const erroredByTable = new Map();
let schemaInfo = '';
if (dbName) {
  const tmp = mkdtempSync(join(tmpdir(), 'ppe-triage-'));
  try {
    // Копия целиком: WAL-файл виден только рядом с базой, а readonly-режим с WAL
    // требует прав на -shm — поэтому читаем копию, оригинал не трогаем.
    for (const suffix of ['', '-wal', '-shm']) {
      const src = join(folder, `${dbName}${suffix}`);
      if (existsSync(src)) cpSync(src, join(tmp, `${dbName}${suffix}`));
    }
    const Database = require('better-sqlite3');
    const db = new Database(join(tmp, dbName), { readonly: true, fileMustExist: true });
    const tables = db
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
      .all()
      .map((r) => String(r.name));
    for (const t of tables) {
      const cols = db.prepare(`pragma table_info("${t}")`).all().map((c) => String(c.name));
      if (!cols.includes('sync_status')) continue;
      for (const row of db.prepare(`select sync_status as s, count(*) as n from "${t}" group by sync_status`).all()) {
        const st = String(row.s ?? '');
        const n = Number(row.n ?? 0);
        if (!n) continue;
        if (st === 'pending') pendingByTable.set(t, (pendingByTable.get(t) ?? 0) + n);
        // Карантин клиент пишет как 'error' (syncService.ts: collectPending/recoverErroredRows),
        // а не 'errored' — счётчик по 'errored' всегда был нулём, и строки карантина
        // (которые клиент сам не воскресит) были не видны в разборе. Значение 'errored'
        // тоже принимаем: снимок мог сделан другой сборкой.
        else if (st === 'error' || st === 'errored') erroredByTable.set(t, (erroredByTable.get(t) ?? 0) + n);
      }
    }
    if (tables.includes('settings')) {
      const cols = db.prepare('pragma table_info("settings")').all().map((c) => String(c.name));
      const keyCol = cols.includes('key') ? 'key' : cols.includes('name') ? 'name' : null;
      const valCol = cols.includes('value') ? 'value' : cols.includes('value_json') ? 'value_json' : null;
      if (keyCol && valCol) {
        const rows = db.prepare(`select "${keyCol}" as k, "${valCol}" as v from settings`).all();
        const wanted = rows.filter((r) => /schema|version|hash/i.test(String(r.k ?? '')));
        if (wanted.length) {
          schemaInfo = wanted
            .map((r) => `${String(r.k)}=${String(r.v ?? '').slice(0, 80)}`)
            .join('; ');
        }
      }
    }
    db.close();
  } catch (e) {
    console.log(`\nБД не прочитана: ${String(e).slice(0, 200)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const pendingTotal = [...pendingByTable.values()].reduce((a, b) => a + b, 0);
const erroredTotal = [...erroredByTable.values()].reduce((a, b) => a + b, 0);
console.log('\nОчередь синка в локальной БД (sync_status):');
if (pendingByTable.size) {
  console.log(`  pending (ждёт отправки): ${pendingTotal}`);
  for (const [t, n] of pendingByTable) console.log(`      ${t}: ${n}`);
} else {
  console.log('  pending: 0');
}
if (erroredByTable.size) {
  console.log(`  errored (карантин — клиент сам не воскресит): ${erroredTotal}`);
  for (const [t, n] of erroredByTable) console.log(`      ${t}: ${n}`);
} else {
  console.log('  errored: 0');
}
if (schemaInfo) console.log(`\nВерсия схемы клиента: ${schemaInfo}`);

// ── 3. Логи: важные строки ──────────────────────────────────────────────────
const logFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.log')).map((e) => e.name);
if (logFiles.length) {
  const interesting = /schema rebuild|pending export saved|pending replay partial|schema mismatch|resetLocalDatabase/i;
  console.log('\nСтроки лога, важные для разбора:');
  let shown = 0;
  for (const f of logFiles) {
    let text = '';
    try {
      text = readFileSync(join(folder, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!interesting.test(line)) continue;
      console.log(`  [${f}] ${line.slice(0, 300)}`);
      shown += 1;
      if (shown >= 60) break;
    }
    if (shown >= 60) break;
  }
  if (!shown) console.log('  (важных строк нет)');
}

// ── 4. Вывод: три состояния данных ──────────────────────────────────────────
console.log('\nВывод (по плану #83):');
console.log(
  `  (а) в локальной БД: pending=${pendingTotal}, карантин=${erroredTotal} ⇒ чинить КЛИЕНТ (миграция/схема), а не пересборкой БД;`,
);
console.log(
  `  (б) только в файлах экспорта: ${exportRows} строк ⇒ БД уже пересобрана, разбирать реплей (replayPendingExports);`,
);
console.log(
  `  (в) карантин/серверные таблицы: клиент их не пошлёт никогда ⇒ запись СЕРВЕРНОЙ дверью домена, не ручным SQL и не клиентским пушем.`,
);
console.log('\nДальше: починка причины → перенос в штатный путь записи → приёмка по объёмам (без выгрузки ПДн).');
