import { resolveEmploymentStatusCode } from './employees.js';
import { WorkOrderKind, type WorkOrderSignatureBlockSelection, type WorkOrderSignatureSlot } from './workOrder.js';

export type WorkOrderSignatureEmployee = {
  id?: string;
  displayName?: string | null;
  fullName?: string | null;
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  position?: string | null;
  employmentStatus?: string | null;
};

export type WorkOrderSignatureDecryptions = {
  crewMember: string;
  workshopHead: string;
  normingSpecialist: string;
  hrHead: string;
};

function normalizePosition(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е');
}

function initialsFromParts(parts: string[]): string {
  return parts
    .map((part) => (String(part ?? '').trim() ? `${String(part).trim().slice(0, 1).toUpperCase()}.` : ''))
    .filter(Boolean)
    .join('');
}

function initialsFromFullName(fullName: string): string {
  const parts = String(fullName ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (parts.length === 0) return '';
  const surname = parts[0] ?? '';
  const initials = initialsFromParts(parts.slice(1));
  return initials ? `${surname} ${initials}` : surname;
}

/** Определение одного блока подписей в печатной форме наряда. */
export type WorkOrderSignatureBlockDef = {
  /** Стабильный id блока (хранится в payload.signatureBlocks[*].blockId). */
  id: string;
  /** Заголовок блока на печати. */
  title: string;
  /** Подпись пустой строки даты в блоке (напр. «Дата выполнения») — под запись от руки. */
  dateLineLabel?: string;
  /**
   * Роли по умолчанию (caption) для предзаполнения блока: пока оператор не задал своих
   * подписантов, блок показывается/печатается с этими ролями и пустыми строками под подпись.
   */
  defaultCaptions?: readonly string[];
};

/**
 * Старые id блоков (до двухфазной процедуры) → новый id. Наряды, подписанные раньше,
 * не осиротевают: их слоты подхватываются под соответствующим новым блоком.
 * Старый общий блок «default» (нефазовый) относим к «Выдаче наряда».
 */
const SIGNATURE_BLOCK_LEGACY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  issue: ['issue', 'assembly_issued', 'default'],
  completion: ['completion', 'assembly_accepted'],
};

/** Все id (новый + legacy), под которыми может храниться этот блок. */
export function workOrderSignatureBlockAliases(blockId: string): readonly string[] {
  return SIGNATURE_BLOCK_LEGACY_ALIASES[blockId] ?? [blockId];
}

/**
 * Блоки подписей наряда. Единая двухфазная процедура для ВСЕХ типов наряда:
 * «Выдача наряда» (ПДО выдал → ОТК согласовал → нач. цеха принял в работу) и
 * «Завершение наряда» (нач. цеха сдал → ОТК принял → ПДО принял/закрыл).
 * Гриф «Утверждаю» (директор) — отдельный, печатается над шапкой, не входит в эти блоки.
 */
export function getWorkOrderSignatureBlocks(
  kind: WorkOrderKind | string | null | undefined,
): readonly WorkOrderSignatureBlockDef[] {
  const isAssembly = kind === WorkOrderKind.Assembly;
  return [
    {
      id: 'issue',
      title: 'Выдача наряда',
      // У сборки строки даты в блоке выдачи нет (решение владельца 2026-07-03);
      // прогноз готовности виден в реквизите «Срок» шапки.
      ...(isAssembly ? {} : { dateLineLabel: 'Дата выдачи' }),
      defaultCaptions: ['Наряд выдал', 'Согласовано (ОТК)', 'Принял в работу'],
    },
    {
      id: 'completion',
      title: 'Завершение наряда',
      dateLineLabel: 'Дата выполнения',
      defaultCaptions: ['Работу сдал', 'Работу принял (ОТК)', 'Работу принял'],
    },
  ];
}

/** Слоты блока из payload (учитывая старые id блоков). Пусто, если не задано. */
export function findWorkOrderSignatureSlots(
  blocks: readonly WorkOrderSignatureBlockSelection[] | undefined,
  blockId: string,
): readonly WorkOrderSignatureSlot[] {
  if (!blocks?.length) return [];
  const aliases = workOrderSignatureBlockAliases(blockId);
  return blocks.find((b) => aliases.includes(b.blockId))?.slots ?? [];
}

/**
 * Слоты блока для показа в редакторе и печати: заданные оператором, иначе — роли по
 * умолчанию (caption из defaultCaptions, без сотрудника → пустая строка под подпись).
 * Так даже нетронутый наряд печатается со всеми ролями процедуры под живые подписи.
 */
