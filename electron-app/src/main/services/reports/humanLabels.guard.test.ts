/**
 * Тест-сторож правила проекта: **оператору никогда не показывают служебный код и никогда
 * не показывают идентификатор**. Гоняет пресеты отчётов на синтетической фикстуре и падает,
 * если такая строка доехала до ячейки, подзаголовка, подвала или подписи итога.
 *
 * ПОЧЕМУ СТОРОЖ, А НЕ ОБЫЧНЫЕ ТЕСТЫ. Правило нарушается не логикой, а фолбэком: `?? id`,
 * `|| code`, `.slice(0, 8)`. Такой фолбэк проходит любой тест на числа и любой typecheck —
 * тип у него строковый и верный. Ловится он только прогоном на данных с дырами.
 *
 * ЧЕТЫРЕ РЕШЕНИЯ, ПРИНЯТЫЕ ДО КОДА (иначе будут выдуманы заново):
 *
 * 1. **Гоняем через `buildReportByPreset`, а не билдеры напрямую.** Диспетчер — часть
 *    маршрута оператора, и у него своя ловушка: `getPreset` (`context.ts`) на неизвестный id
 *    возвращает ПЕРВОЕ определение каталога, а не ошибку. Билдер, забывший поменять
 *    `presetId`, отдал бы чужие колонки, а сторож этого бы не заметил — поэтому каждый
 *    прогон сверяет `report.presetId` с ожидаемым.
 * 2. **Никакого отсева «в тексте есть кириллица — значит человеческое».** Строка
 *    «Марка a3f19b2c-…: BOM не найден» содержит и кириллицу, и идентификатор; такой отсев
 *    пропускает половину нарушений. Детектор смотрит на форму подстрок, а не на алфавит ячейки.
 * 3. **Идентификаторы фикстуры известны сторожу поимённо.** Это ловит форму, которую общий
 *    детектор поймать не может в принципе: обрезок `id.slice(0, 8)` неотличим от артикула,
 *    если не знать исходный id. Мы его знаем — фикстуру пишем мы.
 * 4. **Две фикстуры на каждый пресет.** «Полная» (все справочники на месте) ловит эхо кодов,
 *    которое печатается даже при идеальных данных: статусы, типы операций, разделы. «Дырявая»
 *    (части справочников нет) ловит фолбэки `?? id`. Одной фикстурой ловится только половина.
 *
 * Пресет, который сторож не гоняет, обязан лежать в `humanLabelsExceptions.ts` с обоснованием:
 * молчаливого пропуска быть не должно.
 */
import { describe, expect, it, vi } from 'vitest';

// Диспетчер тянет `electron` ради журнала main-процесса; журнал глотает свои ошибки сам,
// поэтому пустого объекта достаточно — писать в файл на прогоне тестов и не надо.
vi.mock('electron', () => ({ app: {} }));

import {
  REPORT_PRESET_DEFINITIONS,
  StockMovementType,
  WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART,
  WarehouseDocumentType,
  WarehouseDocumentWorkflowStatus,
  hasHumanLabel,
  looksLikeIdentifier,
  stripIdentifierTokens,
} from '@matricarmz/shared';

import {
  attributeDefs,
  attributeValues,
  entities,
  entityTypes,
  erpDocumentHeaders,
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
  operations,
} from '../../database/schema.js';

import { buildReportByPreset } from './dispatch.js';
import { HUMAN_LABEL_GUARD_EXCEPTIONS, HUMAN_LABEL_GUARD_UNCOVERED_PRESETS, findGuardException } from './humanLabelsExceptions.js';

// ---------------------------------------------------------------------------
// Фикстура
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 4, 12);

/**
 * Идентификаторы фикстуры. Намеренно узнаваемые: сторож ищет в ячейках не только их целиком,
 * но и любой их префикс от 6 знаков — ровно так выглядит `id.slice(0, 8)` в колонке «Заявка».
 * Настоящих UUID из прода тут быть не должно, иначе поиск префикса начнёт ловить совпадения.
 */
