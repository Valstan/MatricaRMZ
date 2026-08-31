import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

import { listEmployeesAuth } from './employeeAuthService.js';
import { SYNC_COLUMNS_PENDING_CONTRACT } from './sync/syncSchemaGuard.js';

// B3 (план matrica-v4-kickoff, трек B этап 3) — сторож инвариантов, на которых
// стоит вся конструкция. Каждый из них сегодня выполняется «сам собой», и
// сломать его можно одной строкой, ничего не заметив: тесты выше по стеку
// продолжат проходить, а свойство исчезнет.
//
// Почему сторож нужен именно здесь. Обещание «password_hash не синкается»
// заявлено как СВОЙСТВО КОНСТРУКЦИИ, а не как фильтр в коде: таблицы
// user_credentials просто нет в sync-контракте. Ровно поэтому оно и держится —
// и ровно поэтому исчезнет молча, если кто-то в R3 добавит в контракт не ту
// таблицу. Прецедент в проекте уже был: guard-тест, годами закреплявший дыру
// вместо инварианта (см. shared/src/domain/ledgerAuthz.test.ts, аудит
// 2026-08-29).

const SYNC_TABLES: string[] = Object.values(SyncTableName);

describe('B3: серверные таблицы не входят в sync-контракт', () => {
  // Секрет и настройки не синкаются ПО КОНСТРУКЦИИ. Если эта строка когда-нибудь
  // покраснеет — значит хэши паролей поехали на все машины парка.
  it('user_credentials отсутствует в SyncTableName', () => {
    expect(SYNC_TABLES).not.toContain('user_credentials');
  });

  it('user_settings отсутствует в SyncTableName', () => {
    expect(SYNC_TABLES).not.toContain('user_settings');
  });

  // R3 состоялся: обе таблицы В контракте. Барьер снят осознанно — вместе с
  // реестром, DTO, ledger-enum, обеими PG-картами и путём выдачи seq. Проверка
  // осталась, но перевёрнута: она стережёт, чтобы контракт не потерял их назад
  // (без users реплика пуста, и офлайн-гейт разделов схлопывается в fail-open).
  it('users и user_section_access входят в контракт (B3/R3)', () => {
    expect(SYNC_TABLES).toContain('users');
    expect(SYNC_TABLES).toContain('user_section_access');
  });

  // Ровно то, ради чего барьер и стоял: соседняя строка в контракте — не та.
  it('в контракт вошли ИМЕННО две таблицы, а не соседние по смыслу', () => {
    const usersFamily = SYNC_TABLES.filter((t) => t.startsWith('user'));
    expect(usersFamily.sort()).toEqual(['user_presence', 'user_section_access', 'users']);
  });

  it('access_sections — серверный каталог-якорь, в контракте ему делать нечего', () => {
    expect(SYNC_TABLES).not.toContain('access_sections');
  });
});

type ListOk = Extract<Awaited<ReturnType<typeof listEmployeesAuth>>, { ok: true }>;
type ListRow = ListOk['rows'][number];

describe('B3/R2: listEmployeesAuth не отдаёт секрет', () => {
  // Проверка компилятором, а не рантаймом: если поле вернут — этот файл
  // перестанет собираться на `typecheck:test`, и ошибка вылезет раньше теста.
  it('в типе строки нет passwordHash', () => {
    // @ts-expect-error — passwordHash намеренно убран из наружного типа (B3/R2)
    type _Removed = ListRow['passwordHash'];
    // Признак наличия пароля остаётся — именно его спрашивали все потребители.
    // Строка ниже компилируется, только пока поле есть и оно булево.
    const probe: ListRow = {} as ListRow;
    const _hasPassword: boolean = probe.hasPassword;
    expect(typeof probe).toBe('object');
  });
});

describe('B3: список ожидания sync-контракта не подменяет собой контракт', () => {
  // Список в syncSchemaGuard гасит ERROR для таблиц, которые несут sync-колонки
  // заранее. Опасность очевидна: он же может тихо гасить настоящую ошибку, если
  // таблицу туда впишут и забудут. Поэтому два инварианта.

  it('пуст: с B3/R3 ожидающих таблиц не осталось', () => {
    expect(Object.keys(SYNC_COLUMNS_PENDING_CONTRACT).sort()).toEqual([]);
  });

  it('ни одна запись списка не пересекается с самим контрактом', () => {
    for (const table of Object.keys(SYNC_COLUMNS_PENDING_CONTRACT)) {
      expect(SYNC_TABLES, `${table} уже в контракте — убрать из списка ожидания`).not.toContain(table);
    }
  });

  it('у каждой записи есть причина, а не пустая строка', () => {
    for (const [table, reason] of Object.entries(SYNC_COLUMNS_PENDING_CONTRACT)) {
      expect(String(reason).trim().length, table).toBeGreaterThan(10);
    }
  });
});

