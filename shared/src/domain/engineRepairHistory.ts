import { parseWorkSheetFields, type WorkSheetField } from './workSheets.js';

/**
 * История ремонта двигателя (просьба владельца 08.09.2026): что с двигателем происходило,
 * кем и когда — с возможностью дописать своё.
 *
 * Живёт в строках `operations`, а не в новой таблице: они уже синхронизируются на все клиенты,
 * закрыты правами `operations.view`, попадают в аудит и читаются лентой паспорта ремонта
 * (`engineTimeline`). Новая таблица потребовала бы правки контракта синхронизации, реплики и
 * гейта `check-sync-contract` — ради данных, для которых уже есть подходящее место.
 *
 * Событий два рода, и различать их обязательно:
 *  - **автоматические** — их пишет программа при смене стадии ремонта и переезде в другой цех;
 *    оператор их не правит, иначе история перестанет соответствовать карточке;
 *  - **ручные** — строка, которую оператор завёл сам (дата, действие, цех, причина, примечание
 *    и произвольные поля, которых мы не предусмотрели);
 *  - **строки этапов работ** (15.09.2026, `workSheets.ts`) — заводятся с экрана «Этапы
 *    работ» и правятся только там; несут узел и его поля в `sheet`.
 *
 * Классификация — `entryType`: `manual | status | transfer | sheet`. У старых строк поля нет,
 * и оно выводится по признакам (`auto`, тип операции, наличие `sheet`), чтобы отчёты и ступени
 * списка читали одну и ту же историю одинаково.
 */

export const REPAIR_HISTORY_OPERATION_TYPE = 'repair_history_entry';
export const REPAIR_HISTORY_META_KIND = 'repair_history';

/** Произвольное поле строки: владелец просил не упираться в заранее придуманный набор. */
export type RepairHistoryExtraField = { label: string; value: string };

export const REPAIR_HISTORY_ENTRY_TYPES = ['manual', 'status', 'transfer', 'sheet', 'stage'] as const;
export type RepairHistoryEntryType = (typeof REPAIR_HISTORY_ENTRY_TYPES)[number];

export const REPAIR_HISTORY_ENTRY_TYPE_LABELS: Record<RepairHistoryEntryType, string> = {
  manual: 'Ручная',
  status: 'Стадия',
  transfer: 'Переезд',
  sheet: 'Этап работ',
  stage: 'Этап',
};

/** Строка единого списка этапов: код из шаблона + снимок названия. */
export type RepairHistoryStage = {
  code: string;
  name: string;
};

/** Строка этапа работ: узел и его поля — самоописываемо, чтобы читаться без справочника. */
export type RepairHistorySheet = {
  typeId: string;
  typeCode: string;
  typeName: string;
  fields: WorkSheetField[];
};

/**
 * Повторный проход этапа. `pass` — номер прохода, начиная с 2: первый проход поля не несёт
 * вовсе, поэтому «есть `repeat`» и означает «это возврат». `reason` необязателен — заставлять
 * оператора объяснять возврат в момент, когда он просто вносит факт, значит получить отписку.
 */
export type RepairHistoryRepeat = {
  pass: number;
  reason?: string;
};

/**
 * След строки этапа работ в едином списке (шаг 8 плана unified-repair-stages).
 * Строка обкатки при создании отмечает этап «Обкатка»; удаление строки по
 * подтверждению гасит и эту отметку — но только если её с тех пор никто не
 * правил (чужое решение не трогаем).
 */
export type RepairHistoryStageMark = {
  /** id авто-строки этапа в `operations`. */
  rowId: string;
  code: string;
  atMs: number;
};

