/**
 * Журнал действий: раздел и имя объекта для строки.
 *
 * ЗАЧЕМ. Строка журнала приходила с сервера «без имени»: `documentLabel` знал только
 * `requestNumber`, `engineNumber`, `name` (для деталей) и `docNo`, а раздел считался по
 * префиксу кода действия — из-за чего открытие карточки (`ui.card_open`) попадало в
 * «Прочее», а строка читалась как «Открыл объект, категория прочее» (промт КАРМАНА #169).
 *
 * Правило одно и оно в `shared/src/domain/auditObject.ts` — здесь только ДОСТАВЛЯЕМ
 * недостающее: раздел по типу объекта (сервер знает тип сущности) и имя объекта, если
 * клиент его не прислал.
 *
 * ПОЧЕМУ НЕ ПРАВИТСЯ ПРОШЛОЕ. `statistics_audit_events` наполняется один раз при инжесте
 * (`onConflictDoNothing`), исторические строки не переигрываются никогда — поэтому подпись
 * считается на показе, а здесь мы только обогащаем НОВЫЕ строки.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';

import {
  AUDIT_OBJECT_KIND_BY_ENTITY_TYPE,
  auditObjectKindForRow,
  auditObjectNameFromPayload,
  auditSectionForAction,
  auditSectionForObjectKind,
  sectionLabelForTabKey,
  type AuditObjectKind,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  directoryEngineBrands,
  directoryParts,
  directoryTools,
  entities,
  entityTypes,
  erpContracts,
  erpCounterparties,
  erpDocumentHeaders,
  erpEmployeeCards,
  erpEngineCards,
  fileAssets,
  operations,
} from '../database/schema.js';

/** Атрибуты EAV, из которых берётся имя объекта (первый непустой). */
const NAME_ATTRIBUTE_CODES = ['name', 'number', 'engine_number', 'full_name', 'request_number', 'contract_number'];

export type AuditRowInput = {
  id: string;
  action: string;
  entityId: string | null;
  tableName: string | null;
  payload: unknown;
};

export type AuditObjectInfo = {
  /** Раздел, где лежит объект. '' — раздел определить не удалось. */
  section: string;
  /** Имя объекта (номер двигателя, наименование, ФИО). '' — имени нет. */
  objectName: string;
  /** Вид объекта ('engine' | 'contract' | …). null — вид не определён. */
  objectKind: AuditObjectKind | null;
};

function pickString(payload: unknown, key: string): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = (payload as Record<string, unknown>)[key];
  if (value == null) return '';
  return String(value).trim();
}

/** Тип сущности по id (EAV). Мёртвые строки тоже — их имя журналу тоже нужно. */
async function resolveEntityTypes(ids: string[]): Promise<Map<string, { typeCode: string; typeId: string }>> {
  const map = new Map<string, { typeCode: string; typeId: string }>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: entities.id, typeId: entities.typeId, code: entityTypes.code })
    .from(entities)
    .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
    .where(inArray(entities.id, ids as any));
  for (const row of rows) {
    map.set(String(row.id), { typeCode: String(row.code ?? ''), typeId: String(row.typeId) });
  }
  return map;
}

/** Имя объекта из атрибутов EAV-сущности. */
async function resolveEntityNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ entityId: attributeValues.entityId, code: attributeDefs.code, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .where(inArray(attributeValues.entityId, ids as any));
  for (const row of rows) {
    const id = String(row.entityId);
    if (map.has(id)) continue;
    const code = String(row.code ?? '').trim().toLowerCase();
    if (!NAME_ATTRIBUTE_CODES.includes(code)) continue;
    const raw = row.valueJson == null ? '' : String(row.valueJson);
    const value = raw.trim().replace(/^"|"$/g, '').trim();
    if (value) map.set(id, value);
  }
  return map;
}

/**
 * Имена объектов из строгих таблиц. Одна выборка на таблицу на партию строк — иначе
 * на каждую строку журнала пошёл бы свой запрос.
 */
