import { describe, expect, it } from 'vitest';

import {
  ENGINE_RESERVATION_PRE_LOCK_GRACE_MS,
  ENGINE_RESERVATION_RECENTLY_EXPIRED_MS,
  ENGINE_RESERVATION_RENEW_AFTER_MS,
  ENGINE_RESERVATION_TTL_MS,
  type EngineReservation,
  engineReservationSkipReason,
  engineReservationState,
  formatEngineReservationHolder,
  formatEngineReservationUntil,
  isEngineEditBlockedByReservation,
  isEngineReservationGatedOperationType,
  isEngineReservationLive,
  parseEngineReservation,
  parseEngineReservationSkipReason,
  shouldRenewEngineReservation,
} from './engineReservation.js';

const NOW = 1_800_000_000_000;

function makeReservation(over: Partial<EngineReservation> = {}): EngineReservation {
  return {
    v: 1,
    holderUserId: 'user-a',
    holderLogin: 'ivanov',
    holderFullName: 'Иванов Иван Иванович',
    startedAt: NOW - 60_000,
    expiresAt: NOW - 60_000 + ENGINE_RESERVATION_TTL_MS,
    releasedAt: null,
    releasedBy: null,
    ...over,
  };
}

describe('parseEngineReservation', () => {
  it('одинаково ест объект и JSON-строку', () => {
    const r = makeReservation();
    expect(parseEngineReservation(r)).toEqual(r);
    expect(parseEngineReservation(JSON.stringify(r))).toEqual(r);
  });

  it('отбрасывает мусор, пустое и чужую версию', () => {
    expect(parseEngineReservation(null)).toBeNull();
    expect(parseEngineReservation('')).toBeNull();
    expect(parseEngineReservation('не json')).toBeNull();
    expect(parseEngineReservation([makeReservation()])).toBeNull();
    expect(parseEngineReservation({ ...makeReservation(), v: 2 })).toBeNull();
  });

  it('отбрасывает записи без держателя и с нечисловым временем', () => {
    expect(parseEngineReservation({ ...makeReservation(), holderUserId: '  ' })).toBeNull();
    expect(parseEngineReservation({ ...makeReservation(), startedAt: 'вчера' })).toBeNull();
    expect(parseEngineReservation({ ...makeReservation(), expiresAt: null })).toBeNull();
  });

  it('неизвестное releasedBy схлопывает в null, не роняя запись', () => {
    const parsed = parseEngineReservation({ ...makeReservation(), releasedBy: 'кто-то' });
    expect(parsed?.releasedBy).toBeNull();
  });
});

describe('isEngineReservationLive', () => {
  it('на границе expiresAt === now резерв уже НЕ живой', () => {
    expect(isEngineReservationLive(makeReservation({ expiresAt: NOW }), NOW)).toBe(false);
    expect(isEngineReservationLive(makeReservation({ expiresAt: NOW + 1 }), NOW)).toBe(true);
  });

  it('снятый резерв не живой даже до истечения', () => {
    expect(isEngineReservationLive(makeReservation({ releasedAt: NOW - 1 }), NOW)).toBe(false);
  });
});

describe('engineReservationState', () => {
  it('free / mine / other', () => {
    expect(engineReservationState(null, { nowMs: NOW, viewerUserId: 'user-a' })).toBe('free');
    expect(engineReservationState(makeReservation(), { nowMs: NOW, viewerUserId: 'user-a' })).toBe('mine');
    expect(engineReservationState(makeReservation(), { nowMs: NOW, viewerUserId: 'user-b' })).toBe('other');
  });

  it('истёкший недавно — expired_recently (только текст), давно истёкший — free', () => {
    const justExpired = makeReservation({ expiresAt: NOW - 40 * 60_000 });
    expect(engineReservationState(justExpired, { nowMs: NOW, viewerUserId: 'user-b' })).toBe('expired_recently');

    const longExpired = makeReservation({ expiresAt: NOW - ENGINE_RESERVATION_RECENTLY_EXPIRED_MS - 1 });
    expect(engineReservationState(longExpired, { nowMs: NOW, viewerUserId: 'user-b' })).toBe('free');
  });

  it('снятый вручную резерв сразу free, а не expired_recently', () => {
    const released = makeReservation({ expiresAt: NOW - 1000, releasedAt: NOW - 1000, releasedBy: 'holder' });
    expect(engineReservationState(released, { nowMs: NOW, viewerUserId: 'user-b' })).toBe('free');
  });
});

describe('shouldRenewEngineReservation', () => {
  it('продлеваем только свой живой резерв и только после половины TTL', () => {
    const fresh = makeReservation({ startedAt: NOW - 1000 });
    expect(shouldRenewEngineReservation(fresh, { nowMs: NOW, viewerUserId: 'user-a' })).toBe(false);

    const old = makeReservation({
      startedAt: NOW - ENGINE_RESERVATION_RENEW_AFTER_MS - 1000,
      expiresAt: NOW + 1000,
    });
    expect(shouldRenewEngineReservation(old, { nowMs: NOW, viewerUserId: 'user-a' })).toBe(true);
    expect(shouldRenewEngineReservation(old, { nowMs: NOW, viewerUserId: 'user-b' })).toBe(false);
  });
});

