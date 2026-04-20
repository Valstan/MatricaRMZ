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
  | 'employees_roster'
  | 'tools_inventory'
  | 'services_pricelist'
  | 'products_catalog'
  | 'parts_compatibility'
  | 'counterparties_summary'
  | 'engine_movements'
  | 'engines_list'
  | 'warehouse_stock_path_audit'
  | 'assembly_forecast_7d';

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
  | 'assemblySleeves';

export type ReportFilterSpec =
  | {
      type: 'date_range';
      key: string;
      label: string;
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
    }
  | {
      type: 'select';
      key: string;
      label: string;
      optionsSource?: ReportOptionSource;
      options?: ReportFilterOption[];
    }
  | {
      type: 'checkbox';
      key: string;
      label: string;
    }
  | {
      type: 'number';
      key: string;
      label: string;
      min?: number;
      max?: number;
      step?: number;
      defaultValue?: number;
    }
  | {
      type: 'text';
      key: string;
      label: string;
      placeholder?: string;
      defaultValue?: string;
    };

export type ReportColumn = {
  key: string;
  label: string;
  kind?: 'text' | 'number' | 'date' | 'datetime';
  align?: 'left' | 'right';
};

export type ReportPresetDefinition = {
  id: ReportPresetId;
  title: string;
  description: string;
  filters: ReportFilterSpec[];
  columns: ReportColumn[];
};

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
      /** Доп. блоки текста под таблицей (подсказки, пояснения к фильтрам). */
      footerNotes?: string[];
      /** Детализация работ по нарядам для печати `work_order_payroll`. */
      payrollWorkLines?: WorkOrderPayrollWorkLine[];
      /** Сумма «Начислено»: Σ amountRub по строкам отчёта (та же база, что итог по начислениям). */
      payrollAccrualTotalRub?: number;
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
      { key: 'engineBrand', label: 'Марка' },
      { key: 'contractLabel', label: 'Контракт' },
      { key: 'counterpartyLabel', label: 'Контрагент' },
      { key: 'note', label: 'Примечание' },
    ],
  },
  {
    id: 'engines_list',
    title: 'Отчёт по двигателям',
    description: 'Список двигателей с фильтрацией по датам, маркам, контрактам, статусу утиля и наличию на заводе.',
    filters: [
      { type: 'date_range', key: 'period', label: 'Период (дата создания)', startKey: 'startMs', endKey: 'endMs' },
      { type: 'date_range', key: 'arrivalPeriod', label: 'Дата прихода', startKey: 'arrivalStartMs', endKey: 'arrivalEndMs' },
      { type: 'date_range', key: 'shippingPeriod', label: 'Дата отгрузки', startKey: 'shippingStartMs', endKey: 'shippingEndMs' },
      { type: 'multi_select', key: 'brandIds', label: 'Марки двигателей', optionsSource: 'brands' },
      { type: 'multi_select', key: 'contractIds', label: 'Контракты', optionsSource: 'contracts' },
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
    ],
    columns: [
      { key: 'engineNumber', label: '№ двигателя' },
      { key: 'engineBrand', label: 'Марка' },
      { key: 'contractLabel', label: 'Контракт' },
      { key: 'counterpartyLabel', label: 'Контрагент' },
      { key: 'arrivalDate', label: 'Дата прихода', kind: 'date' },
      { key: 'shippingDate', label: 'Дата отгрузки', kind: 'date' },
      { key: 'isScrap', label: 'Утиль' },
    ],
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
    description:
      'Прогнозирует сборку по активным default BOM-матрицам (марка из справочника → компоненты BOM), с учётом остатков и плановых приходов (planned). Целевой выпуск в сутки — общий по цеху (если комплектующих не хватает, за день наберётся меньше цели — это видно в строках «не хватает»). Режим приоритета: вручную выбранные марки или авто по непросроченным контрактам с отставанием от графика (просроченные контракты в авто-режиме не учитываются). Режимы не смешиваются. Марки в фильтрах — из справочника «Марки двигателей»; расчёт строк прогноза только для марок, у которых есть активная default BOM. Внизу — подсказки по дефициту. В фильтре складов учитывайте id «default».',
    filters: [
      {
        type: 'select',
        key: 'assemblyPriorityMode',
        label: 'Приоритет сборки',
        options: [
          { value: 'manual', label: 'Вручную — приоритетные марки ниже' },
          {
            value: 'contracts',
            label: 'Авто — по контрактам с отставанием от графика',
            hintText:
              'Берутся непросроченные контракты, где исполнение отстаёт от линейного графика. Просроченные контракты не участвуют. Ручной список приоритетных марок отключается.',
          },
        ],
      },
      {
        type: 'multi_select',
        key: 'warehouseIds',
        label: 'Склады',
        optionsSource: 'warehouses',
        selectAllByDefault: true,
      },
      {
        type: 'multi_select',
        key: 'engineBrandIds',
        label: 'Марки двигателей (справочник; в прогнозе участвуют только с активной default BOM)',
        optionsSource: 'brands',
        selectAllByDefault: true,
      },
      {
        type: 'multi_select',
        key: 'priorityEngineBrandIds',
        label: 'Приоритетные марки (в первую очередь на сборку; справочник марок)',
        optionsSource: 'brands',
      },
      {
        type: 'number',
        key: 'targetEnginesPerDay',
        label: 'Целевой выпуск двигателей в сутки',
        min: 0,
        max: 500,
        step: 1,
        defaultValue: 4,
      },
      {
        type: 'number',
        key: 'sameBrandBatchSize',
        label: 'Серия одинаковой марки в день (стараться подряд)',
        min: 1,
        max: 500,
        step: 1,
        defaultValue: 2,
      },
      {
        type: 'number',
        key: 'horizonDays',
        label: 'Горизонт прогноза (дней)',
        min: 1,
        max: 31,
        step: 1,
        defaultValue: 7,
      },
    ],
    columns: [
      { key: 'dayLabel', label: 'День' },
      { key: 'engineBrand', label: 'Марка двигателя' },
      { key: 'plannedEngines', label: 'Кол-во двигателей', kind: 'number', align: 'right' },
      { key: 'status', label: 'Статус' },
      { key: 'requiredComponentsSummary', label: 'Расход комплектующих (факт за день)' },
      { key: 'deficitsSummary', label: 'Дефицит' },
      { key: 'alternativeBrands', label: 'Альтернативные марки' },
    ],
  },
];
