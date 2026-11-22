// Клиент пула MiniMax в «Кармане» (D-243/D-244).
//
// Клиент ходит в «Карман» НАПРЯМУЮ: прод в пути запросов аккаунтов не участвует
// (решение владельца № 3). Токен — пишущий: ручки MiniMax требуют права записи
// (read-only ⇒ 403 на всех трёх).
//
// Честная пустота — 200 с `account: null` и `reason`: это ёмкость пула, а не поломка.
// «Аккаунтов нет» и «сервис сломался» оператор должен различать, поэтому причина
// доезжает до строки статуса панели, а не прячется в лог.

export type KarmanAccount = {
  id: number;
  email?: string;
  title?: string;
  activation_index?: number;
  points_next?: number;
};

export type KarmanOffer = {
  account: KarmanAccount | null;
  /** Причина пустоты: no_free_accounts | no_tokens_ready | no_handleable_accounts. */
  reason: string | null;
  /** Токен доступа аккаунта (refresh «Карман» не отдаёт никогда). */
  accessToken: string | null;
  /** Когда access протухнет (мс epoch). */
  expiresAtMs: number | null;
};

export type KarmanFailureReason =
  | 'not_configured'
  | 'no_free_accounts'
  | 'forbidden'
  | 'rate_limited'
  | 'conflict'
  | 'not_found'
  | 'network'
  | 'bad_response';

export type KarmanResult<T> = { ok: true; value: T } | { ok: false; reason: KarmanFailureReason; message: string };

const EMPTY_REASONS = new Set(['no_free_accounts', 'no_tokens_ready', 'no_handable_accounts']);

function describe(status: number, body: string): { reason: KarmanFailureReason; message: string } {
  if (status === 401) return { reason: 'forbidden', message: 'токен клиентской комнаты отвергнут' };
  if (status === 403) return { reason: 'forbidden', message: 'у токена нет права записи — нужна пишущая комната' };
  if (status === 404) return { reason: 'not_found', message: 'аккаунт не найден в пуле' };
  if (status === 409) return { reason: 'conflict', message: 'аккаунт выдан другой комнате' };
  if (status === 429) return { reason: 'rate_limited', message: '«Карман» просит подождать (лимит запросов)' };
  const detail = body.trim().slice(0, 200);
  return { reason: 'bad_response', message: detail ? `«Карман» ответил ${status}: ${detail}` : `«Карман» ответил ${status}` };
}

type PoolClientOptions = {
  baseUrl: string;
  token: string;
  /** Имя клиентской комнаты: по нему «Карман» привязывает аккаунт. */
  project: string;
  /** Идентификатор клиента в аудите комнаты: «Карман» клиентов внутри комнаты не различает. */
  area: string;
  /** Подмена транспорта — для тестов. */
  fetchImpl?: typeof fetch;
};

/**
 * Пул аккаунтов MiniMax: выдача, продление и наблюдение активации.
 * Область (area) идёт в аудит комнаты — по нему видно, кто и под что брал.
 */
export class KarmanPoolClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly project: string;
  private readonly area: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PoolClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.project = opts.project;
    this.area = opts.area;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'X-MiniMax-Project': this.project,
      'X-MiniMax-Area': this.area,
    };
  }

  /** Взять аккаунт из пула. Ответ 200 с `account: null` — честная пустота, не ошибка. */
  async available(): Promise<KarmanResult<KarmanOffer>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/minimax/accounts/available`, {
        method: 'GET',
        headers: this.headers(),
      });
    } catch (e) {
      return { ok: false, reason: 'network', message: `«Карман» недоступен: ${String(e)}` };
    }
    const body = await response.text();
    if (!response.ok) {
      const described = describe(response.status, body);
      return { ok: false, ...described };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'bad_response', message: '«Карман» ответил неразборчивым JSON' };
    }
    const account = parsed?.account ?? null;
    const reason = typeof parsed?.reason === 'string' ? parsed.reason : null;
    if (!account) {
      const emptyReason = reason && EMPTY_REASONS.has(reason) ? reason : 'no_free_accounts';
      return {
        ok: true,
        value: { account: null, reason: emptyReason, accessToken: null, expiresAtMs: null },
      };
    }
    return {
      ok: true,
      value: {
        account: {
          id: Number(account.id),
          email: typeof account.email === 'string' ? account.email : undefined,
          title: typeof account.title === 'string' ? account.title : undefined,
          activation_index: typeof account.activation_index === 'number' ? account.activation_index : undefined,
          points_next: typeof account.points_next === 'number' ? account.points_next : undefined,
        },
        reason: null,
        accessToken: typeof parsed?.access_token === 'string' ? parsed.access_token : null,
        expiresAtMs: typeof parsed?.expires_at_ms === 'number' ? parsed.expires_at_ms : null,
      },
    };
  }

  /** Продлить цепочку токенов своего аккаунта: access живёт ~12 ч, refresh «Карман» не отдаёт. */
  async renew(accountId: number): Promise<KarmanResult<{ accessToken: string; expiresAtMs: number | null }>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/minimax/renew`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
      });
    } catch (e) {
      return { ok: false, reason: 'network', message: `«Карман» недоступен: ${String(e)}` };
    }
    const body = await response.text();
    if (!response.ok) {
      const described = describe(response.status, body);
      return { ok: false, ...described };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'bad_response', message: '«Карман» ответил неразборчивым JSON' };
    }
    const accessToken = typeof parsed?.access_token === 'string' ? parsed.access_token : '';
    if (!accessToken) {
      return { ok: false, reason: 'bad_response', message: '«Карман» не вернул access-токен' };
    }
    return {
      ok: true,
      value: {
        accessToken,
        expiresAtMs: typeof parsed?.expires_at_ms === 'number' ? parsed.expires_at_ms : null,
      },
    };
  }

  /** Доложить, сколько очков было на выданном токене: только наблюдение, учёт ведёт «Карман». */
  async reportActivation(accountId: number, points?: number): Promise<void> {
    try {
      await this.fetchImpl(`${this.baseUrl}/api/minimax/activations`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(points == null ? { account_id: accountId } : { account_id: accountId, points }),
      });
    } catch {
      // Наблюдение: сбой доклада не должен ломать ответ оператору.
    }
  }
}
