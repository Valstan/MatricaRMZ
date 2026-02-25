import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { IncomingLinkInfo } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { buildLinkTypeOptions, normalizeForMatch, suggestLinkTargetCodeWithRules, type LinkRule } from '@matricarmz/shared';
import { applyClassicMasterdataPreset } from './masterdataClassicPreset.js';

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

const CLASSIC_TYPE_ORDER = [
  'unit',
  'warehouse_ref',
  'nomenclature_group',
  'service',
  'supplier_ref',
  'department',
  'section',
  'workshop_ref',
  'position_ref',
  'payroll_item',
  'cost_center',
  'machine_operation',
  'employee',
  'tool',
  'tool_catalog',
  'tool_property',
] as const;

const CLASSIC_TYPE_CODES = new Set<string>(CLASSIC_TYPE_ORDER);
const CLASSIC_GROUPS: Array<{ key: string; title: string; subtitle: string; icon: string; color: string; tint: string; codes: string[] }> = [
  {
    key: 'stock',
    title: 'Склад и номенклатура',
    subtitle: 'Единицы, склады, номенклатурные группы, поставщики, услуги',
    icon: '📦',
    color: '#1d4ed8',
    tint: 'rgba(37,99,235,0.08)',
    codes: ['unit', 'warehouse_ref', 'nomenclature_group', 'supplier_ref', 'service'],
  },
  {
    key: 'people',
    title: 'Кадры и зарплата',
    subtitle: 'Подразделения, участки, должности, начисления/удержания, сотрудники',
    icon: '👥',
    color: '#7c3aed',
    tint: 'rgba(124,58,237,0.08)',
    codes: ['department', 'section', 'position_ref', 'payroll_item', 'employee'],
  },
  {
    key: 'production',
    title: 'Производство и машиностроение',
    subtitle: 'Цеха, операции, инструмент и его классификаторы',
    icon: '🏭',
    color: '#b45309',
    tint: 'rgba(180,83,9,0.08)',
    codes: ['workshop_ref', 'machine_operation', 'tool', 'tool_catalog', 'tool_property'],
  },
  {
    key: 'finance',
    title: 'Учет и аналитика',
    subtitle: 'Центры затрат и управленческая аналитика',
    icon: '📊',
    color: '#0f766e',
    tint: 'rgba(15,118,110,0.08)',
    codes: ['cost_center'],
  },
];

const TECHNICAL_HIDDEN_CODES = new Set<string>([
  'engine',
  'part',
  'link_field_rule',
  'telegram_chat',
  'telegram_message',
  'sync_event',
]);

