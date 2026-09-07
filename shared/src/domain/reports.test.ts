import { describe, expect, it } from 'vitest';

import {
  cascadeVisibleOptions,
  REPORT_PRESET_DEFINITIONS,
  REPORT_PRESET_THEMES,
  REPORT_THEMES,
  reportPresetsByTheme,
  reportThemeCounts,
} from './reports.js';

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
    expect(ids.has('organization_structure')).toBe(true);
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
      { type: 'multi_select', key: 'workshopIds', label: 'Цеха', optionsSource: 'workshops' },
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
      'workshopName',
      'structureKind',
      'structureName',
      'birthDate',
      'birthday',
      'hireDate',
      'terminationDate',
      'employmentStatus',
    ]);
  });

  it('keeps the organization structure source printable and countable', () => {
    const structure = preset('organization_structure');
    expect(structure?.columns.map((column) => column.key)).toEqual([
      'structureKind',
      'code',
      'name',
      'employees',
      'workingEmployees',
      'firedEmployees',
      'isActive',
    ]);
    expect(REPORT_PRESET_THEMES.organization_structure).toContain('catalogs');
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

describe('report themes', () => {
  const themeIds = new Set(REPORT_THEMES.map((theme) => theme.id));

  it('keeps theme ids unique and described', () => {
    expect(themeIds.size).toBe(REPORT_THEMES.length);
    for (const theme of REPORT_THEMES) {
      expect(theme.title.trim().length).toBeGreaterThan(0);
      expect(theme.description.trim().length).toBeGreaterThan(0);
      expect(theme.icon.trim().length).toBeGreaterThan(0);
    }
  });

  it('assigns every preset to at least one existing theme', () => {
    for (const preset of REPORT_PRESET_DEFINITIONS) {
      const themes = REPORT_PRESET_THEMES[preset.id];
      expect(themes, `preset ${preset.id} has no themes`).toBeTruthy();
      expect(themes.length).toBeGreaterThan(0);
      expect(new Set(themes).size, `preset ${preset.id} repeats a theme`).toBe(themes.length);
      for (const themeId of themes) expect(themeIds.has(themeId), `preset ${preset.id} → unknown theme ${themeId}`).toBe(true);
    }
  });

  it('leaves no empty theme tile', () => {
    const counts = reportThemeCounts();
    for (const theme of REPORT_THEMES) {
      expect(counts[theme.id], `theme ${theme.id} is empty`).toBeGreaterThan(0);
      expect(reportPresetsByTheme(theme.id).length).toBe(counts[theme.id]);
    }
  });

  it('gives every preset a non-empty description for the theme list', () => {
    for (const preset of REPORT_PRESET_DEFINITIONS) {
      expect(preset.description.trim().length, `preset ${preset.id} has no description`).toBeGreaterThan(0);
    }
  });
});


describe('cascadeVisibleOptions', () => {
  const options = [
    { value: 'C1', label: 'Договор 1', linkedIds: ['CP1'] },
    { value: 'C2', label: 'Договор 2', linkedIds: ['CP1'] },
    { value: 'C3', label: 'Договор 3', linkedIds: ['CP2'] },
    { value: 'C4', label: 'Договор без заказчика' },
  ];

  it('пустой родитель — показываем всё', () => {
    expect(cascadeVisibleOptions(options, ['counterpartyIds'], {}).map((o) => o.value)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(cascadeVisibleOptions(options, ['counterpartyIds'], { counterpartyIds: [] }).map((o) => o.value)).toEqual([
      'C1',
      'C2',
      'C3',
      'C4',
    ]);
  });

  it('выбранный родитель оставляет только связанное с ним; несвязанное выпадает', () => {
    const visible = cascadeVisibleOptions(options, ['counterpartyIds'], { counterpartyIds: ['CP1'] });
    expect(visible.map((o) => o.value)).toEqual(['C1', 'C2']);
  });

  it('несколько родителей применяются по «И»', () => {
    const brands = [
      { value: 'BR1', label: 'Д-245', linkedIds: ['CP1', 'C1', 'C2'] },
      { value: 'BR2', label: 'ЯМЗ-238', linkedIds: ['CP1', 'C2'] },
      { value: 'BR3', label: 'КамАЗ-740', linkedIds: ['CP2', 'C3'] },
    ];
    const filters = { counterpartyIds: ['CP1'], contractIds: ['C1'] };
    expect(cascadeVisibleOptions(brands, ['counterpartyIds', 'contractIds'], filters).map((o) => o.value)).toEqual(['BR1']);
  });

  it('без cascadeFrom список не трогаем', () => {
    expect(cascadeVisibleOptions(options, undefined, { counterpartyIds: ['CP1'] }).length).toBe(options.length);
  });
});

describe.each(['engine_flow_by_counterparty', 'engines'])('отбор отчёта %s каскадный', (presetId) => {
  it('заказчик → договор → марка', () => {
    const flow = preset(presetId);
    const byKey = (key: string) => flow?.filters.find((f) => 'key' in f && (f as { key: string }).key === key);
    const counterparties = byKey('counterpartyIds');
    const contracts = byKey('contractIds');
    const brands = byKey('brandIds');
    expect(counterparties && 'cascadeFrom' in counterparties ? counterparties.cascadeFrom : undefined).toBeUndefined();
    expect(contracts && 'cascadeFrom' in contracts ? contracts.cascadeFrom : undefined).toEqual(['counterpartyIds']);
    expect(brands && 'cascadeFrom' in brands ? brands.cascadeFrom : undefined).toEqual(['counterpartyIds', 'contractIds']);
    // Порядок в списке фильтров — это порядок ступеней на экране.
    const keys = flow?.filters.map((f) => ('key' in f ? (f as { key: string }).key : '')) ?? [];
    expect(keys.indexOf('counterpartyIds')).toBeLessThan(keys.indexOf('contractIds'));
    expect(keys.indexOf('contractIds')).toBeLessThan(keys.indexOf('brandIds'));
  });
});
