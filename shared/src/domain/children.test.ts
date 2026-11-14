import { describe, expect, it } from 'vitest';

import {
  CHILD_TAG_CATALOG,
  childActivityLabelRu,
  childActivityState,
  childAgeYears,
  childBirthdayWithinDays,
  childDaysToBirthday,
  childGiftCategoryByAge,
  childNextBirthday,
  childTagLabelRu,
  childTagsLabelRu,
  parseChildTags,
  serializeChildTags,
} from './children.js';
import {
  childGiftDueThisYear,
  giftsForChild,
  parseEventSelections,
  serializeEventSelections,
  type GiftRecord,
} from './orgGifts.js';

const NOW = new Date(2026, 0, 15, 10, 0, 0).getTime();

describe('детский модуль — возраст', () => {
  it('считает полные годы от даты рождения', () => {
    const birth = new Date(2016, 5, 20).getTime();
    expect(childAgeYears(birth, NOW)).toBe(9);
  });

  it('до дня рождения возраст на год меньше', () => {
    const birth = new Date(2016, 11, 31).getTime();
    expect(childAgeYears(birth, NOW)).toBe(9);
  });

  it('возраст меняется вместе с датой рождения', () => {
    expect(childAgeYears(new Date(2016, 5, 20).getTime(), NOW)).toBe(9);
    expect(childAgeYears(new Date(2015, 5, 20).getTime(), NOW)).toBe(10);
  });

  it('без даты рождения возраст неизвестен', () => {
    expect(childAgeYears(null, NOW)).toBeNull();
    expect(childAgeYears(new Date(2030, 0, 1).getTime(), NOW)).toBeNull();
  });
});

describe('детский модуль — «серенькие»', () => {
  it('уволенный родитель делает ребёнка сереньким', () => {
    expect(childActivityState({ employmentStatus: 'fired' })).toBe('silver');
  });

  it('родитель в декрете или на лечении — тоже серенький', () => {
    expect(childActivityState({ employmentStatus: 'decret' })).toBe('silver');
    expect(childActivityState({ employmentStatus: 'sick_leave' })).toBe('silver');
  });

  it('дата увольнения перевешивает статус', () => {
    expect(childActivityState({ employmentStatus: 'working', terminationDate: NOW })).toBe('silver');
  });

  it('работающий родитель оставляет ребёнка участвующим', () => {
    expect(childActivityState({ employmentStatus: 'working' })).toBe('active');
    expect(childActivityLabelRu('active')).toBe('участвует');
  });
});

describe('детский модуль — напоминалки ко дню рождения', () => {
  it('находит ближайший день рождения', () => {
    const birth = new Date(2016, 0, 20).getTime();
    expect(childDaysToBirthday(birth, NOW)).toBe(5);
    expect(childNextBirthday(birth, NOW)).toBe(new Date(2026, 0, 20).getTime());
  });

  it('день рождения в окне «за N дней»', () => {
    const birth = new Date(2016, 0, 20).getTime();
    expect(childBirthdayWithinDays(birth, NOW, 7)).toBe(true);
    expect(childBirthdayWithinDays(birth, NOW, 3)).toBe(false);
  });

  it('прошедший день рождения ждёт следующего года', () => {
    const birth = new Date(2016, 0, 5).getTime();
    expect(childDaysToBirthday(birth, NOW)).toBe(355);
  });

  it('29 февраля в невисокосный год — 1 марта', () => {
    const birth = new Date(2016, 1, 29).getTime();
    expect(childNextBirthday(birth, NOW)).toBe(new Date(2026, 2, 1).getTime());
  });
});

describe('детский модуль — признаки', () => {
  it('разбирает и собирает набор признаков', () => {
    const tags = parseChildTags(JSON.stringify(['svo', 'treatment']));
    expect(tags).toEqual(['svo', 'treatment']);
    expect(serializeChildTags(tags)).toBe('["svo","treatment"]');
  });

  it('битый JSON не роняет разбор', () => {
    expect(parseChildTags('{oops')).toEqual([]);
    expect(parseChildTags(null)).toEqual([]);
  });

  it('подпись известного признака берётся из каталога', () => {
    expect(childTagLabelRu(CHILD_TAG_CATALOG[0].id)).toBe('дети СВО');
    expect(childTagsLabelRu(['svo', 'свой'])).toBe('дети СВО, свой');
  });
});

describe('детский модуль — правило подарка', () => {
  it('категория подарка зависит от возраста', () => {
    expect(childGiftCategoryByAge(2)).toBe('игрушка');
    expect(childGiftCategoryByAge(9)).toBe('конструктор или книга');
    expect(childGiftCategoryByAge(30)).toBe('сертификат');
    expect(childGiftCategoryByAge(null)).toBe('');
  });
});

describe('организационный модуль — журнал выдачи', () => {
  const gift = (over: Partial<GiftRecord>): GiftRecord => ({
    id: 'g1',
    eventId: null,
    recipientKind: 'child',
    recipientEmployeeId: null,
    recipientChildId: 'c1',
    kind: 'gift',
    title: 'Конструктор',
    place: '',
    givenAt: new Date(2026, 0, 3).getTime(),
    note: '',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });

  it('подарок в этом году закрывает потребность', () => {
    const result = childGiftDueThisYear({
      gifts: [gift({})],
      childId: 'c1',
      birthDate: new Date(2016, 5, 20).getTime(),
      nowMs: NOW,
    });
    expect(result.received).toBe(1);
    expect(result.due).toBe(false);
  });

  it('без подарка в этом году ребёнку «надо получить»', () => {
    const result = childGiftDueThisYear({
      gifts: [gift({ givenAt: new Date(2025, 0, 3).getTime() })],
      childId: 'c1',
      birthDate: new Date(2016, 5, 20).getTime(),
      nowMs: NOW,
    });
    expect(result.received).toBe(0);
    expect(result.due).toBe(true);
    expect(result.category).toBe('конструктор или книга');
  });

  it('подарки фильтруются по ребёнку', () => {
    expect(giftsForChild([gift({}), gift({ recipientChildId: 'c2' })], 'c1')).toHaveLength(1);
  });
});

describe('организационный модуль — решения по отбору', () => {
  it('решения сохраняются и читаются', () => {
    const json = serializeEventSelections([
      { childId: 'c1', invited: true, reason: 'победитель' },
      { childId: 'c2', invited: false, reason: '' },
    ]);
    const parsed = parseEventSelections(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ childId: 'c1', invited: true, reason: 'победитель' });
    expect(parsed[1]?.invited).toBe(false);
  });

  it('битые данные не роняют разбор', () => {
    expect(parseEventSelections('не json')).toEqual([]);
    expect(parseEventSelections(null)).toEqual([]);
  });
});
