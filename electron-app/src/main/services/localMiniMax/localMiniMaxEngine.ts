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
// Порядок звеньев и отступление от формулировки D-243 (prod-MiniMax вторым звеном)
// разобраны в PR этой нитки: локальный MiniMax берёт аккаунт из ТОГО ЖЕ бесплатного
// пула, что и прод-MiniMax, поэтому при пустом пуле второе звено всё равно не
// ответило бы; а пока клиент держит claim, серверный воркер такую строку не берёт —
// иначе ответили бы оба.

import type { AiChatLocalStatus } from '@matricarmz/shared';

import { readCredential, profileDirs, writeCredential, type AgentProfile } from './agentProfile.js';
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

let lastState: { state: AiChatLocalStatus['state']; detail: string } = { state: 'off', detail: 'локальный модуль не запускался' };

function setState(state: AiChatLocalStatus['state'], detail: string): void {
  lastState = { state, detail };
}

/** Статус локального звена для строки в панели ИИваныча. */
export function getLocalLinkStatus(deps: LocalMiniMaxEngineDeps = {}): AiChatLocalStatus {
  const config = deps.config ?? loadLocalMiniMaxConfig();
  if (!config.configured) {
    return { state: 'off', detail: config.reason, configured: false };
  }
  return { state: lastState.state, detail: lastState.detail, configured: true };
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
  | { ok: false; reason: string; message: string };

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
    return { ok: false, reason: offer.reason, message: offer.message };
  }
  if (!offer.value.account || !offer.value.accessToken) {
    return { ok: false, reason: 'no_free_accounts', message: 'аккаунты MiniMax кончились на сегодня' };
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
  if (!config.configured || !config.runtime) {
    setState('off', config.reason);
    return { ok: false, reason: 'not_configured', message: config.reason };
  }
  const runtime = config.runtime;
  const now = deps.now?.() ?? Date.now();
  const profile = profileOf(config);
  const run = deps.run ?? runAgent;
  const deepseek = deps.deepseek ?? callDeepSeek;

  const credential = await ensureCredential(config, deps, now);
  if (!credential.ok) {
    setState(credential.reason === 'no_free_accounts' ? 'no_accounts' : 'broken', credential.message);
    return { ok: false, reason: credential.reason, message: credential.message };
  }

  setState('working', 'локальный агент считает ответ');
  const dbMcp = deps.bridge
    ? {
        name: 'matrica-db',
        command: runtime.nodePath,
        args: [runtime.dbMcpPath],
        env: { MATRICA_DB_PIPE: deps.bridge.pipePath, MATRICA_DB_TOKEN: deps.bridge.token },
      }
    : null;

  let attempt = await run({
    mcodePath: runtime.mcodePath,
    nodePath: runtime.nodePath,
    profile,
    workspaceDir: config.workspaceDir,
    question,
    dbMcp,
  });

  // Вход протух, а счёт пошёл: продлеваем цепочку своего аккаунта и пробуем ещё раз.
  if (!attempt.ok && isAuthFailure(attempt.message) && credential.credential.accountId) {
    const pool = poolOf(config, deps);
    const renewed = await pool.renew(credential.credential.accountId);
    if (renewed.ok) {
      const next = {
        accessToken: renewed.value.accessToken,
        expiresAtMs: renewed.value.expiresAtMs ?? now + 8 * 60 * 60 * 1000,
        accountId: credential.credential.accountId,
      };
      writeCredential(profile, next);
      attempt = await run({
        mcodePath: runtime.mcodePath,
        nodePath: runtime.nodePath,
        profile,
        workspaceDir: config.workspaceDir,
        question,
        dbMcp,
      });
    }
  }

  if (attempt.ok) {
    setState('ready', 'локальный модуль готов');
    return { ok: true, source: 'local_minimax', answer: attempt.answer };
  }

  // Локальный MiniMax не справился — клиент пробует свой DeepSeek.
  if (runtime.deepseekApiKey) {
    const fallback = await deepseek({ apiKey: runtime.deepseekApiKey, question });
    if (fallback.ok) {
      setState('ready', 'локальный модуль готов');
      return { ok: true, source: 'deepseek_client', answer: fallback.answer };
    }
    setState('broken', `локальный MiniMax не ответил (${attempt.reason}), резерв с клиента тоже: ${fallback.message}`);
    return { ok: false, reason: attempt.reason, message: attempt.message };
  }

  setState('broken', `локальный MiniMax не ответил: ${attempt.message}`);
  return { ok: false, reason: attempt.reason, message: attempt.message };
}
