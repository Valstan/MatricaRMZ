import { HUMAN_LABEL_DASH, type WarehouseBomRelationSchema } from '@matricarmz/shared';

/**
 * Подписи встроенных типов деталей спецификации сборки. Жили запертыми на странице
 * спецификаций, и всё остальное — диалог разборки, печать — показывало код как есть.
 *
 * ПОЧЕМУ ЭТО НЕ ДОМЕН РЕЕСТРА. Множество типов ОТКРЫТО: сервер принимает любой непустой
 * тип, а источник истины — редактируемая оператором схема связей. Домен в реестре
 * превратил бы всё незнакомое в прочерк, то есть потерял бы типы, заведённые оператором.
 * Здесь только подписи для встроенных кодов; где загружена живая схема, подпись берётся
 * из неё (`componentTypeLabelsFromSchema` → второй аргумент), а этот словарь — запасной.
 */
export const COMPONENT_TYPE_LABELS: Record<string, string> = {
  sleeve: 'Гильза',
  piston: 'Поршень',
  ring: 'Кольцо',
  jacket: 'Рубашка',
  head: 'Головка',
  carter: 'Картер',
  other: 'Прочее',
};

/** Подписи типов из живой схемы связей: сюда попадают и типы, заведённые оператором. */
export function componentTypeLabelsFromSchema(schema: WarehouseBomRelationSchema): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of schema.nodes ?? []) {
    const label = String(node.label ?? '').trim();
    if (label) map.set(node.typeId, label);
  }
  return map;
}

/** Подпись типа детали. Кода не отдаёт никогда: неизвестный тип — прочерк. */
export function componentTypeLabel(code: unknown, live?: ReadonlyMap<string, string>): string {
  const key = String(code ?? '').trim();
  if (!key) return HUMAN_LABEL_DASH;
  return live?.get(key) ?? COMPONENT_TYPE_LABELS[key] ?? HUMAN_LABEL_DASH;
}
