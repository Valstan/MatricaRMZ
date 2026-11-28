// Профиль MiniMax Code на машине оператора: токен-стор и каталоги агента.
//
// Рантайм MiniMax Code читает запись токен-стора из `auth.json` по ключу, который
// выводится из АБСОЛЮТНОГО пути каталога авторизации: `com.minimax.mcode.oauth.prod.en`
// + base64url(sha256(<путь>/auth + "\0" + clientId)). Поэтому профиль привязан к своему
// каталогу на диске и переносить его «в другое место» нельзя.
//
// Требования рантайма к записи (проверено на живом прогоне v0.7.4): обязательны `generation`,
// `loginEpoch`, `tokenType: "Bearer"` и НЕПУСТОЙ `refreshToken` — с пустым значением CLI
// считает запись битой и отказывается работать вовсе. «Карман» refresh не отдаёт (мандат
// владельца 14.11), поэтому туда пишется честно помеченная заглушка: продлить вход ею нельзя —
// после истечения access клиент просто берёт следующий аккаунт.
//
// ВТОРЫЙ ФАЙЛ: кроме `auth.json` рантайм читает `auth-state.json` — состояние входа
// (schemaVersion, status, storeKind, clientId, scopes, audience, buildEnv, region,
// generation). Без него рантайм считает вход анонимным и отвечает «Sign in to MiniMax».
// Токены в state-файл класть нельзя: рантайм это проверяет и отказывается читать такой файл.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TOKEN_KEY_PREFIX = 'com.minimax.mcode.oauth.prod.en';
const TOKEN_CLIENT_ID = 'mcode-public';
/** Заглушка refresh: рантайм требует поле непустым, настоящего refresh у нас нет. */
export const REFRESH_PLACEHOLDER = 'mmoat_placeholder_refresh_not_provided';
/** Запасной срок жизни access, если «Карман» не прислал `expires_at_ms`. */
const DEFAULT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/** Контракт рантайма MiniMax Code (проверен на живой версии 0.7.4). */
const CREDENTIAL_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 2;
const STATE_STORE_KIND = 'file';
const TOKEN_TYPE = 'Bearer';
const TOKEN_SCOPES = ['agent.default'];
const TOKEN_AUDIENCE = 'agent-backend';
const TOKEN_BUILD_ENV = 'prod';
/**
 * Регион аккаунта: 'cn' или 'en'. Рантайм берёт его из `MCODE_REGION` и ищет вход
 * в `<dataDir>/auth/<buildEnv>/<region>/<clientId>/` — если регионы разойдутся, рантайм
 * вход не увидит и ответит «Sign in to MiniMax» (живой прогон 28.11.2026: у нас стояло
 * 'prod' — рантайм взял свой 'cn', а мы писали в 'en').
 */
export const TOKEN_REGION = 'en';

