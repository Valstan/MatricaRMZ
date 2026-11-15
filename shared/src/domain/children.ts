/**
 * Детский модуль: карточка ребёнка сотрудника.
 *
 * Отдельная сущность, а не атрибут карточки сотрудника (решение владельца 15.11.2026):
 * у ребёнка свои фильтры, свои отчёты и своя история подарков. EAV под заморозкой
 * (AGENTS.md §EAV), поэтому карточка ребёнка — строгая таблица, а не новый атрибут.
 *
 * Три правила, которые здесь живут и нигде не дублируются:
 * - **возраст считается** от даты рождения (в коде нет захардкоженного возраста);
 * - **«серенький» выводится** из статуса занятости родителя (ручного флага нет);
 * - **подарок «надо получить»** — это отсутствие подарка в текущем году, а не поле в карточке.
 */

import { employmentStatusLabelRu, isSilverParentStatus, resolveEmploymentStatusCode } from './employees.js';

/** Пол ребёнка: `''` — не указан (неизвестный пол не мешает ни отбору, ни выдаче). */
export type ChildGender = 'male' | 'female' | '';

export const CHILD_GENDERS: readonly ChildGender[] = ['male', 'female'];

/** Ключи известных признаков отбора. Прочие признаки оператор заводит своими словами. */
export const CHILD_TAG_CATALOG = [
  { id: 'svo', label: 'дети СВО' },
  { id: 'treatment', label: 'на лечении' },
] as const;

export type ChildTagId = (typeof CHILD_TAG_CATALOG)[number]['id'];

/** Карточка ребёнка в строгой таблице `erp_employee_children`. */
export type ChildDto = {
  id: string;
  /** Сотрудник-родитель (id EAV-сущности сотрудника). */
  employeeId: string | null;
  fullName: string;
  /** Дата рождения (мс). */
  birthDate: number | null;
  gender: string;
  /** Признаки отбора JSON-строкой: контракт синка текстовый. */
  tagsJson: string | null;
  note: string;
  createdAt: number;
  updatedAt: number;
};

/** Запись карточки ребёнка из UI: `id` пустой — новая карточка. */
export type ChildSaveDto = {
  id?: string | null;
  employeeId?: string | null;
  fullName: string;
  birthDate?: number | null;
  gender?: string | null;
  tags?: string[] | null;
  note?: string | null;
};

/** Состояние ребёнка в глазах модуля: участвует в отборах или «серенький». */
export type ChildActivityState = 'active' | 'silver';

/** Русская подпись пола. */
export function childGenderLabelRu(gender: string | null | undefined): string {
  const g = String(gender ?? '').trim().toLowerCase();
  if (g === 'male' || g === 'm' || g === 'муж' || g === 'мальчик') return 'мальчик';
  if (g === 'female' || g === 'f' || g === 'жен' || g === 'девочка') return 'девочка';
  return 'не указан';
}

