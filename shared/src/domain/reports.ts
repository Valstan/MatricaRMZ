import type { WorkOrderSignatureDecryptions } from './workOrderSignatures.js';
import { WORK_ORDERS_REPORT_COLUMNS, WORK_ORDERS_REPORT_COLUMN_OPTIONS } from './workOrdersReport.js';

export type ReportPresetId =
  | 'parts_demand'
  | 'engine_stages'
  | 'contracts_finance'
  | 'contracts_deadlines'
  | 'contracts_requisites'
  | 'supply_fulfillment'
  | 'work_order_costs'
  | 'work_order_payroll'
  | 'work_order_payroll_summary'
  | 'work_orders_report'
  | 'employees_roster'
  | 'tools_inventory'
  | 'services_pricelist'
  | 'products_catalog'
  | 'parts_compatibility'
  | 'counterparties_summary'
  | 'engine_movements'
  | 'engines_list'
  | 'engines_contracts_overview'
  | 'warehouse_stock_path_audit'
  | 'assembly_forecast_7d'
  | 'part_movement_journal'
  | 'stock_turnover'
  | 'workshop_throughput'
  | 'engine_readiness_to_assemble'
  | 'defect_returns_summary'
  | 'movement_integrity_audit'
  | 'scrap_register'
  | 'engine_kitting'
  | 'supply_receipt_gap'
  | 'norms_purchase_plan'
  | 'repair_fund_reconciliation';

export type ReportFilterOption = {
  value: string;
  label: string;
  hintText?: string;
  searchText?: string;
};

export type ReportOptionSource =
  | 'contracts'
  | 'brands'
  | 'counterparties'
  | 'employees'
  | 'departments'
  | 'warehouses'
  | 'assemblyBrands'
  | 'assemblySleeves'
  /** Двигатели (все, кроме утильных): подпись №/внутр.№/марка, поиск по номерам. */
  | 'engines'
  /** Контракты для режима «По контрактам» в прогнозе сборки: подпись № / внутр. / заказчик и поиск по номерам. */
  | 'assembly_forecast_contracts';

export type ReportFilterSpec =
  | {
      type: 'date_range';
      key: string;
      label: string;
      /** Подсказка при наведении на название фильтра (краткое описание смысла). */
      labelHint?: string;
      startKey: string;
      endKey: string;
    }
  | {
      type: 'multi_select';
      key: string;
      label: string;
      optionsSource?: ReportOptionSource;
      options?: ReportFilterOption[];
      /** Если true — UI предзаполнит фильтр всеми доступными значениями. */
      selectAllByDefault?: boolean;
      labelHint?: string;
    }
  | {
      type: 'select';
      key: string;
      label: string;
      optionsSource?: ReportOptionSource;
      options?: ReportFilterOption[];
      labelHint?: string;
    }
  | {
      type: 'checkbox';
      key: string;
      label: string;
      labelHint?: string;
    }
  | {
      type: 'number';
      key: string;
      label: string;
      min?: number;
      max?: number;
      step?: number;
      defaultValue?: number;
      labelHint?: string;
    }
  | {
      type: 'text';
      key: string;
      label: string;
      placeholder?: string;
      defaultValue?: string;
      labelHint?: string;
    };

export type ReportColumn = {
  key: string;
  label: string;
  kind?: 'text' | 'number' | 'date' | 'datetime';
  align?: 'left' | 'right';
};

/** Суперсет колонок отчёта «Отчёт по двигателям». Порядок = канонический порядок печати. */
export const ENGINES_LIST_REPORT_COLUMNS: ReportColumn[] = [
  { key: 'engineNumber', label: '№ двигателя' },
  { key: 'engineInternalNumber', label: 'Внутр. №' },
  { key: 'engineBrand', label: 'Марка' },
  { key: 'contractLabel', label: 'Контракт' },
  { key: 'counterpartyLabel', label: 'Контрагент' },
  { key: 'arrivalDate', label: 'Дата прихода', kind: 'date' },
  { key: 'repairStartedDate', label: 'Начало ремонта', kind: 'date' },
  { key: 'repairedDate', label: 'Окончание ремонта', kind: 'date' },
  { key: 'shippingDate', label: 'Дата отгрузки', kind: 'date' },
  { key: 'isScrap', label: 'Утиль' },
  { key: 'scrapReason', label: 'Причина утиля' },
  { key: 'completenessAct', label: 'Акт комплектности' },
];

/** Какие колонки печатать (в каноническом порядке). Пусто → все. */
export function selectEnginesListReportColumns(selectedKeys: ReadonlyArray<string>): ReportColumn[] {
  const set = new Set(selectedKeys.map((k) => String(k).trim()).filter(Boolean));
  if (set.size === 0) return [...ENGINES_LIST_REPORT_COLUMNS];
  return ENGINES_LIST_REPORT_COLUMNS.filter((c) => set.has(c.key));
}

/**
 * Отчёт «Двигатели и контракты» — колонки по разрезам (groupBy).
 * `contracts` — сводка по контрактам (план/приехало/отгружено/на заводе);
 * `brands` — агрегат по маркам; `engines` — детальный список двигателей.
 */
export const ENGINES_CONTRACTS_CONTRACT_COLUMNS: ReportColumn[] = [
  { key: 'contractLabel', label: 'Контракт' },
  { key: 'counterpartyLabel', label: 'Заказчик' },
  { key: 'dueAt', label: 'Срок', kind: 'date' },
  { key: 'planQty', label: 'План, шт', kind: 'number', align: 'right' },
  { key: 'arrivedQty', label: 'Приехало, шт', kind: 'number', align: 'right' },
  { key: 'awaitingQty', label: 'Ожидается, шт', kind: 'number', align: 'right' },
  { key: 'atFactoryQty', label: 'На заводе, шт', kind: 'number', align: 'right' },
  { key: 'readyNotShippedQty', label: 'Готово, не отгружено, шт', kind: 'number', align: 'right' },
  { key: 'shippedQty', label: 'Отгружено, шт', kind: 'number', align: 'right' },
  { key: 'scrapQty', label: 'Утиль, шт', kind: 'number', align: 'right' },
  { key: 'progressPct', label: 'Выполнение, %', kind: 'number', align: 'right' },
  { key: 'overdueDays', label: 'Просрочка, дн', kind: 'number', align: 'right' },
];

export const ENGINES_CONTRACTS_BRAND_COLUMNS: ReportColumn[] = [
  { key: 'engineBrand', label: 'Марка' },
  { key: 'arrivedQty', label: 'Приехало, шт', kind: 'number', align: 'right' },
  { key: 'atFactoryQty', label: 'На заводе, шт', kind: 'number', align: 'right' },
  { key: 'readyNotShippedQty', label: 'Готово, не отгружено, шт', kind: 'number', align: 'right' },
  { key: 'shippedQty', label: 'Отгружено, шт', kind: 'number', align: 'right' },
  { key: 'scrapQty', label: 'Утиль, шт', kind: 'number', align: 'right' },
  { key: 'avgTatDays', label: 'Средний TAT, дн', kind: 'number', align: 'right' },
];

/** Суперсет колонок разреза «По двигателям» (выбор колонок доступен оператору). */
export const ENGINES_CONTRACTS_ENGINE_COLUMNS: ReportColumn[] = [
  { key: 'engineNumber', label: '№ двигателя' },
  { key: 'engineInternalNumber', label: 'Внутр. №' },
  { key: 'engineBrand', label: 'Марка' },
  { key: 'contractLabel', label: 'Контракт' },
  { key: 'counterpartyLabel', label: 'Заказчик' },
  { key: 'arrivalDate', label: 'Дата прихода', kind: 'date' },
  { key: 'repairStartedDate', label: 'Начало ремонта', kind: 'date' },
  { key: 'repairedDate', label: 'Окончание ремонта', kind: 'date' },
  { key: 'shippingDate', label: 'Дата отгрузки', kind: 'date' },
  { key: 'daysOnSite', label: 'Дней на заводе', kind: 'number', align: 'right' },
  { key: 'stateLabel', label: 'Состояние' },
  { key: 'isScrap', label: 'Утиль' },
];

export function selectEnginesContractsEngineColumns(selectedKeys: ReadonlyArray<string>): ReportColumn[] {
  const set = new Set(selectedKeys.map((k) => String(k).trim()).filter(Boolean));
  if (set.size === 0) return [...ENGINES_CONTRACTS_ENGINE_COLUMNS];
  return ENGINES_CONTRACTS_ENGINE_COLUMNS.filter((c) => set.has(c.key));
}

