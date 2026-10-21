import {
  EMPTY_AI_ENGINE_BREAKER,
  isLocalEngineBreakerOpen,
  localEngineBreakerRetryInMs,
  recordLocalEngineFailure,
  recordLocalEngineSuccess,
  resolveAiEngineMode,
  shouldTryLocalEngine,
  type AiAnswerSource,
  type AiEngineBreaker,
  type AiEngineMode,
} from '@matricarmz/shared';

import { askLocalEngine } from './localEngineSession.js';
import {
  activeEngineDir,
  applyEngineManifest,
  ensureLocalEngine,
  fetchEngineManifest,
  getLocalEngineStatus,
  updateLocalEngineStatus,
} from './localAiEngine.js';
import { SettingsKey, settingsGetString } from './settingsStore.js';

/**
 * «Авто»-цепочка Ииваныча: сначала этот компьютер, при неудаче — сервер.
 *
 * Breaker держим в памяти: после серии неудач локальный движок не трогаем
 * (иначе каждый вопрос ждёт таймаут — это хуже, чем ответ с сервера).
 * Источник ответа запоминаем по id строки, чтобы оператор видел, к кому ушёл
 * вопрос: «считал сервер» — это честно, а не «что-то сломалось».
 */

let breaker: AiEngineBreaker = { ...EMPTY_AI_ENGINE_BREAKER };
const answerSources = new Map<string, AiAnswerSource>();

export type LocalAttempt = {
  ok: boolean;
  text?: string;
  error?: string;
  /** Движок был пропущен (breaker открыт) — серверу придётся отвечать. */
  skipped?: boolean;
};

export function getEngineBreaker(): AiEngineBreaker {
  return { ...breaker };
}

/** Локальный движок сейчас не трогаем — сколько осталось ждать (мс). */
export function localEnginePausedForMs(nowMs: number = Date.now()): number {
  return localEngineBreakerRetryInMs(breaker, nowMs);
}

export function resetEngineBreaker(): void {
  breaker = { ...EMPTY_AI_ENGINE_BREAKER };
}

export function markAnswerSource(id: string, source: AiAnswerSource): void {
  if (!id) return;
  answerSources.set(id, source);
  // Реестр не должен расти вечно: держим последние 200 строк.
  if (answerSources.size > 200) {
    const oldest = answerSources.keys().next().value;
    if (oldest) answerSources.delete(oldest);
  }
}

export function getAnswerSource(id: string): AiAnswerSource | null {
  return answerSources.get(id) ?? null;
}

/**
 * Попытка посчитать ответ локально — с учётом breaker.
 * `mode` приходит из настройки: в «Только сервер» локальный не трогаем вовсе.
 */
export async function askLocalWithBreaker(mode: AiEngineMode, question: string): Promise<LocalAttempt> {
  const now = Date.now();
  if (!shouldTryLocalEngine(mode, breaker, now)) {
    return {
      ok: false,
      skipped: true,
      error: isLocalEngineBreakerOpen(breaker, now)
        ? `локальный движок на паузе ещё ${Math.ceil(localEngineBreakerRetryInMs(breaker, now) / 60000)} мин`
        : 'локальный движок не используется в этом режиме',
    };
  }
  // В «Авто» не ждём готовности движка: он может качаться минутами, а оператор
  // ждёт ответа. Пока движок не поднят — отвечает сервер. В строгом «Только этот
  // ПК» ждём: оператор сам выбрал этот компьютер.
  const status = getLocalEngineStatus();
  if (status.state !== 'running' && mode !== 'local') {
    if (status.state === 'error') breaker = recordLocalEngineFailure(breaker, now);
    return { ok: false, skipped: true, error: status.error ?? 'движок ещё не готов' };
  }
  const res = await askLocalEngine(question);
  if (res.ok) {
    breaker = recordLocalEngineSuccess();
    return { ok: true, text: res.text };
  }
  breaker = recordLocalEngineFailure(breaker, now);
  return { ok: false, error: res.error };
}

/**
 * Тихая подготовка движка после старта клиента: окно уже показано, оператор
 * не ждёт. В режиме «Только сервер» ничего не делаем.
 */
export async function prepareLocalEngineInBackground(
  db: Parameters<typeof settingsGetString>[0],
  apiBaseUrl: string,
): Promise<void> {
  const raw = await settingsGetString(db, SettingsKey.AiEngineMode).catch(() => null);
  const mode = resolveAiEngineMode(raw);
  if (mode === 'prod') return;
  await ensureLocalEngine({ apiBaseUrl });
}

/** Проверка рекомендованной версии — раз в сутки, в простое. */
export async function runEngineMaintenance(apiBaseUrl: string, nowMs: number = Date.now()): Promise<void> {
  const status = getLocalEngineStatus();
  const last = status.checkedAt ?? 0;
  if (nowMs - last < 24 * 60 * 60 * 1000) return;
  const manifest = await fetchEngineManifest(apiBaseUrl).catch(() => null);
  if (!manifest) return;
  updateLocalEngineStatus({ recommended: manifest.version, checkedAt: nowMs });
  const active = await activeEngineDir();
  if (active?.version === manifest.version) return;
  await applyEngineManifest(manifest);
}

let maintenanceTimer: NodeJS.Timeout | null = null;

/** Планировщик проверки манифеста: раз в час смотрим, не пора ли (проверка — раз в сутки). */
export function scheduleEngineMaintenance(getApiBaseUrl: () => string): void {
  if (maintenanceTimer) return;
  const tick = () => {
    void runEngineMaintenance(getApiBaseUrl()).catch(() => undefined);
  };
  maintenanceTimer = setInterval(tick, 60 * 60 * 1000);
  maintenanceTimer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}
