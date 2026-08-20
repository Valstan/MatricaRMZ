import { REPORT_PRESET_DEFINITIONS, REPORT_PRESET_THEMES, resolveReportPresetId } from '@matricarmz/shared';

import { pool } from '../../database/db.js';
import { computeAssemblyForecastFromServer } from '../warehouseForecastService.js';
import { getRestrictedWorkOrderIds, isAllowlistedReaderById } from '../sync/restrictedWorkOrders.js';
import type { LlmToolDef, LlmToolUse } from './llmProvider.js';
import {
  HIDDEN_TABLES,
  HIDDEN_COLUMNS,
  findForbiddenIdentifiers,
  isHiddenAttributeName,
  sanitizeRows,
} from './sensitiveFilter.js';

const MAX_ROWS = 200;
const PREVIEW_ROWS = 50;
const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|merge)\b/i;

export type ToolContext = {
  actorId: string;
  permissions: Record<string, boolean>;
};

export type ToolResult = {
  content: string;
  isError?: boolean;
};

type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

type ToolEntry = {
  def: LlmToolDef;
  requires?: ReadonlyArray<string>;
  handler: ToolHandler;
};

function can(ctx: ToolContext, perm: string): boolean {
  return ctx.permissions?.[perm] === true;
}

function denyMessage(perms: ReadonlyArray<string>): ToolResult {
  return {
    content: `Недостаточно прав: требуется одно из ${perms.join(', ')}.`,
    isError: true,
  };
}

function jsonResult(payload: unknown): ToolResult {
  const trimmed = trimPayload(payload);
  return { content: JSON.stringify(trimmed) };
}

function trimPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length > PREVIEW_ROWS) {
      return {
        rows: value.slice(0, PREVIEW_ROWS),
        truncated: true,
        total: value.length,
        preview: PREVIEW_ROWS,
      };
    }
    return { rows: value, total: value.length };
  }
  return value;
}

function asString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return v == null ? '' : String(v);
}

function asLimit(input: Record<string, unknown>): number {
  const raw = Number(input.limit ?? 50);
  if (!Number.isFinite(raw)) return 50;
  return Math.max(1, Math.min(Math.floor(raw), MAX_ROWS));
}

function decodeAttributeValue(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function queryNomenclature(input: Record<string, unknown>): Promise<ToolResult> {
  const search = asString(input, 'search').trim();
  const limit = asLimit(input);
  const params: unknown[] = [];
  let where = 'n.deleted_at is null';
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where +=
      ' and (lower(coalesce(n.name, \'\')) like $1 or lower(coalesce(n.sku, \'\')) like $1)';
  }
  const sql =
    'select n.id, n.code, n.name, n.sku, n.item_type, n.category, n.directory_kind, n.default_brand_id, n.is_active ' +
    `from erp_nomenclature n where ${where} order by n.name asc limit ${limit}`;
  const res = await pool.query(sql, params as any[]);
  return jsonResult(sanitizeRows(res.rows ?? []));
}