export type AgentProfile = {
  /** Каталог профиля (корень). */
  root: string;
  /** MCODE_CONFIG_DIR: настройки CLI. */
  configDir: string;
  /** MINIMAX_DATA_DIR/MAVIS_DATA_DIR: данные, сессии, логи. */
  dataDir: string;
  /** Каталог авторизации — из него выводится ключ токен-стора. */
  authHome: string;
  /** Файл токен-стора: учётные данные записи. */
  storePath: string;
  /** Файл состояния входа: рантайм читает его ОТДЕЛЬНО от учётных данных. */
  statePath: string;
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
  const namespaceHome = join(authHome, TOKEN_BUILD_ENV, TOKEN_REGION, TOKEN_CLIENT_ID);
  return {
    root: profileRoot,
    configDir,
    dataDir,
    authHome,
    storePath: join(namespaceHome, 'auth.json'),
    statePath: join(namespaceHome, 'auth-state.json'),
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
  const raw = record.accountId;
  const accountId = typeof raw === 'number' ? raw : typeof raw === 'string' && raw ? Number(raw) : undefined;
  // `exactOptionalPropertyTypes`: необязательное поле либо есть, либо его нет вовсе —
  // «undefined» в объект не кладём.
  const base = {
    accessToken: record.accessToken,
    expiresAtMs: typeof record.expiresAtMs === 'number' ? record.expiresAtMs : 0,
  };
  return typeof accountId === 'number' && Number.isFinite(accountId) ? { ...base, accountId } : base;
}

/**
 * Записать вход аккаунта в токен-стор. `generation` наследуется из прежней записи
 * (счётчик входа), `loginEpoch` — свежая метка: новый токен = новый вход.
 */
/** Запись файла целиком: обрыв на середине = битый вход. */
function writeJsonAtomic(path: string, payload: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
  renameSync(tmp, path);
}

/**
 * Записать вход аккаунта в токен-стор. `generation` наследуется из прежней записи
 * (счётчик входа), `loginEpoch` — свежая метка: новый токен = новый вход.
 *
 * Пишем ДВА файла: учётные данные (`auth.json`) и состояние входа (`auth-state.json`).
 * Рантайм читает их раздельно, и без state-файла он считает вход анонимным и
 * отвечает «Sign in to MiniMax» (живой прогон 28.11.2026, MiniMax Code 0.7.4).
 */
export function writeCredential(profile: AgentProfile, credential: StoredCredential): void {
  const key = tokenStoreKey(resolve(profile.authHome));
  const records = readStore(profile.storePath);
  const previous = records[key] ?? {};
  const generation = typeof previous.generation === 'number' ? previous.generation : 1;
  const expiresAtMs = credential.expiresAtMs || Date.now() + DEFAULT_TOKEN_TTL_MS;
  const record = {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    accessToken: credential.accessToken,
    refreshToken: REFRESH_PLACEHOLDER,
    // Рантайм требует эти поля и отвергает запись без них как битую.
    tokenType: TOKEN_TYPE,
    clientId: TOKEN_CLIENT_ID,
    scopes: TOKEN_SCOPES,
    audience: TOKEN_AUDIENCE,
    expiresAtMs,
    generation,
    loginEpoch: randomUUID(),
    // accountId рантайм ждёт строкой: числовой id он считает битой записью.
    accountId: credential.accountId === undefined ? undefined : String(credential.accountId),
  };
  mkdirSync(join(profile.authHome, TOKEN_BUILD_ENV, TOKEN_REGION, TOKEN_CLIENT_ID), { recursive: true });
  mkdirSync(profile.configDir, { recursive: true });
  mkdirSync(profile.dataDir, { recursive: true });
  writeJsonAtomic(profile.storePath, { schemaVersion: CREDENTIAL_SCHEMA_VERSION, records: { [key]: record } });
  // Состояние входа: токенов в нём быть не может — рантайм это проверяет.
  writeJsonAtomic(profile.statePath, {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: 'authenticated',
    storeKind: STATE_STORE_KIND,
    clientId: TOKEN_CLIENT_ID,
    scopes: TOKEN_SCOPES,
    audience: TOKEN_AUDIENCE,
    buildEnv: TOKEN_BUILD_ENV,
    region: TOKEN_REGION,
    generation,
    expiresAtMs,
  });
}

/** Снести запись входа: профиль следующего аккаунта не должен унаследовать чужой. */
export function clearCredential(profile: AgentProfile): void {
  if (existsSync(profile.storePath)) {
    writeJsonAtomic(profile.storePath, { schemaVersion: CREDENTIAL_SCHEMA_VERSION, records: {} });
  }
  // Состояние — тоже: запись пуста, а состояние «вход живой» сбило бы рантайм с толку.
  writeJsonAtomic(profile.statePath, {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: 'anonymous',
    storeKind: STATE_STORE_KIND,
    clientId: TOKEN_CLIENT_ID,
    scopes: TOKEN_SCOPES,
    audience: TOKEN_AUDIENCE,
    buildEnv: TOKEN_BUILD_ENV,
    region: TOKEN_REGION,
    generation: 0,
  });
}
