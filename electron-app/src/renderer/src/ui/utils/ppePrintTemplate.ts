/**
 * Шаблоны печатных форм: какие блоки и колонки печатать.
 *
 * Зачем они в БД, а не в localStorage: набор колонок для печати раньше жил в
 * localStorage клиента — он не переезжал на другую машину и терялся при переустановке.
 * Теперь шаблон лежит на сервере: кладовщик настраивает форму один раз и печатает
 * её на любой машине.
 *
 * Устройство шаблона:
 *  - `sections` — блоки формы: `{id, enabled, title}`. Выключенный блок не печатается;
 *  - `columns` — колонки списка: `{id, enabled, order, width}`;
 *  - `headerNote` / `footerNote` — свободный текст в шапке и подвале: то, что
 *    кладовщик дописывает под себя (номер приказа, отметка о печати, подпись).
 *
 * Применение шаблона к секциям — чистая функция: порядок и «показывать» остаются
 * от формы, шаблон решает только, что ВЫКЛЮЧИТЬ.
 */
import type { PrintSection } from './printPreview.js';

export type PpePrintTemplateLayout = {
  /** Блоки формы: включён/выключен. Неизвестный id игнорируется. */
  sections?: Array<{ id: string; enabled?: boolean; title?: string }>;
  /** Колонки списка: включён/выключен, порядок и ширина. */
  columns?: Array<{ id: string; enabled?: boolean; order?: number; width?: number }>;
  /** Примечание к шапке листа. */
  headerNote?: string;
  /** Подпись в подвале листа. */
  footerNote?: string;
};

export const PPE_PRINT_FORM_KEY = 'ppe_card';

/** Разбор сохранённого JSON шаблона. Сломанный JSON — пустой шаблон, а не падение. */
export function parsePrintTemplateLayout(raw: string | null | undefined): PpePrintTemplateLayout {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const obj = parsed as PpePrintTemplateLayout;
    return {
      ...(Array.isArray(obj.sections) ? { sections: obj.sections } : {}),
      ...(Array.isArray(obj.columns) ? { columns: obj.columns } : {}),
      ...(typeof obj.headerNote === 'string' ? { headerNote: obj.headerNote } : {}),
      ...(typeof obj.footerNote === 'string' ? { footerNote: obj.footerNote } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Применение шаблона к секциям формы: выключенные в шаблоне блоки снимаются,
 * остальные идут в своём порядке (порядок задаёт форма — он совпадает с приказом).
 */
export function applyPrintTemplate(sections: PrintSection[], layout: PpePrintTemplateLayout): PrintSection[] {
  const disabled = new Set(
    (layout.sections ?? []).filter((s) => s.enabled === false).map((s) => String(s.id)),
  );
  if (disabled.size === 0) return sections;
  return sections.filter((s) => !disabled.has(s.id));
}

/** Сборка шаблона из текущего состояния формы — кнопка «Сохранить как шаблон». */
export function buildPrintTemplateLayout(args: {
  sections: PrintSection[];
  headerNote?: string;
  footerNote?: string;
}): PpePrintTemplateLayout {
  return {
    sections: args.sections.map((s) => ({ id: s.id, enabled: s.checked !== false, title: s.title })),
    ...(args.headerNote ? { headerNote: args.headerNote } : {}),
    ...(args.footerNote ? { footerNote: args.footerNote } : {}),
  };
}
