import { describe, expect, it } from 'vitest';

import { formatAiChatAnswerSourceLabel } from './aiChatSchedule.js';

describe('formatAiChatAnswerSourceLabel', () => {
  it('называет звено серверной цепочки', () => {
    expect(formatAiChatAnswerSourceLabel({ serverAnswerSource: 'engine' })).toBe('считал движок завода');
    expect(formatAiChatAnswerSourceLabel({ serverAnswerSource: 'deepseek' })).toBe('считал резервный движок');
  });

  it('старые строки без answer_source показывают «считал сервер»', () => {
    // Локального звена на клиенте нет с 23.10.2026: любой ответ посчитан сервером.
    expect(formatAiChatAnswerSourceLabel({ serverAnswerSource: null })).toBe('считал сервер');
    expect(formatAiChatAnswerSourceLabel({})).toBe('считал сервер');
  });
});
