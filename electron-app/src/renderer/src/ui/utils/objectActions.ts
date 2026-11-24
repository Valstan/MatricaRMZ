import {
  objectCapabilities,
  objectHasCapability,
  suggestCapabilityAdditions,
  type ObjectCapabilityId,
  type ObjectCapabilityId as Capability,
  type ObjectCapabilitySuggestion,
  type ObjectKind,
} from '@matricarmz/shared';

/**
 * Каталог действий по объекту — «гибкий модуль кнопок» (промт КАРМАНА #124).
 *
 * Механизм «показывать только то, что умеет» в проекте УЖЕ ЕСТЬ — для списков
 * (`listContextActions.ts`, поле `available`). Здесь он доведён до карточек и сделан
 * ОБЩИМ: тип объявления один на всю программу (списки берут его же), а знание «что умеет
 * объект» лежит в домене (`shared/src/domain/objectCapabilities.ts`).
 *
 * Три слоя, каждый со своим делом:
 *  - домен — какая возможность за каким типом объекта стоит (без UI, без обработчиков);
 *  - каталог здесь — подпись и слот кнопки для каждой возможности (одна на всю программу);
 *  - карточка — обработчики; кнопка появляется, только если объект умеет функцию И
 *    обработчик передан И есть право. Нет — кнопки НЕТ ВООБЩЕ, а не «гаснет серым».
 */

/**
 * Объявление действия — общий тип для списков и карточек.
 *
 * Списки объявляют свои действия этим же типом (`ListActionDeclaration` — синоним
 * `ObjectActionDeclaration<T[]>`), поэтому «мёртвая кнопка» ловится одним правилом:
 * объявление с `available: false` в меню не появляется.
 */
export type ObjectActionDeclaration<TContext = void> = {
  /** Стабильный идентификатор действия (для тестов и для отладки). */
  id: string;
  /** Подпись для одной строки/одной кнопки. */
  label: string;
  /** Подпись для пачки (только списки). */
  bulkLabel?: string;
  /**
   * Объект реально умеет это действие (и у оператора есть право). `false` ⇒ кнопка
   * (пункт меню) НЕ появляется — она не гасится серым: гаснущая кнопка читалась бы как
   * «умеет, но запрещено», а это враньё объекта о самом себе.
   */
  available: boolean;
  /** Где действие применимо: одна строка, пачка или и то и другое (только списки). */
  scope?: 'single' | 'bulk' | 'both';
  /** Опасное действие (удаление) — рисуется красным. */
  danger?: boolean;
  /** Что делать. Получает контекст: у списка — строки, у карточки — ничего. */
  run: (context: TContext) => void | Promise<void>;
};

/** Слот кнопки карточки — у какого места панели действий стоит кнопка. */
export type ObjectActionSlot =
  | 'copy_to_new'
  | 'save'
  | 'save_and_close'
  | 'save_as_draft'
  | 'reset'
  | 'print'
  | 'delete'
  | 'close';

/** Шаблон кнопки: слот, подпись и доменная возможность, которой он соответствует. */
export type ObjectActionTemplate = {
  slot: ObjectActionSlot;
  label: string;
  /** Короткая подпись для планшета (полная — в title). */
  shortLabel?: string;
  capability: ObjectCapabilityId;
};

/**
 * Шаблоны кнопок — ОДНИ на всю программу.
 *
 * Подпись кнопки не должна расходиться между карточками («Сохранить» и «Записать» — одна и
 * та же функция с двумя словами — это ровно тот разнобой, который чинит каталог).
 */
