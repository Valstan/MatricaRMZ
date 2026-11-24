// Заглушка API «Кармана» — локальный стенд воркера MiniMax.
//
// Зачем: контур воркера надо гонять целиком и без настоящих токенов (прод не
// трогаем, очки пула жалко). Заглушка повторяет контракт трёх ручек Кармана:
// `GET /accounts/available` (выдача), `POST /renew` (продление цепочки входа)
// и `POST /activations` (наблюдение: сколько очков было на выданном токене).
//
// ⚠️ Честная пустота — это HTTP 200 с `account: null` и причиной, а не ошибка:
// у Кармана «сейчас нельзя» — это 200. Причины разные (`no_free_accounts`,
// `no_tokens_ready`, `no_handable_accounts`), и воркер обязан их различать —
// иначе «кончились аккаунты» и «нет пары токенов» слипнутся в одно «пусто»
// (ADR-0017 «Сарафана», brain G619).
//
// ⚠️ Секретов здесь нет и быть не должно: токен пула — константа `skm_stub`,
// заглушка слушает только 127.0.0.1 и никуда сама не ходит.

import type { Server } from 'node:http';

import express from 'express';

import { moscowDate } from '../agentProfile.js';
import type { KarmanEmptyReason } from '../karmanPool.js';

/** Токен пула на стенде: настоящий токен в коде лежать не должен. */
export const STUB_POOL_TOKEN = 'skm_stub';

export type StubAccount = {
  id: number;
  email: string;
  /** Через сколько мс «протухнет» выданный вход (окно продления у воркера — 5 минут). */
  expiresInMs?: number;
  /** Очки на аккаунте — из них Карман считает наблюдение `activations`. */
  pointsNext?: number;
};

export type KarmanStubOptions = {
  /** Токен, который заглушка считает своим. */
  token?: string;
  /** Причина честной пустоты: если задана — пул всегда пуст с этой причиной. */
  emptyReason?: KarmanEmptyReason | null;
  /** Аккаунты на выдачу — по очереди (выдача = погашение, ручки `release` нет). */
  accounts?: StubAccount[];
  /** Сколько следующих выдач уронить (503 «Карман не ответил»). */
  failNext?: number;
  /** Срок жизни выданного входа по умолчанию, мс. */
  defaultTtlMs?: number;
};

/** Счётчики ручек: по ним сценарий видит, что воркер дёргал то, что надо. */
export type PoolCallCounts = {
  available: number;
  renew: number;
  activations: number;
};

export type KarmanStub = {
  app: express.Express;
  /** Поднять заглушку на свободном порту (127.0.0.1) и вернуть базовый адрес. */
  start(): Promise<string>;
  /** Остановить заглушку. */
  stop(): Promise<void>;
  calls: PoolCallCounts;
  /** Аккаунты, выданные по очереди. */
  issuedAccountIds: number[];
  /** Аккаунты, у которых продлевали цепочку входа. */
  renewedAccountIds: number[];
  /** `exclude` из последнего запроса `available` — что воркер отбросил. */
  lastExclude: number[];
};

