// Поиск и слияние дублей сотрудников (просьба владельца 08.09.2026: один человек завёлся
// дважды — первый аккаунт создан автоматически, второй он создал сам).
//
// Почему отдельный сервис, а не `employeeMergeService`: тот занимается ИМПОРТОМ сотрудников с
// клиентов по имени (upsert, заполняет пустое) и намеренно ПРОПУСКАЕТ имена, у которых больше
// одного совпадения — то есть ровно дубли обходит стороной. Здесь обратная задача: взять два
// уже существующих аккаунта и свести в один.
//
// Что здесь не так, как у двигателей (`engineDedupeService`), и почему:
//  - у сотрудника есть ВТОРАЯ половина — строки `users` / доступ / чат / файлы. Их переносит
//    `reassignUserReferences` (тот же код, что при удалении пользователя);
//  - `client_settings.lastUsername` хранит ЛОГИН, а не id: переписывается по логину;
//  - доступ и роль основного НИКОГДА не перетираются данными вторичного — иначе слияние может
//    отобрать у человека права, а именно это в исходной жалобе и было риском (у одной записи
//    администратор, у другой доступ запрещён).
import { SyncTableName, damerauLevenshtein } from '@matricarmz/shared';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, clientSettings, entities, entityTypes, users } from '../database/schema.js';
import { logInfo } from '../utils/logger.js';
import { ingestServerCriticalEvent } from './criticalEventsService.js';
import { setEntityAttribute, softDeleteEntity, upsertAttributeDef } from './adminMasterdataService.js';
import { setEmployeeAuth } from './employeeAuthService.js';
import { repointEmployeeReferences, type RepointOutcome } from './employeeReferenceRepoint.js';
import { reassignUserReferences } from './userDeletionService.js';


type Actor = { id: string; username: string; role: string };

/** Метка «слит в другого» — по ней видно, что запись не удалена, а объединена. */
const MERGED_INTO_CODE = 'merged_into';

/**
 * Поля, которые у основной записи не трогаются НИКОГДА. Логин и пароль — это личность и вход;
 * роль и доступ — права. Заполнять их «из пустого» у вторичной записи нельзя: слияние обязано
 * оставить человека ровно с тем доступом, который у него был до него.
 */
const PROTECTED_CODES = new Set([
  'login',
  'password_hash',
  'system_role',
  'access_enabled',
  MERGED_INTO_CODE,
]);

export type EmployeeDupCandidate = {
  id: string;
  fullName: string;
  login: string | null;
  /** Табельный номер: по нему видно, какая из записей — «настоящая». */
  personnelNumber: string | null;
  systemRole: string | null;
  accessEnabled: boolean | null;
  hasPassword: boolean;
  /** Сколько непустых атрибутов у записи — подсказка, какую логично взять основной. */
  filledAttrs: number;
  createdAt: number;
};

export type EmployeeDupGroup = {
  kind: 'exact' | 'similar';
  /** Нормализованное имя, по которому записи попали в одну группу. */
  key: string;
  employees: EmployeeDupCandidate[];
};

export type EmployeeMergeReport = {
  survivorId: string;
  loserId: string;
  /** Сколько ПУСТЫХ полей основного заполнено из вторичного. */
  attrsFilled: number;
  /** Поля, которые не переносились, потому что защищены. */
  protectedSkipped: string[];
  /** Перенесены ли пользовательские ссылки (чат, файлы, заметки, права, токены). */
  userReferencesMoved: boolean;
  /** Сколько строк `client_settings` перевешено с логина вторичного на логин основного. */
  clientSettingsRelinked: number;
  /** Сколько ссылок на вторичную запись переведено на основную. */
  referencesMoved: number;
  /** Разбивка переведённых ссылок по видам данных. */
  referencesByStore: Array<{ store: string; count: number }>;
  /** Переносы не «один в один»: сложенные доли бригады, снятые дубли, занятые дни табеля. */
  referenceNotes: string[];
  /** Только отчёт, без единой записи. */
  dryRun: boolean;
};

