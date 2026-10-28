/**
 * Реестр выданных номеров РМЗ — экран «Номера РМЗ» (план engine-rmz-numbers-2026-10, PR-4).
 *
 * Строки `erp_engine_numbers` не удаляются никогда, поэтому реестр — это сразу и список
 * номеров, и история: удалённая карточка остаётся строкой со статусом `deleted`, актором
 * удаления, причиной и снимком «что было в карточке». Ни список двигателей (там карточки
 * уже нет), ни журнал действий (в нём нет номера) на вопрос владельца «кто и почему
 * удалил» не отвечают — отвечает эта таблица.
 *
 * Читается реплика, а не сервер: экран обязан открываться офлайн, как остальные списки.
 * Опознание карточки (документный номер, внутренний, марка, дата прихода) берётся из
 * реплики `erp_engine_cards`; у машины, которая карточку не догнала, остаётся снимок —
 * он приезжает вместе со строкой реестра.
 */
import { asc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  ENGINE_RMZ_NUMBER_STATUSES,
  STATUS_CODES,
  STATUS_LABELS,
  formatEngineInternalNumber,
  formatEngineRmzNumber,
  statusDateCode,
  type EngineRmzHistoryItem,
  type EngineRmzNumberStatus,
  type StatusCode,
} from '@matricarmz/shared';

import { erpEngineCards, erpEngineNumbers } from '../database/schema.js';

/** Снимок приезжает JSON-ом серверной строки (camelCase); snake_case терпим на всякий случай. */
type SnapshotRow = Record<string, unknown>;

const DATE_FMT = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' });

function fmtDate(ms: unknown): string {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? DATE_FMT.format(new Date(n)) : '';
}

function pickString(source: SnapshotRow | null | undefined, keys: readonly string[]): string {
  if (!source) return '';
  for (const key of keys) {
    const value = source[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function pickNumber(source: SnapshotRow | null | undefined, keys: readonly string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** `status_repair_started` → `statusRepairStarted`: так колонка зовётся в строгой карточке. */
function camelCase(code: string): string {
  return code.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase());
}

function asStatus(value: unknown): EngineRmzNumberStatus {
  const text = String(value ?? '');
  return (ENGINE_RMZ_NUMBER_STATUSES as readonly string[]).includes(text)
    ? (text as EngineRmzNumberStatus)
    : 'active';
}

function parseSnapshot(raw: unknown): SnapshotRow | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as SnapshotRow) : null;
  } catch {
    // Битая строка снимка — не повод терять номер: показываем историю без «что было».
    return null;
  }
}

/**
 * «Что было в карточке» на момент удаления — уже с подписями, чтобы экран не заводил
 * второй словарь колонок. Пустые поля не выводим: список прочерков читать нечем.
 */
export function buildCardSnapshotFacts(row: SnapshotRow | null | undefined): Array<{ label: string; value: string }> {
  if (!row) return [];
  const facts: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string) => {
    if (value) facts.push({ label, value });
  };

  push('Документный номер', pickString(row, ['engineNumber', 'engine_number']));
  push(
    'Внутренний номер',
    formatEngineInternalNumber(
      pickString(row, ['engineInternalNumber', 'engine_internal_number']),
      pickNumber(row, ['engineInternalNumberYear', 'engine_internal_number_year']),
    ),
  );
  push('Марка', pickString(row, ['engineBrand', 'engine_brand']));
  push('Дата прихода', fmtDate(pickNumber(row, ['arrivalDate', 'arrival_date'])));
  push('Участок договора', pickString(row, ['contractSectionNumber', 'contract_section_number']));

  for (const code of STATUS_CODES as readonly StatusCode[]) {
    const flag = row[camelCase(code)] ?? row[code];
    if (flag !== true && flag !== 1) continue;
    const dateCode = statusDateCode(code);
    push(STATUS_LABELS[code], fmtDate(row[camelCase(dateCode)] ?? row[dateCode]) || 'да');
  }

  const repeatArrival = row.repeatArrivalFlag ?? row.repeat_arrival_flag;
  if (repeatArrival === true || repeatArrival === 1) push('Повторный заезд', 'да');
  push('Причина утиля', pickString(row, ['scrapReason', 'scrap_reason']));
  push('Примечание', pickString(row, ['engineNote', 'engine_note']));

  return facts;
}

/** Опознание карточки: сначала реплика, недостающее — из снимка. */
function cardIdentity(card: SnapshotRow | undefined, snapshot: SnapshotRow | null) {
  const number = pickString(card, ['engineNumber', 'engine_number']) || pickString(snapshot, ['engineNumber', 'engine_number']);
  const internal =
    formatEngineInternalNumber(
      pickString(card, ['engineInternalNumber', 'engine_internal_number']),
      pickNumber(card, ['engineInternalNumberYear', 'engine_internal_number_year']),
    ) ||
    formatEngineInternalNumber(
      pickString(snapshot, ['engineInternalNumber', 'engine_internal_number']),
      pickNumber(snapshot, ['engineInternalNumberYear', 'engine_internal_number_year']),
    );
  const brand = pickString(card, ['engineBrand', 'engine_brand']) || pickString(snapshot, ['engineBrand', 'engine_brand']);
  const arrivalDate =
    pickNumber(card, ['arrivalDate', 'arrival_date']) ?? pickNumber(snapshot, ['arrivalDate', 'arrival_date']);
  return { engineNumber: number, internalNumber: internal, engineBrand: brand, arrivalDate };
}

/**
 * Реестр номеров, свежие сверху: владелец смотрит на последние заезды и последние
 * удаления, а не на `RMZ1`. Порядок числовой по `seq`, а не по тексту номера.
 */
export async function listEngineRmzNumbers(db: BetterSQLite3Database): Promise<EngineRmzHistoryItem[]> {
  const numbers = await db
    .select()
    .from(erpEngineNumbers)
    .orderBy(asc(erpEngineNumbers.seq));
  if (numbers.length === 0) return [];

  const cards = await db.select().from(erpEngineCards);
  const cardsById = new Map<string, SnapshotRow>();
  for (const card of cards) cardsById.set(String(card.id), card as unknown as SnapshotRow);

  const items = numbers.map((row) => {
    const engineId = String(row.id);
    const status = asStatus(row.status);
    const snapshot = parseSnapshot(row.snapshotJson);
    const card = cardsById.get(engineId);
    const identity = cardIdentity(card, snapshot);
    return {
      engineId,
      seq: Number(row.seq),
      rmzCode: formatEngineRmzNumber(Number(row.seq)),
      status,
      engineNumber: identity.engineNumber,
      internalNumber: identity.internalNumber,
      engineBrand: identity.engineBrand,
      arrivalDate: identity.arrivalDate,
      createdBy: String(row.createdBy ?? '').trim(),
      createdAt: Number(row.createdAt ?? 0),
      cardDeletedAt: row.cardDeletedAt == null ? null : Number(row.cardDeletedAt),
      cardDeletedBy: String(row.cardDeletedBy ?? '').trim(),
      deleteReason: String(row.deleteReason ?? '').trim(),
      // Снимок нужен только там, где карточки в списке уже нет: у живой он был бы
      // копией того, что открывается одним кликом.
      snapshot: status === 'active' ? [] : buildCardSnapshotFacts(snapshot ?? card),
    };
  });

  return items.sort((a, b) => b.seq - a.seq);
}
