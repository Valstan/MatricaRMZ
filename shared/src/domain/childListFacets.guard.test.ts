import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Правила детского модуля разъезжаются молча: свой движок фильтров рядом с общим,
// свой флаг «серенький» рядом со статусом занятости. Обе вещи внешне работают,
// пока не разойдутся: список отфильтрует одно, напоминалка — другое.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const FACETS = src('./childListFacets.ts');
const CHILDREN = src('./children.ts');
const EMPLOYEES = src('./employees.ts');

describe('фасеты детей — общий движок, не своя копия', () => {
  it('ступени собраны на общем движке listFacets', () => {
    expect(FACETS).toContain("from './listFacets.js'");
    expect(FACETS).toContain('applyFacets(');
    expect(FACETS).toContain('facetOptions(');
    expect(FACETS).toContain('sanitizeFacetSelection(');
  });

  it('собственной фильтрации строк в файле нет', () => {
    // Своя копия отсечения разошлась бы с общим движком (варианты ступеней, порядок кликов).
    // Чистка значений внутри строки (теги) — не то же самое, поэтому смотрим именно на строки.
    expect(FACETS).not.toMatch(/\brows\s*\.\s*filter\(/);
    expect(FACETS).not.toMatch(/\.filter\(\s*\(row\b/);
  });

  it('тип ступени — общий FacetDescriptor, а не местный', () => {
    expect(FACETS).toContain('FacetDescriptor<ChildFacetRow>');
    expect(FACETS).toContain('FacetDateRange');
  });
});

describe('«серенький» — правило одно', () => {
  it('правило живёт в статусе занятости', () => {
    expect(EMPLOYEES).toContain('export function isSilverParentStatus');
    expect(EMPLOYEES).toContain("'decret'");
    expect(EMPLOYEES).toContain("'sick_leave'");
  });

  it('детский домен берёт правило, а не заводит своё', () => {
    expect(CHILDREN).toContain('isSilverParentStatus');
    // Своя проверка «уволен» рядом со статусом разъехалась бы с кадровым.
    expect(CHILDREN).not.toMatch(/===\s*'fired'/);
  });

  it('возраст нигде не хранится — только считается', () => {
    expect(CHILDREN).toContain('export function childAgeYears');
    expect(CHILDREN).not.toMatch(/ageYears\s*[:=]\s*\d/);
  });
});
