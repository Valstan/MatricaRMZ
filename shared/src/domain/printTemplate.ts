/**
 * Печатные формы: единая модель шаблона.
 *
 * Зачем модель в shared, а не в renderer: шаблон — это ДАННЫЕ (что печатать), а не
 * код страницы. Клиент их читает, сервер их хранит и проверяет, и одна копия модели
 * не даёт им разойтись. Раньше модель жила только в renderer (`utils/ppePrintTemplate.ts`)
 * и привязывалась к карточке СИЗ; теперь она общая и привязана к виду формы.
 *
 * Устройство шаблона:
 *  - `sections` — блоки формы: `{id, enabled, title}`. Выключенный блок не печатается;
 *  - `columns` — колонки списка: `{id, enabled, order, width}`;
 *  - `headerNote` / `footerNote` — свободный текст в шапке и подвале;
 *  - `images` — картинки на листе: где встаёт (сверху/снизу/слева/справа) и какой ширины;
 *  - `fields` — правила подстановки: какое значение и откуда берётся (объект, подпись по
 *    должности, бригада наряда, свободный текст).
 *
 * Применение шаблона к секциям — чистая функция: порядок и «показывать» остаются
 * от формы, шаблон решает только, что ВЫКЛЮЧИТЬ.
 */

/**
 * Блок печатной формы. Живёт в shared, потому что шаблон (данные) ссылается на
 * блоки формы (структура) — и сервер, проверяющий шаблон, должен знать тот же контракт.
 */
export type PrintSection = {
  id: string;
  title: string;
  html: string;
  checked?: boolean;
  /** Не печатать заголовок секции (<h2>). Чекбокс-переключатель (по title) остаётся. */
  hideTitle?: boolean;
};

/** Куда на листе встаёт картинка шаблона. */
export type PrintImagePlacement = 'top' | 'bottom' | 'left' | 'right';

export const PRINT_IMAGE_PLACEMENTS: readonly PrintImagePlacement[] = ['top', 'bottom', 'left', 'right'];

export const PRINT_IMAGE_PLACEMENT_TITLES: Record<PrintImagePlacement, string> = {
  top: 'Сверху',
  bottom: 'Снизу',
  left: 'Слева',
  right: 'Справа',
};

/** Картинка печатной формы. Вшита в шаблон как data URI — шаблон должен быть самодостаточным. */
export type PrintTemplateImage = {
  id: string;
  /** `data:image/png;base64,…` — картинка целиком внутри шаблона. */
  dataUri: string;
  placement: PrintImagePlacement;
  /** Ширина картинки на листе, мм. */
  widthMm?: number;
  /** Подпись под картинкой. */
  caption?: string;
};

/** Откуда форма берёт значение поля. */
export type PrintFieldSource =
  /** Значение из карточки или списка, к которой открыта форма. */
  | 'object'
  /** Подпись: сотрудник с указанной должностью (и, если нужно, в указанном цехе). */
  | 'signature_role'
  /** Состав бригады, выбранный в наряде. */
  | 'work_order_crew'
  /** Свободный текст — заполняет оператор при создании документа. */
  | 'free_text';

export const PRINT_FIELD_SOURCES: readonly PrintFieldSource[] = [
  'object',
  'signature_role',
  'work_order_crew',
  'free_text',
];

export const PRINT_FIELD_SOURCE_TITLES: Record<PrintFieldSource, string> = {
  object: 'Поле объекта',
  signature_role: 'Подпись по должности',
  work_order_crew: 'Бригада наряда',
  free_text: 'Свободный текст',
};

/**
 * Правило подстановки значения в форму.
 *
 * `requireDepartment` — различает «директор — цех не выбирать» и «подпись начальника
 * цеха — выбрать ещё и номер цеха»: при `true` оператор указывает цех, и подпись
 * подставляется из карточки сотрудника именно этого цеха.
 */
export type PrintTemplateField = {
  id: string;
  /** Подпись поля в форме. */
  label: string;
  source: PrintFieldSource;
  /** Код поля объекта (для `source: 'object'`). */
  objectKey?: string;
  /** Должность подписанта (для `source: 'signature_role'`). */
  role?: string;
  /** Нужен ли выбор цеха (подразделения) для этой подписи. */
  requireDepartment?: boolean;
};

