import { describe, expect, it } from 'vitest';

import { AI_CHAT_LOCAL_STATE_LABELS, formatAiChatAnswerSourceLabel, isClientAnswerSource } from './aiChatSchedule.js';

describe('formatAiChatAnswerSourceLabel', () => {
  it('называет звено серверной цепочки', () => {
    expect(formatAiChatAnswerSourceLabel({ serverAnswerSource: 'engine' })).toBe('считал движок завода');
    expect(formatAiChatAnswerSourceLabel({ serverAnswerSource: 'deepseek' })).toBe('считал резервный движок');
  });

  it('называет локальное звено на машине оператора', () => {
    expect(formatAiChatAnswerSourceLabel({ serverAnswerSource: 'local_minimax' })).toBe('считал этот компьютер');
    expect(formatAiChatAnswerSourceLabel({ serverAnswerSource: 'deepseek_client' })).toBe('считал резерв с этого компьютера');
  });

  it('старые строки без answer_source показывают «считал сервер»', () => {
    expect(formatAiChatAnswerSourceLabel({ serverAnswerSource: null })).toBe('считал сервер');
    expect(formatAiChatAnswerSourceLabel({})).toBe('считал сервер');
  });
});

describe('isClientAnswerSource', () => {
  it('клиентские источники — только те, что пишет компьютер оператора', () => {
    expect(isClientAnswerSource('local_minimax')).toBe(true);
    expect(isClientAnswerSource('deepseek_client')).toBe(true);
    expect(isClientAnswerSource('engine')).toBe(false);
    expect(isClientAnswerSource('deepseek')).toBe(false);
    expect(isClientAnswerSource(null)).toBe(false);
  });
});

describe('состояния локального звена', () => {
  it('у каждого состояния есть подпись для панели', () => {
    for (const state of ['off', 'ready', 'working', 'no_accounts', 'broken'] as const) {
      expect(AI_CHAT_LOCAL_STATE_LABELS[state]).toBeTruthy();
    }
    expect(AI_CHAT_LOCAL_STATE_LABELS.no_accounts).toContain('аккаунты кончились');
    expect(AI_CHAT_LOCAL_STATE_LABELS.ready).toContain('этот компьютер');
  });
});