function normalizeName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е');
}

function parseAttr(raw: unknown): string {
  if (raw == null) return '';
  const s = String(raw);
  try {
    const parsed = JSON.parse(s);
    if (parsed == null) return '';
    if (typeof parsed === 'string') return parsed.trim();
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
    return s.trim();
  } catch {
    return s.trim();
  }
}

async function getEmployeeTypeId(): Promise<string | null> {
  const row = (
    await db
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(and(eq(entityTypes.code, 'employee'), isNull(entityTypes.deletedAt)))
      .limit(1)
  )[0];
  return row ? String(row.id) : null;
}

async function loadCodeByDefId(typeId: string): Promise<Map<string, string>> {
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as never), isNull(attributeDefs.deletedAt)));
  return new Map(defs.map((d) => [String(d.id), String(d.code)]));
}

async function loadAttrs(entityId: string, codeByDefId: Map<string, string>): Promise<Map<string, string>> {
  const vals = await db
    .select()
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, entityId as never), isNull(attributeValues.deletedAt)));
  const out = new Map<string, string>();
  for (const v of vals) {
    const code = codeByDefId.get(String(v.attributeDefId)) ?? String(v.attributeDefId);
    const value = parseAttr(v.valueJson);
    if (value !== '') out.set(code, value);
  }
  return out;
}

/** Разрешённый «бюджет опечаток» для похожих имён: чем длиннее, тем терпимее. */
function editBudgetForName(key: string): number {
  if (key.length <= 8) return 0;
  if (key.length <= 16) return 1;
  return 2;
}

let analyzeRunning = false;

/**
 * Группы дублей сотрудников. Точная группа — совпадение нормализованного ФИО; похожая —
 * расстояние в пределах бюджета опечаток (тот же приём, что у двигателей).
 *
 * Ничего не меняет: только показывает, что нашлось, и с каким доступом каждая запись, — решение
 * о слиянии принимает оператор.
 */
export async function analyzeEmployeeDuplicates(): Promise<
  { ok: true; totalEmployees: number; groups: EmployeeDupGroup[] } | { ok: false; error: string }
