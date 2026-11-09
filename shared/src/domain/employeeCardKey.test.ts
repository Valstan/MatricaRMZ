import { describe, expect, it } from 'vitest';

import {
  compareEmployeeCardKeys,
  employeeCardKeyFromFields,
  isNewEmployeeCardRelation,
  isNewRelation,
  normalizeEmployeeDate,
  normalizeEmployeeFullName,
  normalizeEmployeePersonnelNumber,
  normalizeEmployeePosition,
} from './employeeCardKey.js';

const key = (fields: Record<string, unknown>) => employeeCardKeyFromFields(fields);

describe('нормализация ключа', () => {
  it('ФИО не различает регистр, «ё» и лишние пробелы', () => {
    expect(normalizeEmployeeFullName('  Цветкова   Алёна Владимировна ')).toBe('цветкова алена владимировна');
    expect(normalizeEmployeeFullName('ЦВЕТКОВА АЛЕНА ВЛАДИМИРОВНА')).toBe(
      normalizeEmployeeFullName('Цветкова Алена Владимировна'),
    );
  });

  it('табельный номер: «00675» и «675» — один человек', () => {
    expect(normalizeEmployeePersonnelNumber('00675')).toBe('675');
    expect(normalizeEmployeePersonnelNumber(' 675 ')).toBe('675');
    expect(normalizeEmployeePersonnelNumber('')).toBe('');
  });

  it('должность не различает регистр, «ё» и лишние пробелы', () => {
    expect(normalizeEmployeePosition('Водитель  погрузчика')).toBe('водитель погрузчика');
    expect(normalizeEmployeePosition('ВОДИТЕЛЬ ПОГРУЗЧИКА')).toBe('водитель погрузчика');
  });

  it('даты разных писателей дают один календарный день', () => {
    // Клиент пишет локальную полночь, серверный импорт — UTC-полночь: миллисекунды
    // разные, день должен совпасть.
    const clientLocal = new Date(2024, 4, 17, 0, 0, 0, 0).getTime();
    expect(normalizeEmployeeDate(clientLocal)).toBe('2024-05-17');
    expect(normalizeEmployeeDate(Date.UTC(2024, 4, 17))).toBe('2024-05-17');
    expect(normalizeEmployeeDate('2024-05-17')).toBe('2024-05-17');
    expect(normalizeEmployeeDate('17.05.2024')).toBe('2024-05-17');
    expect(normalizeEmployeeDate('')).toBe('');
    expect(normalizeEmployeeDate(null)).toBe('');
  });

  it('даты до 2014 года: декретное время Москвы не сбивает день', () => {
    // До 2014-го в Москве было декретное время (UTC+4 летом). Фиксированное смещение
    // +03:00 уводило день рождения 1985 года на сутки назад — ключ переставал совпадать
    // сам с собой, и дубли по ПДО (а это главный сценарий гейта) проходили мимо.
    const decreeMidnight = Date.UTC(1985, 6, 2) - 4 * 3600_000; // полночь по Москве 02.07.1985
    expect(normalizeEmployeeDate(decreeMidnight)).toBe('1985-07-02');
    expect(normalizeEmployeeDate(Date.UTC(1985, 6, 2))).toBe('1985-07-02');
    const r = compareEmployeeCardKeys(
      key({ full_name: 'Иванов Иван Иванович', birth_date: decreeMidnight }),
      key({ full_name: 'Иванов Иван Иванович', birth_date: Date.UTC(1985, 6, 2) }),
    );
    expect(r.conflicts).not.toContain('birth_date');
    expect(r.matchedBy).toContain('birth_date');
  });
});

