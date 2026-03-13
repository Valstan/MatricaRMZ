import type { SupplyRequestTransitionAction } from './supplyRequest.js';

const ACTION_POSITION_KEYWORDS: Record<SupplyRequestTransitionAction, string[]> = {
  sign: ['начальник'],
  director_approve: ['директор'],
  accept: ['снабжен', 'снабжение'],
  fulfill_full: ['снабжен', 'снабжение'],
  fulfill_partial: ['снабжен', 'снабжение'],
};

function normalizePart(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е');
}

export function canActByPosition(
  action: SupplyRequestTransitionAction,
  userPosition: string | null | undefined,
  userRole: string | null | undefined,
): boolean {
  if (normalizePart(userRole) === 'superadmin') return true;
  const position = normalizePart(userPosition);
  if (!position) return false;
  const keywords = ACTION_POSITION_KEYWORDS[action] ?? [];
  return keywords.some((keyword) => position.includes(normalizePart(keyword)));
}

export function canSignAsDepartmentHead(
  action: SupplyRequestTransitionAction,
  userDepartmentId: string | null | undefined,
  documentDepartmentId: string | null | undefined,
): boolean {
  if (action !== 'sign') return true;
  const userDept = String(userDepartmentId ?? '').trim();
  const documentDept = String(documentDepartmentId ?? '').trim();
  return !!userDept && !!documentDept && userDept === documentDept;
}

