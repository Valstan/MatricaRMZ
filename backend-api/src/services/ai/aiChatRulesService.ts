// Конституция ответов ИИваныча: живая версия в ai_chat_meta.rules_md, история правок —
// в ai_chat_rules_history. Читает её прямой движок (aiChatAnswerService), правит владелец
// скриптом scripts/aiChatRules.ts. Раньше этим владела облачная рутина (снята в D-024).
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { aiChatMeta, aiChatRulesHistory } from '../../database/schema.js';

export async function getAiChatRules(): Promise<string | null> {
  const rows = await db.select().from(aiChatMeta).where(eq(aiChatMeta.key, 'rules_md')).limit(1);
  const value = rows[0]?.value ?? null;
  return value && String(value).trim() ? String(value) : null;
}

export async function setAiChatRules(args: { rulesMd: string; changedBy?: string | null }) {
  const rulesMd = String(args.rulesMd ?? '');
  if (!rulesMd.trim()) throw new Error('rulesMd is empty');
  const ts = Date.now();
  await db
    .insert(aiChatMeta)
    .values({ key: 'rules_md', value: rulesMd, updatedAt: ts })
    .onConflictDoUpdate({ target: aiChatMeta.key, set: { value: rulesMd, updatedAt: ts } });
  await db.insert(aiChatRulesHistory).values({
    id: randomUUID(),
    rulesMd,
    changedBy: args.changedBy ?? 'owner',
    createdAt: ts,
  });
  return { ok: true as const, bytes: rulesMd.length };
}
