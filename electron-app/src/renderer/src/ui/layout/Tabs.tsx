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
export type TabsLayoutPrefs = {
  order?: MenuTabId[];
  hidden?: MenuTabId[];
  trashIndex?: number | null;
  groupOrder?: MenuGroupId[];
  hiddenGroups?: MenuGroupId[];
  collapsedGroups?: MenuGroupId[];
  activeGroup?: MenuGroupId | null;
};

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

export const DEFAULT_GROUP_ORDER: MenuGroupId[] =['history', 'production', 'supply', 'warehouse', 'business', 'people', 'control'];
export const DEFAULT_GROUP_TABS: Record<MenuGroupId, MenuTabId[]> = {
  history: ['history', 'user_screens'],
  production: ['engines', 'assembly_forecast', 'engine_brands', 'engine_brand_groups', 'parts', 'engine_assembly_bom', 'repair_norms', 'tools'],
  supply: ['requests', 'work_orders', 'work_order_templates', 'services', 'services_by_brand', 'tool_accounting'],
  warehouse: ['nomenclature', 'parts_dedupe', 'stock_balances', 'warehouse_locations', 'stock_documents', 'stock_receipts', 'stock_issues', 'stock_transfers', 'stock_inventory', 'repair_fund_audit', 'warehouse_analytics'],
  business: ['contracts', 'counterparties'],
  people: ['employees', 'timesheets', 'access_sections'],
  control: ['reports', 'custom_reports', 'changes', 'audit', 'notes', 'masterdata', 'workshops', 'workshop_stats', 'warehouses_admin', 'empty_cards', 'drafts', 'admin'],
};

/**
 * Планшетное операторское меню (Ф-later #2, решение владельца 2026-07-23):
 * «двигатели и всё, что с ними связано». В цеху оператору нужны объект работы
 * (двигатель), задание (наряд), справочники для дефектовки, наличие на складе и
 * возможность заказать недостающее — бухгалтерия, кадры и админка только мешают
 * на маленьком экране.
 *
 * Это НЕ права доступа: пресет сужает меню, пока машина в режиме «Планшет», и
 * снимается кнопкой «Комп» на той же машине. Сохранённая раскладка меню при этом
 * не трогается — иначе возврат в режим «Комп» приходил бы с урезанным меню.
 */
/**
 * Android-планшет (Ф2 порта, рамка владельца 2026-08-02): Двигатели, Наряды,
 * Документы склада, Ремфонд. Уже TABLET_OPERATOR_TABS (стартовый пресет носимого
 * клиента; разделы добавляются «по ходу пьесы» — включить страницу + доложить
 * методы моста). Применяется по платформе (isAndroidPlatform), а не по UI-режиму:
 * это свойство клиента, а не рабочего места.
 */
export const ANDROID_TABS: readonly MenuTabId[] = [
  'engines',
  'work_orders',
  'stock_documents',
  'repair_fund_audit',
];

export const TABLET_OPERATOR_TABS: readonly MenuTabId[] = [
  'engines',
  'work_orders',
  'parts',
  'engine_brands',
  'engine_assembly_bom',
  'repair_norms',
  'stock_balances',
  // Документы склада — в рамке владельца (ANDROID_TABS) и обязаны быть у оператора-планшетника.
  'stock_documents',
  'requests',
  'repair_fund_audit',
];