/** Суперсет колонок отчёта «Утиль». Порядок = канонический порядок печати. */
export const SCRAP_REPORT_COLUMNS: ReportColumn[] = [
  { key: 'rowKind', label: 'Вид' },
  { key: 'engineNumber', label: '№ двигателя' },
  { key: 'engineInternalNumber', label: 'Внутр. №' },
  { key: 'engineBrand', label: 'Марка' },
  { key: 'contractLabel', label: 'Контракт' },
  { key: 'counterpartyLabel', label: 'Контрагент' },
  { key: 'partName', label: 'Деталь' },
  { key: 'partNumber', label: '№ по чертежу' },
  { key: 'stampedNumber', label: 'Клеймо' },
  { key: 'scrapQty', label: 'Кол-во утиля', kind: 'number', align: 'right' },
  { key: 'scrapReason', label: 'Причина утиля' },
  { key: 'replenishmentBranch', label: 'Замещение' },
  { key: 'scrapDate', label: 'Дата', kind: 'date' },
];

export function selectScrapReportColumns(selectedKeys: ReadonlyArray<string>): ReportColumn[] {
  const set = new Set(selectedKeys.map((k) => String(k).trim()).filter(Boolean));
  if (set.size === 0) return [...SCRAP_REPORT_COLUMNS];
  return SCRAP_REPORT_COLUMNS.filter((c) => set.has(c.key));
}

export const REPLENISHMENT_BRANCH_REPORT_LABELS: Record<string, string> = {
  customer: 'Заказчик (давальческая)',
  repair: 'Свой ремонт',
  purchase: 'Закупка',
};

export type ReportPresetDefinition = {
  id: ReportPresetId;
  title: string;
  description: string;
  filters: ReportFilterSpec[];
  columns: ReportColumn[];
};

export type ReportThemeId =
  | 'engines'
  | 'contracts'
  | 'supply'
  | 'work_orders'
  | 'payroll'
  | 'warehouse'
  | 'catalogs'
  | 'audit';

export type ReportThemeDefinition = {
  id: ReportThemeId;
  /** Короткое имя для крупной кнопки-темы. */
  title: string;
  /** Одна строка мелким шрифтом под именем. */
  description: string;
  icon: string;
};

/** Порядок показа плиток в каталоге отчётов. */
export const REPORT_THEMES: ReportThemeDefinition[] = [
  {
    id: 'engines',
    title: 'Двигатели',
    description: 'Ремонтный цикл: стадии, приход и отгрузка, комплектование, утиль',
    icon: '🔧',
  },
  {
    id: 'contracts',
    title: 'Контракты',
    description: 'Заказчики, суммы, сроки и реквизиты ГОЗ',
    icon: '📄',
  },
  {
    id: 'supply',
    title: 'Снабжение',
    description: 'Потребность в деталях, заявки, план закупок, приход',
    icon: '🚚',
  },
  {
    id: 'work_orders',
    title: 'Наряды',
    description: 'Выполнение нарядов, затраты, выработка цехов',
    icon: '🛠',
  },
  {
    id: 'payroll',
    title: 'Зарплата',
    description: 'Начисления по нарядам, своды по сотрудникам и подразделениям',
    icon: '💰',
  },
  {
    id: 'warehouse',
    title: 'Склад',
    description: 'Движения деталей, остатки, оборотка, ремфонд',
    icon: '📦',
  },
  {
    id: 'catalogs',
    title: 'Справочники',
    description: 'Детали, услуги, товары, контрагенты, кадры, инструмент',
    icon: '📚',
  },
  {
    id: 'audit',
    title: 'Проверки',
    description: 'Служебные сверки: где два учёта разъехались и что не сходится',
    icon: '🔍',
  },
];

/**
 * Тематическая приписка шаблонов. Один отчёт живёт сразу в нескольких темах, если задевает обе —
 * это норма, а не дубликат. Record по ReportPresetId: новый пресет без темы не соберётся.
 */
export const REPORT_PRESET_THEMES: Record<ReportPresetId, readonly [ReportThemeId, ...ReportThemeId[]]> = {
  parts_demand: ['supply', 'warehouse'],
  engine_stages: ['engines', 'contracts'],
  contracts_finance: ['contracts'],
  contracts_deadlines: ['contracts'],
  contracts_requisites: ['contracts'],
  supply_fulfillment: ['supply'],
  work_order_costs: ['work_orders'],
  work_order_payroll: ['payroll', 'work_orders'],
  work_order_payroll_summary: ['payroll', 'work_orders'],
  work_orders_report: ['work_orders'],
  employees_roster: ['catalogs', 'payroll'],
  tools_inventory: ['catalogs'],
  services_pricelist: ['catalogs', 'supply'],
  products_catalog: ['catalogs', 'supply'],
  parts_compatibility: ['catalogs', 'engines'],
  counterparties_summary: ['contracts', 'catalogs'],
  engine_movements: ['engines'],
  engines_list: ['engines', 'contracts'],
  engines_contracts_overview: ['engines', 'contracts'],
  warehouse_stock_path_audit: ['audit', 'warehouse'],
  assembly_forecast_7d: ['engines', 'supply'],
  part_movement_journal: ['warehouse'],
  stock_turnover: ['warehouse'],
  workshop_throughput: ['work_orders', 'warehouse'],
  engine_readiness_to_assemble: ['engines', 'warehouse'],
  defect_returns_summary: ['work_orders', 'warehouse'],
  movement_integrity_audit: ['audit'],
  scrap_register: ['engines', 'warehouse'],
  engine_kitting: ['engines', 'warehouse'],
  supply_receipt_gap: ['supply', 'audit'],
  norms_purchase_plan: ['supply', 'warehouse'],
  repair_fund_reconciliation: ['warehouse', 'audit'],
};

export function reportPresetThemes(presetId: ReportPresetId): readonly ReportThemeId[] {
  return REPORT_PRESET_THEMES[presetId] ?? [];
}

export function reportPresetsByTheme(
  themeId: ReportThemeId,
  presets: ReportPresetDefinition[] = REPORT_PRESET_DEFINITIONS,
): ReportPresetDefinition[] {
  return presets.filter((preset) => reportPresetThemes(preset.id).includes(themeId));
}

export function reportThemeCounts(
  presets: ReportPresetDefinition[] = REPORT_PRESET_DEFINITIONS,
): Record<ReportThemeId, number> {
  const counts = Object.fromEntries(REPORT_THEMES.map((theme) => [theme.id, 0])) as Record<ReportThemeId, number>;
  for (const preset of presets) {
    for (const themeId of reportPresetThemes(preset.id)) {
      if (themeId in counts) counts[themeId] += 1;
    }
  }
  return counts;
}

export type ReportCellValue = string | number | boolean | null;
export type ReportRow = Record<string, ReportCellValue>;
export type ReportTotals = Record<string, number>;

export type ReportPresetFilters = Record<string, unknown>;

export type ReportPresetListResult =
  | {
      ok: true;
      presets: ReportPresetDefinition[];
      optionSets: Partial<Record<ReportOptionSource, ReportFilterOption[]>>;
    }
  | { ok: false; error: string };

export type ReportPresetPreviewRequest = {
  presetId: ReportPresetId;
  filters?: ReportPresetFilters;
};

/** Строка «видов работ» для печатной формы `work_order_payroll` (не колонки CSV/XML). */
export type WorkOrderPayrollWorkLine = {
  /** Дата строки наряда (дата наряда). */
  orderDateMs: number;
  workOrderNumber: number | null;
  workLabel: string;
  qty: number;
  priceRub: number;
  amountRub: number;
};

export type ReportPresetPreviewResult =
  | {
      ok: true;
      presetId: ReportPresetId;
      title: string;
      subtitle?: string;
      columns: ReportColumn[];
      rows: ReportRow[];
      totals?: ReportTotals;
      totalsByGroup?: Array<{ group: string; totals: ReportTotals }>;
      /** Отчёт «Наряды»: сводка по статусам для подвала (+опциональная разбивка по маркам). */
      workOrdersStatusSummary?: import('./workOrdersReport.js').WorkOrdersStatusSummary;
      /** Доп. блоки текста под таблицей (подсказки, пояснения к фильтрам). */
      footerNotes?: string[];
      /**
       * Прогноз сборки: структурированные дефициты по номенклатуре (все марки прогноза).
       * UI строит из них кнопку «Создать заявку в снабжение» (позиции toPurchase > 0).
       */
      assemblyDeficits?: Array<{
        nomenclatureId: string;
        partLabel: string;
        deficit: number;
        repairFundQty: number;
        coverableByRepairFund: number;
        toPurchase: number;
      }>;
      /** Детализация работ по нарядам для печати `work_order_payroll`. */
      payrollWorkLines?: WorkOrderPayrollWorkLine[];
      /** Сумма «Начислено»: Σ amountRub по строкам отчёта (та же база, что итог по начислениям). */
      payrollAccrualTotalRub?: number;
      /** Расшифровки подписей для печати `work_order_payroll` (бригада + 3 роли). */
      payrollSignatures?: WorkOrderSignatureDecryptions;
      generatedAt: number;
    }
  | { ok: false; error: string };

