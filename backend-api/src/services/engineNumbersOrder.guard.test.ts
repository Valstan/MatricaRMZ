import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Порядок выдачи номеров — решение владельца, а не деталь реализации: 28.10 он поменял
 * его местами («сначала те, у кого нет даты прихода»), и цена ошибки здесь — 2575 уже
 * выданных номеров, которые задним числом не пересчитать: номер принадлежит созданию
 * карточки и второй раз не выдаётся.
 *
 * Сторож читает источник, потому что фикстура сверки подменяет построитель запроса —
 * порядок в ней не применяется вовсе, и сломанный `orderBy` пройдёт любой тест на счётчики.
 */
const SRC = readFileSync(fileURLToPath(new URL('./engineNumbersService.ts', import.meta.url)), 'utf8');

describe('порядок выдачи номеров карточек', () => {
  it('карточки без даты прихода идут первыми, дальше — по дате прихода', () => {
    const fn = SRC.slice(
      SRC.indexOf('async function issueMissingNumbers'),
      SRC.indexOf('async function markDeletedNumbers'),
    );
    expect(fn, 'пустая дата прихода обязана стоять ПЕРВОЙ в очереди').toContain('arrivalDate} asc nulls first');
    expect(fn, 'прежний порядок «пустая дата в конец» отменён владельцем 28.10').not.toContain('nulls last');
    expect(fn, 'порядок обязан быть воспроизводимым: дата создания — первый разрыв ties').toContain(
      'asc(entities.createdAt)',
    );
    expect(fn).toContain('asc(entities.id)');
  });
});
