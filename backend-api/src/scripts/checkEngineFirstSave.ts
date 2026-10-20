import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { SyncTableName } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor } from '../services/sync/syncWriteService.js';

// engines:first-save-check — исполняемая приёмка «первый сейв новой карточки двигателя
// не теряется». Нужен живой PG: дефект жил на стыке push'а и триггера зеркала
// (`rebuild_erp_engine_card` создаёт ПУСТУЮ строку карточки со СВОИМ, серверным
// `updated_at` ещё до того, как применяется строка клиента) — на моках этой стык
// не существует, поэтому ни один тест «по модели» его не видел.
//
// Сценарий ровно тот, что делает «Добавить двигатель»: клиент сохранил карточку
// N секунд назад и отправил её ТЕМ ЖЕ батчем, что и саму сущность
// (`entities` + `erp_engine_cards`). Сервер обязан применить присланные значения,
// а не оставить пустую строку зеркала.
//
// Usage: MATRICA_FIXTURE_ALLOW_WRITE=1 pnpm -F @matricarmz/backend-api engines:first-save-check
// Пишет в БД и в ledger — только для одноразовой CI-базы, НЕ запускать на проде.

let failures = 0;

function ok(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
}

function eq(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, pass, `ожидалось: ${JSON.stringify(expected)}\n      получено:  ${JSON.stringify(actual)}`);
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await pool.query(sql, params as never[]);
  return ((r.rows[0] as Record<string, unknown> | undefined)?.['v'] as T | undefined) ?? null;
}

const ACTOR: SyncWriteActor = { id: 'server', username: 'engines:first-save-check', role: 'system' };

async function ensureEngineNumberDef(entityTypeId: string): Promise<void> {
  const existing = await scalar<string>(
    `SELECT id::text AS v FROM attribute_defs WHERE entity_type_id = $1 AND code = 'engine_number' LIMIT 1`,
    [entityTypeId],
  );
  if (existing) return;
  const now = Date.now();
  await pool.query(
    `INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, created_at, updated_at, sync_status)
     VALUES ($1, $2, 'engine_number', 'Номер двигателя', 'text', false, 0, $3, $3, 'synced')`,
    [randomUUID(), entityTypeId, now],
  );
}