export type PrintTemplateLayout = {
  /** Блоки формы: включён/выключен. Неизвестный id игнорируется. */
  sections?: Array<{ id: string; enabled?: boolean; title?: string }>;
  /** Колонки списка: включён/выключен, порядок и ширина. */
  columns?: Array<{ id: string; enabled?: boolean; order?: number; width?: number }>;
  /** Примечание к шапке листа. */
  headerNote?: string;
  /** Подпись в подвале листа. */
  footerNote?: string;
  /** Картинки на листе. */
  images?: PrintTemplateImage[];
  /** Правила подстановки значений. */
  fields?: PrintTemplateField[];
};

/** Потолок картинки в шаблоне: data URI едет в каждый клиент, поэтому он не должен быть безразмерным. */
export const MAX_PRINT_TEMPLATE_IMAGE_BYTES = 512 * 1024;

/**
 * Разбор сохранённого JSON шаблона. Сломанный JSON — пустой шаблон, а не падение:
 * шаблон не должен ронять печать из-за одной испорченной строки.
 */
export function parsePrintTemplateLayout(raw: string | null | undefined): PrintTemplateLayout {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const obj = parsed as PrintTemplateLayout;
    return {
      ...(Array.isArray(obj.sections) ? { sections: obj.sections } : {}),
      ...(Array.isArray(obj.columns) ? { columns: obj.columns } : {}),
      ...(typeof obj.headerNote === 'string' ? { headerNote: obj.headerNote } : {}),
      ...(typeof obj.footerNote === 'string' ? { footerNote: obj.footerNote } : {}),
      ...(Array.isArray(obj.images) ? { images: obj.images.filter(isPrintTemplateImage) } : {}),
      ...(Array.isArray(obj.fields) ? { fields: obj.fields.filter(isPrintTemplateField) } : {}),
    };
  } catch {
    return {};
  }
}

function isPrintTemplateImage(value: unknown): value is PrintTemplateImage {
  if (!value || typeof value !== 'object') return false;
  const img = value as Partial<PrintTemplateImage>;
  if (typeof img.id !== 'string' || !img.id) return false;
  if (typeof img.dataUri !== 'string' || !img.dataUri.startsWith('data:image/')) return false;
  if (!PRINT_IMAGE_PLACEMENTS.includes(img.placement as PrintImagePlacement)) return false;
  return true;
}

function isPrintTemplateField(value: unknown): value is PrintTemplateField {
  if (!value || typeof value !== 'object') return false;
  const field = value as Partial<PrintTemplateField>;
  if (typeof field.id !== 'string' || !field.id) return false;
  if (typeof field.label !== 'string') return false;
  return PRINT_FIELD_SOURCES.includes(field.source as PrintFieldSource);
}

/**
 * Применение шаблона к секциям формы: выключенные в шаблоне блоки снимаются,
 * остальные идут в своём порядке (порядок задаёт форма — он совпадает с приказом).
 */
export function applyPrintTemplate(sections: PrintSection[], layout: PrintTemplateLayout): PrintSection[] {
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
  images?: PrintTemplateImage[];
  fields?: PrintTemplateField[];
}): PrintTemplateLayout {
  return {
    sections: args.sections.map((s) => ({ id: s.id, enabled: s.checked !== false, title: s.title })),
    ...(args.headerNote ? { headerNote: args.headerNote } : {}),
    ...(args.footerNote ? { footerNote: args.footerNote } : {}),
    ...(args.images?.length ? { images: args.images } : {}),
    ...(args.fields?.length ? { fields: args.fields } : {}),
  };
}

/** Строка шаблона в том виде, как её отдаёт сервер. */
export type PrintTemplateRow = {
  id: string;
  ownerId: string;
  entityKey: string;
  formKey: string;
  name: string;
  layoutJson: string;
  isDefault: boolean;
  updatedAt: number;
  updatedBy: string | null;
};

/**
 * Какой шаблон печатать «по умолчанию»: личный перекрывает общий (владелец настроил
 * под себя — его форма и печатается), внутри одного уровня — помеченный `isDefault`,
 * иначе первый по списку. Сервер отдаёт личные первыми, но порядок не должен быть
 * единственным правилом выбора.
 */
export function resolvePrintTemplate<T extends PrintTemplateRow>(rows: readonly T[] | null | undefined): T | null {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return null;
  const personal = list.filter((r) => r.ownerId !== 'shared');
  const pool = personal.length > 0 ? personal : list;
  return pool.find((r) => r.isDefault) ?? pool[0];
}
