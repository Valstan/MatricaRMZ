import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

/**
 * Регрессия инцидента 20.11.2026: карточка по мылу роняла pull у всего парка.
 *
 * Что было: в `ppe_issue_cards` вошёл вид СИЗ (`kind`, миграция 0131). Клиент не
 * вез это поле в реплику — insert брал дефолт колонки ('workwear'). У сотрудника
 * открыта карточка по спецодежде, и карточка по мылу вставала в реплику как ещё
 * одна карточка по спецодежде: била частичный уникальный индекс открытой карточки
 * (`UNIQUE constraint failed: ppe_issue_cards.employee_id, ppe_issue_cards.kind`)
 * и роняла ВЕСЬ батч pull — синхронизация вставала у каждого клиента.
 *
 * Тест строит реплику ровно такой, какая живёт у клиента (миграция 0033 + доводка
 * долгоживущих БД из `migrate.ts`), кладёт в неё открытую карточку по спецодежде
 * и приезжающую карточку по мылу.
 *
 * Сторож `pullColumnCoverage.guard.test.ts` следит за тем, чтобы клиент вообще
 * брал `kind` из payload (дефолт или литерал он бы не пропустил); этот тест —
 * про саму реплику: законная серверная строка обязана в неё встать.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** Реплика клиента: таблица из миграции 0033 + доводка вида карточки (0131). */
function makeReplica() {
  const sqlite = new Database(':memory:');
  const sql = readFileSync(join(here, '../../../../drizzle/0033_ppe_replica.sql'), 'utf8');
  sqlite.exec(sql);
  // Вид карточки (миграция 0131): колонка, снос прежнего индекса и новый
  // частичный уникальный индекс — те же шаги, что в `database/migrate.ts`.
  sqlite.exec(`ALTER TABLE ppe_issue_cards ADD COLUMN kind text NOT NULL DEFAULT 'workwear';`);
  sqlite.exec(`DROP INDEX IF EXISTS ppe_issue_cards_employee_open_uq;`);
  sqlite.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ppe_issue_cards_employee_kind_open_uq
       ON ppe_issue_cards (employee_id, kind) WHERE closed_at IS NULL AND deleted_at IS NULL;`,
  );
  return sqlite;
}

const insertCard = (sqlite: Database.Database) =>
  sqlite.prepare(
    `INSERT INTO ppe_issue_cards (id, employee_id, kind, opened_at, closed_at, created_at, updated_at)
     VALUES (?, 'emp-1', ?, 1000, NULL, 1000, 1000)`,
  );

describe('реплика карточек СИЗ принимает карточку по мылу', () => {
  it('карточка по мылу встаёт рядом с открытой карточкой по спецодежде', () => {
    const sqlite = makeReplica();
    // У сотрудника открыта карточка по спецодежде (она в реплике с прошлого pull).
    insertCard(sqlite).run('card-workwear', 'workwear');

    // Приезжает карточка по мылу — сервер шлёт вид, клиент обязан его взять.
    expect(() => insertCard(sqlite).run('card-soap', 'soap')).not.toThrow();

    const rows = sqlite.prepare(`SELECT id, kind FROM ppe_issue_cards ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 'card-soap', kind: 'soap' },
      { id: 'card-workwear', kind: 'workwear' },
    ]);
    sqlite.close();
  });

  it('без вида карточка по мылу бьёт индекс открытой карточки — как было 20.11', () => {
    const sqlite = makeReplica();
    insertCard(sqlite).run('card-workwear', 'workwear');
    // Ровно то, что делал клиент без `kind`: вид молча становился 'workwear'.
    expect(() => insertCard(sqlite).run('card-soap', 'workwear')).toThrow(/UNIQUE/);
    sqlite.close();
  });

  it('закрытая карточка вида не занимает место открытой', () => {
    const sqlite = makeReplica();
    insertCard(sqlite).run('card-workwear', 'workwear');
    // Спецодежда закрыта, а вид остаётся прежним — вторая открытая карточка
    // того же вида законна (у сотрудника одна открытая карточка НА ВИД).
    sqlite.prepare(`UPDATE ppe_issue_cards SET closed_at = 1500 WHERE id = 'card-workwear'`).run();
    expect(() => insertCard(sqlite).run('card-workwear-2', 'workwear')).not.toThrow();
    sqlite.close();
  });
});
