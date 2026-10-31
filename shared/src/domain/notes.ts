import type { ChatDeepLinkPayload } from '../ipc/types.js';

export type NoteImportance = 'normal' | 'important' | 'burning' | 'later';

export type NoteBlock =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'link'; label?: string; url?: string; appLink?: ChatDeepLinkPayload }
  | { id: string; kind: 'image'; fileId: string; name?: string; mime?: string };

export type NoteItem = {
  id: string;
  ownerUserId: string;
  title: string;
  body: NoteBlock[];
  importance: NoteImportance;
  dueAt: number | null;
  /** Точки напоминания (могут быть несколько — по времени внутри дня и по дням). */
  reminders: number[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type NoteShareItem = {
  id: string;
  noteId: string;
  recipientUserId: string;
  hidden: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

/**
 * Точки напоминания заметки. В БД и в контракте синка лежат JSON-массивом в
 * `reminders_json`.
 *
 * Три состояния поля различаем намеренно:
 * - `null` — поле не задано (заметка заведена до появления множественных точек):
 *   действует старый срок `due_at`, и он считается одной точкой;
 * - `'[]'` — напоминаний нет вовсе (срок снят осознанно);
 * - `'[ts, ts, …]'` — сами точки, по возрастанию, без повторов.
 *
 * Различать «не задано» и «пусто» обязательно: клиент, который о поле не знает,
 * присылает `null` — это «не менялось», а не «очистить». Иначе старый клиент
 * затрёт набор точек, выставленный новым (на сервере это закрыто COALESCE в
 * applyPushBatch, здесь — тем же правилом чтения).
 */
export function parseNoteReminders(raw: string | null | undefined): number[] | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return normalizeNoteReminderPoints(parsed as unknown[]);
}

/** Нормализация набора точек: только целые положительные миллисекунды, без повторов, по возрастанию. */
export function normalizeNoteReminderPoints(points: readonly unknown[] | null | undefined): number[] {
  const clean: number[] = [];
  for (const raw of points ?? []) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    const point = Math.trunc(value);
    if (!clean.includes(point)) clean.push(point);
  }
  clean.sort((a, b) => a - b);
  return clean;
}

/** Набор точек в строку контракта. Пустой набор — это `'[]'`, а не `null`. */
export function serializeNoteReminders(points: readonly unknown[] | null | undefined): string {
  return JSON.stringify(normalizeNoteReminderPoints(points));
}

/**
 * Действующие точки заметки: у заметки, заведённой до множественных точек,
 * старый срок — это одна точка.
 */
export function effectiveNoteReminders(raw: string | null | undefined, dueAt: number | null | undefined): number[] {
  const parsed = parseNoteReminders(raw);
  if (parsed === null) {
    const due = Number(dueAt ?? 0);
    return Number.isFinite(due) && due > 0 ? [Math.trunc(due)] : [];
  }
  return parsed;
}

/**
 * Срок заметки = последняя точка. Раньше срок был один; теперь несколько точек
 * означают несколько сигналов, а «просрочено» наступает, когда прошла последняя.
 */
export function noteRemindersDueAt(points: readonly unknown[] | null | undefined): number | null {
  const clean = normalizeNoteReminderPoints(points);
  if (clean.length === 0) return null;
  return clean[clean.length - 1]!;
}

/** Действующий срок заметки — та же последняя точка, но с учётом legacy-строки. */
export function effectiveNoteDueAt(raw: string | null | undefined, dueAt: number | null | undefined): number | null {
  const points = effectiveNoteReminders(raw, dueAt);
  return points.length > 0 ? points[points.length - 1]! : null;
}

/** Ближайшая точка, которая ещё не прошла (для «следующего напоминания»). */
export function nextNoteReminderPoint(points: readonly number[] | null | undefined, now: number): number | null {
  const clean = normalizeNoteReminderPoints(points);
  for (const point of clean) {
    if (point > now) return point;
  }
  return null;
}