> {
  if (analyzeRunning) return { ok: false as const, error: 'анализ дублей уже выполняется, подождите' };
  analyzeRunning = true;
  try {
    const typeId = await getEmployeeTypeId();
    if (!typeId) return { ok: false as const, error: 'тип сущности "employee" не найден' };
    const codeByDefId = await loadCodeByDefId(typeId);

    const rows = await db
      .select({ id: entities.id, createdAt: entities.createdAt })
      .from(entities)
      .where(and(eq(entities.typeId, typeId as never), isNull(entities.deletedAt)));

    const ids = rows.map((r) => String(r.id));
    const userRows = ids.length
      ? await db
          .select({ id: users.id, login: users.login, systemRole: users.systemRole, accessEnabled: users.accessEnabled })
          .from(users)
          .where(inArray(users.id, ids as never[]))
      : [];
    const userById = new Map(userRows.map((u) => [String(u.id), u]));

    const candidates: Array<EmployeeDupCandidate & { key: string }> = [];
    for (const row of rows) {
      const id = String(row.id);
      const attrs = await loadAttrs(id, codeByDefId);
      // Слитые записи в кандидаты не берём: они уже объединены и лежат как след.
      if (attrs.get(MERGED_INTO_CODE)) continue;
      const fullName = attrs.get('full_name') ?? '';
      const key = normalizeName(fullName);
      if (!key) continue;
      const user = userById.get(id);
      candidates.push({
        id,
        key,
        fullName,
        login: user?.login ? String(user.login) : (attrs.get('login') ?? null),
        personnelNumber: attrs.get(PERSONNEL_NUMBER_CODE) ?? null,
        systemRole: user?.systemRole ? String(user.systemRole) : (attrs.get('system_role') ?? null),
        accessEnabled: user ? Boolean(user.accessEnabled) : null,
        hasPassword: Boolean(attrs.get('password_hash')),
        filledAttrs: attrs.size,
        createdAt: Number(row.createdAt ?? 0),
      });
    }

    const byKey = new Map<string, Array<EmployeeDupCandidate & { key: string }>>();
    for (const c of candidates) {
      const bucket = byKey.get(c.key) ?? [];
      bucket.push(c);
      byKey.set(c.key, bucket);
    }

    const groups: EmployeeDupGroup[] = [];
    const grouped = new Set<string>();
    for (const [key, bucket] of byKey) {
      if (bucket.length < 2) continue;
      for (const c of bucket) grouped.add(c.id);
      groups.push({ kind: 'exact', key, employees: bucket.map(({ key: _k, ...rest }) => rest) });
    }

    // Похожие имена — только среди тех, кто не попал в точную группу: иначе один и тот же
    // человек оказался бы в двух группах и оператор склеил бы его дважды.
    const rest = candidates.filter((c) => !grouped.has(c.id));
    for (let i = 0; i < rest.length; i += 1) {
      const left = rest[i]!;
      if (grouped.has(left.id)) continue;
      const similar = [left];
      for (let j = i + 1; j < rest.length; j += 1) {
        const right = rest[j]!;
        if (grouped.has(right.id)) continue;
        const budget = Math.min(editBudgetForName(left.key), editBudgetForName(right.key));
        if (budget <= 0) continue;
        if (damerauLevenshtein(left.key, right.key, budget) <= budget) similar.push(right);
      }
      if (similar.length < 2) continue;
      for (const c of similar) grouped.add(c.id);
      groups.push({ kind: 'similar', key: left.key, employees: similar.map(({ key: _k, ...restFields }) => restFields) });
    }

    return { ok: true as const, totalEmployees: candidates.length, groups };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  } finally {
    analyzeRunning = false;
  }
}

/** Хвост отчёта о переводе ссылок — три поля, которые видит оператор в диалоге. */
function referenceReportFields(outcome: RepointOutcome) {
  return {
    referencesMoved: outcome.moved,
    referencesByStore: outcome.byStore.map((s) => ({ store: s.store, count: s.count })),
    referenceNotes: outcome.notes,
  };
}

/** Текст отказа: перевести ссылку нельзя, и слияние не идёт — иначе она осталась бы висеть. */
function blockerMessage(outcome: RepointOutcome): string {
  const reasons = outcome.blockers.map((b) => `${b.store}: ${b.reason}`).join('; ');
  return (
    `Слияние остановлено: часть ссылок на вторичную запись перевести не удалось (${reasons}). ` +
    'Вторичная запись осталась действующей; уже переведённые ссылки стоят на основной, повтор ' +
    'слияния продолжит с того же места. Разберите причину и нажмите «Проверить» снова.'
  );
}

/**
 * Слияние двух записей одного человека.
 *
 * Правила, ради которых всё и писалось:
 *  - ссылки на вторичную запись переводятся на основную (`repointEmployeeReferences`): наряды,
 *    акты, табели, карточки, комнаты чата; что перевести нельзя — отказ, и ни одной записи;
 *  - у основного заполняются ТОЛЬКО пустые поля; непустое не перетирается никогда;
 *  - логин, пароль, роль и доступ основного не трогаются вовсе (см. `PROTECTED_CODES`);
 *  - пользовательские ссылки (чат, файлы, заметки, права, токены) переезжают на основного;
 *  - `client_settings` вторичного логина перевешиваются на логин основного — там ЛОГИН, не id;
 *  - вторичный получает метку `merged_into`, доступ ему выключается, запись гасится.
 *
 * `dryRun` возвращает тот же отчёт, ничего не записывая, — им и проверяют слияние до боевого.
 */
