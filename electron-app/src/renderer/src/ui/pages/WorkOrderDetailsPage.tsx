import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  NOMENCLATURE_ITEM_TYPE_HAS_STOCK,
  NOMENCLATURE_ITEM_TYPE_LABELS,
  WORK_ORDER_KIND_DESCRIPTIONS,
  WORK_ORDER_KIND_LABELS,
  WORK_ORDER_KIND_ORDER,
  WORK_ORDER_PRINT_FONT_DEFAULTS,
  WORK_ORDER_SIGNATURE_CAPTION_SUGGESTIONS,
  WORK_ORDER_STATUS_LABELS,
  WorkOrderKind,
  deriveWorkOrderStatusCode,
  formatEmployeeInitialsSurname,
  getWorkOrderSignatureBlocks,
  resolveWorkOrderApprover,
  resolveWorkOrderSignatureSlots,
  workOrderSignatureBlockAliases,
  isWorkOrderTemplateKind,
  normalizeWorkOrderLine,
  type NomenclatureItemType,
  type WorkOrderPayload,
  type WorkOrderPrintSettings,
  type WorkOrderSignatureBlockSelection,
  type WorkOrderSignatureSlot,
  type WorkOrderTemplateLine,
  type WorkOrderTemplateSummary,
  type WorkOrderWorkGroup,
  type WorkOrderWorkLine,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { EntityCardShell } from '../components/EntityCardShell.js';
import { Input } from '../components/Input.js';
import { RowReorderButtons } from '../components/RowReorderButtons.js';
import { SectionCard } from '../components/SectionCard.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { WorkOrderTemplateEditorDialog } from '../components/WorkOrderTemplateEditorDialog.js';
import { WorkOrderPrintDialog } from '../components/WorkOrderPrintDialog.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { formatAssemblyVariantLabel } from '../utils/assemblyVariant.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { moveArrayItem } from '../utils/moveArrayItem.js';
import { buildWorkOrderA4PreviewHtml, escapeHtml, openPrintPreview, type PrintSection } from '../utils/printPreview.js';
import { buildSearchOption, joinOptionHint, joinOptionSearch } from '../utils/selectOptions.js';

type LinkOpt = SearchSelectOption;
type ServiceInfo = { id: string; name: string; unit: string; priceRub: number; partIds: string[]; engineBrandIds: string[] };
type EmployeeInfo = {
  id: string;
  displayName: string;
  fullName?: string;
  lastName?: string;
  firstName?: string;
  middleName?: string;
  personnelNumber?: string | null;
  departmentName?: string | null;
  workshopId?: string | null;
  position?: string | null;
  employmentStatus?: string | null;
};
type EngineInfo = { id: string; engineNumber?: string; engineBrandId?: string | null; engineBrandName?: string; contractId?: string | null; customerId?: string | null };
/** Резолвленные для печати реквизиты по двигателю: суффикс номера контракта (***NNN) + контрагент. */
type EngineContractInfo = { contractSuffix: string; counterparty: string };

/**
 * Суффикс основного номера контракта для печати: «***» + последние 3 цифры части
 * номера ДО первого «/». Напр. «2325187913551442245231239/27/ГОЗ-24» → «***239».
 * Пустая строка, если цифр нет.
 */
function contractNumberSuffix(mainNumber: string | null | undefined): string {
  const beforeSlash = String(mainNumber ?? '').split('/')[0] ?? '';
  const digits = beforeSlash.replace(/\D/g, '');
  const last3 = digits.slice(-3);
  return last3 ? `***${last3}` : '';
}
type PartInfo = { id: string; name: string; article?: string; sku?: string; itemType?: NomenclatureItemType };

function normalizeLookupValue(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * «Последние использованные» подписанты — локально у оператора (D1: per-machine).
 * Когда поле выбора сотрудника в подписи пустое, эти ФИО показываются в выпадающем
 * списке первыми (выпадающий список — это options в порядке recent-first).
 */
const RECENT_SIGNATURE_EMPLOYEES_KEY = 'wo:recentSignatureEmployees';
const RECENT_SIGNATURE_EMPLOYEES_CAP = 8;
function readRecentSignatureEmployeeIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SIGNATURE_EMPLOYEES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function pushRecentSignatureEmployeeId(id: string): void {
  if (!id) return;
  const next = [id, ...readRecentSignatureEmployeeIds().filter((x) => x !== id)].slice(0, RECENT_SIGNATURE_EMPLOYEES_CAP);
  try {
    localStorage.setItem(RECENT_SIGNATURE_EMPLOYEES_KEY, JSON.stringify(next));
  } catch {
    /* localStorage недоступен — деградируем молча */
  }
}

function toInputDate(ms: number | null | undefined) {
  if (!ms) return '';
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
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function money(v: number) {
  return `${Math.round((Number(v) || 0) * 100) / 100} ₽`;
}

function safeNum(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toCents(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100);
}

function fromCents(value: number): number {
  return Math.round(value) / 100;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((x) => String(x || '').trim()).filter((x) => x.length > 0);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter((x) => x.length > 0);
    } catch {
      // ignore invalid JSON
    }
  }
  return [];
}

function normalizeLine(line: unknown, lineNo: number): WorkOrderWorkLine {
  return normalizeWorkOrderLine(line, lineNo);
}

function distributeByKtu(
  totalAmountRub: number,
  crew: Array<{ ktu: number; payoutFrozen: boolean; manualPayoutRub: number }>,
): number[] {
  const totalCents = toCents(Math.max(0, safeNum(totalAmountRub, 0)));
  const frozenCentsByIndex = crew.map((member) => (member.payoutFrozen ? toCents(Math.max(0, safeNum(member.manualPayoutRub, 0))) : 0));
  const frozenTotalCents = frozenCentsByIndex.reduce((acc, value) => acc + value, 0);
  const remainingCents = Math.max(0, totalCents - frozenTotalCents);

  const unfrozen = crew
    .map((member, index) => ({ index, ktu: Math.max(0.01, safeNum(member.ktu, 1)), frozen: member.payoutFrozen }))
    .filter((entry) => !entry.frozen);
  const totalKtu = unfrozen.reduce((acc, entry) => acc + entry.ktu, 0);

  const payoutsCents = [...frozenCentsByIndex];
  if (unfrozen.length === 0 || totalKtu <= 0 || remainingCents <= 0) {
    for (const entry of unfrozen) payoutsCents[entry.index] = 0;
    return payoutsCents.map(fromCents);
  }

  const weighted = unfrozen.map((entry) => {
    const raw = (remainingCents * entry.ktu) / totalKtu;
    const floor = Math.floor(raw);
    return { index: entry.index, floor, remainder: raw - floor };
  });

  let remainder = remainingCents - weighted.reduce((acc, row) => acc + row.floor, 0);
  weighted.sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.index - b.index;
  });
  for (let i = 0; i < weighted.length && remainder > 0; i += 1) {
    const row = weighted[i];
    if (row) { row.floor += 1; remainder -= 1; }
  }

  for (const row of weighted) payoutsCents[row.index] = row.floor;
  return payoutsCents.map(fromCents);
}

// Phase 3b: cardType key for this editor's recovery drafts (window.matrica.drafts.*).
const WORK_ORDER_DRAFT_TYPE = 'work_order';

function recalcLocally(payload: WorkOrderPayload): WorkOrderPayload {
  const rawPayload = payload as any;
  const groupsSource: Array<{ groupId: string; partId: string | null; partName: string; lines: any[] }> = [];
  const freeSource: any[] = [];
  const hasV2Shape = Array.isArray(rawPayload.workGroups) || Array.isArray(rawPayload.freeWorks);

  if (hasV2Shape) {
    const groups = Array.isArray(rawPayload.workGroups) ? rawPayload.workGroups : [];
    for (let idx = 0; idx < groups.length; idx += 1) {
      const group = groups[idx] ?? {};
      groupsSource.push({
        groupId: String(group.groupId ?? `group-${idx + 1}`),
        partId: group.partId ? String(group.partId) : null,
        partName: String(group.partName ?? ''),
        lines: Array.isArray(group.lines) ? group.lines : [],
      });
    }
    if (Array.isArray(rawPayload.freeWorks)) freeSource.push(...rawPayload.freeWorks);
  } else {
    const legacyWorks = Array.isArray(rawPayload.works) ? rawPayload.works : [];
    const legacyPartId = rawPayload.partId ? String(rawPayload.partId) : null;
    const legacyPartName = String(rawPayload.partName ?? '');
    if (legacyPartId || legacyPartName.trim().length > 0) {
      groupsSource.push({ groupId: 'legacy-main-group', partId: legacyPartId, partName: legacyPartName, lines: legacyWorks });
    } else {
      freeSource.push(...legacyWorks);
    }
  }

  const workGroups: WorkOrderWorkGroup[] = groupsSource.map((group, idx) => ({
    groupId: group.groupId || `group-${idx + 1}`,
    partId: group.partId ? String(group.partId) : null,
    partName: String(group.partName ?? ''),
    lines: (Array.isArray(group.lines) ? group.lines : []).map((line, lineIdx) => normalizeLine(line, lineIdx + 1)),
  }));
  const freeWorks: WorkOrderWorkLine[] = freeSource.map((line, idx) => normalizeLine(line, idx + 1));

  const works = [...workGroups.flatMap((group) => group.lines), ...freeWorks].map((line, idx) => ({
    ...line,
    lineNo: idx + 1,
  }));
  const totalAmountRub = fromCents(works.reduce((acc, line) => acc + toCents(safeNum(line.amountRub, 0)), 0));
  const crew = (Array.isArray(rawPayload.crew) ? rawPayload.crew : []).map((member: any) => {
    const ktu = Math.max(0.01, safeNum(member?.ktu, 1));
    const payoutFrozen = Boolean(member?.payoutFrozen);
    const manualPayoutRub = Math.max(0, safeNum(member?.manualPayoutRub ?? member?.payoutRub, 0));
    return {
      employeeId: String(member?.employeeId ?? ''),
      employeeName: String(member?.employeeName ?? ''),
      ktu,
      payoutFrozen,
      manualPayoutRub,
    };
  });
  type CrewEntry = { employeeId: string; employeeName: string; ktu: number; payoutFrozen: boolean; manualPayoutRub: number };
  const payoutValues = distributeByKtu(totalAmountRub, crew);
  const payouts = crew.map((member: CrewEntry, idx: number) => ({
    employeeId: member.employeeId,
    employeeName: member.employeeName,
    ktu: member.ktu,
    amountRub: payoutValues[idx] ?? 0,
  }));

  const result: WorkOrderPayload = {
    ...payload,
    version: 2,
    workGroups,
    freeWorks,
    works,
    crew: crew.map((member: CrewEntry, idx: number) => ({
      ...member,
      payoutRub: payoutValues[idx] ?? 0,
      ...(member.payoutFrozen ? { manualPayoutRub: member.manualPayoutRub } : {}),
    })),
    totalAmountRub,
    basePerWorkerRub: crew.length > 0 ? fromCents(toCents(totalAmountRub / crew.length)) : 0,
    payouts,
    partId: null,
  };
  delete result.partName;
  return result;
}

