// Перевод ссылок со вторичной записи сотрудника на основную — шаг 2 плана
// owner-batch-2026-09 §PR 8. До него слияние отказывало при любой ссылке (#863).
//
// Почему отдельный файл: перевод — это тринадцать хранилищ, четыре из них через журнал,
// плюс правила столкновений; внутри `employeeDedupeService` он утопил бы сам порядок слияния.
//
// Один проход служит и проверке, и слиянию (`apply`): иначе «Проверить» показывала бы одни
// числа, а слияние делало другое — ровно та рассинхронизация, из-за которой перевод и ждали.
//
// Что НЕ переводится, осознанно:
//  - история и аудит: `audit_log`, `ledger_tx_index`, `release_registry`, `statistics_*`,
//    `ai_chat_rules_history`, `updated_by`/`created_by` шаблонов, `operations.performed_by`,
//    `erp_reg_stock_movements.performed_by` — это записи о том, кто и под каким ИМЕНЕМ что
//    сделал; подмена имени в них была бы подделкой записи, а не починкой ссылки;
//  - `snapshot_json` проведённой дефектовки — снимок защищён `snapshot_hash`, правка сломала бы
//    сверку; действующая ссылка этой версии живёт в колонке `conducted_by`, её и переводим;
//  - строки самой вторичной записи (`user_credentials`, `user_settings`, `user_section_access`,
//    её собственные атрибуты) — это её данные, а не ссылки на неё.
import { SyncTableName, SyncTableRegistry, humanLabel, parseRoomMembers, serializeRoomMembers } from '@matricarmz/shared';

import { and, eq, isNull, like, or } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  aiChatHistory,
  aiChatRequests,
  assemblyShortageApprovals,
  attributeDefs,
  attributeValues,
  cardDrafts,
  chatRooms,
  defectConductedVersions,
  defectPartEvents,
  entities,
  erpDocumentHeaders,
  erpEmployeeCards,
  erpEngineAssemblyBom,
  operations,
  timesheetCells,
  timesheetRows,
  timesheets,
} from '../database/schema.js';
import { setEntityAttribute } from './adminMasterdataService.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

type Actor = { id: string; username: string; role: string };

export type RepointStoreCount = { store: string; count: number };
export type RepointBlocker = { store: string; reason: string };

export type RepointOutcome = {
  /** Сколько строк переведено (в режиме проверки — будет переведено). */
  moved: number;
  byStore: RepointStoreCount[];
  /** Ссылки, которые перевести нельзя: слияние из-за них отказывает целиком. */
  blockers: RepointBlocker[];
  /** Что произошло не «один в один»: сложенные доли бригады, снятые дубли, занятые дни табеля. */
  notes: string[];
};

const STORE = {
  eav: 'Ссылки в карточках',
  bom: 'Спецификации сборки (подписи)',
  chatRooms: 'Комнаты чата',
  cardDrafts: 'Черновики карточек',
  aiRequests: 'Вопросы ИИванычу',
  aiHistory: 'История AI-чата',
  timesheetRows: 'Табели (строки)',
  timesheetAuthor: 'Табели (автор)',
  documents: 'Складские документы (автор)',
  approvals: 'Согласования недостачи',
  defectVersions: 'Проведённая дефектовка',
  defectEvents: 'События деталей дефектовки',
} as const;

/** Наряды и заявки названы как в гейте удаления; остальным подпись даёт домен. */
function operationStoreLabel(operationType: string): string {
  if (operationType === 'work_order') return 'Наряды';
  if (operationType === 'supply_request') return 'Заявки снабжения';
  return humanLabel('operation_type', operationType, 'Записи по двигателям');
}

function nowMs() {
  return Date.now();
}

function parseJson(raw: unknown): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return undefined;
  }
}

/**
 * Замена id во всём JSON: строковые значения и ключи-идентификаторы. Кавычки вокруг id в
 * SQL-отборе и сравнение на полное равенство здесь — одно и то же правило: uuid никогда не
 * бывает частью другого uuid, поэтому подстрочных ложных попаданий нет.
 */
