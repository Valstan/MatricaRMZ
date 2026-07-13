export type WorkOrderCrewMember = {
  employeeId: string;
  employeeName: string;
  ktu: number;
  payoutRub?: number;
  payoutFrozen?: boolean;
  manualPayoutRub?: number;
};

export type WorkOrderWorkLine = {
  lineNo: number;
  serviceId: string | null;
  serviceName: string;
  unit: string;
  qty: number;
  priceRub: number;
  amountRub: number;
  // Дополнительные поля наряда
  productNumber?: string;
  engineId?: string | null;
  engineNumber?: string;
  engineBrandId?: string | null;
  engineBrandName?: string;
  // Наименование изделия (деталь из справочника). Используется backend-ом при закрытии
  // наряда: для Repair/Manufacturing → producedLines, для Assembly → consumedLines.
  partId?: string | null;
  partName?: string;
  // Артикул детали (снимок из справочника на момент выбора). Печатается/показывается
  // в отдельной колонке справа от наименования. Если пуст — UI/печать резолвят артикул
  // из справочника по partId как fallback.
  partArticle?: string;
  // Склад-источник для списания детали (только Assembly). Может быть UUID warehouse_ref
  // либо workshop_<code>. Если не задан — backend подставит склад цеха по умолчанию.
  sourceWarehouseId?: string | null;
};

export type WorkOrderAuditTrailItem = {
  at: number;
  by: string;
  action: string;
  note?: string | null;
};

export type WorkOrderWorkGroup = {
  groupId: string;
  partId: string | null;
  partName: string;
  lines: WorkOrderWorkLine[];
};

function workOrderSafeNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function workOrderLineAmountRub(qty: number, priceRub: number): number {
  return Math.round(qty * priceRub * 100) / 100;
}

/** Нормализует строку вида работ наряда, сохраняя № изделия и привязку к двигателю. */
export function normalizeWorkOrderLine(line: unknown, lineNo: number): WorkOrderWorkLine {
  const raw = line && typeof line === 'object' ? (line as Record<string, unknown>) : {};
  const qty = Math.max(0, workOrderSafeNum(raw.qty, 0));
  const priceRub = Math.max(0, workOrderSafeNum(raw.priceRub, 0));
  const result: WorkOrderWorkLine = {
    lineNo,
    serviceId: raw.serviceId ? String(raw.serviceId) : null,
    serviceName: String(raw.serviceName ?? ''),
    unit: String(raw.unit ?? ''),
    qty,
    priceRub,
    amountRub: workOrderLineAmountRub(qty, priceRub),
  };

  const productNumber = String(raw.productNumber ?? '').trim();
  if (productNumber) result.productNumber = productNumber;

  const partId = raw.partId ? String(raw.partId).trim() : '';
  if (partId) {
    result.partId = partId;
    const partName = String(raw.partName ?? '').trim();
    if (partName) result.partName = partName;
    const partArticle = String(raw.partArticle ?? '').trim();
    if (partArticle) result.partArticle = partArticle;
  }

  const sourceWarehouseId = raw.sourceWarehouseId ? String(raw.sourceWarehouseId).trim() : '';
  if (sourceWarehouseId) result.sourceWarehouseId = sourceWarehouseId;

  const engineId = raw.engineId ? String(raw.engineId).trim() : '';
  if (engineId) {
    result.engineId = engineId;
    const engineNumber = String(raw.engineNumber ?? '').trim();
    if (engineNumber) result.engineNumber = engineNumber;
    const engineBrandId = raw.engineBrandId ? String(raw.engineBrandId).trim() : '';
    if (engineBrandId) result.engineBrandId = engineBrandId;
    const engineBrandName = String(raw.engineBrandName ?? '').trim();
    if (engineBrandName) result.engineBrandName = engineBrandName;
  }

  return result;
}

export const WorkOrderKind = {
  Regular: 'regular',
  Repair: 'repair',
  /**
   * @deprecated Replaced by universal work-order templates
   * (`work_order_templates` table + `shared/src/domain/workOrderTemplate.ts`).
   * Kept in the enum for parsing closed legacy operations from v1.26/27.
   * New work-orders never use this kind — Stage 6 of work-order-template-system
   * plan migrated open Workshop-orders to `repair` with `migratedFromWorkshopTemplate`
   * marker; closed orders keep `workshop_template` as a historical value.
   */
  WorkshopTemplate: 'workshop_template',
  Assembly: 'assembly',
  Manufacturing: 'manufacturing',
} as const;

export type WorkOrderKind = (typeof WorkOrderKind)[keyof typeof WorkOrderKind];

export const WORK_ORDER_KIND_LABELS: Record<WorkOrderKind, string> = {
  [WorkOrderKind.Regular]: 'Обычный',
  [WorkOrderKind.Repair]: 'Ремонт',
  [WorkOrderKind.WorkshopTemplate]: 'Ремонт по шаблону цеха',
  [WorkOrderKind.Assembly]: 'Сборка',
  [WorkOrderKind.Manufacturing]: 'Изготовление',
};

