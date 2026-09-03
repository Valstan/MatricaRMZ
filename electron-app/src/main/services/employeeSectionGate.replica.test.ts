import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { getRestrictedWorkOrderPolicyLocal, getSectionMembershipByLogin } from './employeeService.js';

// B3/R3 — офлайн-гейт разделов читает реплику строгих таблиц, а пока её нет —
// по-прежнему EAV. Проверяется и то и другое, потому что ошибка в любую сторону
// стоит доступа живых людей:
//   • ушли в реплику раньше, чем она налилась → membership null → гейт вернёт
//     true на КАЖДЫЙ канал и молча станет декорацией;
//   • остались на EAV после переезда → снятие доступа не доедет.
//
// Отдельно закреплены два решения R2, перенесённые с сервера дословно: отозванные
// аккаунты из политики НЕ выпадают (иначе раскроются закрытые наряды уволенного
// владельца) и строка считается на АККАУНТ, а не на логин (слияние по логину дало
// бы объединение доступов — больше прав, чем есть).

const DDL = `
  CREATE TABLE entity_types (id text PRIMARY KEY, code text NOT NULL, name text NOT NULL,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_defs (id text PRIMARY KEY, entity_type_id text NOT NULL, code text NOT NULL,
    name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0,
    sort_order integer NOT NULL DEFAULT 0, meta_json text, created_at integer NOT NULL,
    updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
    sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE attribute_values (id text PRIMARY KEY, entity_id text NOT NULL, attribute_def_id text NOT NULL,
    value_json text, created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE users (id text PRIMARY KEY, login text NOT NULL, system_role text NOT NULL,
    access_enabled integer NOT NULL DEFAULT 0, delete_requested_at integer, delete_requested_by text,
    created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  CREATE TABLE user_section_access (id text PRIMARY KEY, user_id text NOT NULL, section_id text NOT NULL,
    level text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
    deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
`;

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  return { sqlite, db: drizzle(sqlite) as never };
}

/** EAV-раскладка «как раньше»: тип employee + атрибуты login / section_access / system_role. */
function seedEav(
  sqlite: Database.Database,
  people: Array<{ id: string; login: string; sections: Record<string, string>; role?: string }>,
) {
  const t = 1;
  sqlite.prepare(`INSERT INTO entity_types (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)`).run('et-emp', 'employee', 'Сотрудник', t, t);
  for (const [i, code] of ['login', 'section_access', 'system_role'].entries()) {
    sqlite
      .prepare(`INSERT INTO attribute_defs (id,entity_type_id,code,name,data_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(`def-${code}`, 'et-emp', code, code, 'text', t + i, t + i);
  }
  let n = 0;
  for (const p of people) {
    const put = (def: string, value: unknown) => {
      n += 1;
      sqlite
        .prepare(`INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
        .run(`av-${n}`, p.id, def, JSON.stringify(value), t, t);
    };
    put('def-login', p.login);
    put('def-section_access', p.sections);
    if (p.role) put('def-system_role', p.role);
  }
}

function seedReplica(
  sqlite: Database.Database,
  accounts: Array<{ id: string; login: string; role: string; deletedAt?: number | null; sections?: Array<{ id: string; section: string; level: string; deletedAt?: number | null }> }>,
) {
  const t = 1;
  for (const a of accounts) {
    sqlite
      .prepare(`INSERT INTO users (id,login,system_role,access_enabled,created_at,updated_at,deleted_at) VALUES (?,?,?,1,?,?,?)`)
      .run(a.id, a.login, a.role, t, t, a.deletedAt ?? null);
    for (const s of a.sections ?? []) {
      sqlite
        .prepare(`INSERT INTO user_section_access (id,user_id,section_id,level,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?)`)
        .run(s.id, a.id, s.section, s.level, t, t, s.deletedAt ?? null);
    }
  }
}

