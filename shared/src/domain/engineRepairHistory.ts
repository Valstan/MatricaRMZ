import { STATUS_LABELS, type StatusCode } from './contract.js';
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
 *  - **строки ведомостей работ** (15.09.2026, `workSheets.ts`) — заводятся с экрана «Ведомости
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

export const REPAIR_HISTORY_ENTRY_TYPES = ['manual', 'status', 'transfer', 'sheet'] as const;
export type RepairHistoryEntryType = (typeof REPAIR_HISTORY_ENTRY_TYPES)[number];

export const REPAIR_HISTORY_ENTRY_TYPE_LABELS: Record<RepairHistoryEntryType, string> = {
  manual: 'Ручная',
  status: 'Стадия',
  transfer: 'Переезд',
  sheet: 'Ведомость',
};

/** Строка ведомости работ: узел и его поля — самоописываемо, чтобы читаться без справочника. */
export type RepairHistorySheet = {
  typeId: string;
  typeCode: string;
  typeName: string;
  fields: WorkSheetField[];
};

export type RepairHistoryMeta = {
  kind: typeof REPAIR_HISTORY_META_KIND;
  action: string;
  workshopId?: string;
  reason?: string;
  note?: string;
  extra?: RepairHistoryExtraField[];
  /** Проставлено программой (смена стадии / переезд), а не оператором. */
  auto?: boolean;
  /** Классификация записи; у старых строк отсутствует и выводится (`repairHistoryEntryType`). */
  entryType?: RepairHistoryEntryType;
  /** Строка ведомости работ. */
  sheet?: RepairHistorySheet;
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

/**
 * Классификация записи: явное поле, иначе по признакам. Порядок важен: ведомость узнаётся
 * по `sheet` даже если кто-то выставил `auto`, переезд — по типу операции.
 */
export function repairHistoryEntryType(
  meta: Pick<RepairHistoryMeta, 'entryType' | 'sheet' | 'auto'> | null,
  operationType: string,
): RepairHistoryEntryType {
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
    ...(text(obj.reason) ? { reason: text(obj.reason).slice(0, 1000) } : {}),
    ...(text(obj.note) ? { note: text(obj.note).slice(0, 2000) } : {}),
    ...(parseExtra(obj.extra).length > 0 ? { extra: parseExtra(obj.extra) } : {}),
    ...(obj.auto === true ? { auto: true } : {}),
    ...(typeof obj.at === 'number' && Number.isFinite(obj.at) && obj.at > 0 ? { at: obj.at } : {}),
    ...(parseEntryType(obj.entryType) ? { entryType: parseEntryType(obj.entryType)! } : {}),
    ...(parseSheet(obj.sheet) ? { sheet: parseSheet(obj.sheet)! } : {}),
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
  reason?: string;
  note?: string;
  extra?: RepairHistoryExtraField[];
  auto?: boolean;
  at?: number;
  entryType?: RepairHistoryEntryType;
  sheet?: RepairHistorySheet | null;
}): RepairHistoryMeta {
  const sheet = parseSheet(input.sheet);
  return {
    kind: REPAIR_HISTORY_META_KIND,
    action: text(input.action).slice(0, 200),
    ...(text(input.workshopId) ? { workshopId: text(input.workshopId) } : {}),
    ...(text(input.reason) ? { reason: text(input.reason).slice(0, 1000) } : {}),
    ...(text(input.note) ? { note: text(input.note).slice(0, 2000) } : {}),
    ...(parseExtra(input.extra).length > 0 ? { extra: parseExtra(input.extra) } : {}),
    ...(input.auto === true ? { auto: true } : {}),
    ...(typeof input.at === 'number' && Number.isFinite(input.at) && input.at > 0 ? { at: input.at } : {}),
    ...(input.entryType ? { entryType: input.entryType } : {}),
    ...(sheet ? { sheet } : {}),
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

/** Автозапись смены стадии ремонта — подпись берём из того же реестра, что и карточка. */
export function repairHistoryMetaForStatus(code: StatusCode, at?: number): RepairHistoryMeta {
  return buildRepairHistoryMeta({ action: STATUS_LABELS[code] ?? code, auto: true, entryType: 'status', ...(at ? { at } : {}) });
}

/** Последняя строка ведомости в ленте — «на каком узле двигатель» для списка и отчётов. */
export function lastSheetEntry(entries: readonly RepairHistoryEntry[]): RepairHistoryEntry | null {
  for (const entry of entries) {
    if (entry.entryType === 'sheet' && entry.sheet) return entry;
  }
  return null;
}
