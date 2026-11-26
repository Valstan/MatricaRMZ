/**
 * Журнал действий: объект, раздел и путь возврата — ОДНО правило на клиент, сервер и веб-админку.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Подпись строки журнала читает раздел, имя объекта и вид объекта.
 * До 26.11.2026 это было размазано по трём местам: серверный `sectionOf`/`docLabel`
 * (`backend-api/src/services/statisticsAuditService.ts`), клиентский `getDeepLinkPayload`
 * (`electron-app/src/renderer/src/ui/pages/SuperadminAuditPage.tsx`) и подпись
 * (`shared/src/labels/auditAction.ts`). Итог был один: строка журнала не называла объект
 * («Открыл объект, категория прочее»), а ссылка появлялась только у тех строк, где имя
 * и так уже было. Правило одно — здесь; вторую копию не заводим.
 *
 * НАПРАВЛЕНИЕ ИМПОРТА. Файл — лист-потребитель: реестры подписей (`labels/`) он не импортирует
 * (см. верхний комментарий в `humanLabels.ts` — обратный импорт даёт ESM-цикл с молча пустым
 * реестром). Наоборот можно: `labels/auditAction.ts` импортирует этот модуль.
 */
import { sectionLabelForTabKey } from './uiSections.js';

/** Вид объекта журнала — тот же словарь, что и «вид карточки» в программе. */
export type AuditObjectKind =
  | 'engine'
  | 'contract'
  | 'counterparty'
  | 'supply_request'
  | 'part'
  | 'employee'
  | 'tool'
  | 'tool_property'
  | 'masterdata'
  | 'work_order'
  | 'file'
  | 'stock_document'
  | 'engine_brand'
  | 'product'
  | 'service';

/** Раздел (человеческое название), где лежит объект каждого вида. */
export const AUDIT_OBJECT_SECTIONS: Record<AuditObjectKind, string> = {
  engine: 'Двигатели',
  contract: 'Договоры',
  counterparty: 'Контрагенты',
  supply_request: 'Заявки',
  part: 'Детали',
  employee: 'Сотрудники',
  tool: 'Инструменты',
  tool_property: 'Свойства инструментов',
  masterdata: 'Справочники',
  work_order: 'Наряды',
  file: 'Файлы',
  stock_document: 'Документы склада',
  engine_brand: 'Марки двигателей',
  product: 'Товары',
  service: 'Услуги',
};

/**
 * Вид объекта по коду типа сущности (серверный справочник `entity_types.code`) и по
 * имени таблицы-зеркала. Ключи строк — в том виде, в каком их кладёт клиент в `tableName`.
 */
export const AUDIT_OBJECT_KIND_BY_ENTITY_TYPE: Record<string, AuditObjectKind> = {
  engine: 'engine',
  contract: 'contract',
  counterparty: 'counterparty',
  customer: 'counterparty',
  supply_request: 'supply_request',
  part: 'part',
  employee: 'employee',
  tool: 'tool',
  tool_property: 'tool_property',
  masterdata: 'masterdata',
  work_order: 'work_order',
  engine_brand: 'engine_brand',
  product: 'product',
  service: 'service',
};

/** Вид объекта по имени таблицы (строка журнала знает `tableName`). */
export const AUDIT_OBJECT_KIND_BY_TABLE: Record<string, AuditObjectKind> = {
  // `entities` (EAV) сюда НЕ входит: под ним лежат все типы сразу, и вид объекта
  // определяется по типу сущности на сервере, а не по имени таблицы.
  erp_engine_cards: 'engine',
  engine: 'engine',
  engines: 'engine',
  erp_contracts: 'contract',
  contract: 'contract',
  contracts: 'contract',
  erp_counterparties: 'counterparty',
  counterparty: 'counterparty',
  counterparties: 'counterparty',
  customer: 'counterparty',
  customers: 'counterparty',
  directory_parts: 'part',
  part: 'part',
  parts: 'part',
  erp_employee_cards: 'employee',
  employee: 'employee',
  employees: 'employee',
  directory_tools: 'tool',
  tool: 'tool',
  tools: 'tool',
  tool_properties: 'tool_property',
  tool_property: 'tool_property',
  directory_engine_brands: 'engine_brand',
  engine_brand: 'engine_brand',
  erp_document_headers: 'stock_document',
  erp_document_lines: 'stock_document',
  file_assets: 'file',
  files: 'file',
  file: 'file',
  products: 'product',
  product: 'product',
  services: 'service',
  service: 'service',
};

/**
 * Вид объекта по ключу карточки клиента (`TabId`): то, что клиент кладёт в `payload.label`
 * при открытии карточки (`ui.card_open`).
 */
export const AUDIT_OBJECT_KIND_BY_CARD_KEY: Record<string, AuditObjectKind> = {
  engine: 'engine',
  contract: 'contract',
  counterparty: 'counterparty',
  request: 'supply_request',
  supply_request: 'supply_request',
  part: 'part',
  employee: 'employee',
  tool: 'tool',
  tool_property: 'tool_property',
  masterdata: 'masterdata',
  work_order: 'work_order',
  engine_brand: 'engine_brand',
  product: 'product',
  service: 'service',
  files: 'file',
};

/**
 * Раздел по коду действия — по префиксу кода. Пустая строка означает «раздел по коду не
 * определяется» (это НЕ «Прочее»: «Прочее» — это когда раздел не найден вовсе, и подпись
 * с ним читается как «действие не понято»).
 */
