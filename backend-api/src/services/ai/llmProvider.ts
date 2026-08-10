// Единая точка обращения к LLM. Движок экосистемы — DeepSeek API напрямую (D-024):
// у него есть Anthropic-совместимый эндпойнт, поэтому тот же @anthropic-ai/sdk и весь
// tools-контур работают без изменений — меняется только baseURL, ключ и имя модели.
// Anthropic оставлен переключателем MATRICA_AI_PROVIDER=anthropic (с РФ-IP он режется
// на эдже — memory anthropic-geo-block, поэтому дефолт именно deepseek).
import Anthropic from '@anthropic-ai/sdk';

const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';

let cachedClient: Anthropic | null = null;
let missingKeyWarned = false;

export type LlmProviderName = 'deepseek' | 'anthropic';

export function getLlmProvider(): LlmProviderName {
  return String(process.env.MATRICA_AI_PROVIDER ?? 'deepseek').trim().toLowerCase() === 'anthropic'
    ? 'anthropic'
    : 'deepseek';
}

function apiKeyForProvider(provider: LlmProviderName): string {
  const raw =
    provider === 'deepseek'
      ? (process.env.MATRICA_AI_DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '')
      : (process.env.MATRICA_AI_CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '');
  return String(raw).trim();
}

/** Ключ движка настроен? Нужно баннеру ИИваныча и health-проверкам — без броска исключения. */
export function isLlmConfigured(): boolean {
  return apiKeyForProvider(getLlmProvider()).length > 0;
}

export class LlmMisconfiguredError extends Error {
  constructor(provider: LlmProviderName) {
    super(provider === 'deepseek' ? 'DEEPSEEK_API_KEY не задан' : 'ANTHROPIC_API_KEY не задан');
    this.name = 'LlmMisconfiguredError';
  }
}

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const provider = getLlmProvider();
  const apiKey = apiKeyForProvider(provider);
  if (!apiKey) {
    if (!missingKeyWarned) {
      missingKeyWarned = true;
      console.warn(`[llmProvider] api key for provider "${provider}" not set — AI assist will fail`);
    }
    throw new LlmMisconfiguredError(provider);
  }
  cachedClient = new Anthropic({
    apiKey,
    ...(provider === 'deepseek' ? { baseURL: DEEPSEEK_ANTHROPIC_BASE_URL } : {}),
  });
  return cachedClient;
}

export type CallLlmOptions = {
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
};

export async function callLlm(args: {
  model: string;
  system: string;
  user: string;
  options?: CallLlmOptions;
}): Promise<string> {
  const client = getClient();
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs) : null;
  try {
    const resp = await client.messages.create(
      {
        model: args.model,
        max_tokens: args.options?.maxTokens ?? 1024,
        system: args.system,
        messages: [{ role: 'user', content: args.user }],
        ...(args.options?.temperature != null ? { temperature: args.options.temperature } : {}),
      },
      { signal: ac.signal },
    );
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type JsonSchemaProperty = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export async function callLlmJson<T = unknown>(args: {
  model: string;
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: { properties: Record<string, JsonSchemaProperty>; required?: string[] };
  options?: CallLlmOptions;
}): Promise<T | null> {
  const client = getClient();
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs) : null;
  try {
    const resp = await client.messages.create(
      {
        model: args.model,
        max_tokens: args.options?.maxTokens ?? 1024,
        system: args.system,
        tools: [
          {
            name: args.toolName,
            description: args.toolDescription,
            input_schema: {
              type: 'object',
              properties: args.schema.properties as Record<string, unknown>,
              ...(args.schema.required ? { required: args.schema.required } : {}),
            },
          },
        ],
        tool_choice: { type: 'tool', name: args.toolName },
        messages: [{ role: 'user', content: args.user }],
        ...(args.options?.temperature != null ? { temperature: args.options.temperature } : {}),
      },
      { signal: ac.signal },
    );
    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!toolUse) return null;
    return toolUse.input as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isLlmMisconfigured(error: unknown): error is LlmMisconfiguredError {
  return error instanceof LlmMisconfiguredError;
}

export type LlmToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type LlmToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type LlmToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type LlmToolMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; rawBlocks: Anthropic.ContentBlock[] }
  | { role: 'user'; toolResults: LlmToolResult[] };

export type LlmWithToolsResult = {
  text: string;
  toolUses: LlmToolUse[];
  steps: number;
  inputTokens: number;
  outputTokens: number;
};

export type SystemBlock =
  | { type: 'text'; text: string; cacheable?: boolean };