/** Короткое описание складского эффекта типа наряда — используется в модалке выбора и подсказках. */
export const WORK_ORDER_KIND_DESCRIPTIONS: Record<WorkOrderKind, string> = {
  [WorkOrderKind.Regular]: 'Промежуточные работы — только для учёта зарплат, без движений по складу.',
  [WorkOrderKind.Repair]: 'Деталь отремонтирована — поступает на склад текущего цеха.',
  [WorkOrderKind.WorkshopTemplate]: 'Список деталей из шаблона цеха. При закрытии выпущенные детали поступают на склад цеха автоматически.',
  [WorkOrderKind.Assembly]: 'Сборка двигателя — детали списываются со склада цеха.',
  [WorkOrderKind.Manufacturing]: 'Изготовление новой детали — поступает на склад текущего цеха.',
};

/**
 * Порядок типов в модалке создания нового наряда. `WorkshopTemplate` исключён
 * после Stage 6 миграции — он остаётся в enum для парсинга закрытых legacy
 * нарядов, но новые наряды через этот picker создать нельзя.
 */
export const WORK_ORDER_KIND_ORDER: readonly WorkOrderKind[] = [
  WorkOrderKind.Regular,
  WorkOrderKind.Repair,
  WorkOrderKind.Assembly,
  WorkOrderKind.Manufacturing,
];

/** Строка планируемого расхода деталей на сборочном наряде. */
export type WorkOrderConsumedLine = {
  lineNo: number;
  nomenclatureId: string;
  qty: number;
  sourceWarehouseId: string;
};

/** Строка планируемого выпуска отремонтированных деталей на ремонтном наряде. */
export type WorkOrderProducedLine = {
  lineNo: number;
  nomenclatureId: string;
  qty: number;
  targetWarehouseId: string;
};

/**
 * Одна строка подписи в блоке: роль/действие (свободный текст, напр. «Наряд выдал»)
 * + выбранный сотрудник. Роли НЕ фиксированы — оператор задаёт их сам. Пустой слот
 * (нет `caption` и `employeeId`) — место под подпись/расшифровку/должность от руки
 * («Добавить пустую подпись»). ФИО и должность резолвятся из карточки сотрудника на
 * печати (`formatEmployeeInitialsSurname` в workOrderSignatures).
 */
export type WorkOrderSignatureSlot = {
  caption?: string;
  employeeId?: string;
};

/**
 * Подписи одного блока (напр. «Выдача наряда»). `blockId` — стабильный id блока
 * (`getWorkOrderSignatureBlocks`, напр. `issue` / `completion`). Порядок `slots` —
 * порядок печати (по две подписи в строку).
 */
export type WorkOrderSignatureBlockSelection = {
  blockId: string;
  slots: WorkOrderSignatureSlot[];
};

/**
 * Настройки печати наряда (панель «Печать»). Все поля опциональны — пусто = дефолт,
 * старые наряды печатаются как раньше.
 * - `titleOverride` — заголовок шапки (пусто = авто «Наряд на <вид работ>»);
 * - `orderDateOverride` — дата для печати, ms (пусто = `orderDate`); реальную дату не меняет;
 * - `font*` — размер шрифта отдельного блока печати в px. Каждый блок шапки регулируется
 *   независимо (гриф директора / заголовок / строка реквизитов) — единого масштаба шапки нет.
 */
export type WorkOrderPrintSettings = {
  titleOverride?: string;
  orderDateOverride?: number;
  /** Кто утверждает наряд в грифе «Утверждаю» (пусто = директор по умолчанию). */
  approver?: WorkOrderApprover;
  /** Переопределение должности утверждающего в грифе (пусто = должность из пресета approver). */
  approverPositionOverride?: string;
  /** Переопределение ФИО утверждающего в грифе — обычно из выбранного сотрудника (пусто = имя из пресета). */
  approverNameOverride?: string;
  /** Id выбранного сотрудника-утверждающего — чтобы отразить выбор в панели печати. */
  approverEmployeeId?: string;
  /**
   * Скрыть реквизит шапки на печати (галочки «Печатать в шапке» панели печати).
   * Отсутствие/false = печатать. Дата создания / приступить / срок / цех.
   */
  hideOrderDate?: boolean;
  hideStartDate?: boolean;
  hideDueDate?: boolean;
  hideWorkshop?: boolean;
  /** Гриф «Утверждаю · Директор» (верхний правый угол). */
  fontDirector?: number;
  /** Заголовок наряда («Наряд на …»). */
  fontTitle?: number;
  /** Строка реквизитов-таблица шапки (№ · Дата · Марка дв. · № дв. · № контр. · Заказчик). */
  fontMeta?: number;
  fontCrew?: number;
  fontWorks?: number;
  fontSignatures?: number;
};

/**
 * Варианты грифа «Утверждаю» в шапке наряда — SSOT для печати и панели печати.
 * `position`/`name` печатаются в верхнем правом углу; `label` — короткая подпись переключателя.
 */
export type WorkOrderApprover = 'director' | 'technical';
export const WORK_ORDER_APPROVERS: Record<WorkOrderApprover, { label: string; position: string; name: string }> = {
  director: { label: 'Директор', position: 'Директор АО «Малмыжский РМЗ»', name: 'И.А. Тихомиров' },
  technical: { label: 'Технический директор', position: 'Технический директор АО «Малмыжский РМЗ»', name: 'В.И. Гурьянов' },
} as const;
export const WORK_ORDER_APPROVER_DEFAULT: WorkOrderApprover = 'director';

