import { describe, expect, it, vi, beforeEach, afterEach, beforeAll } from 'vitest';

let sendTelegramMessage: (args: { toLogin: string; text: string }) => Promise<{ ok: boolean; error?: string }>;
let formatTelegramMessage: (bodyText: string, senderName: string) => string;

describe('telegramBotService', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.MATRICA_TELEGRAM_BOT_TOKEN = 'test-token';
    const mod = await import('../services/telegramBotService.js');
    sendTelegramMessage = mod.sendTelegramMessage;
    formatTelegramMessage = mod.formatTelegramMessage;
  });

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
      text: async () => '',
    })) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('formats message with signature', () => {
    const text = formatTelegramMessage('Привет', 'Иван Иванов');
    expect(text).toBe('Привет\n\n— Иван Иванов');
  });

  it('sends message to normalized @username', async () => {
    const res = await sendTelegramMessage({ toLogin: 'user123', text: 'hello' });
    expect(res.ok).toBe(true);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = (fetchMock as any).mock?.calls ?? [];
    const opts = (calls[0]?.[1] ?? null) as any;
    const body = JSON.parse(String(opts?.body ?? '{}'));
    expect(body.chat_id).toBe('@user123');
    expect(body.text).toBe('hello');
  });
});
