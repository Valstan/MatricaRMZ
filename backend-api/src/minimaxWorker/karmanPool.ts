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

/**
 * Причины «честной пустоты» — что именно у Кармана кончилось.
 *
 * Разные причины ⇒ разные ответы владельцу: «свободных аккаунтов нет»,
 * «аккаунты есть, а пар токенов нет» и «все кандидаты непригодны» — это
 * разные вещи, а не одно «пусто» (ADR-0017 «Сарафана»: «кончились аккаунты»
 * и «кончилась квота» — разные причины и разные сообщения; brain G619).
 */
export type KarmanEmptyReason = 'no_free_accounts' | 'no_tokens_ready' | 'no_handable_accounts';

export type KarmanOffer = {
  account: KarmanPoolAccount | null;
  tier?: string | null;
  /** Причина пустоты: у Кармана — поле `reason` (всегда при `account: null`). */
  reason?: KarmanEmptyReason | null;
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
  /** Свободных аккаунтов нет вовсе (`no_free_accounts`). */
  | 'pool_empty'
  /** Аккаунты свободны, а пары токенов нет (`no_tokens_ready`). */
  | 'pool_no_tokens'
  /** Кандидаты есть, но все непригодны (`no_handable_accounts`). */
  | 'pool_no_handable'
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
 *
 * ⚠️ Честная пустота — это HTTP 200 с `account: null`, а не ошибка: у Кармана
 * так помечается «сейчас нельзя». Причины разные, и различать их надо:
 *   - `no_free_accounts`     — свободных аккаунтов нет (пул исчерпан на сутки);
 *   - `no_tokens_ready`      — аккаунты есть, а пары токенов нет (отдавать нечего);
 *   - `no_handable_accounts` — кандидаты были, но все отбракованы (оборванная
 *     цепочка токенов, клетку забрали, вендор не ответил).
 * Схлопывать их в одно «пусто» нельзя: у них разные сроки ожидания и разные
 * причины (ADR-0017 «Сарафана», brain G619).
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
    const reason = (String(offer.reason ?? 'no_free_accounts') || 'no_free_accounts') as KarmanEmptyReason;
    throw new KarmanPoolError(emptyReasonToFailure(reason), 200, reason);
  }
  return offer;
}

/** Причина пустоты → класс отказа: чем «пустее», тем дольше ждать. */
export function emptyReasonToFailure(reason: string): KarmanFailureReason {
  if (reason === 'no_tokens_ready') return 'pool_no_tokens';
  if (reason === 'no_handable_accounts') return 'pool_no_handable';
  return 'pool_empty';
}

/** Продлить цепочку токенов того же аккаунта (access живёт ~12 ч). */
export async function renewAccount(
  options: KarmanPoolClientOptions,
  accountId: number,
): Promise<KarmanRenewal> {
  const body = await request(options, 'POST', '/renew', { account_id: accountId });
  const renewal = body as unknown as KarmanRenewal;
  // Карман обязан вернуть свежий access. Без него продление бессмысленно: профиль
  // записался бы с пустым токеном, и агент упал бы на входе с «не авторизован».
  if (!renewal.access_token) {
    throw new KarmanPoolError('karman_unavailable', 200, 'Карман не вернул вход при продлении');
  }
  return renewal;
}

/**
 * Отметить активацию: сколько очков было на выданном токене.
 *
 * ⚠️ Это **наблюдение**, а не управление учётом: пара токенов сюда не принимается,
 * активацию и окно ведёт сам Карман. Поэтому шлём только «кто именно работал» —
 * `account_id` и почту.
 *
 * ⚠️ **Поля не отправляем пустыми.** Схема Кармана — `z.coerce.number()`: значение
 * `null` превращается в число (`points: null` → `0`!), а `null` в строке и в
 * `activation_index` даёт 400. Явный `null` в теле — это либо ложное наблюдение
 * («очков было 0»), либо отказ ручки. Отсутствующее поле надо **не слать вовсе**.
 *
 * Очки и клетку (`points`, `activation_index`) мы не отправляем: это факт панели
 * MiniMax, которого у нас нет, — Карман посчитает их сам (`source: computed`).
 */
export async function reportActivation(
  options: KarmanPoolClientOptions,
  payload: { account_id?: number | null; email?: string | null },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (typeof payload.account_id === 'number' && Number.isInteger(payload.account_id)) {
    body.account_id = payload.account_id;
  }
  const email = String(payload.email ?? '').trim();
  if (email) body.email = email;
  // Ничего опознающего не осталось — ручка скажет «Нужен account_id или email».
  if (!body.account_id && !body.email) {
    throw new KarmanPoolError('bad_request', 0, 'нечего отмечать: нет ни account_id, ни почты');
  }
  await request(options, 'POST', '/activations', body);
}