/**
 * Действующие должность и ФИО утверждающего для грифа: override оператора (своя должность /
 * выбранный из базы сотрудник) поверх пресета (директор / технический директор). Единый
 * источник для печати и превью, чтобы они не разъезжались.
 */
export function resolveWorkOrderApprover(
  settings: WorkOrderPrintSettings | null | undefined,
): { position: string; name: string } {
  const key = settings?.approver ?? WORK_ORDER_APPROVER_DEFAULT;
  const preset = WORK_ORDER_APPROVERS[key] ?? WORK_ORDER_APPROVERS[WORK_ORDER_APPROVER_DEFAULT];
  const position = String(settings?.approverPositionOverride ?? '').trim() || preset.position;
  const name = String(settings?.approverNameOverride ?? '').trim() || preset.name;
  return { position, name };
}

/** Дефолтные размеры шрифта блоков печати (px) и допустимые диапазоны степперов. */
export const WORK_ORDER_PRINT_FONT_DEFAULTS = { director: 13, title: 22, meta: 13, crew: 14, works: 14, signatures: 13 } as const;
export const WORK_ORDER_PRINT_FONT_RANGES = {
  director: { min: 9, max: 20 },
  title: { min: 14, max: 30 },
  meta: { min: 9, max: 20 },
  crew: { min: 9, max: 20 },
  works: { min: 9, max: 20 },
  signatures: { min: 9, max: 20 },
} as const;

export const WORK_ORDER_PAYLOAD_VERSION = 4 as const;

export type WorkOrderPayload = {
  kind: 'work_order';
  version: 2 | 3 | 4;

  operationId: string;
  workOrderNumber: number;
  orderDate: number;
  /**
   * v4: плановые даты наряда (ms, локальная полночь из date-input). Опциональны,
   * редактируются оператором. `startDate` — «приступить к работе»; `dueDate` — срок
   * исполнения (по нему вычисляется просрочка). `completedDate` — фактическая дата
   * выполнения работ, задаётся оператором перед закрытием (работы могли быть сделаны
   * раньше нажатия кнопки). Если не задана — дата завершения деривится из времени
   * закрытия операции (`updatedAt` при status='closed'). Влияет на показ «Завершён»,
   * вычисление просрочки и период зарплатного отчёта; дату складского документа НЕ меняет.
   */
  startDate?: number;
  dueDate?: number;
  completedDate?: number;

  crew: WorkOrderCrewMember[];
  workGroups: WorkOrderWorkGroup[];
  freeWorks: WorkOrderWorkLine[];
  works: WorkOrderWorkLine[];

  totalAmountRub: number;
  basePerWorkerRub: number;
  payouts: Array<{
    employeeId: string;
    employeeName: string;
    ktu: number;
    amountRub: number;
  }>;

  auditTrail?: WorkOrderAuditTrailItem[];
  // Legacy v1 fields can still be present in old payloads before normalization.
  partId?: string | null;
  partName?: string;

  // v3 (parts-movement / engine-assembly module). All optional for back-compat.
  workshopId?: string;
  workOrderKind?: WorkOrderKind;
  consumedLines?: WorkOrderConsumedLine[];
  producedLines?: WorkOrderProducedLine[];
  /** ID складского документа, созданного при закрытии наряда (engine_dismantling/repair_recovery/assembly_consumption/assembly_return). */
  linkedDocumentId?: string;
  /**
   * Выбранный вариант сборки BOM (`EngineAssemblyBomLine.variantGroup`) для
   * Assembly-наряда. Если у BOM собираемого двигателя несколько вариантов
   * (variantGroup'ов), оператор выбирает один — это поле подсвечивает строки
   * списка деталей двигателя по совпадающему `bom_variant_group`.
   */
  assemblyVariantGroup?: string | null;
  /**
   * Собираемый двигатель Assembly-наряда, заданный один раз в шапке наряда (а не в
   * каждой строке работ). Единый источник: при выборе двигателя в шапке его id/номер/марка
   * проставляются во все строки `freeWorks`, а новые строки его наследуют. На чтение
   * (совместимость со старыми нарядами без поля) резолвится через `resolveAssemblyEngineId`
   * с fallback на `primaryAssemblyEngineId`. `null`/отсутствует — двигатель не выбран.
   */
  assemblyEngineId?: string | null;
  /**
   * Stage 4 нитки assembly-work-order-from-forecast: stable identifier варианта сборки
   * из отчёта «Прогноз сборки двигателей» (формула `buildAssemblyForecastVariantKey`).
   * Заполняется при создании Assembly-наряда из прогноза. Backend forecast подтягивает
   * активные Assembly-наряды по этому ключу и блокирует кнопку «Создать наряд» в прогнозе.
   */
  forecastVariantKey?: string;
  /**
   * Ремонтный наряд «выдан в работу»: бригада получила задание и деталь действительно
   * ремонтируется. Только выданные Repair-наряды учитываются прогнозом сборки как будущий
   * приход отремонтированных деталей (см. `buildRepairIncomingFromWorkOrderPayloads`).
   * У ремонта нет статуса «открыт» (только draft/closed), поэтому «выдан» — явный флаг
   * оператора, чтобы черновики/брошенные наряды не завышали прогноз. По умолчанию не задан
   * (= не выдан). Снимается оператором («отозвать») до закрытия наряда.
   */
  repairIssued?: boolean;
  /**
   * Наряд «отозван из работы» (после выдачи): момент отзыва (ms). Наличие поля при
   * `repairIssued !== true` и незакрытой операции даёт статус «Отозван» (не «Просрочен»).
   * Черновик, который никогда не выдавался, поля не имеет. При повторной выдаче в работу
   * все `withdrawn*`-поля очищаются (`applyWorkOrderIssue`).
   */
  withdrawnAt?: number;
  /** Причина отзыва: текст оператора или авто-текст «деталь признана утильной». */
  withdrawnReason?: string;
  /** true — отзыв выполнен автоматически (утильная деталь в дефектовке двигателя). */
  withdrawnAuto?: boolean;
  /**
   * Подписанты наряда по блокам подписей (печать). Оператор выбирает сотрудников из
   * справочника; ФИО и должность подтягиваются из карточки сотрудника при печати.
   * Набор блоков зависит от типа наряда (`getWorkOrderSignatureBlocks`). По умолчанию
   * не задан — печать тогда даёт пустые линии под ручную подпись (наряд на сборку).
   */
  signatureBlocks?: WorkOrderSignatureBlockSelection[];
  /** Настройки печати наряда (заголовок/дата/шрифты разделов). По умолчанию не задано. */
  printSettings?: WorkOrderPrintSettings;
};

