import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { cardDrafts } from '../database/schema.js';
import { getSession } from './authService.js';

// Черновики/recovery-снимки карточек в работе (Phase 3). Owner-private, синкается между ПК
// оператора. card_id — id целевого документа (может ещё не существовать). См.
// docs/plans/_archive/drafts-no-empty-cards-recovery-2026-06.md.

function nowMs() {
  return Date.now();
}

async function currentUser(db: BetterSQLite3Database): Promise<{ id: string } | null> {
  const s = await getSession(db).catch(() => null);
  const u = s?.user;
  if (!u?.id) return null;
  return { id: String(u.id) };
}

export type CardDraftRecord = {
  id: string;
  cardType: string;
  cardId: string;
  kind: 'recovery' | 'explicit';
  title: string | null;
  payloadJson: string | null;
  baseUpdatedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

function mapRow(row: any): CardDraftRecord {
  return {
    id: String(row.id),
    cardType: String(row.cardType),
    cardId: String(row.cardId),
    kind: row.kind === 'explicit' ? 'explicit' : 'recovery',
    title: row.title == null ? null : String(row.title),
    payloadJson: row.payloadJson == null ? null : String(row.payloadJson),
    baseUpdatedAt: row.baseUpdatedAt == null ? null : Number(row.baseUpdatedAt),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

type SaveArgs = {
  cardType: string;
  cardId: string;
  kind?: 'recovery' | 'explicit';
  title?: string | null;
  payloadJson?: string | null;
  baseUpdatedAt?: number | null;
};

/** Upsert a working snapshot for (owner, cardType, cardId). One draft per card per operator. */
export async function saveCardDraft(
  db: BetterSQLite3Database,
  args: SaveArgs,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false as const, error: 'auth required' };
    if (!args.cardType?.trim() || !args.cardId?.trim()) return { ok: false as const, error: 'cardType/cardId required' };
    const ts = nowMs();
    const kind = args.kind === 'explicit' ? 'explicit' : 'recovery';
    const existing = await db
      .select()
      .from(cardDrafts)
      .where(
        and(
          eq(cardDrafts.ownerUserId, me.id),
          eq(cardDrafts.cardType, args.cardType),
          eq(cardDrafts.cardId, args.cardId),
          isNull(cardDrafts.deletedAt),
        ),
      )
      .limit(1);
    if (existing[0]) {
      const id = String((existing[0] as any).id);
      await db
        .update(cardDrafts)
        .set({
          kind,
          title: args.title ?? null,
          payloadJson: args.payloadJson ?? null,
          baseUpdatedAt: args.baseUpdatedAt ?? null,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'pending',
        })
        .where(eq(cardDrafts.id, id));
      return { ok: true as const, id };
    }
    const id = randomUUID();
    await db.insert(cardDrafts).values({
      id,
      ownerUserId: me.id,
      cardType: args.cardType,
      cardId: args.cardId,
      kind,
      title: args.title ?? null,
      payloadJson: args.payloadJson ?? null,
      baseUpdatedAt: args.baseUpdatedAt ?? null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    return { ok: true as const, id };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

/** All live drafts for the current operator, newest first (recovery panel on startup). */
export async function listCardDrafts(
  db: BetterSQLite3Database,
): Promise<{ ok: true; drafts: CardDraftRecord[] } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false as const, error: 'auth required' };
    const rows = await db
      .select()
      .from(cardDrafts)
      .where(and(eq(cardDrafts.ownerUserId, me.id), isNull(cardDrafts.deletedAt)))
      .orderBy(desc(cardDrafts.updatedAt))
      .limit(5000);
    return { ok: true as const, drafts: rows.map(mapRow) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

/** The draft for one card, if any (checked when opening a card). */
export async function getCardDraft(
  db: BetterSQLite3Database,
  args: { cardType: string; cardId: string },
): Promise<{ ok: true; draft: CardDraftRecord | null } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false as const, error: 'auth required' };
    const rows = await db
      .select()
      .from(cardDrafts)
      .where(
        and(
          eq(cardDrafts.ownerUserId, me.id),
          eq(cardDrafts.cardType, String(args.cardType)),
          eq(cardDrafts.cardId, String(args.cardId)),
          isNull(cardDrafts.deletedAt),
        ),
      )
      .limit(1);
    return { ok: true as const, draft: rows[0] ? mapRow(rows[0]) : null };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

/** Soft-delete a draft (commit to the document store, or operator discard). Syncs the removal. */
export async function clearCardDraft(
  db: BetterSQLite3Database,
  args: { id?: string; cardType?: string; cardId?: string },
): Promise<{ ok: true; cleared: number } | { ok: false; error: string }> {
  try {
    const me = await currentUser(db);
    if (!me) return { ok: false as const, error: 'auth required' };
    const ts = nowMs();
    const selector = args.id
      ? and(eq(cardDrafts.id, String(args.id)), eq(cardDrafts.ownerUserId, me.id), isNull(cardDrafts.deletedAt))
      : and(
          eq(cardDrafts.ownerUserId, me.id),
          eq(cardDrafts.cardType, String(args.cardType ?? '')),
          eq(cardDrafts.cardId, String(args.cardId ?? '')),
          isNull(cardDrafts.deletedAt),
        );
    const targets = await db.select({ id: cardDrafts.id }).from(cardDrafts).where(selector).limit(5000);
    if (targets.length === 0) return { ok: true as const, cleared: 0 };
    for (const t of targets) {
      await db
        .update(cardDrafts)
        .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' })
        .where(eq(cardDrafts.id, String((t as any).id)));
    }
    return { ok: true as const, cleared: targets.length };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}
