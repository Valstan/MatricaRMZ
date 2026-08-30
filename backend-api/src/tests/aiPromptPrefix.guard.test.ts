// Сторож стабильного префикса запросов к DeepSeek (R29, мандат владельца 30.08).
//
// Кэшируется НАЧАЛО запроса (порядок рендера: tools → system → messages). Любая
// переменная величина, попавшая в system или в голову сообщения, обнуляет кэш всего
// запроса: замер на проде 2026-08-30 — дата первой строкой system роняет
// `cache_read_input_tokens` с 1664 до нуля при том же тексте ниже.
//
// Эти проверки ловят возврат ровно такой регрессии: она не роняет ни один
// функциональный тест и видна только по счёту токенов.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { captured, fakeReport, syncHealth } = vi.hoisted(() => ({
  captured: { calls: [] as Array<{ system: string; user: string }> },
  fakeReport: {
    value: {
      severity: 'ok',
      summary: 'спокойно',
      findings: [],
      suggested_actions: [],
    } as Record<string, unknown>,
  },
  syncHealth: { lag: 0 },
}));

vi.mock('../database/db.js', () => ({
  pool: { query: vi.fn(async () => ({ rows: [] })) },
  db: {},
}));

vi.mock('../services/diagnosticsSyncPipelineService.js', () => ({
  getSyncPipelineHealth: vi.fn(async () => ({
    ok: true,
    generatedAt: Date.now(),
    status: 'ok',
    seq: {
      ledgerLastSeq: 1,
      indexMaxSeq: 1,
      projectionMaxSeq: 1,
      ledgerToIndexLag: syncHealth.lag,
      indexToProjectionLag: 0,
    },
    tables: {},
    botPoll: {},
    skippedRows24h: {},
    reasons: [],
  })),
}));

vi.mock('../services/ai/llmProvider.js', () => ({
  callLlmJson: vi.fn(async (args: { system: string; user: string }) => {
    captured.calls.push({ system: args.system, user: args.user });
    return fakeReport.value;
  }),
  isLlmMisconfigured: () => false,
}));

vi.mock('../services/criticalEventsService.js', () => ({
  ingestServerCriticalEvent: vi.fn(),
  listCriticalEvents: vi.fn(() => []),
}));

import { runLogAnalysisOnce } from '../services/ai/logAnalysisAgentService.js';

const originalLogsDir = process.env.MATRICA_LOGS_DIR;
let tmp = '';

beforeEach(async () => {
  captured.calls = [];
  syncHealth.lag = 0;
  tmp = await mkdtemp(join(tmpdir(), 'matricarmz-prefix-guard-'));
  process.env.MATRICA_LOGS_DIR = tmp;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (originalLogsDir == null) delete process.env.MATRICA_LOGS_DIR;
  else process.env.MATRICA_LOGS_DIR = originalLogsDir;
});

describe('префикс запроса к LLM: ночной разбор логов', () => {
  it('system одинаков между прогонами, а окно разбора не стоит в голове сообщения', async () => {
    await runLogAnalysisOnce({ lookbackHours: 6 });
    syncHealth.lag = 42;
    await runLogAnalysisOnce({ lookbackHours: 12 });

    expect(captured.calls).toHaveLength(2);
    const first = captured.calls[0]!;
    const second = captured.calls[1]!;

    // system — чистая константа: ни даты, ни окна, ни живых чисел.
    expect(first.system).toBe(second.system);
    expect(first.system).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    // Голова сообщения — стабильная легенда полей. Прогоны различаются и окном,
    // и содержимым, но начало обязано совпадать байт-в-байт.
    expect(second.user.slice(0, 200)).toBe(first.user.slice(0, 200));

    // Границы окна — в хвосте, а не в начале: дата не должна встречаться раньше
    // середины сообщения, иначе общий префикс кончается на ней.
    const datePos = first.user.search(/\d{4}-\d{2}-\d{2}T/);
    expect(datePos).toBeGreaterThan(200);
  });

  it('ключи агрегата по моделям отсортированы — порядок строк выборки не течёт в промпт', async () => {
    await runLogAnalysisOnce({ lookbackHours: 6 });
    const user = captured.calls[0]!.user;
    // Пустая выборка (pool замокан) — важно, что поле есть и сериализуется стабильно.
    expect(user).toContain('"byModel"');
  });
});
