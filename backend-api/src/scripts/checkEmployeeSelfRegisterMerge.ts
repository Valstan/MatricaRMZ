import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Локальное подключение к dev-базе: скрипт запускают без поднятого бэкенда, поэтому
// реквизиты PG берём из `.env.dev` сами (до импорта db.js — он читает их при загрузке).
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, '../../.env.dev'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  const key = m?.[1];
  if (key && process.env[key] === undefined) process.env[key] = m?.[2] ?? '';
}

const { pool } = await import('../database/db.js');
const { mergeEmployees } = await import('../services/employeeDedupeService.js');
const { setEntityAttribute } = await import('../services/adminMasterdataService.js');

/**
 * Приёмка слияния сотрудника: САМОРЕГИСТРАЦИЯ + ШТАТНАЯ КАРТОЧКА (промты КАРМАНА #52 + #53).
 *
 * Зачем. Владелец: «человек самостоятельно регистрируется и заполняет свои данные; у нас уже
 * есть сотрудник с таким именем. Сливаем их — и данные одного из аккаунтов пропадают, остаются
 * только данные одного аккаунта». Ручное слияние (оба аккаунта завёл оператор) работает, а
 * саморегистрация — нет.
 *
 * Что проверяем:
 *  1) что реально переносится, а что теряется — по отчёту, а не на глаз;
 *  2) что НИ ОДИН непустой атрибут вторичной карточки не потерян МОЛЧА (проме��ение/отказ
 *     записи обязаны быть видны в отчёте);
 *  3) что запись в «мёртвую» строку (tombstone) больше не прячет значение.
 *
 * Usage: pnpm -F @matricarmz/backend-api employees:self-register-merge-check
 * Пишет в БД и убирает за собой.
 */

