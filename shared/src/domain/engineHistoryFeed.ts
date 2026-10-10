// Единая лента событий по двигателю (задача владельца 01.10.2026).
//
// До этого вкладка «История ремонта» показывала три ленты: этапы ремонта, записи
// истории и паспорт (все операции). Три ленты на одних и тех же данных `operations`
// читались как три разных журнала, и оператор, чтобы узнать «что было с двигателем»,
// перечитывал их все. Теперь это одна таблица, а правило сборки живёт здесь — в домене,
// а не в компоненте: иначе строки из разных лент снова разъедутся по дате и подписи.
//
// Что видно в строке:
//   * `at` — дата СОБЫТИЯ (её вводил оператор; для этапа это дата этапа, для строки
//     истории — введённая дата, для паспорта — момент операции);
//   * `recordedAt` — дата ЗАПИСИ (когда строка физически появилась в базе). Это разные
//     даты: этап «Сборка» за 20-е может быть введён сегодня, и без второй даты
//     появляется обманчивая свежесть события;
//   * `by` — автор по-русски (служебные скрипты названы словами, см. `serviceActors`);
//   * `kind` — тип строки: этап ремонта, этап работ, ручная/стадия/переезд или прочая
//     операция. По нему экран рисует метку и решает, что можно править.

import { actDatesFromAnswers, actStageEntries, mergeActStages, type ActStageEntry } from './actStages.js';
import { parseRepairHistoryMeta, repairHistoryEntryType, type RepairHistoryEntryType } from './engineRepairHistory.js';
import { describeOperationType, operationStatusLabel, type EngineLifecyclePhase } from './engineTimeline.js';
import { serviceActorLabel } from './serviceActors.js';
import { WORK_SHEET_COLUMN_TYPES, formatWorkSheetValue, type WorkSheetField } from './workSheets.js';

