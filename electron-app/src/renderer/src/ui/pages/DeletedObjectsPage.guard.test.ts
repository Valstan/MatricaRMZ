import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Сторож страницы «Удалённое за 3 дня» (промт КАРМАНА #169).
 *
 * ЧТО СТОРОЖИМ. Три кнопки у каждой записи («Посмотреть» — без восстановления,
 * «Восстановить», «Удалить окончательно»), путь возврата ДО восстановления и автор
 * удаления в строке. И отдельно — что страница не трогает черновики карточек и корзину
 * ярлыков на верстаке: это разные вещи, новая вкладка их не заменяет.
 */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./DeletedObjectsPage.tsx');

describe('«Удалённое за 3 дня»: три кнопки и путь возврата', () => {
  it('у каждой записи три кнопки', () => {
    expect(PAGE, 'нет кнопки «Посмотреть»').toContain('Посмотреть');
    expect(PAGE, 'нет кнопки «Восстановить»').toContain('Восстановить');
    expect(PAGE, 'нет кнопки «Удалить окончательно»').toContain('Удалить окончательно');
  });

  it('восстановление спрашивает подтверждение и называет путь возврата', () => {
    const fn = PAGE.slice(PAGE.indexOf('const handleRestore'), PAGE.indexOf('const handlePurge'));
    expect(fn, 'подтверждения восстановления нет').toContain('window.confirm(');
    expect(fn, 'путь возврата в подтверждении не назван').toContain('row.restorePath');
    expect(fn, 'про битые связи не сказано').toContain('связи могут остаться битыми');
  });

  it('окончательное удаление спрашивает подтверждение и говорит про необратимость', () => {
    const fn = PAGE.slice(PAGE.indexOf('const handlePurge'), PAGE.indexOf('return ('));
    expect(fn, 'подтверждения удаления нет').toContain('window.confirm(');
    expect(fn, 'про необратимость не сказано').toContain('необратимо');
  });

  it('в строке видно, кто удалил, и куда объект вернётся', () => {
    expect(PAGE, 'автора удаления в строке нет').toContain('row.deletedBy');
    expect(PAGE, 'пути возврата в строке нет').toContain('row.restorePath');
  });

  it('правило «храним три дня» видно оператору', () => {
    expect(PAGE, 'правило хранения не показано').toContain('DELETED_RETENTION_TEXT');
  });
});

describe('новая вкладка не заменяет черновики и корзину ярлыков', () => {
  it('страница не лезет в черновики карточек и корзину верстака', () => {
    expect(PAGE, 'страница трогает черновики карточек').not.toMatch(/cardDraft|drafts?Service|saveDraft/);
    expect(PAGE, 'страница трогает корзину ярлыков').not.toMatch(/desktopTile|desktopUsage|cornerTiler|значк/i);
  });
});