export type ReportPresetExportRequest = ReportPresetPreviewRequest & { fileNameHint?: string };

export type ReportPresetPdfResult =
  | { ok: true; contentBase64: string; fileName: string; mime: string }
  | { ok: false; error: string };

export type ReportPresetCsvResult =
  | { ok: true; csv: string; fileName: string; mime: string }
  | { ok: false; error: string };

export type ReportPreset1cXmlResult =
  | { ok: true; xml: string; fileName: string; mime: string }
  | { ok: false; error: string };

export type ReportPresetPrintResult = { ok: true } | { ok: false; error: string };

export type ReportPresetHistoryEntry = {
  presetId: ReportPresetId;
  title: string;
  generatedAt: number;
};

/** Именованный шаблон фильтров отчёта (сохранённый набор значений + отключённые фильтры). */
export type ReportPresetFilterTemplate = {
  id: string;
  name: string;
  createdAt: number;
  filters: ReportPresetFilters;
  disabled: string[];
};

export type ReportPresetFilterTemplatesListResult =
  | { ok: true; templates: ReportPresetFilterTemplate[] }
  | { ok: false; error: string };
export type ReportPresetFilterTemplateSaveResult =
  | { ok: true; templates: ReportPresetFilterTemplate[] }
  | { ok: false; error: string };

export type ReportPresetFavoritesResult = { ok: true; ids: ReportPresetId[] } | { ok: false; error: string };
export type ReportPresetHistoryListResult = { ok: true; entries: ReportPresetHistoryEntry[] } | { ok: false; error: string };
export type ReportPresetHistoryAddResult = { ok: true } | { ok: false; error: string };

