// Конфигурация локального звена MiniMax на машине оператора (D-243/D-244, 22.11.2026).
//
// Ни токена комнаты «Кармана», ни клиентского ключа DeepSeek в репозитории быть не может:
// репозиторий публичный. Сборка CI кладёт их в `extraResources` (`local-minimax/runtime`),
// а на dev-машине те же значения берутся из переменных окружения.
//
// Пакет «Кармана» (клиентский токен) умеет брать аккаунты MiniMax, а значит умеет и читать
// все секреты своей комнаты — поэтому у клиентов СВОЯ комната (`matricarmz-clients`): в ней
// лежит только клиентский ключ DeepSeek. Продовые ключи (приватный SSH-ключ бокса, Android-
// keystore, hotline-секрет) клиентам не достаются.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

/** Каталог модуля на машине оператора. ВНЕ путей уборки следов opencode ('engine'). */
export const LOCAL_MINIMAX_DIR_NAME = 'local-minimax';

export type LocalMiniMaxRuntime = {
  /** Адрес «Кармана». Прод-координата в репозитории не хранится. */
  karmanUrl: string;
  /** Пишущий токен клиентской комнаты: MiniMax-ручки требуют права записи. */
  karmanToken: string;
  /** Имя клиентской комнаты — им «Карман» привязывает аккаунт (X-MiniMax-Project). */
  project: string;
  /** Клиентский ключ DeepSeek: свой баланс, своя ротация (D-244). */
  deepseekApiKey: string;
  /** Node.js рядом с mcode: рантайм MiniMax Code требует Node 22.19+, на машине парка Node нет. */
  nodePath: string;
  /** Исполняемый файл MiniMax Code (`mcode`). */
  mcodePath: string;
  /** MCP-мост к локальной реплике (stdio-сервер, запускает сам mcode). */
  dbMcpPath: string;
};

export type LocalMiniMaxConfig = {
  /** Готово ли звено к работе. */
  configured: boolean;
  /** Почему не готово — одной строкой, без кодов. */
  reason: string;
  runtime: LocalMiniMaxRuntime | null;
  /** Каталог профиля агента: авторизация и данные MiniMax Code. */
  profileDir: string;
  /** Рабочий каталог прогона: сюда кладём .mcp.json и входные файлы. */
  workspaceDir: string;
};

type RuntimeBundle = {
  karmanUrl?: string;
  karmanToken?: string;
  project?: string;
  deepseekApiKey?: string;
  node?: string;
  mcode?: string;
};

function resourcesDir(): string {
  return process.resourcesPath ?? '';
}

function readRuntimeBundle(): RuntimeBundle {
  const candidates = [
    join(resourcesDir(), 'local-minimax', 'runtime', 'config.json'),
    join(process.cwd(), 'electron-app', 'build', 'local-minimax', 'config.json'),
    join(process.cwd(), 'build', 'local-minimax', 'config.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as RuntimeBundle;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function firstNonEmpty(...values: (string | undefined | null)[]): string {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * Путь к рантайму внутри `local-minimax/runtime`: относительные пути в bundle-файле
 * считаются от его каталога, абсолютные берутся как есть.
 */
function runtimePath(baseDir: string, value: string | undefined, fallback: string): string {
  const raw = firstNonEmpty(value, fallback);
  if (!raw) return '';
  return raw.includes(':') || raw.startsWith('/') ? raw : join(baseDir, raw);
}

/**
 * Собрать конфигурацию локального звена. Дёргается на каждый вопрос и на опрос статуса —
 * дешёвая, только читает файлы.
 */
export function loadLocalMiniMaxConfig(): LocalMiniMaxConfig {
  const bundleDir = join(resourcesDir(), 'local-minimax', 'runtime');
  const bundle = readRuntimeBundle();
  const userData = app.getPath('userData');
  const profileDir = join(userData, LOCAL_MINIMAX_DIR_NAME, 'profile');
  const workspaceDir = join(userData, LOCAL_MINIMAX_DIR_NAME, 'workspace');

  const karmanUrl = firstNonEmpty(process.env.MATRICA_KARMAN_URL, bundle.karmanUrl);
  const karmanToken = firstNonEmpty(process.env.MATRICA_KARMAN_CLIENT_TOKEN, bundle.karmanToken);
  const project = firstNonEmpty(bundle.project, 'matricarmz-clients');
  const deepseekApiKey = firstNonEmpty(process.env.MATRICA_DEEPSEEK_CLIENT_KEY, bundle.deepseekApiKey);
  const nodePath = runtimePath(bundleDir, bundle.node, 'bin/node.exe');
  const mcodePath = runtimePath(bundleDir, bundle.mcode, 'bin/mcode.cmd');
  const dbMcpPath = join(resourcesDir(), 'local-minimax', 'app', 'matrica-db-mcp.mjs');

  const missing: string[] = [];
  if (!karmanUrl) missing.push('адрес «Кармана»');
  if (!karmanToken) missing.push('токен клиентской комнаты');
  if (!existsSync(mcodePath)) missing.push('рантайм MiniMax Code');
  if (!existsSync(dbMcpPath)) missing.push('мост к базе');

  if (missing.length > 0) {
    return {
      configured: false,
      reason: `локальный модуль не настроен: нет ${missing.join(', ')}`,
      runtime: null,
      profileDir,
      workspaceDir,
    };
  }

  mkdirSync(profileDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  return {
    configured: true,
    reason: 'локальный модуль готов',
    runtime: { karmanUrl, karmanToken, project, deepseekApiKey, nodePath, mcodePath, dbMcpPath },
    profileDir,
    workspaceDir,
  };
}
