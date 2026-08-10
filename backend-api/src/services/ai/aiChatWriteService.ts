// Общий writer асинхронного AI-чата: актор, запись строки ai_chat_requests,
// заливка файлов ответа и DM суперадмину при эскалации. Вынесен из
// aiChatRoutineService, чтобы прямой движок (aiChatAnswerService) и облачная рутина
// писали одним путём — и чтобы снос рутины не утащил writer за собой.
// ВСЕ записи — через writeSyncChanges/recordSyncChanges (ledger), прямой SQL-write запрещён.
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq, isNull } from 'drizzle-orm';

import { SyncTableName } from '@matricarmz/shared';

import { db } from '../../database/db.js';
import { fileAssets } from '../../database/schema.js';
import { listEmployeesAuth } from '../employeeAuthService.js';
import { recordSyncChanges } from '../sync/syncChangeService.js';
import { writeSyncChanges } from '../sync/syncWriteService.js';
import { getDownloadHref, getUploadHref, uploadFileStream, ensureFolderDeep } from '../yandexDisk.js';

export type AiChatActor = { id: string; username: string; role: string };

export function nowMs() {
  return Date.now();
}

export async function getAiChatActor(): Promise<AiChatActor> {
  const list = await listEmployeesAuth();
  if (!list.ok) throw new Error('listEmployeesAuth failed');
  const ai = list.rows.find((r) => String(r.login ?? '').trim().toLowerCase() === 'ai-agent');
  if (ai?.id) return { id: String(ai.id), username: 'ai-agent', role: 'admin' };
  const sa = list.rows.find((r) => String(r.systemRole ?? '').toLowerCase() === 'superadmin');
  if (sa?.id) return { id: String(sa.id), username: String(sa.login ?? 'superadmin'), role: 'superadmin' };
  throw new Error('no ai-agent employee and no superadmin found');
}

export function toAiChatSyncPayload(row: any): Record<string, unknown> {
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

export async function writeAiChatRow(actor: AiChatActor, row: any) {
  return await writeSyncChanges(
    [
      {
        type: 'upsert',
        table: SyncTableName.AiChatRequests,
        row: toAiChatSyncPayload(row),
        row_id: String(row.id),
      },
    ],
    actor,
    { allowSyncConflicts: true },
  );
}

export async function questionFileHref(questionFileJson: string | null): Promise<string | null> {
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

export async function uploadAnswerBuffer(
  requestId: string,
  name: string,
  bytes: Buffer,
  actorId: string,
): Promise<Record<string, unknown>> {
  const base = (process.env.YANDEX_DISK_BASE_PATH ?? '').trim();
  if (!base) throw new Error('YANDEX_DISK_BASE_PATH не настроен');
  const safeName = name.replaceAll(/[^a-zA-Z0-9а-яА-Я._ -]+/g, '_').slice(0, 180) || 'file';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = randomUUID();
  const createdAt = nowMs();
  const diskPath = `${base.replace(/\/+$/, '')}/ai_chat/${requestId}/ai-chat-files/${id}_${safeName}`;
  await ensureFolderDeep(base.replace(/\/+$/, '') || '/');
  await getUploadHref({ diskPath, overwrite: true, ensureParent: true });
  // uploadFileStream работает с файлом на диске — пишем во временный (без изменения yandexDisk.ts).
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-'));
  const tmpPath = join(dir, safeName);
  writeFileSync(tmpPath, bytes);
  try {
    await uploadFileStream({ diskPath, localFilePath: tmpPath, mime: null });
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // temp cleanup is best-effort
    }
  }
  await db.insert(fileAssets).values({
    id,
    createdAt,
    createdByUserId: actorId as any,
    name: safeName,
    mime: null,
    size: bytes.length,
    sha256,
    storageKind: 'yandex',
    localRelPath: null,
    yandexDiskPath: diskPath,
  });
  return { id, name: safeName, size: bytes.length, mime: null, sha256, createdAt };
}

/** DM суперадмину об эскалации (паттерн aiAgentReportsService.sendReportToSuperadmin). */
export async function notifySuperadminEscalation(
  actor: AiChatActor,
  args: { username: string; questionText: string; reason: string },
): Promise<boolean> {
  const list = await listEmployeesAuth();
  const sa = list.ok ? list.rows.find((r) => String(r.systemRole ?? '').toLowerCase() === 'superadmin') : null;
  if (!sa?.id) return false;
  const ts = nowMs();
  const msgId = randomUUID();
  const text =
    `⚠️ ИИваныч: эскалация вопроса от ${args.username}:\n«${String(args.questionText).slice(0, 500)}»\n\n` +
    `Причина: ${args.reason || '(не указана)'}\n\nОткройте ИИваныча → блок «Эскалации» и дайте вердикт.`;
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
  return true;
}
