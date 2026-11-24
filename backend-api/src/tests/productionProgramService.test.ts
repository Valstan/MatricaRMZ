import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  planProductionProgramRowWrite,
  resolveProductionProgramRowId,
  validateLine,
} from '../services/productionProgramService.js';

// Оператору — человеческие наименования. Технический идентификатор в шапке группы
// — это «номер вместо наименования»: в печатной форме плана он выглядит как
// служебная выгрузка, и дверь записи такое отвергает.
const UUID = '9e142af3-caf9-427f-9893-58961e48d4b1';

describe('строка плана: шапка группы — человеческое наименование', () => {
  const base = { orderNo: 1, groupLabel: 'ООО «Заказчик» · 125/2026' };

  it('обычная строка проходит', () => {
    const res = validateLine(base, 0);
    expect(res.ok).toBe(true);
  });

  it('идентификатор в шапке группы отвергается', () => {
    const res = validateLine({ ...base, groupLabel: UUID }, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('идентификатор');
  });

  it('пустая шапка группы отвергается с внятным объяснением', () => {
    const res = validateLine({ ...base, groupLabel: '   ' }, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('договор');
  });

  it('состояние строки остаётся из домена: мусорное значение не проходит', () => {
    const res = validateLine({ ...base, state: 'какая-то ерунда' }, 0);
    expect(res.ok).toBe(false);
  });
});

/**
 * Постоянный id строки плана — то, из-за чего двигатель пропадал из плана.
 *
 * Пока сервер на каждое сохранение заводил строке новый uuid (а старую снимал
 * мягко), журнал увозил пару «удалить + вставить», и клиент применял её по очереди:
 * между удалением и вставкой двигатель исчезал из плана и возвращался. Клиент шлёт
 * id сам — значит, сервер обязан его принять.
 */
describe('id строки плана: постоянный, а не новый на каждое сохранение', () => {
  const ROW_UUID = '11111111-2222-4333-8444-555555555555';
  const OTHER_UUID = '99999999-8888-4777-8666-555555555555';

  it('клиентский uuid принимается — строка не пересоздаётся', () => {
    const id = resolveProductionProgramRowId({
      requestedId: ROW_UUID,
      foreignIds: new Set<string>(),
      fallbackId: () => 'new-id',
    });
    expect(id).toBe(ROW_UUID);
  });

  it('чужой id (занятый другой программой) не берётся — строка не переезжает между планами', () => {
    const id = resolveProductionProgramRowId({
      requestedId: ROW_UUID,
      foreignIds: new Set([ROW_UUID]),
      fallbackId: () => 'new-id',
    });
    expect(id).toBe('new-id');
  });

  it('не-uuid отбрасывается: id строки — uuid, иначе сервер заведёт свой', () => {
    const id = resolveProductionProgramRowId({
      requestedId: 'draft-1712-0',
      foreignIds: new Set<string>(),
      fallbackId: () => 'new-id',
    });
    expect(id).toBe('new-id');
  });

  it('пустой id — сервер заводит свой', () => {
    const id = resolveProductionProgramRowId({
      requestedId: null,
      foreignIds: new Set<string>(),
      fallbackId: () => 'new-id',
    });
    expect(id).toBe('new-id');
  });

  it('id другой программы не влияет на id этой', () => {
    const id = resolveProductionProgramRowId({
      requestedId: ROW_UUID,
      foreignIds: new Set([OTHER_UUID]),
      fallbackId: () => 'new-id',
    });
    expect(id).toBe(ROW_UUID);
  });
});

/**
 * Строка плана, id которой уже занят: вставка или обновление.
 *
 * Инцидент 20.11.2026: строку сняли из плана (мягко удалили), клиентская реплика
 * отстала и прислала тот же id снова. Дверь делала слепой INSERT — PostgreSQL
 * отвечал 23505 (PK), запись падала целиком, у оператора план не сохранялся, а
 * очередь синка висела с тех пор («данные не уходят на сервер»).
 *
 * Данные при этом не терялись: строка на сервере была. Терялось сохранение.
 */
describe('id строки плана занят — это обновление, а не вставка', () => {
  it('свободный id — вставка', () => {
    expect(planProductionProgramRowWrite({ idTaken: false, softDeleted: false })).toEqual({ mode: 'insert' });
  });

  it('id занят живой строкой — обновление без восстановления', () => {
    expect(planProductionProgramRowWrite({ idTaken: true, softDeleted: false })).toEqual({
      mode: 'update',
      restore: false,
    });
  });

  it('id занят мягко удалённой строкой — обновление с восстановлением', () => {
    expect(planProductionProgramRowWrite({ idTaken: true, softDeleted: true })).toEqual({
      mode: 'update',
      restore: true,
    });
  });

  it('дверь берёт в расчёт ВСЕ строки программы, включая мягко удалённые', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../services/productionProgramService.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(src, 'мягко удалённые строки выпадают из выборки — и тот же id снова падает на PK').toContain(
      'const allRows = await tx',
    );
    expect(src, 'existingById должен знать и мягко удалённые строки').toContain(
      'new Map(allRows.map((r) => [String(r.id), r]))',
    );
    expect(src, 'слепой INSERT по занятому id — источник 23505').not.toContain(
      'if (existingById.has(item.id))',
    );
  });

  it('ошибка записи не уезжает необработанным отказом — клиент получает внятный ответ', () => {
    const route = readFileSync(
      fileURLToPath(new URL('../routes/productionProgram.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(route, 'роут не ловит ошибку базы — клиент видит зависшую ошибку').toContain(
      'не удалось сохранить строки плана',
    );
  });
});
