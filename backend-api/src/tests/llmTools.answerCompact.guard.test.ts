// Сторож компактного набора инструментов пути ответа Ииваныча.
//
// Контракт: набор, который модель видит на первом шаге, — подмножество полного,
// каждый его инструмент существует по-настоящему, и в нём есть те, что базовый
// промпт зовёт поимённо. Нарушение любого пункта — тихая поломка: модель уходит
// в эскалацию или отвечает «не найдено» там, где всё есть.
//
// 07.11.2026 на проде вопрос «сколько двигателей» занял 12 шагов с инструментами
// (потолок ANSWER_MAX_STEPS) и ~50 с — модель перебирала меню из 19 инструментов.
// Отсюда компактный старт; здесь след, чтобы он не сломался при правках.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../database/db.js', () => ({
  pool: { query: vi.fn() },
  db: {},
}));

vi.mock('../services/warehouseForecastService.js', () => ({
  computeAssemblyForecastFromServer: vi.fn(async () => ({
    rows: [],
    warnings: [],
    deficitRecommendations: [],
    horizonMissingByBrand: [],
    horizonComponentNeeds: [],
  })),
}));

import {
  ANSWER_COMPACT_TOOL_NAMES,
  FULL_TOOL_NAMES,
  getToolDefinitions,
} from '../services/ai/llmTools.js';

describe('компактный набор инструментов ответа Ииваныча', () => {
  it('каждый его инструмент существует в полном наборе', () => {
    for (const name of ANSWER_COMPACT_TOOL_NAMES) {
      expect(FULL_TOOL_NAMES).toContain(name);
    }
    const defs = getToolDefinitions(ANSWER_COMPACT_TOOL_NAMES).map((d) => d.name);
    expect([...defs].sort()).toEqual([...ANSWER_COMPACT_TOOL_NAMES].sort());
  });

  it('инструменты, которые зовёт промпт поимённо, есть в наборе', () => {
    // find_entity — перед «не найдено» (жёсткое требование промпта);
    // suggest_report — кнопка готового отчёта, без неё оператор теряет отчёт.
    expect(ANSWER_COMPACT_TOOL_NAMES).toContain('find_entity');
    expect(ANSWER_COMPACT_TOOL_NAMES).toContain('suggest_report');
  });

  it('набор меньше полного — расширение вообще что-то даёт', () => {
    expect(ANSWER_COMPACT_TOOL_NAMES.length).toBeLessThan(FULL_TOOL_NAMES.length);
    const extra = FULL_TOOL_NAMES.filter((n) => !ANSWER_COMPACT_TOOL_NAMES.includes(n));
    expect(extra.length).toBeGreaterThan(0);
  });

  it('в наборе есть чем ответить на бытовой вопрос', () => {
    // «Сколько двигателей» — один SELECT; остальное — карточки, остатки, движение.
    expect(ANSWER_COMPACT_TOOL_NAMES).toContain('execute_safe_sql');
    expect(ANSWER_COMPACT_TOOL_NAMES).toContain('get_stock_balances');
    expect(ANSWER_COMPACT_TOOL_NAMES).toContain('get_operations');
    expect(ANSWER_COMPACT_TOOL_NAMES).toContain('get_engine_details');
  });
});