export function WorkOrderDetailsPage(props: {
  id: string;
  /** Phase 2 (deferred-create): seed for a freshly-created, not-yet-saved order — its chosen
   * kind etc. The operations row does not exist yet; first save materializes it. */
  initialPayload?: WorkOrderPayload;
  onClose: () => void;
  canEdit: boolean;
  canEditMasterData: boolean;
  canCreateParts?: boolean;
  canCreateEmployees?: boolean;
  canCloseWorkOrders?: boolean;
  canEditWorkshopRepairTemplates?: boolean;
  canEditWorkOrderTemplates?: boolean;
  onOpenPart?: (partId: string) => void;
  onOpenService?: (serviceId: string) => void;
  onOpenEmployee?: (employeeId: string) => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
}) {
  const [payload, setPayload] = useState<WorkOrderPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [employees, setEmployees] = useState<EmployeeInfo[]>([]);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [engineContractInfo, setEngineContractInfo] = useState<Record<string, EngineContractInfo>>({});
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [parts, setParts] = useState<PartInfo[]>([]);
  const [workshops, setWorkshops] = useState<Array<{ id: string; code: string; name: string; isActive: boolean }>>([]);
  const [assemblyVariantGroups, setAssemblyVariantGroups] = useState<string[]>([]);
  // Stage 2 нитки assembly-work-order-from-forecast: список складов для колонки
  // «Склад деталей» в Assembly-наряде. Подгружается при первом открытии карточки.
  const [warehouseLocations, setWarehouseLocations] = useState<
    Array<{ id: string; type: 'system' | 'workshop' | 'regular'; code: string; name: string; workshopId: string | null; isActive: boolean }>
  >([]);
  const [closing, setClosing] = useState(false);
  const [closedLocally, setClosedLocally] = useState(false);
  /** Текущий статус операции из локальной SQLite (после refresh). 'closed' блокирует редактирование. */
  const [operationStatus, setOperationStatus] = useState<string>('open');
  const [operationUpdatedAt, setOperationUpdatedAt] = useState<number>(0);
  const isClosed = operationStatus === 'closed' || closedLocally;
  const canEditNow = props.canEdit && !isClosed;
  const dirtyRef = useRef(false);
  // Phase 3b: debounced recovery-draft autosave. draftTimerRef debounces writes;
  // draftRestoredRef makes the open-time restore run once per card mount (so an
  // explicit reset reloads the committed payload instead of re-reviving the draft).
  const draftTimerRef = useRef<number | null>(null);
  const draftRestoredRef = useRef(false);
  const { confirm } = useConfirm();

  function buildDraftTitle(p: WorkOrderPayload): string {
    const num = Number(p.workOrderNumber ?? 0);
    const date = p.orderDate ? formatMoscowDate(p.orderDate) : '';
    const label = num > 0 ? `№${num}` : '(новый)';
    return `Наряд ${label}${date ? ` от ${date}` : ''}`;
  }

  async function saveDraftNow(p: WorkOrderPayload, kind: 'recovery' | 'explicit' = 'recovery') {
    if (!canEditNow) return false;
    try {
      const r = await window.matrica.drafts.save({
        cardType: WORK_ORDER_DRAFT_TYPE,
        cardId: props.id,
        kind,
        title: buildDraftTitle(p),
        payloadJson: JSON.stringify(p),
        baseUpdatedAt: operationUpdatedAt || null,
      });
      return Boolean(r?.ok);
    } catch {
      // autosave is best-effort — a write failure must never block editing
      return false;
    }
  }

  async function clearDraft() {
    try {
      await window.matrica.drafts.clear({ cardType: WORK_ORDER_DRAFT_TYPE, cardId: props.id });
    } catch {
      // best-effort
    }
  }

  // Универсальные шаблоны нарядов (Stage 5 нитки work-order-template-system).
  // Загружаются по `payload.workOrderKind`. Применение копирует payloadOverrides и lines
  // в payload + freeWorks. Hidden_fields из шаблона сохраняем в local state — UI скрытия
  // полей карточки добавляется отдельным PR (Stage 5b).
  const [availableWorkOrderTemplates, setAvailableWorkOrderTemplates] = useState<WorkOrderTemplateSummary[]>([]);
  const [selectedWorkOrderTemplateId, setSelectedWorkOrderTemplateId] = useState<string>('');
  const [workOrderTemplateBusy, setWorkOrderTemplateBusy] = useState(false);
  const [workOrderTemplateEditor, setWorkOrderTemplateEditor] = useState<
    { templateId: string | null; defaultKind: WorkOrderKind } | null
  >(null);
  /** Set of payload field keys hidden from the card UI by the last-applied template.
   * Lives only for the current session — closing and re-opening the card resets it. */
  const [appliedHiddenFields, setAppliedHiddenFields] = useState<Set<string>>(new Set());

  useEffect(() => {
    void (async () => {
      try {
        const r = await window.matrica.workshops.list({ activeOnly: true });
        if (r.ok) setWorkshops(r.rows);
      } catch {
        /* non-fatal */
      }
    })();
    void (async () => {
      try {
        const r = await window.matrica.warehouseLocations.list({ activeOnly: true });
        if (r.ok) {
          setWarehouseLocations(
            r.rows.map((row) => ({
              id: row.id,
              type: row.type,
              code: row.code,
              name: row.name,
              workshopId: row.workshopId,
              isActive: row.isActive,
            })),
          );
        }
      } catch {
        /* non-fatal */
      }
    })();
  }, []);

  // Загрузка списка универсальных шаблонов нарядов по kind. Workshop-template
  // (legacy 5-й тип) не имеет своих универсальных шаблонов — пропускаем.
  useEffect(() => {
    if (!payload || !isWorkOrderTemplateKind(payload.workOrderKind)) {
      setAvailableWorkOrderTemplates([]);
      setSelectedWorkOrderTemplateId('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await window.matrica.workOrderTemplates.list({ kind: payload.workOrderKind as WorkOrderKind });
        if (cancelled) return;
        if (r?.ok) setAvailableWorkOrderTemplates(r.templates);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payload?.workOrderKind]);

  // Phase 2.4 PR 1: dropdown «Склад» в строках Assembly-наряда теперь включает любые активные
  // локации (workshop + regular + system). Значение — warehouse_locations.id (uuid), backend
  // резолвит как новый формат напрямую. Старые строки с legacy `workshop_<code>` остаются
  // совместимыми — backend (reserve/release/post) принимает оба формата на время миграции.
  const warehouseSourceOptions = useMemo(
    () =>
      warehouseLocations
        .filter((w) => w.isActive)
        .map((w) => ({ id: w.id, label: w.name })),
    [warehouseLocations],
  );

  const primaryAssemblyEngineBrandId = useMemo(() => {
    if (!payload || payload.workOrderKind !== WorkOrderKind.Assembly) return null;
    for (const line of payload.freeWorks) {
      const id = String(line?.engineBrandId ?? '').trim();
      if (id) return id;
    }
    return null;
  }, [payload]);

  useEffect(() => {
    if (!primaryAssemblyEngineBrandId) {
      setAssemblyVariantGroups([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const listRes = await window.matrica.warehouse.assemblyBomList({
          engineBrandId: primaryAssemblyEngineBrandId,
          status: 'active',
        });
        if (!alive || !listRes?.ok) return;
        const list = (listRes.rows ?? []) as Array<Record<string, unknown>>;
        const primary = list.find((row) => Boolean(row.isDefault)) ?? list[0];
        if (!primary) {
          setAssemblyVariantGroups([]);
          return;
        }
        const detailsRes = await window.matrica.warehouse.assemblyBomGet(String(primary.id));
        if (!alive || !detailsRes?.ok) return;
        // assemblyBomGet returns { ok, bom: { header, lines } } — lines are under .bom.lines.
        const lines = Array.isArray((detailsRes as any).bom?.lines) ? ((detailsRes as any).bom.lines as Array<{ variantGroup?: string | null }>) : [];
        const seen = new Set<string>();
        for (const line of lines) {
          const vg = String(line?.variantGroup ?? '').trim();
          if (vg) seen.add(vg);
        }
        if (!alive) return;
        setAssemblyVariantGroups([...seen].sort((a, b) => a.localeCompare(b, 'ru')));
      } catch {
        if (alive) setAssemblyVariantGroups([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [primaryAssemblyEngineBrandId]);

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        if (payload && canEditNow) {
          await flushSave(payload);
        }
        dirtyRef.current = false;
        await clearDraft();
      },
      reset: async () => {
        await refresh();
        dirtyRef.current = false;
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
        void clearDraft();
      },
      copyToNew: async () => {
        if (!payload) return;
        await copyToNewWorkOrder(payload);
      },
      keepDraft: async () => {
        if (draftTimerRef.current != null) {
          window.clearTimeout(draftTimerRef.current);
          draftTimerRef.current = null;
        }
        if (payload && canEditNow) await saveDraftNow(payload);
        dirtyRef.current = false;
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
  }, [payload, props.registerCardCloseActions, props.id]);

  // Реквизиты контракта/контрагента для печати: резолвим двигатель наряда → контракт
  // (основной номер → ***NNN) и контрагент (краткое наименование, иначе полное) из EAV.
  const orderEngineIdsKey = useMemo(
    () => Array.from(new Set((payload?.freeWorks ?? []).map((l) => String(l.engineId ?? '').trim()).filter(Boolean))).sort().join(','),
    [payload?.freeWorks],
  );
  useEffect(() => {
    const engineIds = orderEngineIdsKey ? orderEngineIdsKey.split(',') : [];
    if (!engineIds.length || engines.length === 0) {
      setEngineContractInfo({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const out: Record<string, EngineContractInfo> = {};
      for (const engineId of engineIds) {
        const engine = engines.find((e) => e.id === engineId);
        if (!engine) continue;
        let contractSuffix = '';
        let customerId = String(engine.customerId ?? '').trim();
        if (engine.contractId) {
          const c = await window.matrica.admin.entities.get(engine.contractId).catch(() => null);
          const attrs = ((c as any)?.attributes ?? {}) as Record<string, unknown>;
          contractSuffix = contractNumberSuffix(attrs.number == null ? '' : String(attrs.number));
          if (!customerId && attrs.customer_id) customerId = String(attrs.customer_id);
        }
        let counterparty = '';
        if (customerId) {
          const cust = await window.matrica.admin.entities.get(customerId).catch(() => null);
          const cattrs = ((cust as any)?.attributes ?? {}) as Record<string, unknown>;
          counterparty = String(cattrs.short_name ?? '').trim() || String(cattrs.name ?? '').trim();
        }
        out[engineId] = { contractSuffix, counterparty };
      }
      if (!cancelled) setEngineContractInfo(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [orderEngineIdsKey, engines]);

  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const allServiceOptions: LinkOpt[] = useMemo(
    () =>
      services.map((s) => {
        const hint = joinOptionHint([s.unit && `Ед. ${s.unit}`, `Цена ${money(s.priceRub)}`]);
        const search = joinOptionSearch([s.name, s.id, s.unit, s.priceRub, ...s.partIds]);
        return buildSearchOption({
          id: s.id,
          label: `${s.name} (${s.unit || 'ед.'}, ${money(s.priceRub)})`,
          ...(hint ? { hintText: hint } : {}),
          ...(search ? { searchText: search } : {}),
        });
      }),
    [services],
  );
  const employeeOptions: LinkOpt[] = useMemo(
    () =>
      employees.map((e) => {
        const hint = joinOptionHint([
          e.personnelNumber && `Таб. ${e.personnelNumber}`,
          e.position,
          e.departmentName,
        ]);
        const search = joinOptionSearch([e.displayName, e.id, e.personnelNumber, e.position, e.departmentName]);
        return buildSearchOption({
          id: e.id,
          label: e.displayName,
          ...(hint ? { hintText: hint } : {}),
          ...(search ? { searchText: search } : {}),
        });
      }),
    [employees],
  );
  // Кандидаты в утверждающие грифа: сотрудник → готовое ФИО «И.О. Фамилия» (как в пресетах грифа).
  const approverEmployees = useMemo(
    () =>
      employees
        .map((e) => ({
          id: e.id,
          label: e.displayName,
          grifName: formatEmployeeInitialsSurname({ fullName: e.displayName, position: e.position ?? null }),
          ...(e.position ? { hintText: String(e.position) } : {}),
        }))
        .filter((e) => e.label && e.grifName),
    [employees],
  );
  const [recentSignatureEmployeeIds, setRecentSignatureEmployeeIds] = useState<string[]>(() => readRecentSignatureEmployeeIds());
  const rememberSignatureEmployee = (id: string) => {
    pushRecentSignatureEmployeeId(id);
    setRecentSignatureEmployeeIds(readRecentSignatureEmployeeIds());
  };
  /** Опции выбора подписанта с «последними использованными» вверху (recent-first). */
  const signatureEmployeeOptions: LinkOpt[] = useMemo(() => {
    if (!recentSignatureEmployeeIds.length) return employeeOptions;
    const byId = new Map(employeeOptions.map((o) => [o.id, o] as const));
    const recent = recentSignatureEmployeeIds
      .map((id) => byId.get(id))
      .filter((o): o is LinkOpt => Boolean(o));
    if (!recent.length) return employeeOptions;
    const recentSet = new Set(recent.map((o) => o.id));
    return [...recent, ...employeeOptions.filter((o) => !recentSet.has(o.id))];
  }, [employeeOptions, recentSignatureEmployeeIds]);
  // Кастомные формулировки подписей из общей БД (D1: формулировки шарятся на всех клиентов).
  const [customSignatureCaptions, setCustomSignatureCaptions] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.matrica.signatureCaptions
      .list()
      .then((r) => {
        if (!cancelled && r.ok) setCustomSignatureCaptions(r.captions);
      })
      .catch(() => {
        /* офлайн/нет прав — деградируем к встроенным подсказкам */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  /** Подсказки datalist: встроенные роли + кастомные из БД (дедуп без учёта регистра/ё). */
  const captionSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of [...WORK_ORDER_SIGNATURE_CAPTION_SUGGESTIONS, ...customSignatureCaptions]) {
      const key = String(c).replace(/\s+/g, ' ').trim().toLowerCase().replaceAll('ё', 'е');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }, [customSignatureCaptions]);
  const knownCaptionKeys = useMemo(
    () => new Set(captionSuggestions.map((c) => c.replace(/\s+/g, ' ').trim().toLowerCase().replaceAll('ё', 'е'))),
    [captionSuggestions],
  );
  /** Сохранить новую формулировку в общую БД (по выходу из поля), если её ещё нет. */
  const persistSignatureCaption = (raw: string) => {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const key = text.toLowerCase().replaceAll('ё', 'е');
    if (knownCaptionKeys.has(key)) return;
    setCustomSignatureCaptions((prev) => (prev.includes(text) ? prev : [...prev, text]));
    void window.matrica.signatureCaptions.add({ text }).catch(() => {
      /* не критично — подсказка останется локально на эту сессию */
    });
  };
  const engineOptions: LinkOpt[] = useMemo(
    () =>
      engines.map((e) => {
        const hint = joinOptionHint([e.engineNumber, e.engineBrandName]);
        const search = joinOptionSearch([e.engineNumber || '', e.id, e.engineBrandName || '']);
        return buildSearchOption({
          id: e.id,
          label: e.engineNumber || e.id,
          ...(hint ? { hintText: hint } : {}),
          ...(search ? { searchText: search } : {}),
        });
      }),
    [engines],
  );
  const partOptions: LinkOpt[] = useMemo(
    () =>
      parts.map((p) => {
        const typeLabel = p.itemType ? NOMENCLATURE_ITEM_TYPE_LABELS[p.itemType] : null;
        const hint = joinOptionHint([typeLabel, p.article && `Артикул ${p.article}`]);
        // Ищем и по реальному артикулу (code), и по sku (DET-зеркало). В подпись добавляем
        // артикул, чтобы одинаково названные позиции («Насос водяной») различались — как в Ревизии ремфонда.
        const search = joinOptionSearch([p.name, p.id, p.article, p.sku, typeLabel]);
        return buildSearchOption({
          id: p.id,
          label: p.article ? `${p.name} (${p.article})` : p.name,
          ...(hint ? { hintText: hint } : {}),
          ...(search ? { searchText: search } : {}),
        });
      }),
    [parts],
  );

  async function loadRefs() {
    try {
      const emps = await window.matrica.employees.list().catch(() => [] as any[]);
      setEmployees(
        (emps as any[]).map((x): EmployeeInfo => ({
          id: String(x.id),
          displayName: String(x.displayName || x.fullName || x.id),
          ...(x.fullName ? { fullName: String(x.fullName) } : {}),
          ...(x.lastName ? { lastName: String(x.lastName) } : {}),
          ...(x.firstName ? { firstName: String(x.firstName) } : {}),
          ...(x.middleName ? { middleName: String(x.middleName) } : {}),
          personnelNumber: x.personnelNumber ? String(x.personnelNumber) : null,
          departmentName: x.departmentName ? String(x.departmentName) : null,
          workshopId: x.workshopId ? String(x.workshopId) : null,
          position: x.position ? String(x.position) : null,
          employmentStatus: x.employmentStatus ? String(x.employmentStatus) : null,
        })),
      );

      const et = await window.matrica.admin.entityTypes.list().catch(() => [] as any[]);
      const serviceType = (et as any[]).find((x) => String(x.code) === 'service');
      if (!serviceType?.id) {
        setServices([]);
        return;
      }
      const list = await window.matrica.admin.entities.listByEntityType(String(serviceType.id)).catch(() => [] as any[]);
      const details = await Promise.all(
        (list as any[]).slice(0, 2000).map(async (row) => {
          const d = await window.matrica.admin.entities.get(String(row.id)).catch(() => null);
          const attrs = (d as any)?.attributes ?? {};
          return {
            id: String(row.id),
            name: String(attrs.name || row.displayName || row.id),
            unit: String(attrs.unit || 'шт'),
            priceRub: Math.max(0, safeNum(attrs.price, 0)),
            partIds: normalizeStringArray(attrs.part_ids),
            engineBrandIds: normalizeStringArray(attrs.engine_brand_ids),
          } as ServiceInfo;
        }),
      );
      setServices(details.filter((x) => x.name.trim().length > 0));

      // Загрузка двигателей
      const engineList = await window.matrica.engines.list().catch(() => [] as any[]);
      const engineInfo = (engineList as any[]).map((e) => ({
        id: String(e.id),
        engineNumber: String(e.engineNumber ?? ''),
        engineBrandId: e.engineBrandId ? String(e.engineBrandId) : null,
        engineBrandName: String(e.engineBrand ?? ''),
        contractId: e.contractId ? String(e.contractId) : null,
        customerId: e.customerId ? String(e.customerId) : null,
      } as EngineInfo));
      setEngines(engineInfo);

      // Загрузка изделий из складской номенклатуры — единый источник истины.
      // Берём все позиции с остатками (HAS_STOCK), т.е. всё кроме service.
      // Это видит и зеркала старых деталей (spec_json.source=part, тот же UUID),
      // и позиции, забитые напрямую в номенклатуру (например, готовые узлы и продукты).
      const nomResult = await window.matrica.warehouse.nomenclatureList({ limit: 5000 }).catch(() => null);
      if (nomResult && nomResult.ok && Array.isArray(nomResult.rows)) {
        const partInfo = nomResult.rows
          .filter((row: Record<string, unknown>) => {
            const itemType = String(row.itemType ?? '') as NomenclatureItemType;
            return Boolean(NOMENCLATURE_ITEM_TYPE_HAS_STOCK[itemType]) && Boolean(row.isActive ?? true);
          })
          .map((row: Record<string, unknown>): PartInfo => {
            const itemType = String(row.itemType ?? '') as NomenclatureItemType;
            // Реальный человеческий артикул — `code` (напр. 411-00-35А). `sku` у мигрированных
            // зеркал — авто-код вида DET-<id>, поэтому показываем/ищем по code, а sku оставляем
            // только в поиске (чтобы старые DET-коды тоже находились). Иначе деталь индексируется
            // под мусорным DET-кодом и не находится по своему настоящему артикулу.
            const code = row.code ? String(row.code) : '';
            const sku = row.sku ? String(row.sku) : '';
            const article = code || sku;
            return {
              id: String(row.id),
              name: String(row.name ?? '').trim() || String(row.id),
              ...(article ? { article } : {}),
              ...(sku && sku !== article ? { sku } : {}),
              ...(itemType ? { itemType } : {}),
            };
          })
          .filter((p) => p.name.trim().length > 0)
          .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        setParts(partInfo);
      } else {
        setParts([]);
      }
    } catch {
      setServices([]);
      setEmployees([]);
      setEngines([]);
      setParts([]);
    }
  }

  async function refresh() {
    setLoading(true);
    const r = await window.matrica.workOrders.get(props.id);
    if (!r.ok) {
      // Phase 2 (deferred-create): no operations row yet. Seed from a recovery draft (crash of a
      // new order) or, for a fresh create this session, from initialPayload. First save
      // materializes the row + number. An empty fresh card stays non-dirty → no row, no draft.
      setOperationStatus('draft');
      setOperationUpdatedAt(0);
      setClosedLocally(false);
      let seeded = false;
      if (props.canEdit && !draftRestoredRef.current) {
        try {
          const d = await window.matrica.drafts.get({ cardType: WORK_ORDER_DRAFT_TYPE, cardId: props.id });
          if (d.ok && d.draft?.payloadJson) {
            setPayload(recalcLocally(JSON.parse(d.draft.payloadJson) as WorkOrderPayload));
            dirtyRef.current = true;
            draftRestoredRef.current = true;
            seeded = true;
            setStatus('Восстановлены несохранённые изменения — «Сохранить» зафиксирует их');
          }
        } catch {
          // corrupt/absent draft → fall through to initialPayload
        }
      }
      if (!seeded && props.initialPayload) {
        setPayload(recalcLocally(props.initialPayload));
        dirtyRef.current = false;
        seeded = true;
        setStatus('');
      }
      if (!seeded) {
        setStatus(`Ошибка загрузки: ${r.error}`);
        setPayload(null);
      }
      setLoading(false);
      return;
    }
    const committed = recalcLocally(r.payload);
    const opStatus = String(r.status ?? 'open');
    setOperationStatus(opStatus);
    setOperationUpdatedAt(Number(r.updatedAt ?? 0));
    setClosedLocally(false);

    // Phase 3b: revive an unsaved recovery snapshot if one survived a crash / forced close.
    // Once per card mount (draftRestoredRef) so an explicit reset reloads the committed copy.
    const editable = props.canEdit && opStatus !== 'closed';
    let restored = false;
    if (editable && !draftRestoredRef.current) {
      try {
        const d = await window.matrica.drafts.get({ cardType: WORK_ORDER_DRAFT_TYPE, cardId: props.id });
        if (d.ok && d.draft?.payloadJson) {
          setPayload(recalcLocally(JSON.parse(d.draft.payloadJson) as WorkOrderPayload));
          dirtyRef.current = true;
          draftRestoredRef.current = true;
          restored = true;
          setStatus('Восстановлены несохранённые изменения — «Сохранить» зафиксирует их');
        }
      } catch {
        // corrupt/absent draft → fall back to the committed payload
      }
    }
    if (!restored) {
      setPayload(committed);
      setStatus('');
      dirtyRef.current = false;
    }
    setLoading(false);
  }

  async function copyToNewWorkOrder(sourcePayload: WorkOrderPayload) {
    const created = await window.matrica.workOrders.create();
    if (!created.ok) {
      setStatus(`Ошибка копирования: ${created.error}`);
      return;
    }

    const copyPayload: WorkOrderPayload = {
      ...sourcePayload,
      workOrderNumber: 0, // fresh number assigned on materialize (deferred-create)
      orderDate: Number(created.payload.orderDate ?? Date.now()),
    };
    // Дата печати привязана к исходному наряду — в копии печатаем её собственную дату.
    if (copyPayload.printSettings?.orderDateOverride != null) {
      const { orderDateOverride: _drop, ...restPrint } = copyPayload.printSettings;
      if (Object.keys(restPrint).length) copyPayload.printSettings = restPrint;
      else delete copyPayload.printSettings;
    }

    const saved = await window.matrica.workOrders.update({
      id: created.id,
      payload: copyPayload,
    });
    if (!saved.ok) {
      setStatus(`Ошибка копирования: ${saved.error}`);
      return;
    }
    setStatus(`Создан новый наряд №${saved.workOrderNumber ?? ''}`);
  }

  useEffect(() => {
    void Promise.all([refresh(), loadRefs()]);
  }, [props.id]);

  // Phase 3b: debounced recovery-draft autosave. Fires ~1.5s after the last edit while the
  // card is dirty & editable; each new edit cancels the pending write (true debounce). The
  // snapshot persists to card_drafts (synced, owner-private) so a crash / forced close /
  // "оставить черновик" leaves the unsaved work recoverable on next start.
  useEffect(() => {
    if (!canEditNow || !payload || !dirtyRef.current) return;
    const snapshot = payload;
    const timer = window.setTimeout(() => {
      void saveDraftNow(snapshot);
    }, 1500);
    draftTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (draftTimerRef.current === timer) draftTimerRef.current = null;
    };
  }, [payload, canEditNow]);

  async function flushSave(next: WorkOrderPayload) {
    if (!canEditNow) return;
    // Cancel any pending autosave so it can't re-write the draft after the commit clears it below.
    if (draftTimerRef.current != null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    const r = await window.matrica.workOrders.update({ id: props.id, payload: recalcLocally(next) });
    if (!r.ok) {
      setStatus(`Ошибка сохранения: ${r.error}`);
      return;
    }
    // Phase 2: first save materializes the order and assigns the number — reflect it in the open
    // card (the «№ новый» placeholder becomes the assigned number) so the operator sees it.
    const assigned = Number(r.workOrderNumber ?? 0);
    if (assigned > 0 && Number(next.workOrderNumber ?? 0) !== assigned) {
      setPayload((prev) => (prev ? recalcLocally({ ...prev, workOrderNumber: assigned }) : prev));
    }
    setStatus('Сохранено');
    dirtyRef.current = false;
    // A commit supersedes the recovery snapshot — drop it (any standalone «Сохранить», not just
    // the close-guard path). A later edit re-arms autosave with a fresh draft.
    await clearDraft();
  }

  function patch(next: WorkOrderPayload) {
    const normalized = recalcLocally(next);
    dirtyRef.current = true;
    setPayload(normalized);
  }

  /**
   * Ремонтный наряд «выдан в работу» ⇄ «отозван». Только выданные ремнаряды учитываются
   * прогнозом сборки как будущий приход отремонтированных деталей (нитка «выдан в работу»).
   * Сохраняется сразу (флаг `repairIssued` едет в metaJson → backend-прогноз читает его).
   */
  async function toggleRepairIssued() {
    if (!payload || !canEditNow) return;
    const nextIssued = !payload.repairIssued;
    const next = recalcLocally({ ...payload, repairIssued: nextIssued });
    setPayload(next);
    await flushSave(next);
    setStatus(nextIssued ? 'Наряд выдан в работу — детали учтены в прогнозе сборки' : 'Наряд отозван из работы');
  }

  /** Maps WorkOrderTemplateLine → WorkOrderWorkLine. nomenclatureId/serviceId are
   * optional, lines may also carry productNumber/engineId/engineNumber/engineBrandId/
   * engineBrandName. */
  function buildLinesFromWorkOrderTemplate(template: WorkOrderTemplateLine[]): WorkOrderWorkLine[] {
    return template.map((row, idx) => {
      const svc = row.serviceId ? serviceById.get(row.serviceId) ?? null : null;
      const partId = row.nomenclatureId ?? null;
      const partName = partId ? parts.find((p) => p.id === partId)?.name ?? '' : '';
      const qty = row.defaultQty ?? 0;
      const line: WorkOrderWorkLine = {
        lineNo: idx + 1,
        serviceId: svc?.id ?? null,
        serviceName: svc?.name ?? row.serviceName ?? '',
        unit: svc?.unit || row.unit || '',
        qty,
        priceRub: svc?.priceRub ?? 0,
        amountRub: 0,
      };
      if (partId) {
        line.partId = partId;
        if (partName) line.partName = partName;
      }
      if (row.productNumber) line.productNumber = row.productNumber;
      if (row.engineId) line.engineId = row.engineId;
      if (row.engineNumber) line.engineNumber = row.engineNumber;
      if (row.engineBrandId) line.engineBrandId = row.engineBrandId;
      if (row.engineBrandName) line.engineBrandName = row.engineBrandName;
      return line;
    });
  }

  /** Apply a universal work-order template to the open card. Confirms replace when the
   * card already has freeWorks rows. payloadOverrides are merged into payload via spread. */
  async function applyWorkOrderTemplate(templateId: string): Promise<void> {
    if (!payload) return;
    if (workOrderTemplateBusy) return;
    setWorkOrderTemplateBusy(true);
    try {
      const r = await window.matrica.workOrderTemplates.get(templateId);
      if (!r?.ok) {
        setStatus(`Не удалось загрузить шаблон: ${r?.error ?? 'unknown'}`);
        return;
      }
      const tmpl = r.template;
      if (tmpl.workOrderKind !== payload.workOrderKind) {
        setStatus('Шаблон относится к другому типу наряда — нельзя применить.');
        return;
      }
      if (payload.freeWorks.length > 0) {
        const ok = await confirm({
          title: 'Применить шаблон?',
          detail: `В наряде уже есть ${payload.freeWorks.length} строк. Применение заменит их строками из шаблона «${tmpl.name}». Продолжить?`,
          confirmLabel: 'Применить',
          cancelLabel: 'Отмена',
          confirmTone: 'warn',
        });
        if (!ok) return;
      }
      const newLines = buildLinesFromWorkOrderTemplate(tmpl.lines);
      // Race guard: справочник parts может ещё не загрузиться к моменту применения —
      // тогда partName/partArticle пустые (в печати «—»). Дозагружаем такие позиции по id.
      await Promise.all(
        newLines
          .filter((line) => line.partId && !String(line.partName ?? '').trim())
          .map(async (line) => {
            const r = await window.matrica.warehouse.nomenclatureList({ id: line.partId as string, limit: 1 }).catch(() => null);
            const row = r && r.ok ? r.rows[0] : undefined;
            if (!row) return;
            if (row.name) line.partName = String(row.name);
            const article = String((row as Record<string, unknown>).code ?? '').trim();
            if (article && !String(line.partArticle ?? '').trim()) line.partArticle = article;
          }),
      );
      const overrides = (tmpl.payloadOverrides ?? {}) as Partial<WorkOrderPayload>;
      // Цех из шаблона («где взять деталь») → склад-источник каждой строки: резолвим
      // цех в его warehouse_location (склад цеха) и проставляем в sourceWarehouseId.
      // Дальше склад правится в каждой строке как обычно.
      const templateWorkshopId = String((overrides.workshopId ?? payload.workshopId) ?? '').trim();
      if (templateWorkshopId) {
        const workshop = workshops.find((w) => w.id === templateWorkshopId);
        const location = warehouseLocations.find(
          (w) =>
            (w.workshopId && w.workshopId === templateWorkshopId) ||
            (workshop != null && w.type === 'workshop' && w.code === `workshop_${workshop.code}`),
        );
        if (location) {
          for (const line of newLines) line.sourceWarehouseId = location.id;
        }
      }
      const next = { ...payload, ...overrides, freeWorks: newLines } as WorkOrderPayload;
      patch(next);
      setAppliedHiddenFields(new Set(tmpl.hiddenFields));
      const hidNote = tmpl.hiddenFields.length > 0 ? `, скрыто полей: ${tmpl.hiddenFields.length}` : '';
      setStatus(`Применён шаблон «${tmpl.name}»: ${newLines.length} строк${hidNote}.`);
    } finally {
      setWorkOrderTemplateBusy(false);
    }
  }

  function findExistingServiceByLabel(label: string, partId: string | null): ServiceInfo | null {
    const key = normalizeLookupValue(label);
    if (!key) return null;
    const exact = services.find((service) => normalizeLookupValue(service.name) === key);
    if (!exact) return null;
    if (!partId) return exact;
    if (exact.partIds.length === 0 || exact.partIds.includes(partId)) return exact;
    return exact;
  }

  function findExistingEmployeeByLabel(label: string): EmployeeInfo | null {
    const key = normalizeLookupValue(label);
    if (!key) return null;
    return employees.find((employee) => normalizeLookupValue(employee.displayName) === key) ?? null;
  }

  function applyServiceSnapshotToLines(lines: WorkOrderWorkLine[], idx: number, serviceId: string | null): WorkOrderWorkLine[] {
    if (!serviceId) {
      return lines.map((line, lineIdx) =>
        lineIdx === idx ? { ...line, serviceId: null, serviceName: '', unit: '', priceRub: 0, amountRub: 0 } : line,
      );
    }
    const service = serviceById.get(serviceId);
    if (!service) return lines;
    return lines.map((line, lineIdx) =>
      lineIdx === idx
        ? {
            ...line,
            serviceId: service.id,
            serviceName: service.name,
            unit: service.unit,
            priceRub: service.priceRub,
          }
        : line,
    );
  }

  async function createServiceFromWorkOrder(
    label: string,
    partId: string | null,
    opts?: { engineBrandId?: string | null },
  ): Promise<string | null> {
    if (!props.canEditMasterData) return null;
    const clean = label.trim();
    if (!clean) return null;
    const existing = findExistingServiceByLabel(clean, partId);
    if (existing?.id) {
      setStatus(`Использована существующая услуга: ${existing.name}`);
      return existing.id;
    }
    const types = await window.matrica.admin.entityTypes.list().catch(() => [] as any[]);
    const serviceType = (types as any[]).find((x) => String(x.code) === 'service');
    if (!serviceType?.id) {
      setStatus('Справочник услуг не найден');
      return null;
    }
    const created = await window.matrica.admin.entities.create(String(serviceType.id));
    if (!created?.ok || !created?.id) {
      const err = !created?.ok && created && 'error' in created ? (created as { error: string }).error : 'unknown';
      setStatus(`Ошибка создания услуги: ${err}`);
      return null;
    }
    await window.matrica.admin.entities.setAttr(created.id, 'name', clean);
    await window.matrica.admin.entities.setAttr(created.id, 'unit', 'шт');
    await window.matrica.admin.entities.setAttr(created.id, 'price', 0);
    if (partId) {
      await window.matrica.admin.entities.setAttr(created.id, 'part_ids', [partId]);
    }
    /** Если строка наряда привязана к двигателю — сразу проставляем марку, чтобы новая услуга
     *  попала в отфильтрованный список без необходимости открывать карточку. */
    const brandId = opts?.engineBrandId ? String(opts.engineBrandId).trim() : '';
    if (brandId) {
      await window.matrica.admin.entities.setAttr(created.id, 'engine_brand_ids', [brandId]);
    }
    return created.id;
  }

  async function createEmployeeFromWorkOrder(label: string): Promise<string | null> {
    if (props.canCreateEmployees !== true) return null;
    const clean = label.trim();
    if (!clean) return null;
    const existing = findExistingEmployeeByLabel(clean);
    if (existing?.id) {
      setStatus(`Использован существующий сотрудник: ${existing.displayName}`);
      return existing.id;
    }
    const created = await window.matrica.employees.create();
    if (!created?.ok || !created?.id) {
      const err = !created?.ok && created && 'error' in created ? (created as { error: string }).error : 'unknown';
      setStatus(`Ошибка создания сотрудника: ${err}`);
      return null;
    }
    const parts = clean.split(/\s+/).filter(Boolean);
    const lastName = parts[0] ?? clean;
    const firstName = parts[1] ?? '';
    const middleName = parts.slice(2).join(' ');
    await window.matrica.employees.setAttr(created.id, 'last_name', lastName);
    if (firstName) await window.matrica.employees.setAttr(created.id, 'first_name', firstName);
    if (middleName) await window.matrica.employees.setAttr(created.id, 'middle_name', middleName);
    await window.matrica.employees.setAttr(created.id, 'full_name', clean);
    setEmployees((prev) => [...prev, { id: created.id, displayName: clean }].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru')));
    return created.id;
  }

  function moveCrewMember(from: number, to: number) {
    if (!payload) return;
    patch({ ...payload, crew: moveArrayItem(payload.crew, from, to) });
  }

  function moveFreeWorkLine(from: number, to: number) {
    if (!payload) return;
    patch({
      ...payload,
      freeWorks: moveArrayItem(payload.freeWorks, from, to).map((line, idx) => ({ ...line, lineNo: idx + 1 })),
    });
  }

  function addFreeWorkLine() {
    if (!payload) return;
    patch({
      ...payload,
      freeWorks: [...payload.freeWorks, { lineNo: payload.freeWorks.length + 1, serviceId: null, serviceName: '', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0, productNumber: '', engineId: null, engineNumber: '', engineBrandId: null, engineBrandName: '', partId: null, partName: '' }],
    });
  }

  function setSignatureSlots(blockId: string, slots: WorkOrderSignatureSlot[]) {
    if (!payload) return;
    // Стрипаем и legacy-id блока, чтобы материализация заменяла старую запись, а не дублировала.
    const aliases = workOrderSignatureBlockAliases(blockId);
    const others = (payload.signatureBlocks ?? []).filter((b) => !aliases.includes(b.blockId));
    const next: WorkOrderSignatureBlockSelection[] = slots.length ? [...others, { blockId, slots }] : others;
    patch({ ...payload, signatureBlocks: next });
  }

  /** Подразделение подписанта для печати: цех (по workshop_id) если задан, иначе подразделение. */
  function resolveEmployeeUnit(employee: EmployeeInfo | undefined): string {
    if (!employee) return '';
    const wsId = String(employee.workshopId ?? '').trim();
    if (wsId) {
      const ws = workshops.find((w) => w.id === wsId);
      if (ws?.name) return ws.name;
    }
    return String(employee.departmentName ?? '').trim();
  }

  /** Имя изделия для печати/строк: сохранённое, иначе по partId из справочника. */
  function resolvePartName(line: WorkOrderWorkLine): string {
    const stored = String(line.partName ?? '').trim();
    if (stored) return stored;
    const partId = String(line.partId ?? '').trim();
    if (!partId) return '';
    return parts.find((p) => p.id === partId)?.name ?? '';
  }

  function resolvePartArticle(line: WorkOrderWorkLine): string {
    const stored = String(line.partArticle ?? '').trim();
    if (stored) return stored;
    const partId = String(line.partId ?? '').trim();
    if (!partId) return '';
    return parts.find((p) => p.id === partId)?.article ?? '';
  }

  function buildPrintModel(current: WorkOrderPayload, settings: WorkOrderPrintSettings) {
    const fs = {
      director: settings.fontDirector ?? WORK_ORDER_PRINT_FONT_DEFAULTS.director,
      title: settings.fontTitle ?? WORK_ORDER_PRINT_FONT_DEFAULTS.title,
      meta: settings.fontMeta ?? WORK_ORDER_PRINT_FONT_DEFAULTS.meta,
      crew: settings.fontCrew ?? WORK_ORDER_PRINT_FONT_DEFAULTS.crew,
      works: settings.fontWorks ?? WORK_ORDER_PRINT_FONT_DEFAULTS.works,
      signatures: settings.fontSignatures ?? WORK_ORDER_PRINT_FONT_DEFAULTS.signatures,
    };
    // Дата печати всегда = дата наряда: сохранённые orderDateOverride (в т.ч. залипшие
    // от старых клиентов/умолчаний) игнорируются — «застрявшая» дата и была этой граблей.
    const printDate = current.orderDate;
    // Mirror the on-screen template field-hiding for the work-line columns this card supports.
    const showService = !appliedHiddenFields.has('serviceName');
    const showPrice = !appliedHiddenFields.has('priceRub');
    const showAmount = !appliedHiddenFields.has('amountRub');

    // Наряд на сборку: марка/№ двигателя и вид работ одинаковы во всех строках — выносим их
    // в шапку и убираем повторяющиеся колонки из таблицы работ (только для Assembly-наряда).
    const isAssembly = current.workOrderKind === WorkOrderKind.Assembly;
    const distinctTrimmed = (vals: Array<string | null | undefined>) =>
      Array.from(new Set(vals.map((v) => String(v ?? '').trim()).filter(Boolean)));
    const headerEngineBrand = distinctTrimmed(current.freeWorks.map((l) => l.engineBrandName)).join(', ') || '—';
    const headerEngineNumber = distinctTrimmed(current.freeWorks.map((l) => l.engineNumber)).join(', ') || '—';
    const headerWorkTypes = distinctTrimmed(current.freeWorks.map((l) => l.serviceName));
    const headerWorkType = headerWorkTypes.length === 1 ? headerWorkTypes[0]! : 'Сборка двигателя';

    const showEngineCols = !isAssembly;
    const showServiceCol = showService && !isAssembly;
    // Наряд на сборку: вместо цены/суммы показываем склад-источник детали (откуда её брать).
    const showPriceCol = showPrice && !isAssembly;
    const showAmountCol = showAmount && !isAssembly;
    const warehouseNameById = new Map(warehouseLocations.map((w) => [w.id, w.name]));
    const warehouseNameByCode = new Map(warehouseLocations.map((w) => [w.code, w.name]));
    const resolveSourceWarehouseName = (rawId: string | null | undefined) => {
      const raw = String(rawId ?? '').trim();
      if (!raw) return 'Склад цеха (по умолчанию)';
      const byId = raw.includes('-') && raw.length >= 32 ? warehouseNameById.get(raw) : undefined;
      return byId ?? warehouseNameByCode.get(raw) ?? raw;
    };
    const linesTable = (lines: WorkOrderWorkLine[]) =>
      lines.length
        ? `<table><thead><tr>${showEngineCols ? '<th>№ двигателя</th><th>Марка</th>' : ''}${
            showServiceCol ? '<th>Вид работ</th>' : ''
          }<th>Наименование изделия</th><th>Артикул</th><th>№ изделия</th><th>Кол-во</th><th>Ед.</th>${
            isAssembly ? '<th>Склад</th>' : ''
          }${showPriceCol ? '<th>Цена</th>' : ''}${showAmountCol ? '<th>Сумма</th>' : ''}</tr></thead><tbody>${lines
            .map(
              (line) =>
                `<tr>${
                  showEngineCols
                    ? `<td>${escapeHtml(line.engineNumber || '—')}</td><td>${escapeHtml(line.engineBrandName || '—')}</td>`
                    : ''
                }${showServiceCol ? `<td>${escapeHtml(line.serviceName || '—')}</td>` : ''}<td>${escapeHtml(
                  resolvePartName(line) || '—',
                )}</td><td>${escapeHtml(resolvePartArticle(line) || '—')}</td><td>${escapeHtml(line.productNumber || '—')}</td><td>${escapeHtml(
                  String(line.qty ?? 0),
                )}</td><td>${escapeHtml(line.unit || '—')}</td>${
                  isAssembly ? `<td>${escapeHtml(resolveSourceWarehouseName(line.sourceWarehouseId))}</td>` : ''
                }${showPriceCol ? `<td>${escapeHtml(money(line.priceRub ?? 0))}</td>` : ''}${
                  showAmountCol ? `<td>${escapeHtml(money(line.amountRub ?? 0))}</td>` : ''
                }</tr>`,
            )
            .join('')}</tbody></table>`
        : `<div class="muted">Нет данных</div>`;

    const crewHtml = current.crew.length
      ? `<table><thead><tr><th>Сотрудник</th><th>КТУ</th><th>Начислено</th><th>Заморозка</th></tr></thead><tbody>${current.crew
          .map((member) => {
            return `<tr><td>${escapeHtml(member.employeeName || '—')}</td><td>${escapeHtml(String(member.ktu ?? 1))}</td><td>${escapeHtml(
              money(member.payoutRub ?? 0),
            )}</td><td>${member.payoutFrozen ? 'Да' : 'Нет'}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : `<div class="muted">Нет данных</div>`;

    const worksHtml = `${linesTable(current.freeWorks)}${
      showAmountCol
        ? `<div class="wo-print-works-footer" style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:13px;"><strong>Итог:</strong> ${escapeHtml(
            money(current.totalAmountRub || 0),
          )}</div>`
        : ''
    }`;

    // Подписи: блоки зависят от типа наряда. В каждом блоке — строки-подписи (слоты):
    // роль (свободный текст) + сотрудник (расшифровка «И.О. Фамилия» + должность из
    // карточки) либо пустой слот под подпись/расшифровку/должность от руки. По две
    // подписи в строку (inline-block ~48%). Пустых слотов по умолчанию нет — их
    // добавляет оператор кнопкой; блок без слотов не печатается.
    const employeeById = new Map(employees.map((e) => [e.id, e] as const));
    const sigName = fs.signatures;
    const sigCap = Math.max(9, fs.signatures - 1);
    const sigPos = Math.max(9, fs.signatures - 2);
    const sigTitle = fs.signatures + 1;
    const signCell = (slot: WorkOrderSignatureSlot) => {
      const caption = String(slot.caption ?? '').trim();
      const employee = slot.employeeId ? employeeById.get(slot.employeeId) : undefined;
      const name = employee ? formatEmployeeInitialsSurname(employee) : '';
      // Под должностью — подразделение/цех подписанта (цех по workshop_id, иначе подразделение).
      const positionLine = [String(employee?.position ?? '').trim(), resolveEmployeeUnit(employee)].filter(Boolean).join(' · ');
      const nameCell = name
        ? `<span style="font-size:${sigName}px;white-space:nowrap;">${escapeHtml(name)}</span>`
        : `<span style="display:inline-block;width:120px;border-bottom:1px solid #94a3b8;"></span>`;
      return `<div style="width:100%;margin:5px 0 0;">${
        caption ? `<div style="font-size:${sigCap}px;color:#334155;margin-bottom:1px;">${escapeHtml(caption)}</div>` : ''
      }<div style="display:flex;align-items:flex-end;gap:8px;"><span style="flex:1;border-bottom:1px solid #0f172a;height:14px;"></span>${nameCell}</div><div style="text-align:center;font-size:${sigPos}px;color:#64748b;margin-top:1px;min-height:11px;">${escapeHtml(
        positionLine,
      )}</div></div>`;
    };
    // Два блока подписей — рядом (Выдача | Завершение): экономит высоту под 1 лист A4.
    const signaturesHtml = `<div style="display:flex;gap:4%;align-items:flex-start;">${getWorkOrderSignatureBlocks(
      current.workOrderKind,
    )
      .map((def) => {
        const slots = resolveWorkOrderSignatureSlots(def, current.signatureBlocks);
        if (!slots.length) return '';
        // Пустая строка даты под запись от руки (план — в блоке выдачи, факт — в блоке выполнения).
        const dateLine = def.dateLineLabel
          ? `<div style="font-size:${sigName}px;margin:1px 0 2px;">${escapeHtml(
              def.dateLineLabel,
            )}: <span style="display:inline-block;min-width:110px;border-bottom:1px solid #0f172a;"></span></div>`
          : '';
        return `<div style="flex:1;min-width:0;break-inside:avoid-page;page-break-inside:avoid;"><div style="font-weight:700;font-size:${sigTitle}px;margin-bottom:1px;">${escapeHtml(
          def.title,
        )}</div>${dateLine}${slots.map((slot) => signCell(slot)).join('')}</div>`;
      })
      .join('')}</div>`;

    // Шапка: гриф директора (справа), заголовок (по центру) и строка реквизитов (таблицей) —
    // три независимых блока, каждый со своим размером шрифта (общего масштаба шапки больше нет).
    const firstWorkType = distinctTrimmed(current.freeWorks.map((l) => l.serviceName))[0] ?? (isAssembly ? headerWorkType : '');
    const autoTitle = firstWorkType ? `Наряд на ${firstWorkType}` : `Наряд №${current.workOrderNumber || '—'}`;
    const headerTitle = settings.titleOverride?.trim() || autoTitle;
    // Реквизиты по первому двигателю наряда: суффикс контракта (***NNN) + контрагент.
    const firstEngineId = current.freeWorks.map((l) => String(l.engineId ?? '').trim()).find(Boolean) ?? '';
    const contractInfo = firstEngineId ? engineContractInfo[firstEngineId] : undefined;

    // Гриф утверждения (ГОСТ Р 7.0.97 — верхний правый угол, над заголовком).
    // Вариант (директор / технический директор) и, при желании, своя должность + выбранный
    // из базы сотрудник выбираются оператором на каждый наряд.
    const approvalLinePx = Math.round(160 * (fs.director / WORK_ORDER_PRINT_FONT_DEFAULTS.director));
    const approver = resolveWorkOrderApprover(settings);
    // Полная дата создания наряда — слева, на одном уровне с грифом (вариант Б, 2026-07-03).
    const createdDateHtml =
      settings.hideOrderDate || !printDate
        ? ''
        : `<div style="font-size:${fs.meta + 1}px;font-weight:600;">${formatMoscowDate(printDate)}</div>`;
    const approvalHtml = `<div style="display:flex;justify-content:space-between;align-items:flex-start;">${createdDateHtml}<div style="margin-left:auto;text-align:right;font-size:${fs.director}px;line-height:1.4;"><div style="font-weight:700;">Утверждаю</div><div>${escapeHtml(approver.position)}</div><div style="margin-top:14px;"><span style="display:inline-block;width:${approvalLinePx}px;border-bottom:1px solid #0f172a;"></span>&nbsp;${escapeHtml(approver.name)}</div></div></div>`;
    const titleHtml = `<div style="text-align:center;font-size:${fs.title}px;font-weight:700;line-height:1.25;">${escapeHtml(headerTitle)}</div>`;

    // Строка реквизитов — таблицей. Колонки двигателя только у сборки (вынесены из строк работ),
    // контракт/заказчик — если резолвятся. Каждое значение в своей ячейке.
    // Плановые даты и цех наряда — печатаются по умолчанию, каждую можно снять
    // галочкой в панели печати (settings.hide*).
    const workshop = workshops.find((w) => w.id === String(current.workshopId ?? '').trim());
    // Плановые даты — без года (ДД.ММ): год виден в дате создания у грифа.
    const shortDate = (ms: number | undefined) => (ms ? formatMoscowDate(ms).slice(0, 5) : '—');
    // Два яруса (вариант Б): «наряд» (№/даты/цех) и «двигатель/контракт» — длинному
    // заказчику не тесно, таблица не расползается за поля листа.
    const tier1: Array<{ label: string; value: string }> = [
      { label: '№', value: String(current.workOrderNumber || '—') },
      ...(settings.hideStartDate ? [] : [{ label: 'Приступить', value: shortDate(current.startDate) }]),
      ...(settings.hideDueDate ? [] : [{ label: 'Срок', value: shortDate(current.dueDate) }]),
      ...(settings.hideWorkshop ? [] : [{ label: 'Цех', value: workshop?.name ?? '—' }]),
    ];
    const tier2: Array<{ label: string; value: string }> = [
      ...(isAssembly
        ? [
            { label: 'Марка дв.', value: headerEngineBrand },
            { label: '№ дв.', value: headerEngineNumber },
          ]
        : []),
      ...(contractInfo?.contractSuffix ? [{ label: '№ контр.', value: contractInfo.contractSuffix }] : []),
      ...(contractInfo?.counterparty ? [{ label: 'Заказчик', value: contractInfo.counterparty }] : []),
    ];
    const metaTier = (cols: Array<{ label: string; value: string }>) =>
      cols.length
        ? `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead><tbody><tr>${cols
            .map((c) => `<td>${escapeHtml(c.value)}</td>`)
            .join('')}</tr></tbody>`
        : '';
    const metaHtml = `<table class="wo-meta">${metaTier(tier1)}${metaTier(tier2)}</table>`;

    return {
      title: headerTitle,
      subtitle: printDate ? `Дата: ${formatMoscowDate(printDate)}` : 'Дата: —',
      extraCss: [
        // Отступы между блоками — визуальное разделение каждого раздела.
        `.section { margin-bottom: 14px; }`,
        `th, td { padding: 2px 7px; }`,
        // Реквизит-таблица шапки: рамка, центрирование, свой шрифт.
        `[data-print-section="meta"] table.wo-meta { width: 100%; border-collapse: collapse; }`,
        `[data-print-section="meta"] table.wo-meta th, [data-print-section="meta"] table.wo-meta td { border: 1px solid #0f172a; text-align: center; font-size: ${fs.meta}px; padding: 3px 8px; word-break: break-word; }`,
        `[data-print-section="meta"] table.wo-meta th { background: #f3f4f6; font-weight: 600; }`,
        `[data-print-section="crew"] td, [data-print-section="crew"] th { font-size: ${fs.crew}px; }`,
        `[data-print-section="works"] td, [data-print-section="works"] th { font-size: ${fs.works}px; }`,
        // Таблицы «Бригада» и «Виды работ / наименование изделия» — с такими же
        // чёткими рамками, как таблица реквизитов (meta): тёмная линия 1px вместо
        // бледно-серой из PRINT_BASE_CSS, чтобы сетка была видна на печати.
        `[data-print-section="crew"] table, [data-print-section="works"] table { border-collapse: collapse; }`,
        `[data-print-section="crew"] th, [data-print-section="crew"] td, [data-print-section="works"] th, [data-print-section="works"] td { border: 1px solid #0f172a; }`,
        `[data-print-section="crew"] th, [data-print-section="works"] th { background: #f3f4f6; }`,
        // Подписи идут сразу за телом наряда (тянутся кверху), с заметным
        // отступом от последнего блока — но НЕ прижимаются к низу листа.
        // Прежний bottom-pin (min-height 273мм + margin-top:auto) выталкивал
        // блок подписей на 2-ю страницу. break-inside:avoid (PRINT_BASE_CSS
        // .section) не даёт блоку подписей разорваться между листами.
        `[data-print-section="signatures"] { margin-top: 24px; }`,
        // Точные поля печати: поля задаёт body (12мм, PRINT_BASE_CSS @media
        // print) — обнуляем поля @page, иначе браузер добавляет свои сверху,
        // уменьшает печатную высоту и выталкивает контент на 2-й лист.
        // Печатная область при этом совпадает с превью (#wo-a4 padding 12мм).
        `@page { size: A4; margin: 0; }`,
      ].join(' '),
      // Пустые блоки не печатаем: бригада/виды работ выводятся только при наличии данных.
      sections: [
        { id: 'director', title: 'Гриф директора', html: approvalHtml, hideTitle: true },
        { id: 'title', title: 'Заголовок', html: titleHtml, hideTitle: true },
        { id: 'meta', title: 'Реквизиты', html: metaHtml, hideTitle: true },
        ...(current.crew.length > 0 ? [{ id: 'crew', title: 'Бригада и выплаты', html: crewHtml, hideTitle: true }] : []),
        ...(current.freeWorks.length > 0 ? [{ id: 'works', title: 'Виды работ', html: worksHtml, hideTitle: true }] : []),
        ...(signaturesHtml ? [{ id: 'signatures', title: 'Подписи', html: signaturesHtml, hideTitle: true }] : []),
      ] as PrintSection[],
    };
  }

  function printWorkOrderCard(current: WorkOrderPayload, settings: WorkOrderPrintSettings) {
    openPrintPreview(buildPrintModel(current, settings));
  }

  if (loading) return <div style={{ color: 'var(--muted)' }}>Загрузка…</div>;
  if (!payload) return <div style={{ color: 'var(--danger)' }}>{status || 'Карточка наряда недоступна'}</div>;

  const amountInputStyle: React.CSSProperties = { textAlign: 'right' };
  const rightCellStyle: React.CSSProperties = { textAlign: 'right', whiteSpace: 'nowrap' };

  const cardActionBar = (
    <CardActionBar
      canEdit={canEditNow}
      cardLabel="Наряд"
      onCopyToNew={() => {
        void (async () => {
          if (!payload) return;
          await copyToNewWorkOrder(payload);
        })();
      }}
      onSave={() => {
        void (async () => {
          if (payload && canEditNow) await flushSave(payload);
          dirtyRef.current = false;
        })();
      }}
      onSaveAndClose={() => {
        void (async () => {
          if (payload && canEditNow) await flushSave(payload);
          dirtyRef.current = false;
          props.onClose();
        })();
      }}
      onSaveAsDraft={() => {
        void (async () => {
          if (!payload || !canEditNow) return;
          // Park as an explicit draft — no commit to operations (no row / number for a new order).
          // Cancel the pending autosave so it can't re-stamp the draft back to «recovery».
          if (draftTimerRef.current != null) {
            window.clearTimeout(draftTimerRef.current);
            draftTimerRef.current = null;
          }
          const ok = await saveDraftNow(payload, 'explicit');
          if (!ok) {
            setStatus('Не удалось сохранить черновик');
            return;
          }
          dirtyRef.current = false;
          setStatus('Сохранено как черновик');
          props.onClose();
        })();
      }}
      onReset={() => {
        void refresh().then(() => {
          dirtyRef.current = false;
        });
      }}
      onPrint={() => setPrintDialogOpen(true)}
      onClose={() => props.requestClose?.()}
      onDelete={
        Number(payload?.workOrderNumber) > 0
          ? () => {
              void (async () => {
                const r = await window.matrica.workOrders.delete(props.id);
                if (!r.ok) {
                  setStatus(`Ошибка удаления: ${r.error}`);
                  return;
                }
                props.onClose();
              })();
            }
          : undefined
      }
      deleteLabel="Удалить наряд"
      deleteConfirmDetail={
        payload
          ? `Будет удалён наряд №${String(payload.workOrderNumber ?? '—')} от ${formatMoscowDate(payload.orderDate)}. Действие обычно нельзя отменить.`
          : undefined
      }
    />
  );

  const crewSection = (
    <SectionCard className="entity-card-span-full">
      <div className="list-table-wrap list-table-wrap--single">
        <table className="list-table list-table--single-mode work-order-table" style={{ width: '100%' }}>
          <colgroup>
            <col />
            <col style={{ width: '12%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '12%' }} />
            {canEditNow ? <col style={{ width: '18%' }} /> : null}
          </colgroup>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }} data-col-kind="name">Сотрудник</th>
              <th style={{ textAlign: 'right' }} data-col-kind="num" title="КТУ">КТУ</th>
              <th style={{ textAlign: 'right' }} data-col-kind="num" title="Начислено">Начислено</th>
              <th style={{ textAlign: 'right' }} data-col-kind="flag" title="Заморозить">Заморозить</th>
              {canEditNow && <th style={{ textAlign: 'center' }}>Действия</th>}
            </tr>
          </thead>
          <tbody>
            {payload.crew.map((member, idx) => (
              <tr key={`crew-${idx}-${member.employeeId}`}>
                <td data-col-kind="name">
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'start' }}>
                    <SearchSelectWithCreate
                      value={member.employeeId || null}
                      options={employeeOptions}
                      disabled={!canEditNow}
                      canCreate={props.canCreateEmployees === true}
                      createLabel="Новый сотрудник"
                      onChange={(next) => {
                        const employee = employees.find((x) => x.id === next);
                        const crew = payload.crew.map((c, i) =>
                          i === idx ? { ...c, employeeId: employee?.id || '', employeeName: employee?.displayName || '' } : c,
                        );
                        patch({ ...payload, crew });
                      }}
                      onCreate={async (label) => {
                        const createdId = await createEmployeeFromWorkOrder(label);
                        if (!createdId) return null;
                        const employee = employees.find((x) => x.id === createdId);
                        const nextName = employee?.displayName || label.trim();
                        const crew = payload.crew.map((c, i) =>
                          i === idx ? { ...c, employeeId: createdId, employeeName: nextName } : c,
                        );
                        patch({ ...payload, crew });
                        return createdId;
                      }}
                      placeholder="Выберите сотрудника"
                    />
                    {member.employeeId && props.onOpenEmployee ? (
                      <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenEmployee?.(member.employeeId as string)}>
                        Открыть
                      </Button>
                    ) : null}
                  </div>
                </td>
                <td data-col-kind="num" style={rightCellStyle}>
                  <Input
                    type="number"
                    min={0.01}
                    step="0.01"
                    value={String(member.ktu ?? 1)}
                    style={amountInputStyle}
                    disabled={!canEditNow}
                    onChange={(e) => {
                      const crew = payload.crew.map((c, i) => (i === idx ? { ...c, ktu: Math.max(0.01, safeNum(e.target.value, 1)) } : c));
                      patch({ ...payload, crew });
                    }}
                  />
                </td>
                <td data-col-kind="num" style={rightCellStyle}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={String(member.payoutFrozen ? member.manualPayoutRub ?? member.payoutRub ?? 0 : member.payoutRub ?? 0)}
                      style={amountInputStyle}
                      disabled={!canEditNow || !member.payoutFrozen}
                      onChange={(e) => {
                        const crew = payload.crew.map((c, i) =>
                          i === idx
                            ? {
                                ...c,
                                manualPayoutRub: Math.max(0, safeNum(e.target.value, 0)),
                              }
                            : c,
                        );
                        patch({ ...payload, crew });
                      }}
                    />
                  </div>
                </td>
                <td data-col-kind="flag" style={rightCellStyle}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, width: '100%', cursor: canEditNow ? 'pointer' : 'default' }}>
                    <input
                      type="checkbox"
                      disabled={!canEditNow}
                      checked={Boolean(member.payoutFrozen)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        const crew = payload.crew.map((c, i) =>
                          i === idx
                            ? {
                                ...c,
                                payoutFrozen: checked,
                                ...(checked ? { manualPayoutRub: Math.max(0, safeNum(c.manualPayoutRub ?? c.payoutRub, 0)) } : {}),
                              }
                            : c,
                        );
                        patch({ ...payload, crew });
                      }}
                    />
                    <span>{member.payoutFrozen ? 'Да' : 'Нет'}</span>
                  </label>
                </td>
                {canEditNow && (
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <RowReorderButtons
                        canMoveUp={idx > 0}
                        canMoveDown={idx < payload.crew.length - 1}
                        onMoveUp={() => moveCrewMember(idx, idx - 1)}
                        onMoveDown={() => moveCrewMember(idx, idx + 1)}
                      />
                      <Button
                        variant="ghost"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => {
                          void (async () => {
                            const ok = await confirm({
                              detail: `Убрать из бригады наряда №${String(payload.workOrderNumber ?? '—')} сотрудника «${String(member.employeeName || '').trim() || `строка ${idx + 1}`}»?`,
                            });
                            if (!ok) return;
                            patch({ ...payload, crew: payload.crew.filter((_, i) => i !== idx) });
                          })();
                        }}
                      >
                        Удалить
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {payload.crew.length === 0 && (
              <tr>
                <td colSpan={canEditNow ? 5 : 4} style={{ color: 'var(--muted)' }}>
                  Состав бригады пуст
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {canEditNow && (
          <Button variant="ghost" onClick={() => patch({ ...payload, crew: [...payload.crew, { employeeId: '', employeeName: '', ktu: 1, payoutFrozen: false }] })}>
            + Добавить сотрудника
          </Button>
        )}
      </div>
    </SectionCard>
  );

  const signaturesSection = (
    <SectionCard className="entity-card-span-full">
      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>Подписи</div>
        <datalist id="wo-signature-captions">
          {captionSuggestions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        {getWorkOrderSignatureBlocks(payload.workOrderKind).map((block) => {
          const slots = resolveWorkOrderSignatureSlots(block, payload.signatureBlocks);
          const setSlot = (idx: number, key: 'caption' | 'employeeId', value: string) => {
            const next = slots.map((s, j) => {
              if (j !== idx) return s;
              const caption = key === 'caption' ? value : s.caption ?? '';
              const employeeId = key === 'employeeId' ? value : s.employeeId ?? '';
              const slot: WorkOrderSignatureSlot = {};
              if (caption) slot.caption = caption;
              if (employeeId) slot.employeeId = employeeId;
              return slot;
            });
            setSignatureSlots(block.id, next);
          };
          return (
            <div key={block.id} style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{block.title}</div>
              {slots.map((slot, idx) => {
                const employee = slot.employeeId ? employees.find((e) => e.id === slot.employeeId) : undefined;
                const unitLine = [employee?.position, resolveEmployeeUnit(employee)].filter(Boolean).join(' · ');
                return (
                  <div
                    key={`${block.id}-${idx}`}
                    style={{
                      display: 'grid',
                      gap: 6,
                      padding: '8px 10px',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      background: 'var(--surface)',
                    }}
                  >
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(140px, 0.7fr) minmax(220px, 1.5fr) auto auto',
                        gap: 8,
                        alignItems: 'center',
                      }}
                    >
                      <Input
                        list="wo-signature-captions"
                        value={slot.caption ?? ''}
                        disabled={!canEditNow}
                        placeholder="Роль (напр. «Наряд выдал»)"
                        onChange={(e) => setSlot(idx, 'caption', e.target.value)}
                        onBlur={(e) => persistSignatureCaption(e.target.value)}
                      />
                      <SearchSelect
                        value={slot.employeeId || null}
                        options={signatureEmployeeOptions}
                        disabled={!canEditNow}
                        onChange={(next) => {
                          setSlot(idx, 'employeeId', next || '');
                          if (next) rememberSignatureEmployee(next);
                        }}
                        placeholder="Сотрудник (пусто — подпись от руки)"
                      />
                      {canEditNow ? (
                        <RowReorderButtons
                          canMoveUp={idx > 0}
                          canMoveDown={idx < slots.length - 1}
                          onMoveUp={() => setSignatureSlots(block.id, moveArrayItem(slots, idx, idx - 1))}
                          onMoveDown={() => setSignatureSlots(block.id, moveArrayItem(slots, idx, idx + 1))}
                        />
                      ) : (
                        <span />
                      )}
                      {canEditNow ? (
                        <Button
                          variant="ghost"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => setSignatureSlots(block.id, slots.filter((_, j) => j !== idx))}
                        >
                          Удалить
                        </Button>
                      ) : (
                        <span />
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', minHeight: 14, wordBreak: 'break-word' }}>
                      {unitLine || (slot.employeeId ? '' : 'Подпись и расшифровка от руки')}
                    </div>
                  </div>
                );
              })}
              {slots.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12 }}>Подписи не добавлены</div>}
              {canEditNow && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="ghost" onClick={() => setSignatureSlots(block.id, [...slots, {}])}>
                    + Добавить подписанта
                  </Button>
                  <Button variant="ghost" onClick={() => setSignatureSlots(block.id, [...slots, {}])}>
                    + Добавить пустую подпись
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      {/* Закреплённая шапка: управляющие кнопки + реквизиты — не уезжают за край при прокрутке */}
      <div style={{ position: 'sticky', top: 0, zIndex: 9, flexShrink: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ maxWidth: 'min(95vw, 1200px)', marginInline: 'auto', width: '100%' }}>
          {cardActionBar}
      {/* Реквизиты: только номер и дата создания */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--ui-space-4, 10px)',
          alignItems: 'center',
          padding: 'var(--ui-space-3, 8px) var(--ui-space-4, 10px)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          marginBottom: 'var(--ui-space-3, 8px)',
          maxWidth: 'var(--ui-content-block-max-width)',
          marginInline: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>№</span>
          <Input value={Number(payload.workOrderNumber) > 0 ? String(payload.workOrderNumber) : 'новый'} disabled style={{ ...amountInputStyle, width: 60 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Дата создания</span>
          <Input
            type="date"
            value={toInputDate(payload.orderDate)}
            disabled
            title="Дата создания наряда — проставляется автоматически при выписке и не изменяется (как и номер)."
            style={{ width: 150 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Приступить</span>
          <Input
            type="date"
            value={toInputDate(payload.startDate)}
            disabled={!canEditNow}
            onChange={(e) => {
              const ms = fromInputDate(e.target.value);
              const next: WorkOrderPayload = { ...payload };
              if (ms) next.startDate = ms;
              else delete next.startDate;
              patch(next);
            }}
            style={{ width: 150 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Срок</span>
          <Input
            type="date"
            value={toInputDate(payload.dueDate)}
            disabled={!canEditNow}
            onChange={(e) => {
              const ms = fromInputDate(e.target.value);
              const next: WorkOrderPayload = { ...payload };
              if (ms) next.dueDate = ms;
              else delete next.dueDate;
              patch(next);
            }}
            style={{ width: 150 }}
          />
        </div>
        {(() => {
          const code = deriveWorkOrderStatusCode({
            operationStatus: isClosed ? 'closed' : operationStatus,
            dueDate: payload.dueDate ?? null,
            completedAt: isClosed ? (payload.completedDate ?? operationUpdatedAt) : null,
            now: Date.now(),
          });
          const palette: Record<string, { bg: string; fg: string }> = {
            issued: { bg: '#fef3c7', fg: '#92400e' },
            done: { bg: '#dcfce7', fg: '#166534' },
            overdue: { bg: '#fee2e2', fg: '#b91c1c' },
            done_late: { bg: '#dcfce7', fg: '#b91c1c' },
          };
          const p = palette[code] ?? palette.issued!;
          return (
            <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: p.bg, color: p.fg }}>
              {WORK_ORDER_STATUS_LABELS[code]}
            </span>
          );
        })()}
        {/* Parts-movement module: cex + kind selectors + close button */}
        {!appliedHiddenFields.has('workshopId') ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Цех</span>
            <select
              value={payload.workshopId ?? ''}
              disabled={!canEditNow || workshops.length === 0}
              onChange={(e) => {
                const v = e.target.value;
                const next: WorkOrderPayload = { ...payload };
                if (v) next.workshopId = v;
                else delete next.workshopId;
                patch(next);
              }}
              style={{ minWidth: 140, padding: '4px 6px' }}
            >
              <option value="">— не выбран —</option>
              {workshops.map((w) => (
                <option key={w.id} value={w.id}>
                  Цех {w.code} — {w.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Тип</span>
          <select
            value={payload.workOrderKind ?? ''}
            disabled={!canEditNow}
            title={payload.workOrderKind ? WORK_ORDER_KIND_DESCRIPTIONS[payload.workOrderKind] : 'Тип наряда не выбран — работы только для учёта зарплат'}
            onChange={(e) => {
              const v = e.target.value;
              const next: WorkOrderPayload = { ...payload };
              if (
                v === WorkOrderKind.Regular ||
                v === WorkOrderKind.Repair ||
                v === WorkOrderKind.Assembly ||
                v === WorkOrderKind.Manufacturing
              ) {
                next.workOrderKind = v;
              } else {
                delete next.workOrderKind;
              }
              patch(next);
            }}
            style={{ minWidth: 160, padding: '4px 6px' }}
          >
            <option value="">— не выбран —</option>
            {WORK_ORDER_KIND_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {WORK_ORDER_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
        {payload.workOrderKind === WorkOrderKind.WorkshopTemplate ? (
          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
            Ремонт по шаблону цеха (legacy)
          </div>
        ) : null}
        {isWorkOrderTemplateKind(payload.workOrderKind) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Шаблон:</span>
            <select
              value={selectedWorkOrderTemplateId}
              disabled={availableWorkOrderTemplates.length === 0}
              onChange={(e) => setSelectedWorkOrderTemplateId(e.target.value)}
              style={{ minWidth: 200, padding: '4px 6px' }}
              title="Список шаблонов для текущего типа наряда"
            >
              <option value="">
                {availableWorkOrderTemplates.length === 0 ? '— нет шаблонов —' : '— не выбран —'}
              </option>
              {availableWorkOrderTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.lineCount} строк)
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              disabled={!canEditNow || !selectedWorkOrderTemplateId || workOrderTemplateBusy}
              onClick={() => void applyWorkOrderTemplate(selectedWorkOrderTemplateId)}
              title="Применить выбранный шаблон: копирует значения полей и список строк"
            >
              {workOrderTemplateBusy ? 'Загрузка…' : 'Применить'}
            </Button>
            {props.canEditWorkOrderTemplates ? (
              <>
                <Button
                  variant="ghost"
                  disabled={workOrderTemplateBusy}
                  onClick={() =>
                    setWorkOrderTemplateEditor({
                      templateId: null,
                      defaultKind: payload.workOrderKind as WorkOrderKind,
                    })
                  }
                  title="Создать новый шаблон для текущего типа наряда"
                >
                  + Шаблон
                </Button>
                {selectedWorkOrderTemplateId ? (
                  <Button
                    variant="ghost"
                    disabled={workOrderTemplateBusy}
                    onClick={() =>
                      setWorkOrderTemplateEditor({
                        templateId: selectedWorkOrderTemplateId,
                        defaultKind: payload.workOrderKind as WorkOrderKind,
                      })
                    }
                    title="Изменить выбранный шаблон"
                  >
                    Изменить
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {payload.workOrderKind === WorkOrderKind.Assembly && assemblyVariantGroups.length >= 2 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Вариант сборки</span>
            <select
              value={payload.assemblyVariantGroup ?? ''}
              disabled={!canEditNow}
              title="Вариант сборки BOM для собираемого двигателя — фильтрует список деталей в карточке двигателя"
              onChange={(e) => {
                const v = e.target.value;
                const next: WorkOrderPayload = { ...payload };
                if (v) next.assemblyVariantGroup = v;
                else next.assemblyVariantGroup = null;
                patch(next);
              }}
              style={{ minWidth: 160, padding: '4px 6px' }}
            >
              <option value="">— не выбран —</option>
              {assemblyVariantGroups.map((vg, idx) => (
                <option key={vg} value={vg}>
                  {formatAssemblyVariantLabel(vg, idx)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {/* Дата выполнения — рядом с кнопкой закрытия (директива владельца «рядом», батч 2026-06-30) */}
        {isClosed ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Завершён</span>
            <span style={{ fontSize: 13, color: 'var(--text)' }}>
              {payload.completedDate && payload.completedDate > 0
                ? formatMoscowDate(payload.completedDate)
                : operationUpdatedAt
                  ? formatMoscowDate(operationUpdatedAt)
                  : '—'}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Дата выполнения</span>
            <Input
              type="date"
              value={payload.completedDate && payload.completedDate > 0 ? toInputDate(payload.completedDate) : ''}
              disabled={!canEditNow}
              title="Фактическая дата выполнения работ. Пустая, пока не указана вручную; можно очистить обратно в пусто. Заполнять не обязательно — при закрытии без даты считается дата проводки. На дату складского документа не влияет."
              onChange={(e) => {
                const ms = fromInputDate(e.target.value);
                const next: WorkOrderPayload = { ...payload };
                if (ms) next.completedDate = ms;
                else delete next.completedDate;
                patch(next);
              }}
              style={{ width: 150 }}
            />
          </div>
        )}
        {payload.linkedDocumentId && !isClosed && payload.workOrderKind === WorkOrderKind.Assembly ? (
          // Stage 2 нитки assembly-work-order-from-forecast: промежуточное состояние —
          // наряд сохранён как черновик, детали зарезервированы на складе через reservedQty.
          // Оператор может «Провести» (списать) или «Удалить черновик» (снять резерв).
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
              Черновик сохранён. Документ: <code>{payload.linkedDocumentId.slice(0, 8)}…</code>. Детали зарезервированы.
            </div>
            {props.canCloseWorkOrders ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  tone="success"
                  disabled={closing}
                  title="Наряд выполнен: списать зарезервированные детали со складов и закрыть наряд (проводка)."
                  onClick={async () => {
                    if (!confirm) return;
                    const ok = await confirm({
                      title: 'Провести сборочный наряд?',
                      detail: 'Зарезервированные детали будут списаны со склада в сборку (assembly_consumption posted). Действие необратимо без сторнирования.',
                      confirmLabel: 'Провести',
                      cancelLabel: 'Отмена',
                    });
                    if (!ok) return;
                    setClosing(true);
                    setStatus('Провожу наряд…');
                    try {
                      if (canEditNow && dirtyRef.current) await flushSave(payload);
                      try {
                        await window.matrica.sync.run();
                      } catch (syncErr) {
                        console.warn('[assembly post] sync.run() failed (continuing):', syncErr);
                      }
                      const r = await window.matrica.workOrders.postAssembly({ operationId: props.id });
                      if (!r.ok) {
                        setStatus(`Ошибка проведения: ${r.error}`);
                        return;
                      }
                      setOperationStatus('closed');
                      setStatus(`Проведено. Документ ${r.documentId} списан.`);
                    } catch (e) {
                      setStatus(`Ошибка: ${String(e)}`);
                    } finally {
                      setClosing(false);
                    }
                  }}
                >
                  {closing ? 'Работаю…' : 'Наряд выполнен — провести'}
                </Button>
                <Button
                  variant="outline"
                  tone="danger"
                  disabled={closing}
                  title="Снять резерв и удалить черновик складского документа. Сам наряд останется открытым."
                  onClick={async () => {
                    if (!confirm) return;
                    const ok = await confirm({
                      title: 'Удалить черновик документа?',
                      detail: 'Резерв деталей будет снят, а связанный документ assembly_consumption (draft) — отменён. Наряд останется открытым: можно отредактировать строки и сохранить заново.',
                      confirmLabel: 'Удалить черновик',
                      cancelLabel: 'Отмена',
                    });
                    if (!ok) return;
                    setClosing(true);
                    setStatus('Удаляю черновик…');
                    try {
                      const r = await window.matrica.workOrders.deleteAssemblyDraft({ operationId: props.id });
                      if (!r.ok) {
                        setStatus(`Ошибка: ${r.error}`);
                        return;
                      }
                      setPayload((prev) => {
                        if (!prev) return prev;
                        const next = { ...prev };
                        delete next.linkedDocumentId;
                        return recalcLocally(next);
                      });
                      setStatus('Черновик удалён, резерв снят.');
                    } catch (e) {
                      setStatus(`Ошибка: ${String(e)}`);
                    } finally {
                      setClosing(false);
                    }
                  }}
                >
                  Удалить черновик
                </Button>
              </div>
            ) : null}
          </div>
        ) : payload.linkedDocumentId ? (
          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
            Закрыт. Документ: <code>{payload.linkedDocumentId.slice(0, 8)}…</code>
          </div>
        ) : isClosed && payload.workOrderKind === WorkOrderKind.Regular ? (
          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>Закрыт (без складского документа)</div>
        ) : isClosed ? (
          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>Наряд закрыт</div>
        ) : props.canCloseWorkOrders && payload.workOrderKind === WorkOrderKind.Assembly ? (
          // Stage 2: для Assembly заменяем «Закрыть и провести» на «Сохранить как черновик».
          // Сохранение создаёт assembly_consumption в статусе draft и резервирует детали.
          // Проведение/удаление — через отдельные кнопки в состоянии черновика выше.
          (() => {
            const assemblyEngineId = payload.freeWorks.find((line) => line.engineId)?.engineId ?? null;
            const missingAssemblyEngine = !assemblyEngineId;
            const missingWorkshop = !payload.workshopId;
            const saveDisabled = closing || missingAssemblyEngine || missingWorkshop;
            const saveTooltip = missingWorkshop
              ? 'Выберите цех'
              : missingAssemblyEngine
                ? 'Укажите двигатель сборки хотя бы в одной строке работ'
                : 'Создаст черновик документа assembly_consumption и зарезервирует детали на складах. Списание — отдельной кнопкой «Провести наряд».';
            return (
              <Button
                disabled={saveDisabled}
                title={saveTooltip}
                onClick={async () => {
                  if (!confirm) return;
                  if (missingAssemblyEngine) {
                    setStatus('Для сборочного наряда укажите двигатель хотя бы в одной строке работ.');
                    return;
                  }
                  if (missingWorkshop) {
                    setStatus('Выберите цех.');
                    return;
                  }
                  setClosing(true);
                  setStatus('Сохраняю черновик…');
                  try {
                    if (canEditNow && dirtyRef.current) await flushSave(payload);
                    try {
                      await window.matrica.sync.run();
                    } catch (syncErr) {
                      console.warn('[assembly save] sync.run() failed (continuing):', syncErr);
                    }
                    const r = await window.matrica.workOrders.saveAssemblyDraft({ operationId: props.id });
                    if (!r.ok) {
                      setStatus(`Ошибка сохранения: ${r.error}`);
                      return;
                    }
                    const docId = r.documentId;
                    setPayload((prev) => (prev ? recalcLocally({ ...prev, linkedDocumentId: docId }) : prev));
                    setStatus(`Черновик сохранён, детали зарезервированы. Документ ${docId.slice(0, 8)}…`);
                  } catch (e) {
                    setStatus(`Ошибка: ${String(e)}`);
                  } finally {
                    setClosing(false);
                  }
                }}
              >
                {closing ? 'Работаю…' : 'Сохранить как черновик'}
              </Button>
            );
          })()
        ) : props.canCloseWorkOrders ? (
          (() => {
            const kind = payload.workOrderKind;
            const isRegular = kind === WorkOrderKind.Regular;
            const needsWorkshop = !isRegular;
            const needsEngine = kind === WorkOrderKind.Assembly;
            const assemblyEngineId = needsEngine
              ? (payload.freeWorks.find((line) => line.engineId)?.engineId ?? null)
              : null;
            const missingAssemblyEngine = needsEngine && !assemblyEngineId;
            const closeDisabled =
              closing ||
              !kind ||
              (needsWorkshop && !payload.workshopId) ||
              missingAssemblyEngine;
            const tooltip = !kind
              ? 'Выберите тип наряда'
              : needsWorkshop && !payload.workshopId
                ? 'Выберите цех'
                : missingAssemblyEngine
                  ? 'Укажите двигатель сборки хотя бы в одной строке работ'
                  : isRegular
                    ? 'Закроет наряд без складских движений (только учёт зарплат)'
                    : kind === WorkOrderKind.Repair
                      ? 'Создаст и проведёт документ production_release — отремонтированные детали поступят на склад цеха'
                      : kind === WorkOrderKind.WorkshopTemplate
                        ? 'Создаст и проведёт документ production_release — выпущенные детали поступят на склад цеха'
                        : kind === WorkOrderKind.Manufacturing
                          ? 'Создаст и проведёт документ production_release — изготовленные детали поступят на склад цеха'
                          : 'Создаст и проведёт документ assembly_consumption — детали спишутся со склада цеха в сборку';
            const buttonLabel = isRegular ? 'Закрыть наряд' : 'Закрыть и провести';
            const confirmTitle = isRegular ? 'Закрыть наряд без складского документа?' : 'Закрыть наряд и провести документ?';
            const confirmDetail = isRegular
              ? [
                  'Тип «Обычный» не создаёт складских движений: программа только запишет объём выполненных работ для расчёта зарплаты бригады. По этому наряду не будет создан складской документ — ничего не спишется и не поступит на склад.',
                  '',
                  'Если по этому наряду должны двигаться детали — нажмите «Отмена» и смените «Тип наряда» в шапке карточки:',
                  '  • «Ремонт» — отремонтированные детали поступят на склад цеха;',
                  '  • «Изготовление» — новые детали поступят на склад цеха;',
                  '  • «Ремонт по шаблону цеха» — детали из шаблона поступят на склад цеха;',
                  '  • «Сборка» — детали спишутся со склада цеха в сборку двигателя.',
                  '',
                  'После подтверждения наряд перейдёт в статус «Закрыт». Действие необратимо.',
                ].join('\n')
              : kind === WorkOrderKind.Repair
                ? 'Будет создан и проведён документ production_release (отремонтированные детали поступают на склад цеха как новые). Действие необратимо без сторнирования.'
                : kind === WorkOrderKind.WorkshopTemplate
                  ? 'Будет создан и проведён документ production_release (выпущенные по шаблону цеха детали поступают на склад цеха). Действие необратимо без сторнирования.'
                  : kind === WorkOrderKind.Manufacturing
                    ? 'Будет создан и проведён документ production_release (новые детали поступают на склад цеха). Действие необратимо без сторнирования.'
                    : 'Будет создан и проведён документ assembly_consumption (детали списываются со склада цеха в сборку, привязка к двигателю). Действие необратимо без сторнирования.';
            return (
              <Button
                disabled={closeDisabled}
                title={tooltip}
                onClick={async () => {
                  if (!confirm) return;
                  if (missingAssemblyEngine) {
                    setStatus('Для сборочного наряда укажите двигатель хотя бы в одной строке работ.');
                    return;
                  }
                  const ok = await confirm({
                    title: confirmTitle,
                    detail: confirmDetail,
                    confirmLabel: 'Подтвердить',
                    cancelLabel: 'Отмена',
                    ...(isRegular ? { confirmTone: 'neutral' as const } : {}),
                  });
                  if (!ok) return;
                  setClosing(true);
                  setStatus('Закрываю наряд…');
                  try {
                    if (canEditNow && dirtyRef.current) await flushSave(payload);
                    // Force-push локальных изменений в backend Postgres перед close.
                    // Backend Postgres хранит «правду» о наряде (operationsService),
                    // а его close-логика читает op.metaJson.workOrderKind — это поле
                    // ещё могло не доехать через периодический ledger sync. Без явного
                    // sync.run() backend увидит наряд либо без workOrderKind, либо вообще
                    // не увидит (если наряд только что создан).
                    setStatus('Синхронизация с сервером…');
                    try {
                      await window.matrica.sync.run();
                    } catch (syncErr) {
                      console.warn('[work-order close] sync.run() failed (continuing):', syncErr);
                    }
                    setStatus('Закрываю наряд…');
                    const r = await window.matrica.workOrders.close({ operationId: props.id });
                    if (!r.ok) {
                      setStatus(`Ошибка закрытия: ${r.error}`);
                      return;
                    }
                    // Оптимистичное обновление: не ждём ledger-sync до клиентской SQLite
                    // (refresh() читает локальную копию и не увидит свежий статус).
                    if (r.documentId) {
                      const docId = r.documentId;
                      setPayload((prev) => (prev ? recalcLocally({ ...prev, linkedDocumentId: docId }) : prev));
                    }
                    if (isRegular) setClosedLocally(true);
                    // Заблокировать редактирование всей карточки немедленно.
                    setOperationStatus('closed');
                    setStatus(
                      isRegular
                        ? 'Закрыто (без складского документа).'
                        : `Закрыто. Документ ${r.documentId ?? '—'} проведён.`,
                    );
                  } catch (e) {
                    setStatus(`Ошибка: ${String(e)}`);
                  } finally {
                    setClosing(false);
                  }
                }}
              >
                {closing ? 'Закрываю…' : buttonLabel}
              </Button>
            );
          })()
        ) : null}
      </div>
        </div>
      </div>
      {/* Тело карточки — прокручивается под закреплённой шапкой */}
      <div style={{ maxWidth: 'min(95vw, 1200px)', marginInline: 'auto', width: '100%', flexShrink: 0 }}>
        <EntityCardShell title="" layout="stack">
      {payload.workOrderKind === WorkOrderKind.Repair && !isClosed ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: payload.repairIssued ? 'var(--success)' : 'var(--muted)' }}>
            {payload.repairIssued
              ? '🟢 Выдан в работу — отремонтированные детали учитываются в прогнозе сборки как приход'
              : '⚪ Не выдан в работу — детали НЕ учитываются прогнозом сборки, пока наряд не выдан'}
          </span>
          {canEditNow ? (
            <Button
              variant={payload.repairIssued ? 'ghost' : 'primary'}
              size="sm"
              title={
                payload.repairIssued
                  ? 'Отозвать наряд: детали перестанут учитываться прогнозом сборки как будущий приход'
                  : 'Выдать наряд в работу: отремонтированные детали попадут в прогноз сборки как приход (день +1)'
              }
              onClick={() => void toggleRepairIssued()}
            >
              {payload.repairIssued ? 'Отозвать из работы' : 'Выдать в работу'}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!isClosed && payload.workOrderKind === WorkOrderKind.Assembly && !payload.freeWorks.some((line) => line.engineId) ? (
        <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>
          ⚠ Сборочный наряд: укажите двигатель сборки хотя бы в одной строке работ — иначе не получится провести документ assembly_consumption.
        </div>
      ) : null}
      {status && !status.startsWith('Сохранено') ? (
        <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--muted)', fontSize: 12, marginBottom: 8 }}>{status}</div>
      ) : null}

      {appliedHiddenFields.size > 0 ? (
        <details
          style={{
            marginBottom: 8,
            padding: '6px 10px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--surface)',
          }}
        >
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--subtle)' }}>
            Дополнительные поля ({appliedHiddenFields.size} скрыто шаблоном)
          </summary>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-4, 10px)', marginTop: 8 }}>
            {appliedHiddenFields.has('workshopId') ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ui-space-2, 4px)' }}>
                <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Цех</span>
                <select
                  value={payload.workshopId ?? ''}
                  disabled={!canEditNow || workshops.length === 0}
                  onChange={(e) => {
                    const v = e.target.value;
                    const next: WorkOrderPayload = { ...payload };
                    if (v) next.workshopId = v;
                    else delete next.workshopId;
                    patch(next);
                  }}
                  style={{ minWidth: 140, padding: '4px 6px' }}
                >
                  <option value="">— не выбран —</option>
                  {workshops.map((w) => (
                    <option key={w.id} value={w.id}>
                      Цех {w.code} — {w.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {(['engineNumber', 'engineBrandId', 'engineBrandName', 'productNumber', 'engineId'] as const)
              .filter((k) => appliedHiddenFields.has(k))
              .map((key) => (
                <span key={key} style={{ fontSize: 12, color: 'var(--subtle)' }}>
                  {key} — скрыты в таблице ниже
                </span>
              ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAppliedHiddenFields(new Set())}
              title="Сбросить скрытие и показать все поля карточки"
            >
              Показать все поля
            </Button>
          </div>
        </details>
      ) : null}

      {crewSection}
    </EntityCardShell>
      </div>

      {/* Виды работ — отдельный широкий блок */}
      <div style={{ maxWidth: 'min(98vw, 1600px)', marginInline: 'auto', width: '100%' }}>
        <SectionCard className="entity-card-span-full work-order-works-panel">
        <div className="list-table-wrap list-table-wrap--single">
          <table className="list-table list-table--single-mode work-order-table">
            <colgroup>
              {!appliedHiddenFields.has('engineNumber') ? <col style={{ width: '130px' }} /> : null}
              {!(appliedHiddenFields.has('engineBrandName') || appliedHiddenFields.has('engineBrandId')) ? (
                <col style={{ width: '140px' }} />
              ) : null}
              {!appliedHiddenFields.has('serviceName') ? <col /> : null}
              <col style={{ width: '220px' }} />
              <col style={{ width: '120px' }} />
              {payload.workOrderKind === WorkOrderKind.Assembly ? <col style={{ width: '160px' }} /> : null}
              {!appliedHiddenFields.has('productNumber') ? <col style={{ width: '100px' }} /> : null}
              <col style={{ width: '65px' }} />
              <col style={{ width: '50px' }} />
              {!appliedHiddenFields.has('priceRub') ? <col style={{ width: '80px' }} /> : null}
              {!appliedHiddenFields.has('amountRub') ? <col style={{ width: '100px' }} /> : null}
              {canEditNow ? <col style={{ width: '184px' }} /> : null}
            </colgroup>
            <thead>
              <tr>
                {!appliedHiddenFields.has('engineNumber') ? <th style={{ textAlign: 'left' }} data-col-kind="name">№ двигателя</th> : null}
                {!(appliedHiddenFields.has('engineBrandName') || appliedHiddenFields.has('engineBrandId')) ? (
                  <th style={{ textAlign: 'left' }} data-col-kind="name">Марка двигателя</th>
                ) : null}
                {!appliedHiddenFields.has('serviceName') ? <th style={{ textAlign: 'left' }} data-col-kind="name">Вид работ</th> : null}
                <th style={{ textAlign: 'left' }} data-col-kind="name">Наименование изделия</th>
                <th style={{ textAlign: 'left' }} data-col-kind="name">Артикул</th>
                {payload.workOrderKind === WorkOrderKind.Assembly ? <th style={{ textAlign: 'left' }} data-col-kind="name">Склад</th> : null}
                {!appliedHiddenFields.has('productNumber') ? <th style={{ textAlign: 'left' }} data-col-kind="name">№ изделия</th> : null}
                <th style={{ textAlign: 'right' }} data-col-kind="num" title="Кол-во">Кол-во</th>
                <th style={{ textAlign: 'right' }}>Ед.</th>
                {!appliedHiddenFields.has('priceRub') ? <th style={{ textAlign: 'right' }} data-col-kind="num" title="Цена">Цена</th> : null}
                {!appliedHiddenFields.has('amountRub') ? <th style={{ textAlign: 'right' }} data-col-kind="num" title="Сумма">Сумма</th> : null}
                {canEditNow && <th style={{ textAlign: 'center' }}>Действия</th>}
              </tr>
            </thead>
            <tbody>
              {payload.freeWorks.map((line, idx) => {
                const engineInfo = engines.find((e) => e.id === line.engineId) || null;
                // Stage 4 followup: `line.engineBrandId` приходит из строки прогноза (через
                // `createAssemblyFromForecast`) ещё до выбора конкретного двигателя. Используем
                // её как fallback, чтобы фильтр услуг и dropdown двигателей работали даже когда
                // engineId пустой.
                const brandForLine = engineInfo?.engineBrandId ?? (line.engineBrandId ? String(line.engineBrandId) : null);
                /**
                 * Фильтр услуг по марке двигателя строки:
                 *  - если в строке не выбран двигатель → показываем все услуги;
                 *  - если выбран → показываем только универсальные (engineBrandIds пуст)
                 *    + те, у кого марка совпадает.
                 * Если в строке уже сохранена услуга, не проходящая фильтр (например, после смены двигателя)
                 * — оставляем её в списке, чтобы оператор мог её увидеть/заменить, а не «потерять».
                 */
                const serviceOptionsForLine = brandForLine
                  ? allServiceOptions.filter((opt) => {
                      if (opt.id === line.serviceId) return true;
                      const svc = serviceById.get(opt.id);
                      if (!svc) return true;
                      if (svc.engineBrandIds.length === 0) return true;
                      return svc.engineBrandIds.includes(brandForLine);
                    })
                  : allServiceOptions;
                /**
                 * Фильтр двигателей dropdown по марке строки: для Assembly-наряда из прогноза
                 * `line.engineBrandId` уже задан → показываем только двигатели этой марки.
                 * Текущий выбранный engineId сохраняется в списке даже если выпадает из фильтра
                 * (например, оператор сменил brand на строке) — чтобы не «потерять» выбор.
                 */
                const engineOptionsForLine = brandForLine
                  ? engineOptions.filter((opt) => {
                      if (opt.id === line.engineId) return true;
                      const eng = engines.find((e) => e.id === opt.id);
                      return eng?.engineBrandId === brandForLine;
                    })
                  : engineOptions;
                return (
                <tr key={`free-work-line-${idx}`}>
                  {!appliedHiddenFields.has('engineNumber') ? (
                    <td data-col-kind="name">
                      <SearchSelect
                        value={line.engineId || null}
                        options={engineOptionsForLine}
                        disabled={!canEditNow}
                        placeholder="Выберите двигатель"
                        onChange={(next) => {
                          const eng = next ? engines.find((e) => e.id === next) : null;
                          const freeWorks = payload.freeWorks.map((item, rowIdx) =>
                            rowIdx === idx
                              ? {
                                  ...item,
                                  engineId: next || null,
                                  engineNumber: eng?.engineNumber || '',
                                  // Не затираем engineBrandId/Name на пустой при clear: они могли прийти
                                  // из прогноза и нужны как фильтр для следующего выбора.
                                  engineBrandId: eng?.engineBrandId ?? item.engineBrandId ?? null,
                                  engineBrandName: eng?.engineBrandName ?? item.engineBrandName ?? '',
                                }
                              : item,
                          );
                          patch({ ...payload, freeWorks });
                        }}
                      />
                    </td>
                  ) : null}
                  {!(appliedHiddenFields.has('engineBrandName') || appliedHiddenFields.has('engineBrandId')) ? (
                    <td data-col-kind="name">
                      <Input
                        value={engineInfo?.engineBrandName || line.engineBrandName || ''}
                        disabled
                        placeholder="—"
                      />
                    </td>
                  ) : null}
                  {!appliedHiddenFields.has('serviceName') ? (
                  <td data-col-kind="name">
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 6, alignItems: 'start' }}>
                      <SearchSelectWithCreate
                        value={line.serviceId}
                        options={serviceOptionsForLine}
                        disabled={!canEditNow}
                        canCreate={props.canEditMasterData}
                        createLabel="Новая услуга"
                        onChange={(next) =>
                          patch({
                            ...payload,
                            freeWorks: applyServiceSnapshotToLines(payload.freeWorks, idx, next),
                          })
                        }
                        onCreate={async (label) => {
                          const createdId = await createServiceFromWorkOrder(label, null, { engineBrandId: brandForLine });
                          if (!createdId) return null;
                          /** После создания услуги перезагружаем справочник, чтобы услуга появилась с её engineBrandIds. */
                          await loadRefs();
                          patch({
                            ...payload,
                            freeWorks: applyServiceSnapshotToLines(payload.freeWorks, idx, createdId),
                          });
                          return createdId;
                        }}
                        placeholder="Выберите вид работ"
                      />
                      {line.serviceId && props.onOpenService ? (
                        <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenService?.(line.serviceId as string)}>
                          Открыть
                        </Button>
                      ) : null}
                    </div>
                  </td>
                  ) : null}
                  <td data-col-kind="name">
                    <SearchSelect
                      value={line.partId || null}
                      options={partOptions}
                      disabled={!canEditNow}
                      placeholder="Выберите изделие"
                      onChange={(next) => {
                        const part = next ? parts.find((p) => p.id === next) : null;
                        const freeWorks = payload.freeWorks.map((item, rowIdx) =>
                          rowIdx === idx
                            ? {
                                ...item,
                                partId: next || null,
                                partName: part?.name || '',
                                partArticle: part?.article || '',
                              }
                            : item,
                        );
                        patch({ ...payload, freeWorks });
                      }}
                    />
                  </td>
                  <td data-col-kind="name">
                    <Input value={resolvePartArticle(line)} disabled placeholder="—" title="Артикул из справочника" />
                  </td>
                  {payload.workOrderKind === WorkOrderKind.Assembly ? (
                    <td data-col-kind="name">
                      <SearchSelect
                        value={(() => {
                          // Phase 2.4 PR 1: legacy строки в payload могут содержать 'workshop_<code>'
                          // или 'default' и т.п. Резолвим в uuid через warehouse_locations.code,
                          // чтобы dropdown отображал выбранную опцию для существующих наряд.
                          const raw = String(line.sourceWarehouseId ?? '').trim();
                          if (!raw) return null;
                          if (raw.includes('-') && raw.length >= 32) return raw;
                          const mapped = warehouseLocations.find((w) => w.code === raw);
                          return mapped?.id ?? raw;
                        })()}
                        options={warehouseSourceOptions}
                        disabled={!canEditNow}
                        placeholder="Склад"
                        onChange={(next) => {
                          const freeWorks = payload.freeWorks.map((item, rowIdx) =>
                            rowIdx === idx ? { ...item, sourceWarehouseId: next || null } : item,
                          );
                          patch({ ...payload, freeWorks });
                        }}
                      />
                    </td>
                  ) : null}
                  {!appliedHiddenFields.has('productNumber') ? (
                    <td data-col-kind="name">
                      <Input
                        value={line.productNumber || ''}
                        disabled={!canEditNow}
                        placeholder="№ изделия"
                        onChange={(e) => {
                          const freeWorks = payload.freeWorks.map((item, rowIdx) => (rowIdx === idx ? { ...item, productNumber: e.target.value } : item));
                          patch({ ...payload, freeWorks });
                        }}
                      />
                    </td>
                  ) : null}
                  <td data-col-kind="num" style={rightCellStyle}>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={String(line.qty ?? 0)}
                      style={amountInputStyle}
                      disabled={!canEditNow}
                      onChange={(e) => {
                        const freeWorks = payload.freeWorks.map((item, rowIdx) => (rowIdx === idx ? { ...item, qty: safeNum(e.target.value, 0) } : item));
                        patch({ ...payload, freeWorks });
                      }}
                    />
                  </td>
                  <td style={rightCellStyle}>
                    <Input value={line.unit || ''} disabled style={amountInputStyle} />
                  </td>
                  {!appliedHiddenFields.has('priceRub') ? (
                  <td data-col-kind="num" style={rightCellStyle}>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={String(line.priceRub ?? 0)}
                      style={amountInputStyle}
                      disabled={!canEditNow}
                      onChange={(e) => {
                        const freeWorks = payload.freeWorks.map((item, rowIdx) => (rowIdx === idx ? { ...item, priceRub: safeNum(e.target.value, 0) } : item));
                        patch({ ...payload, freeWorks });
                      }}
                    />
                  </td>
                  ) : null}
                  {!appliedHiddenFields.has('amountRub') ? <td data-col-kind="num" style={rightCellStyle}>{money(line.amountRub ?? 0)}</td> : null}
                  {canEditNow && (
                    <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <RowReorderButtons
                          canMoveUp={idx > 0}
                          canMoveDown={idx < payload.freeWorks.length - 1}
                          onMoveUp={() => moveFreeWorkLine(idx, idx - 1)}
                          onMoveDown={() => moveFreeWorkLine(idx, idx + 1)}
                        />
                        <Button
                          variant="ghost"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => {
                            void (async () => {
                              const ok = await confirm({
                                detail: `Удалить из наряда №${String(payload.workOrderNumber ?? '—')} строку вида работ №${line.lineNo}${line.serviceName ? ` («${line.serviceName}»)` : ''}?`,
                              });
                              if (!ok) return;
                              patch({ ...payload, freeWorks: payload.freeWorks.filter((_, rowIdx) => rowIdx !== idx) });
                            })();
                          }}
                        >
                          Удалить
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
                );
              })}
              {payload.freeWorks.length === 0 && (
                <tr>
                  <td
                    colSpan={
                      4 + // always-on: Наименование изделия + Артикул + Кол-во + Ед.
                      (appliedHiddenFields.has('engineNumber') ? 0 : 1) +
                      (appliedHiddenFields.has('engineBrandName') || appliedHiddenFields.has('engineBrandId') ? 0 : 1) +
                      (appliedHiddenFields.has('serviceName') ? 0 : 1) +
                      (payload.workOrderKind === WorkOrderKind.Assembly ? 1 : 0) +
                      (appliedHiddenFields.has('productNumber') ? 0 : 1) +
                      (appliedHiddenFields.has('priceRub') ? 0 : 1) +
                      (appliedHiddenFields.has('amountRub') ? 0 : 1) +
                      (canEditNow ? 1 : 0)
                    }
                    style={{ color: 'var(--muted)' }}
                  >
                    Работы не добавлены
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {canEditNow && (
          <div style={{ marginTop: 'var(--ui-space-2, 4px)' }}>
            <Button variant="ghost" onClick={addFreeWorkLine}>
              Добавить работу +
            </Button>
          </div>
        )}
        {!appliedHiddenFields.has('amountRub') ? (
        <div
          className="wo-works-total"
          style={{
            marginTop: 'var(--ui-space-3, 8px)',
            paddingTop: 'var(--ui-space-3, 8px)',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--ui-space-3, 8px)',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Итог</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{money(payload.totalAmountRub)}</span>
        </div>
        ) : null}
      </SectionCard>

      {signaturesSection}
    </div>
    {workOrderTemplateEditor ? (
      <WorkOrderTemplateEditorDialog
        open
        templateId={workOrderTemplateEditor.templateId}
        defaultKind={workOrderTemplateEditor.defaultKind}
        canEdit={props.canEditWorkOrderTemplates === true}
        onClose={() => setWorkOrderTemplateEditor(null)}
        onSaved={(saved) => {
          // Reload list so the dropdown shows the new/renamed template, but don't auto-apply.
          if (!payload || !isWorkOrderTemplateKind(payload.workOrderKind)) return;
          void (async () => {
            const r = await window.matrica.workOrderTemplates.list({
              kind: payload.workOrderKind as WorkOrderKind,
            });
            if (r?.ok) setAvailableWorkOrderTemplates(r.templates);
          })();
          setSelectedWorkOrderTemplateId(saved.id);
        }}
      />
    ) : null}
    {printDialogOpen && payload ? (
      <WorkOrderPrintDialog
        settings={payload.printSettings ?? {}}
        workOrderKind={payload.workOrderKind ?? ''}
        workOrderKindLabel={payload.workOrderKind ? WORK_ORDER_KIND_LABELS[payload.workOrderKind] : 'этого вида'}
        autoTitle={buildPrintModel(payload, {}).title}
        approverEmployees={approverEmployees}
        buildHtml={(settings) => buildWorkOrderA4PreviewHtml(buildPrintModel(payload, settings))}
        onChange={(settings) => {
          const cleaned: WorkOrderPrintSettings = {
            ...(settings.titleOverride?.trim() ? { titleOverride: settings.titleOverride.trim() } : {}),
            ...(settings.approver === 'technical' ? { approver: 'technical' as const } : {}),
            ...(settings.approverPositionOverride?.trim() ? { approverPositionOverride: settings.approverPositionOverride.trim() } : {}),
            ...(settings.approverNameOverride?.trim() ? { approverNameOverride: settings.approverNameOverride.trim() } : {}),
            ...(settings.approverEmployeeId ? { approverEmployeeId: settings.approverEmployeeId } : {}),
            ...(settings.hideOrderDate ? { hideOrderDate: true } : {}),
            ...(settings.hideStartDate ? { hideStartDate: true } : {}),
            ...(settings.hideDueDate ? { hideDueDate: true } : {}),
            ...(settings.hideWorkshop ? { hideWorkshop: true } : {}),
            ...(settings.fontDirector ? { fontDirector: settings.fontDirector } : {}),
            ...(settings.fontTitle ? { fontTitle: settings.fontTitle } : {}),
            ...(settings.fontMeta ? { fontMeta: settings.fontMeta } : {}),
            ...(settings.fontCrew ? { fontCrew: settings.fontCrew } : {}),
            ...(settings.fontWorks ? { fontWorks: settings.fontWorks } : {}),
            ...(settings.fontSignatures ? { fontSignatures: settings.fontSignatures } : {}),
          };
          const next = { ...payload } as WorkOrderPayload;
          if (Object.keys(cleaned).length) next.printSettings = cleaned;
          else delete next.printSettings;
          patch(next);
        }}
        onPrint={(settings) => printWorkOrderCard(payload, settings)}
        onClose={() => setPrintDialogOpen(false)}
      />
    ) : null}
    </div>
  );
}

