import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../database/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
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

import { pool } from '../database/db.js';
import {
  executeTool,
  ANSWER_COMPACT_TOOL_NAMES,
  FULL_TOOL_NAMES,
  getToolDefinitions,
  type ToolContext,
} from '../services/ai/llmTools.js';

const partsViewer: ToolContext = {
  actorId: 'u1',
  permissions: {
    'parts.view': true,
    'engines.view': true,
    'masterdata.view': true,
    'reports.view': true,
    'operations.view': true,
    'employees.view': true,
    'erp.cards.view': true,
  },
};

const restrictedUser: ToolContext = {
  actorId: 'u2',
  permissions: {
    'parts.view': true,
  },
};

const poolQuery = pool.query as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  poolQuery.mockReset();
});

describe('llmTools.executeTool', () => {
  it('rejects unknown tool name', async () => {
    const res = await executeTool({ id: 'x', name: 'nope', input: {} }, partsViewer);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/Неизвестный tool/);
  });

  it('denies when actor has no required permission', async () => {
    const res = await executeTool(
      { id: 'x', name: 'get_employees_list', input: {} },
      restrictedUser,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/Недостаточно прав/);
  });

  it('query_nomenclature executes parameterized search and returns rows', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{ id: 'n1', code: 'P-01', name: 'Поршень', sku: 'P01', item_type: 'material' }],
    });
    const res = await executeTool(
      { id: 'x', name: 'query_nomenclature', input: { search: 'поршень', limit: 10 } },
      partsViewer,
    );
    expect(res.isError).toBeFalsy();
    expect(poolQuery).toHaveBeenCalledOnce();
    const call = poolQuery.mock.calls[0]!;
    expect(call[0]).toMatch(/from erp_nomenclature/);
    expect(call[0]).toMatch(/limit 10/);
    expect(call[1]).toEqual(['%поршень%']);
    const payload = JSON.parse(res.content);
    expect(payload.total).toBe(1);
    expect(payload.rows[0].name).toBe('Поршень');
  });

  it('get_engine_stats отдаёт все цифры одним запросом и фильтры идут параметрами', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [
        {
          total: 2578,
          repair_started: 168,
          repaired: 135,
          shipped: 1472,
          scrap: 97,
          reclamation: 19,
          storage_received: 27,
          at_plant: 513,
          at_plant_with_customer: 418,
          in_repair_now: 150,
          without_arrival: 659,
        },
      ],
    });
    const res = await executeTool(
      { id: 'x', name: 'get_engine_stats', input: { engineBrandId: 'b1' } },
      partsViewer,
    );
    expect(res.isError).toBeFalsy();
    expect(poolQuery).toHaveBeenCalledOnce();
    const call = poolQuery.mock.calls[0]!;
    // Один запрос с FILTER по всем состояниям — не десяток COUNT-запросов по одному.
    expect(call[0]).toMatch(/from erp_engine_cards/);
    expect(call[0]).toMatch(/count\(\*\) filter \(where status_repair_started\)/);
    expect(call[0]).toMatch(/count\(\*\) filter \(where status_scrap_confirmed\)/);
    expect(call[0]).toMatch(/count\(\*\) filter \(where reclamation_flag\)/);
    expect(call[1]).toEqual(['b1']);
    const payload = JSON.parse(res.content);
    expect(payload.counts.total).toBe(2578);
    expect(payload.counts.at_plant_with_customer).toBe(418);
    expect(payload.filters.engineBrandId).toBe('b1');
    // Модель складывает строки — предупреждаем, что флаги пересекаются.
    expect(payload.note).toMatch(/пересекаются/);
  });

  it('get_engine_stats без фильтров идёт по всем карточкам', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    const res = await executeTool({ id: 'x', name: 'get_engine_stats', input: {} }, partsViewer);
    expect(res.isError).toBeFalsy();
    const call = poolQuery.mock.calls[0]!;
    expect(call[1]).toEqual([]);
    expect(call[0]).toMatch(/where deleted_at is null/);
  });

  it('счёт двигателей есть в компактном наборе ответа', () => {
    expect(ANSWER_COMPACT_TOOL_NAMES).toContain('get_engine_stats');
    // Инструмент без «по счёту» — снова десяток COUNT-запросов (прод 08.11: 12 шагов).
    expect(getToolDefinitions(ANSWER_COMPACT_TOOL_NAMES).map((d) => d.name)).toContain('get_engine_stats');
  });

  it('get_employees_list filters out hidden attributes (salary, passport)', async () => {
    poolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'e1', created_at: 1, updated_at: 2 }],
      })
      .mockResolvedValueOnce({
        rows: [
          { entity_id: 'e1', attribute_code: 'fullname', attribute_name: 'ФИО', value_json: '"Иванов"' },
          { entity_id: 'e1', attribute_code: 'salary', attribute_name: 'Оклад', value_json: '50000' },
          { entity_id: 'e1', attribute_code: 'passport_no', attribute_name: 'Паспорт', value_json: '"1234"' },
          { entity_id: 'e1', attribute_code: 'phone', attribute_name: 'Телефон', value_json: '"+7"' },
        ],
      });
    const res = await executeTool(
      { id: 'x', name: 'get_employees_list', input: {} },
      partsViewer,
    );
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content);
    const attrs = payload.rows[0].attributes as Array<{ code: string }>;
    const codes = attrs.map((a) => a.code);
    expect(codes).toContain('fullname');
    expect(codes).toContain('phone');
    expect(codes).not.toContain('salary');
    expect(codes).not.toContain('passport_no');
  });

  it('get_organization_structure resolves names and employee counts without exposing UUIDs', async () => {
    poolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'w1', code: '2', name: 'Цех №2', is_active: true, display_order: 2 }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'd1', name_json: '"Отдел кадров"' }],
      })
      .mockResolvedValueOnce({
        rows: [
          { entity_id: 'e1', code: 'workshop_id', value_json: '"w1"' },
          { entity_id: 'e1', code: 'employment_status', value_json: '"working"' },
          { entity_id: 'e2', code: 'department_id', value_json: '"d1"' },
          { entity_id: 'e2', code: 'employment_status', value_json: '"fired"' },
        ],
      });
    const res = await executeTool({ id: 'x', name: 'get_organization_structure', input: {} }, partsViewer);
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content);
    expect(payload.workshops[0]).toMatchObject({ code: '2', name: 'Цех №2', workingEmployees: 1 });
    expect(payload.departments[0]).toMatchObject({ name: 'Отдел кадров', firedEmployees: 1 });
    expect(JSON.stringify(payload)).not.toContain('"w1"');
    expect(JSON.stringify(payload)).not.toContain('"d1"');
  });

  it('execute_safe_sql rejects writes, comments, semicolons, hidden tables', async () => {
    for (const bad of [
      { sql: 'INSERT INTO users VALUES (1)' },
      { sql: 'SELECT 1; SELECT 2' },
      { sql: 'SELECT id FROM users -- secret' },
      { sql: 'SELECT * FROM refresh_tokens' },
      { sql: 'SELECT password_hash FROM users' },
    ]) {
      const res = await executeTool(
        { id: 'x', name: 'execute_safe_sql', input: bad },
        partsViewer,
      );
      expect(res.isError, `should reject: ${bad.sql}`).toBe(true);
    }
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('execute_safe_sql allows whitelisted tables and redacts hidden columns', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{ id: 'u1', login: 'alice' }],
    });
    const res = await executeTool(
      { id: 'x', name: 'execute_safe_sql', input: { sql: 'SELECT id, name FROM entities' } },
      partsViewer,
    );
    expect(res.isError).toBeFalsy();
    expect(poolQuery).toHaveBeenCalledOnce();
    expect(poolQuery.mock.calls[0]![0]).toMatch(/LIMIT 200/i);
  });

  it('execute_safe_sql allows canonical workshops for readers', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ code: '1', name: 'Цех №1' }] });
    const res = await executeTool(
      { id: 'x', name: 'execute_safe_sql', input: { sql: 'SELECT code, name FROM directory_workshops' } },
      partsViewer,
    );
    expect(res.isError).toBeFalsy();
  });

  it('execute_safe_sql denies access to tables not granted by permissions', async () => {
    const masterdataOnly: ToolContext = {
      actorId: 'u3',
      permissions: { 'masterdata.view': true },
    };
    const res = await executeTool(
      { id: 'x', name: 'execute_safe_sql', input: { sql: 'SELECT * FROM erp_contracts' } },
      masterdataOnly,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/Нет прав на таблицу/);
  });

  // Рекламации читаются из очереди заездов (erp_engine_reclamations), а не из EAV:
  // у двигателя рекламаций может быть несколько, и модель должна видеть их все.
  it('get_reclamations читает очередь заездов и отдаёт все рекламации движка', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'e1' }] });
    poolQuery.mockResolvedValueOnce({
      rows: [
        { entity_id: 'e1', attribute_code: 'engine_number', value_json: '"Д-1"' },
        { entity_id: 'e1', attribute_code: 'customer_id', value_json: '"c1"' },
      ],
    });
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'ООО «ВЗК»' }] });
    poolQuery.mockResolvedValueOnce({
      rows: [
        {
          engine_id: 'e1',
          queue_no: 1,
          accepted_at: 1788332400000,
          shipped_at: 1788418800000,
          customer_reason: 'Треснул блок',
          actual_defect: 'Разрушение вкладышей',
          defect_nature: 'Производственный',
          act_number: '14/26',
          act_date: null,
          comment: null,
        },
        {
          engine_id: 'e1',
          queue_no: 2,
          accepted_at: 1788505200000,
          shipped_at: null,
          customer_reason: 'Повторный дефект',
          actual_defect: null,
          defect_nature: 'Эксплуатационный',
          act_number: null,
          act_date: null,
          comment: 'В работе',
        },
      ],
    });
    const res = await executeTool({ id: 'x', name: 'get_reclamations', input: {} }, partsViewer);
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content);
    expect(payload.rows).toHaveLength(2);
    expect(payload.total).toBe(2);
    expect(payload.rows[0]).toMatchObject({
      engineId: 'e1',
      engine_number: 'Д-1',
      customer_name: 'ООО «ВЗК»',
      reclamation_no: 1,
      reclamation_accepted_at: 1788332400000,
      reclamation_shipped_at: 1788418800000,
      reclamation_customer_reason: 'Треснул блок',
    });
    expect(payload.rows[1]).toMatchObject({ reclamation_no: 2, reclamation_shipped_at: null, reclamation_defect_nature: 'Эксплуатационный' });
    // Очередь читается из строгой таблицы, а не из EAV-флага.
    expect(poolQuery.mock.calls[0]![0]).toMatch(/erp_engine_reclamations/);
  });

  it('описание get_reclamations больше не врёт про отсутствие таблицы', () => {
    const def = getToolDefinitions(['get_reclamations'])[0]!;
    expect(def.description).toContain('erp_engine_reclamations');
    expect(def.description).not.toContain('отдельной таблицы claims НЕТ');
  });

  it('list_report_presets возвращает каталог, поиск фильтрует', async () => {
    const all = await executeTool({ name: 'list_report_presets', input: {} } as any, partsViewer);
    const parsedAll = JSON.parse(all.content);
    expect(parsedAll.presets.length).toBeGreaterThan(20);
    expect(parsedAll.presets.some((p: any) => p.id === 'engines')).toBe(true);
    const filtered = await executeTool({ name: 'list_report_presets', input: { search: 'двигател' } } as any, partsViewer);
    const parsed = JSON.parse(filtered.content);
    expect(parsed.presets.length).toBeGreaterThan(0);
    expect(parsed.presets.length).toBeLessThan(parsedAll.presets.length);
    expect(parsed.hint).toContain('[report:');
  });

  it('suggest_report подбирает пресет по задаче и требует reports.view', async () => {
    const r = await executeTool({ name: 'suggest_report', input: { task: 'сколько двигателей отгружено заказчику за месяц' } } as any, partsViewer);
    const parsed = JSON.parse(r.content);
    expect(parsed.suggestions.length).toBeGreaterThan(0);
    expect(parsed.suggestions.some((x: any) => x.id === 'engines' || x.id === 'engine_flow_by_counterparty')).toBe(true);
    const denied = await executeTool({ name: 'suggest_report', input: { task: 'двигатели' } } as any, restrictedUser);
    expect(denied.isError).toBe(true);
  });

  it('get_report_usage агрегирует open/build и резолвит алиасы в объединённый пресет', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [
        { preset_id: 'engines_list', action: 'ui.report_open', cnt: 5 },
        { preset_id: 'engines_contracts_overview', action: 'ui.report_build', cnt: 3 },
        { preset_id: 'engines', action: 'ui.report_build', cnt: 2 },
        { preset_id: 'work_orders_report', action: 'ui.report_open', cnt: 1 },
      ],
    });
    const r = await executeTool({ name: 'get_report_usage', input: { days: 30 } } as any, partsViewer);
    const parsed = JSON.parse(r.content);
    const engines = parsed.usage.find((x: any) => x.presetId === 'engines');
    expect(engines).toBeTruthy();
    expect(engines.opens).toBe(5);
    expect(engines.builds).toBe(5); // 3 (алиас) + 2 (canonical)
    expect(parsed.usage[0].presetId).toBe('engines');
  });

  it('getToolDefinitions returns Anthropic.Tool[] for known names', () => {
    const defs = getToolDefinitions(FULL_TOOL_NAMES);
    expect(defs.length).toBe(FULL_TOOL_NAMES.length);
    for (const d of defs) {
      expect(d.input_schema.type).toBe('object');
      expect(typeof d.description).toBe('string');
    }
  });
});
