export type ContractProgressVisual = {
  execPct: number;
  timePct: number | null;
  lag: number | null;
  barColor: string;
  isOverdue: boolean;
};

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return value;
}

export function getContractProgressVisual(args: {
  progressPct: number | null;
  dateMs: number | null;
  dueDateMs: number | null;
  isFullyExecuted: boolean;
  isOverdue?: boolean;
  nowMs?: number;
}): ContractProgressVisual {
  const nowMs = Number.isFinite(args.nowMs) ? Number(args.nowMs) : Date.now();
  const execPct = clampPercent(args.progressPct ?? 0);
  const isOverdue =
    args.isOverdue != null
      ? Boolean(args.isOverdue)
      : !args.isFullyExecuted && args.dueDateMs != null && Number(args.dueDateMs) < nowMs;

  if (isOverdue && !args.isFullyExecuted) {
    return { execPct, timePct: null, lag: null, barColor: '#ef4444', isOverdue: true };
  }

  if (args.isFullyExecuted) {
    return { execPct, timePct: 100, lag: 0, barColor: '#3b82f6', isOverdue: false };
  }

  if (
    args.progressPct == null ||
    args.dateMs == null ||
    args.dueDateMs == null ||
    Number(args.dueDateMs) <= Number(args.dateMs)
  ) {
    return { execPct, timePct: null, lag: null, barColor: '#94a3b8', isOverdue: false };
  }

  const timePct = clampPercent(((nowMs - Number(args.dateMs)) / (Number(args.dueDateMs) - Number(args.dateMs))) * 100);
  const lag = timePct - execPct;

  let barColor = '#3b82f6';
  if (lag >= 50) barColor = '#ef4444';
  else if (lag >= 30) barColor = '#f97316';
  else if (lag >= 20) barColor = '#facc15';
  else if (lag >= 10) barColor = '#a3e635';
  else if (lag > 0) barColor = '#60a5fa';

  return { execPct, timePct, lag, barColor, isOverdue: false };
}
