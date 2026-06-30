/**
 * Workshop repair templates — N:1 per workshop (v1.27.0).
 *
 * Each цех owns multiple named templates. Template name is unique within a
 * workshop. Operator picks one at [Применить шаблон] time on the Workshop-наряд
 * to autofill freeWorks.
 */
export type WorkshopRepairTemplateLine = {
  nomenclatureId: string;
  unit: string;
  /** Optional default qty for autofill on Workshop-наряд creation. */
  defaultQty?: number;
  /** Optional service id (вид работы) — copied into freeWorks[i].serviceId on autofill. */
  serviceId?: string;
};

export type WorkshopRepairTemplateDto = {
  id: string;
  workshopId: string;
  name: string;
  lines: WorkshopRepairTemplateLine[];
  /** ms epoch of last edit; null if never saved. */
  updatedAt: number | null;
  /** Username of last editor; null if never saved or recorded. */
  updatedBy: string | null;
};

/** Compact summary used in list views (sidebar / picker). */
export type WorkshopRepairTemplateSummary = {
  id: string;
  workshopId: string;
  name: string;
  lineCount: number;
  updatedAt: number | null;
};
