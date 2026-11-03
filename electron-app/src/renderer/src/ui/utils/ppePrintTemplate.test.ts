/**
 * Шаблоны печатных форм СИЗ: разбор, применение к секциям, сборка.
 *
 * Смысл шаблона — кладовщик настраивает форму один раз (в БД), и она печатается
 * так на любой машине. Поэтому разбор должен быть терпимым к мусору, а применение —
 * не терять блоки, которых в шаблоне нет.
 */
import { describe, expect, it } from 'vitest';

import {
  applyPrintTemplate,
  buildPrintTemplateLayout,
  parsePrintTemplateLayout,
  PPE_PRINT_FORM_KEY,
} from './ppePrintTemplate.js';
import type { PrintSection } from './printPreview.js';

const SECTIONS: PrintSection[] = [
  { id: 'title', title: 'Заголовок', html: '<div>title</div>' },
  { id: 'requisites', title: 'Реквизиты', html: '<div>req</div>' },
  { id: 'norms', title: 'Нормы', html: '<div>norms</div>' },
  { id: 'history', title: 'История выдач', html: '<div>hist</div>', checked: false },
];

describe('ppe: шаблоны печатных форм', () => {
  it('ключ формы — общий на модуль', () => {
    expect(PPE_PRINT_FORM_KEY).toBe('ppe_card');
  });

  it('пустой шаблон — пустая раскладка, а не падение', () => {
    expect(parsePrintTemplateLayout(null)).toEqual({});
    expect(parsePrintTemplateLayout('')).toEqual({});
    expect(parsePrintTemplateLayout('не json')).toEqual({});
    expect(parsePrintTemplateLayout('[]')).toEqual({});
  });

  it('разбор читает блоки и подписи', () => {
    const layout = parsePrintTemplateLayout(
      JSON.stringify({
        sections: [{ id: 'history', enabled: false }],
        headerNote: 'Приказ № 767н',
        footerNote: 'Кладовщик Иванов',
      }),
    );
    expect(layout.sections).toEqual([{ id: 'history', enabled: false }]);
    expect(layout.headerNote).toBe('Приказ № 767н');
    expect(layout.footerNote).toBe('Кладовщик Иванов');
  });

  it('выключенный блок снимается, остальные идут в своём порядке', () => {
    const out = applyPrintTemplate(SECTIONS, { sections: [{ id: 'history', enabled: false }] });
    expect(out.map((s) => s.id)).toEqual(['title', 'requisites', 'norms']);
  });

  it('блок, которого нет в шаблоне, не теряется', () => {
    const out = applyPrintTemplate(SECTIONS, { sections: [{ id: 'unknown', enabled: false }] });
    expect(out.map((s) => s.id)).toEqual(['title', 'requisites', 'norms', 'history']);
  });

  it('пустой шаблон ничего не отключает', () => {
    expect(applyPrintTemplate(SECTIONS, {})).toHaveLength(4);
  });

  it('сборка из формы запоминает включённость блоков', () => {
    const layout = buildPrintTemplateLayout({ sections: SECTIONS });
    expect(layout.sections).toEqual([
      { id: 'title', enabled: true, title: 'Заголовок' },
      { id: 'requisites', enabled: true, title: 'Реквизиты' },
      { id: 'norms', enabled: true, title: 'Нормы' },
      { id: 'history', enabled: false, title: 'История выдач' },
    ]);
  });

  it('подписи шаблона сохраняются, пустые не пишутся', () => {
    const layout = buildPrintTemplateLayout({ sections: SECTIONS, headerNote: 'Приказ', footerNote: '' });
    expect(layout.headerNote).toBe('Приказ');
    expect(layout.footerNote).toBeUndefined();
  });

  it('шаблон проходит круг: собрали → разобрали → применили', () => {
    const layout = buildPrintTemplateLayout({ sections: SECTIONS, headerNote: 'Приказ № 767н' });
    const parsed = parsePrintTemplateLayout(JSON.stringify(layout));
    const out = applyPrintTemplate(SECTIONS, parsed);
    expect(out.map((s) => s.id)).toEqual(['title', 'requisites', 'norms']);
    expect(parsed.headerNote).toBe('Приказ № 767н');
  });
});