function normalizeConsumedLine(raw: unknown, lineNo: number): WorkOrderConsumedLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const nomenclatureId = String(rec.nomenclatureId ?? '').trim();
  if (!nomenclatureId) return null;
  const qty = Math.max(0, workOrderSafeNum(rec.qty, 0));
  if (qty <= 0) return null;
  const sourceWarehouseId = String(rec.sourceWarehouseId ?? '').trim() || 'default';
  return { lineNo, nomenclatureId, qty, sourceWarehouseId };
}

function normalizeProducedLine(raw: unknown, lineNo: number): WorkOrderProducedLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const nomenclatureId = String(rec.nomenclatureId ?? '').trim();
  if (!nomenclatureId) return null;
  const qty = Math.max(0, workOrderSafeNum(rec.qty, 0));
  if (qty <= 0) return null;
  const targetWarehouseId = String(rec.targetWarehouseId ?? '').trim() || 'default';
  return { lineNo, nomenclatureId, qty, targetWarehouseId };
}

function normalizeSignatureSlot(raw: unknown): WorkOrderSignatureSlot | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const caption = String(rec.caption ?? '').trim();
  const employeeId = String(rec.employeeId ?? '').trim();
  // Пустой слот ({}) валиден — это место под подпись от руки.
  return {
    ...(caption ? { caption } : {}),
    ...(employeeId ? { employeeId } : {}),
  };
}

function normalizeSignatureBlockSelection(raw: unknown): WorkOrderSignatureBlockSelection | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const blockId = String(rec.blockId ?? '').trim();
  if (!blockId) return null;
  let slots: WorkOrderSignatureSlot[] = [];
  if (Array.isArray(rec.slots)) {
    slots = rec.slots
      .map((s) => normalizeSignatureSlot(s))
      .filter((s): s is WorkOrderSignatureSlot => s !== null);
  } else if (Array.isArray(rec.employeeIds)) {
    // Back-compat с первой версией поля (плоский список сотрудников) → слоты.
    slots = rec.employeeIds
      .map((id) => String(id ?? '').trim())
      .filter((id) => id.length > 0)
      .map((employeeId) => ({ employeeId }));
  }
  return { blockId, slots };
}

function isWorkOrderKind(value: unknown): value is WorkOrderKind {
  return (
    value === WorkOrderKind.Regular ||
    value === WorkOrderKind.Repair ||
    value === WorkOrderKind.WorkshopTemplate ||
    value === WorkOrderKind.Assembly ||
    value === WorkOrderKind.Manufacturing
  );
}

/**
 * Принимает payload любой версии (v1/v2/v3) и возвращает нормализованные v3-поля.
 * Не модифицирует исходный объект; ничего не теряет — старые поля сохраняются.
 */
