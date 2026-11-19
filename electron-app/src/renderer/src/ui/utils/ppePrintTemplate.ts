/**
 * Шаблоны печатных форм: какие блоки и колонки печатать.
 *
 * Модель живёт в shared (`@matricarmz/shared` → `domain/printTemplate`): шаблон — это
 * данные, которые читает клиент, хранит сервер и проверяет на двери. Одна копия
 * модели не даёт клиенту и серверу разойтись.
 *
 * Зачем они в БД, а не в localStorage: набор блоков для печати раньше жил в
 * localStorage клиента — он не переезжал на другую машину и терялся при переустановке.
 * Теперь шаблон лежит на сервере: кладовщик настраивает форму один раз и печатает
 * её на любой машине.
 *
 * Этот файл — тонкий реэкспорт: старые импорты `../utils/ppePrintTemplate.js`
 * продолжают работать, новый код импортирует модель из shared напрямую.
 */
import type { PrintTemplateLayout } from '@matricarmz/shared';

export {
  applyPrintTemplate,
  buildPrintTemplateLayout,
  parsePrintTemplateLayout,
  resolvePrintTemplate,
  type PrintFieldSource,
  type PrintImagePlacement,
  type PrintSection,
  type PrintTemplateField,
  type PrintTemplateImage,
  type PrintTemplateLayout,
  type PrintTemplateRow,
} from '@matricarmz/shared';

/** Ключ формы карточки СИЗ — историческое имя, которым помечена эта форма. */
export const PPE_PRINT_FORM_KEY = 'ppe_card';

/** Историческое имя модели шаблона СИЗ — та же модель, что и у всех форм. */
export type { PrintTemplateLayout as PpePrintTemplateLayout };
