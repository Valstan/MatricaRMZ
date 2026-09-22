import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Точный поиск по умолчанию (владелец 08.09.2026, распространён на все экраны 22.09.2026)
// опасен ровно одним способом: экран ищет точно, но кнопки «≈ Похожие» на нём нет —
// оператор больше не находит по опечатке и не знает, чем вернуть прежнее поведение.
// Сторож держит пару «режим + кнопка» и не даёт умолчанию уехать обратно в «похожее».
//
// Список экранов НЕ захардкожен: он собирается обходом дерева. Новый список, забывший
// кнопку, краснеет сам — иначе сторож устаревал бы ровно в тот момент, когда нужен.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const UI_ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

/** Экран считается «списочным поиском», если он фильтрует набор строк любым из общих матчеров. */
const SEARCH_SCREENS = walk(UI_ROOT)
  .map((path) => ({ path, code: readFileSync(path, 'utf8') }))
  .filter(({ path, code }) => {
    if (path.endsWith('SearchModeToggle.tsx')) return false;
    return /matchesQueryInRecord|filterPreparedRecords|useListDeepFilter/.test(code);
  })
  .map(({ path, code }) => ({ name: path.slice(UI_ROOT.length), code }));

const HOOK = src('../hooks/useListDeepFilter.ts');
const TOGGLE = src('../components/SearchModeToggle.tsx');
const SEARCH = src('../utils/search.ts');
const STOCK_BALANCES = src('./StockBalancesPage.tsx');

describe('точный поиск по умолчанию', () => {
  it('обход дерева нашёл экраны с поиском (иначе сторож проверяет пустоту)', () => {
    expect(SEARCH_SCREENS.length).toBeGreaterThanOrEqual(14);
  });

  it('каждый экран с поиском даёт кнопку «Похожие»', () => {
    for (const { name, code } of SEARCH_SCREENS) {
      expect(code, `${name}: поиск есть, а вернуть похожие нечем`).toContain('<SearchModeToggle');
      expect(code, `${name}: кнопка есть, а режим не проброшен`).toContain('searchModeOf');
    }
  });

  it('умолчание — точный режим, и оно живёт в трёх известных местах', () => {
    expect(HOOK).toContain("const mode: SearchMode = opts?.mode ?? 'exact';");
    expect(TOGGLE).toContain("return similar === true ? 'similar' : 'exact';");
    // Дефолт общих матчеров: до 22.09.2026 он был 'similar', и каждый непереведённый
    // экран молча оставался «похожим» — правка выглядела невыполненной.
    expect(SEARCH).toContain("mode: SearchMode = 'exact'");
    expect(SEARCH, 'умолчание «похожее» вернулось в общий матчер').not.toContain("mode: SearchMode = 'similar'");
  });

  it('остатки склада ищут точно, пока оператор не попросил похожие', () => {
    // Здесь поиск считает сервер (или оффлайн-реплика), поэтому намерение едет параметром.
    expect(STOCK_BALANCES).toContain('<SearchModeToggle');
    expect(STOCK_BALANCES, 'тумблер не доезжает до запроса остатков').toMatch(/searchSimilar\s*\?\s*\{\s*similar:\s*true\s*\}/);
    // Флаг ответа «показаны похожие» и тумблер — разные вещи; одно имя на двоих
    // уже приводило к тому, что ответ сервера переключал намерение оператора.
    expect(STOCK_BALANCES).toContain('responseSimilar');
  });

  it('лукапы и выпадающие списки остались терпимыми к опечаткам и раскладке', () => {
    // Пикеры ходят через rankLookupOptions, а не через матчеры списков: решение владельца
    // 22.09.2026 — в выпадашке похожее полезно, там оператор выбирает глазами из короткого списка.
    const picker = src('../components/SearchSelect.tsx');
    expect(picker).toContain('rankLookupOptions');
    expect(picker, 'пикер перевели на точный режим — это не то, о чём просили').not.toContain('searchModeOf');
  });

  it('тумблер помечен для смоуков и говорит оператору, что именно он включает', () => {
    expect(TOGGLE).toContain('data-search-similar');
    expect(TOGGLE).toContain('опечатки, часть слова, другая раскладка');
  });

  it('пустая выдача в точном режиме подсказывает про кнопку, а не молчит', () => {
    const engines = src('./EnginesPage.tsx');
    const globalSearch = src('../components/GlobalSearchOverlay.tsx');
    expect(engines).toContain('Нажмите «≈ Похожие»');
    expect(globalSearch, 'Ctrl+K молчит о том, чем расширить поиск').toContain('Нажмите «≈ Похожие»');
  });
});
