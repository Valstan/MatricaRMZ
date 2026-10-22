import { describe, expect, it } from 'vitest';

import { formatAiChatAnswerSourceLabel } from './aiChatSchedule.js';

describe('formatAiChatAnswerSourceLabel', () => {
  it('серверное звено важнее клиентской пометки', () => {
    expect(formatAiChatAnswerSourceLabel({ answerSource: 'server', serverAnswerSource: 'engine' })).toBe(
      'считал движок завода',
    );
    expect(formatAiChatAnswerSourceLabel({ answerSource: 'server', serverAnswerSource: 'deepseek' })).toBe(
      'считал резервный движок',
    );
  });

  it('старые строки без answer_source показывают прежнюю пометку', () => {
    expect(formatAiChatAnswerSourceLabel({ answerSource: 'server', serverAnswerSource: null })).toBe('считал сервер');
    expect(formatAiChatAnswerSourceLabel({ answerSource: 'local', serverAnswerSource: null })).toBe('');
  });

  it('строка без пометок источника не даёт подписи', () => {
    expect(formatAiChatAnswerSourceLabel({})).toBe('');
    expect(formatAiChatAnswerSourceLabel({ answerSource: null, serverAnswerSource: null })).toBe('');
  });
});
