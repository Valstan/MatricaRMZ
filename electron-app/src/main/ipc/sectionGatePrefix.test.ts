import { describe, expect, it } from 'vitest';

import { matchPrefixRule } from './sectionGate.js';

// Префикс `audit:` целиком принадлежал «Администрированию» — и вместе с чтением журнала
// под гейт попала запись телеметрии интерфейса, которую шлёт каждый пользователь.
// У оператора вне раздела она отбивалась на каждом визите вкладки (с 3.1.0 по 10.09.2026).
describe('префиксы клиентского гейта разделов: журнал действий', () => {
  it('читать журнал может только администрирование', () => {
    expect(matchPrefixRule('audit:list')).toBe('administration');
  });

  it('писать телеметрию может любой пользователь', () => {
    expect(matchPrefixRule('audit:add')).toBeNull();
  });
});

// Табель (владелец 13.11.2026): «открой всем пользователям программы разрешение на
// создание табелей работы, но редактировать могут только свои табеля, чужие можно
// только смотреть». Значит гейта по разделу у табеля быть не должно — иначе он виден
// лишь тем, кому выдан раздел «Персонал». Правит свой табель автор (гейт на сервере).
describe('префиксы клиентского гейта разделов: табель', () => {
  it('каналы табеля не гейтятся разделом', () => {
    expect(matchPrefixRule('timesheets:list')).toBeNull();
    expect(matchPrefixRule('timesheets:create')).toBeNull();
    expect(matchPrefixRule('timesheets:update')).toBeNull();
    expect(matchPrefixRule('timesheets:setCells')).toBeNull();
  });

  it('кадры сотрудников остаются под разделом «Персонал»', () => {
    expect(matchPrefixRule('employees:setAttr')).toBe('people');
    expect(matchPrefixRule('employees:create')).toBe('people');
  });
});
