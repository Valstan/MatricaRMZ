import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { CardActionBar } from '../components/CardActionBar.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { EntityCardShell } from '../components/EntityCardShell.js';
import { SectionCard } from '../components/SectionCard.js';
import {
  buildLinkTypeOptions,
  normalizeForMatch,
  parseContractExecutionParts,
  parseContractSections,
  PART_DIMENSIONS_ATTR_CODE,
  PART_TEMPLATE_ID_ATTR_CODE,
  suggestLinkTargetCodeWithRules,
  type LinkRule,
  type PartDimension,
  type WorkOrderPayload,
} from '@matricarmz/shared';
import { STATUS_CODES, STATUS_LABELS, statusDateCode, type StatusCode } from '@matricarmz/shared';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { invalidateListAllPartsCache } from '../utils/partsPagination.js';
import type { SearchSelectOption } from '../components/SearchSelect.js';
import { mapEntityRowsToSearchOptions } from '../utils/selectOptions.js';
import {
  createEngineBrandSummarySyncState,
  persistEngineBrandSummaries as persistEngineBrandSummariesShared,
  type EngineBrandSummarySyncState,
} from '../utils/engineBrandSummary.js';

type Attribute = {
  id: string;
  code: string;
  name: string;
  dataType: string;
  value: unknown;
  isRequired: boolean;
  sortOrder: number;
  metaJson?: unknown;
};

type LinkOpt = SearchSelectOption;
type TextLookupMeta = { targetTypeCode: string; storeAs: 'id' | 'label' };

type PartBrandLink = {
  id: string;
  partId: string;
  engineBrandId: string;
  assemblyUnitNumber: string;
  quantity: number;
};

type EntityTypeRow = { id: string; code: string; name: string };

type UsageItem = {
  key: string;
  kind: 'contract' | 'engine_brand' | 'work_order' | 'service' | 'link';
  entityId: string;
  label: string;
  description?: string;
  targetTypeCode?: string | null;
};

type Part = {
  id: string;
  createdAt: number;
  updatedAt: number;
  brandLinks?: PartBrandLink[];
  attributes: Attribute[];
};

function toInputDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
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

function normalizeDateInput(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDimensionsValue(value: unknown): PartDimension[] {
  if (!Array.isArray(value)) return [];
  const result: PartDimension[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index];
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const rowValue = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (!name && !rowValue) continue;
    result.push({
      id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `dim-${index + 1}`,
      name,
      value: rowValue,
    });
  }
  return result;
}

function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [focused, setFocused] = useState(false);
  return (
    <textarea
      {...props}
      style={{
        width: '100%',
        padding: '9px 12px',
        borderRadius: 0,
        border: focused ? '1px solid var(--input-border-focus)' : '1px solid var(--input-border)',
        outline: 'none',
        background: props.disabled ? 'var(--input-bg-disabled)' : 'var(--input-bg)',
        color: 'var(--text)',
        boxShadow: focused ? 'var(--input-shadow-focus)' : 'var(--input-shadow)',
        fontFamily: 'inherit',
        fontSize: 14,
        lineHeight: 1.4,
        minHeight: 110,
        resize: 'vertical',
        ...(props.style ?? {}),
      }}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
    />
  );
}

function formatValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => formatValue(x)).filter(Boolean).join(', ');
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function keyValueTable(rows: Array<[string, string]>) {
  const body = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '—')}</td></tr>`)
    .join('\n');
  return `<table><tbody>${body}</tbody></table>`;
}

function fileListHtml(list: unknown) {
  const items = Array.isArray(list)
    ? list.filter((x) => x && typeof x === 'object' && typeof (x as any).name === 'string')
    : [];
  if (items.length === 0) return '<div class="muted">Нет файлов</div>';
  return `<ul>${items
    .map((f) => {
      const entry = f as { name: string; isObsolete?: boolean };
      const obsoleteBadge =
        entry.isObsolete === true
          ? ' <span style="display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;color:#991b1b;background:#fee2e2;border:1px solid #fecaca;">Устаревшая версия</span>'
          : '';
      return `<li>${escapeHtml(String(entry.name))}${obsoleteBadge}</li>`;
    })
    .join('')}</ul>`;
}

export function PartDetailsPage(props: {
  partId: string;
  canEdit: boolean;
  canDelete: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  onOpenCustomer?: (customerId: string) => void;
  onOpenContract?: (contractId: string) => void;
  onOpenEngineBrand?: (engineBrandId: string) => void;
  onOpenByCode?: Record<string, ((id: string) => void) | undefined>;
  onClose: () => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
}) {
  const [part, setPart] = useState<Part | null>(null);
  const [status, setStatus] = useState<string>('');
  const [editingAttr, setEditingAttr] = useState<Record<string, unknown>>({});

  // Core fields (better UX: always-visible inputs)
  const [name, setName] = useState<string>('');
  const [article, setArticle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [purchaseDate, setPurchaseDate] = useState<string>(''); // yyyy-mm-dd
  const [supplier, setSupplier] = useState<string>('');
  const [supplierId, setSupplierId] = useState<string>('');
  const [templateId, setTemplateId] = useState<string>('');
  const [templateOptions, setTemplateOptions] = useState<LinkOpt[]>([]);
  const [templateStatus, setTemplateStatus] = useState<string>('');
  const [dimensions, setDimensions] = useState<PartDimension[]>([]);
  const [usageItems, setUsageItems] = useState<UsageItem[]>([]);
  const [usageStatus, setUsageStatus] = useState<string>('');
  const [customerOptions, setCustomerOptions] = useState<LinkOpt[]>([]);
  const [customerStatus, setCustomerStatus] = useState<string>('');

  // Links: engine brands
  const [engineBrandOptions, setEngineBrandOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [engineBrandStatus, setEngineBrandStatus] = useState<string>('');
  const [brandLinks, setBrandLinks] = useState<PartBrandLink[]>([]);
  const [brandLinksStatus, setBrandLinksStatus] = useState<string>('');
  const [brandLinkDrafts, setBrandLinkDrafts] = useState<Record<string, { engineBrandId: string; assemblyUnitNumber: string; quantity: number }>>({});
  const [newBrandLink, setNewBrandLink] = useState({ engineBrandId: '', assemblyUnitNumber: '', quantity: 1 });
  const [contractOptions, setContractOptions] = useState<LinkOpt[]>([]);
  const [statusFlags, setStatusFlags] = useState<Partial<Record<StatusCode, boolean>>>(() => {
    const out: Partial<Record<StatusCode, boolean>> = {};
    for (const c of STATUS_CODES) out[c] = false;
    return out;
  });
  const [statusDates, setStatusDates] = useState<Partial<Record<StatusCode, number | null>>>(() => {
    const out: Partial<Record<StatusCode, number | null>> = {};
    for (const c of STATUS_CODES) out[c] = null;
    return out;
  });

  const [linkRules, setLinkRules] = useState<LinkRule[]>([]);
  const [entityTypes, setEntityTypes] = useState<EntityTypeRow[]>([]);
  const [partTypeId, setPartTypeId] = useState<string>('');
  const [partDefs, setPartDefs] = useState<AttributeDefRow[]>([]);
  const [coreDefsReady, setCoreDefsReady] = useState(false);
  const [linkOptionsByCode, setLinkOptionsByCode] = useState<Record<string, LinkOpt[]>>({});
  const [linkLoadingByCode, setLinkLoadingByCode] = useState<Record<string, boolean>>({});
  const [textLookupOptionsByCode, setTextLookupOptionsByCode] = useState<Record<string, LinkOpt[]>>({});
  const [textLookupMetaByCode, setTextLookupMetaByCode] = useState<Record<string, TextLookupMeta>>({});
  const [textLookupLoadingByCode, setTextLookupLoadingByCode] = useState<Record<string, boolean>>({});

  const dirtyRef = useRef(false);
  const isSavingCoreRef = useRef(false);
  const isSavingAttributeQueueRef = useRef(false);
  const isSavingBrandLinkQueueRef = useRef(false);
  const isSavingFieldQueueRef = useRef(false);
  const isSavingFieldOrderQueueRef = useRef(false);
  const pendingAttributeSaveValuesRef = useRef(new Map<string, unknown>());
  const pendingAttributeSaveResolversRef = useRef<Array<(result: SaveAttributeResult) => void>>([]);
  const attributeSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBrandLinkOperationsRef = useRef<Array<QueuedBrandLinkOperation>>([]);
  const pendingBrandLinkOperationResolversRef = useRef<Array<(result: BrandLinkSaveResult) => void>>([]);
  const brandLinkQueueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFieldOperationsRef = useRef<Array<QueuedFieldOperation>>([]);
  const pendingFieldOperationResolversRef = useRef<Array<(result: FieldOperationResult) => void>>([]);
  const fieldQueueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFieldOrderCodesRef = useRef<FieldOrderOperation | null>(null);
  const pendingFieldOrderResolversRef = useRef<Array<(result: FieldOrderSaveResult) => void>>([]);
  const fieldOrderQueueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summaryPersistState = useRef<EngineBrandSummarySyncState>(createEngineBrandSummarySyncState());
  const summaryDeps = useMemo(
    () => ({
      entityTypesList: async () => (await window.matrica.admin.entityTypes.list()) as unknown[],
      upsertAttributeDef: async (args: {
        entityTypeId: string;
        code: string;
        name: string;
        dataType: 'number';
        sortOrder: number;
      }) => window.matrica.admin.attributeDefs.upsert(args),
      setEntityAttr: async (entityId: string, code: string, value: number) =>
        window.matrica.admin.entities.setAttr(entityId, code, value) as Promise<{ ok: boolean; error?: string }>,
      listPartsByBrand: async (args: { engineBrandId: string; limit: number; offset?: number }) =>
        window.matrica.parts.list(args)
          .then((r) => r as { ok: boolean; parts?: unknown[]; error?: string })
          .catch((error) => ({ ok: false as const, error: String(error) })),
    }),
    [],
  );

  // Schema extension (add new fields)
  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const [newFieldCode, setNewFieldCode] = useState('');
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldDataType, setNewFieldDataType] = useState<'text' | 'number' | 'boolean' | 'date' | 'json' | 'link'>('text');
  const [newFieldSortOrder, setNewFieldSortOrder] = useState('100');
  const [newFieldIsRequired, setNewFieldIsRequired] = useState(false);
  const [newFieldMetaJson, setNewFieldMetaJson] = useState('');
  const [newFieldLinkTarget, setNewFieldLinkTarget] = useState('');
  const [newFieldLinkTouched, setNewFieldLinkTouched] = useState(false);

  const recommendedLinkCode = useMemo(
    () => suggestLinkTargetCodeWithRules(newFieldName, linkRules),
    [newFieldName, linkRules],
  );

  useEffect(() => {
    if (newFieldDataType !== 'link') {
      setNewFieldLinkTarget('');
      setNewFieldLinkTouched(false);
      return;
    }
    if (newFieldLinkTouched) return;
    if (recommendedLinkCode) setNewFieldLinkTarget(recommendedLinkCode);
  }, [newFieldDataType, newFieldLinkTouched, recommendedLinkCode]);

  const newFieldStandardType = useMemo(
    () => (newFieldLinkTouched ? entityTypes.find((t) => t.code === newFieldLinkTarget) ?? null : null),
    [newFieldLinkTouched, newFieldLinkTarget, entityTypes],
  );
  const newFieldRecommendedType = useMemo(
    () => entityTypes.find((t) => t.code === recommendedLinkCode) ?? null,
    [entityTypes, recommendedLinkCode],
  );
  const newFieldLinkOptions = useMemo(
    () => buildLinkTypeOptions(entityTypes, newFieldStandardType?.code ?? null, newFieldRecommendedType?.code ?? null),
    [entityTypes, newFieldStandardType?.code, newFieldRecommendedType?.code],
  );
  const [addFieldStatus, setAddFieldStatus] = useState('');

  async function createNewField() {
    if (!props.canEdit) return;
    try {
      const code = newFieldCode.trim();
      const name = newFieldName.trim();
      if (!code) {
        setAddFieldStatus('Ошибка: code пустой');
        return;
      }
      if (!/^[a-z][a-z0-9_]*$/i.test(code)) {
        setAddFieldStatus('Ошибка: code должен быть вида name_like_this');
        return;
      }
      if (!name) {
        setAddFieldStatus('Ошибка: название пустое');
        return;
      }
      if (newFieldDataType === 'link' && !newFieldLinkTarget) {
        setAddFieldStatus('Ошибка: выберите справочник');
        return;
      }

      setAddFieldStatus('Создание поля…');
      const sortOrder = Number(newFieldSortOrder) || 0;
      const metaJson =
        newFieldDataType === 'link'
          ? newFieldLinkTarget
            ? JSON.stringify({ linkTargetTypeCode: newFieldLinkTarget })
            : null
          : newFieldMetaJson.trim()
            ? newFieldMetaJson.trim()
            : null;

      const r = await queueFieldOperation({
        code,
        name,
        dataType: newFieldDataType,
        isRequired: newFieldIsRequired,
        sortOrder,
        metaJson,
        ...(newFieldDataType === 'link' && newFieldLinkTouched && newFieldLinkTarget ? { linkTargetCode: newFieldLinkTarget } : {}),
      });
      if (!r?.ok) {
        setAddFieldStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return;
      }
      setAddFieldOpen(false);
      setNewFieldCode('');
      setNewFieldName('');
      setNewFieldDataType('text');
      setNewFieldSortOrder('100');
      setNewFieldIsRequired(false);
      setNewFieldMetaJson('');
      setNewFieldLinkTarget('');
      setNewFieldLinkTouched(false);
    } catch (e) {
      setAddFieldStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadEngineBrands() {
    try {
      setEngineBrandStatus('Загрузка списка марок…');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'engine_brand') ?? null;
      if (!type?.id) {
        setEngineBrandOptions([]);
        setEngineBrandStatus('Справочник марок двигателя не найден (engine_brand).');
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
      setEngineBrandOptions(mapEntityRowsToSearchOptions(rows, { fallbackToShortId: true }));
      setEngineBrandStatus('');
    } catch (e) {
      setEngineBrandOptions([]);
      setEngineBrandStatus(`Ошибка: ${String(e)}`);
    }
  }

  function getDraft(linkId: string, link: PartBrandLink) {
    const draft = brandLinkDrafts[linkId];
    if (draft) {
      return {
        engineBrandId: draft.engineBrandId ?? '',
        assemblyUnitNumber: draft.assemblyUnitNumber ?? '',
        quantity: Number.isFinite(draft.quantity) ? draft.quantity : 0,
      };
    }
    return {
      engineBrandId: link.engineBrandId ?? '',
      assemblyUnitNumber: link.assemblyUnitNumber ?? '',
      quantity: Number.isFinite(link.quantity) ? link.quantity : 0,
    };
  }

  function setDraft(linkId: string, patch: Partial<{ engineBrandId: string; assemblyUnitNumber: string; quantity: number }>) {
    const current = getDraft(linkId, brandLinks.find((b) => b.id === linkId) ?? ({} as PartBrandLink));
    dirtyRef.current = true;
    setBrandLinkDrafts((prev) => ({
      ...prev,
      [linkId]: {
        engineBrandId: patch.engineBrandId ?? current.engineBrandId,
        assemblyUnitNumber: patch.assemblyUnitNumber ?? current.assemblyUnitNumber,
        quantity: Number.isFinite(patch.quantity ?? current.quantity) ? Number(patch.quantity ?? current.quantity) : current.quantity,
      },
    }));
  }

  async function persistEngineBrandSummaries(brandIds: string[]) {
    await persistEngineBrandSummariesShared(
      summaryDeps,
      summaryPersistState.current,
      brandIds,
    );
  }

  async function upsertBrandLink(link: {
    linkId?: string;
    engineBrandId: string;
    assemblyUnitNumber: string;
    quantity: number;
  }) {
    if (!props.canEdit) return;
    const engineBrandId = String(link.engineBrandId || '').trim();
    const assemblyUnitNumber = String(link.assemblyUnitNumber || '').trim();
    const quantity = Number(link.quantity);
    if (!engineBrandId) {
      setBrandLinksStatus('Ошибка: выберите марку двигателя');
      return;
    }
    if (!assemblyUnitNumber) {
      setBrandLinksStatus('Ошибка: заполните номер сборочной единицы');
      return;
    }
    if (!Number.isFinite(quantity) || quantity < 0) {
      setBrandLinksStatus('Ошибка: количество должно быть числом ≥ 0');
      return;
    }

    const payload = {
      partId: props.partId,
      engineBrandId,
      assemblyUnitNumber,
      quantity,
      ...(link.linkId ? { linkId: link.linkId } : {}),
    };
    const prev = link.linkId ? brandLinks.find((x) => x.id === link.linkId) : null;

    const result = await queueBrandLinkOperation({
      type: 'upsert',
      clearDraftLinkId: link.linkId,
      payload: {
        partId: payload.partId,
        engineBrandId: payload.engineBrandId,
        assemblyUnitNumber: payload.assemblyUnitNumber,
        quantity: payload.quantity,
        ...(payload.linkId ? { linkId: payload.linkId } : {}),
      },
      affectedBrandIds: [String(prev?.engineBrandId || '').trim(), String(payload.engineBrandId).trim()].filter(Boolean),
    });
    if (!result.ok) {
      setBrandLinksStatus(`Ошибка: ${String(result.error)}`);
      return;
    }
  }

  async function deleteBrandLink(linkId: string) {
    if (!props.canEdit) return;
    const ok = confirm('Удалить связь с маркой двигателя?');
    if (!ok) return;
    const affectedBrandId = String(brandLinks.find((x) => x.id === linkId)?.engineBrandId || '').trim();
    const result = await queueBrandLinkOperation({
      type: 'delete',
      linkId,
      affectedBrandIds: affectedBrandId ? [affectedBrandId] : [],
    });
    if (!result.ok) {
      setBrandLinksStatus(`Ошибка: ${String(result.error)}`);
      return;
    }
  }

  function sortBrandLinks(rows: PartBrandLink[]): PartBrandLink[] {
    return [...rows].sort((a, b) => {
      const aAsm = (a.assemblyUnitNumber || '').trim();
      const bAsm = (b.assemblyUnitNumber || '').trim();
      const cmpAsm = aAsm.localeCompare(bAsm, 'ru');
      if (cmpAsm !== 0) return cmpAsm;
      return String(a.engineBrandId).localeCompare(String(b.engineBrandId), 'ru');
    });
  }

  function normalizeBrandLinksFromPart(partValue: Part): PartBrandLink[] {
    const raw = (partValue as Part & { brandLinks?: unknown }).brandLinks;
    if (!Array.isArray(raw)) return [];
    const out: PartBrandLink[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const v = item as Record<string, unknown>;
      const id = String(v.id ?? '').trim();
      const partId = String(v.partId ?? '').trim();
      const engineBrandId = String(v.engineBrandId ?? '').trim();
      const assemblyUnitNumber = String(v.assemblyUnitNumber ?? '').trim();
      const quantity = Number(v.quantity);
      if (!id || !partId || !engineBrandId) continue;
      out.push({
        id,
        partId,
        engineBrandId,
        assemblyUnitNumber,
        quantity: Number.isFinite(quantity) ? quantity : 0,
      });
    }
    return out;
  }

  async function loadBrandLinks(partId?: string) {
    const pid = String(partId || props.partId || '').trim();
    if (!pid) return;
    try {
      setBrandLinksStatus('Загрузка связей…');
      const r = await window.matrica.parts.partBrandLinks.list({ partId: pid });
      if (!r.ok) {
        setBrandLinksStatus(`Ошибка: ${String(r.error)}`);
        setBrandLinks([]);
        return;
      }
      setBrandLinks(sortBrandLinks(r.brandLinks));
      setBrandLinksStatus('');
      setBrandLinkDrafts({});
      setNewBrandLink((prev) => ({ ...prev, quantity: 1, assemblyUnitNumber: prev.assemblyUnitNumber || '' }));
    } catch (e) {
      setBrandLinksStatus(`Ошибка: ${String(e)}`);
      setBrandLinks([]);
    }
  }

  async function loadContracts() {
    try {
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'contract') ?? null;
      if (!type?.id) {
        setContractOptions([]);
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
      setContractOptions(mapEntityRowsToSearchOptions(rows, { fallbackToShortId: true }));
    } catch {
      setContractOptions([]);
    }
  }

  async function loadCustomers() {
    try {
      setCustomerStatus('Загрузка списка поставщиков…');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'customer') ?? null;
      if (!type?.id) {
        setCustomerOptions([]);
        setCustomerStatus('Справочник контрагентов не найден (customer).');
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
      setCustomerOptions(mapEntityRowsToSearchOptions(rows, { fallbackToShortId: true }));
      setCustomerStatus('');
    } catch (e) {
      setCustomerOptions([]);
      setCustomerStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadTemplates() {
    try {
      setTemplateStatus('Загрузка шаблонов…');
      const r = await window.matrica.parts.templates.list({ limit: 5000 });
      if (!r.ok) {
        setTemplateOptions([]);
        setTemplateStatus(`Ошибка: ${r.error}`);
        return;
      }
      const opts = r.templates.map((row) => ({
        id: String(row.id),
        label: String(row.name ?? row.description ?? row.id),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setTemplateOptions(opts);
      setTemplateStatus('');
    } catch (e) {
      setTemplateOptions([]);
      setTemplateStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function createMasterDataEntity(typeCode: string, label: string): Promise<string | null> {
    if (!props.canEdit) return null;
    const clean = String(label ?? '').trim();
    if (!clean) return null;
    let typeId = entityTypes.find((t) => t.code === typeCode)?.id ?? '';
    if (!typeId) {
      const types = await window.matrica.admin.entityTypes.list().catch(() => []);
      typeId = (types as any[]).find((t) => String(t.code) === typeCode)?.id ?? '';
    }
    if (!typeId) {
      setStatus(`Ошибка: не найден тип справочника "${typeCode}"`);
      return null;
    }
    const created = await window.matrica.admin.entities.create(String(typeId));
    if (!created?.ok || !created?.id) return null;
    if (typeCode === 'contract') await window.matrica.admin.entities.setAttr(created.id, 'number', clean);
    else await window.matrica.admin.entities.setAttr(created.id, 'name', clean);
    if (typeCode === 'customer') await loadCustomers();
    if (typeCode === 'contract') await loadContracts();
    return created.id;
  }

  async function createPartTemplate(label: string): Promise<string | null> {
    if (!props.canEdit) return null;
    const clean = String(label ?? '').trim();
    if (!clean) return null;
    const created = await window.matrica.parts.templates.create({ attributes: { name: clean } });
    if (!created?.ok || !created.template?.id) {
      setTemplateStatus(`Ошибка: ${created?.error ?? 'Не удалось создать шаблон детали'}`);
      return null;
    }
    await loadTemplates();
    return String(created.template.id);
  }

  async function loadLinkRules() {
    try {
      const types = await window.matrica.admin.entityTypes.list();
      setEntityTypes(types as any);
      const partType = (types as any[]).find((t) => String(t.code) === 'part') ?? null;
      if (partType?.id) {
        setPartTypeId(String(partType.id));
        const defs = await window.matrica.admin.attributeDefs.listByEntityType(String(partType.id));
        setPartDefs(defs as AttributeDefRow[]);
        setCoreDefsReady(false);
      }
      const type = (types as any[]).find((t) => String(t.code) === 'link_field_rule') ?? null;
      if (!type?.id) {
        setLinkRules([]);
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
      const rules: LinkRule[] = [];
      for (const row of rows as any[]) {
        const details = await window.matrica.admin.entities.get(String(row.id));
        const attrs = details.attributes ?? {};
        const fieldName = String(attrs.field_name ?? '').trim();
        const targetTypeCode = String(attrs.target_type_code ?? '').trim();
        const priority = Number(attrs.priority ?? 0) || 0;
        if (fieldName && targetTypeCode) rules.push({ fieldName, targetTypeCode, priority });
      }
      setLinkRules(rules);
    } catch {
      setLinkRules([]);
    }
  }

  async function upsertLinkRule(
    fieldName: string,
    targetTypeCode: string,
    options?: { suppressReload?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const shouldReload = !options?.suppressReload;

    const ruleType = entityTypes.find((t) => t.code === 'link_field_rule');
    if (!ruleType) return { ok: false, error: 'Тип правила link_field_rule не найден' };
    const list = await window.matrica.admin.entities.listByEntityType(String(ruleType.id));
    const normalized = normalizeForMatch(fieldName);
    for (const row of list as any[]) {
      const details = await window.matrica.admin.entities.get(String(row.id));
      const attrs = details.attributes ?? {};
      const existingName = normalizeForMatch(String(attrs.field_name ?? ''));
      if (existingName && existingName === normalized) {
        if (String(attrs.target_type_code ?? '') !== targetTypeCode) {
          const updated = await window.matrica.admin.entities.setAttr(String(row.id), 'target_type_code', targetTypeCode);
          if (!updated.ok) return { ok: false, error: String(updated.error ?? 'Ошибка обновления правила') };
        }
        if (!attrs.priority) {
          const updated = await window.matrica.admin.entities.setAttr(String(row.id), 'priority', 100);
          if (!updated.ok) return { ok: false, error: String(updated.error ?? 'Ошибка обновления приоритета') };
        }
        if (shouldReload) {
          await loadLinkRules();
        }
        return { ok: true };
      }
    }
    const created = await window.matrica.admin.entities.create(String(ruleType.id));
    if (!created.ok || !created.id) return { ok: false, error: String(created.error ?? 'Ошибка создания правила') };
    const attrsUpdates = [
      await window.matrica.admin.entities.setAttr(created.id, 'field_name', fieldName),
      await window.matrica.admin.entities.setAttr(created.id, 'target_type_code', targetTypeCode),
      await window.matrica.admin.entities.setAttr(created.id, 'priority', 100),
    ];
    for (const update of attrsUpdates) {
      if (!update.ok) {
        return { ok: false, error: String(update.error ?? 'Ошибка настройки правила') };
      }
    }
    if (shouldReload) {
      await loadLinkRules();
    }
    return { ok: true };
  }

  async function loadLinkOptions(typeCode: string, attrCode: string) {
    if (!typeCode) return;
    setLinkLoadingByCode((p) => ({ ...p, [attrCode]: true }));
    try {
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === typeCode) ?? null;
      if (!type?.id) {
        setLinkOptionsByCode((p) => ({ ...p, [attrCode]: [] }));
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
      setLinkOptionsByCode((p) => ({ ...p, [attrCode]: mapEntityRowsToSearchOptions(rows, { fallbackToShortId: true }) }));
    } catch {
      setLinkOptionsByCode((p) => ({ ...p, [attrCode]: [] }));
    } finally {
      setLinkLoadingByCode((p) => ({ ...p, [attrCode]: false }));
    }
  }

  async function load() {
    try {
      setStatus('Загрузка…');
      const r = await window.matrica.parts.get(props.partId);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setPart(r.part);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadUsage(partValue?: Part | null) {
    const currentPart = partValue ?? part;
    if (!currentPart) return;
    try {
      setUsageStatus('Загрузка связей…');
      const items = new Map<string, UsageItem>();
      const addItem = (item: UsageItem) => {
        if (!item.entityId || !item.label) return;
        items.set(item.key, item);
      };

      for (const link of brandLinks) {
        const label = engineBrandOptions.find((row) => row.id === link.engineBrandId)?.label ?? link.engineBrandId;
        addItem({
          key: `engine_brand:${link.engineBrandId}`,
          kind: 'engine_brand',
          entityId: link.engineBrandId,
          label,
          description: link.assemblyUnitNumber ? `Сборочная единица: ${link.assemblyUnitNumber}` : undefined,
          targetTypeCode: 'engine_brand',
        });
      }

      const byCode = new Map(currentPart.attributes.map((attr) => [attr.code, attr] as const));
      const directContractId = typeof byCode.get('contract_id')?.value === 'string' ? String(byCode.get('contract_id')?.value || '').trim() : '';
      if (directContractId) {
        addItem({
          key: `contract:${directContractId}`,
          kind: 'contract',
          entityId: directContractId,
          label: contractOptions.find((row) => row.id === directContractId)?.label ?? directContractId,
          description: 'Прямая историческая привязка детали',
          targetTypeCode: 'contract',
        });
      }

      for (const attr of currentPart.attributes) {
        if (attr.dataType !== 'link' || attr.code === PART_TEMPLATE_ID_ATTR_CODE || attr.code === 'contract_id') continue;
        const entityId = typeof attr.value === 'string' ? attr.value.trim() : '';
        if (!entityId) continue;
        const targetTypeCode = getLinkTargetTypeCode(attr);
        const options = linkOptionsByCode[attr.code] ?? [];
        const label = options.find((row) => row.id === entityId)?.label ?? entityId;
        addItem({
          key: `link:${attr.code}:${entityId}`,
          kind: 'link',
          entityId,
          label,
          description: attr.name || attr.code,
          targetTypeCode,
        });
      }

      const contractType = entityTypes.find((row) => row.code === 'contract');
      if (contractType?.id) {
        const contracts = await window.matrica.admin.entities.listByEntityType(contractType.id);
        for (const row of contracts as any[]) {
          const id = String(row.id ?? '').trim();
          if (!id || id === directContractId) continue;
          const details = await window.matrica.admin.entities.get(id);
          const attrs = details?.attributes ?? {};
          const sections = parseContractSections(attrs.contract_sections);
          const hasPartInSections =
            sections.primary.parts.some((partRow) => partRow.partId === currentPart.id) ||
            sections.addons.some((addon) => addon.parts.some((partRow) => partRow.partId === currentPart.id));
          const executionParts = parseContractExecutionParts(attrs.contract_execution_parts);
          const hasPartInExecution = executionParts.some((partRow) => partRow.partId === currentPart.id);
          if (!hasPartInSections && !hasPartInExecution) continue;
          addItem({
            key: `contract:${id}`,
            kind: 'contract',
            entityId: id,
            label: String(row.displayName ?? id),
            description: hasPartInExecution ? 'Деталь есть в исполнении контракта' : 'Деталь есть в списке деталей контракта',
            targetTypeCode: 'contract',
          });
        }
      }

      const serviceType = entityTypes.find((row) => row.code === 'service');
      if (serviceType?.id) {
        const services = await window.matrica.admin.entities.listByEntityType(serviceType.id);
        for (const row of services as any[]) {
          const id = String(row.id ?? '').trim();
          if (!id) continue;
          const details = await window.matrica.admin.entities.get(id);
          const partIds = Array.isArray(details?.attributes?.part_ids) ? details.attributes.part_ids.map((value: unknown) => String(value || '').trim()) : [];
          if (!partIds.includes(currentPart.id)) continue;
          addItem({
            key: `service:${id}`,
            kind: 'service',
            entityId: id,
            label: String(row.displayName ?? id),
            description: 'Деталь включена в услугу',
            targetTypeCode: 'service',
          });
        }
      }

      const workOrders = await window.matrica.workOrders.list().catch(() => ({ ok: false as const, rows: [] as unknown[] }));
      if (workOrders.ok) {
        for (const row of workOrders.rows as any[]) {
          const id = String(row?.id ?? '').trim();
          if (!id) continue;
          const details = await window.matrica.workOrders.get(id).catch(() => null);
          if (!details?.ok || !details.payload) continue;
          const payload = details.payload as WorkOrderPayload;
          const groups = Array.isArray(payload.workGroups) ? payload.workGroups : [];
          const hasPart =
            groups.some((group) => String(group?.partId ?? '') === currentPart.id) ||
            String(payload.partId ?? '') === currentPart.id;
          if (!hasPart) continue;
          addItem({
            key: `work_order:${id}`,
            kind: 'work_order',
            entityId: id,
            label: `Наряд №${String(payload.workOrderNumber ?? id)}`,
            description: 'Деталь используется в наряде',
            targetTypeCode: 'work_order',
          });
        }
      }

      const nextItems = Array.from(items.values()).sort((a, b) => {
        const kindCmp = a.kind.localeCompare(b.kind, 'ru');
        if (kindCmp !== 0) return kindCmp;
        return a.label.localeCompare(b.label, 'ru');
      });
      setUsageItems(nextItems);
      setUsageStatus(nextItems.length === 0 ? 'Связи не найдены.' : '');
    } catch (e) {
      setUsageItems([]);
      setUsageStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, [props.partId]);

  useEffect(() => {
    void loadEngineBrands();
  }, []);

  useEffect(() => {
    void loadCustomers();
    void loadContracts();
    void loadTemplates();
    void loadLinkRules();
  }, []);

  useLiveDataRefresh(
    async () => {
      if (dirtyRef.current) return;
      await load();
      await loadEngineBrands();
      await loadCustomers();
      await loadContracts();
      await loadTemplates();
    },
    { intervalMs: 20000 },
  );

  useEffect(() => {
    if (!props.canEdit || !partTypeId || partDefs.length === 0 || coreDefsReady) return;
    const desired = [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      {
        code: PART_TEMPLATE_ID_ATTR_CODE,
        name: 'Шаблон детали',
        dataType: 'link',
        sortOrder: 15,
        metaJson: JSON.stringify({ linkTargetTypeCode: 'part_template' }),
      },
      { code: 'article', name: 'Сборочный номер / артикул', dataType: 'text', sortOrder: 20 },
      { code: PART_DIMENSIONS_ATTR_CODE, name: 'Размеры', dataType: 'json', sortOrder: 25 },
      { code: 'description', name: 'Описание', dataType: 'text', sortOrder: 30 },
      { code: 'purchase_date', name: 'Дата покупки', dataType: 'date', sortOrder: 40 },
      {
        code: 'supplier_id',
        name: 'Поставщик',
        dataType: 'link',
        sortOrder: 50,
        metaJson: JSON.stringify({ linkTargetTypeCode: 'customer' }),
      },
      { code: 'supplier', name: 'Поставщик (текст)', dataType: 'text', sortOrder: 60 },
      {
        code: 'contract_id',
        name: 'Контракт',
        dataType: 'link',
        sortOrder: 65,
        metaJson: JSON.stringify({ linkTargetTypeCode: 'contract' }),
      },
      ...STATUS_CODES.flatMap((code, i) => [
        { code, name: STATUS_LABELS[code], dataType: 'boolean' as const, sortOrder: 70 + i * 2 },
        { code: statusDateCode(code), name: `Дата ${STATUS_LABELS[code]}`, dataType: 'date' as const, sortOrder: 71 + i * 2 },
      ]),
    ];
    void ensureAttributeDefs(partTypeId, desired, partDefs).then((next) => {
      if (next.length !== partDefs.length) setPartDefs(next);
      setCoreDefsReady(true);
    });
  }, [props.canEdit, partTypeId, partDefs.length, coreDefsReady]);

  // Sync local fields from loaded part (important after reload/save)
  useEffect(() => {
    if (!part) return;
    const byCode: Record<string, Attribute> = {};
    for (const a of part.attributes) byCode[a.code] = a;

    const vName = byCode.name?.value;
    const vArticle = byCode.article?.value;
    const vDesc = byCode.description?.value;
    const vPurchase = byCode.purchase_date?.value;
    const vSupplier = byCode.supplier?.value;
    const vSupplierId = byCode.supplier_id?.value;
    const vTemplateId = byCode[PART_TEMPLATE_ID_ATTR_CODE]?.value;
    const vDimensions = byCode[PART_DIMENSIONS_ATTR_CODE]?.value;

    setName(typeof vName === 'string' ? vName : vName == null ? '' : String(vName));
    setArticle(typeof vArticle === 'string' ? vArticle : vArticle == null ? '' : String(vArticle));
    setDescription(typeof vDesc === 'string' ? vDesc : vDesc == null ? '' : String(vDesc));
    setPurchaseDate(typeof vPurchase === 'number' ? toInputDate(vPurchase) : '');
    setSupplier(typeof vSupplier === 'string' ? vSupplier : vSupplier == null ? '' : String(vSupplier));
    setSupplierId(typeof vSupplierId === 'string' ? vSupplierId : vSupplierId == null ? '' : String(vSupplierId));
    setTemplateId(typeof vTemplateId === 'string' ? vTemplateId : vTemplateId == null ? '' : String(vTemplateId));
    setDimensions(normalizeDimensionsValue(vDimensions));
    const linked = normalizeBrandLinksFromPart(part);
    if (linked.length > 0) {
      setBrandLinks(sortBrandLinks(linked));
      setBrandLinkDrafts({});
      setBrandLinksStatus('');
    } else {
      setBrandLinks([]);
      setBrandLinkDrafts({});
      void loadBrandLinks(String(part.id));
    }
    const flags: Partial<Record<StatusCode, boolean>> = {};
    for (const c of STATUS_CODES) flags[c] = Boolean(byCode[c]?.value);
    setStatusFlags(flags);
    const dates: Partial<Record<StatusCode, number | null>> = {};
    for (const c of STATUS_CODES) dates[c] = normalizeDateInput(byCode[statusDateCode(c)]?.value);
    setStatusDates(dates);
    dirtyRef.current = false;
  }, [part?.id, part?.updatedAt]);

  useEffect(() => {
    if (!part) return;
    if (supplierId || !supplier.trim() || customerOptions.length === 0) return;
    const normalized = normalizeForMatch(supplier);
    const match = customerOptions.find((c) => normalizeForMatch(c.label) === normalized);
    if (!match) return;
    setSupplierId(match.id);
  }, [part?.id, supplierId, supplier, customerOptions]);

  useEffect(() => {
    if (!part) return;
    void loadUsage(part);
  }, [part?.id, part?.updatedAt, brandLinks, engineBrandOptions, contractOptions, entityTypes, linkOptionsByCode]);

  function getLinkTargetTypeCode(attr: Attribute): string | null {
    const meta = attr.metaJson;
    if (meta && typeof meta === 'object' && 'linkTargetTypeCode' in meta) {
      const code = (meta as any).linkTargetTypeCode;
      if (typeof code === 'string' && code.trim()) return code.trim();
    }
    if (typeof meta === 'string') {
      try {
        const parsed = JSON.parse(meta);
        const code = parsed?.linkTargetTypeCode;
        if (typeof code === 'string' && code.trim()) return code.trim();
      } catch {
        return null;
      }
    }
    return null;
  }

  function normalizeLookupBaseCode(code: string): string {
    const cleaned = code.trim().toLowerCase();
    if (!cleaned) return '';
    if (cleaned.endsWith('_id')) return cleaned.slice(0, -3);
    if (cleaned.endsWith('_ref')) return cleaned.slice(0, -4);
    return cleaned;
  }

  function getTextLookupConfig(attr: Attribute): TextLookupMeta | null {
    if (attr.dataType !== 'text') return null;
    const baseCode = normalizeLookupBaseCode(attr.code);
    if (!baseCode) return null;
    let meta: Record<string, unknown> | null = null;
    if (attr.metaJson && typeof attr.metaJson === 'object') {
      meta = attr.metaJson as Record<string, unknown>;
    } else if (typeof attr.metaJson === 'string') {
      try {
        const parsed = JSON.parse(attr.metaJson);
        if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
      } catch {
        meta = null;
      }
    }
    const aliases: Record<string, string> = {
      brand: 'engine_brand',
      enginebrand: 'engine_brand',
      ctr: 'customer',
      counterparty: 'customer',
      contractor: 'customer',
      partner: 'customer',
      pos: 'position_ref',
      position: 'position_ref',
      position_ref: 'position_ref',
    };
    const explicitTarget = typeof meta?.lookupTargetTypeCode === 'string' ? meta.lookupTargetTypeCode.trim().toLowerCase() : '';
    const targetTypeCode = aliases[explicitTarget] ?? aliases[baseCode] ?? baseCode;
    if (!targetTypeCode || !entityTypes.some((t) => t.code === targetTypeCode)) return null;
    const explicitStoreAs = typeof meta?.lookupStoreAs === 'string' ? meta.lookupStoreAs.trim().toLowerCase() : '';
    const storeAs: 'id' | 'label' = explicitStoreAs === 'label' ? 'label' : baseCode.endsWith('_id') ? 'id' : 'label';
    return { targetTypeCode, storeAs };
  }

  async function loadTextLookupOptions(attr: Attribute) {
    const config = getTextLookupConfig(attr);
    if (!config) return;
    if (textLookupLoadingByCode[attr.code]) return;
    const targetType = entityTypes.find((t) => t.code === config.targetTypeCode);
    if (!targetType?.id) return;
    setTextLookupLoadingByCode((prev) => ({ ...prev, [attr.code]: true }));
    try {
      const rows = await window.matrica.admin.entities.listByEntityType(String(targetType.id));
      setTextLookupOptionsByCode((prev) => ({ ...prev, [attr.code]: mapEntityRowsToSearchOptions(rows) }));
      setTextLookupMetaByCode((prev) => ({ ...prev, [attr.code]: config }));
    } finally {
      setTextLookupLoadingByCode((prev) => ({ ...prev, [attr.code]: false }));
    }
  }

  async function createTextLookupEntity(attr: Attribute, label: string): Promise<string | null> {
    const config = textLookupMetaByCode[attr.code] ?? getTextLookupConfig(attr);
    if (!config) return null;
    const id = await createMasterDataEntity(config.targetTypeCode, label);
    if (!id) return null;
    await loadTextLookupOptions(attr);
    return id;
  }

  useEffect(() => {
    if (!part) return;
    for (const attr of part.attributes) {
      if (attr.dataType !== 'link') continue;
      const targetTypeCode = getLinkTargetTypeCode(attr);
      if (!targetTypeCode) continue;
      if (linkOptionsByCode[attr.code] || linkLoadingByCode[attr.code]) continue;
      void loadLinkOptions(targetTypeCode, attr.code);
    }
  }, [part?.id, part?.updatedAt, linkOptionsByCode, linkLoadingByCode]);

  useEffect(() => {
    if (!part) return;
    for (const attr of part.attributes) {
      if (attr.dataType !== 'text') continue;
      const config = getTextLookupConfig(attr);
      if (!config) continue;
      if (textLookupOptionsByCode[attr.code] || textLookupLoadingByCode[attr.code]) continue;
      void loadTextLookupOptions(attr);
    }
  }, [part?.id, part?.updatedAt, entityTypes, textLookupOptionsByCode, textLookupLoadingByCode]);

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        await saveAllAndClose();
      },
      reset: async () => {
        await load();
        dirtyRef.current = false;
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
      },
      copyToNew: async () => {
        const attrs: Record<string, unknown> = {};
        if (name.trim()) attrs.name = name.trim();
        if (article.trim()) attrs.article = article.trim();
        const r = await window.matrica.parts.create(name.trim() || article.trim() ? { attributes: attrs } : undefined);
        if (r?.ok && r?.part?.id) {
          invalidateListAllPartsCache();
          dirtyRef.current = false;
        }
      },
    });
    return () => {
      props.registerCardCloseActions?.(null);
    };
  }, [name, article, props.registerCardCloseActions]);

  useEffect(() => {
    return () => {
      if (attributeSaveTimerRef.current) {
        clearTimeout(attributeSaveTimerRef.current);
        attributeSaveTimerRef.current = null;
      }
      if (pendingAttributeSaveResolversRef.current.length > 0) {
        resolvePendingAttributeSaves({ ok: false, error: 'component unmounted' });
      }
      if (brandLinkQueueTimerRef.current) {
        clearTimeout(brandLinkQueueTimerRef.current);
        brandLinkQueueTimerRef.current = null;
      }
      if (pendingBrandLinkOperationResolversRef.current.length > 0) {
        resolvePendingBrandLinkOperations({ ok: false, error: 'component unmounted' });
      }
      if (fieldQueueTimerRef.current) {
        clearTimeout(fieldQueueTimerRef.current);
        fieldQueueTimerRef.current = null;
      }
      if (fieldOrderQueueTimerRef.current) {
        clearTimeout(fieldOrderQueueTimerRef.current);
        fieldOrderQueueTimerRef.current = null;
      }
      if (pendingFieldOperationResolversRef.current.length > 0) {
        resolvePendingFieldOperations({ ok: false, error: 'component unmounted' });
      }
      if (pendingFieldOrderResolversRef.current.length > 0) {
        resolvePendingFieldOrderOperations({ ok: false, error: 'component unmounted' });
      }
      pendingAttributeSaveValuesRef.current.clear();
      pendingBrandLinkOperationsRef.current = [];
      pendingFieldOperationsRef.current = [];
      pendingFieldOrderCodesRef.current = null;
    };
  }, []);

  type SaveAttributeOptions = {
    suppressStatus?: boolean;
    suppressReload?: boolean;
  };

  type SaveAttributeResult = { ok: true; queued?: boolean } | { ok: false; error: string };
  type BrandLinkSaveResult = { ok: true } | { ok: false; error: string };
  type QueuedBrandLinkOperation = {
    type: 'upsert' | 'delete';
    linkId?: string;
    payload?: {
      partId: string;
      engineBrandId: string;
      assemblyUnitNumber: string;
      quantity: number;
      linkId?: string;
    };
    affectedBrandIds?: string[];
    clearDraftLinkId?: string;
  };
  type FieldOperationResult = { ok: true } | { ok: false; error: string };
  type QueuedFieldOperation = {
    code: string;
    name: string;
    dataType: 'text' | 'number' | 'boolean' | 'date' | 'json' | 'link';
    isRequired: boolean;
    sortOrder: number;
    metaJson: string | null;
    linkTargetCode?: string;
  };
  type FieldOrderSaveResult = { ok: true } | { ok: false; error: string };
  type FieldOrderOperation = { orderedCodes: string[]; startAt: number };

  const ATTRIBUTE_SAVE_BATCH_DELAY_MS = 220;
  const BRAND_LINK_BATCH_DELAY_MS = 220;
  const FIELD_BATCH_DELAY_MS = 220;
  const FIELD_ORDER_BATCH_DELAY_MS = 220;
  const FIELD_ORDER_START_AT_DEFAULT = 10;

  function normalizeCoreFieldValue(value: unknown) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
  }

  function getAttributeCurrentValue(code: string): unknown {
    const found = part?.attributes.find((a) => a.code === code);
    return found ? found.value : undefined;
  }

  function resolvePendingAttributeSaves(result: SaveAttributeResult) {
    const resolvers = pendingAttributeSaveResolversRef.current;
    pendingAttributeSaveResolversRef.current = [];
    for (const resolve of resolvers) resolve(result);
  }

  function resolvePendingBrandLinkOperations(result: BrandLinkSaveResult) {
    const resolvers = pendingBrandLinkOperationResolversRef.current;
    pendingBrandLinkOperationResolversRef.current = [];
    for (const resolve of resolvers) resolve(result);
  }

  function resolvePendingFieldOperations(result: FieldOperationResult) {
    const resolvers = pendingFieldOperationResolversRef.current;
    pendingFieldOperationResolversRef.current = [];
    for (const resolve of resolvers) resolve(result);
  }

  function resolvePendingFieldOrderOperations(result: FieldOrderSaveResult) {
    const resolvers = pendingFieldOrderResolversRef.current;
    pendingFieldOrderResolversRef.current = [];
    for (const resolve of resolvers) resolve(result);
  }

  function flushFieldOrderQueue() {
    if (isSavingFieldOrderQueueRef.current) return;
    if (!partTypeId || !pendingFieldOrderCodesRef.current) return;

    isSavingFieldOrderQueueRef.current = true;
    if (fieldOrderQueueTimerRef.current) {
      clearTimeout(fieldOrderQueueTimerRef.current);
      fieldOrderQueueTimerRef.current = null;
    }

    const queuedOrder = pendingFieldOrderCodesRef.current;
    pendingFieldOrderCodesRef.current = null;
    const orderedCodes = [...queuedOrder.orderedCodes];
    const startAt = queuedOrder.startAt;

    (async () => {
      try {
        await persistFieldOrder(orderedCodes, partDefs, { entityTypeId: partTypeId, startAt });
        setPartDefs((prev) => [...prev]);
        resolvePendingFieldOrderOperations({ ok: true });
      } catch (error) {
        const err = String(error);
        setStatus(`Ошибка: ${err}`);
        resolvePendingFieldOrderOperations({ ok: false, error: err });
      } finally {
        isSavingFieldOrderQueueRef.current = false;
        if (pendingFieldOrderCodesRef.current) {
          void flushFieldOrderQueue();
        }
      }
    })();
  }

  function queueFieldOrderOperation(orderedCodes: string[], options?: { startAt?: number }): Promise<FieldOrderSaveResult> {
    const result = new Promise<FieldOrderSaveResult>((resolve) => {
      dirtyRef.current = true;
      pendingFieldOrderCodesRef.current = {
        orderedCodes: [...orderedCodes],
        startAt: options?.startAt ?? FIELD_ORDER_START_AT_DEFAULT,
      };
      pendingFieldOrderResolversRef.current.push((payload) => {
        resolve(payload);
      });
      if (fieldOrderQueueTimerRef.current) {
        clearTimeout(fieldOrderQueueTimerRef.current);
      }
      fieldOrderQueueTimerRef.current = setTimeout(() => {
        void flushFieldOrderQueue();
      }, FIELD_ORDER_BATCH_DELAY_MS);
    });

    return result;
  }

  async function flushBrandLinkQueue() {
    if (isSavingBrandLinkQueueRef.current) return;
    if (!pendingBrandLinkOperationsRef.current.length) return;

    isSavingBrandLinkQueueRef.current = true;
    if (brandLinkQueueTimerRef.current) {
      clearTimeout(brandLinkQueueTimerRef.current);
      brandLinkQueueTimerRef.current = null;
    }

    const queue = [...pendingBrandLinkOperationsRef.current];
    pendingBrandLinkOperationsRef.current = [];
    setBrandLinksStatus('Сохранение...');

    const affectedBrandIds = new Set<string>();
    const clearDraftLinkIds: string[] = [];
    let lastError: string | null = null;

    for (const op of queue) {
      if (op.type === 'upsert') {
        if (!op.payload) {
          lastError = 'Не хватает данных для сохранения связи';
          break;
        }
        const r = await window.matrica.parts.partBrandLinks.upsert(op.payload);
        if (!r?.ok) {
          lastError = String((r as any).error ?? 'Не удалось сохранить связь');
          break;
        }
      } else {
        if (!op.linkId) {
          lastError = 'Не хватает идентификатора связи для удаления';
          break;
        }
        const r = await window.matrica.parts.partBrandLinks.delete({ partId: props.partId, linkId: op.linkId });
        if (!r?.ok) {
          lastError = String((r as any).error ?? 'Не удалось удалить связь');
          break;
        }
      }
      if (op.clearDraftLinkId) {
        clearDraftLinkIds.push(op.clearDraftLinkId);
      }
      for (const affectedBrandId of op.affectedBrandIds ?? []) {
        if (affectedBrandId) affectedBrandIds.add(affectedBrandId);
      }
    }

    if (lastError) {
      setBrandLinksStatus(`Ошибка: ${lastError}`);
      isSavingBrandLinkQueueRef.current = false;
      resolvePendingBrandLinkOperations({ ok: false, error: lastError });
      if (pendingBrandLinkOperationsRef.current.length > 0) {
        void flushBrandLinkQueue();
      }
      return;
    }

    await loadBrandLinks();
    if (clearDraftLinkIds.length) {
      setBrandLinkDrafts((prev) => {
        const next = { ...prev };
        for (const linkId of clearDraftLinkIds) {
          delete next[linkId];
        }
        return next;
      });
    }
    if (affectedBrandIds.size > 0) void persistEngineBrandSummaries(Array.from(affectedBrandIds));
    setBrandLinksStatus('Сохранено');
    setTimeout(() => {
      setBrandLinksStatus((prev) => (prev.startsWith('Ошибка') ? prev : ''));
    }, 1500);
    isSavingBrandLinkQueueRef.current = false;
    resolvePendingBrandLinkOperations({ ok: true });
    if (pendingBrandLinkOperationsRef.current.length > 0) {
      void flushBrandLinkQueue();
    }
  }

  async function queueBrandLinkOperation(op: QueuedBrandLinkOperation): Promise<BrandLinkSaveResult> {
    const result = await new Promise<BrandLinkSaveResult>((resolve) => {
      dirtyRef.current = true;
      pendingBrandLinkOperationsRef.current.push(op);
      pendingBrandLinkOperationResolversRef.current.push((payload) => {
        resolve(payload);
      });
      if (brandLinkQueueTimerRef.current) {
        clearTimeout(brandLinkQueueTimerRef.current);
      }
      brandLinkQueueTimerRef.current = setTimeout(() => {
        void flushBrandLinkQueue();
      }, BRAND_LINK_BATCH_DELAY_MS);
    });

    return result;
  }

  async function flushFieldQueue() {
    if (isSavingFieldQueueRef.current) return;
    if (!pendingFieldOperationsRef.current.length) return;

    isSavingFieldQueueRef.current = true;
    if (fieldQueueTimerRef.current) {
      clearTimeout(fieldQueueTimerRef.current);
      fieldQueueTimerRef.current = null;
    }

    const queue = [...pendingFieldOperationsRef.current];
    pendingFieldOperationsRef.current = [];
    setAddFieldStatus('Создание полей…');

    let hasError: string | null = null;
    for (const op of queue) {
      const r = await window.matrica.parts.createAttributeDef({
        code: op.code,
        name: op.name,
        dataType: op.dataType,
        isRequired: op.isRequired,
        sortOrder: op.sortOrder,
        metaJson: op.metaJson,
      });
      if (!r?.ok) {
        hasError = String(r.error ?? 'Ошибка создания поля');
        break;
      }

      if (op.linkTargetCode) {
        const ruleResult = await upsertLinkRule(op.name, op.linkTargetCode, { suppressReload: true });
        if (!ruleResult.ok) {
          hasError = ruleResult.error;
          break;
        }
      }
    }

    if (hasError) {
      setAddFieldStatus(`Ошибка: ${hasError}`);
      isSavingFieldQueueRef.current = false;
      resolvePendingFieldOperations({ ok: false, error: hasError });
      if (pendingFieldOperationsRef.current.length > 0) {
        void flushFieldQueue();
      }
      return;
    }

    await load();
    await loadLinkRules();

    const addedCount = queue.length;
    setAddFieldStatus(addedCount > 1 ? `Добавлено полей: ${addedCount}` : 'Поле добавлено');
    setTimeout(() => setAddFieldStatus(''), 1200);

    isSavingFieldQueueRef.current = false;
    resolvePendingFieldOperations({ ok: true });
    if (pendingFieldOperationsRef.current.length > 0) {
      void flushFieldQueue();
    }
  }

  async function queueFieldOperation(op: QueuedFieldOperation): Promise<FieldOperationResult> {
    const result = await new Promise<FieldOperationResult>((resolve) => {
      dirtyRef.current = true;
      pendingFieldOperationsRef.current.push(op);
      pendingFieldOperationResolversRef.current.push((payload) => {
        resolve(payload);
      });
      if (fieldQueueTimerRef.current) {
        clearTimeout(fieldQueueTimerRef.current);
      }
      fieldQueueTimerRef.current = setTimeout(() => {
        void flushFieldQueue();
      }, FIELD_BATCH_DELAY_MS);
    });

    return result;
  }

  async function flushAttributeSaveQueue() {
    if (isSavingAttributeQueueRef.current) return;
    const entries = Array.from(pendingAttributeSaveValuesRef.current.entries());
    if (!entries.length) return;

    isSavingAttributeQueueRef.current = true;
    if (attributeSaveTimerRef.current) {
      clearTimeout(attributeSaveTimerRef.current);
      attributeSaveTimerRef.current = null;
    }

    const queue = new Map(entries);
    pendingAttributeSaveValuesRef.current.clear();

    setStatus('Сохранение…');
    let hasQueued = false;
    let lastError: string | null = null;

    for (const [code, value] of queue) {
      const r = await saveAttributeCore(code, value, { suppressReload: true, suppressStatus: true });
      if (!r.ok) {
        lastError = r.error;
        break;
      }
      if ((r as any).queued) {
        hasQueued = true;
      }
    }

    if (lastError) {
      setStatus(`Ошибка: ${lastError}`);
      isSavingAttributeQueueRef.current = false;
      resolvePendingAttributeSaves({ ok: false, error: lastError });
      if (pendingAttributeSaveValuesRef.current.size > 0) {
        void flushAttributeSaveQueue();
      }
      return;
    }

    await load();
    isSavingAttributeQueueRef.current = false;
    const finalResult = hasQueued ? { ok: true, queued: true } : { ok: true };
    setStatus(hasQueued ? 'Отправлено на утверждение (см. «Изменения»)' : 'Сохранено');
    setTimeout(() => setStatus(''), 2000);
    resolvePendingAttributeSaves(finalResult);
    if (pendingAttributeSaveValuesRef.current.size > 0) {
      void flushAttributeSaveQueue();
    }
  }

  async function saveAttribute(code: string, value: unknown): Promise<SaveAttributeResult> {
    if (!props.canEdit) return { ok: false, error: 'no permission' };
    if (!part) return { ok: false, error: 'part not loaded' };

    const previous = getAttributeCurrentValue(code);
    if (Object.is(normalizeCoreFieldValue(previous), normalizeCoreFieldValue(value))) {
      return { ok: true };
    }

    pendingAttributeSaveValuesRef.current.set(code, normalizeCoreFieldValue(value));
    dirtyRef.current = true;

    const result = await new Promise<SaveAttributeResult>((resolve) => {
      pendingAttributeSaveResolversRef.current.push((payload) => {
        resolve(payload);
      });
      if (attributeSaveTimerRef.current) {
        clearTimeout(attributeSaveTimerRef.current);
      }
      attributeSaveTimerRef.current = setTimeout(() => {
        void flushAttributeSaveQueue();
      }, ATTRIBUTE_SAVE_BATCH_DELAY_MS);
    });

    return result;
  }

  async function saveAttributeCore(
    code: string,
    value: unknown,
    options: SaveAttributeOptions = {},
  ): Promise<SaveAttributeResult> {
    if (!props.canEdit) return { ok: false, error: 'no permission' };
    try {
      if (!options.suppressStatus) setStatus('Сохранение…');
      const r = await window.matrica.parts.updateAttribute({ partId: props.partId, attributeCode: code, value });
      if (!r.ok) {
        if (!options.suppressStatus) setStatus(`Ошибка: ${r.error}`);
        return r;
      }
      invalidateListAllPartsCache();
      if (!options.suppressReload) {
        void load();
      }
      if (!options.suppressStatus) {
        if ((r as any).queued) {
          setStatus('Отправлено на утверждение (см. «Изменения»)');
          setTimeout(() => setStatus(''), 2500);
        } else {
          setStatus('Сохранено');
          setTimeout(() => setStatus(''), 2000);
        }
      }
      return r as any;
    } catch (e) {
      const err = String(e);
      if (!options.suppressStatus) setStatus(`Ошибка: ${err}`);
      return { ok: false, error: err };
    }
  }

  async function drainAttributeQueue(): Promise<SaveAttributeResult> {
    if (!pendingAttributeSaveValuesRef.current.size && !isSavingAttributeQueueRef.current) return { ok: true };
    return new Promise<SaveAttributeResult>((resolve) => {
      pendingAttributeSaveResolversRef.current.push(resolve);
      if (!isSavingAttributeQueueRef.current) {
        void flushAttributeSaveQueue();
      }
    });
  }

  async function drainBrandLinkQueue(): Promise<BrandLinkSaveResult> {
    if (!pendingBrandLinkOperationsRef.current.length && !isSavingBrandLinkQueueRef.current) return { ok: true };
    return new Promise<BrandLinkSaveResult>((resolve) => {
      pendingBrandLinkOperationResolversRef.current.push(resolve);
      if (!isSavingBrandLinkQueueRef.current) {
        void flushBrandLinkQueue();
      }
    });
  }

  async function drainFieldQueue(): Promise<FieldOperationResult> {
    if (!pendingFieldOperationsRef.current.length && !isSavingFieldQueueRef.current) return { ok: true };
    return new Promise<FieldOperationResult>((resolve) => {
      pendingFieldOperationResolversRef.current.push(resolve);
      if (!isSavingFieldQueueRef.current) {
        void flushFieldQueue();
      }
    });
  }

  async function drainFieldOrderQueue(): Promise<FieldOrderSaveResult> {
    if (!pendingFieldOrderCodesRef.current && !isSavingFieldOrderQueueRef.current) return { ok: true };
    return new Promise<FieldOrderSaveResult>((resolve) => {
      pendingFieldOrderResolversRef.current.push(resolve);
      if (!isSavingFieldOrderQueueRef.current) {
        void flushFieldOrderQueue();
      }
    });
  }

  async function saveCore(): Promise<boolean> {
    if (!props.canEdit) return true;
    if (!part) return false;
    if (isSavingCoreRef.current) return false;
    isSavingCoreRef.current = true;
    const suppressReloadAndStatus = { suppressReload: true, suppressStatus: true };
    try {
      const byCode = new Map(part.attributes.map((a) => [a.code, a.value] as const));
      const supplierLabel = supplierId ? customerOptions.find((c) => c.id === supplierId)?.label ?? '' : '';

      const candidates: Array<[string, unknown]> = [
        ['name', name],
        ['article', article],
        ['description', description],
        [PART_TEMPLATE_ID_ATTR_CODE, templateId || null],
        [PART_DIMENSIONS_ATTR_CODE, dimensions],
        ['purchase_date', fromInputDate(purchaseDate)],
        ['supplier_id', supplierId || null],
        ['supplier', supplierLabel || supplier],
        ...STATUS_CODES.flatMap((code) => [[code, statusFlags[code] ?? false], [statusDateCode(code), statusDates[code] ?? null]] as const),
      ];

      const updates = candidates.filter(([code, nextValue]) => {
        const prev = byCode.get(code);
        return !Object.is(normalizeCoreFieldValue(prev), normalizeCoreFieldValue(nextValue));
      });

      if (updates.length === 0) {
        setStatus('Нет изменений');
        setTimeout(() => setStatus(''), 1000);
        return true;
      }

      setStatus('Сохранение…');
      let hasQueued = false;
      for (const [code, value] of updates) {
        const r = await saveAttributeCore(code, value, suppressReloadAndStatus);
        if (!r.ok) {
          setStatus(`Ошибка: ${r.error}`);
          return false;
        }
        if ((r as any).queued) hasQueued = true;
      }

      await load();
      setStatus(hasQueued ? 'Отправлено на утверждение (см. «Изменения»)' : 'Сохранено');
      setTimeout(() => setStatus(''), 2000);
      dirtyRef.current = false;
      return true;
    } finally {
      isSavingCoreRef.current = false;
    }
  }

  async function saveAllAndClose(): Promise<boolean> {
    if (!props.canEdit) {
      dirtyRef.current = false;
      return true;
    }
    const attributeResult = await drainAttributeQueue();
    if (!attributeResult.ok) {
      throw new Error(attributeResult.error ?? 'Не удалось сохранить изменения атрибутов');
    }
    const brandLinkResult = await drainBrandLinkQueue();
    if (!brandLinkResult.ok) {
      throw new Error(brandLinkResult.error ?? 'Не удалось сохранить связи марки двигателя');
    }
    const fieldResult = await drainFieldQueue();
    if (!fieldResult.ok) {
      throw new Error(fieldResult.error ?? 'Не удалось сохранить новые поля');
    }
    const fieldOrderResult = await drainFieldOrderQueue();
    if (!fieldOrderResult.ok) {
      throw new Error(fieldOrderResult.error ?? 'Не удалось сохранить порядок полей');
    }
    const saved = await saveCore();
    if (!saved) {
      throw new Error('Не удалось сохранить карточку детали');
    }
    dirtyRef.current = false;
    return true;
  }

  async function handleDelete() {
    if (!props.canDelete) return;
    if (!confirm('Удалить деталь?')) return;
    try {
      setStatus('Удаление…');
      const r = await window.matrica.parts.delete(props.partId);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      invalidateListAllPartsCache();
      props.onClose();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (!part) {
    return (
      <div>
        {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}
      </div>
    );
  }

  const sortedAttrs = [...part.attributes].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  const coreCodes = new Set([
    'name',
    PART_TEMPLATE_ID_ATTR_CODE,
    'article',
    'description',
    PART_DIMENSIONS_ATTR_CODE,
    'purchase_date',
    'supplier',
    'supplier_id',
    ...STATUS_CODES,
    ...STATUS_CODES.map((code) => statusDateCode(code)),
  ]);
  // Эти поля имеют отдельные UI-блоки (связи/вложения) и не должны отображаться как "сырой JSON".
  const hiddenFromExtra = new Set([
    'assembly_unit_number',
    'engine_brand_ids',
    'engine_brand_qty_map',
    'drawings',
    'tech_docs',
    'attachments',
    'contract_id',
  ]);
  const extraAttrs = sortedAttrs.filter((a) => !coreCodes.has(a.code) && !hiddenFromExtra.has(a.code));

  const attrByCode = new Map<string, Attribute>();
  for (const a of part.attributes) attrByCode.set(a.code, a);

  const engineBrandLabelById = new Map<string, string>();
  for (const o of engineBrandOptions) engineBrandLabelById.set(o.id, o.label);

  const mainFields = orderFieldsByDefs(
    [
      {
        code: 'name',
        defaultOrder: 10,
        label: 'Название',
        value: name,
        render: (
          <Input
            value={name}
            disabled={!props.canEdit}
            onChange={(e) => {
              dirtyRef.current = true;
              setName(e.target.value);
            }}
          />
        ),
      },
      {
        code: PART_TEMPLATE_ID_ATTR_CODE,
        defaultOrder: 15,
        label: 'Шаблон детали',
        value: templateOptions.find((row) => row.id === templateId)?.label ?? (templateId || ''),
        render: (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
            <SearchSelectWithCreate
              value={templateId || null}
              options={templateOptions}
              placeholder="Выберите шаблон детали"
              disabled={!props.canEdit}
              canCreate={props.canEdit}
              createLabel="Новый шаблон"
              onChange={(next) => {
                dirtyRef.current = true;
                setTemplateId(next ?? '');
              }}
              onCreate={async (label) => {
                const id = await createPartTemplate(label);
                if (!id) return null;
                dirtyRef.current = true;
                setTemplateId(id);
                return id;
              }}
            />
            {templateStatus && (
              <span style={{ color: templateStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{templateStatus}</span>
            )}
          </div>
        ),
      },
      {
        code: 'article',
        defaultOrder: 20,
        label: 'Сборочный номер / артикул',
        value: article,
        render: (
          <Input
            value={article}
            disabled={!props.canEdit}
            onChange={(e) => {
              dirtyRef.current = true;
              setArticle(e.target.value);
            }}
          />
        ),
      },
      {
        code: 'description',
        defaultOrder: 30,
        label: 'Описание',
        value: description,
        render: (
          <Textarea
            value={description}
            disabled={!props.canEdit}
            onChange={(e) => {
              dirtyRef.current = true;
              setDescription(e.target.value);
            }}
          />
        ),
      },
      {
        code: 'purchase_date',
        defaultOrder: 40,
        label: 'Дата покупки',
        value: purchaseDate || '',
        render: (
          <Input
            type="date"
            value={purchaseDate}
            disabled={!props.canEdit}
            onChange={(e) => {
              dirtyRef.current = true;
              setPurchaseDate(e.target.value);
            }}
          />
        ),
      },
      {
        code: 'supplier_id',
        defaultOrder: 50,
        label: 'Поставщик',
        value: supplier || '',
        render: (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
            <SearchSelectWithCreate
              value={supplierId}
              options={customerOptions}
              placeholder="Выберите поставщика"
              disabled={!props.canEdit}
              canCreate={props.canEdit}
              createLabel="Новый поставщик"
              onChange={(next) => {
                dirtyRef.current = true;
                setSupplierId(next ?? '');
                const label = customerOptions.find((c) => c.id === next)?.label ?? '';
                setSupplier(label);
              }}
              onCreate={async (label) => {
                const id = await createMasterDataEntity('customer', label);
                if (!id) return null;
                const clean = label.trim();
                dirtyRef.current = true;
                setSupplierId(id);
                setSupplier(clean);
                return id;
              }}
            />
            {supplierId && props.onOpenCustomer ? (
              <Button
                variant="outline"
                tone="neutral"
                size="sm"
                onClick={() => props.onOpenCustomer?.(supplierId)}
              >
                Открыть
              </Button>
            ) : null}
            {customerStatus && (
              <span style={{ color: customerStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{customerStatus}</span>
            )}
          </div>
        ),
      },
      ...STATUS_CODES.map((code) => {
        const dateValue = toInputDate(statusDates[code] ?? null);
        return {
          code,
          defaultOrder: 70 + STATUS_CODES.indexOf(code) * 2,
          label: STATUS_LABELS[code],
          value: statusFlags[code] ? 'да' : 'нет',
          render: (
            <div key={code} style={{ display: 'grid', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={!!statusFlags[code]}
                  disabled={!props.canEdit}
                  onChange={(e) => {
                    const next = e.target.checked;
                    dirtyRef.current = true;
                    setStatusFlags((prev) => ({ ...prev, [code]: next }));
                    setStatusDates((prev) => ({
                      ...prev,
                      [code]: next ? prev[code] ?? Date.now() : null,
                    }));
                  }}
                />
                <span>{statusFlags[code] ? 'Да' : 'Нет'}</span>
              </label>
              <Input
                type="date"
                value={dateValue}
                disabled={!props.canEdit}
                onChange={(e) => {
                  dirtyRef.current = true;
                  setStatusDates((prev) => ({ ...prev, [code]: fromInputDate(e.target.value) }));
                }}
              />
            </div>
          ),
        };
      }),
    ],
    partDefs,
  );

  function BrandLinksEditor() {
    const statusText = brandLinksStatus;
    const canEdit = props.canEdit;
    const rowStyle: React.CSSProperties = { display: 'grid', gap: 10 };

    const rows = brandLinks.map((link) => {
      const draft = getDraft(link.id, link);
      const brandName = engineBrandLabelById.get(link.engineBrandId) ?? link.engineBrandId;
      const normalizedOriginalQuantity = Number.isFinite(link.quantity) ? Number(link.quantity) : 0;
      const isDirty =
        draft.engineBrandId !== link.engineBrandId ||
        draft.assemblyUnitNumber !== (link.assemblyUnitNumber || '') ||
        draft.quantity !== normalizedOriginalQuantity;

      return (
        <div key={link.id} style={rowStyle}>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: canEdit ? '2fr 2.2fr 1fr 150px' : '2fr 2.2fr 1fr', alignItems: 'end' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
              <SearchSelect
                value={draft.engineBrandId || null}
                options={engineBrandOptions}
                disabled={!canEdit}
                placeholder="Марка двигателя"
                onChange={(next) => setDraft(link.id, { engineBrandId: next || '' })}
              />
              {draft.engineBrandId && props.onOpenEngineBrand ? (
                <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenEngineBrand?.(draft.engineBrandId)}>
                  Открыть
                </Button>
              ) : null}
            </div>
            <Input
              value={draft.assemblyUnitNumber}
              disabled={!canEdit}
              placeholder="Номер сборочной единицы"
              onChange={(e) => setDraft(link.id, { assemblyUnitNumber: e.target.value })}
            />
            <Input
              type="number"
              value={Number.isFinite(draft.quantity) ? String(draft.quantity) : '0'}
              disabled={!canEdit}
              min={0}
              step="1"
              onChange={(e) => {
                const parsed = Number(e.target.value);
                setDraft(link.id, { quantity: Number.isFinite(parsed) ? parsed : draft.quantity });
              }}
            />
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button
                  variant="ghost"
                  tone="success"
                  onClick={() =>
                    void upsertBrandLink({
                      linkId: link.id,
                      engineBrandId: draft.engineBrandId,
                      assemblyUnitNumber: draft.assemblyUnitNumber,
                      quantity: Number.isFinite(draft.quantity) ? draft.quantity : 0,
                    })
                  }
                  disabled={!isDirty || !draft.engineBrandId || !draft.assemblyUnitNumber}
                >
                  Сохранить
                </Button>
                <Button
                  variant="ghost"
                  tone="danger"
                  onClick={() => void deleteBrandLink(link.id)}
                  disabled={!canEdit}
                >
                  Удалить
                </Button>
              </div>
            )}
          </div>
          <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
            Текущая запись: {brandName} — {link.assemblyUnitNumber || 'без сборочного'} (шт. {link.quantity})
          </div>
        </div>
      );
    });

    const canAdd = canEdit && Boolean(newBrandLink.engineBrandId.trim()) && Boolean(newBrandLink.assemblyUnitNumber.trim());

    return (
      <div style={{ display: 'grid', gap: 12 }}>
        {engineBrandStatus && (
          <div style={{ color: engineBrandStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{engineBrandStatus}</div>
        )}

        {canEdit && (
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '2fr 2.2fr 1fr 150px', alignItems: 'end' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
              <SearchSelect
                value={newBrandLink.engineBrandId || null}
                options={engineBrandOptions}
                disabled={!canEdit}
                placeholder="Выберите марку"
                onChange={(next) => setNewBrandLink((prev) => ({ ...prev, engineBrandId: next || '' }))}
              />
              {newBrandLink.engineBrandId && props.onOpenEngineBrand ? (
                <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenEngineBrand?.(newBrandLink.engineBrandId)}>
                  Открыть
                </Button>
              ) : null}
            </div>
            <Input
              value={newBrandLink.assemblyUnitNumber}
              disabled={!canEdit}
              placeholder="Номер сборочной единицы"
              onChange={(e) => setNewBrandLink((prev) => ({ ...prev, assemblyUnitNumber: e.target.value }))}
            />
            <Input
              type="number"
              value={String(newBrandLink.quantity)}
              disabled={!canEdit}
              min={0}
              step="1"
              onChange={(e) => {
                const parsed = Number(e.target.value);
                setNewBrandLink((prev) => ({ ...prev, quantity: Number.isFinite(parsed) ? parsed : 0 }));
              }}
            />
            <Button
              variant="ghost"
              tone="success"
              onClick={() => {
                if (!canAdd) return;
                void upsertBrandLink(newBrandLink);
              }}
              disabled={!canAdd}
            >
              Добавить
            </Button>
          </div>
        )}

        {brandLinks.length === 0 ? (
          <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Связей не задано.</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>{rows}</div>
        )}

        {statusText && <div style={{ color: statusText.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{statusText}</div>}
      </div>
    );
  }

  function printPartCard() {
    if (!part) return;
    const mainRows: Array<[string, string]> = mainFields.map((f) => [f.label, String(f.value ?? '')]);
    const compatibility = brandLinks
      .map((link) => {
        const brand = engineBrandLabelById.get(link.engineBrandId) ?? link.engineBrandId;
        const asm = link.assemblyUnitNumber ? ` (${link.assemblyUnitNumber})` : '';
        return `${brand}${asm} — ${link.quantity}`;
      })
      .filter(Boolean)
      .join(', ');
    const extraRows = extraAttrs.map((a) => [a.name || a.code, formatValue(a.value)]);
    openPrintPreview({
      title: 'Карточка детали',
      ...(name ? { subtitle: `Название: ${name}` } : {}),
      sections: [
        { id: 'main', title: 'Основное', html: keyValueTable(mainRows) },
        { id: 'compat', title: 'Совместимость', html: compatibility ? `<div>${escapeHtml(compatibility)}</div>` : '<div class="muted">Нет данных</div>' },
        {
          id: 'extra',
          title: 'Дополнительные поля',
          html: extraRows.length > 0 ? keyValueTable(extraRows as Array<[string, string]>) : '<div class="muted">Нет данных</div>',
        },
        {
          id: 'files',
          title: 'Файлы',
          html:
            `<div><strong>Вложения</strong>${fileListHtml(attrByCode.get('attachments')?.value)}</div>` +
            `<div style="margin-top:8px;"><strong>Чертежи</strong>${fileListHtml(attrByCode.get('drawings')?.value)}</div>` +
            `<div style="margin-top:8px;"><strong>Тех. документы</strong>${fileListHtml(attrByCode.get('tech_docs')?.value)}</div>`,
        },
        {
          id: 'meta',
          title: 'Карточка',
          html: keyValueTable([
            ['ID', part.id],
            ['Создано', formatMoscowDateTime(part.createdAt)],
            ['Обновлено', formatMoscowDateTime(part.updatedAt)],
          ]),
        },
      ],
    });
  }

  function openUsageItem(item: UsageItem) {
    if (item.kind === 'contract') {
      props.onOpenContract?.(item.entityId);
      return;
    }
    if (item.kind === 'engine_brand') {
      props.onOpenEngineBrand?.(item.entityId);
      return;
    }
    const byCodeHandler = item.targetTypeCode ? props.onOpenByCode?.[item.targetTypeCode] : undefined;
    byCodeHandler?.(item.entityId);
  }


  const headerTitle = name.trim() ? `Деталь: ${name.trim()}` : 'Карточка детали';

  return (
    <EntityCardShell
      title={headerTitle}
      layout="two-column"
      cardActions={
        <CardActionBar
          canEdit={props.canEdit}
          onCopyToNew={
            props.canEdit
              ? async () => {
                  const attrs: Record<string, unknown> = {};
                  if (name.trim()) attrs.name = name.trim();
                  if (article.trim()) attrs.article = article.trim();
                  const r = await window.matrica.parts.create(name.trim() || article.trim() ? { attributes: attrs } : undefined);
                  if (r?.ok && r?.part?.id) {
          invalidateListAllPartsCache();
                    dirtyRef.current = false;
                  }
                }
              : undefined
          }
          onSaveAndClose={
            props.canEdit
              ? () =>
                  void (async () => {
                    const saved = await saveAllAndClose();
                    if (saved) props.onClose();
                  })()
              : undefined
          }
          onReset={props.canEdit ? () => void load().then(() => { dirtyRef.current = false; }) : undefined}
          onPrint={printPartCard}
          onDelete={props.canDelete ? () => void handleDelete() : undefined}
          onClose={props.requestClose ? () => props.requestClose?.() : undefined}
        />
      }
      status={status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
    >
      {status && <div className="entity-card-span-full" style={{ marginBottom: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}

        <div className="entity-card-span-full" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(520px, 100%), 1fr))', gap: 10 }}>
        {/* Core */}
        <SectionCard
          title="Основное"
          style={{ borderRadius: 0, padding: 16 }}
        >

          <DraggableFieldList
            items={mainFields}
            getKey={(f) => f.code}
            canDrag={props.canEdit}
            onReorder={(next) => {
              if (!partTypeId) return;
              void queueFieldOrderOperation(next.map((f) => f.code), { startAt: 10 });
            }}
            renderItem={(field, itemProps, _dragHandleProps, state) => (
              <div
                {...itemProps}
                className="card-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(140px, 180px) 1fr',
                  gap: 8,
                  alignItems: 'center',
                  padding: '4px 6px',
                  border: state.isOver ? '1px dashed var(--input-border-focus)' : '1px solid var(--card-row-border)',
                  background: state.isDragging ? 'var(--card-row-drag-bg)' : undefined,
                }}
              >
                <div
                  style={{
                    color: 'var(--subtle)',
                    alignSelf: field.code === 'description' ? 'start' : 'center',
                    paddingTop: field.code === 'description' ? 10 : 0,
                  }}
                >
                  {field.label}
                </div>
                {field.render}
              </div>
            )}
          />
        </SectionCard>

        <SectionCard title="Совместимость" style={{ borderRadius: 0, padding: 16 }}>
          <BrandLinksEditor />
        </SectionCard>

        <SectionCard title="Размеры детали" style={{ borderRadius: 0, padding: 16 }}>
          <div style={{ display: 'grid', gap: 10 }}>
            {dimensions.length === 0 ? (
              <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Размеры пока не заданы.</div>
            ) : null}
            {dimensions.map((row) => (
              <div key={row.id} style={{ display: 'grid', gridTemplateColumns: props.canEdit ? '1fr 1fr auto' : '1fr 1fr', gap: 8, alignItems: 'center' }}>
                <Input
                  value={row.name}
                  disabled={!props.canEdit}
                  placeholder="Параметр"
                  onChange={(e) => {
                    dirtyRef.current = true;
                    setDimensions((prev) => prev.map((item) => (item.id === row.id ? { ...item, name: e.target.value } : item)));
                  }}
                />
                <Input
                  value={row.value}
                  disabled={!props.canEdit}
                  placeholder="Значение"
                  onChange={(e) => {
                    dirtyRef.current = true;
                    setDimensions((prev) => prev.map((item) => (item.id === row.id ? { ...item, value: e.target.value } : item)));
                  }}
                />
                {props.canEdit ? (
                  <Button
                    variant="ghost"
                    tone="danger"
                    onClick={() => {
                      dirtyRef.current = true;
                      setDimensions((prev) => prev.filter((item) => item.id !== row.id));
                    }}
                  >
                    Удалить
                  </Button>
                ) : null}
              </div>
            ))}
            {props.canEdit ? (
              <div>
                <Button
                  variant="ghost"
                  onClick={() => {
                    dirtyRef.current = true;
                    setDimensions((prev) => [...prev, { id: crypto.randomUUID(), name: '', value: '' }]);
                  }}
                >
                  Добавить размер
                </Button>
              </div>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard title="Где используется" style={{ borderRadius: 0, padding: 16 }}>
          <div style={{ display: 'grid', gap: 10 }}>
            {usageStatus ? (
              <div style={{ color: usageStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 13 }}>{usageStatus}</div>
            ) : null}
            {usageItems.length > 0 ? (
              <div style={{ display: 'grid', gap: 8 }}>
                {usageItems.map((item) => {
                  const canOpen =
                    item.kind === 'contract'
                      ? Boolean(props.onOpenContract)
                      : item.kind === 'engine_brand'
                        ? Boolean(props.onOpenEngineBrand)
                        : Boolean(item.targetTypeCode && props.onOpenByCode?.[item.targetTypeCode]);
                  return (
                    <div
                      key={item.key}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        alignItems: 'center',
                        padding: '10px 12px',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: 'var(--text)', fontSize: 14 }}>{item.label}</div>
                        <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
                          {item.kind === 'contract'
                            ? 'Контракт'
                            : item.kind === 'engine_brand'
                              ? 'Марка двигателя'
                              : item.kind === 'work_order'
                                ? 'Наряд'
                                : item.kind === 'service'
                                  ? 'Услуга'
                                  : 'Связанная сущность'}
                          {item.description ? ` · ${item.description}` : ''}
                        </div>
                      </div>
                      {canOpen ? (
                        <Button variant="outline" tone="neutral" size="sm" onClick={() => openUsageItem(item)}>
                          Открыть
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard title="Карточка" style={{ borderRadius: 0, padding: 16 }}>
          <div style={{ marginTop: 10, color: 'var(--subtle)', fontSize: 13 }}>
            <div>
              <span style={{ color: 'var(--text)' }}>ID:</span> {part.id}
            </div>
            <div style={{ marginTop: 6 }}>
              <span style={{ color: 'var(--text)' }}>Создано:</span> {formatMoscowDateTime(part.createdAt)}
            </div>
            <div style={{ marginTop: 6 }}>
              <span style={{ color: 'var(--text)' }}>Обновлено:</span> {formatMoscowDateTime(part.updatedAt)}
            </div>
          </div>
        </SectionCard>

        {/* Attachments */}
        <div style={{ gridColumn: '1 / -1' }}>
          <AttachmentsPanel
            title="Чертежи"
            value={attrByCode.get('drawings')?.value}
            canView={props.canViewFiles}
            canUpload={props.canUploadFiles && props.canEdit}
            scope={{ ownerType: 'part', ownerId: part.id, category: 'drawings' }}
            onChange={(next) => saveAttribute('drawings', next)}
          />
          <AttachmentsPanel
            title="Технология"
            value={attrByCode.get('tech_docs')?.value}
            canView={props.canViewFiles}
            canUpload={props.canUploadFiles && props.canEdit}
            scope={{ ownerType: 'part', ownerId: part.id, category: 'tech_docs' }}
            onChange={(next) => saveAttribute('tech_docs', next)}
          />
          <AttachmentsPanel
            title="Вложения (прочее)"
            value={attrByCode.get('attachments')?.value}
            canView={props.canViewFiles}
            canUpload={props.canUploadFiles && props.canEdit}
            scope={{ ownerType: 'part', ownerId: part.id, category: 'attachments' }}
            onChange={(next) => saveAttribute('attachments', next)}
          />
        </div>

        {/* Extra fields */}
        <div style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 0, padding: 16 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <strong>Дополнительные поля</strong>
            <span style={{ flex: 1 }} />
            {addFieldStatus && (
              <span style={{ color: addFieldStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{addFieldStatus}</span>
            )}
            {props.canEdit && (
              <Button
                variant="ghost"
                onClick={() => {
                  setAddFieldOpen((v) => !v);
                  setAddFieldStatus('');
                }}
              >
                {addFieldOpen ? 'Закрыть' : 'Добавить поле'}
              </Button>
            )}
            <span style={{ color: 'var(--subtle)', fontSize: 12 }}>Все остальные поля (в т.ч. файлы/JSON) редактируются здесь.</span>
          </div>

          {addFieldOpen && props.canEdit && (
            <div style={{ marginBottom: 14, border: '1px solid var(--border)', borderRadius: 0, padding: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 8 }}>Новое поле для деталей (появится в карточке у всех деталей).</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 8, alignItems: 'center' }}>
                <Input value={newFieldCode} onChange={(e) => setNewFieldCode(e.target.value)} placeholder="code (например: material)" />
                <Input value={newFieldName} onChange={(e) => setNewFieldName(e.target.value)} placeholder="название (например: Материал)" />

                <select
                  value={newFieldDataType}
                  onChange={(e) => setNewFieldDataType(e.target.value as any)}
                  style={{ padding: '9px 12px', borderRadius: 0, border: '1px solid var(--input-border)' }}
                >
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="date">date</option>
                  <option value="json">json</option>
                  <option value="link">link</option>
                </select>

                <Input value={newFieldSortOrder} onChange={(e) => setNewFieldSortOrder(e.target.value)} placeholder="sortOrder (например: 300)" />

                <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text)', fontSize: 14 }}>
                  <input type="checkbox" checked={newFieldIsRequired} onChange={(e) => setNewFieldIsRequired(e.target.checked)} />
                  обязательное
                </label>

                {newFieldDataType === 'link' ? (
                  <div style={{ display: 'grid', gap: 6, gridColumn: '1 / -1' }}>
                    <select
                      value={newFieldLinkTarget}
                      onChange={(e) => {
                        setNewFieldLinkTarget(e.target.value);
                        setNewFieldLinkTouched(true);
                      }}
                      style={{ padding: '9px 12px', borderRadius: 0, border: '1px solid var(--input-border)' }}
                    >
                      <option value="">связь с (раздел)…</option>
                      {newFieldLinkOptions.map((opt) => (
                        <option key={opt.type.id} value={opt.type.code}>
                          {opt.tag === 'standard'
                            ? `${opt.type.name} (стандартный)`
                            : opt.tag === 'recommended'
                              ? `${opt.type.name} (рекомендуется)`
                              : opt.type.name}
                        </option>
                      ))}
                    </select>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setNewFieldLinkTouched(false);
                          if (recommendedLinkCode) setNewFieldLinkTarget(recommendedLinkCode);
                        }}
                        disabled={!recommendedLinkCode}
                      >
                        Сбросить к рекомендуемому
                      </Button>
                      {!recommendedLinkCode && <span style={{ color: 'var(--subtle)', fontSize: 12 }}>Нет рекомендации</span>}
                    </div>
                    {(newFieldStandardType || newFieldRecommendedType) && (
                      <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
                        {newFieldStandardType && (
                          <>
                            Стандартный: <strong>{newFieldStandardType.name}</strong>
                          </>
                        )}
                        {newFieldStandardType && newFieldRecommendedType && newFieldRecommendedType.code !== newFieldStandardType.code && ' • '}
                        {newFieldRecommendedType && newFieldRecommendedType.code !== newFieldStandardType?.code && (
                          <>
                            Рекомендуется: <strong>{newFieldRecommendedType.name}</strong>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <Input
                    value={newFieldMetaJson}
                    onChange={(e) => setNewFieldMetaJson(e.target.value)}
                    placeholder="metaJson (опц., JSON строка)"
                    style={{ gridColumn: '1 / -1' }}
                  />
                )}

                <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
                  <Button onClick={() => void createNewField()}>Добавить</Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setAddFieldOpen(false);
                      setAddFieldStatus('');
                    }}
                  >
                    Отмена
                  </Button>
                </div>
              </div>
            </div>
          )}

          {extraAttrs.length === 0 ? (
            <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Нет дополнительных полей.</div>
          ) : (
            <DraggableFieldList
              items={orderFieldsByDefs(extraAttrs, partDefs)}
              getKey={(attr) => attr.id}
              canDrag={props.canEdit}
              onReorder={(next) => {
                if (!partTypeId) return;
              void queueFieldOrderOperation(next.map((a) => a.code), { startAt: 300 });
              }}
              renderItem={(attr, itemProps, _dragHandleProps, state) => {
                const value = editingAttr[attr.code] !== undefined ? editingAttr[attr.code] : attr.value;
                const isEditing = editingAttr[attr.code] !== undefined;
                const textLookupMeta = attr.dataType === 'text' ? textLookupMetaByCode[attr.code] ?? null : null;
                const textLookupOptions = textLookupMeta ? (textLookupOptionsByCode[attr.code] ?? []) : [];
                const textLookupSelected =
                  textLookupMeta && typeof value === 'string'
                    ? textLookupMeta.storeAs === 'id'
                      ? textLookupOptions.find((o) => o.id === value) ?? null
                      : textLookupOptions.find((o) => o.label === value) ?? null
                    : null;
                const linkOpt =
                  attr.dataType === 'link' && typeof value === 'string'
                    ? (linkOptionsByCode[attr.code] ?? []).find((o) => o.id === value) ?? null
                    : null;
                const targetTypeCode = getLinkTargetTypeCode(attr);
                const openByTarget =
                  targetTypeCode && !['department', 'unit'].includes(targetTypeCode) ? props.onOpenByCode?.[targetTypeCode] : undefined;
                const textOpenByTarget =
                  textLookupMeta?.storeAs === 'id' && textLookupMeta.targetTypeCode && !['department', 'unit'].includes(textLookupMeta.targetTypeCode)
                    ? props.onOpenByCode?.[textLookupMeta.targetTypeCode]
                    : undefined;
                const readDisplay =
                  value === null || value === undefined
                    ? <span style={{ color: 'var(--subtle)' }}>—</span>
                    : attr.dataType === 'link'
                    ? linkOpt?.label ?? (typeof value === 'string' ? value : '')
                    : typeof value === 'string'
                    ? textLookupMeta?.storeAs === 'id'
                      ? textLookupSelected?.label ?? value
                      : value
                    : typeof value === 'number'
                    ? String(value)
                    : typeof value === 'boolean'
                    ? value
                      ? 'Да'
                      : 'Нет'
                    : JSON.stringify(value);

                return (
                  <div
                    {...itemProps}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      padding: '6px 8px',
                      borderRadius: 0,
                      border: state.isOver ? '1px dashed var(--input-border-focus)' : '1px solid transparent',
                      background: state.isDragging ? 'var(--card-row-drag-bg)' : 'transparent',
                    }}
                  >
                    <label style={{ fontWeight: 600, fontSize: 14, color: 'var(--muted)' }}>
                      {attr.name}
                      <span style={{ color: 'var(--subtle)', fontWeight: 400 }}> ({attr.code})</span>
                      {attr.isRequired && <span style={{ color: 'var(--danger)' }}> *</span>}
                    </label>
                    {!props.canEdit || !isEditing ? (
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'center',
                          padding: '10px 12px',
                          border: '1px solid var(--border)',
                          borderRadius: 0,
                          backgroundColor: props.canEdit ? 'var(--surface-2)' : 'var(--surface)',
                          fontSize: 14,
                          color: 'var(--text)',
                          cursor: props.canEdit ? 'pointer' : 'default',
                          whiteSpace: 'pre-wrap',
                        }}
                        onClick={() => {
                          if (props.canEdit) setEditingAttr({ ...editingAttr, [attr.code]: attr.value });
                        }}
                      >
                        <span style={{ flex: 1 }}>{readDisplay}</span>
                        {typeof value === 'string' && value && (openByTarget || textOpenByTarget) ? (
                          <Button
                            variant="outline"
                            tone="neutral"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (openByTarget) openByTarget(value);
                              else if (textOpenByTarget) textOpenByTarget(value);
                            }}
                          >
                            Открыть
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 8 }}>
                        {attr.dataType === 'text' ? (
                          textLookupMeta ? (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start', flex: 1 }}>
                              <SearchSelectWithCreate
                                value={
                                  typeof value === 'string'
                                    ? textLookupMeta.storeAs === 'id'
                                      ? value
                                      : (textLookupOptions.find((o) => o.label === value)?.id ?? null)
                                    : null
                                }
                                options={textLookupOptions}
                                placeholder="Выберите значение"
                                {...((!props.canEdit || textLookupLoadingByCode[attr.code]) ? { disabled: true } : {})}
                                canCreate={props.canEdit}
                                createLabel={`Новая запись (${textLookupMeta.targetTypeCode})`}
                                onChange={(next) => {
                                  const selected = textLookupOptions.find((o) => o.id === (next ?? ''));
                                  const nextValue =
                                    textLookupMeta.storeAs === 'id'
                                      ? (next ?? '')
                                      : (selected?.label ?? (typeof value === 'string' ? value : ''));
                                  setEditingAttr({ ...editingAttr, [attr.code]: nextValue });
                                }}
                                onCreate={async (label) => {
                                  const id = await createTextLookupEntity(attr, label);
                                  if (!id) return null;
                                  const clean = label.trim();
                                  setEditingAttr((prev) => ({
                                    ...prev,
                                    [attr.code]: textLookupMeta.storeAs === 'id' ? id : clean,
                                  }));
                                  return id;
                                }}
                              />
                              {typeof value === 'string' && value && textLookupMeta.storeAs === 'id' && textOpenByTarget ? (
                                <Button variant="outline" tone="neutral" size="sm" onClick={() => textOpenByTarget(value)}>
                                  Открыть
                                </Button>
                              ) : null}
                            </div>
                          ) : (
                            <Input
                              value={String(value ?? '')}
                              onChange={(e) => setEditingAttr({ ...editingAttr, [attr.code]: e.target.value })}
                              style={{ flex: 1 }}
                            />
                          )
                        ) : attr.dataType === 'link' ? (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
                            <SearchSelect
                              value={typeof value === 'string' ? value : ''}
                              options={linkOptionsByCode[attr.code] ?? []}
                              placeholder="Выберите значение"
                              {...((!props.canEdit || linkLoadingByCode[attr.code]) ? { disabled: true } : {})}
                              onChange={(next) => setEditingAttr({ ...editingAttr, [attr.code]: next })}
                            />
                            {typeof value === 'string' && value && openByTarget ? (
                              <Button variant="outline" tone="neutral" size="sm" onClick={() => openByTarget?.(value)}>
                                Открыть
                              </Button>
                            ) : null}
                          </div>
                        ) : attr.dataType === 'number' ? (
                          <Input
                            type="number"
                            value={String(value ?? '')}
                            onChange={(e) => setEditingAttr({ ...editingAttr, [attr.code]: Number(e.target.value) || 0 })}
                            style={{ flex: 1 }}
                          />
                        ) : attr.dataType === 'boolean' ? (
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={!!value}
                              onChange={(e) => setEditingAttr({ ...editingAttr, [attr.code]: e.target.checked })}
                            />
                            <span>{value ? 'Да' : 'Нет'}</span>
                          </label>
                        ) : attr.dataType === 'date' ? (
                          <Input
                            type="date"
                            value={value && typeof value === 'number' ? toInputDate(value) : ''}
                            onChange={(e) => {
                              const d = fromInputDate(e.target.value);
                              setEditingAttr({ ...editingAttr, [attr.code]: d });
                            }}
                            style={{ flex: 1 }}
                          />
                        ) : (
                          <Input
                            value={JSON.stringify(value ?? '')}
                            onChange={(e) => {
                              try {
                                const parsed = JSON.parse(e.target.value);
                                setEditingAttr({ ...editingAttr, [attr.code]: parsed });
                              } catch {
                                // ignore
                              }
                            }}
                            style={{ flex: 1 }}
                          />
                        )}
                        <Button
                          onClick={() => {
                            void saveAttribute(attr.code, value);
                            const newEditing = { ...editingAttr };
                            delete newEditing[attr.code];
                            setEditingAttr(newEditing);
                          }}
                        >
                          Сохранить
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            const newEditing = { ...editingAttr };
                            delete newEditing[attr.code];
                            setEditingAttr(newEditing);
                          }}
                        >
                          Отмена
                        </Button>
                      </div>
                    )}
                  </div>
                );
              }}
            />
          )}
        </div>
        </div>
    </EntityCardShell>
  );
}

