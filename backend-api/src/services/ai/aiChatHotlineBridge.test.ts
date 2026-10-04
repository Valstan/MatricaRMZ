// Мост «очередь ИИваныча → Телефон» (D-111): чистые функции + проходы тика
// на фейковой БД (паттерн aiChatHistoryService.test.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const metaStore = new Map<string, string>();
let requestRows: Array<Record<string, any>> = [];
const writtenRows: Array<{ row: any }> = [];
const tgSent: Array<{ chatId?: string; toLogin?: string; text: string }> = [];
const fetchMock = vi.fn();

function col(key: string) {
  return { key };
}

vi.mock('drizzle-orm', () => ({
  and: (...preds: any[]) => (row: any) => preds.every((p) => (typeof p === 'function' ? p(row) : true)),
  eq: (c: any, v: any) => (row: any) => row[c.key] === v,
  isNull: (c: any) => (row: any) => row[c.key] == null,
  asc: (c: any) => ({ key: c.key, dir: 'asc' as const }),
}));

vi.mock('../../database/schema.js', () => ({
  aiChatMeta: { key: col('key'), value: col('value'), updatedAt: col('updatedAt') },
  aiChatRequests: {
    id: col('id'),
    userId: col('userId'),
    username: col('username'),
    questionText: col('questionText'),
    questionFileJson: col('questionFileJson'),
    status: col('status'),
    createdAt: col('createdAt'),
    updatedAt: col('updatedAt'),
    deletedAt: col('deletedAt'),
  },
}));

vi.mock('../../database/db.js', () => {
  function selectChain(table: any) {
    const state: { whereFn?: (r: any) => boolean; orderKey?: string; limitN?: number } = {};
    const exec = () => {
      if (table.value !== undefined) {
        // aiChatMeta — в моке только она несёт поле value
        let rows = [...metaStore].map(([key, value]) => ({ key, value }));
        if (state.whereFn) rows = rows.filter(state.whereFn);
        return rows;
      }
      let rows = requestRows.filter((r) => r.deletedAt == null && r.status === 'pending');
      if (state.whereFn) rows = rows.filter(state.whereFn);
      if (state.orderKey) rows = [...rows].sort((a, b) => Number(a[state.orderKey!] ?? 0) - Number(b[state.orderKey!] ?? 0));
      if (typeof state.limitN === 'number') rows = rows.slice(0, state.limitN);
      return rows;
    };
    const chain: any = {
      from() {
        return chain;
      },
      where(fn: any) {
        state.whereFn = fn;
        return chain;
      },
      orderBy(o: any) {
        state.orderKey = o?.key;
        return chain;
      },
      limit(n: number) {
        state.limitN = n;
        return Promise.resolve(exec());
      },
      then(resolve: any) {
        return Promise.resolve(exec()).then(resolve);
      },
    };
    return chain;
  }
  return {
    db: {
      select: () => ({ from: (table: any) => selectChain(table) }),
      insert: (table: any) => ({
        values: (v: any) => {
          const apply = () => {
            if (table.value !== undefined) {
              if (metaStore.has(v.key)) return [];
              metaStore.set(v.key, v.value);
              return [{ key: v.key }];
            }
            return [{ id: v.id }];
          };
          const applyUpsert = () => {
            if (table.value !== undefined) metaStore.set(v.key, v.value);
            return [{ key: v.key }];
          };
          return {
            onConflictDoNothing: () => ({ returning: async () => apply() }),
            // Прод ждёт сам билдер (.onConflictDoUpdate({...}) без .returning()),
            // поэтому применяем сразу — returning() идемпотентен.
            onConflictDoUpdate: () => {
              applyUpsert();
              return { returning: async () => [{ key: v.key }] };
            },
            returning: async () => applyUpsert(),
          };
        },
      }),
      delete: (table: any) => ({
        where: async (pred: any) => {
          if (table.value !== undefined) {
            for (const [k, val] of [...metaStore]) {
              if (!pred || pred({ key: k, value: val })) metaStore.delete(k);
            }
          }
          return [];
        },
      }),
    },
  };
});

vi.mock('./aiChatWriteService.js', () => ({
  nowMs: () => Date.now(),
  getAiChatActor: async () => ({ id: 'actor-1', username: 'ai-agent', role: 'admin' }),
  writeAiChatRow: async (_actor: any, row: any) => {
    writtenRows.push({ row });
    const i = requestRows.findIndex((r) => r.id === row.id);
    if (i >= 0) requestRows[i] = { ...requestRows[i], ...row };
    return { skipped: [] as string[] };
  },
}));

vi.mock('../criticalEventsTelegramService.js', () => ({
  resolveAlertTarget: async () => ({ kind: 'chat', value: 'alert-chat' }),
}));

vi.mock('../telegramBotService.js', () => ({
  isTelegramIntegrationEnabled: () => true,
  sendTelegramMessageToChat: async (args: any) => {
    tgSent.push({ chatId: String(args.chatId), text: String(args.text) });
    return { ok: true as const };
  },
  sendTelegramMessage: async (args: any) => {
    tgSent.push({ toLogin: String(args.toLogin), text: String(args.text) });
    return { ok: true as const };
  },
}));

