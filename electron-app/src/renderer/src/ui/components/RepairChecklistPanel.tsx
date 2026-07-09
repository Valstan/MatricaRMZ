import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { EngineActType, EngineActVersionRecord, EngineInventoryRow, EngineRepairPartState, FileRef, InventoryShortageSummary, PartStatusEventPayload, RepairFundInstancePayload, RepairFundRequirementVersionRecord, RepairChecklistAnswers, RepairChecklistPayload, RepairChecklistTemplate, SupplyRequestItem } from '@matricarmz/shared';
import { buildRepairFundIntakeFromInventory, buildStampedInstancesFromInventory, buildRepairOrderItemsFromInventory, buildSupplyRequestItemsFromInventory, collectDefectPhotosFromInventory, computeCustomerClaim, computeInventoryShortage, ENGINE_INVENTORY_STAGE, ENGINE_RECEIPT_CONDITION_FIELDS, engineInventoryRowSignature, findEmployeeByPositionGroups, normalizeEngineInventoryRows, partRepairStatusLabel, repairFundInstanceClassificationLabel, repairFundInstanceStatusLabel, selectRequirementInstances, rowHasDefect, summarizeReplenishment } from '@matricarmz/shared';

import { Button } from './Button.js';
import { useConfirm } from './ConfirmContext.js';
import { Input } from './Input.js';
import { AttachmentsPanel } from './AttachmentsPanel.js';
import { SearchSelect } from './SearchSelect.js';
import { formatMoscowDate, formatMoscowDateTime } from '../utils/dateUtils.js';
import {
  buildEngineRequirementHtml,
  buildInventoryActHtml,
  buildInventoryClaimHtml,
  buildInventoryDefectHtml,
  openEngineInventoryPrintWindow,
} from '../utils/engineInventoryPrintHtml.js';
import { invalidateListAllPartSpecsCache, listAllPartSpecs } from '../utils/partsPagination.js';
import {
  type ChecklistTableRow,
  BRAND_ROW_SOURCE_KEY,
  BRAND_ROW_PART_ID_KEY,
  ROW_PART_ID_KEY,
  clearBrandRowMeta,
  completenessRowSignature,
  defectRowSignature,
  getRowPartId,
  getRowPhotos,
  getRowSelected,
  isBrandLinkedChecklistRow,
  isInventoryRowVisibleForVariant,
  markBrandLinkedRow,
  mergeBrandManagedRows,
  preserveRowIdentityMeta,
  ROW_PHOTOS_KEY,
  ROW_SELECTED_KEY,
  rowPartIdFromOptionId,
  withRowPhotos,
} from '../utils/repairChecklistRows.js';