export async function mergeEmployees(args: {
  survivorId: string;
  loserId: string;
  actor: Actor;
  dryRun?: boolean;
}): Promise<{ ok: true; report: EmployeeMergeReport } | { ok: false; error: string }> {
  try {
    const survivorId = String(args.survivorId ?? '').trim();
    const loserId = String(args.loserId ?? '').trim();
    const dryRun = args.dryRun === true;
    if (!survivorId || !loserId) return { ok: false as const, error: 'нужны обе записи' };
    if (survivorId === loserId) return { ok: false as const, error: 'основная и вторичная записи совпадают' };

    const typeId = await getEmployeeTypeId();
    if (!typeId) return { ok: false as const, error: 'тип сущности "employee" не найден' };

    const alive = await db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          inArray(entities.id, [survivorId, loserId] as never[]),
          eq(entities.typeId, typeId as never),
          isNull(entities.deletedAt),
        ),
      );
    const aliveIds = new Set(alive.map((r) => String(r.id)));
    if (!aliveIds.has(survivorId)) return { ok: false as const, error: 'основная запись не найдена среди действующих сотрудников' };
    if (!aliveIds.has(loserId)) return { ok: false as const, error: 'вторичная запись не найдена среди действующих сотрудников' };

    const codeByDefId = await loadCodeByDefId(typeId);
    const survivorAttrs = await loadAttrs(survivorId, codeByDefId);
    const loserAttrs = await loadAttrs(loserId, codeByDefId);

    const userRows = await db
      .select({ id: users.id, login: users.login })
      .from(users)
      .where(inArray(users.id, [survivorId, loserId] as never[]));
    const survivorLogin = String(userRows.find((u) => String(u.id) === survivorId)?.login ?? survivorAttrs.get('login') ?? '');
    const loserLogin = String(userRows.find((u) => String(u.id) === loserId)?.login ?? loserAttrs.get('login') ?? '');

    const report: EmployeeMergeReport = {
      survivorId,
      loserId,
      attrsFilled: 0,
      protectedSkipped: [],
      userReferencesMoved: false,
      clientSettingsRelinked: 0,
      referencesMoved: 0,
      referencesByStore: [],
      referenceNotes: [],
      dryRun,
    };

    const fillable: Array<{ code: string; value: string }> = [];
    for (const [code, value] of loserAttrs) {
      if (!value) continue;
      if (PROTECTED_CODES.has(code)) {
        report.protectedSkipped.push(code);
        continue;
      }
      if ((survivorAttrs.get(code) ?? '') !== '') continue;
      fillable.push({ code, value });
    }

    // Строки настроек клиента ищем по ЛОГИНУ вторичного: там хранится он, а не id.
    const settingsRows = loserLogin
      ? await db
          .select({ clientId: clientSettings.clientId, lastUsername: clientSettings.lastUsername })
          .from(clientSettings)
          .where(eq(clientSettings.lastUsername, loserLogin as never))
      : [];

    // Ссылки считает ТОТ ЖЕ код, что и переводит (`apply: false` — только счёт): иначе
    // «Проверить» показывала бы одну оценку, а слияние делало другое.
    const plan = await repointEmployeeReferences({
      fromId: loserId,
      toId: survivorId,
      survivorLogin,
      loserLogin,
      actor: args.actor,
      apply: false,
    });
    if (plan.blockers.length > 0) return { ok: false as const, error: blockerMessage(plan) };

    if (dryRun) {
      report.attrsFilled = fillable.length;
      report.userReferencesMoved = Boolean(survivorLogin);
      report.clientSettingsRelinked = settingsRows.length;
      const planned = referenceReportFields(plan);
      report.referencesMoved = planned.referencesMoved;
      report.referencesByStore = planned.referencesByStore;
      report.referenceNotes = planned.referenceNotes;
      return { ok: true as const, report };
    }

    // У сотрудников метку никто не заводил (у двигателей её заводит их дедуп) — слияние падало на
    // ней уже ПОСЛЕ переноса чата и файлов. Заводим до первой записи и через журнал: иначе клиенты
    // получили бы значение метки без её определения.
    if (![...codeByDefId.values()].includes(MERGED_INTO_CODE)) {
      await upsertAttributeDef(args.actor, {
        entityTypeId: typeId,
        code: MERGED_INTO_CODE,
        name: 'Слит в запись (служебное)',
        dataType: 'text',
        sortOrder: 9000,
      });
    }

    // Перевод ссылок — первым делом: он идемпотентен (повторный проход уже переведённых не
    // находит), поэтому обрыв дальше лечится повтором слияния, а не разбором полу-состояния.
    const moved = await repointEmployeeReferences({
      fromId: loserId,
      toId: survivorId,
      survivorLogin,
      loserLogin,
      actor: args.actor,
      apply: true,
    });
    const movedFields = referenceReportFields(moved);
    report.referencesMoved = movedFields.referencesMoved;
    report.referencesByStore = movedFields.referencesByStore;
    report.referenceNotes = movedFields.referenceNotes;
    if (moved.blockers.length > 0) return { ok: false as const, error: blockerMessage(moved) };

    for (const { code, value } of fillable) {
      const res = await setEntityAttribute(args.actor, survivorId, code, value, { allowSyncConflicts: true });
      if (res.ok) {
        survivorAttrs.set(code, value);
        report.attrsFilled += 1;
      }
    }

    // Вторая половина сотрудника — строки пользователя: чат, файлы, заметки, права, токены.
    if (survivorLogin) {
      await reassignUserReferences({ fromUserId: loserId, toUserId: survivorId, toUsername: survivorLogin, actor: args.actor });
      report.userReferencesMoved = true;

      for (const row of settingsRows) {
        await db
          .update(clientSettings)
          .set({ lastUsername: survivorLogin })
          .where(eq(clientSettings.clientId, String(row.clientId) as never));
        report.clientSettingsRelinked += 1;
      }
    }

    // Метка ставится ДО гашения: по ней видно, что запись объединена, а не удалена.
    const tomb = await setEntityAttribute(args.actor, loserId, MERGED_INTO_CODE, survivorId, { allowSyncConflicts: true });
    if (!tomb.ok) return { ok: false as const, error: `не удалось пометить вторичную запись: ${tomb.error}` };

    // Доступ вторичного выключаем дверью setEmployeeAuth: строка users правится
    // напрямую, а триггер публикации (0103) кладёт заявку в outbox той же
    // транзакцией — до клиентов изменение доезжает обычным pull'ом с номером.
    await setEmployeeAuth(loserId, { accessEnabled: false });

    const del = await softDeleteEntity(args.actor, loserId, { allowSyncConflicts: true, skipReferenceCheck: true });
    if (!del.ok) return { ok: false as const, error: `не удалось погасить вторичную запись: ${del.error}` };

    logInfo('employee merge done', { survivorId, loserId, attrsFilled: report.attrsFilled });
    ingestServerCriticalEvent({
      eventCode: 'employee_duplicates_merged',
      title: 'Слияние дублей сотрудника',
      humanMessage: `Оператор объединил записи сотрудника: основная=${survivorId}, вторичная=${loserId}, заполнено полей ${report.attrsFilled}, перевешено настроек клиента ${report.clientSettingsRelinked}.`,
      category: 'database',
      severity: 'warn',
      aiDetails: { survivorId, loserId, actor: args.actor.username, report },
    });

    return { ok: true as const, report };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export const __testables = { normalizeName, editBudgetForName, PROTECTED_CODES, SyncTableName, blockerMessage };

