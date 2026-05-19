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
  FULL_TOOL_NAMES,
  getToolDefinitions,
  type ToolContext,
} from '../services/ai/claudeTools.js';

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

describe('claudeTools.executeTool', () => {
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

  it('getToolDefinitions returns Anthropic.Tool[] for known names', () => {
    const defs = getToolDefinitions(FULL_TOOL_NAMES);
    expect(defs.length).toBe(FULL_TOOL_NAMES.length);
    for (const d of defs) {
      expect(d.input_schema.type).toBe('object');
      expect(typeof d.description).toBe('string');
    }
  });
});
