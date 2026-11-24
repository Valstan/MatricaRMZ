import { describe, expect, it } from 'vitest';

import {
  productionProgramSignatureTemplateSlots,
  resolveProductionProgramSignatureTemplate,
  type ProductionProgramSignatureTemplate,
} from './productionProgramSignatureTemplate.js';
import { resolvePrintSignatureSlots } from './printSignatures.js';

function tpl(
  id: string,
  name: string,
  slots: string,
  isDefault = false,
  ownerId = 'shared',
): ProductionProgramSignatureTemplate {
  return {
    id,
    ownerId,
    name,
    slots,
    isDefault,
    updatedAt: 0,
    updatedBy: null,
    createdAt: 0,
  };
}

const SLOTS = JSON.stringify([
  { caption: 'Начальник цеха', employeeId: null, fullName: 'Иванов И. И.' },
  { caption: 'Мастер участка', employeeId: null, fullName: 'Петров П. П.' },
]);

describe('шаблон подписей ПП (промт КАРМАНА #120)', () => {
  it('по умолчанию берётся помеченный шаблон', () => {
    const rows = [tpl('a', 'Первый', SLOTS), tpl('b', 'Второй', SLOTS, true)];
    expect(resolveProductionProgramSignatureTemplate(rows)?.id).toBe('b');
  });

  it('если помеченного нет — берётся первый', () => {
    const rows = [tpl('a', 'Первый', SLOTS), tpl('b', 'Второй', SLOTS)];
    expect(resolveProductionProgramSignatureTemplate(rows)?.id).toBe('a');
  });

  it('шаблонов нет — дефолта нет (программа приходит с ролями по умолчанию)', () => {
    expect(resolveProductionProgramSignatureTemplate([])).toBeNull();
    expect(resolveProductionProgramSignatureTemplate(null)).toBeNull();
  });

  it('личный шаблон перекрывает общий — как в печатных формах', () => {
    const rows = [tpl('shared', 'Общий', SLOTS, true), tpl('own', 'Личный', SLOTS, false, 'user-1')];
    expect(resolveProductionProgramSignatureTemplate(rows)?.id).toBe('own');
  });

  it('состав шаблона разбирается общим правилом слотов', () => {
    const slots = productionProgramSignatureTemplateSlots(tpl('a', 'Первый', SLOTS));
    expect(slots).toHaveLength(2);
    expect(slots[0]?.caption).toBe('Начальник цеха');
    expect(slots[0]?.employeeId).toBeNull();
  });

  it('битый состав шаблона не роняет применение — пустой набор', () => {
    expect(productionProgramSignatureTemplateSlots(tpl('a', 'Первый', 'не json'))).toEqual([]);
  });

  it('пустой набор ≠ «не трогал»: null печатает роли по умолчанию, [] — пусто', () => {
    const defaults = [{ caption: 'Роль по умолчанию', employeeId: null, fullName: '' }];
    // `null` — оператор блок не трогал: печатаются роли по умолчанию.
    expect(resolvePrintSignatureSlots(null, defaults)).toHaveLength(1);
    // `[]` — оператор снял всё: печатать нечего.
    expect(resolvePrintSignatureSlots([], defaults)).toHaveLength(0);
    // Шаблон с пустым составом — это `[]`, а не `null`: «снял всё» не путается с
    // «не трогал».
    const emptyTemplate = productionProgramSignatureTemplateSlots(tpl('a', 'Пустой', '[]'));
    expect(emptyTemplate).toEqual([]);
    expect(resolvePrintSignatureSlots(emptyTemplate, defaults)).toHaveLength(0);
  });
});
