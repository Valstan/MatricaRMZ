/**
 * Модуль печатных форм: шаблоны форм и документы (промты КАРМАНА #4/#5).
 *
 * Две сущности, разные по смыслу и по жизни:
 *
 *  - **Шаблон** (`print_templates`) — форма: какие блоки печатать, какие картинки и
 *    правила подстановки. Живёт в БД, общий или личный; личный перекрывает общий.
 *  - **Документ** (`print_documents`) — заполненный экземпляр формы. Хранит СНИМОК
 *    раскладки на момент заполнения: правка шаблона не переписывает уже отправленный
 *    документ.
 *
 * Обе таблицы ВНЕ sync-контракта: их ведут только эти двери, клиент ходит по REST.
 * Клиентский push в них невозможен — их нет в `SyncTableName`, а значит и в журнале.
 */
import { and, eq, isNull } from 'drizzle-orm';

import {
  MAX_PRINT_TEMPLATE_IMAGE_BYTES,
  parsePrintTemplateLayout,
  type PrintDocumentDto,
  type PrintTemplateLayout,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { printDocuments, printTemplates } from '../database/schema.js';
import { logInfo } from '../utils/logger.js';

/** Контракт ответа — как в `ppeOrderNormsService`: успех несёт поля прямо, провал — `error`. */
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export type PrintTemplateDto = {
  id: string;
  ownerId: string;
  entityKey: string;
  formKey: string;
  name: string;
  layoutJson: string;
  isDefault: boolean;
  updatedAt: number;
  updatedBy: string | null;
  createdAt: number;
};

export type PrintDocumentScope = 'inbox' | 'sent' | 'drafts';

// ── Шаблоны ─────────────────────────────────────────────────────────────────

/**
 * Шаблоны формы: общие (`ownerId='shared'`) и личные. Личный перекрывает общий по
 * паре (вид объекта + форма) — поэтому список отдаём «сначала личные».
 */
export async function listPrintTemplates(args: {
  entityKey: string;
  ownerId: string;
}): Promise<PrintTemplateDto[]> {
  const entityKey = String(args.entityKey ?? '').trim();
  if (!entityKey) return [];
  const rows = await db
    .select()
    .from(printTemplates)
    .where(and(isNull(printTemplates.deletedAt), eq(printTemplates.entityKey, entityKey)));
  const visible = rows.filter((r) => r.ownerId === 'shared' || r.ownerId === args.ownerId);
  return visible
    .map((r) => ({
      id: String(r.id),
      ownerId: String(r.ownerId),
      entityKey: String(r.entityKey),
      formKey: String(r.formKey),
      name: String(r.name),
      layoutJson: String(r.layoutJson),
      isDefault: r.isDefault === true,
      updatedAt: Number(r.updatedAt),
      updatedBy: r.updatedBy == null ? null : String(r.updatedBy),
      createdAt: Number(r.createdAt),
    }))
    .sort((a, b) => (a.ownerId === 'shared' ? 1 : 0) - (b.ownerId === 'shared' ? 1 : 0));
}

/** Все шаблоны всех видов объектов — для раздела «Печатные формы». */
export async function listAllPrintTemplates(args: { ownerId: string }): Promise<PrintTemplateDto[]> {
  const rows = await db.select().from(printTemplates).where(isNull(printTemplates.deletedAt));
  const visible = rows.filter((r) => r.ownerId === 'shared' || r.ownerId === args.ownerId);
  return visible
    .map((r) => ({
      id: String(r.id),
      ownerId: String(r.ownerId),
      entityKey: String(r.entityKey),
      formKey: String(r.formKey),
      name: String(r.name),
      layoutJson: String(r.layoutJson),
      isDefault: r.isDefault === true,
      updatedAt: Number(r.updatedAt),
      updatedBy: r.updatedBy == null ? null : String(r.updatedBy),
      createdAt: Number(r.createdAt),
    }))
    .sort((a, b) => a.entityKey.localeCompare(b.entityKey) || a.name.localeCompare(b.name));
}

/**
 * Проверка раскладки на двери. Битый JSON и картинка тяжелее потолка — отказ:
 * шаблон едет в каждый клиент, и тяжёлая картинка делает его дорогим для всех.
 */
export function validatePrintTemplateLayout(layoutJson: string): Result<{ layout: PrintTemplateLayout }> {
  const raw = String(layoutJson ?? '').trim();
  if (!raw) return { ok: false, error: 'Раскладка шаблона обязательна' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Раскладка шаблона — не корректный JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Раскладка шаблона должна быть объектом' };
  }
  const layout = parsePrintTemplateLayout(raw);
  for (const image of layout.images ?? []) {
    // data URI: «data:image/png;base64,<payload>» — размер считаем по payload'у.
    const payload = image.dataUri.slice(image.dataUri.indexOf(',') + 1);
    const bytes = Math.floor((payload.length * 3) / 4);
    if (bytes > MAX_PRINT_TEMPLATE_IMAGE_BYTES) {
      return {
        ok: false,
        error: `Картинка «${image.caption || image.id}» больше ${Math.round(MAX_PRINT_TEMPLATE_IMAGE_BYTES / 1024)} КБ — уменьшите её`,
      };
    }
  }
  return { ok: true, layout };
}

export async function savePrintTemplate(input: {
  id?: string;
  ownerId: string;
  entityKey: string;
  formKey: string;
  name: string;
  layoutJson: string;
  isDefault?: boolean;
  updatedBy?: string;
}): Promise<Result<{ id: string }>> {
  try {
    const entityKey = String(input.entityKey ?? '').trim();
    const formKey = String(input.formKey ?? '').trim() || entityKey;
    const name = String(input.name ?? '').trim();
    const ownerId = String(input.ownerId ?? 'shared').trim() || 'shared';
    if (!entityKey) return { ok: false, error: 'Вид объекта (entityKey) обязателен' };
    if (!name) return { ok: false, error: 'Название шаблона обязательно' };
    const checked = validatePrintTemplateLayout(input.layoutJson);
    if (!checked.ok) return checked;

    const now = Date.now();
    const id = String(input.id ?? '').trim() || crypto.randomUUID();
    const existing = await db
      .select({ id: printTemplates.id })
      .from(printTemplates)
      .where(eq(printTemplates.id, id as never))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(printTemplates)
        .set({
          name,
          layoutJson: String(input.layoutJson ?? ''),
          isDefault: input.isDefault === true,
          updatedAt: now,
          updatedBy: input.updatedBy ?? null,
          deletedAt: null,
        } as never)
        .where(eq(printTemplates.id, id as never));
    } else {
      await db.insert(printTemplates).values({
        id,
        ownerId,
        entityKey,
        formKey,
        name,
        layoutJson: String(input.layoutJson ?? ''),
        isDefault: input.isDefault === true,
        updatedAt: now,
        updatedBy: input.updatedBy ?? null,
        createdAt: now,
        deletedAt: null,
      });
    }
    // «По умолчанию» — один на пару (владелец + вид объекта + форма): иначе печать
    // брала бы шаблон наугад, и оператор не понимал бы, почему на бумаге не то.
    if (input.isDefault === true) {
      await db
        .update(printTemplates)
        .set({ isDefault: false, updatedAt: now })
        .where(
          and(
            eq(printTemplates.ownerId, ownerId),
            eq(printTemplates.entityKey, entityKey),
            eq(printTemplates.formKey, formKey),
            isNull(printTemplates.deletedAt),
          ),
        );
      await db
        .update(printTemplates)
        .set({ isDefault: true })
        .where(eq(printTemplates.id, id as never));
    }
    logInfo('print template saved', { entityKey, ownerId, name });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Удаление шаблона. Общий удаляет тот, у кого есть право править справочники;
 * личный — только его владелец.
 */
export async function deletePrintTemplate(
  id: string,
  actor: { id: string; canEditShared: boolean },
): Promise<Result<{ deleted: true }>> {
  try {
    const templateId = String(id ?? '').trim();
    if (!templateId) return { ok: false, error: 'id обязателен' };
    const rows = await db
      .select({ id: printTemplates.id, ownerId: printTemplates.ownerId })
      .from(printTemplates)
      .where(eq(printTemplates.id, templateId as never))
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Шаблон не найден' };
    if (row.ownerId !== 'shared' && row.ownerId !== actor.id && !actor.canEditShared) {
      return { ok: false, error: 'Личный шаблон удаляет его владелец' };
    }
    const now = Date.now();
    await db
      .update(printTemplates)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(printTemplates.id, templateId as never));
    return { ok: true, deleted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Документы ───────────────────────────────────────────────────────────────

/**
 * Документы по разбору: входящие (адресованные мне), отправленные (мои) и черновики.
 * Входящие определяются по логину получателя — он же идентифицирует оператора
 * в сессии, поэтому «пришёл документ» работает без отдельного справочника.
 */
export async function listPrintDocuments(args: {
  actorUsername: string;
  actorId: string;
  scope: PrintDocumentScope;
}): Promise<PrintDocumentDto[]> {
  const rows = await db.select().from(printDocuments).where(isNull(printDocuments.deletedAt));
  const username = String(args.actorUsername ?? '').trim();
  const actorId = String(args.actorId ?? '').trim();
  const filtered = rows.filter((r) => {
    if (args.scope === 'inbox') return String(r.recipientUsername ?? '') === username && r.status === 'sent';
    if (args.scope === 'sent') return String(r.authorId ?? '') === actorId && r.status !== 'draft';
    return String(r.authorId ?? '') === actorId && r.status === 'draft';
  });
  return filtered
    .map((r) => toDocumentDto(r))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function toDocumentDto(r: typeof printDocuments.$inferSelect): PrintDocumentDto {
  return {
    id: String(r.id),
    entityKey: String(r.entityKey),
    formKey: String(r.formKey),
    templateId: r.templateId == null ? null : String(r.templateId),
    title: String(r.title),
    valuesJson: String(r.valuesJson ?? '{}'),
    layoutJson: String(r.layoutJson ?? '{}'),
    status: r.status as PrintDocumentDto['status'],
    authorId: String(r.authorId),
    authorUsername: String(r.authorUsername ?? ''),
    recipientId: r.recipientId == null ? null : String(r.recipientId),
    recipientUsername: r.recipientUsername == null ? null : String(r.recipientUsername),
    note: String(r.note ?? ''),
    decisionNote: String(r.decisionNote ?? ''),
    decidedAt: r.decidedAt == null ? null : Number(r.decidedAt),
    decidedBy: r.decidedBy == null ? null : String(r.decidedBy),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  };
}

export async function createPrintDocument(input: {
  entityKey: string;
  formKey: string;
  templateId?: string | null;
  title: string;
  valuesJson: string;
  layoutJson: string;
  note?: string;
  authorId: string;
  authorUsername: string;
}): Promise<Result<{ id: string }>> {
  try {
    const entityKey = String(input.entityKey ?? '').trim();
    const title = String(input.title ?? '').trim();
    if (!entityKey) return { ok: false, error: 'Вид документа обязателен' };
    if (!title) return { ok: false, error: 'Заголовок документа обязателен' };
    const valuesJson = String(input.valuesJson ?? '{}');
    try {
      JSON.parse(valuesJson);
    } catch {
      return { ok: false, error: 'Значения полей — не корректный JSON' };
    }
    const now = Date.now();
    const id = crypto.randomUUID();
    await db.insert(printDocuments).values({
      id,
      entityKey,
      formKey: String(input.formKey ?? '').trim() || entityKey,
      templateId: input.templateId ?? null,
      title,
      valuesJson,
      layoutJson: String(input.layoutJson ?? '{}'),
      status: 'draft',
      authorId: String(input.authorId ?? ''),
      authorUsername: String(input.authorUsername ?? ''),
      note: String(input.note ?? ''),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    logInfo('print document created', { entityKey, title });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Отправка документа другому оператору: черновик → «пришёл». */
export async function sendPrintDocument(
  id: string,
  input: { recipientId?: string | null; recipientUsername: string; note?: string },
): Promise<Result<{ id: string }>> {
  try {
    const documentId = String(id ?? '').trim();
    if (!documentId) return { ok: false, error: 'id обязателен' };
    const recipient = String(input.recipientUsername ?? '').trim();
    if (!recipient) return { ok: false, error: 'Получатель обязателен' };
    const rows = await db
      .select({ id: printDocuments.id, status: printDocuments.status })
      .from(printDocuments)
      .where(eq(printDocuments.id, documentId as never))
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Документ не найден' };
    if (row.status !== 'draft') return { ok: false, error: 'Отправить можно только черновик' };
    const now = Date.now();
    await db
      .update(printDocuments)
      .set({
        status: 'sent',
        recipientId: input.recipientId ?? null,
        recipientUsername: recipient,
        note: input.note ?? '',
        updatedAt: now,
      } as never)
      .where(eq(printDocuments.id, documentId as never));
    logInfo('print document sent', { documentId, recipient });
    return { ok: true, id: documentId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Приёмка документа: получатель явно принимает или отклоняет. «Просто синхронизировать
 * строки» приёмку не заменяет — решение остаётся за человеком, поэтому приёмка и
 * отклонение пишут, кто и когда решил.
 */
export async function decidePrintDocument(
  id: string,
  input: { decision: 'accepted' | 'rejected'; note?: string; actorUsername: string },
): Promise<Result<{ id: string }>> {
  try {
    const documentId = String(id ?? '').trim();
    if (!documentId) return { ok: false, error: 'id обязателен' };
    const rows = await db
      .select({
        id: printDocuments.id,
        status: printDocuments.status,
        recipientUsername: printDocuments.recipientUsername,
      })
      .from(printDocuments)
      .where(eq(printDocuments.id, documentId as never))
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Документ не найден' };
    if (row.status !== 'sent') return { ok: false, error: 'Решение принимается по отправленному документу' };
    if (String(row.recipientUsername ?? '') !== String(input.actorUsername ?? '')) {
      return { ok: false, error: 'Принять документ может только получатель' };
    }
    const now = Date.now();
    await db
      .update(printDocuments)
      .set({
        status: input.decision,
        decisionNote: String(input.note ?? ''),
        decidedAt: now,
        decidedBy: String(input.actorUsername ?? ''),
        updatedAt: now,
      } as never)
      .where(eq(printDocuments.id, documentId as never));
    logInfo('print document decided', { documentId, decision: input.decision });
    return { ok: true, id: documentId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deletePrintDocument(
  id: string,
  actor: { id: string },
): Promise<Result<{ deleted: true }>> {
  try {
    const documentId = String(id ?? '').trim();
    if (!documentId) return { ok: false, error: 'id обязателен' };
    const rows = await db
      .select({ id: printDocuments.id, authorId: printDocuments.authorId })
      .from(printDocuments)
      .where(eq(printDocuments.id, documentId as never))
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Документ не найден' };
    if (String(row.authorId ?? '') !== String(actor.id ?? '')) {
      return { ok: false, error: 'Удалить документ может только его автор' };
    }
    const now = Date.now();
    await db
      .update(printDocuments)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(printDocuments.id, documentId as never));
    return { ok: true, deleted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Непрочитанные входящие — счётчик на кнопке «Документы». */
export async function countIncomingPrintDocuments(actorUsername: string): Promise<number> {
  const rows = await db
    .select({ id: printDocuments.id })
    .from(printDocuments)
    .where(
      and(
        isNull(printDocuments.deletedAt),
        eq(printDocuments.recipientUsername, String(actorUsername ?? '').trim()),
        eq(printDocuments.status, 'sent'),
      ),
    );
  return rows.length;
}
