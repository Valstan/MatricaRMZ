import { describe, expect, it } from 'vitest';

import { nextMembership } from './grantProductionProgramSection.js';

/**
 * Раздел ПП добавляется в membership, не затирая остальные разделы. Проверка чистая:
 * аккаунты без membership (fail-open) скрипт не трогает — это решение живёт в main(),
 * здесь только слияние ключей.
 */
describe('nextMembership — раздел ПП в membership', () => {
  it('добавляет ключ, не трогая остальные разделы', () => {
    const { membership, changed } = nextMembership('{"production":"viewer","supply":"editor"}', 'viewer');
    expect(changed).toBe(true);
    expect(membership).toEqual({ production: 'viewer', supply: 'editor', production_program: 'viewer' });
  });

  it('повышает уровень, когда редактор сменился', () => {
    const { membership, changed } = nextMembership('{"production_program":"viewer"}', 'editor');
    expect(changed).toBe(true);
    expect(membership.production_program).toBe('editor');
  });

  it('не меняет membership, если уровень тот же', () => {
    const { membership, changed } = nextMembership('{"production_program":"viewer"}', 'viewer');
    expect(changed).toBe(false);
    expect(membership.production_program).toBe('viewer');
  });

  it('битый membership трактуется как пустой — раздел всё равно заводится', () => {
    const { membership, changed } = nextMembership('не json', 'viewer');
    expect(changed).toBe(true);
    expect(membership).toEqual({ production_program: 'viewer' });
  });

  it('двойное JSON-энкодирование (как на проде) разбирается', () => {
    const inner = JSON.stringify({ production: 'viewer' });
    const { membership, changed } = nextMembership(JSON.stringify(inner), 'viewer');
    expect(changed).toBe(true);
    expect(membership).toEqual({ production: 'viewer', production_program: 'viewer' });
  });
});
