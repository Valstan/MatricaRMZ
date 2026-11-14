import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Правило «сереньких» (детей уволенных, в декрете и на лечении) держится на одном
// признаке — статусе занятости родителя. Если экран начнёт считать его сам по-своему,
// список отфильтрует одно, а напоминалка и отбор — другое: ребёнок «прячется»
// наполовину, и оператор не видит, почему его нет в отборе.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const CHILDREN = src('./ChildrenPage.tsx');
const ORGANIZATION = src('./OrganizationPage.tsx');
const CARD = src('../components/ChildCardDialog.tsx');

describe('экран «Дети» — серенькие не попадают в напоминания', () => {
  it('список «кого поздравить» берёт только участвующих', () => {
    expect(CHILDREN).toContain("r.activityState === 'active'");
    expect(CHILDREN).toContain('childBirthdayWithinDays');
  });

  it('напоминание заводится заметкой со сроком и точками', () => {
    expect(CHILDREN).toContain('window.matrica.notes.upsert');
    expect(CHILDREN).toContain('reminders:');
    expect(CHILDREN).toContain('dueAt: birthday');
  });

  it('состояние выводится общим правилом домена, а не разбором статуса на экране', () => {
    expect(CHILDREN).toContain('childActivityState');
    expect(CHILDREN).not.toMatch(/===\s*'fired'/);
  });
});

describe('отбор под мероприятие — серенькие в отбор не попадают', () => {
  it('чекбокс приглашения у серенького выключен', () => {
    expect(ORGANIZATION).toContain('silver');
    expect(ORGANIZATION).toContain('disabled={busy || !props.canEdit || silver}');
  });

  it('решение оператора сохраняется, а результат фильтра — нет', () => {
    expect(ORGANIZATION).toContain('selections:');
    expect(ORGANIZATION).not.toContain('saveSelectionList');
  });
});

describe('карточка ребёнка — возраст считается, а не хранится', () => {
  it('карточка берёт возраст из даты рождения', () => {
    expect(CARD).toContain('childAgeYears');
    expect(CARD).not.toMatch(/ageYears:\s*\d/);
  });
});
