import { SYNTHETIC_NOMENCLATURE_CODE_REJECT, isSyntheticNomenclatureCode } from '@matricarmz/shared';

import type { PromptTextOptions } from '../components/ConfirmContext.js';

/**
 * Стоп-кран синтетики: быстрое создание позиции спрашивает артикул у оператора вместо
 * того, чтобы штамповать заглушку `DET-…`.
 *
 * Почему спрашиваем, а не просто перестаём штамповать: идентичность детали — пара
 * имя+артикул, и без артикула вторая одноимённая карточка («Фильтр масляный» их на
 * проде четыре) упёрлась бы в дедуп и увела оператора в чужую карточку. Артикул —
 * единственное, чем строки внутри такой группы вообще различаются.
 *
 * `null` — оператор отменил создание; `''` — осознанно выбрал «без артикула».
 */
export async function promptNomenclatureArticle(
  promptText: (opts: PromptTextOptions) => Promise<string | null>,
  name: string,
): Promise<string | null> {
  const label = String(name ?? '').trim();
  return promptText({
    title: 'Артикул позиции',
    detail: label
      ? `Создаётся «${label}». Артикул отличает её от одноимённых и находится поиском в цеху.`
      : 'Артикул отличает позицию от одноимённых и находится поиском в цеху.',
    placeholder: 'например, 3301-15-30',
    confirmLabel: 'Создать',
    emptyLabel: 'Без артикула',
    validate: (v) => (isSyntheticNomenclatureCode(v) ? SYNTHETIC_NOMENCLATURE_CODE_REJECT : null),
  });
}
