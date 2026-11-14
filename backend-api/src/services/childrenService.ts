import { randomUUID } from 'node:crypto';

import { and, asc, eq, isNull } from 'drizzle-orm';

import { parseChildTags, serializeChildTags } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { erpEmployeeChildren } from '../database/schema.js';

/**
 * Детский модуль — серверная дверь.
 *
 * Ведёт ТОЛЬКО эта дверь: строки пишутся обычным insert/update с
 * `sync_status = 'pending'`, а публикатор зеркала (`childrenSyncPublisherService`)
 * доводит их до журнала — иначе инкрементальный pull их не увидит никогда.
 * Клиент карточку только читает (реплика), владение таблиц — `shared/domain/ledgerAuthz`.
 *
 * Правила, которые держит домен (shared/domain/children.ts), а не эта дверь:
 * возраст считается от даты рождения, «серенький» выводится из статуса занятости
 * родителя. Здесь — только проверка входа и запись.
 */

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export type ChildRow = {
  id: string;
  employeeId: string | null;
  fullName: string;
  birthDate: number | null;
  gender: string;
  tagsJson: string | null;
  note: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type ChildInput = {
  employeeId?: string | null | undefined;
  fullName: string;
  birthDate?: number | null | undefined;
  gender?: string | null | undefined;
  tags?: string[] | null | undefined;
  note?: string | null | undefined;
};

export type ChildUpdate = {
  employeeId?: string | null | undefined;
  fullName?: string | undefined;
  birthDate?: number | null | undefined;
  gender?: string | null | undefined;
  tags?: string[] | null | undefined;
  note?: string | null | undefined;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function mapChild(r: typeof erpEmployeeChildren.$inferSelect): ChildRow {
  return {
    id: String(r.id),
    employeeId: r.employeeId == null ? null : String(r.employeeId),
    fullName: String(r.fullName),
    birthDate: r.birthDate == null ? null : Number(r.birthDate),
    gender: String(r.gender ?? ''),
    tagsJson: r.tagsJson == null ? null : String(r.tagsJson),
    note: String(r.note ?? ''),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    deletedAt: r.deletedAt == null ? null : Number(r.deletedAt),
  };
}

function normalizeTags(tags: string[] | null | undefined): string[] {
  return parseChildTags(serializeChildTags(tags));
}

type ValidatedChild = {
  fullName: string;
  employeeId: string | null;
  birthDate: number | null;
  gender: string;
  tags: string[];
  note: string;
};

function validateInput(input: ChildInput): { ok: true; value: ValidatedChild } | { ok: false; error: string } {
  const fullName = String(input.fullName ?? '').trim();
  if (!fullName) return { ok: false, error: 'ФИО ребёнка обязательно' };
  if (fullName.length > 200) return { ok: false, error: 'ФИО ребёнка слишком длинное' };
  const employeeId = input.employeeId == null ? null : String(input.employeeId).trim();
  if (employeeId && !isUuid(employeeId)) return { ok: false, error: 'родитель должен быть существующим сотрудником' };
  const birthDate = input.birthDate == null ? null : Number(input.birthDate);
  if (birthDate != null && (!Number.isFinite(birthDate) || birthDate <= 0)) {
    return { ok: false, error: 'дата рождения задана неверно' };
  }
  if (birthDate != null && birthDate > Date.now()) return { ok: false, error: 'дата рождения не может быть в будущем' };
  const gender = String(input.gender ?? '').trim().toLowerCase();
  if (gender && gender !== 'male' && gender !== 'female') {
    return { ok: false, error: 'пол задан неверно' };
  }
  return {
    ok: true,
    value: {
      fullName,
      employeeId,
      birthDate,
      gender,
      tags: normalizeTags(input.tags),
      note: String(input.note ?? '').trim().slice(0, 2000),
    },
  };
}

export async function listChildren(): Promise<Result<{ children: ChildRow[] }>> {
  const rows = await db
    .select()
    .from(erpEmployeeChildren)
    .where(isNull(erpEmployeeChildren.deletedAt))
    .orderBy(asc(erpEmployeeChildren.fullName));
  return { ok: true, children: rows.map(mapChild) };
}

export async function getChild(id: string): Promise<Result<{ child: ChildRow }>> {
  const childId = String(id ?? '').trim();
  if (!isUuid(childId)) return { ok: false, error: 'id ребёнка должен быть uuid' };
  const [row] = await db
    .select()
    .from(erpEmployeeChildren)
    .where(and(eq(erpEmployeeChildren.id, childId as any), isNull(erpEmployeeChildren.deletedAt)))
    .limit(1);
  if (!row) return { ok: false, error: 'карточка ребёнка не найдена' };
  return { ok: true, child: mapChild(row) };
}

export async function createChild(input: ChildInput): Promise<Result<{ id: string }>> {
  const checked = validateInput(input);
  if (!checked.ok) return checked;
  const now = Date.now();
  const id = randomUUID();
  await db.insert(erpEmployeeChildren).values({
    id: id as any,
    employeeId: checked.value.employeeId as any,
    fullName: checked.value.fullName,
    birthDate: checked.value.birthDate,
    gender: checked.value.gender ?? '',
    tagsJson: serializeChildTags(checked.value.tags ?? []),
    note: checked.value.note ?? '',
    createdAt: now,
    updatedAt: now,
    syncStatus: 'pending',
  });
  return { ok: true, id };
}

export async function updateChild(id: string, input: ChildUpdate): Promise<Result<{ id: string }>> {
  const childId = String(id ?? '').trim();
  if (!isUuid(childId)) return { ok: false, error: 'id ребёнка должен быть uuid' };
  const [current] = await db
    .select()
    .from(erpEmployeeChildren)
    .where(and(eq(erpEmployeeChildren.id, childId as any), isNull(erpEmployeeChildren.deletedAt)))
    .limit(1);
  if (!current) return { ok: false, error: 'карточка ребёнка не найдена' };
  const merged = validateInput({
    employeeId: input.employeeId === undefined ? current.employeeId : input.employeeId,
    fullName: input.fullName === undefined ? current.fullName : input.fullName,
    birthDate: input.birthDate === undefined ? current.birthDate : input.birthDate,
    gender: input.gender === undefined ? current.gender : input.gender,
    tags: input.tags === undefined ? parseChildTags(current.tagsJson) : input.tags,
    note: input.note === undefined ? current.note : input.note,
  });
  if (!merged.ok) return merged;
  await db
    .update(erpEmployeeChildren)
    .set({
      employeeId: merged.value.employeeId as any,
      fullName: merged.value.fullName,
      birthDate: merged.value.birthDate,
      gender: merged.value.gender ?? '',
      tagsJson: serializeChildTags(merged.value.tags ?? []),
      note: merged.value.note ?? '',
      updatedAt: Date.now(),
      syncStatus: 'pending',
    })
    .where(eq(erpEmployeeChildren.id, childId as any));
  return { ok: true, id: childId };
}

export async function deleteChild(id: string): Promise<Result<{ id: string }>> {
  const childId = String(id ?? '').trim();
  if (!isUuid(childId)) return { ok: false, error: 'id ребёнка должен быть uuid' };
  const [current] = await db
    .select()
    .from(erpEmployeeChildren)
    .where(and(eq(erpEmployeeChildren.id, childId as any), isNull(erpEmployeeChildren.deletedAt)))
    .limit(1);
  if (!current) return { ok: false, error: 'карточка ребёнка не найдена' };
  await db
    .update(erpEmployeeChildren)
    .set({ deletedAt: Date.now(), updatedAt: Date.now(), syncStatus: 'pending' })
    .where(eq(erpEmployeeChildren.id, childId as any));
  return { ok: true, id: childId };
}
