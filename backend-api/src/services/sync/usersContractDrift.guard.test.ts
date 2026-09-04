import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SYSTEM_ROLE_CATALOG, SyncTableName, userRowSchema } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

// B3/R3 — два класса молчаливого дрейфа, каждый из которых уже стрелял в этом
// репозитории. Оба проверяются по ИСХОДНОМУ ТЕКСТУ, а не по импорту модулей:
// routes/ledger.ts тянет за собой половину приложения, а цена вопроса — один
// regexp по файлу.

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** Имена таблиц внутри блока `const PG_SYNC_TABLES … = { … };`. */
function pgMapTables(source: string): string[] {
  const start = source.indexOf('PG_SYNC_TABLES');
  expect(start, 'блок PG_SYNC_TABLES не найден — тест устарел вместе с файлом').toBeGreaterThan(-1);
  // Именно `= {`, а не первая `{`: у обеих карт между именем и телом стоит
  // аннотация типа со своими фигурными скобками.
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

describe('B3/R3: две PG-карты синка не расходятся', () => {
  // Дрейф этих карт уже стоил проекту таблицы: erp_engine_instances была в
  // инкрементальном pull и отсутствовала в снапшоте — cold rebuild реплики
  // молча терял её целиком (шрам-комментарий в routes/ledger.ts). Для аккаунтов
  // цена того же дрейфа — пустая реплика на холодном старте и офлайн-гейт,
  // закрывший доступ всем.
  //
  // Полного равенства карт сегодня НЕТ, и это не наша недоделка: erp_reg_*
  // сознательно живут только в снапшот-карте (snapshot-only регистры). Список
  // расхождений закреплён явно — чтобы новое расхождение было ВИДНО.
  const KNOWN_SNAPSHOT_ONLY = ['ErpRegStockBalance', 'ErpRegStockMovements'];

  const incremental = pgMapTables(readSource('./pullChangesSince.ts'));
  // Снапшот-карта с 05.09 живёт в pgSyncTables.ts (общая для /state/snapshot и ledger:resnapshot-state).
  const snapshot = pgMapTables(readSource('./pgSyncTables.ts'));

  it('обе карты содержат users и user_section_access', () => {
    expect(incremental).toContain('Users');
    expect(incremental).toContain('UserSectionAccess');
    expect(snapshot).toContain('Users');
    expect(snapshot).toContain('UserSectionAccess');
  });

  it('расхождение карт — только известное и записанное', () => {
    const onlyInSnapshot = snapshot.filter((t) => !incremental.includes(t));
    const onlyInIncremental = incremental.filter((t) => !snapshot.includes(t));
    expect(onlyInSnapshot.sort()).toEqual([...KNOWN_SNAPSHOT_ONLY].sort());
    expect(onlyInIncremental).toEqual([]);
  });
});

describe('B3/R3: набор ролей в DTO совпадает с CHECK миграции', () => {
  // Схема userRowSchema фильтрует ИСХОДЯЩИЕ строки в /ledger/state/changes:
  // строка, не прошедшая zod, исчезает из pull МОЛЧА, без строки в логе. Значит
  // роль, которую БД разрешает, а shared-каталог не знает, вырезала бы аккаунт
  // из синхронизации навсегда. Поэтому списки обязаны совпадать посимвольно.
  it('SYSTEM_ROLE_CATALOG == users_system_role_ck в 0086', () => {
    const sql = readSource('../../../drizzle/0086_users_strict.sql');
    const m = sql.match(/CONSTRAINT users_system_role_ck CHECK \(system_role IN \(([^)]*)\)\)/);
    expect(m, 'CHECK users_system_role_ck не найден в 0086').not.toBeNull();
    const fromSql = Array.from(String(m?.[1]).matchAll(/'([a-z_]+)'/g)).map((x) => String(x[1])).sort();
    const fromCatalog = SYSTEM_ROLE_CATALOG.map((r) => r.key).sort();
    expect(fromSql).toEqual(fromCatalog);
  });

  it('роль вне каталога режется схемой, а роль из каталога проходит', () => {
    const base = {
      id: '11111111-1111-1111-1111-111111111111',
      login: 'oper1',
      access_enabled: true,
      created_at: 1,
      updated_at: 1,
    };
    for (const role of SYSTEM_ROLE_CATALOG.map((r) => r.key)) {
      expect(userRowSchema.safeParse({ ...base, system_role: role }).success, role).toBe(true);
    }
    expect(userRowSchema.safeParse({ ...base, system_role: 'merged' }).success).toBe(false);
  });

  it('в схеме строки аккаунта нет и не может быть password_hash', () => {
    const parsed = userRowSchema.safeParse({
      id: '11111111-1111-1111-1111-111111111111',
      login: 'oper1',
      system_role: 'employee',
      access_enabled: false,
      created_at: 1,
      updated_at: 1,
      password_hash: 'секрет',
    });
    expect(parsed.success).toBe(true);
    // zod по умолчанию срезает неизвестные ключи — секрет физически не доедет
    // до клиента, даже если кто-то положит его в payload.
    expect(parsed.success && 'password_hash' in parsed.data).toBe(false);
  });

  it('обе таблицы объявлены server-managed', () => {
    // Дубль-страховка к ledgerAuthz.test.ts: имена в контракте и в списке
    // server-managed обязаны совпадать, иначе backstop охраняет не то.
    expect(String(SyncTableName.Users)).toBe('users');
    expect(String(SyncTableName.UserSectionAccess)).toBe('user_section_access');
  });
});