/** Строка `operations` в том виде, в котором лента читает её. */
export type EngineHistoryFeedRow = {
  id: string;
  operationType: string;
  status?: string | null;
  note: string | null;
  performedAt: number | null;
  performedBy: string | null;
  metaJson: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Тип строки ленты. `sheet` — этап работ (его правят на экране «Этапы работ»). */
export type EngineHistoryFeedKind = RepairHistoryEntryType | 'operation';

export type EngineHistoryFeedItem = {
  id: string;
  /** Дата события — по ней сортируем сверху вниз. */
  at: number;
  /** Дата записи в базе (когда строка появилась), — отдельная колонка. */
  recordedAt: number;
  kind: EngineHistoryFeedKind;
  /** Короткая метка типа для колонки «Тип». */
  kindLabel: string;
  /** Название события: имя этапа, действие или подпись типа операции. */
  title: string;
  icon: string;
  phase: EngineLifecyclePhase;
  workshopId: string;
  workshopName: string;
  reason: string;
  note: string;
  /** Произвольные поля ручной записи. */
  extra: Array<{ label: string; value: string }>;
  /** Поля строки этапа работ — самоописываемые, читаются без справочника. */
  fields: WorkSheetField[];
  /** Автор по-русски; пусто — автора нет (`local`, пустой логин). */
  by: string;
  /** Код этапа ремонта — для правки даты (пишется обратно в stages.save). */
  stageCode: string;
  /** Номер прохода этапа (2+ = осознанный возврат). */
  pass: number;
  /** Запись можно править здесь (этап ремонта: дата и снятие). */
  editable: boolean;
  /** Строка этапа работ: её правят на экране «Этапы работ», отсюда — только переход. */
  sheetRowId: string | null;
  /** Запись заведена программой (стадия, переезд), а не оператором. */
  auto: boolean;
  /** Статус операции («Выполнено», «Черновик») — только у операций. */
  statusLabel: string;
};

const KIND_LABELS: Record<EngineHistoryFeedKind, string> = {
  stage: 'Этап ремонта',
  sheet: 'Этап работ',
  manual: 'Ручная запись',
  status: 'Стадия',
  transfer: 'Переезд',
  operation: 'Операция',
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseSheetFields(raw: unknown): WorkSheetField[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkSheetField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const code = text(obj.code).slice(0, 60);
    if (!code) continue;
    out.push({
      code,
      label: text(obj.label).slice(0, 120) || code,
      type: (WORK_SHEET_COLUMN_TYPES as readonly string[]).includes(text(obj.type))
        ? (obj.type as WorkSheetField['type'])
        : 'text',
      value: obj.value as WorkSheetField['value'] ?? null,
    });
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Одна строка `operations` → строка ленты.
 *
 * Записи истории ремонта и строки этапов ремонта разбираются через `meta_json`
 * (`parseRepairHistoryMeta`): у них есть подпись события, цех, причина, примечание и
 * автор. Прочие операции берут подпись из реестра типов (`describeOperationType`).
 */
export function engineHistoryFeedItem(row: EngineHistoryFeedRow): EngineHistoryFeedItem {
  const recordedAt = (row.updatedAt || row.createdAt) > 0 ? row.updatedAt || row.createdAt : 0;
  const occurredAt = typeof row.performedAt === 'number' && Number.isFinite(row.performedAt) && row.performedAt > 0
    ? row.performedAt
    : recordedAt;
  const by = serviceActorLabel(row.performedBy);
  const descriptor = describeOperationType(row.operationType);
  const meta = parseRepairHistoryMeta(row.metaJson);

  if (meta) {
    const entryType = repairHistoryEntryType(meta, row.operationType);
    const kind: EngineHistoryFeedKind = entryType;
    const sheet = meta.sheet ?? null;
    const fields = sheet ? parseSheetFields((sheet as { fields?: unknown }).fields) : [];
    return {
      id: String(row.id),
      // Дата, введённая оператором, важнее момента записи: записи заводят задним числом.
      at: meta.at && meta.at > 0 ? meta.at : occurredAt,
      recordedAt,
      kind,
      kindLabel: KIND_LABELS[kind],
      title: meta.action,
      icon: kind === 'stage' ? '🚩' : kind === 'sheet' ? '🔧' : kind === 'transfer' ? '🔁' : '🗒️',
      phase: descriptor.phase,
      workshopId: meta.workshopId ?? '',
      workshopName: meta.workshopName ?? '',
      reason: meta.reason ?? '',
      note: meta.note ?? '',
      extra: meta.extra ?? [],
      fields,
      by,
      stageCode: text(meta.stage?.code),
      pass: meta.repeat?.pass ?? 1,
      // Дату и снятие этапа ремонта правим прямо здесь; строку этапа работ — на её
      // экране («Этапы работ»), из ленты на неё только переход.
      editable: kind === 'stage',
      sheetRowId: kind === 'sheet' ? String(row.id) : null,
      auto: meta.auto === true,
      statusLabel: '',
    };
  }

  // Подписи из реестра не бывает: неизвестный тип получает свой код (`describeOperationType`),
  // и строка показывается — новая операция не должна молча исчезнуть из истории.
  const passThrough = parseJson(row.metaJson);
  return {
    id: String(row.id),
    at: occurredAt,
    recordedAt,
    kind: 'operation',
    kindLabel: KIND_LABELS.operation,
    title: descriptor.label,
    icon: descriptor.icon,
    phase: descriptor.phase,
    workshopId: text(passThrough?.toWorkshopId),
    workshopName: '',
    reason: '',
    note: text(row.note),
    extra: [],
    fields: [],
    by,
    stageCode: '',
    pass: 1,
    editable: false,
    sheetRowId: null,
    auto: false,
    statusLabel: operationStatusLabel(text(row.status)),
  };
}

/** Поля строки этапа работ в строку «подпись: значение» — для колонки «Примечание». */
export function engineHistoryFeedFieldLines(item: EngineHistoryFeedItem): string[] {
  return item.fields
    .map((f) => {
      const value = formatWorkSheetValue(f);
      return value ? `${f.label}: ${value}` : '';
    })
    .filter(Boolean);
}

/**
 * Лента по двигателю, новые сверху. Строки без даты (`at <= 0`) уходят в конец: пустая
 * дата — это «неизвестно когда», а не «самое свежее».
 *
 * Этапы `arrival` / `disassembly_defect` выводятся из дат акта (`engine_inventory`):
 * хранимая строка того же кода в тот же московский день скрывается (акт — источник
 * правды). Выведенные строки не правятся здесь (править — в акте).
 */
export function buildEngineHistoryFeed(rows: readonly EngineHistoryFeedRow[]): EngineHistoryFeedItem[] {
  const out: EngineHistoryFeedItem[] = [];
  for (const row of rows) out.push(engineHistoryFeedItem(row));
  const actDates = latestActDates(rows);
  if (!actDates) return sortFeedItems(out);
  const derived = actStageEntries(actDates);
  if (derived.length === 0) return sortFeedItems(out);
  const merged = mergeActStages(
    out.flatMap((item) =>
      item.kind === 'stage' && item.stageCode ? [{ code: item.stageCode, atMs: item.at > 0 ? item.at : null, item }] : [],
    ),
    derived,
  );
  return sortFeedItems(merged.map((m) => (m.origin === 'stored' ? m.row.item : actFeedItem(m.entry))));
}

function sortFeedItems(items: EngineHistoryFeedItem[]): EngineHistoryFeedItem[] {
  return items.sort((a, b) => {
    const aAt = a.at > 0 ? a.at : null;
    const bAt = b.at > 0 ? b.at : null;
    if (aAt !== null && bAt !== null && aAt !== bAt) return bAt - aAt;
    if (aAt !== null && bAt === null) return -1;
    if (aAt === null && bAt !== null) return 1;
    return b.recordedAt - a.recordedAt || a.id.localeCompare(b.id);
  });
}

/** Даты акта из последнего листа `engine_inventory` (по моменту записи). */
function latestActDates(rows: readonly EngineHistoryFeedRow[]) {
  let best: { updatedAt: number; answers: unknown } | null = null;
  for (const row of rows) {
    if (row.operationType !== 'engine_inventory') continue;
    let answers: unknown = null;
    try {
      const payload = JSON.parse(row.metaJson ?? '');
      answers = payload && typeof payload === 'object' ? (payload as { answers?: unknown }).answers : null;
    } catch {
      continue;
    }
    if (!answers || typeof answers !== 'object') continue;
    const updatedAt = Number(row.updatedAt ?? 0);
    if (!best || updatedAt > best.updatedAt) best = { updatedAt, answers };
  }
  return best ? actDatesFromAnswers(best.answers) : null;
}

const ACT_FEED_PHASE: Record<string, EngineLifecyclePhase> = {
  arrival: 'acceptance',
  disassembly_defect: 'defect',
};

/** Выведенная строка ленты: этап из акта. Не правится здесь — только в акте. */
function actFeedItem(entry: ActStageEntry): EngineHistoryFeedItem {
  return {
    id: `act:${entry.code}`,
    at: entry.atMs,
    recordedAt: entry.atMs,
    kind: 'stage',
    kindLabel: KIND_LABELS.stage,
    title: entry.name,
    icon: '🚩',
    phase: ACT_FEED_PHASE[entry.code] ?? 'defect',
    workshopId: '',
    workshopName: '',
    reason: '',
    note: 'Из акта',
    extra: [],
    fields: [],
    by: '',
    stageCode: entry.code,
    pass: 1,
    editable: false,
    sheetRowId: null,
    auto: true,
    statusLabel: '',
  };
}