const ID = {
  brand: 'aa110000-0000-4000-8000-000000000001',
  brandNameless: 'aa110000-0000-4000-8000-000000000002',
  /** Марки с таким id в справочнике нет вовсе — не «без названия», а висячая ссылка. */
  brandMissing: 'aa110000-0000-4000-8000-000000000003',
  engine: 'bb220000-0000-4000-8000-000000000001',
  engineNoNumber: 'bb220000-0000-4000-8000-000000000002',
  engineScrap: 'bb220000-0000-4000-8000-000000000003',
  contract: 'cc330000-0000-4000-8000-000000000001',
  counterparty: 'dd440000-0000-4000-8000-000000000001',
  employee: 'ee550000-0000-4000-8000-000000000001',
  tool: 'ff660000-0000-4000-8000-000000000001',
  service: 'a1770000-0000-4000-8000-000000000001',
  product: 'b2880000-0000-4000-8000-000000000001',
  part: 'c3990000-0000-4000-8000-000000000001',
  partLink: 'd4aa0000-0000-4000-8000-000000000001',
  department: 'c3990000-0000-4000-8000-000000000009',
  /** Подразделения с таким id в справочнике нет — висячая ссылка в карточке сотрудника. */
  departmentMissing: 'c3990000-0000-4000-8000-00000000000b',
  partCard: 'c3990000-0000-4000-8000-00000000000a',
  nomenclature: 'e5bb0000-0000-4000-8000-000000000001',
  nomenclatureMissing: 'e5bb0000-0000-4000-8000-000000000002',
  warehouse: 'f6cc0000-0000-4000-8000-000000000001',
  docHeader: '07dd0000-0000-4000-8000-000000000001',
  docHeaderDrifted: '07dd0000-0000-4000-8000-000000000002',
  bom: '07dd0000-0000-4000-8000-00000000000b',
  operation: '18ee0000-0000-4000-8000-000000000001',
  operationCompleteness: '18ee0000-0000-4000-8000-000000000002',
  workOrder: '18ee0000-0000-4000-8000-000000000003',
  repairFundInstance: '18ee0000-0000-4000-8000-000000000004',
  supplyRequest: '29ff0000-0000-4000-8000-000000000001',
} as const;

const ALL_FIXTURE_IDS: string[] = Object.values(ID);

/**
 * Односложные служебные коды, которые фикстура кладёт в данные ИМЕННО ЭТИ и никакие другие.
 * Коды с подчёркиванием (`in_assembly`, `assembly_return_in_scrap`, `fulfilled_full`) сюда не
 * входят — их ловит общее правило ниже; а вот одиночное латинское слово общее правило от
 * артикула отличить не может, и единственное, что позволяет его судить, — знание фикстуры.
 *
 * Список обязан отражать фикстуру, а не пожелания: код, которого фикстура не кладёт, здесь
 * бесполезен и лжив — он создаёт впечатление проверки, которой нет.
 */
const SERVICE_CODES = [
  'received', // engine_phase двигателя
  'posted', // статус приходного документа
  'receipt', // тип движения и тип документа
  'primary', // ключ раздела контракта
  'material', // itemType номенклатуры
  'advance', // вид платежа
  'defect', // тип операции (акт дефектовки)
  'completeness', // тип операции (акт комплектности)
] as const;

/**
 * Код, которого клиентский словарь не знает. Не выдумка ради красного теста: клиент и сервер
 * выпускаются порознь, движения приезжают синхронизацией как есть, и ровно на этот случай в
 * коде живут фолбэки `?? code`. Фикстура моделирует «сервер ушёл вперёд», а не «ошибка в БД».
 */
const DRIFTED_MOVEMENT_TYPE = 'quarantine_in';
const DRIFTED_DOCUMENT_STATUS = 'awaiting_approval';
const DRIFTED_DOCUMENT_TYPE = 'quarantine_act';

type Row = Record<string, unknown>;

type FixtureShape = {
  /** Дырявая: справочники неполные, а часть кодов клиенту неизвестна — ловит фолбэки `?? id`. */
  leaky: boolean;
};

