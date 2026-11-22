// Клиент пула аккаунтов MiniMax в КАРМАНе (контракт ручек — plan #57, сверено с кодом
// Кармана 22.11.2026).
//
// Три ручки, и только три: `accounts/available` (выдача), `renew` (продление цепочки
// токенов), `activations` (наблюдение: сколько очков было на токене).
//
// ⚠️ Свой пул и свою логику подбора здесь не заводим — это зона Кармана (D-214, D-216).
// Ручки `release` у Кармана нет: выдача = погашение.

export type KarmanPoolAccount = {
  id: number;
  title?: string | null;
  email?: string | null;
  activation_index?: number | null;
  points_next?: number | null;
  streak?: number | null;
  next_bonus_in_days?: number | null;
  used_on?: string | null;
  quota_exhausted?: boolean | null;
  unverified?: boolean | null;
  hint_source?: string | null;
};

export type KarmanOffer = {
  account: KarmanPoolAccount | null;
  tier?: string | null;
  reason?: string | null;
  recommended?: boolean;
  why?: string;
  free?: number;
  soon?: number;
  project?: string;
  today?: string;
  /** Вход в аккаунт: только access (refresh Карман наружу не отдаёт). */
  access_token?: string;
  expires_at_ms?: number | null;
};

export type KarmanRenewal = {
  account_id: number;
  email?: string;
  access_token: string;
  expires_at_ms: number;
  renewed: boolean;
};

/** Причины отказа — различаются намеренно: «аккаунтов нет» и «сервис сломался» — разные вещи. */
export type KarmanFailureReason =
  | 'karman_unavailable'
  | 'token_unauthorized'
  | 'token_read_only'
  | 'rate_limited'
  | 'pool_empty'
  | 'account_not_found'
  | 'account_not_ours'
  | 'bad_request';

export class KarmanPoolError extends Error {
  readonly reason: KarmanFailureReason;
  readonly status: number;
  readonly detail: string;

  constructor(reason: KarmanFailureReason, status: number, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'KarmanPoolError';
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

export type KarmanPoolClientOptions = {
  base: string;
  token: string;
  project: string;
  area: string;
  fetchImpl?: typeof fetch;
};

function consumerHeaders(options: KarmanPoolClientOptions): Record<string, string> {
  return {
    'X-MiniMax-Project': options.project,
    'X-MiniMax-Area': options.area,
  };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { error: text.slice(0, 300) };
  }
}

/** Статус → причина. Ошибки провайдера не размазываем: у каждой свой смысл. */
function failureForStatus(status: number, body: Record<string, unknown>): KarmanPoolError {
  const detail = String(body.error ?? body.message ?? `HTTP ${status}`);
  if (status === 401) return new KarmanPoolError('token_unauthorized', status, detail);
  if (status === 403) return new KarmanPoolError('token_read_only', status, detail);
  if (status === 429) return new KarmanPoolError('rate_limited', status, detail);
  if (status === 404) return new KarmanPoolError('account_not_found', status, detail);
  if (status === 409) return new KarmanPoolError('account_not_ours', status, detail);
  if (status === 400) return new KarmanPoolError('bad_request', status, detail);
  return new KarmanPoolError('karman_unavailable', status, detail);
}

async function request(
  options: KarmanPoolClientOptions,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!options.base) {
    throw new KarmanPoolError('karman_unavailable', 0, 'не задан адрес ручек пула Кармана');
  }
  if (!options.token) {
    throw new KarmanPoolError('token_unauthorized', 0, 'не задан токен пула Кармана');
  }
  const doFetch = options.fetchImpl ?? fetch;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json',
      ...consumerHeaders(options),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  let res: Response;
  try {
    res = await doFetch(`${options.base}${path}`, init);
  } catch (e) {
    throw new KarmanPoolError('karman_unavailable', 0, String(e));
  }
  const parsed = await readJson(res);
  if (!res.ok) throw failureForStatus(res.status, parsed);
  return parsed;
}

/**
 * Взять аккаунт из пула.
 *
 * `exclude` — id аккаунтов, которые нам не подошли (Карман отдаст следующего):
 * без него он вернёт тот же id, и мы снова получим «очки кончились».
 */
export async function takeAccount(
  options: KarmanPoolClientOptions & { exclude?: number[] },
): Promise<KarmanOffer> {
  const query = new URLSearchParams();
  const exclude = (options.exclude ?? []).filter((id) => Number.isInteger(id) && id > 0);
  if (exclude.length) query.set('exclude', exclude.join(','));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const body = await request(options, 'GET', `/accounts/available${suffix}`);
  const offer = body as unknown as KarmanOffer;
  if (!offer.account) {
    const reason = String(offer.reason ?? 'no_free_accounts');
    throw new KarmanPoolError('pool_empty', 200, reason);
  }
  return offer;
}

/** Продлить цепочку токенов того же аккаунта (access живёт ~12 ч). */
export async function renewAccount(
  options: KarmanPoolClientOptions,
  accountId: number,
): Promise<KarmanRenewal> {
  const body = await request(options, 'POST', '/renew', { account_id: accountId });
  return body as unknown as KarmanRenewal;
}

/** Отметить активацию: сколько очков было на выданном токене (наблюдение, не запись учёта). */
export async function reportActivation(
  options: KarmanPoolClientOptions,
  payload: { account_id?: number | null; email?: string | null; points?: number | null; activation_index?: number | null },
): Promise<void> {
  await request(options, 'POST', '/activations', {
    account_id: payload.account_id ?? null,
    email: payload.email ?? null,
    points: payload.points ?? null,
    activation_index: payload.activation_index ?? null,
  });
}
