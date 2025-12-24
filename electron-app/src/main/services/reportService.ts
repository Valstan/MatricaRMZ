import { and, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { attributeDefs, attributeValues, entities, operations } from '../database/schema.js';

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

export async function buildPeriodStagesCsvByLink(
  db: BetterSQLite3Database,
  args: { startMs?: number; endMs: number; linkAttrCode: string },
): Promise<Ok<{ csv: string }> | Err> {
  try {
    const endMs = args.endMs;
    if (!Number.isFinite(endMs) || endMs <= 0) return { ok: false, error: 'Некорректная дата endMs' };
    const linkAttrCode = String(args.linkAttrCode || '').trim();
    if (!linkAttrCode) return { ok: false, error: 'Некорректный linkAttrCode' };

    // 1) последняя операция по каждому engine
    const opsRows = await db
      .select()
      .from(operations)
      .where(and(isNull(operations.deletedAt), lte(operations.createdAt, endMs)))
      .limit(200_000);

    const latestByEngine = new Map<string, { type: string; ts: number }>();
    for (const r of opsRows as any[]) {
      const engineId: string = r.engineEntityId;
      const ts: number = (r.performedAt ?? r.createdAt) as number;
      const prev = latestByEngine.get(engineId);
      if (!prev || ts > prev.ts) latestByEngine.set(engineId, { type: String(r.operationType), ts });
    }

    const startMs = args.startMs;

    // 2) находим attribute_def_id для linkAttrCode для типа engine
    // (быстро и достаточно надёжно: берём def по code, затем применяем к attribute_values)
    const def = await db.select().from(attributeDefs).where(and(isNull(attributeDefs.deletedAt), lte(attributeDefs.createdAt, endMs))).limit(5000);
    const defRow = (def as any[]).find((d) => String(d.code) === linkAttrCode) as any | undefined;
    if (!defRow?.id) return { ok: false, error: `Не найден attribute_def: ${linkAttrCode}` };
    const defId = String(defRow.id);

    // 3) map engineId -> groupId (из attribute_values)
    const values = await db.select().from(attributeValues).where(and(isNull(attributeValues.deletedAt), lte(attributeValues.createdAt, endMs))).limit(200_000);
    const groupByEngine = new Map<string, string>();
    for (const v of values as any[]) {
      if (String(v.attributeDefId) !== defId) continue;
      const engineId = String(v.entityId);
      if (!latestByEngine.has(engineId)) continue;
      const raw = v.valueJson ? safeJsonParse(String(v.valueJson)) : null;
      if (typeof raw === 'string' && raw) groupByEngine.set(engineId, raw);
    }

    // 4) resolve group labels (optional): group entity displayName = best-effort
    const entityRows = await db.select().from(entities).where(isNull(entities.deletedAt)).limit(50_000);
    const entityById = new Map((entityRows as any[]).map((e) => [String(e.id), e] as const));

    // best-effort label attribute on the group entity
    const labelKeys = ['name', 'number', 'full_name'];
    const labelDefCandidates = (def as any[]).filter((d) => labelKeys.includes(String(d.code))).map((d) => String(d.id));
    const labelByEntity = new Map<string, string>();
    for (const v of values as any[]) {
      if (!labelDefCandidates.includes(String(v.attributeDefId))) continue;
      const entId = String(v.entityId);
      if (!entityById.has(entId)) continue;
      const raw = v.valueJson ? safeJsonParse(String(v.valueJson)) : null;
      if (raw != null && raw !== '') labelByEntity.set(entId, String(raw));
    }

    const counts = new Map<string, number>();
    for (const [engineId, stage] of latestByEngine.entries()) {
      if (typeof startMs === 'number' && Number.isFinite(startMs) && stage.ts < startMs) continue;
      const groupId = groupByEngine.get(engineId) ?? '';
      const label = groupId ? labelByEntity.get(groupId) ?? groupId : '(не указано)';
      const key = `${label}||${stage.type}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const header = ['group', 'stage', 'count'];
    const lines: string[] = [header.join(';')];
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [key, count] of sorted) {
      const [group, stage] = key.split('||');
      lines.push([csvEscape(group), csvEscape(stage), String(count)].join(';'));
    }
    return { ok: true, csv: lines.join('\n') + '\n' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}