import {
  aiChatBridgeTick,
  BRIDGE_ROOM,
  buildBridgeText,
  claimKey,
  extractReferencedId,
  isPresenceFresh,
  listBridgedRequestIds,
  matchSessionAnswer,
  parseClaim,
  RELAY_TEXT_LIMIT,
  tryClaim,
} from './aiChatHotlineBridgeService.js';

const QID = '11111111-1111-4111-8111-111111111111';

function seedQuestion(over: Partial<Record<string, any>> = {}) {
  const row = {
    id: QID,
    userId: 'u-1',
    username: 'oper',
    questionText: 'сколько двигателей в ремонте?',
    questionFileJson: null,
    status: 'pending',
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    ...over,
  };
  requestRows.push(row);
  return row;
}

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body };
}

beforeEach(() => {
  metaStore.clear();
  requestRows = [];
  writtenRows.length = 0;
  tgSent.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.HOTLINE_RELAY_SECRET = 'test-secret';
  process.env.HOTLINE_RELAY_URL = 'https://relay.example';
  // По умолчанию: POST ушёл (201), комната пуста, присутствие протухло.
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/api/hotline/presence')) {
      return jsonResponse(200, { presence: [] });
    }
    if (String(url).includes('/api/hotline?')) {
      return jsonResponse(200, { messages: [] });
    }
    return jsonResponse(201, { id: 42, created_at: 'x' });
  });
});

describe('чистые функции моста', () => {
  it('текст: префикс с id, влезает в лимит релея', () => {
    const t = buildBridgeText('q'.repeat(5000), QID, true);
    expect(t.startsWith(`[ИИваныч #${QID}] `)).toBe(true);
    expect(t.length).toBeLessThanOrEqual(RELAY_TEXT_LIMIT);
    expect(t).toContain('приложен файл');
    expect(buildBridgeText('короткий', QID, false)).toBe(`[ИИваныч #${QID}] короткий`);
  });

  it('ссылка #uuid: регистр неважен, мусора нет', () => {
    expect(extractReferencedId(`смотри #${QID.toUpperCase()} тут`)).toBe(QID);
    expect(extractReferencedId('без ссылки')).toBeNull();
    expect(extractReferencedId(`склейка x#${QID}y`)).toBe(QID);
  });

  it('матчинг: только answer/done от нашей метки со ссылкой на pending', () => {
    const pending = new Set([QID]);
    const base = { id: 1, room: BRIDGE_ROOM, sender: 'MatricaRMZ', text: `готово #${QID}`, createdAt: 'x' };
    expect(matchSessionAnswer({ ...base, kind: 'answer' }, pending)).toBe(QID);
    expect(matchSessionAnswer({ ...base, kind: 'done' }, pending)).toBe(QID);
    expect(matchSessionAnswer({ ...base, kind: 'question' }, pending)).toBeNull();
    expect(matchSessionAnswer({ ...base, kind: 'answer', sender: 'KARMAN' }, pending)).toBeNull();
    expect(matchSessionAnswer({ ...base, kind: 'answer', text: 'без ссылки' }, pending)).toBeNull();
    expect(matchSessionAnswer({ ...base, kind: 'answer', text: `чужой #${'2'.repeat(8)}-1111-4111-8111-111111111111` }, pending)).toBeNull();
  });

  it('присутствие: свежее/протухшее/нет — с запасом на скос часов', () => {
    const now = 1_000_000;
    const fresh = [{ label: 'matricarmz', aliveUntil: new Date(now + 600_000).toISOString() }];
    expect(isPresenceFresh(fresh, 'MatricaRMZ', now)).toBe(true);
    const stale = [{ label: 'MatricaRMZ', aliveUntil: new Date(now - 1).toISOString() }];
    expect(isPresenceFresh(stale, 'MatricaRMZ', now)).toBe(false);
    expect(isPresenceFresh([], 'MatricaRMZ', now)).toBe(false);
  });

  it('claim: roundtrip и мусор', () => {
    expect(parseClaim(JSON.stringify({ claimedAt: 5, postedAt: null, relayMsgId: null, pagedAt: null }))).toMatchObject({
      claimedAt: 5,
    });
    expect(parseClaim('claimed')).toBeNull();
    expect(parseClaim(null)).toBeNull();
    expect(claimKey(QID)).toBe(`hotline_bridge_claim:${QID}`);
  });
});

