import { describe, expect, it } from 'vitest';

import {
  AI_CHAT_ENGINE_UNAVAILABLE_LINE,
  AI_CHAT_LOCAL_STATE_LABELS,
  aiChatLocalStatusLine,
  formatAiChatAnswerSourceLabel,
  isClientAnswerSource,
} from './aiChatSchedule.js';

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
  const states = ['off', 'ready', 'working', 'no_accounts', 'broken'] as const;
  const causes = [
    'not_configured',
    'no_free_accounts',
    'no_tokens_ready',
    'no_handable_accounts',
    'pool_unavailable',
    'module_failed',
  ] as const;

  it('у каждого состояния есть подпись для панели', () => {
    for (const state of states) {
      expect(AI_CHAT_LOCAL_STATE_LABELS[state]).toBeTruthy();
    }
    expect(AI_CHAT_LOCAL_STATE_LABELS.ready).toContain('этот компьютер');
    expect(AI_CHAT_LOCAL_STATE_LABELS.no_accounts).toContain('считает сервер');
  });

  it('красный — только когда не отвечает никто', () => {
    // Отказ локального звена — не красный: вопрос отпускается в очередь, его считает
    // сервер. Красный в панели — это «сервер тоже не берёт вопрос».
    expect(AI_CHAT_LOCAL_STATE_LABELS.broken).not.toContain('🔴');
    expect(AI_CHAT_ENGINE_UNAVAILABLE_LINE.label).toContain('🔴');
  });

  it('причины пустоты различаются — оператор видит разное', () => {
    const empty = aiChatLocalStatusLine({ state: 'no_accounts', cause: 'no_free_accounts', configured: true });
    const noTokens = aiChatLocalStatusLine({ state: 'no_accounts', cause: 'no_tokens_ready', configured: true });
    const noHandleable = aiChatLocalStatusLine({ state: 'no_accounts', cause: 'no_handable_accounts', configured: true });
    const broken = aiChatLocalStatusLine({ state: 'broken', cause: 'pool_unavailable', configured: true });
    expect(empty.text).not.toBe(noTokens.text);
    expect(empty.text).not.toBe(noHandleable.text);
    expect(empty.text).not.toBe(broken.text);
  });

  it('в строке нет ни кодов, ни служебных слов', () => {
    // Правило промта #176: оператор не видит кодов причин, названий сервисов и
    // внутренних терминов — только человеческие слова.
    const forbidden = /no_free_accounts|no_tokens_ready|no_handable_accounts|Карман|пул|токен|MiniMax|агент/i;
    for (const state of states) {
      for (const cause of causes) {
        const line = aiChatLocalStatusLine({ state, cause, configured: true });
        expect(`${line.label} ${line.text} ${line.title}`).not.toMatch(forbidden);
      }
    }
  });
});
