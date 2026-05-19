import Anthropic from '@anthropic-ai/sdk';

let cachedClient: Anthropic | null = null;
let missingKeyWarned = false;

export class ClaudeMisconfiguredError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY не задан');
    this.name = 'ClaudeMisconfiguredError';
  }
}

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = String(
    process.env.MATRICA_AI_CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '',
  ).trim();
  if (!apiKey) {
    if (!missingKeyWarned) {
      missingKeyWarned = true;
      console.warn('[claudeProvider] MATRICA_AI_CLAUDE_API_KEY not set — AI assist will fail');
    }
    throw new ClaudeMisconfiguredError();
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

export type CallClaudeOptions = {
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
};

export async function callClaude(args: {
  model: string;
  system: string;
  user: string;
  options?: CallClaudeOptions;
}): Promise<string> {
  const client = getClient();
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('claude timeout')), timeoutMs) : null;
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

export async function callClaudeJson<T = unknown>(args: {
  model: string;
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: { properties: Record<string, JsonSchemaProperty>; required?: string[] };
  options?: CallClaudeOptions;
}): Promise<T | null> {
  const client = getClient();
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('claude timeout')), timeoutMs) : null;
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

export function isClaudeMisconfigured(error: unknown): error is ClaudeMisconfiguredError {
  return error instanceof ClaudeMisconfiguredError;
}

export type ClaudeToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type ClaudeToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ClaudeToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ClaudeToolMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; rawBlocks: Anthropic.ContentBlock[] }
  | { role: 'user'; toolResults: ClaudeToolResult[] };

export type ClaudeWithToolsResult = {
  text: string;
  toolUses: ClaudeToolUse[];
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

export async function callClaudeWithTools(args: {
  model: string;
  systemBlocks: SystemBlock[];
  userMessage: string;
  tools: ClaudeToolDef[];
  executeTool: (toolUse: ClaudeToolUse) => Promise<{ content: string; isError?: boolean }>;
  maxSteps?: number;
  options?: CallClaudeOptions;
}): Promise<ClaudeWithToolsResult> {
  const client = getClient();
  const ac = new AbortController();
  const timeoutMs = args.options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('claude timeout')), timeoutMs) : null;
  const maxSteps = Math.max(1, Math.min(args.maxSteps ?? 4, 8));
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: args.userMessage },
  ];
  const allToolUses: ClaudeToolUse[] = [];
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
        const toolUse: ClaudeToolUse = {
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
