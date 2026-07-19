/**
 * aiChatRoutineIO — I/O-скрипт облачной AI-рутины асинхронного чата.
 *
 * Вызывается рутиной по SSH: node dist/scripts/aiChatRoutineIO.js <cmd> [args].
 * ВСЕ записи идут через recordSyncChanges (ledger → PG → клиенты по pull);
 * прямой SQL-write мимо ledger запрещён. Чтения БД рутина делает сама (psql,
 * роль ai_readonly) — этот скрипт даёт ей только карту прав и канал записи.
 *
 * Команды (вывод — одна JSON-строка в stdout):
 *   list-pending
 *     Вопросы status='pending' + эскалации с заполненным вердиктом. На каждый:
 *     permissions / allowedTables / role спросившего, download-href файла вопроса.
 *   post-answer --id <uuid> --answer-file <path.md> [--attach <path>]... [--expect-updated-at <ms>] [--reject]
 *     Пишет ответ (или отказ при --reject): заливает вложения на Яндекс.Диск,
 *     создаёт file_assets, ставит status answered/rejected.
 *   escalate --id <uuid> --reason-file <path>
 *     status='escalated' + DM суперадмину от актора ai-agent.
 *   get-rules / set-rules --file <path> [--changed-by <who>]
 *     «Конституция ответов» в ai_chat_meta.rules_md + append-only история.
 *   post-digest --file <path.md> [--title <text>] [--attach <path>]...
 *     Еженедельный дайджест использования программы: создаёт ГОТОВУЮ answered-запись
 *     в AI-чате суперадмина (вопрос-заглушка + ответ из файла). Задача E плана
 *     ai-chat-ux-drafts-telemetry-2026-07 («куда класть отчёт — в AI-чат суперадмину»).
 *   mark-run
 *     Штампит last_run_at в ai_chat_meta.
 */
import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { and, eq, isNull, isNotNull, or } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { aiChatMeta, aiChatRequests, aiChatRulesHistory, fileAssets } from '../database/schema.js';
import { getEffectivePermissionsForUser } from '../auth/permissions.js';
import { buildAllowedTablesFromPerms } from '../services/ai/claudeTools.js';
import { listEmployeesAuth } from '../services/employeeAuthService.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';
import { writeSyncChanges } from '../services/sync/syncWriteService.js';
import { getDownloadHref, getUploadHref, uploadFileStream, ensureFolderDeep } from '../services/yandexDisk.js';
import { backendVersion as appVersion } from '../version.js';

function nowMs() {
  return Date.now();
}

function argValue(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return null;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : null;
}

