import { describe, expect, it } from 'vitest';

import { resolveHeaderAutofill } from './repairChecklist.js';

describe('resolveHeaderAutofill', () => {
  it('заполняет пустое поле, к которому никто не прикасался', () => {
    expect(resolveHeaderAutofill({ current: '', incoming: '2Ж03АТ', owned: undefined })).toBe('2Ж03АТ');
  });

  it('догоняет карточку, пока в поле лежит ровно наша прежняя подстановка', () => {
    // Карточка двигателя шлёт состояние на каждое нажатие: 2 → 2Ж → 2Ж0.
    let owned: string | undefined;
    let current = '';
    for (const incoming of ['2', '2Ж', '2Ж0']) {
      const next = resolveHeaderAutofill({ current, incoming, owned });
      expect(next).toBe(incoming);
      current = next!;
      owned = next!;
    }
    expect(current).toBe('2Ж0');
  });

  it('не трогает поле, которое оператор правил руками', () => {
    expect(resolveHeaderAutofill({ current: 'свой номер', incoming: '2Ж03', owned: '2Ж' })).toBeNull();
  });

  it('не трогает чужое непустое поле после перезагрузки листа (владения не помним)', () => {
    expect(resolveHeaderAutofill({ current: '2Ж03', incoming: 'другой', owned: undefined })).toBeNull();
  });

  it('не возвращает значение в поле, очищенное оператором', () => {
    expect(resolveHeaderAutofill({ current: '', incoming: '2Ж03', owned: '2Ж03' })).toBeNull();
  });

  it('молчит, когда карточка пуста или значение уже совпадает', () => {
    expect(resolveHeaderAutofill({ current: '', incoming: '', owned: undefined })).toBeNull();
    expect(resolveHeaderAutofill({ current: '2Ж03', incoming: '2Ж03', owned: '2Ж03' })).toBeNull();
  });
});