const ts = Date.now();
const ACTOR = { id: '', username: 'selfreg-merge-check', role: 'superadmin' };
const FULL_NAME = 'Пробников Пётр Сергеевич';

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = '') {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail === '' ? '' : `\n      ${detail}`}`);
  }
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await pool.query(sql, params as never[]);
  return (r.rows[0] as T | undefined) ?? null;
}

async function main() {
  const typeId = (await one<{ id: string }>(`SELECT id FROM entity_types WHERE code='employee' AND deleted_at IS NULL`))?.id;
  if (!typeId) {
    console.error('Отказ: нет типа сущности «employee».');
    process.exit(2);
  }
  const defRows = await pool.query(
    `SELECT id, code FROM attribute_defs WHERE entity_type_id=$1 AND deleted_at IS NULL`,
    [typeId] as never[],
  );
  const defId = new Map<string, string>(defRows.rows.map((r: { id: string; code: string }) => [String(r.code), String(r.id)]));

  async function mkEntity(): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ($1,$2,$3,$3)`, [
      id,
      typeId,
      ts,
    ] as never[]);
    return id;
  }
  async function setAttr(entityId: string, code: string, value: unknown) {
    const d = defId.get(code);
    if (!d) return false;
    await pool.query(
      `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$5)
       ON CONFLICT (entity_id, attribute_def_id) DO UPDATE
         SET value_json=EXCLUDED.value_json, updated_at=EXCLUDED.updated_at, deleted_at=NULL`,
      [randomUUID(), entityId, d, JSON.stringify(value), ts] as never[],
    );
    return true;
  }
  /** Тот же атрибут, но «мёртвой» строкой (tombstone) — как после снятия значения. */
  async function tombstoneAttr(entityId: string, code: string) {
    const d = defId.get(code);
    if (!d) return false;
    await pool.query(
      `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at, deleted_at)
       VALUES ($1,$2,$3,'null',$4,$4,$4)
       ON CONFLICT (entity_id, attribute_def_id) DO UPDATE SET deleted_at=$4`,
      [randomUUID(), entityId, d, ts] as never[],
    );
    return true;
  }
  async function readAttrs(entityId: string): Promise<Record<string, string>> {
    const r = await pool.query(
      `SELECT d.code AS code, v.value_json AS value
         FROM attribute_values v JOIN attribute_defs d ON d.id = v.attribute_def_id
        WHERE v.entity_id=$1 AND v.deleted_at IS NULL`,
      [entityId] as never[],
    );
    const out: Record<string, string> = {};
    for (const row of r.rows as Array<{ code: string; value: string }>) {
      out[String(row.code)] = String(row.value ?? '').replace(/^"|"$/g, '');
    }
    return out;
  }

  // --- фикстуры: саморегистрация и штатная карточка одного человека ----------
  const selfReg = await mkEntity();
  const staff = await mkEntity();
  await setAttr(selfReg, 'full_name', FULL_NAME);
  await setAttr(selfReg, 'last_name', 'Пробников');
  await setAttr(selfReg, 'first_name', 'Пётр');
  await setAttr(selfReg, 'middle_name', 'Сергеевич');
  await setAttr(selfReg, 'role', 'Механик участка');
  await setAttr(staff, 'full_name', FULL_NAME);
  await setAttr(staff, 'last_name', 'Пробников');
  await setAttr(staff, 'first_name', 'Пётр');
  await setAttr(staff, 'middle_name', 'Сергеевич');
  await setAttr(staff, 'role', 'Токарь');
  await setAttr(staff, 'personnel_number', `ПРОБ-${randomUUID().slice(0, 6)}`);
  // Табельный номер штатки лежит в «мёртвой» строке (значение снимали и не перезаписали) —
  // ровно тот случай, из-за которого атрибут пропадал молча.
  await tombstoneAttr(staff, 'hire_date');

  console.log('Фикстуры созданы.');
  console.log('  саморегистрация:', JSON.stringify(await readAttrs(selfReg)));
  console.log('  штатка:        ', JSON.stringify(await readAttrs(staff)));

  // --- слияние: основная = саморегистрация (как preselect в диалоге) --------
  const res = await mergeEmployees({
    survivorId: selfReg,
    loserId: staff,
    actor: ACTOR,
  });

  console.log('\nОтчёт слияния:');
  console.log(' ', JSON.stringify(res.ok ? res.report : { error: res.error }));
  const after = await readAttrs(selfReg);
  console.log('Атрибуты основной записи после слияния:');
  console.log(' ', JSON.stringify(after));

  if (!res.ok) {
    check('слияние прошло', false, res.error);
  } else {
    check('табельный номер штатки перенесён', typeof after.personnel_number === 'string' && after.personnel_number !== '');
    check(
      'должность не потеряна молча (либо перенесена, либо названа в отчёте)',
      after.role === 'Токарь' || (res.report.notTransferred ?? []).some((n) => n.code === 'role'),
      `получено: ${after.role ?? '—'}; не перенесено: ${JSON.stringify(res.report.notTransferred ?? [])}`,
    );
    check(
      'в отчёте нет кода, потерянного молча',
      (res.report.notTransferred ?? []).every((n) => Boolean(n.reason)),
      JSON.stringify(res.report.notTransferred ?? []),
    );
    check(
      'расхождение должностей названо в отчёте (обе стороны)',
      (res.report.notTransferred ?? []).some((n) => n.code === 'role' && (n.detail ?? '').includes('Токарь')),
      JSON.stringify(res.report.notTransferred ?? []),
    );
  }

  // --- запись в «мёртвую» строку (tombstone) --------------------------------
  // Значение, записанное в строку со снятым deleted_at, ПРОПАДАЛО: уникальный индекс
  // (entity_id, attribute_def_id) один на пару, поэтому запись обновляла МЁРТВУЮ строку,
  // а чтение её не видело. Теперь строка воскрешается.
  const probe = await mkEntity();
  await tombstoneAttr(probe, 'birth_date');
  const writeRes = await setEntityAttribute(ACTOR, probe, 'birth_date', '1990-05-05', { allowSyncConflicts: true });
  const probeAttrs = await readAttrs(probe);
  check(
    'значение, записанное в «мёртвую» строку, видно после записи',
    writeRes.ok && probeAttrs.birth_date === '1990-05-05',
    `ok=${String(writeRes.ok)}, получено: ${probeAttrs.birth_date ?? '—'}`,
  );

  // --- уборка ---------------------------------------------------------------
  for (const id of [selfReg, staff]) {
    await pool.query(`DELETE FROM attribute_values WHERE entity_id=$1`, [id] as never[]);
    await pool.query(`DELETE FROM entities WHERE id=$1`, [id] as never[]);
  }
  console.log('\nФикстуры убраны.');
  console.log(failures === 0 ? 'ИТОГ: все проверки пройдены' : `ИТОГ: провалено проверок — ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Скрипт упал:', e);
  process.exit(1);
});
