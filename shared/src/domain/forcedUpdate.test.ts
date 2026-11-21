import { describe, expect, it } from 'vitest';

import {
  FORCED_UPDATE_MIN_RELEASE_DISTANCE,
  FORCED_UPDATE_WINDOW_MINUTE_MSK,
  MSK_UTC_OFFSET_MINUTES,
  evaluateForcedUpdate,
  forcedUpdateWindow,
  releaseDistance,
} from './forcedUpdate.js';

// Правило владельца 21.11.2026: «если программа не перезапускается долгое время,
// а версии обновления ушли уже на 2 версии вперёд — делать принудительное
// обновление программы в 12:30 по Москве».

const NOW = Date.UTC(2026, 10, 21, 9, 30, 0); // 21.11.2026 12:30 МСК

function candidate(overrides: Partial<Parameters<typeof evaluateForcedUpdate>[0]['candidate']> = {}) {
  return {
    clientId: 'PC20-a0327b8a',
    lastVersion: '3.134.0',
    lastSeenAt: NOW - 5 * 60_000,
    updatesEnabled: true,
    hasWatchdog: true,
    pendingRequestType: null,
    pendingRequestAt: null,
    ...overrides,
  };
}

describe('отставание клиента от последнего релиза', () => {
  it('считается по релизам поколения, а не по semver', () => {
    expect(releaseDistance('3.134.0', '3.140.0')).toBe(6);
    expect(releaseDistance('3.139.0', '3.140.0')).toBe(1);
    expect(releaseDistance('3.140.0', '3.140.0')).toBe(0);
  });

  it('клиент на прежней нумерации (CalVer) позади всего поколения', () => {
    expect(releaseDistance('2026.814.1503', '3.140.0')).toBeGreaterThan(FORCED_UPDATE_MIN_RELEASE_DISTANCE);
  });

  it('несравнимые версии дают null, а не «отставание»', () => {
    expect(releaseDistance('', '3.140.0')).toBeNull();
    expect(releaseDistance('не-версия', '3.140.0')).toBeNull();
  });
});

