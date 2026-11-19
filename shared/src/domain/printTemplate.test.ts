import { describe, expect, it } from 'vitest';

import {
  applyPrintTemplate,
  buildPrintTemplateLayout,
  parsePrintTemplateLayout,
  resolvePrintTemplate,
  type PrintSection,
  type PrintTemplateRow,
} from './printTemplate.js';

function section(id: string, title = id): PrintSection {
  return { id, title, html: `<div>${id}</div>` };
}

describe('parsePrintTemplateLayout', () => {
  it('битый JSON — пустой шаблон, а не падение', () => {
    expect(parsePrintTemplateLayout('{не json')).toEqual({});
    expect(parsePrintTemplateLayout(null)).toEqual({});
    expect(parsePrintTemplateLayout('')).toEqual({});
  });

  it('не-объект отбрасывается', () => {
    expect(parsePrintTemplateLayout('"строка"')).toEqual({});
    expect(parsePrintTemplateLayout('42')).toEqual({});
  });

  it('секции, колонки и примечания переносятся', () => {
    const layout = parsePrintTemplateLayout(
      JSON.stringify({
        sections: [{ id: 'norms', enabled: false, title: 'Нормы' }],
        columns: [{ id: 'article', enabled: true, order: 2, width: 30 }],
        headerNote: 'Примечание к шапке',
        footerNote: 'Подпись в подвале',
      }),
    );
    expect(layout.sections?.[0]).toEqual({ id: 'norms', enabled: false, title: 'Нормы' });
    expect(layout.columns?.[0]?.order).toBe(2);
    expect(layout.headerNote).toBe('Примечание к шапке');
    expect(layout.footerNote).toBe('Подпись в подвале');
  });

  it('картинка без data-URI и с неизвестным размещением — не берётся', () => {
    const layout = parsePrintTemplateLayout(
      JSON.stringify({
        images: [
          { id: 'ok', dataUri: 'data:image/png;base64,AAA', placement: 'top' },
          { id: 'нет картинки', placement: 'top' },
          { id: 'неизвестное размещение', dataUri: 'data:image/png;base64,AAA', placement: 'center' },
        ],
      }),
    );
    expect(layout.images?.map((i) => i.id)).toEqual(['ok']);
  });

  it('поле с неизвестным источником — не берётся', () => {
    const layout = parsePrintTemplateLayout(
      JSON.stringify({
        fields: [
          { id: 'a', label: 'Директор', source: 'signature_role', role: 'директор' },
          { id: 'b', label: '???', source: 'from_nowhere' },
        ],
      }),
    );
    expect(layout.fields?.map((f) => f.id)).toEqual(['a']);
  });
});

describe('applyPrintTemplate', () => {
  it('выключенный блок снимается, порядок остаётся формы', () => {
    const sections = [section('title'), section('norms'), section('sign')];
    const result = applyPrintTemplate(sections, { sections: [{ id: 'norms', enabled: false }] });
    expect(result.map((s) => s.id)).toEqual(['title', 'sign']);
  });

  it('неизвестный id игнорируется', () => {
    const sections = [section('title'), section('norms')];
    const result = applyPrintTemplate(sections, { sections: [{ id: 'нет такого', enabled: false }] });
    expect(result.map((s) => s.id)).toEqual(['title', 'norms']);
  });

  it('включённый блок остаётся на месте', () => {
    const sections = [section('title'), section('norms')];
    const result = applyPrintTemplate(sections, { sections: [{ id: 'norms', enabled: true }] });
    expect(result.map((s) => s.id)).toEqual(['title', 'norms']);
  });

  it('пустой шаблон ничего не меняет', () => {
    const sections = [section('title')];
    expect(applyPrintTemplate(sections, {})).toBe(sections);
  });
});

describe('buildPrintTemplateLayout', () => {
  it('снятый чекбоксом блок попадает в шаблон выключенным', () => {
    const layout = buildPrintTemplateLayout({
      sections: [section('title'), { ...section('history'), checked: false }],
    });
    expect(layout.sections).toEqual([
      { id: 'title', enabled: true, title: 'title' },
      { id: 'history', enabled: false, title: 'history' },
    ]);
  });

  it('картинки и поля сохраняются, пустые не попадают', () => {
    const layout = buildPrintTemplateLayout({
      sections: [section('title')],
      images: [{ id: 'logo', dataUri: 'data:image/png;base64,AAA', placement: 'top' }],
      fields: [{ id: 'f1', label: 'Директор', source: 'signature_role' }],
    });
    expect(layout.images).toHaveLength(1);
    expect(layout.fields).toHaveLength(1);

    const empty = buildPrintTemplateLayout({ sections: [section('title')] });
    expect(empty.images).toBeUndefined();
    expect(empty.fields).toBeUndefined();
  });
});

describe('resolvePrintTemplate', () => {
  const row = (over: Partial<PrintTemplateRow>): PrintTemplateRow => ({
    id: 'id',
    ownerId: 'shared',
    entityKey: 'ppe_card',
    formKey: 'ppe_card',
    name: 'Шаблон',
    layoutJson: '{}',
    isDefault: false,
    updatedAt: 0,
    updatedBy: null,
    createdAt: 0,
    ...over,
  });

  it('пустой список — null', () => {
    expect(resolvePrintTemplate([])).toBeNull();
    expect(resolvePrintTemplate(null)).toBeNull();
  });

  it('личный шаблон перекрывает общий, даже если общий помечен по умолчанию', () => {
    const shared = row({ id: 'shared', ownerId: 'shared', isDefault: true });
    const personal = row({ id: 'personal', ownerId: 'user-1' });
    expect(resolvePrintTemplate([shared, personal])?.id).toBe('personal');
  });

  it('внутри одного уровня побеждает помеченный по умолчанию', () => {
    const first = row({ id: 'first' });
    const def = row({ id: 'default', isDefault: true });
    expect(resolvePrintTemplate([first, def])?.id).toBe('default');
  });

  it('если по умолчанию нет — берётся первый', () => {
    const first = row({ id: 'first' });
    const second = row({ id: 'second' });
    expect(resolvePrintTemplate([first, second])?.id).toBe('first');
  });
});
