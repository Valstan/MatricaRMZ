import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { fakeReport, ingestSpy } = vi.hoisted(() => ({
  fakeReport: { value: null as null | Record<string, unknown> },
  ingestSpy: vi.fn(),
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
    seq: { ledgerLastSeq: 1, indexMaxSeq: 1, projectionMaxSeq: 1, ledgerToIndexLag: 0, indexToProjectionLag: 0 },
    tables: {},
    botPoll: {},
    skippedRows24h: {},
    reasons: [],
  })),
}));

vi.mock('../services/ai/claudeProvider.js', () => ({
  callClaudeJson: vi.fn(async () => fakeReport.value),
  isClaudeMisconfigured: () => false,
}));

vi.mock('../services/criticalEventsService.js', () => ({
  ingestServerCriticalEvent: ingestSpy,
  listCriticalEvents: vi.fn(() => []),
}));

import { runLogAnalysisOnce } from '../services/ai/logAnalysisAgentService.js';

const originalLogsDir = process.env.MATRICA_LOGS_DIR;
let tmp = '';

beforeEach(async () => {
  ingestSpy.mockReset();
  fakeReport.value = null;
  tmp = await mkdtemp(join(tmpdir(), 'matricarmz-log-analysis-'));
  process.env.MATRICA_LOGS_DIR = tmp;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (originalLogsDir == null) delete process.env.MATRICA_LOGS_DIR;
  else process.env.MATRICA_LOGS_DIR = originalLogsDir;
});

describe('logAnalysisAgentService.runLogAnalysisOnce', () => {
  it('does not emit critical event when severity is ok', async () => {
    fakeReport.value = {
      severity: 'ok',
      summary: 'Всё спокойно',
      findings: [],
      suggested_actions: [],
    };
    const res = await runLogAnalysisOnce({ lookbackHours: 12 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.emitted).toBe(false);
      expect(res.report.severity).toBe('ok');
    }
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('emits a "warn" critical event with proper eventCode and category', async () => {
    fakeReport.value = {
      severity: 'warn',
      summary: 'Растёт лаг sync pipeline',
      findings: [
        { what: 'indexToProjectionLag вырос до 500', why: 'клиенты получают устаревшие данные', recommendation: 'перезапустить projection worker' },
      ],
      suggested_actions: ['systemctl restart matricarmz-backend-primary'],
    };
    const res = await runLogAnalysisOnce({ lookbackHours: 12 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.emitted).toBe(true);
    expect(ingestSpy).toHaveBeenCalledOnce();
    const call = ingestSpy.mock.calls[0]![0];
    expect(call.eventCode).toBe('server.ai_log_analysis.report');
    expect(call.severity).toBe('warn');
    expect(call.category).toBe('backend');
    expect(call.title).toMatch(/Предупреждение/i);
    expect(call.humanMessage).toContain('Растёт лаг');
    expect(call.humanMessage).toContain('indexToProjectionLag');
    const details = call.aiDetails as { source: string; findings: unknown[] };
    expect(details.source).toBe('ai_log_analysis');
    expect(Array.isArray(details.findings)).toBe(true);
  });

  it('escalates critical severity to fatal in the emitted event', async () => {
    fakeReport.value = {
      severity: 'critical',
      summary: 'База упала, операции теряются',
      findings: [{ what: 'pg connection refused' }],
    };
    const res = await runLogAnalysisOnce({ lookbackHours: 12 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.emitted).toBe(true);
    expect(ingestSpy).toHaveBeenCalledOnce();
    const call = ingestSpy.mock.calls[0]![0];
    expect(call.severity).toBe('fatal');
    expect(call.title).toMatch(/Критика/i);
  });

  it('returns ok:false when claude returns null', async () => {
    fakeReport.value = null;
    const res = await runLogAnalysisOnce({ lookbackHours: 12 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Claude/);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('coerces unknown severity into warn but still emits an event', async () => {
    fakeReport.value = { severity: 'mystery', summary: 'странное' } as any;
    const res = await runLogAnalysisOnce({ lookbackHours: 12 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.report.severity).toBe('warn');
      expect(res.emitted).toBe(true);
    }
    expect(ingestSpy).toHaveBeenCalledOnce();
  });
});
