import { beforeEach, describe, expect, it, vi } from 'vitest';

// Справочники подменяем: сервис должен собирать настройки из того, что нашёл, а не ходить
// в живую базу. Ответ pool.query выбирается по тому, из какой таблицы читают.
const rows = vi.hoisted(() => ({
  brands: [] as Array<{ id: string; name: string }>,
  counterparties: [] as Array<{ id: string; name: string }>,
  contracts: [] as Array<{ id: string; name: string }>,
  fail: false,
}));

vi.mock('../../database/db.js', () => ({
  pool: {
    query: async (sql: string) => {
      if (rows.fail) throw new Error('база недоступна');
      if (sql.includes('directory_engine_brands')) return { rows: rows.brands };
      if (sql.includes('erp_counterparties')) return { rows: rows.counterparties };
      if (sql.includes('erp_contracts')) return { rows: rows.contracts };
      return { rows: [] };
    },
  },
}));

import { resolveReportTaskEntities, suggestReportsForTask } from './reportSuggestService.js';

const NOW = new Date(2026, 8, 12, 10, 0, 0);

beforeEach(() => {
  rows.brands = [
    { id: 'b1', name: 'Д-245' },
    { id: 'b2', name: 'ЯМЗ-238' },
  ];
  rows.counterparties = [{ id: 'cp1', name: 'Агрофирма Заря' }];
  rows.contracts = [{ id: 'c1', name: '12/26' }];
  rows.fail = false;
});

describe('resolveReportTaskEntities', () => {
  it('находит в задаче только упомянутое', () => {
    return resolveReportTaskEntities('двигатели Д-245 по заказчику Агрофирма Заря').then((out) => {
      expect(out.brands).toEqual([{ id: 'b1', name: 'Д-245' }]);
      expect(out.counterparties).toEqual([{ id: 'cp1', name: 'Агрофирма Заря' }]);
      expect(out.contracts).toEqual([]);
    });
  });

  it('не цепляет название внутри другого слова', async () => {
    const out = await resolveReportTaskEntities('нужна марка Д-245М, а не обычная');
    expect(out.brands).toEqual([]);
  });
});

describe('suggestReportsForTask', () => {
  it('кладёт в маркер период и найденные сущности', async () => {
    const { suggestions, period } = await suggestReportsForTask('покажи двигатели Д-245 за сентябрь', NOW);
    expect(period).toBe('сентябрь 2026');
    const best = suggestions[0]!;
    expect(best.id).toBe('engines');
    expect(best.marker.startsWith('[report:engines?')).toBe(true);
    expect(best.applied).toContain('сентябрь 2026');
    expect(best.applied).toContain('Д-245');
  });

  it('без узнаваемых слов ничего не предлагает, а не подсовывает случайный отчёт', async () => {
    const { suggestions } = await suggestReportsForTask('ы', NOW);
    expect(suggestions).toEqual([]);
  });

  it('задача без периода и сущностей даёт короткий маркер', async () => {
    const { suggestions } = await suggestReportsForTask('отчёт по нарядам', NOW);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.marker).toMatch(/^\[report:[a-z0-9_]+\]$/);
  });

  it('недоступная база не роняет подбор — отчёт предлагается без отбора', async () => {
    rows.fail = true;
    const { suggestions } = await suggestReportsForTask('двигатели Д-245 за сентябрь', NOW);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.applied).toContain('сентябрь 2026');
    expect(suggestions[0]!.applied).not.toContain('Д-245');
  });

  it('предложений не больше трёх — иначе ответ превращается в каталог', async () => {
    const { suggestions } = await suggestReportsForTask('двигатели наряды склад детали контракты за сентябрь', NOW);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });
});
