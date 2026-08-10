// Ядро операций облачной AI-рутины асинхронного чата. Используется двумя каналами:
// CLI-скриптом scripts/aiChatRoutineIO.ts (SSH-путь) и REST-роутером /ai-chat/routine
// (облачный контейнер claude.ai не имеет SSH — ходит по HTTPS с AI_ROUTINE_TOKEN).
// D-024: с переходом ИИваныча на прямые вызовы DeepSeek этот канал — резервный;
// сам ответ теперь пишет aiChatAnswerService тем же writer'ом (aiChatWriteService).
import { randomUUID } from 'node:crypto';

import { and, eq, isNull, isNotNull, or } from 'drizzle-orm';
import { Pool } from 'pg';

import { db } from '../../database/db.js';
import { aiChatMeta, aiChatRequests, aiChatRulesHistory } from '../../database/schema.js';
import { getEffectivePermissionsForUser } from '../../auth/permissions.js';
import { buildAllowedTablesFromPerms } from './llmTools.js';
import { listEmployeesAuth } from '../employeeAuthService.js';
import {
  getAiChatActor,
  notifySuperadminEscalation,
  nowMs,
  questionFileHref,
  uploadAnswerBuffer,
  writeAiChatRow,
  type AiChatActor,
} from './aiChatWriteService.js';

export type RoutineActor = AiChatActor;

export const getRoutineActor = getAiChatActor;

const writeRow = writeAiChatRow;

export async function routineListPending() {
  const rows = await db
    .select()
    .from(aiChatRequests)
    .where(
      and(
        isNull(aiChatRequests.deletedAt),
        or(
          eq(aiChatRequests.status, 'pending'),
          and(eq(aiChatRequests.status, 'escalated'), isNotNull(aiChatRequests.verdictText)),
        ),
      ),
    )
    .limit(500);

  const userIds = Array.from(new Set(rows.map((r: any) => String(r.userId))));
  const permsByUser = new Map<string, { permissions: string[]; allowedTables: string[] }>();
  for (const uid of userIds) {
    const perms = await getEffectivePermissionsForUser(uid);
    const granted = Object.entries(perms)
      .filter(([, v]) => v === true)
      .map(([k]) => k)
      .sort();
    permsByUser.set(uid, { permissions: granted, allowedTables: Array.from(buildAllowedTablesFromPerms(perms)).sort() });
  }

  const items = [];
  for (const r of rows as any[]) {
    const u = permsByUser.get(String(r.userId)) ?? { permissions: [], allowedTables: [] };
    items.push({
      id: String(r.id),
      userId: String(r.userId),
      username: String(r.username),
      questionText: String(r.questionText),
      status: String(r.status),
      verdictText: r.verdictText ?? null,
      escalationNote: r.escalationNote ?? null,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
      questionFileDownloadHref: await questionFileHref(r.questionFileJson ?? null),
      userPermissions: u.permissions,
      userAllowedTables: u.allowedTables,
    });
  }
  return { ok: true as const, count: items.length, items };
}

export type RoutineAttachment = { name: string; contentBase64: string };

function decodeAttachments(attachments: RoutineAttachment[] | undefined): Array<{ name: string; bytes: Buffer }> {
  const out: Array<{ name: string; bytes: Buffer }> = [];
  for (const a of attachments ?? []) {
    const name = String(a?.name ?? '').trim();
    const b64 = String(a?.contentBase64 ?? '');
    if (!name || !b64) throw new Error('attachment: name and contentBase64 required');
    out.push({ name, bytes: Buffer.from(b64, 'base64') });
  }
  return out;
}

export async function routinePostAnswer(args: {
  id: string;
  answerText: string;
  reject?: boolean;
  expectUpdatedAt?: number | null;
  attachments?: RoutineAttachment[];
}) {
  const answerText = String(args.answerText ?? '').trim();
  if (!args.id || !answerText) throw new Error('id and answerText required');

  const rows = await db.select().from(aiChatRequests).where(eq(aiChatRequests.id, args.id as any)).limit(1);
  const cur = rows[0] as any;
  if (!cur || cur.deletedAt != null) throw new Error('request not found');
  if (args.expectUpdatedAt != null && Number(args.expectUpdatedAt) !== Number(cur.updatedAt)) {
    return { ok: false as const, error: 'stale: question edited after list-pending', currentUpdatedAt: Number(cur.updatedAt) };
  }

  const actor = await getRoutineActor();
  const attachRefs = [];
  for (const a of decodeAttachments(args.attachments)) {
    attachRefs.push(await uploadAnswerBuffer(String(args.id), a.name, a.bytes, actor.id));
  }

  const ts = nowMs();
  const next = {
    ...cur,
    status: args.reject ? 'rejected' : 'answered',
    answerText,
    answerFilesJson: attachRefs.length > 0 ? JSON.stringify(attachRefs) : null,
    answeredAt: ts,
    updatedAt: ts,
  };
  const res = await writeRow(actor, next);
  return { ok: true as const, id: args.id, status: next.status, attachments: attachRefs.length, dbApplied: res.dbApplied, skipped: res.skipped };
}

