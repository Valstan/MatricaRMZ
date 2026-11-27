// Оркестратор локального звена MiniMax на машине оператора (D-243/D-244).
//
// Цепочка клиента: локальный MiniMax (бесплатный пул «Кармана») → DeepSeek с клиента
// (клиентский ключ, свой баланс) → сервер (MiniMax на проде → платный DeepSeek сервера).
// Серверный конец — последнее страховочное звено, как и решил владелец.
//
// Claim ленивый (D-244): аккаунт пула берётся на ПЕРВЫЙ вопрос, а не заранее —
// несработанные очки сгорают (D-240). «Аккаунты кончились» — честный отказ с
// причиной, а не тишина.
//
// Промт КАРМАНА #176 (27.11.2026) достроил три вещи:
//   * при отказе аккаунта агент берёт СВЕЖИЙ аккаунт у пула и доводит задание сам;
//   * причина пустоты доезжает до оператора РАЗЛИЧИМОЙ (нет свободных / нет готовых
//     / нет пригодных) — но только когда работать нечем;
//   * оператор не видит служебных подробностей: статус несёт МАШИННЫЙ код причины,
//     а слова оператору собирает домен (`shared/src/domain/aiChatSchedule.ts`).
//
// Порядок звеньев и отступление от формулировки D-243 (prod-MiniMax вторым звеном)
// разобраны в PR этой нитки: локальный MiniMax берёт аккаунт из ТОГО ЖЕ бесплатного
// пула, что и прод-MiniMax, поэтому при пустом пуле второе звено всё равно не
// ответило бы; а пока клиент держит claim, серверный воркер такую строку не берёт —
// иначе ответили бы оба.

import type { AiChatLocalCause, AiChatLocalStatus } from '@matricarmz/shared';

import { clearCredential, readCredential, profileDirs, writeCredential, type AgentProfile } from './agentProfile.js';
import { runAgent } from './agentRunner.js';
import { loadLocalMiniMaxConfig, type LocalMiniMaxConfig } from './config.js';
import { callDeepSeek } from './deepseekClient.js';
import { KarmanPoolClient } from './karmanPool.js';
import type { LocalDbBridge } from './dbBridge.js';

/** Звено цепочки, которым посчитан ответ на клиенте. */
export type LocalAnswerSource = 'local_minimax' | 'deepseek_client';

export type LocalAnswerOutcome =
  | { ok: true; source: LocalAnswerSource; answer: string }
  | { ok: false; reason: string; message: string };

export type LocalMiniMaxEngineDeps = {
  config?: LocalMiniMaxConfig;
  pool?: KarmanPoolClient;
  run?: typeof runAgent;
  deepseek?: typeof callDeepSeek;
  bridge?: LocalDbBridge | null;
  now?: () => number;
  /** Идентификатор клиента в аудите «Кармана» — «Карман» клиентов внутри комнаты не различает. */
  area?: string;
};

/** Access протухает ~12 ч; обновляем, когда осталось меньше двух часов. */
const RENEW_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/**
 * Бюджет ожидания оператора.
 *
 * Прогон агента — до 4 минут (`agentRunner.ts`). Два перебора — это до 12 минут
 * ожидания, а вопрос может посчитать сервер. Поэтому свежий аккаунт берём только
 * пока есть время; дальше вопрос отпускается серверу (промт КАРМАНА #176, п. 3).
 */
const LOCAL_ANSWER_BUDGET_MS = 5 * 60 * 1000;

/**
 * Давний отказ протухает.
 *
 * Строка статуса живёт до перезапуска, а «аккаунтов нет» через час — уже неправда.
 * Поэтому отказ старше TTL теряет причину: «считает сервер» остаётся правдой, а
 * выдуманная причина — нет. Заодно оживает локальный claim: после одного отказа
 * клиент не должен молчать до перезапуска.
 */
const FAILURE_TTL_MS = 15 * 60 * 1000;

/**
 * Причины пустоты пула — ровно те коды, что шлёт «Карман».
 *
 * Своя копия словаря расходится молча, и тогда третья причина («все кандидаты
 * отбракованы») не сойдётся никогда, а оператор всё время видит «свободных
 * аккаунтов нет» (ADR-0011). Эталон — серверный словарь причин.
 */
const POOL_EMPTY_CAUSES = new Set<string>(['no_free_accounts', 'no_tokens_ready', 'no_handable_accounts']);

/** Признаки того, что вход протух и запись токен-стора надо переписать. */
const AUTH_FAILURE_MARKERS = [
  'token has expired',
  'expired_token',
  'invalid_grant',
  'authentication error',
  'stored oauth credential record is invalid',
  'credential record is invalid',
  'credentialrecordcorrupt',
];

function isAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_FAILURE_MARKERS.some((marker) => lower.includes(marker));
}

