import type { NoteBlock, NoteImportance, NoteItem } from '@matricarmz/shared';
import { normalizeNoteReminderPoints } from '@matricarmz/shared';

/**
 * Черновик заметки, который живёт в состоянии страницы между пушами синка.
 *
 * Правило одно и оно же — причина, по которой этот файл существует отдельно:
 * **несохранённый текст сильнее серверной копии**. Пока заметка помечена `dirty`,
 * строку из `notes` в черновик не подставляем — иначе каждый pull (а он приходит
 * и после собственного автосохранения) затирал бы то, что человек печатает прямо
 * сейчас. Живой симптом поломки 26.10.2026: «вносишь текст — он стирается».
 */
export type NoteDraft = {
  id: string;
  title: string;
  body: NoteBlock[];
  importance: NoteImportance;
  /** Срок заметки — последняя точка напоминания (производное от `reminders`). */
  dueAt: number | null;
  /** Точки напоминания: несколько дат-времён на заметку (и по дням, и внутри дня). */
  reminders: number[];
};

export function newNoteBlockId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? (crypto as any).randomUUID()
    : `note_${Math.random().toString(36).slice(2)}`;
}

export function getTextFromBody(body: NoteBlock[]): string {
  const lines: string[] = [];
  for (const b of body) {
    if (b.kind === 'text') lines.push(b.text);
  }
  return lines.join('\n').trim();
}

export function makeAutoTitle(body: NoteBlock[]): string {
  const first = getTextFromBody(body)
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean);
  if (!first) return 'Заметка';
  return first.slice(0, 80);
}

export function ensureTextBlock(body: NoteBlock[]): { body: NoteBlock[]; textIndex: number } {
  const idx = body.findIndex((b) => b.kind === 'text');
  if (idx >= 0) return { body, textIndex: idx };
  return { body: [{ id: newNoteBlockId(), kind: 'text', text: '' } as NoteBlock, ...body], textIndex: 0 };
}

export function noteDraftFromNote(note: NoteItem): NoteDraft {
  const normalized = ensureTextBlock(note.body ?? []);
  // Точки приезжают уже действующими (правило чтения на сервере и в сервисе
  // клиента); если поле ещё пустое — падаем на старый срок как на одну точку.
  const reminders = normalizeNoteReminderPoints(
    note.reminders?.length ? note.reminders : note.dueAt ? [note.dueAt] : [],
  );
  return {
    id: note.id,
    title: makeAutoTitle(normalized.body),
    body: normalized.body,
    importance: note.importance ?? 'normal',
    dueAt: reminders.length > 0 ? reminders[reminders.length - 1]! : null,
    reminders,
  };
}

/**
 * Правка набора точек напоминания. Точки — источник истины, срок — последняя
 * из них: держать два независимых поля значит однажды показать «срок» в одном
 * месте, а напоминать в другом.
 */
export function noteDraftReminderPatch(points: readonly number[]): { reminders: number[]; dueAt: number | null } {
  const reminders = normalizeNoteReminderPoints(points);
  return {
    reminders,
    dueAt: reminders.length > 0 ? reminders[reminders.length - 1]! : null,
  };
}

/**
 * Свести приехавшие с сервера заметки с черновиками страницы.
 *
 * - черновик, помеченный `dirty`, остаётся ровно тем, что человек набрал;
 * - остальные пересобираются из строки (сервер — источник правды);
 * - исчезнувшие заметки выбрасываются;
 * - если ничего не поменялось, возвращается тот же объект (`prev`) — иначе
 *   эффект, вызвавший слияние, гонял бы лишние рендеры на каждом пуше.
 */
export function mergeDraftsFromNotes(
  prev: Record<string, NoteDraft>,
  notes: NoteItem[],
  isDirty: (id: string) => boolean,
): Record<string, NoteDraft> {
  const next: Record<string, NoteDraft> = {};
  let changed = false;
  for (const note of notes) {
    const existing = prev[note.id];
    if (existing && isDirty(note.id)) {
      next[note.id] = existing;
      continue;
    }
    const current = noteDraftFromNote(note);
    next[note.id] = current;
    if (changed) continue;
    changed =
      !existing ||
      existing.title !== current.title ||
      existing.importance !== current.importance ||
      existing.dueAt !== current.dueAt ||
      JSON.stringify(existing.reminders ?? []) !== JSON.stringify(current.reminders ?? []) ||
      JSON.stringify(existing.body) !== JSON.stringify(current.body);
  }
  if (!changed && Object.keys(prev).length !== Object.keys(next).length) changed = true;
  return changed ? next : prev;
}

/** Убрать из карты отметок те заметки, которых больше нет, не трогая остальные. */
export function pruneDirtyFlags(prev: Record<string, boolean>, notes: NoteItem[]): Record<string, boolean> {
  const alive = new Set(notes.map((n) => n.id));
  const hasStale = Object.keys(prev).some((id) => !alive.has(id));
  if (!hasStale) return prev;
  const next: Record<string, boolean> = {};
  for (const note of notes) {
    if (prev[note.id]) next[note.id] = true;
  }
  return next;
}

/** Отметить черновик изменённым, не создавая новый объект, если он уже отмечен. */
export function markDirty(prev: Record<string, boolean>, id: string): Record<string, boolean> {
  return prev[id] === true ? prev : { ...prev, [id]: true };
}

/** Снять отметку после успешного сохранения (идемпотентно). */
export function clearDirty(prev: Record<string, boolean>, id: string): Record<string, boolean> {
  return prev[id] === false ? prev : { ...prev, [id]: false };
}
