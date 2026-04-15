import { describe, expect, it } from 'vitest';

import { REPORT_PRESET_DEFINITIONS } from './reports.js';

function preset(id: string) {
  return REPORT_PRESET_DEFINITIONS.find((item) => item.id === id);
}

describe('report presets regressions', () => {
  it('keeps preset ids unique', () => {
    const ids = REPORT_PRESET_DEFINITIONS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('contains all list-oriented presets added in this session', () => {
    const ids = new Set(REPORT_PRESET_DEFINITIONS.map((item) => item.id));
    expect(ids.has('employees_roster')).toBe(true);
    expect(ids.has('tools_inventory')).toBe(true);
    expect(ids.has('services_pricelist')).toBe(true);
    expect(ids.has('products_catalog')).toBe(true);
    expect(ids.has('parts_compatibility')).toBe(true);
    expect(ids.has('counterparties_summary')).toBe(true);
    expect(ids.has('warehouse_stock_path_audit')).toBe(true);
    expect(ids.has('assembly_forecast_7d')).toBe(true);
  });

  it('keeps employee roster wiring for department and employment filters', () => {
    const employeesRoster = preset('employees_roster');
    expect(employeesRoster?.filters).toEqual([
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
    ]);
    expect(employeesRoster?.columns.map((column) => column.key)).toEqual([
      'fullName',
      'personnelNumber',
      'position',
      'departmentName',
      'hireDate',
      'terminationDate',
      'employmentStatus',
    ]);
  });

  it('keeps tool inventory, services, products and compatibility presets business-critical columns', () => {
    expect(preset('tools_inventory')?.columns.map((column) => column.key)).toEqual([
      'toolNumber',
      'name',
      'serialNumber',
      'departmentName',
      'receivedAt',
      'retiredAt',
      'retireReason',
    ]);
    expect(preset('services_pricelist')?.filters).toEqual([{ type: 'checkbox', key: 'onlyLinkedParts', label: 'Только услуги с привязкой к деталям' }]);
    expect(preset('services_pricelist')?.columns.map((column) => column.key)).toEqual(['serviceName', 'unit', 'priceRub', 'linkedParts']);
    expect(preset('products_catalog')?.filters).toEqual([]);
    expect(preset('products_catalog')?.columns.map((column) => column.key)).toEqual(['productName', 'article', 'unit', 'priceRub']);
    expect(preset('parts_compatibility')?.columns.map((column) => column.key)).toEqual([
      'partName',
      'article',
      'engineBrand',
      'assemblyUnitNumber',
      'qtyPerEngine',
      'supplierName',
    ]);
    expect(preset('warehouse_stock_path_audit')?.columns.map((column) => column.key)).toEqual([
      'issueKind',
      'warehouseId',
      'partId',
      'partLabel',
      'nomenclatureQty',
      'partCardQty',
      'note',
    ]);
    expect(preset('assembly_forecast_7d')?.columns.map((column) => column.key)).toEqual([
      'dayLabel',
      'engineBrand',
      'plannedEngines',
      'status',
      'requiredComponentsSummary',
      'deficitsSummary',
      'alternativeBrands',
    ]);
  });

  it('keeps counterparties summary and payroll in accounting-friendly row format', () => {
    expect(preset('counterparties_summary')?.columns.map((column) => column.key)).toEqual([
      'counterpartyName',
      'inn',
      'contractsCount',
      'enginesCount',
      'totalAmountRub',
      'progressPct',
    ]);
    expect(preset('work_order_payroll')?.columns.map((column) => column.key)).toEqual([
      'employeeName',
      'personnelNumber',
      'workOrderNumber',
      'orderDate',
      'ktu',
      'amountRub',
    ]);
    expect(preset('work_order_payroll_summary')?.columns.map((column) => column.key)).toEqual([
      'departmentName',
      'employeeName',
      'personnelNumber',
      'workOrders',
      'lines',
      'totalKtu',
      'avgKtu',
      'amountRub',
      'avgWorkOrderAmountRub',
    ]);
  });
});