async function resolveStrictNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const put = (id: unknown, value: unknown) => {
    const name = String(value ?? '').trim();
    if (name) map.set(String(id), name);
  };
  const engineRows = await db
    .select({ id: erpEngineCards.id, engineNumber: erpEngineCards.engineNumber })
    .from(erpEngineCards)
    .where(inArray(erpEngineCards.id, ids as any));
  for (const row of engineRows) put(row.id, row.engineNumber);
  const contractRows = await db
    .select({ id: erpContracts.id, number: erpContracts.number, internalNumber: erpContracts.internalNumber, gozName: erpContracts.gozName })
    .from(erpContracts)
    .where(inArray(erpContracts.id, ids as any));
  for (const row of contractRows) put(row.id, row.number || row.internalNumber || row.gozName);
  const counterpartyRows = await db.select({ id: erpCounterparties.id, name: erpCounterparties.name }).from(erpCounterparties).where(inArray(erpCounterparties.id, ids as any));
  for (const row of counterpartyRows) put(row.id, row.name);
  const employeeRows = await db.select({ id: erpEmployeeCards.id, fullName: erpEmployeeCards.fullName }).from(erpEmployeeCards).where(inArray(erpEmployeeCards.id, ids as any));
  for (const row of employeeRows) put(row.id, row.fullName);
  const partRows = await db.select({ id: directoryParts.id, name: directoryParts.name }).from(directoryParts).where(inArray(directoryParts.id, ids as any));
  for (const row of partRows) put(row.id, row.name);
  const toolRows = await db.select({ id: directoryTools.id, name: directoryTools.name }).from(directoryTools).where(inArray(directoryTools.id, ids as any));
  for (const row of toolRows) put(row.id, row.name);
  const docRows = await db.select({ id: erpDocumentHeaders.id, docNo: erpDocumentHeaders.docNo }).from(erpDocumentHeaders).where(inArray(erpDocumentHeaders.id, ids as any));
  for (const row of docRows) put(row.id, row.docNo);
  const fileRows = await db.select({ id: fileAssets.id, name: fileAssets.name }).from(fileAssets).where(inArray(fileAssets.id, ids as any));
  for (const row of fileRows) put(row.id, row.name);
  return map;
}

/**
 * Раздел, имя и вид объекта для каждой строки партии журнала.
 * Ключ карты — id строки (`audit_log.id`).
 */
export async function resolveAuditObjectInfo(rows: AuditRowInput[]): Promise<Map<string, AuditObjectInfo>> {
  const out = new Map<string, AuditObjectInfo>();
  const entityIds = Array.from(new Set(rows.map((row) => String(row.entityId ?? '')).filter(Boolean)));
  const [typeByEntity, strictNames] = await Promise.all([resolveEntityTypes(entityIds), resolveStrictNames(entityIds)]);
  const entityIdsWithoutStrictName = entityIds.filter((id) => !strictNames.has(id));
  const entityNames = await resolveEntityNames(entityIdsWithoutStrictName);

  for (const row of rows) {
    const cardKey = pickString(row.payload, 'label');
    const tabKey = row.action === 'ui.visit' ? cardKey : '';
    const entityId = String(row.entityId ?? '').trim();

    let section = auditSectionForAction(row.action);
    let objectKind: AuditObjectKind | null = null;

    // Визит вкладки: раздел — из ключа вкладки (клиент шлёт его в payload.label).
    if (!section && tabKey) {
      const label = sectionLabelForTabKey(tabKey);
      if (label && label !== '—') section = label;
    }
    // Тип объекта: сервер знает его по строке `entities` — он и есть раздел.
    const typeInfo = entityId ? typeByEntity.get(entityId) : undefined;
    if (typeInfo?.typeCode) {
      const kind = AUDIT_OBJECT_KIND_BY_ENTITY_TYPE[typeInfo.typeCode];
      if (kind) objectKind = kind;
    }
    if (!objectKind) {
      const kind = auditObjectKindForRow({ action: row.action, tableName: row.tableName, cardKey });
      if (kind) objectKind = kind;
    }
    if (!section && objectKind) section = auditSectionForObjectKind(objectKind as never);

    // Отчёты: отдельный раздел (клиент шлёт id пресета, а не вкладку).
    if (!section && (row.action === 'ui.report_open' || row.action === 'ui.report_build')) section = 'Отчёты';

    let objectName = auditObjectNameFromPayload(row.payload);
    if (!objectName && entityId) {
      objectName = strictNames.get(entityId) ?? entityNames.get(entityId) ?? '';
    }

    out.set(String(row.id), { section, objectName, objectKind });
  }
  return out;
}

/**
 * Мягко удалённые объекты среди строк журнала — по СТРГИМ таблицам.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ ДЖОЙНА С `entities`. Джойн видит только EAV-сущности: там удаление
 * помечается меткой на строке `entities`. А заявки (`operations`), договоры, контрагенты,
 * детали, инструменты, сотрудники, документы склада и файлы лежат в строгих таблицах со
 * своим `deletedAt`, и их id в `entities` не значится. Без этой проверки у удалённого
 * объекта оставалась бы живая ссылка на несуществующую карточку (промт КАРМАНА #169:
 * «у удалённого объекта ссылка отсутствует»).
 *
 * СПОСОБ. Строки журнала знают `tableName` — по нему и берём таблицу, а не перебираем все.
 * Одна выборка на таблицу на всю страницу журнала (иначе на каждую строку пошёл бы свой
 * запрос).
 */
