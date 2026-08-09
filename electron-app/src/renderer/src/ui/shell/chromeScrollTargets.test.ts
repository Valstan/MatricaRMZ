import { describe, expect, it } from 'vitest';

import { isDataScrollTarget } from './chromeScrollTargets.js';

describe('isDataScrollTarget', () => {
  // Панель списочной вкладки — единственный узел с overflow:auto у списков. Пока её
  // тут не было, «данными» считалось только тело карточки: оператор листал список, а
  // хром не уезжал — то есть режим не работал на самом частом экране цеха.
  it('прокрутка списка раздела — это данные', () => {
    expect(isDataScrollTarget([['v3-tab-content', 'ui-content-viewport', 'v3-tab-pane'], ['v3-tab-body']])).toBe(true);
  });

  it('прокрутка тела карточки — это данные', () => {
    expect(isDataScrollTarget([['ui-form'], ['v3-card-body'], ['v3-shell']])).toBe(true);
  });

  it('прокрутка вкладки МЕНЮ хром не прячет', () => {
    expect(isDataScrollTarget([['v3-tab-content-menu', 'v3-tab-pane'], ['v3-tab-body']])).toBe(false);
    expect(isDataScrollTarget([['v2-button-panel'], ['v3-tab-content-menu'], ['v3-tab-body']])).toBe(false);
  });

  // Вложенный хром побеждает предка-данные: цепочка идёт наружу, и первое совпадение
  // решает. Раньше это же проверялось на `mx-drawer` — класс уехал вместе с выдвижной
  // панелью, инвариант остался.
  it('док действий внутри карточки остаётся хромом, хотя его предок — контейнер данных', () => {
    expect(isDataScrollTarget([['card-action-bar'], ['v3-card-body']])).toBe(false);
  });

  it('неизвестный контейнер трактуется консервативно — хром остаётся', () => {
    expect(isDataScrollTarget([['some-widget'], ['ui-shell']])).toBe(false);
    expect(isDataScrollTarget([])).toBe(false);
  });

  // Токены сравниваются целиком, поэтому вкладка МЕНЮ не проходит по `v3-tab-content`.
  // Если сравнение когда-нибудь станет префиксным, этот тест покраснеет первым.
  it('v3-tab-content-menu не считается v3-tab-content', () => {
    expect(isDataScrollTarget([['v3-tab-content-menu']])).toBe(false);
  });
});
