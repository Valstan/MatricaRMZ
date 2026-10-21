import { describe, expect, it, vi } from 'vitest';

// Ответ локального движка и откат на сервер: проверяем, что при неудаче движка
// строка уходит на сервер (syncStatus → pending), а в строгом режиме «Только
// этот ПК» остаётся локальной и показывает оператору причину.

const askLocalWithBreaker = vi.fn();
const markAnswerSource = vi.fn();

vi.mock('./aiEngineAuto.js', () => ({
  askLocalWithBreaker: (...args: unknown[]) => askLocalWithBreaker(...args),
  markAnswerSource: (...args: unknown[]) => markAnswerSource(...args),
}));

const { runLocalAiChatAnswer } = await import('./localAiChat.js');

function fakeDb() {
  const sets: Array<Record<string, unknown>> = [];
  return {
    sets,
    db: {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            sets.push(values);
          },
        }),
      }),
    } as never,
  };
}

describe('runLocalAiChatAnswer', () => {
  it('локальный ответ пишется в строку и остаётся на машине', async () => {
    askLocalWithBreaker.mockResolvedValue({ ok: true, text: 'ответ движка' });
    const { db, sets } = fakeDb();
    const res = await runLocalAiChatAnswer(db, 'id-1', 'вопрос', { mode: 'auto' });
    expect(res).toMatchObject({ ok: true, source: 'local' });
    expect(sets[0]).toMatchObject({ status: 'answered', answerText: 'ответ движка', syncStatus: 'synced' });
  });

  it('в «Авто» неудача движка отдаёт вопрос серверу и пинает синк', async () => {
    askLocalWithBreaker.mockResolvedValue({ ok: false, error: 'движок не ответил' });
    const { db, sets } = fakeDb();
    let kicked = 0;
    const res = await runLocalAiChatAnswer(db, 'id-2', 'вопрос', {
      mode: 'auto',
      onFallback: () => {
        kicked += 1;
      },
    });
    expect(res).toMatchObject({ ok: false, source: 'server' });
    expect(sets[0]).toMatchObject({ status: 'pending', syncStatus: 'pending' });
    expect(kicked).toBe(1);
  });

  it('в «Только этот ПК» серверу не отдаём — показываем причину оператору', async () => {
    askLocalWithBreaker.mockResolvedValue({ ok: false, error: 'движок не ответил' });
    const { db, sets } = fakeDb();
    let kicked = 0;
    const res = await runLocalAiChatAnswer(db, 'id-3', 'вопрос', {
      mode: 'local',
      onFallback: () => {
        kicked += 1;
      },
    });
    expect(res).toMatchObject({ ok: false, source: 'local' });
    expect(sets[0]).toMatchObject({ status: 'answered', syncStatus: 'synced' });
    expect(String(sets[0]?.answerText)).toContain('движок не ответил');
    expect(kicked).toBe(0);
  });
});
