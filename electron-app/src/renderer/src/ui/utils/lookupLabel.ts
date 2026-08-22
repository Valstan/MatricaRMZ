import { HUMAN_LABEL_DASH, looksLikeIdentifier } from '@matricarmz/shared';

/**
 * Подпись сущности по справочнику, который уже загружен на страницу.
 *
 * Заведено потому, что выражение `справочник[id] ?? id` жило в полудюжине мест и в каждом
 * из них показывало оператору идентификатор, как только справочник не догрузился или
 * запись удалили. Проверка на идентификатор — реестровая, своих регулярок здесь нет.
 *
 * ГДЕ ЭТИМ ПОЛЬЗОВАТЬСЯ НЕЛЬЗЯ: там, где подпись служит ключом — сортировкой, точным
 * сравнением введённого текста, антидублем при создании. Две безымянные записи получат
 * одинаковый текст и станут неразличимы; в выпадающих списках это молча привяжет к
 * документу произвольную сущность.
 */
export function lookupLabel(
  id: string | null | undefined,
  lookup: (key: string) => unknown,
  texts?: { absent?: string; missing?: string },
): string {
  const key = String(id ?? '').trim();
  if (!key) return texts?.absent ?? HUMAN_LABEL_DASH;
  const raw = lookup(key);
  const text = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!text || looksLikeIdentifier(text)) return texts?.missing ?? HUMAN_LABEL_DASH;
  return text;
}

/**
 * Тексты для марки двигателя. Разведены «марки нет» и «марка была, но её не найти»:
 * первое — обычное состояние карточки, второе — сигнал, что справочник разъехался с
 * данными, и оператору полезно это видеть. Образец взят с карточки договора, где так
 * сделано с самого начала.
 */
export const BRAND_LABEL_TEXTS = { absent: 'Без марки', missing: '⚠ марка удалена' } as const;
