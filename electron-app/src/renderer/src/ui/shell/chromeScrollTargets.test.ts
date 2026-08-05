import { describe, expect, it } from 'vitest';

import { isDataScrollTarget } from './chromeScrollTargets.js';

describe('isDataScrollTarget', () => {
  it('прокрутка списка раздела — это данные', () => {
    expect(isDataScrollTarget([['v3-split-list'], ['v3-shell']])).toBe(true);
  });

  it('прокрутка тела карточки — это данные', () => {
    expect(isDataScrollTarget([['ui-form'], ['v3-card-body'], ['v3-shell']])).toBe(true);
  });

  it('прокрутка панели разделов хром не прячет', () => {
    expect(isDataScrollTarget([['v2-button-panel'], ['v3-split-sections'], ['v3-shell']])).toBe(false);
  });

  it('выпадашка внутри карточки остаётся хромом, хотя её предок — контейнер данных', () => {
    expect(isDataScrollTarget([['mx-drawer'], ['v3-card-body']])).toBe(false);
  });

  it('док действий не прячет хром сам себя', () => {
    expect(isDataScrollTarget([['card-action-bar'], ['v3-card-body']])).toBe(false);
  });

  it('неизвестный контейнер трактуется консервативно — хром остаётся', () => {
    expect(isDataScrollTarget([['some-widget'], ['ui-shell']])).toBe(false);
    expect(isDataScrollTarget([])).toBe(false);
  });

  it('явная пометка mx-data-scroll включает контейнер в данные', () => {
    expect(isDataScrollTarget([['mx-data-scroll'], ['ui-shell']])).toBe(true);
  });
});