function eavRows(shape: FixtureShape) {
  const types: Row[] = [
    'engine',
    'engine_brand',
    'contract',
    'counterparty',
    'employee',
    'department',
    'tool',
    'service',
    'product',
    'part',
    'part_engine_brand',
  ].map((code) => ({ id: `T_${code}`, code }));

  const entityRows: Row[] = [
    { id: ID.brand, typeId: 'T_engine_brand' },
    { id: ID.brandNameless, typeId: 'T_engine_brand' },
    { id: ID.contract, typeId: 'T_contract' },
    { id: ID.counterparty, typeId: 'T_counterparty' },
    { id: ID.engine, typeId: 'T_engine' },
    { id: ID.engineNoNumber, typeId: 'T_engine' },
    { id: ID.engineScrap, typeId: 'T_engine' },
    { id: ID.employee, typeId: 'T_employee' },
    { id: ID.department, typeId: 'T_department' },
    { id: ID.tool, typeId: 'T_tool' },
    { id: ID.service, typeId: 'T_service' },
    { id: ID.product, typeId: 'T_product' },
    { id: ID.part, typeId: 'T_part' },
    { id: ID.partLink, typeId: 'T_part_engine_brand' },
  ];

  const attrs: Record<string, Record<string, unknown>> = {
    [ID.brand]: { name: 'Д-245' },
    // Дырявая фикстура: у марки нет названия — именно здесь прежде печатался UUID.
    [ID.brandNameless]: shape.leaky ? {} : { name: 'ЯМЗ-238' },
    [ID.counterparty]: { name: 'ООО «Ремонтник»', inn: '4345000000' },
    [ID.contract]: {
      contract_sections: {
        primary: {
          number: '100/2026',
          internalNumber: 'вн-7',
          customerId: ID.counterparty,
          signedAt: T0,
          dueAt: T0 + 30 * DAY,
          engineBrands: [{ engineBrandId: ID.brand, qty: 4, unitPrice: 150_000 }],
          parts: [],
        },
        addons: [],
      },
      due_date: T0 + 30 * DAY,
      customer_id: ID.counterparty,
      contract_payments: {
        version: 1,
        slots: [
          {
            id: 'slot-1',
            sectionKey: 'primary',
            engineId: ID.engine,
            engineBrandId: shape.leaky ? ID.brandMissing : ID.brand,
            contractPriceKop: 15_000_000,
            payments: [{ id: 'p1', date: '2026-05-12', amountKop: 5_000_000, kind: 'advance', countdownStart: true }],
          },
        ],
      },
    },
    [ID.engine]: {
      engine_number: 'ДВ-1001',
      engine_brand_id: ID.brand,
      contract_id: ID.contract,
      arrival_date: T0,
      engine_phase: 'in_assembly',
      status_repaired: true,
    },
    [ID.engineNoNumber]: {
      // Дырявая: ни номера, ни имени — фолбэк прежде подставлял идентификатор.
      ...(shape.leaky ? {} : { engine_number: 'ДВ-1002' }),
      // Дырявая: марка ссылается на сущность, которой в справочнике нет вовсе. Это не то же
      // самое, что марка без названия: там снапшот отдаёт «(без названия)», а тут — ничего,
      // и фолбэк волен подставить сам идентификатор.
      engine_brand_id: shape.leaky ? ID.brandMissing : ID.brand,
      contract_id: ID.contract,
      arrival_date: T0 + DAY,
      engine_phase: 'received',
    },
    [ID.engineScrap]: {
      engine_number: 'ДВ-1003',
      engine_brand_id: shape.leaky ? ID.brandNameless : ID.brand,
      contract_id: ID.contract,
      arrival_date: T0 + DAY,
      status_scrap_confirmed: true,
    },
    [ID.employee]: {
      full_name: 'Иванов Иван Иванович',
      login: 'ivanov',
      personnel_number: 'ТН-15',
      position: 'Слесарь',
      // Дырявая: подразделение указано, но такой сущности нет — фолбэк волен подставить id.
      department_id: shape.leaky ? ID.departmentMissing : ID.department,
      is_working: true,
    },
    [ID.department]: { name: 'Ремонтный участок', code: 'РУ-1' },
    [ID.tool]: { name: 'Ключ динамометрический', inventory_number: 'ИНВ-12', status: 'in_inventory' },
    [ID.service]: { name: 'Шлифовка коленвала', price: 5000 },
    [ID.product]: { name: 'Прокладка ГБЦ', price: 320 },
    [ID.part]: { name: 'Коленвал', part_number: 'Д245-1005020' },
    [ID.partLink]: { part_id: ID.part, engine_brand_id: ID.brand },
  };

  const codes = new Set<string>();
  for (const map of Object.values(attrs)) for (const code of Object.keys(map)) codes.add(code);
  const defRows: Row[] = [...codes].map((code) => ({ id: `D_${code}`, code }));

  const valueRows: Row[] = [];
  for (const [entityId, map] of Object.entries(attrs)) {
    for (const [code, value] of Object.entries(map)) {
      valueRows.push({ entityId, attributeDefId: `D_${code}`, valueJson: JSON.stringify(value) });
    }
  }
  return { types, entityRows, defRows, valueRows };
}