describe('решение о принудительном обновлении', () => {
  it('отставшая на 2+ релиза живая машина обновляется', () => {
    const decision = evaluateForcedUpdate({
      candidate: candidate({ lastVersion: '3.134.0' }),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 3 * 24 * 60 * 60_000,
    });
    expect(decision.forced).toBe(true);
    expect(decision.reason).toBe('forced');
    expect(decision.releaseDistance).toBe(6);
  });

  it('отставание в один релиз — не принудительно (машина просто отстала)', () => {
    const decision = evaluateForcedUpdate({
      candidate: candidate({ lastVersion: '3.139.0' }),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 3 * 24 * 60 * 60_000,
    });
    expect(decision.forced).toBe(false);
    expect(decision.reason).toBe('within-distance');
  });

  it('актуальная машина не трогается', () => {
    const decision = evaluateForcedUpdate({
      candidate: candidate({ lastVersion: '3.140.0' }),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 3 * 24 * 60 * 60_000,
    });
    expect(decision.forced).toBe(false);
    expect(decision.reason).toBe('up-to-date');
  });

  it('выключенная машина (heartbeat старше часа) не обновляется', () => {
    const decision = evaluateForcedUpdate({
      candidate: candidate({ lastSeenAt: NOW - 3 * 60 * 60_000 }),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 3 * 24 * 60 * 60_000,
    });
    expect(decision.forced).toBe(false);
    expect(decision.reason).toBe('client-offline');
  });

  it('машина без сторожа не обновляется — команду никто не заберёт', () => {
    const decision = evaluateForcedUpdate({
      candidate: candidate({ hasWatchdog: false }),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 3 * 24 * 60 * 60_000,
    });
    expect(decision.forced).toBe(false);
    expect(decision.reason).toBe('no-watchdog');
  });

  it('обновления, выключенные администратором, уважаются', () => {
    const decision = evaluateForcedUpdate({
      candidate: candidate({ updatesEnabled: false }),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 3 * 24 * 60 * 60_000,
    });
    expect(decision.forced).toBe(false);
    expect(decision.reason).toBe('updates-disabled');
  });

  it('свежий релиз машине не вменяем — «не перезапускается долгое время» ещё не прошло', () => {
    const decision = evaluateForcedUpdate({
      candidate: candidate(),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 2 * 60 * 60_000,
    });
    expect(decision.forced).toBe(false);
    expect(decision.reason).toBe('release-too-fresh');
  });

  it('уже высланная команда переустановки не дублируется', () => {
    const decision = evaluateForcedUpdate({
      candidate: candidate({ pendingRequestType: 'reinstall', pendingRequestAt: NOW - 60_000 }),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 3 * 24 * 60 * 60_000,
    });
    expect(decision.forced).toBe(false);
    expect(decision.reason).toBe('already-commanded');
  });

  it('живая чужая команда в слоте не вытесняется', () => {
    const decision = evaluateForcedUpdate({
      candidate: candidate({ pendingRequestType: 'force_full_pull', pendingRequestAt: NOW - 60_000 }),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 3 * 24 * 60 * 60_000,
    });
    expect(decision.forced).toBe(false);
    expect(decision.reason).toBe('request-busy');
  });

  it('мёртвая команда в слоте вытесняется — иначе обновление не дойдёт никогда', () => {
    // Реальный случай: reset_sync_state_and_pull от 16.09 висит на PC20 и блокирует
    // доставку команды переустановки.
    const decision = evaluateForcedUpdate({
      candidate: candidate({
        pendingRequestType: 'reset_sync_state_and_pull',
        pendingRequestAt: Date.UTC(2026, 8, 16, 8, 0, 27),
      }),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 3 * 24 * 60 * 60_000,
    });
    expect(decision.forced).toBe(true);
    expect(decision.replaceStaleRequest).toBe(true);
  });

  it('версия, которой машина не сообщила, — не причина обновлять', () => {
    const decision = evaluateForcedUpdate({
      candidate: candidate({ lastVersion: null }),
      latestVersion: '3.140.0',
      now: NOW,
      latestPublishedAt: NOW - 3 * 24 * 60 * 60_000,
    });
    expect(decision.forced).toBe(false);
    expect(decision.reason).toBe('version-unknown');
  });
});

describe('окно принудительного обновления по Москве', () => {
  it('открыто в 12:30 МСК независимо от TZ процесса', () => {
    // 09:30 UTC = 12:30 МСК
    expect(forcedUpdateWindow(NOW).open).toBe(true);
    expect(forcedUpdateWindow(NOW).minutesUntilStart).toBe(0);
  });

  it('закрыто в 12:29 и открыто в 13:00 — по границам окна', () => {
    expect(forcedUpdateWindow(Date.UTC(2026, 10, 21, 9, 29)).open).toBe(false);
    expect(forcedUpdateWindow(Date.UTC(2026, 10, 21, 9, 29)).minutesUntilStart).toBe(1);
    expect(forcedUpdateWindow(Date.UTC(2026, 10, 21, 10, 0)).open).toBe(false);
    expect(forcedUpdateWindow(Date.UTC(2026, 10, 21, 10, 0)).minutesUntilStart).toBe(24 * 60 - 30);
  });

  it('дата ключа — по Москве, а не по UTC', () => {
    // 21:00 UTC = 00:00 МСК следующего дня
    const win = forcedUpdateWindow(Date.UTC(2026, 10, 21, 21, 0));
    expect(win.dateKey).toBe('2026-11-22');
    expect(win.open).toBe(false);
  });

  it('окно задаётся правилом, а не сдвигом сервера', () => {
    expect(FORCED_UPDATE_WINDOW_MINUTE_MSK).toBe(30);
    expect(MSK_UTC_OFFSET_MINUTES).toBe(180);
  });
});