export const OBJECT_ACTION_TEMPLATES: readonly ObjectActionTemplate[] = [
  { slot: 'copy_to_new', label: 'Скопировать в новую карточку', shortLabel: 'Скопировать', capability: 'copy_to_new' },
  { slot: 'save', label: 'Сохранить', capability: 'save' },
  { slot: 'save_and_close', label: 'Сохранить и выйти', capability: 'save_and_close' },
  { slot: 'save_as_draft', label: 'Сохранить как черновик', shortLabel: 'В черновик', capability: 'save_as_draft' },
  { slot: 'reset', label: 'Сброс', capability: 'reset' },
  { slot: 'print', label: 'Распечатать', capability: 'print' },
  { slot: 'delete', label: 'Удалить карточку', shortLabel: 'Удалить', capability: 'delete' },
  { slot: 'close', label: 'Закрыть карточку', shortLabel: 'Закрыть', capability: 'close' },
];

/** Слоты, которые меняют данные: без права на правку их нет. */
const EDIT_ONLY_SLOTS: ReadonlySet<ObjectActionSlot> = new Set<ObjectActionSlot>([
  'copy_to_new',
  'save',
  'save_and_close',
  'save_as_draft',
  'reset',
  'delete',
]);

/**
 * Обработчики кнопок карточки — по слоту. Нет обработчика ⇒ нет кнопки.
 *
 * Слот может быть задан пустым значением (`undefined`): карточка отдаёт обработчик
 * только когда он уместен (например, «удалить» — у нового этапа работ его нет).
 */
export type ObjectActionHandlers = {
  [K in ObjectActionSlot]?: (() => void | Promise<void>) | undefined;
};

/** Объявление действия карточки: слот + подпись + готовность. */
export type CardObjectAction = {
  slot: ObjectActionSlot;
  label: string;
  shortLabel?: string;
  danger: boolean;
  available: boolean;
  run: () => void | Promise<void>;
};

/**
 * Собирает кнопки карточки из КАТАЛОГА — не из пропсов страницы.
 *
 * Кнопка появляется, только если выполнены все три условия:
 *  1) объект такого типа умеет эту функцию (домен: `OBJECT_CAPABILITIES`);
 *  2) карточка передала обработчик (фича не сделана — кнопки нет);
 *  3) для меняющих кнопок есть право на правку (`canEdit`).
 *
 * Это и есть «показывать только то, что умеет»: у объекта без функции кнопки нет.
 */
export function buildCardActions(args: {
  kind: ObjectKind;
  canEdit: boolean;
  handlers: ObjectActionHandlers;
  /** Переопределение подписи (например, «Удалить этап работ»). */
  labels?: Partial<Record<ObjectActionSlot, string>>;
}): CardObjectAction[] {
  const capabilities = objectCapabilities(args.kind);
  const actions: CardObjectAction[] = [];
  for (const template of OBJECT_ACTION_TEMPLATES) {
    const handler = args.handlers[template.slot];
    const ownsCapability = capabilities.includes(template.capability);
    const editable = !EDIT_ONLY_SLOTS.has(template.slot) || args.canEdit;
    const available = ownsCapability && Boolean(handler) && editable;
    const customLabel = args.labels?.[template.slot];
    const label = customLabel ?? template.label;
    // Своя подпись — это своя кнопка целиком: сокращённая подпись из каталога («Удалить»)
    // к ней не годится, иначе на планшете оператор увидит не то, что нажал.
    const shortLabel = customLabel ? undefined : template.shortLabel;
    actions.push({
      slot: template.slot,
      label,
      ...(shortLabel ? { shortLabel } : {}),
      danger: template.slot === 'delete',
      available,
      run: handler ?? (() => undefined),
    });
  }
  return actions;
}

/**
 * Подсказка при разработке: «объект X умеет A; объект Y умеет A — можно ли добавить Y?».
 *
 * Это СОВЕТ, а не запрет и не подсказка в рантайме: его читает разработчик (или линза
 * глобальных обработчиков), когда добавляет новую функцию объекту.
 */
export function suggestObjectCapabilityAdditions(kind: ObjectKind): ObjectCapabilitySuggestion[] {
  return suggestCapabilityAdditions(kind);
}

/** Умеет ли объект эту функцию (короткая форма для вызывающего кода). */
export function objectSupports(kind: ObjectKind, capability: Capability): boolean {
  return objectHasCapability(kind, capability);
}
