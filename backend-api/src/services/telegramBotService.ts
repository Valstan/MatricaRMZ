import { logWarn } from '../utils/logger.js';

const MAX_TEXT_LEN = 4000;
let missingTokenWarned = false;

function normalizeLogin(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  return value.startsWith('@') ? value : `@${value}`;
}

function getToken(): string | null {
  const token = String(process.env.MATRICA_TELEGRAM_BOT_TOKEN ?? '').trim();
  if (token) return token;
  if (!missingTokenWarned) {
    missingTokenWarned = true;
    logWarn('telegram bot token is missing; delivery disabled');
  }
  return null;
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_LEN) return text;
  return text.slice(0, MAX_TEXT_LEN - 1) + '…';
}

export async function sendTelegramMessage(args: { toLogin: string; text: string }) {
  const token = getToken();
  if (!token) return { ok: false as const, error: 'missing token' };
  const chatId = normalizeLogin(args.toLogin);
  if (!chatId) return { ok: false as const, error: 'missing login' };

  const body = {
    chat_id: chatId,
    text: truncateText(String(args.text ?? '')),
  };

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false as const, error: `telegram HTTP ${r.status}: ${t || 'no body'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok) return { ok: false as const, error: 'telegram response not ok' };
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export function formatTelegramMessage(bodyText: string, senderName: string) {
  const text = String(bodyText ?? '').trim();
  const sender = String(senderName ?? '').trim() || 'Пользователь';
  return `${text}\n\n— ${sender}`;
}