describe('claim и очередь', () => {
  it('CAS: второй claim того же id проигрывает', async () => {
    expect(await tryClaim(QID, 100)).toBe(true);
    expect(await tryClaim(QID, 101)).toBe(false);
    expect(await listBridgedRequestIds()).toEqual(new Set([QID]));
  });

  it('без секрета релея — тик no-op без единого запроса', async () => {
    delete process.env.HOTLINE_RELAY_SECRET;
    seedQuestion();
    const s = await aiChatBridgeTick(1000);
    expect(s).toEqual({ posted: 0, answered: 0, released: 0, paged: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('новый вопрос уходит в комнату моста один раз', async () => {
    seedQuestion();
    const s = await aiChatBridgeTick(1000);
    expect(s.posted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // POST + GET пустой комнаты + presence (сессия спит → пейджинг)
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('https://relay.example/api/hotline');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: 'MatricaRMZ', room: BRIDGE_ROOM, kind: 'question' });
    expect(String(body.text).startsWith(`[ИИваныч #${QID}]`)).toBe(true);
    expect(await listBridgedRequestIds()).toEqual(new Set([QID]));

    fetchMock.mockClear();
    const s2 = await aiChatBridgeTick(2000);
    expect(s2.posted).toBe(0);
    const posts = fetchMock.mock.calls.filter((c) => (c[1] as any)?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('отказ релея в приёме (400) — claim снимается сразу, без ожидания таймаута', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/hotline?')) return jsonResponse(200, { messages: [] });
      if (String(url).includes('/presence')) return jsonResponse(200, { presence: [] });
      return jsonResponse(400, { error: 'lint' });
    });
    seedQuestion();
    const s = await aiChatBridgeTick(1000);
    expect(s.posted).toBe(0);
    expect(await listBridgedRequestIds()).toEqual(new Set());
  });
});

describe('ответы сессии', () => {
  it('answer от нашей метки закрывает вопрос штатным путём', async () => {
    seedQuestion();
    await aiChatBridgeTick(1000);
    expect(writtenRows).toHaveLength(0);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/hotline?')) {
        return jsonResponse(200, {
          messages: [
            { id: 50, room: BRIDGE_ROOM, sender: 'MatricaRMZ', kind: 'answer', text: `В ремонте 5 #${QID}`, createdAt: 'x' },
          ],
        });
      }
      if (String(url).includes('/presence')) return jsonResponse(200, { presence: [] });
      return jsonResponse(201, { id: 43, created_at: 'x' });
    });
    const s = await aiChatBridgeTick(2000);
    expect(s.answered).toBe(1);
    expect(writtenRows).toHaveLength(1);
    expect(writtenRows[0]?.row).toMatchObject({ id: QID, status: 'answered' });
    expect(String(writtenRows[0]?.row.answerText)).toContain(QID);
    expect(await listBridgedRequestIds()).toEqual(new Set());
  });

  it('чужак и мусор комнату не трогают', async () => {
    seedQuestion();
    await aiChatBridgeTick(1000);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/hotline?')) {
        return jsonResponse(200, {
          messages: [
            { id: 51, room: BRIDGE_ROOM, sender: 'KARMAN', kind: 'answer', text: `держи #${QID}`, createdAt: 'x' },
            { id: 52, room: BRIDGE_ROOM, sender: 'MatricaRMZ', kind: 'answer', text: 'просто болтовня', createdAt: 'x' },
            { id: 53, room: BRIDGE_ROOM, sender: 'MatricaRMZ', kind: 'question', text: `[ИИваныч #${QID}] повтор`, createdAt: 'x' },
          ],
        });
      }
      if (String(url).includes('/presence')) return jsonResponse(200, { presence: [] });
      return jsonResponse(201, { id: 44, created_at: 'x' });
    });
    const s = await aiChatBridgeTick(2000);
    expect(s.answered).toBe(0);
    expect(writtenRows).toHaveLength(0);
    expect(await listBridgedRequestIds()).toEqual(new Set([QID]));
  });
});

describe('fail-open и пейджинг', () => {
  it('claim старше таймаута снимается, строка остаётся pending', async () => {
    seedQuestion();
    await aiChatBridgeTick(1000);
    expect(await listBridgedRequestIds()).toEqual(new Set([QID]));
    const s = await aiChatBridgeTick(1000 + 31 * 60_000);
    expect(s.released).toBe(1);
    expect(await listBridgedRequestIds()).toEqual(new Set());
    expect(writtenRows).toHaveLength(0);
    expect(requestRows[0]?.status).toBe('pending');
  });

  it('сессия спит — один алерт со счётом и id, без текста вопроса; дубля нет', async () => {
    seedQuestion();
    const s1 = await aiChatBridgeTick(1000);
    expect(s1.posted).toBe(1);
    expect(s1.paged).toBe(1);
    expect(tgSent).toHaveLength(1);
    expect(tgSent[0]?.text).toContain(QID);
    expect(tgSent[0]?.text).not.toContain('двигателей в ремонте');

    const s2 = await aiChatBridgeTick(3000);
    expect(s2.paged).toBe(0);
    expect(tgSent).toHaveLength(1);
  });

  it('сессия жива — пейджинга нет', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/presence')) {
        return jsonResponse(200, {
          presence: [{ label: 'MatricaRMZ', aliveUntil: new Date(Date.now() + 3_600_000).toISOString() }],
        });
      }
      if (String(url).includes('/api/hotline?')) return jsonResponse(200, { messages: [] });
      return jsonResponse(201, { id: 45, created_at: 'x' });
    });
    seedQuestion();
    const s = await aiChatBridgeTick(1000);
    expect(s.posted).toBe(1);
    expect(s.paged).toBe(0);
    expect(tgSent).toHaveLength(0);
  });
});
