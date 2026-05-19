export type AiAgentEventType =
  | 'focus'
  | 'blur'
  | 'input'
  | 'idle'
  | 'submit'
  | 'open'
  | 'navigate';

export type AiAgentFieldContext = {
  name?: string | null;
  label?: string | null;
  placeholder?: string | null;
  inputType?: string | null;
};

export type AiAgentContext = {
  tab: string;
  entityId?: string | null;
  entityType?: string | null;
  breadcrumbs?: string[];
};

export type AiAgentEvent = {
  type: AiAgentEventType;
  ts: number;
  tab: string;
  entityId?: string | null;
  entityType?: string | null;
  field?: AiAgentFieldContext | null;
  valuePreview?: string | null;
  durationMs?: number | null;
  idleMs?: number | null;
};

export type AiAgentAssistRequest = {
  message: string;
  context: AiAgentContext;
  conversationId?: string;
  lastEvent?: AiAgentEvent | null;
  recentEvents?: AiAgentEvent[];
};

export type AiAgentSuggestion = {
  kind: 'suggestion' | 'question' | 'info';
  text: string;
  actions?: string[];
};

type ErrorResult = { ok: false; error: string };

export type AiAgentAssistResponse =
  | { ok: true; reply: AiAgentSuggestion; conversationId?: string }
  | ErrorResult;

export type AiAgentLogRequest = {
  context: AiAgentContext;
  event: AiAgentEvent;
};

export type AiAgentLogResponse = { ok: true } | ErrorResult;

export type AiChatConversationSummary = {
  conversationId: string;
  lastMessageAt: number;
  messageCount: number;
  lastUserMessage: string;
  lastModel: string | null;
};

export type AiChatHistoryMessage = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  ts: number;
};

export type AiAgentConversationsListResponse =
  | { ok: true; items: AiChatConversationSummary[] }
  | ErrorResult;

export type AiAgentConversationMessagesResponse =
  | { ok: true; conversationId: string; messages: AiChatHistoryMessage[] }
  | ErrorResult;

export type AiAgentConversationDeleteResponse = { ok: true; removed: number } | ErrorResult;

export type AiAgentConversationSearchResponse =
  | { ok: true; items: AiChatHistoryMessage[] }
  | ErrorResult;

export type AiAgentStreamEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; toolName: string; content: string; isError?: boolean }
  | { type: 'step_done'; step: number; stopReason: string | null }
  | { type: 'final'; conversationId: string; reply: AiAgentSuggestion; model: string; escalated?: boolean; inputTokens?: number; outputTokens?: number }
  | { type: 'error'; error: string }
  | { type: 'done' };
