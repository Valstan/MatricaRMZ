/**
 * Единый реестр человеко-понятных подписей. Правило проекта: оператору никогда не
 * показывается служебный код и никогда не показывается идентификатор. Нет подписи —
 * прочерк.
 *
 * НАПРАВЛЕНИЕ ИМПОРТА: файл — лист-потребитель. Ничто из shared/src/domain не имеет
 * права его импортировать: при цикле нативный ESM даст ReferenceError на загрузке
 * модуля, а под CJS-транспиляцией (vitest, бандл electron) — молча undefined, и
 * реестр окажется пустым в момент построения таблицы доменов.
 *
 * Реестр не переписывает существующие словари, а агрегирует их импортом; переезжают
 * сюда только бездомные (те, у которых не было единственного владельца).
 *
 * КОГДА ЗАВОДИТЬ ДОМЕН. Только для ЗАКРЫТОГО множества кодов — такого, где перечень задан
 * union-типом или enum'ом и компилятор поймает расхождение. Для открытого множества (коды
 * заводит оператор в редактируемой схеме) домен вреден: он превращает всё незнакомое в
 * прочерк, то есть теряет данные, которых сам не знает. Там подпись берётся из живой схемы.
 *
 * КАКОЙ ТЕКСТ СТАВИТЬ, КОГДА ПОДПИСИ НЕТ. Всегда `HUMAN_LABEL_DASH`. Отдельный текст
 * допустим только там, где прочерк схлопывает разрез или убивает единственный смысл ячейки,
 * и заводится он именованной константой здесь же — не на месте употребления, иначе через
 * полгода в проекте будет три разных «нет подписи».
 */
import { OPERATION_DESCRIPTORS, OPERATION_STATUS_LABELS } from './engineTimeline.js';
import { SUPPLY_REQUEST_STATUS_LABELS } from './supplyRequest.js';

export const HUMAN_LABEL_DASH = '—';

/**
 * Единственный в проекте детектор «это идентификатор, а не текст». Форма 8-4-4-4-12 из
 * шестнадцатеричных цифр — без ограничений на версию и вариант: системные идентификаторы
 * проекта (`00000000-0000-0000-0000-…`) версии не несут, а прежняя строгая проверка их
 * пропускала как «текст». Человеческое название такой формы иметь не может, так что
 * ослабление ничего не ломает: «DIESEL-2024-A» под шаблон не подходит.
 */
export function looksLikeIdentifier(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/** Первый непустой кандидат, не похожий на идентификатор. Никогда не отдаёт id. */
export function pickHumanText(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' && typeof candidate !== 'number') continue;
    const text = String(candidate).trim();
    if (!text || looksLikeIdentifier(text)) continue;
    return text;
  }
  return '';
}

/**
 * Фазы двигателя (EAV `engine_phase`). Коды заводит сервер (`enginePhaseService`), но
 * подписей у них не было нигде — оператор видел `received` / `in_assembly` как есть.
 */
export const ENGINE_PHASE_LABELS: Record<string, string> = {
  received: 'Принят',
  disassembled: 'Разобран',
  in_assembly: 'В сборке',
  assembled: 'Собран',
  shipped: 'Отгружен',
};

/**
 * Подписи строки «Итого» отчётов. Жили двумя копиями — в сборщике отчётов main и в
 * предпросмотре рендерера, — и расходились четырьмя ключами: оператор видел в PDF
 * русские подписи, а в предпросмотре того же отчёта сырые `totalKtu` и `avgKtu`.
 */
