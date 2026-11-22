// Профиль MiniMax Code на машине оператора: токен-стор и каталоги агента.
//
// Рантайм MiniMax Code читает запись токен-стора из `auth.json` по ключу, который
// выводится из АБСОЛЮТНОГО пути каталога авторизации: `com.minimax.mcode.oauth.prod.en`
// + base64url(sha256(<путь>/auth + "\0" + clientId)). Поэтому профиль привязан к своему
// каталогу на диске и переносить его «в другое место» нельзя.
//
// Требования рантайма к записи (проверено на живых прогонах): обязательны `generation`,
// `loginEpoch` и НЕПУСТОЙ `refreshToken` — с пустым значением CLI считает запись битой и
// отказывается работать вовсе. «Карман» refresh не отдаёт (мандат владельца 14.11),
// поэтому туда пишется честно помеченная заглушка: продлить вход ею нельзя — после
// истечения access клиент просто берёт следующий аккаунт.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TOKEN_KEY_PREFIX = 'com.minimax.mcode.oauth.prod.en';
const TOKEN_CLIENT_ID = 'mcode-public';
/** Заглушка refresh: рантайм требует поле непустым, настоящего refresh у нас нет. */
export const REFRESH_PLACEHOLDER = 'mmoat_placeholder_refresh_not_provided';
/** Запасной срок жизни access, если «Карман» не прислал `expires_at_ms`. */
const DEFAULT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export type AgentProfile = {
  /** Каталог профиля (корень). */
  root: string;
  /** MCODE_CONFIG_DIR: настройки CLI. */
  configDir: string;
  /** MINIMAX_DATA_DIR/MAVIS_DATA_DIR: данные, сессии, логи. */
  dataDir: string;
  /** Каталог авторизации — из него выводится ключ токен-стора. */
  authHome: string;
  /** Файл токен-стора. */
  storePath: string;
};

export type StoredCredential = {
  accessToken: string;
  expiresAtMs: number;
  accountId?: number;
};

/** Ключ записи токен-стора: путь авторизации + clientId → sha256 → base64url без паддинга. */
export function tokenStoreKey(authHome: string): string {
  const digest = createHash('sha256').update(`${authHome}\0${TOKEN_CLIENT_ID}`, 'utf8').digest();
  const suffix = digest.toString('base64url');
  return `${TOKEN_KEY_PREFIX}\0${suffix}`;
}

export function profileDirs(profileRoot: string): AgentProfile {
  const configDir = join(profileRoot, 'config');
  const dataDir = join(profileRoot, 'data');
  const authHome = join(dataDir, 'auth');
  return {
    root: profileRoot,
    configDir,
    dataDir,
    authHome,
    storePath: join(authHome, 'prod', 'en', TOKEN_CLIENT_ID, 'auth.json'),
  };
}

function readStore(storePath: string): Record<string, any> {
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    const records = parsed?.records;
    return records && typeof records === 'object' ? records : {};
  } catch {
    return {};
  }
}

/** Что в профиле уже есть: запись токен-стора по ключу этого пути. */
export function readCredential(profile: AgentProfile): StoredCredential | null {
  const records = readStore(profile.storePath);
  const record = records[tokenStoreKey(resolve(profile.authHome))];
  if (!record || typeof record.accessToken !== 'string' || !record.accessToken) return null;
  return {
    accessToken: record.accessToken,
    expiresAtMs: typeof record.expiresAtMs === 'number' ? record.expiresAtMs : 0,
    accountId: typeof record.accountId === 'number' ? record.accountId : undefined,
  };
}

/**
 * Записать вход аккаунта в токен-стор. `generation` наследуется из прежней записи
 * (счётчик входа), `loginEpoch` — свежая метка: новый токен = новый вход.
 */
export function writeCredential(profile: AgentProfile, credential: StoredCredential): void {
  const key = tokenStoreKey(resolve(profile.authHome));
  const records = readStore(profile.storePath);
  const previous = records[key] ?? {};
  const record = {
    schemaVersion: 1,
    accessToken: credential.accessToken,
    clientId: TOKEN_CLIENT_ID,
    scopes: ['agent.default'],
    audience: 'agent-backend',
    expiresAtMs: credential.expiresAtMs || Date.now() + DEFAULT_TOKEN_TTL_MS,
    generation: typeof previous.generation === 'number' ? previous.generation : 1,
    loginEpoch: randomUUID(),
    refreshToken: REFRESH_PLACEHOLDER,
    accountId: credential.accountId,
  };
  mkdirSync(join(profile.authHome, 'prod', 'en', TOKEN_CLIENT_ID), { recursive: true });
  mkdirSync(profile.configDir, { recursive: true });
  mkdirSync(profile.dataDir, { recursive: true });
  const payload = JSON.stringify({ schemaVersion: 1, records: { [key]: record } });
  // Пишем через временный файл: оборванная запись auth.json = сломанный вход.
  const tmp = `${profile.storePath}.tmp-${process.pid}`;
  writeFileSync(tmp, payload, { encoding: 'utf8' });
  renameSync(tmp, profile.storePath);
}

/** Снести запись входа: профиль следующего аккаунта не должен унаследовать чужой. */
export function clearCredential(profile: AgentProfile): void {
  try {
    if (existsSync(profile.storePath)) writeFileSync(profile.storePath, JSON.stringify({ schemaVersion: 1, records: {} }), 'utf8');
  } catch {
    // Чистка не обязана удаваться: следующая запись перезапишет файл целиком.
  }
}
