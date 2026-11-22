import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  buildAgentCommand,
  buildAgentEnv,
  parseAgentPayload,
  runAgent,
  type SpawnFn,
} from './minimaxAgent.js';

function fakeSpawn(stdout: string, code = 0) {
  const calls: { cmd: string[]; options: { env: NodeJS.ProcessEnv } }[] = [];
  const spawnImpl = ((cmd: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd: [cmd, ...args], options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => {
      child.stdout.emit('data', stdout);
      child.emit('close', code);
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawnImpl, calls };
}

describe('buildAgentCommand', () => {
  it('собирает флаги как в рабочем прецеденте', () => {
    const cmd = buildAgentCommand({
      cli: 'mcode',
      systemFile: '/tmp/system.md',
      answerFile: '/tmp/answer.txt',
      payloadFile: '/tmp/payload.md',
      model: 'minimax/MiniMax-M3.1-Flash',
      maxSteps: 6,
      mode: 'standard',
      timeoutSec: 120,
      task: 'Ответь.',
    });
    expect(cmd).toEqual([
      'mcode',
      'exec',
      '--permission',
      'off',
      '--output-format',
      'json',
      '--output-last-message',
      '/tmp/answer.txt',
      '--system-prompt-file',
      '/tmp/system.md',
      '--max-steps',
      '6',
      '--mode',
      'standard',
      '--timeout',
      '120s',
      '--model',
      'minimax/MiniMax-M3.1-Flash',
      '--file',
      '/tmp/payload.md',
      'Ответь.',
    ]);
  });

  it('нативной схемы нет: у MiniMax она не работает', () => {
    const cmd = buildAgentCommand({
      cli: 'mcode',
      systemFile: '/tmp/s.md',
      answerFile: '/tmp/a.txt',
      payloadFile: '/tmp/p.md',
      model: 'minimax/MiniMax-M3.1-Flash',
      maxSteps: 6,
      mode: 'standard',
      timeoutSec: 120,
      task: 'x',
    });
    expect(cmd.join(' ')).not.toContain('--output-schema');
  });
});

describe('buildAgentEnv', () => {
  it('убирает прокси и ставит профиль, IPv4 и потолок кучи', () => {
    const env = buildAgentEnv({
      baseEnv: {
        HTTP_PROXY: 'http://proxy:10809',
        https_proxy: 'http://proxy:10809',
        PATH: '/usr/bin',
      } as NodeJS.ProcessEnv,
      configDir: '/opt/minimax-accounts/iivanych/config',
      dataDir: '/opt/minimax-accounts/iivanych/data',
      maxOldSpaceMb: 320,
    });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.MCODE_CONFIG_DIR).toBe('/opt/minimax-accounts/iivanych/config');
    expect(env.MAVIS_DATA_DIR).toBe('/opt/minimax-accounts/iivanych/data');
    expect(env.NODE_OPTIONS).toContain('--dns-result-order=ipv4first');
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=320');
  });
});

describe('parseAgentPayload', () => {
  it('берёт последний JSON-объект из stdout', () => {
    const payload = parseAgentPayload('служебное\n{"status":"succeeded","output":"готово"}');
    expect(payload?.status).toBe('succeeded');
    expect(payload?.output).toBe('готово');
  });

  it('мусор вместо JSON не превращается в объект', () => {
    expect(parseAgentPayload('ошибка: command not found')).toBeNull();
  });
});

describe('runAgent', () => {
  it('возвращает текст ответа агента', async () => {
    const { spawnImpl, calls } = fakeSpawn('{"status":"succeeded","output":"готово","usage":{"inputTokens":10,"outputTokens":5}}');
    const result = await runAgent(
      { system: 'system', user: 'user', task: 'Ответь.' },
      {
        cli: 'mcode',
        model: 'minimax/MiniMax-M3.1-Flash',
        maxSteps: 6,
        mode: 'standard',
        timeoutSec: 5,
        configDir: '/tmp/config',
        dataDir: '/tmp/data',
        maxOldSpaceMb: 320,
        baseEnv: {} as NodeJS.ProcessEnv,
        spawnImpl,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('готово');
      expect(result.payload.usage?.inputTokens).toBe(10);
    }
    expect(calls[0]!.cmd[1]).toBe('exec');
  });

  it('провал агента — честная причина, а не пустой ответ', async () => {
    const { spawnImpl } = fakeSpawn('{"status":"limit_exceeded","error":"не успел"}');
    const result = await runAgent(
      { system: 's', user: 'u', task: 't' },
      {
        cli: 'mcode',
        model: 'minimax/MiniMax-M3.1-Flash',
        maxSteps: 6,
        mode: 'standard',
        timeoutSec: 5,
        configDir: '/tmp/config',
        dataDir: '/tmp/data',
        maxOldSpaceMb: 320,
        baseEnv: {} as NodeJS.ProcessEnv,
        spawnImpl,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('limit_exceeded');
      expect(result.detail).toContain('не успел');
    }
  });

  it('CLI без JSON — это тоже провал, а не пустой успех', async () => {
    const { spawnImpl } = fakeSpawn('command not found');
    const result = await runAgent(
      { system: 's', user: 'u', task: 't' },
      {
        cli: 'mcode',
        model: 'minimax/MiniMax-M3.1-Flash',
        maxSteps: 6,
        mode: 'standard',
        timeoutSec: 5,
        configDir: '/tmp/config',
        dataDir: '/tmp/data',
        maxOldSpaceMb: 320,
        baseEnv: {} as NodeJS.ProcessEnv,
        spawnImpl,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_payload');
  });
});
