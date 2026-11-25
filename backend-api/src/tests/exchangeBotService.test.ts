import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queueByTable, sentMessages, events, accessAllowed } = vi.hoisted(() => ({
  queueByTable: new Map<unknown, any[][]>(),
  sentMessages: [] as any[],
  events: [] as Array<Record<string, unknown>>,
  accessAllowed: { value: true },
}));

// База замокана цепочкой вызовов: select().from(таблица).where(...).limit(n).
// На каждую таблицу — очередь наборов строк: первый запрос забирает первый набор,
// второй — второй. Так тест различает «поиск сообщения по id» и «поиск последнего
// присланного файла» — оба ходят в одну таблицу, но с разными условиями.
vi.mock('../database/db.js', () => ({
  db: {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        const chain: Record<string, unknown> = {};
        chain.where = () => chain;
        chain.orderBy = () => chain;
        chain.limit = async (n?: number) => {
          const queue = queueByTable.get(table);
          if (!queue || queue.length === 0) return [];
          const rows = queue.length === 1 ? (queue[0] ?? []) : (queue.shift() ?? []);
          return typeof n === 'number' ? rows.slice(0, n) : rows;
        };
        return chain;
      },
    }),
  },
}));

vi.mock('../services/chatMessageService.js', () => ({
  postChatMessage: vi.fn(async (args: any) => {
    sentMessages.push(args);
    return { ok: true as const, id: `m-${sentMessages.length}` };
  }),
}));

vi.mock('../services/criticalEventsService.js', () => ({
  ingestClientCriticalEvent: vi.fn((args: Record<string, unknown>) => {
    events.push(args);
  }),
}));

vi.mock('../services/fileAccessService.js', () => ({
  canAccessFile: vi.fn(async () => accessAllowed.value),
}));

vi.mock('../services/employeeAuthService.js', () => ({
  getSuperadminUserId: vi.fn(async () => 'u-super'),
  listEmployeesAuth: vi.fn(async () => ({
    ok: true as const,
    rows: [
      { id: 'u-1', login: 'operator', fullName: 'Иванов Иван Иванович', chatDisplayName: '', systemRole: 'user', accessEnabled: true, hasPassword: true },
      { id: 'u-2', login: 'colleague', fullName: 'Петров Пётр Петрович', chatDisplayName: '', systemRole: 'user', accessEnabled: true, hasPassword: true },
    ],
  })),
}));

import { chatMessages, clientSettings, fileAssets } from '../database/schema.js';
import { resetExchangeBotFloodGuard, runExchangeBotAction } from '../services/exchangeBotService.js';

const NOW = Date.parse('2026-11-26T09:00:00Z');

function clientRow(over: Record<string, unknown> = {}) {
  return {
    clientId: 'PC-OFIS-uuid',
    hostname: 'PC-OFIS',
    platform: 'win32',
    username: 'operator',
    lastSeenAt: NOW - 60_000,
    ...over,
  };
}

function fileRow(over: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    name: 'акт.pdf',
    size: 10,
    mime: 'application/pdf',
    sha256: 'abc',
    createdAt: NOW - 1000,
    createdByUserId: 'u-1',
    deletedAt: null,
    ...over,
  };
}

function fileMessageRow(over: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    senderUserId: 'u-1',
    recipientUserId: 'u-super',
    messageType: 'file',
    bodyText: 'акт.pdf',
    payloadJson: JSON.stringify({ id: 'file-1', name: 'акт.pdf', size: 10, mime: 'application/pdf', sha256: 'abc', createdAt: NOW }),
    createdAt: Date.now(),
    deletedAt: null,
    ...over,
  };
}

function trigger(over: Record<string, unknown> = {}) {
  return {
    actor: { id: 'u-1', username: 'operator', role: 'user' },
    messageId: 'msg-1',
    recipientUserId: 'u-super',
    clientId: 'PHONE-uuid',
    clientName: 'PHONE',
    deviceKind: 'tablet',
    appVersion: '3.147.0',
    ...over,
  } as any;
}

