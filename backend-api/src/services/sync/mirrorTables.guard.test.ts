import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SERVER_MANAGED_SYNC_TABLES, SyncTableName } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

// Сторож транспортного шва «таблица-зеркало ↔ карты pull» (PR-6, вскрыт смоуком 2026-10-17).
//
// Шов нашёлся вживую, на стенде: строки Кладовщика/СИЗ перепубликовывались КАЖДЫЕ 60 секунд
// (никто не снимал sync_status='pending' — 29 записей журнала на одну строку за полчаса),
// а холодный снапшот отдавал по этим таблицам пустоту, то есть свежая машина оставалась
// без модуля целиком. Каждый PR серии по отдельности был зелёным — шов живёт между ними
// (brain #166). Этот тест держит обе половины механизма вместе: карты pull и обработчик
// применения в applyPushBatch.
//
// Проверка по тексту, а не импортом applyPushBatch: он тянет половину приложения
// (образец — syncTableOwnership.guard.test.ts).

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** Имена таблиц, объявленных в карте `PG_SYNC_TABLES` файла-источника. */
function pgMapTables(source: string): string[] {
  const start = source.indexOf('PG_SYNC_TABLES');
  expect(start, 'блок PG_SYNC_TABLES не найден — тест устарел вместе с файлом').toBeGreaterThan(-1);
  // Именно `= {`, а не первая `{`: между именем и телом стоит аннотация типа
  // со своими фигурными скобками.
  const assign = source.indexOf('= {', start);
  expect(assign, 'тело PG_SYNC_TABLES не найдено').toBeGreaterThan(-1);
  const open = assign + 2;
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open, end);
  const names = new Set<string>();
  for (const m of body.matchAll(/\[(?:SyncTableName|LedgerTableName)\.(\w+)\]\s*:/g)) {
    names.add(String(m[1]));
  }
  return Array.from(names).sort();
}

/** Имена таблиц, которые публикует издатель зеркала СИЗ (ppeSyncPublisherService.ts). */
function publisherTableKeys(source: string): string[] {
  const keys = new Set(Array.from(source.matchAll(/SyncTableName\.(\w+)/g)).map((m) => String(m[1])));
  return Array.from(keys).sort();
}

/**
 * Издатели зеркал, чьи таблицы обязаны быть в `SERVER_MIRROR_TABLES`.
 *
 * Список не «весь подряд»: справочники (договоры, контрагенты, склады) и аккаунты
 * ведут серверные обработчики в applyPushBatch отдельной веткой, а не зеркалом.
 * ПП попал в этот список после разведки 10.11.2026: его издатель публиковал строки
 * каждый тик (sync_status не снимался), а `last_server_seq` на них не ставился —
 * ровно тот шов, который этот сторож и ловит.
 */
const MIRROR_PUBLISHERS = [
  './ppeSyncPublisherService.ts',
  './productionProgramSyncPublisherService.ts',
  './signatureDefaultsSyncPublisherService.ts',
  './engineReclamationSyncPublisherService.ts',
] as const;

/** Имена таблиц из списка `SERVER_MIRROR_TABLES` в applyPushBatch.ts. */
function mirrorTableKeys(source: string): string[] {
  const start = source.indexOf('SERVER_MIRROR_TABLES');
  expect(start, 'объявление SERVER_MIRROR_TABLES не найдено').toBeGreaterThan(-1);
  const end = source.indexOf('] as const;', start);
  expect(end, 'хвост SERVER_MIRROR_TABLES не найден').toBeGreaterThan(start);
  const keys = Array.from(source.slice(start, end).matchAll(/SyncTableName\.(\w+)/g)).map((m) => String(m[1]));
  expect(keys.length, 'список зеркал пуст').toBeGreaterThan(0);
  return keys;
}

describe('таблицы-зеркала серверных дверей: транспортный шов', () => {
  const applySource = readSource('./applyPushBatch.ts');
  const mirrorTables = mirrorTableKeys(applySource);
  const snapshot = pgMapTables(readSource('./pgSyncTables.ts'));
  const incremental = pgMapTables(readSource('./pullChangesSince.ts'));

  it('каждая таблица зеркала — в ОБЕИХ картах pull', () => {
    // Без снапшот-карты холодный старт отдаёт пустоту (реплика свежей машины пуста),
    // без инкрементальной — строка не доедет живому клиенту. Ходить пары тоже
    // заставляет usersContractDrift.guard.test — здесь проверка с другой стороны:
    // что новую таблицу зеркала не забыли в картах вовсе.
    for (const key of mirrorTables) {
      expect(snapshot, `pgSyncTables.ts без ${key}`).toContain(key);
      expect(incremental, `pullChangesSince.ts без ${key}`).toContain(key);
    }
  });

  it('каждая таблица зеркала — server-managed', () => {
    // Зеркало с клиентским правом писать сломало бы саму идею: строку ведёт дверь,
    // а публикатор лишь доводит её до журнала.
    for (const key of mirrorTables) {
      const table = (SyncTableName as unknown as Record<string, string>)[key] ?? '';
      expect(table, `SyncTableName.${key} не существует`).toBeTruthy();
      expect(SERVER_MANAGED_SYNC_TABLES.has(table), `${table} не в server-managed`).toBe(true);
    }
  });

  it('обработчик снятия pending ходит по списку, а не по копии', () => {
    // Копия списка рядом разошлась бы с константой при первой же новой таблице —
    // и строка снова начала бы перепубликоваться каждый тик.
    expect(applySource).toContain('for (const tableName of SERVER_MIRROR_TABLES)');
  });

  it('каждая таблица издателя зеркала — зеркало', () => {
    // Обратная сторона того же шва. Проверка выше идёт от зеркала к картам pull и
    // потому молча пропускает обратный случай: таблицу внесли в карты pull, но
    // забыли в SERVER_MIRROR_TABLES — издатель шлёт её в журнал каждый тик
    // (sync_status не снимается), а клиент получает дубли. Ровно это случилось
    // с четырьмя таблицами приказа о СИЗ: PR #1554 внёс их в pgSyncTables и
    // pullChangesSince, а зеркалом они не стали — и PR был зелёным.
    // Повторилось с производственной программой (10.11.2026): её издатель был
    // вне списка, и строки ПП перепубликовывались каждый тик, а инкрементальный
    // pull их не отдавал.
    for (const file of MIRROR_PUBLISHERS) {
      const publisher = publisherTableKeys(readSource(file));
      expect(publisher.length, `издатель ${file} не найден — тест устарел вместе с файлом`).toBeGreaterThan(0);
      for (const key of publisher) {
        expect(mirrorTables, `SERVER_MIRROR_TABLES без ${key} (${file}) — издатель переотправляет её каждый тик`).toContain(key);
      }
    }
  });
});
