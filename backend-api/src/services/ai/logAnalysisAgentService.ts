import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { pool } from '../../database/db.js';
import { ingestServerCriticalEvent, listCriticalEvents } from '../criticalEventsService.js';
import { getSyncPipelineHealth } from '../diagnosticsSyncPipelineService.js';
import { logError, logInfo } from '../../utils/logger.js';
import { AI_ENABLED, CLAUDE_MODEL_ANALYTICS, CLAUDE_TIMEOUT_ANALYTICS_MS, nowMs } from './common.js';
import { callClaudeJson, isClaudeMisconfigured } from './claudeProvider.js';

const DEFAULT_TIME_ZONE = 'Europe/Moscow';
const DEFAULT_TIMES = ['06:00', '18:00'];
const DEFAULT_LOOKBACK_HOURS = 12;
const TICK_MS = 60_000;
const MAX_LOG_LINES = 100;
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AI_DETAILS_BYTES = 16_000;

type TimeParts = { year: number; month: number; day: number; hour: number; minute: number };

type AssistMetricsAgg = {
  total: number;
  errors: number;
  timeouts: number;
  byModel: Record<string, number>;
  escalated: number;
};

export type LogAnalysisContext = {
  rangeSinceMs: number;
  rangeUntilMs: number;
  timeZone: string;
  criticalEventCount: number;
  criticalEventsTop: Array<{ severity: string; category: string; title: string; eventCode: string }>;
  syncPipeline: { status: string; reasons: string[]; ledgerToIndexLag: number; indexToProjectionLag: number };
  assistMetrics: AssistMetricsAgg;
  recentLogLines: string[];
};

export type LogAnalysisFinding = {
  what: string;
  why?: string;
  recommendation?: string;
};

export type LogAnalysisReport = {
  severity: 'ok' | 'warn' | 'critical';
  summary: string;
  findings: LogAnalysisFinding[];
  suggested_actions?: string[];
};

function parseTime(value: string): string | null {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseTimes(raw: string | undefined | null): string[] {
  if (!raw) return DEFAULT_TIMES;
  const parts = raw
    .split(',')
    .map((p) => parseTime(p))
    .filter((p): p is string => Boolean(p));
  return parts.length ? Array.from(new Set(parts)) : DEFAULT_TIMES;
}

function getTimeParts(timeZone: string): TimeParts {
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const map = new Map(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.get('year') ?? 0),
    month: Number(map.get('month') ?? 0),
    day: Number(map.get('day') ?? 0),
    hour: Number(map.get('hour') ?? 0),
    minute: Number(map.get('minute') ?? 0),
  };
}

