/**
 * Сквозной программный номер КАРТОЧКИ двигателя — `RMZ451`.
 *
 * Первые два номера двигателя (документный с картера и заводской `41/26` из журнала
 * дефектовки) уникальности не дают: документный повторяется при повторном заезде и
 * приезжает с опечатками, заводской уникален только парой (номер, год). Поэтому у
 * каждого создания карточки есть свой номер, который не переиспользуется никогда —
 * ни после удаления карточки, ни после её слияния с другой.
 *
 * Номер принадлежит СОЗДАНИЮ, а не железу: тот же двигатель, приехавший в ремонт
 * второй раз, получает новую карточку и новый номер. Поэтому в `stamped_number`
 * строк деталей он не подставляется (поэкземплярный учёт ремфонда, решение
 * 15.07.2026, PR #216) — там живёт личный номер экземпляра детали.
 *
 * Выдаёт номер сервер (`erp_engine_numbers`, последовательность `engine_rmz_seq`),
 * клиент только читает: приложение работает офлайн, а номер обязан быть сквозным по
 * заводу. Пока карточка до сервера не доехала, номера нет — экран говорит об этом
 * прямо, а не подставляет чужой.
 */

export const ENGINE_RMZ_PREFIX = 'RMZ';

/** Состояние выданного номера: карточка жива / удалена / слита с другой. */
export const ENGINE_RMZ_NUMBER_STATUSES = ['active', 'deleted', 'merged'] as const;

export type EngineRmzNumberStatus = (typeof ENGINE_RMZ_NUMBER_STATUSES)[number];

function asSequence(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Число номера → как его видит оператор: 451 → 'RMZ451'. Пусто, если номера нет. */
export function formatEngineRmzNumber(seq: number | null | undefined): string {
  const n = asSequence(seq);
  return n == null ? '' : `${ENGINE_RMZ_PREFIX}${n}`;
}

/**
 * Разбор номера из текста: 'RMZ451', 'rmz451' → 451. Голое число не принимается —
 * это может быть документный номер, и угадывать за оператора здесь нечего.
 */
export function parseEngineRmzNumber(text: string | null | undefined): number | null {
  const match = /^rmz(\d+)$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  return asSequence(Number(match[1]));
}

/**
 * Ключ сортировки: `451` → '000000000451'. Дополнение нулями обязательно —
 * иначе строковое сравнение поставит `RMZ1000` раньше `RMZ451`. Пустой номер
 * даёт '' и уезжает в конец списка, как у внутреннего номера.
 */
export function engineRmzNumberSortKey(seq: number | null | undefined): string {
  const n = asSequence(seq);
  return n == null ? '' : String(n).padStart(12, '0');
}