/** Атрибут табельного номера (заводится `baseMasterdataService`). */
const PERSONNEL_NUMBER_CODE = 'personnel_number';
const FULL_NAME_CODE = 'full_name';

/** Табельный номер: «00675» и «675» — один человек (тот же ключ, что у номера РМЗ). */
function personnelKey(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return /^\d+$/.test(raw) ? String(Number(raw)) : raw.toLowerCase();
}

export type EmployeeDupMatch = {
  id: string;
  fullName: string;
  login: string | null;
  personnelNumber: string | null;
  systemRole: string | null;
  accessEnabled: boolean | null;
  /** По каким признакам нашлась запись: ФИО, табельный номер. */
  matchedBy: Array<'name' | 'personnel'>;
};

/**
 * Атрибуты всех живых сотрудников — ОДНИМ запросом.
 *
 * Прежний `loadAttrs` ходил в базу по одной строке на сотрудника (N+1): анализ
 * дублей на 440 сотрудниках — это 440 походов. Тут нужен весь срез разом: по нему
 * работает и точечная проверка при создании карточки, а она зовётся на КАЖДОЕ
 * сохранение имени — значит, запрос должен быть один и быстрый.
 */
async function loadAllEmployeeAttrs(
  typeId: string,
  codeByDefId: Map<string, string>,
): Promise<Map<string, Map<string, string>>> {
  const defIds = [...codeByDefId.keys()];
  const rows = defIds.length
    ? await db
        .select({
          entityId: attributeValues.entityId,
          defId: attributeValues.attributeDefId,
          valueJson: attributeValues.valueJson,
        })
        .from(attributeValues)
        .where(
          and(
            inArray(attributeValues.attributeDefId, defIds as never[]),
            isNull(attributeValues.deletedAt),
          ),
        )
    : [];
  const out = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const code = codeByDefId.get(String(row.defId));
    if (!code) continue;
    const value = parseAttr(row.valueJson);
    if (!value) continue;
    const bucket = out.get(String(row.entityId)) ?? new Map<string, string>();
    bucket.set(code, value);
    out.set(String(row.entityId), bucket);
  }
  return out;
}

