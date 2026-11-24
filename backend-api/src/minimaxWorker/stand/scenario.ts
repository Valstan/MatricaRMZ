// Сценарий стенда воркера MiniMax: заглушка «Кармана» + настоящий воркер.
//
// ⚠️ Подменяется ровно одно — внешний бинарь `mcode`: вендорского CLI на машине
// разработчика нет и на стенде быть не может. Всё остальное настоящее:
//   - клиент пула (`karmanPool.ts`) ходит HTTP-ом в заглушку «Кармана»;
//   - токен пула подменён константой — в комнату «Кармана» стенд не ходит;
//   - профиль пишет настоящий `materializeProfile` (во временный каталог);
//   - команду CLI собирает и ответ разбирает настоящий `runAgent`;
//   - ответ превращается в `tool_use` настоящим шейпером.
//
// Сценарий поднимает воркер на свободном порту (`listen(0)`) и снимает с
// заглушки счётчики ручек: по ним видно, что воркер дёргал ровно то, что надо.

import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Express } from 'express';

import { materializeProfile } from '../agentProfile.js';
import type { AnthropicToolDef } from '../agentPrompt.js';
import { loadConfig } from '../config.js';
import { renewAccount, reportActivation, takeAccount } from '../karmanPool.js';
import { runAgent, type SpawnFn } from '../minimaxAgent.js';
import { createWorkerApp, type WorkerDeps } from '../server.js';
import {
  createKarmanStub,
  STUB_POOL_TOKEN,
  type KarmanStubOptions,
  type PoolCallCounts,
} from './karmanStub.js';

/** Токен доступа к самому воркеру на стенде (настоящий — в комнате Кармана). */
const STAND_SERVICE_TOKEN = 'stand-worker-token';

/** Окружение подставного CLI: его собирает настоящий `runAgent` (прокси вычищает). */
const STAND_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };

/** Инструмент по умолчанию: его имя должно доехать до ответа блоком `tool_use`. */
const DEFAULT_TOOLS: AnthropicToolDef[] = [
  {
    name: 'find_engine',
    description: 'поиск двигателей',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

/** Что отвечает подставной CLI в очередном прогоне. */
export type AgentPlan = {
  /** Текст ответа агента: уходит в `output` или в файл ответа (по `viaFile`). */
  text?: string;
  /** Ответ приходит файлом `--output-last-message`, а не в stdout. */
  viaFile?: boolean;
  /** Статус прогона CLI (`succeeded` — успех). */
  status?: string;
  /** Текст ошибки — при статусе не `succeeded`. */
  error?: string;
  /** Код завершения процесса. */
  exitCode?: number;
};

export type FakeSpawnCall = {
  /** Команда, как её собрал настоящий `runAgent`. */
  cmd: string[];
  /** Окружение запуска — как его собрал настоящий `runAgent`. */
  env: NodeJS.ProcessEnv;
  plan: AgentPlan;
};

export type FakeSpawner = {
  spawnImpl: SpawnFn;
  calls: FakeSpawnCall[];
};

/** stdout подставного CLI: полезный объект — последняя строка, как у настоящего. */
function stdoutOf(plan: AgentPlan): string {
  const payload: Record<string, unknown> = {
    status: plan.status ?? 'succeeded',
    usage: { inputTokens: 120, outputTokens: 40 },
  };
  if (plan.error) payload.error = plan.error;
  if (plan.text && !plan.viaFile) payload.output = plan.text;
  return `${JSON.stringify(payload)}\n`;
}

/** Ответ файлом `--output-last-message` — так тоже умеет настоящий CLI. */
async function writeAnswerFile(plan: AgentPlan, args: string[]): Promise<void> {
  if (!plan.viaFile || !plan.text) return;
  const index = args.indexOf('--output-last-message');
  const target = index >= 0 ? args[index + 1] : undefined;
  if (!target) return;
  await writeFile(target, plan.text, 'utf8');
}

/**
 * Подставной процесс `mcode`.
 *
 * ⚠️ Это единственная подмена на стенде: бинарь вендора. Команду, файлы задачи,
 * окружение и разбор ответа по-прежнему делает настоящий `runAgent`.
 */
function createFakeSpawner(plans: AgentPlan[]): FakeSpawner {
  const calls: FakeSpawnCall[] = [];
  const spawnImpl = ((cmd: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const plan = plans[calls.length] ?? {
      status: 'succeeded',
      text: '{"text":"(план агента кончился)"}',
    };
    calls.push({ cmd: [cmd, ...args], env: options.env, plan });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => {
      void writeAnswerFile(plan, args).then(() => {
        child.stdout.emit('data', stdoutOf(plan));
        child.emit('close', plan.exitCode ?? 0);
      });
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawnImpl, calls };
}

/** Что стенд насмотрел за одним прогоном. */
export type ScenarioFacts = {
  /** HTTP-статус ответа воркера. */
  status: number;
  /** Тело ответа воркера. */
  body: Record<string, unknown>;
  /** Блоки `content` из ответа (пусто, если ответ не 200). */
  blocks: Array<Record<string, unknown>>;
  /** Счётчики ручек пула. */
  pool: PoolCallCounts;
  /** Сколько раз поднимался CLI-агент. */
  agentRuns: number;
  /** Аккаунты, выданные пулом (по порядку). */
  issuedAccountIds: number[];
  /** Аккаунты, у которых продлевали цепочку входа. */
  renewedAccountIds: number[];
  /** `exclude` из последнего запроса `available`. */
  lastExclude: number[];
  /** Команда CLI из последнего прогона (её собрал настоящий `runAgent`). */
  lastAgentCommand: string[];
  /** Куда лег токен-стор профиля. */
  profilePath: string | null;
};

/** Одна проверка сценария: что должно было получиться — и получилось ли. */
export type ScenarioCheck = { label: string; ok: boolean };

export type ScenarioResult = {
  key: string;
  title: string;
  facts: ScenarioFacts;
  checks: ScenarioCheck[];
  /** Итог: все проверки прошли. */
  ok: boolean;
  /** Отчёт по шагам — по-русски, для человека. */
  lines: string[];
};

async function listen(app: Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (e) => reject(e));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Keep-alive-сокеты клиента (fetch) не дают серверу закрыться — рвём их.
    server.closeAllConnections();
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function parseJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { error: raw.slice(0, 300) };
  }
}

/**
 * Один прогон: заглушка «Кармана» + настоящий воркер + один запрос.
 *
 * Каталог профилей — временный (`mkdtemp`), и он убирается в конце: на машине
 * разработчика не остаётся ни токен-стора, ни профилей.
 */
async function runScenario(params: {
  stub: KarmanStubOptions;
  plans: AgentPlan[];
  request?: { question?: string; tools?: AnthropicToolDef[] };
}): Promise<ScenarioFacts> {
  const stub = createKarmanStub(params.stub);
  const poolBase = await stub.start();
  const accountsDir = await mkdtemp(path.join(tmpdir(), 'matricarmz-minimax-stand-'));
  const spawner = createFakeSpawner(params.plans);
  let worker: { server: Server; base: string } | null = null;
  try {
    const config = loadConfig({
      KARMAN_MINIMAX_API_URL: poolBase,
      MATRICA_MINIMAX_WORKER_TOKEN: STAND_SERVICE_TOKEN,
      MINIMAX_ACCOUNTS_DIR: accountsDir,
      MINIMAX_AREA: 'stand',
      MINIMAX_CLI: 'mcode',
      MINIMAX_MODEL: 'minimax/MiniMax-M3.1-Flash',
      MINIMAX_TIMEOUT: '30',
    });

    const deps: Partial<WorkerDeps> = {
      // Токен пула на стенде — константа: в комнату «Кармана» стенд не ходит.
      resolveToken: async () => STUB_POOL_TOKEN,
      // Клиент пула — настоящий (`karmanPool.ts`); адрес указывает на заглушку.
      takeAccount: (options) => takeAccount(options),
      renewAccount: (options, accountId) => renewAccount(options, accountId),
      reportActivation: (options, payload) => reportActivation(options, payload),
      // Профиль — настоящий: токен-стор ложится во временный каталог стенда.
      materializeProfile,
      // Агент — настоящий `runAgent`; подменён только запуск бинаря `mcode`.
      runAgent: (invocation, options) =>
        runAgent(invocation, { ...options, baseEnv: STAND_ENV, spawnImpl: spawner.spawnImpl }),
    };

    const { app } = createWorkerApp(config, deps);
    worker = await listen(app);

    const res = await fetch(`${worker.base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${STAND_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'minimax-m3.1-flash',
        max_tokens: 512,
        system: [{ type: 'text', text: 'Ты ИИваныч — помощник по заводу.' }],
        messages: [
          {
            role: 'user',
            content: params.request?.question ?? 'Сколько двигателей на заводе?',
          },
        ],
        tools: params.request?.tools ?? DEFAULT_TOOLS,
      }),
    });

    const body = parseJson(await res.text());
    const profilePath = path.join(
      accountsDir,
      config.area,
      'data',
      'auth',
      'prod',
      'en',
      'mcode-public',
      'auth.json',
    );

    return {
      status: res.status,
      body,
      blocks: Array.isArray(body.content) ? (body.content as Array<Record<string, unknown>>) : [],
      pool: { ...stub.calls },
      agentRuns: spawner.calls.length,
      issuedAccountIds: [...stub.issuedAccountIds],
      renewedAccountIds: [...stub.renewedAccountIds],
      lastExclude: [...stub.lastExclude],
      lastAgentCommand: spawner.calls[spawner.calls.length - 1]?.cmd ?? [],
      profilePath: (await exists(profilePath)) ? profilePath : null,
    };
  } finally {
    if (worker) await closeServer(worker.server);
    await stub.stop();
    await rm(accountsDir, { recursive: true, force: true });
  }
}

function textOf(facts: ScenarioFacts): string {
  const block = facts.blocks.find((b) => b.type === 'text');
  return typeof block?.text === 'string' ? block.text : '';
}

function toolOf(facts: ScenarioFacts, name: string): Record<string, unknown> | null {
  return facts.blocks.find((b) => b.type === 'tool_use' && b.name === name) ?? null;
}

function commonLines(facts: ScenarioFacts): string[] {
  const renewed = facts.renewedAccountIds.length
    ? `, продлены ${facts.renewedAccountIds.join(', ')}`
    : '';
  return [
    `воркер    : POST /v1/messages → ${facts.status}`,
    `пул       : available=${facts.pool.available}, renew=${facts.pool.renew}, activations=${facts.pool.activations}`,
    `аккаунты  : выданы ${facts.issuedAccountIds.join(', ') || '—'}${renewed}`,
    `агент     : запусков ${facts.agentRuns}`,
  ];
}

function answerLines(facts: ScenarioFacts): string[] {
  if (!facts.blocks.length) return ['ответ     : (блоков content нет)'];
  return facts.blocks.map((block) =>
    block.type === 'tool_use'
      ? `ответ     : tool_use «${String(block.name ?? '')}» ${JSON.stringify(block.input ?? {})}`
      : `ответ     : text «${String(block.text ?? '')}»`,
  );
}

function reasonLine(facts: ScenarioFacts): string {
  return `причина   : ${String(facts.body.reason ?? '—')} (retryAfterMs=${String(facts.body.retryAfterMs ?? '—')})`;
}

/** Сценарий a: успех — пул отдал аккаунт, агент ответил, ответ разобран в блоки. */
export async function scenarioSuccess(): Promise<ScenarioResult> {
  const facts = await runScenario({
    stub: { accounts: [{ id: 101, email: 'stand-101@example.invalid', pointsNext: 1500 }] },
    plans: [
      {
        text: JSON.stringify({
          text: 'Сейчас посмотрю по базе.',
          tool_use: { name: 'find_engine', input: { query: 'двигатель' } },
        }),
      },
    ],
  });
  const checks: ScenarioCheck[] = [
    { label: 'воркер ответил 200', ok: facts.status === 200 },
    { label: 'в ответе есть блок text с ответом агента', ok: textOf(facts).length > 0 },
    { label: 'в ответе есть блок tool_use «find_engine»', ok: toolOf(facts, 'find_engine') !== null },
    { label: 'пул отдал аккаунт один раз', ok: facts.pool.available === 1 },
    { label: 'активация отмечена в журнале Кармана', ok: facts.pool.activations === 1 },
    { label: 'агент запущен один раз', ok: facts.agentRuns === 1 },
    { label: 'профиль аккаунта записан', ok: facts.profilePath !== null },
  ];
  return {
    key: 'success',
    title: 'успех: аккаунт взят, агент ответил',
    facts,
    checks,
    ok: checks.every((c) => c.ok),
    lines: [...commonLines(facts), ...answerLines(facts)],
  };
}

/** Сценарий b: пустой пул — честная пустота, а не «всё сломалось». */
export async function scenarioEmptyPool(): Promise<ScenarioResult> {
  const facts = await runScenario({
    stub: { emptyReason: 'no_free_accounts', accounts: [] },
    plans: [],
  });
  const checks: ScenarioCheck[] = [
    { label: 'воркер ответил 503', ok: facts.status === 503 },
    { label: 'причина в ответе — pool_empty', ok: facts.body.reason === 'pool_empty' },
    { label: 'сказано, когда повторить', ok: Number(facts.body.retryAfterMs ?? 0) > 0 },
    { label: 'агент не запускался', ok: facts.agentRuns === 0 },
    { label: 'пул опрошен один раз', ok: facts.pool.available === 1 },
  ];
  return {
    key: 'pool_empty',
    title: 'пустой пул: свободных аккаунтов нет',
    facts,
    checks,
    ok: checks.every((c) => c.ok),
    lines: [...commonLines(facts), reasonLine(facts)],
  };
}

/** Сценарий c: аккаунты есть, а пары токенов нет — причина видна в ответе. */
export async function scenarioNoTokens(): Promise<ScenarioResult> {
  const facts = await runScenario({
    stub: {
      emptyReason: 'no_tokens_ready',
      accounts: [{ id: 301, email: 'stand-301@example.invalid' }],
    },
    plans: [],
  });
  const checks: ScenarioCheck[] = [
    { label: 'воркер ответил 503', ok: facts.status === 503 },
    { label: 'причина в ответе — pool_no_tokens', ok: facts.body.reason === 'pool_no_tokens' },
    { label: 'сказано, когда повторить', ok: Number(facts.body.retryAfterMs ?? 0) > 0 },
    { label: 'агент не запускался', ok: facts.agentRuns === 0 },
    { label: 'пул опрошен один раз', ok: facts.pool.available === 1 },
  ];
  return {
    key: 'pool_no_tokens',
    title: 'нет пары токенов: вход ждёт владельца',
    facts,
    checks,
    ok: checks.every((c) => c.ok),
    lines: [...commonLines(facts), reasonLine(facts)],
  };
}

/** Сценарий d: аккаунт отказал (401) — воркер выбрасывает его и берёт следующий. */
export async function scenarioAccountRejected(): Promise<ScenarioResult> {
  const facts = await runScenario({
    stub: {
      accounts: [
        { id: 101, email: 'stand-101@example.invalid' },
        { id: 102, email: 'stand-102@example.invalid' },
      ],
    },
    plans: [
      { status: 'failed', error: '401 unauthorized', exitCode: 1 },
      { text: '{"text":"Ответ со второго аккаунта"}' },
    ],
  });
  const checks: ScenarioCheck[] = [
    { label: 'воркер ответил 200 после повтора', ok: facts.status === 200 },
    { label: 'в ответе — ответ второго аккаунта', ok: textOf(facts).includes('второго аккаунта') },
    { label: 'пул отдал два аккаунта', ok: facts.issuedAccountIds.length === 2 },
    { label: 'первый аккаунт ушёл в exclude', ok: facts.lastExclude.includes(101) },
    { label: 'агент запущен дважды', ok: facts.agentRuns === 2 },
    { label: 'цепочку входа не продлевали', ok: facts.pool.renew === 0 },
  ];
  return {
    key: 'account_rejected',
    title: 'отказ аккаунта: берём следующий и повторяем',
    facts,
    checks,
    ok: checks.every((c) => c.ok),
    lines: [
      ...commonLines(facts),
      `exclude   : ${facts.lastExclude.join(', ') || '—'}`,
      ...answerLines(facts),
    ],
  };
}

/** Сценарий e: вход скоро истечёт — продлеваем цепочку, а не берём новый аккаунт. */
export async function scenarioRenewal(): Promise<ScenarioResult> {
  const facts = await runScenario({
    stub: {
      // Вход почти истёк (минута): окно продления у воркера — 5 минут.
      accounts: [{ id: 201, email: 'stand-201@example.invalid', expiresInMs: 60_000 }],
    },
    // Ответ агента приходит файлом (`--output-last-message`) — так тоже умеет
    // настоящий CLI, и этот путь разбора должен быть проверен наравне с stdout.
    plans: [{ text: '{"text":"Ответ после продления"}', viaFile: true }],
  });
  const checks: ScenarioCheck[] = [
    { label: 'воркер ответил 200', ok: facts.status === 200 },
    { label: 'цепочку входа продлили', ok: facts.pool.renew === 1 },
    { label: 'продлён тот же аккаунт', ok: facts.renewedAccountIds[0] === 201 },
    { label: 'новый аккаунт не брали', ok: facts.pool.available === 1 },
    { label: 'агент запущен один раз', ok: facts.agentRuns === 1 },
  ];
  return {
    key: 'renewal',
    title: 'продление цепочки входа: тот же аккаунт',
    facts,
    checks,
    ok: checks.every((c) => c.ok),
    lines: [...commonLines(facts), ...answerLines(facts)],
  };
}

export type StandScenario = {
  key: string;
  title: string;
  run: () => Promise<ScenarioResult>;
};

/** Порядок сценариев на стенде — от «всё хорошо» к «почти всё хорошо». */
export const STAND_SCENARIOS: StandScenario[] = [
  { key: 'success', title: 'успех: аккаунт взят, агент ответил', run: scenarioSuccess },
  { key: 'pool_empty', title: 'пустой пул: свободных аккаунтов нет', run: scenarioEmptyPool },
  { key: 'pool_no_tokens', title: 'нет пары токенов: вход ждёт владельца', run: scenarioNoTokens },
  {
    key: 'account_rejected',
    title: 'отказ аккаунта: берём следующий и повторяем',
    run: scenarioAccountRejected,
  },
  { key: 'renewal', title: 'продление цепочки входа: тот же аккаунт', run: scenarioRenewal },
];

/** Прогнать все сценарии подряд — так стенд и работает. */
export async function runStand(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of STAND_SCENARIOS) {
    results.push(await scenario.run());
  }
  return results;
}
