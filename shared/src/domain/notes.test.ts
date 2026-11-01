import { describe, expect, it } from 'vitest';

import {
  effectiveNoteDueAt,
  effectiveNoteReminders,
  nextNoteReminderPoint,
  normalizeNoteReminderPoints,
  noteRemindersDueAt,
  parseNoteReminders,
  serializeNoteReminders,
} from './notes.js';

describe('напоминания заметки: разбор и сборка', () => {
  it('три состояния поля различаются: не задано / пусто / точки', () => {
    expect(parseNoteReminders(null)).toBeNull();
    expect(parseNoteReminders(undefined)).toBeNull();
    expect(parseNoteReminders('[]')).toEqual([]);
    expect(parseNoteReminders('[1700000000000]')).toEqual([1700000000000]);
  });

  it('битое значение не превращается в тишину: поле трактуется как пустое', () => {
    expect(parseNoteReminders('не json')).toEqual([]);
    expect(parseNoteReminders('{"a":1}')).toEqual([]);
  });

  it('точки нормализуются: только целые положительные, без повторов, по возрастанию', () => {
    expect(normalizeNoteReminderPoints([3, 1, 1, 0, -5, 2.7, 'x', null])).toEqual([1, 2, 3]);
  });

  it('набор в строку контракта: пусто — это "[]", а не null', () => {
    expect(serializeNoteReminders([])).toBe('[]');
    expect(serializeNoteReminders([2, 1, 2])).toBe('[1,2]');
  });
});

describe('напоминания заметки: действующие точки', () => {
  it('заметка, заведённая до множественных точек, считает старый срок одной точкой', () => {
    expect(effectiveNoteReminders(null, 1_700_000_000_000)).toEqual([1_700_000_000_000]);
    expect(effectiveNoteReminders(null, null)).toEqual([]);
  });

  it('явно пустой набор снимает и срок', () => {
    expect(effectiveNoteReminders('[]', 1_700_000_000_000)).toEqual([]);
    expect(effectiveNoteDueAt('[]', 1_700_000_000_000)).toBeNull();
  });

  it('срок — последняя точка: "просрочено" наступает, когда прошла последняя', () => {
    expect(noteRemindersDueAt([10, 50, 30])).toBe(50);
    expect(effectiveNoteDueAt('[10,50,30]', 999)).toBe(50);
    expect(noteRemindersDueAt([])).toBeNull();
  });

  it('ближайшая точка — та, что ещё не прошла', () => {
    expect(nextNoteReminderPoint([10, 50, 30], 20)).toBe(30);
    expect(nextNoteReminderPoint([10, 50], 60)).toBeNull();
    expect(nextNoteReminderPoint([], 60)).toBeNull();
  });
});
