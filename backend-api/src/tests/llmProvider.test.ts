import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create, stream: vi.fn() };
  },
}));

import { callLlmJson, callLlmWithTools } from '../services/ai/llmProvider.js';

const TOOL_USE_RESPONSE = {
  content: [{ type: 'tool_use', id: 'tu-1', name: 'sql_query', input: {} }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 5 },
};

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 7 },
  };
}

const TOOLS = [
  { name: 'sql_query', description: 'q', input_schema: { type: 'object' as const, properties: {} } },
];

beforeEach(() => {
  create.mockReset();
  process.env.MATRICA_AI_DEEPSEEK_API_KEY = 'test-key';
  delete process.env.MATRICA_AI_PROVIDER;
});

describe('callLlmWithTools', () => {
  it('досинтезирует ответ, когда шаги кончились на вызове инструмента', async () => {
    create
      .mockResolvedValueOnce(TOOL_USE_RESPONSE)
      .mockResolvedValueOnce(TOOL_USE_RESPONSE)
      .mockResolvedValueOnce(textResponse('Двигателей в ремонте: 7.'));

    const result = await callLlmWithTools({
      model: 'deepseek-v4-flash',
      systemBlocks: [{ type: 'text', text: 'system' }],
      userMessage: 'сколько двигателей в ремонте?',
      tools: TOOLS,
      maxSteps: 2,
      executeTool: async () => ({ content: 'rows: 7' }),
    });

    expect(result.text).toBe('Двигателей в ремонте: 7.');
    expect(result.steps).toBe(2);
    expect(create).toHaveBeenCalledTimes(3);
    expect(result.inputTokens).toBe(23);
    expect(result.outputTokens).toBe(17);

    // Инструкция дописана в последнее сообщение пользователя, а не отдельным сообщением:
    // два user-сообщения подряд эндпойнт не принимает.
    const lastCall = create.mock.calls[2]?.[0] as { messages: { role: string; content: unknown }[] };
    const lastMessage = lastCall.messages[lastCall.messages.length - 1];
    expect(lastMessage?.role).toBe('user');
    const blocks = lastMessage?.content as { type: string; text?: string }[];
    expect(blocks[0]?.type).toBe('tool_result');
    expect(blocks[blocks.length - 1]?.text).toContain('Лимит обращений к инструментам исчерпан');
  });

  it('отдаёт текст последнего шага, если досинтез вернул пустоту', async () => {
    create
      .mockResolvedValueOnce({ ...TOOL_USE_RESPONSE, content: [{ type: 'text', text: 'промежуточный вывод' }, ...TOOL_USE_RESPONSE.content] })
      .mockResolvedValueOnce(textResponse(''));

    const result = await callLlmWithTools({
      model: 'deepseek-v4-flash',
      systemBlocks: [{ type: 'text', text: 'system' }],
      userMessage: 'вопрос',
      tools: TOOLS,
      maxSteps: 1,
      executeTool: async () => ({ content: 'ok' }),
    });

    expect(result.text).toBe('промежуточный вывод');
  });

  it('возвращает текст сразу, как только модель перестала звать инструменты', async () => {
    create.mockResolvedValueOnce(textResponse('Готово.'));

    const result = await callLlmWithTools({
      model: 'deepseek-v4-flash',
      systemBlocks: [{ type: 'text', text: 'system' }],
      userMessage: 'вопрос',
      tools: TOOLS,
      maxSteps: 4,
      executeTool: async () => ({ content: 'ok' }),
    });

    expect(result.text).toBe('Готово.');
    expect(result.steps).toBe(1);
    expect(result.stopReason).toBe('end_turn');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('callLlmJson', () => {
  const JSON_ARGS = {
    model: 'deepseek-v4-flash',
    system: 'system',
    user: 'user',
    toolName: 'report',
    toolDescription: 'отчёт',
    schema: { properties: {} },
  };

  it('на deepseek не принуждает tool_choice (thinking-режим его отвергает)', async () => {
    create.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'tu-1', name: 'report', input: { ok: true } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const result = await callLlmJson<{ ok: boolean }>(JSON_ARGS);

    expect(result).toEqual({ ok: true });
    const params = create.mock.calls[0]?.[0] as { tool_choice?: unknown; system: string };
    expect(params.tool_choice).toBeUndefined();
    expect(params.system).toContain('report');
  });

  it('на anthropic принуждает tool_choice и откатывается на инструкцию при отказе', async () => {
    process.env.MATRICA_AI_PROVIDER = 'anthropic';
    process.env.MATRICA_AI_CLAUDE_API_KEY = 'test-key';
    create
      .mockRejectedValueOnce(new Error('400 {"error":{"message":"Thinking mode does not support this tool_choice"}}'))
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu-1', name: 'report', input: { ok: 1 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    const result = await callLlmJson<{ ok: number }>(JSON_ARGS);

    expect(result).toEqual({ ok: 1 });
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[0]?.[0] as { tool_choice?: unknown }).tool_choice).toEqual({
      type: 'tool',
      name: 'report',
    });
    expect((create.mock.calls[1]?.[0] as { tool_choice?: unknown }).tool_choice).toBeUndefined();
  });
});