function operationRows(shape: FixtureShape): Row[] {
  const base = { performedBy: 'ivanov', createdAt: T0, updatedAt: T0, status: 'done' };
  return [
    {
      ...base,
      id: ID.operation,
      engineEntityId: ID.engine,
      operationType: 'defect',
      performedAt: T0 + DAY,
      metaJson: JSON.stringify({
        kind: 'repair_checklist',
        answers: {
          defect_items: {
            kind: 'table',
            rows: [{ part_name: 'Коленвал', part_number: 'Д245-1005020', scrap_qty: 1 }],
          },
        },
      }),
    },
    {
      ...base,
      id: ID.operationCompleteness,
      engineEntityId: ID.engine,
      operationType: 'completeness',
      performedAt: T0 + DAY,
      metaJson: JSON.stringify({
        kind: 'repair_checklist',
        answers: {
          completeness_items: {
            kind: 'table',
            rows: [{ part_name: 'Гильза', assembly_unit_number: 'Д245-1002021', quantity: 4, actual_qty: 1 }],
          },
        },
      }),
    },
    {
      ...base,
      id: ID.supplyRequest,
      engineEntityId: ID.engine,
      operationType: 'supply_request',
      performedAt: T0 + 2 * DAY,
      metaJson: JSON.stringify({
        kind: 'supply_request',
        // Дырявая: номера у заявки нет — ровно тут фолбэк печатал огрызок идентификатора.
        ...(shape.leaky ? {} : { requestNumber: 'ЗАЯВКА-7' }),
        status: 'fulfilled_full',
        compiledAt: T0 + 2 * DAY,
        items: [{ name: 'Коленвал', qty: 3, deliveries: [{ qty: 3, deliveredAt: T0 + 3 * DAY }] }],
      }),
    },
    {
      ...base,
      id: ID.workOrder,
      engineEntityId: ID.engine,
      operationType: 'work_order',
      performedAt: T0 + 4 * DAY,
      // Дырявая: исполнителя нет среди карточек сотрудников — в колонку «Создал» уходит логин
      // вместо ФИО. Логин намеренно обычный: выдуманный `unknown_login` сторож поймал бы как
      // служебный код, и претензия оказалась бы к фикстуре, а не к коду.
      performedBy: shape.leaky ? 'petrov' : 'ivanov',
      metaJson: JSON.stringify({
        kind: 'work_order',
        workOrderNumber: 41,
        orderDate: T0 + 4 * DAY,
        partName: 'Коленвал',
        totalAmountRub: 5000,
        workGroups: [{ partName: 'Коленвал', lines: [{ serviceName: 'Шлифовка коленвала', qty: 1, amountRub: 5000 }] }],
        crew: [{ employeeId: ID.employee, employeeName: 'Иванов Иван Иванович', ktu: 1, payoutRub: 5000 }],
      }),
    },
    {
      ...base,
      id: ID.repairFundInstance,
      engineEntityId: ID.engine,
      operationType: 'repair_fund_instance',
      performedAt: T0 + 5 * DAY,
      metaJson: JSON.stringify({
        kind: 'repair_fund_instance',
        status: 'in_fund',
        // Дырявая: номенклатуры с таким id в справочнике нет — фолбэк печатает сам id.
        nomenclatureId: shape.leaky ? ID.nomenclatureMissing : ID.nomenclature,
        stampedNumber: 'К-12',
      }),
    },
  ];
}