export const REPORT_PRESET_DEFINITIONS: ReportPresetDefinition[] = [
  {
    id: 'parts_demand',
    title: 'Потребность в деталях',
    description: 'Дефектовка + комплектность с учетом прихода по заявкам.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'brandIds', label: 'Марки двигателей', optionsSource: 'brands' },
      { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
      { type: 'checkbox', key: 'includePurchases', label: 'Учитывать приход закупленных деталей' },
    ],
    columns: [
      { key: 'contractLabel', label: 'Контракт' },
      { key: 'partName', label: 'Деталь' },
      { key: 'partNumber', label: '№ детали/узла' },
      { key: 'scrapQty', label: 'Утиль (шт)', kind: 'number', align: 'right' },
      { key: 'missingQty', label: 'Недокомплект (шт)', kind: 'number', align: 'right' },
      { key: 'deliveredQty', label: 'Привезено (шт)', kind: 'number', align: 'right' },
      { key: 'remainingNeedQty', label: 'Остаточная потребность (шт)', kind: 'number', align: 'right' },
    ],
  },
  {
    id: 'engine_stages',
    title: 'Стадии двигателей по контрактам',
    description: 'Текущий этап ремонта, прогресс и даты операций.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
      { type: 'multi_select', key: 'brandIds', label: 'Марки двигателей', optionsSource: 'brands' },
      { type: 'multi_select', key: 'counterpartyIds', label: 'Контрагенты', optionsSource: 'counterparties' },
    ],
    columns: [
      { key: 'engineNumber', label: '№ двигателя' },
      { key: 'engineInternalNumber', label: 'Внутр. №' },
      { key: 'engineBrand', label: 'Марка' },
      { key: 'contractLabel', label: 'Контракт' },
      { key: 'counterpartyLabel', label: 'Контрагент' },
      { key: 'currentStage', label: 'Текущая стадия' },
      { key: 'progressPct', label: 'Прогресс, %', kind: 'number', align: 'right' },
      { key: 'arrivalDate', label: 'Дата поступления', kind: 'date' },
      { key: 'lastOperationAt', label: 'Дата последней операции', kind: 'datetime' },
    ],
  },
  {
    id: 'contracts_finance',
    title: 'Финансовая сводка по контрактам',
    description: 'Суммы, объемы, сроки и реквизиты ГОЗ.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период заключения', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'counterpartyIds', label: 'Контрагенты', optionsSource: 'counterparties' },
      { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
      {
        type: 'select',
        key: 'status',
        label: 'Статус',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'active', label: 'Активные' },
          { value: 'overdue', label: 'Просроченные' },
          { value: 'completed', label: 'Завершенные' },
        ],
      },
      {
        type: 'select',
        key: 'dueState',
        label: 'Срок исполнения',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'overdue', label: 'Просроченные' },
          { value: 'due_30', label: 'Срок до 30 дней' },
          { value: 'due_90', label: 'Срок до 90 дней' },
          { value: 'no_due', label: 'Без срока' },
        ],
      },
      {
        type: 'select',
        key: 'igkState',
        label: 'ИГК',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'with', label: 'С ИГК' },
          { value: 'without', label: 'Без ИГК' },
        ],
      },
      {
        type: 'select',
        key: 'separateAccountState',
        label: 'Отдельный счет',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'with', label: 'Есть' },
          { value: 'without', label: 'Нет' },
        ],
      },
    ],
    columns: [
      { key: 'contractLabel', label: 'Контракт' },
      { key: 'internalNumber', label: 'Внутр. номер' },
      { key: 'counterpartyLabel', label: 'Контрагент' },
      { key: 'signedAt', label: 'Дата заключения', kind: 'date' },
      { key: 'dueAt', label: 'Срок исполнения', kind: 'date' },
      { key: 'totalQty', label: 'Кол-во ед.', kind: 'number', align: 'right' },
      { key: 'totalAmountRub', label: 'Сумма (руб)', kind: 'number', align: 'right' },
      { key: 'progressPct', label: 'Прогресс, %', kind: 'number', align: 'right' },
      { key: 'daysLeft', label: 'Дней до окончания', kind: 'number', align: 'right' },
      { key: 'igk', label: 'ИГК' },
      { key: 'separateAccount', label: 'Отдельный счет' },
    ],
  },
  {
    id: 'contracts_deadlines',
    title: 'Контракты: сроки и риски',
    description: 'Контроль дедлайнов, риска просрочки и прогресса исполнения.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период заключения', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'counterpartyIds', label: 'Контрагенты', optionsSource: 'counterparties' },
      { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
      {
        type: 'select',
        key: 'dueState',
        label: 'Срок исполнения',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'overdue', label: 'Просроченные' },
          { value: 'due_30', label: 'Срок до 30 дней' },
          { value: 'due_90', label: 'Срок до 90 дней' },
          { value: 'no_due', label: 'Без срока' },
        ],
      },
      {
        type: 'select',
        key: 'progressState',
        label: 'Прогресс',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'no_progress', label: '0%' },
          { value: 'in_progress', label: 'В работе (1-99%)' },
          { value: 'completed', label: '100%' },
        ],
      },
    ],
    columns: [
      { key: 'contractLabel', label: 'Контракт' },
      { key: 'counterpartyLabel', label: 'Контрагент' },
      { key: 'signedAt', label: 'Дата заключения', kind: 'date' },
      { key: 'dueAt', label: 'Срок исполнения', kind: 'date' },
      { key: 'daysLeft', label: 'Дней до окончания', kind: 'number', align: 'right' },
      { key: 'riskLabel', label: 'Риск срока' },
      { key: 'progressPct', label: 'Прогресс, %', kind: 'number', align: 'right' },
      { key: 'totalAmountRub', label: 'Сумма (руб)', kind: 'number', align: 'right' },
    ],
  },
  {
    id: 'contracts_requisites',
    title: 'Контракты: реквизиты для бухгалтерии',
    description: 'ИГК, отдельные счета, сроки и контроль полноты реквизитов.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период заключения', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'counterpartyIds', label: 'Контрагенты', optionsSource: 'counterparties' },
      { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
      {
        type: 'select',
        key: 'igkState',
        label: 'ИГК',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'with', label: 'С ИГК' },
          { value: 'without', label: 'Без ИГК' },
        ],
      },
      {
        type: 'select',
        key: 'separateAccountState',
        label: 'Отдельный счет',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'with', label: 'Есть' },
          { value: 'without', label: 'Нет' },
        ],
      },
    ],
    columns: [
      { key: 'contractLabel', label: 'Контракт' },
      { key: 'internalNumber', label: 'Внутр. номер' },
      { key: 'counterpartyLabel', label: 'Контрагент' },
      { key: 'signedAt', label: 'Дата заключения', kind: 'date' },
      { key: 'dueAt', label: 'Срок исполнения', kind: 'date' },
      { key: 'igk', label: 'ИГК' },
      { key: 'separateAccount', label: 'Отдельный счет' },
      { key: 'requisitesState', label: 'Полнота реквизитов' },
      { key: 'totalAmountRub', label: 'Сумма (руб)', kind: 'number', align: 'right' },
    ],
  },
  {
    id: 'supply_fulfillment',
    title: 'Заявки в снабжение: исполнение',
    description: 'Заказано, привезено, остаток и статус исполнения.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      {
        type: 'multi_select',
        key: 'statuses',
        label: 'Статусы',
        options: [
          { value: 'draft', label: 'Черновик' },
          { value: 'signed', label: 'Подписана' },
          { value: 'director_approved', label: 'Одобрена директором' },
          { value: 'accepted', label: 'Принята к исполнению' },
          { value: 'fulfilled_full', label: 'Исполнена полностью' },
          { value: 'fulfilled_partial', label: 'Исполнена частично' },
        ],
      },
      { type: 'multi_select', key: 'responsibleIds', label: 'Исполнитель', optionsSource: 'employees' },
    ],
    columns: [
      { key: 'requestNumber', label: '№ заявки' },
      { key: 'requestDate', label: 'Дата', kind: 'date' },
      { key: 'statusLabel', label: 'Статус' },
      { key: 'partName', label: 'Деталь' },
      { key: 'orderedQty', label: 'Заказано', kind: 'number', align: 'right' },
      { key: 'deliveredQty', label: 'Доставлено', kind: 'number', align: 'right' },
      { key: 'remainingQty', label: 'Остаток', kind: 'number', align: 'right' },
      { key: 'lastDeliveryAt', label: 'Последняя доставка', kind: 'datetime' },
    ],
  },
  {
    id: 'work_order_costs',
    title: 'Наряды: выполнение и затраты',
    description: 'Свод по работам, суммам и исполнителям.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'brandIds', label: 'Марки двигателей', optionsSource: 'brands' },
      { type: 'multi_select', key: 'employeeIds', label: 'Бригадир/исполнитель', optionsSource: 'employees' },
    ],
    columns: [
      { key: 'workOrderNumber', label: '№ наряда' },
      { key: 'engineNumber', label: 'Двигатель' },
      { key: 'engineBrand', label: 'Марка' },
      { key: 'orderDate', label: 'Дата', kind: 'date' },
      { key: 'workLabel', label: 'Вид работ' },
      { key: 'qty', label: 'Кол-во', kind: 'number', align: 'right' },
      { key: 'amountRub', label: 'Сумма (руб)', kind: 'number', align: 'right' },
      { key: 'crewLabel', label: 'Бригада' },
    ],
  },
  {
    id: 'work_orders_report',
    title: 'Отчёт по нарядам',
    description: 'Журнал нарядов: фильтры по каждому полю, выбор колонок, сортировка (в т.ч. по статусу), красивая печать.',
    filters: [
      { type: 'date_range', key: 'issued', label: 'Дата выдачи', startKey: 'issuedStartMs', endKey: 'issuedEndMs', labelHint: 'Период по дате выдачи наряда' },
      { type: 'date_range', key: 'due', label: 'Срок исполнения', startKey: 'dueStartMs', endKey: 'dueEndMs', labelHint: 'Период по плановой дате исполнения' },
      { type: 'date_range', key: 'completed', label: 'Дата выполнения', startKey: 'completedStartMs', endKey: 'completedEndMs', labelHint: 'Период по фактической дате выполнения' },
      {
        type: 'multi_select',
        key: 'statusCodes',
        label: 'Статус',
        options: [
          { value: 'issued', label: 'Выдан' },
          { value: 'done', label: 'Выполнен' },
          { value: 'overdue', label: 'Просрочен' },
          { value: 'done_late', label: 'Выполнен с просрочкой' },
          { value: 'withdrawn', label: 'Отозван' },
        ],
        labelHint: 'Пусто — все статусы',
      },
      {
        type: 'multi_select',
        key: 'kinds',
        label: 'Тип наряда',
        options: [
          { value: 'regular', label: 'Обычный' },
          { value: 'repair', label: 'Ремонт' },
          { value: 'assembly', label: 'Сборка' },
          { value: 'manufacturing', label: 'Изготовление' },
        ],
        labelHint: 'Пусто — все типы',
      },
      { type: 'multi_select', key: 'responsibleIds', label: 'Ответственный', optionsSource: 'employees', labelHint: 'Первый подписант блока «Выдача наряда»' },
      { type: 'multi_select', key: 'brandIds', label: 'Марки двигателей', optionsSource: 'brands' },
      { type: 'multi_select', key: 'counterpartyIds', label: 'Контрагент', optionsSource: 'counterparties', labelHint: 'Заказчик из контракта двигателя наряда' },
      { type: 'text', key: 'numberQuery', label: '№ наряда', placeholder: 'напр. 1024', labelHint: 'Фильтр по номеру наряда (вхождение)' },
      { type: 'text', key: 'engineNumberQuery', label: '№ двигателя', labelHint: 'Фильтр по номеру двигателя (вхождение)' },
      { type: 'text', key: 'workTypeQuery', label: 'Виды работ', labelHint: 'Фильтр по названию работ (вхождение)' },
      { type: 'multi_select', key: 'columns', label: 'Колонки отчёта', options: WORK_ORDERS_REPORT_COLUMN_OPTIONS, selectAllByDefault: true, labelHint: 'Какие колонки печатать. Пусто — все.' },
      {
        type: 'select',
        key: 'sortBy',
        label: 'Сортировка',
        options: [
          { value: 'orderDate', label: 'По дате выдачи' },
          { value: 'status', label: 'По статусу' },
          { value: 'workOrderNumber', label: 'По № наряда' },
          { value: 'dueDate', label: 'По сроку' },
          { value: 'completedDate', label: 'По дате выполнения' },
          { value: 'shippedDate', label: 'По дате отгрузки' },
          { value: 'engineBrand', label: 'По марке двигателя' },
          { value: 'amountRub', label: 'По сумме' },
        ],
      },
      {
        type: 'checkbox',
        key: 'summaryByBrand',
        label: 'Сводка по маркам двигателей',
        labelHint: 'Разбить итоговую сводку статусов по маркам двигателей',
      },
      {
        type: 'select',
        key: 'sortDir',
        label: 'Порядок',
        options: [
          { value: 'desc', label: 'По убыванию' },
          { value: 'asc', label: 'По возрастанию' },
        ],
      },
    ],
    columns: WORK_ORDERS_REPORT_COLUMNS,
  },
  {
    id: 'work_order_payroll',
    title: 'Наряды: зарплата сотрудников',
    description:
      'Одна строка на сотрудника и конкретный наряд за выбранный период; печатная форма включает таблицу начислений и перечень видов работ по нарядам.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'employeeIds', label: 'Сотрудники', optionsSource: 'employees' },
    ],
    columns: [
      { key: 'employeeName', label: 'Сотрудник' },
      { key: 'personnelNumber', label: 'Таб. №' },
      { key: 'workOrderNumber', label: '№ наряда', kind: 'number', align: 'right' },
      { key: 'orderDate', label: 'Дата наряда', kind: 'date' },
      { key: 'ktu', label: 'КТУ', kind: 'number', align: 'right' },
      { key: 'amountRub', label: 'Начислено (руб)', kind: 'number', align: 'right' },
    ],
  },
  {
    id: 'work_order_payroll_summary',
    title: 'Наряды: начисления по сотрудникам (свод)',
    description: 'Сводный бухгалтерский срез по сотрудникам и подразделениям за период.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'employeeIds', label: 'Сотрудники', optionsSource: 'employees' },
      { type: 'multi_select', key: 'departmentIds', label: 'Подразделения', optionsSource: 'departments' },
    ],
    columns: [
      { key: 'departmentName', label: 'Подразделение' },
      { key: 'employeeName', label: 'Сотрудник' },
      { key: 'personnelNumber', label: 'Таб. №' },
      { key: 'workOrders', label: 'Наряды, шт', kind: 'number', align: 'right' },
      { key: 'lines', label: 'Начисления, шт', kind: 'number', align: 'right' },
      { key: 'totalKtu', label: 'КТУ суммарно', kind: 'number', align: 'right' },
      { key: 'avgKtu', label: 'КТУ средний', kind: 'number', align: 'right' },
      { key: 'amountRub', label: 'Начислено (руб)', kind: 'number', align: 'right' },
      { key: 'avgWorkOrderAmountRub', label: 'Средняя сумма на наряд (руб)', kind: 'number', align: 'right' },
    ],
  },
  {
    id: 'employees_roster',
    title: 'Кадровый реестр сотрудников',
    description: 'Сотрудники, табельные номера, должности и статус занятости с группировкой по подразделениям.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период (дата приема)', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'departmentIds', label: 'Подразделения', optionsSource: 'departments' },
      {
        type: 'select',
        key: 'employmentStatus',
        label: 'Статус занятости',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'working', label: 'Работает' },
          { value: 'fired', label: 'Уволен' },
        ],
      },
    ],
    columns: [
      { key: 'fullName', label: 'ФИО' },
      { key: 'personnelNumber', label: 'Табельный номер' },
      { key: 'position', label: 'Должность' },
      { key: 'departmentName', label: 'Подразделение' },
      { key: 'hireDate', label: 'Дата приема', kind: 'date' },
      { key: 'terminationDate', label: 'Дата увольнения', kind: 'date' },
      { key: 'employmentStatus', label: 'Статус' },
    ],
  },
  {
    id: 'tools_inventory',
    title: 'Инструменты: учет по подразделениям',
    description: 'Реестр инструмента с датами поступления/списания и статусом учета.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период (дата получения)', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'departmentIds', label: 'Подразделения', optionsSource: 'departments' },
      {
        type: 'select',
        key: 'status',
        label: 'Статус',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'in_inventory', label: 'В учете' },
          { value: 'retired', label: 'Списан' },
        ],
      },
    ],
    columns: [
      { key: 'toolNumber', label: 'Табельный номер' },
      { key: 'name', label: 'Наименование' },
      { key: 'serialNumber', label: 'Серийный номер' },
      { key: 'departmentName', label: 'Подразделение' },
      { key: 'receivedAt', label: 'Дата получения', kind: 'date' },
      { key: 'retiredAt', label: 'Дата списания', kind: 'date' },
      { key: 'retireReason', label: 'Причина списания' },
    ],
  },
  {
    id: 'services_pricelist',
    title: 'Услуги: прайс-лист',
    description: 'Актуальный список услуг с ценами и привязкой к деталям.',
    filters: [{ type: 'checkbox', key: 'onlyLinkedParts', label: 'Только услуги с привязкой к деталям' }],
    columns: [
      { key: 'serviceName', label: 'Наименование' },
      { key: 'unit', label: 'Единица измерения' },
      { key: 'priceRub', label: 'Цена (руб)', kind: 'number', align: 'right' },
      { key: 'linkedParts', label: 'Привязанные детали' },
    ],
  },
  {
    id: 'products_catalog',
    title: 'Товары: каталог',
    description: 'Справочник товаров с артикулами, единицами и ценами.',
    filters: [],
    columns: [
      { key: 'productName', label: 'Наименование' },
      { key: 'article', label: 'Артикул' },
      { key: 'unit', label: 'Единица измерения' },
      { key: 'priceRub', label: 'Цена (руб)', kind: 'number', align: 'right' },
    ],
  },
  {
    id: 'parts_compatibility',
    title: 'Детали: совместимость по маркам',
    description: 'Какие детали и в каком количестве применяются по маркам двигателей.',
    filters: [
      { type: 'multi_select', key: 'brandIds', label: 'Марки двигателей', optionsSource: 'brands' },
      { type: 'multi_select', key: 'supplierIds', label: 'Поставщики', optionsSource: 'counterparties' },
    ],
    columns: [
      { key: 'partName', label: 'Деталь' },
      { key: 'article', label: 'Артикул' },
      { key: 'engineBrand', label: 'Марка двигателя' },
      { key: 'assemblyUnitNumber', label: 'Номер сборочной единицы' },
      { key: 'qtyPerEngine', label: 'Количество на двигатель', kind: 'number', align: 'right' },
      { key: 'supplierName', label: 'Поставщик' },
    ],
  },
  {
    id: 'counterparties_summary',
    title: 'Контрагенты: сводка по контрактам',
    description: 'Количество контрактов и двигателей, сумма и средний прогресс по каждому контрагенту.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период (дата контракта)', startKey: 'startMs', endKey: 'endMs' },
      { type: 'multi_select', key: 'counterpartyIds', label: 'Контрагенты', optionsSource: 'counterparties' },
    ],
    columns: [
      { key: 'counterpartyName', label: 'Контрагент' },
      { key: 'inn', label: 'ИНН' },
      { key: 'contractsCount', label: 'Контрактов, шт.', kind: 'number', align: 'right' },
      { key: 'enginesCount', label: 'Двигателей, шт.', kind: 'number', align: 'right' },
      { key: 'totalAmountRub', label: 'Сумма контрактов (руб)', kind: 'number', align: 'right' },
      { key: 'progressPct', label: 'Прогресс, %', kind: 'number', align: 'right' },
    ],
  },
  {
    id: 'engine_movements',
    title: 'Движение двигателей за период',
    description: 'Поступление/отгрузка и связанные события.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      {
        type: 'select',
        key: 'eventType',
        label: 'Тип события',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'acceptance', label: 'Приемка' },
          { value: 'shipment', label: 'Отгрузка' },
          { value: 'customer_delivery', label: 'Доставка заказчику' },
        ],
      },
      { type: 'multi_select', key: 'brandIds', label: 'Марки двигателей', optionsSource: 'brands' },
      { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
    ],
    columns: [
      { key: 'eventAt', label: 'Дата', kind: 'datetime' },
      { key: 'eventTypeLabel', label: 'Тип события' },
      { key: 'engineNumber', label: '№ двигателя' },
      { key: 'engineInternalNumber', label: 'Внутр. №' },
      { key: 'engineBrand', label: 'Марка' },
      { key: 'contractLabel', label: 'Контракт' },
      { key: 'counterpartyLabel', label: 'Контрагент' },
      { key: 'note', label: 'Примечание' },
    ],
  },
  {
    id: 'engines_list',
    title: 'Отчёт по двигателям',
    description:
      'Список двигателей: фильтры по датам, маркам, контрактам, контрагентам, утилю, наличию на заводе и акту комплектности; выбор колонок для печати.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период (дата создания)', startKey: 'startMs', endKey: 'endMs' },
      { type: 'date_range', key: 'arrivalPeriod', label: 'Дата прихода', startKey: 'arrivalStartMs', endKey: 'arrivalEndMs' },
      {
        type: 'date_range',
        key: 'repairStartPeriod',
        label: 'Начало ремонта',
        startKey: 'repairStartStartMs',
        endKey: 'repairStartEndMs',
        labelHint:
          'Исторический фильтр: ремонт был начат в периоде, включая уже отремонтированные и отгруженные. Для «в ремонте сейчас» — фильтр «Статус „Начат ремонт“».',
      },
      { type: 'date_range', key: 'repairEndPeriod', label: 'Окончание ремонта', startKey: 'repairEndStartMs', endKey: 'repairEndEndMs' },
      { type: 'date_range', key: 'shippingPeriod', label: 'Дата отгрузки', startKey: 'shippingStartMs', endKey: 'shippingEndMs' },
      { type: 'multi_select', key: 'brandIds', label: 'Марки двигателей', optionsSource: 'brands' },
      { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
      { type: 'multi_select', key: 'counterpartyIds', label: 'Контрагенты', optionsSource: 'counterparties' },
      {
        type: 'select',
        key: 'repairActiveFilter',
        label: 'Статус «Начат ремонт»',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'yes', label: 'В ремонте сейчас (галочка стоит)' },
          { value: 'no', label: 'Не в ремонте (галочка снята)' },
        ],
        labelHint: 'Текущая галочка в карточке двигателя, в отличие от исторического фильтра дат «Начало ремонта».',
      },
      {
        type: 'select',
        key: 'scrapFilter',
        label: 'Утиль',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'yes', label: 'Только утиль' },
          { value: 'no', label: 'Только не утиль' },
        ],
      },
      {
        type: 'select',
        key: 'onSiteFilter',
        label: 'Наличие на заводе',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'yes', label: 'На заводе (без даты отгрузки)' },
          { value: 'no', label: 'Отгруженные' },
        ],
      },
      {
        type: 'select',
        key: 'completenessActFilter',
        label: 'Акт комплектности',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'yes', label: 'Заполнен (начат)' },
          { value: 'no', label: 'Не заполнен' },
        ],
        labelHint: 'Акт считается заполненным, если хотя бы одна деталь отмечена «на месте»',
      },
      {
        type: 'multi_select',
        key: 'columns',
        label: 'Колонки отчёта',
        options: ENGINES_LIST_REPORT_COLUMNS.map((c) => ({ value: c.key, label: c.label })),
        selectAllByDefault: true,
        labelHint: 'Какие колонки печатать. Пусто — все.',
      },
    ],
    columns: ENGINES_LIST_REPORT_COLUMNS,
  },
  {
    id: 'engines_contracts_overview',
    title: 'Двигатели и контракты',
    description:
      'Разносторонний обзор: по контрактам (план / приехало / отгружено / осталось на заводе), по маркам и детально по двигателям. Настройки разбиты на сворачиваемые секции, шаблоны сохраняются.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      {
        type: 'select',
        key: 'periodBasis',
        label: 'Учитывать период',
        options: [
          { value: 'none', label: 'Весь период (не ограничивать)' },
          { value: 'arrival', label: 'По дате прихода' },
          { value: 'shipping', label: 'По дате отгрузки' },
        ],
        labelHint:
          'Как применять период. «Весь период» — цифры за всё время контракта/завода. «По дате прихода/отгрузки» — только двигатели с соответствующей датой в диапазоне.',
      },
      { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
      { type: 'multi_select', key: 'brandIds', label: 'Марки двигателей', optionsSource: 'brands' },
      { type: 'multi_select', key: 'counterpartyIds', label: 'Заказчики', optionsSource: 'counterparties' },
      {
        type: 'select',
        key: 'engineState',
        label: 'Состояние двигателя',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'on_site', label: 'На заводе (не отгружены)' },
          { value: 'shipped', label: 'Отгружены заказчику' },
          { value: 'ready_not_shipped', label: 'Готовы, но не отгружены' },
          { value: 'scrap', label: 'Утиль' },
        ],
      },
      { type: 'checkbox', key: 'hideScrap', label: 'Скрыть утиль' },
      {
        type: 'checkbox',
        key: 'overdueOnly',
        label: 'Только просроченные контракты',
        labelHint: 'Разрез «По контрактам»: показывать только контракты с истёкшим сроком и незакрытым исполнением.',
      },
      {
        type: 'number',
        key: 'agingDays',
        label: 'Застряли на заводе дольше, дн',
        min: 0,
        step: 1,
        defaultValue: 0,
        labelHint: '0 — не фильтровать. Иначе показывать только двигатели на заводе, которые ждут ремонта/отгрузки дольше N дней.',
      },
      {
        type: 'select',
        key: 'groupBy',
        label: 'Разрез отчёта',
        options: [
          { value: 'contracts', label: 'По контрактам' },
          { value: 'brands', label: 'По маркам двигателей' },
          { value: 'engines', label: 'По двигателям (детально)' },
        ],
        labelHint: 'Что показывать строками: сводку по контрактам, агрегат по маркам или детальный список двигателей.',
      },
      {
        type: 'multi_select',
        key: 'columns',
        label: 'Колонки (разрез «По двигателям»)',
        options: ENGINES_CONTRACTS_ENGINE_COLUMNS.map((c) => ({ value: c.key, label: c.label })),
        selectAllByDefault: true,
        labelHint: 'Какие колонки печатать в детальном разрезе по двигателям. Пусто — все.',
      },
    ],
    columns: ENGINES_CONTRACTS_CONTRACT_COLUMNS,
  },
  {
    id: 'scrap_register',
    title: 'Утиль: реестр с причинами',
    description:
      'Все утильные позиции завода: детали из дефектовок (кол-во, причина, ветка замещения) и двигатели, признанные утильными целиком. Фильтры по маркам, контрактам, контрагентам, номеру двигателя, датам и замещению.',
    filters: [
      {
        type: 'date_range',
        key: 'period',
        label: 'Период',
        startKey: 'startMs',
        endKey: 'endMs',
        labelHint: 'Дата дефектовки (для деталей) / дата утильного статуса (для двигателей).',
      },
      { type: 'multi_select', key: 'brandIds', label: 'Марки двигателей', optionsSource: 'brands' },
      { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
      { type: 'multi_select', key: 'counterpartyIds', label: 'Контрагенты', optionsSource: 'counterparties' },
      { type: 'text', key: 'engineNumberQuery', label: '№ двигателя', placeholder: 'часть номера или внутр. №' },
      {
        type: 'select',
        key: 'branchFilter',
        label: 'Замещение утиля',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'customer', label: 'Заказчик (давальческая)' },
          { value: 'repair', label: 'Свой ремонт' },
          { value: 'purchase', label: 'Закупка' },
          { value: 'none', label: 'Не выбрано' },
        ],
        labelHint: 'Ветка восполнения из дефектовки: кто замещает утильную деталь.',
      },
      {
        type: 'select',
        key: 'kindFilter',
        label: 'Вид утиля',
        options: [
          { value: 'all', label: 'Детали и двигатели' },
          { value: 'parts', label: 'Только детали' },
          { value: 'engines', label: 'Только двигатели целиком' },
        ],
      },
      {
        type: 'multi_select',
        key: 'columns',
        label: 'Колонки отчёта',
        options: SCRAP_REPORT_COLUMNS.map((c) => ({ value: c.key, label: c.label })),
        selectAllByDefault: true,
        labelHint: 'Какие колонки печатать. Пусто — все.',
      },
    ],
    columns: SCRAP_REPORT_COLUMNS,
  },
  {
    id: 'warehouse_stock_path_audit',
    title: 'Склад: аудит двойного учёта (номенклатура vs деталь)',
    description:
      'Read-only диагностика: строки `erp_reg_stock_balance`, где одна и та же деталь может учитываться и по `nomenclature_id` (зеркало part), и по `part_card_id`, либо присутствует только один из контуров.',
    filters: [{ type: 'multi_select', key: 'warehouseIds', label: 'Склады (пусто = все)', optionsSource: 'warehouses' }],
    columns: [
      { key: 'issueKind', label: 'Тип' },
      { key: 'warehouseId', label: 'Склад (id)' },
      { key: 'partId', label: 'Деталь (id)' },
      { key: 'partLabel', label: 'Деталь' },
      { key: 'nomenclatureQty', label: 'Остаток по номенклатуре', kind: 'number', align: 'right' },
      { key: 'partCardQty', label: 'Остаток по part_card_id', kind: 'number', align: 'right' },
      { key: 'note', label: 'Примечание' },
    ],
  },
  {
    id: 'assembly_forecast_7d',
    title: 'Прогноз сборки двигателей',
    description: 'Что успеваем собрать по маркам на горизонте недели и каких деталей не хватит.',
    filters: [
      {
        type: 'select',
        key: 'assemblyPriorityMode',
        label: 'Приоритет сборки',
        labelHint:
          'Задаёт порядок марок на сборку. «Вручную» — по списку «Приоритетные марки». «По контрактам» — автоматически по непросроченным контрактам с отставанием от линейного графика (просроченные не учитываются). Режимы не смешиваются.',
        options: [
          { value: 'manual', label: 'Вручную' },
          { value: 'contracts', label: 'По контрактам' },
        ],
      },
      {
        type: 'multi_select',
        key: 'assemblyContractIds',
        label: 'Контракты для авто-приоритета',
        labelHint:
          'Доступно в режиме «По контрактам». Среди выбранных контрактов строится приоритет марок по отставанию от графика (самые рискованные — выше). По умолчанию выбраны все контракты; пустой список после загрузки опций означает все контракты.',
        optionsSource: 'assembly_forecast_contracts',
        selectAllByDefault: true,
      },
      {
        type: 'checkbox',
        key: 'assemblyForecastOnSiteOnly',
        label: 'Учитывать только двигатели в статусе ремонта:',
        labelHint:
          'Только в режиме «По контрактам». Включено — в прогнозе по объёму и приоритету учитываются только прикреплённые к контракту двигатели со статусом «Начат ремонт». Выключено — ориентир по суммарным количествам по маркам из первичного договора и всех ДС (остаток к исполнению с учётом уже завершённых единиц).',
      },
      {
        type: 'multi_select',
        key: 'warehouseIds',
        label: 'Склады',
        labelHint: 'Остатки и расход — только по выбранным складам. Пустой список после загрузки опций означает все склады.',
        optionsSource: 'warehouses',
        selectAllByDefault: true,
      },
      {
        type: 'multi_select',
        key: 'engineBrandIds',
        label: 'Марки двигателей',
        labelHint:
          'В расчёт попадают марки с активной default BOM. Пусто (после загрузки) — все такие марки из справочника.',
        optionsSource: 'brands',
        selectAllByDefault: true,
      },
      {
        type: 'multi_select',
        key: 'priorityEngineBrandIds',
        label: 'Приоритетные марки',
        labelHint:
          'В режиме «Вручную» — в первую очередь на сборку. В режиме «По контрактам» список задаётся автоматически.',
        optionsSource: 'brands',
      },
      {
        type: 'number',
        key: 'targetEnginesPerDay',
        label: 'Количество двигателей в сутки',
        labelHint: 'Целевой общий выпуск за сутки по цеху; при дефиците факт может быть ниже.',
        min: 0,
        max: 500,
        step: 1,
        defaultValue: 4,
      },
      {
        type: 'number',
        key: 'sameBrandBatchSize',
        label: 'Одинаковая марка в сутки',
        labelHint: 'Не больше указанного числа двигателей одной марки за сутки (стараться подряд).',
        min: 1,
        max: 500,
        step: 1,
        defaultValue: 2,
      },
      {
        type: 'number',
        key: 'horizonDays',
        label: 'Горизонт, дней',
        labelHint: 'На сколько суток вперёд строится план.',
        min: 1,
        max: 31,
        step: 1,
        defaultValue: 7,
      },
      {
        type: 'multi_select',
        key: 'workingWeekdays',
        label: 'Рабочие дни недели',
        labelHint:
          'Отмеченные дни считаются рабочими и участвуют в расчёте сборки. Неотмеченные дни считаются выходными: в результате они показываются строкой «Выходной» без расчёта сборки. По умолчанию рабочие понедельник–суббота; воскресенье — выходной (его можно отметить как рабочий).',
        options: [
          { value: '1', label: 'Понедельник' },
          { value: '2', label: 'Вторник' },
          { value: '3', label: 'Среда' },
          { value: '4', label: 'Четверг' },
          { value: '5', label: 'Пятница' },
          { value: '6', label: 'Суббота' },
          { value: '0', label: 'Воскресенье' },
        ],
      },
    ],
    columns: [
      { key: 'dayLabel', label: 'Дата и день недели' },
      { key: 'engineBrand', label: 'Марка двигателя' },
      { key: 'plannedEngines', label: 'Кол-во двигателей', kind: 'number', align: 'right' },
      { key: 'status', label: 'Статус сборки' },
      { key: 'requiredComponentsSummary', label: 'Комплектующие' },
    ],
  },
  {
    id: 'part_movement_journal',
    title: 'Журнал движений деталей',
    description:
      'История всех движений по партиям деталей: разборка → ремфонд → склад цеха → сборка/возврат. Фильтрация по складу, типу движения, документу и двигателю.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      {
        type: 'multi_select',
        key: 'warehouseIds',
        label: 'Склады',
        labelHint:
          'Логические локации: repair_fund, workshop_1..workshop_7, assembly_in_progress, scrap, default. Пустой список = все.',
        optionsSource: 'warehouses',
      },
      {
        type: 'multi_select',
        key: 'movementTypes',
        label: 'Типы движений',
        labelHint:
          'dismantle_in (в ремфонд), dismantle_scrap_in (в утиль при разборке), repair_out/_in (ремонт), assembly_consumption_out/_in (списание в сборку), assembly_return_out/_in_rework/_in_scrap (возврат), reversal_* (сторно).',
        options: [
          { value: 'dismantle_in', label: 'Разборка → ремфонд' },
          { value: 'dismantle_scrap_in', label: 'Разборка → утиль' },
          { value: 'repair_out', label: 'Ремонт: списано из ремфонда' },
          { value: 'repair_in', label: 'Ремонт: приход на склад цеха' },
          { value: 'assembly_consumption_out', label: 'Сборка: списание со склада' },
          { value: 'assembly_consumption_in', label: 'Сборка: приход на «в сборке»' },
          { value: 'assembly_return_out', label: 'Возврат из сборки' },
          { value: 'assembly_return_in_rework', label: 'Возврат → ремфонд (доработка)' },
          { value: 'assembly_return_in_scrap', label: 'Возврат → утиль' },
          { value: 'receipt', label: 'Приход (generic)' },
          { value: 'issue', label: 'Расход (generic)' },
          { value: 'writeoff', label: 'Списание' },
          { value: 'transfer_in', label: 'Перемещение: приход' },
          { value: 'transfer_out', label: 'Перемещение: расход' },
        ],
      },
      {
        type: 'text',
        key: 'engineId',
        label: 'ID двигателя',
        placeholder: 'UUID (опц.)',
        labelHint: 'Фильтр по engineId в записях движений — все движения, связанные с конкретным двигателем.',
      },
      {
        type: 'text',
        key: 'nomenclatureSearch',
        label: 'Деталь (поиск по названию/коду)',
        placeholder: 'часть имени или кода',
      },
    ],
    columns: [
      { key: 'performedAt', label: 'Дата/время', kind: 'datetime' },
      { key: 'movementTypeLabel', label: 'Тип движения' },
      { key: 'direction', label: 'Направление' },
      { key: 'warehouseLabel', label: 'Локация' },
      { key: 'nomenclatureName', label: 'Деталь' },
      { key: 'nomenclatureCode', label: 'Код' },
      { key: 'qty', label: 'Кол-во', kind: 'number', align: 'right' },
      { key: 'engineId', label: 'Двигатель' },
      { key: 'documentDocNo', label: '№ документа' },
      { key: 'documentDocType', label: 'Тип документа' },
      { key: 'performedBy', label: 'Исполнитель' },
      { key: 'reason', label: 'Причина' },
    ],
  },
  {
    id: 'stock_turnover',
    title: 'Оборотная ведомость по складу',
    description:
      'Классическая оборотка по номенклатуре и локации: сальдо на начало периода + приход − расход = сальдо на конец. Сальдо привязаны к текущим остаткам регистра.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      {
        type: 'multi_select',
        key: 'warehouseIds',
        label: 'Склады',
        labelHint: 'Локации остатков. Пустой список = все.',
        optionsSource: 'warehouses',
      },
      {
        type: 'text',
        key: 'nomenclatureSearch',
        label: 'Деталь (поиск по названию/коду)',
        placeholder: 'часть имени или кода',
      },
      {
        type: 'checkbox',
        key: 'onlyWithMovements',
        label: 'Только с движением за период',
        labelHint: 'Скрыть позиции, у которых за период не было ни прихода, ни расхода (только сальдо).',
      },
    ],
    columns: [
      { key: 'warehouseLabel', label: 'Локация' },
      { key: 'nomenclatureName', label: 'Деталь' },
      { key: 'nomenclatureCode', label: 'Код' },
      { key: 'openingQty', label: 'Сальдо нач.', kind: 'number', align: 'right' },
      { key: 'receiptQty', label: 'Приход', kind: 'number', align: 'right' },
      { key: 'issueQty', label: 'Расход', kind: 'number', align: 'right' },
      { key: 'closingQty', label: 'Сальдо кон.', kind: 'number', align: 'right' },
    ],
  },
  {
    id: 'norms_purchase_plan',
    title: 'План закупок по нормам',
    description:
      'Для экономистов: BOM марки × норма расхода (%) × количество двигателей = план потребности; минус свободные остатки = к закупке. Нормы без типизированного процента считаются как 100%.',
    filters: [
      {
        type: 'select',
        key: 'brandId',
        label: 'Марка двигателя',
        labelHint: 'Марка, по активному BOM которой считается план.',
        optionsSource: 'assemblyBrands',
      },
      {
        type: 'number',
        key: 'enginesCount',
        label: 'Количество двигателей',
        labelHint: 'Плановое число ремонтов, на которое считается закупка.',
        min: 1,
        max: 10000,
        step: 1,
        defaultValue: 1,
      },
      {
        type: 'checkbox',
        key: 'onlyToPurchase',
        label: 'Только позиции к закупке',
        labelHint: 'Скрыть строки, полностью закрытые свободными остатками.',
      },
    ],
    columns: [
      { key: 'componentName', label: 'Деталь' },
      { key: 'componentCode', label: 'Код' },
      { key: 'qtyPerUnit', label: 'Кол-во на 1 дв.', kind: 'number', align: 'right' },
      { key: 'normPercentLabel', label: 'Норма, %', align: 'right' },
      { key: 'planQty', label: 'План (шт)', kind: 'number', align: 'right' },
      { key: 'availableQty', label: 'Доступно', kind: 'number', align: 'right' },
      { key: 'repairFundQty', label: 'Ремфонд', kind: 'number', align: 'right' },
      { key: 'toPurchaseQty', label: 'К закупке', kind: 'number', align: 'right' },
      { key: 'variantNote', label: 'Примечание' },
    ],
  },
  {
    id: 'repair_fund_reconciliation',
    title: 'Сверка ремфонда: экземпляры vs остаток',
    description:
      'Контроль расползания двух учётов: клеймёные экземпляры «в ремфонде» (поэкземплярный реестр) против агрегатного остатка локации «Ремонтный фонд» по каждой номенклатуре. Экземпляров больше остатка — красный сигнал.',
    filters: [
      {
        type: 'text',
        key: 'nomenclatureSearch',
        label: 'Деталь (поиск по названию/коду)',
        placeholder: 'часть имени или кода',
      },
      {
        type: 'checkbox',
        key: 'onlyMismatch',
        label: 'Только расхождения',
        labelHint: 'Показать только позиции, где клеймёных экземпляров числится больше, чем агрегатный остаток фонда.',
      },
    ],
    columns: [
      { key: 'nomenclatureName', label: 'Деталь' },
      { key: 'nomenclatureCode', label: 'Код' },
      { key: 'instancesInFund', label: 'Экземпляров «в ремфонде»', kind: 'number', align: 'right' },
      { key: 'fundQty', label: 'Остаток фонда (агрегат)', kind: 'number', align: 'right' },
      { key: 'unnamedQty', label: 'Безымянных (остаток − экз.)', kind: 'number', align: 'right' },
      { key: 'excessInstances', label: 'Экз. сверх остатка ⚠', kind: 'number', align: 'right' },
      { key: 'stampedNumbers', label: 'Личные №' },
    ],
  },
  {
    id: 'workshop_throughput',
    title: 'Выработка цехов',
    description: 'Сумма отремонтированных деталей (movement_type=repair_in) по складу цеха и номенклатуре за период.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      {
        type: 'multi_select',
        key: 'warehouseIds',
        label: 'Склады цехов',
        labelHint: 'Фильтр по warehouse_id вида workshop_*. Пусто = все цеха.',
        optionsSource: 'warehouses',
      },
    ],
    columns: [
      { key: 'warehouseLabel', label: 'Цех (склад)' },
      { key: 'nomenclatureName', label: 'Деталь' },
      { key: 'nomenclatureCode', label: 'Код' },
      { key: 'qtyRepaired', label: 'Отремонтировано, шт', kind: 'number', align: 'right' },
      { key: 'records', label: 'Записей', kind: 'number', align: 'right' },
    ],
  },
  {
    id: 'engine_readiness_to_assemble',
    title: 'Готовность двигателей к сборке',
    description:
      'Для каждого двигателя в фазах received/disassembled — список нехватающих деталей по BOM ' +
      '(требуется − qty на workshop_* и repair_fund). Фаза двигателя берётся из EAV engine_phase.',
    filters: [
      {
        type: 'multi_select',
        key: 'engineBrandIds',
        label: 'Марки двигателей',
        optionsSource: 'brands',
      },
      {
        type: 'checkbox',
        key: 'showOnlyShortages',
        label: 'Только с дефицитом',
      },
    ],
    columns: [
      { key: 'engineNumber', label: '№ двигателя' },
      { key: 'engineInternalNumber', label: 'Внутр. №' },
      { key: 'engineBrand', label: 'Марка' },
      { key: 'enginePhase', label: 'Фаза' },
      { key: 'totalComponents', label: 'Компонентов', kind: 'number', align: 'right' },
      { key: 'componentsShort', label: 'Дефицитных', kind: 'number', align: 'right' },
      { key: 'totalShortQty', label: 'Σ дефицит, шт', kind: 'number', align: 'right' },
      { key: 'shortageSummary', label: 'Дефициты (TOP-5)' },
    ],
  },
  {
    id: 'defect_returns_summary',
    title: 'Сводка возвратов брака из сборки',
    description:
      'Возвраты деталей из сборки за период: суммы по mode (rework/scrap), по двигателям и номенклатуре. ' +
      'Источник: movement_type=assembly_return_in_rework/scrap.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период', startKey: 'startMs', endKey: 'endMs' },
      {
        type: 'select',
        key: 'mode',
        label: 'Режим возврата',
        options: [
          { value: 'all', label: 'Все' },
          { value: 'rework', label: 'На доработку (rework)' },
          { value: 'scrap', label: 'В утиль (scrap)' },
        ],
      },
    ],
    columns: [
      { key: 'modeLabel', label: 'Режим' },
      { key: 'engineId', label: 'Двигатель' },
      { key: 'nomenclatureName', label: 'Деталь' },
      { key: 'nomenclatureCode', label: 'Код' },
      { key: 'qty', label: 'Кол-во', kind: 'number', align: 'right' },
      { key: 'returns', label: 'Возвратов, шт', kind: 'number', align: 'right' },
      { key: 'reasons', label: 'Причины' },
    ],
  },
  {
    id: 'movement_integrity_audit',
    title: 'Проверка целостности журнала движений',
    description:
      'Hash-chain аудит erp_reg_stock_movements: где prev_hash не совпадает с self_hash предыдущей записи. ' +
      'Записи без хэшей считаются «до-цепочечными» (включены в БД до активации hash-chain).',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период (опц.)', startKey: 'startMs', endKey: 'endMs' },
      {
        type: 'checkbox',
        key: 'includePreChain',
        label: 'Включать записи без хэша (pre-chain)',
      },
    ],
    columns: [
      { key: 'status', label: 'Статус' },
      { key: 'performedAt', label: 'Дата/время', kind: 'datetime' },
      { key: 'movementId', label: 'ID движения' },
      { key: 'movementType', label: 'Тип движения' },
      { key: 'warehouseId', label: 'Склад' },
      { key: 'prevHash', label: 'prev_hash (фрагмент)' },
      { key: 'selfHash', label: 'self_hash (фрагмент)' },
      { key: 'expectedPrev', label: 'Ожидалось prev_hash' },
      { key: 'detail', label: 'Детали' },
    ],
  },
  {
    id: 'engine_kitting',
    title: 'Комплектование двигателя',
    description:
      'Подбор деталей на сборку конкретного двигателя: по BOM его марки — что уже выдано в сборку, ' +
      'что осталось выдать, где лежит доступное (склады/цеха), что можно закрыть ремфондом и чистый дефицит. ' +
      'Печать — пикинг-лист для кладовщика/комплектовщика.',
    filters: [
      {
        type: 'select',
        key: 'engineId',
        label: 'Двигатель',
        optionsSource: 'engines',
        labelHint: 'Двигатель, который комплектуем. Марка определяет BOM (активный, по умолчанию).',
      },
      {
        type: 'checkbox',
        key: 'onlyMissing',
        label: 'Только неукомплектованные',
        labelHint: 'Показывать только позиции, по которым ещё осталось выдать детали.',
      },
    ],
    columns: [
      { key: 'componentName', label: 'Деталь' },
      { key: 'componentCode', label: 'Код' },
      { key: 'requiredQty', label: 'Требуется', kind: 'number', align: 'right' },
      { key: 'issuedQty', label: 'Выдано в сборку', kind: 'number', align: 'right' },
      { key: 'remainingQty', label: 'Осталось выдать', kind: 'number', align: 'right' },
      { key: 'availableQty', label: 'Доступно', kind: 'number', align: 'right' },
      { key: 'locationsHint', label: 'Где лежит' },
      { key: 'repairFundQty', label: 'В ремфонде', kind: 'number', align: 'right' },
      { key: 'deficitQty', label: 'Дефицит', kind: 'number', align: 'right' },
      { key: 'variantNote', label: 'Варианты / примечание' },
    ],
  },
  {
    id: 'supply_receipt_gap',
    title: 'Заявки снабжения без прихода на склад',
    description:
      'Контроль разрыва «снабжение → склад»: заявки в исполнении и исполненные — оформлен ли по ним ' +
      'приходный документ (связь через «Источник/ссылка» документа, кнопка «Оформить приход» на карточке заявки). ' +
      'Заявка без прихода = привезённое не оприходовано.',
    filters: [
      {
        type: 'date_range',
        key: 'period',
        label: 'Период',
        startKey: 'startMs',
        endKey: 'endMs',
        labelHint: 'По дате заявки (исполнение / поступление / принятие / составление — первая заполненная).',
      },
      {
        type: 'checkbox',
        key: 'onlyMissing',
        label: 'Только без прихода',
      },
    ],
    columns: [
      { key: 'requestNumber', label: '№ заявки' },
      { key: 'statusLabel', label: 'Статус заявки' },
      { key: 'requestDate', label: 'Дата', kind: 'date' },
      { key: 'itemsCount', label: 'Позиций', kind: 'number', align: 'right' },
      { key: 'orderedQty', label: 'Заказано', kind: 'number', align: 'right' },
      { key: 'deliveredQty', label: 'Привезено', kind: 'number', align: 'right' },
      { key: 'receiptDocNo', label: 'Документ прихода' },
      { key: 'receiptStatusLabel', label: 'Статус документа' },
    ],
  },
];
