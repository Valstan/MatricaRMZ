/**
 * Связь «карточка СИЗ ↔ карточка сотрудника».
 *
 * id у карточек РАЗНЫЕ: карточка СИЗ живёт в строгой `erp_employee_cards`
 * (зеркало импорта ЗУП), карточка сотрудника — в EAV (сущность типа `employee`).
 * Общий ключ один — табельный номер: `employee.personnel_number` ↔
 * `erp_employee_cards.personnel_no`. Серверная колонка `entity_id` (прямая ссылка
 * на EAV-карточку) в зеркальный DTO не входит, поэтому связь строим по номеру —
 * тем же ключом, каким уже связаны размеры в карточке СИЗ.
 *
 * Правило неоднозначности: два сотрудника с одним табельным номером → по такому
 * номеру переход НЕ предлагаем (иначе откроем чужую карточку). Размеры при этом
 * показываем: значение у обоих одно.
 */

import { PPE_SIZE_ATTRIBUTE_CODES } from './ppe.js';

/** Фактические размеры сотрудника — то, что кладовщик меряет при выдаче. */
export type EmployeeSizes = {
  clothes: string;
  shoes: string;
  height: string;
};

/** Пустые размеры: поле редактируемое и пустое, а не «—». */
export const EMPTY_EMPLOYEE_SIZES: EmployeeSizes = { clothes: '', shoes: '', height: '' };

/** Связь одного сотрудника с карточкой СИЗ. */
export type PpeEmployeeLink = {
  /** id EAV-карточки сотрудника — по нему открывается карточка сотрудника. */
  entityId: string;
  personnelNo: string;
  /** Фактические размеры из EAV-карточки сотрудника. */
  sizes: EmployeeSizes;
  /** Подразделение сотрудника (EAV `department_id`) — может быть пустым. */
  departmentId: string | null;
  /** Два сотрудника с одним табельным: переход по такому номеру не предлагаем. */
  ambiguous: boolean;
};

/** Строка EAV-списка сотрудников: id + атрибуты. */
export type PpeEmployeeLinkRow = {
  id: string;
  attributes?: Record<string, unknown> | null;
};

/** Строка списка сотрудников СИЗ (строгая `erp_employee_cards`). */
export type PpeEmployeeRef = {
  id: string;
  personnelNo?: string | null;
};

/** Код атрибута «табельный номер» в EAV-карточке сотрудника. */
export const EMPLOYEE_PERSONNEL_NO_ATTR_CODE = 'personnel_number';

/** Код атрибута «подразделение» в EAV-карточке сотрудника. */
export const EMPLOYEE_DEPARTMENT_ATTR_CODE = 'department_id';

function attrText(attributes: Record<string, unknown> | null | undefined, code: string): string {
  const raw = attributes?.[code];
  return raw == null || typeof raw === 'object' ? '' : String(raw).trim();
}

/** Фактические размеры из атрибутов EAV-карточки сотрудника. */
export function readEmployeeSizes(attributes: Record<string, unknown> | null | undefined): EmployeeSizes {
  return {
    clothes: attrText(attributes, PPE_SIZE_ATTRIBUTE_CODES.clothes),
    shoes: attrText(attributes, PPE_SIZE_ATTRIBUTE_CODES.shoes),
    height: attrText(attributes, PPE_SIZE_ATTRIBUTE_CODES.height),
  };
}

/**
 * Индекс «табельный номер → карточка сотрудника».
 *
 * Сотрудники без табельного номера в индекс не попадают: по ним связь
 * неоднозначна по определению, и переход по такому сотруднику не предлагается.
 */
export function buildEmployeeLinks(rows: PpeEmployeeLinkRow[]): Map<string, PpeEmployeeLink> {
  const out = new Map<string, PpeEmployeeLink>();
  for (const row of rows ?? []) {
    const personnelNo = attrText(row.attributes, EMPLOYEE_PERSONNEL_NO_ATTR_CODE);
    if (!personnelNo) continue;
    const existing = out.get(personnelNo);
    if (existing) {
      // Второй сотрудник с тем же номером: помечаем связь неоднозначной.
      out.set(personnelNo, { ...existing, ambiguous: true });
      continue;
    }
    out.set(personnelNo, {
      entityId: String(row.id),
      personnelNo,
      sizes: readEmployeeSizes(row.attributes),
      departmentId: attrText(row.attributes, EMPLOYEE_DEPARTMENT_ATTR_CODE) || null,
      ambiguous: false,
    });
  }
  return out;
}

/**
 * Обратная связь: карточка сотрудника (EAV) → карточка СИЗ (строгая).
 * Ищем по табельному номеру в списке сотрудников СИЗ.
 */
export function findPpeEmployeeIdByPersonnelNo(rows: PpeEmployeeRef[], personnelNo: string): string | null {
  const wanted = String(personnelNo ?? '').trim();
  if (!wanted) return null;
  for (const row of rows ?? []) {
    if (String(row.personnelNo ?? '').trim() === wanted) return String(row.id);
  }
  return null;
}