function erpRows(shape: FixtureShape) {
  const nomenclature: Row[] = [
    {
      id: ID.nomenclature,
      code: 'НОМ-001',
      name: 'Коленвал Д-245',
      itemType: 'material',
      // Зеркало детали: остаток той же детали числится и по номенклатуре, и по карточке —
      // строка «двойного учёта» в аудите путей склада.
      specJson: JSON.stringify({ source: WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART, partId: ID.partCard, article: 'Д245-1005020' }),
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    },
  ];
  const headers: Row[] = [
    {
      id: ID.docHeader,
      docType: WarehouseDocumentType.PurchaseReceipt,
      docNo: 'ПР-15',
      docDate: T0 + 3 * DAY,
      status: shape.leaky ? DRIFTED_DOCUMENT_STATUS : WarehouseDocumentWorkflowStatus.Posted,
      // Приход сшивается с заявкой снабжения через идентификатор в ссылке — это ключ, не показ.
      payloadJson: JSON.stringify({ sourceRef: `supply_request:${ID.supplyRequest}` }),
      createdAt: T0,
      updatedAt: T0,
    },
  ];
  if (shape.leaky) {
    // Документ с типом, которого клиентский словарь ещё не знает: тот же «сервер ушёл вперёд»,
    // что и у типа движения, но отдельной шапкой — иначе пропал бы приход, на котором держится
    // отчёт «Заявки без прихода» (он отбирает шапки строго по типу `purchase_receipt`).
    headers.push({
      id: ID.docHeaderDrifted,
      docType: DRIFTED_DOCUMENT_TYPE,
      docNo: 'КАР-2',
      docDate: T0 + 3 * DAY,
      status: WarehouseDocumentWorkflowStatus.Posted,
      createdAt: T0,
      updatedAt: T0,
    });
  }
  const movements: Row[] = [
    {
      id: 'm1',
      // Дырявая: движение ссылается на номенклатуру, которой нет в справочнике.
      nomenclatureId: shape.leaky ? ID.nomenclatureMissing : ID.nomenclature,
      warehouseLocationId: ID.warehouse,
      documentHeaderId: ID.docHeader,
      movementType: StockMovementType.Receipt,
      qty: 5,
      direction: 'in',
      engineId: ID.engine,
      performedAt: T0 + DAY,
      performedBy: 'ivanov',
      createdAt: T0,
    },
    {
      id: 'm2',
      nomenclatureId: shape.leaky ? ID.nomenclatureMissing : ID.nomenclature,
      warehouseLocationId: ID.warehouse,
      documentHeaderId: ID.docHeader,
      movementType: StockMovementType.AssemblyReturnInScrap,
      qty: 2,
      direction: 'out',
      engineId: ID.engine,
      reason: 'Брак литья',
      performedAt: T0 + 2 * DAY,
      performedBy: 'ivanov',
      createdAt: T0,
    },
  ];
  // Выпуск цеха. Признак цеха при недоступном справочнике локаций (а сторож гоняет билдеры
  // без `ctx`, то есть всегда офлайн) определяется ТОЛЬКО легаси-полем `warehouseId`.
  movements.push({
    id: 'm4',
    nomenclatureId: ID.nomenclature,
    warehouseLocationId: ID.warehouse,
    warehouseId: 'workshop_3',
    documentHeaderId: ID.docHeader,
    movementType: StockMovementType.RepairIn,
    qty: 4,
    direction: 'in',
    performedAt: T0 + 4 * DAY,
    performedBy: 'ivanov',
    createdAt: T0,
  });
  if (shape.leaky) {
    // Движение с кодом, которого клиентский словарь ещё не знает. Отдельной строкой, а не
    // подменой типа у `m2`: сводка возвратов брака отбирает строки ИМЕННО по типу, и подмена
    // оставила бы её без данных — сторож проверял бы пустоту вместо подписей.
    movements.push({
      id: 'm3',
      nomenclatureId: ID.nomenclature,
      warehouseLocationId: ID.warehouse,
      documentHeaderId: ID.docHeaderDrifted,
      movementType: DRIFTED_MOVEMENT_TYPE,
      qty: 1,
      direction: 'in',
      engineId: ID.engine,
      performedAt: T0 + 3 * DAY,
      performedBy: 'ivanov',
      createdAt: T0,
    });
  }
  // BOM марки: офлайн-путь «Комплектования двигателя». Строки-варианты одной позиции несут
  // машинный ключ редактора (`pos-…`) и подпись оператора — сторож следит, чтобы в ячейку
  // уходила подпись.
  const bomHeaders: Row[] = [
    { id: ID.bom, name: 'Сборка Д-245', status: 'active', isDefault: true, updatedAt: T0, createdAt: T0 },
  ];
  const bomBrandLinks: Row[] = [{ id: 'bl1', bomId: ID.bom, engineBrandId: ID.brand, isDefaultForBrand: true, createdAt: T0, updatedAt: T0 }];
  const bomLines: Row[] = [
    {
      id: 'bomline1',
      bomId: ID.bom,
      componentNomenclatureId: ID.nomenclature,
      componentType: 'part',
      qtyPerUnit: 6,
      variantGroup: 'поршневая-группа',
      positionKey: 'pos-x7k2m9q',
      positionLabel: shape.leaky ? null : 'Поршневая группа',
      isRequired: true,
      priority: 100,
      isDefaultOption: true,
      createdAt: T0,
      updatedAt: T0,
    },
  ];

  const balances: Row[] = [
    {
      id: 'b1',
      nomenclatureId: shape.leaky ? ID.nomenclatureMissing : ID.nomenclature,
      partCardId: null,
      warehouseLocationId: ID.warehouse,
      qty: 3,
      reservedQty: 0,
      updatedAt: T0,
    },
    {
      id: 'b2',
      nomenclatureId: null,
      partCardId: ID.partCard,
      warehouseLocationId: ID.warehouse,
      qty: 2,
      reservedQty: 0,
      updatedAt: T0,
    },
  ];
  return { nomenclature, headers, movements, balances, bomHeaders, bomBrandLinks, bomLines };
}

