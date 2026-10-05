// Мост «очередь ИИваныча → Телефон» (мандат brain 2026-10-05, D-111).
// Пока DeepSeek не оплачен, на вопросы операторов отвечает живая сессия через
// Телефон; движок без ключа простаивает честно, конкурента у моста нет.
// Воркер крутится только на primary (как остальные фоновые джобы).
//
// Claim — строкой в aiChatMeta (`hotline_bridge_claim:<uuid>`, см. план
// docs/plans/iivanych-hotline-bridge-2026-10.md): вставка по PK атомарна,
// статус строки всё время `pending`, снятие claim'а = возврат в очередь
// без единой записи в ledger. Мета не синкается — маркер серверный.
// Claim-first: мост забирает свежие pending до того, как их сможет
// забрать DeepSeek — иначе 2-секундный тик движка всегда выигрывает
// гонку и мост не успевает (поймано dry-run'ом v3.64.0).

import { and, asc, eq, isNull } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { aiChatMeta, aiChatRequests } from '../../database/schema.js';
import { logError, logInfo, logWarn } from '../../utils/logger.js';
import { resolveAlertTarget } from '../criticalEventsTelegramService.js';
import { isTelegramIntegrationEnabled, sendTelegramMessage, sendTelegramMessageToChat } from '../telegramBotService.js';
import {
  getAiChatActor,
  nowMs,
  writeAiChatRow,
  type AiChatActor,
} from './aiChatWriteService.js';
import {
  isHotlineRelayConfigured,
  logRelayError,
  relayPost,
  relayPresence,
  relayRead,
  type HotlineMessage,
} from './hotlineRelayClient.js';

export const BRIDGE_ROOM = 'to-MatricaRMZ';
export const BRIDGE_SENDER = 'MatricaRMZ';
/** Лимит текста релея — тот же, что в контракте (karman docs/hotline-relay.md). */
export const RELAY_TEXT_LIMIT = 2000;

const CLAIM_PREFIX = 'hotline_bridge_claim:';
const CURSOR_KEY = 'hotline_bridge_cursor';

const TICK_MS = Math.max(5_000, Number(process.env.AI_CHAT_BRIDGE_TICK_MS ?? 30_000));
const CLAIM_TIMEOUT_MS = Math.max(60_000, Number(process.env.AI_CHAT_BRIDGE_TIMEOUT_MS ?? 30 * 60_000));
const BATCH = Math.max(1, Math.min(Number(process.env.AI_CHAT_BRIDGE_BATCH ?? 5), 20));
const PENDING_SCAN_LIMIT = 200;
/** Часы на концах плывут — присутствие считаем свежим с запасом. */
const PRESENCE_SKEW_MS = 60_000;

type BridgeClaim = {
  claimedAt: number;
  postedAt: number | null;
  relayMsgId: number | null;
  pagedAt: number | null;
};

export function claimKey(id: string): string {
  return `${CLAIM_PREFIX}${id}`;
}

export function parseClaim(raw: unknown): BridgeClaim | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<BridgeClaim>;
    if (!Number.isFinite(Number(v.claimedAt))) return null;
    return {
      claimedAt: Number(v.claimedAt),
      postedAt: typeof v.postedAt === 'number' ? v.postedAt : null,
      relayMsgId: typeof v.relayMsgId === 'number' ? v.relayMsgId : null,
      pagedAt: typeof v.pagedAt === 'number' ? v.pagedAt : null,
    };
  } catch {
    return null;
  }
}

/** Текст вопроса в релей: префикс с id (по нему сессия отвечает) + обрезанный вопрос. */
export function buildBridgeText(questionText: string, id: string, hasFile: boolean): string {
  const prefix = `[ИИваныч #${id}] `;
  const fileNote = hasFile ? '\n(к вопросу приложен файл — смотри в программе)' : '';
  const budget = RELAY_TEXT_LIMIT - prefix.length - fileNote.length;
  const chars = Array.from(String(questionText ?? ''));
  const cut = chars.length > budget ? `${chars.slice(0, Math.max(0, budget - 1)).join('')}…` : chars.join('');
  return `${prefix}${cut}${fileNote}`;
}

