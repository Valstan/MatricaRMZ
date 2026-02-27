import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { IncomingLinkInfo } from '../shared-types.js';

import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { SearchSelect } from './components/SearchSelect.js';
import * as masterdata from '../api/masterdata.js';
import { buildLinkTypeOptions, normalizeForMatch, suggestLinkTargetCodeWithRules, type LinkRule } from '@matricarmz/shared';
import { matchesQueryInRecord } from './utils/search.js';

type EntityTypeRow = { id: string; code: string; name: string; updatedAt: number; deletedAt: number | null };
type AttrDefRow = {
  id: string;
  entityTypeId: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  metaJson: string | null;
  updatedAt: number;
  deletedAt: number | null;
};
type EntityRow = { id: string; typeId: string; updatedAt: number; syncStatus: string; displayName?: string };

export function MasterdataPage(props: {
  canViewMasterData: boolean;
  canEditMasterData: boolean;
  pinnedTypeIds?: string[];
  selectedTypeId?: string | null;
  onPinnedChange?: (next: string[]) => void;
  onTypesChange?: (next: EntityTypeRow[]) => void;
}) {

  const [types, setTypes] = useState<EntityTypeRow[]>([]);
  const [selectedTypeId, setSelectedTypeId] = useState<string>('');
  const [defs, setDefs] = useState<AttrDefRow[]>([]);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<string>('');
  const [entityQuery, setEntityQuery] = useState<string>('');
  const [entityAttrs, setEntityAttrs] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<string>('');
  const [linkRules, setLinkRules] = useState<LinkRule[]>([]);
  const [lookupOptionsByCode, setLookupOptionsByCode] = useState<Record<string, { id: string; label: string }[]>>({});
  const lookupTypeIdByCode = useRef<Record<string, string>>({});

  const [deleteDialog, setDeleteDialog] = useState<
    | {
        open: true;
        entityId: string;
        entityLabel: string;
        loading: boolean;
        error: string | null;
        links: IncomingLinkInfo[] | null;
      }
    | { open: false }
  >({ open: false });

  const [incomingLinks, setIncomingLinks] = useState<{ loading: boolean; error: string | null; links: IncomingLinkInfo[] }>({
    loading: false,
    error: null,
    links: [],
  });

  const [typeDeleteDialog, setTypeDeleteDialog] = useState<
    | {
        open: true;
        typeId: string;
        typeName: string;
        loading: boolean;
        error: string | null;
        counts: { entities: number; defs: number } | null;
        deleteEntities: boolean;
        deleteDefs: boolean;
      }
    | { open: false }
  >({ open: false });

  const openEntityRef = useRef<string | null>(null);

  const [defDeleteDialog, setDefDeleteDialog] = useState<
    | {
        open: true;
        defId: string;
        defName: string;
        defDataType: string;
        loading: boolean;
        error: string | null;
        counts: { values: number } | null;
        deleteValues: boolean;
      }
    | { open: false }
  >({ open: false });


  const selectedType = useMemo(() => types.find((t) => t.id === selectedTypeId) ?? null, [types, selectedTypeId]);
  const selectedEntity = useMemo(() => entities.find((e) => e.id === selectedEntityId) ?? null, [entities, selectedEntityId]);

  const sortedTypes = useMemo(() => {
    return types.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
  }, [types]);

  const filteredEntities = useMemo(() => {
    return entities.filter((row) => matchesQueryInRecord(entityQuery, row));
  }, [entities, entityQuery]);

  const linkTargetByCode: Record<string, string> = {
    customer_id: 'customer',
    contract_id: 'contract',
    work_order_id: 'work_order',
    workshop_id: 'workshop',
    section_id: 'section',
  };

  function safeParseMetaJson(metaJson: string | null): any | null {
    if (!metaJson) return null;
    try {
      return JSON.parse(metaJson);
    } catch {
      return null;
    }
  }

  function getLinkTargetTypeCode(def: AttrDefRow): string | null {
    const meta = safeParseMetaJson(def.metaJson);
    const fromMeta = meta?.linkTargetTypeCode;
    if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();
    return linkTargetByCode[def.code] ?? null;
  }

  function isServerOnlyDef(def: AttrDefRow): boolean {
    const meta = safeParseMetaJson(def.metaJson);
    return meta?.serverOnly === true;
  }

  function orderEmployeeDefs(defsForType: AttrDefRow[]) {
    const order = [
      'last_name',
      'first_name',
      'middle_name',
      'full_name',
      'personnel_number',
      'birth_date',
      'role',
      'employment_status',
      'hire_date',
      'termination_date',
      'department_id',
      'section_id',
      'category_id',
      'transfers',
      'attachments',
    ];
    const idx = new Map(order.map((code, i) => [code, i]));
    return defsForType.slice().sort((a, b) => {
      const ai = idx.has(a.code) ? idx.get(a.code)! : order.length + 100;
      const bi = idx.has(b.code) ? idx.get(b.code)! : order.length + 100;
      if (ai !== bi) return ai - bi;
      return (a.sortOrder - b.sortOrder) || a.code.localeCompare(b.code);
    });
  }

  function formatDefDataType(def: AttrDefRow): string {
    if (def.dataType !== 'link') return def.dataType;
    const targetCode = getLinkTargetTypeCode(def);
    if (!targetCode) return 'link';
    const t = types.find((x) => x.code === targetCode);
    return `link → ${t ? t.name : targetCode}`;
  }

  const [linkOptions, setLinkOptions] = useState<Record<string, { id: string; label: string }[]>>({});

  const outgoingLinks = useMemo(() => {
    const linkDefs = defs.filter((d) => d.dataType === 'link');
    return linkDefs.map((d) => {
      const targetTypeCode = getLinkTargetTypeCode(d);
      const targetType = targetTypeCode ? types.find((t) => t.code === targetTypeCode) ?? null : null;
      const targetTypeName = targetType?.name ?? (targetTypeCode ?? '—');
      const raw = entityAttrs[d.code];
      const targetEntityId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
      const opt = targetEntityId ? (linkOptions[d.code] ?? []).find((x) => x.id === targetEntityId) ?? null : null;
      return {
        defId: d.id,
        attributeCode: d.code,
        attributeName: d.name,
        targetTypeId: targetType?.id ?? null,
        targetTypeName,
        targetEntityId,
        targetEntityLabel: opt?.label ?? null,
      };
    });
  }, [defs, entityAttrs, linkOptions, types]);

  async function refreshTypes() {
    const r = await masterdata.listEntityTypes();
    if (!r.ok) {
      setStatus(`Ошибка типов: ${r.error ?? 'unknown'}`);
      return;
    }
    const rows: EntityTypeRow[] = r.rows ?? [];
    setTypes(rows);
    props.onTypesChange?.(rows);
    setSelectedTypeId((prev) => {
      if (prev && rows.some((t) => t.id === prev)) return prev;
      return rows[0]?.id ?? '';
    });
    if (rows.length > 0) {
      void loadLinkRules(rows);
      void loadLookupOptions(rows);
    }
  }

  async function loadLookupOptions(rows?: EntityTypeRow[]) {
    try {
      const list = rows ?? (await masterdata.listEntityTypes()).rows ?? [];
      const map: Record<string, string> = {};
      for (const t of list) {
        if (t.code === 'unit') map.unit = String(t.id);
        if (t.code === 'store') map.shop = String(t.id);
      }
      lookupTypeIdByCode.current = map;
      const next: Record<string, { id: string; label: string }[]> = {};
      if (map.unit) {
        const units = await masterdata.listEntities(map.unit);
        if (units.ok) {
          next.unit = (units.rows ?? [])
            .map((r: any) => ({ id: String(r.id), label: String(r.displayName ?? r.id) }))
            .sort((a: { id: string; label: string }, b: { id: string; label: string }) => a.label.localeCompare(b.label, 'ru'));
        }
      }
      if (map.shop) {
        const stores = await masterdata.listEntities(map.shop);
        if (stores.ok) {
          next.shop = (stores.rows ?? [])
            .map((r: any) => ({ id: String(r.id), label: String(r.displayName ?? r.id) }))
            .sort((a: { id: string; label: string }, b: { id: string; label: string }) => a.label.localeCompare(b.label, 'ru'));
        }
      }
      setLookupOptionsByCode(next);
    } catch {
      setLookupOptionsByCode({});
    }
  }

  async function createLookupEntity(code: 'unit' | 'shop', label: string): Promise<string | null> {
    const typeId = lookupTypeIdByCode.current[code];
    const name = label.trim();
    if (!typeId || !name) return null;
    const created = await masterdata.createEntity(typeId);
    if (!created.ok || !created.id) return null;
    await masterdata.setEntityAttr(created.id, 'name', name);
    await loadLookupOptions();
    return created.id;
  }

  async function loadLinkRules(rows?: EntityTypeRow[]) {
    try {
      const list = rows ?? (await masterdata.listEntityTypes()).rows ?? [];
      const ruleType = (list as any[]).find((t) => t.code === 'link_field_rule');
      if (!ruleType?.id) {
        setLinkRules([]);
        return;
      }
      const items = await masterdata.listEntities(String(ruleType.id));
      if (!items.ok) {
        setLinkRules([]);
        return;
      }
      const rules: LinkRule[] = [];
      for (const row of items.rows ?? []) {
        const details = await masterdata.getEntity(String(row.id));
        if (!details.ok) continue;
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
    const ruleType = types.find((t) => t.code === 'link_field_rule');
    if (!ruleType) return;
    const list = await masterdata.listEntities(ruleType.id);
    if (!list.ok) return;
    const normalized = normalizeForMatch(fieldName);
    for (const row of list.rows ?? []) {
      const details = await masterdata.getEntity(String(row.id));
      if (!details.ok) continue;
      const attrs = details.attributes ?? {};
      const existingName = normalizeForMatch(String(attrs.field_name ?? ''));
      if (existingName && existingName === normalized) {
        await masterdata.setEntityAttr(String(row.id), 'target_type_code', targetTypeCode);
        if (!attrs.priority) await masterdata.setEntityAttr(String(row.id), 'priority', 100);
        await loadLinkRules();
        return;
      }
    }
    const created = await masterdata.createEntity(ruleType.id);
    if (!created.ok || !created.id) return;
    await masterdata.setEntityAttr(created.id, 'field_name', fieldName);
    await masterdata.setEntityAttr(created.id, 'target_type_code', targetTypeCode);
    await masterdata.setEntityAttr(created.id, 'priority', 100);
    await loadLinkRules();
  }

  async function refreshDefs(typeId: string) {
    const r = await masterdata.listAttributeDefs(typeId);
    if (!r.ok) {
      setStatus(`Ошибка свойств: ${r.error ?? 'unknown'}`);
      return;
    }
    const next = r.rows ?? [];
    if (selectedType?.code === 'employee') {
      const filtered = next.filter((d: any) => !isServerOnlyDef(d));
      setDefs(orderEmployeeDefs(filtered));
      return;
    }
    setDefs(next);
  }

  async function refreshEntities(typeId: string, opts?: { selectId?: string }) {
    const r = await masterdata.listEntities(typeId);
    if (!r.ok) {
      setStatus(`Ошибка записей: ${r.error ?? 'unknown'}`);
      return;
    }
    const rows = r.rows ?? [];
    setEntities(rows);
    const desired = opts?.selectId ?? selectedEntityId;
    if (desired && rows.find((r: EntityRow) => r.id === desired)) setSelectedEntityId(desired);
    else setSelectedEntityId(rows[0]?.id ?? '');
  }

  function closeDeleteDialog() {
    setDeleteDialog({ open: false });
  }

  function closeTypeDeleteDialog() {
    setTypeDeleteDialog({ open: false });
  }

  async function openTypeDeleteDialog(typeId: string) {
    const name = types.find((t) => t.id === typeId)?.name ?? '';
    setTypeDeleteDialog({
      open: true,
      typeId,
      typeName: name || '—',
      loading: true,
      error: null,
      counts: null,
      deleteEntities: false,
      deleteDefs: false,
    });
    const r = await masterdata.getEntityTypeDeleteInfo(typeId);
    if (!r.ok) {
      setTypeDeleteDialog({
        open: true,
        typeId,
        typeName: name || '—',
        loading: false,
        error: r.error ?? 'unknown',
        counts: { entities: 0, defs: 0 },
        deleteEntities: false,
        deleteDefs: false,
      });
      return;
    }
    setTypeDeleteDialog((p) =>
      p.open
        ? {
            ...p,
            loading: false,
            error: null,
            typeName: r.type?.name ?? p.typeName,
            counts: r.counts ?? { entities: 0, defs: 0 },
          }
        : p,
    );
  }

  async function doDeleteType() {
    if (!typeDeleteDialog.open) return;
    setTypeDeleteDialog((p) => (p.open ? { ...p, loading: true, error: null } : p));
    const args = {
      deleteEntities: !!typeDeleteDialog.deleteEntities,
      deleteDefs: !!typeDeleteDialog.deleteDefs,
    };
    setStatus('Удаление раздела...');
    const r = await masterdata.deleteEntityType(typeDeleteDialog.typeId, args);
    if (!r.ok) {
      setTypeDeleteDialog((p) => (p.open ? { ...p, loading: false, error: r.error ?? 'unknown' } : p));
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    setStatus(`Раздел удалён (записей удалено: ${r.deletedEntities ?? 0})`);
    await refreshTypes();
    setSelectedTypeId('');
    setSelectedEntityId('');
    setDefs([]);
    setEntities([]);
    setEntityAttrs({});
    closeTypeDeleteDialog();
  }

  function closeDefDeleteDialog() {
    setDefDeleteDialog({ open: false });
  }

  async function openDefDeleteDialog(def: AttrDefRow) {
    setDefDeleteDialog({
      open: true,
      defId: def.id,
      defName: def.name,
      defDataType: formatDefDataType(def),
      loading: true,
      error: null,
      counts: null,
      deleteValues: false,
    });
    const r = await masterdata.getAttributeDefDeleteInfo(def.id);
    if (!r.ok) {
      setDefDeleteDialog({
        open: true,
        defId: def.id,
        defName: def.name,
        defDataType: formatDefDataType(def),
        loading: false,
        error: r.error ?? 'unknown',
        counts: { values: 0 },
        deleteValues: false,
      });
      return;
    }
    setDefDeleteDialog((p) => (p.open ? { ...p, loading: false, error: null, counts: r.counts ?? { values: 0 } } : p));
  }

  async function doDeleteDef() {
    if (!defDeleteDialog.open) return;
    setDefDeleteDialog((p) => (p.open ? { ...p, loading: true, error: null } : p));
    setStatus('Удаление свойства...');
    const r = await masterdata.deleteAttributeDef(defDeleteDialog.defId, { deleteValues: !!defDeleteDialog.deleteValues });
    if (!r.ok) {
      setDefDeleteDialog((p) => (p.open ? { ...p, loading: false, error: r.error ?? 'unknown' } : p));
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    setStatus(defDeleteDialog.deleteValues ? 'Свойство и значения удалены' : 'Свойство удалено');
    if (selectedTypeId) await refreshDefs(selectedTypeId);
    if (selectedEntityId) {
      await loadEntity(selectedEntityId);
      await refreshIncomingLinks(selectedEntityId);
    }
    closeDefDeleteDialog();
  }

  async function openDeleteDialog(entityId: string) {
    const label = entities.find((e) => e.id === entityId)?.displayName ?? (entityId ? entityId.slice(0, 8) : '');
    setDeleteDialog({ open: true, entityId, entityLabel: label, loading: true, error: null, links: null });
    const r = await masterdata.getEntityDeleteInfo(entityId);
    if (!r.ok) {
      setDeleteDialog({ open: true, entityId, entityLabel: label, loading: false, error: r.error ?? 'unknown', links: [] });
      return;
    }
    setDeleteDialog({ open: true, entityId, entityLabel: label, loading: false, error: null, links: r.links ?? [] });
  }

  async function doSoftDelete(entityId: string) {
    setDeleteDialog((p) => (p.open ? { ...p, loading: true, error: null } : p));
    setStatus('Удаление...');
    const r = await masterdata.softDeleteEntity(entityId);
    if (!r.ok) {
      setDeleteDialog((p) => (p.open ? { ...p, error: r.error ?? 'unknown' } : p));
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      setDeleteDialog((p) => (p.open ? { ...p, loading: false } : p));
      return;
    }
    setStatus('Удалено');
    if (selectedTypeId) await refreshEntities(selectedTypeId);
    setSelectedEntityId('');
    setEntityAttrs({});
    closeDeleteDialog();
  }

  async function doDetachAndDelete(entityId: string) {
    setDeleteDialog((p) => (p.open ? { ...p, loading: true, error: null } : p));
    setStatus('Удаление (отвязываем связи)...');
    const r = await masterdata.detachLinksAndDelete(entityId);
    if (!r.ok) {
      setDeleteDialog((p) => (p.open ? { ...p, error: r.error ?? 'unknown' } : p));
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      setDeleteDialog((p) => (p.open ? { ...p, loading: false } : p));
      return;
    }
    setStatus(`Удалено (отвязано: ${r.detached ?? 0})`);
    if (selectedTypeId) await refreshEntities(selectedTypeId);
    setSelectedEntityId('');
    setEntityAttrs({});
    closeDeleteDialog();
  }

  async function loadEntity(id: string) {
    const r = await masterdata.getEntity(id);
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    setEntityAttrs(r.entity?.attributes ?? {});
  }

  async function refreshIncomingLinks(entityId: string) {
    setIncomingLinks((p) => ({ ...p, loading: true, error: null }));
    const r = await masterdata.getEntityDeleteInfo(entityId);
    if (!r.ok) {
      setIncomingLinks({ loading: false, error: r.error ?? 'unknown', links: [] });
      return;
    }
    setIncomingLinks({ loading: false, error: null, links: r.links ?? [] });
  }

  async function jumpToEntity(typeId: string, entityId: string) {
    setSelectedTypeId(typeId);
    await refreshDefs(typeId);
    await refreshEntities(typeId, { selectId: entityId });
    setSelectedEntityId(entityId);
  }

  useEffect(() => {
    if (types.length === 0) return;
    try {
      const raw = localStorage.getItem('diagnostics.openEntity');
      if (!raw) return;
      const parsed = JSON.parse(raw) as { typeId?: string; typeCode?: string; entityId?: string };
      if (!parsed?.entityId) return;
      const typeId =
        parsed.typeId ||
        types.find((t) => String(t.code) === String(parsed.typeCode ?? ''))?.id ||
        '';
      if (!typeId) return;
      if (openEntityRef.current === parsed.entityId) return;
      openEntityRef.current = parsed.entityId;
      void jumpToEntity(typeId, parsed.entityId).then(() => {
        localStorage.removeItem('diagnostics.openEntity');
      });
    } catch {
      // ignore
    }
  }, [types]);

  async function refreshLinkOptions(defsForType: AttrDefRow[]) {
    const map: Record<string, { id: string; label: string }[]> = {};
    for (const d of defsForType) {
      if (d.dataType !== 'link') continue;
      const targetCode = getLinkTargetTypeCode(d);
      if (!targetCode) continue;
      const targetType = types.find((t) => t.code === targetCode);
      if (!targetType) continue;
      const list = await masterdata.listEntities(targetType.id);
      const rows = list.rows ?? [];
      map[d.code] = rows.map((x: any) => ({ id: x.id, label: x.displayName ? `${x.displayName}` : x.id }));
    }
    setLinkOptions(map);
  }

  useEffect(() => {
    void refreshTypes();
  }, []);

  useEffect(() => {
    if (!selectedTypeId) return;
    void (async () => {
      await refreshDefs(selectedTypeId);
      await refreshEntities(selectedTypeId);
    })();
  }, [selectedTypeId]);

  useEffect(() => {
    if (!types.length) return;
    setSelectedTypeId((prev) => {
      if (prev && sortedTypes.some((t) => t.id === prev)) return prev;
      return sortedTypes[0]?.id ?? '';
    });
  }, [types, sortedTypes]);

  const lastOverrideRef = useRef<string | null>(null);
  useEffect(() => {
    if (!props.selectedTypeId) return;
    if (props.selectedTypeId === lastOverrideRef.current) return;
    lastOverrideRef.current = props.selectedTypeId;
    setSelectedTypeId(props.selectedTypeId);
  }, [props.selectedTypeId]);

  useEffect(() => {
    if (!selectedEntityId) return;
    void loadEntity(selectedEntityId);
    void refreshIncomingLinks(selectedEntityId);
  }, [selectedEntityId]);

  useEffect(() => {
    if (!selectedTypeId) return;
    void refreshLinkOptions(defs);
  }, [selectedTypeId, defs, types]);

  const pinnedTypeIds = useMemo(() => new Set(props.pinnedTypeIds ?? []), [props.pinnedTypeIds]);
  const canPin = typeof props.onPinnedChange === 'function';

  function addPinned(typeId: string) {
    if (!props.onPinnedChange) return;
    const next = Array.from(new Set([...(props.pinnedTypeIds ?? []), typeId]));
    props.onPinnedChange(next);
  }

  function removePinned(typeId: string) {
    if (!props.onPinnedChange) return;
    const next = (props.pinnedTypeIds ?? []).filter((id) => id !== typeId);
    props.onPinnedChange(next);
  }

  function resolveCategory(type: EntityTypeRow): string {
    const hay = `${type.code} ${type.name}`.toLowerCase();
    if (/(customer|client|контрагент|заказчик|contract|work_order|договор|заказ)/.test(hay)) return 'partners';
    if (/(employee|person|staff|department|section|workshop|персонал|сотрудник|цех|участок|отдел)/.test(hay)) return 'org';
    if (/(product|service|category|nomen|товар|услуг|категор|номенклатур|part|детал)/.test(hay)) return 'catalog';
    if (/(engine|repair|assembly|brand|двигател|ремонт|сборк|испытан|марка)/.test(hay)) return 'production';
    if (/(link_field_rule|permission|role|system|meta|служеб|прав|систем)/.test(hay)) return 'system';
    return 'other';
  }

  const categories = useMemo(() => {
    const order = [
      { id: 'partners', label: 'Контрагенты и договоры' },
      { id: 'org', label: 'Организация и персонал' },
      { id: 'catalog', label: 'Номенклатура и услуги' },
      { id: 'production', label: 'Производство и ремонт' },
      { id: 'system', label: 'Системные' },
      { id: 'other', label: 'Прочее' },
    ];
    const map = new Map<string, { id: string; label: string; items: EntityTypeRow[] }>();
    for (const row of sortedTypes) {
      const catId = resolveCategory(row);
      const meta = order.find((c) => c.id === catId) ?? order[order.length - 1];
      if (!map.has(meta.id)) map.set(meta.id, { ...meta, items: [] });
      map.get(meta.id)!.items.push(row);
    }
    return order
      .map((c) => map.get(c.id))
      .filter((x): x is { id: string; label: string; items: EntityTypeRow[] } => !!x)
      .map((c) => ({ ...c, items: c.items.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru')) }));
  }, [sortedTypes]);

  const [openCategoryIds, setOpenCategoryIds] = useState<string[]>([]);

  useEffect(() => {
    if (openCategoryIds.length > 0 || categories.length === 0) return;
    setOpenCategoryIds([categories[0].id]);
  }, [categories, openCategoryIds.length]);

  useEffect(() => {
    if (!selectedTypeId) return;
    const cat = categories.find((c) => c.items.some((t) => t.id === selectedTypeId));
    if (!cat) return;
    setOpenCategoryIds((prev) => (prev.includes(cat.id) ? prev : [...prev, cat.id]));
  }, [categories, selectedTypeId]);

  function toggleCategory(id: string) {
    setOpenCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Справочники</h2>
      <div className="muted" style={{ marginBottom: 12 }}>
        {props.canViewMasterData
          ? 'Здесь можно настраивать номенклатуру и свойства (для расширения системы без миграций).'
          : 'У вас нет доступа к мастер-данным.'}
      </div>
      {props.canViewMasterData && (
        <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
          Источник чтения: <strong>{masterdata.MASTERDATA_READ_SOURCE}</strong>
        </div>
      )}

      {props.canViewMasterData && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 10 }}>
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <strong>Справочники</strong>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" onClick={() => void refreshTypes()}>
                Обновить
              </Button>
              {props.canEditMasterData && (
                <Button
                  variant="ghost"
                  disabled={!selectedTypeId}
                  onClick={() => {
                    if (!selectedTypeId) return;
                    void openTypeDeleteDialog(selectedTypeId);
                  }}
                  style={{ color: '#b91c1c' }}
                >
                  Удалить раздел
                </Button>
              )}
            </div>

            <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
              {categories.map((cat) => {
                const open = openCategoryIds.includes(cat.id);
                return (
                  <div key={cat.id} style={{ border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                    <div
                      onClick={() => toggleCategory(cat.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 12px',
                        background: '#f8fafc',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontWeight: 800, color: '#111827' }}>{cat.label}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {cat.items.length}
                      </div>
                      <span style={{ flex: 1 }} />
                      <div className="muted" style={{ fontSize: 12 }}>
                        {open ? 'v' : '>'}
                      </div>
                    </div>
                    {open && (
                      <div style={{ display: 'grid', gap: 6, padding: 10 }}>
                        {cat.items.map((t) => {
                          const active = t.id === selectedTypeId;
                          const pinned = pinnedTypeIds.has(t.id);
                          return (
                            <div
                              key={t.id}
                              onClick={() => setSelectedTypeId(t.id)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                                padding: '8px 10px',
                                borderRadius: 10,
                                border: active ? '1px solid #93c5fd' : '1px solid #f3f4f6',
                                background: active ? '#eff6ff' : '#fff',
                                cursor: 'pointer',
                              }}
                            >
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 700, color: '#111827' }}>{t.name}</div>
                                <div className="muted" style={{ fontSize: 12 }}>
                                  код: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{t.code}</span>
                                </div>
                              </div>
                              <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                                <Button
                                  variant="ghost"
                                  disabled={!canPin || pinned}
                                  onClick={() => addPinned(t.id)}
                                  style={{ fontSize: 12, padding: '6px 10px' }}
                                >
                                  Добавить в главное меню
                                </Button>
                                <Button
                                  variant="ghost"
                                  disabled={!canPin || !pinned}
                                  onClick={() => removePinned(t.id)}
                                  style={{ fontSize: 12, padding: '6px 10px' }}
                                >
                                  Убрать из главного меню
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                        {cat.items.length === 0 && <div className="muted">(справочники не настроены)</div>}
                      </div>
                    )}
                  </div>
                );
              })}
              {categories.length === 0 && <div className="muted">(справочники не настроены)</div>}
            </div>

            {props.canEditMasterData && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Добавить раздел</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                  <NewEntityTypeForm
                    existingCodes={types.map((t) => t.code)}
                    onSubmit={async (code, name) => {
                      setStatus('Сохранение раздела...');
                      const r = await masterdata.upsertEntityType({ code, name });
                      setStatus(r.ok ? 'Раздел сохранён' : `Ошибка: ${r.error ?? 'unknown'}`);
                      await refreshTypes();
                      if (r.ok && r.id) setSelectedTypeId(String(r.id));
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <strong>{selectedType ? `Свойства ${selectedType.name}` : 'Свойства'}</strong>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" onClick={() => selectedTypeId && void refreshDefs(selectedTypeId)}>
                Обновить
              </Button>
            </div>

            <div style={{ marginTop: 12 }}>
              {selectedTypeId ? (
                <>
                  {props.canEditMasterData && (
                    <NewAttrDefForm
                      entityTypeId={selectedTypeId}
                      types={types}
                      linkRules={linkRules}
                      onStandardLink={async (fieldName, targetTypeCode) => {
                        await upsertLinkRule(fieldName, targetTypeCode);
                      }}
                      onSubmit={async (payload) => {
                        setStatus('Сохранение свойства...');
                        const r = await masterdata.upsertAttributeDef(payload);
                        setStatus(r.ok ? 'Свойство сохранено' : `Ошибка: ${r.error ?? 'unknown'}`);
                        await refreshDefs(selectedTypeId);
                      }}
                    />
                  )}
                  <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'linear-gradient(135deg, #db2777 0%, #9d174d 120%)', color: '#fff' }}>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Код</th>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Название</th>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Тип</th>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Обяз.</th>
                          {props.canEditMasterData && (
                            <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, width: 120 }}>
                              Действия
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {defs.map((d) => (
                          <tr key={d.id}>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.code}</td>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.name}</td>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{formatDefDataType(d)}</td>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.isRequired ? 'да' : 'нет'}</td>
                            {props.canEditMasterData && (
                              <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }} onClick={(e) => e.stopPropagation()}>
                                <Button
                                  variant="ghost"
                                  style={{ color: '#b91c1c' }}
                                  onClick={() => {
                                    void openDefDeleteDialog(d);
                                  }}
                                >
                                  Удалить
                                </Button>
                              </td>
                            )}
                          </tr>
                        ))}
                        {defs.length === 0 && (
                          <tr>
                            <td style={{ padding: 12, color: '#6b7280' }} colSpan={props.canEditMasterData ? 5 : 4}>
                              Свойств нет
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="muted">Выберите раздел номенклатуры</div>
              )}
            </div>
          </div>

          <div className="card">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <strong>{selectedType ? `Список ${selectedType.name}` : 'Список'}</strong>
              <span style={{ flex: 1 }} />
              <Button
                variant="ghost"
                onClick={() => {
                  if (selectedTypeId) void refreshEntities(selectedTypeId);
                }}
              >
                Обновить
              </Button>
            </div>

            {!selectedTypeId ? (
              <div style={{ marginTop: 12 }} className="muted">
                Выберите раздел номенклатуры
              </div>
            ) : (
              <>
                <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
                  {props.canEditMasterData && (
                    <>
                      <Button
                        onClick={async () => {
                          setStatus('Создание записи...');
                          const r = await masterdata.createEntity(selectedTypeId);
                          if (!r.ok) {
                            setStatus(`Ошибка: ${r.error}`);
                            return;
                          }
                          setStatus('Запись создана');
                          await refreshEntities(selectedTypeId);
                          setSelectedEntityId(r.id);
                        }}
                      >
                        Создать
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          if (!selectedEntityId) return;
                          await openDeleteDialog(selectedEntityId);
                        }}
                      >
                        Удалить
                      </Button>
                    </>
                  )}
                  <span style={{ flex: 1 }} />
                  <div className="muted" style={{ fontSize: 12 }}>
                    {selectedEntity ? 'Выбрано' : 'Всего'}: {selectedEntity ? selectedEntity.displayName ?? selectedEntity.id.slice(0, 8) : entities.length}
                  </div>
                </div>

                <div style={{ marginTop: 10 }}>
                  <Input value={entityQuery} onChange={(e) => setEntityQuery(e.target.value)} placeholder="Поиск по всем данным записи…" />

                  <div style={{ marginTop: 8, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                    <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                      {filteredEntities.map((e) => {
                        const active = e.id === selectedEntityId;
                        return (
                          <div
                            key={e.id}
                            onClick={() => setSelectedEntityId(e.id)}
                            style={{
                              padding: '10px 12px',
                              cursor: 'pointer',
                              borderBottom: '1px solid #f3f4f6',
                              background: active ? '#ecfeff' : '#fff',
                              display: 'grid',
                              gridTemplateColumns: props.canEditMasterData ? '1fr auto' : '1fr',
                              gap: 10,
                              alignItems: 'center',
                            }}
                            title={e.id}
                          >
                            <div>
                              <div style={{ fontWeight: 700, color: '#111827', lineHeight: 1.2 }}>{e.displayName ?? e.id.slice(0, 8)}</div>
                              <div style={{ marginTop: 2, fontSize: 12, color: '#6b7280' }}>
                                <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{e.id.slice(0, 8)}</span>
                                {'  '}| sync: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{e.syncStatus}</span>
                              </div>
                            </div>
                            {props.canEditMasterData && (
                              <Button
                                variant="ghost"
                                style={{ color: '#b91c1c' }}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void openDeleteDialog(e.id);
                                }}
                              >
                                Удалить
                              </Button>
                            )}
                          </div>
                        );
                      })}

                      {filteredEntities.length === 0 && <div style={{ padding: 12, color: '#6b7280' }}>(пусто)</div>}
                    </div>
                  </div>
                </div>

                {selectedEntity ? (
                  <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                      {props.canEditMasterData ? 'Редактирование свойств' : 'Свойства (только просмотр)'}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 10, alignItems: 'center' }}>
                      {defs.map((d) => (
                        <React.Fragment key={d.id}>
                          <div className="muted">{d.name}</div>
                          <FieldEditor
                            def={d}
                            canEdit={props.canEditMasterData}
                            value={entityAttrs[d.code]}
                            linkOptions={linkOptions[d.code] ?? []}
                            lookupOptions={lookupOptionsByCode[d.code] ?? []}
                            lookupCreate={
                              d.code === 'unit' || d.code === 'shop'
                                ? async (label) => await createLookupEntity(d.code as 'unit' | 'shop', label)
                                : undefined
                            }
                            onChange={(v) => setEntityAttrs((p) => ({ ...p, [d.code]: v }))}
                            onSave={async (v) => {
                              const r = await masterdata.setEntityAttr(selectedEntityId, d.code, v);
                              if (!r.ok) setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
                              else setStatus('Сохранено');
                              await refreshEntities(selectedTypeId);
                            }}
                          />
                        </React.Fragment>
                      ))}
                    </div>

                    <div style={{ marginTop: 14, borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <strong>Связи</strong>
                        <span style={{ flex: 1 }} />
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (selectedEntityId) void refreshIncomingLinks(selectedEntityId);
                          }}
                        >
                          Обновить
                        </Button>
                      </div>

                      <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                          <div style={{ fontWeight: 800, marginBottom: 8 }}>Исходящие</div>
                          {outgoingLinks.length === 0 ? (
                            <div className="muted">В этом разделе нет связанных полей.</div>
                          ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                              {outgoingLinks.map((l) => (
                                <div key={l.defId} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ color: '#111827', fontWeight: 700 }}>{l.attributeName}</div>
                                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                                      → {l.targetTypeName}
                                      {l.targetEntityId ? (
                                        <>
                                          {' '}
                                          | <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{l.targetEntityId.slice(0, 8)}</span>
                                          {l.targetEntityLabel ? ` — ${l.targetEntityLabel}` : ''}
                                        </>
                                      ) : (
                                        ' | (не выбрано)'
                                      )}
                                    </div>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    disabled={!l.targetTypeId || !l.targetEntityId}
                                    onClick={() => {
                                      if (!l.targetTypeId || !l.targetEntityId) return;
                                      void jumpToEntity(l.targetTypeId, l.targetEntityId);
                                    }}
                                  >
                                    Перейти
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                          <div style={{ fontWeight: 800, marginBottom: 8 }}>Входящие</div>
                          {incomingLinks.loading ? (
                            <div className="muted">Загрузка…</div>
                          ) : incomingLinks.error ? (
                            <div className="danger">Ошибка: {incomingLinks.error}</div>
                          ) : incomingLinks.links.length === 0 ? (
                            <div className="muted">Никто не ссылается на эту запись.</div>
                          ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                              {incomingLinks.links.map((l, idx) => (
                                <div key={`${l.fromEntityId}:${l.attributeDefId}:${idx}`} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 700, color: '#111827' }}>
                                      {l.fromEntityTypeName}: {l.fromEntityDisplayName ?? l.fromEntityId.slice(0, 8)}
                                    </div>
                                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                                      по свойству “{l.attributeName}” |{' '}
                                      <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{l.fromEntityId.slice(0, 8)}</span>
                                    </div>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    onClick={() => {
                                      void jumpToEntity(l.fromEntityTypeId, l.fromEntityId);
                                    }}
                                  >
                                    Перейти
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: 12 }} className="muted">
                    Выберите запись
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {typeDeleteDialog.open && (
        <Modal onClose={() => !typeDeleteDialog.loading && closeTypeDeleteDialog()}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#111827' }}>Удалить раздел номенклатуры</div>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={closeTypeDeleteDialog} disabled={typeDeleteDialog.loading}>
              Закрыть
            </Button>
          </div>

          <div style={{ marginTop: 10, color: '#6b7280', fontSize: 12 }}>
            Раздел: <span style={{ fontWeight: 800, color: '#111827' }}>{typeDeleteDialog.typeName || '—'}</span>
          </div>

          {typeDeleteDialog.loading ? (
            <div style={{ marginTop: 12, color: '#6b7280' }}>Проверяем содержимое…</div>
          ) : (
            <>
              <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                <div style={{ display: 'flex', gap: 16, color: '#111827' }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>Записей</div>
                    <div style={{ fontWeight: 900, fontSize: 18 }}>{typeDeleteDialog.counts?.entities ?? 0}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>Свойств</div>
                    <div style={{ fontWeight: 900, fontSize: 18 }}>{typeDeleteDialog.counts?.defs ?? 0}</div>
                  </div>
                </div>

                <div style={{ marginTop: 10, color: '#6b7280', fontSize: 12 }}>
                  Если удалить только раздел, а записи/свойства не удалять — они будут «в архиве» (скрыты из интерфейса), но останутся в базе.
                </div>
              </div>

              <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#111827', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={typeDeleteDialog.deleteEntities}
                    disabled={typeDeleteDialog.loading}
                    onChange={(e) => setTypeDeleteDialog((p) => (p.open ? { ...p, deleteEntities: e.target.checked } : p))}
                  />
                  Удалить записи этого раздела (умно: с отвязкой входящих связей)
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#111827', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={typeDeleteDialog.deleteDefs}
                    disabled={typeDeleteDialog.loading}
                    onChange={(e) => setTypeDeleteDialog((p) => (p.open ? { ...p, deleteDefs: e.target.checked } : p))}
                  />
                  Удалить свойства этого раздела
                </label>
              </div>

              {typeDeleteDialog.error && (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: '#fee2e2', color: '#991b1b' }}>
                  Ошибка: {typeDeleteDialog.error}
                </div>
              )}

              <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={closeTypeDeleteDialog} disabled={typeDeleteDialog.loading}>
                  Отмена
                </Button>
                <Button onClick={() => void doDeleteType()} disabled={typeDeleteDialog.loading} style={{ background: '#b91c1c', border: '1px solid #991b1b' }}>
                  Удалить раздел
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}

      {deleteDialog.open && (
        <Modal onClose={() => !deleteDialog.loading && closeDeleteDialog()}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#111827' }}>Удалить запись</div>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={closeDeleteDialog} disabled={deleteDialog.loading}>
              Закрыть
            </Button>
          </div>

          <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
            Запись: <span style={{ fontWeight: 700, color: '#111827' }}>{deleteDialog.entityLabel}</span>{' '}
            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>({deleteDialog.entityId.slice(0, 8)})</span>
          </div>

          {deleteDialog.loading ? (
            <div style={{ marginTop: 12, color: '#6b7280' }}>Проверяем связи…</div>
          ) : (
            <>
              {deleteDialog.links && deleteDialog.links.length > 0 ? (
                <>
                  <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: '#fff7ed', color: '#9a3412' }}>
                    Нельзя удалить без действий: запись связана с другими. Можно <strong>отвязать связи</strong> и удалить.
                  </div>

                  <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'linear-gradient(135deg, #f97316 0%, #ea580c 120%)', color: '#fff' }}>
                          <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Тип</th>
                          <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Запись</th>
                          <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Свойство</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deleteDialog.links.map((l, idx) => (
                          <tr key={`${l.fromEntityId}:${l.attributeDefId}:${idx}`}>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{l.fromEntityTypeName}</td>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                              <div style={{ fontWeight: 700, color: '#111827' }}>{l.fromEntityDisplayName ?? l.fromEntityId.slice(0, 8)}</div>
                              <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{l.fromEntityId.slice(0, 8)}</div>
                            </td>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{l.attributeName}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: '#ecfeff', color: '#155e75' }}>
                  Связей не найдено. Можно удалить запись.
                </div>
              )}

              {deleteDialog.error && (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: '#fee2e2', color: '#991b1b' }}>
                  Ошибка: {deleteDialog.error}
                </div>
              )}

              <div style={{ marginTop: 12, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={closeDeleteDialog} disabled={deleteDialog.loading}>
                  Отмена
                </Button>
                {deleteDialog.links && deleteDialog.links.length > 0 ? (
                  <Button onClick={() => void doDetachAndDelete(deleteDialog.entityId)} disabled={deleteDialog.loading} style={{ background: '#b91c1c', border: '1px solid #991b1b' }}>
                    Отвязать и удалить
                  </Button>
                ) : (
                  <Button onClick={() => void doSoftDelete(deleteDialog.entityId)} disabled={deleteDialog.loading} style={{ background: '#b91c1c', border: '1px solid #991b1b' }}>
                    Удалить
                  </Button>
                )}
              </div>
            </>
          )}
        </Modal>
      )}

      {defDeleteDialog.open && (
        <Modal onClose={() => !defDeleteDialog.loading && closeDefDeleteDialog()}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#111827' }}>Удалить свойство</div>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={closeDefDeleteDialog} disabled={defDeleteDialog.loading}>
              Закрыть
            </Button>
          </div>

          <div style={{ marginTop: 10, color: '#6b7280', fontSize: 12 }}>
            Свойство: <span style={{ fontWeight: 800, color: '#111827' }}>{defDeleteDialog.defName}</span>
          </div>
          {defDeleteDialog.defDataType && <div style={{ marginTop: 4, color: '#6b7280', fontSize: 12 }}>Тип: {defDeleteDialog.defDataType}</div>}

          {defDeleteDialog.loading ? (
            <div style={{ marginTop: 12, color: '#6b7280' }}>Проверяем использование…</div>
          ) : (
            <>
              <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Значений у этого свойства</div>
                <div style={{ fontWeight: 900, fontSize: 18, color: '#111827' }}>{defDeleteDialog.counts?.values ?? 0}</div>
                <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
                  Можно удалить только свойство (значения останутся в базе, но будут скрыты), либо удалить и значения.
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#111827', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={defDeleteDialog.deleteValues}
                    disabled={defDeleteDialog.loading || (defDeleteDialog.counts?.values ?? 0) === 0}
                    onChange={(e) => setDefDeleteDialog((p) => (p.open ? { ...p, deleteValues: e.target.checked } : p))}
                  />
                  Удалить также значения этого свойства
                </label>
              </div>

              {defDeleteDialog.error && (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: '#fee2e2', color: '#991b1b' }}>
                  Ошибка: {defDeleteDialog.error}
                </div>
              )}

              <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={closeDefDeleteDialog} disabled={defDeleteDialog.loading}>
                  Отмена
                </Button>
                <Button onClick={() => void doDeleteDef()} disabled={defDeleteDialog.loading} style={{ background: '#b91c1c', border: '1px solid #991b1b' }}>
                  Удалить свойство
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}

      {status && <div style={{ marginTop: 12, color: '#6b7280' }}>{status}</div>}
    </div>
  );
}

function Modal(props: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 9999,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 760,
          maxWidth: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          background: '#fff',
          borderRadius: 16,
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
          padding: 16,
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

function NewEntityTypeForm(props: { existingCodes: string[]; onSubmit: (code: string, name: string) => Promise<void> }) {
  const [name, setName] = useState('');

  function normalizeForMatch(s: string) {
    return String(s ?? '').trim().toLowerCase();
  }

  function translitRuToLat(s: string): string {
    const map: Record<string, string> = {
      а: 'a',
      б: 'b',
      в: 'v',
      г: 'g',
      д: 'd',
      е: 'e',
      ё: 'e',
      ж: 'zh',
      з: 'z',
      и: 'i',
      й: 'y',
      к: 'k',
      л: 'l',
      м: 'm',
      н: 'n',
      о: 'o',
      п: 'p',
      р: 'r',
      с: 's',
      т: 't',
      у: 'u',
      ф: 'f',
      х: 'h',
      ц: 'ts',
      ч: 'ch',
      ш: 'sh',
      щ: 'sch',
      ъ: '',
      ы: 'y',
      ь: '',
      э: 'e',
      ю: 'yu',
      я: 'ya',
    };
    const src = normalizeForMatch(s);
    let out = '';
    for (const ch of src) out += map[ch] ?? ch;
    return out;
  }

  function slugifyCode(s: string): string {
    let out = translitRuToLat(s);
    out = out.replace(/&/g, ' and ');
    out = out.replace(/[^a-z0-9]+/g, '_');
    out = out.replace(/_+/g, '_').replace(/^_+/, '').replace(/_+$/, '');
    if (!out) out = 'type';
    if (/^[0-9]/.test(out)) out = `t_${out}`;
    return out;
  }

  function suggestCode(name: string): string {
    const dict: Record<string, string> = {
      услуга: 'service',
      услуги: 'service',
      товар: 'product',
      товары: 'product',
      категория: 'category',
      категории: 'category',
      деталь: 'part',
      детали: 'parts',
      заказчик: 'customer',
      заказчики: 'customers',
    };
    const key = normalizeForMatch(name);
    const base = dict[key] ?? slugifyCode(name);
    const taken = new Set(props.existingCodes.map((c) => normalizeForMatch(c)));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}_${i}`)) i += 1;
    return `${base}_${i}`;
  }

  const computedCode = useMemo(() => (name.trim() ? suggestCode(name) : ''), [name, props.existingCodes.join('|')]);
  return (
    <>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="название (например: Услуга)" />
      <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#6b7280' }}>
        {computedCode ? (
          <>
            Код будет создан автоматически: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{computedCode}</span>
          </>
        ) : (
          'Код будет создан автоматически.'
        )}
      </div>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
        <Button
          onClick={() => {
            if (!name.trim()) return;
            const code = suggestCode(name);
            void props.onSubmit(code, name.trim());
            setName('');
          }}
        >
          Добавить
        </Button>
      </div>
    </>
  );
}

function NewAttrDefForm(props: {
  entityTypeId: string;
  types: EntityTypeRow[];
  linkRules: LinkRule[];
  onStandardLink: (fieldName: string, targetTypeCode: string) => Promise<void>;
  onSubmit: (payload: {
    entityTypeId: string;
    code: string;
    name: string;
    dataType: string;
    isRequired?: boolean;
    sortOrder?: number;
    metaJson?: string | null;
  }) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [dataType, setDataType] = useState('text');
  const [isRequired, setIsRequired] = useState(false);
  const [sortOrder, setSortOrder] = useState('0');
  const [metaJson, setMetaJson] = useState('');
  const [linkTargetTypeCode, setLinkTargetTypeCode] = useState('');
  const [linkTouched, setLinkTouched] = useState(false);

  useEffect(() => {
    if (dataType !== 'link') setLinkTargetTypeCode('');
    if (dataType !== 'link') setLinkTouched(false);
  }, [dataType]);

  const recommendedLinkCode = useMemo(
    () => suggestLinkTargetCodeWithRules(name, props.linkRules),
    [name, props.linkRules],
  );

  useEffect(() => {
    if (dataType !== 'link') return;
    if (linkTouched) return;
    if (recommendedLinkCode) setLinkTargetTypeCode(recommendedLinkCode);
  }, [dataType, linkTouched, recommendedLinkCode]);

  const standardType = useMemo(
    () => (linkTouched ? props.types.find((t) => t.code === linkTargetTypeCode) ?? null : null),
    [linkTouched, linkTargetTypeCode, props.types],
  );
  const recommendedType = useMemo(
    () => props.types.find((t) => t.code === recommendedLinkCode) ?? null,
    [props.types, recommendedLinkCode],
  );
  const linkTypeOptions = useMemo(
    () => buildLinkTypeOptions(props.types, standardType?.code ?? null, recommendedType?.code ?? null),
    [props.types, standardType?.code, recommendedType?.code],
  );

  return (
    <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Добавить свойство</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code (например: passport_details)" />
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="название (например: Паспорт)" />
        <select value={dataType} onChange={(e) => setDataType(e.target.value)} style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}>
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
          <option value="date">date</option>
          <option value="json">json</option>
          <option value="link">link</option>
        </select>
        <Input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} placeholder="sortOrder" />
        {dataType === 'link' && (
          <div style={{ display: 'grid', gap: 6, gridColumn: '1 / -1' }}>
            <select
              value={linkTargetTypeCode}
              onChange={(e) => {
                setLinkTargetTypeCode(e.target.value);
                setLinkTouched(true);
              }}
              style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
            >
              <option value="">связь с (раздел)…</option>
              {linkTypeOptions.map((opt) => (
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
                  setLinkTouched(false);
                  if (recommendedLinkCode) setLinkTargetTypeCode(recommendedLinkCode);
                }}
                disabled={!recommendedLinkCode}
              >
                Сбросить к рекомендуемому
              </Button>
              {!recommendedLinkCode && <span style={{ color: '#6b7280', fontSize: 12 }}>Нет рекомендации</span>}
            </div>
            {(standardType || recommendedType) && (
              <div style={{ color: '#6b7280', fontSize: 12 }}>
                {standardType && (
                  <>
                    Стандартный: <strong>{standardType.name}</strong>
                  </>
                )}
                {standardType && recommendedType && recommendedType.code !== standardType.code && ' • '}
                {recommendedType && recommendedType.code !== standardType?.code && (
                  <>
                    Рекомендуется: <strong>{recommendedType.name}</strong>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#111827', fontSize: 14, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
          обязательное
        </label>
        {dataType === 'link' ? (
          <div style={{ display: 'flex', alignItems: 'center', color: '#6b7280', fontSize: 12 }}>
            target будет сохранён в metaJson как <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{`{"linkTargetTypeCode":"${linkTargetTypeCode || '...'}"}`}</span>
          </div>
        ) : (
          <Input value={metaJson} onChange={(e) => setMetaJson(e.target.value)} placeholder="metaJson (опц., JSON строка)" />
        )}
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
          <Button
            onClick={() => {
              if (!code.trim() || !name.trim()) return;
              if (dataType === 'link' && !linkTargetTypeCode) return;
              if (dataType === 'link' && linkTouched && linkTargetTypeCode) void props.onStandardLink(name, linkTargetTypeCode);
              void props.onSubmit({
                entityTypeId: props.entityTypeId,
                code,
                name,
                dataType,
                isRequired,
                sortOrder: Number(sortOrder) || 0,
                metaJson: dataType === 'link' ? JSON.stringify({ linkTargetTypeCode }) : metaJson.trim() ? metaJson : null,
              });
              setCode('');
              setName('');
              setMetaJson('');
              setLinkTargetTypeCode('');
            }}
          >
            Добавить
          </Button>
        </div>
      </div>
    </div>
  );
}

function FieldEditor(props: {
  def: AttrDefRow;
  canEdit: boolean;
  value: unknown;
  linkOptions: { id: string; label: string }[];
  lookupOptions?: { id: string; label: string }[];
  lookupCreate?: (label: string) => Promise<string | null>;
  onChange: (v: unknown) => void;
  onSave: (v: unknown) => Promise<void>;
}) {
  const dt = props.def.dataType;
  const linkTargetTypeCode = useMemo(() => {
    if (!props.def.metaJson) return '';
    try {
      const json = JSON.parse(String(props.def.metaJson));
      return typeof json?.linkTargetTypeCode === 'string' ? json.linkTargetTypeCode : '';
    } catch {
      return '';
    }
  }, [props.def.metaJson]);

  async function createLinkedEntity(label: string): Promise<string | null> {
    if (!linkTargetTypeCode) return null;
    const types = await masterdata.listEntityTypes();
    if (!types.ok) return null;
    const target = (types.rows ?? []).find((t: any) => String(t.code) === linkTargetTypeCode) ?? null;
    if (!target?.id) return null;
    const created = await masterdata.createEntity(String(target.id));
    if (!created.ok || !created.id) return null;
    const defs = await masterdata.listAttributeDefs(String(target.id));
    if (!defs.ok) return created.id;
    const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
    const labelDef = (defs.rows ?? []).find((d: any) => labelKeys.includes(String(d.code))) ?? null;
    if (labelDef?.code) {
      await masterdata.setEntityAttr(created.id, String(labelDef.code), label);
    }
    return created.id;
  }

  const toInputDate = (ms: number) => {
    const d = new Date(ms);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };
  const fromInputDate = (v: string): number | null => {
    if (!v) return null;
    const [y, m, d] = v.split('-').map((x) => Number(x));
    if (!y || !m || !d) return null;
    const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
    const ms = dt.getTime();
    return Number.isFinite(ms) ? ms : null;
  };

  if (dt === 'boolean') {
    const checked = Boolean(props.value);
    return (
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!props.canEdit}
          onChange={(e) => {
            if (!props.canEdit) return;
            props.onChange(e.target.checked);
            void props.onSave(e.target.checked);
          }}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {checked ? 'да' : 'нет'}
        </span>
      </label>
    );
  }

  if (dt === 'date') {
    const ms = typeof props.value === 'number' ? props.value : null;
    return (
      <Input
        type="date"
        value={ms ? toInputDate(ms) : ''}
        disabled={!props.canEdit}
        onChange={(e) => {
          if (!props.canEdit) return;
          const next = fromInputDate(e.target.value);
          props.onChange(next);
          void props.onSave(next);
        }}
      />
    );
  }

  if (dt === 'number') {
    const s = props.value == null ? '' : String(props.value);
    return (
      <Input
        value={s}
        disabled={!props.canEdit}
        onChange={(e) => {
          if (!props.canEdit) return;
          props.onChange(e.target.value === '' ? null : Number(e.target.value));
        }}
        onBlur={() => {
          if (!props.canEdit) return;
          void props.onSave(props.value == null || props.value === '' ? null : Number(props.value));
        }}
        placeholder="число"
      />
    );
  }

  if (dt === 'json') {
    const s = props.value == null ? '' : JSON.stringify(props.value);
    return (
      <Input
        value={s}
        disabled={!props.canEdit}
        onChange={(e) => {
          if (!props.canEdit) return;
          props.onChange(e.target.value);
        }}
        onBlur={() => {
          if (!props.canEdit) return;
          try {
            const v = s ? JSON.parse(s) : null;
            void props.onSave(v);
          } catch {
            // ignore invalid json
          }
        }}
        placeholder="json"
      />
    );
  }

  if (dt === 'link') {
    const current = typeof props.value === 'string' ? props.value : null;
    return (
      <SearchSelect
        value={current}
        disabled={!props.canEdit}
        options={props.linkOptions}
        placeholder="(не выбрано)"
        onChange={(next) => {
          if (!props.canEdit) return;
          props.onChange(next);
          void props.onSave(next);
        }}
        onCreate={
          props.canEdit && linkTargetTypeCode
            ? async (label) => {
                const id = await createLinkedEntity(label);
                if (!id) return null;
                props.onChange(id);
                void props.onSave(id);
                return id;
              }
            : undefined
        }
        createLabel={
          linkTargetTypeCode ? (linkTargetTypeCode === 'category' ? 'Новая категория' : `Новая запись (${linkTargetTypeCode})`) : undefined
        }
      />
    );
  }

  if (dt === 'text' && (props.def.code === 'unit' || props.def.code === 'shop')) {
    const opts = props.lookupOptions ?? [];
    const currentLabel = typeof props.value === 'string' ? props.value : '';
    const currentId = opts.find((o) => o.label === currentLabel)?.id ?? null;
    return (
      <SearchSelect
        value={currentId}
        disabled={!props.canEdit}
        options={opts}
        placeholder="(не выбрано)"
        onChange={(next) => {
          if (!props.canEdit) return;
          const label = opts.find((o) => o.id === next)?.label ?? '';
          props.onChange(label);
          void props.onSave(label);
        }}
        onCreate={
          props.canEdit && props.lookupCreate
            ? async (label) => {
                const lookupCreate = props.lookupCreate;
                if (!lookupCreate) return null;
                const id = await lookupCreate(label);
                if (!id) return null;
                props.onChange(label.trim());
                void props.onSave(label.trim());
                return id;
              }
            : undefined
        }
        createLabel={props.def.code === 'unit' ? 'Новая единица' : 'Новый магазин'}
      />
    );
  }

  const text = props.value == null ? '' : String(props.value);
  return (
    <Input
      value={text}
      disabled={!props.canEdit}
      onChange={(e) => {
        if (!props.canEdit) return;
        props.onChange(e.target.value);
      }}
      onBlur={() => {
        if (!props.canEdit) return;
        void props.onSave(text);
      }}
      placeholder={props.def.code}
    />
  );
}