describe('бот обмена и пересылки', () => {
  beforeEach(() => {
    queueByTable.clear();
    sentMessages.length = 0;
    events.length = 0;
    accessAllowed.value = true;
    resetExchangeBotFloodGuard();
    queueByTable.set(clientSettings, [[clientRow()]]);
    queueByTable.set(fileAssets, [[fileRow()]]);
    queueByTable.set(chatMessages, [[]]);
  });

  it('на чужое сообщение бот не отвечает', async () => {
    const r = await runExchangeBotAction(trigger({ recipientUserId: 'u-2' }));
    expect(r.ok).toBe(true);
    expect(r.acted).toBe(false);
    expect(sentMessages).toHaveLength(0);
  });

  it('на файл спрашивает, кому переслать, и называет, где отправитель', async () => {
    queueByTable.set(chatMessages, [[fileMessageRow()]]);
    // Вторая машина — коллеги: выбор неоднозначен, значит вопрос.
    queueByTable.set(clientSettings, [
      [
        clientRow(),
        clientRow({ clientId: 'PC2-uuid', hostname: 'PC2', username: 'colleague', lastSeenAt: NOW - 30_000 }),
      ],
    ]);
    const r = await runExchangeBotAction(trigger({ fileId: 'file-1', fileName: 'акт.pdf' }));
    expect(r.acted).toBe(true);
    const reply = String(sentMessages.at(-1)?.text ?? '');
    expect(reply).toContain('вы на планшет PHONE');
    expect(reply).toContain('Файл «акт.pdf»');
    expect(reply).toContain('1) компьютер PC-OFIS — Иванов Иван Иванович — (вы)');
    expect(reply).toContain('2) компьютер PC2 — Петров Пётр Петрович');
    // Файл ещё не отправлен — отправка только после ответа.
    expect(sentMessages.filter((m) => m.messageType === 'file')).toHaveLength(0);
  });

  it('при однозначном выборе отправляет сразу, не спрашивая', async () => {
    queueByTable.set(chatMessages, [[fileMessageRow()]]);
    const r = await runExchangeBotAction(trigger({ fileId: 'file-1', fileName: 'акт.pdf' }));
    expect(r.acted).toBe(true);
    const fileMsg = sentMessages.find((m) => m.messageType === 'file');
    expect(fileMsg).toBeTruthy();
    expect(fileMsg?.recipientUserId).toBe('u-1');
    // Транспорт — личное сообщение чата с файлом: получатель получает доступ.
    expect((fileMsg?.payload as any)?.id).toBe('file-1');
    expect(String(sentMessages.at(-1)?.text ?? '')).toContain('переслан');
  });

  it('на ответ номером пересылает выбранному', async () => {
    queueByTable.set(clientSettings, [
      [
        clientRow(),
        clientRow({ clientId: 'PC2-uuid', hostname: 'PC2', username: 'colleague', lastSeenAt: NOW - 30_000 }),
      ],
    ]);
    // Первый запрос чата — поиск сообщения по id, второй — поиск последнего файла.
    queueByTable.set(chatMessages, [
      [
        { id: 'msg-2', senderUserId: 'u-1', recipientUserId: 'u-super', messageType: 'text', bodyText: '2', payloadJson: null, createdAt: NOW + 1000, deletedAt: null },
      ],
      [fileMessageRow()],
    ]);
    const r = await runExchangeBotAction(trigger({ messageId: 'msg-2', text: '2' }));
    expect(r.acted).toBe(true);
    const fileMsg = sentMessages.find((m) => m.messageType === 'file');
    expect(fileMsg?.recipientUserId).toBe('u-2');
    expect(String(sentMessages.at(-1)?.text ?? '')).toContain('Петров');
  });

  it('на старый запрос бот не отвечает пересылкой — файл ждёт ответа только десять минут', async () => {
    queueByTable.set(clientSettings, [
      [
        clientRow(),
        clientRow({ clientId: 'PC2-uuid', hostname: 'PC2', username: 'colleague', lastSeenAt: NOW - 30_000 }),
      ],
    ]);
    const stale = fileMessageRow({ createdAt: Date.now() - 60 * 60_000 });
    queueByTable.set(chatMessages, [
      [
        { id: 'msg-2', senderUserId: 'u-1', recipientUserId: 'u-super', messageType: 'text', bodyText: '2', payloadJson: null, createdAt: NOW + 1000, deletedAt: null },
      ],
      [stale],
    ]);
    const r = await runExchangeBotAction(trigger({ messageId: 'msg-2', text: '2' }));
    expect(sentMessages.filter((m) => m.messageType === 'file')).toHaveLength(0);
    expect(String(sentMessages.at(-1)?.text ?? '')).toContain('не вижу файла');
    expect(r.acted).toBe(true);
  });

  it('на отмену («0») бот отвечает коротко и ничего не пересылает', async () => {
    queueByTable.set(chatMessages, [
      [
        { id: 'msg-4', senderUserId: 'u-1', recipientUserId: 'u-super', messageType: 'text', bodyText: '0', payloadJson: null, createdAt: Date.now(), deletedAt: null },
      ],
    ]);
    const r = await runExchangeBotAction(trigger({ messageId: 'msg-4', text: '0' }));
    expect(r.acted).toBe(true);
    expect(sentMessages.filter((m) => m.messageType === 'file')).toHaveLength(0);
    expect(String(sentMessages.at(-1)?.text ?? '')).toContain('отменено');
  });

  it('без доступа отправителя файл не пересылает и пишет в журнал событий', async () => {
    accessAllowed.value = false;
    queueByTable.set(chatMessages, [[fileMessageRow()]]);
    const r = await runExchangeBotAction(trigger({ fileId: 'file-1', fileName: 'акт.pdf' }));
    expect(r.acted, 'бот должен сказать, что переслать не смог').toBe(true);
    expect(sentMessages.filter((m) => m.messageType === 'file')).toHaveLength(0);
    expect(String(sentMessages.at(-1)?.text ?? '')).toContain('не смог переслать');
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('exchange.bot.forward');
  });

  it('на обычный текст бот молчит', async () => {
    queueByTable.set(chatMessages, [
      [
        { id: 'msg-3', senderUserId: 'u-1', recipientUserId: 'u-super', messageType: 'text', bodyText: 'привет', payloadJson: null, createdAt: NOW, deletedAt: null },
      ],
    ]);
    const r = await runExchangeBotAction(trigger({ messageId: 'msg-3', text: 'привет' }));
    expect(r.acted).toBe(false);
    expect(sentMessages).toHaveLength(0);
  });

  it('предел флуда: больше десяти обращений в минуту — молчок', async () => {
    queueByTable.set(chatMessages, [[fileMessageRow()]]);
    for (let i = 0; i < 11; i += 1) {
      await runExchangeBotAction(trigger({ fileId: 'file-1', fileName: 'акт.pdf' }));
    }    const replies = sentMessages.filter((m) => m.messageType === 'text').length;
    expect(replies).toBeLessThanOrEqual(10);
  });
});