/**
 * Стаб БД. Билдеры ходят в drizzle цепочками разной длины (`.where()`, `.orderBy()`,
 * `.limit()`, иногда ничего), поэтому цепочка сделана «ленивой и обещающей»: любой метод
 * возвращает её же, а `await` отдаёт строки таблицы. Фильтры стаб не исполняет — фикстуру
 * пишем мы, лишних строк в ней нет.
 */
function stubDb(shape: FixtureShape): any {
  const eav = eavRows(shape);
  const erp = erpRows(shape);
  const byTable = new Map<unknown, Row[]>([
    [entityTypes, eav.types],
    [entities, eav.entityRows],
    [attributeDefs, eav.defRows],
    [attributeValues, eav.valueRows],
    [operations, operationRows(shape)],
    [erpNomenclature, erp.nomenclature],
    [erpDocumentHeaders, erp.headers],
    [erpRegStockMovements, erp.movements],
    [erpRegStockBalance, erp.balances],
    [erpEngineAssemblyBom, erp.bomHeaders],
    [erpEngineAssemblyBomBrandLinks, erp.bomBrandLinks],
    [erpEngineAssemblyBomLines, erp.bomLines],
  ]);

  return {
    select() {
      return {
        from(table: unknown) {
          const rows = byTable.get(table) ?? [];
          const chain: any = new Proxy(
            {},
            {
              get(_target, prop) {
                if (prop === 'then') {
                  return (resolve: (value: Row[]) => unknown) => resolve(rows);
                }
                return () => chain;
              },
            },
          );
          return chain;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Детектор
// ---------------------------------------------------------------------------

type Leak = { kind: string; detail: string };

/** Токен «служебный код»: латиница в нижнем регистре хотя бы с одним подчёркиванием. */
const SNAKE_CASE_TOKEN = /(?:^|[\s:,;·([«"'/])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=[\s:,;·)\]»"'/.]|$)/;

/** Минимальная длина префикса идентификатора, которую считаем утечкой (`slice(0, 8)` и короче). */
const ID_PREFIX_MIN = 6;

function detectLeaks(raw: unknown): Leak[] {
  if (typeof raw !== 'string' && typeof raw !== 'number') return [];
  const text = String(raw).trim();
  if (!text) return [];
  const leaks: Leak[] = [];

  if (looksLikeIdentifier(text)) {
    leaks.push({ kind: 'идентификатор целиком', detail: text });
  } else if (stripIdentifierTokens(text) !== text) {
    leaks.push({ kind: 'идентификатор внутри текста', detail: text });
  } else {
    // Огрызок идентификатора. Общий детектор такую форму поймать не может — она
    // неотличима от артикула; ловится только знанием собственной фикстуры.
    const fragment = ALL_FIXTURE_IDS.find((id) => {
      for (let len = id.length; len >= ID_PREFIX_MIN; len -= 1) {
        if (text.includes(id.slice(0, len))) return true;
      }
      return false;
    });
    if (fragment) leaks.push({ kind: 'обрезанный идентификатор', detail: text });
  }

  const snake = SNAKE_CASE_TOKEN.exec(text);
  if (snake) leaks.push({ kind: 'служебный код', detail: snake[1] ?? text });

  for (const code of SERVICE_CODES) {
    const asToken = new RegExp(`(?:^|[\\s:,;·(\\[«"'/])${code}(?=[\\s:,;·)\\]»"'/.]|$)`);
    if (asToken.test(text)) leaks.push({ kind: 'служебный код из фикстуры', detail: code });
  }

  return leaks;
}

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

type Violation = { presetId: string; column: string; value: string; kind: string };

/**
 * Пресеты, которые сторож гоняет. Всё, чего тут нет, обязано лежать в списке непокрытых.
 * `filters` — только там, где без них билдер честно не отдаёт строк (не «удобнее», а «иначе
 * ветка недостижима»); значения фильтров не подгоняются под желаемый результат.
 */
const COVERED_PRESETS: Array<{ presetId: string; filters?: Record<string, unknown> }> = [
  { presetId: 'employees_roster' },
  { presetId: 'organization_structure' },
  { presetId: 'tools_inventory' },
  { presetId: 'services_pricelist' },
  { presetId: 'products_catalog' },
  { presetId: 'parts_compatibility' },
  { presetId: 'counterparties_summary' },
  { presetId: 'contracts_finance' },
  { presetId: 'contracts_deadlines' },
  { presetId: 'contracts_requisites' },
  { presetId: 'engines' },
  { presetId: 'engine_stages' },
  { presetId: 'engine_flow_by_counterparty' },
  { presetId: 'engine_readiness_to_assemble' },
  { presetId: 'scrap_register' },
  { presetId: 'parts_demand' },
  { presetId: 'supply_fulfillment' },
  { presetId: 'supply_receipt_gap' },
  { presetId: 'part_movement_journal' },
  { presetId: 'stock_turnover' },
  { presetId: 'workshop_throughput' },
  { presetId: 'defect_returns_summary' },
  { presetId: 'warehouse_stock_path_audit' },
  { presetId: 'repair_fund_reconciliation' },
  // Ветка «до включения проверки» — единственная, куда доходят движения без хеш-цепочки,
  // и она закрыта фильтром: без него отчёт честно пуст.
  { presetId: 'movement_integrity_audit', filters: { includePreChain: true } },
  { presetId: 'work_order_costs' },
  { presetId: 'work_orders_report' },
  { presetId: 'work_order_payroll' },
  { presetId: 'work_order_payroll_summary' },
  // «Комплектование» строится по одному двигателю — id двигателя тут разрез, а не удобство.
  { presetId: 'engine_kitting', filters: { engineId: ID.engine } },
  // Матрица платежей строится по одному контракту — id контракта тут разрез, а не фильтр-удобство.
  { presetId: 'contract_payments_matrix', filters: { contractId: ID.contract } },
  { presetId: 'payments_overview' },
];

async function runPreset(presetId: string, shape: FixtureShape, filters?: Record<string, unknown>) {
  return buildReportByPreset(stubDb(shape), { presetId: presetId as never, ...(filters ? { filters } : {}) });
}

/**
 * Какие исключения сегодня реально сработали. Фикстура детерминированная, поэтому
 * несработавшее исключение означает не «повезло», а «место починили, строку забыли убрать»;
 * такая строка через полгода прикроет уже настоящий дефект в той же ячейке.
 */
const usedExceptions = new Set<string>();
const exceptionKey = (item: { presetId: string; column: string; kind: string }) =>
  `${item.presetId}.${item.column}.${item.kind}`;

function collectViolations(presetId: string, report: Extract<Awaited<ReturnType<typeof runPreset>>, { ok: true }>): Violation[] {
  const out: Violation[] = [];
  const push = (column: string, value: unknown, leaks: Leak[]) => {
    for (const leak of leaks) out.push({ presetId, column, value: String(value), kind: leak.kind });
  };

  // Только объявленные колонки. Строка носит и служебные поля (`contractId` в потребности
  // деталей — ключ фильтра, не ячейка), но ни таблица, ни CSV, ни 1С-XML, ни «Мои отчёты»
  // их не печатают: все четыре проекции идут строго через `report.columns`
  // (`render.ts:45-48,298-301`, `customReport.ts:373-378`). Проверять их — плодить ложные
  // срабатывания на данных, которых оператор не видит.
  const shownKeys = report.columns.map((column) => column.key);
  for (const row of report.rows) {
    for (const key of shownKeys) push(key, row[key], detectLeaks(row[key]));
  }
  push('subtitle', report.subtitle ?? '', detectLeaks(report.subtitle));
  push('title', report.title ?? '', detectLeaks(report.title));
  for (const note of report.footerNotes ?? []) push('footerNote', note, detectLeaks(note));
  for (const group of report.totalsByGroup ?? []) push('totalsGroup', group.group, detectLeaks(group.group));
  return out;
}

describe('сторож человеко-понятных названий: ни один отчёт не показывает служебный код', () => {
  it('каталог пресетов разложен на покрытые и непокрытые — молчаливого пропуска нет', () => {
    const catalogIds = REPORT_PRESET_DEFINITIONS.map((preset) => String(preset.id));
    const accounted = new Set([
      ...COVERED_PRESETS.map((item) => item.presetId),
      ...HUMAN_LABEL_GUARD_UNCOVERED_PRESETS.map((item) => item.presetId),
    ]);
    const forgotten = catalogIds.filter((id) => !accounted.has(id));
    expect(forgotten, 'пресет не покрыт сторожем и не занесён в список непокрытых с обоснованием').toEqual([]);
  });

  it('список непокрытых не содержит пресетов, которых больше нет в каталоге', () => {
    const catalogIds = new Set(REPORT_PRESET_DEFINITIONS.map((preset) => String(preset.id)));
    const stale = HUMAN_LABEL_GUARD_UNCOVERED_PRESETS.filter((item) => !catalogIds.has(item.presetId));
    expect(stale.map((item) => item.presetId), 'пресет снят с производства — уберите строку').toEqual([]);
  });

  for (const shape of [{ leaky: false }, { leaky: true }] as FixtureShape[]) {
    const flavour = shape.leaky ? 'дырявая фикстура' : 'полная фикстура';

    for (const { presetId, filters } of COVERED_PRESETS) {
      it(`${presetId} (${flavour}): строится, отвечает своим presetId и не печатает кодов`, async () => {
        const report = await runPreset(presetId, shape, filters);
        expect(report.ok, `отчёт не построился: ${report.ok ? '' : report.error}`).toBe(true);
        if (!report.ok) return;

        // Ловушка `getPreset`: на неизвестный id он отдаёт ПЕРВОЕ определение каталога.
        // Без этой сверки сторож молча проверял бы чужие колонки.
        expect(report.presetId).toBe(presetId);

        // Пресет без строк проверяет пустоту и зеленеет ни на чём. Это и есть тот молчаливый
        // пропуск, ради которого пишется явный список непокрытых: не строится — уходи в список.
        expect(report.rows.length, `фикстура не дала ни одной строки — сторож проверяет пустоту`).toBeGreaterThan(0);

        const violations = collectViolations(presetId, report)
          .filter((v) => {
            const exception = findGuardException(presetId, v.column, v.kind);
            if (exception) usedExceptions.add(exceptionKey(exception));
            return !exception;
          })
          .map((v) => `${v.column}: ${v.kind} — «${v.value}»`);
        expect(violations, `служебные коды в отчёте ${presetId}`).toEqual([]);
      });
    }
  }

  // Прогоняется по ВСЕМУ каталогу, а не только по покрытым: объект итогов билдеры формируют
  // и на пустом наборе строк, поэтому подписи проверяются даже там, где фикстура строк не даёт.
  it('каждый ключ строки «Итого» имеет подпись', async () => {
    const uncovered: string[] = [];
    const filtersById = new Map(COVERED_PRESETS.map((item) => [item.presetId, item.filters]));
    for (const preset of REPORT_PRESET_DEFINITIONS) {
      const presetId = String(preset.id);
      const report = await runPreset(presetId, { leaky: false }, filtersById.get(presetId));
      if (!report.ok) continue;
      const keys = new Set<string>(Object.keys(report.totals ?? {}));
      for (const group of report.totalsByGroup ?? []) for (const key of Object.keys(group.totals)) keys.add(key);
      for (const key of keys) {
        if (!hasHumanLabel('report_total', key)) uncovered.push(`${presetId}.${key}`);
      }
    }
    expect(uncovered, 'ключ итога без подписи печатается оператору прочерком вместо названия').toEqual([]);
  });

  // Последним по счёту: к этому моменту прогоны выше уже отметили, какие исключения сработали.
  it('в списке исключений нет строк, которые больше ничего не прощают', () => {
    const dead = HUMAN_LABEL_GUARD_EXCEPTIONS.filter((item) => !usedExceptions.has(exceptionKey(item)));
    expect(
      dead.map(exceptionKey),
      'место починили — уберите исключение, иначе оно прикроет следующий дефект в той же ячейке',
    ).toEqual([]);
  });
});
