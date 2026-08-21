import { and, eq, isNull, like, or } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  aiChatRequests,
  attributeDefs,
  attributeValues,
  chatMessages,
  directoryParts,
  entities,
  entityTypes,
  noteShares,
  notes,
  operations,
} from '../database/schema.js';
import { PermissionCode, getEffectivePermissionsForUser } from '../auth/permissions.js';

// ── Linkage-aware file authorization (security-hardening-2026-06, Phase 3) ──
// A file_asset is readable by: its uploader, an admin, or anyone who can see a
// context that references it (chat sender/recipient, note owner/share, an engine
// operation, an EAV entity attachment, or the directory_parts mirror). File ids
// live inside JSON TEXT columns (no FK), so we LIKE-prefilter candidate rows then
// verify the exact id via a structure-agnostic recursive walk (no substring false
// positives). The decision is cached briefly so photo galleries (many per-image
// reads) stay responsive. This replaces the old flat "any files.view holder can
// read any file id" behaviour (the IDOR).

// Returns true only if `id` appears as a whole string VALUE somewhere in the
// parsed JSON — never a substring match. Structure-agnostic so it covers chat
// FileRef ({id}), note blocks ({fileId}), operation payloads (attachments[]),
// and EAV FileRef[] without per-shape parsing.
export function jsonContainsId(jsonStr: string | null | undefined, id: string): boolean {
  if (!jsonStr || !id) return false;
  // Cheap reject: the id must at least appear as a substring of the raw text.
  if (!jsonStr.includes(id)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return false;
  }
  const stack: unknown[] = [parsed];
  while (stack.length) {
    const cur = stack.pop();
    if (cur == null) continue;
    if (typeof cur === 'string') {
      if (cur === id) return true;
      continue;
    }
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    if (typeof cur === 'object') {
      for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v);
    }
  }
  return false;
}

// Attribute codes that hold FileRef[]. `attachments` is seeded for every entity
// type (and auto-added to types the operator creates); `photos` covers tools and
// simple masterdata; `drawings`/`tech_docs` stopped being written when they were
// merged into `attachments`, but rows written before that merge are still live.
const FILE_BEARING_ATTR_CODES = new Set(['attachments', 'photos', 'drawings', 'tech_docs']);

// Only an attribute that is *meant* to carry files may authorize a file. Every
// other EAV row is free-form content the requester can write themselves (own
// full_name, own ui_profile_json, an attribute of an entity they created), so
// treating "this id occurs somewhere in a type I may view" as proof of access
// lets anyone who learns a file id grant it to themselves.
export function attrDefHoldsFiles(attrCode: string, metaJson: string | null | undefined): boolean {
  if (FILE_BEARING_ATTR_CODES.has(attrCode)) return true;
  // Contract cards let the operator add file fields under an arbitrary code; the
  // marker in metaJson is the only thing identifying them — the card itself picks
  // them the same way.
  if (!metaJson) return false;
  try {
    const meta: unknown = JSON.parse(metaJson);
    return typeof meta === 'object' && meta !== null && (meta as { ui?: unknown }).ui === 'files';
  } catch {
    return false;
  }
}

export function permsForEntityTypeCode(code: string): PermissionCode[] {
  switch (code) {
    case 'engine':
      return [PermissionCode.EnginesView];
    case 'employee':
      return [PermissionCode.EmployeesView];
    case 'part':
      // part files surface both on the parts card (parts.view) and the warehouse
      // nomenclature part-spec card (erp.dictionary.view) — either grants read.
      return [PermissionCode.PartsView, PermissionCode.ErpDictionaryView];
    case 'contract':
      return [PermissionCode.ContractsEdit, PermissionCode.MasterDataView];
    default:
      // engine_brand, customer, tool, and other simple masterdata entities
      return [PermissionCode.MasterDataView];
  }
}

export type EavFileRow = {
  typeCode: string;
  attrCode: string;
  attrMetaJson: string | null;
  valueJson: string | null;
};

// The whole decision for one EAV row in one place, so the three conditions are
// tested together: drop any one of them and access silently widens, while every
// individual unit test below still passes.
export function eavRowGrantsFileAccess(row: EavFileRow, fileId: string, has: (perm: string) => boolean): boolean {
  if (!attrDefHoldsFiles(row.attrCode, row.attrMetaJson)) return false;
  if (!permsForEntityTypeCode(row.typeCode).some((p) => has(p))) return false;
  return jsonContainsId(row.valueJson, fileId);
}

type FileActor = { id: string; role?: string | null };
type FileRow = { id: string; createdByUserId: string | null };

