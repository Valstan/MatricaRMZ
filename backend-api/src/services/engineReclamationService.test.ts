import { describe, expect, it } from 'vitest';

import { mayDropReclamationRow, resolveReclamationRowId } from './engineReclamationService.js';

// Очередь рекламаций — заезды двигателя по рекламации. Ключевое правило записи:
// строка опознаётся по НОМЕРУ рекламации, а не только по id из запроса. Клиент знает
// id строки лишь тогда, когда реплика успела догнать сервер; пока она отстаёт, в
// запросе id нет, и без разбора каждое сохранение плодило новую строку вместо
// правки прежней (жалоба владельца 11.11.2026, двигатель Е02АТ5382).

const OWN_1 = '11111111-1111-4111-8111-111111111111';
const OWN_2 = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';

describe('resolveReclamationRowId — какую строку очереди править', () => {
  it('своя строка — правим её на месте', () => {
    expect(
      resolveReclamationRowId({
        requestedId: OWN_1,
        queueNo: 1,
        ownIds: new Set([OWN_1]),
        foreignIds: new Set(),
        liveIdByQueueNo: new Map([[1, OWN_1]]),
        newId: 'new',
      }),
    ).toBe(OWN_1);
  });

  it('id неизвестен — берём ту же рекламацию по номеру, а не плодим строку', () => {
    expect(
      resolveReclamationRowId({
        requestedId: null,
        queueNo: 1,
        ownIds: new Set([OWN_1]),
        foreignIds: new Set(),
        liveIdByQueueNo: new Map([[1, OWN_1]]),
        newId: 'new',
      }),
    ).toBe(OWN_1);
  });

  it('id чужой (занят другим двигателем) — не берём, ищем по номеру', () => {
    expect(
      resolveReclamationRowId({
        requestedId: FOREIGN,
        queueNo: 2,
        ownIds: new Set([OWN_1]),
        foreignIds: new Set([FOREIGN]),
        liveIdByQueueNo: new Map([[2, OWN_2]]),
        newId: 'new',
      }),
    ).toBe(OWN_2);
  });

  it('такой рекламации ещё нет — заводим новую строку', () => {
    expect(
      resolveReclamationRowId({
        requestedId: null,
        queueNo: 3,
        ownIds: new Set([OWN_1]),
        foreignIds: new Set(),
        liveIdByQueueNo: new Map([[1, OWN_1]]),
        newId: 'new',
      }),
    ).toBe('new');
  });

  it('номер другой, а строка с тем же id есть — правим свою строку', () => {
    // Клиент прислал id своей строки с другим номером (номер переехал) — правим её,
    // а не заводим третью строку в очередь.
    expect(
      resolveReclamationRowId({
        requestedId: OWN_2,
        queueNo: 2,
        ownIds: new Set([OWN_1, OWN_2]),
        foreignIds: new Set(),
        liveIdByQueueNo: new Map([[1, OWN_1]]),
        newId: 'new',
      }),
    ).toBe(OWN_2);
  });
});

/**
 * Потеря рекламации (жалоба владельца 11.11.2026, Е02АТ5382): пустой запрос от клиента
 * с отставшей репликой означал «рекламаций нет», и сервер смягко удалял то, что оператор
 * только что записал. Пустая очередь чистится только по явному подтверждению.
 */
describe('mayDropReclamationRow — когда очередь можно очистить', () => {
  it('непустой запрос — строки сняты осознанно, чистим те, что клиент видел', () => {
    expect(
      mayDropReclamationRow({ preparedCount: 2, clear: false, knownIds: new Set([OWN_1]), rowId: OWN_1 }),
    ).toBe(true);
    // Строку, которой клиент НЕ видел, сносить нельзя: её мог добавить другой оператор.
    expect(
      mayDropReclamationRow({ preparedCount: 2, clear: false, knownIds: new Set([OWN_1]), rowId: OWN_2 }),
    ).toBe(false);
  });

  it('пустой запрос без подтверждения — НЕ сносим рекламацию', () => {
    expect(mayDropReclamationRow({ preparedCount: 0, clear: false, knownIds: new Set([OWN_1]), rowId: OWN_1 })).toBe(
      false,
    );
  });

  it('пустой запрос с подтверждением очистки — сносим то, что клиент видел', () => {
    expect(mayDropReclamationRow({ preparedCount: 0, clear: true, knownIds: new Set([OWN_1]), rowId: OWN_1 })).toBe(
      true,
    );
  });

  it('клиент без известных строк (старая версия) не сносит ничего', () => {
    expect(mayDropReclamationRow({ preparedCount: 0, clear: false, knownIds: new Set(), rowId: OWN_1 })).toBe(false);
    expect(mayDropReclamationRow({ preparedCount: 1, clear: false, knownIds: new Set(), rowId: OWN_1 })).toBe(false);
  });
});
