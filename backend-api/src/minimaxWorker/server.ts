// HTTP-слой воркера MiniMax: Anthropic-совместимый `/v1/messages`.
//
// Бэкенд ходит сюда тем же SDK, что и в DeepSeek, — поэтому контракт ИИваныча,
// очередь и существующий воркер не трогаем: меняется только транспорт.
//
// ⚠️ Отказы — честные и разные: «аккаунтов нет» (503, reason `pool_empty`) и
// «сервис сломался» (503, reason `karman_unavailable`) — разные вещи. Бэкенд по
// любому из них уходит на платного страхователя (fail-open, D-243).
//
// ⚠️ **Аккаунт берётся один и переиспользуется** — как в «Сарафане». У Кармана
// выдача = погашение (ручки `release` нет), а аккаунт — «один потребитель на
// сутки»: брать новый на каждый вопрос значило бы сжечь пул за первые же минуты
// (прецедент 15.11: 15 аккаунтов за две минуты). Поэтому держим «аренду»:
// следующий аккаунт берём, когда текущий отказал (очки кончились, вход протух)
// или его access скоро истечёт — тогда продлеваем цепочку (`renew`).

import express from 'express';

import { logError, logInfo, logWarn } from '../utils/logger.js';
import { readVaultSecret } from '../services/karmanVaultClient.js';
import {
  buildAgentSystemPrompt,
  buildAgentUserPayload,
  type AnthropicMessageParam,
  type AnthropicSystemBlock,
  type AnthropicToolDef,
} from './agentPrompt.js';
import { materializeProfile, type MinimaxProfile } from './agentProfile.js';
import {
  KarmanPoolError,
  renewAccount,
  reportActivation,
  takeAccount,
  type KarmanOffer,
  type KarmanPoolClientOptions,
} from './karmanPool.js';
import { PoolBackoff } from './poolBackoff.js';
import { runAgent } from './minimaxAgent.js';
import { shapeAgentAnswer } from './toolUseShaper.js';
import type { MinimaxWorkerConfig } from './config.js';

export type WorkerDeps = {
  takeAccount: (options: KarmanPoolClientOptions & { exclude?: number[] }) => Promise<KarmanOffer>;
  renewAccount: (options: KarmanPoolClientOptions, accountId: number) => Promise<{
    access_token: string;
    expires_at_ms: number;
    renewed: boolean;
  }>;
  reportActivation: (
    options: KarmanPoolClientOptions,
    payload: { account_id?: number | null; email?: string | null },
  ) => Promise<void>;
  materializeProfile: typeof materializeProfile;
  runAgent: typeof runAgent;
  /** Токен пула: из env или из комнаты Кармана (сервисный грант). */
  resolveToken: (config: MinimaxWorkerConfig) => Promise<string>;
};

export type MinimaxLease = {
  accountId: number;
  email: string | null;
  accessToken: string;
  expiresAtMs: number;
  profile: MinimaxProfile;
};

export type WorkerState = {
  /** id аккаунтов, которые не подошли: Карману их передаём `exclude=`, иначе он отдаст тот же. */
  deadAccountIds: number[];
  /** Пул на паузе после отказа — до какого момента (epoch мс). */
  pausedUntilMs: number;
  /** Текущая аренда: один аккаунт на много запросов (выдача = погашение). */
  lease: MinimaxLease | null;
};

const DEFAULT_DEPS: WorkerDeps = {
  takeAccount,
  renewAccount,
  reportActivation,
  materializeProfile,
  runAgent,
  async resolveToken(config: MinimaxWorkerConfig): Promise<string> {
    if (config.karmanToken) return config.karmanToken;
    const fromVault = await readVaultSecret(config.karmanTokenVaultKey).catch(() => null);
    return String(fromVault ?? '').trim();
  },
};

const MAX_DEAD_IDS = 50;
/** За сколько до истечения access продлеваем цепочку: раньше — отказ придёт молча. */
const RENEW_WINDOW_MS = 5 * 60_000;

/**
 * Сколько агентов может работать одновременно.
 *
 * ⚠️ На боксе 1536 МБ, swap запрещён: `mcode exec` — пик ~381 МБ по node-процессам
 * (у «Сарафана» воркер один раз убивался по OOM). Два одновременных прогона — это
 * ~800 МБ поверх postgres и двух инстансов бэкенда ⇒ ядро снимает крупнейший процесс.
 * Поэтому прогон агента — **строго один**, остальные ждут в очереди.
 */
const MAX_CONCURRENT_AGENT_RUNS = 1;

