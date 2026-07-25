import { describe, expect, it } from 'vitest';

import { applyAiChatPushPolicy, type AiChatExistingRow, type AiChatPushRow } from './aiChatPushPolicy.js';

const ACTOR = 'user-1';

function row(over: Partial<AiChatPushRow> = {}): AiChatPushRow {
  return {
    id: 'q1',
    user_id: ACTOR,
    username: 'ivan',
    question_text: 'почему станок молчит?',
    status: 'pending',
    ...over,
  };
}

function existing(over: Partial<AiChatExistingRow> = {}): AiChatExistingRow {
  return {
    userId: ACTOR,
    username: 'ivan',
    questionText: 'почему станок молчит?',
    status: 'pending',
    ...over,
  };
}

function ctx(over: Partial<Parameters<typeof applyAiChatPushPolicy>[2]> = {}) {
  return {
    actorId: ACTOR,
    trustedServerWrite: false,
    actorIsAdmin: false,
    actorIsSuperadmin: false,
    initialHourCount: 0,
    ...over,
  };
}

describe('applyAiChatPushPolicy', () => {
  it('trusted-bypass: серверная запись проходит как есть (поля ответа не затираются)', () => {
    const r = row({ status: 'answered', answer_text: 'готово', user_id: 'someone-else' });
    const out = applyAiChatPushPolicy([r], new Map(), ctx({ trustedServerWrite: true }));
    expect(out).toEqual([r]);
  });

  it('новый вопрос: владелец = актор, статус pending, серверные поля обнулены', () => {
    const r = row({ user_id: 'spoofed', status: 'answered', answer_text: 'подделка', verdict_text: 'v' });
    const out = applyAiChatPushPolicy([r], new Map(), ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.user_id).toBe(ACTOR);
    expect(out[0]!.status).toBe('pending');
    expect(out[0]!.answer_text).toBeNull();
    expect(out[0]!.verdict_text).toBeNull();
  });

  it('rate limit: 5-й новый вопрос за час проходит, 6-й падает', () => {
    const five = Array.from({ length: 5 }, (_, i) => row({ id: `q${i}` }));
    expect(applyAiChatPushPolicy(five, new Map(), ctx())).toHaveLength(5);
    const six = Array.from({ length: 6 }, (_, i) => row({ id: `q${i}` }));
    expect(() => applyAiChatPushPolicy(six, new Map(), ctx())).toThrow('ai_chat_rate_limit');
  });

  it('rate limit учитывает существующие вопросы часа (initialHourCount)', () => {
    const two = [row({ id: 'a' }), row({ id: 'b' })];
    expect(() => applyAiChatPushPolicy(two, new Map(), ctx({ initialHourCount: 4 }))).toThrow('ai_chat_rate_limit');
    expect(applyAiChatPushPolicy([row({ id: 'a' })], new Map(), ctx({ initialHourCount: 4 }))).toHaveLength(1);
  });

  it('rate limit не действует на админа', () => {
    const many = Array.from({ length: 10 }, (_, i) => row({ id: `q${i}` }));
    expect(applyAiChatPushPolicy(many, new Map(), ctx({ actorIsAdmin: true }))).toHaveLength(10);
  });

  it('ownership: чужую строку не-админ править не может', () => {
    const map = new Map([['q1', existing({ userId: 'other-user' })]]);
    expect(() => applyAiChatPushPolicy([row()], map, ctx())).toThrow('ai_chat_owner');
  });

  it('pending-only: answered-строку владелец не правит', () => {
    const map = new Map([['q1', existing({ status: 'answered' })]]);
    expect(() => applyAiChatPushPolicy([row()], map, ctx())).toThrow('ai_chat_not_pending');
  });

  it('правка своего pending: серверные поля затираются, владелец сохраняется', () => {
    const map = new Map([['q1', existing()]]);
    const r = row({ question_text: 'обновлённый вопрос', answer_text: 'самоответ', user_id: 'spoofed' });
    const out = applyAiChatPushPolicy([r], map, ctx());
    expect(out[0]!.question_text).toBe('обновлённый вопрос');
    expect(out[0]!.user_id).toBe(ACTOR);
    expect(out[0]!.answer_text).toBeNull();
    expect(out[0]!.status).toBe('pending');
  });

  it('суперадмин-исключение: verdict_text в escalated проходит, остальное — из текущей строки', () => {
    const map = new Map([
      ['q1', existing({ userId: 'other-user', status: 'escalated', answerText: 'ответ рутины', escalationNote: 'note' })],
    ]);
    const r = row({ verdict_text: 'вердикт супера', question_text: 'подмена вопроса', answer_text: 'подмена ответа' });
    const out = applyAiChatPushPolicy([r], map, ctx({ actorIsAdmin: true, actorIsSuperadmin: true }));
    expect(out[0]!.verdict_text).toBe('вердикт супера');
    expect(out[0]!.question_text).toBe('почему станок молчит?');
    expect(out[0]!.answer_text).toBe('ответ рутины');
    expect(out[0]!.status).toBe('escalated');
    expect(out[0]!.user_id).toBe('other-user');
  });

  it('обычный админ (не супер) в escalated-строку не пишет', () => {
    const map = new Map([['q1', existing({ userId: 'other-user', status: 'escalated' })]]);
    expect(() => applyAiChatPushPolicy([row()], map, ctx({ actorIsAdmin: true }))).toThrow('ai_chat_not_pending');
  });
});