export async function routineEscalate(args: { id: string; reason: string }) {
  if (!args.id) throw new Error('id required');
  const reason = String(args.reason ?? '').trim();

  const rows = await db.select().from(aiChatRequests).where(eq(aiChatRequests.id, args.id as any)).limit(1);
  const cur = rows[0] as any;
  if (!cur || cur.deletedAt != null) throw new Error('request not found');

  const ts = nowMs();
  const next = { ...cur, status: 'escalated', escalationNote: reason || null, updatedAt: ts };
  const actor = await getRoutineActor();
  const wres = await writeRow(actor, next);
  if (wres.skipped.length > 0) {
    return { ok: false as const, error: `escalate skipped: ${JSON.stringify(wres.skipped)}` };
  }

  const notified = await notifySuperadminEscalation(actor, {
    username: String(cur.username),
    questionText: String(cur.questionText),
    reason,
  });
  return { ok: true as const, id: args.id, notifiedSuperadmin: notified };
}

async function upsertMeta(key: string, value: string) {
  const ts = nowMs();
  await db
    .insert(aiChatMeta)
    .values({ key, value, updatedAt: ts })
    .onConflictDoUpdate({ target: aiChatMeta.key, set: { value, updatedAt: ts } });
}

export async function routineGetRules() {
  const rows = await db.select().from(aiChatMeta).where(eq(aiChatMeta.key, 'rules_md')).limit(1);
  return { ok: true as const, rulesMd: rows[0]?.value ?? null };
}

export async function routineSetRules(args: { rulesMd: string; changedBy?: string | null }) {
  const rulesMd = String(args.rulesMd ?? '');
  if (!rulesMd.trim()) throw new Error('rulesMd is empty');
  await upsertMeta('rules_md', rulesMd);
  await db.insert(aiChatRulesHistory).values({
    id: randomUUID(),
    rulesMd,
    changedBy: args.changedBy ?? 'ai-routine',
    createdAt: nowMs(),
  });
  return { ok: true as const, bytes: rulesMd.length };
}

export async function routinePostDigest(args: { digestMd: string; title?: string | null; attachments?: RoutineAttachment[] }) {
  const answerText = String(args.digestMd ?? '').trim();
  if (!answerText) throw new Error('digestMd is empty');
  const title = (args.title ?? '').trim() || '📊 Еженедельный отчёт по использованию программы';

  const list = await listEmployeesAuth();
  const sa = list.ok ? list.rows.find((r) => String(r.systemRole ?? '').toLowerCase() === 'superadmin') : null;
  if (!sa?.id) throw new Error('superadmin not found');

  const actor = await getRoutineActor();
  const id = randomUUID();
  const attachRefs = [];
  for (const a of decodeAttachments(args.attachments)) {
    attachRefs.push(await uploadAnswerBuffer(id, a.name, a.bytes, actor.id));
  }

  const ts = nowMs();
  const row = {
    id,
    userId: String(sa.id),
    username: String(sa.login ?? 'superadmin'),
    questionText: title,
    questionFileJson: null,
    status: 'answered',
    answerText,
    answerFilesJson: attachRefs.length > 0 ? JSON.stringify(attachRefs) : null,
    answeredAt: ts,
    escalationNote: null,
    verdictText: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  };
  const res = await writeRow(actor, row);
  return { ok: true as const, id, attachments: attachRefs.length, dbApplied: res.dbApplied, skipped: res.skipped };
}

export async function routineMarkRun() {
  const ts = nowMs();
  await upsertMeta('last_run_at', String(ts));
  return { ok: true as const, lastRunAt: ts };
}

// Read-only SQL для анализа из облака (REST-замена psql-доступа по SSH).
// Двойной гейт: соединение под ролью ai_readonly (SELECT-only на уровне PG) +
// синтаксический фильтр «один statement, начинается с SELECT/WITH».
let readonlyPool: Pool | null = null;

function getReadonlyPool(): Pool {
  const url = (process.env.AI_READONLY_URL ?? '').trim();
  if (!url) throw new Error('AI_READONLY_URL не настроен (PG-роль ai_readonly)');
  if (!readonlyPool) {
    readonlyPool = new Pool({ connectionString: url, max: 2, statement_timeout: 15_000 });
  }
  return readonlyPool;
}

const MAX_SELECT_ROWS = 5000;

export async function routineRunSelect(args: { sql: string }) {
  const sql = String(args.sql ?? '').trim().replace(/;\s*$/, '');
  if (!sql) throw new Error('sql required');
  if (sql.includes(';')) throw new Error('single statement only');
  if (!/^(select|with)\b/i.test(sql)) throw new Error('only SELECT/WITH statements allowed');
  const pool = getReadonlyPool();
  const res = await pool.query({ text: sql, rowMode: 'array' as const });
  const rows = (res.rows ?? []).slice(0, MAX_SELECT_ROWS);
  return {
    ok: true as const,
    columns: (res.fields ?? []).map((f: any) => String(f.name)),
    rowCount: rows.length,
    truncated: (res.rows?.length ?? 0) > MAX_SELECT_ROWS,
    rows,
  };
}