type TabVisualMeta = { icon: string; subtitle: string; gradient: string };
export const TAB_VISUALS: Partial<Record<MenuTabId, TabVisualMeta>> = {
  history: { icon: '🎯', subtitle: '', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)' },
  engines: { icon: '⚙️', subtitle: 'Список и карточки двигателей', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)' },
  assembly_forecast: { icon: '🔮', subtitle: 'Прогноз сборки двигателей', gradient: 'linear-gradient(135deg, #4338ca 0%, #6366f1 100%)' },
  engine_brands: { icon: '🏷️', subtitle: 'Марки двигателей и нормы', gradient: 'linear-gradient(135deg, #2563eb 0%, #60a5fa 100%)' },
  engine_brand_groups: { icon: '🗂️', subtitle: 'Группы марок для привязки деталей', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #38bdf8 100%)' },
  parts: { icon: '🧩', subtitle: 'Справочник деталей и узлов', gradient: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)' },
  requests: { icon: '📦', subtitle: 'Закупка и потребности', gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)' },
  work_orders: { icon: '🛠️', subtitle: 'Работы и производство', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  work_order_templates: { icon: '📋', subtitle: 'Шаблоны нарядов по типу', gradient: 'linear-gradient(135deg, #0d9488 0%, #2dd4bf 100%)' },
  tools: { icon: '🔧', subtitle: 'Справочник инструментов (номенклатура)', gradient: 'linear-gradient(135deg, #059669 0%, #22c55e 100%)' },
  tool_accounting: { icon: '📋', subtitle: 'Выдачи и возвраты по сотрудникам', gradient: 'linear-gradient(135deg, #047857 0%, #34d399 100%)' },
  products: { icon: '📦', subtitle: 'Товары и номенклатура', gradient: 'linear-gradient(135deg, #0891b2 0%, #06b6d4 100%)' },
  services: { icon: '🧰', subtitle: 'Услуги и операции', gradient: 'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)' },
  services_by_brand: { icon: '🧩', subtitle: 'Спецификация услуг по марке двигателя', gradient: 'linear-gradient(135deg, #0369a1 0%, #0ea5e9 100%)' },
  nomenclature: { icon: '🗃️', subtitle: 'Единый каталог ТМЦ', gradient: 'linear-gradient(135deg, #0369a1 0%, #0ea5e9 100%)' },
  engine_assembly_bom: { icon: '🧮', subtitle: 'Матрица комплектования двигателей', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  repair_norms: { icon: '📐', subtitle: 'Нормативы замены деталей при ремонте', gradient: 'linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%)' },
  stock_balances: { icon: '📊', subtitle: 'Остатки по складам', gradient: 'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)' },
  stock_documents: { icon: '📄', subtitle: 'Все типы складских документов', gradient: 'linear-gradient(135deg, #0369a1 0%, #22d3ee 100%)' },
  stock_receipts: { icon: '📥', subtitle: 'Документы поступления', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #22d3ee 100%)' },
  stock_issues: { icon: '📤', subtitle: 'Документы расхода', gradient: 'linear-gradient(135deg, #0891b2 0%, #06b6d4 100%)' },
  stock_transfers: { icon: '🔄', subtitle: 'Перемещения и списание', gradient: 'linear-gradient(135deg, #0c4a6e 0%, #0284c7 100%)' },
  stock_inventory: { icon: '📋', subtitle: 'Инвентаризация склада', gradient: 'linear-gradient(135deg, #075985 0%, #0284c7 100%)' },
  repair_fund_audit: { icon: '🛠️', subtitle: 'Детали, ожидающие ремонта', gradient: 'linear-gradient(135deg, #b45309 0%, #f59e0b 100%)' },
  warehouse_analytics: { icon: '📈', subtitle: 'Выпуск двигателей по маркам', gradient: 'linear-gradient(135deg, #0d9488 0%, #2dd4bf 100%)' },
  workshop_stats: { icon: '📊', subtitle: 'Труд и прохождение двигателей по цехам', gradient: 'linear-gradient(135deg, #4338ca 0%, #6366f1 100%)' },
  contracts: { icon: '📄', subtitle: 'Договоры и условия', gradient: 'linear-gradient(135deg, #7c3aed 0%, #c084fc 100%)' },
  counterparties: { icon: '🤝', subtitle: 'Поставщики и партнеры', gradient: 'linear-gradient(135deg, #9333ea 0%, #ec4899 100%)' },
  employees: { icon: '👥', subtitle: 'Сотрудники и профили', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  timesheets: { icon: '🗓️', subtitle: 'Табель учёта рабочего времени (Т-13)', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  access_sections: { icon: '🔐', subtitle: 'Кто видит и правит каждый раздел', gradient: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)' },
  reports: { icon: '📊', subtitle: 'Аналитика и выгрузки', gradient: 'linear-gradient(135deg, #be185d 0%, #ec4899 100%)' },
  custom_reports: { icon: '🧩', subtitle: 'Свои отчёты: фильтры, колонки, шаблоны', gradient: 'linear-gradient(135deg, #be185d 0%, #f472b6 100%)' },
  changes: { icon: '🧾', subtitle: 'История изменений данных', gradient: 'linear-gradient(135deg, #6b7280 0%, #94a3b8 100%)' },
  drafts: { icon: '🗂️', subtitle: 'Несохранённые черновики карточек', gradient: 'linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%)' },
  audit: { icon: '🔍', subtitle: 'Журнал аудита действий', gradient: 'linear-gradient(135deg, #374151 0%, #6b7280 100%)' },
  notes: { icon: '📝', subtitle: 'Личные и общие записи', gradient: 'linear-gradient(135deg, #c2410c 0%, #f97316 100%)' },
  masterdata: { icon: '🗂️', subtitle: 'Общие справочники системы', gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)' },
  admin: { icon: '🛡️', subtitle: 'Админ. раздел и полномочия', gradient: 'linear-gradient(135deg, #4b5563 0%, #9ca3af 100%)' },
  auth: { icon: '🔐', subtitle: 'Вход и авторизация', gradient: 'linear-gradient(135deg, #334155 0%, #64748b 100%)' },
  settings: { icon: '⚙️', subtitle: 'Параметры программы', gradient: 'linear-gradient(135deg, #475569 0%, #94a3b8 100%)' },
  user_screens: { icon: '🧱', subtitle: 'Экраны, собранные операторами', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 100%)' },
};

export function groupForTab(tab: MenuTabId): MenuGroupId {
  for (const groupId of DEFAULT_GROUP_ORDER) {
    if (DEFAULT_GROUP_TABS[groupId].includes(tab)) return groupId;
  }
  return 'control';
}

