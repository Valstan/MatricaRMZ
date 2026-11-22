// Адаптер MiniMax Code: запуск CLI-агента (`mcode exec`) и разбор его ответа.
//
// ⚠️ Почему CLI, а не API: у аккаунтов Кармана нет API-ключа — вендор отвечает
// `401` + `2062 no active token plan subscription`. Очки чекина тратятся только в
// сценариях MiniMax Code. Значит воркер — не прокси к API, а реализация семантики
// агента-CLI (ADR-0017 «Сарафана»).
//
// ⚠️ Нативная строгая схема (`--output-schema`) у MiniMax не работает
// (`STRUCTURED_OUTPUT_INVALID`): формат ответа задаёт системный промпт, а разбор —
// наш. Поэтому формат ответа здесь задаётся промптом воркера, а превращение в
// `tool_use` — отдельным слоем (`toolUseShaper.ts`).

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type AgentInvocation = {
  /** Промпт агента: системный промпт Ииваныча + контракт ответа + каталог инструментов. */
  system: string;
  /** Данные задачи (вопрос, история диалога, результаты инструментов). */
  user: string;
  /** Что агент должен сделать — короткая команда в конце командной строки. */
  task: string;
};

export type AgentCommandOptions = {
  cli: string;
  systemFile: string;
  answerFile: string;
  payloadFile: string;
  model: string;
  maxSteps: number;
  mode: string;
  timeoutSec: number;
  task: string;
};

/**
 * Команда запуска агента.
 *
 * Флаги — как в «Сарафане»: `standard` (агент видит вложенные файлы),
 * `--output-format json` (ответ приходит JSON-объектом), `--output-last-message`
 * (файл с финальным ответом) и `--file` (данные задачи файлом — содержимое задачи
 * агент-кодер иначе не считает данными).
 */
export function buildAgentCommand(options: AgentCommandOptions): string[] {
  const cmd = [
    options.cli,
    'exec',
    '--permission',
    'off',
    '--output-format',
    'json',
    '--output-last-message',
    options.answerFile,
    '--system-prompt-file',
    options.systemFile,
    '--max-steps',
    String(options.maxSteps),
    '--mode',
    options.mode,
    '--timeout',
    `${options.timeoutSec}s`,
  ];
  if (options.model) cmd.push('--model', options.model);
  cmd.push('--file', options.payloadFile);
  cmd.push(options.task.trim() || 'Ответь по заданию.');
  return cmd;
}

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

/**
 * Окружение запуска.
 *
 * Прокси из окружения убираем: CLI читает `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` сам,
 * а прокси в окружении ломает вход в аккаунт (G536). IPv4 — на боксе нет маршрута
 * IPv6, а DNS отдаёт AAAA первыми. Потолок кучи V8 — страховка бокса: без него Node
 * выбирает лимит по памяти машины и ядро снимает крупнейший процесс.
 */
export function buildAgentEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  configDir: string;
  dataDir: string;
  maxOldSpaceMb: number;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...params.baseEnv };
  for (const key of PROXY_VARS) delete env[key];
  env.MCODE_CONFIG_DIR = params.configDir;
  env.MINIMAX_DATA_DIR = params.dataDir;
  env.MAVIS_DATA_DIR = params.dataDir;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --dns-result-order=ipv4first --max-old-space-size=${params.maxOldSpaceMb}`.trim();
  return env;
}

export type AgentPayload = {
  status?: string;
  output?: string;
  result?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  durationMs?: number;
  model?: { modelId?: string; providerId?: string };
  error?: { message?: string } | string;
};

/**
 * Ответ CLI — последняя JSON-строка в stdout: рантайм печатает служебное, а
 * полезный объект — последним.
 */
export function parseAgentPayload(stdout: string): AgentPayload | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as AgentPayload;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

export type AgentRunResult =
  | { ok: true; text: string; payload: AgentPayload }
  | { ok: false; reason: string; detail: string; payload: AgentPayload | null };

/** Минимум от процесса CLI — свой тип вместо `ChildProcess`, чтобы запуск был тестируемым. */
export type SpawnedProcess = {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  kill(signal?: string): void;
  on(event: 'close', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (error: Error) => void): void;
};

export type SpawnFn = (
  cmd: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => SpawnedProcess;

export type RunAgentOptions = {
  cli: string;
  model: string;
  maxSteps: number;
  mode: string;
  timeoutSec: number;
  configDir: string;
  dataDir: string;
  maxOldSpaceMb: number;
  baseEnv?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnFn;
};

/** Запуск агента: файлы задачи → CLI → текст ответа. */
export async function runAgent(
  invocation: AgentInvocation,
  options: RunAgentOptions,
): Promise<AgentRunResult> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'matricarmz-minimax-'));
  const systemFile = path.join(workDir, 'system.md');
  const payloadFile = path.join(workDir, 'payload.md');
  const answerFile = path.join(workDir, 'answer.txt');
  try {
    await writeFile(systemFile, invocation.system, 'utf8');
    await writeFile(payloadFile, invocation.user, 'utf8');

    const cmd = buildAgentCommand({
      cli: options.cli,
      systemFile,
      answerFile,
      payloadFile,
      model: options.model,
      maxSteps: options.maxSteps,
      mode: options.mode,
      timeoutSec: options.timeoutSec,
      task: invocation.task,
    });
    const env = buildAgentEnv({
      baseEnv: options.baseEnv ?? process.env,
      configDir: options.configDir,
      dataDir: options.dataDir,
      maxOldSpaceMb: options.maxOldSpaceMb,
    });

    const spawnImpl: SpawnFn =
      options.spawnImpl ?? ((bin, args, opts) => spawn(bin, args, opts) as unknown as SpawnedProcess);
    const [bin, ...rest] = cmd;
    const { stdout, stderr, code, timedOut } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawnImpl(bin ?? options.cli, rest, { env });
      let out = '';
      let err = '';
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        resolve({ stdout: out, stderr: err, code: null, timedOut: true });
      }, (options.timeoutSec + 60) * 1000);
      child.stdout?.on('data', (chunk: Buffer | string) => {
        out += String(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        err += String(chunk);
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout: out, stderr: `${err}${String(error)}`, code: null, timedOut: false });
      });
      child.on('close', (closeCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout: out, stderr: err, code: closeCode, timedOut: false });
      });
    });

    if (timedOut) {
      return { ok: false, reason: 'timeout', detail: 'агент не уложился в таймаут', payload: null };
    }

    const payload = parseAgentPayload(stdout);
    if (!payload) {
      const tail = stderr.trim().slice(0, 200);
      return {
        ok: false,
        reason: 'no_payload',
        detail: `CLI не вернул JSON-объект (код ${code ?? '—'})${tail ? `: ${tail}` : ''}`,
        payload: null,
      };
    }
    const status = String(payload.status ?? '');
    if (status !== 'succeeded') {
      const detail =
        typeof payload.error === 'string'
          ? payload.error
          : String(payload.error?.message ?? status ?? 'агент не справился');
      return {
        ok: false,
        reason: status || 'agent_failed',
        detail: `${detail.slice(0, 260)} (код ${code ?? '—'})`,
        payload,
      };
    }

    let text = String(payload.output ?? '').trim();
    if (!text) {
      text = (await readFile(answerFile, 'utf8').catch(() => '')).trim();
    }
    if (!text && payload.result != null) {
      text = typeof payload.result === 'string' ? payload.result.trim() : JSON.stringify(payload.result);
    }
    if (!text) {
      return { ok: false, reason: 'empty_response', detail: 'агент не вернул текста', payload };
    }
    return { ok: true, text, payload };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