export function resolveWorkOrderSignatureSlots(
  block: WorkOrderSignatureBlockDef,
  blocks: readonly WorkOrderSignatureBlockSelection[] | undefined,
): WorkOrderSignatureSlot[] {
  const persisted = findWorkOrderSignatureSlots(blocks, block.id);
  if (persisted.length) return persisted.map((s) => ({ ...s }));
  return (block.defaultCaptions ?? []).map((caption) => ({ caption }));
}

/**
 * Подсказки ролей подписи (datalist в редакторе). Роли НЕ фиксированы — оператор может
 * выбрать из списка или ввести своё. Порядок ≈ типичный путь наряда (выдача → выполнение).
 */
export const WORK_ORDER_SIGNATURE_CAPTION_SUGGESTIONS: readonly string[] = [
  'Наряд выдал',
  'Согласовано (ОТК)',
  'Принял в работу',
  'Работу сдал',
  'Работу принял (ОТК)',
  'Работу принял',
  'Утверждаю',
];

/**
 * Расшифровка подписи по ГОСТ Р 7.0.97-2016: «И.О. Фамилия» (инициалы перед фамилией).
 * При наличии lastName/firstName/middleName собирается из них, иначе — из ФИО одной
 * строкой (первое слово — фамилия). Пустой сотрудник → пустая строка.
 */
export function formatEmployeeInitialsSurname(employee: WorkOrderSignatureEmployee): string {
  const last = String(employee.lastName ?? '').trim();
  if (last) {
    const initials = initialsFromParts([String(employee.firstName ?? '').trim(), String(employee.middleName ?? '').trim()]);
    return initials ? `${initials} ${last}` : last;
  }
  const full = String(employee.fullName ?? employee.displayName ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!full) return '';
  const parts = full.split(' ').filter(Boolean);
  const surname = parts[0] ?? '';
  const initials = initialsFromParts(parts.slice(1));
  return initials ? `${initials} ${surname}` : surname;
}

/** Фамилия и инициалы для расшифровки подписи (например, «Иванов И.И.»). */
export function formatEmployeeSurnameInitials(employee: WorkOrderSignatureEmployee): string {
  const last = String(employee.lastName ?? '').trim();
  const first = String(employee.firstName ?? '').trim();
  const middle = String(employee.middleName ?? '').trim();
  if (last) {
    const initials = initialsFromParts([first, middle]);
    return initials ? `${last} ${initials}` : last;
  }
  const full = String(employee.fullName ?? employee.displayName ?? '').trim();
  return full ? initialsFromFullName(full) : '';
}

function isWorkingEmployee(employee: WorkOrderSignatureEmployee): boolean {
  return resolveEmploymentStatusCode(employee.employmentStatus, null) === 'working';
}

function positionMatchesGroups(position: string, groups: string[][]): boolean {
  const normalized = normalizePosition(position);
  if (!normalized) return false;
  return groups.every((group) => group.some((keyword) => normalized.includes(normalizePosition(keyword))));
}

export function findEmployeeByPositionGroups(
  employees: WorkOrderSignatureEmployee[],
  groups: string[][],
): WorkOrderSignatureEmployee | null {
  for (const employee of employees) {
    if (!isWorkingEmployee(employee)) continue;
    if (positionMatchesGroups(String(employee.position ?? ''), groups)) return employee;
  }
  return null;
}

export function resolveWorkOrderSignatureDecryptions(args: {
  crewEmployeeIds: string[];
  employees: WorkOrderSignatureEmployee[];
}): WorkOrderSignatureDecryptions {
  const byId = new Map(
    args.employees
      .map((employee) => [String(employee.id ?? '').trim(), employee] as const)
      .filter(([id]) => id.length > 0),
  );

  const crewNames: string[] = [];
  const seenCrew = new Set<string>();
  for (const employeeId of args.crewEmployeeIds) {
    const id = String(employeeId ?? '').trim();
    if (!id) continue;
    const employee = byId.get(id);
    if (!employee) continue;
    const formatted = formatEmployeeSurnameInitials(employee);
    if (!formatted || seenCrew.has(formatted)) continue;
    seenCrew.add(formatted);
    crewNames.push(formatted);
  }

  const workshopHead = findEmployeeByPositionGroups(args.employees, [['начальник'], ['цех']]);
  const normingSpecialist = findEmployeeByPositionGroups(args.employees, [['специалист'], ['нормирован', 'нормирование']]);
  const hrHead = findEmployeeByPositionGroups(args.employees, [['начальник'], ['кадр', 'отдел кадров']]);

  return {
    crewMember: crewNames.join(', '),
    workshopHead: workshopHead ? formatEmployeeSurnameInitials(workshopHead) : '',
    normingSpecialist: normingSpecialist ? formatEmployeeSurnameInitials(normingSpecialist) : '',
    hrHead: hrHead ? formatEmployeeSurnameInitials(hrHead) : '',
  };
}
