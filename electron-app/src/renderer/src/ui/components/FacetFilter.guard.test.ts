import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Владелец 25.10.2026: «когда открыто много фильтров — каша, путаемся, где что лежит». Два
// свойства снимают эту кашу, и оба рвутся молча: панель фильтров работает, просто снова
// бесцветная и снова в исходном порядке.
//
// Перевод строки нормализуется: на копии с CRLF многострочные ожидания не совпали бы ни при
// какой вёрстке, и сторож краснел бы от настройки Git, а не от кода.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const FILTER = src('./FacetFilter.tsx');
const ENGINE_FILTER = src('./EngineFacetFilter.tsx');

const HOSTS: ReadonlyArray<{ name: string; source: string; usageKey: string }> = [
  { name: 'EnginesPage', source: src('../pages/EnginesPage.tsx'), usageKey: 'list:engines' },
  { name: 'ContractsPage', source: src('../pages/ContractsPage.tsx'), usageKey: 'list:contracts' },
  { name: 'EmployeesPage', source: src('../pages/EmployeesPage.tsx'), usageKey: 'list:employees' },
  { name: 'PpeCardsPage', source: src('../pages/PpeCardsPage.tsx'), usageKey: 'list:ppe-cards' },
  { name: 'WorkSheetsPage', source: src('../pages/WorkSheetsPage.tsx'), usageKey: 'list:workSheets:ui' },
  {
    name: 'EnginesReportPage',
    source: src('../pages/reports/EnginesReportPage.tsx'),
    usageKey: 'report:engines:ui',
  },
  {
    name: 'EnginesNowAtPlantReportPage',
    source: src('../pages/reports/EnginesNowAtPlantReportPage.tsx'),
    usageKey: 'report:enginesNowAtPlant:ui',
  },
  {
    name: 'WorkSheetsReportPage',
    source: src('../pages/reports/WorkSheetsReportPage.tsx'),
    usageKey: 'report:workSheets:ui',
  },
];

describe('фильтры списков — цвет ступени', () => {
  it('оттенок каждой ступени приходит из палитры, а не из цвета «открыто/закрыто»', () => {
    expect(FILTER).toContain('facetTones(');
    expect(FILTER).toContain('tone.accent');
    expect(FILTER).toContain('tone.tint');
  });

  it('панель значений лежит на подложке своего цвета', () => {
    const panels = FILTER.match(/data-facet-panel=\{[^}]+\} style=\{panelStyle\}/g) ?? [];
    expect(panels).toHaveLength(2); // ступень значений и ступень-диапазон дат
    expect(FILTER).toContain('background: tone.panel');
    expect(FILTER).toContain('borderLeft: `3px solid ${tone.accent}`');
  });
});

describe('фильтры списков — рейтинг ступеней', () => {
  it('щелчок по ступени копит счёт и переживает перезапуск', () => {
    expect(FILTER).toContain('facetUsageBump(');
    expect(FILTER).toContain('localStorage');
  });

  it('ряд кнопок строится по рейтингу в момент открытия панели, а не под курсором', () => {
    expect(FILTER).toContain('orderFacetIdsByUsage(');
    // Порядок фиксируется эффектом на открытии: сдвинь кнопки в момент щелчка — оператор
    // щёлкнет не ту ступень.
    expect(FILTER).toMatch(/if \(!props\.open\) return;\n\s*setRankedIds\(orderFacetIdsByUsage\(/);
  });

  it('частые ступени идут левее редких: ряд и панели сортируются одним порядком', () => {
    expect(FILTER).toContain('orderedFacets.map(');
    expect(FILTER).toContain('orderedFields.map(');
  });

  it('у каждого списка свой ключ рейтинга', () => {
    for (const host of HOSTS) {
      expect(host.source, `${host.name}: usageKey не передан — ряд кнопок не будет сортироваться`).toContain(
        `usageKey="${host.usageKey}"`,
      );
    }
  });

  it('двигатели идут через обёртку — она обязана прокинуть ключ дальше', () => {
    expect(ENGINE_FILTER).toContain('usageKey?: string;');
    expect(ENGINE_FILTER).toContain('usageKey: props.usageKey');
  });
});
