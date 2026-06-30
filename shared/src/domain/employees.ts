export type EmployeeAccessInfo = {
  id: string;
  accessEnabled: boolean;
  systemRole: string;
  deleteRequestedAt?: number | null;
  deleteRequestedById?: string | null;
  deleteRequestedByUsername?: string | null;
};

/** Код статуса занятости для логики (храним в атрибуте как `working` / `fired`). */
export type EmploymentStatusCode = 'working' | 'fired';

/**
 * Разбирает сырое значение `employment_status` (англ. коды, русские подписи, пусто).
 * Синонимы вроде `working` и «работает» приводятся к одному коду.
 */
export function parseEmploymentStatusAttr(raw: string | null | undefined): EmploymentStatusCode {
  const n = String(raw ?? '').trim().toLowerCase();
  if (!n) return 'working';
  if (n === 'fired' || n.includes('уволен')) return 'fired';
  if (n === 'dismissed' || n === 'terminated') return 'fired';
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
  return code === 'fired' ? 'уволен' : 'работает';
}

/** Единая русская подпись для списков, карточек и поиска по статусу сотрудника. */
export function formatEmploymentStatusAttrForUi(raw: string | null | undefined): string {
  return employmentStatusLabelRu(parseEmploymentStatusAttr(raw));
}
