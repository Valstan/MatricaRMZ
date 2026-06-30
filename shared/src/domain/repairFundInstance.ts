/**
 * Ремфонд Ф3: поэкземплярный учёт деталей по личным (набитым) номерам.
 *
 * Носитель — строки `operations` с `operationType='repair_fund_instance'` и
 * `engineEntityId` = двигатель-источник (провенанс: с какого двигателя снята деталь).
 * Синкаются дженериком (operation_type — свободный текст, meta_json — opaque JSON),
 * сync-контракт не меняется. Образец жизненного цикла — `part_status_event`.
 *
 * Запись рождается на дефектовке (там одновременно есть личный номер, двигатель и
 * классификация). Ключ экземпляра — `(engineEntityId, nomenclatureId, stampedNumber)`.
 * Цель — собрать по двигателю требование к заказчику (что классифицировано в утиль /
 * заменено) и подшить в «дело двигателя».
 */

export const REPAIR_FUND_INSTANCE_TYPE = 'repair_fund_instance' as const;

/** Классификация детали на дефектовке (доказательная для претензии Ф4). */
export type RepairFundInstanceClassification = 'repairable' | 'scrap' | 'replace';

export const REPAIR_FUND_INSTANCE_CLASSIFICATIONS = [
  'repairable',
  'scrap',
  'replace',
] as const satisfies readonly RepairFundInstanceClassification[];

/** Текущий статус экземпляра. Стартует из классификации, `repaired` — переход на Ф2. */
export type RepairFundInstanceStatus = 'in_fund' | 'repaired' | 'scrapped' | 'replaced';

export type RepairFundInstancePayload = {
  kind: 'repair_fund_instance';
  /** Двигатель-источник (провенанс). */
  engineEntityId: string;
  /** Номенклатура (resolved на бэкенде из partId). */
  nomenclatureId: string;
  /** Исходный partId строки дефектовки (directory_parts либо erp_nomenclature). */
  partId: string;
  partLabel: string;
  /** Личный набитый номер — человеческий ключ экземпляра. */
  stampedNumber: string;
  classification: RepairFundInstanceClassification;
  status: RepairFundInstanceStatus;
  capturedAt: number;
  capturedBy: string;
};

export function toRepairFundInstanceClassification(value: unknown): RepairFundInstanceClassification {
  return value === 'scrap' || value === 'replace' || value === 'repairable' ? value : 'repairable';
}

/** Стартовый статус из классификации: ремонтопригодна → в фонде, утиль → списана, замена → заменена. */
export function statusFromClassification(classification: RepairFundInstanceClassification): RepairFundInstanceStatus {
  if (classification === 'scrap') return 'scrapped';
  if (classification === 'replace') return 'replaced';
  return 'in_fund';
}

export function repairFundInstanceClassificationLabel(classification: RepairFundInstanceClassification): string {
  if (classification === 'scrap') return 'утиль';
  if (classification === 'replace') return 'замена';
  return 'годна к ремонту';
}

export function repairFundInstanceStatusLabel(status: RepairFundInstanceStatus): string {
  switch (status) {
    case 'repaired':
      return 'отремонтирована';
    case 'scrapped':
      return 'в утиль';
    case 'replaced':
      return 'заменена';
    case 'in_fund':
    default:
      return 'в ремфонде';
  }
}

/**
 * Ф3.1: ручная отметка «отремонтирована» на карточке двигателя допустима только для
 * пары `in_fund ↔ repaired`. Терминальные `scrapped`/`replaced` задаются классификацией
 * дефектовки (утиль/замена) и вручную здесь не меняются — их правит переклассификация
 * (повторный захват), не эта кнопка. Мастер знает физическую деталь → точно, без эвристики.
 */
export function canToggleRepairedStatus(current: RepairFundInstanceStatus): boolean {
  return current === 'in_fund' || current === 'repaired';
}

export function buildRepairFundInstanceNote(
  payload: Pick<RepairFundInstancePayload, 'partLabel' | 'stampedNumber' | 'classification'>,
): string {
  const num = payload.stampedNumber ? ` №${payload.stampedNumber}` : '';
  return `${payload.partLabel || 'Деталь'}${num} — ${repairFundInstanceClassificationLabel(payload.classification)}`;
}