export type RepairHistoryMeta = {
  kind: typeof REPAIR_HISTORY_META_KIND;
  action: string;
  workshopId?: string;
  /**
   * Имя цеха НА МОМЕНТ ЗАПИСИ. Снимок, а не источник правды: при чтении сначала спрашивается
   * справочник (там имя свежее), и только если он недоступен — права не выданы, офлайн, цех
   * деактивирован — показывается это. Без снимка на экран уезжал uuid: справочник цехов живёт
   * на сервере и требует `masterdata.view`, а строка обязана читаться без него — ровно по той
   * же причине, по которой она несёт `typeName` рядом с `typeId`.
   */
  workshopName?: string;
  reason?: string;
  note?: string;
  extra?: RepairHistoryExtraField[];
  /** Проставлено программой (смена стадии / переезд), а не оператором. */
  auto?: boolean;
  /** Классификация записи; у старых строк отсутствует и выводится (`repairHistoryEntryType`). */
  entryType?: RepairHistoryEntryType;
  /** Строка этапа работ. */
  sheet?: RepairHistorySheet;
  /** Строка единого списка этапов (план unified-repair-stages, шаг 2). */
  stage?: RepairHistoryStage;
  /** След строки этапа работ в едином списке — основание для отката при удалении. */
  repairStage?: RepairHistoryStageMark | null;
  /**
   * Осознанный повторный проход: двигатель вернулся на ТОТ ЖЕ этап в тот же день.
   * Ставится только когда оператор ответил на гейт дублей «это повторный проход» —
   * отсутствие поля означает первый проход, а не «неизвестно».
   *
   * Почему отдельным полем, а не префиксом в названии или отдельным видом работ:
   * префикс — данные в имени (не посчитать, не отфильтровать, ломается опечаткой),
   * а отдельный вид работ разъехался бы с основным во всех группировках отчётов
   * (`typeCode` заморожен после создания, ранги этапов строятся по `sortOrder` вида).
   * Явное поле делает возврат считаемым: доля этапов, пройденных с первого раза, —
   * это выход годного с первого предъявления, и сегодня его посчитать нечем.
   */
  repeat?: RepairHistoryRepeat;
  /**
   * Дата события, когда она НЕ совпадает с моментом записи: строку истории часто заводят
   * задним числом. Хранится здесь, потому что запись операции даты не принимает — иначе
   * пришлось бы менять контракт IPC ради одного поля.
   */
  at?: number;
};

/**
 * Действия, предложенные в списке. Список открытый — оператор вправе ввести своё,
 * и оно попадёт в подсказки следующего раза (`repairHistoryActionOptions`).
 */
export const REPAIR_HISTORY_ACTIONS: readonly string[] = [
  'Перемещение в другой цех',
  'Возврат из цеха',
  'Отправлен на сборку',
  'Отправлен на утиль',
  'Начат ремонт',
  'Ремонт закончен',
  'Отгружен заказчику',
  'Приостановлен',
  'Замечание ОТК',
];

export type RepairHistorySource = 'auto' | 'manual';

export type RepairHistoryEntry = {
  id: string;
  at: number;
  action: string;
  source: RepairHistorySource;
  workshopId: string;
  reason: string;
  note: string;
  extra: RepairHistoryExtraField[];
  performedBy: string | null;
  /** Тип исходной строки `operations` — по нему видно, откуда событие взялось. */
  operationType: string;
  entryType: RepairHistoryEntryType;
  sheet: RepairHistorySheet | null;
  stage: RepairHistoryStage | null;
  /** Номер прохода (1 — первый, без пометки): возврат пишется позже и побеждает при равной дате. */
  pass: number;
};

/** Форма строки `operations`, которой достаточно истории (без завязки на ipc/types). */
export type RepairHistorySourceRow = {
  id: string;
  operationType: string;
  note: string | null;
  performedAt: number | null;
  performedBy: string | null;
  metaJson: string | null;
  createdAt: number;
  updatedAt: number;
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseExtra(raw: unknown): RepairHistoryExtraField[] {
  if (!Array.isArray(raw)) return [];
  const out: RepairHistoryExtraField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const label = text((item as Record<string, unknown>).label).slice(0, 120);
    const value = text((item as Record<string, unknown>).value).slice(0, 500);
    if (!label && !value) continue;
    out.push({ label, value });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Разбор признака повторного прохода. Номер меньше 2 отбрасывается вместе со всем полем:
 * `pass: 1` — это первый проход, а первый проход признака не несёт; хранить его значило бы
 * завести два разных представления одного состояния и разойтись на первой же проверке.
 */
function parseRepeat(raw: unknown): RepairHistoryRepeat | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const pass = typeof obj.pass === 'number' && Number.isFinite(obj.pass) ? Math.floor(obj.pass) : 0;
  if (pass < 2) return null;
  const reason = text(obj.reason).slice(0, 500);
  return { pass: Math.min(pass, 99), ...(reason ? { reason } : {}) };
}

function parseRepairStageMark(raw: unknown): RepairHistoryStageMark | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const rowId = text(obj.rowId).slice(0, 80);
  const code = text(obj.code).toLowerCase().slice(0, 40);
  const atMs = typeof obj.atMs === 'number' && Number.isFinite(obj.atMs) && obj.atMs > 0 ? obj.atMs : null;
  if (!rowId || !code || atMs === null) return null;
  return { rowId, code, atMs };
}

function parseSheet(raw: unknown): RepairHistorySheet | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const typeId = text(obj.typeId).slice(0, 80);
  const typeCode = text(obj.typeCode).toLowerCase().slice(0, 40);
  const typeName = text(obj.typeName).slice(0, 120);
  if (!typeId && !typeCode) return null;
  return { typeId, typeCode, typeName: typeName || typeCode, fields: parseWorkSheetFields(obj.fields) };
}

