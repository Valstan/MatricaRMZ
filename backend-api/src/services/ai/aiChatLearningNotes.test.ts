import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('../../database/db.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const value = store.get('learning_md');
            return value != null ? [{ key: 'learning_md', value, updatedAt: 0 }] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (row: { value: string }) => ({
        onConflictDoUpdate: async () => {
          store.set('learning_md', row.value);
        },
      }),
    }),
  },
}));

const { appendLearningNote, getLearningNotes } = await import('./aiChatLearningNotes.js');

describe('aiChatLearningNotes', () => {
  beforeEach(() => store.clear());

  it('добавляет заметку с датой и читает её обратно', async () => {
    const res = await appendLearningNote('ОВК = заказчик ООО «ОВК» (тип customer)');
    expect(res.ok).toBe(true);
    const notes = await getLearningNotes();
    expect(notes).toContain('ОВК = заказчик');
    expect(notes).toMatch(/^- \[\d{4}-\d{2}-\d{2}\]/);
  });

  it('не дублирует одинаковые заметки', async () => {
    await appendLearningNote('рекламации ищи через get_reclamations');
    await appendLearningNote('Рекламации ищи через get_reclamations');
    const notes = await getLearningNotes();
    expect(notes!.match(/get_reclamations/g)!.length).toBe(1);
  });

  it('отклоняет пустую заметку', async () => {
    const res = await appendLearningNote('   ');
    expect(res.ok).toBe(false);
  });

  it('вытесняет старейшие строки при переполнении', async () => {
    for (let i = 0; i < 100; i++) {
      await appendLearningNote(`правило номер ${i}: ${'x'.repeat(400)}`);
    }
    const notes = await getLearningNotes();
    expect(notes!.length).toBeLessThanOrEqual(24_000);
    expect(notes).not.toContain('правило номер 0:');
    expect(notes).toContain('правило номер 99:');
  });
});
