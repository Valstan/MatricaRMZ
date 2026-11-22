import { describe, expect, it } from 'vitest';

import { buildAgentArgs, buildAgentEnv, buildMcpConfig, parseExecResult } from './agentRunner.js';
import { profileDirs } from './agentProfile.js';

// Молчание — это не «спрятать окно», а набор флагов запуска: `windowsHide` и НЕ
// `detached` (грабля M214). Проверяем то, что реально уходит в процесс: аргументы,
// окружение (свои каталоги, чистка мёртвого прокси, потолок кучи) и разбор ответа.

describe('запуск локального агента', () => {
  it('аргументы mcode exec: разрешения выключены, ответ пишется в файл', () => {
    const args = buildAgentArgs({
      answerFile: 'answer.txt',
      systemPromptFile: 'system.txt',
      payloadFile: 'question.md',
      timeoutMs: 60_000,
      maxSteps: 8,
      model: 'minimax/MiniMax-M3.1-Flash',
    });
    expect(args[0]).toBe('exec');
    expect(args).toContain('--permission');
    expect(args[args.indexOf('--permission') + 1]).toBe('off');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args[args.indexOf('--output-last-message') + 1]).toBe('answer.txt');
    expect(args[args.indexOf('--system-prompt-file') + 1]).toBe('system.txt');
    expect(args[args.indexOf('--model') + 1]).toBe('minimax/MiniMax-M3.1-Flash');
    expect(args[args.indexOf('--timeout') + 1]).toBe('60s');
  });

  it('окружение: свои каталоги, прокси вычищен, куча ограничена', () => {
    const profile = profileDirs('C:\\profiles\\p1');
    const previousHttpProxy = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = 'http://127.0.0.1:10809';
    try {
      const env = buildAgentEnv(profile, 'C:\\profiles\\p1\\data\\mcode.log');
      expect(env.MCODE_CONFIG_DIR).toBe(profile.configDir);
      expect(env.MINIMAX_DATA_DIR).toBe(profile.dataDir);
      expect(env.MAVIS_DATA_DIR).toBe(profile.dataDir);
      expect(env.MCODE_LOG_FILE).toContain('mcode.log');
      expect(env.HTTP_PROXY).toBeUndefined();
      expect(env.NODE_OPTIONS).toContain('--max-old-space-size=');
      expect(env.NODE_OPTIONS).toContain('--dns-result-order=ipv4first');
    } finally {
      if (previousHttpProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = previousHttpProxy;
    }
  });

  it('конфиг MCP проекта: сервер базы с каналом и токеном', () => {
    const config = JSON.parse(
      buildMcpConfig({
        name: 'matrica-db',
        command: 'C:\\rt\\node.exe',
        args: ['C:\\rt\\matrica-db-mcp.mjs'],
        env: { MATRICA_DB_PIPE: '\\\\.\\pipe\\x', MATRICA_DB_TOKEN: 'tok' },
      }),
    );
    expect(Object.keys(config.mcpServers)).toEqual(['matrica-db']);
    expect(config.mcpServers['matrica-db'].command).toBe('C:\\rt\\node.exe');
    expect(config.mcpServers['matrica-db'].env.MATRICA_DB_TOKEN).toBe('tok');
  });

  it('без моста к базе конфиг MCP пустой, а не сломанный', () => {
    expect(JSON.parse(buildMcpConfig(null))).toEqual({ mcpServers: {} });
  });

  it('разбор ответа: берётся последняя строка exec.result', () => {
    const stdout = [
      '{"type":"exec.start"}',
      '{"type":"exec.result","status":"succeeded","output":"ответ агента"}',
      '{"type":"exec.log"}',
    ].join('\n');
    expect(parseExecResult(stdout)?.output).toBe('ответ агента');
  });

  it('нет exec.result — результата нет, это не «пустой ответ»', () => {
    expect(parseExecResult('что-то другое\n{не json}')).toBeNull();
  });
});
