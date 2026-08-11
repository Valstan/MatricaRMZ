// Реестр разделов (TabId/MenuTabId, русские названия, группы) живёт в shared
// (@matricarmz/shared, domain/uiSections) — им же пользуется backend для дайджеста
// и отчётов ИИваныча. Здесь остались только renderer-специфика (визуальные пресеты,
// планшетные наборы вкладок) и реэкспорт для обратной совместимости импортов.
import type { MenuGroupId, MenuTabId } from '@matricarmz/shared';

export type { TabId, MenuTabId, MenuGroupId } from '@matricarmz/shared';
export {
  resolveMenuTab,
  GROUP_LABELS,
  MENU_TAB_LABELS,
  DEFAULT_GROUP_ORDER,
  DEFAULT_GROUP_TABS,
  groupForTab,
} from '@matricarmz/shared';

export type TabsLayoutPrefs = {
  order?: MenuTabId[];
  hidden?: MenuTabId[];
  trashIndex?: number | null;
  groupOrder?: MenuGroupId[];
  hiddenGroups?: MenuGroupId[];
  collapsedGroups?: MenuGroupId[];
  activeGroup?: MenuGroupId | null;
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