const UUID_RE = /#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Ссылка `#<uuid>` в тексте сообщения сессии. */
export function extractReferencedId(text: string): string | null {
  const m = UUID_RE.exec(String(text ?? ''));
  return m?.[1] ? m[1].toLowerCase() : null;
}

/**
 * Это ответ сессии на один из ждущих вопросов (а не наш пост, не чужак, не мусор):
 * отправитель — наша метка, вид — ответ, в тексте ссылка на id из pending.
 */
export function matchSessionAnswer(msg: HotlineMessage, pendingIds: Set<string>): string | null {
  if (String(msg.sender ?? '').toLowerCase() !== BRIDGE_SENDER.toLowerCase()) return null;
  if (msg.kind !== 'answer' && msg.kind !== 'done') return null;
  const id = extractReferencedId(msg.text);
  if (!id || !pendingIds.has(id)) return null;
  return id;
}

/** Свежее присутствие метки (сессия жива — пейджинг не нужен). */
export function isPresenceFresh(
  presence: Array<{ label: string; aliveUntil: string }>,
  label: string,
  now: number,
): boolean {
  const row = presence.find((p) => String(p.label ?? '').toLowerCase() === label.toLowerCase());
  if (!row) return false;
  const until = Date.parse(String(row.aliveUntil ?? ''));
  return Number.isFinite(until) && until > now + PRESENCE_SKEW_MS;
}

async function readMeta(): Promise<Map<string, string>> {
  const rows = await db.select({ key: aiChatMeta.key, value: aiChatMeta.value }).from(aiChatMeta);
  const map = new Map<string, string>();
  for (const r of rows as Array<{ key: string; value: string }>) map.set(String(r.key), String(r.value));
  return map;
}

/** Все id, забранные мостом (для фильтра движка DeepSeek — см. B3 в плане). */
export async function listBridgedRequestIds(): Promise<Set<string>> {
  const meta = await readMeta().catch(() => new Map<string, string>());
  const ids = new Set<string>();
  for (const key of meta.keys()) {
    if (key.startsWith(CLAIM_PREFIX)) ids.add(key.slice(CLAIM_PREFIX.length));
  }
  return ids;
}


/** Атомарный claim: вставка по PK — конфликт значит, что строку забрали раньше нас. */
export async function tryClaim(id: string, now: number): Promise<boolean> {
  const value = JSON.stringify({ claimedAt: now, postedAt: null, relayMsgId: null, pagedAt: null });
  const rows = await db
    .insert(aiChatMeta)
    .values({ key: claimKey(id), value, updatedAt: now })
    .onConflictDoNothing()
    .returning({ key: aiChatMeta.key });
  return rows.length > 0;
}

async function writeClaim(id: string, claim: BridgeClaim, now: number): Promise<void> {
  await db
    .insert(aiChatMeta)
    .values({ key: claimKey(id), value: JSON.stringify(claim), updatedAt: now })
    .onConflictDoUpdate({ target: aiChatMeta.key, set: { value: JSON.stringify(claim), updatedAt: now } });
}

async function deleteClaim(id: string): Promise<void> {
  await db.delete(aiChatMeta).where(eq(aiChatMeta.key, claimKey(id)));
}

