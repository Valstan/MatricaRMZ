import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import { GIFT_KINDS, ORG_EVENT_KINDS, parseEventSelections, serializeEventSelections } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { erpGiftRecords, erpOrgEvents } from '../database/schema.js';
import { publishOrganizationRowNow, toGiftRecordInput, toOrgEventInput } from './sync/childrenSyncPublisherService.js';
import type { SyncActor } from './childrenService.js';

/**
 * РћСЂРіР°РЅРёР·Р°С†РёРѕРЅРЅС‹Р№ РјРѕРґСѓР»СЊ вЂ” СЃРµСЂРІРµСЂРЅР°СЏ РґРІРµСЂСЊ.
 *
 * РњРµСЂРѕРїСЂРёСЏС‚РёСЏ (РїСЂР°Р·РґРЅРёРєРё, СЃРѕСЂРµРІРЅРѕРІР°РЅРёСЏ, РґРЅРё СЂРѕР¶РґРµРЅРёСЏ) Рё Р¶СѓСЂРЅР°Р» РІС‹РґР°С‡Рё РїРѕРґР°СЂРєРѕРІ,
 * РїСЂРёР·РѕРІ Рё РіСЂР°РјРѕС‚. Р’РµРґС‘С‚ РўРћР›Р¬РљРћ СЌС‚Р° РґРІРµСЂСЊ: СЃС‚СЂРѕРєРё РїРёС€СѓС‚СЃСЏ РѕР±С‹С‡РЅС‹Рј insert/update
 * СЃ `sync_status = 'pending'`, Р° РїСѓР±Р»РёРєР°С‚РѕСЂ Р·РµСЂРєР°Р»Р° (`childrenSyncPublisherService`)
 * РґРѕРІРѕРґРёС‚ РёС… РґРѕ Р¶СѓСЂРЅР°Р»Р° вЂ” РёРЅР°С‡Рµ РёРЅРєСЂРµРјРµРЅС‚Р°Р»СЊРЅС‹Р№ pull РёС… РЅРµ СѓРІРёРґРёС‚ РЅРёРєРѕРіРґР°.
 *
 * РџРѕР»СѓС‡Р°С‚РµР»СЊ РїРѕРґР°СЂРєР° вЂ” РЎРЎР«Р›РљРђ (СЃРѕС‚СЂСѓРґРЅРёРє РёР»Рё СЂРµР±С‘РЅРѕРє), Р° РЅРµ СЃРІРѕР±РѕРґРЅС‹Р№ С‚РµРєСЃС‚ СЃ Р¤РРћ:
 * СЃРІРѕР±РѕРґРЅС‹Р№ С‚РµРєСЃС‚ Р·Р°РІС‘Р» Р±С‹ РІ Р¶СѓСЂРЅР°Р»Рµ РґСѓР±Р»Рё.
 */

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export type OrgEventRow = {
  id: string;
  title: string;
  kind: string;
  eventDate: number | null;
  description: string;
  selectionsJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type GiftRecordRow = {
  id: string;
  eventId: string | null;
  recipientKind: string;
  recipientEmployeeId: string | null;
  recipientChildId: string | null;
  kind: string;
  title: string;
  place: string;
  givenAt: number | null;
  note: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type OrgEventInput = {
  title: string;
  kind?: string | null | undefined;
  eventDate?: number | null | undefined;
  description?: string | null | undefined;
  selections?: Array<{ childId: string; invited: boolean; reason?: string | undefined }> | null | undefined;
};

export type OrgEventUpdate = {
  title?: string | undefined;
  kind?: string | null | undefined;
  eventDate?: number | null | undefined;
  description?: string | null | undefined;
  selections?: Array<{ childId: string; invited: boolean; reason?: string | undefined }> | null | undefined;
};

export type GiftRecordInput = {
  eventId?: string | null | undefined;
  recipientKind?: string | null | undefined;
  recipientEmployeeId?: string | null | undefined;
  recipientChildId?: string | null | undefined;
  kind?: string | null | undefined;
  title?: string | null | undefined;
  place?: string | null | undefined;
  givenAt?: number | null | undefined;
  note?: string | null | undefined;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function mapEvent(r: typeof erpOrgEvents.$inferSelect): OrgEventRow {
  return {
    id: String(r.id),
    title: String(r.title),
    kind: String(r.kind),
    eventDate: r.eventDate == null ? null : Number(r.eventDate),
    description: String(r.description ?? ''),
    selectionsJson: r.selectionsJson == null ? null : String(r.selectionsJson),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    deletedAt: r.deletedAt == null ? null : Number(r.deletedAt),
  };
}

function mapGift(r: typeof erpGiftRecords.$inferSelect): GiftRecordRow {
  return {
    id: String(r.id),
    eventId: r.eventId == null ? null : String(r.eventId),
    recipientKind: String(r.recipientKind),
    recipientEmployeeId: r.recipientEmployeeId == null ? null : String(r.recipientEmployeeId),
    recipientChildId: r.recipientChildId == null ? null : String(r.recipientChildId),
    kind: String(r.kind),
    title: String(r.title ?? ''),
    place: String(r.place ?? ''),
    givenAt: r.givenAt == null ? null : Number(r.givenAt),
    note: String(r.note ?? ''),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    deletedAt: r.deletedAt == null ? null : Number(r.deletedAt),
  };
}

type ValidatedEvent = {
  title: string;
  kind: string;
  eventDate: number | null;
  description: string;
  selectionsJson: string;
};

function validateEvent(input: OrgEventInput): { ok: true; value: ValidatedEvent } | { ok: false; error: string } {
  const title = String(input.title ?? '').trim();
  if (!title) return { ok: false, error: 'РЅР°Р·РІР°РЅРёРµ РјРµСЂРѕРїСЂРёСЏС‚РёСЏ РѕР±СЏР·Р°С‚РµР»СЊРЅРѕ' };
  if (title.length > 300) return { ok: false, error: 'РЅР°Р·РІР°РЅРёРµ РјРµСЂРѕРїСЂРёСЏС‚РёСЏ СЃР»РёС€РєРѕРј РґР»РёРЅРЅРѕРµ' };
  const kind = String(input.kind ?? 'other').trim().toLowerCase();
  if (!ORG_EVENT_KINDS.includes(kind as (typeof ORG_EVENT_KINDS)[number])) {
    return { ok: false, error: 'РІРёРґ РјРµСЂРѕРїСЂРёСЏС‚РёСЏ Р·Р°РґР°РЅ РЅРµРІРµСЂРЅРѕ' };
  }
  const eventDate = input.eventDate == null ? null : Number(input.eventDate);
  if (eventDate != null && (!Number.isFinite(eventDate) || eventDate <= 0)) {
    return { ok: false, error: 'РґР°С‚Р° РјРµСЂРѕРїСЂРёСЏС‚РёСЏ Р·Р°РґР°РЅР° РЅРµРІРµСЂРЅРѕ' };
  }
  return {
    ok: true,
    value: {
      title,
      kind,
      eventDate,
      description: String(input.description ?? '').trim().slice(0, 4000),
      selectionsJson: serializeEventSelections(
        (input.selections ?? []).map((s) => ({ childId: s.childId, invited: s.invited === true, reason: s.reason ?? '' })),
      ),
    },
  };
}

type ValidatedGift = {
  eventId: string | null;
  recipientKind: string;
  recipientEmployeeId: string | null;
  recipientChildId: string | null;
  kind: string;
  title: string;
  place: string;
  givenAt: number | null;
  note: string;
};

async function validateGift(input: GiftRecordInput): Promise<{ ok: true; value: ValidatedGift } | { ok: false; error: string }> {
  const recipientKind = String(input.recipientKind ?? 'child').trim().toLowerCase();
  if (recipientKind !== 'child' && recipientKind !== 'employee') {
    return { ok: false, error: 'РїРѕР»СѓС‡Р°С‚РµР»СЊ Р·Р°РґР°РЅ РЅРµРІРµСЂРЅРѕ' };
  }
  const recipientEmployeeId = input.recipientEmployeeId == null ? null : String(input.recipientEmployeeId).trim();
  const recipientChildId = input.recipientChildId == null ? null : String(input.recipientChildId).trim();
  if (recipientKind === 'child') {
    if (!recipientChildId) return { ok: false, error: 'РїРѕР»СѓС‡Р°С‚РµР»СЊ-СЂРµР±С‘РЅРѕРє РѕР±СЏР·Р°С‚РµР»РµРЅ' };
    if (!isUuid(recipientChildId)) return { ok: false, error: 'РєР°СЂС‚РѕС‡РєР° СЂРµР±С‘РЅРєР° РЅРµ РЅР°Р№РґРµРЅР°' };
  } else {
    if (!recipientEmployeeId) return { ok: false, error: 'РїРѕР»СѓС‡Р°С‚РµР»СЊ-СЃРѕС‚СЂСѓРґРЅРёРє РѕР±СЏР·Р°С‚РµР»РµРЅ' };
    if (!isUuid(recipientEmployeeId)) return { ok: false, error: 'РїРѕР»СѓС‡Р°С‚РµР»СЊ-СЃРѕС‚СЂСѓРґРЅРёРє РЅРµ РЅР°Р№РґРµРЅ' };
  }
  const eventId = input.eventId == null ? null : String(input.eventId).trim();
  if (eventId) {
    if (!isUuid(eventId)) return { ok: false, error: 'РјРµСЂРѕРїСЂРёСЏС‚РёРµ РЅРµ РЅР°Р№РґРµРЅРѕ' };
    const [event] = await db
      .select({ id: erpOrgEvents.id })
      .from(erpOrgEvents)
      .where(and(eq(erpOrgEvents.id, eventId as any), isNull(erpOrgEvents.deletedAt)))
      .limit(1);
    if (!event) return { ok: false, error: 'РјРµСЂРѕРїСЂРёСЏС‚РёРµ РЅРµ РЅР°Р№РґРµРЅРѕ' };
  }
  const kind = String(input.kind ?? 'gift').trim().toLowerCase();
  if (!GIFT_KINDS.includes(kind as (typeof GIFT_KINDS)[number])) {
    return { ok: false, error: 'РІРёРґ РїРѕРґР°СЂРєР° Р·Р°РґР°РЅ РЅРµРІРµСЂРЅРѕ' };
  }
  const givenAt = input.givenAt == null ? null : Number(input.givenAt);
  if (givenAt != null && (!Number.isFinite(givenAt) || givenAt <= 0)) {
    return { ok: false, error: 'РґР°С‚Р° РІС‹РґР°С‡Рё Р·Р°РґР°РЅР° РЅРµРІРµСЂРЅРѕ' };
  }
  return {
    ok: true,
    value: {
      eventId: eventId || null,
      recipientKind,
      recipientEmployeeId: recipientKind === 'employee' ? recipientEmployeeId : null,
      recipientChildId: recipientKind === 'child' ? recipientChildId : null,
      kind,
      title: String(input.title ?? '').trim().slice(0, 300),
      place: String(input.place ?? '').trim().slice(0, 120),
      givenAt,
      note: String(input.note ?? '').trim().slice(0, 2000),
    },
  };
}

export async function listOrgEvents(): Promise<Result<{ events: OrgEventRow[] }>> {
  const rows = await db
    .select()
    .from(erpOrgEvents)
    .where(isNull(erpOrgEvents.deletedAt))
    .orderBy(desc(erpOrgEvents.eventDate), asc(erpOrgEvents.title));
  return { ok: true, events: rows.map(mapEvent) };
}

export async function getOrgEvent(id: string): Promise<Result<{ event: OrgEventRow }>> {
  const eventId = String(id ?? '').trim();
  if (!isUuid(eventId)) return { ok: false, error: 'id РјРµСЂРѕРїСЂРёСЏС‚РёСЏ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ uuid' };
  const [row] = await db
    .select()
    .from(erpOrgEvents)
    .where(and(eq(erpOrgEvents.id, eventId as any), isNull(erpOrgEvents.deletedAt)))
    .limit(1);
  if (!row) return { ok: false, error: 'РјРµСЂРѕРїСЂРёСЏС‚РёРµ РЅРµ РЅР°Р№РґРµРЅРѕ' };
  return { ok: true, event: mapEvent(row) };
}

export async function createOrgEvent(input: OrgEventInput, actor?: SyncActor): Promise<Result<{ id: string }>> {
  const checked = validateEvent(input);
  if (!checked.ok) return checked;
  const now = Date.now();
  const id = randomUUID();
  const row = {
    id,
    title: checked.value.title,
    kind: checked.value.kind,
    eventDate: checked.value.eventDate,
    description: checked.value.description,
    selectionsJson: checked.value.selectionsJson,
    createdAt: now,
    updatedAt: now,
    deletedAt: null as number | null,
  };
  await db.insert(erpOrgEvents).values({
    id: id as any,
    title: row.title,
    kind: row.kind,
    eventDate: row.eventDate,
    description: row.description,
    selectionsJson: row.selectionsJson,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'pending',
  });
  await publishOrganizationRowNow(toOrgEventInput(row as any), actor);
  return { ok: true, id };
}

export async function updateOrgEvent(id: string, input: OrgEventUpdate, actor?: SyncActor): Promise<Result<{ id: string }>> {
  const eventId = String(id ?? '').trim();
  if (!isUuid(eventId)) return { ok: false, error: 'id РјРµСЂРѕРїСЂРёСЏС‚РёСЏ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ uuid' };
  const [current] = await db
    .select()
    .from(erpOrgEvents)
    .where(and(eq(erpOrgEvents.id, eventId as any), isNull(erpOrgEvents.deletedAt)))
    .limit(1);
  if (!current) return { ok: false, error: 'РјРµСЂРѕРїСЂРёСЏС‚РёРµ РЅРµ РЅР°Р№РґРµРЅРѕ' };
  const merged = validateEvent({
    title: input.title === undefined ? current.title : input.title,
    kind: input.kind === undefined ? current.kind : input.kind,
    eventDate: input.eventDate === undefined ? current.eventDate : input.eventDate,
    description: input.description === undefined ? current.description : input.description,
    selections:
      input.selections === undefined
        ? parseEventSelections(current.selectionsJson).map((s) => ({ childId: s.childId, invited: s.invited, reason: s.reason }))
        : input.selections,
  });
  if (!merged.ok) return merged;
  await db
    .update(erpOrgEvents)
    .set({
      title: merged.value.title,
      kind: merged.value.kind,
      eventDate: merged.value.eventDate,
      description: merged.value.description,
      selectionsJson: merged.value.selectionsJson,
      updatedAt: Date.now(),
      syncStatus: 'pending',
    })
    .where(eq(erpOrgEvents.id, eventId as any));
  const [fresh] = await db.select().from(erpOrgEvents).where(eq(erpOrgEvents.id, eventId as any)).limit(1);
  if (fresh) await publishOrganizationRowNow(toOrgEventInput(fresh as any), actor);
  return { ok: true, id: eventId };
}

export async function deleteOrgEvent(id: string, actor?: SyncActor): Promise<Result<{ id: string }>> {
  const eventId = String(id ?? '').trim();
  if (!isUuid(eventId)) return { ok: false, error: 'id РјРµСЂРѕРїСЂРёСЏС‚РёСЏ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ uuid' };
  const [current] = await db
    .select()
    .from(erpOrgEvents)
    .where(and(eq(erpOrgEvents.id, eventId as any), isNull(erpOrgEvents.deletedAt)))
    .limit(1);
  if (!current) return { ok: false, error: 'РјРµСЂРѕРїСЂРёСЏС‚РёРµ РЅРµ РЅР°Р№РґРµРЅРѕ' };
  await db
    .update(erpOrgEvents)
    .set({ deletedAt: Date.now(), updatedAt: Date.now(), syncStatus: 'pending' })
    .where(eq(erpOrgEvents.id, eventId as any));
  const [fresh] = await db.select().from(erpOrgEvents).where(eq(erpOrgEvents.id, eventId as any)).limit(1);
  if (fresh) await publishOrganizationRowNow(toOrgEventInput(fresh as any), actor);
  return { ok: true, id: eventId };
}

export async function listGiftRecords(): Promise<Result<{ gifts: GiftRecordRow[] }>> {
  const rows = await db
    .select()
    .from(erpGiftRecords)
    .where(isNull(erpGiftRecords.deletedAt))
    .orderBy(desc(erpGiftRecords.givenAt), asc(erpGiftRecords.title));
  return { ok: true, gifts: rows.map(mapGift) };
}

export async function createGiftRecord(input: GiftRecordInput, actor?: SyncActor): Promise<Result<{ id: string }>> {
  const checked = await validateGift(input);
  if (!checked.ok) return checked;
  const now = Date.now();
  const id = randomUUID();
  const row = {
    id,
    eventId: checked.value.eventId,
    recipientKind: checked.value.recipientKind,
    recipientEmployeeId: checked.value.recipientEmployeeId,
    recipientChildId: checked.value.recipientChildId,
    kind: checked.value.kind,
    title: checked.value.title,
    place: checked.value.place,
    givenAt: checked.value.givenAt,
    note: checked.value.note,
    createdAt: now,
    updatedAt: now,
    deletedAt: null as number | null,
  };
  await db.insert(erpGiftRecords).values({
    id: id as any,
    eventId: row.eventId as any,
    recipientKind: row.recipientKind,
    recipientEmployeeId: row.recipientEmployeeId as any,
    recipientChildId: row.recipientChildId as any,
    kind: row.kind,
    title: row.title,
    place: row.place,
    givenAt: row.givenAt,
    note: row.note,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'pending',
  });
  await publishOrganizationRowNow(toGiftRecordInput(row as any), actor);
  return { ok: true, id };
}

export async function updateGiftRecord(id: string, input: GiftRecordInput, actor?: SyncActor): Promise<Result<{ id: string }>> {
  const giftId = String(id ?? '').trim();
  if (!isUuid(giftId)) return { ok: false, error: 'id Р·Р°РїРёСЃРё Рѕ РІС‹РґР°С‡Рµ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ uuid' };
  const [current] = await db
    .select()
    .from(erpGiftRecords)
    .where(and(eq(erpGiftRecords.id, giftId as any), isNull(erpGiftRecords.deletedAt)))
    .limit(1);
  if (!current) return { ok: false, error: 'Р·Р°РїРёСЃСЊ Рѕ РІС‹РґР°С‡Рµ РЅРµ РЅР°Р№РґРµРЅР°' };
  const checked = await validateGift({
    eventId: input.eventId === undefined ? current.eventId : input.eventId,
    recipientKind: input.recipientKind === undefined ? current.recipientKind : input.recipientKind,
    recipientEmployeeId: input.recipientEmployeeId === undefined ? current.recipientEmployeeId : input.recipientEmployeeId,
    recipientChildId: input.recipientChildId === undefined ? current.recipientChildId : input.recipientChildId,
    kind: input.kind === undefined ? current.kind : input.kind,
    title: input.title === undefined ? current.title : input.title,
    place: input.place === undefined ? current.place : input.place,
    givenAt: input.givenAt === undefined ? current.givenAt : input.givenAt,
    note: input.note === undefined ? current.note : input.note,
  });
  if (!checked.ok) return checked;
  await db
    .update(erpGiftRecords)
    .set({
      eventId: checked.value.eventId as any,
      recipientKind: checked.value.recipientKind,
      recipientEmployeeId: checked.value.recipientEmployeeId as any,
      recipientChildId: checked.value.recipientChildId as any,
      kind: checked.value.kind,
      title: checked.value.title,
      place: checked.value.place,
      givenAt: checked.value.givenAt,
      note: checked.value.note,
      updatedAt: Date.now(),
      syncStatus: 'pending',
    })
    .where(eq(erpGiftRecords.id, giftId as any));
  const [fresh] = await db.select().from(erpGiftRecords).where(eq(erpGiftRecords.id, giftId as any)).limit(1);
  if (fresh) await publishOrganizationRowNow(toGiftRecordInput(fresh as any), actor);
  return { ok: true, id: giftId };
}

export async function deleteGiftRecord(id: string, actor?: SyncActor): Promise<Result<{ id: string }>> {
  const giftId = String(id ?? '').trim();
  if (!isUuid(giftId)) return { ok: false, error: 'id Р·Р°РїРёСЃРё Рѕ РІС‹РґР°С‡Рµ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ uuid' };
  const [current] = await db
    .select()
    .from(erpGiftRecords)
    .where(and(eq(erpGiftRecords.id, giftId as any), isNull(erpGiftRecords.deletedAt)))
    .limit(1);
  if (!current) return { ok: false, error: 'Р·Р°РїРёСЃСЊ Рѕ РІС‹РґР°С‡Рµ РЅРµ РЅР°Р№РґРµРЅР°' };
  await db
    .update(erpGiftRecords)
    .set({ deletedAt: Date.now(), updatedAt: Date.now(), syncStatus: 'pending' })
    .where(eq(erpGiftRecords.id, giftId as any));
  const [fresh] = await db.select().from(erpGiftRecords).where(eq(erpGiftRecords.id, giftId as any)).limit(1);
  if (fresh) await publishOrganizationRowNow(toGiftRecordInput(fresh as any), actor);
  return { ok: true, id: giftId };
}
