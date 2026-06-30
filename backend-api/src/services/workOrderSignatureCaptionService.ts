import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import { db } from '../database/db.js';
import { workOrderSignatureCaptions } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

const CAPTION_MAX = 200;

/** Dedupe key: trim + collapse spaces + lowercase + ё→е (mirrors the DB unique index). */
function normCaption(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е');
}

export async function listWorkOrderSignatureCaptions(): Promise<Ok<{ captions: string[] }>> {
  const rows = await db
    .select({ text: workOrderSignatureCaptions.text })
    .from(workOrderSignatureCaptions)
    .orderBy(asc(workOrderSignatureCaptions.text));
  return { ok: true, captions: rows.map((r) => r.text) };
}

export async function addWorkOrderSignatureCaption(args: {
  text: string;
  actor: string | null;
}): Promise<Ok<{ added: boolean }> | Err> {
  const text = String(args.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, error: 'Пустая формулировка' };
  if (text.length > CAPTION_MAX) return { ok: false, error: `Формулировка длиннее ${CAPTION_MAX} символов` };
  const textNorm = normCaption(text);

  const existing = await db
    .select({ id: workOrderSignatureCaptions.id })
    .from(workOrderSignatureCaptions)
    .where(eq(workOrderSignatureCaptions.textNorm, textNorm))
    .limit(1);
  if (existing.length) return { ok: true, added: false };

  await db
    .insert(workOrderSignatureCaptions)
    .values({
      id: randomUUID(),
      text,
      textNorm,
      createdAt: Date.now(),
      ...(args.actor ? { createdBy: args.actor } : {}),
    })
    .onConflictDoNothing();
  return { ok: true, added: true };
}