async function readCursor(meta: Map<string, string>): Promise<number> {
  const raw = meta.get(CURSOR_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

async function writeCursor(sinceId: number, now: number): Promise<void> {
  const value = String(sinceId);
  await db
    .insert(aiChatMeta)
    .values({ key: CURSOR_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: aiChatMeta.key, set: { value, updatedAt: now } });
}

type PendingRow = {
  id: string;
  userId: string;
  username: string;
  questionText: string;
  questionFileJson: string | null;
  status: string;
  createdAt: number;
  [k: string]: unknown;
};

async function listPendingRows(): Promise<PendingRow[]> {
  return (await db
    .select()
    .from(aiChatRequests)
    .where(and(isNull(aiChatRequests.deletedAt), eq(aiChatRequests.status, 'pending')))
    .orderBy(asc(aiChatRequests.createdAt))
    .limit(PENDING_SCAN_LIMIT)) as PendingRow[];
}

async function closeAsAnswered(row: PendingRow, actor: AiChatActor, answerText: string): Promise<void> {
  const ts = nowMs();
  await writeAiChatRow(actor, {
    ...row,
    status: 'answered',
    answerText,
    answeredAt: ts,
    updatedAt: ts,
  });
}

async function pageOwner(ids: string[]): Promise<boolean> {
  if (!isTelegramIntegrationEnabled()) {
    logWarn('ai chat bridge: paging skipped (MATRICA_TELEGRAM_ENABLED=false)');
    return false;
  }
  const target = await resolveAlertTarget().catch(() => null);
  if (!target) {
    logWarn('ai chat bridge: paging skipped (цель Telegram-алерта не настроена)');
    return false;
  }
  const text = `ИИваныч: новых вопросов — ${ids.length}, сессия спит. id: ${ids.join(', ')}`;
  const res =
    target.kind === 'chat'
      ? await sendTelegramMessageToChat({ chatId: target.value, text }).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
      : await sendTelegramMessage({ toLogin: target.value, text }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
  if (!res.ok) {
    logWarn(`ai chat bridge: paging failed: ${res.error}`);
    return false;
  }
  return true;
}

export type BridgeTickSummary = {
  posted: number;
  answered: number;
  released: number;
  paged: number;
};

/** Один проход моста. Экспортируется для тестов и ручного прогона. */
export async function aiChatBridgeTick(now = nowMs()): Promise<BridgeTickSummary> {
  const summary: BridgeTickSummary = { posted: 0, answered: 0, released: 0, paged: 0 };
  if (!isHotlineRelayConfigured()) return summary;
  const actor = await getAiChatActor().catch((e: unknown) => {
    logError('ai chat bridge: no actor', { error: String(e) });
    return null;
  });
  if (!actor) return summary;

  const pending = await listPendingRows().catch((e: unknown) => {
    logError('ai chat bridge: pending list failed', { error: String(e) });
    return [] as PendingRow[];
  });
  if (pending.length === 0) return summary;
  const byId = new Map(pending.map((r) => [String(r.id).toLowerCase(), r]));
  const meta = await readMeta().catch(() => new Map<string, string>());

  // 0. Claim-first: свежие pending берёт мост, движок потом фильтрует
  // (listBridgedRequestIds) — иначе гоночка двух воркеров 2 с vs 30 с.
  for (const row of pending) {
    const id = String(row.id);
    if (meta.has(claimKey(id))) continue;
    if (!(await tryClaim(id, now).catch(() => false))) continue;
    meta.set(claimKey(id), JSON.stringify({ claimedAt: now, postedAt: null, relayMsgId: null, pagedAt: null }));
  }

  // 1. Новые вопросы → релей.
  let posted = 0;
  for (const row of pending) {
    if (posted >= BATCH) break;
    const id = String(row.id);
    const existingClaimRaw = meta.get(claimKey(id));
    if (!existingClaimRaw) continue;
    const existingClaim = parseClaim(existingClaimRaw) ?? { claimedAt: now, postedAt: null, relayMsgId: null, pagedAt: null };
    if (existingClaim.postedAt) continue; // уже в relay
    const res = await relayPost({
      room: BRIDGE_ROOM,
      kind: 'question',
      text: buildBridgeText(row.questionText, id, !!row.questionFileJson),
    });
    if (res.ok) {
      const claim: BridgeClaim = { claimedAt: existingClaim.claimedAt, postedAt: now, relayMsgId: res.id, pagedAt: null };
      await writeClaim(id, claim, now).catch(() => undefined);
      meta.set(claimKey(id), JSON.stringify(claim));
      summary.posted += 1;
      posted += 1;
    } else if (!res.retryable) {
      // Отказ в приёме (линт 400, auth, relay не настроен) — сетью не лечится:
      // сразу возвращаем строку в очередь, не ждём таймаут.
      logRelayError('POST question', res);
      await deleteClaim(id).catch(() => undefined);
      meta.delete(claimKey(id));
    } else {
      logRelayError('POST question', res);
    }
  }

  // 2. Ответы сессии → очередь (постранично от курсора; курсор двигаем всегда,
  // иначе перечитываем одно и то же; перескок безопасен — id вопроса нельзя
  // угадать до его публикации, а совпадение идёт только по pending).
  let sinceId = await readCursor(meta);
  for (let page = 0; page < 5; page++) {
    const res = await relayRead({ room: BRIDGE_ROOM, sinceId, limit: 100 });
    if (!res.ok) {
      logRelayError('GET room', res);
      break;
    }
    if (res.messages.length === 0) break;
    for (const msg of res.messages) {
      sinceId = Math.max(sinceId, Number(msg.id) || sinceId);
      const ref = matchSessionAnswer(msg, new Set(byId.keys()));
      if (!ref) continue;
      const row = byId.get(ref);
      if (!row) continue;
      await closeAsAnswered(row, actor, String(msg.text ?? '')).catch((e: unknown) => {
        logError('ai chat bridge: close failed', { id: ref, error: String(e) });
      });
      await deleteClaim(ref).catch(() => undefined);
      meta.delete(claimKey(ref));
      byId.delete(ref);
      summary.answered += 1;
      logInfo('ai chat bridge: answered by session', { id: ref });
    }
    if (res.messages.length < 100) break;
  }
  await writeCursor(sinceId, now).catch(() => undefined);

  // 3. Просроченные claim'ы → снять (fail-open к движку, статус и так pending).
  const claims = await readMeta().catch(() => new Map<string, string>());
  for (const [key, raw] of claims) {
    if (!key.startsWith(CLAIM_PREFIX)) continue;
    const id = key.slice(CLAIM_PREFIX.length);
    const claim = parseClaim(raw);
    if (!claim) {
      await deleteClaim(id).catch(() => undefined);
      continue;
    }
    const ageFrom = claim.postedAt ?? claim.claimedAt;
    const age = now - ageFrom;
    if (age <= CLAIM_TIMEOUT_MS) continue;
    await deleteClaim(id).catch(() => undefined);
    summary.released += 1;
    logInfo('ai chat bridge: claim expired, back to pending', { id });
  }

  // 4. Пейджинг: заявленные без ответа и без свежего присутствия — один алерт.
  const waiting: string[] = [];
  const claimsNow = await readMeta().catch(() => new Map<string, string>());
  const pendingIds = new Set(byId.keys());
  for (const [key, raw] of claimsNow) {
    if (!key.startsWith(CLAIM_PREFIX)) continue;
    const id = key.slice(CLAIM_PREFIX.length);
    const claim = parseClaim(raw);
    if (!claim || claim.pagedAt) continue;
    if (!pendingIds.has(id.toLowerCase())) {
      await deleteClaim(id).catch(() => undefined);
      continue;
    }
    waiting.push(id);
  }
  if (waiting.length > 0) {
    const presence = await relayPresence();
    const fresh = presence.ok && isPresenceFresh(presence.presence, BRIDGE_SENDER, now);
    if (!fresh) {
      if (!presence.ok) logRelayError('GET presence', presence);
      if (await pageOwner(waiting)) {
        for (const id of waiting) {
          const claim = parseClaim(claimsNow.get(claimKey(id)) ?? null);
          if (claim) await writeClaim(id, { ...claim, pagedAt: now }, now).catch(() => undefined);
        }
        summary.paged = waiting.length;
      }
    }
  }

  return summary;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let misconfiguredWarned = false;

export function startAiChatHotlineBridge(): void {
  if (timer) return;
  if (String(process.env.AI_CHAT_BRIDGE_ENABLED ?? 'true').trim().toLowerCase() === 'false') {
    logInfo('ai chat bridge: disabled (AI_CHAT_BRIDGE_ENABLED=false)');
    return;
  }
  if (!isHotlineRelayConfigured() && !misconfiguredWarned) {
    misconfiguredWarned = true;
    logWarn('ai chat bridge: relay not configured (HOTLINE_RELAY_SECRET/HOTLINE_RELAY_URL) — questions wait as usual');
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await aiChatBridgeTick();
      if (s.posted + s.answered + s.released + s.paged > 0) {
        logInfo('ai chat bridge tick', { ...s });
      }
    } catch (e) {
      logError('ai chat bridge tick failed', { error: String(e) });
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  logInfo('ai chat bridge worker started', { tickMs: TICK_MS, timeoutMs: CLAIM_TIMEOUT_MS, batch: BATCH }, { critical: true });
}