export function deepReplaceId(value: unknown, fromId: string, toId: string): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    return value === fromId ? { value: toId, changed: true } : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = deepReplaceId(item, fromId, toId);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const r = deepReplaceId(item, fromId, toId);
      if (r.changed) changed = true;
      const nextKey = key === fromId ? toId : key;
      if (nextKey !== key) changed = true;
      next[nextKey] = r.value;
    }
    return changed ? { value: next, changed } : { value, changed: false };
  }
  return { value, changed: false };
}

const CREW_SUMMED_FIELDS = ['ktu', 'payoutRub', 'manualPayoutRub', 'amountRub'] as const;

/**
 * Обе записи в одной бригаде — это один человек с двумя долями: КТУ и выплаты складываются,
 * запись вторичного уходит. Простая замена id оставила бы двух «одинаковых» рабочих в наряде,
 * и отчёт по зарплате показал бы человека дважды.
 */
function mergePersonEntries(rows: unknown, fromId: string, toId: string): { rows: unknown; merged: number; changed: boolean } {
  if (!Array.isArray(rows)) return { rows, merged: 0, changed: false };
  const out: Array<Record<string, unknown>> = [];
  let merged = 0;
  let changed = false;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out.push(raw as Record<string, unknown>);
      continue;
    }
    const row = { ...(raw as Record<string, unknown>) };
    const id = String(row.employeeId ?? '').trim();
    if (id !== fromId && id !== toId) {
      out.push(row);
      continue;
    }
    if (id === fromId) {
      row.employeeId = toId;
      changed = true;
    }
    const existing = out.find((candidate) => String(candidate.employeeId ?? '').trim() === toId);
    if (!existing) {
      out.push(row);
      continue;
    }
    for (const field of CREW_SUMMED_FIELDS) {
      const left = Number(existing[field] ?? 0);
      const right = Number(row[field] ?? 0);
      if (existing[field] == null && row[field] == null) continue;
      existing[field] = (Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0);
    }
    if (row.payoutFrozen === true) existing.payoutFrozen = true;
    merged += 1;
    changed = true;
  }
  return { rows: out, merged, changed };
}

/**
 * Один человек дважды в одном списке сотрудников акта — дубль, а не двое: снимаем. Комиссию и
 * подписи не трогаем — там один человек законно стоит в двух ролях с разными подписями.
 */
function dedupeEmployeeLists(value: unknown, id: string): { value: unknown; removed: number } {
  let removed = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const obj = { ...(node as Record<string, unknown>) };
    for (const [key, item] of Object.entries(obj)) {
      if (key === 'employees' && Array.isArray(item)) {
        const seen = new Set<string>();
        const kept: unknown[] = [];
        for (const entry of item) {
          const entryId = entry && typeof entry === 'object' ? String((entry as Record<string, unknown>).employeeId ?? '').trim() : '';
          if (entryId && entryId === id) {
            if (seen.has(entryId)) {
              removed += 1;
              continue;
            }
            seen.add(entryId);
          }
          kept.push(entry);
        }
        obj[key] = kept;
        continue;
      }
      obj[key] = walk(item);
    }
    return obj;
  };
  return { value: walk(value), removed };
}

export type OperationRepointResult = {
  metaJson: string | null;
  changed: boolean;
  crewMerged: number;
  duplicatesRemoved: number;
  /** `meta_json` не разобрался: id в нём есть, а безопасно переписать нельзя. */
  unparsable: boolean;
};

/**
 * Перевод ссылок внутри `operations.meta_json`. Сначала бригада и выплаты наряда (там доли
 * складываются), потом общая замена по всему JSON — она и закрывает подписи, утверждающего в
 * грифе, комиссию актов, перемещения инструмента и подписантов заявок, — потом снятие дублей.
 */
