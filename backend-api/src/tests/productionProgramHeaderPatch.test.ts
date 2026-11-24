import { describe, expect, it } from 'vitest';

import { mergeProductionProgramHeader } from '../services/productionProgramService.js';

// Правка шапки ПП: «поле не прислано» и «поле очистить» — это разные вещи.
//
// Жалоба владельца 24.11.2026: «подписи то появляются, то исчезают». Причина
// была не в синхроне, а в правке: клиент слал в PATCH всю шапку из реплики, а
// реплика отстаёт на минуту — вместе с названием уезжал `signatureSlots: null`,
// и сервер честно стирал подписи, которые оператор сохранил.
const SLOTS = JSON.stringify([
  { caption: 'Коммерческий директор', employeeId: null, fullName: 'Беркута А.А.' },
  { caption: 'Главный инженер', employeeId: null, fullName: 'Сидоров С.С.' },
]);

const CURRENT = {
  periodStart: 1_762_000_000_000,
  periodEnd: 1_762_700_000_000,
  shop: 'Цех № 1',
  workshopId: null as string | null,
  title: 'ПП Цех 1 с 01.11 по 15.11.2026',
  status: 'draft',
  signatureSlots: SLOTS,
};

const RESOLVED = { shop: 'Цех № 1', workshopId: null as string | null };

describe('правка шапки ПП — «не прислано» и «очистить»', () => {
  it('подписи, которых нет в правке, остаются как есть', () => {
    const merged = mergeProductionProgramHeader(CURRENT, { title: 'ПП переименованная' }, RESOLVED);
    expect(merged.signatureSlots).toBe(SLOTS);
    expect(merged.title).toBe('ПП переименованная');
  });

  it('подписи с null очищаются осознанно', () => {
    const merged = mergeProductionProgramHeader(CURRENT, { signatureSlots: null }, RESOLVED);
    expect(merged.signatureSlots).toBeNull();
  });

  it('правка названия не стирает подписи (корень жалобы «подписи исчезают»)', () => {
    const merged = mergeProductionProgramHeader(CURRENT, { title: 'ПП Цех 1 (переименована)' }, RESOLVED);
    expect(merged.signatureSlots).toBe(SLOTS);
    expect(merged.status).toBe('draft');
    expect(merged.periodStart).toBe(CURRENT.periodStart);
    expect(merged.periodEnd).toBe(CURRENT.periodEnd);
  });

  it('состав подписей меняется только когда оператор правил именно его', () => {
    const next = JSON.stringify([{ caption: 'Начальник цеха', employeeId: null, fullName: 'И.К. Мухаммадиев' }]);
    const merged = mergeProductionProgramHeader(CURRENT, { signatureSlots: next }, RESOLVED);
    expect(merged.signatureSlots).toBe(next);
    expect(merged.title).toBe(CURRENT.title);
  });

  it('цех и имя цеха приходят разрешёнными (сервер берёт имя из справочника)', () => {
    const merged = mergeProductionProgramHeader(
      CURRENT,
      { workshopId: '22222222-2222-4222-8222-222222222222' },
      { shop: 'Цех № 2', workshopId: '22222222-2222-4222-8222-222222222222' },
    );
    expect(merged.workshopId).toBe('22222222-2222-4222-8222-222222222222');
    expect(merged.shop).toBe('Цех № 2');
  });
});
