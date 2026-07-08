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
  | 'warehouse_stock_path_audit'
  | 'assembly_forecast_7d'
  | 'part_movement_journal'
  | 'workshop_throughput'
  | 'engine_readiness_to_assemble'
  | 'defect_returns_summary'
  | 'movement_integrity_audit';

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
          { value: 'engineBrand', label: 'По марке двигателя' },
          { value: 'amountRub', label: 'По сумме' },
        ],
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
    description: '',
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
];