/** Парсит meta_json операции repair_fund_instance; null для чужих/битых payload. */
export function parseRepairFundInstancePayload(metaJson: string | null | undefined): RepairFundInstancePayload | null {
  if (!metaJson) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(String(metaJson));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== REPAIR_FUND_INSTANCE_TYPE) return null;
  const stampedNumber = typeof obj.stampedNumber === 'string' ? obj.stampedNumber.trim() : '';
  if (!stampedNumber) return null;
  const classification = toRepairFundInstanceClassification(obj.classification);
  const statusRaw = obj.status;
  const status: RepairFundInstanceStatus =
    statusRaw === 'in_fund' || statusRaw === 'repaired' || statusRaw === 'scrapped' || statusRaw === 'replaced'
      ? statusRaw
      : statusFromClassification(classification);
  return {
    kind: REPAIR_FUND_INSTANCE_TYPE,
    engineEntityId: typeof obj.engineEntityId === 'string' ? obj.engineEntityId : '',
    nomenclatureId: typeof obj.nomenclatureId === 'string' ? obj.nomenclatureId : '',
    partId: typeof obj.partId === 'string' ? obj.partId : '',
    partLabel: typeof obj.partLabel === 'string' ? obj.partLabel : '',
    stampedNumber,
    classification,
    status,
    capturedAt: Math.max(0, Math.floor(Number(obj.capturedAt ?? 0)) || 0),
    capturedBy: typeof obj.capturedBy === 'string' ? obj.capturedBy : '',
  };
}

/* -------------------------------------------------------------------------- *
 * Ф4: печатное «требование к заказчику» по двигателю — версионируемый снимок
 * экземпляров утиль/замена (как акты комплектности/дефектовки). Хранится строкой
 * `operations` (operationType='repair_fund_requirement'), payload плоско в meta_json.
 * -------------------------------------------------------------------------- */

export const REPAIR_FUND_REQUIREMENT_TYPE = 'repair_fund_requirement' as const;

/**
 * Экземпляры, попадающие в требование к заказчику: классифицированы в утиль/замену
 * (это и есть детали, которые мы вывели из двигателя — обоснование роста цены).
 * Ремонтопригодные (in_fund) НЕ входят. Сортировка по личному номеру для стабильности.
 */
export function selectRequirementInstances<T extends Pick<RepairFundInstancePayload, 'classification' | 'stampedNumber'>>(
  instances: ReadonlyArray<T>,
): T[] {
  return instances
    .filter((i) => i.classification === 'scrap' || i.classification === 'replace')
    .slice()
    .sort((a, b) => String(a.stampedNumber).localeCompare(String(b.stampedNumber), 'ru'));
}

export type RepairFundRequirementSnapshotPayload = {
  kind: 'repair_fund_requirement_snapshot';
  engineEntityId: string;
  /** Монотонная версия в пределах двигателя. 1-based. */
  version: number;
  /** Экземпляры, вошедшие в требование (утиль/замена), замороженные на момент печати. */
  instances: RepairFundInstancePayload[];
  header: { engineBrand: string; engineNumber: string; contractNumber: string };
  printedBy: string | null;
  printedAt: number;
};

export type RepairFundRequirementVersionRecord = RepairFundRequirementSnapshotPayload & { operationId: string };

/** Сигнатура снимка требования для дедупа идентичных подряд печатей. */
export function repairFundRequirementSignature(args: {
  instances: ReadonlyArray<Pick<RepairFundInstancePayload, 'stampedNumber' | 'classification' | 'partLabel'>>;
}): string {
  const rows = selectRequirementInstances(args.instances).map((i) => ({
    n: String(i.stampedNumber).trim(),
    c: i.classification,
    p: String(i.partLabel).trim(),
  }));
  return JSON.stringify(rows);
}

/** Парсит meta_json снимка требования; null для чужих/битых payload. */
export function parseRepairFundRequirementPayload(metaJson: string | null | undefined): RepairFundRequirementSnapshotPayload | null {
  if (!metaJson) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(String(metaJson));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== 'repair_fund_requirement_snapshot') return null;
  const instances = Array.isArray(obj.instances)
    ? obj.instances.map((x) => parseRepairFundInstancePayload(JSON.stringify(x))).filter((x): x is RepairFundInstancePayload => !!x)
    : [];
  const h = (obj.header && typeof obj.header === 'object' ? obj.header : {}) as Record<string, unknown>;
  return {
    kind: 'repair_fund_requirement_snapshot',
    engineEntityId: typeof obj.engineEntityId === 'string' ? obj.engineEntityId : '',
    version: Math.max(1, Math.floor(Number(obj.version ?? 1)) || 1),
    instances,
    header: {
      engineBrand: typeof h.engineBrand === 'string' ? h.engineBrand : '',
      engineNumber: typeof h.engineNumber === 'string' ? h.engineNumber : '',
      contractNumber: typeof h.contractNumber === 'string' ? h.contractNumber : '',
    },
    printedBy: typeof obj.printedBy === 'string' ? obj.printedBy : null,
    printedAt: Math.max(0, Math.floor(Number(obj.printedAt ?? 0)) || 0),
  };
}
