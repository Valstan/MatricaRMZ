import { describe, expect, it } from 'vitest';

import { aiChatRequestRowSchema } from './dto.js';

const BASE = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  username: 'ivan',
  question_text: 'сколько двигателей в работе?',
  status: 'answered' as const,
  created_at: 1792600000000,
  updated_at: 1792600000000,
  sync_status: 'synced' as const,
};

describe('aiChatRequestRowSchema.answer_source', () => {
  it('знает два звена серверной цепочки', () => {
    expect(aiChatRequestRowSchema.parse({ ...BASE, answer_source: 'engine' }).answer_source).toBe('engine');
    expect(aiChatRequestRowSchema.parse({ ...BASE, answer_source: 'deepseek' }).answer_source).toBe('deepseek');
  });

  it('старые строки и эскалации — null/без поля', () => {
    expect(aiChatRequestRowSchema.parse({ ...BASE, answer_source: null }).answer_source).toBeNull();
    expect(aiChatRequestRowSchema.parse(BASE).answer_source).toBeUndefined();
  });

  // Значение приходит из БД и уезжает клиентам: свободная строка означала бы, что
  // в окне чата может появиться любой текст «источника», включая поддельный.
  it('прочие значения отвергаются', () => {
    expect(() => aiChatRequestRowSchema.parse({ ...BASE, answer_source: 'local' })).toThrow();
    expect(() => aiChatRequestRowSchema.parse({ ...BASE, answer_source: 'engine ' })).toThrow();
  });
});
