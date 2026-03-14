type BotPollErrorKind = 'conflict' | 'transient' | 'misconfigured' | 'other';

type BotPollMetricsState = {
  startedAt: number;
  totalAttempts: number;
  totalFailures: number;
  transientFailures: number;
  conflictFailures: number;
  misconfiguredFailures: number;
  otherFailures: number;
  currentFailureStreak: number;
  maxFailureStreak: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string;
};

const state: BotPollMetricsState = {
  startedAt: Date.now(),
  totalAttempts: 0,
  totalFailures: 0,
  transientFailures: 0,
  conflictFailures: 0,
  misconfiguredFailures: 0,
  otherFailures: 0,
  currentFailureStreak: 0,
  maxFailureStreak: 0,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: '',
};

function resetState() {
  state.startedAt = Date.now();
  state.totalAttempts = 0;
  state.totalFailures = 0;
  state.transientFailures = 0;
  state.conflictFailures = 0;
  state.misconfiguredFailures = 0;
  state.otherFailures = 0;
  state.currentFailureStreak = 0;
  state.maxFailureStreak = 0;
  state.lastSuccessAt = null;
  state.lastErrorAt = null;
  state.lastError = '';
}

export function classifySyncPipelineBotPollError(rawError: string): BotPollErrorKind {
  const raw = String(rawError ?? '').trim().toLowerCase();
  if (!raw) return 'other';

  if (
    (raw.includes('telegram http 409') && raw.includes('getupdates')) ||
    raw.includes('terminated by other getupdates request') ||
    (raw.includes('error_code') && raw.includes('409') && raw.includes('getupdates'))
  ) {
    return 'conflict';
  }

  if (
    raw.includes('telegram http 401') ||
    raw.includes('telegram http 403') ||
    raw.includes('unauthorized') ||
    raw.includes('forbidden') ||
    raw.includes('bot was blocked') ||
    raw.includes('bot is blocked') ||
    raw.includes('invalid token') ||
    raw.includes('token is invalid')
  ) {
    return 'misconfigured';
  }

  if (
    raw.includes('fetch failed') ||
    raw.includes('etimedout') ||
    raw.includes('econnreset') ||
    raw.includes('eai_again') ||
    raw.includes('socket hang up') ||
    raw.includes('timeout') ||
    raw.includes('http 429') ||
    raw.includes('http 500') ||
    raw.includes('http 502') ||
    raw.includes('http 503') ||
    raw.includes('http 504')
  ) {
    return 'transient';
  }

  return 'other';
}

export function markSyncPipelineBotPollAttempt() {
  state.totalAttempts += 1;
}

export function markSyncPipelineBotPollFailure(error: string) {
  const kind = classifySyncPipelineBotPollError(error);
  state.totalFailures += 1;
  state.currentFailureStreak += 1;
  state.lastError = String(error ?? '');
  state.lastErrorAt = Date.now();
  if (state.currentFailureStreak > state.maxFailureStreak) {
    state.maxFailureStreak = state.currentFailureStreak;
  }
  if (kind === 'transient') state.transientFailures += 1;
  else if (kind === 'conflict') state.conflictFailures += 1;
  else if (kind === 'misconfigured') state.misconfiguredFailures += 1;
  else state.otherFailures += 1;
  return kind;
}

export function markSyncPipelineBotPollSuccess() {
  state.currentFailureStreak = 0;
  state.lastSuccessAt = Date.now();
}

export function getSyncPipelineBotPollMetrics() {
  return {
    startedAt: state.startedAt,
    totalAttempts: state.totalAttempts,
    totalFailures: state.totalFailures,
    transientFailures: state.transientFailures,
    conflictFailures: state.conflictFailures,
    misconfiguredFailures: state.misconfiguredFailures,
    otherFailures: state.otherFailures,
    currentFailureStreak: state.currentFailureStreak,
    maxFailureStreak: state.maxFailureStreak,
    lastSuccessAt: state.lastSuccessAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
  };
}

export function resetSyncPipelineBotPollMetricsForTests() {
  resetState();
}

