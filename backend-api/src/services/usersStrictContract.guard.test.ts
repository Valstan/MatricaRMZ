import { describe, expect, it } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

import { listEmployeesAuth } from './employeeAuthService.js';

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

  // users и user_section_access входят в контракт на R3 — осознанным шагом, с
  // правкой реестра, DTO, ledger-enum и ОБЕИХ клиентских цепочек миграций.
  // Пока их там нет, и случайное добавление должно упереться в этот тест: он
  // заставит автора прочитать список требований R3, а не просто дописать строку.
  it('users и user_section_access ещё не в контракте (входят на R3)', () => {
    expect(SYNC_TABLES).not.toContain('users');
    expect(SYNC_TABLES).not.toContain('user_section_access');
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
