export function computeNextSyncDelayMs(args: {
  baseIntervalMs: number;
  resultOk: boolean;
  pulled: number;
  pushed: number;
  offline: boolean;
  consecutiveErrors: number;
  random?: () => number;
}): { nextDelayMs: number; nextConsecutiveErrors: number } {
  let nextDelayMs = args.baseIntervalMs;
  let nextConsecutiveErrors = args.consecutiveErrors;

  if (args.offline) {
    nextConsecutiveErrors = 0;
    nextDelayMs = Math.min(args.baseIntervalMs, 60_000);
  } else if (!args.resultOk) {
    nextConsecutiveErrors += 1;
    const backoff = Math.min(10 * 60_000, 30_000 * 2 ** Math.min(4, nextConsecutiveErrors - 1));
    nextDelayMs = Math.max(30_000, backoff);
  } else {
    nextConsecutiveErrors = 0;
    const activity = Number(args.pulled ?? 0) + Number(args.pushed ?? 0);
    nextDelayMs = activity > 0 ? Math.min(45_000, Math.max(15_000, Math.floor(args.baseIntervalMs / 3))) : args.baseIntervalMs;
  }

  const randomFn = args.random ?? Math.random;
  const jitter = Math.floor(nextDelayMs * 0.15 * randomFn());
  nextDelayMs = Math.max(10_000, nextDelayMs + jitter);

  return { nextDelayMs, nextConsecutiveErrors };
}

