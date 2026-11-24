// Запуск MiniMax Code на машине оператора — МОЛЧА.
//
// Требования (план #62, п. 9):
//   * ни одного окна, даже окна терминала — `windowsHide: true` и НЕ `detached`:
//     `detached: true` убивает процесс вместе с родителем (грабля M214);
//   * stdout нужен для разбора `exec.result`, поэтому stdio — трубы, а не 'ignore';
//   * свои каталоги (MCODE_CONFIG_DIR/MINIMAX_DATA_DIR) — профиль агента;
//   * прокси-переменные вычищаются: мёртвый 127.0.0.1:10809 роняет и установку, и вход;
//   * потолок кучи V8 — клиентская машина парка не должна уходить в OOM.
//
// MCP-конфиг проекта `.mcp.json` лежит в рабочем каталоге прогона: рантайм MiniMax
// Code подхватывает его сам (общее правило с Desktop/ACP) — так агент получает
// read-only доступ к локальной реплике базы завода.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

import type { AgentProfile } from './agentProfile.js';

export const AGENT_MODEL = 'minimax/MiniMax-M3.1-Flash';
export const AGENT_MAX_STEPS = 8;
export const AGENT_TIMEOUT_MS = 4 * 60_000;
/** Потолок кучи V8: клиентская машина парка — не бокс с 1,5 ГБ, но и не сервер. */
const NODE_MAX_OLD_SPACE_MB = 512;

/**
 * Системный промпт агента: он и задаёт форму ответа ( `--output-schema` рантайм не
 * держит — ADR-0017). Отвечать нужно по данным завода, а не по памяти: за данные
 * ходит в базу через MCP-инструменты.
 */
export const AGENT_SYSTEM_PROMPT = [
  'Ты — ИИваныч, помощник завода «Матрица РМЗ». Отвечаешь оператору на русском.',
  'Данные завода лежат в локальной базе: читай их инструментами matrica-db (db_schema, db_table, db_query).',
  'Инструменты только на чтение — записи в базу нет и не нужно.',
  'Отвечай по фактам из базы: цифры, названия, остатки, сроки. Не выдумывай.',
  'Формат: короткий ответ по существу, можно списком. Без вступлений вроде «конечно» и без service-фраз.',
].join('\n');

export type AgentRunRequest = {
  /** Исполняемый файл MiniMax Code (JS-вход или .exe; shim .cmd разрешается). */
  mcodePath: string;
  /** Рантайм Node.js рядом с модулем — им запускается JS-вход MiniMax Code. */
  nodePath?: string;
  /** Профиль агента (каталоги и токен-стор). */
  profile: AgentProfile;
  /** Рабочий каталог прогона: тут .mcp.json и входные файлы. */
  workspaceDir: string;
  /** Текст вопроса оператора. */
  question: string;
  /** Имя MCP-моста к базе (ключ в .mcp.json) и команда запуска моста. */
  dbMcp?: { name: string; command: string; args: string[]; env: Record<string, string> } | null;
  timeoutMs?: number;
  maxSteps?: number;
  model?: string;
};

export type AgentRunResult =
  | { ok: true; answer: string; details: Record<string, unknown> }
  | { ok: false; reason: string; message: string; details: Record<string, unknown> };

/** Расширения, которые Node запускает сам как скрипт. */
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'];
/** Обёртки npm для Windows — Node их исполнять отказывается (EINVAL без shell). */
const CMD_EXTENSIONS = ['.cmd', '.bat'];

/**
 * Настоящий вход MiniMax Code.
 *
 * npm на Windows кладёт рядом shim `mcode.cmd`, а Node такие файлы запускать
 * отказывается (без `shell` — EINVAL, а `shell` открыл бы окно консоли).
 * Значит «запуск по абсолютному пути к исполняемому файлу» надо понимать
 * буквально: ищем JS-вход (сначала одноимённый файл рядом, потом путь внутри
 * shim) и запускаем его рантайм-node, который едет с модулем.
 */