function parseEntryType(raw: unknown): RepairHistoryEntryType | null {
  const s = text(raw);
  return (REPAIR_HISTORY_ENTRY_TYPES as readonly string[]).includes(s) ? (s as RepairHistoryEntryType) : null;
}

function parseStage(raw: unknown): RepairHistoryStage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const code = text(obj.code).toLowerCase().slice(0, 40);
  const name = text(obj.name).slice(0, 120);
  if (!code || !name) return null;
  return { code, name };
}

/**
 * Классификация записи: явное поле, иначе по признакам. Порядок важен: этап работ узнаётся
 * по `sheet` даже если кто-то выставил `auto`, строка единого списка — по `stage`,
 * переезд — по типу операции.
 */
export function repairHistoryEntryType(
  meta: Pick<RepairHistoryMeta, 'entryType' | 'sheet' | 'stage' | 'auto'> | null,
  operationType: string,
): RepairHistoryEntryType {
  if (meta?.stage) return 'stage';
  if (meta?.sheet) return 'sheet';
  if (meta?.entryType) return meta.entryType;
  if (operationType === 'workshop_transfer') return 'transfer';
  if (meta?.auto === true) return 'status';
  return 'manual';
}

/** Разбор `meta_json` строки истории; `null` — строка не наша. */
export function parseRepairHistoryMeta(metaJson: string | null): RepairHistoryMeta | null {
  const raw = parseJson(metaJson);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (text(obj.kind) !== REPAIR_HISTORY_META_KIND) return null;
  const action = text(obj.action);
  if (!action) return null;
  return {
    kind: REPAIR_HISTORY_META_KIND,
    action: action.slice(0, 200),
    ...(text(obj.workshopId) ? { workshopId: text(obj.workshopId) } : {}),
    ...(text(obj.workshopName) ? { workshopName: text(obj.workshopName).slice(0, 200) } : {}),
    ...(text(obj.reason) ? { reason: text(obj.reason).slice(0, 1000) } : {}),
    ...(text(obj.note) ? { note: text(obj.note).slice(0, 2000) } : {}),
    ...(parseExtra(obj.extra).length > 0 ? { extra: parseExtra(obj.extra) } : {}),
    ...(obj.auto === true ? { auto: true } : {}),
    ...(typeof obj.at === 'number' && Number.isFinite(obj.at) && obj.at > 0 ? { at: obj.at } : {}),
    ...(parseEntryType(obj.entryType) ? { entryType: parseEntryType(obj.entryType)! } : {}),
    ...(parseSheet(obj.sheet) ? { sheet: parseSheet(obj.sheet)! } : {}),
    ...(parseStage(obj.stage) ? { stage: parseStage(obj.stage)! } : {}),
    ...(parseRepairStageMark(obj.repairStage) ? { repairStage: parseRepairStageMark(obj.repairStage)! } : {}),
    ...(parseRepeat(obj.repeat) ? { repeat: parseRepeat(obj.repeat)! } : {}),
  };
}

/**
 * Собрать `meta_json` строки истории — единственная точка, где эта форма создаётся.
 * Новое поле добавляется СРАЗУ и сюда, и в `parseRepairHistoryMeta`: парсер режет неизвестные
 * ключи, и поле, положенное только здесь, пропадёт при первом же чтении.
 */
export function buildRepairHistoryMeta(input: {
  action: string;
  workshopId?: string | null;
  workshopName?: string | null;
  reason?: string;
  note?: string;
  extra?: RepairHistoryExtraField[];
  auto?: boolean;
  at?: number;
  entryType?: RepairHistoryEntryType;
  sheet?: RepairHistorySheet | null;
  stage?: RepairHistoryStage | null;
  repairStage?: RepairHistoryStageMark | null;
  repeat?: RepairHistoryRepeat | null;
}): RepairHistoryMeta {
  const sheet = parseSheet(input.sheet);
  const stage = parseStage(input.stage);
  return {
    kind: REPAIR_HISTORY_META_KIND,
    action: text(input.action).slice(0, 200),
    ...(text(input.workshopId) ? { workshopId: text(input.workshopId) } : {}),
    ...(text(input.workshopName) ? { workshopName: text(input.workshopName).slice(0, 200) } : {}),
    ...(text(input.reason) ? { reason: text(input.reason).slice(0, 1000) } : {}),
    ...(text(input.note) ? { note: text(input.note).slice(0, 2000) } : {}),
    ...(parseExtra(input.extra).length > 0 ? { extra: parseExtra(input.extra) } : {}),
    ...(input.auto === true ? { auto: true } : {}),
    ...(typeof input.at === 'number' && Number.isFinite(input.at) && input.at > 0 ? { at: input.at } : {}),
    ...(input.entryType ? { entryType: input.entryType } : {}),
    ...(sheet ? { sheet } : {}),
    ...(stage ? { stage } : {}),
    ...(parseRepairStageMark(input.repairStage) ? { repairStage: parseRepairStageMark(input.repairStage)! } : {}),
    ...(parseRepeat(input.repeat) ? { repeat: parseRepeat(input.repeat)! } : {}),
  };
}