async function main(): Promise<void> {
  if (process.env.MATRICA_FIXTURE_ALLOW_WRITE !== '1') {
    console.error('Отказ: скрипт пишет в БД. Запускать только с MATRICA_FIXTURE_ALLOW_WRITE=1 (одноразовая база).');
    process.exit(2);
  }

  const typeId = await scalar<string>(
    `SELECT id::text AS v FROM entity_types WHERE code = 'engine' LIMIT 1`,
  );
  if (!typeId) {
    console.error('Нет типа сущности engine — база не мигрирована.');
    process.exit(2);
  }
  await ensureEngineNumberDef(typeId);

  const engineId = randomUUID();
  const stamp = Date.now();
  // Клиент сохранил карточку за 20 секунд до отправки: серверный штамп зеркала
  // (clock_timestamp в момент push'а) заведомо позже — именно это и обгоняло строку клиента.
  const savedAt = stamp - 20_000;
  const values = {
    engineNumber: `SMK-FS-${stamp}`,
    engineBrand: 'Фикстура-бренд',
    engineNote: 'первый сейв новой карточки',
    arrivalDate: savedAt - 86_400_000,
  };

  console.log('\n== 1. Клиент отправил новую сущность и карточку одним батчем ==');
  await writeSyncChanges(
    [
      {
        type: 'upsert',
        table: SyncTableName.Entities,
        row_id: engineId,
        row: {
          id: engineId,
          type_id: typeId,
          created_at: savedAt,
          updated_at: savedAt,
          deleted_at: null,
          sync_status: 'synced',
        },
      },
      {
        type: 'upsert',
        table: SyncTableName.ErpEngineCards,
        row_id: engineId,
        row: {
          id: engineId,
          engine_number: values.engineNumber,
          engine_brand: values.engineBrand,
          engine_note: values.engineNote,
          arrival_date: values.arrivalDate,
          created_at: savedAt,
          updated_at: savedAt,
          deleted_at: null,
          sync_status: 'pending',
          last_server_seq: null,
        },
      },
    ],
    ACTOR,
    { allowSyncConflicts: true },
  );
  ok('батч принят без исключения', true);

  try {
    console.log('\n== 2. Значения доехали до строгой строки карточки ==');
    const card = await pool.query(
      `SELECT engine_number, engine_brand, engine_note, arrival_date,
              sync_status, last_server_seq, updated_at
         FROM erp_engine_cards WHERE id = $1`,
      [engineId],
    );
    const row = card.rows[0] as Record<string, unknown> | undefined;
    ok('строка карточки существует', Boolean(row), 'строка не создана вовсе');
    eq('номер двигателя применён (не затёрт пустым зеркалом)', row?.['engine_number'] ?? null, values.engineNumber);
    eq('марка применена', row?.['engine_brand'] ?? null, values.engineBrand);
    eq('примечание применено', row?.['engine_note'] ?? null, values.engineNote);
    eq('дата прихода применена', Number(row?.['arrival_date'] ?? 0), values.arrivalDate);
    ok(
      'строка получила номер журнала (иначе не уедет инкрементальным pull)',
      row?.['last_server_seq'] != null,
      'last_server_seq = NULL: строка невидима для инкрементального pull',
    );

    console.log('\n== 3. EAV-след записан (старые клиенты читают его до E5-freeze) ==');
    const attr = await scalar<string>(
      `SELECT v.value_json AS v
         FROM attribute_values v
         JOIN attribute_defs d ON d.id = v.attribute_def_id
        WHERE v.entity_id = $1 AND d.code = 'engine_number' AND v.deleted_at IS NULL
        LIMIT 1`,
      [engineId],
    );
    eq('engine_number лёг в EAV', attr == null ? null : String(attr).replace(/^"|"$/g, ''), values.engineNumber);

    console.log('\n== 4. Следующий сейв (новее) применяется — обычный LWW жив ==');
    const laterSave = await writeSyncChanges(
      [
        {
          type: 'upsert',
          table: SyncTableName.ErpEngineCards,
          row_id: engineId,
          row: {
            id: engineId,
            engine_number: values.engineNumber,
            engine_brand: values.engineBrand,
            engine_note: 'правка после первого сейва',
            arrival_date: values.arrivalDate,
            created_at: savedAt,
            updated_at: stamp + 5_000,
            deleted_at: null,
            sync_status: 'pending',
            last_server_seq: null,
          },
        },
      ],
      ACTOR,
      { allowSyncConflicts: true },
    );
    ok('батч второго сейва принят', laterSave.dbApplied > 0, `dbApplied=${laterSave.dbApplied}`);
    const afterSecond = await scalar<string>(
      `SELECT engine_note AS v FROM erp_engine_cards WHERE id = $1`,
      [engineId],
    );
    eq('правка применена', afterSecond, 'правка после первого сейва');

    console.log('\n== 5. Устаревший сейв отклоняется — LWW не отключён ==');
    const stale = await writeSyncChanges(
      [
        {
          type: 'upsert',
          table: SyncTableName.ErpEngineCards,
          row_id: engineId,
          row: {
            id: engineId,
            engine_number: values.engineNumber,
            engine_brand: values.engineBrand,
            engine_note: 'устаревшая правка',
            arrival_date: values.arrivalDate,
            created_at: savedAt,
            updated_at: stamp + 1_000,
            deleted_at: null,
            sync_status: 'pending',
            last_server_seq: null,
          },
        },
      ],
      ACTOR,
      { allowSyncConflicts: true },
    );
    const afterStale = await scalar<string>(
      `SELECT engine_note AS v FROM erp_engine_cards WHERE id = $1`,
      [engineId],
    );
    eq('устаревшая правка не перезаписала карточку', afterStale, 'правка после первого сейва');
    ok('отказ LWW виден в счётчиках (не молчит)', stale.dbApplied === 0, `dbApplied=${stale.dbApplied}`);
  } finally {
    // Фикстура не должна пережить проверку: строка живёт в карточках, сущности и EAV.
    await pool.query(`DELETE FROM attribute_values WHERE entity_id = $1`, [engineId]).catch(() => {});
    await pool.query(`DELETE FROM erp_engine_cards WHERE id = $1`, [engineId]).catch(() => {});
    await pool.query(`DELETE FROM entities WHERE id = $1`, [engineId]).catch(() => {});
  }

  if (failures > 0) {
    console.log(`\nFAIL: проверок провалено ${failures}`);
    process.exit(1);
  }
  console.log('\nPASS: первый сейв новой карточки не теряется');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(2);
  })
  .finally(() => {
    void pool.end();
  });
