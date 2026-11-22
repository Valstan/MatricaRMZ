// Сборка промпта агента MiniMax Code из запроса `/v1/messages`.
//
// Запрос приходит в Anthropic-совместимом виде (system-блоки, tools, messages), а
// агент CLI работает с обычным текстом: поэтому всё, что модель должна увидеть,
// собирается здесь — и ответ задан явно, потому что нативной схемы у MiniMax нет
// (`--output-schema` не работает, ADR-0017).

export type AnthropicToolDef = {
  name: string;
  description?: string;
  input_schema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

export type AnthropicSystemBlock = { type: 'text'; text: string };

export type AnthropicMessageParam =
  | { role: 'user'; content: string | Array<Record<string, unknown>> }
  | { role: 'assistant'; content: Array<Record<string, unknown>> }
  | { role: 'user'; content: Array<Record<string, unknown>> };

/** Контракт ответа агента: строгий JSON, иначе шапер не сможет его разобрать. */
export const ANSWER_CONTRACT = [
  'Ответь ОДНИМ JSON-объектом, без текста вокруг и без пояснений:',
  '{"text": "текст ответа сотруднику", "tool_use": {"name": "имя_инструмента", "input": {}}}',
  'Правила:',
  '- Нужен инструмент → заполни "tool_use" (name — строго из списка инструментов, input — объект с их аргументами), а "text" оставь пустым.',
  '- Инструмент не нужен → верни только {"text": "..."}.',
  '- Ничего кроме этого JSON не пиши.',
].join('\n');

function renderTools(tools: AnthropicToolDef[]): string {
  if (!tools.length) return 'Инструменты не заданы.';
  return tools
    .map((tool) => {
      const schema = tool.input_schema ?? {};
      const props = Object.entries(schema.properties ?? {})
        .map(([key, value]) => {
          const type = (value as { type?: string } | undefined)?.type ?? 'string';
          const required = (schema.required ?? []).includes(key) ? ' (обязателен)' : '';
          return `${key}: ${type}${required}`;
        })
        .join(', ');
      const required = (schema.required ?? []).length
        ? `\nОбязательные аргументы: ${(schema.required ?? []).join(', ')}`
        : '';
      return `- ${tool.name}${tool.description ? ` — ${tool.description}` : ''}\n  Аргументы: ${props || 'нет'}${required}`;
    })
    .join('\n');
}

/** Системный промпт агента: правила Ииваныча + каталог инструментов + контракт ответа. */
export function buildAgentSystemPrompt(params: {
  systemBlocks: AnthropicSystemBlock[];
  tools: AnthropicToolDef[];
}): string {
  const rules = params.systemBlocks.map((b) => b.text).filter(Boolean).join('\n\n');
  return [
    rules,
    '',
    'Доступные инструменты (вызывай их через "tool_use"):',
    renderTools(params.tools),
    '',
    ANSWER_CONTRACT,
  ].join('\n');
}

function blockText(block: Record<string, unknown>): string {
  if (block.type === 'text') return String(block.text ?? '');
  if (block.type === 'tool_result') {
    const content = block.content;
    const body = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    return `Результат инструмента ${String(block.tool_use_id ?? '')}: ${body}`;
  }
  if (block.type === 'tool_use') {
    return `Вызван инструмент ${String(block.name ?? '')} с аргументами ${JSON.stringify(block.input ?? {})}`;
  }
  return '';
}

/** История диалога и результаты инструментов — плоским текстом для агента. */
export function buildAgentUserPayload(params: { messages: AnthropicMessageParam[] }): string {
  const parts: string[] = [];
  for (const message of params.messages) {
    if (typeof message.content === 'string') {
      parts.push(message.content);
      continue;
    }
    const rendered = (message.content ?? [])
      .map((block) => blockText(block))
      .filter((text) => text.trim().length > 0);
    if (rendered.length) parts.push(rendered.join('\n'));
  }
  return parts.join('\n\n---\n\n');
}
