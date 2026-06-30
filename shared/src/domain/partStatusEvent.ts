/**
 * Ф5 актов двигателя (GAP-6): per-деталь история статусов ремонта.
 *
 * Носитель — строки `operations` с `operationType='part_status_event'` и
 * `engineEntityId` = двигатель. Синкаются дженериком (operation_type — свободный
 * текст, meta_json — opaque JSON), сync-контракт не меняется.
 *
 * Пишутся:
 *  - 'in_repair' — electron main при создании Repair-наряда из дефектовки
 *    (workOrders:createRepairFromDefects);
 *  - 'ready_for_assembly' — backend при закрытии Repair-наряда, per (engineId, partId)
 *    из work-lines с привязкой к двигателю (best-effort, закрытие не валит).
 */

export const PART_STATUS_EVENT_TYPE = 'part_status_event' as const;

export type PartRepairStatus = 'in_repair' | 'ready_for_assembly';

export type PartStatusEventPayload = {
  kind: 'part_status_event';
  engineEntityId: string;
  /** id детали/номенклатуры (как в work-line.partId — directory_parts либо erp_nomenclature). */
  partId: string;
  partLabel: string;
  qty: number;
  status: PartRepairStatus;
  workOrderOperationId: string;
  workOrderNumber: number;
};

export function partRepairStatusLabel(status: PartRepairStatus): string {
  return status === 'in_repair' ? 'в ремонте' : 'готова к сборке';
}

export function buildPartStatusEventNote(payload: Pick<PartStatusEventPayload, 'partLabel' | 'status' | 'workOrderNumber'>): string {
  const wo = payload.workOrderNumber > 0 ? ` (наряд №${payload.workOrderNumber})` : '';
  return `${payload.partLabel || 'Деталь'} — ${partRepairStatusLabel(payload.status)}${wo}`;
}

/** Парсит meta_json операции part_status_event; null для чужих/битых payload. */
export function parsePartStatusEventPayload(metaJson: string | null | undefined): PartStatusEventPayload | null {
  if (!metaJson) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(String(metaJson));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== 'part_status_event') return null;
  const status = obj.status === 'in_repair' || obj.status === 'ready_for_assembly' ? obj.status : null;
  const partId = typeof obj.partId === 'string' ? obj.partId.trim() : '';
  if (!status || !partId) return null;
  return {
    kind: 'part_status_event',
    engineEntityId: typeof obj.engineEntityId === 'string' ? obj.engineEntityId : '',
    partId,
    partLabel: typeof obj.partLabel === 'string' ? obj.partLabel : '',
    qty: Math.max(0, Math.floor(Number(obj.qty ?? 0)) || 0),
    status,
    workOrderOperationId: typeof obj.workOrderOperationId === 'string' ? obj.workOrderOperationId : '',
    workOrderNumber: Math.max(0, Math.floor(Number(obj.workOrderNumber ?? 0)) || 0),
  };
}
