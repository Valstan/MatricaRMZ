// HTTP-слой воркера MiniMax: Anthropic-совместимый `/v1/messages`.
//
// Бэкенд ходит сюда тем же SDK, что и в DeepSeek, — поэтому контракт ИИваныча,
// очередь и существующий воркер не трогаем: меняется только транспорт.
//
// ⚠️ Отказы — честные и разные: «аккаунтов нет» (503, reason `pool_empty`) и
// «сервис сломался» (503, reason `karman_unavailable`) — разные вещи. Бэкенд по
// любому из них уходит на платного страхователя (fail-open, D-243).

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
    payload: { account_id?: number | null; email?: string | null; points?: number | null; activation_index?: number | null },
  ) => Promise<void>;
  materializeProfile: typeof materializeProfile;
  runAgent: typeof runAgent;
  /** Токен пула: из env или из комнаты Кармана (сервисный грант). */
  resolveToken: (config: MinimaxWorkerConfig) => Promise<string>;
};

export type WorkerState = {
  /** id аккаунтов, которые не подошли: Карману их передаём `exclude=`, иначе он отдаст тот же. */
  deadAccountIds: number[];
  /** Пауза после отказа Кармана/пустого пула: волна не должна молотить ручку и ловить 429. */
  pausedUntilMs: number;
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

const PAUSE_AFTER_FAILURE_MS = 10_000;
const MAX_DEAD_IDS = 50;

function statusForFailure(error: KarmanPoolError): number {
  switch (error.reason) {
    case 'pool_empty':
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
  const state: WorkerState = { deadAccountIds: [], pausedUntilMs: 0 };
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
    res.json({
      ok: true,
      service: 'minimax-worker',
      pool: config.karmanApiBase ? 'configured' : 'not_configured',
      cli: config.cli,
      model: config.model,
      paused: Date.now() < state.pausedUntilMs,
    });
  });

  app.post('/v1/messages', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messages = (body.messages ?? []) as AnthropicMessageParam[];
    const tools = (body.tools ?? []) as AnthropicToolDef[];
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Нет messages в запросе' });
      return;
    }

    if (Date.now() < state.pausedUntilMs) {
      res.status(503).json({ error: 'Пул Кармана на паузе после отказа', reason: 'pool_paused' });
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

    let offer: KarmanOffer;
    try {
      offer = await resolved.takeAccount({ ...poolOptions, exclude: state.deadAccountIds });
    } catch (e) {
      const reason = e instanceof KarmanPoolError ? e.reason : 'karman_unavailable';
      const detail = e instanceof KarmanPoolError ? e.detail : String(e);
      state.pausedUntilMs = Date.now() + PAUSE_AFTER_FAILURE_MS;
      logWarn('minimax worker: пул Кармана не ответил', { reason, detail });
      res.status(statusForFailure(e instanceof KarmanPoolError ? e : new KarmanPoolError('karman_unavailable', 0, String(e)))).json({
        error: detail,
        reason,
      });
      return;
    }

    const account = offer.account!;
    const accessToken = String(offer.access_token ?? '');
    if (!accessToken) {
      state.pausedUntilMs = Date.now() + PAUSE_AFTER_FAILURE_MS;
      res.status(503).json({ error: 'Карман не отдал вход в аккаунт', reason: 'no_access_token' });
      return;
    }

    let profile: MinimaxProfile;
    try {
      profile = await resolved.materializeProfile({
        accountsDir: config.accountsDir,
        area: config.area,
        accessToken,
        expiresAtMs: offer.expires_at_ms ?? null,
        accountId: account.id,
        email: account.email ?? null,
      });
    } catch (e) {
      logError('minimax worker: профиль не собран', { error: String(e) });
      res.status(500).json({ error: `Профиль не собран: ${String(e)}` });
      return;
    }

    const system = buildAgentSystemPrompt({ systemBlocks: systemBlocksOf(body), tools });
    const user = buildAgentUserPayload({ messages });

    const run = await resolved.runAgent(
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
    );

    if (!run.ok) {
      // Аккаунт без очков или с протухшим входом — в список исключённых: Карману его
      // больше не предлагаем (иначе он отдаст тот же id снова).
      if (account.id) {
        state.deadAccountIds = [...state.deadAccountIds, account.id].slice(-MAX_DEAD_IDS);
      }
      logError('minimax worker: агент не ответил', { reason: run.reason, detail: run.detail, account: account.id });
      res.status(502).json({ error: run.detail, reason: run.reason });
      return;
    }

    const shaped = shapeAgentAnswer(run.text, tools.map((t) => ({ name: t.name })));
    if (shaped.warnings.length) {
      logWarn('minimax worker: ответ агента разобран с замечаниями', {
        warnings: shaped.warnings.join('; '),
        account: account.id,
      });
    }

    // Активация — только наблюдение: сколько очков было на выданном токене.
    await resolved
      .reportActivation(poolOptions, {
        account_id: account.id,
        email: account.email ?? null,
        points: account.points_next ?? null,
        activation_index: account.activation_index ?? null,
      })
      .catch((e) => logWarn('minimax worker: активация не отмечена', { error: String(e) }));

    logInfo(
      'minimax worker: ответ готов',
      {
        account: account.id,
        blocks: shaped.blocks.length,
        stopReason: shaped.stopReason,
        steps: run.payload?.durationMs ?? null,
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