export function MasterdataPage(props: {
  canViewMasterData: boolean;
  canEditMasterData: boolean;
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
  const [entityFilter, setEntityFilter] = useState<'all' | 'named' | 'empty'>('all');
  const [showDefsPanel, setShowDefsPanel] = useState(false);
  const [showAllTypes, setShowAllTypes] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [engineBrandName, setEngineBrandName] = useState<string>('');
  const [partsOptions, setPartsOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [engineBrandPartIds, setEngineBrandPartIds] = useState<string[]>([]);
  const [partsStatus, setPartsStatus] = useState<string>('');
  const autoResyncedTypes = useRef<Set<string>>(new Set());

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
  const canUseDangerActions = props.canEditMasterData && advancedMode;

  const typeOrderRank = useMemo(() => {
    const rank = new Map<string, number>();
    CLASSIC_TYPE_ORDER.forEach((code, i) => rank.set(code, i));
    return rank;
  }, []);

  const sortedNonTechnicalTypes = useMemo(() => {
    return types
      .filter((t) => !TECHNICAL_HIDDEN_CODES.has(t.code))
      .slice()
      .sort((a, b) => {
        const ar = typeOrderRank.get(a.code);
        const br = typeOrderRank.get(b.code);
        if (ar != null && br != null) return ar - br;
        if (ar != null) return -1;
        if (br != null) return 1;
        return String(a.name).localeCompare(String(b.name), 'ru');
      });
  }, [types, typeOrderRank]);

  const classicTypes = useMemo(() => sortedNonTechnicalTypes.filter((t) => CLASSIC_TYPE_CODES.has(t.code)), [sortedNonTechnicalTypes]);
  const additionalTypes = useMemo(() => sortedNonTechnicalTypes.filter((t) => !CLASSIC_TYPE_CODES.has(t.code)), [sortedNonTechnicalTypes]);
  const visibleTypes = useMemo(() => {
    // Default to "classic only" to keep administration screen clean.
    if (showAllTypes) return sortedNonTechnicalTypes;
    return classicTypes.length > 0 ? classicTypes : sortedNonTechnicalTypes;
  }, [showAllTypes, classicTypes, sortedNonTechnicalTypes]);
  const classicGroupedTypes = useMemo(() => {
    const byCode = new Map(visibleTypes.map((t) => [t.code, t]));
    const groups = CLASSIC_GROUPS.map((group) => ({
      key: group.key,
      title: group.title,
      subtitle: group.subtitle,
      icon: group.icon,
      color: group.color,
      tint: group.tint,
      items: group.codes.map((code) => byCode.get(code)).filter((v): v is EntityTypeRow => Boolean(v)),
    })).filter((group) => group.items.length > 0);
    if (groups.length > 0) return groups;
    return [
      {
        key: 'all',
        title: 'Разделы',
        subtitle: 'Показан полный список разделов',
        icon: '🧩',
        color: '#475569',
        tint: 'rgba(71,85,105,0.08)',
        items: visibleTypes,
      },
    ];
  }, [visibleTypes]);

  const visibleDefs = useMemo(() => defs.filter((d) => d.code !== 'category_id'), [defs]);

  const filteredEntities = useMemo(() => {
    const q = entityQuery.trim().toLowerCase();
    let list = entities;
    if (entityFilter === 'named') list = list.filter((e) => String(e.displayName ?? '').trim());
    if (entityFilter === 'empty') list = list.filter((e) => !String(e.displayName ?? '').trim());
    if (!q) return list;
    return list.filter((e) => {
      const label = (e.displayName ? `${e.displayName} ` : '') + e.id;
      return label.toLowerCase().includes(q);
    });
  }, [entities, entityQuery, entityFilter]);

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

  function formatDefDataType(def: AttrDefRow): string {
    if (def.dataType !== 'link') return def.dataType;
    const targetCode = getLinkTargetTypeCode(def);
    if (!targetCode) return 'link';
    const t = types.find((x) => x.code === targetCode);
    return `link → ${t ? t.name : targetCode}`;
  }

  const [linkOptions, setLinkOptions] = useState<Record<string, { id: string; label: string }[]>>({});
  const [lookupOptionsByCode, setLookupOptionsByCode] = useState<Record<string, { id: string; label: string }[]>>({});
  const lookupTypeIdByCode = useRef<Record<string, string>>({});

  const outgoingLinks = useMemo(() => {
    const linkDefs = visibleDefs.filter((d) => d.dataType === 'link');
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
  }, [visibleDefs, entityAttrs, linkOptions, types]);

  async function refreshTypes() {
    const rows = await window.matrica.admin.entityTypes.list();
    setTypes(rows);
    setSelectedTypeId((prev) => {
      const nextVisible = rows.filter((t) => !TECHNICAL_HIDDEN_CODES.has(t.code));
      if (prev && nextVisible.some((t) => t.id === prev)) return prev;
      return nextVisible[0]?.id ?? '';
    });
    if (rows.length > 0) {
      void loadLinkRules(rows as any);
      void loadLookupOptions(rows as any);
    }
  }

  async function resyncSelectedType(
    typeId: string | null | undefined,
    opts?: { skipTypesRefresh?: boolean; silent?: boolean },
  ) {
    const targetTypeId = String(typeId ?? '').trim();
    if (!targetTypeId) return;
    try {
      if (!opts?.silent) setStatus('Подгружаем справочник с сервера…');
      const r = await window.matrica.admin.entityTypes.resyncFromServer(targetTypeId);
      if (!r?.ok) {
        if (!opts?.silent) setStatus(`Ошибка подгрузки: ${r?.error ?? 'unknown'}`);
        return;
      }
      if (r.sync && r.sync.ok === false) {
        if (!opts?.silent) setStatus(`Синхронизация не завершилась: ${r.sync.error ?? 'unknown'}`);
        return;
      }
      const resolvedId = r?.resync?.resolvedId ? String(r.resync.resolvedId) : null;
      const needsRefresh = !opts?.skipTypesRefresh || (resolvedId && resolvedId !== targetTypeId);
      if (needsRefresh) {
        await refreshTypes();
      }
      const nextTypeId = resolvedId && resolvedId !== targetTypeId ? resolvedId : targetTypeId;
      if (nextTypeId !== targetTypeId) setSelectedTypeId(nextTypeId);
      await refreshDefs(nextTypeId);
      await refreshEntities(nextTypeId);
      if (!opts?.silent) {
        setStatus('Справочник обновлён.');
        setTimeout(() => setStatus(''), 1200);
      }
    } catch (e) {
      if (!opts?.silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function resyncAllMasterdata() {
    try {
      setStatus('Подгружаем все справочники и карточки…');
      const r = await window.matrica.admin.entityTypes.resyncAllFromServer();
      if (!r?.ok) {
        setStatus(`Ошибка подгрузки: ${r?.error ?? 'unknown'}`);
        return;
      }
      if (r.sync && r.sync.ok === false) {
        setStatus(`Синхронизация не завершилась: ${r.sync.error ?? 'unknown'}`);
        return;
      }
      autoResyncedTypes.current.clear();
      await refreshTypes();
      if (selectedTypeId) {
        await refreshDefs(selectedTypeId);
        await refreshEntities(selectedTypeId);
      }
      setStatus('Справочники обновлены.');
      setTimeout(() => setStatus(''), 1200);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadLookupOptions(rows?: EntityTypeRow[]) {
    try {
      const list = rows ?? (await window.matrica.admin.entityTypes.list());
      const map: Record<string, string> = {};
      for (const t of list as any[]) {
        if (String(t.code) === 'unit') map.unit = String(t.id);
        if (String(t.code) === 'customer') map.shop = String(t.id);
      }
      lookupTypeIdByCode.current = map;
      const next: Record<string, { id: string; label: string }[]> = {};
      if (map.unit) {
        const units = await window.matrica.admin.entities.listByEntityType(map.unit);
        next.unit = (units as any[])
          .map((r) => ({ id: String(r.id), label: String(r.displayName ?? r.id) }))
          .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      }
      if (map.shop) {
        const stores = await window.matrica.admin.entities.listByEntityType(map.shop);
        next.shop = (stores as any[])
          .map((r) => ({ id: String(r.id), label: String(r.displayName ?? r.id) }))
          .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
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
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created.ok || !created.id) return null;
    await window.matrica.admin.entities.setAttr(created.id, 'name', name);
    await loadLookupOptions();
    return created.id;
  }

  async function loadLinkRules(rows?: EntityTypeRow[]) {
    try {
      const list = rows ?? (await window.matrica.admin.entityTypes.list());
      const ruleType = (list as any[]).find((t) => t.code === 'link_field_rule');
      if (!ruleType?.id) {
        setLinkRules([]);
        return;
      }
      const items = await window.matrica.admin.entities.listByEntityType(String(ruleType.id));
      const rules: LinkRule[] = [];
      for (const row of items as any[]) {
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
    const ruleType = types.find((t) => t.code === 'link_field_rule');
    if (!ruleType) return;
    const list = await window.matrica.admin.entities.listByEntityType(ruleType.id);
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
    const created = await window.matrica.admin.entities.create(ruleType.id);
    if (!created.ok || !created.id) return;
    await window.matrica.admin.entities.setAttr(created.id, 'field_name', fieldName);
    await window.matrica.admin.entities.setAttr(created.id, 'target_type_code', targetTypeCode);
    await window.matrica.admin.entities.setAttr(created.id, 'priority', 100);
    await loadLinkRules();
  }

  async function refreshDefs(typeId: string) {
    const rows = await window.matrica.admin.attributeDefs.listByEntityType(typeId);
    setDefs(rows);
  }

  async function refreshEntities(typeId: string, opts?: { selectId?: string }) {
    const rows = await window.matrica.admin.entities.listByEntityType(typeId);
    setEntities(rows as any);
    const desired = opts?.selectId ?? selectedEntityId;
    if (desired && rows.find((r) => r.id === desired)) setSelectedEntityId(desired);
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
    const r = await window.matrica.admin.entityTypes.deleteInfo(typeId).catch((e) => ({ ok: false as const, error: String(e) }));
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
      entityTypeId: typeDeleteDialog.typeId,
      deleteEntities: !!typeDeleteDialog.deleteEntities,
      deleteDefs: !!typeDeleteDialog.deleteDefs,
    };
    setStatus('Удаление раздела...');
    const r = await window.matrica.admin.entityTypes.delete(args).catch((e) => ({ ok: false as const, error: String(e) }));
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
    const r = await window.matrica.admin.attributeDefs.deleteInfo(def.id).catch((e) => ({ ok: false as const, error: String(e) }));
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
    const r = await window.matrica.admin.attributeDefs
      .delete({ attributeDefId: defDeleteDialog.defId, deleteValues: !!defDeleteDialog.deleteValues })
      .catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r.ok) {
      setDefDeleteDialog((p) => (p.open ? { ...p, loading: false, error: r.error ?? 'unknown' } : p));
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    setStatus(defDeleteDialog.deleteValues ? 'Свойство и значения удалены' : 'Свойство удалено');
    if (selectedTypeId) await refreshDefs(selectedTypeId);
    // Перезагрузим карточку записи (если открыта), чтобы исчезло поле.
    if (selectedEntityId) {
      await loadEntity(selectedEntityId);
      await refreshIncomingLinks(selectedEntityId);
    }
    closeDefDeleteDialog();
  }

  async function openDeleteDialog(entityId: string) {
    const label =
      entities.find((e) => e.id === entityId)?.displayName ??
      (entityId ? entityId.slice(0, 8) : '');

    setDeleteDialog({ open: true, entityId, entityLabel: label, loading: true, error: null, links: null });
    const r = await window.matrica.admin.entities.deleteInfo(entityId).catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r.ok) {
      setDeleteDialog({ open: true, entityId, entityLabel: label, loading: false, error: r.error ?? 'unknown', links: [] });
      return;
    }
    setDeleteDialog({ open: true, entityId, entityLabel: label, loading: false, error: null, links: r.links ?? [] });
  }

  async function doSoftDelete(entityId: string) {
    setDeleteDialog((p) => (p.open ? { ...p, loading: true, error: null } : p));
    setStatus('Удаление...');
    const r = await window.matrica.admin.entities.softDelete(entityId);
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
    const r = await window.matrica.admin.entities.detachLinksAndDelete(entityId);
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
    const d = await window.matrica.admin.entities.get(id);
    setEntityAttrs(d.attributes ?? {});
  }

  async function loadPartsOptions() {
    setPartsStatus('Загрузка списка деталей...');
    const r = await window.matrica.parts.list({ limit: 5000 }).catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r.ok) {
      setPartsOptions([]);
      setPartsStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    const opts = r.parts.map((p) => ({
      id: String(p.id),
      label: String(p.name ?? p.article ?? p.id),
    }));
    opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    setPartsOptions(opts);
    setPartsStatus('');
  }

  async function loadBrandParts(brandId: string) {
    if (!brandId) return;
    const r = await window.matrica.parts.list({ engineBrandId: brandId, limit: 5000 }).catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r.ok) {
      setEngineBrandPartIds([]);
      setPartsStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    const ids = r.parts.map((p) => String(p?.id || '')).filter(Boolean);
    setEngineBrandPartIds(ids);
  }

  async function updateBrandParts(nextIds: string[]) {
    const brandId = selectedEntityId;
    if (!brandId) return;
    if (!props.canEditMasterData) return;
    const prev = new Set(engineBrandPartIds);
    const next = new Set(nextIds);
    const toAdd = nextIds.filter((id) => !prev.has(id));
    const toRemove = engineBrandPartIds.filter((id) => !next.has(id));

    for (const partId of toAdd) {
      const links = await window.matrica.parts.partBrandLinks.list({ partId });
      if (!links.ok) {
        setPartsStatus(`Ошибка: ${links.error ?? 'не удалось загрузить связи'}`);
        return;
      }
      const exists = links.brandLinks.find((l) => l.engineBrandId === brandId);
      if (exists?.id) continue;
      const fallbackAssembly = links.brandLinks.find((l) => l.assemblyUnitNumber?.trim())?.assemblyUnitNumber?.trim() || 'не задано';
      const up = await window.matrica.parts.partBrandLinks.upsert({
        partId,
        engineBrandId: brandId,
        assemblyUnitNumber: fallbackAssembly || 'не задано',
        quantity: 0,
      });
      if (!up.ok) {
        setPartsStatus(`Ошибка: ${up.error ?? 'не удалось создать связь'}`);
        return;
      }
    }

    for (const partId of toRemove) {
      const links = await window.matrica.parts.partBrandLinks.list({ partId });
      if (!links.ok) {
        setPartsStatus(`Ошибка: ${links.error ?? 'не удалось загрузить связи'}`);
        return;
      }
      const current = links.brandLinks.find((l) => l.engineBrandId === brandId);
      if (!current?.id) continue;
      const del = await window.matrica.parts.partBrandLinks.delete({ partId, linkId: String(current.id) });
      if (!del.ok) {
        setPartsStatus(`Ошибка: ${del.error ?? 'не удалось удалить связь'}`);
        return;
      }
    }
    setPartsStatus('Сохранено');
    setTimeout(() => setPartsStatus(''), 900);
  }

  async function refreshIncomingLinks(entityId: string) {
    setIncomingLinks((p) => ({ ...p, loading: true, error: null }));
    const r = await window.matrica.admin.entities.deleteInfo(entityId).catch((e) => ({ ok: false as const, error: String(e) }));
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

  async function refreshLinkOptions(defsForType: AttrDefRow[]) {
    // Для link полей подгружаем списки записей целевого типа.
    const map: Record<string, { id: string; label: string }[]> = {};
    for (const d of defsForType) {
      if (d.dataType !== 'link') continue;
      const targetCode = getLinkTargetTypeCode(d);
      if (!targetCode) continue;
      const targetType = types.find((t) => t.code === targetCode);
      if (!targetType) continue;
      const list = await window.matrica.admin.entities.listByEntityType(targetType.id);
      map[d.code] = list.map((x) => ({ id: x.id, label: x.displayName ? `${x.displayName}` : x.id }));
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
      if (!autoResyncedTypes.current.has(selectedTypeId)) {
        autoResyncedTypes.current.add(selectedTypeId);
        await resyncSelectedType(selectedTypeId, { skipTypesRefresh: true, silent: true });
      }
    })();
  }, [selectedTypeId]);

  useEffect(() => {
    if (!types.length) return;
    setSelectedTypeId((prev) => {
      if (prev && visibleTypes.some((t) => t.id === prev)) return prev;
      return visibleTypes[0]?.id ?? '';
    });
  }, [types, visibleTypes]);

  useEffect(() => {
    if (!selectedEntityId) return;
    void loadEntity(selectedEntityId);
    void refreshIncomingLinks(selectedEntityId);
  }, [selectedEntityId]);

  useEffect(() => {
    if (selectedType?.code !== 'engine_brand') return;
    if (!selectedEntityId) return;
    setEngineBrandName(String(entityAttrs.name ?? ''));
    void loadPartsOptions();
    void loadBrandParts(selectedEntityId);
  }, [selectedType?.code, selectedEntityId, entityAttrs.name]);

  useEffect(() => {
    if (!selectedTypeId) return;
    void refreshLinkOptions(visibleDefs);
  }, [selectedTypeId, visibleDefs, types]);

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Справочники</h2>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        {props.canViewMasterData
          ? 'Здесь можно настраивать номенклатуру и свойства (для расширения системы без миграций).'
          : 'У вас нет доступа к мастер-данным.'}
      </div>

      {props.canViewMasterData && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <strong>Справочники</strong>
              <span style={{ flex: 1 }} />
              {props.canEditMasterData && (
                <Button
                  variant="ghost"
                  onClick={() => setAdvancedMode((v) => !v)}
                  style={
                    advancedMode
                      ? { border: '1px solid #b91c1c', color: '#b91c1c', background: '#fef2f2' }
                      : undefined
                  }
                >
                  {advancedMode ? 'Расширенный режим: вкл' : 'Расширенный режим'}
                </Button>
              )}
              <Button variant="ghost" onClick={() => void resyncAllMasterdata()}>
                Подгрузить все
              </Button>
              {props.canEditMasterData && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    void (async () => {
                      try {
                        setStatus('Применяем классический шаблон справочников...');
                        const r = await applyClassicMasterdataPreset((m) => setStatus(m));
                        if (!r.ok) {
                          setStatus('Ошибка применения шаблона');
                          return;
                        }
                        await refreshTypes();
                        if (selectedTypeId) {
                          await refreshDefs(selectedTypeId);
                          await refreshEntities(selectedTypeId);
                        }
                      } catch (e) {
                        setStatus(`Ошибка: ${String(e)}`);
                      }
                    })()
                  }
                >
                  Классический шаблон
                </Button>
              )}
              <Button variant="ghost" disabled={!selectedTypeId} onClick={() => void resyncSelectedType(selectedTypeId)}>
                Подгрузить с сервера
              </Button>
              <Button variant="ghost" onClick={() => void refreshTypes()}>
                Обновить
              </Button>
              {canUseDangerActions && (
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
            {!advancedMode && props.canEditMasterData && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
                Безопасный режим: удаление разделов/свойств/записей скрыто.
              </div>
            )}

            {!showAllTypes && additionalTypes.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>
                Показаны классические разделы. Дополнительные: {additionalTypes.length}.
              </div>
            )}
            <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
              {(showAllTypes
                ? [
                    {
                      key: 'all',
                      title: 'Все разделы',
                      subtitle: 'Показан полный список, включая дополнительные справочники',
                      icon: '🧩',
                      color: '#475569',
                      tint: 'rgba(71,85,105,0.08)',
                      items: visibleTypes,
                    },
                  ]
                : classicGroupedTypes
              ).map((group) => (
                <div key={group.key} style={{ border: '1px solid #f3f4f6', borderRadius: 10, padding: 8, background: group.tint }}>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: group.color }}>
                      <span>{group.icon}</span>
                      <span style={{ fontWeight: 700 }}>{group.title}</span>
                    </div>
                    <div style={{ marginTop: 2, fontSize: 11, color: '#64748b' }}>{group.subtitle}</div>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {group.items.map((t) => {
                      const active = t.id === selectedTypeId;
                      return (
                        <Button
                          key={t.id}
                          variant="ghost"
                          onClick={() => setSelectedTypeId(t.id)}
                          style={
                            active
                              ? {
                                  background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 70%)',
                                  border: '1px solid #1e40af',
                                  color: '#fff',
                                  boxShadow: '0 10px 18px rgba(29, 78, 216, 0.18)',
                                }
                              : undefined
                          }
                        >
                          {t.name}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {visibleTypes.length === 0 && <div style={{ color: '#6b7280' }}>(справочники не настроены)</div>}
            </div>
            {additionalTypes.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={() => setShowAllTypes((v) => !v)}>
                  {showAllTypes ? 'Только классические' : `Показать все (${additionalTypes.length} доп.)`}
                </Button>
              </div>
            )}

            {props.canEditMasterData && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Добавить раздел</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                  <NewEntityTypeForm
                    existingCodes={types.map((t) => t.code)}
                    onSubmit={async (code, name) => {
                      setStatus('Сохранение раздела...');
                      const r = await window.matrica.admin.entityTypes.upsert({ code, name });
                      setStatus(r.ok ? 'Раздел сохранён' : `Ошибка: ${r.error ?? 'unknown'}`);
                      await refreshTypes();
                      if (r.ok && r.id) setSelectedTypeId(String(r.id));
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr auto', gap: 8, alignItems: 'center' }}>
              <select
                value={entityFilter}
                onChange={(e) => setEntityFilter(e.target.value as any)}
                style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
              >
                <option value="all">Все записи</option>
                <option value="named">Только с названием</option>
                <option value="empty">Без названия</option>
              </select>
              <Input value={entityQuery} onChange={(e) => setEntityQuery(e.target.value)} placeholder="Поиск записей…" />
              <Button variant="ghost" disabled={!selectedTypeId} onClick={() => setShowDefsPanel(true)}>
                Свойства справочника
              </Button>
            </div>
          </div>

          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <strong>{selectedType ? `Список ${selectedType.name}` : 'Список'}</strong>
              <span style={{ flex: 1 }} />
              {props.canEditMasterData && selectedTypeId && (
                <Button
                  onClick={async () => {
                    setStatus('Создание записи...');
                    const r = await window.matrica.admin.entities.create(selectedTypeId);
                    if (!r.ok) {
                      setStatus(`Ошибка: ${r.error}`);
                      return;
                    }
                    setStatus('Запись создана');
                    await refreshEntities(selectedTypeId);
                    setSelectedEntityId(r.id);
                  }}
                >
                  Добавить запись
                </Button>
              )}
            </div>

            {!selectedTypeId ? (
              <div style={{ marginTop: 12, color: '#6b7280' }}>Выберите справочник</div>
            ) : (
              <div className="list-panel list-panel--catalog" style={{ marginTop: 10, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                  {filteredEntities.map((e) => {
                    const active = e.id === selectedEntityId;
                    const label = e.displayName?.trim() ? e.displayName : 'Без названия';
                    return (
                      <div
                        key={e.id}
                        onClick={() => setSelectedEntityId(e.id)}
                        className="list-row"
                        style={{
                          cursor: 'pointer',
                          borderLeft: active ? '3px solid #22c55e' : '3px solid transparent',
                          background: active ? 'var(--list-row-green-hover)' : undefined,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 700, color: '#111827', lineHeight: 1.2 }}>{label}</div>
                          <div style={{ marginTop: 2, fontSize: 12, color: '#6b7280' }}>{e.id.slice(0, 8)}</div>
                        </div>
                        <span style={{ flex: 1 }} />
                        {canUseDangerActions && (
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
            )}
          </div>

          {selectedEntity ? (
            <div className="card-panel" style={{ borderRadius: 12, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{ fontWeight: 800, color: 'var(--text)' }}>Карточка записи</div>
                <div style={{ color: '#64748b', fontSize: 12 }}>
                  {selectedType?.name ? `Справочник: ${selectedType.name}` : ''}
                </div>
              </div>
              <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 8 }}>
                {props.canEditMasterData ? 'Редактирование свойств' : 'Свойства (только просмотр)'}
              </div>

              {selectedType?.code === 'engine_brand' ? (
                <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 10, alignItems: 'center' }}>
                  <div style={{ color: '#6b7280' }}>Марка двигателя</div>
                  <Input
                    value={engineBrandName}
                    disabled={!props.canEditMasterData}
                    onChange={(e) => setEngineBrandName(e.target.value)}
                    onBlur={async () => {
                      const next = engineBrandName.trim();
                      const r = await window.matrica.admin.entities.setAttr(selectedEntityId, 'name', next || null);
                      if (!r.ok) setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
                      else setStatus('Сохранено');
                      await refreshEntities(selectedTypeId);
                    }}
                  />

                  <div style={{ color: '#6b7280', alignSelf: 'start', paddingTop: 6 }}>Детали</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <Button variant="ghost" onClick={() => void loadPartsOptions()}>
                        Обновить список
                      </Button>
                      <span style={{ color: '#6b7280', fontSize: 12 }}>Выбрано: {engineBrandPartIds.length}</span>
                    </div>
                    <MultiSearchSelect
                      values={engineBrandPartIds}
                      options={partsOptions}
                      disabled={!props.canEditMasterData}
                      placeholder="Выберите детали для этой марки"
                      onChange={(next) => {
                        const labelById = new Map(partsOptions.map((o) => [o.id, o.label]));
                        const sorted = [...next].sort((a, b) =>
                          String(labelById.get(a) ?? a).localeCompare(String(labelById.get(b) ?? b), 'ru'),
                        );
                        setEngineBrandPartIds(sorted);
                        if (props.canEditMasterData) void updateBrandParts(sorted);
                      }}
                    />
                    {partsStatus && (
                      <div style={{ color: partsStatus.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', fontSize: 12 }}>{partsStatus}</div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 10, alignItems: 'center' }}>
                    {visibleDefs.map((d) => (
                      <React.Fragment key={d.id}>
                        <div style={{ color: '#6b7280' }}>{d.name}</div>
                        <FieldEditor
                          def={d}
                          canEdit={props.canEditMasterData}
                          value={entityAttrs[d.code]}
                          linkOptions={linkOptions[d.code] ?? []}
                          lookupOptions={lookupOptionsByCode[d.code] ?? []}
                          {...(d.code === 'unit' || d.code === 'shop'
                            ? { lookupCreate: async (label: string) => await createLookupEntity(d.code as 'unit' | 'shop', label) }
                            : {})}
                          onChange={(v) => setEntityAttrs((p) => ({ ...p, [d.code]: v }))}
                          onSave={async (v) => {
                            const r = await window.matrica.admin.entities.setAttr(selectedEntityId, d.code, v);
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

                    <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
                      <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                        <div style={{ fontWeight: 800, marginBottom: 8 }}>Исходящие</div>
                        {outgoingLinks.length === 0 ? (
                          <div style={{ color: '#6b7280' }}>В этом разделе нет связанных полей.</div>
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
                          <div style={{ color: '#6b7280' }}>Загрузка…</div>
                        ) : incomingLinks.error ? (
                          <div style={{ color: '#b91c1c' }}>Ошибка: {incomingLinks.error}</div>
                        ) : incomingLinks.links.length === 0 ? (
                          <div style={{ color: '#6b7280' }}>Никто не ссылается на эту запись.</div>
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
                </>
              )}
            </div>
          ) : (
            <div style={{ color: '#6b7280' }}>Выберите запись справочника.</div>
          )}
        </div>
      )}

      {typeDeleteDialog.open && (
        <div
          onClick={() => {
            if (!typeDeleteDialog.loading) closeTypeDeleteDialog();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 9998,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 720,
              maxWidth: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              background: '#fff',
              borderRadius: 16,
              boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
              padding: 16,
            }}
          >
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
                  <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: '#111827' }}>
                    <input
                      type="checkbox"
                      checked={typeDeleteDialog.deleteEntities}
                      disabled={typeDeleteDialog.loading}
                      onChange={(e) => setTypeDeleteDialog((p) => (p.open ? { ...p, deleteEntities: e.target.checked } : p))}
                    />
                    Удалить записи этого раздела (умно: с отвязкой входящих связей)
                  </label>
                  <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: '#111827' }}>
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
                  <Button
                    onClick={() => void doDeleteType()}
                    disabled={typeDeleteDialog.loading}
                    style={{ background: '#b91c1c', border: '1px solid #991b1b' }}
                  >
                    Удалить раздел
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {deleteDialog.open && (
        <div
          onClick={() => {
            if (!deleteDialog.loading) closeDeleteDialog();
          }}
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
              border: '1px solid rgba(255,255,255,0.25)',
              boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
              padding: 16,
            }}
          >
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
                      <table className="list-table list-table--catalog">
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
                                <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                                  {l.fromEntityId.slice(0, 8)}
                                </div>
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
                    <Button
                      onClick={() => void doDetachAndDelete(deleteDialog.entityId)}
                      disabled={deleteDialog.loading}
                      style={{ background: '#b91c1c', border: '1px solid #991b1b' }}
                    >
                      Отвязать и удалить
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void doSoftDelete(deleteDialog.entityId)}
                      disabled={deleteDialog.loading}
                      style={{ background: '#b91c1c', border: '1px solid #991b1b' }}
                    >
                      Удалить
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showDefsPanel && (
        <div
          onClick={() => setShowDefsPanel(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 9996,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 920,
              maxWidth: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              background: '#fff',
              borderRadius: 16,
              boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
              padding: 16,
            }}
          >
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: '#111827' }}>
                {selectedType ? `Свойства справочника: ${selectedType.name}` : 'Свойства справочника'}
              </div>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" onClick={() => setShowDefsPanel(false)}>
                Закрыть
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
                        const r = await window.matrica.admin.attributeDefs.upsert(payload);
                        setStatus(r.ok ? 'Свойство сохранено' : `Ошибка: ${r.error ?? 'unknown'}`);
                        await refreshDefs(selectedTypeId);
                      }}
                    />
                  )}
                  <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                    <table className="list-table list-table--catalog">
                      <thead>
                        <tr style={{ background: 'linear-gradient(135deg, #db2777 0%, #9d174d 120%)', color: '#fff' }}>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Код</th>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Название</th>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Тип</th>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Обяз.</th>
                          {canUseDangerActions && (
                            <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, width: 120 }}>
                              Действия
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleDefs.map((d) => (
                          <tr key={d.id}>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.code}</td>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.name}</td>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{formatDefDataType(d)}</td>
                            <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.isRequired ? 'да' : 'нет'}</td>
                            {canUseDangerActions && (
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
                        {visibleDefs.length === 0 && (
                          <tr>
                            <td style={{ padding: 12, color: '#6b7280' }} colSpan={canUseDangerActions ? 5 : 4}>
                              Свойств нет
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div style={{ color: '#6b7280' }}>Выберите справочник.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {defDeleteDialog.open && (
        <div
          onClick={() => {
            if (!defDeleteDialog.loading) closeDefDeleteDialog();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 9997,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 720,
              maxWidth: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              background: '#fff',
              borderRadius: 16,
              boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
              padding: 16,
            }}
          >
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
            {defDeleteDialog.defDataType && (
              <div style={{ marginTop: 4, color: '#6b7280', fontSize: 12 }}>Тип: {defDeleteDialog.defDataType}</div>
            )}

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
                  <label style={{ display: 'flex', gap: 10, alignItems: 'center', color: '#111827' }}>
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
                  <Button
                    onClick={() => void doDeleteDef()}
                    disabled={defDeleteDialog.loading}
                    style={{ background: '#b91c1c', border: '1px solid #991b1b' }}
                  >
                    Удалить свойство
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {status && <div style={{ marginTop: 12, color: '#6b7280' }}>{status}</div>}
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8 }}>
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code (например: passport_details)" />
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="название (например: Паспорт)" />
        <select
          value={dataType}
          onChange={(e) => setDataType(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
        >
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
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827', fontSize: 14 }}>
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
    const types = await window.matrica.admin.entityTypes.list();
    const target = types.find((t) => String((t as any).code) === linkTargetTypeCode) ?? null;
    if (!target?.id) return null;
    const created = await window.matrica.admin.entities.create(String(target.id));
    if (!created.ok || !created.id) return null;
    const defs = await window.matrica.admin.attributeDefs.listByEntityType(String(target.id));
    const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
    const labelDef = defs.find((d) => labelKeys.includes(String((d as any).code))) ?? null;
    if (labelDef?.code) {
      await window.matrica.admin.entities.setAttr(created.id, String(labelDef.code), label);
    }
    return created.id;
  }

  // date хранится как ms number (unix ms).
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
      <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
        <span style={{ color: '#6b7280', fontSize: 12 }}>{checked ? 'да' : 'нет'}</span>
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
            // оставим как есть
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
        {...(props.canEdit && linkTargetTypeCode
          ? {
              onCreate: async (label: string) => {
                const id = await createLinkedEntity(label);
                if (!id) return null;
                props.onChange(id);
                void props.onSave(id);
                return id;
              },
            }
          : {})}
        {...(linkTargetTypeCode
          ? { createLabel: linkTargetTypeCode === 'category' ? 'Новая категория' : `Новая запись (${linkTargetTypeCode})` }
          : {})}
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
        {...(props.canEdit && props.lookupCreate
          ? {
              onCreate: async (label: string) => {
                const lookupCreate = props.lookupCreate;
                if (!lookupCreate) return null;
                const id = await lookupCreate(label);
                if (!id) return null;
                props.onChange(label.trim());
                void props.onSave(label.trim());
                return id;
              },
            }
          : {})}
        createLabel={props.def.code === 'unit' ? 'Новая единица' : 'Новый контрагент'}
      />
    );
  }

  // text / fallback
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


