import { describe, expect, it } from 'vitest';

import { extractJsonObject, shapeAgentAnswer } from './toolUseShaper.js';

describe('extractJsonObject', () => {
  it('берёт голый JSON', () => {
    expect(extractJsonObject('{"text":"привет"}')).toEqual({ text: 'привет' });
  });

  it('берёт JSON из блока кода', () => {
    expect(extractJsonObject('```json\n{"text":"привет"}\n```')).toEqual({ text: 'привет' });
  });

  it('берёт JSON из текста вокруг', () => {
    expect(extractJsonObject('Вот ответ: {"text":"привет"} — всё')).toEqual({ text: 'привет' });
  });

  it('не выдумывает объект, если JSON нет', () => {
    expect(extractJsonObject('просто слова')).toBeNull();
  });
});

describe('shapeAgentAnswer', () => {
  const tools = [{ name: 'find_entity' }, { name: 'escalate_to_admin' }];

  it('текстовый ответ без инструмента', () => {
    const shaped = shapeAgentAnswer('{"text":"Ответ по заводу"}', tools);
    expect(shaped.stopReason).toBe('end_turn');
    expect(shaped.blocks).toEqual([{ type: 'text', text: 'Ответ по заводу' }]);
  });

  it('вызов инструмента превращается в tool_use', () => {
    const shaped = shapeAgentAnswer(
      '{"tool_use":{"name":"find_entity","input":{"query":"Иванов"}}}',
      tools,
    );
    expect(shaped.stopReason).toBe('tool_use');
    const block = shaped.blocks[0] as { type: string; id: string; name: string; input: Record<string, unknown> };
    expect(block.type).toBe('tool_use');
    expect(block.name).toBe('find_entity');
    expect(block.input).toEqual({ query: 'Иванов' });
    expect(block.id).toMatch(/^toolu_/);
  });

  it('несколько вызовов дают несколько блоков', () => {
    const shaped = shapeAgentAnswer(
      '{"tool_calls":[{"name":"find_entity","input":{"query":"а"}},{"name":"escalate_to_admin","input":{"reason":"б"}}]}',
      tools,
    );
    expect(shaped.stopReason).toBe('tool_use');
    expect(shaped.blocks).toHaveLength(2);
  });

  it('незапрошенный инструмент отбрасывается, а текст остаётся', () => {
    const shaped = shapeAgentAnswer(
      '{"text":"сработало","tool_use":{"name":"drop_table","input":{}}}',
      tools,
    );
    expect(shaped.stopReason).toBe('end_turn');
    expect(shaped.blocks).toEqual([{ type: 'text', text: 'сработало' }]);
    expect(shaped.warnings.join(' ')).toContain('drop_table');
  });

  it('не-объект во входе приводится к объекту', () => {
    const shaped = shapeAgentAnswer('{"tool_use":{"name":"find_entity","input":"Иванов"}}', tools);
    const block = shaped.blocks[0] as { input: Record<string, unknown> };
    expect(block.input).toEqual({ query: 'Иванов' });
    expect(shaped.warnings.length).toBeGreaterThan(0);
  });

  it('текст без JSON отдаётся как есть и помечается замечанием', () => {
    const shaped = shapeAgentAnswer('просто слова ответа', tools);
    expect(shaped.blocks).toEqual([{ type: 'text', text: 'просто слова ответа' }]);
    expect(shaped.warnings.join(' ')).toContain('не разобран');
  });

  it('пустой ответ — пустой результат, а не выдуманный текст', () => {
    const shaped = shapeAgentAnswer('   ', tools);
    expect(shaped.blocks).toEqual([]);
    expect(shaped.warnings.length).toBeGreaterThan(0);
  });
});
