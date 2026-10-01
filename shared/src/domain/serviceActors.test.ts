import { describe, expect, it } from 'vitest';

import { isServiceActor, serviceActorLabel } from './serviceActors.js';

describe('подпись автора записи по-русски', () => {
  it('служебный скрипт переноса этапов называется словами, а не логином', () => {
    // Именно этот логин владелец видел в колонке «Кто» и не понял, что это.
    expect(serviceActorLabel('stages:backfill')).toBe('перенос этапов из прежних отметок (программа)');
    expect(serviceActorLabel('stages:backfill')).not.toContain('backfill');
  });

  it('подпись всегда говорит, что это программа, а не человек', () => {
    // Читатель должен отличить запись человека от записи машины с одного взгляда.
    for (const login of [
      'stages:backfill',
      'stages:review-order',
      'engine-inventory:fix-defect-stage-dates',
      'engine-inventory:dedup-sheets',
      'engine-inventory:backfill-lines',
      'engine-inventory:strip-rows',
      'server',
      'system',
    ]) {
      expect(serviceActorLabel(login), login).toContain('программа');
    }
  });

  it('пусто и `local` не показываются: автор либо неизвестен, либо его нет', () => {
    expect(serviceActorLabel('')).toBe('');
    expect(serviceActorLabel(null)).toBe('');
    expect(serviceActorLabel('   ')).toBe('');
    // `local` — это клиент без входа в сеть, а не человек: показывать его нельзя.
    expect(serviceActorLabel('local')).toBe('');
  });

  it('настоящий логин остаётся логином — улику терять нельзя', () => {
    expect(serviceActorLabel('ivanov')).toBe('ivanov');
    expect(serviceActorLabel(' ivanov ')).toBe('ivanov');
    // Неизвестный служебный логин тоже остаётся: новый скрипт не должен становиться
    // пустой ячейкой, но и выдуманной подписью называться не должен.
    expect(serviceActorLabel('какой-то:новый-скрипт')).toBe('какой-то:новый-скрипт');
  });

  it('isServiceActor отличает служебный логин от человеческого', () => {
    expect(isServiceActor('stages:backfill')).toBe(true);
    expect(isServiceActor('local')).toBe(true);
    expect(isServiceActor('ivanov')).toBe(false);
    expect(isServiceActor('')).toBe(false);
    // Подпись не подставляется из прототипа: логин `constructor` не должен стать функцией.
    expect(serviceActorLabel('constructor')).toBe('constructor');
    expect(isServiceActor('toString')).toBe(false);
  });
});