/** Причина пустоты пула → код причины для оператора; иначе null. */
function poolEmptyCause(reason: string | null | undefined): AiChatLocalCause | null {
  if (!reason) return null;
  return POOL_EMPTY_CAUSES.has(reason) ? (reason as AiChatLocalCause) : null;
}

let lastState: { state: AiChatLocalStatus['state']; cause: AiChatLocalCause | null; at: number } = {
  state: 'off',
  cause: null,
  at: 0,
};

/**
 * Запомнить состояние звена.
 *
 * В состоянии — ТОЛЬКО коды: что показывать оператору, решает домен. Подробности
 * (ответ сервера, код, причина отказа) уходят в лог клиента — туда, где их и
 * разбирают, а не в строку статуса перед оператором.
 */
function setState(state: AiChatLocalStatus['state'], cause: AiChatLocalCause | null, at: number): void {
  lastState = { state, cause, at };
}

/** Статус локального звена для строки в панели ИИваныча. */
export function getLocalLinkStatus(deps: LocalMiniMaxEngineDeps = {}): AiChatLocalStatus {
  const config = deps.config ?? loadLocalMiniMaxConfig();
  if (!config.configured) {
    return { state: 'off', cause: 'not_configured', configured: false };
  }
  const now = deps.now?.() ?? Date.now();
  const failure = lastState.state === 'broken' || lastState.state === 'no_accounts';
  if (failure && now - lastState.at > FAILURE_TTL_MS) {
    // Давний отказ: «считает сервер» — правда, «аккаунтов нет» — уже нет.
    return { state: 'off', cause: null, configured: true };
  }
  return { state: lastState.state, cause: lastState.cause, configured: true };
}

function profileOf(config: LocalMiniMaxConfig): AgentProfile {
  return profileDirs(config.profileDir);
}

function poolOf(config: LocalMiniMaxConfig, deps: LocalMiniMaxEngineDeps): KarmanPoolClient {
  if (deps.pool) return deps.pool;
  const runtime = config.runtime!;
  return new KarmanPoolClient({
    baseUrl: runtime.karmanUrl,
    token: runtime.karmanToken,
    project: runtime.project,
    area: deps.area ?? 'matricarmz-client',
  });
}

type CredentialResult =
  | { ok: true; credential: { accessToken: string; expiresAtMs: number; accountId?: number } }
  | { ok: false; reason: string; cause: AiChatLocalCause; message: string };

/**
 * Живой вход в аккаунт. Claim ленивый: если вход ещё живой — новый аккаунт не берём.
 * Иначе берём один аккаунт у «Кармана» и пишем его в профиль.
 */
async function ensureCredential(
  config: LocalMiniMaxConfig,
  deps: LocalMiniMaxEngineDeps,
  now: number,
): Promise<CredentialResult> {
  const profile = profileOf(config);
  const existing = readCredential(profile);
  if (existing && existing.expiresAtMs - now > RENEW_THRESHOLD_MS) {
    return { ok: true, credential: existing };
  }
  const pool = poolOf(config, deps);
  const offer = await pool.available();
  if (!offer.ok) {
    return {
      ok: false,
      reason: offer.reason,
      cause: 'pool_unavailable',
      message: offer.message,
    };
  }
  if (!offer.value.account || !offer.value.accessToken) {
    // Причина пустоты — конкретный случай (нет свободных / нет готовых / нет
    // пригодных), а не «аккаунты кончились на сегодня». Различие доезжает до
    // оператора — но только когда работать нечем.
    const reason = offer.value.reason ?? 'no_free_accounts';
    return {
      ok: false,
      reason,
      cause: poolEmptyCause(reason) ?? 'no_free_accounts',
      message: `пул аккаунтов пуст (${reason})`,
    };
  }
  const credential = {
    accessToken: offer.value.accessToken,
    expiresAtMs: offer.value.expiresAtMs ?? now + 8 * 60 * 60 * 1000,
    accountId: offer.value.account.id,
  };
  writeCredential(profile, credential);
  return { ok: true, credential };
}

/**
 * Посчитать ответ локально. Порядок: локальный MiniMax → DeepSeek с клиента.
 * Любая неудача звена — это честный отказ с причиной, а не тишина.
 */