/** Разбор набора признаков из JSON-строки. Мусор и пустые строки — вон. */
export function parseChildTags(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  const text = String(raw).trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    const value = String(item ?? '').trim().slice(0, 60);
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Набор признаков в JSON-строку. */
export function serializeChildTags(tags: readonly string[] | null | undefined): string {
  const clean: string[] = [];
  for (const tag of tags ?? []) {
    const value = String(tag ?? '').trim().slice(0, 60);
    if (value && !clean.includes(value)) clean.push(value);
  }
  return JSON.stringify(clean);
}

/** Подпись признака: известные — из каталога, прочие — как есть. */
export function childTagLabelRu(tag: string): string {
  const id = String(tag ?? '').trim();
  const known = CHILD_TAG_CATALOG.find((t) => t.id === id);
  return known ? known.label : id;
}

/** Подписи всех признаков ребёнка — одной строкой. */
export function childTagsLabelRu(tags: readonly string[] | null | undefined): string {
  const list = (tags ?? []).map(childTagLabelRu).filter(Boolean);
  return list.length > 0 ? list.join(', ') : '';
}

/**
 * Возраст в полных годах — считается от даты рождения.
 * `null` означает «возраст неизвестен»: нет даты рождения или дата в будущем.
 */
export function childAgeYears(birthDateMs: number | null | undefined, nowMs: number): number | null {
  const birth = Number(birthDateMs ?? 0);
  if (!Number.isFinite(birth) || birth <= 0) return null;
  const now = Number(nowMs ?? 0);
  if (!Number.isFinite(now) || now <= 0) return null;
  if (birth > now) return null;
  const b = new Date(birth);
  const n = new Date(now);
  let age = n.getFullYear() - b.getFullYear();
  const months = n.getMonth() - b.getMonth();
  if (months < 0 || (months === 0 && n.getDate() < b.getDate())) age -= 1;
  return age < 0 ? null : age;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Ближайший день рождения — полночь локального дня, не раньше сегодня.
 * 29 февраля в «невисокосном» году JavaScript сам сдвигает на 1 марта.
 */
export function childNextBirthday(birthDateMs: number | null | undefined, nowMs: number): number | null {
  const birth = Number(birthDateMs ?? 0);
  if (!Number.isFinite(birth) || birth <= 0) return null;
  const now = Number(nowMs ?? 0);
  if (!Number.isFinite(now) || now <= 0) return null;
  const b = new Date(birth);
  const n = new Date(now);
  const today = startOfLocalDay(now);
  let next = new Date(n.getFullYear(), b.getMonth(), b.getDate()).getTime();
  if (next < today) next = new Date(n.getFullYear() + 1, b.getMonth(), b.getDate()).getTime();
  return next;
}

/** Через сколько дней день рождения (0 — сегодня). */
export function childDaysToBirthday(birthDateMs: number | null | undefined, nowMs: number): number | null {
  const next = childNextBirthday(birthDateMs, nowMs);
  if (next == null) return null;
  const today = startOfLocalDay(Number(nowMs));
  return Math.round((next - today) / 86_400_000);
}

/** День рождения в окне «за N дней» — основа напоминалок. */
export function childBirthdayWithinDays(
  birthDateMs: number | null | undefined,
  nowMs: number,
  daysAhead: number,
): boolean {
  const days = childDaysToBirthday(birthDateMs, nowMs);
  if (days == null) return false;
  return days >= 0 && days <= Math.max(0, Math.trunc(daysAhead));
}

/**
 * «Серенький» ли ребёнок — выводится из статуса занятости родителя.
 * Уволен, в декрете или на лечении → ребёнок не участвует в отборах и не попадает
 * в напоминалки. Флага на карточке ребёнка нет намеренно.
 */
export function childActivityState(args: {
  employmentStatus?: string | null;
  terminationDate?: number | null;
}): ChildActivityState {
  const code = resolveEmploymentStatusCode(args.employmentStatus, args.terminationDate);
  return isSilverParentStatus(code) ? 'silver' : 'active';
}

/** Подпись состояния ребёнка в списке. */
export function childActivityLabelRu(state: ChildActivityState): string {
  return state === 'silver' ? 'серенький' : 'участвует';
}

/**
 * Категория подарка по возрасту — стартовое правило модуля.
 * Правило намеренно грубое: оператор правит подарок руками, а правило лишь подсказывает.
 * Пол в правиле не участвует — оснований различать подарки по полу нет.
 */
export function childGiftCategoryByAge(ageYears: number | null | undefined): string {
  const age = ageYears;
  if (age == null || !Number.isFinite(age)) return '';
  if (age <= 3) return 'игрушка';
  if (age <= 6) return 'игрушка или конструктор';
  if (age <= 10) return 'конструктор или книга';
  if (age <= 14) return 'книга или спорт';
  if (age <= 17) return 'книга или сертификат';
  return 'сертификат';
}

/** Короткая подпись статуса родителя — для списка детей. */
export function parentStatusLabelRu(args: {
  employmentStatus?: string | null;
  terminationDate?: number | null;
}): string {
  const code = resolveEmploymentStatusCode(args.employmentStatus, args.terminationDate);
  return employmentStatusLabelRu(code);
}
