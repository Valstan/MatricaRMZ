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
  | { ok: true; reply: AiAgentSuggestion }
  | ErrorResult;

export type AiAgentLogRequest = {
  context: AiAgentContext;
  event: AiAgentEvent;
};

export type AiAgentLogResponse = { ok: true } | ErrorResult;

export type AiAgentOllamaHealthRequest = {
  attempts?: number;
  timeoutMs?: number;
};

export type AiAgentOllamaHealthAttempt = {
  ok: boolean;
  tookMs: number;
  error?: string;
};

export type AiAgentOllamaHealthResponse =
  | { ok: true; attempts: AiAgentOllamaHealthAttempt[]; summary: string }
  | { ok: false; attempts?: AiAgentOllamaHealthAttempt[]; summary?: string; error?: string };