export async function answerQuestionLocally(
  question: string,
  deps: LocalMiniMaxEngineDeps = {},
): Promise<LocalAnswerOutcome> {
  const config = deps.config ?? loadLocalMiniMaxConfig();
  const now = deps.now?.() ?? Date.now();
  if (!config.configured || !config.runtime) {
    // Что именно не настроено — в лог: это часть машины, не забота оператора.
    console.warn('[local-minimax] модуль не настроен:', config.reason);
    setState('off', 'not_configured', now);
    return { ok: false, reason: 'not_configured', message: config.reason };
  }
  const runtime = config.runtime;
  const profile = profileOf(config);
  const run = deps.run ?? runAgent;
  const deepseek = deps.deepseek ?? callDeepSeek;
  const nowMs = (): number => deps.now?.() ?? Date.now();

  const credential = await ensureCredential(config, deps, now);
  if (!credential.ok) {
    const empty = poolEmptyCause(credential.cause) !== null;
    setState(empty ? 'no_accounts' : 'broken', credential.cause, now);
    // Подробность — в лог клиента: оператору она не поможет, инженеру нужна.
    console.warn('[local-minimax] вход в аккаунт не получен:', credential.reason, credential.message);
    return { ok: false, reason: credential.reason, message: credential.message };
  }

  setState('working', null, now);
  const dbMcp = deps.bridge
    ? {
        name: 'matrica-db',
        command: runtime.nodePath,
        args: [runtime.dbMcpPath],
        env: { MATRICA_DB_PIPE: deps.bridge.pipePath, MATRICA_DB_TOKEN: deps.bridge.token },
      }
    : null;

  const runOnce = () =>
    run({
      mcodePath: runtime.mcodePath,
      nodePath: runtime.nodePath,
      profile,
      workspaceDir: config.workspaceDir,
      question,
      dbMcp,
    });

  let attempt = await runOnce();
  /** Пул оказался пуст уже во время перебора — оператору важна именно эта причина. */
  let emptyCause: AiChatLocalCause | null = null;
  const accountId = credential.credential.accountId;

  if (!attempt.ok && isAuthFailure(attempt.message)) {
    const pool = poolOf(config, deps);
    // 1. Продлеваем СВОЙ аккаунт: это не съедает ёмкость пула.
    if (accountId) {
      const renewed = await pool.renew(accountId);
      if (renewed.ok) {
        const next = {
          accessToken: renewed.value.accessToken,
          expiresAtMs: renewed.value.expiresAtMs ?? now + 8 * 60 * 60 * 1000,
          accountId,
        };
        writeCredential(profile, next);
        attempt = await runOnce();
      } else {
        console.warn('[local-minimax] свой аккаунт продлить не вышло:', renewed.reason, renewed.message);
      }
    }
    // 2. Не помогло — берём СВЕЖИЙ аккаунт у пула и доводим задание (промт #176, п. 3).
    //    Ограничения: не крутимся на том же аккаунте, успеваем в бюджет ожидания.
    if (!attempt.ok && isAuthFailure(attempt.message) && nowMs() - now < LOCAL_ANSWER_BUDGET_MS) {
      const offer = await pool.available();
      if (!offer.ok) {
        console.warn('[local-minimax] свежий аккаунт не взят:', offer.reason, offer.message);
      } else if (!offer.value.account || !offer.value.accessToken) {
        emptyCause = poolEmptyCause(offer.value.reason) ?? 'no_free_accounts';
      } else if (offer.value.account.id === accountId) {
        // Тот же аккаунт выдали снова — крутиться на нём бессмысленно.
        console.warn('[local-minimax] пул вернул тот же аккаунт — дальше не крутимся');
      } else {
        const fresh = {
          accessToken: offer.value.accessToken,
          expiresAtMs: offer.value.expiresAtMs ?? now + 8 * 60 * 60 * 1000,
          accountId: offer.value.account.id,
        };
        writeCredential(profile, fresh);
        attempt = await runOnce();
      }
    }
    // Отказавший вход в профиле не оставляем: следующий вопрос не должен
    // переиспользовать мёртвый токен (иначе клиент до перезапуска молчит).
    if (!attempt.ok && isAuthFailure(attempt.message)) {
      clearCredential(profile);
    }
  }

  if (attempt.ok) {
    setState('ready', null, nowMs());
    return { ok: true, source: 'local_minimax', answer: attempt.answer };
  }

  // Локальный MiniMax не справился — клиент пробует свой DeepSeek.
  if (runtime.deepseekApiKey) {
    const fallback = await deepseek({ apiKey: runtime.deepseekApiKey, question });
    if (fallback.ok) {
      setState('ready', null, nowMs());
      return { ok: true, source: 'deepseek_client', answer: fallback.answer };
    }
    console.warn('[local-minimax] резерв с клиента не ответил:', fallback.reason, fallback.message);
  }

  // Работать нечем: оператору — одно понятное сообщение (слова — в домене), подробность — в лог.
  console.warn('[local-minimax] локальный агент не ответил:', attempt.reason, attempt.message);
  setState(emptyCause ? 'no_accounts' : 'broken', emptyCause ?? 'module_failed', nowMs());
  return { ok: false, reason: attempt.reason, message: attempt.message };
}
