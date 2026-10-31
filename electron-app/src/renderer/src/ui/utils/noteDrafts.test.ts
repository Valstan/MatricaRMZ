import { describe, expect, it } from 'vitest';

import type { NoteItem } from '@matricarmz/shared';

import {
  clearDirty,
  ensureTextBlock,
  makeAutoTitle,
  markDirty,
  mergeDraftsFromNotes,
  noteDraftFromNote,
  noteDraftReminderPatch,
  pruneDirtyFlags,
  type NoteDraft,
} from './noteDrafts.js';

function note(overrides: Partial<NoteItem> = {}): NoteItem {
  return {
    id: 'n1',
    ownerUserId: 'u1',
    title: 'Заметка',
    body: [{ id: 'b1', kind: 'text', text: '' }],
    importance: 'normal',
    dueAt: null,
    reminders: [],
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

function draft(text: string): NoteDraft {
  return {
    id: 'n1',
    title: makeAutoTitle([{ id: 'b1', kind: 'text', text }]),
    body: [{ id: 'b1', kind: 'text', text }],
    importance: 'normal',
    dueAt: null,
    reminders: [],
  };
}

describe('черновики заметок: несохранённый текст сильнее серверной копии', () => {
  it('набранный текст не затирается приехавшей строкой, пока заметка помечена изменённой', () => {
    // Прод-случай 26.10.2026: «вносишь текст — он стирается тут же». Причина была
    // в эффекте, который перезапускался от собственной отметки `dirty` и подставлял
    // в textarea снимок, где отметки ещё не было.
    const typed = draft('привет');
    const merged = mergeDraftsFromNotes({ n1: typed }, [note({ body: [{ id: 'b1', kind: 'text', text: '' }] })], () => true);
    expect(merged.n1).toBe(typed);
    expect((merged.n1?.body[0] as { text: string }).text).toBe('привет');
  });

  it('сохранённая заметка (отметки нет) пересобирается из строки сервера', () => {
    const merged = mergeDraftsFromNotes({ n1: draft('старое') }, [note({ body: [{ id: 'b1', kind: 'text', text: 'с сервера' }], updatedAt: 5 })], () => false);
    expect((merged.n1?.body[0] as { text: string }).text).toBe('с сервера');
    expect(merged.n1?.title).toBe('с сервера');
  });

  it('не создаёт новый объект, когда ничего не поменялось — иначе эффект гоняет рендеры', () => {
    const prev = { n1: noteDraftFromNote(note({ body: [{ id: 'b1', kind: 'text', text: 'текст' }] })) };
    const merged = mergeDraftsFromNotes(prev, [note({ body: [{ id: 'b1', kind: 'text', text: 'текст' }] })], () => false);
    expect(merged).toBe(prev);
  });

  it('выбрасывает исчезнувшие заметки и помечает результат изменённым', () => {
    const prev = { gone: noteDraftFromNote(note({ id: 'gone' })) };
    const merged = mergeDraftsFromNotes(prev, [note()], () => false);
    expect(Object.keys(merged)).toEqual(['n1']);
  });

  it('новой заметке без текстового блока он добавляется первым', () => {
    const { body, textIndex } = ensureTextBlock([{ id: 'i1', kind: 'image', fileId: 'f1' }]);
    expect(textIndex).toBe(0);
    expect(body[0]?.kind).toBe('text');
    expect(body).toHaveLength(2);
  });
});

describe('напоминания заметки: несколько точек', () => {
  it('заметка без полей напоминаний (старая) считает свой срок одной точкой', () => {
    const built = noteDraftFromNote(note({ dueAt: 1_700_000_000_000 }));
    expect(built.reminders).toEqual([1_700_000_000_000]);
    expect(built.dueAt).toBe(1_700_000_000_000);
  });

  it('несколько точек: срок — последняя из них', () => {
    const built = noteDraftFromNote(note({ dueAt: 20, reminders: [10, 20] }));
    expect(built.reminders).toEqual([10, 20]);
    expect(built.dueAt).toBe(20);
  });

  it('правка набора точек держит срок последней и чистит дубли', () => {
    expect(noteDraftReminderPatch([50, 10, 50])).toEqual({ reminders: [10, 50], dueAt: 50 });
    expect(noteDraftReminderPatch([])).toEqual({ reminders: [], dueAt: null });
  });

  it('изменившиеся точки пересобирают черновик (объект меняется)', () => {
    const prev = { n1: noteDraftFromNote(note({ dueAt: 10, reminders: [10] })) };
    const merged = mergeDraftsFromNotes(prev, [note({ dueAt: 20, reminders: [10, 20] })], () => false);
    expect(merged).not.toBe(prev);
    expect(merged.n1?.reminders).toEqual([10, 20]);
  });
});

describe('отметки изменений: без лишних новых объектов', () => {
  it('повторная отметка возвращает тот же объект', () => {
    const prev = { n1: true };
    expect(markDirty(prev, 'n1')).toBe(prev);
    expect(markDirty({}, 'n1')).toEqual({ n1: true });
  });

  it('снятие отметки идемпотентно', () => {
    const prev = { n1: false };
    expect(clearDirty(prev, 'n1')).toBe(prev);
  });

  it('чистка отметок не трогает карту, если заметки все на месте', () => {
    const prev = { n1: true };
    expect(pruneDirtyFlags(prev, [note()])).toBe(prev);
  });

  it('отметка пропавшей заметки убирается', () => {
    expect(pruneDirtyFlags({ gone: true, n1: true }, [note()])).toEqual({ n1: true });
  });
});