async function computeFileAccess(actor: FileActor, file: FileRow): Promise<boolean> {
  const role = String(actor.role || '').toLowerCase();
  if (role === 'admin' || role === 'superadmin') return true;
  if (file.createdByUserId && String(file.createdByUserId) === actor.id) return true;

  const id = String(file.id);
  const likeArg = `%${id}%`;
  const perms = await getEffectivePermissionsForUser(actor.id);
  const has = (code: string) => perms[code] === true;

  // 1) Chat attachment. Scope the query to messages the actor participates in
  // (global, or where they are sender/recipient) so a LIMIT can never drop the
  // row that would grant access — a deduped file id can legitimately appear in
  // many messages (e.g. an admin broadcasting one file individually to many
  // recipients).
  const myChat = await db
    .select({ payload: chatMessages.payloadJson })
    .from(chatMessages)
    .where(
      and(
        isNull(chatMessages.deletedAt),
        like(chatMessages.payloadJson, likeArg),
        or(
          isNull(chatMessages.recipientUserId),
          eq(chatMessages.recipientUserId, actor.id as any),
          eq(chatMessages.senderUserId, actor.id as any),
        ),
      ),
    )
    .limit(50);
  for (const row of myChat) {
    if (jsonContainsId(row.payload, id)) return true;
  }
  // Chat admins (clamped to admin/superadmin in getEffectivePermissionsForUser)
  // may read any chat-linked file.
  if (has(PermissionCode.ChatAdminView)) {
    const anyChat = await db
      .select({ payload: chatMessages.payloadJson })
      .from(chatMessages)
      .where(and(isNull(chatMessages.deletedAt), like(chatMessages.payloadJson, likeArg)))
      .limit(50);
    for (const row of anyChat) {
      if (jsonContainsId(row.payload, id)) return true;
    }
  }

  // 2) Note image block — owner, or a note shared with the actor. Both queries
  // are scoped to the actor so the LIMIT cannot drop the authorizing row.
  const myNotes = await db
    .select({ body: notes.bodyJson })
    .from(notes)
    .where(and(isNull(notes.deletedAt), like(notes.bodyJson, likeArg), eq(notes.ownerUserId, actor.id as any)))
    .limit(50);
  for (const n of myNotes) {
    if (jsonContainsId(n.body, id)) return true;
  }
  const sharedNotes = await db
    .select({ body: notes.bodyJson })
    .from(notes)
    .innerJoin(
      noteShares,
      and(eq(noteShares.noteId, notes.id), eq(noteShares.recipientUserId, actor.id as any), isNull(noteShares.deletedAt)),
    )
    .where(and(isNull(notes.deletedAt), like(notes.bodyJson, likeArg)))
    .limit(50);
  for (const n of sharedNotes) {
    if (jsonContainsId(n.body, id)) return true;
  }

  // 3) Engine operation attachment (repair checklist / supply request / acts).
  if (has(PermissionCode.EnginesView)) {
    const opRows = await db
      .select({ meta: operations.metaJson })
      .from(operations)
      .where(and(isNull(operations.deletedAt), like(operations.metaJson, likeArg)))
      .limit(50);
    for (const op of opRows) {
      if (jsonContainsId(op.meta, id)) return true;
    }
  }

  // 4) EAV entity attachment. A row grants the file only if all three hold: the
  // attribute is one that carries files, the value really references this id (a
  // bare LIKE also matches an id pasted into free text), and the actor may view
  // the owning entity type. Dropping any one of them turns "I can write anywhere"
  // into "I can read any file whose id I know".
  // The join deliberately does NOT filter attributeDefs.deletedAt: deleting an
  // attribute definition keeps its values, and the engine card still reads and
  // writes attachments through a soft-deleted def — filtering here would 403 the
  // very files that card shows.
  const eavRows = await db
    .select({
      typeCode: entityTypes.code,
      attrCode: attributeDefs.code,
      attrMetaJson: attributeDefs.metaJson,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .innerJoin(entities, eq(entities.id, attributeValues.entityId))
    .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .where(and(isNull(attributeValues.deletedAt), like(attributeValues.valueJson, likeArg)));
  for (const r of eavRows) {
    const row: EavFileRow = {
      typeCode: String(r.typeCode || ''),
      attrCode: String(r.attrCode || ''),
      attrMetaJson: r.attrMetaJson,
      valueJson: r.valueJson,
    };
    if (eavRowGrantsFileAccess(row, id, has)) return true;
  }

  // 5) AI-чат: файл вопроса/ответа читаем владельцем запроса (ответные файлы
  // создаёт актор ai-agent, поэтому createdByUserId-ветки недостаточно).
  {
    const aiRows = await db
      .select({ q: aiChatRequests.questionFileJson, a: aiChatRequests.answerFilesJson })
      .from(aiChatRequests)
      .where(
        and(
          isNull(aiChatRequests.deletedAt),
          eq(aiChatRequests.userId, actor.id as any),
          or(like(aiChatRequests.questionFileJson, likeArg), like(aiChatRequests.answerFilesJson, likeArg)),
        ),
      )
      .limit(50);
    for (const r of aiRows) {
      if (jsonContainsId(r.q, id) || jsonContainsId(r.a, id)) return true;
    }
  }

  // 6) directory_parts mirror of part FileRefs (parts card or part-spec card).
  if (has(PermissionCode.PartsView) || has(PermissionCode.ErpDictionaryView)) {
    const dpRows = await db
      .select({ meta: directoryParts.metadataJson })
      .from(directoryParts)
      .where(and(isNull(directoryParts.deletedAt), like(directoryParts.metadataJson, likeArg)))
      .limit(20);
    for (const dp of dpRows) {
      if (jsonContainsId(dp.meta, id)) return true;
    }
  }

  return false;
}

const fileAccessCache = new Map<string, { allowed: boolean; exp: number }>();
const FILE_ACCESS_TTL_MS = 30_000;
const FILE_ACCESS_CACHE_MAX = 5000;

export async function canAccessFile(actor: FileActor | undefined, file: FileRow): Promise<boolean> {
  if (!actor?.id) return false;
  const key = `${actor.id}:${file.id}`;
  const now = Date.now();
  const cached = fileAccessCache.get(key);
  if (cached && cached.exp > now) return cached.allowed;
  const allowed = await computeFileAccess(actor, file);
  if (fileAccessCache.size >= FILE_ACCESS_CACHE_MAX) fileAccessCache.clear();
  fileAccessCache.set(key, { allowed, exp: now + FILE_ACCESS_TTL_MS });
  return allowed;
}