describe('отношение карточек', () => {
  it('совпал табельный номер — человек один, даже если ФИО разошлось', () => {
    const r = compareEmployeeCardKeys(
      key({ full_name: 'Хапикова Ирина Сергеевна', personnel_number: '818' }),
      key({ full_name: 'Хапикова И. С.', personnel_number: '00818' }),
    );
    expect(r.relation).toBe('personnel');
    expect(r.matchedBy).toContain('personnel_number');
  });

  it('разные ФИО — разные люди', () => {
    const r = compareEmployeeCardKeys(
      key({ full_name: 'Иванов Иван Иванович' }),
      key({ full_name: 'Петров Пётр Петрович' }),
    );
    expect(r.relation).toBe('different');
  });

  it('совпало только ФИО — однофамильцы, не дубль', () => {
    const r = compareEmployeeCardKeys(
      key({ full_name: 'Иванов Иван Иванович' }),
      key({ full_name: 'иванов иван иванович' }),
    );
    expect(r.relation).toBe('disputed');
    expect(r.matchedBy).toEqual(['full_name']);
  });

  it('совпал ФИО, должность и ДР — совпал ключ', () => {
    const r = compareEmployeeCardKeys(
      key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь', birth_date: Date.UTC(1980, 0, 15) }),
      key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь', birth_date: Date.UTC(1980, 0, 15) }),
    );
    expect(r.relation).toBe('exact');
    expect(r.matchedBy).toContain('birth_date');
    expect(r.matchedBy).toContain('role');
  });

  it('совпал ФИО, должность и дата приёма — совпал ключ', () => {
    const r = compareEmployeeCardKeys(
      key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь', hire_date: Date.UTC(2020, 4, 17) }),
      key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь', hire_date: Date.UTC(2020, 4, 17) }),
    );
    expect(r.relation).toBe('exact');
  });

  it('одного сильного поля мало — это ещё не ключ (однофамильцы могут иметь общую должность)', () => {
    const r = compareEmployeeCardKeys(
      key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь' }),
      key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь' }),
    );
    expect(r.relation).toBe('disputed');
  });

  it('совпало ФИО, но даты разошлись — спорный случай, не разные люди', () => {
    const r = compareEmployeeCardKeys(
      key({ full_name: 'Иванов Иван Иванович', birth_date: Date.UTC(1980, 0, 15) }),
      key({ full_name: 'Иванов Иван Иванович', birth_date: Date.UTC(1981, 0, 15) }),
    );
    expect(r.relation).toBe('disputed');
    expect(r.conflicts).toContain('birth_date');
  });

  it('разные должности при одном ФИО — спорный случай: человек один, должность разошлась', () => {
    const r = compareEmployeeCardKeys(
      key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь' }),
      key({ full_name: 'Иванов Иван Иванович', role: 'Токарь' }),
    );
    expect(r.relation).toBe('disputed');
    expect(r.conflicts).toContain('role');
  });

  it('незаполненное поле не считается расхождением', () => {
    const r = compareEmployeeCardKeys(
      key({ full_name: 'Иванов Иван Иванович', personnel_number: '818' }),
      key({ full_name: 'Иванов Иван Иванович' }),
    );
    expect(r.relation).toBe('disputed');
    expect(r.conflicts).toEqual([]);
  });

  it('без ФИО сравнивать нечего', () => {
    const r = compareEmployeeCardKeys(key({ personnel_number: '818' }), key({ personnel_number: '819' }));
    expect(r.relation).toBe('different');
  });
});

describe('новая связь против старой', () => {
  it('запись, которая ничего не ухудшила, не блокируется', () => {
    expect(isNewRelation('disputed', 'disputed')).toBe(false);
    expect(isNewRelation('different', 'different')).toBe(false);
  });

  it('запись, занявшая чужой табельный номер, — новая связь', () => {
    expect(isNewRelation('disputed', 'personnel')).toBe(true);
    expect(isNewRelation('different', 'exact')).toBe(true);
  });

  it('бывший дубль, разошедшийся после правки, — не новая связь', () => {
    expect(isNewRelation('personnel', 'disputed')).toBe(false);
    expect(isNewRelation('exact', 'different')).toBe(false);
  });

  it('дописывание ПОСЛЕДНЕГО поля ключа — новая связь (уровень этого не видит)', () => {
    // Главный случай: приходит ПДО с датами приёма и ДР, ключ дописывается на глазах
    // у оператора. Уровень связи до и после один и тот же — ловит только множество
    // совпавших полей.
    const other = key({
      full_name: 'Иванов Иван Иванович',
      role: 'Слесарь',
      hire_date: Date.UTC(2020, 4, 17),
      birth_date: Date.UTC(1980, 0, 15),
    });
    const before = compareEmployeeCardKeys(
      key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь', hire_date: Date.UTC(2020, 4, 17) }),
      other,
    );
    const after = compareEmployeeCardKeys(
      key({
        full_name: 'Иванов Иван Иванович',
        role: 'Слесарь',
        hire_date: Date.UTC(2020, 4, 17),
        birth_date: Date.UTC(1980, 0, 15),
      }),
      other,
    );
    // Уровень связи не изменился — а связь стала крепче.
    expect(before.relation).toBe(after.relation);
    expect(isNewRelation(before.relation, after.relation)).toBe(false);
    expect(isNewEmployeeCardRelation(before, after)).toBe(true);
  });

  it('повторное сохранение той же карточки — не новая связь', () => {
    const other = key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь' });
    const card = key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь' });
    const before = compareEmployeeCardKeys(card, other);
    const after = compareEmployeeCardKeys(card, other);
    expect(isNewEmployeeCardRelation(before, after)).toBe(false);
  });

  it('разные ФИО — связи нет даже при совпавшей должности', () => {
    const other = key({ full_name: 'Петров Пётр Петрович', role: 'Слесарь' });
    const before = compareEmployeeCardKeys(key({ full_name: 'Иванов Иван Иванович' }), other);
    const after = compareEmployeeCardKeys(key({ full_name: 'Иванов Иван Иванович', role: 'Слесарь' }), other);
    expect(after.relation).toBe('different');
    expect(isNewEmployeeCardRelation(before, after)).toBe(false);
  });
});
