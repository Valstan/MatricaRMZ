/**
 * Universal work-order templates (Stage 1 of work-order-template-system plan).
 *
 * Generalises the Workshop-specific WorkshopRepairTemplate from v1.26/27 to any
 * of the four base WorkOrderKind values. A template carries:
 *
 *   - payloadOverrides — partial WorkOrderPayload snapshot copied via Object.assign
 *     when the operator clicks [Apply template] on a work-order card.
 *   - hiddenFields     — array of payload field keys hidden in the UI for that kind
 *                        of order. Visual-only — stored values stay null in the DB.
 *   - lines            — ordered template lines copied into payload.freeWorks at apply.
 *
 * Templates are global (not per-user): they represent цех/процесс conventions, not
 * personal preferences.
 *
 * Open questions kept until later stages:
 *   - Replace vs append semantics for `lines` at apply — UX call in Stage 5.
 *   - Picker UX for hidden fields (checkbox per field vs. two-pane shuttle) — Stage 4.
 */

import { WorkOrderKind } from './workOrder.js';

/**
 * One template line. Mirrors the shape of `WorkOrderPayload.freeWorks[i]` but
 * every field is optional: a template may pre-fill just nomenclature, just
 * service, or any subset. lineNo/price/amount are not stored — they are filled
 * in at apply-time by the work-order card's existing freeWorks normalization.
 */
export type WorkOrderTemplateLine = {
  nomenclatureId?: string;
  serviceId?: string;
  serviceName?: string;
  unit?: string;
  /** Default qty proposed in the freeWorks row on apply. */
  defaultQty?: number;
  productNumber?: string;
  engineId?: string | null;
  engineNumber?: string;
  engineBrandId?: string | null;
  engineBrandName?: string;
};

/**
 * Field keys of `WorkOrderPayload` that the operator is allowed to hide.
 *
 * Open string set — UI may add new keys without migrating data. The set of
 * fields that may NOT be hidden (because backend validation requires them
 * for a given kind) lives in {@link UNHIDABLE_FIELDS_BY_KIND}.
 */
export type WorkOrderTemplateHiddenFields = string[];

/**
 * Payload field overrides applied via Object.assign when the operator clicks
 * [Apply template]. Open record — narrow-typing belongs to the UI layer.
 */
export type WorkOrderTemplatePayloadOverrides = Record<string, unknown>;

export type WorkOrderTemplateDto = {
  id: string;
  workOrderKind: WorkOrderKind;
  name: string;
  payloadOverrides: WorkOrderTemplatePayloadOverrides;
  hiddenFields: WorkOrderTemplateHiddenFields;
  lines: WorkOrderTemplateLine[];
  /** ms epoch of last edit. */
  updatedAt: number | null;
  /** Username of last editor. */
  updatedBy: string | null;
};

/** Compact summary used in list views (sidebar / picker). */
export type WorkOrderTemplateSummary = {
  id: string;
  workOrderKind: WorkOrderKind;
  name: string;
  lineCount: number;
  updatedAt: number | null;
};

/**
 * Field keys that may NOT be hidden for a given WorkOrderKind because backend
 * closing logic requires them. Hiding such a field in the editor must be
 * rejected by the service layer (Stage 2).
 *
 * Conservative starting set — extend in later stages as we discover more
 * required fields. Per-kind tables intentionally omit the legacy
 * `WorkOrderKind.WorkshopTemplate`: that kind is being deprecated in PR 6 and
 * does not get its own templates.
 */
export const UNHIDABLE_FIELDS_BY_KIND: Record<WorkOrderKind, readonly string[]> = {
  [WorkOrderKind.Regular]: ['workOrderNumber', 'orderDate', 'crew'],
  [WorkOrderKind.Repair]: ['workOrderNumber', 'orderDate', 'crew', 'workshopId'],
  [WorkOrderKind.Assembly]: ['workOrderNumber', 'orderDate', 'crew', 'workshopId', 'engineId'],
  [WorkOrderKind.Manufacturing]: ['workOrderNumber', 'orderDate', 'crew', 'workshopId'],
  [WorkOrderKind.WorkshopTemplate]: [],
} as const;

/**
 * WorkOrderKind values that own templates. WorkshopTemplate is excluded — it is
 * being deprecated; its operations migrate to Repair in PR 6.
 */
export const WORK_ORDER_TEMPLATE_KINDS: readonly WorkOrderKind[] = [
  WorkOrderKind.Regular,
  WorkOrderKind.Repair,
  WorkOrderKind.Assembly,
  WorkOrderKind.Manufacturing,
];

export function isWorkOrderTemplateKind(value: unknown): value is WorkOrderKind {
  return (
    value === WorkOrderKind.Regular ||
    value === WorkOrderKind.Repair ||
    value === WorkOrderKind.Assembly ||
    value === WorkOrderKind.Manufacturing
  );
}

/** Template name validation — matches the SQL CHECK constraint length(1..100). */
export const WORK_ORDER_TEMPLATE_NAME_MAX = 100;

export function isValidWorkOrderTemplateName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= WORK_ORDER_TEMPLATE_NAME_MAX;
}

/**
 * True if `field` may be hidden for the given kind. Used by the service layer
 * and the editor UI to reject/disable hiding of required fields.
 */
export function isHidableField(kind: WorkOrderKind, field: string): boolean {
  const unhidable = UNHIDABLE_FIELDS_BY_KIND[kind];
  return !unhidable.includes(field);
}