export function normalizeWorkOrderPayloadV3Fields(raw: unknown): Pick<WorkOrderPayload, 'workshopId' | 'workOrderKind' | 'consumedLines' | 'producedLines' | 'linkedDocumentId' | 'assemblyVariantGroup' | 'assemblyEngineId' | 'repairIssued' | 'withdrawnAt' | 'withdrawnReason' | 'withdrawnAuto' | 'signatureBlocks' | 'printSettings' | 'startDate' | 'dueDate' | 'completedDate'> {
  if (!raw || typeof raw !== 'object') return {};
  const rec = raw as Record<string, unknown>;

  const result: Pick<WorkOrderPayload, 'workshopId' | 'workOrderKind' | 'consumedLines' | 'producedLines' | 'linkedDocumentId' | 'assemblyVariantGroup' | 'assemblyEngineId' | 'repairIssued' | 'withdrawnAt' | 'withdrawnReason' | 'withdrawnAuto' | 'signatureBlocks' | 'printSettings' | 'startDate' | 'dueDate' | 'completedDate'> = {};

  const workshopId = typeof rec.workshopId === 'string' ? rec.workshopId.trim() : '';
  if (workshopId) result.workshopId = workshopId;

  if (isWorkOrderKind(rec.workOrderKind)) result.workOrderKind = rec.workOrderKind;

  if (Array.isArray(rec.consumedLines)) {
    const consumed = rec.consumedLines
      .map((row, idx) => normalizeConsumedLine(row, idx + 1))
      .filter((row): row is WorkOrderConsumedLine => row !== null);
    if (consumed.length > 0) result.consumedLines = consumed;
  }

  if (Array.isArray(rec.producedLines)) {
    const produced = rec.producedLines
      .map((row, idx) => normalizeProducedLine(row, idx + 1))
      .filter((row): row is WorkOrderProducedLine => row !== null);
    if (produced.length > 0) result.producedLines = produced;
  }

  const linkedDocumentId = typeof rec.linkedDocumentId === 'string' ? rec.linkedDocumentId.trim() : '';
  if (linkedDocumentId) result.linkedDocumentId = linkedDocumentId;

  if (rec.assemblyVariantGroup === null) {
    result.assemblyVariantGroup = null;
  } else if (typeof rec.assemblyVariantGroup === 'string') {
    const trimmed = rec.assemblyVariantGroup.trim();
    if (trimmed) result.assemblyVariantGroup = trimmed;
  }

  if (rec.assemblyEngineId === null) {
    result.assemblyEngineId = null;
  } else if (typeof rec.assemblyEngineId === 'string') {
    const trimmed = rec.assemblyEngineId.trim();
    if (trimmed) result.assemblyEngineId = trimmed;
  }

  if (rec.repairIssued === true) result.repairIssued = true;

  const withdrawnAt = Number(rec.withdrawnAt);
  if (Number.isFinite(withdrawnAt) && withdrawnAt > 0) result.withdrawnAt = withdrawnAt;
  const withdrawnReason = typeof rec.withdrawnReason === 'string' ? rec.withdrawnReason.trim() : '';
  if (withdrawnReason) result.withdrawnReason = withdrawnReason;
  if (rec.withdrawnAuto === true) result.withdrawnAuto = true;

  const startDate = Number(rec.startDate);
  if (Number.isFinite(startDate) && startDate > 0) result.startDate = startDate;
  const dueDate = Number(rec.dueDate);
  if (Number.isFinite(dueDate) && dueDate > 0) result.dueDate = dueDate;
  const completedDate = Number(rec.completedDate);
  if (Number.isFinite(completedDate) && completedDate > 0) result.completedDate = completedDate;

  if (Array.isArray(rec.signatureBlocks)) {
    const blocks = rec.signatureBlocks
      .map((row) => normalizeSignatureBlockSelection(row))
      .filter((row): row is WorkOrderSignatureBlockSelection => row !== null && row.slots.length > 0);
    if (blocks.length > 0) result.signatureBlocks = blocks;
  }

  const printSettings = normalizeWorkOrderPrintSettings(rec.printSettings);
  if (printSettings) result.printSettings = printSettings;

  return result;
}

/**
 * Вычисляемый статус наряда для списка/карточки (presentation, D2 «вычисляемые»):
 * не хранится, выводится из статуса операции + плановой/фактической дат.
 * - issued      — выдан (операция открыта, дата выполнения не проставлена), срок ещё не вышел → жёлтый;
 * - done        — выполнен (операция закрыта ИЛИ проставлена дата выполнения) в срок → зелёный;
 * - overdue     — не выполнен (не закрыт и без даты выполнения), плановая дата прошла → красный;
 * - done_late   — выполнен (закрыт или с датой выполнения), но позже плановой даты → зелёный фон + красная дата.
 * - withdrawn   — отозван из работы (после выдачи, не закрыт); не «просрочивается» → серый.
 */
export type WorkOrderStatusCode = 'issued' | 'done' | 'overdue' | 'done_late' | 'withdrawn';

export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatusCode, string> = {
  issued: 'Выдан',
  done: 'Выполнен',
  overdue: 'Просрочен',
  done_late: 'Выполнен с просрочкой',
  withdrawn: 'Отозван',
};

const WORK_ORDER_DAY_MS = 86_400_000;

/**
 * Срок считается прошедшим, когда наступил следующий за `dueDate` день: наряд со сроком
 * «сегодня» не просрочен в течение дня. `dueDate` — локальная полночь из date-input.
 */
