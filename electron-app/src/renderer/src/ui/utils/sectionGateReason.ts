// Почему раздел не открывается — каким фильтром его срезали.
//
// Раздел режут три независимых фильтра, и оператор видит только следствие:
// раздел просто исчезает из меню, а плашка в левой полосе не появляется.
// Владелец 23.11.2026 (промт КАРМАНА #84): «на планшете так и не появилась в
// меню “Производственная программа”» — и непонятно, то ли права, то ли раздел
// не выдан учётной записи, то ли клиент его не показывает.
//
// Модуль отвечает на один вопрос: каким фильтром срезан раздел, — чтобы
// интерфейс сказал это словами, а не исчез молча.

/** Фильтр, срезавший раздел. */
export type SectionGateReason = 'no_right' | 'no_membership' | 'not_in_tablet_preset';

/**
 * Причина, по которой раздел не открывается; `null` — раздел открыт.
 *
 * Порядок — от общего к частому: право, потом членство в разделе, потом
 * пресет клиента. Проверка права первой: раздел, которого нет в праве,
 * «не выдан» быть не может — иначе оператор получит неверную причину.
 */
export function sectionGateReason(args: {
  /** Раздел есть в списке по правам (`availableTabs`). */
  allowedByRight: boolean;
  /** Раздел есть после фильтра членства в разделах. */
  allowedByMembership: boolean;
  /** Раздел есть после пресета клиента (планшетной рамки). */
  allowedByTabletPreset: boolean;
}): SectionGateReason | null {
  if (args.allowedByTabletPreset) return null;
  if (!args.allowedByRight) return 'no_right';
  if (!args.allowedByMembership) return 'no_membership';
  return 'not_in_tablet_preset';
}

/** Словами для оператора — почему раздел не открывается. */
export function sectionGateReasonText(reason: SectionGateReason): string {
  switch (reason) {
    case 'no_right':
      return 'нет права на этот раздел';
    case 'no_membership':
      return 'раздел не выдан вашей учётной записи';
    case 'not_in_tablet_preset':
      return 'раздел не входит в меню планшета';
    default:
      return 'раздел недоступен';
  }
}
