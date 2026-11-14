/**
 * Организационный модуль: мероприятия, отборы и журнал выдачи подарков и наград.
 *
 * Форма взята из мировой практики (записка в плане нити): подарок/приз — документ
 * с датой выдачи, мотивом (мероприятие) и табличной частью «кому что». Мотивом у нас
 * служит мероприятие, а не формулировка приказа.
 *
 * Отбор под мероприятие — **фасет**, а не сохранённый список: результат фильтра зависит
 * от состава и каждый раз считается заново. Хранится только РЕШЕНИЕ оператора
 * (приглашён / не приглашён и почему) — оно в `selections_json` мероприятия.
 */

import { childAgeYears, childGiftCategoryByAge } from './children.js';

export type OrgEventKind = 'holiday' | 'competition' | 'birthday' | 'other';
export type GiftKind = 'gift' | 'prize' | 'certificate' | 'money';
export type GiftRecipientKind = 'employee' | 'child';

export const ORG_EVENT_KINDS: readonly OrgEventKind[] = ['holiday', 'competition', 'birthday', 'other'];
export const GIFT_KINDS: readonly GiftKind[] = ['gift', 'prize', 'certificate', 'money'];
export const GIFT_RECIPIENT_KINDS: readonly GiftRecipientKind[] = ['employee', 'child'];

/** Мероприятие (праздник, соревнование, день рождения) — строгая таблица `erp_org_events`. */
export type OrgEventRecord = {
  id: string;
  title: string;
  kind: string;
  /** Дата мероприятия (мс). */
  eventDate: number | null;
  description: string;
  /** Решения по отбору JSON-строкой: `[{ childId, invited, reason }]`. */
  selectionsJson: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Запись журнала выдачи — строгая таблица `erp_gift_records`. */
export type GiftRecord = {
  id: string;
  /** Мероприятие-мотив; `null` — подарок вне мероприятия (например, на день рождения). */
  eventId: string | null;
  recipientKind: string;
  /** Получатель-сотрудник (id EAV-сущности). */
  recipientEmployeeId: string | null;
  /** Получатель-ребёнок (id карточки ребёнка). */
  recipientChildId: string | null;
  kind: string;
  /** Что подарили (наименование). */
  title: string;
  /** Место/ранг («1 место», «за 2 место»). */
  place: string;
  givenAt: number | null;
  note: string;
  createdAt: number;
  updatedAt: number;
};

/** Решение оператора по ребёнку на мероприятии. */
export type EventSelection = {
  childId: string;
  invited: boolean;
  reason: string;
};

export function orgEventKindLabelRu(kind: string | null | undefined): string {
  const k = String(kind ?? '').trim().toLowerCase();
  if (k === 'holiday') return 'праздник';
  if (k === 'competition') return 'соревнование';
  if (k === 'birthday') return 'день рождения';
  return 'прочее';
}

export function giftKindLabelRu(kind: string | null | undefined): string {
  const k = String(kind ?? '').trim().toLowerCase();
  if (k === 'gift') return 'подарок';
  if (k === 'prize') return 'приз';
  if (k === 'certificate') return 'грамота';
  if (k === 'money') return 'деньги';
  return 'подарок';
}

export function giftRecipientKindLabelRu(kind: string | null | undefined): string {
  const k = String(kind ?? '').trim().toLowerCase();
  return k === 'child' ? 'ребёнку' : 'сотруднику';
}

/** Разбор решений по отбору из JSON-строки. */
export function parseEventSelections(raw: string | null | undefined): EventSelection[] {
  if (raw == null) return [];
  const text = String(raw).trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: EventSelection[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const childId = String(row['childId'] ?? '').trim();
    if (!childId) continue;
    out.push({
      childId,
      invited: row['invited'] === true,
      reason: String(row['reason'] ?? '').trim().slice(0, 300),
    });
  }
  return out;
}

/** Решения по отбору в JSON-строку. */
export function serializeEventSelections(selections: readonly EventSelection[] | null | undefined): string {
  const out: EventSelection[] = [];
  const seen = new Set<string>();
  for (const sel of selections ?? []) {
    const childId = String(sel?.childId ?? '').trim();
    if (!childId || seen.has(childId)) continue;
    seen.add(childId);
    out.push({ childId, invited: sel.invited === true, reason: String(sel.reason ?? '').trim().slice(0, 300) });
  }
  return JSON.stringify(out);
}

/** Решение по конкретному ребёнку на мероприятии — `null`, если решения не было. */
export function eventSelectionFor(
  selections: readonly EventSelection[] | null | undefined,
  childId: string,
): EventSelection | null {
  const id = String(childId ?? '').trim();
  if (!id) return null;
  return (selections ?? []).find((s) => s.childId === id) ?? null;
}

/** Подарки, выданные конкретному ребёнку. */
export function giftsForChild(gifts: readonly GiftRecord[] | null | undefined, childId: string): GiftRecord[] {
  const id = String(childId ?? '').trim();
  if (!id) return [];
  return (gifts ?? []).filter((g) => g.recipientChildId === id);
}

/** Подарочные строки ребёнка за календарный год. */
export function childGiftsInYear(
  gifts: readonly GiftRecord[] | null | undefined,
  childId: string,
  year: number,
): GiftRecord[] {
  return giftsForChild(gifts, childId).filter((g) => {
    const at = Number(g.givenAt ?? 0);
    if (!Number.isFinite(at) || at <= 0) return false;
    return new Date(at).getFullYear() === year;
  });
}

/**
 * Что ребёнку «надо получить» — по правилам модуля.
 *
 * Правило одно: подарка в этом году ещё не было → пора. Категория подарка
 * подсказывается по возрасту (стартовое правило, оператор правит руками).
 */
export function childGiftDueThisYear(args: {
  gifts: readonly GiftRecord[] | null | undefined;
  childId: string;
  birthDate: number | null | undefined;
  nowMs: number;
}): { due: boolean; received: number; category: string } {
  const year = new Date(Number(args.nowMs)).getFullYear();
  const received = childGiftsInYear(args.gifts, args.childId, year).length;
  const age = childAgeYears(args.birthDate, args.nowMs);
  return { due: received === 0, received, category: childGiftCategoryByAge(age) };
}
