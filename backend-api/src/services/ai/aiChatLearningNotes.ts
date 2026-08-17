// Память самообучения ИИваныча: короткие заметки «как понимать пользователей»
// (синонимы, сокращения, где лежат данные, удачные ходы после уточнений).
// Живёт в ai_chat_meta.learning_md одним markdown-блоком и подмешивается в
// системный промпт каждого ответа — так опыт уточняющих диалогов накапливается
// и следующий раз обходится без переспрашивания.
//
// Пишет её сама модель через tool save_learning_note; правки владельца — тем же
// ключом. Блок ограничен по размеру: при переполнении старейшие строки
// вытесняются (свежий опыт ценнее).
import { eq } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { aiChatMeta } from '../../database/schema.js';

const KEY = 'learning_md';
const MAX_BYTES = 24_000;
const MAX_NOTE_LENGTH = 500;

export async function getLearningNotes(): Promise<string | null> {
  const rows = await db.select().from(aiChatMeta).where(eq(aiChatMeta.key, KEY)).limit(1);
  const value = rows[0]?.value ?? null;
  return value && String(value).trim() ? String(value) : null;
}

export async function appendLearningNote(note: string): Promise<{ ok: true; total: number } | { ok: false; error: string }> {
  const clean = String(note ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NOTE_LENGTH);
  if (!clean) return { ok: false, error: 'пустая заметка' };
  const existing = (await getLearningNotes()) ?? '';
  // Дубликаты не копим: одна и та же подсказка не должна съедать лимит.
  if (existing.toLowerCase().includes(clean.toLowerCase())) {
    return { ok: true, total: existing.length };
  }
  const stamp = new Date().toISOString().slice(0, 10);
  let next = existing ? `${existing}\n- [${stamp}] ${clean}` : `- [${stamp}] ${clean}`;
  // Вытесняем старейшие строки при переполнении.
  while (next.length > MAX_BYTES) {
    const cut = next.indexOf('\n');
    if (cut < 0) break;
    next = next.slice(cut + 1);
  }
  const ts = Date.now();
  await db
    .insert(aiChatMeta)
    .values({ key: KEY, value: next, updatedAt: ts })
    .onConflictDoUpdate({ target: aiChatMeta.key, set: { value: next, updatedAt: ts } });
  return { ok: true, total: next.length };
}
