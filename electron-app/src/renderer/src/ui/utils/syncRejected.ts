/**
 * Подписи rejected-строк синка для баннера (09.10.2026): что за строка и почему
 * сервер её не примет. Сырые `table:reason` оператору ничего не говорят.
 */

const TABLE_LABELS: Record<string, string> = {
  operations: 'Операция',
  entities: 'Карточка',
  attribute_values: 'Поле карточки',
  work_orders: 'Наряд',
  chat_messages: 'Сообщение',
  erp_engine_cards: 'Карточка двигателя',
};

export function syncTableLabel(table: string): string {
  return TABLE_LABELS[String(table ?? '').trim()] ?? String(table ?? '');
}

export function syncRejectReasonLabel(reason: string): string {
  const text = String(reason ?? '').trim();
  if (!text) return 'причина неизвестна';
  if (text.startsWith('reserved:')) return 'двигатель занят другим — уйдёт само';
  if (text.startsWith('forbidden:')) return 'нет прав на запись';
  if (text.includes('"reason":"deleted"')) return 'ссылка на удалённое';
  if (text.startsWith('invalid_reference')) return 'битая ссылка — проверьте данные';
  if (text.startsWith('missing_dependency')) return 'ждёт данные (возможно, двигатель)';
  if (text.startsWith('engine_')) return 'гейт карточки двигателя';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function describeRejectedRow(row: { table: string; rowId: string; reason: string }): string {
  const id = String(row.rowId ?? '');
  const short = id.length > 8 ? `${id.slice(0, 8)}…` : id;
  return `${syncTableLabel(row.table)} ${short} — ${syncRejectReasonLabel(row.reason)}`;
}