/**
 * Точечная проверка: есть ли уже такой сотрудник.
 *
 * Служит гейтом при создании и правке карточки: табельный номер идентифицирует
 * человека (дубль номера — всегда ошибка), а ФИО может совпасть у разных людей
 * (тогда нужен явный выбор оператора, а не молчаливый дубль).
 *
 * Возвращает обе группы совпадений, чтобы оператор увидел: «вот кто уже есть».
 */
export async function findEmployeeDuplicates(args: {
  fullName?: string | null;
  personnelNumber?: string | null;
  excludeId?: string | null;
}): Promise<{ ok: true; matches: EmployeeDupMatch[] } | { ok: false; error: string }> {
  try {
    const nameKey = normalizeName(args.fullName);
    const personnel = personnelKey(args.personnelNumber);
    if (!nameKey && !personnel) return { ok: true as const, matches: [] };

    const typeId = await getEmployeeTypeId();
    if (!typeId) return { ok: false as const, error: 'тип сущности "employee" не найден' };
    const codeByDefId = await loadCodeByDefId(typeId);

    const rows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.typeId, typeId as never), isNull(entities.deletedAt)));
    if (rows.length === 0) return { ok: true as const, matches: [] };

    const ids = rows.map((r) => String(r.id));
    const userRows = await db
      .select({ id: users.id, login: users.login, systemRole: users.systemRole, accessEnabled: users.accessEnabled })
      .from(users)
      .where(inArray(users.id, ids as never[]));
    const userById = new Map(userRows.map((u) => [String(u.id), u]));
    const attrsById = await loadAllEmployeeAttrs(typeId, codeByDefId);

    const excludeId = String(args.excludeId ?? '').trim();
    const matches: EmployeeDupMatch[] = [];
    for (const id of ids) {
      if (excludeId && id === excludeId) continue;
      const attrs = attrsById.get(id) ?? new Map<string, string>();
      // Слитые записи — след прежнего слияния, они не «ещё один такой же сотрудник».
      if (attrs.get(MERGED_INTO_CODE)) continue;
      const fullName = attrs.get(FULL_NAME_CODE) ?? '';
      const matchedBy: Array<'name' | 'personnel'> = [];
      if (nameKey && normalizeName(fullName) === nameKey) matchedBy.push('name');
      if (personnel && personnelKey(attrs.get(PERSONNEL_NUMBER_CODE)) === personnel) {
        matchedBy.push('personnel');
      }
      if (matchedBy.length === 0) continue;
      const user = userById.get(id);
      matches.push({
        id,
        fullName,
        login: user?.login ? String(user.login) : (attrs.get('login') ?? null),
        personnelNumber: attrs.get(PERSONNEL_NUMBER_CODE) ?? null,
        systemRole: user?.systemRole ? String(user.systemRole) : (attrs.get('system_role') ?? null),
        accessEnabled: user ? Boolean(user.accessEnabled) : null,
        matchedBy,
      });
    }
    // Сначала совпадения по табельному номеру: они жёстче, оператор должен увидеть их первыми.
    matches.sort((a, b) => Number(b.matchedBy.includes('personnel')) - Number(a.matchedBy.includes('personnel')));
    return { ok: true as const, matches };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export type EmployeeGroupMergeReport = {
  survivorId: string;
  /** Отчёт по каждому слитому дублю, по порядку. */
  merged: Array<{ loserId: string; report: EmployeeMergeReport }>;
  /** Дубль, на котором слияние остановилось (и остальные — не трогали). */
  failed: { loserId: string; error: string } | null;
  totals: { attrsFilled: number; referencesMoved: number; clientSettingsRelinked: number };
  dryRun: boolean;
};