function toSystemParam(blocks: SystemBlock[]): string | Anthropic.TextBlockParam[] {
  if (blocks.length === 1 && !blocks[0]?.cacheable) return blocks[0]?.text ?? '';
  return blocks.map<Anthropic.TextBlockParam>((b) => ({
    type: 'text',
    text: b.text,
    ...(b.cacheable ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
}

export async function callLlmWithTools(args: {
  model: string;
  systemBlocks: SystemBlock[];
  userMessage: string;
  tools: LlmToolDef[];
  executeTool: (toolUse: LlmToolUse) => Promise<{ content: string; isError?: boolean }>;
  maxSteps?: number;
  options?: CallLlmOptions;
}): Promise<LlmWithToolsResult> {
  const client = getClient();
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs) : null;
  const maxSteps = Math.max(1, Math.min(args.maxSteps ?? 4, 8));
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: args.userMessage },
  ];
  const allToolUses: LlmToolUse[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    for (let step = 1; step <= maxSteps; step++) {
      const resp = await client.messages.create(
        {
          model: args.model,
          max_tokens: args.options?.maxTokens ?? 1024,
          system: toSystemParam(args.systemBlocks),
          tools: args.tools,
          messages,
          ...(args.options?.temperature != null ? { temperature: args.options.temperature } : {}),
        },
        { signal: ac.signal },
      );
      inputTokens += resp.usage?.input_tokens ?? 0;
      outputTokens += resp.usage?.output_tokens ?? 0;
      const toolUseBlocks = resp.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const textBlocks = resp.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      );
      if (toolUseBlocks.length === 0 || resp.stop_reason !== 'tool_use') {
        const finalText = textBlocks.map((b) => b.text).join('\n').trim();
        return { text: finalText, toolUses: allToolUses, steps: step, inputTokens, outputTokens };
      }
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUseBlocks) {
        const toolUse: LlmToolUse = {
          id: tu.id,
          name: tu.name,
          input: (tu.input ?? {}) as Record<string, unknown>,
        };
        allToolUses.push(toolUse);
        const result = await args.executeTool(toolUse).catch((err) => ({
          content: `Ошибка выполнения tool: ${String(err)}`,
          isError: true,
        }));
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    return { text: '', toolUses: allToolUses, steps: maxSteps, inputTokens, outputTokens };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type LlmStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; id: string }
  | { type: 'tool_result'; toolUseId: string; toolName: string; content: string; isError?: boolean }
  | { type: 'step_done'; step: number; stopReason: string | null }
  | { type: 'done'; inputTokens: number; outputTokens: number; steps: number; toolUses: LlmToolUse[]; text: string }
  | { type: 'error'; error: string };

export async function streamLlmWithTools(args: {
  model: string;
  systemBlocks: SystemBlock[];
  userMessage: string;
  tools: LlmToolDef[];
  executeTool: (toolUse: LlmToolUse) => Promise<{ content: string; isError?: boolean }>;
  onEvent: (ev: LlmStreamEvent) => void | Promise<void>;
  maxSteps?: number;
  options?: CallLlmOptions;
}): Promise<LlmWithToolsResult> {
  const client = getClient();
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('llm timeout')), timeoutMs) : null;
  const maxSteps = Math.max(1, Math.min(args.maxSteps ?? 4, 8));
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: args.userMessage }];
  const allToolUses: LlmToolUse[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = '';
  try {
    for (let step = 1; step <= maxSteps; step++) {
      const stream = client.messages.stream(
        {
          model: args.model,
          max_tokens: args.options?.maxTokens ?? 1024,
          system: toSystemParam(args.systemBlocks),
          tools: args.tools,
          messages,
          ...(args.options?.temperature != null ? { temperature: args.options.temperature } : {}),
        },
        { signal: ac.signal },
      );
      stream.on('text', (delta: string) => {
        if (delta) void args.onEvent({ type: 'text', delta });
      });
      const finalMessage = await stream.finalMessage();
      inputTokens += finalMessage.usage?.input_tokens ?? 0;
      outputTokens += finalMessage.usage?.output_tokens ?? 0;
      const toolUseBlocks = finalMessage.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const textBlocks = finalMessage.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      );
      const stepText = textBlocks.map((b) => b.text).join('\n').trim();
      if (stepText) finalText = stepText;
      await args.onEvent({ type: 'step_done', step, stopReason: finalMessage.stop_reason });
      if (toolUseBlocks.length === 0 || finalMessage.stop_reason !== 'tool_use') {
        await args.onEvent({
          type: 'done',
          inputTokens,
          outputTokens,
          steps: step,
          toolUses: allToolUses,
          text: finalText,
        });
        return { text: finalText, toolUses: allToolUses, steps: step, inputTokens, outputTokens };
      }
      messages.push({ role: 'assistant', content: finalMessage.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUseBlocks) {
        const toolUse: LlmToolUse = {
          id: tu.id,
          name: tu.name,
          input: (tu.input ?? {}) as Record<string, unknown>,
        };
        allToolUses.push(toolUse);
        await args.onEvent({ type: 'tool_use', id: tu.id, name: tu.name, input: toolUse.input });
        const result = await args.executeTool(toolUse).catch((err) => ({
          content: `Ошибка выполнения tool: ${String(err)}`,
          isError: true,
        }));
        await args.onEvent({
          type: 'tool_result',
          toolUseId: tu.id,
          toolName: tu.name,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    await args.onEvent({
      type: 'done',
      inputTokens,
      outputTokens,
      steps: maxSteps,
      toolUses: allToolUses,
      text: finalText,
    });
    return { text: finalText, toolUses: allToolUses, steps: maxSteps, inputTokens, outputTokens };
  } catch (err) {
    try {
      await args.onEvent({ type: 'error', error: String(err) });
    } catch {
      // suppress: emitting failure should not mask the original error
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
