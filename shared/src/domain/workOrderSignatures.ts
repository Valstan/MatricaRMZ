import { resolveEmploymentStatusCode } from './employees.js';

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