const SECTION_BY_ACTION_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ['app.session.', 'Сессия приложения'],
  ['auth.', 'Авторизация'],
  ['ui.engine.', 'Двигатели'],
  ['engine.', 'Двигатели'],
  ['ui.contract.', 'Договоры'],
  ['contract.', 'Договоры'],
  ['ui.counterparty.', 'Контрагенты'],
  ['counterparty.', 'Контрагенты'],
  ['ui.supply_request.', 'Заявки'],
  ['supply_request.', 'Заявки'],
  ['ui.part.', 'Детали'],
  ['part.', 'Детали'],
  ['ui.employee.', 'Сотрудники'],
  ['employee.', 'Сотрудники'],
  ['ui.tool_property.', 'Свойства инструментов'],
  ['tool_property.', 'Свойства инструментов'],
  ['ui.tool.', 'Инструменты'],
  ['tool.', 'Инструменты'],
  ['ui.work_order.', 'Наряды'],
  ['work_order.', 'Наряды'],
  ['ui.masterdata.', 'Справочники'],
  ['masterdata.', 'Справочники'],
  ['admin:', 'Справочники'],
  ['ui.files.', 'Файлы'],
  ['files.', 'Файлы'],
  ['file.', 'Файлы'],
  ['ui.engine_brand.', 'Марки двигателей'],
  ['engine_brand.', 'Марки двигателей'],
  ['ppe.', 'СИЗ'],
  ['warehouse.', 'Склад'],
  ['erp_document.', 'Документы склада'],
  ['stock.', 'Склад'],
  ['sync.', 'Синхронизация'],
  // След окончательного удаления живёт в том же журнале, но в отдельном разделе:
  // объекта уже нет, и «раздел, где он лежит» назвать нечем.
  ['deleted.', 'Удалённое'],
];

/** Раздел по коду действия. '' — раздел по коду не определяется. */
export function auditSectionForAction(action: string): string {
  const a = String(action ?? '').trim().toLowerCase();
  if (!a) return '';
  for (const [prefix, section] of SECTION_BY_ACTION_PREFIX) {
    if (a.startsWith(prefix)) return section;
  }
  return '';
}

/** Раздел по виду объекта. */
export function auditSectionForObjectKind(kind: AuditObjectKind): string {
  return AUDIT_OBJECT_SECTIONS[kind] ?? '';
}

/**
 * Имя объекта из `payload` — то, что клиент уже присылает в строке журнала.
 * Порядок полей = порядок «насколько это однозначно»: номер двигателя и номер заявки
 * важнее наименования (наименование есть почти у всех деталей и не различает их).
 */
export function auditObjectNameFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  const keys = [
    'objectName',
    'engineNumber',
    'requestNumber',
    'contractNumber',
    'workOrderNumber',
    'docNo',
    'engine_number',
    'full_name',
    'fullName',
    'name',
    'fileName',
  ];
  for (const key of keys) {
    const raw = p[key];
    if (raw == null) continue;
    const value = String(raw).trim();
    if (value) return value;
  }
  return '';
}

/**
 * Вид объекта строки журнала: по коду действия, потом по таблице, потом по ключу карточки
 * из `payload.label`. `null` — вид определить не удалось.
 */
export function auditObjectKindForRow(row: {
  action?: string | null;
  tableName?: string | null;
  cardKey?: string | null;
}): AuditObjectKind | null {
  const action = String(row.action ?? '').trim().toLowerCase();
  if (action) {
    const byAction = SECTION_BY_ACTION_PREFIX.find(([prefix]) => action.startsWith(prefix));
    const kind = byAction ? AUDIT_OBJECT_KIND_BY_ENTITY_TYPE[byAction[0].replace(/^(ui\.)?|\.$/g, '')] : undefined;
    if (kind) return kind;
  }
  const table = String(row.tableName ?? '').trim().toLowerCase();
  if (table && AUDIT_OBJECT_KIND_BY_TABLE[table]) return AUDIT_OBJECT_KIND_BY_TABLE[table]!;
  const cardKey = String(row.cardKey ?? '').trim().toLowerCase();
  if (cardKey && AUDIT_OBJECT_KIND_BY_CARD_KEY[cardKey]) return AUDIT_OBJECT_KIND_BY_CARD_KEY[cardKey]!;
  return null;
}

/**
 * Раздел строки журнала по тому, что строка знает: ключ вкладки (для визита раздела),
 * ключ карточки, код действия, таблица. '' — раздел неизвестен.
 */
export function auditSectionForRow(row: {
  action?: string | null;
  tableName?: string | null;
  cardKey?: string | null;
  tabKey?: string | null;
}): string {
  const tabKey = String(row.tabKey ?? '').trim();
  if (tabKey) {
    const label = sectionLabelForTabKey(tabKey);
    if (label && label !== '—') return label;
  }
  const byAction = auditSectionForAction(String(row.action ?? ''));
  if (byAction) return byAction;
  const kind = auditObjectKindForRow(row);
  if (kind) return auditSectionForObjectKind(kind);
  return '';
}

/**
 * Путь возврата объекта: «Двигатели → Д-100». Показывается оператору ДО восстановления,
 * чтобы он видел, что именно вернёт и куда.
 */
export function auditObjectRestorePath(section: string, name: string): string {
  const s = String(section ?? '').trim();
  const n = String(name ?? '').trim();
  if (s && n) return `${s} → ${n}`;
  return s || n || '';
}
