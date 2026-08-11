// Еженедельный дайджест использования программы (наследник §5 облачной рутины,
// снесённой в D-024). Каждый понедельник в AI_DIGEST_TIME собирает статистику за
// 7 дней (плюс предыдущие 7 для сравнения), очеловечивает её (ФИО вместо логинов,
// русские названия разделов вместо TabId) и постит суперадмину как answered-строку
// ИИваныча. Наблюдения пишет LLM по готовым числам; при сбое LLM уходит голая
// статистика — дайджест не имеет права молча пропустить неделю.
import { and, eq, gte, inArray, isNull, lt } from 'drizzle-orm';

import { REPORT_PRESET_DEFINITIONS, formatClientLabel, sectionLabelForTabKey } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { aiChatMeta, aiChatRequests, auditLog, statisticsAuditDaily } from '../../database/schema.js';
import { logError, logInfo } from '../../utils/logger.js';
import { resolveLoginsToFullNames } from '../employeeAuthService.js';
import { postDigestToSuperadmin } from './aiChatWriteService.js';
import { AI_MODEL_ANALYTICS } from './common.js';
import { callLlm, getLlmProvider, isLlmConfigured } from './llmProvider.js';

const DEFAULT_TIME_ZONE = 'Europe/Moscow';
const DEFAULT_DIGEST_TIME = '09:00';
const DIGEST_TICK_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
const META_KEY = 'usage_digest_last_week';
export const DIGEST_TITLE = '📊 Еженедельный отчёт по использованию программы';
/** Дневная сводка statistics_audit_daily пишется планировщиком с этим cutoff (statisticsAuditService). */
const DAILY_CUTOFF_HOUR = 21;
const UI_ACTIONS = ['ui.visit', 'ui.card_open', 'ui.report_open'] as const;
/** Технические акторы: локальный fallback клиента и сам ИИваныч — в дайджест не идут. */
const SERVICE_ACTORS = new Set(['local', 'ai-agent']);
const TOP_LIMIT = 8;

const REPORT_TITLES = new Map(REPORT_PRESET_DEFINITIONS.map((d) => [String(d.id), d.title]));

// ---------- pure helpers (unit-tested) ----------

/** ISO-8601 ключ недели для персистентного dedupe: понедельник 2026-08-10 → '2026-W33'. */
export function isoWeekKey(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** «ФИО (login)», а без ФИО — просто login: оператор не должен пропасть из дайджеста молча. */
export function formatPersonLabel(login: string, fullNames: Record<string, string>): string {
  const raw = String(login ?? '').trim();
  if (!raw) return '—';
  return formatClientLabel({ login: raw, fullName: fullNames[raw.toLowerCase()] ?? null });
}

/** Название отчёта по preset id, незнакомый id остаётся в кавычках как есть. */
export function reportLabelForPresetId(id: string): string {
  const raw = String(id ?? '').trim();
  if (!raw) return '—';
  return REPORT_TITLES.get(raw) ?? `«${raw}»`;
}

// ---------- time ----------

type TimeParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: string };

function getTimeParts(timeZone: string): TimeParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const map = new Map(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    year: Number(map.get('year') ?? 0),
    month: Number(map.get('month') ?? 0),
    day: Number(map.get('day') ?? 0),
    hour: Number(map.get('hour') ?? 0) % 24,
    minute: Number(map.get('minute') ?? 0),
    weekday: String(map.get('weekday') ?? ''),
  };
}

