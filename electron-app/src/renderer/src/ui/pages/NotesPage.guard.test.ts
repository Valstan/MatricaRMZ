import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож страницы «Заметки»: текст, который человек печатает, не имеет права
 * затираться приехавшей копией.
 *
 * Живая поломка 26.10.2026: эффект слияния черновиков стоял в зависимостях от
 * собственной отметки изменений (`[notes, dirty]`), перезапускал сам себя и на
 * каждом проходе подставлял в textarea серверный снимок — «ничего записать
 * нельзя, всё стирается тут же». Поведение сторожат `noteDrafts.test.ts`, а этот
 * файл держит форму: зависимость, ради которой всё сломалось, и источник
 * черновика для автосохранения.
 */
const page = readFileSync(path.resolve(__dirname, 'NotesPage.tsx'), 'utf8');
const watcher = readFileSync(path.resolve(__dirname, '../hooks/useNoteReminderWatcher.ts'), 'utf8');

describe('NotesPage: напоминаний может быть несколько', () => {
  it('редактор — список точек, а не одно поле с датой', () => {
    expect(page).toContain('addReminderPoint');
    expect(page).toContain('changeReminderPoint');
    // Прежняя форма была одним чекбоксом и одним datetime-local.
    expect(page).not.toContain('checked={Boolean(draft.dueAt)}');
  });

  it('срабатывание живёт на уровне приложения, а не на странице', () => {
    // Страница «Заметки» смонтирована только если её открывали: напоминание,
    // которое приходит лишь на этой вкладке, — не напоминание.
    expect(page).not.toContain('Напоминание по заметке');
    expect(watcher).toContain('Напоминание по заметке');
  });

  it('сработавшие точки не повторяются после перезапуска программы', () => {
    expect(watcher).toContain('localStorage');
  });
});

describe('NotesPage: набираемый текст не затирается', () => {
  it('эффект слияния черновиков не зависит от карты отметок', () => {
    expect(page).not.toContain('[notes, dirty]');
    expect(page).not.toContain('[dirty, notes]');
    expect(page).toContain('mergeDraftsFromNotes(prev, notes, (id) => dirtyRef.current[id] === true)');
  });

  it('слияние доверено общему правилу из noteDrafts, а не написано на месте', () => {
    expect(page).toContain("from '../utils/noteDrafts.js'");
    // Прежняя форма подставляла строку сервера в черновик прямо в странице.
    expect(page).not.toContain('if (!prev[n.id] || !dirty[n.id])');
  });

  it('автосохранение читает черновик из ref, а не из замыкания рендера', () => {
    const saveDraftBody = page.slice(page.indexOf('async function saveDraft'), page.indexOf('async function createNote'));
    expect(saveDraftBody).toContain('const draft = draftsRef.current[id];');
    expect(saveDraftBody).not.toContain('const draft = drafts[id];');
  });

  it('отметки изменений ставятся и снимаются помощниками (без лишних объектов состояния)', () => {
    expect(page).toContain('setDirty((prev) => markDirty(prev, id))');
    expect(page).toContain('setDirty((prev) => clearDirty(prev, id))');
    expect(page).not.toContain('setDirty((prev) => ({ ...prev, [id]: true }))');
  });
});
