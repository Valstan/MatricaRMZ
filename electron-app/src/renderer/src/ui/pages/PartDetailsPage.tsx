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
import { RowActions } from '../components/RowActions.js';
import { SectionCard } from '../components/SectionCard.js';
import { buildLinkTypeOptions, normalizeForMatch, suggestLinkTargetCodeWithRules, type LinkRule } from '@matricarmz/shared';
import { STATUS_CODES, STATUS_LABELS, statusDateCode, type StatusCode } from '@matricarmz/shared';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
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

type LinkOpt = { id: string; label: string };

type PartBrandLink = {
  id: string;
  partId: string;
  engineBrandId: string;
  assemblyUnitNumber: string;
  quantity: number;
};

type EntityTypeRow = { id: string; code: string; name: string };

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
  const [customerOptions, setCustomerOptions] = useState<LinkOpt[]>([]);
  const [customerStatus, setCustomerStatus] = useState<string>('');

  // Links: engine brands
  const [engineBrandOptions, setEngineBrandOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [engineBrandStatus, setEngineBrandStatus] = useState<string>('');
  const [brandLinks, setBrandLinks] = useState<PartBrandLink[]>([]);
  const [brandLinksStatus, setBrandLinksStatus] = useState<string>('');
  const [brandLinkDrafts, setBrandLinkDrafts] = useState<Record<string, { engineBrandId: string; assemblyUnitNumber: string; quantity: number }>>({});
  const [newBrandLink, setNewBrandLink] = useState({ engineBrandId: '', assemblyUnitNumber: '', quantity: 1 });
  const [contractId, setContractId] = useState<string>('');
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

  const dirtyRef = useRef(false);
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
      listPartsByBrand: async (args: { engineBrandId: string; limit: number }) =>
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

      const r = await window.matrica.parts.createAttributeDef({
        code,
        name,
        dataType: newFieldDataType,
        isRequired: newFieldIsRequired,
        sortOrder,
        metaJson,
      });
      if (!r?.ok) {
        setAddFieldStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return;
      }
      if (newFieldDataType === 'link' && newFieldLinkTouched && newFieldLinkTarget) {
        await upsertLinkRule(name, newFieldLinkTarget);
      }

      setAddFieldStatus('Поле добавлено');
      setTimeout(() => setAddFieldStatus(''), 1200);
      setAddFieldOpen(false);
      setNewFieldCode('');
      setNewFieldName('');
      setNewFieldDataType('text');
      setNewFieldSortOrder('100');
      setNewFieldIsRequired(false);
      setNewFieldMetaJson('');
      setNewFieldLinkTarget('');
      setNewFieldLinkTouched(false);
      void load();
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
      const opts = (rows as any[]).map((r) => ({
        id: String(r.id),
        label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setEngineBrandOptions(opts);
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
    const affectedBrandIds = new Set<string>();
    if (prev?.engineBrandId) affectedBrandIds.add(String(prev.engineBrandId).trim());
    affectedBrandIds.add(engineBrandId);

    const r = await window.matrica.parts.partBrandLinks.upsert(payload);
    if (!r?.ok) {
      setBrandLinksStatus(`Ошибка: ${String(r?.error ?? 'unknown')}`);
      return;
    }

    setBrandLinksStatus('Сохранено');
    setBrandLinkDrafts((prev) => {
      const next = { ...prev };
      if (link.linkId) delete next[link.linkId];
      return next;
    });
    await loadBrandLinks();
    void persistEngineBrandSummaries(Array.from(affectedBrandIds));
    setTimeout(() => {
      setBrandLinksStatus((prev) => (prev.startsWith('Ошибка') ? prev : ''));
    }, 1500);
  }

  async function deleteBrandLink(linkId: string) {
    if (!props.canEdit) return;
    const ok = confirm('Удалить связь с маркой двигателя?');
    if (!ok) return;
    const affectedBrandId = String(brandLinks.find((x) => x.id === linkId)?.engineBrandId || '').trim();
    const r = await window.matrica.parts.partBrandLinks.delete({ partId: props.partId, linkId });
    if (!r?.ok) {
      setBrandLinksStatus(`Ошибка: ${String(r?.error ?? 'unknown')}`);
      return;
    }
    await loadBrandLinks();
    if (affectedBrandId) void persistEngineBrandSummaries([affectedBrandId]);
    setBrandLinksStatus('Удалено');
    setTimeout(() => setBrandLinksStatus(''), 1200);
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
      const opts = (rows as any[]).map((r) => ({
        id: String(r.id),
        label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setContractOptions(opts);
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
      const opts = (rows as any[]).map((r) => ({
        id: String(r.id),
        label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setCustomerOptions(opts);
      setCustomerStatus('');
    } catch (e) {
      setCustomerOptions([]);
      setCustomerStatus(`Ошибка: ${String(e)}`);
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

  async function upsertLinkRule(fieldName: string, targetTypeCode: string) {
    const ruleType = entityTypes.find((t) => t.code === 'link_field_rule');
    if (!ruleType) return;
    const list = await window.matrica.admin.entities.listByEntityType(String(ruleType.id));
    const normalized = normalizeForMatch(fieldName);
    for (const row of list as any[]) {
      const details = await window.matrica.admin.entities.get(String(row.id));
      const attrs = details.attributes ?? {};
      const existingName = normalizeForMatch(String(attrs.field_name ?? ''));
      if (existingName && existingName === normalized) {
        await window.matrica.admin.entities.setAttr(String(row.id), 'target_type_code', targetTypeCode);
        if (!attrs.priority) await window.matrica.admin.entities.setAttr(String(row.id), 'priority', 100);
        await loadLinkRules();
        return;
      }
    }
    const created = await window.matrica.admin.entities.create(String(ruleType.id));
    if (!created.ok || !created.id) return;
    await window.matrica.admin.entities.setAttr(created.id, 'field_name', fieldName);
    await window.matrica.admin.entities.setAttr(created.id, 'target_type_code', targetTypeCode);
    await window.matrica.admin.entities.setAttr(created.id, 'priority', 100);
    await loadLinkRules();
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
      const opts = (rows as any[]).map((r) => ({
        id: String(r.id),
        label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setLinkOptionsByCode((p) => ({ ...p, [attrCode]: opts }));
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

  useEffect(() => {
    void load();
  }, [props.partId]);

  useEffect(() => {
    void loadEngineBrands();
  }, []);

  useEffect(() => {
    void loadCustomers();
    void loadContracts();
    void loadLinkRules();
  }, []);

  useLiveDataRefresh(
    async () => {
      if (dirtyRef.current) return;
      await load();
      await loadEngineBrands();
      await loadCustomers();
      await loadContracts();
    },
    { intervalMs: 20000 },
  );

  useEffect(() => {
    if (!props.canEdit || !partTypeId || partDefs.length === 0 || coreDefsReady) return;
    const desired = [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'article', name: 'Артикул / обозначение', dataType: 'text', sortOrder: 20 },
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
    const vContractId = byCode.contract_id?.value;

    setName(typeof vName === 'string' ? vName : vName == null ? '' : String(vName));
    setArticle(typeof vArticle === 'string' ? vArticle : vArticle == null ? '' : String(vArticle));
    setDescription(typeof vDesc === 'string' ? vDesc : vDesc == null ? '' : String(vDesc));
    setPurchaseDate(typeof vPurchase === 'number' ? toInputDate(vPurchase) : '');
    setSupplier(typeof vSupplier === 'string' ? vSupplier : vSupplier == null ? '' : String(vSupplier));
    setSupplierId(typeof vSupplierId === 'string' ? vSupplierId : vSupplierId == null ? '' : String(vSupplierId));
    setContractId(typeof vContractId === 'string' ? vContractId : vContractId == null ? '' : String(vContractId));
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
          dirtyRef.current = false;
        }
      },
    });
    return () => {
      props.registerCardCloseActions?.(null);
    };
  }, [name, article, props.registerCardCloseActions]);

  async function saveAttribute(code: string, value: unknown): Promise<{ ok: true; queued?: boolean } | { ok: false; error: string }> {
    if (!props.canEdit) return { ok: false, error: 'no permission' };
    try {
      setStatus('Сохранение…');
      const r = await window.matrica.parts.updateAttribute({ partId: props.partId, attributeCode: code, value });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return r;
      }
      if ((r as any).queued) {
        setStatus('Отправлено на утверждение (см. «Изменения»)');
        setTimeout(() => setStatus(''), 2500);
      } else {
        setStatus('Сохранено');
        setTimeout(() => setStatus(''), 2000);
      }
      void load();
      return r as any;
    } catch (e) {
      const err = String(e);
      setStatus(`Ошибка: ${err}`);
      return { ok: false, error: err };
    }
  }

  async function saveCore() {
    if (!props.canEdit) return;
    const supplierLabel = supplierId ? customerOptions.find((c) => c.id === supplierId)?.label ?? '' : '';
    // Save sequentially (simple + predictable)
    await saveAttribute('name', name);
    await saveAttribute('article', article);
    await saveAttribute('description', description);
    await saveAttribute('purchase_date', fromInputDate(purchaseDate));
    await saveAttribute('supplier_id', supplierId || null);
    await saveAttribute('supplier', supplierLabel || supplier);
    await saveAttribute('contract_id', contractId || null);
    for (const c of STATUS_CODES) {
      await saveAttribute(c, statusFlags[c] ?? false);
      await saveAttribute(statusDateCode(c), statusDates[c] ?? null);
    }
  }

  async function saveAllAndClose() {
    if (props.canEdit) {
      await saveCore();
    }
    dirtyRef.current = false;
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
    'article',
    'description',
    'purchase_date',
    'supplier',
    'supplier_id',
    'contract_id',
    ...STATUS_CODES,
    ...STATUS_CODES.map((code) => statusDateCode(code)),
  ]);
  // Эти поля имеют отдельные UI-блоки (связи/вложения) и не должны отображаться как "сырой JSON".
  const hiddenFromExtra = new Set(['assembly_unit_number', 'engine_brand_ids', 'engine_brand_qty_map', 'drawings', 'tech_docs', 'attachments']);
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
        code: 'article',
        defaultOrder: 20,
        label: 'Артикул / обозначение',
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
      {
        code: 'contract_id',
        defaultOrder: 65,
        label: 'Контракт',
        value: contractOptions.find((c) => c.id === contractId)?.label ?? (contractId || ''),
        render: (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
            <SearchSelectWithCreate
              value={contractId || null}
              options={contractOptions}
              placeholder="Выберите контракт"
              disabled={!props.canEdit}
              canCreate={props.canEdit}
              createLabel="Новый контракт"
              onChange={(next) => {
                dirtyRef.current = true;
                setContractId(next ?? '');
              }}
              onCreate={async (label) => {
                const id = await createMasterDataEntity('contract', label);
                if (!id) return null;
                dirtyRef.current = true;
                setContractId(id);
                return id;
              }}
            />
            {contractId && props.onOpenContract ? (
              <Button
                variant="outline"
                tone="neutral"
                size="sm"
                onClick={() => props.onOpenContract?.(contractId)}
              >
                Открыть
              </Button>
            ) : null}
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
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <strong>Марки двигателя и сборочные номера</strong>
          <span style={{ flex: 1 }} />
        </div>
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
                    dirtyRef.current = false;
                  }
                }
              : undefined
          }
          onSaveAndClose={
            props.canEdit
              ? () => void saveAllAndClose().then(() => props.onClose())
              : undefined
          }
          onReset={props.canEdit ? () => void load().then(() => { dirtyRef.current = false; }) : undefined}
          onDelete={props.canDelete ? () => void handleDelete() : undefined}
          onClose={props.requestClose ? () => props.requestClose?.() : undefined}
        />
      }
      actions={
        <RowActions>
          <Button variant="ghost" tone="info" onClick={printPartCard}>
            Распечатать
          </Button>
        </RowActions>
      }
      status={status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
    >
      {status && <div className="entity-card-span-full" style={{ marginBottom: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}

        <div className="entity-card-span-full" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(520px, 100%), 1fr))', gap: 10 }}>
        {/* Core */}
        <SectionCard
          title="Основное"
          style={{ borderRadius: 0, padding: 16 }}
          actions={
            props.canEdit ? (
              <Button variant="ghost" tone="success" onClick={() => void saveCore()}>
                Сохранить
              </Button>
            ) : undefined
          }
        >

          <DraggableFieldList
            items={mainFields}
            getKey={(f) => f.code}
            canDrag={props.canEdit}
            onReorder={(next) => {
              if (!partTypeId) return;
              void persistFieldOrder(
                next.map((f) => f.code),
                partDefs,
                { entityTypeId: partTypeId },
              ).then(() => setPartDefs([...partDefs]));
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

        {/* Meta / placeholders for next steps */}
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

          <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <BrandLinksEditor />
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
                void persistFieldOrder(
                  next.map((a) => a.code),
                  partDefs,
                  { entityTypeId: partTypeId, startAt: 300 },
                ).then(() => setPartDefs([...partDefs]));
              }}
              renderItem={(attr, itemProps, _dragHandleProps, state) => {
                const value = editingAttr[attr.code] !== undefined ? editingAttr[attr.code] : attr.value;
                const isEditing = editingAttr[attr.code] !== undefined;
                const linkOpt =
                  attr.dataType === 'link' && typeof value === 'string'
                    ? (linkOptionsByCode[attr.code] ?? []).find((o) => o.id === value) ?? null
                    : null;
                const targetTypeCode = getLinkTargetTypeCode(attr);
                const openByTarget =
                  targetTypeCode && !['department', 'unit'].includes(targetTypeCode) ? props.onOpenByCode?.[targetTypeCode] : undefined;
                const readDisplay =
                  value === null || value === undefined
                    ? <span style={{ color: 'var(--subtle)' }}>—</span>
                    : attr.dataType === 'link'
                    ? linkOpt?.label ?? (typeof value === 'string' ? value : '')
                    : typeof value === 'string'
                    ? value
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
                        {typeof value === 'string' && value && openByTarget ? (
                          <Button
                            variant="outline"
                            tone="neutral"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              openByTarget?.(value);
                            }}
                          >
                            Открыть
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 8 }}>
                        {attr.dataType === 'text' ? (
                          <Input
                            value={String(value ?? '')}
                            onChange={(e) => setEditingAttr({ ...editingAttr, [attr.code]: e.target.value })}
                            style={{ flex: 1 }}
                          />
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