describe('B3/R4a: listEmployeesAuth читает auth-поля из строгих таблиц', () => {
  // Сторож исходника, а не поведения: разница видна только на замороженном EAV,
  // то есть ПОСЛЕ cutover'а — когда чинить уже поздно. Сегодня оба источника
  // совпадают (зеркало держат триггеры 0086), поэтому обычный тест на данных
  // остался бы зелёным при любом из двух вариантов кода и ничего не стерёг бы.
  //
  // Цена регресса: от этого списка кормятся ростер чата и заметок, подсказка
  // логинов, админский список, отчёт о доступах и ВЫБОР ПОЛУЧАТЕЛЕЙ
  // telegram-уведомлений. Возврат к EAV означает, что отозванный сотрудник
  // продолжит получать тела чужих сообщений во внешний канал (класс инцидента
  // 3.18.0), а заведённый после cutover — не появится в ростере никогда.
  const source = readFileSync(new URL('./employeeAuthService.ts', import.meta.url), 'utf8');
  const body = (() => {
    const start = source.indexOf('export async function listEmployeesAuth()');
    expect(start, 'listEmployeesAuth не найдена — сторож потерял предмет').toBeGreaterThan(0);
    const end = source.indexOf('\nexport ', start + 1);
    return source.slice(start, end === -1 ? source.length : end);
  })();

  it.each([
    ['loginDefId', 'логин'],
    ['passwordDefId', 'признак наличия пароля'],
    ['accessDefId', 'признак доступа'],
    ['deleteRequestedAtDefId', 'дата заявки на удаление'],
    ['deleteRequestedByIdDefId', 'инициатор заявки'],
    ['deleteRequestedByUsernameDefId', 'денормализованная копия логина инициатора'],
  ])('не берёт %s из EAV (%s)', (defId) => {
    expect(body).not.toContain(defId);
  });

  it('сырая роль ИЗ EAV остаётся — на ней стоит ведро аномалий roleReport', () => {
    // Обратный инвариант: это исключение осознанное, и вычистить его «заодно»
    // с остальными EAV-чтениями нельзя — `users.system_role` NOT NULL и с CHECK
    // по каталогу, он не отличает «атрибута нет» от «сознательно employee».
    expect(body).toContain('defs.roleDefId');
    expect(body).toContain('systemRoleRaw');
  });

  it('строка списка несёт и канон, и сырое значение', () => {
    const probe: ListRow = {} as ListRow;
    const _canon: string = probe.systemRole;
    const _raw: string = probe.systemRoleRaw;
    expect(typeof probe).toBe('object');
  });
});

describe('B3/R4a: настройки пользователя читаются из user_settings', () => {
  // Тот же класс, что и у списка аккаунтов, но цена другая: здесь протухшее
  // чтение не только показывает старое, но и ПИШЕТ. `setEmployeeUiProfile`
  // берёт из `getEmployeeUiProfile` базу per-key LWW-мерджа — после cutover
  // база из замороженного EAV начала бы затирать свежие секции рабочего стола.
  const source = readFileSync(new URL('./employeeAuthService.ts', import.meta.url), 'utf8');
  const bodyOf = (name: string) => {
    const start = source.indexOf(`export async function ${name}(`);
    expect(start, `${name} не найдена — сторож потерял предмет`).toBeGreaterThan(0);
    const end = source.indexOf('\nexport ', start + 1);
    return source.slice(start, end === -1 ? source.length : end);
  };

  it.each(['getEmployeeLoggingSettings', 'getEmployeeUiSettings', 'getEmployeeUiProfile'])(
    '%s не читает attribute_values',
    (name) => {
      expect(bodyOf(name)).not.toContain('attributeValues');
    },
  );

  it.each(['getEmployeeLoggingSettings', 'getEmployeeUiSettings', 'getEmployeeUiProfile'])(
    '%s идёт через readUserSettings',
    (name) => {
      expect(bodyOf(name)).toContain('readUserSettings');
    },
  );

  // Писатели остаются на EAV до R4b — и это НЕ недоделка, а условие
  // безопасности: пока триггеры вооружены, `rebuild_user` перезаписывает
  // user_settings из EAV, и прямая запись была бы затёрта следующей же правкой
  // любого атрибута сотрудника.
  it.each(['setEmployeeLoggingSettings', 'setEmployeeUiSettings', 'setEmployeeUiProfile'])(
    '%s пока пишет в EAV (переезд писателей — R4b, вместе со сносом триггеров)',
    (name) => {
      expect(bodyOf(name)).toContain('upsertAttrValue');
    },
  );
});