export function repointOperationMeta(args: {
  operationType: string;
  metaJson: string | null;
  fromId: string;
  toId: string;
}): OperationRepointResult {
  const parsed = parseJson(args.metaJson);
  if (parsed === undefined || !parsed || typeof parsed !== 'object') {
    return { metaJson: args.metaJson, changed: false, crewMerged: 0, duplicatesRemoved: 0, unparsable: true };
  }

  let changed = false;
  let crewMerged = 0;
  const meta = { ...(parsed as Record<string, unknown>) };

  if (args.operationType === 'work_order') {
    for (const field of ['crew', 'payouts'] as const) {
      const res = mergePersonEntries(meta[field], args.fromId, args.toId);
      if (res.changed) {
        meta[field] = res.rows;
        changed = true;
        crewMerged += res.merged;
      }
    }
  }

  const replaced = deepReplaceId(meta, args.fromId, args.toId);
  if (replaced.changed) changed = true;
  const deduped = dedupeEmployeeLists(replaced.value, args.toId);
  if (deduped.removed > 0) changed = true;

  return {
    metaJson: changed ? JSON.stringify(deduped.value) : args.metaJson,
    changed,
    crewMerged,
    duplicatesRemoved: deduped.removed,
    unparsable: false,
  };
}

/** EAV-значение: та же замена, но у массивной ссылки после неё не должно остаться дублей. */
export function repointAttributeValue(value: unknown, fromId: string, toId: string): { value: unknown; changed: boolean } {
  const replaced = deepReplaceId(value, fromId, toId);
  if (!replaced.changed) return replaced;
  if (Array.isArray(replaced.value)) {
    const seen = new Set<string>();
    const kept: unknown[] = [];
    for (const item of replaced.value) {
      if (typeof item === 'string') {
        if (seen.has(item)) continue;
        seen.add(item);
      }
      kept.push(item);
    }
    return { value: kept, changed: true };
  }
  return replaced;
}

type Ctx = {
  fromId: string;
  toId: string;
  survivorLogin: string;
  loserLogin: string;
  apply: boolean;
  actor: Actor;
  quoted: string;
  out: RepointOutcome;
};

function bump(ctx: Ctx, store: string, n = 1) {
  if (n <= 0) return;
  const found = ctx.out.byStore.find((s) => s.store === store);
  if (found) found.count += n;
  else ctx.out.byStore.push({ store, count: n });
  ctx.out.moved += n;
}

function block(ctx: Ctx, store: string, reason: string) {
  ctx.out.blockers.push({ store, reason });
}

async function publish(ctx: Ctx, tableName: SyncTableName, rowId: string, row: Record<string, unknown>) {
  await recordSyncChanges(
    ctx.actor,
    [{ tableName, rowId, op: 'upsert', payload: SyncTableRegistry.toSyncRow(tableName, row) }],
    { allowSyncConflicts: true },
  );
}

/** Ссылки в EAV: одиночные и массивные link-атрибуты, JSON-атрибуты (резерв двигателя) — все сразу. */
async function repointEavValues(ctx: Ctx) {
  const rows = await db
    .select({
      valueId: attributeValues.id,
      entityId: attributeValues.entityId,
      valueJson: attributeValues.valueJson,
      code: attributeDefs.code,
    })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeValues.attributeDefId, attributeDefs.id))
    .innerJoin(entities, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        isNull(attributeValues.deletedAt),
        isNull(attributeDefs.deletedAt),
        isNull(entities.deletedAt),
        like(attributeValues.valueJson, ctx.quoted),
      ),
    )
    .limit(10_000);

  for (const row of rows) {
    // Атрибуты самой вторичной записи — её данные (включая метку слияния), не ссылки на неё.
    if (String(row.entityId) === ctx.fromId) continue;
    const parsed = parseJson(row.valueJson);
    if (parsed === undefined) {
      block(ctx, STORE.eav, `значение атрибута «${String(row.code)}» не разбирается как JSON`);
      continue;
    }
    const next = repointAttributeValue(parsed, ctx.fromId, ctx.toId);
    if (!next.changed) continue;
    if (ctx.apply) {
      // allowProtectedAttrs: среди служебных кодов есть `delete_requested_by_id` — он тоже
      // ссылка на сотрудника, и оставить её висеть нельзя. Это серверная дверь слияния.
      const res = await setEntityAttribute(ctx.actor, String(row.entityId), String(row.code), next.value, {
        allowSyncConflicts: true,
        allowProtectedAttrs: true,
      });
      if (!res.ok) {
        block(ctx, STORE.eav, `атрибут «${String(row.code)}»: ${res.error}`);
        continue;
      }
    }
    bump(ctx, STORE.eav);
  }
}