export async function resolveDeletedObjectIds(
  rows: Array<{ entityId: string | null; tableName: string | null }>,
): Promise<Set<string>> {
  const deleted = new Set<string>();
  const idsByTable = new Map<string, string[]>();
  for (const row of rows) {
    const id = String(row.entityId ?? '').trim();
    if (!id) continue;
    const table = String(row.tableName ?? '').trim().toLowerCase();
    if (!STRICT_DELETED_TABLES.has(table)) continue;
    const list = idsByTable.get(table);
    if (list) list.push(id);
    else idsByTable.set(table, [id]);
  }
  for (const [table, ids] of idsByTable) {
    for (const id of await deletedIdsInStrictTable(table, ids)) deleted.add(id);
  }
  return deleted;
}

/**
 * Таблицы, где объект удаляется мягко и лежит НЕ в `entities`. Ключ — `tableName` строки
 * журнала (как его кладёт клиент).
 */
const STRICT_DELETED_TABLES = new Set<string>([
  'operations',
  'erp_contracts',
  'erp_counterparties',
  'erp_engine_cards',
  'erp_employee_cards',
  'directory_parts',
  'directory_tools',
  'directory_engine_brands',
  'erp_document_headers',
  'file_assets',
]);

/** Ids удалённых объектов одной строгой таблицы. */
async function deletedIdsInStrictTable(table: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const list = ids as any;
  if (table === 'operations') {
    const rows = await db
      .select({ id: operations.id })
      .from(operations)
      .where(and(inArray(operations.id, list), isNotNull(operations.deletedAt)));
    return rows.map((row) => String(row.id));
  }
  if (table === 'erp_contracts') {
    const rows = await db
      .select({ id: erpContracts.id })
      .from(erpContracts)
      .where(and(inArray(erpContracts.id, list), isNotNull(erpContracts.deletedAt)));
    return rows.map((row) => String(row.id));
  }
  if (table === 'erp_counterparties') {
    const rows = await db
      .select({ id: erpCounterparties.id })
      .from(erpCounterparties)
      .where(and(inArray(erpCounterparties.id, list), isNotNull(erpCounterparties.deletedAt)));
    return rows.map((row) => String(row.id));
  }
  if (table === 'erp_engine_cards') {
    const rows = await db
      .select({ id: erpEngineCards.id })
      .from(erpEngineCards)
      .where(and(inArray(erpEngineCards.id, list), isNotNull(erpEngineCards.deletedAt)));
    return rows.map((row) => String(row.id));
  }
  if (table === 'erp_employee_cards') {
    const rows = await db
      .select({ id: erpEmployeeCards.id })
      .from(erpEmployeeCards)
      .where(and(inArray(erpEmployeeCards.id, list), isNotNull(erpEmployeeCards.deletedAt)));
    return rows.map((row) => String(row.id));
  }
  if (table === 'directory_parts') {
    const rows = await db
      .select({ id: directoryParts.id })
      .from(directoryParts)
      .where(and(inArray(directoryParts.id, list), isNotNull(directoryParts.deletedAt)));
    return rows.map((row) => String(row.id));
  }
  if (table === 'directory_tools') {
    const rows = await db
      .select({ id: directoryTools.id })
      .from(directoryTools)
      .where(and(inArray(directoryTools.id, list), isNotNull(directoryTools.deletedAt)));
    return rows.map((row) => String(row.id));
  }
  if (table === 'directory_engine_brands') {
    const rows = await db
      .select({ id: directoryEngineBrands.id })
      .from(directoryEngineBrands)
      .where(and(inArray(directoryEngineBrands.id, list), isNotNull(directoryEngineBrands.deletedAt)));
    return rows.map((row) => String(row.id));
  }
  if (table === 'erp_document_headers') {
    const rows = await db
      .select({ id: erpDocumentHeaders.id })
      .from(erpDocumentHeaders)
      .where(and(inArray(erpDocumentHeaders.id, list), isNotNull(erpDocumentHeaders.deletedAt)));
    return rows.map((row) => String(row.id));
  }
  if (table === 'file_assets') {
    const rows = await db
      .select({ id: fileAssets.id })
      .from(fileAssets)
      .where(and(inArray(fileAssets.id, list), isNotNull(fileAssets.deletedAt)));
    return rows.map((row) => String(row.id));
  }
  return [];
}
