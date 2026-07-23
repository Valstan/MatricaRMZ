import React, { useEffect, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { SectionCard } from '../components/SectionCard.js';
import {
  normalizeForMatch,
  parseContractExecutionParts,
  parseContractSections,
  PART_TEMPLATE_ID_ATTR_CODE,
} from '@matricarmz/shared';
import { STATUS_CODES, STATUS_LABELS, statusDateCode, type StatusCode } from '@matricarmz/shared';
import type { FileRef, PartMetadata } from '@matricarmz/shared';
import { ensureAttributeDefs, orderFieldsByDefs, type AttributeDefRow } from '../utils/fieldOrder.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { listPartSpecBrandLinks } from '../utils/partsPagination.js';
import type { SearchSelectOption } from '../components/SearchSelect.js';
import { mapEntityRowsToSearchOptions } from '../utils/selectOptions.js';
import {
  buildPartCoreFieldDefs,
  fromInputDate,
  getLinkTargetTypeCode,
  normalizeCoreFieldValue,
  normalizeDateInput,
  toInputDate,
} from '../utils/partEav.js';

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

function synAttr(code: string, dataType: string, value: unknown, name = code, sortOrder = 0): Attribute {
  return { id: `syn:${code}`, code, name, dataType, value, isRequired: false, sortOrder };
}

// Phase 3 Stage E: reverse of backend partFieldMirror.buildPartMetadataBlob — rebuild
// the part's editable attributes from the directory_parts metadata blob so the embedded
// card renders/hydrates without calling parts.get. Attachments slots are always present
// (even when empty) so AttachmentsPanel + local edits have a value to write into.
function buildSyntheticPartAttributes(meta: PartMetadata): Attribute[] {
  const out: Attribute[] = [];
  if (meta.description != null) out.push(synAttr('description', 'text', meta.description));
  if (meta.purchaseDate != null) out.push(synAttr('purchase_date', 'date', meta.purchaseDate));
  if (meta.supplierLegacy != null) out.push(synAttr('supplier', 'text', meta.supplierLegacy));
  if (meta.supplierId != null) out.push(synAttr('supplier_id', 'link', meta.supplierId));
  if (meta.contractId != null) out.push(synAttr('contract_id', 'link', meta.contractId));
  if (meta.assemblyUnitNumber != null) out.push(synAttr('assembly_unit_number', 'text', meta.assemblyUnitNumber));
  if (meta.engineNodeId != null) out.push(synAttr('engine_node_id', 'link', meta.engineNodeId));
  // Theme F (как у марки, #172): три legacy-раздела файлов сливаются в одно «Вложения»
  // (дедуп по FileRef.id — один файл мог лежать в двух); слоты drawings/tech_docs больше
  // не выставляются, buildMetadataFromState их не переносит → первый unified-save
  // пересохраняет блоб с merged-списком в attachments (файлы сохранены).
  const mergedFiles: FileRef[] = [];
  const seenFileIds = new Set<string>();
  for (const f of [...(meta.attachments ?? []), ...(meta.drawings ?? []), ...(meta.techDocs ?? [])]) {
    const id = String((f as { id?: unknown })?.id ?? '');
    if (!id || seenFileIds.has(id)) continue;
    seenFileIds.add(id);
    mergedFiles.push(f);
  }
  out.push(synAttr('attachments', 'json', mergedFiles.length ? mergedFiles : null));
  for (const c of STATUS_CODES) {
    if (meta.statusFlags?.[c]) out.push(synAttr(c, 'boolean', true));
    const d = meta.statusDates?.[c];
    if (d != null) out.push(synAttr(statusDateCode(c), 'date', d));
  }
  const defByCode = new Map((meta.customDefs ?? []).map((d) => [d.code, d] as const));
  for (const [code, value] of Object.entries(meta.custom ?? {})) {
    const def = defByCode.get(code);
    out.push(synAttr(code, def?.dataType ?? 'text', value, def?.name ?? code, def?.sortOrder ?? 300));
  }
  return out;
}

function applyAttrToSyntheticPart(part: Part, code: string, value: unknown): Part {
  const attributes = part.attributes.some((a) => a.code === code)
    ? part.attributes.map((a) => (a.code === code ? { ...a, value } : a))
    : [...part.attributes, synAttr(code, 'json', value)];
  return { ...part, attributes };
}

function asFileRefArray(value: unknown): FileRef[] | null {
  return Array.isArray(value) && value.length ? (value as FileRef[]) : null;
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
  // Phase 2 Stage E.2: when embedded inside the nomenclature card, hide the blocks
  // owned by the nomenclature base row + E.1 part-spec subpanel (name/article/template/
  // dimensions/compatibility/metadata + action bar) and let the parent drive Save via
  // onRegisterSaver. The remaining EAV blocks (description/supplier/status/attachments/
  // usage/custom fields) render unchanged.
  embedded?: boolean;
  // Phase 3 Stage E: in embedded mode the residual part fields live in
  // directory_parts.metadataJson — the parent loads the blob (nomenclaturePartSpecGet)
  // and passes it here; the card reads it instead of parts.get and registers a provider
  // that hands a fresh blob back, which the parent folds into nomenclaturePartSpecUpdate.
  partMetadata?: PartMetadata;
  onRegisterMetadataProvider?: (provider: (() => PartMetadata) | null) => void;
}) {
  const [part, setPart] = useState<Part | null>(null);
  const [status, setStatus] = useState<string>('');

  // Core fields (better UX: always-visible inputs)
  const [name, setName] = useState<string>('');
  const [article, setArticle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [purchaseDate, setPurchaseDate] = useState<string>(''); // yyyy-mm-dd
  const [supplier, setSupplier] = useState<string>('');
  const [supplierId, setSupplierId] = useState<string>('');
  const [usageItems, setUsageItems] = useState<UsageItem[]>([]);
  const [usageStatus, setUsageStatus] = useState<string>('');
  const [customerOptions, setCustomerOptions] = useState<LinkOpt[]>([]);
  const [customerStatus, setCustomerStatus] = useState<string>('');

  // Links: engine brands
  const [engineBrandOptions, setEngineBrandOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [brandLinks, setBrandLinks] = useState<PartBrandLink[]>([]);
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

  const [entityTypes, setEntityTypes] = useState<EntityTypeRow[]>([]);
  const [partTypeId, setPartTypeId] = useState<string>('');
  const [partDefs, setPartDefs] = useState<AttributeDefRow[]>([]);
  const [coreDefsReady, setCoreDefsReady] = useState(false);
  const [linkOptionsByCode, setLinkOptionsByCode] = useState<Record<string, LinkOpt[]>>({});
  const [linkLoadingByCode, setLinkLoadingByCode] = useState<Record<string, boolean>>({});

  const dirtyRef = useRef(false);
  const metadataProviderRef = useRef<(() => PartMetadata) | null>(null);
  const embeddedRevRef = useRef(0);
  const isSavingAttributeQueueRef = useRef(false);
  const pendingAttributeSaveValuesRef = useRef(new Map<string, unknown>());
  const pendingAttributeSaveResolversRef = useRef<Array<(result: SaveAttributeResult) => void>>([]);
  const attributeSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadEngineBrands() {
    try {
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'engine_brand') ?? null;
      if (!type?.id) {
        setEngineBrandOptions([]);
        return;
      }
      const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
      setEngineBrandOptions(mapEntityRowsToSearchOptions(rows, { fallbackToShortId: true }));
    } catch {
      setEngineBrandOptions([]);
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
      const r = await listPartSpecBrandLinks({ partId: pid });
      if (!r.ok) {
        setBrandLinks([]);
        return;
      }
      setBrandLinks(sortBrandLinks(r.brandLinks.map((l) => ({ ...l, partId: pid }))));
    } catch {
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
    } catch {
      setEntityTypes([]);
    }
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
    // Phase 3 Stage E: embedded card reads residual part fields from the metadata blob
    // passed by the parent (directory_parts.metadataJson) — not from parts.get. The rev
    // bump gives the synthetic part a fresh updatedAt so the field-hydration effect re-runs.
    embeddedRevRef.current += 1;
    setPart({
      id: props.partId,
      createdAt: 0,
      updatedAt: embeddedRevRef.current,
      attributes: buildSyntheticPartAttributes(props.partMetadata ?? {}),
    });
    setStatus('');
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
          ...(link.assemblyUnitNumber ? { description: `Сборочная единица: ${link.assemblyUnitNumber}` } : {}),
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
          try {
            const details = await window.matrica.admin.entities.get(id);
            const attrs = (details?.attributes ?? {}) as Record<string, unknown>;
            const sections = parseContractSections(attrs);
            const hasPartInSections =
              sections.primary.parts.some((partRow) => partRow.partId === currentPart.id) ||
              sections.addons.some((addon) => addon.parts.some((partRow) => partRow.partId === currentPart.id));
            const executionParts = parseContractExecutionParts(attrs);
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
          } catch {
            continue;
          }
        }
      }

      const serviceType = entityTypes.find((row) => row.code === 'service');
      if (serviceType?.id) {
        // Один вызов со всеми атрибутами вместо `get` на каждую услугу (368 штук на проде).
        const services = await window.matrica.admin.entities.listByEntityTypeWithAttrs(serviceType.id).catch(() => []);
        for (const row of services) {
          const id = String(row.id ?? '').trim();
          if (!id) continue;
          const rawPartIds = row.attributes?.part_ids;
          const partIds = Array.isArray(rawPartIds) ? rawPartIds.map((value: unknown) => String(value || '').trim()) : [];
          if (!partIds.includes(currentPart.id)) continue;
          addItem({
            key: `service:${id}`,
            kind: 'service',
            entityId: id,
            label: String(row.attributes?.name ?? id),
            description: 'Деталь включена в услугу',
            targetTypeCode: 'service',
          });
        }
      }

      // Один вызов на весь раздел: раньше карточка открывала каждый наряд отдельно, чтобы
      // заглянуть в его строки, — 81 IPC-вызов на прод-данных при каждом открытии детали.
      const workOrders = await window.matrica.workOrders
        .usageByPart(currentPart.id)
        .catch(() => ({ ok: false as const, error: 'unavailable' }));
      if (workOrders.ok) {
        for (const row of workOrders.rows) {
          addItem({
            key: `work_order:${row.id}`,
            kind: 'work_order',
            entityId: row.id,
            label: `Наряд №${String(row.workOrderNumber || row.id)}`,
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
    // Stage E: re-hydrate the embedded synthetic part whenever the parent passes a fresh
    // metadata blob (e.g. after a save → reload). Non-embedded keys on partId only.
    void load();
  }, [props.partId, props.embedded, props.partMetadata]);

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
    const desired = buildPartCoreFieldDefs();
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

    setName(typeof vName === 'string' ? vName : vName == null ? '' : String(vName));
    setArticle(typeof vArticle === 'string' ? vArticle : vArticle == null ? '' : String(vArticle));
    setDescription(typeof vDesc === 'string' ? vDesc : vDesc == null ? '' : String(vDesc));
    setPurchaseDate(typeof vPurchase === 'number' ? toInputDate(vPurchase) : '');
    setSupplier(typeof vSupplier === 'string' ? vSupplier : vSupplier == null ? '' : String(vSupplier));
    setSupplierId(typeof vSupplierId === 'string' ? vSupplierId : vSupplierId == null ? '' : String(vSupplierId));
    const linked = normalizeBrandLinksFromPart(part);
    if (linked.length > 0) {
      setBrandLinks(sortBrandLinks(linked));
    } else {
      setBrandLinks([]);
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

  // Phase 3 Stage E: build the directory_parts.metadataJson blob from the card's current
  // state. Symmetric to backend partFieldMirror.buildPartMetadataBlob (same field names /
  // units). Typed fields come from editable state; attachments from the synthetic part;
  // fields the card never edits (contract/assembly/node/custom) carry through from the
  // loaded blob unchanged. Conditional spread per exactOptionalPropertyTypes.
  function buildMetadataFromState(): PartMetadata {
    const base = props.partMetadata ?? {};
    const supplierLabel = supplierId ? (customerOptions.find((c) => c.id === supplierId)?.label ?? '') : '';
    const legacySupplier = (supplierLabel || supplier).trim();
    const purchaseMs = fromInputDate(purchaseDate);
    const desc = description.trim();
    const flags: Record<string, boolean> = {};
    for (const c of STATUS_CODES) if (statusFlags[c]) flags[c] = true;
    const dates: Record<string, number> = {};
    for (const c of STATUS_CODES) {
      const d = statusDates[c];
      if (d != null) dates[c] = d;
    }
    const attrVal = (code: string) => part?.attributes.find((a) => a.code === code)?.value;
    // Theme F: drawings/techDocs слиты в attachments при гидрации — блоб их больше не несёт.
    const attachments = asFileRefArray(attrVal('attachments'));
    return {
      // carry-through (card does not edit these)
      ...(base.contractId ? { contractId: base.contractId } : {}),
      ...(base.assemblyUnitNumber ? { assemblyUnitNumber: base.assemblyUnitNumber } : {}),
      ...(base.engineNodeId ? { engineNodeId: base.engineNodeId } : {}),
      ...(base.custom ? { custom: base.custom } : {}),
      ...(base.customDefs ? { customDefs: base.customDefs } : {}),
      // owned typed fields from editable state
      ...(desc ? { description: desc } : {}),
      ...(supplierId ? { supplierId } : {}),
      ...(legacySupplier ? { supplierLegacy: legacySupplier } : {}),
      ...(purchaseMs != null ? { purchaseDate: purchaseMs } : {}),
      ...(attachments ? { attachments } : {}),
      ...(Object.keys(flags).length ? { statusFlags: flags } : {}),
      ...(Object.keys(dates).length ? { statusDates: dates } : {}),
    };
  }

  // Keep a fresh provider handle (no stale closure over field state) and hand it to the
  // embedding nomenclature card, which calls it during its unified save.
  useEffect(() => {
    metadataProviderRef.current = buildMetadataFromState;
  });

  useEffect(() => {
    if (!props.onRegisterMetadataProvider) return;
    props.onRegisterMetadataProvider(() => metadataProviderRef.current?.() ?? {});
    return () => props.onRegisterMetadataProvider?.(null);
  }, [props.onRegisterMetadataProvider]);

  useEffect(() => {
    return () => {
      if (attributeSaveTimerRef.current) {
        clearTimeout(attributeSaveTimerRef.current);
        attributeSaveTimerRef.current = null;
      }
      if (pendingAttributeSaveResolversRef.current.length > 0) {
        resolvePendingAttributeSaves({ ok: false, error: 'component unmounted' });
      }
      pendingAttributeSaveValuesRef.current.clear();
    };
  }, []);

  type SaveAttributeOptions = {
    suppressStatus?: boolean;
    suppressReload?: boolean;
  };

  type SaveAttributeResult = { ok: true; queued?: boolean } | { ok: false; error: string };

  const ATTRIBUTE_SAVE_BATCH_DELAY_MS = 220;

  function getAttributeCurrentValue(code: string): unknown {
    const found = part?.attributes.find((a) => a.code === code);
    return found ? found.value : undefined;
  }

  function resolvePendingAttributeSaves(result: SaveAttributeResult) {
    const resolvers = pendingAttributeSaveResolversRef.current;
    pendingAttributeSaveResolversRef.current = [];
    for (const resolve of resolvers) resolve(result);
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
    const finalResult = hasQueued ? { ok: true as const, queued: true } : { ok: true as const };
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

    // Phase 3 Stage E: embedded card never writes parts.* — edits (e.g. attachments) update
    // the in-memory synthetic part; buildMetadataFromState reads them back into the blob the
    // parent persists via nomenclaturePartSpecUpdate({ metadata }).
    if (props.embedded) {
      const normalized = normalizeCoreFieldValue(value);
      setPart((prev) => (prev ? applyAttrToSyntheticPart(prev, code, normalized) : prev));
      dirtyRef.current = true;
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
      // Phase 3 pre-H cleanup: unreachable — only the embedded card mounts and its saveAttribute()
      // short-circuits to the metadata blob before reaching here (non-embedded card is never rendered).
      // Stubbed off the Stage-H-removed PUT /parts/:id/attributes/:code route.
      void code;
      void value;
      const r: SaveAttributeResult = { ok: false, error: 'устаревшая карточка детали (non-embedded) отключена' };
      if (!r.ok) {
        if (!options.suppressStatus) setStatus(`Ошибка: ${r.error}`);
        return r;
      }
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

  if (!part) {
    return (
      <div>
        {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}
      </div>
    );
  }

  const attrByCode = new Map<string, Attribute>();
  for (const a of part.attributes) attrByCode.set(a.code, a);

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


  const visibleMainFields = mainFields.filter(
    (f) => f.code !== 'name' && f.code !== 'article' && f.code !== PART_TEMPLATE_ID_ATTR_CODE,
  );

  const cardBody = (
    <>
      {status && <div className="entity-card-span-full" style={{ marginBottom: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}

        <div className="entity-card-span-full" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(520px, 100%), 1fr))', gap: 10 }}>
        {/* Core */}
        <SectionCard
          title="Основное"
          style={{ borderRadius: 0, padding: 16 }}
        >

          <DraggableFieldList
            items={visibleMainFields}
            getKey={(f) => f.code}
            canDrag={false}
            onReorder={() => {}}
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

        <SectionCard title={`Где используется${usageItems.length ? ` (${usageItems.length})` : ''}`} collapsible defaultCollapsed style={{ borderRadius: 0, padding: 16 }}>
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

        {/* Attachments */}
        <div style={{ gridColumn: '1 / -1' }}>
          <SectionCard title="Файлы и вложения" collapsible defaultCollapsed style={{ borderRadius: 0, padding: 16 }}>
          {/* Theme F (как у марки, #172): одно «Вложения» вместо Чертежи/Технология/прочее —
              legacy-разделы слиты при гидрации, запись всегда в attachments. */}
          <AttachmentsPanel
            title="Вложения"
            value={attrByCode.get('attachments')?.value}
            canView={props.canViewFiles}
            canUpload={props.canUploadFiles && props.canEdit}
            scope={{ ownerType: 'part', ownerId: part.id, category: 'attachments' }}
            onChange={(next) => saveAttribute('attachments', next)}
          />
          </SectionCard>
        </div>
        </div>
    </>
  );

  return <div style={{ width: '100%' }}>{cardBody}</div>;
}