async function repointOperations(ctx: Ctx) {
  const rows = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), like(operations.metaJson, ctx.quoted)))
    .limit(10_000);

  for (const row of rows) {
    const type = String(row.operationType);
    const res = repointOperationMeta({ operationType: type, metaJson: row.metaJson ?? null, fromId: ctx.fromId, toId: ctx.toId });
    if (res.unparsable) {
      block(ctx, operationStoreLabel(type), 'meta_json не разбирается как JSON');
      continue;
    }
    if (!res.changed) continue;
    if (ctx.apply) {
      const ts = nowMs();
      await db
        .update(operations)
        .set({ metaJson: res.metaJson, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(operations.id, row.id));
      await publish(ctx, SyncTableName.Operations, String(row.id), { ...row, metaJson: res.metaJson, updatedAt: ts });
    }
    bump(ctx, operationStoreLabel(type));
    if (res.crewMerged > 0) {
      ctx.out.notes.push(`бригада и выплаты наряда: сложено долей ${res.crewMerged} (обе записи были в одном наряде)`);
    }
    if (res.duplicatesRemoved > 0) {
      ctx.out.notes.push(`снято дублей в списках сотрудников: ${res.duplicatesRemoved}`);
    }
  }
}

async function repointAssemblyBom(ctx: Ctx) {
  const rows = await db
    .select()
    .from(erpEngineAssemblyBom)
    .where(and(isNull(erpEngineAssemblyBom.deletedAt), like(erpEngineAssemblyBom.executionProfileJson, ctx.quoted)))
    .limit(10_000);

  for (const row of rows) {
    const parsed = parseJson(row.executionProfileJson);
    if (parsed === undefined) {
      block(ctx, STORE.bom, 'execution_profile_json не разбирается как JSON');
      continue;
    }
    const next = deepReplaceId(parsed, ctx.fromId, ctx.toId);
    if (!next.changed) continue;
    if (ctx.apply) {
      const ts = nowMs();
      const executionProfileJson = JSON.stringify(next.value);
      await db
        .update(erpEngineAssemblyBom)
        .set({ executionProfileJson, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(erpEngineAssemblyBom.id, row.id));
      await publish(ctx, SyncTableName.ErpEngineAssemblyBom, String(row.id), { ...row, executionProfileJson, updatedAt: ts });
    }
    bump(ctx, STORE.bom);
  }
}

/**
 * Комнаты чата: `reassignUserReferences` их не знает (комнаты появились позже, миграция 0094).
 * Участники лежат списком в строке комнаты, и создатель участник по определению — поэтому из
 * списка он вычищается, иначе основная запись оказалась бы в нём дважды.
 */
async function repointChatRooms(ctx: Ctx) {
  const rows = await db
    .select()
    .from(chatRooms)
    .where(
      and(
        isNull(chatRooms.deletedAt),
        or(eq(chatRooms.ownerUserId, ctx.fromId as never), like(chatRooms.membersJson, ctx.quoted)),
      ),
    )
    .limit(10_000);

  for (const row of rows) {
    const owner = String(row.ownerUserId) === ctx.fromId ? ctx.toId : String(row.ownerUserId);
    // Только замена id и снятие дубля (`serializeRoomMembers`): состав комнаты сверх этого не
    // нормализуем — создатель в списке участников безвреден (`roomParticipantIds`), а чужую
    // строку слияние трогает ровно настолько, насколько в ней стояла вторичная запись.
    const members = parseRoomMembers(row.membersJson).map((id) => (id === ctx.fromId ? ctx.toId : id));
    const membersJson = serializeRoomMembers(members);
    if (owner === String(row.ownerUserId) && membersJson === serializeRoomMembers(parseRoomMembers(row.membersJson))) continue;
    if (ctx.apply) {
      const ts = nowMs();
      await db
        .update(chatRooms)
        .set({ ownerUserId: owner as never, membersJson, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(chatRooms.id, row.id));
      await publish(ctx, SyncTableName.ChatRooms, String(row.id), { ...row, ownerUserId: owner, membersJson, updatedAt: ts });
    }
    bump(ctx, STORE.chatRooms);
  }
}

async function repointCardDrafts(ctx: Ctx) {
  const rows = await db
    .select()
    .from(cardDrafts)
    .where(and(isNull(cardDrafts.deletedAt), eq(cardDrafts.ownerUserId, ctx.fromId as never)))
    .limit(10_000);

  for (const row of rows) {
    if (ctx.apply) {
      const ts = nowMs();
      await db
        .update(cardDrafts)
        .set({ ownerUserId: ctx.toId as never, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(cardDrafts.id, row.id));
      await publish(ctx, SyncTableName.CardDrafts, String(row.id), { ...row, ownerUserId: ctx.toId, updatedAt: ts });
    }
    bump(ctx, STORE.cardDrafts);
  }
}

async function repointAiChat(ctx: Ctx) {
  const requests = await db
    .select()
    .from(aiChatRequests)
    .where(and(isNull(aiChatRequests.deletedAt), eq(aiChatRequests.userId, ctx.fromId as never)))
    .limit(10_000);

  for (const row of requests) {
    // `username` в строке — адрес ответа ИИваныча, а не запись истории: без него ответ уехал бы
    // на погашенный логин.
    const username = ctx.survivorLogin || String(row.username);
    if (ctx.apply) {
      const ts = nowMs();
      await db
        .update(aiChatRequests)
        .set({ userId: ctx.toId as never, username, updatedAt: ts, syncStatus: 'synced' })
        .where(eq(aiChatRequests.id, row.id));
      await publish(ctx, SyncTableName.AiChatRequests, String(row.id), { ...row, userId: ctx.toId, username, updatedAt: ts });
    }
    bump(ctx, STORE.aiRequests);
  }

  const history = await db
    .select({ id: aiChatHistory.id })
    .from(aiChatHistory)
    .where(eq(aiChatHistory.userId, ctx.fromId as never))
    .limit(100_000);
  if (history.length > 0) {
    if (ctx.apply) {
      await db.update(aiChatHistory).set({ userId: ctx.toId as never }).where(eq(aiChatHistory.userId, ctx.fromId as never));
    }
    bump(ctx, STORE.aiHistory, history.length);
  }
}

/**
 * Табель: `timesheet_rows_timesheet_employee_uq` не даёт двум строкам одного человека жить в
 * одном табеле. Если обе записи в табеле есть — ячейки вторичной переезжают в строку основной по
 * свободным дням, строка вторичной уходит. Занятый день не перетираем: в нём уже стоит отметка
 * основной записи, и выбор между двумя отметками за один день — не дело слияния.
 */
async function repointTimesheets(ctx: Ctx) {
  const rows = await db
    .select({ id: timesheetRows.id, timesheetId: timesheetRows.timesheetId })
    .from(timesheetRows)
    .innerJoin(timesheets, eq(timesheets.id, timesheetRows.timesheetId))
    .where(and(eq(timesheetRows.employeeId, ctx.fromId as never), isNull(timesheets.deletedAt)))
    .limit(10_000);

  for (const row of rows) {
    const survivorRow = (
      await db
        .select({ id: timesheetRows.id })
        .from(timesheetRows)
        .where(and(eq(timesheetRows.timesheetId, row.timesheetId), eq(timesheetRows.employeeId, ctx.toId as never)))
        .limit(1)
    )[0];

    if (!survivorRow) {
      if (ctx.apply) {
        await db.update(timesheetRows).set({ employeeId: ctx.toId as never }).where(eq(timesheetRows.id, row.id));
      }
      bump(ctx, STORE.timesheetRows);
      continue;
    }

    const loserCells = await db
      .select({ id: timesheetCells.id, day: timesheetCells.day })
      .from(timesheetCells)
      .where(eq(timesheetCells.rowId, row.id))
      .limit(100);
    const survivorDays = new Set(
      (
        await db
          .select({ day: timesheetCells.day })
          .from(timesheetCells)
          .where(eq(timesheetCells.rowId, survivorRow.id))
          .limit(100)
      ).map((c) => Number(c.day)),
    );

    let taken = 0;
    for (const cell of loserCells) {
      if (survivorDays.has(Number(cell.day))) {
        taken += 1;
        continue;
      }
      if (ctx.apply) {
        await db.update(timesheetCells).set({ rowId: survivorRow.id }).where(eq(timesheetCells.id, cell.id));
      }
    }
    if (ctx.apply) {
      await db.delete(timesheetRows).where(eq(timesheetRows.id, row.id));
    }
    bump(ctx, STORE.timesheetRows);
    if (taken > 0) {
      ctx.out.notes.push(`в табеле обе записи уже стояли: ${taken} дн. остались с отметками основной записи`);
    }
  }

  // Автор табеля хранится ЛОГИНОМ и даёт право правки — как `client_settings.lastUsername`.
  if (ctx.loserLogin && ctx.survivorLogin && ctx.loserLogin !== ctx.survivorLogin) {
    const authored = await db
      .select({ id: timesheets.id })
      .from(timesheets)
      .where(and(isNull(timesheets.deletedAt), eq(timesheets.createdBy, ctx.loserLogin)))
      .limit(10_000);
    if (authored.length > 0) {
      if (ctx.apply) {
        await db
          .update(timesheets)
          .set({ createdBy: ctx.survivorLogin, updatedAt: nowMs() })
          .where(and(isNull(timesheets.deletedAt), eq(timesheets.createdBy, ctx.loserLogin)));
      }
      bump(ctx, STORE.timesheetAuthor, authored.length);
    }
  }
}

async function repointServerColumns(ctx: Ctx) {
  // `erp_document_headers.author_id` — внешний ключ на `erp_employee_cards`, а карточки заводятся
  // не всегда: без карточки основной записи перевод уронил бы вставку, поэтому это blocker.
  const documents = await db
    .select({ id: erpDocumentHeaders.id })
    .from(erpDocumentHeaders)
    .where(and(isNull(erpDocumentHeaders.deletedAt), eq(erpDocumentHeaders.authorId, ctx.fromId as never)))
    .limit(10_000);
  if (documents.length > 0) {
    const survivorCard = (
      await db.select({ id: erpEmployeeCards.id }).from(erpEmployeeCards).where(eq(erpEmployeeCards.id, ctx.toId as never)).limit(1)
    )[0];
    if (!survivorCard) {
      block(ctx, STORE.documents, `у основной записи нет строки erp_employee_cards, а на вторичную ссылаются документы (${documents.length})`);
    } else {
      if (ctx.apply) {
        await db
          .update(erpDocumentHeaders)
          .set({ authorId: ctx.toId as never, updatedAt: nowMs() })
          .where(and(isNull(erpDocumentHeaders.deletedAt), eq(erpDocumentHeaders.authorId, ctx.fromId as never)));
      }
      bump(ctx, STORE.documents, documents.length);
    }
  }

  // Ниже — «кто сделал» в действующих записях, а не в журнале аудита: сотрудник тот же самый,
  // и без перевода карточка показала бы погашенную запись. Каждая колонка правится явно:
  // собирать имя поля вычислением значит однажды записать в соседнее.
  const requested = await db
    .select({ id: assemblyShortageApprovals.id })
    .from(assemblyShortageApprovals)
    .where(eq(assemblyShortageApprovals.requestedBy, ctx.fromId as never))
    .limit(10_000);
  if (requested.length > 0) {
    if (ctx.apply) {
      await db
        .update(assemblyShortageApprovals)
        .set({ requestedBy: ctx.toId as never })
        .where(eq(assemblyShortageApprovals.requestedBy, ctx.fromId as never));
    }
    bump(ctx, STORE.approvals, requested.length);
  }

  const decided = await db
    .select({ id: assemblyShortageApprovals.id })
    .from(assemblyShortageApprovals)
    .where(eq(assemblyShortageApprovals.decidedBy, ctx.fromId as never))
    .limit(10_000);
  if (decided.length > 0) {
    if (ctx.apply) {
      await db
        .update(assemblyShortageApprovals)
        .set({ decidedBy: ctx.toId as never })
        .where(eq(assemblyShortageApprovals.decidedBy, ctx.fromId as never));
    }
    bump(ctx, STORE.approvals, decided.length);
  }

  const conducted = await db
    .select({ id: defectConductedVersions.id })
    .from(defectConductedVersions)
    .where(eq(defectConductedVersions.conductedBy, ctx.fromId as never))
    .limit(10_000);
  if (conducted.length > 0) {
    if (ctx.apply) {
      await db
        .update(defectConductedVersions)
        .set({ conductedBy: ctx.toId as never })
        .where(eq(defectConductedVersions.conductedBy, ctx.fromId as never));
    }
    bump(ctx, STORE.defectVersions, conducted.length);
  }

  const occurred = await db
    .select({ id: defectPartEvents.id })
    .from(defectPartEvents)
    .where(eq(defectPartEvents.occurredBy, ctx.fromId as never))
    .limit(10_000);
  if (occurred.length > 0) {
    if (ctx.apply) {
      await db
        .update(defectPartEvents)
        .set({ occurredBy: ctx.toId as never })
        .where(eq(defectPartEvents.occurredBy, ctx.fromId as never));
    }
    bump(ctx, STORE.defectEvents, occurred.length);
  }
}

/**
 * Один проход по всем хранилищам. `apply: false` — только счёт (для «Проверить»), ничего не пишет.
 * Перевод идемпотентен: повторный запуск уже переведённых ссылок не находит, поэтому обрыв
 * посреди слияния лечится повтором — транзакции на все хранилища тут нет и быть не может
 * (журнал пишет своим путём, вне нашей транзакции).
 */
export async function repointEmployeeReferences(args: {
  fromId: string;
  toId: string;
  survivorLogin: string;
  loserLogin: string;
  actor: Actor;
  apply: boolean;
}): Promise<RepointOutcome> {
  const ctx: Ctx = {
    fromId: args.fromId,
    toId: args.toId,
    survivorLogin: args.survivorLogin,
    loserLogin: args.loserLogin,
    apply: args.apply,
    actor: args.actor,
    quoted: `%${JSON.stringify(args.fromId)}%`,
    out: { moved: 0, byStore: [], blockers: [], notes: [] },
  };

  await repointEavValues(ctx);
  await repointOperations(ctx);
  await repointAssemblyBom(ctx);
  await repointChatRooms(ctx);
  await repointCardDrafts(ctx);
  await repointAiChat(ctx);
  await repointTimesheets(ctx);
  await repointServerColumns(ctx);

  ctx.out.notes = [...new Set(ctx.out.notes)];
  return ctx.out;
}

export const __testables = { deepReplaceId, mergePersonEntries, dedupeEmployeeLists, operationStoreLabel };