function safeJsonStringify(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

function escapeHtml(s: string) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function csvEscape(s: string) {
  const t = String(s ?? '');
  if (/[",\n\r]/.test(t)) return `"${t.replaceAll('"', '""')}"`;
  return t;
}

function normalizeDefectRows(rows: Record<string, string | boolean | number>[]) {
  let changed = false;
  const next = rows.map((row) => {
    const out = { ...row } as Record<string, string | boolean | number>;
    const hasNew = 'part_number' in out || 'repairable_qty' in out || 'scrap_qty' in out || 'quantity' in out;
    if (!hasNew) {
      if (!('part_number' in out) && typeof out.note === 'string' && out.note.trim()) {
        out.part_number = out.note;
        changed = true;
      }
      if (!('repairable_qty' in out) && out.reinstall === true) {
        out.repairable_qty = 1;
        changed = true;
      }
      if (!('scrap_qty' in out) && out.replace === true) {
        out.scrap_qty = 1;
        changed = true;
      }
    }
    const fallbackQty = Number(out.repairable_qty ?? 0) + Number(out.scrap_qty ?? 0);
    const quantityRaw = Number(out.quantity ?? (Number.isFinite(fallbackQty) ? fallbackQty : 0));
    const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.floor(quantityRaw) : 0;
    if (out.quantity !== quantity) {
      out.quantity = quantity;
      changed = true;
    }
    const scrapRaw = Number(out.scrap_qty ?? 0);
    const scrapClamped = Number.isFinite(scrapRaw) ? Math.max(0, Math.min(quantity, Math.floor(scrapRaw))) : 0;
    if (out.scrap_qty !== scrapClamped) {
      out.scrap_qty = scrapClamped;
      changed = true;
    }
    const repairable = Math.max(0, quantity - scrapClamped);
    if (out.repairable_qty !== repairable) {
      out.repairable_qty = repairable;
      changed = true;
    }
    if (out.part_number == null) {
      out.part_number = '';
      changed = true;
    }
    return out;
  });
  return { rows: next, changed };
}

function normalizeCompletenessRows(rows: Record<string, string | boolean | number>[]) {
  let changed = false;
  const next = rows.map((row) => {
    const out = { ...row } as Record<string, string | boolean | number>;
    const qtyFallback = Number(out.actual_qty ?? 0);
    const quantityRaw = Number(out.quantity ?? (Number.isFinite(qtyFallback) ? qtyFallback : 0));
    const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.floor(quantityRaw) : 0;
    if (out.quantity !== quantity) {
      out.quantity = quantity;
      changed = true;
    }
    const present = out.present === true;
    if (out.present !== present) {
      out.present = present;
      changed = true;
    }
    const actualRaw = Number(out.actual_qty ?? 0);
    let actual = Number.isFinite(actualRaw) ? Math.max(0, Math.floor(actualRaw)) : 0;
    if (present) actual = quantity;
    if (!present) actual = Math.min(actual, quantity);
    if (out.actual_qty !== actual) {
      out.actual_qty = actual;
      changed = true;
    }
    if (out.assembly_unit_number == null) {
      out.assembly_unit_number = '';
      changed = true;
    }
    return out;
  });
  return { rows: next, changed };
}

function normalizeDefectAnswers(
  template: RepairChecklistTemplate | null,
  answers: RepairChecklistAnswers,
): { next: RepairChecklistAnswers; changed: boolean } {
  if (!template) return { next: answers, changed: false };
  const tableItem = template.items.find((it) => it.kind === 'table' && it.id === 'defect_items');
  if (!tableItem) return { next: answers, changed: false };
  const current = (answers as any)[tableItem.id];
  if (!current || current.kind !== 'table') return { next: answers, changed: false };
  const rows = Array.isArray(current.rows) ? current.rows : [];
  if (rows.length === 0) return { next: answers, changed: false };
  const normalized = normalizeDefectRows(rows as any);
  if (!normalized.changed) return { next: answers, changed: false };
  return {
    next: { ...answers, [tableItem.id]: { kind: 'table', rows: normalized.rows } } as RepairChecklistAnswers,
    changed: true,
  };
}

function normalizeCompletenessAnswers(
  template: RepairChecklistTemplate | null,
  answers: RepairChecklistAnswers,
): { next: RepairChecklistAnswers; changed: boolean } {
  if (!template) return { next: answers, changed: false };
  const tableItem = template.items.find((it) => it.kind === 'table' && it.id === 'completeness_items');
  if (!tableItem) return { next: answers, changed: false };
  const current = (answers as any)[tableItem.id];
  if (!current || current.kind !== 'table') return { next: answers, changed: false };
  const rows = Array.isArray(current.rows) ? current.rows : [];
  if (rows.length === 0) return { next: answers, changed: false };
  const normalized = normalizeCompletenessRows(rows as any);
  if (!normalized.changed) return { next: answers, changed: false };
  return {
    next: { ...answers, [tableItem.id]: { kind: 'table', rows: normalized.rows } } as RepairChecklistAnswers,
    changed: true,
  };
}

function normalizeInventoryAnswers(
  template: RepairChecklistTemplate | null,
  answers: RepairChecklistAnswers,
): { next: RepairChecklistAnswers; changed: boolean } {
  if (!template) return { next: answers, changed: false };
  const tableItem = template.items.find((it) => it.kind === 'table' && it.id === 'engine_inventory_items');
  if (!tableItem) return { next: answers, changed: false };
  const current = (answers as any)[tableItem.id];
  if (!current || current.kind !== 'table') return { next: answers, changed: false };
  const rows = Array.isArray(current.rows) ? current.rows : [];
  if (rows.length === 0) return { next: answers, changed: false };
  const normalized = normalizeEngineInventoryRows(rows as Record<string, unknown>[]);
  if (!normalized.changed) return { next: answers, changed: false };
  const preservedRows = normalized.rows.map((nr, i) => {
    const prev = rows[i] as unknown as ChecklistTableRow | undefined;
    return { ...nr, ...preserveRowIdentityMeta(prev) } as unknown as Record<string, string | boolean | number>;
  });
  return {
    next: { ...answers, [tableItem.id]: { kind: 'table', rows: preservedRows } } as RepairChecklistAnswers,
    changed: true,
  };
}

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toInputDate(ms: number) {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function getBrandLinkForPart(part: unknown, engineBrandId: string | undefined) {
  const brandId = String(engineBrandId || '').trim();
  if (!brandId || !part || typeof part !== 'object') return null;
  const links = Array.isArray((part as any).brandLinks) ? (part as any).brandLinks : [];
  const link = links.find((x: any) => String(x?.engineBrandId || '').trim() === brandId);
  if (!link) return null;
  // Решение владельца (2026-06-12): артикул детали И ЕСТЬ «№ сборочной единицы».
  // Артикул приоритетен; legacy-привязки без артикула падают на старый assemblyUnitNumber.
  const article = String((part as any).article ?? '').trim();
  return {
    partNumber: String(link.assemblyUnitNumber ?? ''),
    assemblyUnitNumber: article || String(link.assemblyUnitNumber ?? ''),
    quantity: Number.isFinite(Number(link.quantity)) ? Number(link.quantity) : 0,
    inCompletenessAct: Boolean(link.inCompletenessAct),
    inDefectAct: Boolean(link.inDefectAct),
  };
}

function toQtyValue(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function inventoryRawRows(answers: RepairChecklistAnswers): Record<string, unknown>[] {
  const a: any = (answers as any).engine_inventory_items;
  if (!a || a.kind !== 'table') return [];
  return Array.isArray(a.rows) ? (a.rows as Record<string, unknown>[]) : [];
}

/** Число строк, отмеченных для печати акта (Ф1). */
function countSelectedInventoryRows(answers: RepairChecklistAnswers): number {
  return inventoryRawRows(answers).filter((r) => getRowSelected(r as ChecklistTableRow)).length;
}

/**
 * Строки для печати акта (Ф1 + Т4): сначала фильтр по галочке акта (Т4 — в акт попадают
 * только детали с соответствующим флагом; если флагов нет НИ У ОДНОЙ строки — legacy-двигатель,
 * фильтр не применяется), затем «только отмеченные; ничего не отмечено — печатаем все».
 * Акт претензии питается от набора комплектности (недостача = акт-детали без наличия).
 */
function extractInventoryRowsForPrint(answers: RepairChecklistAnswers, actType?: EngineActType): EngineInventoryRow[] {
  const raw = inventoryRawRows(answers);
  const flagKey = actType === 'defect' ? 'in_defect_act' : actType === 'completeness' || actType === 'claim' ? 'in_completeness_act' : null;
  const anyFlagged = flagKey != null && raw.some((r) => r[flagKey] !== undefined);
  const actRows = flagKey != null && anyFlagged ? raw.filter((r) => Boolean(r[flagKey])) : raw;
  const selected = actRows.filter((r) => getRowSelected(r as ChecklistTableRow));
  return normalizeEngineInventoryRows(selected.length > 0 ? selected : actRows).rows;
}

function emptyAnswersForTemplate(t: RepairChecklistTemplate): RepairChecklistAnswers {
  const ans: RepairChecklistAnswers = {};
  for (const it of t.items) {
    if (it.kind === 'text') ans[it.id] = { kind: 'text', value: '' };
    if (it.kind === 'date') ans[it.id] = { kind: 'date', value: null };
    if (it.kind === 'boolean') ans[it.id] = { kind: 'boolean', value: false };
    if (it.kind === 'table') ans[it.id] = { kind: 'table', rows: [] };
    if (it.kind === 'signature') ans[it.id] = { kind: 'signature', fio: '', position: '', signedAt: null };
  }
  return ans;
}

// Разделение под-вкладок: какие элементы шаблона (даты/подписи) относятся к какому акту.
// Элементы не из этих множеств (напр. `approved_by`, таблица, ссылочные поля) видны в обоих.
const COMPLETENESS_ONLY_ITEM_IDS = new Set([
  'arrival_date',
  'completeness_inspection_date',
  'acceptance_signed_by',
  'commission_workshop_head',
  'commission_workshop_master',
  'commission_otk_head',
  'customer_representative',
]);
const DEFECT_ONLY_ITEM_IDS = new Set(['defect_start_date', 'defect_end_date', 'defect_signed_by']);

export function RepairChecklistPanel(props: {
  engineId: string;
  stage: string;
  canEdit: boolean;
  canEditMasterData?: boolean;
  canPrint: boolean;
  canExport: boolean;
  engineNumber?: string;
  engineBrand?: string;
  engineBrandId?: string;
  contractNumber?: string;
  arrivalDate?: number | null;
  canViewFiles?: boolean;
  canUploadFiles?: boolean;
  defaultCollapsed?: boolean;
  currentUserProfile?: { fullName: string; position: string } | null;
  /** Имя цеха двигателя (workshop_id → directory_workshops.name) для автоподстановки комиссии акта комплектности. */
  workshopName?: string;
  /** engine_inventory: build a draft supply request from rows marked «заказать новую» (replace_qty>0).
   *  photos — фото-доказательства с тех же строк (MVP-2), прикрепляются к заявке. */
  onCreateSupplyRequestFromDefects?: (items: SupplyRequestItem[], photos: FileRef[]) => void | Promise<void>;
  /** Ф5: право создавать Repair-наряд из строк «свой ремонт» (work_orders.create). */
  canCreateWorkOrder?: boolean;
  /** Ф5: открыть карточку созданного наряда (оператор заполняет цех/услуги там). */
  onOpenWorkOrder?: (workOrderId: string) => void;
}) {
  const [status, setStatus] = useState<string>('');
  const [supplyRequestBusy, setSupplyRequestBusy] = useState(false);
  const [repairOrderBusy, setRepairOrderBusy] = useState(false);
  const [repairFundBusy, setRepairFundBusy] = useState(false);
  // Ф5 (GAP-4): производные статусы «в ремонте/готова к сборке» per partId.
  const [repairPartStates, setRepairPartStates] = useState<Record<string, EngineRepairPartState>>({});
  // Ф5 (GAP-6): история статусов деталей (события part_status_event, новые сверху).
  const [partStatusEvents, setPartStatusEvents] = useState<Array<PartStatusEventPayload & { operationId: string; at: number; by: string }>>([]);
  const [partStatusHistoryOpen, setPartStatusHistoryOpen] = useState(false);
  // Ремфонд Ф3: номерные экземпляры деталей двигателя (личные набитые номера).
  const [stampedBusy, setStampedBusy] = useState(false);
  const [instanceBusyId, setInstanceBusyId] = useState<string | null>(null);
  const [stampedInstances, setStampedInstances] = useState<Array<RepairFundInstancePayload & { operationId: string; at?: number }>>([]);
  const [stampedOpen, setStampedOpen] = useState(false);
  // Ремфонд Ф4: версии печатного «требования к заказчику» + флаги.
  const [requirementVersions, setRequirementVersions] = useState<RepairFundRequirementVersionRecord[]>([]);
  const [requirementVersionsOpen, setRequirementVersionsOpen] = useState(false);
  const [templates, setTemplates] = useState<RepairChecklistTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>('default');
  const [operationId, setOperationId] = useState<string | null>(null);
  const [payload, setPayload] = useState<RepairChecklistPayload | null>(null);
  const [answers, setAnswers] = useState<RepairChecklistAnswers>({});
  const [collapsed, setCollapsed] = useState<boolean>(props.defaultCollapsed === true);
  const [loadVersion, setLoadVersion] = useState(0);
  const brandRowsSyncKeyRef = useRef<string>('');
  const lastSavedAnswersRef = useRef<string>('');
  const saveInFlightRef = useRef(false);
  const queuedSaveAnswersRef = useRef<RepairChecklistAnswers | null>(null);
  const [employeeOptions, setEmployeeOptions] = useState<Array<{ id: string; label: string; position?: string | null }>>([]);
  // Полные записи работников для автоподстановки комиссии (нужны departmentName/employmentStatus).
  const [employeeRows, setEmployeeRows] = useState<any[]>([]);
  const [defectOptions, setDefectOptions] = useState<Array<{ id: string; label: string; hintText?: string; searchText?: string }>>([]);
  // Meta keyed by option id (`part:<uuid>`), not label — labels collide for
  // same-name parts that differ only by артикул (program Т1).
  const [defectPartMetaById, setDefectPartMetaById] = useState<Record<string, { partNumber: string; quantity: number }>>({});
  const [defectOptionsStatus, setDefectOptionsStatus] = useState<string>('');
  const [completenessOptions, setCompletenessOptions] = useState<Array<{ id: string; label: string; hintText?: string; searchText?: string }>>([]);
  const [completenessPartMetaById, setCompletenessPartMetaById] = useState<
    Record<string, { assemblyUnitNumber: string; quantity: number }>
  >({});
  const [completenessOptionsStatus, setCompletenessOptionsStatus] = useState<string>('');
  const [inventoryOptions, setInventoryOptions] = useState<Array<{ id: string; label: string; hintText?: string; searchText?: string }>>([]);
  const [inventoryPartMetaById, setInventoryPartMetaById] = useState<
    Record<string, { partNumber: string; assemblyUnitNumber: string; quantity: number }>
  >({});
  const [inventoryOptionsStatus, setInventoryOptionsStatus] = useState<string>('');
  const [defectCreateKind, setDefectCreateKind] = useState<'part' | 'node'>('part');
  // checklist-unify Этап 5: фильтр строк списка деталей по варианту сборки активного Assembly-наряда.
  const [assemblyVariant, setAssemblyVariant] = useState<string | null>(null);
  const [variantMembership, setVariantMembership] = useState<Map<string, Set<string>> | null>(null);
  const [variantFilterOn, setVariantFilterOn] = useState(true);

  const activeTemplate = useMemo(() => templates.find((t) => t.id === templateId) ?? templates[0] ?? null, [templates, templateId]);
  const isInventoryStage = props.stage === ENGINE_INVENTORY_STAGE;
  // Detail rows marked «заказать новую» (replace_qty>0) → draft supply-request items.
  // Read raw rows (not normalized) so the helper can pick up the optional __part_id/__part_unit hints.
  const defectSupplyItems = useMemo<SupplyRequestItem[]>(() => {
    const a = (answers as Record<string, unknown>).engine_inventory_items as { kind?: string; rows?: unknown } | undefined;
    const raw = a && a.kind === 'table' && Array.isArray(a.rows) ? (a.rows as Record<string, unknown>[]) : [];
    return buildSupplyRequestItemsFromInventory(raw);
  }, [answers]);
  // Ф1 актов: сколько строк отмечено для печати (0 → печатаем все).
  const selectedInventoryCount = useMemo(
    () => (isInventoryStage ? countSelectedInventoryRows(answers) : 0),
    [answers, isInventoryStage],
  );
  // Фото-доказательства со строк «заказать новую» → прикрепляются к черновику заявки (MVP-2).
  const defectSupplyPhotos = useMemo<FileRef[]>(() => {
    const a = (answers as Record<string, unknown>).engine_inventory_items as { kind?: string; rows?: unknown } | undefined;
    const raw = a && a.kind === 'table' && Array.isArray(a.rows) ? (a.rows as Record<string, unknown>[]) : [];
    return collectDefectPhotosFromInventory(raw);
  }, [answers]);
  // Ф5: строки «свой ремонт» с дефектом → черновик ремонтного наряда.
  const repairOrderDraft = useMemo(() => {
    const a = (answers as Record<string, unknown>).engine_inventory_items as { kind?: string; rows?: unknown } | undefined;
    const raw = a && a.kind === 'table' && Array.isArray(a.rows) ? (a.rows as Record<string, unknown>[]) : [];
    return buildRepairOrderItemsFromInventory(raw);
  }, [answers]);
  // Ремфонд Ф1: годные к ремонту детали (present && repairable_qty>0) для заноса в ремонтный фонд.
  const repairFundDraft = useMemo(() => {
    const a = (answers as Record<string, unknown>).engine_inventory_items as { kind?: string; rows?: unknown } | undefined;
    const raw = a && a.kind === 'table' && Array.isArray(a.rows) ? (a.rows as Record<string, unknown>[]) : [];
    return buildRepairFundIntakeFromInventory(raw);
  }, [answers]);
  // Ремфонд Ф3: строки с личным набитым номером (stamped_number) для поэкземплярного захвата.
  const stampedDraft = useMemo(() => buildStampedInstancesFromInventory(inventoryRawRows(answers)), [answers]);
  // Ф3 forecast-remfond-aware: бейдж «дефектовка не занесена в ремфонд» — read-only превью дельты
  // (сравнение текущих годных-к-ремонту с high-water-mark прошлого заноса), дебаунс 600мс.
  const [intakePending, setIntakePending] = useState<{ qty: number; positions: number } | null>(null);
  useEffect(() => {
    if (!isInventoryStage || !props.engineId || repairFundDraft.items.length === 0) {
      setIntakePending(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const r = await window.matrica.warehouse.repairFundIntakePreview({
          engineId: props.engineId,
          items: repairFundDraft.items,
        });
        if (cancelled) return;
        setIntakePending(r.ok && Number(r.pendingQty) > 0 ? { qty: Number(r.pendingQty), positions: Number(r.pendingPositions) } : null);
      } catch {
        if (!cancelled) setIntakePending(null);
      }
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isInventoryStage, props.engineId, repairFundDraft, repairFundBusy]);
  const variantFilterActive =
    isInventoryStage && variantFilterOn && !!assemblyVariant && !!variantMembership && variantMembership.size > 0;
  const panelTitle = isInventoryStage
    ? 'Список деталей двигателя'
    : props.stage === 'defect'
      ? 'Лист дефектовки'
      : 'Акт комплектности двигателя';

  // Ф2: недостача по комплектности — по ВСЕМ строкам списка (не только отмеченным в печать).
  const inventoryShortage = useMemo<InventoryShortageSummary | null>(
    () => (isInventoryStage ? computeInventoryShortage(normalizeEngineInventoryRows(inventoryRawRows(answers)).rows) : null),
    [answers, isInventoryStage],
  );
  // Ф3: сводка веток восполнения (заказчик / свой ремонт / закупка / не задано).
  const replenishmentSummary = useMemo(
    () => (isInventoryStage ? summarizeReplenishment(inventoryRawRows(answers)) : null),
    [answers, isInventoryStage],
  );
  // Ф4: претензия заказчику — дефектные строки на ветке «заказчик» (по ВСЕМ строкам списка).
  const customerClaim = useMemo(
    () => (isInventoryStage ? computeCustomerClaim(normalizeEngineInventoryRows(inventoryRawRows(answers)).rows) : null),
    [answers, isInventoryStage],
  );
  // Ф2: история версий акта (комплектности/дефектовки/претензии), новые сверху.
  const [actVersions, setActVersions] = useState<Record<EngineActType, EngineActVersionRecord[]>>({
    completeness: [],
    defect: [],
    claim: [],
  });
  const [actVersionsOpen, setActVersionsOpen] = useState(false);
  // Разделение единого списка на под-вкладки: «Акт комплектности» / «Акт дефектовки»
  // (решение владельца 2026-07-09). Данные общие (одно сохранение), меняется набор
  // колонок таблицы, показанных подписей/дат и кнопок печати.
  const [actView, setActView] = useState<'completeness' | 'defect'>('completeness');
  async function loadActVersions() {
    if (!isInventoryStage || !props.engineId) return;
    const [c, d, p] = await Promise.all([
      window.matrica.checklists.engineActVersions({ engineId: props.engineId, actType: 'completeness' }),
      window.matrica.checklists.engineActVersions({ engineId: props.engineId, actType: 'defect' }),
      window.matrica.checklists.engineActVersions({ engineId: props.engineId, actType: 'claim' }),
    ]);
    setActVersions({ completeness: c.ok ? c.versions : [], defect: d.ok ? d.versions : [], claim: p.ok ? p.versions : [] });
  }
  useEffect(() => {
    void loadActVersions();
  }, [isInventoryStage, props.engineId]);

  // Ф5: производные статусы ремонта per-деталь + история событий part_status_event + Ф3-экземпляры + Ф4-версии требования.
  async function loadRepairPartData() {
    if (!isInventoryStage || !props.engineId) return;
    const [states, events, stamped, requirement] = await Promise.all([
      window.matrica.workOrders.engineRepairPartStates(props.engineId),
      window.matrica.checklists.enginePartStatusEvents({ engineId: props.engineId }),
      window.matrica.checklists.engineStampedInstances({ engineId: props.engineId }),
      window.matrica.checklists.requirementVersions({ engineId: props.engineId }),
    ]);
    setRepairPartStates(states.ok ? states.states : {});
    setPartStatusEvents(events.ok ? events.events : []);
    setStampedInstances(stamped.ok ? stamped.instances : []);
    setRequirementVersions(requirement.ok ? requirement.versions : []);
  }
  useEffect(() => {
    void loadRepairPartData();
  }, [isInventoryStage, props.engineId]);

  async function createRepairOrderFromDefects() {
    if (repairOrderBusy || repairOrderDraft.items.length === 0) return;
    setRepairOrderBusy(true);
    try {
      const r = await window.matrica.workOrders.createRepairFromDefects({
        engineId: props.engineId,
        ...(props.engineNumber ? { engineNumber: String(props.engineNumber) } : {}),
        ...(props.engineBrandId ? { engineBrandId: String(props.engineBrandId) } : {}),
        ...(props.engineBrand ? { engineBrandName: String(props.engineBrand) } : {}),
        items: repairOrderDraft.items,
      });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setStatus(`Ремонтный наряд №${r.workOrderNumber} создан (${repairOrderDraft.items.length} поз.)`);
      void loadRepairPartData();
      props.onOpenWorkOrder?.(r.id);
    } finally {
      setRepairOrderBusy(false);
    }
  }

  async function intakeRepairFundFromDefects() {
    if (repairFundBusy || repairFundDraft.items.length === 0) return;
    setRepairFundBusy(true);
    try {
      const r = await window.matrica.warehouse.repairFundIntake({
        engineId: props.engineId,
        items: repairFundDraft.items,
      });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setStatus(
        r.unchanged
          ? 'Ремфонд уже актуален по этой дефектовке — новых деталей нет.'
          : `В ремфонд занесено ${r.addedQty} шт (${r.posted} поз.).${r.skippedNoNom ? ` Пропущено без номенклатуры: ${r.skippedNoNom}.` : ''}`,
      );
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setRepairFundBusy(false);
    }
  }

  // Ремфонд Ф3: захват номерных экземпляров деталей (личные набитые номера) с дефектовки.
  async function captureStampedInstances() {
    if (stampedBusy || stampedDraft.items.length === 0) return;
    setStampedBusy(true);
    try {
      const r = await window.matrica.warehouse.repairFundCaptureInstances({
        engineId: props.engineId,
        instances: stampedDraft.items.map((i) => ({
          partId: i.partId,
          partLabel: i.partLabel,
          stampedNumber: i.stampedNumber,
          classification: i.classification,
        })),
      });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setStampedInstances(r.instances);
      setStampedOpen(true);
      const changed = r.added + r.updated;
      setStatus(
        changed === 0
          ? `Личные номера уже зафиксированы (${r.total} экз.).`
          : `Зафиксировано экземпляров: ${changed} (новых ${r.added}, обновлено ${r.updated}).${r.skippedNoNom ? ` Пропущено без номенклатуры: ${r.skippedNoNom}.` : ''}`,
      );
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setStampedBusy(false);
    }
  }

  // Ремфонд Ф3.1: ручная отметка экземпляра «отремонтирована» (in_fund↔repaired) — точно,
  // мастер указывает конкретную физическую деталь по личному номеру (без эвристики по qty).
  async function setInstanceRepaired(operationId: string, repaired: boolean) {
    if (instanceBusyId) return;
    setInstanceBusyId(operationId);
    try {
      const r = await window.matrica.warehouse.repairFundSetInstanceRepaired({ operationId, repaired });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setStampedInstances(r.instances);
      setStatus(repaired ? 'Экземпляр отмечен как отремонтированный.' : 'Экземпляр возвращён в ремфонд.');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setInstanceBusyId(null);
    }
  }

  // Ремфонд Ф4: экземпляры утиль/замена — попадают в требование к заказчику.
  const requirementInstances = useMemo(() => selectRequirementInstances(stampedInstances), [stampedInstances]);

  function requirementHeader() {
    return {
      engineBrand: String(props.engineBrand ?? ''),
      engineNumber: String(props.engineNumber ?? ''),
      contractNumber: String(props.contractNumber ?? ''),
    };
  }

  // Ремфонд Ф4: печать требования к заказчику (печать = новая версия снимка, дедуп идентичных).
  async function printRequirement() {
    if (requirementInstances.length === 0) return;
    const header = requirementHeader();
    if (props.canEdit) {
      const snap = await window.matrica.checklists.requirementSnapshot({
        engineId: props.engineId,
        instances: requirementInstances,
        header,
      });
      if (snap.ok) void loadRepairPartData();
    }
    openEngineInventoryPrintWindow(buildEngineRequirementHtml({ ...header, instances: requirementInstances }));
  }

  function printRequirementVersion(v: RepairFundRequirementVersionRecord) {
    openEngineInventoryPrintWindow(buildEngineRequirementHtml({ ...v.header, instances: v.instances, printedAt: v.printedAt }));
  }

  function actHtml(
    actType: EngineActType,
    rows: EngineInventoryRow[],
    ans: RepairChecklistAnswers,
    opts?: { blank?: boolean; version?: number },
  ) {
    const ctx = {
      engineBrand: String(props.engineBrand ?? ''),
      engineNumber: String(props.engineNumber ?? ''),
      contractNumber: String(props.contractNumber ?? ''),
      rows,
      answers: ans,
      ...(props.workshopName ? { workshopName: props.workshopName } : {}),
      ...(opts?.version ? { actVersion: opts.version } : {}),
      ...(opts?.blank ? { blank: true } : {}),
    };
    if (actType === 'claim') return buildInventoryClaimHtml(ctx);
    return actType === 'completeness' ? buildInventoryActHtml(ctx) : buildInventoryDefectHtml(ctx);
  }

  // Печать акта: сначала фиксируем версию (печать = новая версия, дедуп идентичных), затем печатаем.
  async function printAct(actType: EngineActType) {
    const rows = extractInventoryRowsForPrint(answers, actType);
    let version: number | undefined;
    if (props.canEdit) {
      const snap = await window.matrica.checklists.engineActSnapshot({
        engineId: props.engineId,
        actType,
        rows,
        header: {
          engineBrand: String(props.engineBrand ?? ''),
          engineNumber: String(props.engineNumber ?? ''),
          contractNumber: String(props.contractNumber ?? ''),
        },
        answers,
        selectedCount: selectedInventoryCount,
      });
      if (snap.ok) {
        version = snap.version;
        void loadActVersions();
      }
    }
    openEngineInventoryPrintWindow(actHtml(actType, rows, answers, version ? { version } : undefined));
  }

  // Пустой бланк для заполнения комиссией на месте: значения-клетки пустые + запасные строки.
  // Версию НЕ создаёт (это не готовый документ, а форма для ручного заполнения).
  function printBlankAct(actType: EngineActType) {
    const rows = extractInventoryRowsForPrint(answers, actType);
    openEngineInventoryPrintWindow(actHtml(actType, rows, answers, { blank: true }));
  }

  // Повторная печать исторической версии — рендерим её замороженный снимок (rows+answers).
  function printActVersion(v: EngineActVersionRecord) {
    openEngineInventoryPrintWindow(actHtml(v.actType, v.rows, v.answers, { version: v.version }));
  }
  const attachmentsTitle = isInventoryStage
    ? 'Вложения к списку деталей двигателя'
    : props.stage === 'defect'
      ? 'Вложения к листу дефектовки'
      : 'Вложения к акту комплектности';
  const lockedFieldIds = useMemo(() => {
    const locked = new Set<string>();
    const brand = String(props.engineBrand ?? '').trim();
    const number = String(props.engineNumber ?? '').trim();
    const contractNumber = String(props.contractNumber ?? '').trim();
    const hasArrivalDate = typeof props.arrivalDate === 'number' && Number.isFinite(props.arrivalDate);

    if (props.stage === 'defect' || props.stage === 'completeness' || props.stage === ENGINE_INVENTORY_STAGE) {
      if (brand) locked.add('engine_brand');
      if (number) locked.add('engine_number');
    }
    if ((props.stage === 'completeness' || props.stage === ENGINE_INVENTORY_STAGE) && contractNumber) {
      locked.add('contract_number');
    }
    if (props.stage === ENGINE_INVENTORY_STAGE && hasArrivalDate) {
      locked.add('arrival_date');
    }

    return locked;
  }, [props.arrivalDate, props.contractNumber, props.engineBrand, props.engineNumber, props.stage]);

  async function load() {
    setStatus('Загрузка чек-листа...');
    const r = await window.matrica.checklists.engineGet({ engineId: props.engineId, stage: props.stage });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    setTemplates(r.templates ?? []);
    const preferred = r.payload?.templateId ?? (r.templates?.[0]?.id ?? 'default');
    setTemplateId(preferred);
    setOperationId(r.operationId ?? null);
    setPayload(r.payload ?? null);

    const t = (r.templates ?? []).find((x) => x.id === preferred) ?? (r.templates?.[0] ?? null);
    let nextAnswers: RepairChecklistAnswers = {};
    if (r.payload?.answers) {
      const base = r.payload.answers;
      const normalized =
        props.stage === 'defect'
          ? normalizeDefectAnswers(t ?? null, base)
          : props.stage === 'completeness'
            ? normalizeCompletenessAnswers(t ?? null, base)
            : props.stage === ENGINE_INVENTORY_STAGE
              ? normalizeInventoryAnswers(t ?? null, base)
              : { next: base, changed: false };
      nextAnswers = normalized.next;
    } else if (t) {
      nextAnswers = emptyAnswersForTemplate(t);
    }
    setAnswers(nextAnswers);
    lastSavedAnswersRef.current = safeJsonStringify({ templateId: preferred, answers: nextAnswers });
    brandRowsSyncKeyRef.current = '';
    setLoadVersion((v) => v + 1);
    setStatus('');
  }

  useEffect(() => {
    void load();
  }, [props.engineId, props.stage]);

  useEffect(() => {
    let alive = true;
    void window.matrica.employees
      .list()
      .then((rows) => {
        if (!alive) return;
        const opts = (rows as any[]).map((r) => ({
          id: String(r.id),
          label: String(r.displayName ?? r.fullName ?? r.id),
          position: r.position ?? null,
        }));
        opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setEmployeeOptions(opts);
        setEmployeeRows(rows as any[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // При смене шаблона: если нет payload — инициализируем ответы под шаблон.
    if (!activeTemplate) return;
    if (payload?.templateId) return;
    setAnswers((prev) => (Object.keys(prev).length ? prev : emptyAnswersForTemplate(activeTemplate)));
  }, [activeTemplate?.id]);

  // Автоподстановка повторяющихся данных из карточки двигателя.
  useEffect(() => {
    if (!activeTemplate) return;
    const hasItem = (id: string) => activeTemplate.items.some((it) => it.id === id);
    const brand = String(props.engineBrand ?? '').trim();
    const num = String(props.engineNumber ?? '').trim();
    const contractNumber = String(props.contractNumber ?? '').trim();
    const arrivalDate = typeof props.arrivalDate === 'number' && Number.isFinite(props.arrivalDate) ? props.arrivalDate : null;
    const next = { ...answers } as RepairChecklistAnswers;
    let changed = false;
    const isDefect = props.stage === 'defect';
    const isCompleteness = props.stage === 'completeness';
    const isInventory = props.stage === ENGINE_INVENTORY_STAGE;
    const isLockedByEngine = isDefect || isCompleteness || isInventory;

    if (hasItem('engine_brand') && brand) {
      const a: any = (answers as any).engine_brand;
      const current = a?.kind === 'text' ? String(a.value ?? '') : '';
      if ((isLockedByEngine && current !== brand) || (!isLockedByEngine && !current.trim())) {
        (next as any).engine_brand = { kind: 'text', value: brand };
        changed = true;
      }
    }
    if (hasItem('engine_number') && num) {
      const a: any = (answers as any).engine_number;
      const current = a?.kind === 'text' ? String(a.value ?? '') : '';
      if ((isLockedByEngine && current !== num) || (!isLockedByEngine && !current.trim())) {
        (next as any).engine_number = { kind: 'text', value: num };
        changed = true;
      }
    }
    if ((isCompleteness || isInventory) && hasItem('contract_number') && contractNumber) {
      const a: any = (answers as any).contract_number;
      const current = a?.kind === 'text' ? String(a.value ?? '') : '';
      if (current !== contractNumber) {
        (next as any).contract_number = { kind: 'text', value: contractNumber };
        changed = true;
      }
    }
    if (isInventory && hasItem('arrival_date') && arrivalDate) {
      const a: any = (answers as any).arrival_date;
      const current = a?.kind === 'date' && Number.isFinite(a.value) ? Number(a.value) : null;
      if (current !== arrivalDate) {
        (next as any).arrival_date = { kind: 'date', value: arrivalDate };
        changed = true;
      }
    }

    if (!changed) return;
    setAnswers(next);
    if (props.canEdit) void save(next);
  }, [activeTemplate?.id, answers, props.arrivalDate, props.canEdit, props.contractNumber, props.engineBrand, props.engineNumber, props.stage]);

  useEffect(() => {
    if (!activeTemplate) return;
    const fullName = String(props.currentUserProfile?.fullName ?? '').trim();
    const position = String(props.currentUserProfile?.position ?? '').trim();
    if (!fullName && !position) return;
    const next = { ...answers } as RepairChecklistAnswers;
    let changed = false;
    for (const item of activeTemplate.items) {
      if (item.kind !== 'signature') continue;
      // Комиссию заполняет автоподстановка по цеху, не текущий пользователь.
      if (item.id.startsWith('commission_')) continue;
      const current = (answers as any)[item.id];
      const currentFio = current?.kind === 'signature' ? String(current.fio ?? '').trim() : '';
      const currentPosition = current?.kind === 'signature' ? String(current.position ?? '').trim() : '';
      if (currentFio || currentPosition) continue;
      const signedAt = current?.kind === 'signature' ? (current.signedAt ?? null) : null;
      (next as any)[item.id] = { kind: 'signature', fio: fullName, position, signedAt };
      changed = true;
    }
    if (!changed) return;
    setAnswers(next);
    if (props.canEdit) void save(next);
  }, [activeTemplate?.id, answers, props.canEdit, props.currentUserProfile?.fullName, props.currentUserProfile?.position]);

  // Хвост Т6: автоподстановка комиссии акта комплектности по цеху двигателя.
  // Нач. цеха / мастер ищутся среди работников подразделения, чьё имя совпадает с цехом
  // двигателя (department-сущности и directory_workshops — разные справочники, связь по имени);
  // нач. ОТК — по всей базе. Заполняются только пустые поля — ручной выбор не перетирается.
  useEffect(() => {
    if (!activeTemplate || !props.canEdit) return;
    if (employeeRows.length === 0) return;
    const commissionIds = ['commission_workshop_head', 'commission_workshop_master', 'commission_otk_head'];
    if (!activeTemplate.items.some((it) => commissionIds.includes(it.id))) return;
    const normalizeName = (v: unknown) =>
      String(v ?? '')
        .trim()
        .toLowerCase()
        .replaceAll('ё', 'е')
        .replaceAll('№', '')
        .replace(/\s+/g, ' ');
    const ws = normalizeName(props.workshopName);
    // Строгое равенство имён: подстрочный матч ловит «Цех №1» в «Цех №12».
    const inWorkshop = ws ? employeeRows.filter((r) => normalizeName(r.departmentName) === ws) : [];
    const picks: Array<[string, ReturnType<typeof findEmployeeByPositionGroups>]> = [
      ['commission_workshop_head', findEmployeeByPositionGroups(inWorkshop, [['начальник'], ['цех']])],
      ['commission_workshop_master', findEmployeeByPositionGroups(inWorkshop, [['мастер']])],
      ['commission_otk_head', findEmployeeByPositionGroups(employeeRows, [['начальник'], ['отк']])],
    ];
    const next = { ...answers } as RepairChecklistAnswers;
    let changed = false;
    for (const [id, emp] of picks) {
      if (!emp) continue;
      const current = (answers as any)[id];
      const currentFio = current?.kind === 'signature' ? String(current.fio ?? '').trim() : '';
      const currentPosition = current?.kind === 'signature' ? String(current.position ?? '').trim() : '';
      if (currentFio || currentPosition) continue;
      const fio = String(emp.displayName ?? emp.fullName ?? '').trim();
      if (!fio) continue;
      const signedAt = current?.kind === 'signature' ? (current.signedAt ?? null) : null;
      (next as any)[id] = { kind: 'signature', fio, position: String(emp.position ?? ''), signedAt };
      changed = true;
    }
    if (!changed) return;
    setAnswers(next);
    void save(next);
  }, [activeTemplate?.id, answers, employeeRows, props.canEdit, props.workshopName]);

  // Кнопка «Заполнить комиссию по цеху» (под-вкладка комплектности): принудительно ставит
  // комиссию (нач. цеха/мастер — из цеха двигателя, нач. ОТК — по всей базе), перетирая текущие
  // ФИО. Автоподстановка выше трогает только пустые поля — кнопка обновляет всё по требованию.
  function fillCommissionByWorkshop() {
    if (!activeTemplate || !props.canEdit || employeeRows.length === 0) return;
    const normalizeName = (v: unknown) =>
      String(v ?? '')
        .trim()
        .toLowerCase()
        .replaceAll('ё', 'е')
        .replaceAll('№', '')
        .replace(/\s+/g, ' ');
    const ws = normalizeName(props.workshopName);
    const inWorkshop = ws ? employeeRows.filter((r) => normalizeName(r.departmentName) === ws) : [];
    const picks: Array<[string, string, ReturnType<typeof findEmployeeByPositionGroups>]> = [
      ['commission_workshop_head', 'начальник цеха', findEmployeeByPositionGroups(inWorkshop, [['начальник'], ['цех']])],
      ['commission_workshop_master', 'мастер', findEmployeeByPositionGroups(inWorkshop, [['мастер']])],
      ['commission_otk_head', 'начальник ОТК', findEmployeeByPositionGroups(employeeRows, [['начальник'], ['отк']])],
    ];
    const next = { ...answers } as RepairChecklistAnswers;
    let changed = false;
    const missing: string[] = [];
    for (const [id, roleLabel, emp] of picks) {
      const fio = emp ? String(emp.displayName ?? emp.fullName ?? '').trim() : '';
      if (!fio) {
        missing.push(roleLabel);
        continue;
      }
      const current = (answers as any)[id];
      const signedAt = current?.kind === 'signature' ? (current.signedAt ?? null) : null;
      (next as any)[id] = { kind: 'signature', fio, position: String(emp?.position ?? ''), signedAt };
      changed = true;
    }
    if (changed) {
      setAnswers(next);
      void save(next);
    }
    setStatus(
      missing.length === 0
        ? 'Комиссия заполнена по цеху двигателя.'
        : `Комиссия заполнена частично — не найдены: ${missing.join(', ')}. Проверьте, что для цеха «${props.workshopName ?? ''}» заведены сотрудники с нужными должностями.`,
    );
  }

  useEffect(() => {
    if (props.stage !== 'defect') return;
    let alive = true;
    void (async () => {
      try {
        setDefectOptionsStatus('Загрузка справочников...');
        const options: Array<{ id: string; label: string; hintText?: string; searchText?: string }> = [];
        const metaById: Record<string, { partNumber: string; quantity: number }> = {};
        const partsRes = await listAllPartSpecs(props.engineBrandId ? { engineBrandId: props.engineBrandId } : {});
        if (partsRes && (partsRes as any).ok && Array.isArray((partsRes as any).parts)) {
          for (const p of (partsRes as any).parts) {
            const label = String(p.name ?? p.article ?? p.id);
            const article = String(p.article ?? '').trim();
            const optionId = `part:${p.id}`;
            options.push({
              id: optionId,
              label,
              ...(article ? { hintText: `Арт. ${article}`, searchText: `${label} ${article}` } : {}),
            });
            const link = getBrandLinkForPart(p, props.engineBrandId);
            const linkQty = Number(link?.quantity ?? NaN);
            const qtyNum = Number.isFinite(linkQty) ? linkQty : 0;
            metaById[optionId] = {
              partNumber: String(link?.partNumber ?? ''),
              quantity: toQtyValue(qtyNum),
            };
          }
        }
        const types = await window.matrica.admin.entityTypes.list();
        const nodeType = (types as any[]).find((t) => String(t.code) === 'engine_node');
        if (nodeType?.id) {
          const rows = await window.matrica.admin.entities.listByEntityType(String(nodeType.id));
          for (const r of rows as any[]) {
            const label = String(r.displayName ?? r.id);
            options.push({ id: `node:${r.id}`, label });
          }
        }
        if (!alive) return;
        options.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setDefectOptions(options);
        setDefectPartMetaById(metaById);
        setDefectOptionsStatus('');
      } catch (e) {
        if (!alive) return;
        setDefectOptionsStatus(`Ошибка загрузки: ${String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.stage, props.engineBrandId]);

  useEffect(() => {
    if (props.stage !== 'completeness') return;
    let alive = true;
    void (async () => {
      try {
        setCompletenessOptionsStatus('Загрузка справочников...');
        const options: Array<{ id: string; label: string; hintText?: string; searchText?: string }> = [];
        const metaById: Record<string, { assemblyUnitNumber: string; quantity: number }> = {};
        const partsRes = await listAllPartSpecs(props.engineBrandId ? { engineBrandId: props.engineBrandId } : {});
        if (partsRes && (partsRes as any).ok && Array.isArray((partsRes as any).parts)) {
          for (const p of (partsRes as any).parts) {
            const label = String(p.name ?? p.article ?? p.id);
            const article = String(p.article ?? '').trim();
            const optionId = `part:${p.id}`;
            options.push({
              id: optionId,
              label,
              ...(article ? { hintText: `Арт. ${article}`, searchText: `${label} ${article}` } : {}),
            });
            const link = getBrandLinkForPart(p, props.engineBrandId);
            const linkQty = Number(link?.quantity ?? NaN);
            const qtyNum = Number.isFinite(linkQty) ? linkQty : 0;
            metaById[optionId] = {
              assemblyUnitNumber: String(link?.assemblyUnitNumber ?? ''),
              quantity: toQtyValue(qtyNum),
            };
          }
        }
        if (!alive) return;
        options.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setCompletenessOptions(options);
        setCompletenessPartMetaById(metaById);
        setCompletenessOptionsStatus('');
      } catch (e) {
        if (!alive) return;
        setCompletenessOptionsStatus(`Ошибка загрузки: ${String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.stage, props.engineBrandId]);

  useEffect(() => {
    if (props.stage !== ENGINE_INVENTORY_STAGE) return;
    let alive = true;
    void (async () => {
      try {
        setInventoryOptionsStatus('Загрузка справочников...');
        const options: Array<{ id: string; label: string; hintText?: string; searchText?: string }> = [];
        const metaById: Record<string, { partNumber: string; assemblyUnitNumber: string; quantity: number }> = {};
        const partsRes = await listAllPartSpecs(props.engineBrandId ? { engineBrandId: props.engineBrandId } : {});
        if (partsRes && (partsRes as any).ok && Array.isArray((partsRes as any).parts)) {
          for (const p of (partsRes as any).parts) {
            const label = String(p.name ?? p.article ?? p.id);
            const article = String(p.article ?? '').trim();
            const optionId = `part:${p.id}`;
            options.push({
              id: optionId,
              label,
              ...(article ? { hintText: `Арт. ${article}`, searchText: `${label} ${article}` } : {}),
            });
            const link = getBrandLinkForPart(p, props.engineBrandId);
            const linkQty = Number(link?.quantity ?? NaN);
            const qtyNum = Number.isFinite(linkQty) ? linkQty : 0;
            metaById[optionId] = {
              partNumber: String(link?.partNumber ?? ''),
              assemblyUnitNumber: String(link?.assemblyUnitNumber ?? ''),
              quantity: toQtyValue(qtyNum),
            };
          }
        }
        if (!alive) return;
        options.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setInventoryOptions(options);
        setInventoryPartMetaById(metaById);
        setInventoryOptionsStatus('');
      } catch (e) {
        if (!alive) return;
        setInventoryOptionsStatus(`Ошибка загрузки: ${String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.stage, props.engineBrandId]);

  async function createInventoryItem(label: string) {
    const name = label.trim();
    if (!name) return null;
    if (!props.canEdit) return null;
    const created = await window.matrica.warehouse.nomenclatureDirectoryPartCreate({ name }).catch(() => null);
    if (!created || !(created as any).ok || !(created as any).part?.id) return null;
    invalidateListAllPartSpecsCache();
    const part = (created as any).part;
    const opt = { id: `part:${part.id}`, label: name };
    setInventoryOptions((prev) => [...prev, opt].sort((a, b) => a.label.localeCompare(b.label, 'ru')));
    return opt.id;
  }

  async function createDefectItem(label: string) {
    const name = label.trim();
    if (!name) return null;
    const wantsNode = defectCreateKind === 'node';
    if (wantsNode && !props.canEditMasterData) return null;

    if (wantsNode) {
      const types = await window.matrica.admin.entityTypes.list();
      const nodeType = (types as any[]).find((t) => String(t.code) === 'engine_node');
      if (!nodeType?.id) return null;
      const created = await window.matrica.admin.entities.create(String(nodeType.id));
      if (!created?.ok || !created.id) return null;
      await window.matrica.admin.entities.setAttr(created.id, 'name', name);
      const opt = { id: `node:${created.id}`, label: name };
      setDefectOptions((prev) => [...prev, opt].sort((a, b) => a.label.localeCompare(b.label, 'ru')));
      return opt.id;
    }

    const created = await window.matrica.warehouse.nomenclatureDirectoryPartCreate({ name }).catch(() => null);
    if (!created || !(created as any).ok || !(created as any).part?.id) return null;
    invalidateListAllPartSpecsCache();
    const part = (created as any).part;
    const opt = { id: `part:${part.id}`, label: name };
    setDefectOptions((prev) => [...prev, opt].sort((a, b) => a.label.localeCompare(b.label, 'ru')));
    return opt.id;
  }

  async function createCompletenessItem(label: string) {
    const name = label.trim();
    if (!name) return null;
    if (!props.canEdit) return null;
    const created = await window.matrica.warehouse.nomenclatureDirectoryPartCreate({ name }).catch(() => null);
    if (!created || !(created as any).ok || !(created as any).part?.id) return null;
    invalidateListAllPartSpecsCache();
    const part = (created as any).part;
    const opt = { id: `part:${part.id}`, label: name };
    setCompletenessOptions((prev) => [...prev, opt].sort((a, b) => a.label.localeCompare(b.label, 'ru')));
    return opt.id;
  }

  useEffect(() => {
    if (!activeTemplate) return;
    if (props.stage !== 'defect' && props.stage !== 'completeness' && props.stage !== ENGINE_INVENTORY_STAGE) return;
    const tableId =
      props.stage === 'defect'
        ? 'defect_items'
        : props.stage === 'completeness'
          ? 'completeness_items'
          : 'engine_inventory_items';
    const tableItem = activeTemplate.items.find((it) => it.kind === 'table' && it.id === tableId);
    if (!tableItem) return;
    const syncKey = `${loadVersion}:${props.engineId}:${props.stage}:${activeTemplate.id}:${props.engineBrandId ?? ''}:${tableId}`;
    if (brandRowsSyncKeyRef.current === syncKey) return;
    brandRowsSyncKeyRef.current = syncKey;

    void (async () => {
      const current = (answers as any)[tableItem.id];
      const currentRows: ChecklistTableRow[] =
        current?.kind === 'table' && Array.isArray(current.rows) ? ((current.rows as ChecklistTableRow[]) ?? []) : [];
      if (!props.engineBrandId) {
        const normalizedRows = currentRows.map(clearBrandRowMeta);
        const nextJson = safeJsonStringify(normalizedRows);
        const currJson = safeJsonStringify(currentRows);
        if (nextJson === currJson) return;
        const next = { ...answers, [tableItem.id]: { kind: 'table', rows: normalizedRows } } as RepairChecklistAnswers;
        setAnswers(next);
        if (props.canEdit) void save(next);
        return;
      }
      const parts = await listAllPartSpecs({ engineBrandId: props.engineBrandId });
      if (!parts.ok) {
        setStatus(`Ошибка: ${parts.error}`);
        return;
      }

      if (props.stage === ENGINE_INVENTORY_STAGE) {
        const freshBrandRows = (parts.parts as any[]).map((p: any) => {
          const link = getBrandLinkForPart(p, props.engineBrandId);
          const qty = toQtyValue(link?.quantity ?? 0);
          // Т4: галочки актов копируются из привязки деталь↔марка; default-наличие:
          // акт-детали приходят с ПУСТЫМ наличием (печатается чистый акт, работники
          // заполняют на бумаге), остальная мелочёвка — наличие проставлено сразу.
          const inCompleteness = Boolean((link as any)?.inCompletenessAct);
          const inDefect = Boolean((link as any)?.inDefectAct);
          const defaultPresent = !(inCompleteness || inDefect);
          return markBrandLinkedRow(
            {
              part_name: String(p.name ?? p.article ?? p.id),
              assembly_unit_number: String(link?.assemblyUnitNumber ?? ''),
              part_number: String(link?.partNumber ?? ''),
              bom_variant_group: '',
              quantity: qty,
              present: defaultPresent,
              actual_qty: defaultPresent ? qty : 0,
              repairable_qty: qty,
              scrap_qty: 0,
              replace_qty: 0,
              in_completeness_act: inCompleteness,
              in_defect_act: inDefect,
            },
            String((p as any).id ?? ''),
          );
        });
        const merged = mergeBrandManagedRows(
          currentRows,
          freshBrandRows,
          (row) => engineInventoryRowSignature({
            part_name: String((row as any).part_name ?? ''),
            assembly_unit_number: String((row as any).assembly_unit_number ?? ''),
            part_number: String((row as any).part_number ?? ''),
          }),
          (base, prev) => ({
            ...base,
            // prev == null — новая строка марки: оставляем default из base
            // (Т4: наличие у не-акт мелочёвки проставлено сразу).
            present: prev != null ? Boolean((prev as any).present) : Boolean((base as any).present),
            actual_qty: prev != null ? toQtyValue((prev as any).actual_qty ?? 0) : toQtyValue((base as any).actual_qty ?? 0),
            scrap_qty: toQtyValue((prev as any)?.scrap_qty ?? 0),
            replace_qty: toQtyValue((prev as any)?.replace_qty ?? 0),
            // Т6: «№ на детали» (набитый) — операторские данные строки, переживают brand-resync.
            ...(prev && String((prev as any).stamped_number ?? '').trim()
              ? { stamped_number: String((prev as any).stamped_number) }
              : {}),
            // Т4/Т5: эффективный флаг акта = операторский override (Т5, ставится только
            // в карточке двигателя) ?? актуальное значение шаблона марки. Сам флаг
            // НЕ замораживается копией: правка галочек в марке доезжает до двигателей
            // при resync, пока оператор явно не переопределил строку.
            ...((prev as any)?.in_completeness_act_override !== undefined
              ? { in_completeness_act: Boolean((prev as any).in_completeness_act_override) }
              : {}),
            ...((prev as any)?.in_defect_act_override !== undefined
              ? { in_defect_act: Boolean((prev as any).in_defect_act_override) }
              : {}),
            ...((prev as any)?.in_completeness_act_override !== undefined
              ? { in_completeness_act_override: Boolean((prev as any).in_completeness_act_override) }
              : {}),
            ...((prev as any)?.in_defect_act_override !== undefined
              ? { in_defect_act_override: Boolean((prev as any).in_defect_act_override) }
              : {}),
            // Ф3: ветка восполнения — пользовательский выбор детали, переживает brand-resync.
            replenishment_branch: (prev as any)?.replenishment_branch ?? null,
            // MVP-2: фото-доказательства — пользовательские данные строки, переживают brand-resync.
            ...(prev && String((prev as any)[ROW_PHOTOS_KEY] ?? '').trim()
              ? { [ROW_PHOTOS_KEY]: String((prev as any)[ROW_PHOTOS_KEY]) }
              : {}),
            // Ф1: отметка «в печать» — пользовательский выбор строки, переживает brand-resync.
            ...(prev && getRowSelected(prev as ChecklistTableRow) ? { [ROW_SELECTED_KEY]: true } : {}),
          }),
        );
        const normalized = normalizeEngineInventoryRows(merged as unknown as Record<string, unknown>[]);
        const preservedRows: ChecklistTableRow[] = normalized.rows.map((nr, i) => {
          const prev = merged[i] as ChecklistTableRow | undefined;
          return { ...nr, ...preserveRowIdentityMeta(prev) } as unknown as ChecklistTableRow;
        });
        const nextJson = safeJsonStringify(preservedRows);
        const currJson = safeJsonStringify(currentRows);
        if (nextJson === currJson) return;
        const next = { ...answers, [tableItem.id]: { kind: 'table', rows: preservedRows } } as RepairChecklistAnswers;
        setAnswers(next);
        if (props.canEdit) void save(next);
        return;
      }

      if (props.stage === 'defect') {
        const freshBrandRows = (parts.parts as any[]).map((p: any) => {
          const link = getBrandLinkForPart(p, props.engineBrandId);
          const qty = toQtyValue(link?.quantity ?? 0);
          return markBrandLinkedRow(
            {
              part_name: String(p.name ?? p.article ?? p.id),
              part_number: String(link?.partNumber ?? ''),
              quantity: qty,
              repairable_qty: qty,
              scrap_qty: 0,
            },
            String((p as any).id ?? ''),
          );
        });
        const merged = mergeBrandManagedRows(currentRows, freshBrandRows, defectRowSignature, (base, prev) => ({
          ...base,
          scrap_qty: toQtyValue((prev as any)?.scrap_qty ?? 0),
        }));
        const normalizedRows = normalizeDefectRows(merged as any).rows as ChecklistTableRow[];
        const nextJson = safeJsonStringify(normalizedRows);
        const currJson = safeJsonStringify(currentRows);
        if (nextJson === currJson) return;
        const next = { ...answers, [tableItem.id]: { kind: 'table', rows: normalizedRows } } as RepairChecklistAnswers;
        setAnswers(next);
        if (props.canEdit) void save(next);
        return;
      }

      const freshBrandRows = (parts.parts as any[]).map((p: any) => {
        const link = getBrandLinkForPart(p, props.engineBrandId);
        return markBrandLinkedRow(
          {
            part_name: String(p.name ?? p.article ?? p.id),
            assembly_unit_number: String(link?.assemblyUnitNumber ?? ''),
            quantity: toQtyValue(link?.quantity ?? 0),
            present: false,
            actual_qty: 0,
          },
          String((p as any).id ?? ''),
        );
      });
      const merged = mergeBrandManagedRows(currentRows, freshBrandRows, completenessRowSignature, (base, prev) => ({
        ...base,
        present: Boolean((prev as any)?.present),
        actual_qty: toQtyValue((prev as any)?.actual_qty ?? 0),
      }));
      const normalizedRows = normalizeCompletenessRows(merged as any).rows as ChecklistTableRow[];
      const nextJson = safeJsonStringify(normalizedRows);
      const currJson = safeJsonStringify(currentRows);
      if (nextJson === currJson) return;
      const next = { ...answers, [tableItem.id]: { kind: 'table', rows: normalizedRows } } as RepairChecklistAnswers;
      setAnswers(next);
      if (props.canEdit) void save(next);
    })();
  }, [activeTemplate?.id, answers, loadVersion, props.canEdit, props.engineBrandId, props.engineId, props.stage]);

  // Note: normalization happens on load/save to avoid focus loss on each keystroke.

  // Этап 5: активный вариант сборки двигателя (из его незакрытого Assembly-наряда).
  useEffect(() => {
    if (!isInventoryStage) return;
    let alive = true;
    void window.matrica.workOrders
      .activeAssemblyVariant(props.engineId)
      .then((r) => {
        if (!alive) return;
        setAssemblyVariant(r.ok ? r.variantGroup : null);
        setVariantFilterOn(true);
      })
      .catch(() => {
        if (alive) setAssemblyVariant(null);
      });
    return () => {
      alive = false;
    };
  }, [isInventoryStage, props.engineId]);

  // Этап 5: карта nomenclatureId → варианты BOM марки (для фильтра). Грузим лениво — только когда
  // есть активный вариант (иначе фильтровать нечего). Паттерн загрузки — как в WorkOrderDetailsPage.
  useEffect(() => {
    if (!isInventoryStage || !assemblyVariant || !props.engineBrandId) {
      setVariantMembership(null);
      return;
    }
    const brandId = props.engineBrandId;
    let alive = true;
    void (async () => {
      try {
        const listRes = await window.matrica.warehouse.assemblyBomList({ engineBrandId: brandId, status: 'active' });
        if (!alive || !listRes?.ok) {
          if (alive) setVariantMembership(null);
          return;
        }
        const list = (listRes.rows ?? []) as Array<Record<string, unknown>>;
        const primary = list.find((row) => Boolean(row.isDefault)) ?? list[0];
        if (!primary) {
          setVariantMembership(null);
          return;
        }
        const detailsRes = await window.matrica.warehouse.assemblyBomGet(String(primary.id));
        if (!alive || !detailsRes?.ok) {
          if (alive) setVariantMembership(null);
          return;
        }
        // assemblyBomGet returns { ok, bom: { header, lines } } — lines are under .bom.lines.
        const lines = Array.isArray((detailsRes as any).bom?.lines)
          ? ((detailsRes as any).bom.lines as Array<{ componentNomenclatureId?: string | null; variantGroup?: string | null }>)
          : [];
        const map = new Map<string, Set<string>>();
        for (const line of lines) {
          const nomId = String(line?.componentNomenclatureId ?? '').trim();
          const vg = String(line?.variantGroup ?? '').trim();
          if (!nomId || !vg) continue; // деталь без variantGroup — общая, в карту не кладём
          const set = map.get(nomId) ?? new Set<string>();
          set.add(vg);
          map.set(nomId, set);
        }
        if (alive) setVariantMembership(map);
      } catch {
        if (alive) setVariantMembership(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isInventoryStage, assemblyVariant, props.engineBrandId]);

  async function save(nextAnswers: RepairChecklistAnswers) {
    if (!activeTemplate) return;
    if (!props.canEdit) return;
    const normalized =
      props.stage === 'defect'
        ? normalizeDefectAnswers(activeTemplate, nextAnswers)
        : props.stage === 'completeness'
          ? normalizeCompletenessAnswers(activeTemplate, nextAnswers)
          : props.stage === ENGINE_INVENTORY_STAGE
            ? normalizeInventoryAnswers(activeTemplate, nextAnswers)
            : { next: nextAnswers, changed: false };
    if (normalized.changed) setAnswers(normalized.next);

    const snapshot = safeJsonStringify({ templateId: activeTemplate.id, answers: normalized.next });
    if (snapshot && snapshot === lastSavedAnswersRef.current) return;
    if (saveInFlightRef.current) {
      queuedSaveAnswersRef.current = normalized.next;
      return;
    }

    saveInFlightRef.current = true;
    setStatus('Сохранение...');
    const r = await window.matrica.checklists.engineSave({
      engineId: props.engineId,
      stage: props.stage,
      templateId: activeTemplate.id,
      operationId,
      answers: normalized.next,
    });
    saveInFlightRef.current = false;

    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    setOperationId(r.operationId);
    lastSavedAnswersRef.current = snapshot;
    setStatus('Сохранено');
    setTimeout(() => setStatus(''), 700);

    const queued = queuedSaveAnswersRef.current;
    queuedSaveAnswersRef.current = null;
    if (!queued) return;
    const queuedSnapshot = safeJsonStringify({ templateId: activeTemplate.id, answers: queued });
    if (queuedSnapshot && queuedSnapshot !== lastSavedAnswersRef.current) {
      void save(queued);
    }
  }

  function exportJson() {
    if (!activeTemplate) return;
    const obj = {
      template: activeTemplate,
      engineId: props.engineId,
      stage: props.stage,
      operationId,
      answers,
      exportedAt: Date.now(),
    };
    downloadText(`repair_checklist_${props.engineId}_${props.stage}.json`, JSON.stringify(obj, null, 2), 'application/json;charset=utf-8');
  }

  function exportCsv() {
    if (!activeTemplate) return;
    const lines: string[] = [];
    lines.push(['engineId', 'stage', 'operationId', 'itemId', 'label', 'kind', 'rowIndex', 'colId', 'value'].map(csvEscape).join(','));

    for (const it of activeTemplate.items) {
      const a: any = (answers as any)[it.id];
      if (!a) {
        lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, it.kind, '', '', ''].map(csvEscape).join(','));
        continue;
      }
      if (a.kind === 'text') {
        lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, 'text', '', '', String(a.value ?? '')].map(csvEscape).join(','));
        continue;
      }
      if (a.kind === 'date') {
        const v = a.value ? new Date(a.value).toISOString() : '';
        lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, 'date', '', '', v].map(csvEscape).join(','));
        continue;
      }
      if (a.kind === 'boolean') {
        lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, 'boolean', '', '', a.value ? 'true' : 'false'].map(csvEscape).join(','));
        continue;
      }
      if (a.kind === 'signature') {
        const signedAt = a.signedAt ? new Date(a.signedAt).toISOString() : '';
        const value = `fio=${String(a.fio ?? '')}; position=${String(a.position ?? '')}; signedAt=${signedAt}`;
        lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, 'signature', '', '', value].map(csvEscape).join(','));
        continue;
      }
      if (a.kind === 'table') {
        const rows: any[] = Array.isArray(a.rows) ? a.rows : [];
        if (rows.length === 0) {
          lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, 'table', '', '', ''].map(csvEscape).join(','));
          continue;
        }
        rows.forEach((row, idx) => {
          const cols = it.columns?.map((c) => c.id) ?? Object.keys(row ?? {});
          cols.forEach((colId) => {
            lines.push(
              [props.engineId, props.stage, operationId ?? '', it.id, it.label, 'table', String(idx), colId, String((row as any)?.[colId] ?? '')]
                .map(csvEscape)
                .join(','),
            );
          });
        });
        continue;
      }
      lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, it.kind, '', '', safeJsonStringify(a)].map(csvEscape).join(','));
    }

    downloadText(`repair_checklist_${props.engineId}_${props.stage}.csv`, lines.join('\n') + '\n', 'text/csv;charset=utf-8');
  }

  function printChecklist() {
    if (!activeTemplate) return;
    const formatBool = (val: unknown) => (val ? 'Да' : 'Нет');
    const renderTable = (it: any, a: any) => {
      const rows: any[] = Array.isArray(a?.rows) ? a.rows : [];
      const cols =
        Array.isArray(it?.columns) && it.columns.length > 0
          ? it.columns
          : rows[0]
            ? Object.keys(rows[0]).map((id) => ({ id, label: id }))
            : [{ id: 'value', label: 'Значение' }];
      const head = cols.map((c: any) => `<th>${escapeHtml(c.label ?? c.id)}</th>`).join('');
      const body =
        rows.length === 0
          ? `<tr><td colspan="${cols.length}" class="muted">Нет данных</td></tr>`
          : rows
              .map((row) => {
                const tds = cols
                  .map((c: any) => {
                    const raw = (row as any)?.[c.id];
                    const isBool = c.kind === 'boolean' || typeof raw === 'boolean';
                    const value = isBool ? formatBool(raw) : raw == null ? '—' : String(raw);
                    return `<td>${escapeHtml(value)}</td>`;
                  })
                  .join('');
                return `<tr>${tds}</tr>`;
              })
              .join('');
      return `<table class="doc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    };
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${panelTitle}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    body { font-family: "Times New Roman", "Liberation Serif", serif; margin: 0; color: #0b1220; }
    h1 { margin: 0 0 6px 0; font-size: 18px; text-transform: uppercase; letter-spacing: 0.2px; }
    .doc { padding: 12mm; }
    .meta { color: #111827; margin-bottom: 12px; font-size: 12px; line-height: 1.35; }
    .doc-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .doc-table th, .doc-table td { border: 1px solid #111827; padding: 6px 8px; font-size: 12px; vertical-align: top; }
    .doc-table th { background: #f3f4f6; font-weight: 700; }
    .muted { color: #6b7280; }
    .section-title { margin: 12px 0 6px; font-size: 13px; font-weight: 700; }
    .signature { margin-top: 10px; font-size: 12px; }
    .signature-line { display: inline-block; border-bottom: 1px solid #111827; min-width: 220px; height: 14px; vertical-align: bottom; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin:12px;">
    <button id="printBtn">Печать</button>
  </div>
  <div class="doc">
    <h1>${panelTitle}</h1>
    <div class="meta">
      <div><b>Двигатель:</b> ${escapeHtml(String(props.engineBrand ?? ''))} ${escapeHtml(String(props.engineNumber ?? ''))}</div>
      <div><b>Шаблон:</b> ${escapeHtml(activeTemplate.name)} (v${escapeHtml(String(activeTemplate.version))})</div>
      <div><b>Дата:</b> ${escapeHtml(formatMoscowDateTime(Date.now()))}</div>
    </div>
    <table class="doc-table">
      <thead><tr><th style="width:40%">Поле</th><th>Значение</th></tr></thead>
      <tbody>
        ${activeTemplate.items
          .map((it) => {
            const a: any = (answers as any)[it.id];
            if (!a) return `<tr><td>${escapeHtml(it.label)}</td><td class="muted">—</td></tr>`;
            if (a.kind === 'text') return `<tr><td>${escapeHtml(it.label)}</td><td>${escapeHtml(String(a.value ?? ''))}</td></tr>`;
            if (a.kind === 'date') return `<tr><td>${escapeHtml(it.label)}</td><td>${a.value ? escapeHtml(formatMoscowDate(a.value)) : ''}</td></tr>`;
            if (a.kind === 'boolean') return `<tr><td>${escapeHtml(it.label)}</td><td>${formatBool(a.value)}</td></tr>`;
            if (a.kind === 'signature')
              return `<tr><td>${escapeHtml(it.label)}</td><td>ФИО: ${escapeHtml(String(a.fio ?? ''))}<br/>Должность: ${escapeHtml(
                String(a.position ?? ''),
              )}<br/>Дата: ${a.signedAt ? escapeHtml(formatMoscowDate(a.signedAt)) : ''}</td></tr>`;
            if (a.kind === 'table')
              return `<tr><td>${escapeHtml(it.label)}</td><td>${renderTable(it, a)}</td></tr>`;
            return `<tr><td>${escapeHtml(it.label)}</td><td class="muted">—</td></tr>`;
          })
          .join('\n')}
      </tbody>
    </table>
    <div class="signature">
      <div>Подпись: <span class="signature-line"></span></div>
    </div>
  </div>
</body>
</html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => {
      const printBtn = w.document.getElementById('printBtn');
      if (printBtn) printBtn.addEventListener('click', () => w.print());
      w.focus();
    }, 200);
  }

  return (
    <div style={{ marginTop: 14, border: '1px solid rgba(15, 23, 42, 0.18)', borderRadius: 14, padding: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <strong>{panelTitle}</strong>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? 'Развернуть' : 'Свернуть'}
        </Button>
        {props.canExport && (
          <>
            <Button variant="ghost" onClick={exportJson}>
              Экспорт JSON
            </Button>
            <Button variant="ghost" onClick={exportCsv}>
              Экспорт CSV
            </Button>
          </>
        )}
        {props.canPrint && !isInventoryStage && (
          <Button variant="ghost" onClick={printChecklist}>
            Печать
          </Button>
        )}
        {props.canPrint && isInventoryStage && (
          <>
            {actView === 'completeness' ? (
              <>
                <Button variant="ghost" onClick={() => void printAct('completeness')}>
                  Печать акта комплектности
                </Button>
                <Button
                  variant="ghost"
                  title="Пустой бланк акта комплектности с перечнем деталей — для заполнения комиссией на месте от руки"
                  onClick={() => printBlankAct('completeness')}
                >
                  Бланк комплектности
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => void printAct('defect')}>
                  Печать акта дефектовки
                </Button>
                <Button
                  variant="ghost"
                  title="Пустой бланк акта дефектовки с перечнем деталей — для заполнения на месте от руки"
                  onClick={() => printBlankAct('defect')}
                >
                  Бланк дефектовки
                </Button>
                <Button
                  variant="ghost"
                  disabled={(customerClaim?.total ?? 0) === 0 && (inventoryShortage?.total ?? 0) === 0}
                  title="Дефектные детали на ветке «заказчик» + недостача комплектности"
                  onClick={() => void printAct('claim')}
                >
                  {`Печать претензии${customerClaim && customerClaim.total > 0 ? ` (${customerClaim.total})` : ''}`}
                </Button>
              </>
            )}
            {selectedInventoryCount > 0 && (
              <span style={{ color: '#2563eb', fontSize: 12, alignSelf: 'center' }}>
                в печать: {selectedInventoryCount}
              </span>
            )}
          </>
        )}
      </div>

      {!collapsed && isInventoryStage && inventoryShortage && inventoryShortage.total > 0 && (
        <div
          style={{
            marginTop: 10,
            padding: '8px 12px',
            borderRadius: 10,
            background: 'rgba(234, 88, 12, 0.10)',
            border: '1px solid rgba(234, 88, 12, 0.35)',
            fontSize: 13,
            color: '#9a3412',
          }}
        >
          <strong>Недостача комплектности:</strong> {inventoryShortage.total} позиц. ({inventoryShortage.missingUnits} ед.) — требует восполнения.{' '}
          <span style={{ color: '#7c2d12' }}>Требование в снабжение не создано (создаётся отдельным шагом с одобрением директора).</span>
        </div>
      )}

      {!collapsed && isInventoryStage && actVersions.completeness.length + actVersions.defect.length + actVersions.claim.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Button variant="ghost" onClick={() => setActVersionsOpen((v) => !v)}>
            {`История версий актов (${actVersions.completeness.length + actVersions.defect.length + actVersions.claim.length}) ${actVersionsOpen ? '▲' : '▼'}`}
          </Button>
          {actVersionsOpen && (
            <div style={{ marginTop: 6, display: 'grid', gap: 10 }}>
              {(['completeness', 'defect', 'claim'] as const).map((at) => {
                const list = actVersions[at];
                if (list.length === 0) return null;
                const title = at === 'completeness' ? 'Акт комплектности' : at === 'defect' ? 'Акт дефектовки' : 'Акт претензии заказчику';
                return (
                  <div key={at}>
                    <div style={{ fontSize: 12, color: '#334155', marginBottom: 4 }}>
                      {title} — версий: {list.length}
                    </div>
                    <table className="list-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: 'left', color: '#64748b' }}>
                          <th style={{ padding: 6 }}>Версия</th>
                          <th style={{ padding: 6 }}>Дата печати</th>
                          <th style={{ padding: 6 }}>Кто</th>
                          <th style={{ padding: 6 }}>Строк</th>
                          <th style={{ padding: 6 }}>Недостача</th>
                          <th style={{ padding: 6 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((v) => (
                          <tr key={v.operationId} style={{ borderTop: '1px solid rgba(15,23,42,0.08)' }}>
                            <td style={{ padding: 6 }}>№{v.version}</td>
                            <td style={{ padding: 6 }}>{formatMoscowDateTime(v.printedAt)}</td>
                            <td style={{ padding: 6 }}>{v.printedBy ?? '—'}</td>
                            <td style={{ padding: 6 }}>
                              {v.rows.length}
                              {v.selectedCount > 0 ? ` (выбрано ${v.selectedCount})` : ''}
                            </td>
                            <td style={{ padding: 6 }}>{v.shortage && v.shortage.total > 0 ? `${v.shortage.total} поз.` : '—'}</td>
                            <td style={{ padding: 6 }}>
                              <Button variant="ghost" onClick={() => printActVersion(v)}>
                                Печать
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!collapsed && (
      <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 420 }}>
          <div style={{ fontSize: 12, color: '#334155', marginBottom: 4 }}>Шаблон</div>
          <select
            value={templateId}
            onChange={(e) => {
              const id = e.target.value;
              setTemplateId(id);
              const t = templates.find((x) => x.id === id) ?? null;
              if (t && (!payload || payload.templateId !== id)) setAnswers(emptyAnswersForTemplate(t));
            }}
            style={{ width: '100%', padding: '9px 12px', borderRadius: 12, border: '1px solid rgba(15, 23, 42, 0.25)' }}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (v{t.version})
              </option>
            ))}
            {templates.length === 0 && <option value="default">(нет шаблонов)</option>}
          </select>
        </div>
        <div style={{ color: '#64748b', fontSize: 12 }}>
          stage: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{props.stage}</span>
        </div>
        {(props.stage === 'defect' || props.stage === 'completeness' || isInventoryStage) && (
          <div style={{ color: '#64748b', fontSize: 12 }}>
            Список деталей из марки двигателя синхронизируется автоматически при открытии карточки.
          </div>
        )}
        {props.stage === 'defect' && props.canEdit && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ color: '#64748b', fontSize: 12 }}>Создавать:</div>
            {(['part', 'node'] as const).map((kind) => {
              const active = defectCreateKind === kind;
              const disabled = kind === 'node' && !props.canEditMasterData;
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => !disabled && setDefectCreateKind(kind)}
                  disabled={disabled}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: active ? '1px solid #2563eb' : '1px solid rgba(15, 23, 42, 0.25)',
                    background: active ? 'rgba(37, 99, 235, 0.12)' : 'var(--input-bg)',
                    color: disabled ? '#94a3b8' : 'var(--text)',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                  }}
                >
                  {kind === 'part' ? 'Деталь' : 'Узел'}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ flex: 1 }} />
        {status && <div style={{ color: '#64748b', fontSize: 12 }}>{status}</div>}
      </div>
      )}

      {!collapsed && !activeTemplate ? (
        <div style={{ marginTop: 10, color: '#64748b' }}>Нет доступных шаблонов.</div>
      ) : null}
      {!collapsed && activeTemplate && isInventoryStage ? (
        <div style={{ marginTop: 12, display: 'flex', gap: 6, borderBottom: '2px solid var(--border)' }}>
          {(
            [
              { key: 'completeness', label: 'Акт комплектности' },
              { key: 'defect', label: 'Акт дефектовки' },
            ] as const
          ).map((t) => {
            const active = actView === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActView(t.key)}
                style={{
                  padding: '8px 16px',
                  fontSize: 14,
                  fontWeight: active ? 700 : 500,
                  border: 'none',
                  borderBottom: active ? '3px solid #2563eb' : '3px solid transparent',
                  background: 'transparent',
                  color: active ? 'var(--text)' : '#64748b',
                  cursor: 'pointer',
                  marginBottom: -2,
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      ) : null}
      {!collapsed && activeTemplate && isInventoryStage && actView === 'completeness' && props.canEdit ? (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            variant="ghost"
            title="Автоподстановка комиссии акта комплектности по цеху двигателя: начальник цеха и мастер — из цеха двигателя, начальник ОТК — по базе. Перетирает текущие ФИО."
            onClick={fillCommissionByWorkshop}
          >
            Заполнить комиссию по цеху
          </Button>
        </div>
      ) : null}
      {!collapsed && activeTemplate && isInventoryStage && actView === 'defect'
        ? (() => {
            const current: { employeeId: string; fio: string; position: string }[] =
              (answers as any).defect_dismantled_by?.kind === 'employees'
                ? ((answers as any).defect_dismantled_by.employees ?? [])
                : [];
            const commit = (employees: { employeeId: string; fio: string; position: string }[]) => {
              const nextAnswers = { ...answers, defect_dismantled_by: { kind: 'employees', employees } } as RepairChecklistAnswers;
              setAnswers(nextAnswers);
              void save(nextAnswers);
            };
            const ghostBtn: React.CSSProperties = {
              padding: '4px 10px',
              borderRadius: 8,
              border: '1px solid rgba(15, 23, 42, 0.25)',
              background: 'var(--input-bg)',
              color: 'var(--text)',
              cursor: 'pointer',
              fontSize: 12,
            };
            return (
              <div style={{ marginTop: 12, padding: '10px 12px', border: '1px solid rgba(15,23,42,0.12)', borderRadius: 10, background: 'var(--input-bg)' }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Разборку двигателя произвёл:</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {current.map((emp, idx) => {
                    const inList = emp.employeeId ? employeeOptions.some((o) => o.id === emp.employeeId) : false;
                    const extra = emp.employeeId && !inList && emp.fio ? [{ id: emp.employeeId, label: emp.fio, position: emp.position || null }] : [];
                    const options = [...employeeOptions, ...extra];
                    return (
                      <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ flex: 1, maxWidth: 360 }}>
                          <SearchSelect
                            value={emp.employeeId || null}
                            options={options}
                            disabled={!props.canEdit}
                            placeholder="ФИО сотрудника"
                            onChange={(next) => {
                              if (!props.canEdit) return;
                              const chosen = options.find((o) => o.id === next) ?? null;
                              commit(
                                current.map((r, i) =>
                                  i === idx ? { employeeId: next ?? '', fio: chosen?.label ?? '', position: chosen?.position ?? '' } : r,
                                ),
                              );
                            }}
                          />
                        </div>
                        {props.canEdit ? (
                          <button type="button" onClick={() => commit(current.filter((_, i) => i !== idx))} style={ghostBtn}>
                            Удалить
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {props.canEdit ? (
                  <button
                    type="button"
                    onClick={() => commit([...current, { employeeId: '', fio: '', position: '' }])}
                    style={{ ...ghostBtn, marginTop: current.length ? 8 : 0 }}
                  >
                    + Добавить сотрудника
                  </button>
                ) : null}
              </div>
            );
          })()
        : null}
      {!collapsed && activeTemplate && isInventoryStage && actView === 'completeness' ? (
        <div style={{ marginTop: 12, padding: '10px 12px', border: '1px solid rgba(15,23,42,0.12)', borderRadius: 10, background: 'var(--input-bg)' }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Состояние при поступлении:</div>
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 8, alignItems: 'center' }}>
            {ENGINE_RECEIPT_CONDITION_FIELDS.map((f) => {
              const a: any = (answers as any)[f.id];
              const val = a?.kind === 'text' ? String(a.value ?? '') : '';
              const placeholder =
                f.id === 'receipt_packaging'
                  ? 'целая / повреждена (описать)'
                  : f.id === 'receipt_seals'
                    ? 'есть / нет'
                    : f.id === 'receipt_notes'
                      ? 'особые отметки при приёмке'
                      : 'отсутствуют / имеются (описать)';
              return (
                <React.Fragment key={f.id}>
                  <div style={{ color: '#334155', fontSize: 13 }}>{f.label}</div>
                  <Input
                    value={val}
                    disabled={!props.canEdit}
                    placeholder={placeholder}
                    onChange={(e) => {
                      if (!props.canEdit) return;
                      const next = { ...answers, [f.id]: { kind: 'text', value: e.target.value } } as RepairChecklistAnswers;
                      setAnswers(next);
                    }}
                    onBlur={() => void save(answers)}
                  />
                </React.Fragment>
              );
            })}
          </div>
        </div>
      ) : null}
      {!collapsed && activeTemplate ? (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '340px 1fr', gap: 10, alignItems: 'center' }}>
          {activeTemplate.items.map((it) => {
            // Под-вкладки: скрываем даты/подписи чужого акта (данные не теряются — просто не показаны).
            if (isInventoryStage) {
              if (actView === 'completeness' && DEFECT_ONLY_ITEM_IDS.has(it.id)) return null;
              if (actView === 'defect' && COMPLETENESS_ONLY_ITEM_IDS.has(it.id)) return null;
            }
            const a: any = (answers as any)[it.id];
            const isDefectResultsTable = props.stage === 'defect' && it.kind === 'table' && it.id === 'defect_items';
            const isCompletenessGroupsTable = props.stage === 'completeness' && it.kind === 'table' && it.id === 'completeness_items';
            const isInventoryItemsTable = isInventoryStage && it.kind === 'table' && it.id === 'engine_inventory_items';
            const isWideTableRow = isDefectResultsTable || isCompletenessGroupsTable || isInventoryItemsTable;
            const isLockedField = lockedFieldIds.has(it.id);
            return (
              <React.Fragment key={it.id}>
                <div style={{ color: '#334155', ...(isWideTableRow ? { gridColumn: '1 / -1' } : {}) }}>
                  {it.label} {it.required ? <span style={{ color: '#b91c1c' }}>*</span> : null}
                </div>
                <div style={isWideTableRow ? { gridColumn: '1 / -1' } : undefined}>
                  {it.kind === 'text' && (
                    <Input
                      value={a?.kind === 'text' ? a.value : ''}
                      disabled={!props.canEdit || isLockedField}
                      onChange={(e) => {
                        if (isLockedField) return;
                        const next = { ...answers, [it.id]: { kind: 'text', value: e.target.value } } as RepairChecklistAnswers;
                        setAnswers(next);
                      }}
                      onBlur={() => void save(answers)}
                    />
                  )}

                  {it.kind === 'date' && (
                    <Input
                      type="date"
                      value={a?.kind === 'date' && a.value ? toInputDate(a.value) : ''}
                      disabled={!props.canEdit || isLockedField}
                      onChange={(e) => {
                        if (isLockedField) return;
                        const nextVal = fromInputDate(e.target.value);
                        const next = { ...answers, [it.id]: { kind: 'date', value: nextVal } } as RepairChecklistAnswers;
                        setAnswers(next);
                        void save(next);
                      }}
                    />
                  )}

                  {it.kind === 'boolean' && (
                    <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={a?.kind === 'boolean' ? !!a.value : false}
                        disabled={!props.canEdit}
                        onChange={(e) => {
                          const next = { ...answers, [it.id]: { kind: 'boolean', value: e.target.checked } } as RepairChecklistAnswers;
                          setAnswers(next);
                          void save(next);
                        }}
                      />
                      <span style={{ color: '#64748b', fontSize: 12 }}>{a?.kind === 'boolean' && a.value ? 'да' : 'нет'}</span>
                    </label>
                  )}

                  {it.kind === 'signature' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 160px', gap: 8 }}>
                      {(() => {
                        const fioValue = a?.kind === 'signature' ? String(a.fio ?? '') : '';
                        const inList = fioValue ? employeeOptions.some((opt) => opt.label === fioValue || opt.id === fioValue) : false;
                        const extra = fioValue && !inList ? [{ id: fioValue, label: fioValue, position: a?.position ?? null }] : [];
                        const options = [...employeeOptions, ...extra];
                        const valueId =
                          fioValue && inList
                            ? employeeOptions.find((opt) => opt.label === fioValue || opt.id === fioValue)?.id ?? fioValue
                            : fioValue || null;
                        return (
                      <SearchSelect
                        value={valueId}
                        options={options}
                        disabled={!props.canEdit}
                        placeholder="ФИО"
                        onChange={(next) => {
                          if (!props.canEdit) return;
                          const prev = a?.kind === 'signature' ? a : { fio: '', position: '', signedAt: null };
                          const chosen = options.find((opt) => opt.id === next) ?? null;
                          const fio = chosen?.label ?? '';
                          const position = chosen?.position ?? prev.position ?? '';
                          const nextAnswers = {
                            ...answers,
                            [it.id]: { kind: 'signature', fio, position, signedAt: prev.signedAt },
                          } as RepairChecklistAnswers;
                          setAnswers(nextAnswers);
                          void save(nextAnswers);
                        }}
                      />
                        );
                      })()}
                      <Input
                        value={a?.kind === 'signature' ? String(a.position ?? '') : ''}
                        disabled
                        placeholder="Должность"
                      />
                      <Input
                        type="date"
                        value={a?.kind === 'signature' && a.signedAt ? toInputDate(a.signedAt) : ''}
                        disabled={!props.canEdit}
                        onChange={(e) => {
                          const prev = a?.kind === 'signature' ? a : { fio: '', position: '', signedAt: null };
                          const nextVal = fromInputDate(e.target.value);
                          const next = { ...answers, [it.id]: { kind: 'signature', fio: prev.fio, position: prev.position, signedAt: nextVal } } as RepairChecklistAnswers;
                          setAnswers(next);
                          void save(next);
                        }}
                      />
                    </div>
                  )}

                  {it.kind === 'table' && (
                    <>
                    {isInventoryStage && it.id === 'engine_inventory_items' && assemblyVariant && variantMembership && variantMembership.size > 0 ? (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          flexWrap: 'wrap',
                          marginBottom: 8,
                          padding: '6px 10px',
                          borderRadius: 8,
                          background: variantFilterOn ? 'rgba(37, 99, 235, 0.10)' : 'rgba(100, 116, 139, 0.10)',
                          fontSize: 13,
                        }}
                      >
                        <span>
                          {variantFilterOn ? (
                            <>Показаны детали варианта сборки: <strong>{assemblyVariant}</strong> (+ общие)</>
                          ) : (
                            <>Показаны все детали марки (фильтр по варианту выключен)</>
                          )}
                        </span>
                        <Button variant="ghost" onClick={() => setVariantFilterOn((v) => !v)}>
                          {variantFilterOn ? 'Показать все детали' : `Фильтровать по варианту «${assemblyVariant}»`}
                        </Button>
                      </div>
                    ) : null}
                    <TableEditor
                      tableId={it.id}
                      canEdit={props.canEdit}
                      columns={
                        props.stage === 'defect' && it.id === 'defect_items'
                          ? [
                              { id: 'part_name', label: 'Наименование узла (детали)' },
                              { id: 'part_number', label: '№ детали (узла)' },
                              { id: 'quantity', label: 'Количество', kind: 'number' as const },
                              { id: 'repairable_qty', label: 'Ремонтно-пригодная', kind: 'number' as const },
                              { id: 'scrap_qty', label: 'Утиль', kind: 'number' as const },
                            ]
                          : props.stage === 'completeness' && it.id === 'completeness_items'
                            ? [
                                { id: 'part_name', label: 'Наименование' },
                                { id: 'assembly_unit_number', label: 'Обозначение (№ сборочной единицы)' },
                                { id: 'quantity', label: 'Количество', kind: 'number' as const },
                                { id: 'present', label: 'Наличие', kind: 'boolean' as const },
                                { id: 'actual_qty', label: 'Фактическое количество', kind: 'number' as const },
                              ]
                            : isInventoryStage && it.id === 'engine_inventory_items'
                              ? actView === 'completeness'
                                ? [
                                    { id: 'part_name', label: 'Наименование' },
                                    { id: 'assembly_unit_number', label: '№ сборочной единицы' },
                                    { id: 'stamped_number', label: '№ на детали' },
                                    { id: 'quantity', label: 'План', kind: 'number' as const },
                                    { id: 'present', label: 'На месте', kind: 'boolean' as const },
                                    { id: 'actual_qty', label: 'Принято', kind: 'number' as const },
                                    { id: 'in_completeness_act', label: 'В акте' },
                                  ]
                                : [
                                    { id: 'part_name', label: 'Наименование' },
                                    { id: 'assembly_unit_number', label: '№ сборочной единицы' },
                                    { id: 'stamped_number', label: '№ на детали' },
                                    { id: 'quantity', label: 'План', kind: 'number' as const },
                                    { id: 'present', label: 'На месте', kind: 'boolean' as const },
                                    { id: 'repairable_qty', label: 'Ремонт', kind: 'number' as const },
                                    { id: 'scrap_qty', label: 'Утиль', kind: 'number' as const },
                                    { id: 'replace_qty', label: 'Заменить', kind: 'number' as const },
                                    { id: 'in_defect_act', label: 'В акте' },
                                    { id: 'replenishment_branch', label: 'Восполнение' },
                                  ]
                              : (it.columns ?? [])
                      }
                      rows={a?.kind === 'table' ? (a.rows ?? []) : []}
                      {...(() => {
                        const defectRenderers =
                          props.stage === 'defect' && it.id === 'defect_items'
                            ? {
                                part_name: ({ rowIdx, row, columnId, value, setValue }: any) => {
                                  if (isBrandLinkedChecklistRow(row as ChecklistTableRow)) {
                                    return <Input value={String(value ?? '')} disabled />;
                                  }
                                  const current = String(value ?? '');
                                  const rowPartId = String((row as any)?.[ROW_PART_ID_KEY] ?? '').trim();
                                  const match =
                                    (rowPartId ? defectOptions.find((o) => o.id === `part:${rowPartId}`) : null) ??
                                    defectOptions.find((o) => o.label === current) ??
                                    null;
                                  const valueId = match?.id ?? null;
                                  return (
                                    <SearchSelect
                                      value={valueId}
                                      options={defectOptions}
                                      disabled={!props.canEdit}
                                      placeholder="Выберите деталь или узел"
                                      createLabel="Добавить"
                                      {...(props.canEdit ? { onCreate: createDefectItem } : {})}
                                      onChange={(next) => {
                                        const selected = defectOptions.find((o) => o.id === next) ?? null;
                                        const label = selected?.label ?? '';
                                        setValue(rowIdx, BRAND_ROW_SOURCE_KEY, '');
                                        setValue(rowIdx, BRAND_ROW_PART_ID_KEY, '');
                                        setValue(rowIdx, ROW_PART_ID_KEY, rowPartIdFromOptionId(next));
                                        setValue(rowIdx, columnId, label);
                                        const meta = defectPartMetaById[next ?? ''];
                                        if (meta) {
                                          setValue(rowIdx, 'part_number', meta.partNumber);
                                          setValue(rowIdx, 'quantity', meta.quantity);
                                          setValue(rowIdx, 'repairable_qty', meta.quantity);
                                          setValue(rowIdx, 'scrap_qty', 0, true);
                                          return;
                                        }
                                        setValue(rowIdx, 'repairable_qty', 0);
                                        setValue(rowIdx, 'scrap_qty', 0, true);
                                      }}
                                    />
                                  );
                                },
                              }
                            : null;
                        if (defectRenderers) return { cellRenderers: defectRenderers };
                        const completenessRenderers =
                          props.stage === 'completeness' && it.id === 'completeness_items'
                            ? {
                                part_name: ({ rowIdx, row, columnId, value, setValue }: any) => {
                                  if (isBrandLinkedChecklistRow(row as ChecklistTableRow)) {
                                    return <Input value={String(value ?? '')} disabled />;
                                  }
                                  const current = String(value ?? '');
                                  const rowPartId = String((row as any)?.[ROW_PART_ID_KEY] ?? '').trim();
                                  const match =
                                    (rowPartId ? completenessOptions.find((o) => o.id === `part:${rowPartId}`) : null) ??
                                    completenessOptions.find((o) => o.label === current) ??
                                    null;
                                  const valueId = match?.id ?? null;
                                  return (
                                    <SearchSelect
                                      value={valueId}
                                      options={completenessOptions}
                                      disabled={!props.canEdit}
                                      placeholder="Выберите деталь"
                                      createLabel="Добавить"
                                      {...(props.canEdit ? { onCreate: createCompletenessItem } : {})}
                                      onChange={(next) => {
                                        const selected = completenessOptions.find((o) => o.id === next) ?? null;
                                        const label = selected?.label ?? '';
                                        setValue(rowIdx, BRAND_ROW_SOURCE_KEY, '');
                                        setValue(rowIdx, BRAND_ROW_PART_ID_KEY, '');
                                        setValue(rowIdx, ROW_PART_ID_KEY, rowPartIdFromOptionId(next));
                                        setValue(rowIdx, columnId, label);
                                        const meta = completenessPartMetaById[next ?? ''];
                                        if (meta) {
                                          setValue(rowIdx, 'assembly_unit_number', meta.assemblyUnitNumber);
                                          setValue(rowIdx, 'quantity', meta.quantity);
                                          setValue(rowIdx, 'present', false);
                                          setValue(rowIdx, 'actual_qty', 0, true);
                                          return;
                                        }
                                        setValue(rowIdx, 'actual_qty', 0, true);
                                      }}
                                    />
                                  );
                                },
                              }
                            : null;
                        if (completenessRenderers) return { cellRenderers: completenessRenderers };
                        // Т5: галочка акта пишет И эффективное значение, И операторский
                        // override — иначе brand-resync вернёт значение шаблона марки.
                        const actFlagRenderer =
                          (flagId: 'in_completeness_act' | 'in_defect_act') =>
                          ({ rowIdx, value, setValue }: any) => (
                            <input
                              type="checkbox"
                              checked={Boolean(value)}
                              disabled={!props.canEdit}
                              onChange={(e) => {
                                setValue(rowIdx, flagId, e.target.checked);
                                setValue(rowIdx, `${flagId}_override`, e.target.checked, true);
                              }}
                            />
                          );
                        const inventoryRenderers =
                          isInventoryStage && it.id === 'engine_inventory_items'
                            ? {
                                in_completeness_act: actFlagRenderer('in_completeness_act'),
                                in_defect_act: actFlagRenderer('in_defect_act'),
                                part_name: ({ rowIdx, row, columnId, value, setValue }: any) => {
                                  if (isBrandLinkedChecklistRow(row as ChecklistTableRow)) {
                                    return <Input value={String(value ?? '')} disabled />;
                                  }
                                  const current = String(value ?? '');
                                  const rowPartId = String((row as any)?.[ROW_PART_ID_KEY] ?? '').trim();
                                  const match =
                                    (rowPartId ? inventoryOptions.find((o) => o.id === `part:${rowPartId}`) : null) ??
                                    inventoryOptions.find((o) => o.label === current) ??
                                    null;
                                  const valueId = match?.id ?? null;
                                  return (
                                    <SearchSelect
                                      value={valueId}
                                      options={inventoryOptions}
                                      disabled={!props.canEdit}
                                      placeholder="Выберите деталь"
                                      createLabel="Добавить"
                                      {...(props.canEdit ? { onCreate: createInventoryItem } : {})}
                                      onChange={(next) => {
                                        const selected = inventoryOptions.find((o) => o.id === next) ?? null;
                                        const label = selected?.label ?? '';
                                        setValue(rowIdx, BRAND_ROW_SOURCE_KEY, '');
                                        setValue(rowIdx, BRAND_ROW_PART_ID_KEY, '');
                                        setValue(rowIdx, ROW_PART_ID_KEY, rowPartIdFromOptionId(next));
                                        setValue(rowIdx, columnId, label);
                                        const meta = inventoryPartMetaById[next ?? ''];
                                        if (meta) {
                                          setValue(rowIdx, 'assembly_unit_number', meta.assemblyUnitNumber);
                                          setValue(rowIdx, 'part_number', meta.partNumber);
                                          setValue(rowIdx, 'quantity', meta.quantity);
                                          setValue(rowIdx, 'present', false);
                                          setValue(rowIdx, 'actual_qty', 0);
                                          setValue(rowIdx, 'repairable_qty', meta.quantity);
                                          setValue(rowIdx, 'scrap_qty', 0);
                                          setValue(rowIdx, 'replace_qty', 0, true);
                                          return;
                                        }
                                        setValue(rowIdx, 'quantity', 0);
                                        setValue(rowIdx, 'repairable_qty', 0);
                                        setValue(rowIdx, 'scrap_qty', 0);
                                        setValue(rowIdx, 'replace_qty', 0, true);
                                      }}
                                    />
                                  );
                                },
                                // Ф3/Ф4: ветка восполнения per-деталь — активна при дефекте (утиль или замена > 0):
                                // и утиль, и замена выводят деталь из двигателя, решение «кто восполняет» нужно в обоих случаях.
                                replenishment_branch: ({ rowIdx, row, value, setValue }: any) => {
                                  const needsReplenish = rowHasDefect({
                                    scrap_qty: Number((row as any).scrap_qty ?? 0),
                                    replace_qty: Number((row as any).replace_qty ?? 0),
                                  });
                                  // Ф5: производный статус ремонта детали (open Repair-наряд → «в ремонте», closed → «готова»).
                                  // Событие ready_for_assembly того же наряда переводит в «готова» даже пока статус
                                  // closed самого наряда ещё не доехал синком (закрытие происходит на backend).
                                  const rowPartIdForState = getRowPartId(row as ChecklistTableRow);
                                  const rawRepairState = repairPartStates[rowPartIdForState];
                                  const repairState =
                                    rawRepairState &&
                                    rawRepairState.state === 'in_repair' &&
                                    partStatusEvents.some(
                                      (ev) =>
                                        ev.status === 'ready_for_assembly' &&
                                        ev.partId === rowPartIdForState &&
                                        ev.workOrderOperationId === rawRepairState.workOrderOperationId,
                                    )
                                      ? { ...rawRepairState, state: 'repaired' as const }
                                      : rawRepairState;
                                  return (
                                    <div style={{ display: 'grid', gap: 3 }}>
                                      <select
                                        value={String(value ?? '')}
                                        disabled={!props.canEdit || !needsReplenish}
                                        title={needsReplenish ? 'Как восполнить деталь' : 'Доступно для деталей с дефектом (утиль или заменить > 0)'}
                                        onChange={(e) => setValue(rowIdx, 'replenishment_branch', e.target.value, true)}
                                        style={{
                                          width: '100%',
                                          minWidth: 130,
                                          padding: '7px 8px',
                                          borderRadius: 8,
                                          border: '1px solid rgba(15, 23, 42, 0.25)',
                                          background: needsReplenish ? 'var(--input-bg)' : 'rgba(100,116,139,0.08)',
                                          color: needsReplenish ? 'var(--text)' : '#94a3b8',
                                        }}
                                      >
                                        <option value="">—</option>
                                        <option value="customer">Заказчик</option>
                                        <option value="repair">Свой ремонт</option>
                                        <option value="purchase">Закупка</option>
                                      </select>
                                      {repairState && (
                                        <span
                                          title={`Статус из ремонтного наряда №${repairState.workOrderNumber}`}
                                          style={{
                                            fontSize: 11,
                                            color: repairState.state === 'repaired' ? '#15803d' : '#b45309',
                                            whiteSpace: 'nowrap',
                                          }}
                                        >
                                          {repairState.state === 'repaired' ? '✅ готова к сборке' : '🔧 в ремонте'}
                                          {repairState.workOrderNumber > 0 ? ` (№${repairState.workOrderNumber})` : ''}
                                        </span>
                                      )}
                                    </div>
                                  );
                                },
                              }
                            : null;
                        return inventoryRenderers ? { cellRenderers: inventoryRenderers } : {};
                      })()}
                      {...(variantFilterActive && it.id === 'engine_inventory_items' && variantMembership
                        ? {
                            isRowHidden: (row: Record<string, string | boolean | number>) =>
                              !isInventoryRowVisibleForVariant(
                                getRowPartId(row as ChecklistTableRow),
                                variantMembership,
                                assemblyVariant,
                              ),
                          }
                        : {})}
                      {...(isInventoryStage && it.id === 'engine_inventory_items' && props.canViewFiles === true
                        ? {
                            renderRowExtra: (rowIdx: number, row: Record<string, string | boolean | number>) => (
                              <InventoryRowPhotos
                                photos={getRowPhotos(row as ChecklistTableRow)}
                                canView={props.canViewFiles === true}
                                canUpload={props.canUploadFiles === true && props.canEdit}
                                scope={{ ownerType: 'engine', ownerId: props.engineId, category: 'defect_photo' }}
                                onChange={(next) => {
                                  const cur = (answers as any).engine_inventory_items;
                                  const curRows: ChecklistTableRow[] =
                                    cur?.kind === 'table' && Array.isArray(cur.rows) ? (cur.rows as ChecklistTableRow[]) : [];
                                  const nextRows = curRows.map((r, i) => (i === rowIdx ? withRowPhotos(r, next) : r));
                                  const nextAnswers = {
                                    ...answers,
                                    [it.id]: { kind: 'table', rows: nextRows },
                                  } as RepairChecklistAnswers;
                                  setAnswers(nextAnswers);
                                  void save(nextAnswers);
                                }}
                              />
                            ),
                          }
                        : {})}
                      onChange={(rows) => {
                        const normalizedRows =
                          props.stage === 'defect' && it.id === 'defect_items'
                            ? (normalizeDefectRows(rows as any).rows as ChecklistTableRow[])
                            : props.stage === 'completeness' && it.id === 'completeness_items'
                              ? (normalizeCompletenessRows(rows as any).rows as ChecklistTableRow[])
                              : isInventoryStage && it.id === 'engine_inventory_items'
                                ? normalizeEngineInventoryRows(rows as unknown as Record<string, unknown>[]).rows.map((nr, i) => {
                                    const prev = rows[i] as ChecklistTableRow | undefined;
                                    return { ...nr, ...preserveRowIdentityMeta(prev) } as unknown as ChecklistTableRow;
                                  })
                                : (rows as ChecklistTableRow[]);
                        const next = { ...answers, [it.id]: { kind: 'table', rows: normalizedRows } } as RepairChecklistAnswers;
                        setAnswers(next);
                      }}
                      onSave={(rows) => {
                        const normalizedRows =
                          props.stage === 'defect' && it.id === 'defect_items'
                            ? (normalizeDefectRows(rows as any).rows as ChecklistTableRow[])
                            : props.stage === 'completeness' && it.id === 'completeness_items'
                              ? (normalizeCompletenessRows(rows as any).rows as ChecklistTableRow[])
                              : isInventoryStage && it.id === 'engine_inventory_items'
                                ? normalizeEngineInventoryRows(rows as unknown as Record<string, unknown>[]).rows.map((nr, i) => {
                                    const prev = rows[i] as ChecklistTableRow | undefined;
                                    return { ...nr, ...preserveRowIdentityMeta(prev) } as unknown as ChecklistTableRow;
                                  })
                                : (rows as ChecklistTableRow[]);
                        void save({ ...answers, [it.id]: { kind: 'table', rows: normalizedRows } } as RepairChecklistAnswers);
                      }}
                    />
                    </>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      ) : null}

      {!collapsed && !props.canEdit && <div style={{ marginTop: 10, color: '#64748b' }}>Только просмотр (нет прав на редактирование операций).</div>}

      {!collapsed && !isInventoryStage && (
        <AttachmentsPanel
          title={attachmentsTitle}
          value={(payload as any)?.attachments}
          canView={props.canViewFiles === true}
          canUpload={props.canUploadFiles === true && props.canEdit}
          onChange={async (next) => {
            if (!activeTemplate) return;
            if (!props.canEdit) return;
            setStatus('Сохранение...');
            const r = await window.matrica.checklists.engineSave({
              engineId: props.engineId,
              stage: props.stage,
              templateId: activeTemplate.id,
              operationId,
              answers,
              attachments: next,
            });
            if (!r.ok) {
              setStatus(`Ошибка: ${r.error}`);
              return { ok: false as const, error: r.error };
            }
            setOperationId(r.operationId);
            setPayload((prev) => (prev ? ({ ...prev, attachments: next } as RepairChecklistPayload) : prev));
            setStatus('Сохранено');
            setTimeout(() => setStatus(''), 700);
            return { ok: true as const };
          }}
        />
      )}

      {!collapsed && props.stage === 'defect' && defectOptionsStatus && (
        <div style={{ marginTop: 10, color: defectOptionsStatus.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>
          {defectOptionsStatus}
        </div>
      )}
      {!collapsed && props.stage === 'defect' && !props.engineBrandId && (
        <div style={{ marginTop: 10, color: '#64748b', fontSize: 12 }}>
          Выберите марку двигателя, чтобы подставить список деталей из справочника.
        </div>
      )}
      {!collapsed && props.stage === 'completeness' && completenessOptionsStatus && (
        <div style={{ marginTop: 10, color: completenessOptionsStatus.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>
          {completenessOptionsStatus}
        </div>
      )}
      {!collapsed && props.stage === 'completeness' && !props.engineBrandId && (
        <div style={{ marginTop: 10, color: '#64748b', fontSize: 12 }}>
          Выберите марку двигателя, чтобы подставить список деталей из справочника.
        </div>
      )}
      {!collapsed && isInventoryStage && inventoryOptionsStatus && (
        <div style={{ marginTop: 10, color: inventoryOptionsStatus.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>
          {inventoryOptionsStatus}
        </div>
      )}
      {!collapsed && isInventoryStage && !props.engineBrandId && (
        <div style={{ marginTop: 10, color: '#64748b', fontSize: 12 }}>
          Выберите марку двигателя, чтобы подставить список деталей из справочника.
        </div>
      )}
      {!collapsed && isInventoryStage && props.onCreateSupplyRequestFromDefects && (
        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="outline"
            disabled={defectSupplyItems.length === 0 || supplyRequestBusy}
            title="Собрать детали, помеченные «заказать новую», в черновик заявки в снабжение"
            onClick={async () => {
              if (defectSupplyItems.length === 0 || supplyRequestBusy) return;
              setSupplyRequestBusy(true);
              try {
                await props.onCreateSupplyRequestFromDefects?.(defectSupplyItems, defectSupplyPhotos);
              } finally {
                setSupplyRequestBusy(false);
              }
            }}
          >
            {supplyRequestBusy ? 'Создаём заявку…' : `🧾 Заявка в снабжение (закупка) (${defectSupplyItems.length})`}
          </Button>
          {defectSupplyItems.length === 0 && (
            <span style={{ color: '#64748b', fontSize: 12 }}>Нет деталей к закупке (ветка «закупка» или не задана).</span>
          )}
          {replenishmentSummary && replenishmentSummary.toReplenish > 0 && (
            <span style={{ color: '#64748b', fontSize: 12 }}>
              Восполнение: заказчик {replenishmentSummary.customer} · свой ремонт {replenishmentSummary.repair} · закупка {replenishmentSummary.purchase}
              {replenishmentSummary.unrouted > 0 ? ` · не задано ${replenishmentSummary.unrouted} (незаданные «заменить» идут в закупку)` : ''}
            </span>
          )}
          <span style={{ color: '#7c2d12', fontSize: 12, flexBasis: '100%' }}>
            Создаётся черновик заявки — уходит в требование только после одобрения директором.
          </span>
        </div>
      )}

      {/* Ф5 (GAP-4 вход): строки «свой ремонт» с дефектом → черновик ремонтного наряда. */}
      {!collapsed && isInventoryStage && props.canCreateWorkOrder && (
        <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="outline"
            disabled={repairOrderDraft.items.length === 0 || repairOrderBusy}
            title="Создать черновик ремонтного наряда из деталей на ветке «свой ремонт» (цех и услуги — в карточке наряда)"
            onClick={() => void createRepairOrderFromDefects()}
          >
            {repairOrderBusy ? 'Создаём наряд…' : `🔧 Ремонтный наряд (свой ремонт) (${repairOrderDraft.items.length})`}
          </Button>
          {repairOrderDraft.items.length === 0 && (
            <span style={{ color: '#64748b', fontSize: 12 }}>Нет деталей на ветке «свой ремонт» с дефектом.</span>
          )}
          {repairOrderDraft.skippedNoPartId > 0 && (
            <span style={{ color: '#b45309', fontSize: 12 }}>
              Пропущено {repairOrderDraft.skippedNoPartId} строк без привязки к справочнику — выберите деталь из списка в строке.
            </span>
          )}
          <span style={{ color: '#64748b', fontSize: 12, flexBasis: '100%' }}>
            Создаётся черновик наряда «Ремонт»: при закрытии наряда детали приходуются на склад цеха и получают статус «годна к сборке».
          </span>
        </div>
      )}

      {/* Ремфонд Ф1: годные к ремонту детали (present && не утиль) → приход в ремонтный фонд. */}
      {!collapsed && isInventoryStage && props.canCreateWorkOrder && (
        <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="outline"
            disabled={repairFundDraft.items.length === 0 || repairFundBusy}
            title="Занести годные к ремонту детали (присутствуют и не утиль) в «Ремонтный фонд». Повторное нажатие не двоит приход — заносится только прирост."
            onClick={() => void intakeRepairFundFromDefects()}
          >
            {repairFundBusy ? 'Заносим…' : `🛠️ В ремфонд (${repairFundDraft.items.length})`}
          </Button>
          {intakePending && (
            <span
              style={{ color: '#b45309', fontSize: 12, fontWeight: 600 }}
              title="По текущей дефектовке есть годные к ремонту детали, которые ещё не занесены в ремонтный фонд. Нажмите «В ремфонд» — занесётся только прирост."
            >
              ⚠ Не занесено в ремфонд: {intakePending.qty} шт. ({intakePending.positions} поз.)
            </span>
          )}
          {repairFundDraft.items.length === 0 && (
            <span style={{ color: '#64748b', fontSize: 12 }}>Нет деталей «присутствует и ремонтопригодна».</span>
          )}
          {repairFundDraft.skippedNoPartId > 0 && (
            <span style={{ color: '#b45309', fontSize: 12 }}>
              Пропущено {repairFundDraft.skippedNoPartId} строк без привязки к справочнику.
            </span>
          )}
          <span style={{ color: '#64748b', fontSize: 12, flexBasis: '100%' }}>
            Годные к ремонту детали приходуются в «Ремонтный фонд» (ожидают ремонта). Ревизия/правка — «Склад → Ревизия ремфонда».
          </span>
        </div>
      )}

      {/* Ремфонд Ф3: захват номерных экземпляров деталей (личные набитые номера) с провенансом. */}
      {!collapsed && isInventoryStage && props.canCreateWorkOrder && (
        <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="outline"
            disabled={stampedDraft.items.length === 0 || stampedBusy}
            title="Зафиксировать детали с личным (набитым) номером в поэкземплярный реестр: номер ↔ этот двигатель ↔ классификация. Идемпотентно — повтор не двоит."
            onClick={() => void captureStampedInstances()}
          >
            {stampedBusy ? 'Фиксируем…' : `📌 Зафиксировать личные № (${stampedDraft.items.length})`}
          </Button>
          {props.canPrint && requirementInstances.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              title="Печать «Требования к заказчику»: детали этого двигателя в утиль/замену (обоснование роста цены ремонта). Печать фиксирует версию-снимок."
              onClick={() => void printRequirement()}
            >
              {`🧾 Печать требования (${requirementInstances.length})`}
            </Button>
          )}
          {stampedDraft.items.length === 0 && (
            <span style={{ color: '#64748b', fontSize: 12 }}>Нет строк с личным номером (поле «№ набитый»).</span>
          )}
          {stampedDraft.skippedNoPartId > 0 && (
            <span style={{ color: '#b45309', fontSize: 12 }}>
              Пропущено {stampedDraft.skippedNoPartId} строк с номером, но без привязки к справочнику.
            </span>
          )}
          <span style={{ color: '#64748b', fontSize: 12, flexBasis: '100%' }}>
            Деталь с личным номером учитывается поштучно с привязкой к двигателю-источнику — для требования к заказчику по конкретному двигателю.
          </span>
        </div>
      )}

      {/* Ремфонд Ф3: реестр номерных экземпляров этого двигателя (провенанс-вид для претензии). */}
      {!collapsed && isInventoryStage && stampedInstances.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Button variant="ghost" onClick={() => setStampedOpen((v) => !v)}>
            {`Личные номера экземпляров (${stampedInstances.length}) ${stampedOpen ? '▲' : '▼'}`}
          </Button>
          {stampedOpen && (
            <table className="list-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b' }}>
                  <th style={{ padding: 6 }}>Личный №</th>
                  <th style={{ padding: 6 }}>Деталь</th>
                  <th style={{ padding: 6 }}>Классификация</th>
                  <th style={{ padding: 6 }}>Статус</th>
                  <th style={{ padding: 6 }}>Зафиксировано</th>
                  {props.canCreateWorkOrder && <th style={{ padding: 6 }}>Ремонт</th>}
                </tr>
              </thead>
              <tbody>
                {stampedInstances.map((it) => (
                  <tr key={it.operationId} style={{ borderTop: '1px solid rgba(15,23,42,0.08)' }}>
                    <td style={{ padding: 6, fontWeight: 600 }}>{it.stampedNumber}</td>
                    <td style={{ padding: 6 }}>{it.partLabel || it.partId}</td>
                    <td style={{ padding: 6, color: it.classification === 'scrap' ? '#b91c1c' : it.classification === 'replace' ? '#b45309' : '#15803d' }}>
                      {repairFundInstanceClassificationLabel(it.classification)}
                    </td>
                    <td style={{ padding: 6, color: it.status === 'repaired' ? '#15803d' : undefined, fontWeight: it.status === 'repaired' ? 600 : undefined }}>
                      {repairFundInstanceStatusLabel(it.status)}
                    </td>
                    <td style={{ padding: 6 }}>{it.at ? formatMoscowDateTime(it.at) : formatMoscowDateTime(it.capturedAt)}</td>
                    {props.canCreateWorkOrder && (
                      <td style={{ padding: 6 }}>
                        {it.status === 'in_fund' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!instanceBusyId}
                            title="Отметить эту деталь как отремонтированную (выходит из ремфонда). Точно — по конкретному личному номеру."
                            onClick={() => void setInstanceRepaired(it.operationId, true)}
                          >
                            {instanceBusyId === it.operationId ? '…' : '✓ Отремонтирована'}
                          </Button>
                        )}
                        {it.status === 'repaired' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!instanceBusyId}
                            title="Вернуть деталь в ремфонд (отменить отметку «отремонтирована»)."
                            onClick={() => void setInstanceRepaired(it.operationId, false)}
                          >
                            {instanceBusyId === it.operationId ? '…' : '↩ В фонд'}
                          </Button>
                        )}
                        {it.status !== 'in_fund' && it.status !== 'repaired' && (
                          <span style={{ color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Ремфонд Ф4: версии печатного «требования к заказчику» (снимки), с повторной печатью. */}
      {!collapsed && isInventoryStage && requirementVersions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Button variant="ghost" onClick={() => setRequirementVersionsOpen((v) => !v)}>
            {`Версии требования (${requirementVersions.length}) ${requirementVersionsOpen ? '▲' : '▼'}`}
          </Button>
          {requirementVersionsOpen && (
            <table className="list-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b' }}>
                  <th style={{ padding: 6 }}>Версия</th>
                  <th style={{ padding: 6 }}>Позиций</th>
                  <th style={{ padding: 6 }}>Напечатано</th>
                  <th style={{ padding: 6 }}>Кто</th>
                  <th style={{ padding: 6 }}></th>
                </tr>
              </thead>
              <tbody>
                {requirementVersions.map((v) => (
                  <tr key={v.operationId} style={{ borderTop: '1px solid rgba(15,23,42,0.08)' }}>
                    <td style={{ padding: 6, fontWeight: 600 }}>№{v.version}</td>
                    <td style={{ padding: 6 }}>{selectRequirementInstances(v.instances).length}</td>
                    <td style={{ padding: 6 }}>{v.printedAt ? formatMoscowDateTime(v.printedAt) : '—'}</td>
                    <td style={{ padding: 6 }}>{v.printedBy || '—'}</td>
                    <td style={{ padding: 6 }}>
                      <Button variant="ghost" onClick={() => printRequirementVersion(v)}>
                        🧾 Печать
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Ф5 (GAP-6): история статусов деталей двигателя (события part_status_event). */}
      {!collapsed && isInventoryStage && partStatusEvents.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Button variant="ghost" onClick={() => setPartStatusHistoryOpen((v) => !v)}>
            {`История статусов деталей (${partStatusEvents.length}) ${partStatusHistoryOpen ? '▲' : '▼'}`}
          </Button>
          {partStatusHistoryOpen && (
            <table className="list-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b' }}>
                  <th style={{ padding: 6 }}>Дата</th>
                  <th style={{ padding: 6 }}>Деталь</th>
                  <th style={{ padding: 6 }}>Кол-во</th>
                  <th style={{ padding: 6 }}>Статус</th>
                  <th style={{ padding: 6 }}>Наряд</th>
                  <th style={{ padding: 6 }}>Кто</th>
                </tr>
              </thead>
              <tbody>
                {partStatusEvents.map((ev) => (
                  <tr key={ev.operationId} style={{ borderTop: '1px solid rgba(15,23,42,0.08)' }}>
                    <td style={{ padding: 6 }}>{formatMoscowDateTime(ev.at)}</td>
                    <td style={{ padding: 6 }}>{ev.partLabel || ev.partId}</td>
                    <td style={{ padding: 6 }}>{ev.qty}</td>
                    <td style={{ padding: 6, color: ev.status === 'ready_for_assembly' ? '#15803d' : '#b45309' }}>
                      {partRepairStatusLabel(ev.status)}
                    </td>
                    <td style={{ padding: 6 }}>{ev.workOrderNumber > 0 ? `№${ev.workOrderNumber}` : '—'}</td>
                    <td style={{ padding: 6 }}>{ev.by || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// B-#4: список деталей двигателя рендерится с table-layout:fixed + <colgroup>, чтобы
// каждый инпут (width:100%) заполнял ячейку и поля выравнивались по колонке. Под
// table-layout:auto Chromium считает ширину колонки по max-content, но width:100%
// инпутов резолвится против indefinite containing block → инпуты садятся на ширину
// содержимого (72–347px) при ровных td. Fixed-раскладка делает ячейку definite →
// width:100% раскрывается ровно. Ширины подобраны по роли колонки: текстовые шире,
// number — с запасом под длинный заголовок («Ремонтопригодная»), чтобы заголовок не
// рвался посреди слова (UI-аудит проход-2 #4); чекбоксы узкие. Сумма (с «Действия»)
// ≈100%; незнакомая колонка → auto (на случай изменения набора колонок шаблона).
const INVENTORY_COL_WIDTHS: Record<string, string> = {
  part_name: '14%',
  assembly_unit_number: '10%',
  part_number: '9%',
  stamped_number: '8%',
  in_completeness_act: '6%',
  in_defect_act: '6%',
  quantity: '5%',
  present: '7%',
  actual_qty: '7%',
  repairable_qty: '8%',
  scrap_qty: '6%',
  replace_qty: '7%',
};
const INVENTORY_ACTIONS_COL_WIDTH = '7%';

function TableEditor(props: {
  tableId?: string;
  canEdit: boolean;
  columns: { id: string; label: string; kind?: 'text' | 'boolean' | 'number' }[];
  rows: Record<string, string | boolean | number>[];
  cellRenderers?: Record<
    string,
    (args: {
      rowIdx: number;
      row: Record<string, string | boolean | number>;
      columnId: string;
      value: string | boolean | number;
      setValue: (rowIdx: number, columnId: string, value: string | boolean | number, save?: boolean) => void;
    }) => React.ReactNode
  >;
  onChange: (rows: Record<string, string | boolean | number>[]) => void;
  onSave: (rows: Record<string, string | boolean | number>[]) => void;
  /**
   * View-time скрытие строки (фильтр по варианту сборки, Этап 5). Строка НЕ удаляется из массива —
   * только не рендерится; индексы, save и brand-sync работают с полным набором.
   */
  isRowHidden?: (row: Record<string, string | boolean | number>, idx: number) => boolean;
  /**
   * Доп. контент под ячейками строки (MVP-2: фото-доказательства дефекта). Рендерится во всю ширину
   * (отдельная строка таблицы / блок в компактной карточке). Возврат null/undefined ничего не добавляет.
   */
  renderRowExtra?: (rowIdx: number, row: Record<string, string | boolean | number>) => React.ReactNode;
}) {
  const { confirm } = useConfirm();
  const cols = props.columns.length ? props.columns : [{ id: 'value', label: 'Значение' }];
  const rows = props.rows ?? [];
  const isDefectItemsTable = props.tableId === 'defect_items';
  const isCompletenessItemsTable = props.tableId === 'completeness_items';
  const isInventoryItemsTable = props.tableId === 'engine_inventory_items';
  const isCompactModeSupported = isDefectItemsTable || isCompletenessItemsTable || isInventoryItemsTable;
  // Список деталей двигателя по умолчанию показываем табличным видом (строки), не компактным.
  const [compactMode, setCompactMode] = useState(isInventoryItemsTable ? false : isCompactModeSupported);
  // Список деталей делится на два сворачиваемых блока; по умолчанию оба свёрнуты.
  const [baseGroupOpen, setBaseGroupOpen] = useState(false);
  const [otherGroupOpen, setOtherGroupOpen] = useState(false);

  // Массовые операции по списку деталей (наличие/корзины ремонта) — только список деталей, с правами.
  const showBulkOps = isInventoryItemsTable && props.canEdit;
  const visibleRowIdxs = rows.map((_, i) => i).filter((i) => !props.isRowHidden?.(rows[i]!, i));
  // Блок «Базовые детали» = деталь входит в акт комплектности ИЛИ дефектовки; «Остальные» — нет.
  const rowInAct = (i: number) =>
    Boolean((rows[i] as any)?.in_completeness_act) || Boolean((rows[i] as any)?.in_defect_act);
  const baseRowIdxs = isInventoryItemsTable ? visibleRowIdxs.filter(rowInAct) : [];
  const otherRowIdxs = isInventoryItemsTable ? visibleRowIdxs.filter((i) => !rowInAct(i)) : [];

  function getColumnSizing(columnId: string): React.CSSProperties | undefined {
    if (isDefectItemsTable) {
      if (columnId === 'part_number') return { minWidth: 140 };
      if (columnId === 'quantity' || columnId === 'repairable_qty' || columnId === 'scrap_qty') return { minWidth: 126 };
      return undefined;
    }
    if (isCompletenessItemsTable) {
      if (columnId === 'quantity' || columnId === 'actual_qty') return { minWidth: 126 };
      return undefined;
    }
    if (isInventoryItemsTable) {
      // Ужатие под ширину окна (13 колонок): без жёстких minWidth, ячейки ПЕРЕНОСЯТ текст.
      // whiteSpace:'normal' инлайном перебивает базовый `.list-table th { white-space: nowrap }`
      // (равная специфичность, base позже по файлу) — иначе при узком окне таблица снова
      // уезжает. table-layout:auto не переносит лишнего, пока есть место. Имени — скромный пол
      // для читаемости, чекбокс-колонки центрируем.
      const wrap: React.CSSProperties = { whiteSpace: 'normal', wordBreak: 'break-word' };
      if (columnId === 'part_name') return { ...wrap, minWidth: 150 };
      if (columnId === 'present' || columnId === 'in_completeness_act' || columnId === 'in_defect_act') {
        return { ...wrap, textAlign: 'center' };
      }
      return wrap;
    }
    return undefined;
  }

  function setCell(rowIdx: number, colId: string, value: string | boolean | number, save = false) {
    const next = rows.map((r, i) => (i === rowIdx ? { ...r, [colId]: value } : r));
    props.onChange(next);
    if (save && props.canEdit) props.onSave(next);
  }

  // Применяет mutate ко всем показанным строкам (скрытые фильтром по варианту — не трогаются).
  function applyBulkToVisible(mutate: (row: Record<string, string | boolean | number>) => Record<string, string | boolean | number>) {
    const next = rows.map((row, i) => (props.isRowHidden?.(row, i) ? row : mutate(row)));
    props.onChange(next);
    if (props.canEdit) props.onSave(next);
  }

  async function bulkPresent(present: boolean) {
    if (visibleRowIdxs.length === 0) return;
    const ok = await confirm({
      detail: `Отметить «${present ? 'на месте' : 'отсутствует'}» для всех показанных строк (${visibleRowIdxs.length})?`,
    });
    if (!ok) return;
    applyBulkToVisible((row) => {
      const qty = Math.max(0, toNumberValue((row as any).quantity ?? 0));
      return { ...row, present, actual_qty: present ? qty : 0 };
    });
  }

  async function bulkDefect(kind: 'repair' | 'scrap' | 'replace') {
    if (visibleRowIdxs.length === 0) return;
    const ru = kind === 'repair' ? 'в ремонт' : kind === 'scrap' ? 'в утиль' : 'на замену';
    const ok = await confirm({
      detail: `Перевести все показанные строки (${visibleRowIdxs.length}) «${ru}»? Текущее распределение по корзинам (ремонт/утиль/замена) будет перезаписано.`,
    });
    if (!ok) return;
    applyBulkToVisible((row) => {
      // Т7: дефектовка только для деталей «на месте» — отсутствующие пропускаем.
      if (!(row as any).present) return row;
      const qty = Math.max(0, toNumberValue((row as any).quantity ?? 0));
      if (kind === 'repair') return { ...row, scrap_qty: 0, replace_qty: 0 };
      if (kind === 'scrap') return { ...row, scrap_qty: qty, replace_qty: 0 };
      return { ...row, replace_qty: qty, scrap_qty: 0 };
    });
  }

  function toNumberValue(value: string | number | boolean): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return 0;
      const num = Number(trimmed);
      return Number.isFinite(num) ? num : 0;
    }
    return 0;
  }

  function getQuantityByRowIndex(rowIdx: number): number {
    const row = rows[rowIdx] ?? {};
    return Math.max(0, toNumberValue((row as any).quantity ?? 0));
  }

  function isReadOnlyNumberColumn(rowIdx: number, columnId: string): boolean {
    if (isDefectItemsTable && (columnId === 'quantity' || columnId === 'repairable_qty')) return true;
    if (isCompletenessItemsTable && columnId === 'quantity') return true;
    if (isCompletenessItemsTable && columnId === 'actual_qty') {
      const row = rows[rowIdx] ?? {};
      return Boolean((row as any).present);
    }
    if (isInventoryItemsTable) {
      if (columnId === 'quantity' || columnId === 'repairable_qty') return true;
      if (columnId === 'actual_qty') {
        const row = rows[rowIdx] ?? {};
        return Boolean((row as any).present);
      }
      // Т7: дефектовка (утиль/замена) заблокирована, пока деталь не отмечена «на месте».
      if (columnId === 'scrap_qty' || columnId === 'replace_qty') {
        const row = rows[rowIdx] ?? {};
        return !(row as any).present;
      }
    }
    return false;
  }

  function canDeleteRow(rowIdx: number): boolean {
    if (!props.canEdit) return false;
    const row = rows[rowIdx] ?? {};
    if ((isDefectItemsTable || isCompletenessItemsTable || isInventoryItemsTable) && isBrandLinkedChecklistRow(row as ChecklistTableRow)) return false;
    return true;
  }

  function renderCellInput(rowIdx: number, column: { id: string; label: string; kind?: 'text' | 'boolean' | 'number' }) {
    const row = rows[rowIdx] ?? {};
    const value = (row as any)?.[column.id];
    const isBrandIdentityFieldLocked =
      isBrandLinkedChecklistRow(row as ChecklistTableRow) &&
      ((isDefectItemsTable && (column.id === 'part_name' || column.id === 'part_number')) ||
        (isCompletenessItemsTable && (column.id === 'part_name' || column.id === 'assembly_unit_number')) ||
        (isInventoryItemsTable && (column.id === 'part_name' || column.id === 'assembly_unit_number' || column.id === 'part_number')));
    const renderer = props.cellRenderers?.[column.id];
    if (renderer) {
      return renderer({ rowIdx, row, columnId: column.id, value, setValue: setCell });
    }

    if (column.kind === 'boolean') {
      return (
        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={Boolean(value)}
            disabled={!props.canEdit}
            onChange={(e) => {
              if (!props.canEdit) return;
              const next = rows.map((row, i) => {
                if (i !== rowIdx) return row;
                const nextRow: Record<string, string | boolean | number> = { ...row, [column.id]: e.target.checked };
                if ((isCompletenessItemsTable || isInventoryItemsTable) && column.id === 'present') {
                  const qty = Math.max(0, toNumberValue((row as any).quantity ?? 0));
                  nextRow.actual_qty = e.target.checked ? qty : 0;
                  // Т7: снятие «на месте» убирает деталь из дефектовки — чистим корзины и восполнение.
                  if (isInventoryItemsTable && !e.target.checked) {
                    nextRow.scrap_qty = 0;
                    nextRow.replace_qty = 0;
                    nextRow.replenishment_branch = '';
                  }
                }
                return nextRow;
              });
              props.onChange(next);
              props.onSave(next);
            }}
          />
          <span style={{ color: '#6b7280', fontSize: 12 }}>{value ? 'да' : 'нет'}</span>
        </label>
      );
    }

    if (column.kind === 'number') {
      const readOnly = isReadOnlyNumberColumn(rowIdx, column.id);
      const maxQty = getQuantityByRowIndex(rowIdx);
      // Список деталей в табличном виде ужимается под ширину окна: число заполняет ячейку,
      // степперы +/- скрыты (13 колонок иначе не влезают). Компактный режим и листы
      // дефектовки/комплектности сохраняют степперы.
      const numberFitMode = isInventoryItemsTable && !compactMode;
      const lockedByPresence =
        isInventoryItemsTable &&
        (column.id === 'scrap_qty' || column.id === 'replace_qty') &&
        !(rows[rowIdx] as any)?.present;
      return (
        <div
          style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}
          title={lockedByPresence ? 'Сначала отметьте «На месте» в комплектности — тогда деталь попадёт в дефектовку' : undefined}
        >
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={String(value ?? '')}
            style={numberFitMode ? { width: '100%', minWidth: 0 } : { minWidth: 72, maxWidth: compactMode ? 110 : undefined }}
            disabled={!props.canEdit || readOnly}
            onChange={(e) => {
              const raw = e.target.value;
              if (!/^\d*$/.test(raw)) return;
              if (raw === '') {
                setCell(rowIdx, column.id, '');
                return;
              }
              let next = Number(raw);
              if (isDefectItemsTable && column.id === 'scrap_qty') next = Math.min(next, maxQty);
              if (isCompletenessItemsTable && column.id === 'actual_qty') next = Math.min(next, maxQty);
              if (isInventoryItemsTable && (column.id === 'actual_qty' || column.id === 'scrap_qty' || column.id === 'replace_qty')) {
                next = Math.min(next, maxQty);
              }
              setCell(rowIdx, column.id, next);
            }}
            onBlur={() => {
              if (!props.canEdit || readOnly) return;
              const current = (rows[rowIdx] as any)?.[column.id];
              if (current === '' || current == null || Number.isNaN(current)) {
                setCell(rowIdx, column.id, 0, true);
                return;
              }
              props.onSave(rows);
            }}
          />
          {!numberFitMode && (
          <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
            <button
              type="button"
              onClick={() => {
                const readOnly = isReadOnlyNumberColumn(rowIdx, column.id);
                if (!props.canEdit || readOnly) return;
                const next = Math.max(0, toNumberValue((rows[rowIdx] as any)?.[column.id]) - 1);
                setCell(rowIdx, column.id, next, true);
              }}
              style={{
                width: 30,
                height: 28,
                borderRadius: 6,
                border: '1px solid var(--input-border)',
                background: 'var(--input-bg)',
                color: 'var(--text)',
                cursor: props.canEdit && !isReadOnlyNumberColumn(rowIdx, column.id) ? 'pointer' : 'not-allowed',
              }}
              aria-label="Уменьшить"
              disabled={!props.canEdit || isReadOnlyNumberColumn(rowIdx, column.id)}
            >
              -
            </button>
            <button
              type="button"
              onClick={() => {
                const readOnly = isReadOnlyNumberColumn(rowIdx, column.id);
                if (!props.canEdit || readOnly) return;
                let next = toNumberValue((rows[rowIdx] as any)?.[column.id]) + 1;
                const maxQty = getQuantityByRowIndex(rowIdx);
                if ((isDefectItemsTable && column.id === 'scrap_qty') || (isCompletenessItemsTable && column.id === 'actual_qty')) {
                  next = Math.min(next, maxQty);
                }
                if (isInventoryItemsTable && (column.id === 'actual_qty' || column.id === 'scrap_qty' || column.id === 'replace_qty')) {
                  next = Math.min(next, maxQty);
                }
                setCell(rowIdx, column.id, next, true);
              }}
              style={{
                width: 30,
                height: 28,
                borderRadius: 6,
                border: '1px solid var(--input-border)',
                background: 'var(--input-bg)',
                color: 'var(--text)',
                cursor: props.canEdit && !isReadOnlyNumberColumn(rowIdx, column.id) ? 'pointer' : 'not-allowed',
              }}
              aria-label="Увеличить"
              disabled={!props.canEdit || isReadOnlyNumberColumn(rowIdx, column.id)}
            >
              +
            </button>
          </div>
          )}
        </div>
      );
    }

    return (
      <Input
        value={String(value ?? '')}
        style={isDefectItemsTable && column.id === 'part_number' ? { minWidth: 120 } : undefined}
        disabled={!props.canEdit || isBrandIdentityFieldLocked}
        onChange={(e) => setCell(rowIdx, column.id, e.target.value)}
        onBlur={() => props.canEdit && props.onSave(rows)}
      />
    );
  }

  function renderDeleteButton(idx: number) {
    return (
      <Button
        variant="ghost"
        onClick={() => {
          void (async () => {
            if (!canDeleteRow(idx)) return;
            const row = rows[idx] as Record<string, unknown>;
            const partNo = isDefectItemsTable ? String(row?.part_number ?? '').trim() : '';
            const node = isCompletenessItemsTable ? String(row?.node_label ?? row?.part_number ?? '').trim() : '';
            const inv = isInventoryItemsTable
              ? String(row?.part_number ?? row?.assembly_unit_number ?? row?.part_name ?? '').trim()
              : '';
            const hint = partNo || node || inv || String(row?.[cols[0]?.id ?? 'value'] ?? '').trim().slice(0, 120);
            const tableRu =
              props.tableId === 'defect_items'
                ? 'листа дефектовки'
                : props.tableId === 'completeness_items'
                  ? 'акта комплектности'
                  : props.tableId === 'engine_inventory_items'
                    ? 'списка деталей двигателя'
                    : 'таблицы';
            const ok = await confirm({
              detail: `Будет удалена строка ${idx + 1} ${tableRu}${hint ? ` (данные: «${hint}»)` : ''}.`,
            });
            if (!ok) return;
            const next = rows.filter((_, i) => i !== idx);
            props.onChange(next);
            props.onSave(next);
          })();
        }}
        title={canDeleteRow(idx) ? undefined : 'Строка из марки двигателя обновляется автоматически'}
        disabled={!canDeleteRow(idx)}
      >
        Удалить
      </Button>
    );
  }

  // Табличный рендер заданного набора строк (по абсолютным индексам — setCell/удаление их используют).
  function renderDataTable(idxList: number[]) {
    return (
      <table className={`list-table${isInventoryItemsTable ? ' list-table--single-mode' : ''}`} style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        {isInventoryItemsTable && (
          <colgroup>
            {cols.map((c) => (
              <col key={c.id} style={{ width: INVENTORY_COL_WIDTHS[c.id] ?? 'auto' }} />
            ))}
            {props.canEdit && <col style={{ width: INVENTORY_ACTIONS_COL_WIDTH }} />}
          </colgroup>
        )}
        <thead>
          <tr style={{ background: 'linear-gradient(135deg, #2563eb 0%, #7c3aed 120%)', color: '#fff' }}>
            {cols.map((c) => (
              <th
                key={c.id}
                style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, ...(getColumnSizing(c.id) ?? {}) }}
              >
                {c.label}
              </th>
            ))}
            {props.canEdit && (
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, ...(isInventoryItemsTable ? {} : { minWidth: 150 }) }}>Действия</th>
            )}
          </tr>
        </thead>
        <tbody>
          {idxList.map((idx) => {
            const row = rows[idx]!;
            const extra = props.renderRowExtra?.(idx, row);
            return (
              <tr key={idx}>
                {cols.map((c) => (
                  <td key={c.id} style={{ borderBottom: '1px solid rgba(15, 23, 42, 0.10)', padding: 8, ...(getColumnSizing(c.id) ?? {}) }}>
                    {renderCellInput(idx, c)}
                  </td>
                ))}
                {props.canEdit && (
                  <td style={{ borderBottom: '1px solid rgba(15, 23, 42, 0.10)', padding: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      {extra}
                      {renderDeleteButton(idx)}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
          {idxList.length === 0 && (
            <tr>
              <td colSpan={cols.length + (props.canEdit ? 1 : 0)} style={{ padding: 10, color: '#64748b' }}>
                Пусто
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  }

  // Компактный рендер (карточки) заданного набора строк.
  function renderCompactList(idxList: number[]) {
    return (
      <div style={{ padding: 10 }}>
        {idxList.map((idx) => {
          const r = rows[idx]!;
          const extra = props.renderRowExtra?.(idx, r);
          return (
            <div key={idx} style={{ border: '1px solid rgba(15, 23, 42, 0.12)', borderRadius: 10, padding: 10, marginBottom: 8, background: '#ffffff' }}>
              {cols.map((c) => (
                <div key={c.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 34%) 1fr', gap: 10, alignItems: 'start', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: '#334155', paddingTop: 7 }}>{c.label}</div>
                  <div style={{ minWidth: 0 }}>{renderCellInput(idx, c)}</div>
                </div>
              ))}
              {props.canEdit ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 4 }}>
                  {extra}
                  {renderDeleteButton(idx)}
                </div>
              ) : extra ? (
                <div style={{ marginTop: 4 }}>{extra}</div>
              ) : null}
            </div>
          );
        })}
        {idxList.length === 0 && <div style={{ padding: 10, color: '#64748b' }}>Пусто</div>}
      </div>
    );
  }

  // Сворачиваемый блок списка деталей двигателя.
  function renderGroup(title: string, idxList: number[], open: boolean, onToggle: () => void) {
    return (
      <div style={{ borderTop: '1px solid rgba(15, 23, 42, 0.08)' }}>
        <button
          type="button"
          onClick={onToggle}
          style={{
            width: '100%',
            textAlign: 'left',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            background: 'rgba(37, 99, 235, 0.06)',
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            color: '#1e293b',
          }}
        >
          <span>{open ? '▼' : '▶'}</span>
          <span>{title}</span>
          <span style={{ color: '#64748b', fontWeight: 400 }}>({idxList.length})</span>
        </button>
        {open ? (compactMode ? renderCompactList(idxList) : renderDataTable(idxList)) : null}
      </div>
    );
  }

  return (
    // `overflow-x: auto` here forces overflow-y to a scroll container, which captures the
    // sticky `<th>` context and unpins the column header on scroll. The inventory table is
    // single-mode (cells wrap, width:100%) so it never needs horizontal scroll → use `clip`
    // there to keep sticky headers attached to the real (card) scroller. The fixed-layout
    // defect/completeness tables keep `auto` for their horizontal scroll.
    <div style={{ border: '1px solid rgba(15, 23, 42, 0.18)', borderRadius: 12, overflowX: isInventoryItemsTable ? 'clip' : 'auto', overflowY: isInventoryItemsTable ? 'visible' : 'hidden' }}>
      {isCompactModeSupported && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid rgba(15, 23, 42, 0.1)' }}>
          <div style={{ color: '#64748b', fontSize: 12 }}>
            {compactMode ? 'Компактный режим: заполнение по строкам без горизонтальной прокрутки' : 'Табличный режим'}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155' }}>
            <input type="checkbox" checked={compactMode} onChange={(e) => setCompactMode(e.target.checked)} />
            <span>Компактный режим</span>
          </label>
        </div>
      )}
      {showBulkOps && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid rgba(15, 23, 42, 0.1)' }}>
          <span style={{ fontSize: 12, color: '#334155' }}>Массовые операции:</span>
          <Button variant="ghost" onClick={() => void bulkPresent(true)}>Все на месте</Button>
          <Button variant="ghost" onClick={() => void bulkPresent(false)}>Все отсутствуют</Button>
          <span style={{ width: 1, height: 18, background: 'rgba(15, 23, 42, 0.15)', margin: '0 2px' }} />
          <Button variant="ghost" onClick={() => void bulkDefect('repair')}>Все в ремонт</Button>
          <Button variant="ghost" onClick={() => void bulkDefect('scrap')}>Все в утиль</Button>
          <Button variant="ghost" onClick={() => void bulkDefect('replace')}>Все заменить</Button>
        </div>
      )}
      {isInventoryItemsTable ? (
        <>
          {renderGroup('Базовые детали (в актах)', baseRowIdxs, baseGroupOpen, () => setBaseGroupOpen((v) => !v))}
          {renderGroup('Остальные детали', otherRowIdxs, otherGroupOpen, () => setOtherGroupOpen((v) => !v))}
        </>
      ) : compactMode ? (
        renderCompactList(visibleRowIdxs)
      ) : (
        renderDataTable(visibleRowIdxs)
      )}
      {props.canEdit && !isInventoryItemsTable && (
        <div style={{ padding: 10, display: 'flex', gap: 10 }}>
          <Button
            variant="ghost"
            onClick={() => {
              const next = [
                ...rows,
                Object.fromEntries(cols.map((c) => [c.id, c.kind === 'boolean' ? false : c.kind === 'number' ? 0 : ''])),
              ];
              props.onChange(next);
              props.onSave(next);
            }}
          >
            Добавить строку
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * MVP-2: фото-доказательства дефекта на уровне строки списка деталей. Свёрнуто за кнопкой
 * «📷 Фото (N)»; разворачивает переиспользованную AttachmentsPanel, привязанную к строке
 * (значение/onChange ходят через мета-ключ `__photos` строки, см. withRowPhotos/getRowPhotos).
 */
function InventoryRowPhotos(props: {
  photos: FileRef[];
  canView: boolean;
  canUpload: boolean;
  scope?: { ownerType: string; ownerId: string; category: string };
  onChange: (next: FileRef[]) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!props.canView) return null;
  const count = props.photos.length;
  return (
    <div>
      <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
        {`📷 Фото${count ? ` (${count})` : ''} ${open ? '▲' : '▼'}`}
      </Button>
      {open && (
        <AttachmentsPanel
          title="Фото детали (доказательство дефекта)"
          value={props.photos}
          canView={props.canView}
          canUpload={props.canUpload}
          {...(props.scope ? { scope: props.scope } : {})}
          onChange={(next) => {
            props.onChange(next);
          }}
        />
      )}
    </div>
  );
}


