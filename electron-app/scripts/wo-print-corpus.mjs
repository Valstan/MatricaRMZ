/**
 * Корпус ЗАКРЫТЫХ нарядов РМЗ для аудита печати (промт КАРМАНА #165, шаг 1).
 *
 * Зачем он нужен: печать наряда проверяется не «на глаз», а измерением — сколько
 * страниц A4 получается и влезают ли колонки в ширину листа. Локальная dev-БД
 * закрытых нарядов РМЗ не содержит (в ней только черновики без строк), прод не
 * трогаем, поэтому корпус собран из реальной номенклатуры РМЗ и форм наряда
 * (виды работ, клейма, состав бригады, длина наименований изделий), которые берутся
 * из номенклатуры завода (`backend-api/src/scripts/seedPortfolioDemo.ts`) и из
 * `docs/zavod/FACTORY_MODEL.md`.
 *
 * Персоналии — вымышленные (правило репо: реальные ФИО сотрудников в отслеживаемых
 * файлах не храним). Формы, длина названий, число строк и колонок — реальные.
 *
 * Формат кейса: `{ id, title, note, payload, deps }` — `deps` в формате `WoPrintDeps`
 * (`electron-app/src/renderer/src/ui/utils/woPrintModel.ts`).
 */

/** Сотрудники цеха 1 — вымышленные, как требует правило репо про ПДн. */
const EMPLOYEES = [
  { id: 'e-ivanov', displayName: 'Иванов Иван Иванович', lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович', position: 'Слесарь 5 разряда', workshopId: 'w-1', personnelNumber: '1043', departmentName: 'Ремонтный участок' },
  { id: 'e-petrov', displayName: 'Петров Пётр Петрович', lastName: 'Петров', firstName: 'Пётр', middleName: 'Петрович', position: 'Слесарь 4 разряда', workshopId: 'w-1', personnelNumber: '1044', departmentName: 'Ремонтный участок' },
  { id: 'e-sidorov', displayName: 'Сидоров Сидор Сидорович', lastName: 'Сидоров', firstName: 'Сидор', middleName: 'Сидорович', position: 'Слесарь 6 разряда', workshopId: 'w-1', personnelNumber: '1045', departmentName: 'Ремонтный участок' },
  { id: 'e-kuznetsov', displayName: 'Кузнецов Николай Николаевич', lastName: 'Кузнецов', firstName: 'Николай', middleName: 'Николайевич', position: 'Мастер участка', workshopId: 'w-1', personnelNumber: '1046', departmentName: 'Ремонтный участок' },
  { id: 'e-smirnov', displayName: 'Смирнов Сергей Сергеевич', lastName: 'Смирнов', firstName: 'Сергей', middleName: 'Сергеевич', position: 'Специалист по нормированию', workshopId: 'w-1', personnelNumber: '1047', departmentName: 'ППО' },
];

const WORKSHOPS = [
  { id: 'w-1', name: 'Цех №1 ремонта двигателей' },
  { id: 'w-2', name: 'Цех №2 ремонта двигателей' },
];

const WAREHOUSES = [
  { id: 'wh-1', code: 'TSH1', name: 'Главный склад цеха №1' },
  { id: 'wh-2', code: 'TSH2', name: 'Главный склад цеха №2' },
];

const ENGINES = [
  { id: 'eng-41-26', engineNumber: '12345', engineInternalNumber: '41/26', engineBrandName: 'Р-84' },
  { id: 'eng-52-11', engineNumber: '12780', engineInternalNumber: '52/11', engineBrandName: 'Р-84' },
  { id: 'eng-63-04', engineNumber: '13102', engineInternalNumber: '63/04', engineBrandName: 'ТНД-1' },
];

/** Номенклатура РМЗ: короткие и длинные наименования (длинные и рвут колонку). */
const PARTS = [
  { id: 'p-gbc', name: 'Прокладка ГБЦ', article: 'ПР-0142' },
  { id: 'p-gbc-kit', name: 'Комплект прокладок двигателя', article: 'ПР-0142-К' },
  { id: 'p-ras', name: 'Вал распределительный', article: 'ВР-0088' },
  { id: 'p-mah', name: 'Маховик', article: 'МХ-0021' },
  { id: 'p-tk', name: 'Турбокомпрессор ТКР 7-10С с турбиной', article: 'ТКР-7-10С' },
  { id: 'p-tk-long', name: 'Колонва газовой турбины турбокомпрессора ТКР 7-10С производства АО «Малмыжский РМЗ»', article: 'КТ-ТКР-7-10С' },
  { id: 'p-fors', name: 'Форсунка форсунки дизельного двигателя 12НВК.01.010-20', article: '12НВК.01.010-20' },
  { id: 'p-blok', name: 'Блок цилиндров', article: 'БЦ-0113' },
  { id: 'p-kol', name: 'Коленчатый вал', article: 'КВ-0044' },
  { id: 'p-gb', name: 'Головка блока цилиндров', article: 'ГБЦ-0114' },
  { id: 'p-nabor', name: 'Комплект прокладок ГБЦ и картера двигателя для дизельных двигателей Р-84', article: 'ПР-0142-КОМП' },
  { id: 'p-vkl', name: 'Клапан впускной', article: 'КЛП-0033' },
];

const ENGINE_CONTRACT_INFO = {
  'eng-41-26': { contractSuffix: '*239', counterparty: 'АО «Машиностроительный завод»' },
  'eng-52-11': { contractSuffix: '*241', counterparty: 'ООО «ТЭК-Запчасть»' },
  'eng-63-04': { contractSuffix: '*247', counterparty: 'ПАО «Судостроительный завод»' },
};

/** Виды работ РМЗ (справочник услуг) — реальные формулировки цехов. */
const SERVICES = {
  razborka: { serviceId: 'svc-razborka', serviceName: 'Разборка двигателя, мойка узлов', unit: 'нормо-час', priceRub: 950 },
  defekt: { serviceId: 'svc-defekt', serviceName: 'Дефектовка узлов с обмером', unit: 'нормо-час', priceRub: 1100 },
  shlif: { serviceId: 'svc-shlif', serviceName: 'Шлифовка коленчатого вала', unit: 'шт', priceRub: 28500 },
  rasto: { serviceId: 'svc-rasto', serviceName: 'Расточка блока цилиндров', unit: 'шт', priceRub: 34200 },
  postel: { serviceId: 'svc-postel', serviceName: 'Восстановление постелей коленвала', unit: 'шт', priceRub: 21800 },
  prityrka: { serviceId: 'svc-prityrka', serviceName: 'Притирка клапанов ГБЦ', unit: 'компл', priceRub: 9600 },
  sborka: { serviceId: 'svc-sborka', serviceName: 'Сборка двигателя', unit: 'нормо-час', priceRub: 1250 },
  zakl: { serviceId: 'svc-zakl', serviceName: 'Закрепление шпонки вкладышей коленвала', unit: 'шт', priceRub: 7400 },
  montazh: { serviceId: 'svc-montazh', serviceName: 'Установка и настройка турбокомпрессора', unit: 'нормо-час', priceRub: 2150 },
  opn: { serviceId: 'svc-opn', serviceName: 'Опробование двигателя после сборки', unit: 'нормо-час', priceRub: 1680 },
};

/** 2026-05-13 — локальная полночь (как из date-input). */
function day(y, m, d) {
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}

function line(over) {
  return {
    lineNo: 1,
    serviceId: null,
    serviceName: '',
    unit: 'шт',
    qty: 1,
    priceRub: 0,
    amountRub: 0,
    productNumber: '',
    engineId: null,
    engineNumber: '',
    engineBrandName: '',
    partId: null,
    partName: '',
    ...over,
  };
}

function crew(...ids) {
  return ids.map((employeeId, idx) => {
    const emp = EMPLOYEES.find((e) => e.id === employeeId);
    return {
      employeeId,
      employeeName: emp?.displayName ?? '',
      ktu: [0.9, 1, 1.1, 1.2, 1.3][idx % 5],
      payoutRub: 12000 + idx * 3400,
      payoutFrozen: false,
    };
  });
}

function base(over) {
  return {
    kind: 'work_order',
    version: 5,
    operationId: 'op-1',
    workOrderNumber: 412,
    orderDate: day(2026, 5, 13),
    startDate: day(2026, 5, 14),
    dueDate: day(2026, 6, 2),
    completedDate: day(2026, 6, 2),
    crew: [],
    workGroups: [],
    freeWorks: [],
    works: [],
    totalAmountRub: 0,
    basePerWorkerRub: 0,
    payouts: [],
    workshopId: 'w-1',
    ...over,
  };
}

function deps(over) {
  return {
    employees: EMPLOYEES,
    engines: ENGINES,
    parts: PARTS,
    workshops: WORKSHOPS,
    warehouseLocations: WAREHOUSES,
    engineContractInfo: ENGINE_CONTRACT_INFO,
    hiddenFields: new Set(),
    ...over,
  };
}

/** Полный набор кейсов: по одному на каждую форму и на каждую «болезнь» листа. */
export function buildRmzClosedWorkOrderCorpus() {
  return [
    {
      id: 'rmz-closed-repair-short',
      title: 'Ремонтный наряд №412 — короткий (1 работа, 1 сотрудник)',
      note: 'Базовый случай: проверяем, что печать не ломается на самом простом наряде.',
      payload: base({
        workOrderNumber: 412,
        workOrderKind: 'repair',
        crew: crew('e-ivanov'),
        totalAmountRub: 950,
        freeWorks: [line({ ...SERVICES.razborka, qty: 1, amountRub: 950, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' })],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-repair-typical',
      title: 'Ремонтный наряд №413 — типовой (4 работы, 2 сотрудника)',
      note: 'Типовой закрытый наряд цеха: несколько видов работ, бригада из двух человек.',
      payload: base({
        workOrderNumber: 413,
        workOrderKind: 'repair',
        crew: crew('e-ivanov', 'e-petrov'),
        totalAmountRub: 65100,
        freeWorks: [
          line({ ...SERVICES.razborka, qty: 4, amountRub: 3800, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044' }),
          line({ ...SERVICES.defekt, qty: 2, amountRub: 2200, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.shlif, qty: 1, amountRub: 28500, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044' }),
          line({ ...SERVICES.prityrka, qty: 1, amountRub: 9600, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-gbc', partName: 'Прокладка ГБЦ', partArticle: 'ПР-0142' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-repair-long-part-name',
      title: 'Ремонтный наряд №414 — длинное наименование изделия',
      note: 'Наименование колонвы турбокомпрессора в одну строку не влезает — колонка «Наименование изделия» распирает таблицу.',
      payload: base({
        workOrderNumber: 414,
        workOrderKind: 'repair',
        crew: crew('e-sidorov'),
        totalAmountRub: 43100,
        freeWorks: [
          line({ ...SERVICES.montazh, qty: 1, amountRub: 21500, engineId: 'eng-52-11', engineNumber: '12780', engineBrandName: 'Р-84', partId: 'p-tk-long', partName: 'Колонва газовой турбины турбокомпрессора ТКР 7-10С производства АО «Малмыжский РМЗ»', partArticle: 'КТ-ТКР-7-10С' }),
          line({ ...SERVICES.shlif, qty: 1, amountRub: 28500, engineId: 'eng-52-11', engineNumber: '12780', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-repair-stamped',
      title: 'Ремонтный наряд №415 — клейма деталей (колонка «№ детали»)',
      note: 'Несколько клейм в одной строке: колонка «№ детали» съедает ширину и уводит «Цена»/«Сумма» за край.',
      payload: base({
        workOrderNumber: 415,
        workOrderKind: 'repair',
        crew: crew('e-ivanov', 'e-petrov'),
        totalAmountRub: 28800,
        freeWorks: [
          line({ ...SERVICES.prityrka, qty: 4, amountRub: 9600, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-vkl', partName: 'Клапан впускной', partArticle: 'КЛП-0033', stampedNumbers: ['2411', '2412', '2413', '2414'] }),
          line({ ...SERVICES.zakl, qty: 1, amountRub: 7400, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044', stampedNumbers: ['2388'] }),
          line({ ...SERVICES.shlif, qty: 1, amountRub: 11800, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-blok', partName: 'Блок цилиндров', partArticle: 'БЦ-0113', stampedNumbers: ['2290', '2291'] }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-repair-big-crew',
      title: 'Ремонтный наряд №416 — бригада из 6 человек',
      note: 'Широкая таблица бригады с колонкой росписи: с шестью работниками уходит за край и съедает высоту листа.',
      payload: base({
        workOrderNumber: 416,
        workOrderKind: 'repair',
        crew: crew('e-ivanov', 'e-petrov', 'e-sidorov', 'e-kuznetsov', 'e-smirnov', 'e-ivanov'),
        totalAmountRub: 44000,
        freeWorks: [
          line({ ...SERVICES.razborka, qty: 6, amountRub: 5700, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.defekt, qty: 4, amountRub: 4400, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.sborka, qty: 3, amountRub: 3750, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-repair-many-lines',
      title: 'Ремонтный наряд №417 — 12 видов работ с длинными наименованиями',
      note: 'Предельный случай объёма: 12 строк И длинные наименования изделия.',
      payload: base({
        workOrderNumber: 417,
        workOrderKind: 'repair',
        crew: crew('e-ivanov', 'e-petrov'),
        totalAmountRub: 92000,
        freeWorks: [
          line({ ...SERVICES.razborka, qty: 6, amountRub: 5700, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-blok', partName: 'Блок цилиндров', partArticle: 'БЦ-0113' }),
          line({ ...SERVICES.defekt, qty: 4, amountRub: 4400, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.shlif, qty: 1, amountRub: 28500, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044' }),
          line({ ...SERVICES.rasto, qty: 1, amountRub: 34200, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-blok', partName: 'Блок цилиндров', partArticle: 'БЦ-0113' }),
          line({ ...SERVICES.postel, qty: 1, amountRub: 21800, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044' }),
          line({ ...SERVICES.prityrka, qty: 1, amountRub: 9600, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-gbc', partName: 'Прокладка ГБЦ', partArticle: 'ПР-0142' }),
          line({ ...SERVICES.zakl, qty: 1, amountRub: 7400, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.montazh, qty: 1, amountRub: 21500, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-tk', partName: 'Турбокомпрессор ТКР 7-10С с турбиной', partArticle: 'ТКР-7-10С' }),
          line({ ...SERVICES.sborka, qty: 3, amountRub: 3750, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.opn, qty: 2, amountRub: 3360, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.defekt, qty: 3, amountRub: 3300, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-gb', partName: 'Головка блока цилиндров', partArticle: 'ГБЦ-0114' }),
          line({ ...SERVICES.razborka, qty: 1, amountRub: 950, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-nabor', partName: 'Комплект прокладок ГБЦ и картера двигателя для дизельных двигателей Р-84', partArticle: 'ПР-0142-КОМП' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-repair-many-short-lines',
      title: 'Ремонтный наряд №423 — 12 видов работ с короткими наименованиями',
      note: 'Тот же объём, но реальные названия деталей РМЗ («Коленчатый вал», «Маховик»): влезает ли наряд в один лист.',
      payload: base({
        workOrderNumber: 423,
        workOrderKind: 'repair',
        crew: crew('e-ivanov', 'e-petrov'),
        totalAmountRub: 88000,
        freeWorks: [
          line({ ...SERVICES.razborka, qty: 6, amountRub: 5700, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-blok', partName: 'Блок цилиндров', partArticle: 'БЦ-0113' }),
          line({ ...SERVICES.defekt, qty: 4, amountRub: 4400, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.shlif, qty: 1, amountRub: 28500, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044' }),
          line({ ...SERVICES.rasto, qty: 1, amountRub: 34200, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-blok', partName: 'Блок цилиндров', partArticle: 'БЦ-0113' }),
          line({ ...SERVICES.postel, qty: 1, amountRub: 21800, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044' }),
          line({ ...SERVICES.prityrka, qty: 1, amountRub: 9600, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-gbc', partName: 'Прокладка ГБЦ', partArticle: 'ПР-0142' }),
          line({ ...SERVICES.zakl, qty: 1, amountRub: 7400, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.montazh, qty: 1, amountRub: 21500, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-tk', partName: 'Турбокомпрессор ТКР 7-10С', partArticle: 'ТКР-7-10С' }),
          line({ ...SERVICES.sborka, qty: 3, amountRub: 3750, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.opn, qty: 2, amountRub: 3360, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.defekt, qty: 3, amountRub: 3300, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-gb', partName: 'Головка блока цилиндров', partArticle: 'ГБЦ-0114' }),
          line({ ...SERVICES.razborka, qty: 1, amountRub: 950, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-mah', partName: 'Маховик', partArticle: 'МХ-0021' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-repair-period-mode',
      title: 'Ремонтный наряд №424 — режим «период»',
      note: 'Оператор внёс период «с 13 мая по 2 июня»: в наряде печатается общий период, у отдельных работ дат нет.',
      payload: base({
        workOrderNumber: 424,
        workOrderKind: 'repair',
        crew: crew('e-ivanov', 'e-petrov'),
        totalAmountRub: 38000,
        workDateMode: 'period',
        workPeriods: [{ employeeId: '', from: day(2026, 5, 13), to: day(2026, 6, 2) }],
        freeWorks: [
          line({ ...SERVICES.razborka, qty: 4, amountRub: 3800, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-blok', partName: 'Блок цилиндров', partArticle: 'БЦ-0113' }),
          line({ ...SERVICES.defekt, qty: 2, amountRub: 2200, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.shlif, qty: 1, amountRub: 28500, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-repair-daily-mode',
      title: 'Ремонтный наряд №425 — режим «ежедневно» (две бригады, разные дни)',
      note: 'У каждой работы своя дата и свой исполнитель: 13-го пять головок, 14-го семь, 15-го одна.',
      payload: base({
        workOrderNumber: 425,
        workOrderKind: 'repair',
        crew: crew('e-ivanov', 'e-petrov'),
        totalAmountRub: 38000,
        workDateMode: 'daily',
        freeWorks: [
          line({ ...SERVICES.razborka, qty: 5, amountRub: 4750, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-blok', partName: 'Блок цилиндров', partArticle: 'БЦ-0113', workDate: day(2026, 5, 13), workAssigneeId: 'e-ivanov' }),
          line({ ...SERVICES.defekt, qty: 7, amountRub: 7700, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', workDate: day(2026, 5, 14), workAssigneeId: 'e-ivanov' }),
          line({ ...SERVICES.shlif, qty: 1, amountRub: 28500, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044', workDate: day(2026, 5, 15), workAssigneeId: 'e-petrov' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-repair-daily-mode-mixed',
      title: 'Ремонтный наряд №426 — «ежедневно» у одного, «период» у другого',
      note: 'Один сотрудник работает по дням, другой закрывает наряд за период: даты не смешиваются.',
      payload: base({
        workOrderNumber: 426,
        workOrderKind: 'repair',
        crew: crew('e-ivanov', 'e-petrov'),
        totalAmountRub: 38000,
        workDateMode: 'daily',
        workPeriods: [{ employeeId: 'e-petrov', from: day(2026, 5, 20), to: day(2026, 6, 2) }],
        freeWorks: [
          line({ ...SERVICES.razborka, qty: 5, amountRub: 4750, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', workDate: day(2026, 5, 13), workAssigneeId: 'e-ivanov' }),
          line({ ...SERVICES.defekt, qty: 7, amountRub: 7700, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', workDate: day(2026, 5, 14), workAssigneeId: 'e-ivanov' }),
          line({ ...SERVICES.shlif, qty: 1, amountRub: 28500, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044', workAssigneeId: 'e-petrov' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-regular',
      title: 'Обычный наряд №418 — промежуточные работы',
      note: 'Форма «обычный»: без склада, но с грифом «Согласовано» внизу листа.',
      payload: base({
        workOrderNumber: 418,
        workOrderKind: 'regular',
        crew: crew('e-petrov'),
        totalAmountRub: 2200,
        freeWorks: [
          line({ ...SERVICES.defekt, qty: 2, amountRub: 2200, engineId: 'eng-63-04', engineNumber: '13102', engineBrandName: 'ТНД-1' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-manufacturing',
      title: 'Наряд на изготовление №419 — новая деталь',
      note: 'Форма «изготовление»: деталь идёт на склад цеха, длинное наименование.',
      payload: base({
        workOrderNumber: 419,
        workOrderKind: 'manufacturing',
        crew: crew('e-sidorov'),
        totalAmountRub: 35000,
        freeWorks: [
          line({ ...SERVICES.rasto, qty: 1, amountRub: 34200, engineId: 'eng-52-11', engineNumber: '12780', engineBrandName: 'Р-84', partId: 'p-tk-long', partName: 'Колонва газовой турбины турбокомпрессора ТКР 7-10С производства АО «Малмыжский РМЗ»', partArticle: 'КТ-ТКР-7-10С' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-workshop-template',
      title: 'Наряд по шаблону цеха №420 — 8 выпущенных строк',
      note: 'Историческая форма: при закрытии остаются только выпущенные строки — их много.',
      payload: base({
        workOrderNumber: 420,
        workOrderKind: 'workshop_template',
        crew: crew('e-ivanov', 'e-petrov', 'e-sidorov'),
        totalAmountRub: 64000,
        freeWorks: [
          line({ ...SERVICES.shlif, qty: 1, amountRub: 28500, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044' }),
          line({ ...SERVICES.postel, qty: 1, amountRub: 21800, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-kol', partName: 'Коленчатый вал', partArticle: 'КВ-0044' }),
          line({ ...SERVICES.zakl, qty: 1, amountRub: 7400, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.prityrka, qty: 1, amountRub: 9600, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-gbc', partName: 'Прокладка ГБЦ', partArticle: 'ПР-0142' }),
          line({ ...SERVICES.rasto, qty: 1, amountRub: 34200, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-blok', partName: 'Блок цилиндров', partArticle: 'БЦ-0113' }),
          line({ ...SERVICES.razborka, qty: 2, amountRub: 1900, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.defekt, qty: 2, amountRub: 2200, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
          line({ ...SERVICES.sborka, qty: 1, amountRub: 1250, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84' }),
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-assembly',
      title: 'Сборочный наряд №421 — сборка двигателя',
      note: 'Форма «сборка»: гриф директора, бригада, склады и двухфазные подписи.',
      payload: base({
        workOrderNumber: 421,
        workOrderKind: 'assembly',
        crew: crew('e-ivanov', 'e-petrov', 'e-sidorov', 'e-kuznetsov'),
        totalAmountRub: 58000,
        assemblyEngineId: 'eng-41-26',
        freeWorks: [
          line({ ...SERVICES.sborka, qty: 4, amountRub: 5000, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-blok', partName: 'Блок цилиндров', partArticle: 'БЦ-0113', sourceWarehouseId: 'wh-1' }),
          line({ ...SERVICES.montazh, qty: 1, amountRub: 21500, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-tk', partName: 'Турбокомпрессор ТКР 7-10С с турбиной', partArticle: 'ТКР-7-10С', sourceWarehouseId: 'wh-1' }),
          line({ ...SERVICES.opn, qty: 3, amountRub: 5040, engineId: 'eng-41-26', engineNumber: '12345', engineBrandName: 'Р-84', partId: 'p-fors', partName: 'Форсунка форсунки дизельного двигателя 12НВК.01.010-20', partArticle: '12НВК.01.010-20', sourceWarehouseId: 'wh-2' }),
        ],
        signatureBlocks: [
          { blockId: 'issue', slots: [{ caption: 'Наряд выдал', employeeId: 'e-smirnov' }, { caption: 'Согласовано (ОТК)' }, { caption: 'Принял в работу', employeeId: 'e-kuznetsov' }] },
          { blockId: 'completion', slots: [{ caption: 'Работу сдал', employeeId: 'e-ivanov' }, { caption: 'Работу принял (ОТК)' }, { caption: 'Работу принял', employeeId: 'e-kuznetsov' }] },
        ],
      }),
      deps: deps(),
    },
    {
      id: 'rmz-closed-assembly-wide',
      title: 'Сборочный наряд №422 — длинные наименования и 5 сотрудников бригады',
      note: 'Самый тяжёлый случай: длинные наименования изделия + широкая бригада + подписи.',
      payload: base({
        workOrderNumber: 422,
        workOrderKind: 'assembly',
        crew: crew('e-ivanov', 'e-petrov', 'e-sidorov', 'e-kuznetsov', 'e-smirnov'),
        totalAmountRub: 118000,
        assemblyEngineId: 'eng-52-11',
        freeWorks: [
          line({ ...SERVICES.sborka, qty: 5, amountRub: 6250, engineId: 'eng-52-11', engineNumber: '12780', engineBrandName: 'Р-84', partId: 'p-tk-long', partName: 'Колонва газовой турбины турбокомпрессора ТКР 7-10С производства АО «Малмыжский РМЗ»', partArticle: 'КТ-ТКР-7-10С', sourceWarehouseId: 'wh-1' }),
          line({ ...SERVICES.montazh, qty: 2, amountRub: 43000, engineId: 'eng-52-11', engineNumber: '12780', engineBrandName: 'Р-84', partId: 'p-fors', partName: 'Форсунка форсунки дизельного двигателя 12НВК.01.010-20', partArticle: '12НВК.01.010-20', sourceWarehouseId: 'wh-1' }),
          line({ ...SERVICES.opn, qty: 2, amountRub: 3360, engineId: 'eng-52-11', engineNumber: '12780', engineBrandName: 'Р-84', partId: 'p-nabor', partName: 'Комплект прокладок ГБЦ и картера двигателя для дизельных двигателей Р-84', partArticle: 'ПР-0142-КОМП', sourceWarehouseId: 'wh-2' }),
          line({ ...SERVICES.razborka, qty: 1, amountRub: 950, engineId: 'eng-52-11', engineNumber: '12780', engineBrandName: 'Р-84', partId: 'p-gbc-kit', partName: 'Комплект прокладок двигателя', partArticle: 'ПР-0142-К', sourceWarehouseId: 'wh-1' }),
        ],
        signatureBlocks: [
          { blockId: 'issue', slots: [{ caption: 'Наряд выдал', employeeId: 'e-smirnov' }, { caption: 'Согласовано (ОТК)' }, { caption: 'Принял в работу', employeeId: 'e-kuznetsov' }] },
          { blockId: 'completion', slots: [{ caption: 'Работу сдал', employeeId: 'e-ivanov' }, { caption: 'Работу принял (ОТК)' }, { caption: 'Работу принял', employeeId: 'e-kuznetsov' }] },
        ],
      }),
      deps: deps(),
    },
  ];
}
