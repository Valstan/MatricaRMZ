import { logSnapshot, nowMs } from './common.js';

export type AssistStageTimings = {
  totalMs: number;
  routeMs?: number;
  ragMs?: number;
  llmMs?: number;
  sqlPlanMs?: number;
  sqlExecMs?: number;
};

export async function recordAssistMetrics(args: {
  actorId: string;
  mode: 'chat' | 'analytics';
  model: string;
  ok: boolean;
  timeout: boolean;
  context: any;
  timings: AssistStageTimings;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: string[];
  escalated?: boolean;
}) {
  await logSnapshot(
    'ai_agent_metrics',
    {
      actorId: args.actorId,
      mode: args.mode,
      model: args.model,
      ok: args.ok,
      timeout: args.timeout,
      tab: String(args.context?.tab ?? ''),
      entityType: String(args.context?.entityType ?? ''),
      timings: args.timings,
      ...(typeof args.inputTokens === 'number' ? { inputTokens: args.inputTokens } : {}),
      ...(typeof args.outputTokens === 'number' ? { outputTokens: args.outputTokens } : {}),
      ...(args.toolCalls && args.toolCalls.length > 0 ? { toolCalls: args.toolCalls } : {}),
      ...(args.escalated ? { escalated: true } : {}),
      at: nowMs(),
    },
    args.actorId,
  );
}
