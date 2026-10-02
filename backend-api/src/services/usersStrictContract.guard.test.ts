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
  // база из замороженного EAV начала бы затирать свежие секции Верстака.
  const source = readFileSync(new URL('./employeeAuthService.ts', import.meta.url), 'utf8');
  // Ищем БЕЗ префикса `export`: терминал маршрута (readUserSettings) не
  // экспортируется, а без него сторож проверял бы только вызывающих — EAV-фолбэк
  // внутри самой readUserSettings оставил бы все утверждения зелёными.
  // Замыкающая `(` не даёт `getEmployeeUiSettings` совпасть с
  // `getEmployeeUiSettingsDefId`.
  const bodyOf = (name: string) => {
    const start = source.indexOf(`async function ${name}(`);
    expect(start, `${name} не найдена — сторож потерял предмет`).toBeGreaterThan(0);
    const end = source.indexOf('\nasync function ', start + 1);
    const endExported = source.indexOf('\nexport ', start + 1);
    const stop = [end, endExported].filter((n) => n > 0).sort((a, b) => a - b)[0];
    return source.slice(start, stop ?? source.length);
  };

  it.each(['getEmployeeLoggingSettings', 'getEmployeeUiSettings', 'getEmployeeUiProfile', 'readUserSettings'])(
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

  // B3/R4b СОСТОЯЛСЯ: писатели пишут в strict (триггеры EAV снесены миграцией
  // 0103 — вооружённого перезаписывателя больше нет). Возврат к upsertAttrValue
  // здесь означал бы правку, которую никто не читает: читатели строгие.
  it.each(['setEmployeeLoggingSettings', 'setEmployeeUiSettings', 'setEmployeeUiProfile'])(
    '%s пишет в strict, а не в EAV (R4b состоялся)',
    (name) => {
      expect(bodyOf(name)).not.toContain('upsertAttrValue');
    },
  );
});

describe('B3/R4b: база записи читается из того же хранилища, куда идёт запись', () => {
  // R4b СОСТОЯЛСЯ: писатели и обе базы — в strict. Инвариант прежний, полюса
  // сменились: показываешь — можно откуда угодно; пишешь — база строго оттуда же,
  // куда пишешь. Возврат любой из баз в EAV после сноса триггеров означал бы базу
  // из заморозки: дельта на ней soft-delete'ит все реальные доступы человека, а
  // LWW-мердж стирает вкладки, пины и раскладки. Необратимо и молча.
  const source = readFileSync(new URL('./employeeAuthService.ts', import.meta.url), 'utf8');
  const bodyOf = (name: string) => {
    const start = source.indexOf(`async function ${name}(`);
    expect(start, `${name} не найдена — сторож потерял предмет`).toBeGreaterThan(0);
    const stop = [source.indexOf('\nasync function ', start + 1), source.indexOf('\nexport ', start + 1)]
      .filter((n) => n > 0)
      .sort((a, b) => a - b)[0];
    return source.slice(start, stop ?? source.length);
  };

  it('дельта-дверь берёт базу из канона, а не из строгой таблицы', () => {
    expect(bodyOf('setEmployeeSectionAccessOne')).toContain('readCanonSectionMembership');
  });

  it('решение о засеве разделов — тоже по канону', () => {
    expect(bodyOf('seedSectionAccessIfMissing')).toContain('readCanonSectionMembership');
  });

  it('канон разделов — строгая таблица (писатель пишет туда же)', () => {
    expect(bodyOf('readCanonSectionMembership')).toContain('userSectionAccess');
    expect(bodyOf('readCanonSectionMembership')).not.toContain('attributeValues');
  });

  it('база LWW-мерджа профиля читается из user_settings, а не из EAV', () => {
    const body = bodyOf('setEmployeeUiProfile');
    expect(body).toContain('readCanonUiProfile');
    expect(body).not.toContain('readEavUiProfile');
  });

  it('readCanonUiProfile идёт через readUserSettings (а та — из user_settings)', () => {
    expect(bodyOf('readCanonUiProfile')).toContain('readUserSettings');
    expect(bodyOf('readCanonUiProfile')).not.toContain('attributeValues');
    expect(bodyOf('readUserSettings')).toContain('userSettings');
  });
});
