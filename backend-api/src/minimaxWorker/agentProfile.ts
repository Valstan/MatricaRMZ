// Профиль аккаунта MiniMax Code: токен-стор + конфиг CLI.
//
// Формат записи токен-стора — не наш: рантайм MiniMax Code ищет запись по ключу,
// который выводится из **абсолютного пути** каталога данных профиля, и отвергает
// запись без `refreshToken`, `generation` и `loginEpoch` («stored OAuth credential
// record is invalid»). Проверено по коду CLI в «Сарафане» (ADR-0017) — оттуда же
// взят алгоритм ключа.
//
// ⚠️ Refresh Карман наружу не отдаёт, а рантайм требует поле непустым: пишем
// заглушку. Продлить ею вход нельзя — после истечения access берём следующий аккаунт.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const TOKEN_KEY_PREFIX = 'com.minimax.mcode.oauth.prod.en';
export const TOKEN_CLIENT_ID = 'mcode-public';
export const REFRESH_PLACEHOLDER = 'mmoat_placeholder_refresh_not_provided';
/** Запасной срок жизни access, если Карман не прислал `expires_at_ms` (замерено ≈9 ч). */
export const DEFAULT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export type TokenStoreRecord = {
  schemaVersion: number;
  accessToken: string;
  tokenType: string;
  clientId: string;
  scopes: string[];
  audience: string;
  expiresAtMs: number;
  generation: number;
  loginEpoch: string;
  refreshToken: string;
};

export type TokenStore = {
  schemaVersion: number;
  records: Record<string, TokenStoreRecord>;
};

/** Ключ записи токен-стора: sha256 от пути и id клиента, base64url без padding. */
export function tokenStoreKey(authHome: string): string {
  const digest = createHash('sha256')
    .update(`${authHome}\0${TOKEN_CLIENT_ID}`)
    .digest('base64url')
    .replace(/=+$/, '');
  return `${TOKEN_KEY_PREFIX}\0${digest}`;
}

export function buildTokenRecord(params: {
  accessToken: string;
  expiresAtMs?: number | null;
  generation?: number;
}): TokenStoreRecord {
  return {
    schemaVersion: 1,
    accessToken: params.accessToken,
    tokenType: 'Bearer',
    clientId: TOKEN_CLIENT_ID,
    scopes: ['agent.default'],
    audience: 'agent-backend',
    expiresAtMs: Number(
      params.expiresAtMs ?? Date.now() + DEFAULT_TOKEN_TTL_MS,
    ),
    generation: Math.max(1, Number(params.generation ?? 1)),
    loginEpoch: randomUUID(),
    refreshToken: REFRESH_PLACEHOLDER,
  };
}

export type MinimaxProfile = {
  /** Корень профиля: в нём `config` (MCODE_CONFIG_DIR) и `data` (токен-стор). */
  root: string;
  configDir: string;
  dataDir: string;
  authPath: string;
  accountId: number | null;
  email: string | null;
};

/**
 * Положить выданный токен в рабочую область.
 *
 * Рабочая область одна (как в «Сарафане»): токен перезаписывает токен-стор, а не
 * плодит профили — путь области постоянен, значит и ключ записи (он выводится из
 * пути) остаётся верным.
 */
export async function materializeProfile(params: {
  accountsDir: string;
  area: string;
  accessToken: string;
  expiresAtMs?: number | null;
  accountId?: number | null;
  email?: string | null;
  nowMs?: number;
}): Promise<MinimaxProfile> {
  const root = path.join(params.accountsDir, params.area);
  const dataDir = path.join(root, 'data');
  const authHome = path.join(dataDir, 'auth');
  const authPath = path.join(authHome, 'prod', 'en', TOKEN_CLIENT_ID, 'auth.json');
  const configDir = path.join(root, 'config');
  const key = tokenStoreKey(authHome);

  const record = buildTokenRecord({
    accessToken: params.accessToken,
    expiresAtMs: params.expiresAtMs ?? null,
  });
  const store: TokenStore = { schemaVersion: 1, records: { [key]: record } };

  await mkdir(path.dirname(authPath), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(authPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');

  const now = params.nowMs ?? Date.now();
  const meta = {
    karman_account_id: params.accountId ?? null,
    email: params.email ?? null,
    updated_at_ms: now,
    // День получения токена: отчёт об активации привязан к выдаче, а не к календарю.
    leased_day: moscowDate(now),
  };
  await writeFile(path.join(root, 'profile.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  return {
    root,
    configDir,
    dataDir,
    authPath,
    accountId: params.accountId ?? null,
    email: params.email ?? null,
  };
}

/** Московская дата `YYYY-MM-DD` — как у Кармана (его `used_on`). */
export function moscowDate(nowMs: number = Date.now()): string {
  const shifted = new Date(nowMs + 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
