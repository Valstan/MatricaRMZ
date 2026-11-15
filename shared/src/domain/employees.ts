export type EmployeeAccessInfo = {
  id: string;
  accessEnabled: boolean;
  systemRole: string;
  deleteRequestedAt?: number | null;
  deleteRequestedById?: string | null;
  deleteRequestedByUsername?: string | null;
};

/**
 * Код статуса занятости для логики (храним в атрибуте как `working` / `fired` /
 * `decret` / `sick_leave`).
 *
 * `decret` и `sick_leave` — решение владельца 15.11.2026: ушедшие в декрет или на
 * лечение считаются «серенькими» наравне с уволенными (дети таких сотрудников не
 * участвуют в отборах и уходят из напоминалок).
 */
export type EmploymentStatusCode = 'working' | 'fired' | 'decret' | 'sick_leave';

/**
 * Разбирает сырое значение `employment_status` (англ. коды, русские подписи, пусто).
 * Синонимы вроде `working` и «работает» приводятся к одному коду.
 */
export function parseEmploymentStatusAttr(raw: string | null | undefined): EmploymentStatusCode {
  const n = String(raw ?? '').trim().toLowerCase();
  if (!n) return 'working';
  if (n === 'fired' || n.includes('уволен')) return 'fired';
  if (n === 'dismissed' || n === 'terminated') return 'fired';
  if (n === 'decret' || n.includes('декрет') || n === 'maternity' || n === 'child_leave') return 'decret';
  if (n === 'sick_leave' || n === 'sick' || n === 'ill' || n.includes('лечени') || n.includes('болезн')) {
    return 'sick_leave';
  }
  if (n === 'working' || n === 'work' || n === 'works' || n === 'active') return 'working';
  if (n.includes('работ')) return 'working';
  return 'working';
}

/**
 * Учитывает дату увольнения: при ненулевой дате статус считается «уволен», даже если строка ещё не исправлена.
 */
export function resolveEmploymentStatusCode(
  raw: string | null | undefined,
  terminationDateMs?: number | null,
): EmploymentStatusCode {
  const t = terminationDateMs;
  if (t != null && Number.isFinite(t) && t > 0) return 'fired';
  return parseEmploymentStatusAttr(raw);
}

export function employmentStatusLabelRu(code: EmploymentStatusCode): string {
  if (code === 'fired') return 'уволен';
  if (code === 'decret') return 'в декрете';
  if (code === 'sick_leave') return 'на лечении';
  return 'работает';
}

/** Сотрудник сейчас не работает, но ещё не уволен (декрет, лечение). */
export function isOnLeaveStatus(code: EmploymentStatusCode): boolean {
  return code === 'decret' || code === 'sick_leave';
}

/**
 * Родитель «серенький» для детского модуля: уволен или отсутствует (декрет, лечение).
 * Правило одно и выводится из статуса занятости — ручного флага на ребёнке нет,
 * иначе статус разъедется с кадровым.
 */
export function isSilverParentStatus(code: EmploymentStatusCode): boolean {
  return code === 'fired' || isOnLeaveStatus(code);
}

/** Почему родитель «серенький» — для подписи в списке и карточке ребёнка. */
export function silverParentReasonRu(code: EmploymentStatusCode): string | null {
  if (code === 'fired') return 'родитель уволен';
  if (code === 'decret') return 'родитель в декрете';
  if (code === 'sick_leave') return 'родитель на лечении';
  return null;
}

/** Единая русская подпись для списков, карточек и поиска по статусу сотрудника. */
export function formatEmploymentStatusAttrForUi(raw: string | null | undefined): string {
  return employmentStatusLabelRu(parseEmploymentStatusAttr(raw));
}