/** Срок жизни входа, который Карман отдаёт «свежим» (замерено ≈12 ч). */
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** `exclude` приходит строкой «1,2» — разбираем в список id. */
function parseExclude(raw: unknown): number[] {
  const parts = Array.isArray(raw) ? raw : [raw];
  const ids: number[] = [];
  for (const part of parts) {
    for (const chunk of String(part ?? '').split(',')) {
      const id = Number(chunk.trim());
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
  }
  return ids;
}

export function createKarmanStub(options: KarmanStubOptions = {}): KarmanStub {
  const token = options.token ?? STUB_POOL_TOKEN;
  const accounts = options.accounts ?? [];
  const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  const emptyReason = options.emptyReason ?? null;
  let failNext = Math.max(0, Number(options.failNext ?? 0));

  const calls: PoolCallCounts = { available: 0, renew: 0, activations: 0 };
  const issuedAccountIds: number[] = [];
  const renewedAccountIds: number[] = [];
  /** Уже выданные аккаунты: выдача = погашение, второй раз тот же не отдаём. */
  const issued = new Set<number>();
  /** `exclude` пересобирается на каждый запрос — держим в объекте, а не в let. */
  const state: { lastExclude: number[] } = { lastExclude: [] };

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Авторизация — как у Кармана: без токена или с чужим токеном ручек не отдаём.
  app.use((req, res, next) => {
    const header = String(req.headers.authorization ?? '');
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!provided || provided !== token) {
      res.status(401).json({ error: 'Недействительный токен' });
      return;
    }
    next();
  });

  /** Вход аккаунта — помечен как стендовой, настоящих токенов тут нет. */
  function accessTokenFor(accountId: number): string {
    return `skm_stub_access_${accountId}`;
  }

  function accountPayload(account: StubAccount): Record<string, unknown> {
    return {
      id: account.id,
      email: account.email,
      activation_index: 1,
      points_next: account.pointsNext ?? 1000,
      streak: 3,
      next_bonus_in_days: 5,
      used_on: moscowDate(),
      quota_exhausted: false,
      unverified: false,
      hint_source: 'stand',
    };
  }

  /** Честная пустота: 200, `account: null` и причина — что именно кончилось. */
  function emptyOffer(reason: KarmanEmptyReason): Record<string, unknown> {
    return {
      account: null,
      reason,
      tier: null,
      free: 0,
      soon: 0,
      project: 'matricarmz',
      today: moscowDate(),
    };
  }

  app.get('/accounts/available', (req, res) => {
    calls.available += 1;
    state.lastExclude = parseExclude(req.query.exclude);

    if (failNext > 0) {
      failNext -= 1;
      res.status(503).json({ error: 'Карман временно недоступен' });
      return;
    }

    if (emptyReason) {
      res.json(emptyOffer(emptyReason));
      return;
    }

    // Отброшенные воркером аккаунты (`exclude=`) не выдаём — иначе он получит
    // тот же аккаунт снова и уйдёт на страхователя зря.
    const account = accounts.find((a) => !issued.has(a.id) && !state.lastExclude.includes(a.id));
    if (!account) {
      res.json(emptyOffer('no_free_accounts'));
      return;
    }

    issued.add(account.id);
    issuedAccountIds.push(account.id);
    res.json({
      account: accountPayload(account),
      tier: 'free',
      reason: null,
      free: Math.max(0, accounts.length - issued.size),
      soon: 0,
      project: 'matricarmz',
      today: moscowDate(),
      access_token: accessTokenFor(account.id),
      expires_at_ms: Date.now() + (account.expiresInMs ?? defaultTtlMs),
    });
  });

  app.post('/renew', (req, res) => {
    calls.renew += 1;
    const body = (req.body ?? {}) as { account_id?: number };
    const accountId = Number(body.account_id);
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      res.status(404).json({ error: 'Аккаунт не найден' });
      return;
    }
    renewedAccountIds.push(account.id);
    res.json({
      account_id: account.id,
      email: account.email,
      access_token: `${accessTokenFor(account.id)}_renewed_${renewedAccountIds.length}`,
      expires_at_ms: Date.now() + defaultTtlMs,
      renewed: true,
    });
  });

  app.post('/activations', (req, res) => {
    calls.activations += 1;
    const body = (req.body ?? {}) as { account_id?: number; email?: string };
    const accountId = Number(body.account_id);
    const account = accounts.find((a) => a.id === accountId);
    res.json({
      account_id: Number.isInteger(accountId) ? accountId : null,
      email: String(body.email ?? ''),
      used_on: moscowDate(),
      points: account?.pointsNext ?? 0,
      source: 'computed',
    });
  });

  let server: Server | null = null;

  async function start(): Promise<string> {
    if (server) throw new Error('заглушка уже поднята');
    const listening = app.listen(0, '127.0.0.1');
    server = listening;
    await new Promise<void>((resolve, reject) => {
      listening.once('listening', () => resolve());
      listening.once('error', (e) => reject(e));
    });
    const address = listening.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  async function stop(): Promise<void> {
    const listening = server;
    server = null;
    if (!listening) return;
    await new Promise<void>((resolve) => {
      listening.close(() => resolve());
      // Keep-alive-сокеты клиента (fetch) не дают серверу закрыться — рвём их.
      listening.closeAllConnections();
    });
  }

  return {
    app,
    start,
    stop,
    calls,
    issuedAccountIds,
    renewedAccountIds,
    /** Геттер: `exclude` пересобирается на каждом запросе `available`. */
    get lastExclude(): number[] {
      return state.lastExclude;
    },
  };
}
