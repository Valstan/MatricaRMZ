import { and, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { operations } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

function csvEscape(s: string) {
  const needs = /[,"\n\r;]/.test(s);
  const v = s.replace(/"/g, '""');
  return needs ? `"${v}"` : v;
}

export async function buildPeriodStagesCsv(
  db: BetterSQLite3Database,
  args: { startMs?: number; endMs: number },
): Promise<Ok<{ csv: string }> | Err> {
  try {
    const endMs = args.endMs;
    if (!Number.isFinite(endMs) || endMs <= 0) return { ok: false, error: 'Некорректная дата endMs' };

    // Берём все операции по всем двигателям до endMs и выбираем “последнюю” по performedAt/createdAt.
    const rows = await db
      .select()
      .from(operations)
      .where(and(isNull(operations.deletedAt), lte(operations.createdAt, endMs)))
      .limit(200_000);

    const latestByEngine = new Map<string, { type: string; ts: number }>();
    for (const r of rows as any[]) {
      const engineId: string = r.engineEntityId;
      const ts: number = (r.performedAt ?? r.createdAt) as number;
      const prev = latestByEngine.get(engineId);
      if (!prev || ts > prev.ts) latestByEngine.set(engineId, { type: String(r.operationType), ts });
    }

    // Фильтр по startMs (если задан): считаем только те движки, у которых последняя стадия в окне.
    const startMs = args.startMs;
    const counts = new Map<string, number>();
    for (const v of latestByEngine.values()) {
      if (typeof startMs === 'number' && Number.isFinite(startMs) && v.ts < startMs) continue;
      counts.set(v.type, (counts.get(v.type) ?? 0) + 1);
    }

    const header = ['stage', 'count'];
    const lines: string[] = [header.join(';')];
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [stage, count] of sorted) {
      lines.push([csvEscape(stage), String(count)].join(';'));
    }
    lines.push(['TOTAL', String([...counts.values()].reduce((a, b) => a + b, 0))].join(';'));

    return { ok: true, csv: lines.join('\n') + '\n' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


