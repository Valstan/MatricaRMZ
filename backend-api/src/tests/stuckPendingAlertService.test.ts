import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatSent: string[] = [];
const roomSent: string[] = [];
const events: Array<Record<string, unknown>> = [];

vi.mock('../services/chatMessageService.js', () => ({
  postChatMessageToSuperadmin: vi.fn(async (args: { text: string }) => {
    chatSent.push(String(args?.text ?? ''));
    return { ok: true as const };
  }),
  ensureMonitoringRoom: vi.fn(async () => 'room-1'),
  postChatMessageToRoom: vi.fn(async (args: { text: string }) => {
    roomSent.push(String(args?.text ?? ''));
    return { ok: true as const };
  }),
}));

vi.mock('../services/criticalEventsService.js', () => ({
  ingestClientCriticalEvent: vi.fn((args: Record<string, unknown>) => {
    events.push(args);
  }),
}));

vi.mock('../services/employeeAuthService.js', () => ({
  resolveLoginsToFullNames: vi.fn(async (logins: string[]) => {
    const out: Record<string, string> = {};
    for (const login of logins) out[login.trim().toLowerCase()] = 'Иванов Иван Иванович';
    return out;
  }),
}));

import {
  clientNameFromClientId,
  raiseStuckPendingAlert,
  resetStuckPendingAlertCooldown,
  stuckPendingReportFromSnapshotTables,
} from '../services/stuckPendingAlertService.js';

const NOW = Date.parse('2026-11-19T10:00:00Z');

const stuck = {
  count: 617,
  oldestPendingAt: NOW - 83 * 60_000,
  thresholdMinutes: 15,
  byTable: [{ table: 'attribute_values', n: 617, oldestPendingAt: NOW - 83 * 60_000 }],
};

function actor() {
  return { id: 'u-1', username: 'operator', role: 'operator' };
}

describe('аларм застрявшей очереди', () => {
  beforeEach(() => {
    chatSent.length = 0;
    roomSent.length = 0;
    events.length = 0;
    resetStuckPendingAlertCooldown();
  });

  it('имя машины берётся из clientId: формат <hostname>-<uuid>', () => {
    expect(clientNameFromClientId('rmz4val-1a2b3c4d-1111-2222-3333-444455556666')).toBe('rmz4val');
    expect(clientNameFromClientId('PC79-aaaa-bbbb-cccc-dddd-eeeeffff0000')).toBe('PC79');
    expect(clientNameFromClientId('')).toBe('');
  });

  it('из снимка клиента собирается отчёт с потабличным разбором', () => {
    const report = stuckPendingReportFromSnapshotTables(
      {
        attribute_values: { stuckCount: 617, oldestPendingAt: NOW - 83 * 60_000 },
        entities: { stuckCount: 3, oldestPendingAt: NOW - 20 * 60_000 },
        notes: { stuckCount: 0, oldestPendingAt: null },
      },
      15,
    );
    expect(report?.count).toBe(620);
    expect(report?.byTable?.map((row) => row.table)).toEqual(['attribute_values', 'entities']);
    expect(report?.oldestPendingAt).toBe(NOW - 83 * 60_000);
  });

  it('застрявших нет — отчёта нет (аларм не поднимаем)', () => {
    expect(stuckPendingReportFromSnapshotTables({ notes: { stuckCount: 0 } }, 15)).toBeNull();
    expect(stuckPendingReportFromSnapshotTables({}, 15)).toBeNull();
    expect(stuckPendingReportFromSnapshotTables(null, 15)).toBeNull();
  });

  it('аларм уходит в комнату мониторинга и в журнал событий — один и тот же текст', async () => {
    const res = await raiseStuckPendingAlert({
      actor: actor(),
      clientId: 'rmz4val-1a2b3c4d-1111-2222-3333-444455556666',
      stuck,
      trigger: 'auto',
      detectedAt: NOW,
    });
    expect(res.alerted).toBe(true);
    expect(res.chatSent).toBe(true);
    expect(roomSent).toHaveLength(1);
    expect(roomSent[0]).toContain('Иванов Иван Иванович');
    expect(roomSent[0]).toContain('attribute_values: 617');
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('client.sync.stuck_pending');
    // Текст в журнале событий и в комнате — один: числа в каналах разойтись не должны.
    expect(String(events[0]?.humanMessage)).toBe(roomSent[0]);
  });

  it('повторный авто-аларм по той же машине в окно анти-флуда не уходит', async () => {
    await raiseStuckPendingAlert({ actor: actor(), clientId: 'c-1', stuck, trigger: 'auto', cooldownMs: 30 * 60_000 });
    const second = await raiseStuckPendingAlert({ actor: actor(), clientId: 'c-1', stuck, trigger: 'auto', cooldownMs: 30 * 60_000 });
    expect(second.alerted).toBe(false);
    expect(second.reason).toContain('окно');
    expect(roomSent).toHaveLength(1);
  });

  it('кнопка оператора проходит окно автоматики (это и есть её смысл)', async () => {
    await raiseStuckPendingAlert({ actor: actor(), clientId: 'c-1', stuck, trigger: 'auto', cooldownMs: 30 * 60_000 });
    const manual = await raiseStuckPendingAlert({
      actor: actor(),
      clientId: 'c-1',
      stuck,
      trigger: 'manual',
      force: true,
      manualCooldownMs: 0,
    });
    expect(manual.alerted).toBe(true);
    expect(roomSent).toHaveLength(2);
  });

  it('кнопку нельзя залить: повтор в пределах её пола запрета молча отсекается', async () => {
    const first = await raiseStuckPendingAlert({
      actor: actor(),
      clientId: 'c-1',
      stuck,
      trigger: 'manual',
      force: true,
      manualCooldownMs: 2 * 60_000,
    });
    expect(first.alerted).toBe(true);
    const second = await raiseStuckPendingAlert({
      actor: actor(),
      clientId: 'c-1',
      stuck,
      trigger: 'manual',
      force: true,
      manualCooldownMs: 2 * 60_000,
    });
    expect(second.alerted).toBe(false);
    expect(roomSent).toHaveLength(1);
  });
});
