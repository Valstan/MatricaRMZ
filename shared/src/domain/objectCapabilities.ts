/**
 * Каталог действий по объекту — «гибкий модуль кнопок» (заказ владельца, промт КАРМАНА #124).
 *
 * Проблема, которую он лечит: у карточек и списков набор кнопок собирался руками в каждой
 * странице. В одних карточках одни функции, в других — другие, а кнопка, которой у объекта
 * нет, оставалась видимой («мёртвая кнопка»). Правило владельца: модуль должен понимать,
 * какой объект перед ним, что он умеет, и включать ТОЛЬКО те кнопки, которые этому объекту
 * нужны — и подсказывать при разработке, что объекту можно добавить функцию, которая уже
 * есть у другого похожего объекта.
 *
 * Здесь — только ЗНАНИЕ: «какой тип объекта что умеет». Это чистые данные без UI и без
 * обработчиков, поэтому живут в домене (их может прочитать и сервер). Кнопки, подписи и
 * обработчики — в renderer: `renderer/src/ui/utils/objectActions.ts`.
 *
 * Правила файла:
 *  - «умеет» = запись в {@link OBJECT_CAPABILITIES}, а не набор пропсов страницы;
 *  - родство объектов ({@link OBJECT_KINSHIP}) задано явно: «похожий объект» — не догадка;
 *  - функция ничего не блокирует: подсказка — совет при разработке, а не запрет.
 */

/** Тип объекта, у которого есть карточка и свой набор действий. */
export type ObjectKind =
  | 'engine'
  | 'work_order'
  | 'work_sheet_row'
  | 'counterparty'
  | 'contract'
  | 'employee'
  | 'part'
  | 'tool'
  | 'nomenclature'
  | 'supply_request'
  | 'engine_brand'
  | 'stock_document'
  | 'bom';

/**
 * Возможность объекта — «что он умеет». Идентификатор переиспользуется каталогом кнопок
 * (renderer), поэтому он не должен быть привязан к подписи или к иконке.
 */
export type ObjectCapabilityId =
  | 'copy_to_new'
  | 'save'
  | 'save_and_close'
  | 'save_as_draft'
  | 'reset'
  | 'print'
  | 'delete'
  | 'close'
  | 'signatures'
  | 'attachments'
  | 'payments';

/**
 * Что умеет каждый тип объекта.
 *
 * Это ЕДИНСТВЕНный источник правды про «мёртвые кнопки»: кнопка показывается тогда и только
 * тогда, когда её возможность есть в этой строке. Тонкая обёртка над общим движком — не дубль
 * (см. `docs/GLOBAL_MODULES.md` §«Дубли»): правило здесь одно на весь домен.
 */
export const OBJECT_CAPABILITIES: Record<ObjectKind, readonly ObjectCapabilityId[]> = {
  engine: ['copy_to_new', 'save', 'save_and_close', 'save_as_draft', 'reset', 'print', 'delete', 'close', 'attachments', 'payments'],
  work_order: ['copy_to_new', 'save', 'save_and_close', 'save_as_draft', 'reset', 'print', 'delete', 'close', 'signatures', 'attachments'],
  work_sheet_row: ['save', 'save_and_close', 'reset', 'delete', 'close'],
  counterparty: ['copy_to_new', 'save', 'save_and_close', 'reset', 'print', 'delete', 'close', 'attachments'],
  contract: ['copy_to_new', 'save', 'save_and_close', 'reset', 'print', 'delete', 'close', 'attachments', 'payments'],
  employee: ['copy_to_new', 'save', 'save_and_close', 'reset', 'print', 'delete', 'close', 'attachments'],
  part: ['copy_to_new', 'save', 'save_and_close', 'reset', 'delete', 'close'],
  tool: ['copy_to_new', 'save', 'save_and_close', 'reset', 'delete', 'close'],
  nomenclature: ['copy_to_new', 'save', 'save_and_close', 'reset', 'delete', 'close'],
  supply_request: ['copy_to_new', 'save', 'save_and_close', 'reset', 'print', 'delete', 'close', 'attachments'],
  engine_brand: ['copy_to_new', 'save', 'save_and_close', 'reset', 'delete', 'close'],
  stock_document: ['save', 'save_and_close', 'reset', 'delete', 'close', 'print'],
  bom: ['copy_to_new', 'save', 'save_and_close', 'reset', 'delete', 'close', 'print'],
};

/**
 * Родство объектов: у кого искать «похожий объект, у которого эта функция уже есть».
 *
 * Явный список вместо вычисления по похожим именам: подсказка «добавь объекту то, что есть у
 * похожего» обязана быть предсказуемой, иначе её перестанут читать.
 */
export const OBJECT_KINSHIP: Record<ObjectKind, readonly ObjectKind[]> = {
  engine: ['work_order', 'contract'],
  work_order: ['engine', 'contract'],
  work_sheet_row: ['engine', 'work_order'],
  counterparty: ['contract', 'employee'],
  contract: ['engine', 'work_order', 'counterparty'],
  employee: ['counterparty', 'part'],
  part: ['tool', 'nomenclature', 'employee'],
  tool: ['part', 'nomenclature'],
  nomenclature: ['part', 'tool'],
  supply_request: ['nomenclature', 'part'],
  engine_brand: ['nomenclature', 'part'],
  stock_document: ['bom', 'nomenclature'],
  bom: ['stock_document', 'nomenclature'],
};

/** Подсказка при разработке: «у этого объекта такой функции нет, а у похожего — есть». */
export type ObjectCapabilitySuggestion = {
  /** Возможность, которой нет у объекта. */
  capability: ObjectCapabilityId;
  /** У кого из похожих объектов такая возможность уже есть. */
  owners: ObjectKind[];
};

/** Возможности типа объекта (копия строки — чтобы наружу не утекли массивы реестра). */
export function objectCapabilities(kind: ObjectKind): readonly ObjectCapabilityId[] {
  return OBJECT_CAPABILITIES[kind] ?? [];
}

/** Умеет ли объект эту функцию. */
export function objectHasCapability(kind: ObjectKind, capability: ObjectCapabilityId): boolean {
  return objectCapabilities(kind).includes(capability);
}

/** Кто из объектов этой возможностью обладает. */
export function capabilityOwners(capability: ObjectCapabilityId): ObjectKind[] {
  return (Object.keys(OBJECT_CAPABILITIES) as ObjectKind[]).filter((kind) =>
    objectHasCapability(kind, capability),
  );
}

/**
 * Чего объекту не хватает по сравнению с похожими.
 *
 * Это и есть тот самый совет владельца: «объект X умеет A; объект Y умеет A — можно ли
 * добавить Y?». Ничего не блокирует и ничего не меняет — только показывает, куда смотреть.
 */
export function suggestCapabilityAdditions(kind: ObjectKind): ObjectCapabilitySuggestion[] {
  const own = objectCapabilities(kind);
  const relatives = OBJECT_KINSHIP[kind] ?? [];
  const suggestions: ObjectCapabilitySuggestion[] = [];
  // Список возможностей берём из всех типов, чтобы подсказка не зависела от порядка ключей.
  const allCapabilities = new Set<ObjectCapabilityId>();
  for (const caps of Object.values(OBJECT_CAPABILITIES)) {
    for (const capability of caps) allCapabilities.add(capability);
  }
  for (const capability of allCapabilities) {
    if (own.includes(capability)) continue;
    const owners = relatives.filter((relative) => objectHasCapability(relative, capability));
    if (owners.length) suggestions.push({ capability, owners });
  }
  return suggestions;
}