/** Признаки «аккаунт больше не годится»: вход протух или очки кончились. */
const STALE_LEASE_MARKERS = [
  'token expired',
  'token has expired',
  'expired_token',
  'invalid_grant',
  'unauthorized',
  '401',
  'sign in',
  'not logged in',
  'session has expired',
  'session expired',
  'insufficient balance',
  'quota',
  'usage limit',
  'stored oauth credential record is invalid',
  'credential record is invalid',
  'credentialrecordcorrupt',
];

export function isStaleLeaseFailure(detail: string): boolean {
  const text = String(detail ?? '').toLowerCase();
  return STALE_LEASE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Ворота прогона агента: одновременно работает `limit` агентов, остальные ждут.
 *
 * Слот передаётся ожидающему **напрямую** (без гонки за свободный слот) — иначе
 * два запроса, разбуженных одновременно, могли бы взять слот каждый и запустить
 * по два CLI-процесса.
 */
export function createAgentGate(limit: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    get active(): number {
      return active;
    },
    get queued(): number {
      return waiters.length;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < limit) {
        active += 1;
      } else {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      try {
        return await fn();
      } finally {
        const next = waiters.shift();
        if (next) next();
        else active -= 1;
      }
    },
  };
}

/**
 * Код ответа по причине отказа.
 *
 * ⚠️ Все «сейчас нельзя» (пул пуст, Карман недоступен, лимит) — это 503: по
 * правилу fail-open бэкенд уходит на платного страхователя (D-243). 400/401/403
 * откатом **не** считаются: это наша ошибка или нет доступа, и молчаливый откат
 * спрятал бы поломку.
 */
function statusForFailure(error: KarmanPoolError): number {
  switch (error.reason) {
    case 'pool_empty':
    case 'pool_no_tokens':
    case 'pool_no_handable':
    case 'karman_unavailable':
    case 'token_read_only':
    case 'token_unauthorized':
    case 'rate_limited':
      return 503;
    case 'bad_request':
      return 400;
    case 'account_not_found':
    case 'account_not_ours':
      return 409;
    default:
      return 500;
  }
}

function systemBlocksOf(body: Record<string, unknown>): AnthropicSystemBlock[] {
  const raw = body.system;
  if (typeof raw === 'string') return raw.trim() ? [{ type: 'text', text: raw }] : [];
  if (Array.isArray(raw)) {
    return raw
      .map((block) => {
        const item = block as { type?: string; text?: string };
        return item?.type === 'text' && typeof item.text === 'string'
          ? ({ type: 'text', text: item.text } as AnthropicSystemBlock)
          : null;
      })
      .filter((b): b is AnthropicSystemBlock => b !== null);
  }
  return [];
}