function argValues(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}`) {
      const v = process.argv[i + 1];
      if (v && !v.startsWith('--')) out.push(v);
    }
  }
  return out;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function out(obj: Record<string, unknown>) {
  console.log(JSON.stringify({ version: appVersion, ...obj }));
}

async function getActor(): Promise<{ id: string; username: string; role: string }> {
  const list = await listEmployeesAuth();
  if (!list.ok) throw new Error('listEmployeesAuth failed');
  const byLogin = (login: string) =>
    list.rows.find((r) => String(r.login ?? '').trim().toLowerCase() === login);
  const ai = byLogin('ai-agent');
  if (ai?.id) return { id: String(ai.id), username: 'ai-agent', role: 'admin' };
  const sa = list.rows.find((r) => String(r.systemRole ?? '').toLowerCase() === 'superadmin');
  if (sa?.id) return { id: String(sa.id), username: String(sa.login ?? 'superadmin'), role: 'superadmin' };
  throw new Error('no ai-agent employee and no superadmin found');
}

function toSyncPayload(row: any): Record<string, unknown> {
  return {
    id: String(row.id),
    user_id: String(row.userId),
    username: String(row.username),
    question_text: String(row.questionText),
    question_file_json: row.questionFileJson ?? null,
    status: String(row.status),
    answer_text: row.answerText ?? null,
    answer_files_json: row.answerFilesJson ?? null,
    answered_at: row.answeredAt ?? null,
    escalation_note: row.escalationNote ?? null,
    verdict_text: row.verdictText ?? null,
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt ?? null,
    sync_status: 'synced',
  };
}

async function writeRow(actor: { id: string; username: string; role: string }, row: any) {
  return await writeSyncChanges(
    [
      {
        type: 'upsert',
        table: SyncTableName.AiChatRequests,
        row: toSyncPayload(row),
        row_id: String(row.id),
      },
    ],
    actor,
    { allowSyncConflicts: true },
  );
}

async function questionFileHref(questionFileJson: string | null): Promise<string | null> {
  if (!questionFileJson) return null;
  try {
    const ref = JSON.parse(questionFileJson) as { id?: string };
    if (!ref?.id) return null;
    const rows = await db
      .select()
      .from(fileAssets)
      .where(and(eq(fileAssets.id, String(ref.id) as any), isNull(fileAssets.deletedAt)))
      .limit(1);
    const f = rows[0] as any;
    if (!f?.yandexDiskPath) return null;
    return await getDownloadHref(String(f.yandexDiskPath));
  } catch {
    return null;
  }
}

async function cmdListPending() {
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
  out({ ok: true, count: items.length, items });
}

async function uploadAnswerFile(requestId: string, localPath: string, actorId: string): Promise<Record<string, unknown>> {
  const base = (process.env.YANDEX_DISK_BASE_PATH ?? '').trim();
  if (!base) throw new Error('YANDEX_DISK_BASE_PATH не настроен');
  const st = statSync(localPath);
  if (!st.isFile()) throw new Error(`not a file: ${localPath}`);
  const name = basename(localPath).replaceAll(/[^a-zA-Z0-9а-яА-Я._ -]+/g, '_').slice(0, 180) || 'file';
  const bytes = readFileSync(localPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = randomUUID();
  const createdAt = nowMs();
  const diskPath = `${base.replace(/\/+$/, '')}/ai_chat/${requestId}/ai-chat-files/${id}_${name}`;
  await ensureFolderDeep(base.replace(/\/+$/, '') || '/');
  await getUploadHref({ diskPath, overwrite: true, ensureParent: true }); // ensureParent создаёт вложенные папки
  await uploadFileStream({ diskPath, localFilePath: localPath, mime: null });
  await db.insert(fileAssets).values({
    id,
    createdAt,
    createdByUserId: actorId as any,
    name,
    mime: null,
    size: Number(st.size),
    sha256,
    storageKind: 'yandex',
    localRelPath: null,
    yandexDiskPath: diskPath,
  });
  return { id, name, size: Number(st.size), mime: null, sha256, createdAt };
}

async function cmdPostAnswer() {
  const id = argValue('id');
  const answerFile = argValue('answer-file');
  if (!id || !answerFile) throw new Error('usage: post-answer --id <uuid> --answer-file <path> [--attach <path>]... [--expect-updated-at <ms>] [--reject]');
  const answerText = readFileSync(answerFile, 'utf8').trim();
  if (!answerText) throw new Error('empty answer');

  const rows = await db.select().from(aiChatRequests).where(eq(aiChatRequests.id, id as any)).limit(1);
  const cur = rows[0] as any;
  if (!cur || cur.deletedAt != null) throw new Error('request not found');
  const expect = argValue('expect-updated-at');
  if (expect && Number(expect) !== Number(cur.updatedAt)) {
    out({ ok: false, error: 'stale: question edited after list-pending', currentUpdatedAt: Number(cur.updatedAt) });
    return;
  }

  const actor = await getActor();
  const attachRefs = [];
  for (const p of argValues('attach')) {
    attachRefs.push(await uploadAnswerFile(String(id), p, actor.id));
  }

  const ts = nowMs();
  const next = {
    ...cur,
    status: hasFlag('reject') ? 'rejected' : 'answered',
    answerText,
    answerFilesJson: attachRefs.length > 0 ? JSON.stringify(attachRefs) : null,
    answeredAt: ts,
    updatedAt: ts,
  };
  const res = await writeRow(actor, next);
  out({ ok: true, id, status: next.status, attachments: attachRefs.length, dbApplied: res.dbApplied, skipped: res.skipped });
}

async function cmdEscalate() {
  const id = argValue('id');
  const reasonFile = argValue('reason-file');
  if (!id || !reasonFile) throw new Error('usage: escalate --id <uuid> --reason-file <path>');
  const reason = readFileSync(reasonFile, 'utf8').trim();

  const rows = await db.select().from(aiChatRequests).where(eq(aiChatRequests.id, id as any)).limit(1);
  const cur = rows[0] as any;
  if (!cur || cur.deletedAt != null) throw new Error('request not found');

  const ts = nowMs();
  const next = { ...cur, status: 'escalated', escalationNote: reason || null, updatedAt: ts };
  const actor = await getActor();
  const wres = await writeRow(actor, next);
  if (wres.skipped.length > 0) {
    out({ ok: false, error: `escalate skipped: ${JSON.stringify(wres.skipped)}` });
    return;
  }

  // DM суперадмину (паттерн aiAgentReportsService.sendReportToSuperadmin).
  const list = await listEmployeesAuth();
  const sa = list.ok ? list.rows.find((r) => String(r.systemRole ?? '').toLowerCase() === 'superadmin') : null;
  if (sa?.id) {
    const msgId = randomUUID();
    const text = `⚠️ AI-чат: эскалация вопроса от ${cur.username}:\n«${String(cur.questionText).slice(0, 500)}»\n\nПричина: ${reason || '(не указана)'}\n\nОткройте ИИ-помощник → блок «Эскалации» и дайте вердикт.`;
    await recordSyncChanges(
      actor,
      [
        {
          tableName: SyncTableName.ChatMessages,
          rowId: msgId,
          op: 'upsert',
          payload: {
            id: msgId,
            sender_user_id: actor.id,
            sender_username: actor.username,
            recipient_user_id: String(sa.id),
            message_type: 'text',
            body_text: text,
            payload_json: null,
            created_at: ts,
            updated_at: ts,
            deleted_at: null,
            sync_status: 'synced',
          },
          ts,
        },
      ],
      { allowSyncConflicts: true },
    );
  }
  out({ ok: true, id, notifiedSuperadmin: Boolean(sa?.id) });
}

async function cmdPostDigest() {
  const file = argValue('file');
  if (!file) throw new Error('usage: post-digest --file <path.md> [--title <text>] [--attach <path>]...');
  const answerText = readFileSync(file, 'utf8').trim();
  if (!answerText) throw new Error('empty digest');
  const title = argValue('title') ?? '📊 Еженедельный отчёт по использованию программы';

  const list = await listEmployeesAuth();
  const sa = list.ok ? list.rows.find((r) => String(r.systemRole ?? '').toLowerCase() === 'superadmin') : null;
  if (!sa?.id) throw new Error('superadmin not found');

  const actor = await getActor();
  const id = randomUUID();
  const attachRefs = [];
  for (const p of argValues('attach')) {
    attachRefs.push(await uploadAnswerFile(id, p, actor.id));
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
  out({ ok: true, id, attachments: attachRefs.length, dbApplied: res.dbApplied, skipped: res.skipped });
}

async function upsertMeta(key: string, value: string) {
  const ts = nowMs();
  await db
    .insert(aiChatMeta)
    .values({ key, value, updatedAt: ts })
    .onConflictDoUpdate({ target: aiChatMeta.key, set: { value, updatedAt: ts } });
}

async function cmdGetRules() {
  const rows = await db.select().from(aiChatMeta).where(eq(aiChatMeta.key, 'rules_md')).limit(1);
  out({ ok: true, rulesMd: rows[0]?.value ?? null });
}

async function cmdSetRules() {
  const file = argValue('file');
  if (!file) throw new Error('usage: set-rules --file <path> [--changed-by <who>]');
  const rulesMd = readFileSync(file, 'utf8');
  await upsertMeta('rules_md', rulesMd);
  await db.insert(aiChatRulesHistory).values({
    id: randomUUID(),
    rulesMd,
    changedBy: argValue('changed-by') ?? 'ai-routine',
    createdAt: nowMs(),
  });
  out({ ok: true, bytes: rulesMd.length });
}

async function cmdMarkRun() {
  await upsertMeta('last_run_at', String(nowMs()));
  out({ ok: true, lastRunAt: nowMs() });
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'list-pending':
      return cmdListPending();
    case 'post-answer':
      return cmdPostAnswer();
    case 'escalate':
      return cmdEscalate();
    case 'get-rules':
      return cmdGetRules();
    case 'set-rules':
      return cmdSetRules();
    case 'post-digest':
      return cmdPostDigest();
    case 'mark-run':
      return cmdMarkRun();
    default:
      throw new Error(`unknown command: ${cmd ?? '(none)'}; commands: list-pending | post-answer | escalate | get-rules | set-rules | post-digest | mark-run`);
  }
}

void main()
  .catch((e) => {
    out({ ok: false, error: String(e?.message ?? e) });
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end().catch(() => {});
  });