async function getStockBalances(input: Record<string, unknown>): Promise<ToolResult> {
  const nomenclatureId = asString(input, 'nomenclatureId').trim();
  const search = asString(input, 'search').trim();
  const warehouseId = asString(input, 'warehouseId').trim();
  const limit = asLimit(input);
  const params: unknown[] = [];
  const conds: string[] = ['b.qty <> 0'];
  if (nomenclatureId) {
    params.push(nomenclatureId);
    conds.push(`b.nomenclature_id = $${params.length}`);
  }
  if (warehouseId) {
    params.push(warehouseId);
    conds.push(`wl.code = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    conds.push(
      `(lower(coalesce(n.name, '')) like $${params.length} or lower(coalesce(n.sku, '')) like $${params.length})`,
    );
  }
  const sql =
    'select b.nomenclature_id, n.name as nomenclature_name, n.sku, ' +
    'wl.code as warehouse_id, b.qty, b.reserved_qty ' +
    'from erp_reg_stock_balance b ' +
    'left join erp_nomenclature n on n.id = b.nomenclature_id ' +
    'left join warehouse_locations wl on wl.id = b.warehouse_location_id ' +
    `where ${conds.join(' and ')} order by n.name asc limit ${limit}`;
  const res = await pool.query(sql, params as any[]);
  return jsonResult(sanitizeRows(res.rows ?? []));
}

async function getInventoryForecast(input: Record<string, unknown>): Promise<ToolResult> {
  const horizonDays = Number(input.horizonDays ?? 7);
  const targetEnginesPerDay = Number(input.targetEnginesPerDay ?? 2);
  const sameBrandBatchSize = Number(input.sameBrandBatchSize ?? 2);
  const engineBrandIds = Array.isArray(input.engineBrandIds)
    ? (input.engineBrandIds as unknown[]).map(String)
    : undefined;
  const warehouseIds = Array.isArray(input.warehouseIds)
    ? (input.warehouseIds as unknown[]).map(String)
    : undefined;
  const forecast = await computeAssemblyForecastFromServer({
    horizonDays,
    targetEnginesPerDay,
    sameBrandBatchSize,
    ...(engineBrandIds ? { engineBrandIds } : {}),
    ...(warehouseIds ? { warehouseIds } : {}),
  });
  const compact = {
    warnings: forecast.warnings ?? [],
    deficits: (forecast.deficitRecommendations ?? []).slice(0, PREVIEW_ROWS),
    horizonMissingByBrand: (forecast.horizonMissingByBrand ?? []).slice(0, PREVIEW_ROWS),
    rowsPreview: (forecast.rows ?? []).slice(0, 10),
    totalRows: (forecast.rows ?? []).length,
  };
  return jsonResult(compact);
}

async function getEngineBrands(input: Record<string, unknown>): Promise<ToolResult> {
  const search = asString(input, 'search').trim();
  const limit = asLimit(input);
  const params: unknown[] = [];
  let where = 'deleted_at is null';
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where += ` and lower(name) like $${params.length}`;
  }
  const sql = `select id, name, is_active from directory_engine_brands where ${where} order by name asc limit ${limit}`;
  const res = await pool.query(sql, params as any[]);
  return jsonResult(sanitizeRows(res.rows ?? []));
}

async function getEngineDetails(input: Record<string, unknown>): Promise<ToolResult> {
  const engineId = asString(input, 'engineId').trim();
  if (!engineId) return { content: 'Параметр engineId обязателен.', isError: true };
  const headSql =
    'select e.id, e.type_id, t.code as type_code, e.created_at, e.updated_at ' +
    'from entities e join entity_types t on t.id = e.type_id ' +
    "where e.id = $1 and e.deleted_at is null and t.code in ('engine','engine_instance') limit 1";
  const head = await pool.query(headSql, [engineId]);
  if ((head.rows ?? []).length === 0) {
    return { content: JSON.stringify({ found: false }) };
  }
  const attrSql =
    'select d.code as attribute_code, d.name as attribute_name, d.data_type, av.value_json ' +
    'from attribute_values av join attribute_defs d on d.id = av.attribute_def_id ' +
    "where av.entity_id = $1 and av.deleted_at is null and d.deleted_at is null order by d.sort_order asc";
  const attrs = await pool.query(attrSql, [engineId]);
  const attributes = (attrs.rows ?? []).filter(
    (r: any) => !isHiddenAttributeName(r.attribute_code) && !isHiddenAttributeName(r.attribute_name),
  );
  return jsonResult({ found: true, engine: head.rows[0], attributes });
}

// Нечёткий поиск сущностей по имени: пользователи пишут сокращённо и с
// ошибками («ОВК» вместо «ООО "ОВК"», «гранит» вместо «АО "РПТП "ГРАНИТ"»).
// Ищем по подстроке (регистронезависимо) и, если установлен pg_trgm, добираем
// похожие по триграммной близости. Покрывает EAV-сущности (заказчики,
// двигатели, сотрудники, детали…) и ERP-справочники контрагентов/номенклатуры.
// Атрибуты, по которым человек опознаёт сущность вслух. Не «все текстовые» —
// иначе в кандидаты полезут комментарии и реквизиты счетов, и нечёткий поиск
// начнёт возвращать шум вместо ответа.
const SEARCHABLE_IDENTIFIER_CODES = [
  'name',
  'full_name',
  'short_name',
  'login',
  'goz_name', // у договора нет `name` — по-человечески он зовётся наименованием ГОЗ
  'number', // номер договора
  'internal_number', // внутренний номер договора («20/ГОЗ-25»)
  'engine_number',
  'engine_internal_number', // клеймо на безымянных деталях («41/26»)
  'personnel_number', // табельный номер сотрудника
  'assembly_unit_number',
  'code',
  'short_code',
] as const;

let trgmAvailable: boolean | null = null;
async function hasTrgm(): Promise<boolean> {
  if (trgmAvailable !== null) return trgmAvailable;
  try {
    const r = await pool.query("select 1 from pg_extension where extname = 'pg_trgm'");
    trgmAvailable = (r.rows ?? []).length > 0;
  } catch {
    trgmAvailable = false;
  }
  return trgmAvailable;
}

async function findEntity(input: Record<string, unknown>): Promise<ToolResult> {
  const query = asString(input, 'query').trim();
  if (!query) return { content: 'Параметр query обязателен.', isError: true };
  const typeFilter = asString(input, 'type').trim().toLowerCase();
  const limit = Math.min(asLimit(input), 25);
  const trgm = await hasTrgm();
  const results: Array<Record<string, unknown>> = [];

  // 1. EAV: человеческий идентификатор сущности лежит не только в name — у
  // договора имени нет вовсе, он опознаётся НОМЕРОМ (`number` /
  // `internal_number`), у сотрудника есть табельный, у двигателя — клеймо.
  // Пока список был только name/full_name/short_name/engine_number/login,
  // вопрос «сводка по договору 425» давал 0 строк: номер договора не искался
  // ни одним tool'ом (кейс владельца 2026-08-17).
  const eavParams: unknown[] = [query.toLowerCase()];
  let eavWhere =
    `d.code in (${SEARCHABLE_IDENTIFIER_CODES.map((c) => `'${c}'`).join(', ')}) ` +
    'and av.deleted_at is null and e.deleted_at is null ' +
    `and (lower(coalesce(av.value_json, '')) like '%' || $1 || '%'` +
    (trgm ? ` or similarity(lower(coalesce(av.value_json, '')), $1) > 0.25` : '') +
    ')';
  if (typeFilter) {
    eavParams.push(typeFilter);
    eavWhere += ` and t.code = $${eavParams.length}`;
  }
  // Точное вхождение подстроки должно бить нечёткое совпадение, иначе длинный
  // номер договора («…5215425/641/25/…», similarity ≈ 0.05) вытесняется из
  // выдачи короткими похожими номерами двигателей («Ф07АТ2425», similarity
  // высокая) — ровно этот перевёрнутый порядок владелец и увидел 2026-08-17.
  const eavSql =
    'select e.id, t.code as entity_type, d.code as matched_attr, av.value_json as matched_value ' +
    `, (lower(coalesce(av.value_json, '')) like '%' || $1 || '%') as exact_hit ` +
    (trgm ? `, similarity(lower(coalesce(av.value_json, '')), $1) as score ` : ', 1.0 as score ') +
    'from attribute_values av ' +
    'join attribute_defs d on d.id = av.attribute_def_id ' +
    'join entities e on e.id = av.entity_id ' +
    'join entity_types t on t.id = e.type_id ' +
    `where ${eavWhere} order by exact_hit desc, score desc limit ${limit}`;
  const eav = await pool.query(eavSql, eavParams as any[]);
  for (const r of eav.rows ?? []) {
    let value = String(r.matched_value ?? '');
    try {
      value = String(JSON.parse(value));
    } catch {
      /* как есть */
    }
    if (isHiddenAttributeName(r.matched_attr)) continue;
    results.push({ id: r.id, entityType: r.entity_type, matchedAttr: r.matched_attr, name: value, score: r.score });
  }

  // Контрагенты и договоры ищутся EAV-поиском выше (сущности customer/contract);
  // строгие зеркала erp_counterparties/erp_contracts (B2) дублировать здесь не нужно —
  // id-пространство одно и то же, кандидаты совпали бы.

  if (results.length === 0) {
    return jsonResult({
      found: false,
      hint: 'Ничего похожего. Попробуй другой вариант написания или спроси пользователя, что он имел в виду.',
    });
  }
  return jsonResult({ found: true, candidates: results.slice(0, limit) });
}

// Рекламации — НЕ отдельная таблица: это EAV-атрибуты reclamation_* на самой
// сущности двигателя (см. shared/src/domain/reclamation.ts). Без этого tool
// модель ищет несуществующую таблицу claims, получает отказ и неверно
// докладывает «нет прав» (кейс sapegin / «вся рекламация ОВК», 2026-08-17).
async function getReclamations(input: Record<string, unknown>): Promise<ToolResult> {
  const search = asString(input, 'counterparty').trim();
  const limit = asLimit(input);
  const params: unknown[] = [];
  let counterpartyFilter = '';
  if (search) {
    // customer_id двигателя указывает на EAV-сущность типа customer (не на
    // erp_counterparties) — имя заказчика лежит атрибутом name этой сущности.
    params.push(`%${search.toLowerCase()}%`);
    counterpartyFilter =
      ` and exists (select 1 from attribute_values avc join attribute_defs dc on dc.id = avc.attribute_def_id ` +
      `join attribute_values avn join attribute_defs dn on dn.id = avn.attribute_def_id ` +
      `on avn.entity_id::text = trim(both '"' from coalesce(avc.value_json, '')) ` +
      `where avc.entity_id = e.id and avc.deleted_at is null and dc.code = 'customer_id' ` +
      `and dn.code in ('name', 'full_name', 'short_name') and avn.deleted_at is null ` +
      `and lower(coalesce(avn.value_json, '')) like $${params.length})`;
  }
  const headSql =
    'select e.id, e.created_at, e.updated_at from entities e ' +
    'join entity_types t on t.id = e.type_id ' +
    "where t.code in ('engine','engine_instance') and e.deleted_at is null " +
    'and exists (select 1 from attribute_values avf join attribute_defs df on df.id = avf.attribute_def_id ' +
    "where avf.entity_id = e.id and avf.deleted_at is null and df.code = 'reclamation_flag' " +
    "and lower(coalesce(avf.value_json, '')) in ('true', '\"true\"'))" +
    counterpartyFilter +
    ` order by e.updated_at desc limit ${limit}`;
  const head = await pool.query(headSql, params as any[]);
  const ids = (head.rows ?? []).map((r: any) => r.id);
  if (ids.length === 0) return jsonResult([]);
  const attrSql =
    'select av.entity_id, d.code as attribute_code, d.name as attribute_name, av.value_json ' +
    'from attribute_values av join attribute_defs d on d.id = av.attribute_def_id ' +
    'where av.deleted_at is null and d.deleted_at is null and av.entity_id = ANY($1::uuid[]) ' +
    "and (d.code like 'reclamation%' or d.code in ('engine_number','engine_internal_number','engine_brand','engine_brand_id','contract_id','customer_id'))";
  const attrs = await pool.query(attrSql, [ids]);
  const byId = new Map<string, Record<string, unknown>>();
  const counterpartyIds = new Set<string>();
  const contractIds = new Set<string>();
  for (const a of attrs.rows ?? []) {
    const rec = byId.get(a.entity_id) ?? {};
    let value: unknown = a.value_json;
    try {
      value = JSON.parse(String(a.value_json ?? 'null'));
    } catch {
      /* сырые строки оставляем как есть */
    }
    rec[a.attribute_code] = value;
    byId.set(a.entity_id, rec);
    if (a.attribute_code === 'customer_id' && typeof value === 'string') counterpartyIds.add(value);
    if (a.attribute_code === 'contract_id' && typeof value === 'string') contractIds.add(value);
  }
  const names = new Map<string, string>();
  if (counterpartyIds.size > 0) {
    // Имя заказчика — атрибут name EAV-сущности customer; фолбэк на ERP-справочник.
    const r = await pool.query(
      'select av.entity_id as id, av.value_json as name from attribute_values av ' +
        'join attribute_defs d on d.id = av.attribute_def_id ' +
        "where av.entity_id = ANY($1::uuid[]) and av.deleted_at is null and d.code in ('name', 'full_name', 'short_name')",
      [[...counterpartyIds]],
    );
    for (const row of r.rows ?? []) {
      let value = String(row.name ?? '');
      try {
        value = String(JSON.parse(value));
      } catch {
        /* не-JSON — как есть */
      }
      if (value && !names.has(row.id)) names.set(row.id, value);
    }
  }
  const contractNames = new Map<string, string>();
  if (contractIds.size > 0) {
    // B2: договор опознаётся номером, не именем: internal_number («20/ГОЗ-25»)
    // приоритетнее казённого number. Читаем строгую erp_contracts (зеркало EAV, 0084).
    const r = await pool.query(
      'select id, number, internal_number from erp_contracts where id = ANY($1::uuid[])',
      [[...contractIds]],
    );
    for (const row of r.rows ?? []) {
      const label = String(row.internal_number ?? '').trim() || String(row.number ?? '').trim();
      if (label) contractNames.set(row.id, label);
    }
  }
  const rows = ids.map((id: string) => {
    const rec = byId.get(id) ?? {};
    const customerId = typeof rec['customer_id'] === 'string' ? (rec['customer_id'] as string) : '';
    const contractId = typeof rec['contract_id'] === 'string' ? (rec['contract_id'] as string) : '';
    return {
      engineId: id,
      ...rec,
      customer_name: names.get(customerId) ?? null,
      contract_name: contractNames.get(contractId) ?? null,
    };
  });
  return jsonResult(rows);
}

async function getEmployeesList(input: Record<string, unknown>): Promise<ToolResult> {
  const search = asString(input, 'search').trim();
  const limit = asLimit(input);
  const params: unknown[] = [];
  let where = "t.code = 'employee' and e.deleted_at is null";
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where +=
      ` and exists (select 1 from attribute_values av join attribute_defs d on d.id = av.attribute_def_id ` +
      `where av.entity_id = e.id and av.deleted_at is null and d.code in ('full_name','fullname','name','last_name') ` +
      `and lower(coalesce(av.value_json, '')) like $${params.length})`;
  }
  const sql =
    'select e.id, e.created_at, e.updated_at from entities e ' +
    `join entity_types t on t.id = e.type_id where ${where} order by e.updated_at desc limit ${limit}`;
  const head = await pool.query(sql, params as any[]);
  const heads = head.rows ?? [];
  const ids = heads.map((r: any) => r.id);
  if (ids.length === 0) return jsonResult([]);
  const attrSql =
    'select av.entity_id, d.code as attribute_code, d.name as attribute_name, av.value_json ' +
    'from attribute_values av join attribute_defs d on d.id = av.attribute_def_id ' +
    "where av.deleted_at is null and d.deleted_at is null and av.entity_id = ANY($1::uuid[])";
  const attrs = await pool.query(attrSql, [ids]);
  const visible = (attrs.rows ?? []).filter(
    (r: any) => !isHiddenAttributeName(r.attribute_code) && !isHiddenAttributeName(r.attribute_name),
  );
  const byId = new Map<string, any[]>();
  for (const a of visible) {
    const arr = byId.get(a.entity_id) ?? [];
    arr.push({ code: a.attribute_code, name: a.attribute_name, value: a.value_json });
    byId.set(a.entity_id, arr);
  }
  const rows = heads.map((h: any) => ({ id: h.id, attributes: byId.get(h.id) ?? [] }));
  return jsonResult(rows);
}

async function getOrganizationStructure(input: Record<string, unknown>): Promise<ToolResult> {
  const includeEmpty = input.includeEmpty !== false;
  const [workshopsResult, departmentsResult, employeeAttrsResult] = await Promise.all([
    pool.query(
      'select id, code, name, is_active, display_order from directory_workshops ' +
        'where deleted_at is null order by display_order asc, name asc',
    ),
    pool.query(
      "select e.id, av.value_json as name_json from entities e " +
        "join entity_types t on t.id = e.type_id and t.code = 'department' " +
        "left join attribute_defs d on d.entity_type_id = t.id and d.code in ('name','title') and d.deleted_at is null " +
        'left join attribute_values av on av.entity_id = e.id and av.attribute_def_id = d.id and av.deleted_at is null ' +
        'where e.deleted_at is null order by av.value_json asc nulls last',
    ),
    pool.query(
      "select e.id as entity_id, d.code, av.value_json from entities e " +
        "join entity_types t on t.id = e.type_id and t.code = 'employee' " +
        "left join (attribute_values av join attribute_defs d on d.id = av.attribute_def_id " +
        "and d.deleted_at is null and d.code in ('department_id','workshop_id','employment_status','termination_date')) " +
        'on av.entity_id = e.id and av.deleted_at is null ' +
        'where e.deleted_at is null',
    ),
  ]);

  const employeeAttrs = new Map<string, Record<string, unknown>>();
  for (const row of employeeAttrsResult.rows ?? []) {
    const id = String(row.entity_id ?? '');
    const attrs = employeeAttrs.get(id) ?? {};
    const code = String(row.code ?? '');
    if (code) attrs[code] = decodeAttributeValue(row.value_json);
    employeeAttrs.set(id, attrs);
  }
  const counts = new Map<string, { employees: number; workingEmployees: number; firedEmployees: number }>();
  let unassignedEmployees = 0;
  for (const attrs of employeeAttrs.values()) {
    const structureId = String(attrs.workshop_id ?? attrs.department_id ?? '').trim();
    if (!structureId) {
      unassignedEmployees += 1;
      continue;
    }
    const fired = String(attrs.employment_status ?? '').trim().toLowerCase() === 'fired' || attrs.termination_date != null;
    const current = counts.get(structureId) ?? { employees: 0, workingEmployees: 0, firedEmployees: 0 };
    current.employees += 1;
    if (fired) current.firedEmployees += 1;
    else current.workingEmployees += 1;
    counts.set(structureId, current);
  }
  const emptyCount = { employees: 0, workingEmployees: 0, firedEmployees: 0 };
  const workshops = (workshopsResult.rows ?? [])
    .map((row: any) => ({
      kind: 'workshop',
      code: String(row.code ?? ''),
      name: String(row.name ?? ''),
      isActive: row.is_active !== false,
      ...(counts.get(String(row.id)) ?? emptyCount),
    }))
    .filter((row) => includeEmpty || row.employees > 0);
  const departments = (departmentsResult.rows ?? [])
    .map((row: any) => ({
      kind: 'department',
      name: String(decodeAttributeValue(row.name_json) ?? '').trim() || '(без названия)',
      ...(counts.get(String(row.id)) ?? emptyCount),
    }))
    .filter((row) => includeEmpty || row.employees > 0);
  return jsonResult({ workshops, departments, unassignedEmployees });
}

async function getContracts(input: Record<string, unknown>): Promise<ToolResult> {
  // B2: строгая erp_contracts — триггерное зеркало EAV (миграция 0084), непустая.
  const counterpartyId = asString(input, 'counterpartyId').trim();
  const search = asString(input, 'search').trim();
  const limit = asLimit(input);
  const conds: string[] = ['deleted_at is null'];
  const params: unknown[] = [];
  if (counterpartyId) {
    params.push(counterpartyId);
    conds.push(`customer_id = $${params.length}::uuid`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    conds.push(
      `(lower(coalesce(number, '')) like $${params.length} ` +
        `or lower(coalesce(internal_number, '')) like $${params.length} ` +
        `or lower(coalesce(goz_name, '')) like $${params.length} ` +
        `or lower(coalesce(sections_json, '')) like $${params.length})`,
    );
  }
  const sql =
    'select id, number, internal_number, goz_name, goz_igk, signed_at, due_at, customer_id, comment ' +
    `from erp_contracts where ${conds.join(' and ')} order by signed_at desc nulls last limit ${limit}`;
  const res = await pool.query(sql, params as any[]);
  return jsonResult(sanitizeRows(res.rows ?? []));
}

async function getOperations(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const engineId = asString(input, 'engineId').trim();
  const operationType = asString(input, 'operationType').trim();
  const status = asString(input, 'status').trim();
  const limit = asLimit(input);
  const conds: string[] = ['deleted_at is null'];
  const params: unknown[] = [];
  if (engineId) {
    params.push(engineId);
    conds.push(`engine_entity_id = $${params.length}`);
  }
  if (operationType) {
    params.push(operationType);
    conds.push(`operation_type = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conds.push(`status = $${params.length}`);
  }
  const sql =
    'select id, engine_entity_id, operation_type, status, note, performed_at, performed_by, created_at ' +
    `from operations where ${conds.join(' and ')} order by performed_at desc nulls last limit ${limit}`;
  const res = await pool.query(sql, params as any[]);
  let rows = (res.rows ?? []) as Array<Record<string, unknown>>;
  // Restricted work-order isolation (C1): never expose another person's restricted work
  // orders (Ramzia) to a non-allowlisted actor via the assistant. Mirrors the sync/report
  // gates; the operationType filter can target work_order, so this must run regardless.
  const restricted = await getRestrictedWorkOrderIds();
  if (restricted.size > 0 && !(await isAllowlistedReaderById(ctx.actorId))) {
    rows = rows.filter((r) => !restricted.has(String(r.id ?? '')));
  }
  return jsonResult(sanitizeRows(rows));
}

async function queryDiagnosticsSnapshots(input: Record<string, unknown>): Promise<ToolResult> {
  const scope = asString(input, 'scope').trim();
  const sinceHours = Math.max(1, Math.min(Number(input.sinceHours ?? 24), 24 * 30));
  const limit = asLimit(input);
  const since = Date.now() - sinceHours * 3600_000;
  const conds: string[] = ['created_at >= $1'];
  const params: unknown[] = [since];
  if (scope) {
    params.push(scope);
    conds.push(`scope = $${params.length}`);
  }
  const sql =
    'select id, scope, client_id, payload_json, created_at ' +
    `from diagnostics_snapshots where ${conds.join(' and ')} order by created_at desc limit ${limit}`;
  const res = await pool.query(sql, params as any[]);
  return jsonResult(res.rows ?? []);
}

function normalizeSql(sql: string) {
  return String(sql ?? '').trim().replace(/\s+/g, ' ');
}

function extractTables(sql: string): string[] {
  const tables: string[] = [];
  const re = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) if (m[1]) tables.push(m[1].toLowerCase());
  return Array.from(new Set(tables));
}

export function buildAllowedTablesFromPerms(perms: Record<string, boolean>): Set<string> {
  const allowed = new Set<string>();
  if (perms['masterdata.view']) {
    allowed.add('entity_types');
    allowed.add('attribute_defs');
  }
  if (perms['engines.view'] || perms['parts.view'] || perms['employees.view']) {
    allowed.add('entities');
    allowed.add('attribute_values');
    allowed.add('entity_types');
    allowed.add('attribute_defs');
  }
  if (perms['operations.view']) allowed.add('operations');
  if (perms['parts.view']) {
    allowed.add('directory_parts');
  }
  if (perms['parts.view'] || perms['engines.view']) {
    allowed.add('erp_nomenclature');
    allowed.add('erp_reg_stock_balance');
    allowed.add('erp_reg_stock_movements');
    allowed.add('directory_engine_brands');
    allowed.add('directory_goods');
    allowed.add('directory_services');
    allowed.add('directory_tools');
  }
  if (perms['employees.view']) {
    allowed.add('directory_workshops');
  }
  if (perms['masterdata.view']) allowed.add('directory_workshops');
  if (perms['supply_requests.view'] || perms['work_orders.view']) allowed.add('operations');
  if (perms['files.view']) allowed.add('file_assets');
  // B2: erp_contracts / erp_counterparties возвращены в allowlist — с миграции 0084 это
  // триггерные зеркала EAV с реальными данными. erp_employee_cards остаётся вне
  // (пустая до этапа 3), erp_reg_contract_settlement дропнута (0082).
  if (perms['reports.view']) {
    allowed.add('erp_contracts');
    allowed.add('erp_counterparties');
    allowed.add('erp_document_headers');
    allowed.add('erp_document_lines');
    allowed.add('erp_journal_documents');
    allowed.add('erp_reg_stock_balance');
    allowed.add('erp_reg_stock_movements');
  }
  return allowed;
}

async function executeSafeSql(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rawSql = asString(input, 'sql');
  if (!rawSql) return { content: 'Параметр sql обязателен.', isError: true };
  const normalized = normalizeSql(rawSql);
  if (!/^select\s/i.test(normalized))
    return { content: 'Разрешены только SELECT-запросы.', isError: true };
  if (normalized.includes(';'))
    return { content: 'Нельзя выполнять несколько SQL-операторов.', isError: true };
  if (FORBIDDEN_SQL.test(normalized))
    return { content: 'Обнаружено запрещённое ключевое слово SQL.', isError: true };
  if (normalized.includes('--') || normalized.includes('/*'))
    return { content: 'Комментарии в SQL недопустимы.', isError: true };
  const hidden = findForbiddenIdentifiers(normalized);
  if (hidden.length > 0) {
    return {
      content: `Запрос обращается к защищённым идентификаторам: ${hidden.join(', ')}.`,
      isError: true,
    };
  }
  const tables = extractTables(normalized);
  const allowed = buildAllowedTablesFromPerms(ctx.permissions ?? {});
  for (const t of tables) {
    if (HIDDEN_TABLES.includes(t)) return { content: `Таблица недоступна: ${t}.`, isError: true };
    if (!allowed.has(t)) return { content: `Нет прав на таблицу: ${t}.`, isError: true };
  }
  let finalSql = normalized;
  if (!/\blimit\b/i.test(finalSql)) finalSql = `${finalSql} LIMIT ${MAX_ROWS}`;
  const res = await pool.query(finalSql, []);
  const sanitized = sanitizeRows(res.rows ?? []);
  const filtered = sanitized.map((row) => {
    const out = { ...row };
    for (const col of Object.keys(out)) {
      if (HIDDEN_COLUMNS.includes(col.toLowerCase())) (out as any)[col] = '[hidden]';
    }
    return out;
  });
  return jsonResult(filtered);
}

// ---- Отчёты (этап 7 пакета 19.08б): каталог пресетов, подбор, статистика ----

const REPORT_TITLE_BY_ID = new Map(REPORT_PRESET_DEFINITIONS.map((d) => [String(d.id), d.title]));

function reportPresetBrief(d: (typeof REPORT_PRESET_DEFINITIONS)[number]) {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    themes: REPORT_PRESET_THEMES[d.id] ?? [],
    filters: d.filters.map((f) => ('key' in f ? { key: (f as { key: string }).key, label: (f as { label?: string }).label ?? '' } : null)).filter(Boolean),
  };
}