/**
 * Слияние НЕСКОЛЬКИХ дублей в одну основную запись (просьба владельца 07.11.2026:
 * «три-четыре дубля сразу, галочками, а основной выбирает оператор»).
 *
 * Прежнее слияние умело только пару — и в диалоге стоял жёсткий отказ «слияние идёт
 * парами»: группа из трёх записей (как «Хапикова И. С.» на проде) не сливалась вовсе.
 *
 * Слияние идёт последовательно, по одному дублю: перевод ссылок идемпотентен (повторный
 * проход уже переведённого не находит), поэтому обрыв на третьем дубле не оставляет
 * полу-состояния — уже слитые стоят на основной, повтор продолжит с того же места.
 */
export async function mergeEmployeeGroup(args: {
  survivorId: string;
  loserIds: string[];
  actor: Actor;
  dryRun?: boolean;
}): Promise<{ ok: true; report: EmployeeGroupMergeReport } | { ok: false; error: string }> {
  const survivorId = String(args.survivorId ?? '').trim();
  const loserIds = (args.loserIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean);
  const dryRun = args.dryRun === true;
  if (!survivorId) return { ok: false as const, error: 'не выбрана основная запись' };
  if (loserIds.length === 0) return { ok: false as const, error: 'не выбрано ни одного дубля для слияния' };
  if (loserIds.includes(survivorId)) {
    return { ok: false as const, error: 'основная запись не может быть дублем' };
  }

  const merged: Array<{ loserId: string; report: EmployeeMergeReport }> = [];
  const totals = { attrsFilled: 0, referencesMoved: 0, clientSettingsRelinked: 0 };
  for (const loserId of loserIds) {
    const res = await mergeEmployees({ survivorId, loserId, actor: args.actor, dryRun });
    if (!res.ok) {
      return {
        ok: true as const,
        report: { survivorId, merged, failed: { loserId, error: res.error }, totals, dryRun },
      };
    }
    merged.push({ loserId, report: res.report });
    totals.attrsFilled += res.report.attrsFilled;
    totals.referencesMoved += res.report.referencesMoved;
    totals.clientSettingsRelinked += res.report.clientSettingsRelinked;
  }
  return { ok: true as const, report: { survivorId, merged, failed: null, totals, dryRun } };
}
