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
      at: nowMs(),
    },
    args.actorId,
  );
}