async function listReportPresets(input: Record<string, unknown>): Promise<ToolResult> {
  const search = String(input.search ?? '').trim().toLowerCase();
  let items = REPORT_PRESET_DEFINITIONS.map(reportPresetBrief);
  if (search) {
    items = items.filter((x) => `${x.id} ${x.title} ${x.description}`.toLowerCase().includes(search));
  }
  return jsonResult({
    presets: items,
    hint: 'Чтобы дать пользователю кнопку открытия отчёта, вставь в свой ответ маркер вида [report:<id>] (например [report:engines]) — клиент отрисует его кнопкой «Открыть отчёт».',
  });
}

async function suggestReport(input: Record<string, unknown>): Promise<ToolResult> {
  const task = String(input.task ?? '').trim().toLowerCase();
  if (!task) return { content: 'Опиши задачу пользователя в поле task.', isError: true };
  const words = task.split(/[^a-zа-яё0-9]+/i).filter((w) => w.length >= 3);
  const scored = REPORT_PRESET_DEFINITIONS.map((d) => {
    const hay = `${d.title} ${d.description} ${d.filters.map((f) => ('label' in f ? (f as { label?: string }).label ?? '' : '')).join(' ')}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += 1;
    return { d, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (scored.length === 0) {
    return jsonResult({ suggestions: [], hint: 'Совпадений нет — возьми полный каталог через list_report_presets.' });
  }
  return jsonResult({
    suggestions: scored.map((x) => ({ ...reportPresetBrief(x.d), matchScore: x.score })),
    hint: 'Предложи пользователю лучший вариант и вставь в ответ маркер [report:<id>] — клиент отрисует его кнопкой «Открыть отчёт».',
  });
}

async function getReportUsage(input: Record<string, unknown>): Promise<ToolResult> {
  const days = Math.min(365, Math.max(1, Number(input.days ?? 30) || 30));
  const limit = Math.min(40, Math.max(1, Number(input.limit ?? 10) || 10));
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  // payload_json -> label = id пресета (пишется клиентом в ui.report_open / ui.report_build).
  const res = await pool.query(
    `SELECT payload_json::jsonb->>'label' AS preset_id, action, COUNT(*)::int AS cnt
       FROM audit_log
      WHERE action IN ('ui.report_open','ui.report_build')
        AND deleted_at IS NULL
        AND created_at >= $1
        AND payload_json LIKE '{%'
      GROUP BY 1, 2
      ORDER BY cnt DESC
      LIMIT 200`,
    [sinceMs],
  );
  const byPreset = new Map<string, { presetId: string; title: string; opens: number; builds: number }>();
  for (const row of (res.rows ?? []) as Array<{ preset_id: string | null; action: string; cnt: number }>) {
    const rawId = String(row.preset_id ?? '').trim();
    if (!rawId) continue;
    const presetId = resolveReportPresetId(rawId);
    const entry = byPreset.get(presetId) ?? {
      presetId,
      title: REPORT_TITLE_BY_ID.get(presetId) ?? rawId,
      opens: 0,
      builds: 0,
    };
    if (row.action === 'ui.report_open') entry.opens += Number(row.cnt) || 0;
    else entry.builds += Number(row.cnt) || 0;
    byPreset.set(presetId, entry);
  }
  const items = [...byPreset.values()].sort((a, b) => b.opens + b.builds - (a.opens + a.builds)).slice(0, limit);
  return jsonResult({ days, usage: items });
}

const TOOLS: Record<string, ToolEntry> = {
  query_nomenclature: {
    def: {
      name: 'query_nomenclature',
      description:
        'Поиск номенклатуры (детали, услуги, товары) по названию или артикулу. ' +
        'Возвращает id, name, sku, unit, category, kind, engine_brand_id.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Подстрока для поиска по имени/артикулу.' },
          limit: { type: 'integer', description: 'Максимум строк (1..200, default 50).' },
        },
      },
    },
    requires: ['parts.view', 'engines.view', 'masterdata.view'],
    handler: (input) => queryNomenclature(input),
  },
  get_stock_balances: {
    def: {
      name: 'get_stock_balances',
      description: 'Остатки на складах по номенклатуре. Можно фильтровать по nomenclatureId или warehouseId.',
      input_schema: {
        type: 'object',
        properties: {
          nomenclatureId: { type: 'string', description: 'UUID номенклатуры.' },
          warehouseId: { type: 'string', description: 'UUID склада.' },
          search: { type: 'string', description: 'Подстрока по имени/артикулу номенклатуры.' },
          limit: { type: 'integer' },
        },
      },
    },
    requires: ['parts.view', 'engines.view'],
    handler: (input) => getStockBalances(input),
  },
  get_inventory_forecast: {
    def: {
      name: 'get_inventory_forecast',
      description:
        'Прогноз сборки двигателей: какие детали нужны, чего не хватит. ' +
        'Параметры: horizonDays (1..31, default 7), targetEnginesPerDay (default 2), engineBrandIds[], warehouseIds[].',
      input_schema: {
        type: 'object',
        properties: {
          horizonDays: { type: 'integer', description: '1..31, default 7' },
          targetEnginesPerDay: { type: 'integer' },
          sameBrandBatchSize: { type: 'integer' },
          engineBrandIds: { type: 'array', items: { type: 'string' } },
          warehouseIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    requires: ['parts.view', 'engines.view', 'reports.view'],
    handler: (input) => getInventoryForecast(input),
  },
  get_engine_brands: {
    def: {
      name: 'get_engine_brands',
      description: 'Список марок двигателей из справочника.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
    requires: ['masterdata.view', 'engines.view'],
    handler: (input) => getEngineBrands(input),
  },
  get_engine_details: {
    def: {
      name: 'get_engine_details',
      description: 'Карточка двигателя по UUID: тип + все видимые атрибуты EAV.',
      input_schema: {
        type: 'object',
        properties: {
          engineId: { type: 'string', description: 'UUID двигателя.' },
        },
        required: ['engineId'],
      },
    },
    requires: ['engines.view'],
    handler: (input) => getEngineDetails(input),
  },
  find_entity: {
    def: {
      name: 'find_entity',
      description:
        'Нечёткий поиск сущности по имени/номеру: заказчики, контрагенты, двигатели, сотрудники, детали. ' +
        'Понимает сокращения, подстроки и опечатки («ОВК» найдёт ООО «ОВК»). ВСЕГДА вызывай этот tool, ' +
        'если названная пользователем сущность не нашлась точным запросом — прежде чем отвечать «не существует». ' +
        'Параметр type (опционально): customer, engine, employee, part, erp_counterparty.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Имя/номер как написал пользователь.' },
          type: { type: 'string', description: 'Тип сущности, если известен.' },
          limit: { type: 'integer', description: 'Максимум кандидатов (default 25).' },
        },
        required: ['query'],
      },
    },
    requires: ['engines.view', 'employees.view', 'parts.view', 'reports.view'],
    handler: (input) => findEntity(input),
  },
  get_reclamations: {
    def: {
      name: 'get_reclamations',
      description:
        'Рекламации по двигателям: дата приёма, причина заказчика, вердикт, статус ремонта, отгрузка, ' +
        'контрагент и контракт. Рекламации хранятся атрибутами reclamation_* на двигателе — отдельной ' +
        'таблицы claims НЕТ, используй этот tool. Фильтр counterparty — подстрока имени контрагента (например «ОВК»).',
      input_schema: {
        type: 'object',
        properties: {
          counterparty: { type: 'string', description: 'Подстрока имени контрагента-заказчика.' },
          limit: { type: 'integer', description: 'Максимум строк (1..200, default 50).' },
        },
      },
    },
    requires: ['engines.view'],
    handler: (input) => getReclamations(input),
  },
  get_employees_list: {
    def: {
      name: 'get_employees_list',
      description:
        'Список сотрудников с базовыми атрибутами. ' +
        'Чувствительные поля (зарплата, паспорт, ИНН, СНИЛС) скрыты.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
    requires: ['employees.view'],
    handler: (input) => getEmployeesList(input),
  },
  get_organization_structure: {
    def: {
      name: 'get_organization_structure',
      description:
        'Официальная структура предприятия: цеха из directory_workshops и подразделения из справочника department. ' +
        'Возвращает названия, коды цехов, активность и количество работающих/уволенных сотрудников. ' +
        'Используй для вопросов о списке цехов, подразделений и численности; не показывай UUID пользователю.',
      input_schema: {
        type: 'object',
        properties: {
          includeEmpty: { type: 'boolean', description: 'Включать структуры без сотрудников; по умолчанию true.' },
        },
      },
    },
    requires: ['employees.view', 'masterdata.view', 'reports.view'],
    handler: (input) => getOrganizationStructure(input),
  },
  get_contracts: {
    def: {
      name: 'get_contracts',
      description:
        'Список договоров (поиск по номеру контракта, внутреннему номеру «20/ГОЗ-25», наименованию ГОЗ и номерам ДС; фильтр по контрагенту).',
      input_schema: {
        type: 'object',
        properties: {
          counterpartyId: { type: 'string' },
          search: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
    requires: ['reports.view', 'erp.cards.view'],
    handler: (input) => getContracts(input),
  },
  get_operations: {
    def: {
      name: 'get_operations',
      description: 'Операции по двигателям: приёмка, дефектовка, ремонт, тест и т.д.',
      input_schema: {
        type: 'object',
        properties: {
          engineId: { type: 'string' },
          operationType: { type: 'string' },
          status: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
    requires: ['operations.view'],
    handler: (input, ctx) => getOperations(input, ctx),
  },
  query_diagnostics_snapshots: {
    def: {
      name: 'query_diagnostics_snapshots',
      description:
        'Поиск в диагностических снимках (логах AI / критических событий). ' +
        'Только для администраторов.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Например ai_agent_assist.' },
          sinceHours: { type: 'integer', description: 'Сколько часов назад смотреть.' },
          limit: { type: 'integer' },
        },
      },
    },
    requires: ['admin.users.manage'],
    handler: (input) => queryDiagnosticsSnapshots(input),
  },
  execute_safe_sql: {
    def: {
      name: 'execute_safe_sql',
      description:
        'Выполнить произвольный SELECT-запрос (PostgreSQL, LIMIT 200) ' +
        'если других tools не хватает. Запрещены write-операции, комментарии, ' +
        'обращения к refresh_tokens, ledger_data_keys, password_hash и пр. ' +
        '⚠️ ОБЯЗАТЕЛЬНО: удаление в этой базе — мягкое. В КАЖДОМ запросе к ' +
        'entities / attribute_values / attribute_defs ставь `deleted_at is null` ' +
        'на каждую таблицу, иначе в ответ попадут УДАЛЁННЫЕ записи и ты доложишь ' +
        'их как действующие данные учёта. Так родился ложный доклад «у договора ' +
        'есть дубль» (2026-08-17): «дубль» был удалён ещё 2026-03-19, а запрос ' +
        'этого не отфильтровал. Если удалённые нужны намеренно — скажи об этом в ' +
        'ответе прямо. ' +
        'Подсказки по схеме: контрагенты — таблица erp_counterparties, договоры — erp_contracts ' +
        '(строгие зеркала EAV с реальными данными; у договора колонки number/internal_number/goz_name, ' +
        'секции и платежи — JSON в sections_json/payments_json); ' +
        'договор опознаётся НОМЕРОМ, а не именем: атрибуты `number` (длинный ' +
        'казённый номер) и `internal_number` («20/ГОЗ-25»), поле `name` у него ' +
        'отсутствует; двигатель ссылается на договор атрибутом `contract_id`; ' +
        'рекламации — НЕ таблица claims, а атрибуты reclamation_* двигателя (tool get_reclamations); ' +
        'двигатели/детали/сотрудники — EAV: entities + attribute_values + attribute_defs.',
      input_schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Один SELECT-запрос без точек с запятой.' },
        },
        required: ['sql'],
      },
    },
    requires: ['masterdata.view', 'reports.view', 'engines.view'],
    handler: (input, ctx) => executeSafeSql(input, ctx),
  },
  get_parts_demand_priority: {
    def: {
      name: 'get_parts_demand_priority',
      description:
        'Приоритеты ремонта по деталям: где qty в ремфонде (repair_fund) ниже прогнозируемой потребности сборки. ' +
        'Сортирует по дефициту убывающе. Параметры: horizonDays (1..31, default 7), engineBrandIds[].',
      input_schema: {
        type: 'object',
        properties: {
          horizonDays: { type: 'integer', description: '1..31, default 7' },
          engineBrandIds: { type: 'array', items: { type: 'string' } },
          limit: { type: 'integer' },
        },
      },
    },
    requires: ['parts.view', 'engines.view', 'reports.view'],
    handler: (input) => getPartsDemandPriority(input),
  },
  get_movement_anomalies: {
    def: {
      name: 'get_movement_anomalies',
      description:
        'Аномалии в журнале движений склада за последние N часов (default 48): ' +
        'серии сторно от одного пользователя, движения вне рабочих часов МСК (08:00-18:00), ' +
        'списания в сборку без привязки к двигателю.',
      input_schema: {
        type: 'object',
        properties: {
          sinceHours: { type: 'integer', description: 'Default 48' },
          limit: { type: 'integer' },
        },
      },
    },
    requires: ['reports.view', 'engines.view'],
    handler: (input) => getMovementAnomalies(input),
  },
  get_workshop_throughput: {
    def: {
      name: 'get_workshop_throughput',
      description:
        'Выработка цеха: сумма qty отремонтированных деталей (movement_type=repair_in) по складу цеха ' +
        '(warehouse_id вида workshop_*) за период. Группировка по цеху и номенклатуре.',
      input_schema: {
        type: 'object',
        properties: {
          workshopWarehouseId: { type: 'string', description: 'Например, workshop_1. Если пусто — все цеха.' },
          fromDateMs: { type: 'integer', description: 'Default — 30 дней назад' },
          toDateMs: { type: 'integer', description: 'Default — сейчас' },
          limit: { type: 'integer' },
        },
      },
    },
    requires: ['reports.view', 'engines.view'],
    handler: (input) => getWorkshopThroughput(input),
  },
  list_report_presets: {
    def: {
      name: 'list_report_presets',
      description:
        'Каталог готовых отчётов программы (пресеты): id, название, описание, темы и фильтры. ' +
        'Используй, когда пользователь спрашивает «какие есть отчёты» или нужного отчёта нет в подсказках suggest_report.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Подстрока по названию/описанию (опционально).' },
        },
      },
    },
    requires: ['reports.view'],
    handler: (input) => listReportPresets(input),
  },
  suggest_report: {
    def: {
      name: 'suggest_report',
      description:
        'Подбор готового отчёта под задачу пользователя («хочу посмотреть, сколько двигателей ушло заказчику за месяц»). ' +
        'Возвращает до 5 подходящих пресетов с фильтрами. В ответ пользователю вставь маркер [report:<id>] — он станет кнопкой открытия.',
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Задача пользователя своими словами.' },
        },
        required: ['task'],
      },
    },
    requires: ['reports.view'],
    handler: (input) => suggestReport(input),
  },
  get_report_usage: {
    def: {
      name: 'get_report_usage',
      description:
        'Статистика использования отчётов по журналу действий (ui.report_open / ui.report_build): ' +
        'какие отчёты открывают и строят чаще всего за период.',
      input_schema: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: 'Период в днях (1..365, default 30).' },
          limit: { type: 'integer', description: 'Сколько строк вернуть (default 10).' },
        },
      },
    },
    requires: ['reports.view'],
    handler: (input) => getReportUsage(input),
  },
};

export const FULL_TOOL_NAMES: ReadonlyArray<string> = Object.keys(TOOLS);

export const COMPACT_TOOL_NAMES: ReadonlyArray<string> = [
  'query_nomenclature',
  'get_stock_balances',
  'get_engine_brands',
  'get_engine_details',
  'get_operations',
  'get_inventory_forecast',
];

export function getToolDefinitions(names: ReadonlyArray<string>): LlmToolDef[] {
  return names
    .map((n) => TOOLS[n]?.def)
    .filter((d): d is LlmToolDef => Boolean(d));
}

async function getPartsDemandPriority(input: Record<string, unknown>): Promise<ToolResult> {
  const horizonDays = Math.min(31, Math.max(1, Number(input.horizonDays ?? 7)));
  const brandIds = Array.isArray(input.engineBrandIds)
    ? input.engineBrandIds.filter((v) => typeof v === 'string').map(String)
    : [];
  const limit = Math.min(MAX_ROWS, Math.max(1, Number(input.limit ?? 50)));

  try {
    const forecast = await computeAssemblyForecastFromServer({
      horizonDays,
      targetEnginesPerDay: 4,
      sameBrandBatchSize: 2,
      ...(brandIds.length > 0 ? { engineBrandIds: brandIds } : {}),
      workingWeekdays: [1, 2, 3, 4, 5, 6],
    });
    if (!('rows' in forecast) || !Array.isArray(forecast.rows)) {
      return jsonResult({ horizonDays, rows: [] });
    }
    type ShortageRow = {
      nomenclatureId: string;
      nomenclatureName: string;
      deficitQty: number;
      reasons: string[];
    };
    const aggByNom = new Map<string, ShortageRow>();
    for (const row of forecast.rows as Array<Record<string, unknown>>) {
      const components = Array.isArray(row.componentDetails) ? (row.componentDetails as Array<Record<string, unknown>>) : [];
      for (const comp of components) {
        const deficit = Number(comp.deficitQty ?? 0);
        if (deficit <= 0) continue;
        const id = String(comp.componentNomenclatureId ?? '');
        if (!id) continue;
        const name = String(comp.componentNomenclatureName ?? '');
        const dayLabel = String(row.dayLabel ?? '');
        const brand = String(row.engineBrand ?? '');
        const cur = aggByNom.get(id) ?? { nomenclatureId: id, nomenclatureName: name, deficitQty: 0, reasons: [] };
        cur.deficitQty += deficit;
        if (cur.reasons.length < 5) cur.reasons.push(`${dayLabel} · ${brand}: дефицит ${deficit} шт`);
        aggByNom.set(id, cur);
      }
    }
    const sorted = Array.from(aggByNom.values())
      .sort((a, b) => b.deficitQty - a.deficitQty)
      .slice(0, limit);
    return jsonResult({ horizonDays, total: sorted.length, rows: sorted });
  } catch (e) {
    return { content: `Ошибка прогноза: ${String(e)}`, isError: true };
  }
}

async function getMovementAnomalies(input: Record<string, unknown>): Promise<ToolResult> {
  const sinceHours = Math.max(1, Math.min(720, Number(input.sinceHours ?? 48)));
  const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
  const limit = Math.min(MAX_ROWS, Math.max(1, Number(input.limit ?? 100)));

  const reversalSql = `
    SELECT performed_by AS user, COUNT(*) AS reversal_count
    FROM erp_reg_stock_movements
    WHERE movement_type LIKE 'reversal_%' AND performed_at >= $1
    GROUP BY performed_by
    HAVING COUNT(*) >= 3
    ORDER BY reversal_count DESC
    LIMIT $2
  `;
  const offHoursSql = `
    SELECT m.id, m.performed_by AS user, m.performed_at,
           m.movement_type, wl.code AS warehouse_id, m.qty, m.nomenclature_id, m.engine_id
    FROM erp_reg_stock_movements m
    LEFT JOIN warehouse_locations wl ON wl.id = m.warehouse_location_id
    WHERE m.performed_at >= $1
      AND (
        EXTRACT(HOUR FROM (to_timestamp(m.performed_at / 1000) AT TIME ZONE 'Europe/Moscow')) < 8
        OR EXTRACT(HOUR FROM (to_timestamp(m.performed_at / 1000) AT TIME ZONE 'Europe/Moscow')) >= 18
      )
    ORDER BY m.performed_at DESC
    LIMIT $2
  `;
  const orphanAssemblyConsumptionSql = `
    SELECT m.id, m.performed_by AS user, m.performed_at, m.movement_type,
           wl.code AS warehouse_id, m.qty, m.nomenclature_id
    FROM erp_reg_stock_movements m
    LEFT JOIN warehouse_locations wl ON wl.id = m.warehouse_location_id
    WHERE m.performed_at >= $1
      AND m.movement_type LIKE 'assembly_consumption_%'
      AND m.engine_id IS NULL
    ORDER BY m.performed_at DESC
    LIMIT $2
  `;

  try {
    const [reversals, offHours, orphans] = await Promise.all([
      pool.query(reversalSql, [sinceMs, limit]),
      pool.query(offHoursSql, [sinceMs, limit]),
      pool.query(orphanAssemblyConsumptionSql, [sinceMs, limit]),
    ]);
    return jsonResult({
      sinceHours,
      reversalSeriesByUser: reversals.rows,
      offHoursMovements: offHours.rows,
      assemblyConsumptionWithoutEngine: orphans.rows,
    });
  } catch (e) {
    return { content: `Ошибка запроса аномалий: ${String(e)}`, isError: true };
  }
}

async function getWorkshopThroughput(input: Record<string, unknown>): Promise<ToolResult> {
  const workshopFilter = typeof input.workshopWarehouseId === 'string' ? String(input.workshopWarehouseId).trim() : '';
  const fromMs = Number(input.fromDateMs ?? Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toMs = Number(input.toDateMs ?? Date.now());
  const limit = Math.min(MAX_ROWS, Math.max(1, Number(input.limit ?? 100)));

  const params: unknown[] = [fromMs, toMs];
  const conditions: string[] = ["m.movement_type = 'repair_in'", 'm.performed_at BETWEEN $1 AND $2'];
  if (workshopFilter) {
    params.push(workshopFilter);
    conditions.push(`wl.code = $${params.length}`);
  } else {
    conditions.push(`wl.code LIKE 'workshop_%'`);
  }
  params.push(limit);
  const sql = `
    SELECT wl.code AS warehouse_id, m.nomenclature_id,
           SUM(m.qty)::int AS qty_repaired, COUNT(*)::int AS records
    FROM erp_reg_stock_movements m
    JOIN warehouse_locations wl ON wl.id = m.warehouse_location_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY wl.code, m.nomenclature_id
    ORDER BY qty_repaired DESC
    LIMIT $${params.length}
  `;
  try {
    const result = await pool.query(sql, params);
    return jsonResult({ fromMs, toMs, ...(workshopFilter ? { workshopWarehouseId: workshopFilter } : {}), rows: result.rows });
  } catch (e) {
    return { content: `Ошибка запроса выработки: ${String(e)}`, isError: true };
  }
}

export async function executeTool(toolUse: LlmToolUse, ctx: ToolContext): Promise<ToolResult> {
  const entry = TOOLS[toolUse.name];
  if (!entry) return { content: `Неизвестный tool: ${toolUse.name}.`, isError: true };
  const requires = entry.requires ?? [];
  if (requires.length > 0) {
    const ok = requires.some((p) => can(ctx, p));
    if (!ok) return denyMessage(requires);
  }
  try {
    return await entry.handler(toolUse.input ?? {}, ctx);
  } catch (err) {
    return { content: `Ошибка tool ${toolUse.name}: ${String(err)}`, isError: true };
  }
}