export function deriveWorkOrderStatusCode(args: {
  /** Статус операции: 'draft' | 'open' | 'closed' (прочее трактуется как открытый). */
  operationStatus: string;
  /** Плановая дата исполнения (ms) или пусто. */
  dueDate?: number | null;
  /** Факт. дата закрытия (ms) — время закрытия операции (для закрытых нарядов). */
  completedAt?: number | null;
  /**
   * Оператор-заданная фактическая дата выполнения работ (ms) или пусто. Если задана — наряд
   * считается выполненным независимо от того, закрыта ли операция: оператор явно указал, что
   * работы сделаны. Без неё незакрытый наряд с прошедшим сроком → overdue (розовый).
   */
  completedDate?: number | null;
  /** Момент отзыва наряда из работы (ms) или пусто — payload.withdrawnAt. */
  withdrawnAt?: number | null;
  /** Текущее время (ms). */
  now: number;
}): WorkOrderStatusCode {
  const due = args.dueDate && args.dueDate > 0 ? args.dueDate : null;
  const dueExpiry = due !== null ? due + WORK_ORDER_DAY_MS : null;
  const operatorCompleted = args.completedDate && args.completedDate > 0 ? args.completedDate : null;
  const closedAt = args.completedAt && args.completedAt > 0 ? args.completedAt : null;
  // Наряд «выполнен», если операция закрыта ИЛИ оператор проставил фактическую дату выполнения.
  if (args.operationStatus === 'closed' || operatorCompleted !== null) {
    // Эффективная дата выполнения: оператор-заданная дата приоритетна, иначе время закрытия.
    const completion = operatorCompleted ?? closedAt;
    if (dueExpiry !== null && completion !== null && completion >= dueExpiry) return 'done_late';
    return 'done';
  }
  // Отозванный наряд стоит на паузе — просрочка по нему не считается.
  if (args.withdrawnAt && args.withdrawnAt > 0) return 'withdrawn';
  if (dueExpiry !== null && args.now >= dueExpiry) return 'overdue';
  return 'issued';
}

/**
 * Момент отзыва для деривации статуса: `withdrawnAt` действует, только пока наряд
 * не выдан заново (`repairIssued !== true`) — страховка от payload'а старого клиента,
 * который выставил `repairIssued`, не очистив `withdrawn*`.
 */