function formatDateKey(parts: TimeParts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function formatTimeKey(parts: TimeParts) {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function logsDir(): string {
  return process.env.MATRICA_LOGS_DIR?.trim() || 'logs';
}

async function loadRecentServerLogLines(maxLines = MAX_LOG_LINES): Promise<string[]> {
  try {
    const dir = logsDir();
    const entries = await readdir(dir).catch(() => [] as string[]);
    const candidates = entries
      .filter((f) => /^server.*\.log(\.\d+)?$/i.test(f))
      .sort()
      .reverse()
      .slice(0, 3);
    const collected: string[] = [];
    for (const file of candidates) {
      const path = join(dir, file);
      try {
        const content = await readFile(path, { encoding: 'utf8' });
        const slice = content.length > MAX_LOG_FILE_BYTES ? content.slice(-MAX_LOG_FILE_BYTES) : content;
        const lines = slice
          .split(/\r?\n/)
          .filter((l) => /\b(error|warn|warning|fatal|critical|ошибк)\b/i.test(l));
        for (const line of lines.slice(-maxLines)) {
          collected.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
          if (collected.length >= maxLines) break;
        }
      } catch {
        // ignore unreadable file
      }
      if (collected.length >= maxLines) break;
    }
    return collected;
  } catch {
    return [];
  }
}

async function loadAssistMetrics(rangeSinceMs: number, rangeUntilMs: number): Promise<AssistMetricsAgg> {
  const agg: AssistMetricsAgg = { total: 0, errors: 0, timeouts: 0, byModel: {}, escalated: 0 };
  try {
    const res = await pool.query(
      `select payload_json from diagnostics_snapshots
        where scope = 'ai_agent_metrics' and created_at >= $1 and created_at <= $2
        order by created_at desc limit 5000`,
      [rangeSinceMs, rangeUntilMs],
    );
    for (const row of res.rows ?? []) {
      let parsed: any;
      try {
        parsed = JSON.parse((row as any).payload_json ?? 'null');
      } catch {
        continue;
      }
      if (!parsed) continue;
      agg.total += 1;
      if (parsed.ok === false) agg.errors += 1;
      if (parsed.timeout === true) agg.timeouts += 1;
      if (parsed.escalated === true) agg.escalated += 1;
      const model = String(parsed.model ?? '').trim();
      if (model) agg.byModel[model] = (agg.byModel[model] ?? 0) + 1;
    }
  } catch {
    // db error — leave zeroed
  }
  return agg;
}

function pickTopCriticalEvents(events: ReturnType<typeof listCriticalEvents>, sinceMs: number) {
  return events
    .filter((e) => e.createdAt >= sinceMs)
    .slice(0, 20)
    .map((e) => ({
      severity: e.severity,
      category: e.category,
      title: e.title,
      eventCode: e.eventCode,
    }));
}

export async function collectLogAnalysisContext(args?: { lookbackHours?: number; timeZone?: string }): Promise<LogAnalysisContext> {
  const timeZone = args?.timeZone || DEFAULT_TIME_ZONE;
  const lookbackHours = Math.max(1, Math.min(72, args?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS));
  const untilMs = nowMs();
  const sinceMs = untilMs - lookbackHours * 60 * 60 * 1000;

  const [criticalEvents, syncHealth, assistMetrics, recentLogLines] = await Promise.all([
    Promise.resolve(listCriticalEvents({ days: Math.ceil(lookbackHours / 24) + 1, limit: 200 })),
    getSyncPipelineHealth().catch(() => null),
    loadAssistMetrics(sinceMs, untilMs),
    loadRecentServerLogLines(),
  ]);

  return {
    rangeSinceMs: sinceMs,
    rangeUntilMs: untilMs,
    timeZone,
    criticalEventCount: criticalEvents.length,
    criticalEventsTop: pickTopCriticalEvents(criticalEvents, sinceMs),
    syncPipeline: syncHealth
      ? {
          status: syncHealth.status,
          reasons: syncHealth.reasons,
          ledgerToIndexLag: syncHealth.seq.ledgerToIndexLag,
          indexToProjectionLag: syncHealth.seq.indexToProjectionLag,
        }
      : { status: 'unknown', reasons: ['sync pipeline health unavailable'], ledgerToIndexLag: 0, indexToProjectionLag: 0 },
    assistMetrics,
    recentLogLines,
  };
}

function buildPrompt(ctx: LogAnalysisContext): { system: string; user: string } {
  const system =
    'Ты SRE-аналитик для production-сервера ERP Матрица РМЗ. Тебе дают сводку логов и метрик ' +
    'за последние часы. Твоя задача — оценить severity (ok / warn / critical), кратко описать ' +
    'находки и предложить действия. Отвечай на русском. Если всё спокойно — severity=ok, summary ' +
    'из 1-2 фраз, findings и suggested_actions могут быть пустыми. Если есть тревога — каждой ' +
    'находке давай what (что произошло), why (почему важно) и recommendation (что сделать).';
  const user = JSON.stringify(
    {
      range: {
        sinceIso: new Date(ctx.rangeSinceMs).toISOString(),
        untilIso: new Date(ctx.rangeUntilMs).toISOString(),
        hours: Math.round((ctx.rangeUntilMs - ctx.rangeSinceMs) / 3600_000),
      },
      criticalEvents: {
        count: ctx.criticalEventCount,
        top: ctx.criticalEventsTop,
      },
      syncPipeline: ctx.syncPipeline,
      assistMetrics: ctx.assistMetrics,
      recentLogLines: ctx.recentLogLines.slice(-MAX_LOG_LINES),
    },
    null,
    2,
  );
  return { system, user };
}

function clipDetails(payload: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(payload);
  if (json.length <= MAX_AI_DETAILS_BYTES) return payload;
  return { ...payload, truncated: true, originalBytes: json.length };
}

export async function runLogAnalysisOnce(args?: { lookbackHours?: number; timeZone?: string }): Promise<{
  ok: true;
  report: LogAnalysisReport;
  contextRange: { sinceMs: number; untilMs: number };
  emitted: boolean;
} | { ok: false; error: string }> {
  if (!AI_ENABLED) {
    return { ok: false, error: 'AI отключён администратором (AI_ENABLED=false)' };
  }
  const context = await collectLogAnalysisContext(args);
  const { system, user } = buildPrompt(context);

  let report: LogAnalysisReport | null;
  try {
    report = await callClaudeJson<LogAnalysisReport>({
      model: CLAUDE_MODEL_ANALYTICS,
      system,
      user,
      toolName: 'submit_log_analysis_report',
      toolDescription: 'Сформируй структурированный отчёт о состоянии сервера по предоставленным данным.',
      schema: {
        properties: {
          severity: {
            type: 'string',
            enum: ['ok', 'warn', 'critical'],
            description: 'Общая оценка состояния сервера.',
          },
          summary: { type: 'string', description: 'Краткое описание (1-3 фразы) состояния.' },
          findings: {
            type: 'array',
            description: 'Список конкретных находок (если severity != ok).',
            items: {
              type: 'object',
              properties: {
                what: { type: 'string' },
                why: { type: 'string' },
                recommendation: { type: 'string' },
              },
              required: ['what'],
            },
          },
          suggested_actions: {
            type: 'array',
            description: 'Короткие шаги для оператора.',
            items: { type: 'string' },
          },
        },
        required: ['severity', 'summary'],
      },
      options: { timeoutMs: CLAUDE_TIMEOUT_ANALYTICS_MS, temperature: 0, maxTokens: 2048 },
    });
  } catch (err) {
    if (isClaudeMisconfigured(err)) {
      return { ok: false, error: 'MATRICA_AI_CLAUDE_API_KEY не задан' };
    }
    return { ok: false, error: String(err) };
  }
  if (!report || typeof report !== 'object') {
    return { ok: false, error: 'Claude не вернул отчёт' };
  }
  const severity = report.severity === 'critical' || report.severity === 'warn' || report.severity === 'ok' ? report.severity : 'warn';
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const summary = String(report.summary ?? '').trim() || 'Без подробностей.';

  let emitted = false;
  if (severity !== 'ok') {
    const mappedSeverity = severity === 'critical' ? 'fatal' : 'warn';
    const title = severity === 'critical' ? 'Критика в логах сервера (AI-анализ)' : 'Предупреждение в логах (AI-анализ)';
    const findingsText = findings
      .slice(0, 10)
      .map((f, i) => {
        const lines = [`${i + 1}. ${f.what ?? '?'}`];
        if (f.why) lines.push(`   Почему важно: ${f.why}`);
        if (f.recommendation) lines.push(`   Рекомендация: ${f.recommendation}`);
        return lines.join('\n');
      })
      .join('\n');
    const humanMessage = [summary, findingsText && '', findingsText].filter(Boolean).join('\n').slice(0, 2000);
    ingestServerCriticalEvent({
      eventCode: 'server.ai_log_analysis.report',
      title,
      humanMessage: humanMessage || summary,
      category: 'backend',
      severity: mappedSeverity,
      dedupMessage: `ai_log_analysis|${severity}|${summary.slice(0, 200)}`,
      aiDetails: clipDetails({
        source: 'ai_log_analysis',
        severity,
        summary,
        findings: findings.slice(0, 10),
        suggestedActions: Array.isArray(report.suggested_actions) ? report.suggested_actions.slice(0, 10) : [],
        contextRange: {
          sinceIso: new Date(context.rangeSinceMs).toISOString(),
          untilIso: new Date(context.rangeUntilMs).toISOString(),
        },
        assistMetrics: context.assistMetrics,
        syncPipeline: context.syncPipeline,
        criticalEventCount: context.criticalEventCount,
      }),
    });
    emitted = true;
  }

  return {
    ok: true,
    report: { ...report, severity, summary, findings },
    contextRange: { sinceMs: context.rangeSinceMs, untilMs: context.rangeUntilMs },
    emitted,
  };
}

let schedulerStarted = false;

export function startLogAnalysisAgent(args?: { times?: string[]; timeZone?: string }) {
  if (schedulerStarted) return;
  if (!AI_ENABLED) {
    logInfo('ai log analysis scheduler skipped: AI_ENABLED=false');
    return;
  }
  const enabled = String(process.env.AI_LOG_ANALYSIS_ENABLED ?? 'false').toLowerCase() === 'true';
  if (!enabled) return;
  schedulerStarted = true;
  const timeZone = args?.timeZone || String(process.env.AI_LOG_ANALYSIS_TZ ?? DEFAULT_TIME_ZONE);
  const times = args?.times?.length ? args.times : parseTimes(process.env.AI_LOG_ANALYSIS_TIMES);
  const lookbackHours = Math.max(1, Math.min(72, Number(process.env.AI_LOG_ANALYSIS_LOOKBACK_HOURS ?? DEFAULT_LOOKBACK_HOURS)));
  const lastDoneBySlot = new Map<string, string>();

  const tick = async () => {
    try {
      const parts = getTimeParts(timeZone);
      const dateKey = formatDateKey(parts);
      const timeKey = formatTimeKey(parts);
      if (!times.includes(timeKey)) return;
      if (lastDoneBySlot.get(timeKey) === dateKey) return;
      lastDoneBySlot.set(timeKey, dateKey);
      const result = await runLogAnalysisOnce({ lookbackHours, timeZone });
      if (!result.ok) {
        logError('ai log analysis failed', { error: result.error, timeKey, dateKey });
        return;
      }
      logInfo('ai log analysis done', {
        timeKey,
        dateKey,
        severity: result.report.severity,
        emitted: result.emitted,
        findings: result.report.findings.length,
      });
    } catch (e) {
      logError('ai log analysis tick error', { error: String(e) });
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 30_000).unref?.();
  logInfo('ai log analysis scheduler started', { times, timeZone, lookbackHours });
}

export function _resetLogAnalysisSchedulerForTests() {
  schedulerStarted = false;
}