describe('isEngineEditBlockedByReservation', () => {
  // Замок взят достаточно давно, чтобы grace уже истёк — иначе свежая правка проходит по построению.
  const held = makeReservation({ startedAt: NOW - ENGINE_RESERVATION_PRE_LOCK_GRACE_MS - 60_000 });
  const base = { nowMs: NOW, actorIsAdmin: false, rowUpdatedAt: NOW };

  it('чужой живой резерв блокирует свежую правку', () => {
    expect(isEngineEditBlockedByReservation({ ...base, reservation: held, actorUserId: 'user-b' })).toBe(true);
  });

  it('в первые 15 минут после взятия замок ещё не режет — это цена допуска на скос часов', () => {
    const justTaken = makeReservation({ startedAt: NOW - 60_000 });
    expect(isEngineEditBlockedByReservation({ ...base, reservation: justTaken, actorUserId: 'user-b' })).toBe(false);
  });

  it('держателя собственный резерв не блокирует', () => {
    expect(isEngineEditBlockedByReservation({ ...base, reservation: held, actorUserId: 'user-a' })).toBe(false);
  });

  it('pre-lock grace: правка, сделанная ДО взятия замка, проходит', () => {
    const reservation = makeReservation({ startedAt: NOW - 1000 });
    expect(
      isEngineEditBlockedByReservation({
        ...base,
        reservation,
        actorUserId: 'user-b',
        rowUpdatedAt: reservation.startedAt - 7 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it('grace покрывает скос часов клиента ровно на ENGINE_RESERVATION_PRE_LOCK_GRACE_MS', () => {
    const reservation = makeReservation({ startedAt: NOW - 1000 });
    const edge = reservation.startedAt + ENGINE_RESERVATION_PRE_LOCK_GRACE_MS;
    expect(isEngineEditBlockedByReservation({ ...base, reservation, actorUserId: 'user-b', rowUpdatedAt: edge })).toBe(
      false,
    );
    expect(
      isEngineEditBlockedByReservation({ ...base, reservation, actorUserId: 'user-b', rowUpdatedAt: edge + 1 }),
    ).toBe(true);
  });

  it('админ проходит всегда, анонимный актор не блокируется', () => {
    expect(
      isEngineEditBlockedByReservation({ ...base, reservation: held, actorUserId: 'user-b', actorIsAdmin: true }),
    ).toBe(false);
    expect(isEngineEditBlockedByReservation({ ...base, reservation: held, actorUserId: '' })).toBe(false);
  });

  it('истёкший и снятый резервы не блокируют', () => {
    expect(
      isEngineEditBlockedByReservation({
        ...base,
        reservation: { ...held, expiresAt: NOW - 1 },
        actorUserId: 'user-b',
      }),
    ).toBe(false);
    expect(
      isEngineEditBlockedByReservation({
        ...base,
        reservation: { ...held, releasedAt: NOW - 1 },
        actorUserId: 'user-b',
      }),
    ).toBe(false);
    expect(isEngineEditBlockedByReservation({ ...base, reservation: null, actorUserId: 'user-b' })).toBe(false);
  });
});

describe('гейтимые типы операций', () => {
  it('карточные операции двигателиста гейтятся', () => {
    expect(isEngineReservationGatedOperationType('defect')).toBe(true);
    expect(isEngineReservationGatedOperationType('engine_inventory')).toBe(true);
    expect(isEngineReservationGatedOperationType('disassembly')).toBe(true);
  });

  it('чужие контуры (мастер/снабженец/кладовщик) не гейтятся', () => {
    for (const t of ['work_order', 'supply_request', 'stock_receipt', 'tool_movement', 'shipment']) {
      expect(isEngineReservationGatedOperationType(t)).toBe(false);
    }
  });
});

describe('skip reason round-trip', () => {
  it('логин с двоеточием не ломает разбор', () => {
    const reservation = makeReservation({ holderLogin: 'domain:ivanov', expiresAt: NOW + 5000 });
    const reason = engineReservationSkipReason(reservation);
    expect(parseEngineReservationSkipReason(reason)).toEqual({
      holderLogin: 'domain:ivanov',
      expiresAt: NOW + 5000,
    });
  });

  it('чужие reason не разбираются', () => {
    expect(parseEngineReservationSkipReason('conflict')).toBeNull();
    expect(parseEngineReservationSkipReason('reserved:')).toBeNull();
    expect(parseEngineReservationSkipReason('reserved:ivanov:не-число')).toBeNull();
  });
});

describe('форматирование для UI', () => {
  it('держатель показывается как ФИО (логин)', () => {
    expect(formatEngineReservationHolder(makeReservation())).toBe('Иванов Иван Иванович (ivanov)');
    expect(formatEngineReservationHolder(makeReservation({ holderFullName: '' }))).toBe('ivanov');
  });

  it('срок — «до дд.мм чч:мм»', () => {
    const at = new Date(2026, 6, 22, 20, 30).getTime();
    expect(formatEngineReservationUntil(at)).toBe('до 22.07 20:30');
  });
});