export function workOrderWithdrawnAt(rawPayload: Record<string, unknown>): number | null {
  if (rawPayload.repairIssued === true) return null;
  const at = Number(rawPayload.withdrawnAt);
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * Отзыв наряда из работы: снимает `repairIssued`, ставит `withdrawnAt/Reason/Auto`
 * и пишет auditTrail item `{action:'withdraw', note: reason}`. Единая логика для
 * клиента (модалка причины / клиентский хук утиля) и backend (хук дефектовки).
 */
export function applyWorkOrderWithdrawal(
  payload: WorkOrderPayload,
  args: { at: number; by: string; reason: string; auto?: boolean },
): WorkOrderPayload {
  const reason = args.reason.trim();
  const next: WorkOrderPayload = {
    ...payload,
    withdrawnAt: args.at,
    ...(reason ? { withdrawnReason: reason } : {}),
    ...(args.auto === true ? { withdrawnAuto: true } : {}),
    auditTrail: [
      ...(Array.isArray(payload.auditTrail) ? payload.auditTrail : []),
      { at: args.at, by: args.by, action: 'withdraw', ...(reason ? { note: reason } : {}) },
    ],
  };
  delete next.repairIssued;
  if (!(args.auto === true)) delete next.withdrawnAuto;
  if (!reason) delete next.withdrawnReason;
  return next;
}

/** Выдача наряда в работу: ставит `repairIssued`, очищает `withdrawn*`, пишет auditTrail. */
export function applyWorkOrderIssue(payload: WorkOrderPayload, args: { at: number; by: string }): WorkOrderPayload {
  const next: WorkOrderPayload = {
    ...payload,
    repairIssued: true,
    auditTrail: [
      ...(Array.isArray(payload.auditTrail) ? payload.auditTrail : []),
      { at: args.at, by: args.by, action: 'issue' },
    ],
  };
  delete next.withdrawnAt;
  delete next.withdrawnReason;
  delete next.withdrawnAuto;
  return next;
}

function clampFont(value: unknown, range: { min: number; max: number }): number | undefined {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(range.max, Math.max(range.min, n));
}

function normalizeWorkOrderPrintSettings(raw: unknown): WorkOrderPrintSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const out: WorkOrderPrintSettings = {};
  const title = String(rec.titleOverride ?? '').trim();
  if (title) out.titleOverride = title;
  const date = Number(rec.orderDateOverride);
  if (Number.isFinite(date) && date > 0) out.orderDateOverride = date;
  // Храним только не-дефолтный вариант; отсутствие = директор (back-compat для старых нарядов).
  if (rec.approver === 'technical') out.approver = 'technical';
  const approverPosition = String(rec.approverPositionOverride ?? '').trim();
  if (approverPosition) out.approverPositionOverride = approverPosition;
  const approverName = String(rec.approverNameOverride ?? '').trim();
  if (approverName) out.approverNameOverride = approverName;
  const approverEmployeeId = String(rec.approverEmployeeId ?? '').trim();
  if (approverEmployeeId) out.approverEmployeeId = approverEmployeeId;
  if (rec.hideOrderDate === true) out.hideOrderDate = true;
  if (rec.hideStartDate === true) out.hideStartDate = true;
  if (rec.hideDueDate === true) out.hideDueDate = true;
  if (rec.hideWorkshop === true) out.hideWorkshop = true;
  const director = clampFont(rec.fontDirector, WORK_ORDER_PRINT_FONT_RANGES.director);
  if (director !== undefined) out.fontDirector = director;
  // Back-compat: старое единое поле fontHeader (масштаб всей шапки) → размер заголовка.
  const title2 = clampFont(rec.fontTitle, WORK_ORDER_PRINT_FONT_RANGES.title);
  const legacyHeader = clampFont(rec.fontHeader, WORK_ORDER_PRINT_FONT_RANGES.title);
  if (title2 !== undefined) out.fontTitle = title2;
  else if (legacyHeader !== undefined) out.fontTitle = legacyHeader;
  const meta = clampFont(rec.fontMeta, WORK_ORDER_PRINT_FONT_RANGES.meta);
  if (meta !== undefined) out.fontMeta = meta;
  const crew = clampFont(rec.fontCrew, WORK_ORDER_PRINT_FONT_RANGES.crew);
  if (crew !== undefined) out.fontCrew = crew;
  const works = clampFont(rec.fontWorks, WORK_ORDER_PRINT_FONT_RANGES.works);
  if (works !== undefined) out.fontWorks = works;
  const signatures = clampFont(rec.fontSignatures, WORK_ORDER_PRINT_FONT_RANGES.signatures);
  if (signatures !== undefined) out.fontSignatures = signatures;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * «Пустой» наряд — авто-созданная карточка, в которую ничего не внесли: нет строк
 * работ/бригады/групп и нет привязанного складского документа. Номер/дата проставляются
 * автоматически при создании и содержимым не считаются. Defensive: принимает сырой payload
 * (любой версии, до нормализации) — используется чисткой пустых карточек на бэкенде.
 */
export function isWorkOrderPayloadEmpty(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true;
  const p = payload as Record<string, unknown>;
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const hasLines =
    len(p.freeWorks) + len(p.works) + len(p.crew) + len(p.workGroups) + len(p.consumedLines) + len(p.producedLines) > 0;
  const hasLinkedDoc = typeof p.linkedDocumentId === 'string' && p.linkedDocumentId.trim() !== '';
  return !hasLines && !hasLinkedDoc;
}

/**
 * Удаляет из `freeWorks` строки с qty <= 0 (или невалидным qty). Применяется
 * на проводке Workshop-наряда: до закрытия все строки шаблона хранятся, чтобы
 * оператор видел весь список, при закрытии остаются только реально выпущенные.
 * Для нарядов других типов возвращает payload без изменений. Не мутирует.
 */
export function pruneEmptyWorkshopLines(payload: WorkOrderPayload): WorkOrderPayload {
  if (payload.workOrderKind !== WorkOrderKind.WorkshopTemplate) return payload;
  const freeWorks = Array.isArray(payload.freeWorks) ? payload.freeWorks : [];
  const kept = freeWorks.filter((line) => {
    const qty = Number(line?.qty);
    return Number.isFinite(qty) && qty > 0;
  });
  if (kept.length === freeWorks.length) return payload;
  return { ...payload, freeWorks: kept };
}

/**
 * Первый ненулевой engineId среди строк наряда. Используется DAL'ом наряда
 * для записи operations.engine_entity_id у Assembly-нарядов (сборка двигателя):
 * partId на assembly указывает на собираемое изделие, а собираемый двигатель
 * приходит через freeWorks[*].engineId / workGroups[*].lines[*].engineId. Без
 * этой записи бэк-проверка workOrderClosingService падает у любого Assembly.
 */
export function primaryAssemblyEngineId(payload: WorkOrderPayload): string | null {
  const freeWorks = Array.isArray(payload.freeWorks) ? payload.freeWorks : [];
  for (const line of freeWorks) {
    const id = String(line?.engineId ?? '').trim();
    if (id) return id;
  }
  const workGroups = Array.isArray(payload.workGroups) ? payload.workGroups : [];
  for (const group of workGroups) {
    const lines = Array.isArray(group?.lines) ? group.lines : [];
    for (const line of lines) {
      const id = String(line?.engineId ?? '').trim();
      if (id) return id;
    }
  }
  return null;
}

/**
 * Двигатель Assembly-наряда для шапки: явное header-поле `assemblyEngineId`, с fallback
 * на первый двигатель среди строк (`primaryAssemblyEngineId`) — чтобы старые наряды,
 * сохранённые до появления header-поля, показывали двигатель в шапке.
 */
export function resolveAssemblyEngineId(payload: WorkOrderPayload): string | null {
  const explicit = String(payload.assemblyEngineId ?? '').trim();
  if (explicit) return explicit;
  return primaryAssemblyEngineId(payload);
}

/* -------------------------------------------------------------------------- *
 * Ф5 актов двигателя: ремфонд → наряд → прогноз. Pure-хелперы поверх payload
 * наряда, чтобы и electron main (derive статусов), и backend forecast (канал
 * открытых ремнарядов) считали одинаково и были покрыты юнит-тестами.
 * -------------------------------------------------------------------------- */

/** Все строки работ payload (freeWorks + workGroups, fallback legacy works) — как collectWorkLines backend'а. */
export function collectWorkOrderWorkLines(rawPayload: Record<string, unknown>): WorkOrderWorkLine[] {
  const result: WorkOrderWorkLine[] = [];
  const free = rawPayload.freeWorks;
  if (Array.isArray(free)) {
    for (const line of free) if (line && typeof line === 'object') result.push(line as WorkOrderWorkLine);
  }
  const groups = rawPayload.workGroups;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const lines = (group as { lines?: unknown }).lines;
      if (!Array.isArray(lines)) continue;
      for (const line of lines) if (line && typeof line === 'object') result.push(line as WorkOrderWorkLine);
    }
  }
  if (result.length === 0 && Array.isArray(rawPayload.works)) {
    for (const line of rawPayload.works) if (line && typeof line === 'object') result.push(line as WorkOrderWorkLine);
  }
  return result;
}