export const REPORT_TOTAL_LABELS: Record<string, string> = {
  employees: 'Сотрудники, шт.',
  workingEmployees: 'Работают, шт.',
  firedEmployees: 'Уволены, шт.',
  firedInPeriod: 'Уволены за период, шт.',
  counterparties: 'Контрагенты, шт.',
  tools: 'Инструменты, шт.',
  inInventory: 'В учете, шт.',
  retired: 'Списано, шт.',
  services: 'Услуги, шт.',
  products: 'Товары, шт.',
  parts: 'Детали, шт.',
  brands: 'Марки, шт.',
  scrapQty: 'Утиль, шт.',
  missingQty: 'Недокомплект, шт.',
  deliveredQty: 'Привезено, шт.',
  remainingNeedQty: 'Остаточная потребность, шт.',
  engines: 'Двигатели, шт.',
  progressPct: 'Прогресс, %',
  contracts: 'Контракты, шт.',
  totalQty: 'Общий объем, шт.',
  totalAmountRub: 'Сумма, ₽',
  orderedQty: 'Заказано, шт.',
  remainingQty: 'Остаток, шт.',
  fulfillmentPct: '% выполнения',
  workOrders: 'Наряды, шт.',
  lines: 'Записей, шт.',
  amountRub: 'Сумма, ₽',
  totalKtu: 'КТУ суммарно',
  avgKtu: 'КТУ средний',
  avgWorkOrderAmountRub: 'Средняя сумма на наряд, ₽',
  avgAmountRub: 'Средняя цена, ₽',
  onSiteQty: 'На заводе, шт.',
  years: 'Лет в отчёте',
  overdueContracts: 'Просрочено, шт.',
  dueSoonContracts: 'Срок до 30 дней, шт.',
  withIgk: 'С ИГК, шт.',
  withoutIgk: 'Без ИГК, шт.',
  withSeparateAccount: 'С отдельным счетом, шт.',
  withoutSeparateAccount: 'Без отдельного счета, шт.',
  dualPathRows: 'Двойной учёт, шт.',
  nomOnlyRows: 'Только номенклатура, шт.',
  partOnlyRows: 'Только карточка детали, шт.',
  forecastRows: 'Строк прогноза, шт.',
  plannedEngines: 'Двигателей в плане, шт.',
  planQty: 'План, шт.',
  arrivedQty: 'Приехало, шт.',
  awaitingQty: 'Ожидается, шт.',
  atFactoryQty: 'На заводе, шт.',
  readyNotShippedQty: 'Готово, не отгружено, шт.',
  shippedQty: 'Отгружено, шт.',
  overdueDays: 'Просрочка, дн.',
  avgTatDays: 'Средний срок ремонта, дн.',
  positions: 'Позиций, шт.',
  customerQty: 'Ветка «заказчик», шт.',
  repairQty: 'Ветка «ремонт», шт.',
  purchaseQty: 'Ветка «закупка», шт.',
  noBranchQty: 'Без ветки, шт.',
  // Ключи, которые обе прежние копии не покрывали вовсе: оператор видел их сырыми
  // (`slots: 7`, `okHashed: 412`) в строке «Итого» тринадцати отчётов.
  structures: 'Структурных единиц, шт.',
  totalPositions: 'Позиций в спецификации, шт.',
  positionsDone: 'Позиций укомплектовано, шт.',
  positionsDeficit: 'Позиций с дефицитом, шт.',
  totalDeficitQty: 'Дефицит, шт.',
  totalPlanQty: 'План закупки, шт.',
  totalToPurchaseQty: 'К закупке, шт.',
  positionsWithoutNorm: 'Позиций без нормы, шт.',
  slots: 'Платёжных позиций, шт.',
  priceRub: 'Цена, ₽',
  advanceRub: 'Аванс, ₽',
  extraAdvanceRub: 'Дополнительный аванс, ₽',
  finalRub: 'Окончательный расчёт, ₽',
  paidRub: 'Оплачено, ₽',
  deltaRub: 'Разница, ₽',
  payments: 'Платежей, шт.',
  movements: 'Движений, шт.',
  openingQty: 'Остаток на начало, шт.',
  receiptQty: 'Приход, шт.',
  issueQty: 'Расход, шт.',
  closingQty: 'Остаток на конец, шт.',
  totalRepaired: 'Отремонтировано, шт.',
  totalReturnedQty: 'Возвращено, шт.',
  returns: 'Возвратов, шт.',
  okHashed: 'Записей с целым отпечатком, шт.',
  brokenLinks: 'Разрывов цепочки, шт.',
  preChain: 'Записей до включения проверки, шт.',
  requests: 'Заявок, шт.',
  withReceipt: 'С приходом, шт.',
  withoutReceipt: 'Без прихода, шт.',
  totalInstances: 'Клеймёных экземпляров, шт.',
  totalFundQty: 'Остаток ремфонда, шт.',
  mismatchPositions: 'Позиций с расхождением, шт.',
  orders: 'Нарядов, шт.',
};

const OPERATION_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(OPERATION_DESCRIPTORS).map(([code, descriptor]) => [code, descriptor.label]),
);

export type HumanLabelDomainId =
  | 'operation_type'
  | 'operation_status'
  | 'engine_phase'
  | 'report_total'
  | 'supply_request_status';

const DOMAINS: Record<HumanLabelDomainId, Record<string, string>> = {
  operation_type: OPERATION_TYPE_LABELS,
  operation_status: OPERATION_STATUS_LABELS,
  engine_phase: ENGINE_PHASE_LABELS,
  report_total: REPORT_TOTAL_LABELS,
  supply_request_status: SUPPLY_REQUEST_STATUS_LABELS,
};

/**
 * Подпись кода из домена. Кода нет в домене — отдаём `missing` (по умолчанию прочерк),
 * но НИКОГДА сам код: именно эхо кода и показывало оператору `engine_inventory` в
 * колонке «Текущая стадия».
 */
export function humanLabel(domain: HumanLabelDomainId, code: unknown, missing: string = HUMAN_LABEL_DASH): string {
  if (typeof code !== 'string') return missing;
  const trimmed = code.trim();
  if (!trimmed) return missing;
  // Через hasOwnProperty, а не индексацией: коды приходят из БД, и ключ `constructor`
  // или `toString` вернул бы функцию прототипа вместо подписи.
  if (!hasHumanLabel(domain, trimmed)) return missing;
  return DOMAINS[domain][trimmed] ?? missing;
}

export type ReportTotalKind = 'percent' | 'money' | 'number';

/**
 * Как показывать значение итога. Правило одно на проект: прежде классификация жила
 * двумя одинаковыми копиями (сборщик main и предпросмотр рендерера) и требовала в ключе
 * денег И «amount», И «rub» — из-за чего `priceRub`, `paidRub`, `deltaRub`, `finalRub`,
 * `advanceRub` и `extraAdvanceRub` печатались голым числом под подписью, обещающей ₽.
 */
export function reportTotalKind(key: string): ReportTotalKind {
  const normalized = key.toLowerCase();
  if (normalized.includes('pct')) return 'percent';
  if (normalized.includes('rub') || normalized.includes('₽')) return 'money';
  return 'number';
}

/** Есть ли у кода подпись в домене — для тест-сторожа и для веток «показать как есть». */
export function hasHumanLabel(domain: HumanLabelDomainId, code: string): boolean {
  return Object.prototype.hasOwnProperty.call(DOMAINS[domain], code.trim());
}

/** Все коды домена — источник для тест-сторожа (PR III), чтобы список не разъезжался. */
export function humanLabelDomainCodes(domain: HumanLabelDomainId): string[] {
  return Object.keys(DOMAINS[domain]);
}
