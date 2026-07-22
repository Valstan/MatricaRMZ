/**
 * Advisory-резервирование двигателя («Взять в работу») — Ф2 плана `docs/plans/tablet-shop-floor.md`.
 *
 * В цеху работа естественно делится по объектам: один оператор ↔ один двигатель.
 * Планшет уходит в цех оффлайн на часы, поэтому строгая блокировка невозможна
 * принципиально (два оффлайн-клиента сервер не разведёт до синка). Берём
 * pessimistic offline lock в advisory-виде: замок виден всем, гейт мягкий,
 * LWW остаётся страховкой, TTL не даёт замку залипнуть навсегда.
 *
 * Хранение — ОДИН json-EAV-атрибут `engine_reservation` на engine-entity (без DDL).
 * Префикс `engine_` обязателен: голые коды заняты другими типами.
 *
 * Писать атрибут может ТОЛЬКО сервер (REST + серверные часы): у планшета часы
 * плывут, а в проекте нет ни одной компенсации скоса. Клиент замок читает.
 */

import { formatClientLabel } from './clientLabel.js';

export const ENGINE_RESERVATION_CODE = 'engine_reservation' as const;

/** Смена. Забытый замок рассасывается к следующему утру — админ не нужен. */
export const ENGINE_RESERVATION_TTL_MS = 12 * 60 * 60 * 1000;

/** Продление — событийное (при сохранении карточки) и не чаще половины TTL: ≤2 ledger-записи на двигатель в сутки. */
export const ENGINE_RESERVATION_RENEW_AFTER_MS = ENGINE_RESERVATION_TTL_MS / 2;

/**
 * Сердце оффлайн-дизайна: правки со штампом раньше `startedAt + grace` гейт пропускает.
 * Планшет, неделю проработавший оффлайн, не теряет работу задним числом; допуск
 * покрывает скос часов клиента относительно сервера.
 */
export const ENGINE_RESERVATION_PRE_LOCK_GRACE_MS = 15 * 60 * 1000;

/** Только для текста плашки («резерв Иванова истёк 40 мин назад»), не блокировка. */
export const ENGINE_RESERVATION_RECENTLY_EXPIRED_MS = 2 * 60 * 60 * 1000;

export type EngineReservationReleasedBy = 'holder' | 'admin';

export type EngineReservation = {
  v: 1;
  holderUserId: string;
  holderLogin: string;
  holderFullName: string;
  startedAt: number;
  expiresAt: number;
  releasedAt: number | null;
  releasedBy: EngineReservationReleasedBy | null;
};

export type EngineReservationState = 'free' | 'mine' | 'other' | 'expired_recently';

/** `Number(null)` — это 0, а `Number('')` — тоже 0: без явного отсева мусорный резерв прошёл бы как «истёкший в 1970». */
function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Принимает и объект (клиент: `attributes[code]` уже прогнан через safeJsonParse),
 * и строку (сервер: `value_json` — text).
 */