/** Короткая строка для колонки `note` — старая лента паспорта ремонта читает именно её. */
export function repairHistoryNoteLine(meta: RepairHistoryMeta, workshopName?: string): string {
  const parts = [meta.action];
  const place = text(workshopName) || text(meta.workshopId);
  if (place) parts.push(`цех: ${place}`);
  if (meta.reason) parts.push(`причина: ${meta.reason}`);
  return parts.join(' · ');
}

/**
 * Лента истории по строкам `operations` — новые сверху.
 *
 * Кроме собственных строк истории подхватывает **межцеховые передачи** (`workshop_transfer`):
 * их писала карточка задолго до этой вкладки, и без них история начиналась бы с пустого места
 * у каждого двигателя, который уже ездил по цехам.
 */
export function repairHistoryFromOperations(rows: readonly RepairHistorySourceRow[]): RepairHistoryEntry[] {
  const out: RepairHistoryEntry[] = [];
  for (const row of rows) {
    const at = typeof row.performedAt === 'number' && Number.isFinite(row.performedAt) ? row.performedAt : row.updatedAt;
    const meta = parseRepairHistoryMeta(row.metaJson);
    if (meta) {
      out.push({
        id: String(row.id),
        // Дата, введённая оператором, важнее момента записи: запись часто заводят задним числом.
        at: meta.at ?? at,
        action: meta.action,
        source: meta.auto === true ? 'auto' : 'manual',
        workshopId: meta.workshopId ?? '',
        reason: meta.reason ?? '',
        note: meta.note ?? '',
        extra: meta.extra ?? [],
        performedBy: row.performedBy ?? null,
        operationType: row.operationType,
        entryType: repairHistoryEntryType(meta, row.operationType),
        sheet: meta.sheet ?? null,
        stage: meta.stage ?? null,
        pass: meta.repeat?.pass ?? 1,
      });
      continue;
    }
    if (row.operationType === 'workshop_transfer') {
      const raw = parseJson(row.metaJson);
      const to = raw && typeof raw === 'object' ? text((raw as Record<string, unknown>).toWorkshopId) : '';
      out.push({
        id: String(row.id),
        at,
        action: 'Перемещение в другой цех',
        source: 'auto',
        workshopId: to,
        reason: '',
        note: text(row.note),
        extra: [],
        performedBy: row.performedBy ?? null,
        operationType: row.operationType,
        entryType: 'transfer',
        sheet: null,
        stage: null,
        pass: 1,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/** Подсказки действий: предустановленные плюс всё, что операторы уже вводили руками. */
export function repairHistoryActionOptions(entries: readonly RepairHistoryEntry[]): string[] {
  const seen = new Set<string>(REPAIR_HISTORY_ACTIONS);
  for (const entry of entries) {
    const action = text(entry.action);
    if (action) seen.add(action);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'ru'));
}

/**
 * Где двигатель сейчас по истории: цех последнего события, у которого цех указан.
 * `null` — история про цех ничего не говорит, и спрашивать надо карточку.
 */
export function currentWorkshopFromHistory(entries: readonly RepairHistoryEntry[]): string | null {
  for (const entry of entries) {
    if (entry.workshopId) return entry.workshopId;
  }
  return null;
}

/** Последняя строка этапа работ в ленте — «на каком узле двигатель» для списка и отчётов. */
export function lastSheetEntry(entries: readonly RepairHistoryEntry[]): RepairHistoryEntry | null {
  for (const entry of entries) {
    if (entry.entryType === 'sheet' && entry.sheet) return entry;
  }
  return null;
}

/** Строка единого списка этапов для builder-сервиса (шаг 2 плана). */
export function repairHistoryMetaForStage(
  code: string,
  name: string,
  at?: number,
  repeat?: RepairHistoryRepeat | null,
): RepairHistoryMeta {
  return buildRepairHistoryMeta({
    action: name,
    entryType: 'stage',
    stage: { code, name },
    ...(typeof at === 'number' && Number.isFinite(at) && at > 0 ? { at } : {}),
    ...(repeat ? { repeat } : {}),
  });
}
