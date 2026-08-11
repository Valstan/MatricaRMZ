// Единый реестр разделов UI: TabId/MenuTabId и их русские названия.
// Перенесён из electron-app renderer (ui/layout/Tabs.tsx) в shared, чтобы backend
// (еженедельный дайджест, отчёты ИИваныча) переводил технические ключи вкладок в
// человеческие названия тем же словарём, что и меню клиента — без второй копии канона.
// Renderer реэкспортирует всё отсюда (Tabs.tsx), визуальные пресеты остались там.

export type TabId =
  | 'history'
  | 'engines'
  | 'assembly_forecast'
  | 'engine'
  | 'engine_brands'
  | 'engine_brand'
  | 'engine_brand_groups'
  | 'engine_brand_group'
  | 'counterparties'
  | 'counterparty'
  | 'products'
  | 'product'
  | 'services'
  | 'services_by_brand'
  | 'service'
  | 'nomenclature'
  | 'nomenclature_item'
  | 'parts_dedupe'
  | 'empty_cards'
  | 'drafts'
  | 'stock_balances'
  | 'stock_receipts'
  | 'stock_issues'
  | 'stock_transfers'
  | 'stock_documents'
  | 'stock_document'
  | 'stock_inventory'
  | 'repair_fund_audit'
  | 'warehouse_analytics'
  | 'workshop_stats'
  | 'custom_reports'
  | 'engine_assembly_bom'
  | 'repair_norms'
  | 'engine_assembly_bom_item'
  | 'contracts'
  | 'contract'
  | 'requests'
  | 'request'
  | 'work_orders'
  | 'work_order'
  | 'work_order_templates'
  | 'parts'
  | 'part'
  | 'tools'
  | 'tool_accounting'
  | 'tool'
  | 'tool_properties'
  | 'tool_property'
  | 'employees'
  | 'employee'
  | 'access_sections'
  | 'timesheets'
  | 'timesheet'
  | 'changes'
  | 'auth'
  | 'reports'
  | 'report_preset'
  | 'masterdata'
  | 'workshops'
  | 'warehouses_admin'
  | 'warehouse_locations'
  | 'admin'
  | 'audit'
  | 'notes'
  | 'settings'
  | 'user_screens'
  | 'user_screen';

export type MenuTabId = Exclude<
  TabId,
  | 'engine'
  | 'request'
  | 'work_order'
  | 'part'
  | 'employee'
  | 'contract'
  | 'engine_brand'
  | 'engine_brand_group'
  | 'product'
  | 'service'
  | 'nomenclature_item'
  | 'stock_document'
  | 'counterparty'
  | 'tool'
  | 'tool_property'
  | 'tool_properties'
  | 'report_preset'
  | 'engine_assembly_bom_item'
  | 'timesheet'
  | 'user_screen'
>;

/** Maps detail tabs to their parent menu tab so the correct section button stays highlighted. */
const PARENT_TAB: Record<string, MenuTabId> = {
  engine: 'engines',
  engine_brand: 'engine_brands',
  engine_brand_group: 'engine_brand_groups',
  work_order: 'work_orders',
  part: 'parts',
  tool: 'tools',
  tool_property: 'tools',
  tool_properties: 'tools',
  employee: 'employees',
  contract: 'contracts',
  counterparty: 'counterparties',
  product: 'nomenclature',
  service: 'nomenclature',
  nomenclature_item: 'nomenclature',
  stock_document: 'stock_documents',
  engine_assembly_bom_item: 'engine_assembly_bom',
  request: 'requests',
  report_preset: 'reports',
  timesheet: 'timesheets',
  user_screen: 'user_screens',
};

// Pre-computed set for O(1) lookup
const menuTabSet = new Set<MenuTabId>([
  'history',
  'masterdata',
  'contracts',
  'changes',
  'engines',
  'assembly_forecast',
  'engine_brands',
  'engine_brand_groups',
  'counterparties',
  'requests',
  'work_orders',
  'work_order_templates',
  'parts',
  'tools',
  'tool_accounting',
  'products',
  'services',
  'services_by_brand',
  'nomenclature',
  'parts_dedupe',
  'stock_balances',
  'stock_documents',
  'stock_receipts',
  'stock_issues',
  'stock_transfers',
  'stock_inventory',
  'repair_fund_audit',
  'warehouse_analytics',
  'workshop_stats',
  'engine_assembly_bom',
  'repair_norms',
  'employees',
  'timesheets',
  'access_sections',
  'reports',
  'custom_reports',
  'audit',
  // empty_cards/drafts отсутствовали в реестре renderer'а — их визиты оставались бы
  // непереведёнными ключами в статистике, хотя это обычные пункты меню «Контроль».
  'empty_cards',
  'drafts',
  'admin',
  'auth',
  'notes',
  'settings',
  'workshops',
  'warehouses_admin',
  'warehouse_locations',
  'user_screens',
]);