describe('офлайн-гейт разделов: источник membership', () => {
  it('реплика пуста → читаем EAV (переходная ветка)', async () => {
    const { sqlite, db } = makeDb();
    seedEav(sqlite, [{ id: 'e1', login: 'oper1', sections: { work_orders: 'editor' } }]);
    expect(await getSectionMembershipByLogin(db, 'oper1')).toEqual({ work_orders: 'editor' });
  });

  it('реплика налита → читаем ЕЁ, а не EAV', async () => {
    const { sqlite, db } = makeDb();
    // EAV говорит одно, реплика — другое. Верить надо реплике: именно она едет
    // с сервера и именно в ней отражается снятие доступа.
    seedEav(sqlite, [{ id: 'e1', login: 'oper1', sections: { work_orders: 'editor' } }]);
    seedReplica(sqlite, [
      { id: 'e1', login: 'oper1', role: 'master', sections: [{ id: 's1', section: 'production', level: 'viewer' }] },
    ]);
    expect(await getSectionMembershipByLogin(db, 'oper1')).toEqual({ production: 'viewer' });
  });

  it('снятый раздел приезжает тумбстоуном и в membership не попадает', async () => {
    const { sqlite, db } = makeDb();
    seedReplica(sqlite, [
      {
        id: 'e1',
        login: 'oper1',
        role: 'master',
        sections: [
          { id: 's1', section: 'production', level: 'viewer' },
          { id: 's2', section: 'work_orders', level: 'editor', deletedAt: 100 },
        ],
      },
    ]);
    expect(await getSectionMembershipByLogin(db, 'oper1')).toEqual({ production: 'viewer' });
  });

  it('нет живых разделов → null (fail-open), а не пустой membership', async () => {
    // Инцидент 2026-07-10: клиент считал {} «засеянным пустым» и отказывал во
    // ВСЕХ разделах, тогда как серверный гейт для того же человека был fail-open.
    const { sqlite, db } = makeDb();
    seedReplica(sqlite, [
      { id: 'e1', login: 'oper1', role: 'master', sections: [{ id: 's1', section: 'production', level: 'viewer', deletedAt: 100 }] },
    ]);
    expect(await getSectionMembershipByLogin(db, 'oper1')).toBeNull();
  });

  it('логин переиспользован: отвечает ЖИВОЙ аккаунт, а не тумбстоун', async () => {
    // Логин отозванного освобождается, и его может получить другой человек.
    // Порядок повторяет серверный (живой вперёд), иначе ответ зависел бы от
    // плана запроса — сегодня один, завтра другой, у одного и того же человека.
    const { sqlite, db } = makeDb();
    seedReplica(sqlite, [
      { id: 'dead', login: 'oper1', role: 'master', deletedAt: 50, sections: [{ id: 's1', section: 'warehouse', level: 'editor' }] },
      { id: 'live', login: 'oper1', role: 'viewer', sections: [{ id: 's2', section: 'production', level: 'viewer' }] },
    ]);
    expect(await getSectionMembershipByLogin(db, 'oper1')).toEqual({ production: 'viewer' });
  });
});

describe('офлайн-гейт: политика закрытых нарядов', () => {
  it('строит политику из реплики', async () => {
    const { sqlite, db } = makeDb();
    seedReplica(sqlite, [
      { id: 'owner', login: 'owner1', role: 'master', sections: [{ id: 's1', section: 'restricted_work_orders', level: 'editor' }] },
      { id: 'reader', login: 'reader1', role: 'viewer', sections: [{ id: 's2', section: 'restricted_work_orders', level: 'viewer' }] },
    ]);
    const policy = await getRestrictedWorkOrderPolicyLocal(db);
    expect(policy).not.toBeNull();
    // owners/readers — Set, JSON.stringify их не сериализует.
    expect([...(policy!.owners)]).toEqual(['owner1']);
    expect([...(policy!.readers)].sort()).toEqual(['owner1', 'reader1']);
  });

  it('ОТОЗВАННЫЙ ограниченный владелец из политики НЕ выпадает', async () => {
    // Иначе его закрытые наряды раскрылись бы всем — это выглядело бы как
    // уборка, а было бы утечкой (решение R2, перенесено с сервера дословно).
    const { sqlite, db } = makeDb();
    seedReplica(sqlite, [
      { id: 'gone', login: 'gone1', role: 'master', deletedAt: 50, sections: [{ id: 's1', section: 'restricted_work_orders', level: 'editor' }] },
    ]);
    const policy = await getRestrictedWorkOrderPolicyLocal(db);
    expect([...(policy!.owners)]).toEqual(['gone1']);
  });

  it('реплика пуста → политика по-прежнему считается из EAV', async () => {
    const { sqlite, db } = makeDb();
    seedEav(sqlite, [
      { id: 'e1', login: 'owner1', role: 'master', sections: { restricted_work_orders: 'editor' } },
    ]);
    const policy = await getRestrictedWorkOrderPolicyLocal(db);
    expect([...(policy!.owners)]).toEqual(['owner1']);
  });

  it('аккаунты доехали, а доступы ещё нет → это НЕ «никто не ограничен», а падение в EAV', async () => {
    // Холодный полный прогон идёт таблица за таблицей: между `users` и
    // `user_section_access` машина живёт в состоянии «аккаунты есть, доступов нет».
    // Проба по одним лишь `users` прочитала бы это как пустую политику — и закрытые
    // наряды показались бы всем, кто в этот момент открыл список или отчёт.
    const { sqlite, db } = makeDb();
    seedReplica(sqlite, [{ id: 'half', login: 'somebody', role: 'master' }]); // без sections
    seedEav(sqlite, [
      { id: 'e1', login: 'owner1', role: 'master', sections: { restricted_work_orders: 'editor' } },
    ]);
    const policy = await getRestrictedWorkOrderPolicyLocal(db);
    expect(policy).not.toBeNull();
    expect([...(policy!.owners)]).toEqual(['owner1']);
  });
});
