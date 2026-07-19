// Асинхронный AI-чат: локальный CRUD очереди вопросов (sync-таблица ai_chat_requests).
// Клиент пишет ТОЛЬКО вопрос (owner-private, ≤5/час — гейт на сервере); ответы приезжают
// pull'ом от облачной рутины. Файл вопроса заливается на Яндекс через существующий files-контур.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { asc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { AiChatMetaResult, AiChatRequestItem, AiChatRequestStatus } from '@matricarmz/shared';

import { aiChatRequests } from '../database/schema.js';
import { getSession } from './authService.js';
import { httpAuthed } from './httpClient.js';
import { filesUpload } from './fileService.js';

function nowMs() {
  return Date.now();
}

async function currentUser(db: BetterSQLite3Database): Promise<{ id: string; username: string; role: string } | null> {
  const s = await getSession(db).catch(() => null);
  const u = s?.user;
  if (!u?.id) return null;
  return { id: String(u.id), username: String(u.username ?? '').trim() || 'unknown', role: String(u.role ?? '') };
}

function mapRow(row: any): AiChatRequestItem {
  return {
    id: String(row.id),
    userId: String(row.userId),
    username: String(row.username ?? ''),
    questionText: String(row.questionText ?? ''),
    questionFileJson: row.questionFileJson == null ? null : String(row.questionFileJson),
    status: (row.status ?? 'pending') as AiChatRequestStatus,
    answerText: row.answerText == null ? null : String(row.answerText),
    answerFilesJson: row.answerFilesJson == null ? null : String(row.answerFilesJson),
    answeredAt: row.answeredAt == null ? null : Number(row.answeredAt),
    escalationNote: row.escalationNote == null ? null : String(row.escalationNote),
    verdictText: row.verdictText == null ? null : String(row.verdictText),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    deletedAt: row.deletedAt == null ? null : Number(row.deletedAt),
  };
}

export async function aiChatList(
  db: BetterSQLite3Database,
): Promise<{ ok: true; items: AiChatRequestItem[] } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    // В реплике оператора лежат только его строки (privacy pull); у админа — все,
    // это и нужно для просмотра эскалаций.
    const rows = await db
      .select()
      .from(aiChatRequests)
      .where(isNull(aiChatRequests.deletedAt))
      .orderBy(asc(aiChatRequests.createdAt))
      .limit(50_000);
    return { ok: true, items: rows.map(mapRow) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function aiChatCreate(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { questionText: string; filePath?: string },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const questionText = String(args.questionText ?? '').trim();
    if (!questionText) return { ok: false, error: 'empty question' };

    const id = randomUUID();
    let questionFileJson: string | null = null;
    if (args.filePath) {
      const up = await filesUpload(db, apiBaseUrl, {
        path: String(args.filePath),
        scope: { ownerType: 'ai_chat', ownerId: id, category: 'ai-chat-files' },
      });
      if (!up.ok) return { ok: false, error: `file upload: ${up.error}` };
      questionFileJson = JSON.stringify(up.file);
    }

    const ts = nowMs();
    await db.insert(aiChatRequests).values({
      id,
      userId: me.id,
      username: me.username,
      questionText,
      questionFileJson,
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function aiChatUpdate(
  db: BetterSQLite3Database,
  args: { id: string; questionText: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const questionText = String(args.questionText ?? '').trim();
    if (!questionText) return { ok: false, error: 'empty question' };
    const existing = await db.select().from(aiChatRequests).where(eq(aiChatRequests.id, String(args.id))).limit(1);
    const cur = existing[0] as any;
    if (!cur || cur.deletedAt != null) return { ok: false, error: 'not found' };
    if (String(cur.userId) !== me.id) return { ok: false, error: 'not owner' };
    if (String(cur.status) !== 'pending') return { ok: false, error: 'already processed' };
    await db
      .update(aiChatRequests)
      .set({ questionText, updatedAt: nowMs(), syncStatus: 'pending' })
      .where(eq(aiChatRequests.id, String(args.id)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function aiChatDelete(
  db: BetterSQLite3Database,
  args: { id: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    const existing = await db.select().from(aiChatRequests).where(eq(aiChatRequests.id, String(args.id))).limit(1);
    const cur = existing[0] as any;
    if (!cur || cur.deletedAt != null) return { ok: false, error: 'not found' };
    if (String(cur.userId) !== me.id) return { ok: false, error: 'not owner' };
    if (String(cur.status) !== 'pending') return { ok: false, error: 'already processed' };
    await db
      .update(aiChatRequests)
      .set({ deletedAt: nowMs(), updatedAt: nowMs(), syncStatus: 'pending' })
      .where(eq(aiChatRequests.id, String(args.id)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function aiChatSetVerdict(
  db: BetterSQLite3Database,
  args: { id: string; verdictText: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false, error: 'auth required' };
    if (String(me.role).toLowerCase() !== 'superadmin') return { ok: false, error: 'superadmin only' };
    const verdictText = String(args.verdictText ?? '').trim();
    if (!verdictText) return { ok: false, error: 'empty verdict' };
    const existing = await db.select().from(aiChatRequests).where(eq(aiChatRequests.id, String(args.id))).limit(1);
    const cur = existing[0] as any;
    if (!cur || cur.deletedAt != null) return { ok: false, error: 'not found' };
    if (String(cur.status) !== 'escalated') return { ok: false, error: 'not escalated' };
    await db
      .update(aiChatRequests)
      .set({ verdictText, updatedAt: nowMs(), syncStatus: 'pending' })
      .where(eq(aiChatRequests.id, String(args.id)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function aiChatMeta(db: BetterSQLite3Database, apiBaseUrl: string): Promise<AiChatMetaResult> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, '/ai-chat/meta', { method: 'GET' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok) return { ok: false, error: 'bad response' };
    return { ok: true, lastRunAt: j.lastRunAt == null ? null : Number(j.lastRunAt) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
