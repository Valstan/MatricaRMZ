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
  const apiKey = String(process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) {
    if (!missingKeyWarned) {
      missingKeyWarned = true;
      console.warn('[claudeProvider] ANTHROPIC_API_KEY not set — AI assist will fail');
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
