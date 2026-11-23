import { describe, expect, it } from 'vitest';

import { buildSignatureEmployeeOptions, signatureSlotRowHint } from './SignatureSlotsEditor.js';

// Подсказка под строкой блока подписей — это ровно то, что уйдёт на бумагу (ФИО и
// должность подписанта). Если редактор показывает одно, а печать печатает другое,
// оператор подписывает не тот лист.
describe('редактор блока подписей', () => {
  it('привязанный сотрудник: ФИО из карточки и его должность (профессия)', () => {
    const employees = [
      {
        id: 'emp-1',
        lastName: 'Иванов',
        firstName: 'Иван',
        middleName: 'Иванович',
        position: 'Начальник цеха № 4',
        employmentStatus: 'working',
      },
    ];
    const hint = signatureSlotRowHint({ id: 'r1', caption: 'Начальник цеха № 4', employeeId: 'emp-1', fullName: '' }, employees);
    // ФИО печатается по ГОСТ Р 7.0.97-2016: «Иванов И.И.» (фамилия, потом инициалы).
    expect(hint.text).toBe('Иванов И.И. · Начальник цеха № 4');
    expect(hint.source).toBe('из карточки сотрудника');
  });

  it('без сотрудника печатается вписанное ФИО — подпись от руки', () => {
    const hint = signatureSlotRowHint(
      { id: 'r1', caption: 'Мастер цеха', employeeId: null, fullName: 'Петров П.П.' },
      [],
    );
    expect(hint.text).toBe('Петров П.П.');
    expect(hint.source).toBe('от руки');
  });

  it('подпись без ФИО и без сотрудника — пусто, а не мусор', () => {
    const hint = signatureSlotRowHint({ id: 'r1', caption: 'Мастер цеха', employeeId: null, fullName: '' }, []);
    expect(hint.text).toBe('');
    expect(hint.source).toBe('от руки');
  });

  it('опции выбора сотрудника: ФИО в подписи, должность — в подсказке', () => {
    const options = buildSignatureEmployeeOptions([
      { id: 'emp-1', displayName: 'Иванов И.И.', position: 'Начальник цеха № 4' },
    ]);
    expect(options).toHaveLength(1);
    expect(options[0]?.id).toBe('emp-1');
    expect(options[0]?.label).toBe('Иванов И.И.');
    expect(options[0]?.hintText).toContain('Начальник цеха № 4');
  });
});
