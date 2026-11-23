import { describe, expect, it } from 'vitest';

import {
  addPrintSignatureSlot,
  parsePrintSignatureSlots,
  removePrintSignatureSlot,
  resolvePrintSignatureSlots,
  serializePrintSignatureSlots,
  updatePrintSignatureSlot,
  type PrintSignatureSlot,
} from './printSignatures.js';

// Подписи печатных форм — общий слой (заказ владельца 23.11.2026): блок подписей
// должен быть редактируемым, а добавленная подпись — печататься.

const DEFAULTS: PrintSignatureSlot[] = [
  { caption: 'Директор', employeeId: null, fullName: 'И.А. Тихомиров' },
  { caption: 'Начальник цеха №1', employeeId: null, fullName: 'И.К. Мухаммадиев' },
];

describe('подписи печатных форм', () => {
  it('добавленная оператором подпись не теряется — это и был корень', () => {
    // Прежде сохранённые слоты, которых нет в списке ролей по умолчанию, отбрасывались:
    // подпись исчезала из печати.
    const saved: PrintSignatureSlot[] = [
      { caption: 'Директор', employeeId: null, fullName: 'И.А. Тихомиров' },
      { caption: 'Главный инженер', employeeId: null, fullName: 'Сидоров С.С.' },
    ];
    const resolved = resolvePrintSignatureSlots(saved, DEFAULTS);
    expect(resolved.map((s) => s.caption)).toEqual(['Директор', 'Главный инженер']);
    expect(resolved[1]?.employeeId).toBeNull();
    expect(resolved[1]?.fullName).toBe('Сидоров С.С.');
  });

  it('сохранённый набор заменяет роли по умолчанию целиком: удалённая роль не возвращается', () => {
    const saved: PrintSignatureSlot[] = [{ caption: 'Директор', employeeId: null, fullName: 'И.А. Тихомиров' }];
    const resolved = resolvePrintSignatureSlots(saved, DEFAULTS);
    expect(resolved.map((s) => s.caption)).toEqual(['Директор']);
  });

  it('не сохранено ни одной подписи — печатаются роли по умолчанию', () => {
    expect(resolvePrintSignatureSlots(null, DEFAULTS).map((s) => s.caption)).toEqual([
      'Директор',
      'Начальник цеха №1',
    ]);
    // Явный пустой набор — «оператор снял все подписи», а не «не задано».
    expect(resolvePrintSignatureSlots([], DEFAULTS)).toEqual([]);
  });

  it('пустая подпись (слот есть, имени нет) сохраняется — под неё подписывают от руки', () => {
    const parsed = parsePrintSignatureSlots('[{"caption":"Мастер смены","employeeId":null,"fullName":""}]');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.caption).toBe('Мастер смены');
    // Настоящий мусор — предмет без полей — отбрасывается.
    expect(parsePrintSignatureSlots('[{"foo":1}]')).toEqual([]);
    expect(parsePrintSignatureSlots('не json')).toEqual([]);
  });

  it('правки блока: добавить, изменить, удалить', () => {
    const slots: PrintSignatureSlot[] = [{ caption: 'Директор', employeeId: null, fullName: '' }];
    const added = addPrintSignatureSlot(slots, { caption: 'Инженер' });
    expect(added).toHaveLength(2);
    expect(added[1]?.caption).toBe('Инженер');

    const updated = updatePrintSignatureSlot(added, 1, { employeeId: 'emp-3', fullName: 'Петров П.П.' });
    expect(updated[1]?.employeeId).toBe('emp-3');
    expect(updated[1]?.fullName).toBe('Петров П.П.');
    expect(updated[0]?.caption).toBe('Директор');

    const removed = removePrintSignatureSlot(updated, 0);
    expect(removed.map((s) => s.caption)).toEqual(['Инженер']);
  });

  it('сохранение и разбор — без потерь (пустая подпись остаётся пустой)', () => {
    const slots: PrintSignatureSlot[] = [
      { caption: 'Директор', employeeId: 'emp-1', fullName: '' },
      { caption: '', employeeId: null, fullName: '' },
    ];
    const round = parsePrintSignatureSlots(serializePrintSignatureSlots(slots));
    expect(round).toHaveLength(2);
    expect(round[0]?.employeeId).toBe('emp-1');
    expect(round[1]?.caption).toBe('');
  });
});
