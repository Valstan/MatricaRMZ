/**
 * Реестр печатных форм: какие формы в программе печатаются и из каких блоков состоят.
 *
 * Зачем реестр, если блоки печати собирает сама страница: редактор шаблона должен
 * предложить оператору ПОНЯТНЫЕ пункты («Реквизиты», «Нормы», «Подписи»), а не
 * технические id. Реестр — этот список в одном месте; id блоков в нём совпадают
 * с id блоков, которые отдают построители форм (`buildPersonalCardForm`,
 * `buildWorkOrderPrintModel`, `buildEnginePrintModel`, `ListPrintDialog`).
 *
 * Ключ формы (`entityKey`) — это ПРИВЯЗКА шаблона к объекту: по нему печать находит
 * свои шаблоны, а шаблон находит свои блоки.
 */

/** Группы форм — по ним раздел «Печатные формы» раскладывает список. */
export type PrintFormGroup = 'ppe' | 'engine' | 'production' | 'list' | 'document';

export const PRINT_FORM_GROUP_TITLES: Record<PrintFormGroup, string> = {
  ppe: 'СИЗ',
  engine: 'Двигатели',
  production: 'Производство',
  list: 'Списки',
  document: 'Документы',
};

/** Блок печатной формы: id (совпадает с id у построителя формы) и название для оператора. */
export type PrintFormSectionDef = {
  id: string;
  title: string;
};

export type PrintFormEntityKey =
  | 'ppe_card'
  | 'ppe_issue_card'
  | 'engine_card'
  | 'work_order'
  | 'engine_list'
  | 'parts_list'
  | 'document_service_note'
  | 'document_vacation_request';

export type PrintFormKindDef = {
  key: PrintFormEntityKey;
  title: string;
  group: PrintFormGroup;
  /** Форма — документ: её заполняют, а потом печатают (служебная записка, заявление). */
  isDocument?: boolean;
  sections: readonly PrintFormSectionDef[];
};

export const PRINT_FORM_KINDS: readonly PrintFormKindDef[] = [
  {
    key: 'ppe_card',
    title: 'Карточка СИЗ (личная карточка)',
    group: 'ppe',
    sections: [
      { id: 'title', title: 'Заголовок' },
      { id: 'requisites', title: 'Реквизиты' },
      { id: 'norms', title: 'Нормы' },
      { id: 'history', title: 'История выдач' },
      { id: 'sign', title: 'Подписи' },
    ],
  },
  {
    key: 'ppe_issue_card',
    title: 'Карточка выдачи СИЗ',
    group: 'ppe',
    sections: [
      { id: 'title', title: 'Заголовок' },
      { id: 'employee', title: 'Сотрудник' },
      { id: 'items', title: 'Выданное' },
      { id: 'sign', title: 'Подписи' },
    ],
  },
  {
    key: 'engine_card',
    title: 'Карточка двигателя',
    group: 'engine',
    sections: [
      { id: 'main', title: 'Основное' },
      { id: 'history', title: 'История ремонта' },
      { id: 'reclamation', title: 'Рекламация' },
    ],
  },
  {
    key: 'work_order',
    title: 'Наряд',
    group: 'production',
    sections: [
      { id: 'director', title: 'Гриф директора' },
      { id: 'title', title: 'Заголовок' },
      { id: 'meta', title: 'Реквизиты' },
      { id: 'crew', title: 'Бригада и выплаты' },
      { id: 'works', title: 'Виды работ' },
      { id: 'signatures', title: 'Подписи' },
    ],
  },
  {
    key: 'engine_list',
    title: 'Список двигателей',
    group: 'list',
    sections: [{ id: 'list', title: 'Таблица' }],
  },
  {
    key: 'parts_list',
    title: 'Список деталей',
    group: 'list',
    sections: [{ id: 'list', title: 'Таблица' }],
  },
  {
    key: 'document_service_note',
    title: 'Служебная записка',
    group: 'document',
    isDocument: true,
    sections: [
      { id: 'title', title: 'Заголовок' },
      { id: 'from', title: 'От кого' },
      { id: 'to', title: 'Кому' },
      { id: 'body', title: 'Текст записки' },
      { id: 'sign', title: 'Подписи' },
    ],
  },
  {
    key: 'document_vacation_request',
    title: 'Заявление на отпуск',
    group: 'document',
    isDocument: true,
    sections: [
      { id: 'title', title: 'Заголовок' },
      { id: 'employee', title: 'Сотрудник' },
      { id: 'period', title: 'Период отпуска' },
      { id: 'reason', title: 'Причина' },
      { id: 'sign', title: 'Подписи' },
    ],
  },
];

const KIND_BY_KEY: Record<PrintFormEntityKey, PrintFormKindDef> = PRINT_FORM_KINDS.reduce(
  (acc, kind) => {
    acc[kind.key] = kind;
    return acc;
  },
  {} as Record<PrintFormEntityKey, PrintFormKindDef>,
);

export function isPrintFormEntityKey(value: unknown): value is PrintFormEntityKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KIND_BY_KEY, value);
}

export function printFormKind(key: string | null | undefined): PrintFormKindDef | null {
  if (!key) return null;
  return isPrintFormEntityKey(key) ? KIND_BY_KEY[key] : null;
}

export function printFormKindTitle(key: string | null | undefined): string {
  return printFormKind(key)?.title ?? String(key ?? '');
}

/** Виды форм, которые заполняет оператор, а потом печатает (документы). */
export const PRINT_DOCUMENT_KINDS: readonly PrintFormKindDef[] = PRINT_FORM_KINDS.filter((k) => k.isDocument);
