/**
 * «Удалённое за 3 дня» — правило хранения и реестр видов объектов.
 *
 * СУТЬ. Удаление в программе МЯГКОЕ: запись помечается временем удаления и физически
 * остаётся (в серверной и клиентской схеме есть `deletedAt`). Значит, «удалено за
 * последние три дня» собирается из этих записей — отдельного хранилища «корзины удалённого»
 * не заводим (второе место хранения той же правды = «расползлось»).
 *
 * СРОК. Три дня — и окно показа, и срок хранения: записи старше срока не показываются
 * и удаляются окончательно. Решение владельца (по умолчанию) — см.
 * `docs/pending/udalennoe-za-tri-dnya-resheniya-vladelca.md`.
 */
import { AUDIT_OBJECT_SECTIONS, type AuditObjectKind, auditObjectRestorePath } from './auditObject.js';

/** Сколько дней храним удалённое и показываем в списке. */
export const DELETED_RETENTION_DAYS = 3;

/** Правило для интерфейса: видно оператору, а не только в коде. */
export const DELETED_RETENTION_TEXT = `Храним ${DELETED_RETENTION_DAYS} дня: записи старше — удаляются окончательно.`;

/** Виды объектов, которые попадают в «Удалённое за 3 дня». */
export type DeletedObjectKind = AuditObjectKind;

/**
 * Реестр видов: вид → раздел, где объект лежит (и куда он вернётся при восстановлении).
 * Порядок — как в меню программы, чтобы список читался привычно.
 */
export const DELETED_OBJECT_KINDS: ReadonlyArray<{ kind: DeletedObjectKind; section: string }> = [
  { kind: 'engine', section: AUDIT_OBJECT_SECTIONS.engine },
  { kind: 'contract', section: AUDIT_OBJECT_SECTIONS.contract },
  { kind: 'counterparty', section: AUDIT_OBJECT_SECTIONS.counterparty },
  { kind: 'supply_request', section: AUDIT_OBJECT_SECTIONS.supply_request },
  { kind: 'part', section: AUDIT_OBJECT_SECTIONS.part },
  { kind: 'employee', section: AUDIT_OBJECT_SECTIONS.employee },
  { kind: 'tool', section: AUDIT_OBJECT_SECTIONS.tool },
  { kind: 'work_order', section: AUDIT_OBJECT_SECTIONS.work_order },
  { kind: 'masterdata', section: AUDIT_OBJECT_SECTIONS.masterdata },
  { kind: 'stock_document', section: AUDIT_OBJECT_SECTIONS.stock_document },
  { kind: 'file', section: AUDIT_OBJECT_SECTIONS.file },
];

/** Раздел по виду объекта; '' — вид в реестр не входит. */
export function deletedObjectSection(kind: string): string {
  const found = DELETED_OBJECT_KINDS.find((entry) => entry.kind === kind);
  return found ? found.section : '';
}

/**
 * Путь возврата: «Двигатели → Д-100». Показывается ДО восстановления — оператор должен
 * видеть, что именно он вернёт и куда.
 */
export function deletedObjectRestorePath(kind: string, name: string): string {
  return auditObjectRestorePath(deletedObjectSection(kind), name);
}

/** Граница окна показа: отсечка по времени удаления (мс). */
export function deletedObjectsSince(nowMs: number, days: number = DELETED_RETENTION_DAYS): number {
  const span = Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000;
  return Math.max(0, nowMs - span);
}
