export type ReportPresetId =
  | 'parts_demand'
  | 'engine_stages'
  | 'contracts_finance'
  | 'supply_fulfillment'
  | 'work_order_costs'
  | 'engine_movements';

export type ReportFilterOption = {
  value: string;
  label: string;
};

export type ReportOptionSource = 'contracts' | 'brands' | 'counterparties' | 'employees';

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
    }
  | {
      type: 'select';
      key: string;
      label: string;
      options: ReportFilterOption[];
    }
  | {
      type: 'checkbox';
      key: string;
      label: string;
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

export type ReportPresetPrintResult = { ok: true } | { ok: false; error: string };

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
      { key: 'progressPct', label: 'Прогресс (%)', kind: 'number', align: 'right' },
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
    ],
    columns: [
      { key: 'contractLabel', label: 'Контракт' },
      { key: 'internalNumber', label: 'Внутр. номер' },
      { key: 'counterpartyLabel', label: 'Контрагент' },
      { key: 'signedAt', label: 'Дата заключения', kind: 'date' },
      { key: 'dueAt', label: 'Срок исполнения', kind: 'date' },
      { key: 'totalQty', label: 'Кол-во ед.', kind: 'number', align: 'right' },
      { key: 'totalAmountRub', label: 'Сумма (руб)', kind: 'number', align: 'right' },
      { key: 'progressPct', label: 'Прогресс (%)', kind: 'number', align: 'right' },
      { key: 'daysLeft', label: 'Дней до окончания', kind: 'number', align: 'right' },
      { key: 'igk', label: 'ИГК' },
      { key: 'separateAccount', label: 'Отдельный счет' },
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
];
