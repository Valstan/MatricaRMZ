import { describe, expect, it } from 'vitest';

import { htmlToPlainText, listToText, printSectionsToText } from './mailText.js';

describe('текст письма из формы печати', () => {
  it('строки таблицы разбираются по ячейкам, теги не протекают в письмо', () => {
    const html = '<table><tr><th>Деталь</th><th>Кол-во</th></tr><tr><td>Поршень</td><td>6</td></tr></table>';
    expect(htmlToPlainText(html)).toBe('Деталь | Кол-во\nПоршень | 6');
  });

  it('абзацы и переносы строк сохраняются, пустые строки не размножаются', () => {
    const html = '<div>Акт</div><div><br></div><div><br></div><div>Подпись</div>';
    expect(htmlToPlainText(html)).toBe('Акт\n\nПодпись');
  });

  it('мнемоники раскрываются: письмо не показывает &laquo;сырой&raquo; html-мусор', () => {
    expect(htmlToPlainText('<div>Иванов &amp; Петров&nbsp;&mdash; норма</div>')).toBe('Иванов & Петров — норма');
  });

  it('секции склеиваются с заголовками, кроме тех, где заголовок уже внутри', () => {
    const text = printSectionsToText([
      { title: 'Шапка', html: '<div>Наряд № 12</div>', hideTitle: true },
      { title: 'Позиции', html: '<div>Поршень</div>' },
      { title: 'Подписи', html: '<div> </div>' },
    ]);
    expect(text).toBe('Наряд № 12\n\nПозиции\nПоршень');
  });

  it('список в письме обрезается и честно говорит, где остальное', () => {
    const fields = [
      { id: 'name', label: 'Сотрудник', printValue: (r: { name: string }) => r.name },
      { id: 'size', label: 'Размер', printValue: (r: { name: string }) => String(r.name.length) },
    ];
    const rows = [{ name: 'Иванов' }, { name: 'Петров' }];
    expect(listToText(fields, rows)).toBe('Иванов | 6\nПетров | 6');
    expect(listToText(fields, [...rows, ...rows], 3)).toContain('… и ещё 1 строк — полностью в приложенном файле');
  });
});