export function parseEngineReservation(raw: unknown): EngineReservation | null {
  let source: unknown = raw;
  if (typeof source === 'string') {
    const text = source.trim();
    if (!text) return null;
    try {
      source = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const o = source as Record<string, unknown>;
  if (Number(o.v) !== 1) return null;

  const holderUserId = String(o.holderUserId ?? '').trim();
  if (!holderUserId) return null;

  const startedAt = finiteNumber(o.startedAt);
  const expiresAt = finiteNumber(o.expiresAt);
  if (startedAt === null || expiresAt === null) return null;

  const releasedAtRaw = o.releasedAt;
  const releasedAt = releasedAtRaw === null || releasedAtRaw === undefined ? null : finiteNumber(releasedAtRaw);
  if (releasedAtRaw !== null && releasedAtRaw !== undefined && releasedAt === null) return null;

  const releasedByRaw = String(o.releasedBy ?? '');
  const releasedBy: EngineReservationReleasedBy | null =
    releasedByRaw === 'holder' || releasedByRaw === 'admin' ? releasedByRaw : null;

  return {
    v: 1,
    holderUserId,
    holderLogin: String(o.holderLogin ?? '').trim(),
    holderFullName: String(o.holderFullName ?? '').trim(),
    startedAt,
    expiresAt,
    releasedAt,
    releasedBy,
  };
}

export function isEngineReservationLive(reservation: EngineReservation | null, nowMs: number): boolean {
  return !!reservation && reservation.releasedAt === null && reservation.expiresAt > nowMs;
}

export function engineReservationState(
  reservation: EngineReservation | null,
  args: { nowMs: number; viewerUserId: string },
): EngineReservationState {
  if (!reservation) return 'free';
  if (isEngineReservationLive(reservation, args.nowMs)) {
    return reservation.holderUserId === args.viewerUserId ? 'mine' : 'other';
  }
  if (
    reservation.releasedAt === null &&
    args.nowMs - reservation.expiresAt <= ENGINE_RESERVATION_RECENTLY_EXPIRED_MS
  ) {
    return 'expired_recently';
  }
  return 'free';
}

/**
 * Считаем по ОСТАТКУ до истечения, а не по возрасту от `startedAt`: при продлении
 * `startedAt` намеренно не сдвигается (иначе поехало бы окно pre-lock grace), и
 * отсчёт от него после первого же продления давал бы «продлевать всегда» —
 * ledger-запись на каждое сохранение карточки (класс M28).
 */
export function shouldRenewEngineReservation(
  reservation: EngineReservation | null,
  args: { nowMs: number; viewerUserId: string },
): boolean {
  if (!isEngineReservationLive(reservation, args.nowMs)) return false;
  const r = reservation as EngineReservation;
  if (r.holderUserId !== args.viewerUserId) return false;
  return r.expiresAt - args.nowMs < ENGINE_RESERVATION_RENEW_AFTER_MS;
}

/** ЕДИНСТВЕННОЕ правило гейта — одно и то же на сервере (мягкий скип) и в UI (read-only). */
export function isEngineEditBlockedByReservation(args: {
  reservation: EngineReservation | null;
  actorUserId: string;
  rowUpdatedAt: number;
  nowMs: number;
  actorIsAdmin: boolean;
}): boolean {
  if (!isEngineReservationLive(args.reservation, args.nowMs)) return false;
  const r = args.reservation as EngineReservation;
  if (!args.actorUserId) return false;
  if (r.holderUserId === args.actorUserId) return false;
  if (args.actorIsAdmin) return false;
  return args.rowUpdatedAt > r.startedAt + ENGINE_RESERVATION_PRE_LOCK_GRACE_MS;
}

/**
 * `engine_entity_id` есть у ВСЕХ операций (work_order, supply_request, stock_*, otk,
 * test, packaging, shipment, customer_delivery, tool_movement, workshop_transfer) —
 * их пишут мастер, снабженец и кладовщик, у которых нет ни плашки, ни кнопки резерва.
 * Гейтим только то, что двигателист правит из карточки двигателя.
 */
export const ENGINE_RESERVATION_GATED_OPERATION_TYPES: ReadonlySet<string> = new Set([
  'defect',
  'defect_act',
  'engine_inventory',
  'kitting',
  'completeness',
  'completeness_act',
  'claim_act',
  'disassembly',
]);

export function isEngineReservationGatedOperationType(operationType: string): boolean {
  return ENGINE_RESERVATION_GATED_OPERATION_TYPES.has(String(operationType ?? '').trim());
}

/**
 * Контекст замка едет внутри свободной строки `reason`: `syncSkippedRowSchema`
 * (`shared/src/sync/dto.ts`) требует `row_id: uuid` и свободных полей не имеет.
 */
export function engineReservationSkipReason(reservation: EngineReservation): string {
  return `reserved:${reservation.holderLogin}:${reservation.expiresAt}`;
}

export function parseEngineReservationSkipReason(
  reason: string,
): { holderLogin: string; expiresAt: number } | null {
  const text = String(reason ?? '');
  if (!text.startsWith('reserved:')) return null;
  const lastColon = text.lastIndexOf(':');
  if (lastColon <= 'reserved'.length) return null;
  const expiresAt = Number(text.slice(lastColon + 1));
  if (!Number.isFinite(expiresAt)) return null;
  return { holderLogin: text.slice('reserved:'.length, lastColon), expiresAt };
}

export function isEngineReservationSkipReason(reason: string): boolean {
  return String(reason ?? '').startsWith('reserved:');
}

/** Правило проекта: клиента/человека показываем логином + ФИО. */
export function formatEngineReservationHolder(reservation: EngineReservation): string {
  return formatClientLabel({ login: reservation.holderLogin, fullName: reservation.holderFullName });
}

export function formatEngineReservationUntil(expiresAt: number): string {
  const d = new Date(expiresAt);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `до ${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
