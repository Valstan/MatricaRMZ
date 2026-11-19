import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Комната КАРМАНА в тестах пустая: рантайм читает её сам, но в тестах это лишний шум.
vi.mock('../services/karmanVaultClient.js', () => ({
  readVaultSecret: vi.fn(async () => null),
}));

import { discoverMaxTarget, isMaxAlertConfigured, sendMaxAlert } from '../services/criticalEventsMaxService.js';

/**
 * Канал МАКС: без токена и адресата он — честный no-op (ни одного запроса наружу),
 * а с настроенным — уходит по контракту MAX Bot API: POST platform-api2.max.ru/messages,
 * токен в заголовке Authorization, без Bearer.
 */
describe('канал МАКС', () => {
  const savedEnv = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.MATRICA_MAX_ALERT_TOKEN;
    delete process.env.MATRICA_MAX_ALERT_CHAT_ID;
    delete process.env.MATRICA_MAX_ALERT_USER_ID;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.unstubAllGlobals();
  });

  it('без токена и адресата канала нет — и запросов наружу тоже нет', async () => {
    expect(await isMaxAlertConfigured()).toBe(false);
    const res = await sendMaxAlert('тест');
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('токен без адресата — канала тоже нет (адресат обязателен)', async () => {
    process.env.MATRICA_MAX_ALERT_TOKEN = 'secret-token';
    expect(await isMaxAlertConfigured()).toBe(false);
  });

  it('со всеми настройками сообщение уходит по контракту MAX Bot API', async () => {
    process.env.MATRICA_MAX_ALERT_TOKEN = 'secret-token';
    process.env.MATRICA_MAX_ALERT_CHAT_ID = 'chat-42';
    expect(await isMaxAlertConfigured()).toBe(true);
    const res = await sendMaxAlert('🚨 очередь застряла');
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://platform-api2.max.ru/messages?chat_id=chat-42');
    expect((init.headers as Record<string, string>).Authorization).toBe('secret-token');
    expect(JSON.parse(String(init.body)).text).toBe('🚨 очередь застряла');
  });

  it('личный диалог — по user_id, а не по chat_id', async () => {
    process.env.MATRICA_MAX_ALERT_TOKEN = 'secret-token';
    process.env.MATRICA_MAX_ALERT_USER_ID = '12345';
    await sendMaxAlert('тест');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://platform-api2.max.ru/messages?user_id=12345');
  });

  it('отказ платформы не роняет вызывающего — текст ошибки остаётся в ответе', async () => {
    process.env.MATRICA_MAX_ALERT_TOKEN = 'secret-token';
    process.env.MATRICA_MAX_ALERT_CHAT_ID = 'chat-42';
    fetchMock.mockImplementation(async () => new Response('token is invalid', { status: 401 }));
    const res = await sendMaxAlert('тест');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('401');
  });

  it('пустое сообщение не отправляем', async () => {
    process.env.MATRICA_MAX_ALERT_TOKEN = 'secret-token';
    process.env.MATRICA_MAX_ALERT_CHAT_ID = 'chat-42';
    const res = await sendMaxAlert('   ');
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('адресат узнаётся из сообщения боту (GET /chats у МАКС отключён)', async () => {
    process.env.MATRICA_MAX_ALERT_TOKEN = 'secret-token';
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          updates: [
            { type: 'message_created', message: { chat: { chat_id: 777 }, user: { user_id: 42 }, text: 'Привет' } },
          ],
        }),
        { status: 200 },
      ),
    );
    const found = await discoverMaxTarget();
    expect(found.ok).toBe(true);
    expect(found.ok === true && found.chatId).toBe('777');
    expect(found.ok === true && found.userId).toBe('42');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/updates');
  });

  it('без сообщений адресат не определён — и это не ошибка канала', async () => {
    process.env.MATRICA_MAX_ALERT_TOKEN = 'secret-token';
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ updates: [] }), { status: 200 }));
    const found = await discoverMaxTarget();
    expect(found.ok).toBe(false);
  });

  it('событие bot_started: chat_id лежит на верхнем уровне (контракт из «Сарафана»)', async () => {
    process.env.MATRICA_MAX_ALERT_TOKEN = 'secret-token';
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ updates: [{ type: 'bot_started', chat_id: 557954956 }] }), { status: 200 }),
    );
    const found = await discoverMaxTarget();
    expect(found.ok).toBe(true);
    expect(found.ok === true && found.chatId).toBe('557954956');
  });
});
