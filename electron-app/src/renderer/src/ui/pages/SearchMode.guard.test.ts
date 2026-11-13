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
const MODE_HOOK = src('../hooks/useSearchMode.ts');
const TOGGLE = src('../components/SearchModeToggle.tsx');
const SEARCH = src('../utils/search.ts');
const HINT = src('../components/SearchModeHint.tsx');
const PAGED_FETCH = src('../utils/warehousePagedFetch.ts');
const STOCK_BALANCES = src('./StockBalancesPage.tsx');
const ERP_SERVICE = src('../../../../main/services/erpService.ts');
const WAREHOUSE_ROUTE = src('../../../../../../backend-api/src/routes/warehouse.ts');

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
    // Намерение едет в запрос ЯВНО — и «похожие», и «строго» (владелец 13.11.2026, промт #10):
    // «параметр не прислали» — это не решение, это отсутствие решения. Сервер не должен угадывать.
    expect(STOCK_BALANCES).toContain('similar: searchSimilar,');
    // Намерение доезжает до сервера через разбор страниц: флаг объявлен и уходит в запрос как есть.
    expect(PAGED_FETCH).toContain('similar?: boolean;');
    expect(PAGED_FETCH).toContain('...args,');
    expect(ERP_SERVICE).toContain("qp.set('similar', args?.similar === true ? 'true' : 'false');");
    expect(WAREHOUSE_ROUTE).toContain('similar: parsed.data.similar === true,');
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
    // Подсказка живёт в ОДНОМ файле (её текст одинаков на всех экранах), а экраны её подключают.
    expect(HINT, 'подсказка пропала из общего места').toContain('Нажмите «≈ Похожие»');
    expect(src('./EnginesPage.tsx')).toContain('SEARCH_MODE_HINT');
    expect(src('../components/GlobalSearchOverlay.tsx')).toContain('SEARCH_MODE_HINT');
  });

  // Правило одно для всех экранов (владелец 13.11.2026, промты КАРМАНА #10 + #14):
  // пока в поле печатают — ищется ТОЧНО; «похожие» включается кнопкой и только на это время.
  it('режим поиска берётся из общего хука — одно правило, а не по экрану', () => {
    for (const { name, code } of SEARCH_SCREENS) {
      expect(code, `${name}: режим поиска взят не из общего хука`).toContain('useSearchMode(');
    }
  });

  it('режим поиска не лежит в состоянии списка (оно живёт в sessionStorage)', () => {
    for (const { name, code } of SEARCH_SCREENS) {
      // Список сохранён в sessionStorage: режим там переживал бы и перезапуск программы,
      // и смену экрана — оператор получал «лишнее» в выдаче и не понимал, откуда оно.
      expect(code, `${name}: режим поиска снова в состоянии списка`).not.toMatch(/searchSimilar:\s*(false|boolean)/);
      expect(code, `${name}: режим читается из состояния списка`).not.toMatch(/(listState|ui)\.searchSimilar/);
    }
  });

  it('режим не переживает перезапуск списка, очистку поля и сброс фильтров', () => {
    expect(MODE_HOOK).toContain('const [similar, setSimilar] = useState(false);');
    // Панель показали снова — список открыли заново: «похожие» не переносится через экран.
    expect(MODE_HOOK).toContain('useOnTabVisible(() => setSimilar(false));');
    // Новое поле — новый поиск: очистил строку, вернись к точному.
    expect(MODE_HOOK).toContain('if (!query.trim()) setSimilar(false);');
    // Сброс фильтров возвращает строгий (одно правило, а не по экрану).
    expect(MODE_HOOK).toContain('const reset = useCallback(() => setSimilar(false), []);');
  });

  it('сброс фильтров на экране со ступенями возвращает строгий режим', () => {
    const withFacets = SEARCH_SCREENS.filter(({ code }) => code.includes('<FacetFilter') || code.includes('<EngineFacetFilter'));
    expect(withFacets.length).toBeGreaterThanOrEqual(8);
    for (const { name, code } of withFacets) {
      expect(code, `${name}: сброс ступеней не вернул строгий поиск`).toContain('resetSearchMode()');
    }
  });

  it('пустая выдача на любом экране подсказывает кнопку «Похожие»', () => {
    for (const { name, code } of SEARCH_SCREENS) {
      expect(code, `${name}: пустая выдача молчит — оператор не знает, чем искать`).toMatch(
        /searchModeEmptyText|SearchModeEmptyHint|SEARCH_MODE_HINT/,
      );
    }
  });
});