export function resolveMcodeEntry(mcodePath: string): string {
  const ext = extname(mcodePath).toLowerCase();
  if (SCRIPT_EXTENSIONS.includes(ext)) return mcodePath;
  if (!CMD_EXTENSIONS.includes(ext)) return mcodePath;

  const base = mcodePath.slice(0, mcodePath.length - ext.length);
  for (const candidate of SCRIPT_EXTENSIONS.map((e) => `${base}${e}`)) {
    if (existsSync(candidate)) return candidate;
  }
  return readShimTarget(mcodePath) ?? mcodePath;
}

/** Путь на JS-вход внутри shim npm: `"%~dp0\\..\\@minimax-ai\\code\\bin\\mcode.js"`. */
function readShimTarget(cmdPath: string): string | null {
  let text = '';
  try {
    text = readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const dir = dirname(cmdPath);
  const quoted = text.match(/"[^"]+"/g) ?? [];
  for (const raw of quoted) {
    const value = raw.slice(1, -1).replace(/%~dp0/g, dir).trim();
    if (!value) continue;
    // Путь внутри shim написан обратными слэшами (стиль Windows) — на POSIX их
    // надо превратить в прямые, иначе resolve получит несуществующий путь.
    const native = process.platform === 'win32' ? value : value.replace(/\\/g, '/');
    if (!SCRIPT_EXTENSIONS.includes(extname(native).toLowerCase())) continue;
    // resolve нормализует «..» (shim npm ссылается на пакет через «%dp0\..\»).
    const absolute = resolve(dir, native);
    if (existsSync(absolute)) return absolute;
  }
  return null;
}

export type AgentCommand = {
  /** Что запускаем. */
  command: string;
  /** Аргументы запуска (для JS-входа первым идёт сам скрипт). */
  args: string[];
};

/**
 * Команда запуска агента. JS-вход запускается рантайм-node рядом с модулем
 * (`node.exe` из extraResources), а не системным Node — на машине парка его нет,
 * и не `electron.exe` (это запустило бы приложение, а не скрипт).
 */
export function resolveAgentCommand(params: {
  mcodePath: string;
  nodePath?: string;
  args: string[];
}): AgentCommand {
  const entry = resolveMcodeEntry(params.mcodePath);
  const ext = extname(entry).toLowerCase();
  if (SCRIPT_EXTENSIONS.includes(ext)) {
    const node = params.nodePath && existsSync(params.nodePath) ? params.nodePath : '';
    if (!node) {
      return { command: entry, args: params.args };
    }
    return { command: node, args: [entry, ...params.args] };
  }
  return { command: entry, args: params.args };
}

/** Конфиг MCP проекта: рантайм MiniMax Code читает `.mcp.json` из рабочего каталога. */
export function buildMcpConfig(dbMcp: AgentRunRequest['dbMcp']): string {
  if (!dbMcp) return JSON.stringify({ mcpServers: {} }, null, 2);
  return JSON.stringify(
    {
      mcpServers: {
        [dbMcp.name]: {
          command: dbMcp.command,
          args: dbMcp.args,
          env: dbMcp.env,
        },
      },
    },
    null,
    2,
  );
}

/**
 * Аргументы `mcode exec`. Порядок и набор — как у живого прогона Сарафана:
 * разрешения выключены, ответ пишется в файл, формат разбора — json.
 */
export function buildAgentArgs(req: {
  answerFile: string;
  systemPromptFile: string;
  payloadFile: string;
  timeoutMs: number;
  maxSteps: number;
  model: string;
}): string[] {
  return [
    'exec',
    '--permission',
    'off',
    '--output-format',
    'json',
    '--output-last-message',
    req.answerFile,
    '--system-prompt-file',
    req.systemPromptFile,
    '--max-steps',
    String(req.maxSteps),
    '--mode',
    'standard',
    '--timeout',
    `${Math.round(req.timeoutMs / 1000)}s`,
    '--model',
    req.model,
    '--file',
    req.payloadFile,
  ];
}

/** Окружение прогона: свои каталоги, чистка прокси, потолок кучи. */
export function buildAgentEnv(profile: AgentProfile, logFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    delete env[key];
  }
  env.MCODE_CONFIG_DIR = profile.configDir;
  env.MINIMAX_DATA_DIR = profile.dataDir;
  env.MAVIS_DATA_DIR = profile.dataDir;
  env.MCODE_LOG_FILE = logFile;
  env.MCODE_REGION = 'prod';
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --dns-result-order=ipv4first --max-old-space-size=${NODE_MAX_OLD_SPACE_MB}`.trim();
  return env;
}

/** Разбор stdout: последняя строка с `type: "exec.result"` — это итог прогона. */
export function parseExecResult(stdout: string): Record<string, any> | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && parsed.type === 'exec.result') return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Прогон агента. Возвращает ответ или честную причину отказа: «молчать» оператору
 * нельзя — вопрос либо получает ответ, либо уходит дальше по цепочке.
 */
export async function runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
  const timeoutMs = req.timeoutMs ?? AGENT_TIMEOUT_MS;
  const maxSteps = req.maxSteps ?? AGENT_MAX_STEPS;
  const model = req.model ?? AGENT_MODEL;
  const workspaceDir = req.workspaceDir;
  mkdirSync(workspaceDir, { recursive: true });

  const answerFile = join(workspaceDir, 'answer.txt');
  const systemPromptFile = join(workspaceDir, 'system-prompt.txt');
  const payloadFile = join(workspaceDir, 'question.md');
  const logFile = join(req.profile.dataDir, 'mcode.log');
  writeFileSync(systemPromptFile, AGENT_SYSTEM_PROMPT, 'utf8');
  writeFileSync(payloadFile, req.question, 'utf8');
  writeFileSync(join(workspaceDir, '.mcp.json'), buildMcpConfig(req.dbMcp), 'utf8');

  const args = buildAgentArgs({ answerFile, systemPromptFile, payloadFile, timeoutMs, maxSteps, model });
  const env = buildAgentEnv(req.profile, logFile);
  // Запуск по абсолютному пути к исполняемому файлу: JS-вход MiniMax Code идёт
  // через рантайм-node модуля, shim npm (.cmd) не исполняется Node вовсе.
  const command = resolveAgentCommand({
    mcodePath: req.mcodePath,
    ...(req.nodePath ? { nodePath: req.nodePath } : {}),
    args,
  });

  return await new Promise<AgentRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: AgentRunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(command.command, command.args, {
      cwd: workspaceDir,
      env,
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: 'timeout', message: 'локальный агент не ответил вовремя', details: { timeoutMs } });
    }, timeoutMs + 15_000);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (e) => {
      finish({ ok: false, reason: 'spawn_failed', message: `не удалось запустить локальный агент: ${String(e)}`, details: {} });
    });
    child.on('close', (code) => {
      const payload = parseExecResult(stdout);
      if (!payload) {
        finish({
          ok: false,
          reason: 'no_result',
          message: 'локальный агент не вернул результат',
          details: { exitCode: code, stderr: stderr.slice(-400) },
        });
        return;
      }
      if (payload.status === 'succeeded') {
        let answer = String(payload.output ?? '');
        if (!answer && existsSync(answerFile)) answer = readFileSync(answerFile, 'utf8');
        if (!answer && payload.result) answer = String(payload.result);
        if (!answer.trim()) {
          finish({ ok: false, reason: 'empty_response', message: 'локальный агент ответил пустотой', details: { exitCode: code } });
          return;
        }
        finish({ ok: true, answer: answer.trim(), details: { exitCode: code, model: payload.model?.modelId, usage: payload.usage } });
        return;
      }
      const error = payload.error ?? {};
      finish({
        ok: false,
        reason: String(error.type ?? 'exec_failed'),
        message: String(error.message ?? 'локальный агент отказал'),
        details: { exitCode: code, stderr: stderr.slice(-400) },
      });
    });
  });
}