export function createWorkerApp(
  config: MinimaxWorkerConfig,
  deps: Partial<WorkerDeps> = {},
): { app: express.Express; state: WorkerState } {
  const resolved: WorkerDeps = { ...DEFAULT_DEPS, ...deps };
  const state: WorkerState = { deadAccountIds: [], pausedUntilMs: 0, lease: null };
  /**
   * Паузы между попытками взять аккаунт.
   *
   * ⚠️ Раньше пауза была одна на все отказы (10 с): пустой пул на сутки и
   * «Карман не ответил» ждали одинаково, а лимит Кармана (60 запросов в минуту
   * на токен и IP) в это укладывается впритык. Теперь пауза зависит от причины
   * и растёт при повторных отказах (см. `poolBackoff.ts`).
   */
  const backoff = new PoolBackoff();
  const gate = createAgentGate(MAX_CONCURRENT_AGENT_RUNS);
  const app = express();

  app.use(express.json({ limit: '8mb' }));

  // Локальный эндпойнт воркера: доступ с хоста — по токену. Наружу не выставляем.
  //
  // ⚠️ Anthropic SDK шлёт ключ как `X-Api-Key` (при `apiKey`), а не `Authorization: Bearer`
  // (тот идёт от `authToken`). Поэтому принимаем оба заголовка: иначе бэкенд, ходящий
  // тем же SDK, получил бы 401 — и не смог бы уйти на платного страхователя.
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const bearer = String(req.headers.authorization ?? '');
    const bearerToken = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : '';
    const apiKey = String(req.headers['x-api-key'] ?? '').trim();
    const token = bearerToken || apiKey;
    if (!token || token !== config.serviceToken) {
      res.status(401).json({ error: 'Требуется токен воркера (X-Api-Key или Authorization: Bearer)' });
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    const snapshot = backoff.snapshot();
    res.json({
      ok: true,
      service: 'minimax-worker',
      pool: config.karmanApiBase ? 'configured' : 'not_configured',
      cli: config.cli,
      model: config.model,
      paused: backoff.isPaused(),
      /** До какого момента пул не опрашиваем — видно, когда ждать снова. */
      pausedUntilMs: snapshot.pausedUntilMs || null,
      /** Причина последнего отказа: пул пуст / Карман недоступен / лимит. */
      lastFailure: snapshot.lastReason,
      account: state.lease?.accountId ?? null,
      agentsActive: gate.active,
      agentsQueued: gate.queued,
    });
  });

  /** Продлить цепочку входа того же аккаунта и переписать токен в профиль. */
  async function renewLease(
    lease: MinimaxLease,
    poolOptions: KarmanPoolClientOptions,
  ): Promise<MinimaxLease> {
    const renewed = await resolved.renewAccount(poolOptions, lease.accountId);
    const profile = await resolved.materializeProfile({
      accountsDir: config.accountsDir,
      area: config.area,
      accessToken: renewed.access_token,
      expiresAtMs: renewed.expires_at_ms,
      accountId: lease.accountId,
      email: lease.email,
    });
    const next: MinimaxLease = {
      ...lease,
      accessToken: renewed.access_token,
      expiresAtMs: renewed.expires_at_ms,
      profile,
    };
    state.lease = next;
    logInfo('minimax worker: цепочка входа продлена', { account: lease.accountId });
    return next;
  }

  /**
   * Аккаунт для работы: текущая аренда (продлённая, если подходит) или новый из пула.
   *
   * `fresh` —true, когда аккаунт только что взят: тогда его активацию надо отметить
   * в журнале Кармана (наблюдение: сколько очков было на выданном токене).
   */
  async function acquireLease(
    poolOptions: KarmanPoolClientOptions,
  ): Promise<{ lease: MinimaxLease; fresh: boolean }> {
    const current = state.lease;
    if (current) {
      if (current.expiresAtMs - Date.now() > RENEW_WINDOW_MS) return { lease: current, fresh: false };
      try {
        return { lease: await renewLease(current, poolOptions), fresh: false };
      } catch (e) {
        state.lease = null;
        logWarn('minimax worker: продлить вход не вышло — беру следующий аккаунт', {
          account: current.accountId,
          error: String(e),
        });
      }
    }

    const offer = await resolved.takeAccount({ ...poolOptions, exclude: state.deadAccountIds });
    const account = offer.account!;
    const accessToken = String(offer.access_token ?? '');
    if (!accessToken) {
      throw new KarmanPoolError('pool_empty', 200, 'Карман не отдал вход в аккаунт');
    }
    const profile = await resolved.materializeProfile({
      accountsDir: config.accountsDir,
      area: config.area,
      accessToken,
      expiresAtMs: offer.expires_at_ms ?? null,
      accountId: account.id,
      email: account.email ?? null,
    });
    let lease: MinimaxLease = {
      accountId: account.id,
      email: account.email ?? null,
      accessToken,
      expiresAtMs: Number(offer.expires_at_ms ?? 0),
      profile,
    };
    state.lease = lease;

    await resolved
      .reportActivation(poolOptions, {
        account_id: account.id,
        email: account.email ?? null,
      })
      .catch((e) => logWarn('minimax worker: активация не отмечена', { error: String(e) }));

    // Выданный access живёт ~12 ч, но если Карман отдал уже под исход — продлеваем
    // сразу: иначе отказ придёт молча, на середине вопроса.
    if (lease.expiresAtMs - Date.now() <= RENEW_WINDOW_MS) {
      try {
        lease = await renewLease(lease, poolOptions);
      } catch (e) {
        logWarn('minimax worker: свежий вход уже под исход, продлить не вышло', {
          account: lease.accountId,
          error: String(e),
        });
      }
    }

    return { lease, fresh: true };
  }

  app.post('/v1/messages', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messages = (body.messages ?? []) as AnthropicMessageParam[];
    const tools = (body.tools ?? []) as AnthropicToolDef[];
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Нет messages в запросе' });
      return;
    }

    if (backoff.isPaused()) {
      res.status(503).json({
        error: 'Пул Кармана на паузе после отказа',
        reason: 'pool_paused',
        retryAfterMs: backoff.remainingMs(),
      });
      return;
    }

    const token = await resolved.resolveToken(config);
    if (!token) {
      res.status(503).json({
        error: 'Нет токена пула Кармана: положите его в комнату под ключом ' + config.karmanTokenVaultKey,
        reason: 'token_missing',
      });
      return;
    }
    if (!config.karmanApiBase) {
      res.status(503).json({ error: 'Не задан адрес ручек пула Кармана', reason: 'pool_not_configured' });
      return;
    }

    const poolOptions: KarmanPoolClientOptions = {
      base: config.karmanApiBase,
      token,
      project: config.project,
      area: config.area,
    };

    const system = buildAgentSystemPrompt({ systemBlocks: systemBlocksOf(body), tools });
    const user = buildAgentUserPayload({ messages });

    const runAgentFor = (profile: MinimaxProfile) =>
      gate.run(() =>
        resolved.runAgent(
          { system, user, task: 'Ответь сотруднику по заданию выше.' },
          {
            cli: config.cli,
            model: config.model,
            maxSteps: config.maxSteps,
            mode: config.cliMode,
            timeoutSec: config.timeoutSec,
            configDir: profile.configDir,
            dataDir: profile.dataDir,
            maxOldSpaceMb: config.maxOldSpaceMb,
          },
        ),
      );

    let lease: MinimaxLease;
    try {
      lease = (await acquireLease(poolOptions)).lease;
    } catch (e) {
      const failure =
        e instanceof KarmanPoolError ? e : new KarmanPoolError('karman_unavailable', 0, String(e));
      const delayMs = backoff.noteFailure(failure.reason);
      state.pausedUntilMs = Date.now() + delayMs;
      logWarn('minimax worker: пул Кармана не ответил', {
        reason: failure.reason,
        detail: failure.detail,
        retryInMs: delayMs,
      });
      res.status(statusForFailure(failure)).json({
        error: failure.detail,
        reason: failure.reason,
        retryAfterMs: delayMs,
      });
      return;
    }

    let run = await runAgentFor(lease.profile);

    // Аккаунт отказал (очки кончились / вход протух) — выбрасываем его и берём
    // следующий, один повтор. Иначе вопрос уйдёт в платного страхователя зря.
    if (!run.ok && isStaleLeaseFailure(run.detail)) {
      state.lease = null;
      if (lease.accountId) {
        state.deadAccountIds = [...state.deadAccountIds, lease.accountId].slice(-MAX_DEAD_IDS);
      }
      logWarn('minimax worker: аккаунт не годится — беру следующий', {
        account: lease.accountId,
        reason: run.reason,
      });
      try {
        lease = (await acquireLease(poolOptions)).lease;
        run = await runAgentFor(lease.profile);
      } catch (e) {
        const failure =
          e instanceof KarmanPoolError ? e : new KarmanPoolError('karman_unavailable', 0, String(e));
        const delayMs = backoff.noteFailure(failure.reason);
        state.pausedUntilMs = Date.now() + delayMs;
        logWarn('minimax worker: пул Кармана не ответил', {
          reason: failure.reason,
          detail: failure.detail,
          retryInMs: delayMs,
        });
        res.status(statusForFailure(failure)).json({
          error: failure.detail,
          reason: failure.reason,
          retryAfterMs: delayMs,
        });
        return;
      }
    }

    if (!run.ok) {
      logError('minimax worker: агент не ответил', { reason: run.reason, detail: run.detail, account: lease.accountId });
      res.status(502).json({ error: run.detail, reason: run.reason });
      return;
    }

    // Пул снова в работе — счётчики неудач обнуляются, иначе пауза росла бы
    // на ровном месте после одного успеха.
    backoff.noteSuccess();
    state.pausedUntilMs = 0;

    const shaped = shapeAgentAnswer(run.text, tools.map((t) => ({ name: t.name })));
    if (shaped.warnings.length) {
      logWarn('minimax worker: ответ агента разобран с замечаниями', {
        warnings: shaped.warnings.join('; '),
        account: lease.accountId,
      });
    }

    logInfo(
      'minimax worker: ответ готов',
      {
        account: lease.accountId,
        blocks: shaped.blocks.length,
        stopReason: shaped.stopReason,
        durationMs: run.payload?.durationMs ?? null,
      },
      { critical: true },
    );

    res.json({
      id: `msg_${Date.now().toString(16)}`,
      type: 'message',
      role: 'assistant',
      model: String(body.model ?? config.model),
      content: shaped.blocks,
      stop_reason: shaped.stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: Number(run.payload?.usage?.inputTokens ?? 0),
        output_tokens: Number(run.payload?.usage?.outputTokens ?? 0),
      },
    });
  });

  return { app, state };
}
