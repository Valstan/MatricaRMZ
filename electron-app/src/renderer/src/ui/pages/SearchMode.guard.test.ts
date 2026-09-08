import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Точный поиск по умолчанию (просьба владельца 08.09.2026) опасен ровно одним способом:
// список, где включён точный режим, но НЕ поставлена кнопка «≈ Похожие», молча теряет
// прежнее поведение — оператор больше не может найти по опечатке и не знает, чем это вернуть.
// Сторож держит пару «режим + кнопка» на каждом списке и то, что лукапы остались терпимыми.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGES = {
  'EnginesPage.tsx': src('./EnginesPage.tsx'),
  'ContractsPage.tsx': src('./ContractsPage.tsx'),
  'CounterpartiesPage.tsx': src('./CounterpartiesPage.tsx'),
  'EmployeesPage.tsx': src('./EmployeesPage.tsx'),
  'EngineBrandsPage.tsx': src('./EngineBrandsPage.tsx'),
  'ServicesByBrandPage.tsx': src('./ServicesByBrandPage.tsx'),
};

const HOOK = src('../hooks/useListDeepFilter.ts');
const TOGGLE = src('../components/SearchModeToggle.tsx');
const SEARCH = src('../utils/search.ts');

describe('точный поиск по умолчанию', () => {
  it('каждый список с точным режимом даёт кнопку «Похожие»', () => {
    for (const [name, code] of Object.entries(PAGES)) {
      expect(code, `${name}: режим есть, а вернуть похожие нечем`).toContain('<SearchModeToggle');
      expect(code, `${name}: кнопка есть, а режим не проброшен`).toContain('searchModeOf');
    }
  });

  it('умолчание — точный режим, и оно живёт в одном месте', () => {
    expect(HOOK).toContain("const mode: SearchMode = opts?.mode ?? 'exact';");
    expect(TOGGLE).toContain("return similar === true ? 'similar' : 'exact';");
  });

  it('лукапы и выпадающие списки остались терпимыми к опечаткам и раскладке', () => {
    // Дефолт домена — similar: правка не должна была тронуть SearchSelect и подсказки.
    expect(SEARCH).toContain("mode: SearchMode = 'similar'");
  });

  it('тумблер помечен для смоуков и говорит оператору, что именно он включает', () => {
    expect(TOGGLE).toContain('data-search-similar');
    expect(TOGGLE).toContain('опечатки, часть слова, другая раскладка');
  });

  it('пустая выдача в точном режиме подсказывает про кнопку, а не молчит', () => {
    expect(PAGES['EnginesPage.tsx']).toContain('Нажмите «≈ Похожие»');
  });
});
