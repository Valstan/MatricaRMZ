import { describe, expect, it } from 'vitest';

import {
  BOM_COMPACT_ROWS_PER_COLUMN,
  buildAllBomsPrintHtml,
  buildBomCompactRows,
  buildBomCompactSections,
  buildBomComparisonRows,
  buildBomComparisonSections,
  buildBomFullSections,
  type BomPrintDoc,
  type BomPrintLine,
} from './bomPrint.js';

function line(partial: Partial<BomPrintLine> = {}): BomPrintLine {
  return {
    componentNomenclatureId: 'n1',
    componentNomenclatureName: 'Гильза',
    componentNomenclatureCode: '303-07',
    componentType: 'sleeve',
    qtyPerUnit: 12,
    variantGroup: null,
    isRequired: true,
    priority: 100,
    ...partial,
  };
}

function doc(lines: BomPrintLine[], name = 'BOM В-84'): BomPrintDoc {
  return { header: { id: 'b1', name, engineBrandIds: ['brand-1'], version: 3 }, lines };
}

const labels = {
  brandsLabel: (ids: string[]) => ids.map((id) => `Марка ${id}`).join(', '),
  typeLabels: new Map([
    ['sleeve', 'Гильза'],
    ['piston', 'Поршень'],
    ['other', 'Прочее'],
  ]),
  typeOrder: new Map([
    ['sleeve', 20],
    ['piston', 30],
    ['other', 900],
  ]),
};

describe('buildBomCompactRows', () => {
  it('берёт только базовый комплект и основные варианты, разделы — по порядку схемы', () => {
    const rows = buildBomCompactRows(
      [
        line({ componentType: 'other', componentNomenclatureId: 'o', componentNomenclatureName: 'Прокладка' }),
        line({ componentType: 'sleeve' }),
        line({ componentType: 'sleeve', componentNomenclatureId: 'n2', positionKey: 'p', isDefaultOption: false }),
        line({ componentType: 'piston', variantGroup: '__kit_a', componentNomenclatureId: 'k' }),
      ],
      labels,
    );
    expect(rows.map((r) => (r.kind === 'type' ? `#${r.label}` : r.line.componentNomenclatureId))).toEqual(['#Гильза — 1', 'n1', '#Прочее — 1', 'o']);
  });
});

describe('buildBomCompactSections', () => {
  it('одна таблица, когда строк мало; в шапке — марки, версия, число позиций', () => {
    const [main] = buildBomCompactSections(doc([line()]), labels);
    expect(main!.html).not.toContain('bom-compact-columns');
    expect(main!.html).toContain('Марки: Марка brand-1 · версия 3 · позиций: 1');
    expect(main!.html).toContain('<th>Артикул</th><th>Деталь</th>');
    expect(main!.html).toContain('303-07');
  });

  it('две колонки при переполнении; заголовок типа не остаётся последним в левой колонке', () => {
    const many: BomPrintLine[] = [];
    for (let i = 0; i < BOM_COMPACT_ROWS_PER_COLUMN; i++) {
      many.push(line({ componentType: 'sleeve', componentNomenclatureId: `s${i}`, componentNomenclatureName: `Гильза ${String(i).padStart(3, '0')}` }));
    }
    // Ровно на разрезе — начало нового раздела: заголовок «Прочее» должен уехать вправо.
    many.push(line({ componentType: 'other', componentNomenclatureId: 'o1', componentNomenclatureName: 'Прокладка' }));
    const [main] = buildBomCompactSections(doc(many), labels);
    expect(main!.html).toContain('bom-compact-columns');
    const [left, right] = main!.html.split('</table>');
    expect(left).not.toMatch(/Прочее — 1<\/td><\/tr><\/tbody>$/);
    expect(right).toContain('Прочее — 1');
  });

  it('запасные варианты не печатаются, но их число названо; киты — отдельной секцией «только отличия»', () => {
    const sections = buildBomCompactSections(
      doc([line({ positionKey: 'p' }), line({ positionKey: 'p', componentNomenclatureId: 'n2', isDefaultOption: false }), line({ variantGroup: '__kit_x', componentNomenclatureId: 'k', componentNomenclatureName: 'Поршень К' })]),
      labels,
    );
    expect(sections).toHaveLength(2);
    expect(sections[0]!.html).toContain('запасных вариантов не печатается: 1');
    expect(sections[0]!.html).not.toContain('n2');
    expect(sections[1]!.title).toBe('Вариант 1 — только отличия от базового комплекта');
    expect(sections[1]!.html).toContain('Поршень К');
  });

  it('норма печатается с запятой и знаком процента, пустая — пусто', () => {
    const [main] = buildBomCompactSections(doc([line({ normPercent: 12.5 }), line({ componentNomenclatureId: 'n2', normPercent: null })]), labels);
    expect(main!.html).toContain('12,5 %');
  });
});

describe('buildBomComparisonRows / Sections', () => {
  it('строки — объединение деталей, колонка на BOM, пусто = «—»', () => {
    const a = doc([line(), line({ componentNomenclatureId: 'p', componentType: 'piston', componentNomenclatureName: 'Поршень', qtyPerUnit: 6 })], 'A');
    const b = doc([line({ qtyPerUnit: 8 })], 'B');
    const rows = buildBomComparisonRows([a, b], labels);
    expect(rows).toEqual([
      { kind: 'type', label: 'Гильза' },
      { kind: 'line', nomenclatureId: 'n1', code: '303-07', name: 'Гильза', qty: [12, 8] },
      { kind: 'type', label: 'Поршень' },
      { kind: 'line', nomenclatureId: 'p', code: '303-07', name: 'Поршень', qty: [6, null] },
    ]);
    const [section] = buildBomComparisonSections([a, b], labels);
    expect(section!.title).toBe('Сверка спецификаций: 2 · деталей: 2');
    expect(section!.html).toContain('<td class="bom-empty">—</td>');
  });

  it('запасные варианты и киты в сверку не попадают', () => {
    const rows = buildBomComparisonRows([doc([line({ isDefaultOption: false }), line({ variantGroup: '__kit_1' })])], labels);
    expect(rows).toEqual([]);
  });
});

describe('buildBomFullSections', () => {
  it('база + варианты, запасной помечен, норма и примечание в колонках', () => {
    const sections = buildBomFullSections([line({ normPercent: 40, notes: 'см. чертёж' }), line({ componentNomenclatureId: 'n2', isDefaultOption: false, positionKey: 'p' }), line({ variantGroup: '__kit_1', componentNomenclatureId: 'k' })], labels.typeLabels);
    expect(sections.map((s) => s.title)).toEqual(['База (общие строки)', 'Вариант 1']);
    expect(sections[0]!.html).toContain('(запасной)');
    expect(sections[0]!.html).toContain('40 %');
    expect(sections[0]!.html).toContain('см. чертёж');
  });
  it('пустая BOM — заглушка', () => {
    expect(buildBomFullSections([], labels.typeLabels)[0]!.html).toContain('Нет строк BOM');
  });
});

describe('buildAllBomsPrintHtml', () => {
  it('секция на BOM и легенда компонентов', () => {
    const { sections, legendHtml } = buildAllBomsPrintHtml([doc([line()]), doc([line({ componentNomenclatureId: 'n9', componentNomenclatureName: 'Кольцо', componentType: 'other' })], 'BOM В-59')], labels);
    expect(sections.map((s) => s.title)).toEqual(['BOM В-84', 'BOM В-59']);
    expect(legendHtml).toContain('Кольцо');
    expect(legendHtml).toContain('Прочее');
  });
});