function parseTime(value: string | undefined | null): string | null {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function isoDateInTz(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function formatDate(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleDateString('ru-RU', { timeZone });
}

// ---------- stats ----------

type CountMap = Map<string, number>;

type UiUsageWindows = {
  sections: CountMap;
  cards: CountMap;
  reports: CountMap;
  prevSections: CountMap;
  prevCards: CountMap;
  prevReports: CountMap;
};

type PersonRow = {
  login: string;
  fullName: string;
  created: number;
  updated: number;
  deleted: number;
  onlineMs: number;
  activeMs: number;
};

type ChatStats = {
  total: number;
  answered: number;
  escalated: number;
  prevTotal: number;
  askedBy: string[];
};

function inc(map: CountMap, key: string, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function topEntries(map: CountMap, limit = TOP_LIMIT): Array<[string, number]> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

async function loadUiUsage(sinceMs: number, untilMs: number): Promise<UiUsageWindows> {
  const midMs = untilMs - WEEK_MS;
  const rows = await db
    .select({ actor: auditLog.actor, action: auditLog.action, payloadJson: auditLog.payloadJson, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        isNull(auditLog.deletedAt),
        inArray(auditLog.action, [...UI_ACTIONS]),
        gte(auditLog.createdAt, sinceMs),
        lt(auditLog.createdAt, untilMs),
      ),
    )
    .limit(50_000);
  const out: UiUsageWindows = {
    sections: new Map(),
    cards: new Map(),
    reports: new Map(),
    prevSections: new Map(),
    prevCards: new Map(),
    prevReports: new Map(),
  };
  for (const row of rows) {
    const actor = String(row.actor ?? '').trim().toLowerCase();
    if (SERVICE_ACTORS.has(actor)) continue;
    let label = '';
    try {
      label = String(JSON.parse(String(row.payloadJson ?? '{}'))?.label ?? '');
    } catch {
      continue;
    }
    if (!label.trim()) continue;
    const current = Number(row.createdAt) >= midMs;
    if (row.action === 'ui.visit') inc(current ? out.sections : out.prevSections, sectionLabelForTabKey(label));
    else if (row.action === 'ui.card_open') inc(current ? out.cards : out.prevCards, sectionLabelForTabKey(label));
    else if (row.action === 'ui.report_open') inc(current ? out.reports : out.prevReports, reportLabelForPresetId(label));
  }
  return out;
}

async function loadPeople(untilMs: number, timeZone: string): Promise<{ current: PersonRow[]; prevTotals: Map<string, number> }> {
  const currentDates: string[] = [];
  const prevDates: string[] = [];
  for (let i = 0; i < 7; i++) currentDates.push(isoDateInTz(untilMs - i * DAY_MS, timeZone));
  for (let i = 7; i < 14; i++) prevDates.push(isoDateInTz(untilMs - i * DAY_MS, timeZone));
  const rows = await db
    .select()
    .from(statisticsAuditDaily)
    .where(
      and(
        eq(statisticsAuditDaily.cutoffHour, DAILY_CUTOFF_HOUR),
        inArray(statisticsAuditDaily.summaryDate, [...currentDates, ...prevDates]),
      ),
    );
  const currentSet = new Set(currentDates);
  const byLogin = new Map<string, PersonRow>();
  const prevTotals = new Map<string, number>();
  for (const row of rows) {
    const login = String(row.login ?? '').trim();
    if (!login || SERVICE_ACTORS.has(login.toLowerCase())) continue;
    if (!currentSet.has(String(row.summaryDate))) {
      prevTotals.set(login, (prevTotals.get(login) ?? 0) + Number(row.totalChanged ?? 0));
      continue;
    }
    const acc = byLogin.get(login) ?? {
      login,
      fullName: String(row.fullName ?? '').trim(),
      created: 0,
      updated: 0,
      deleted: 0,
      onlineMs: 0,
      activeMs: 0,
    };
    if (!acc.fullName) acc.fullName = String(row.fullName ?? '').trim();
    acc.created += Number(row.createdCount ?? 0);
    acc.updated += Number(row.updatedCount ?? 0);
    acc.deleted += Number(row.deletedCount ?? 0);
    acc.onlineMs += Number(row.onlineMs ?? 0);
    acc.activeMs += Number(row.activeMs ?? 0);
    byLogin.set(login, acc);
  }
  const current = Array.from(byLogin.values()).sort(
    (a, b) => b.created + b.updated + b.deleted - (a.created + a.updated + a.deleted),
  );
  return { current, prevTotals };
}

async function loadChatStats(sinceMs: number, untilMs: number): Promise<ChatStats> {
  const midMs = untilMs - WEEK_MS;
  const rows = await db
    .select({ username: aiChatRequests.username, status: aiChatRequests.status, createdAt: aiChatRequests.createdAt, questionText: aiChatRequests.questionText })
    .from(aiChatRequests)
    .where(and(isNull(aiChatRequests.deletedAt), gte(aiChatRequests.createdAt, sinceMs), lt(aiChatRequests.createdAt, untilMs)))
    .limit(10_000);
  const stats: ChatStats = { total: 0, answered: 0, escalated: 0, prevTotal: 0, askedBy: [] };
  const asked = new Set<string>();
  for (const row of rows) {
    // Сам дайджест тоже лежит в ai_chat_requests answered-строкой — из статистики вопросов его убираем.
    if (String(row.questionText ?? '') === DIGEST_TITLE) continue;
    const login = String(row.username ?? '').trim();
    if (SERVICE_ACTORS.has(login.toLowerCase())) continue;
    if (Number(row.createdAt) < midMs) {
      stats.prevTotal += 1;
      continue;
    }
    stats.total += 1;
    const status = String(row.status ?? '');
    if (status === 'answered') stats.answered += 1;
    if (status === 'escalated') stats.escalated += 1;
    if (login) asked.add(login);
  }
  stats.askedBy = Array.from(asked);
  return stats;
}

function hoursText(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)} ч`;
}

function compareSuffix(prev: number | undefined): string {
  return prev != null && prev > 0 ? ` (неделей ранее: ${prev})` : '';
}

function renderTop(title: string, current: CountMap, prev: CountMap): string[] {
  const entries = topEntries(current);
  if (entries.length === 0) return [];
  const lines = [`### ${title}`];
  for (const [label, count] of entries) {
    lines.push(`- ${label} — ${count}${compareSuffix(prev.get(label))}`);
  }
  lines.push('');
  return lines;
}

export async function buildDigestStatsMarkdown(untilMs: number, timeZone: string): Promise<string> {
  const sinceMs = untilMs - WEEK_MS;
  const prevSinceMs = untilMs - 2 * WEEK_MS;
  const [ui, people, chat] = await Promise.all([
    loadUiUsage(prevSinceMs, untilMs),
    loadPeople(untilMs, timeZone),
    loadChatStats(prevSinceMs, untilMs),
  ]);
  const fullNames = await resolveLoginsToFullNames(chat.askedBy).catch(() => ({}) as Record<string, string>);

  const lines: string[] = [];
  lines.push(`## ${DIGEST_TITLE}`);
  lines.push(`Период: ${formatDate(sinceMs, timeZone)} — ${formatDate(untilMs, timeZone)} (сравнение с предыдущей неделей).`);
  lines.push('');
  lines.push(...renderTop('Разделы программы (заходы)', ui.sections, ui.prevSections));
  lines.push(...renderTop('Открытые карточки', ui.cards, ui.prevCards));
  lines.push(...renderTop('Отчёты', ui.reports, ui.prevReports));

  if (people.current.length > 0) {
    lines.push('### Работа сотрудников');
    for (const p of people.current) {
      const label = formatClientLabel({ login: p.login, fullName: p.fullName || null });
      const total = p.created + p.updated + p.deleted;
      lines.push(
        `- ${label}: создано ${p.created}, изменено ${p.updated}, удалено ${p.deleted}` +
          `${compareSuffix(people.prevTotals.get(p.login))}; онлайн ${hoursText(p.onlineMs)}, активно ${hoursText(p.activeMs)}` +
          (total === 0 ? ' — записей не менял(а)' : ''),
      );
    }
    lines.push('');
  }

  lines.push('### ИИваныч');
  if (chat.total === 0) {
    lines.push(`Вопросов за неделю не было${compareSuffix(chat.prevTotal)}.`);
  } else {
    lines.push(`Вопросов за неделю: ${chat.total} (ответил: ${chat.answered}, эскалаций: ${chat.escalated})${compareSuffix(chat.prevTotal)}.`);
    if (chat.askedBy.length > 0) {
      lines.push(`Спрашивали: ${chat.askedBy.map((login) => formatPersonLabel(login, fullNames)).join(', ')}.`);
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- narration ----------

const NARRATION_SYSTEM_PROMPT =
  'Ты ИИваныч — помощник руководителя ремонтно-механического завода в программе «Матрица РМЗ». ' +
  'Тебе дают готовую статистику использования программы за неделю. Напиши по-русски короткий живой разбор: ' +
  '2–4 наблюдения о том, кто и как работает в программе (что востребовано, что просело, кто активен), ' +
  'и 1–3 практических предложения руководителю. ' +
  'Используй ТОЛЬКО числа и имена из присланной статистики — ничего не выдумывай и не пересчитывай. ' +
  'Не пересказывай всю статистику подряд, выделяй главное. Оформи простым markdown-списком.';

async function narrateDigest(statsMd: string): Promise<string | null> {
  if (!isLlmConfigured()) return null;
  try {
    const text = await callLlm({
      model: AI_MODEL_ANALYTICS,
      system: NARRATION_SYSTEM_PROMPT,
      user: statsMd,
      options: { timeoutMs: 120_000, maxTokens: 1200, temperature: 0.4 },
    });
    return text.trim() || null;
  } catch (e) {
    logError('ai usage digest: narration failed, posting plain stats', { error: String(e) });
    return null;
  }
}

// ---------- persistent dedupe (survives restarts, unlike the in-memory reports Map) ----------

async function getLastSentWeek(): Promise<string | null> {
  const rows = await db.select().from(aiChatMeta).where(eq(aiChatMeta.key, META_KEY)).limit(1);
  return rows[0]?.value ?? null;
}

async function markWeekSent(weekKey: string): Promise<void> {
  const ts = Date.now();
  await db
    .insert(aiChatMeta)
    .values({ key: META_KEY, value: weekKey, updatedAt: ts })
    .onConflictDoUpdate({ target: aiChatMeta.key, set: { value: weekKey, updatedAt: ts } });
}

// ---------- scheduler ----------

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Один прогон: собрать, очеловечить, рассказать, запостить. Экспорт — для ручного запуска/отладки. */
export async function runUsageDigestOnce(weekKey: string, timeZone: string): Promise<void> {
  const untilMs = Date.now();
  const statsMd = await buildDigestStatsMarkdown(untilMs, timeZone);
  const narration = await narrateDigest(statsMd);
  const digestMd = narration ? `${narration}\n\n---\n\n${statsMd}` : statsMd;
  const res = await postDigestToSuperadmin({ digestMd });
  if (!res.ok) throw new Error(res.error);
  await markWeekSent(weekKey);
  logInfo(
    'ai usage digest posted',
    { weekKey, requestId: res.id, narrated: Boolean(narration), bytes: digestMd.length },
    { critical: true },
  );
}

export function startAiUsageDigestScheduler(): void {
  if (timer) return;
  const timeZone = String(process.env.AI_DIGEST_TZ ?? DEFAULT_TIME_ZONE);
  const digestTime = parseTime(process.env.AI_DIGEST_TIME) ?? DEFAULT_DIGEST_TIME;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const parts = getTimeParts(timeZone);
      if (parts.weekday !== 'Mon') return;
      const timeKey = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
      // «>=» вместо точного совпадения минуты: упавший прогон ретраится до конца понедельника,
      // а от повторной отправки после успеха держит персистентный weekKey в ai_chat_meta.
      if (timeKey < digestTime) return;
      const weekKey = isoWeekKey(parts.year, parts.month, parts.day);
      if ((await getLastSentWeek()) === weekKey) return;
      await runUsageDigestOnce(weekKey, timeZone);
    } catch (e) {
      logError('ai usage digest tick failed', { error: String(e) });
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), DIGEST_TICK_MS);
  timer.unref?.();
  // critical:true — на проде logInfo без него не виден, а строка старта — единственное
  // подтверждение после деплоя, что дайджест вообще заведён (грабли #525).
  logInfo(
    'ai usage digest scheduler started',
    { digestTime, timeZone, model: AI_MODEL_ANALYTICS, provider: getLlmProvider(), llmConfigured: isLlmConfigured() },
    { critical: true },
  );
}
