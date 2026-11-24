import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож писателя доступа по разделам.
 *
 * План записи (`sectionAccessPlan`) говорит «оживить тумбстоун», а БЫЛА ошибка
 * в SQL: UPDATE оживления нёс фильтр `deleted_at IS NULL` — тот самый фильтр,
 * который отсекает тумбстоун. Выдача отвечала `ok`, а раздел оставался снятым
 * (замер на стенде lane1, 25.11.2026).
 *
 * Юнит-тест плана такую ошибку не видит: он проверяет РЕШЕНИЕ, а не условие
 * WHERE. Поэтому условие сторожит отдельный сторож по исходнику — так же, как
 * сторожит пресеты меню и разметку планшета.
 */
const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

const AUTH_SERVICE = src('./employeeAuthService.ts');

/** Текст ветки `revive` — от её проверки до конца блока. */
function reviveBranch(source: string): string {
  const start = source.indexOf("step.kind === 'revive'");
  if (start < 0) return '';
  const end = source.indexOf('continue;', start);
  return source.slice(start, end < 0 ? start + 600 : end);
}

describe('писатель доступа по разделам: тумбстоун оживает по-настоящему', () => {
  it('ветка revive есть и ждёт именно оживления', () => {
    expect(reviveBranch(AUTH_SERVICE), 'писатель не знает про revive').not.toBe('');
  });

  it('оживление НЕ отсекается фильтром deleted_at IS NULL', () => {
    const branch = reviveBranch(AUTH_SERVICE);
    expect(branch, 'оживление отсекается фильтром deleted_at IS NULL — тумбстоун не оживёт').not.toContain(
      'isNull(userSectionAccess.deletedAt)',
    );
  });

  it('оживление снимает тумбстоун (deleted_at = NULL)', () => {
    expect(reviveBranch(AUTH_SERVICE), 'оживление не снимает deleted_at').toContain('deletedAt: null');
  });

  it('оживление идёт по id строки, а не по живому подмножеству', () => {
    expect(reviveBranch(AUTH_SERVICE), 'оживление идёт не по id строки').toContain(
      'eq(userSectionAccess.id, step.rowId',
    );
  });
});