function isRepairWorkOrderPayload(rawPayload: Record<string, unknown>): boolean {
  return rawPayload.kind === 'work_order' && rawPayload.workOrderKind === WorkOrderKind.Repair;
}

/**
 * Ф5 (GAP-5): Repair-наряды, ВЫДАННЫЕ В РАБОТУ → строки будущего прихода для прогноза сборки.
 * Учитываются только наряды с `repairIssued === true` — у ремонта нет статуса «открыт»
 * (только draft/closed), поэтому черновики и брошенные наряды иначе завышали бы прогноз
 * (нитка «выдан в работу», аудит прогноза 2026-06-22). Агрегирует qty по (partId, workshopId
 * наряда); строки без partId/qty пропускаются. Backend-loader поверх: резолвит
 * workshopId → склад цеха, partId → номенклатуру, применяет фильтр складов и ставит dayOffset.
 */
export function buildRepairIncomingFromWorkOrderPayloads(
  rawPayloads: ReadonlyArray<Record<string, unknown>>,
): Array<{ partId: string; qty: number; workshopId: string | null }> {
  const acc = new Map<string, { partId: string; qty: number; workshopId: string | null }>();
  for (const rawPayload of rawPayloads) {
    if (!isRepairWorkOrderPayload(rawPayload)) continue;
    if (rawPayload.repairIssued !== true) continue;
    const workshopId = String(rawPayload.workshopId ?? '').trim() || null;
    for (const line of collectWorkOrderWorkLines(rawPayload)) {
      const partId = String(line?.partId ?? '').trim();
      const qty = Math.max(0, Math.trunc(Number(line?.qty ?? 0)));
      if (!partId || qty <= 0) continue;
      const key = `${partId}@${workshopId ?? ''}`;
      const existing = acc.get(key);
      if (existing) existing.qty += qty;
      else acc.set(key, { partId, qty, workshopId });
    }
  }
  return [...acc.values()];
}

/** Производный статус ремонта детали конкретного двигателя (Ф5, GAP-4): без хранимого поля в строке. */
export type EngineRepairPartState = {
  state: 'in_repair' | 'repaired';
  workOrderOperationId: string;
  workOrderNumber: number;
};

/**
 * Деривация статусов «в ремонте / готова к сборке» из Repair-нарядов:
 * open-наряд с work-line (engineId=двигатель, partId) → 'in_repair';
 * closed-наряд → 'repaired'. Открытый наряд побеждает закрытый (деталь снова в работе);
 * среди одинаковых статусов побеждает наряд с большим updatedAt. Удалённые наряды
 * не передаются (фильтр deletedAt — на вызывающем).
 */
export function deriveEngineRepairPartStates(
  ops: ReadonlyArray<{ operationId: string; status: string; updatedAt: number; rawPayload: Record<string, unknown> }>,
  engineId: string,
): Map<string, EngineRepairPartState> {
  const target = String(engineId ?? '').trim();
  if (!target) return new Map();
  const best = new Map<string, EngineRepairPartState & { updatedAt: number }>();
  for (const op of ops) {
    if (!isRepairWorkOrderPayload(op.rawPayload)) continue;
    const status = String(op.status) === 'closed' ? 'repaired' : 'in_repair';
    const workOrderNumber = Math.max(0, Math.trunc(Number(op.rawPayload.workOrderNumber ?? 0)) || 0);
    for (const line of collectWorkOrderWorkLines(op.rawPayload)) {
      if (String(line?.engineId ?? '').trim() !== target) continue;
      const partId = String(line?.partId ?? '').trim();
      if (!partId) continue;
      const prev = best.get(partId);
      const candidate = {
        state: status as 'in_repair' | 'repaired',
        workOrderOperationId: op.operationId,
        workOrderNumber,
        updatedAt: Number(op.updatedAt) || 0,
      };
      if (
        !prev ||
        (prev.state === 'repaired' && candidate.state === 'in_repair') ||
        (prev.state === candidate.state && candidate.updatedAt > prev.updatedAt)
      ) {
        best.set(partId, candidate);
      }
    }
  }
  const out = new Map<string, EngineRepairPartState>();
  for (const [partId, v] of best) {
    out.set(partId, { state: v.state, workOrderOperationId: v.workOrderOperationId, workOrderNumber: v.workOrderNumber });
  }
  return out;
}