export function resolveMenuTab(tab: string): MenuTabId | null {
  const parent = PARENT_TAB[tab];
  if (parent) return parent;
  return menuTabSet.has(tab as MenuTabId) ? (tab as MenuTabId) : null;
}

export type MenuGroupId =
  | 'history'
  | 'production'
  | 'supply'
  | 'warehouse'
  | 'business'
  | 'people'
  | 'control';

export const GROUP_LABELS: Record<MenuGroupId, string> = {
  history: 'Мой круг',
  production: 'Производство',
  supply: 'Снабжение',
  warehouse: 'Склад',
  business: 'Договоры и контрагенты',
  people: 'Персонал и доступ',
  control: 'Контроль и аналитика',
};

export const MENU_TAB_LABELS: Record<MenuTabId, string> = {
  history: 'Мой круг',
  user_screens: 'Мои экраны',
  masterdata: 'Справочники',
  contracts: 'Контракты',
  changes: 'Изменения',
  engines: 'Двигатели',
  assembly_forecast: 'Прогноз сборки',
  engine_brands: 'Марки двигателей',
  engine_brand_groups: 'Группы марок',
  counterparties: 'Контрагенты',
  requests: 'Заявки',
  work_orders: 'Наряды',
  work_order_templates: 'Шаблоны нарядов',
  parts: 'Детали',
  tools: 'Инструменты',
  tool_accounting: 'Учёт инструментов',
  products: 'Товары',
  services: 'Услуги',
  services_by_brand: 'Услуги по маркам',
  nomenclature: 'Номенклатура',
  parts_dedupe: 'Дубли номенклатуры',
  engine_assembly_bom: 'BOM двигателей',
  repair_norms: 'Нормы ремонта',
  stock_balances: 'Остатки',
  stock_documents: 'Документы',
  stock_receipts: 'Приход',
  stock_issues: 'Расход',
  stock_transfers: 'Перемещения',
  stock_inventory: 'Инвентаризация',
  repair_fund_audit: 'Ревизия ремфонда',
  warehouse_analytics: 'Аналитика выпуска',
  workshop_stats: 'Статистика цехов',
  employees: 'Сотрудники',
  timesheets: 'Табель',
  access_sections: 'Доступы по разделам',
  reports: 'Отчёты',
  custom_reports: 'Мои отчёты',
  audit: 'Журнал',
  empty_cards: 'Пустые карточки',
  drafts: 'Черновики',
  admin: 'Админ',
  auth: 'Вход',
  notes: 'Заметки',
  settings: 'Настройки',
  workshops: 'Цеха',
  warehouses_admin: 'Склады и цеха',
  warehouse_locations: 'Локации',
};

export const DEFAULT_GROUP_ORDER: MenuGroupId[] = ['history', 'production', 'supply', 'warehouse', 'business', 'people', 'control'];
export const DEFAULT_GROUP_TABS: Record<MenuGroupId, MenuTabId[]> = {
  history: ['history', 'user_screens'],
  production: ['engines', 'assembly_forecast', 'engine_brands', 'engine_brand_groups', 'parts', 'engine_assembly_bom', 'repair_norms', 'tools'],
  supply: ['requests', 'work_orders', 'work_order_templates', 'services', 'services_by_brand', 'tool_accounting'],
  warehouse: ['nomenclature', 'parts_dedupe', 'stock_balances', 'warehouse_locations', 'stock_documents', 'stock_receipts', 'stock_issues', 'stock_transfers', 'stock_inventory', 'repair_fund_audit', 'warehouse_analytics'],
  business: ['contracts', 'counterparties'],
  people: ['employees', 'timesheets', 'access_sections'],
  control: ['reports', 'custom_reports', 'changes', 'audit', 'notes', 'masterdata', 'workshops', 'workshop_stats', 'warehouses_admin', 'empty_cards', 'drafts', 'admin'],
};

export function groupForTab(tab: MenuTabId): MenuGroupId {
  for (const groupId of DEFAULT_GROUP_ORDER) {
    if (DEFAULT_GROUP_TABS[groupId].includes(tab)) return groupId;
  }
  return 'control';
}

/**
 * Человеческое название раздела по техническому ключу вкладки (включая detail-вкладки
 * через PARENT_TAB). Незнакомый ключ возвращается в кавычках как есть — оператор из
 * статистики не должен пропадать молча, даже если ключ ещё не в словаре.
 */
export function sectionLabelForTabKey(key: string): string {
  const raw = String(key ?? '').trim();
  if (!raw) return '—';
  const menuTab = resolveMenuTab(raw);
  if (menuTab) return MENU_TAB_LABELS[menuTab];
  return `«${raw}»`;
}
