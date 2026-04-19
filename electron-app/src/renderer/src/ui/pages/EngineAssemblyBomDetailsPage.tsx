import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA,
  sanitizeWarehouseBomRelationSchema,
  type WarehouseBomRelationNode,
  type WarehouseBomRelationSchema,
  type WarehouseBomRelationTypeUsage,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { Input } from '../components/Input.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';

type BomDetails = {
  header: {
    id: string;
    name: string;
    engineBrandId: string;
    engineNomenclatureId?: string | null;
    engineNomenclatureCode?: string | null;
    engineNomenclatureName?: string | null;
    status: string;
    isDefault: boolean;
    version: number;
    notes?: string | null;
  };
  lines: Array<{
    id?: string;
    componentNomenclatureId: string;
    componentNomenclatureCode?: string | null;
    componentNomenclatureName?: string | null;
    componentType: string;
    qtyPerUnit: number;
    variantGroup?: string | null;
    lineKey?: string | null;
    parentLineKey?: string | null;
    isRequired: boolean;
    priority: number;
    notes?: string | null;
  }>;
};
type BomLine = BomDetails['lines'][number];
type ViewMode = 'table' | 'tree';
type PreparedLine = BomLine & {
  idx: number;
  normalizedVariantGroup: string | null;
  normalizedLineKey: string | null;
  normalizedParentLineKey: string | null;
  componentLabel: string;
};
type DraftSchemaNode = WarehouseBomRelationNode & { originTypeId?: string | null };
type PendingSchemaRenameConfirm = {
  safeSchema: WarehouseBomRelationSchema;
  renames: Array<{ fromTypeId: string; toTypeId: string }>;
  estimatedAffected: number;
  activeAffected: number;
};
type LineIssue = {
  errors: string[];
  warnings: string[];
};

const FALLBACK_COMPONENT_TYPES = ['sleeve', 'piston', 'ring', 'jacket', 'head', 'other'] as const;

const DEFAULT_COMPONENT_TYPE_LABELS: Record<string, string> = {
  sleeve: 'Гильза',
  piston: 'Поршень',
  ring: 'Кольцо',
  jacket: 'Рубашка',
  head: 'Головка',
  other: 'Прочее',
};
const TYPE_SEARCH_TOKENS: Record<string, string[]> = {
  sleeve: ['гильз', 'втулк', 'sleeve', 'liner'],
  piston: ['порш', 'piston'],
  ring: ['кольц', 'ring'],
  jacket: ['рубаш', 'jacket'],
  head: ['голов', 'head'],
};

function normalizeNodeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
}

function normalizeVariantGroup(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  return value || null;
}

function getLineDisplayLabel(line: BomLine): string {
  return line.componentNomenclatureName || line.componentNomenclatureCode || line.componentNomenclatureId || '(не выбран компонент)';
}

function normalizeSearchText(raw: string): string {
  return String(raw ?? '').trim().toLowerCase().replaceAll('ё', 'е');
}

type BomOccupancyRow = { id: string; engineBrandId: string };

function buildBomSnapshot(data: BomDetails | null): string {
  if (!data) return '';
  return JSON.stringify({
    header: {
      id: data.header.id,
      name: data.header.name,
      engineBrandId: data.header.engineBrandId,
      status: data.header.status,
      isDefault: data.header.isDefault,
      version: data.header.version,
      notes: data.header.notes ?? null,
    },
    lines: data.lines.map((line) => ({
      id: line.id ?? '',
      componentNomenclatureId: line.componentNomenclatureId,
      componentType: line.componentType,
      qtyPerUnit: Number(line.qtyPerUnit ?? 0),
      variantGroup: line.variantGroup ?? null,
      lineKey: normalizeNodeKey(String(line.lineKey ?? '')) || null,
      parentLineKey: normalizeNodeKey(String(line.parentLineKey ?? '')) || null,
      isRequired: line.isRequired !== false,
      priority: Number(line.priority ?? 100),
      notes: line.notes ?? null,
    })),
  });
}

function prepareLines(lines: BomLine[]): PreparedLine[] {
  return lines.map((line, idx) => ({
    ...line,
    idx,
    normalizedVariantGroup: normalizeVariantGroup(line.variantGroup),
    normalizedLineKey: normalizeNodeKey(String(line.lineKey ?? '')) || null,
    normalizedParentLineKey: normalizeNodeKey(String(line.parentLineKey ?? '')) || null,
    componentLabel: getLineDisplayLabel(line),
  }));
}

function validatePreparedLines(lines: PreparedLine[], relationRules?: Map<string, string[]>, requiredComponentTypes?: string[]): {
  errors: string[];
  warnings: string[];
  lineIssues: Map<number, LineIssue>;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lineIssues = new Map<number, LineIssue>();
  const pushLineIssue = (idx: number, kind: 'error' | 'warning', message: string) => {
    const current = lineIssues.get(idx) ?? { errors: [], warnings: [] };
    if (kind === 'error') current.errors.push(message);
    else current.warnings.push(message);
    lineIssues.set(idx, current);
  };
  const keyToIndexes = new Map<string, number[]>();
  const uniqueLineByKey = new Map<string, PreparedLine>();
  for (const line of lines) {
    if (!line.normalizedLineKey) continue;
    const list = keyToIndexes.get(line.normalizedLineKey) ?? [];
    list.push(line.idx);
    keyToIndexes.set(line.normalizedLineKey, list);
  }
  for (const [key, indexes] of keyToIndexes) {
    if (indexes.length <= 1) continue;
    errors.push(`Дубли ключа узла "${key}" в строках: ${indexes.map((idx) => idx + 1).join(', ')}.`);
    for (const idx of indexes) {
      pushLineIssue(idx, 'error', `Дубликат ключа узла "${key}".`);
    }
    uniqueLineByKey.delete(key);
  }
  for (const line of lines) {
    if (!line.normalizedLineKey) continue;
    if ((keyToIndexes.get(line.normalizedLineKey)?.length ?? 0) !== 1) continue;
    uniqueLineByKey.set(line.normalizedLineKey, line);
  }
  for (const line of lines) {
    if (!line.componentNomenclatureId) {
      errors.push(`Строка ${line.idx + 1}: не выбран компонент.`);
      pushLineIssue(line.idx, 'error', 'Не выбран компонент.');
    }
    if (line.normalizedParentLineKey && !line.normalizedLineKey) {
      errors.push(`Строка ${line.idx + 1}: для родителя нужно указать ключ узла.`);
      pushLineIssue(line.idx, 'error', 'Для родителя нужно указать ключ узла.');
    }
    if (line.normalizedParentLineKey && !keyToIndexes.has(line.normalizedParentLineKey)) {
      errors.push(`Строка ${line.idx + 1}: родительский узел "${line.normalizedParentLineKey}" не найден.`);
      pushLineIssue(line.idx, 'error', `Родитель "${line.normalizedParentLineKey}" не найден.`);
    }
    if (line.normalizedLineKey && line.normalizedParentLineKey && line.normalizedLineKey === line.normalizedParentLineKey) {
      errors.push(`Строка ${line.idx + 1}: узел не может ссылаться сам на себя.`);
      pushLineIssue(line.idx, 'error', 'Узел не может ссылаться сам на себя.');
    }
    if (line.qtyPerUnit <= 0 && line.isRequired !== false) {
      warnings.push(`Строка ${line.idx + 1}: обязательный компонент с нулевым количеством.`);
      pushLineIssue(line.idx, 'warning', 'Обязательный компонент с нулевым количеством.');
    }
    if (line.normalizedParentLineKey) {
      const parentLine = uniqueLineByKey.get(line.normalizedParentLineKey);
      const allowedChildren = relationRules?.get(String(parentLine?.componentType ?? '')) ?? null;
      if (parentLine && Array.isArray(allowedChildren) && allowedChildren.length > 0 && !allowedChildren.includes(String(line.componentType))) {
        warnings.push(
          `Строка ${line.idx + 1}: связь "${String(parentLine.componentType)} -> ${String(line.componentType)}" не описана в глобальной схеме.`,
        );
        pushLineIssue(line.idx, 'warning', 'Связь не описана в глобальной схеме.');
      }
    }
  }

  const keyToParent = new Map<string, string | null>();
  for (const line of lines) {
    if (!line.normalizedLineKey || !keyToIndexes.has(line.normalizedLineKey) || keyToIndexes.get(line.normalizedLineKey)!.length !== 1) continue;
    keyToParent.set(line.normalizedLineKey, line.normalizedParentLineKey ?? null);
  }
  for (const key of keyToParent.keys()) {
    const chain = new Set<string>();
    let current: string | null = key;
    while (current) {
      if (chain.has(current)) {
        errors.push(`Обнаружен цикл в связях BOM: ${Array.from(chain).join(' -> ')} -> ${current}.`);
        for (const chainKey of chain) {
          const related = keyToIndexes.get(chainKey) ?? [];
          for (const idx of related) {
            pushLineIssue(idx, 'error', 'Узел участвует в циклической зависимости.');
          }
        }
        break;
      }
      chain.add(current);
      current = keyToParent.get(current) ?? null;
    }
  }

  if (Array.isArray(requiredComponentTypes) && requiredComponentTypes.length > 0) {
    const presentTypes = new Set(lines.map((line) => String(line.componentType ?? '').trim().toLowerCase()).filter(Boolean));
    for (const requiredType of requiredComponentTypes.map((item) => String(item ?? '').trim().toLowerCase()).filter(Boolean)) {
      if (presentTypes.has(requiredType)) continue;
      errors.push(`В спецификации отсутствует обязательный тип компонента "${requiredType}" из глобальной схемы.`);
    }
  }

  return {
    errors: Array.from(new Set(errors)),
    warnings: Array.from(new Set(warnings)),
    lineIssues,
  };
}

export function EngineAssemblyBomDetailsPage(props: {
  id: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState('');
  const [data, setData] = useState<BomDetails | null>(null);
  const [bomRelationSchema, setBomRelationSchema] = useState<WarehouseBomRelationSchema>(DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA);
  const [schemaStatus, setSchemaStatus] = useState('');
  const [schemaDraftJson, setSchemaDraftJson] = useState('');
  const [schemaRootTypeDraft, setSchemaRootTypeDraft] = useState(DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA.rootTypeId);
  const [schemaNodesDraft, setSchemaNodesDraft] = useState<DraftSchemaNode[]>(
    DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA.nodes.map((node) => ({ ...node, originTypeId: node.typeId })),
  );
  const [showSchemaJsonEditor, setShowSchemaJsonEditor] = useState(false);
  const [showSchemaEditor, setShowSchemaEditor] = useState(false);
  const [schemaUsageRows, setSchemaUsageRows] = useState<WarehouseBomRelationTypeUsage[]>([]);
  const [pendingSchemaRenameConfirm, setPendingSchemaRenameConfirm] = useState<PendingSchemaRenameConfirm | null>(null);
  const [savedBomSnapshot, setSavedBomSnapshot] = useState('');
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [savingBom, setSavingBom] = useState(false);
  const [deletingBom, setDeletingBom] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [showTechnicalFields, setShowTechnicalFields] = useState(false);
  const [componentOptions, setComponentOptions] = useState<SearchSelectOption[]>([]);
  const [bomOccupancyRows, setBomOccupancyRows] = useState<BomOccupancyRow[]>([]);
  const { lookups, error: warehouseRefsError } = useWarehouseReferenceData();

  const relationNodes = useMemo(
    () => [...(bomRelationSchema.nodes ?? [])].sort((a, b) => (a.sortOrder - b.sortOrder) || a.label.localeCompare(b.label, 'ru')),
    [bomRelationSchema.nodes],
  );
  const schemaNodeOptions = useMemo(
    () =>
      schemaNodesDraft
        .map((node) => ({ id: node.typeId, label: `${node.label} (${node.typeId})` }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    [schemaNodesDraft],
  );
  const schemaUsageByTypeId = useMemo(() => {
    const map = new Map<string, WarehouseBomRelationTypeUsage>();
    for (const row of schemaUsageRows) {
      const typeId = String(row.typeId ?? '').trim().toLowerCase();
      if (!typeId) continue;
      map.set(typeId, row);
    }
    return map;
  }, [schemaUsageRows]);
  const schemaEditableRows = useMemo(
    () => schemaNodesDraft.map((node, idx) => ({ node, idx })).filter((entry) => String(entry.node.typeId) !== String(schemaRootTypeDraft)),
    [schemaNodesDraft, schemaRootTypeDraft],
  );
  const componentTypeOptions = useMemo(() => {
    const active = relationNodes
      .filter((node) => node.isActive !== false && node.typeId !== bomRelationSchema.rootTypeId)
      .map((node) => node.typeId);
    if (active.length > 0) return active;
    return [...FALLBACK_COMPONENT_TYPES];
  }, [bomRelationSchema.rootTypeId, relationNodes]);
  const requiredComponentTypes = useMemo(
    () => relationNodes.filter((node) => node.isActive !== false && node.typeId !== bomRelationSchema.rootTypeId).map((node) => node.typeId),
    [bomRelationSchema.rootTypeId, relationNodes],
  );
  const componentTypeLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of relationNodes) map.set(node.typeId, node.label || node.typeId);
    for (const [typeId, label] of Object.entries(DEFAULT_COMPONENT_TYPE_LABELS)) {
      if (!map.has(typeId)) map.set(typeId, label);
    }
    return map;
  }, [relationNodes]);
  const componentOptionById = useMemo(() => {
    const map = new Map<string, SearchSelectOption>();
    for (const option of componentOptions) map.set(String(option.id), option);
    return map;
  }, [componentOptions]);
  const componentOptionsByType = useMemo(() => {
    const map = new Map<string, SearchSelectOption[]>();
    for (const typeId of componentTypeOptions) {
      const normalizedTypeId = String(typeId).trim().toLowerCase();
      const tokens = TYPE_SEARCH_TOKENS[normalizedTypeId] ?? [];
      if (tokens.length === 0) {
        map.set(normalizedTypeId, componentOptions);
        continue;
      }
      const filtered = componentOptions.filter((option) => {
        const haystack = normalizeSearchText(`${option.label ?? ''} ${option.hintText ?? ''}`);
        return tokens.some((token) => haystack.includes(token));
      });
      map.set(normalizedTypeId, filtered);
    }
    map.set('other', componentOptions);
    return map;
  }, [componentOptions, componentTypeOptions]);
  const allowedChildrenByType = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const node of relationNodes) {
      map.set(
        node.typeId,
        (node.childTypeIds ?? []).filter((childType) => relationNodes.some((candidate) => candidate.typeId === childType && candidate.isActive !== false)),
      );
    }
    if (!map.has('other')) map.set('other', []);
    return map;
  }, [relationNodes]);

  const preparedLines = useMemo(() => prepareLines(data?.lines ?? []), [data?.lines]);
  const bomSnapshot = useMemo(() => buildBomSnapshot(data), [data]);
  const isBomDirty = useMemo(() => Boolean(data) && Boolean(savedBomSnapshot) && bomSnapshot !== savedBomSnapshot, [bomSnapshot, data, savedBomSnapshot]);
  const isSchemaDirty = useMemo(() => {
    const persisted = sanitizeWarehouseBomRelationSchema(bomRelationSchema);
    const draft = sanitizeWarehouseBomRelationSchema({
      format: 'bom_relation_schema_v1',
      rootTypeId: schemaRootTypeDraft,
      nodes: schemaNodesDraft,
    });
    return JSON.stringify(draft) !== JSON.stringify(persisted);
  }, [bomRelationSchema, schemaNodesDraft, schemaRootTypeDraft]);
  const lineValidation = useMemo(
    () => validatePreparedLines(preparedLines, allowedChildrenByType, requiredComponentTypes),
    [allowedChildrenByType, preparedLines, requiredComponentTypes],
  );
  const brandIdToBomId = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of bomOccupancyRows) {
      map.set(String(row.engineBrandId), String(row.id));
    }
    return map;
  }, [bomOccupancyRows]);

  const brandLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of lookups.engineBrands ?? []) {
      const id = String(b.id ?? '').trim();
      if (!id) continue;
      map.set(id, String(b.label ?? '').trim() || id);
    }
    return map;
  }, [lookups.engineBrands]);

  const engineBrandSelectOptions = useMemo(
    () =>
      (lookups.engineBrands ?? [])
        .map((brand) => ({
          id: String(brand.id ?? ''),
          label: String(brand.label ?? ''),
          ...(brand.code ? { hintText: String(brand.code) } : {}),
        }))
        .filter((brand) => brand.id && brand.label)
        .sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    [lookups.engineBrands],
  );

  const engineBrandOptionsForHeader = useMemo(() => {
    const currentBomId = data?.header.id ?? '';
    return engineBrandSelectOptions.filter((opt) => {
      const occupant = brandIdToBomId.get(String(opt.id));
      return !occupant || occupant === currentBomId;
    });
  }, [brandIdToBomId, data?.header.id, engineBrandSelectOptions]);

  const parentOptionsByLineIdx = useMemo(() => {
    const map = new Map<number, SearchSelectOption[]>();
    for (const line of preparedLines) {
      const options = preparedLines
        .filter((candidate) => candidate.idx !== line.idx && candidate.normalizedLineKey)
        .map((candidate) => ({
          id: String(candidate.normalizedLineKey),
          label: `${candidate.normalizedLineKey} - ${candidate.componentLabel}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      map.set(line.idx, options);
    }
    return map;
  }, [preparedLines]);
  const treeScopes = useMemo(() => {
    const baseLines = preparedLines.filter((line) => !line.normalizedVariantGroup);
    const groupNames = Array.from(new Set(preparedLines.map((line) => line.normalizedVariantGroup).filter((value): value is string => Boolean(value))));
    if (groupNames.length === 0) {
      return [{ id: 'base-only', title: 'Общая спецификация', lines: preparedLines }];
    }
    return groupNames.map((groupName) => ({
      id: groupName,
      title: `Вариант: ${groupName}`,
      lines: [...baseLines, ...preparedLines.filter((line) => line.normalizedVariantGroup === groupName)],
    }));
  }, [preparedLines]);

  const patchLine = useCallback((idx: number, patch: Partial<BomLine>) => {
    setData((prev) => {
      if (!prev) return prev;
      const current = prev.lines[idx];
      if (!current) return prev;
      const lines = [...prev.lines];
      lines[idx] = {
        id: current.id ?? '',
        componentNomenclatureId: current.componentNomenclatureId ?? '',
        componentNomenclatureCode: current.componentNomenclatureCode ?? null,
        componentNomenclatureName: current.componentNomenclatureName ?? null,
        componentType: current.componentType ?? 'other',
        qtyPerUnit: Number(current.qtyPerUnit ?? 0),
        variantGroup: current.variantGroup ?? null,
        lineKey: current.lineKey ?? null,
        parentLineKey: current.parentLineKey ?? null,
        isRequired: current.isRequired !== false,
        priority: Number(current.priority ?? 100),
        notes: current.notes ?? null,
        ...patch,
      };
      return { ...prev, lines };
    });
  }, []);

  const removeLine = useCallback((idx: number) => {
    setData((prev) => {
      if (!prev) return prev;
      const lines = prev.lines.filter((_, i) => i !== idx);
      return { ...prev, lines };
    });
  }, []);

  const loadBomOccupancy = useCallback(async () => {
    const r = await window.matrica.warehouse.assemblyBomList();
    if (!r?.ok) return;
    setBomOccupancyRows(
      (r.rows ?? []).map((row) => ({
        id: String((row as { id?: string }).id ?? ''),
        engineBrandId: String((row as { engineBrandId?: string }).engineBrandId ?? ''),
      })),
    );
  }, []);

  const refresh = useCallback(async () => {
    setStatus('Загрузка BOM...');
    const result = await window.matrica.warehouse.assemblyBomGet(props.id);
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
      return;
    }
    const nextData = (result.bom ?? null) as BomDetails | null;
    setData(nextData);
    setSavedBomSnapshot(buildBomSnapshot(nextData));
    setCloseConfirmOpen(false);
    setStatus('');
    await loadBomOccupancy();
  }, [props.id, loadBomOccupancy]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    const loadComponents = async () => {
      const result = await window.matrica.warehouse.nomenclatureList({
        isActive: true,
        limit: 5000,
      });
      if (!alive || !result?.ok) return;
      const rows = result.rows ?? [];
      setComponentOptions(
        rows.map((row) => ({
          id: String((row as { id?: string }).id ?? ''),
          label: String((row as { name?: string; code?: string }).name ?? (row as { code?: string }).code ?? ''),
          hintText: String((row as { code?: string }).code ?? ''),
        })),
      );
    };
    void loadComponents();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void loadBomOccupancy();
  }, [loadBomOccupancy]);

  useEffect(() => {
    if (!data) return;
    if (data.lines.length > 0) return;
    if (requiredComponentTypes.length === 0) return;
    setData((prev) => {
      if (!prev) return prev;
      if (prev.lines.length > 0) return prev;
      return {
        ...prev,
        lines: requiredComponentTypes.map((typeId, idx) => ({
          id: '',
          componentNomenclatureId: '',
          componentType: typeId,
          qtyPerUnit: 0,
          variantGroup: null,
          lineKey: null,
          parentLineKey: null,
          isRequired: true,
          priority: (idx + 1) * 10,
          notes: null,
        })),
      };
    });
  }, [data, requiredComponentTypes]);

  useEffect(() => {
    let alive = true;
    const loadSchema = async () => {
      const [schemaResult, usageResult] = await Promise.all([
        window.matrica.warehouse.assemblyBomSchemaGet(),
        window.matrica.warehouse.assemblyBomSchemaUsageGet(),
      ]);
      if (!alive) return;
      if (!schemaResult?.ok) {
        setSchemaStatus(`Ошибка схемы: ${String(schemaResult?.error ?? 'unknown')}`);
        return;
      }
      const schema = sanitizeWarehouseBomRelationSchema(schemaResult.schema);
      setBomRelationSchema(schema);
      setSchemaRootTypeDraft(schema.rootTypeId);
      setSchemaNodesDraft(schema.nodes.map((node) => ({ ...node, originTypeId: node.typeId })));
      setSchemaDraftJson(JSON.stringify(schema, null, 2));
      if (usageResult?.ok) {
        setSchemaUsageRows((usageResult.rows ?? []) as WarehouseBomRelationTypeUsage[]);
        setSchemaStatus('');
      } else {
        setSchemaStatus(`Предупреждение: не удалось загрузить использование типов (${String(usageResult && !usageResult.ok ? usageResult.error : 'unknown')}).`);
      }
    };
    void loadSchema();
    return () => {
      alive = false;
    };
  }, []);

  const renderScopeTree = useCallback(
    (scope: { id: string; title: string; lines: PreparedLine[] }) => {
      const lineByKey = new Map<string, PreparedLine>();
      const childrenByParent = new Map<string | null, PreparedLine[]>();
      for (const line of scope.lines) {
        if (line.normalizedLineKey && !lineByKey.has(line.normalizedLineKey)) {
          lineByKey.set(line.normalizedLineKey, line);
        }
      }
      for (const line of scope.lines) {
        const parentKey = line.normalizedParentLineKey && lineByKey.has(line.normalizedParentLineKey) ? line.normalizedParentLineKey : null;
        const list = childrenByParent.get(parentKey) ?? [];
        list.push(line);
        childrenByParent.set(parentKey, list);
      }
      for (const list of childrenByParent.values()) {
        list.sort((a, b) => {
          const byPriority = Number(a.priority ?? 100) - Number(b.priority ?? 100);
          if (byPriority !== 0) return byPriority;
          return a.componentLabel.localeCompare(b.componentLabel, 'ru');
        });
      }
      const roots = childrenByParent.get(null) ?? [];
      const visited = new Set<number>();
      const renderNode = (line: PreparedLine, depth: number): React.ReactNode => {
        if (visited.has(line.idx)) return null;
        visited.add(line.idx);
        const key = line.normalizedLineKey ?? `line-${line.idx}`;
        const children = line.normalizedLineKey ? childrenByParent.get(line.normalizedLineKey) ?? [] : [];
        const issue = lineValidation.lineIssues.get(line.idx);
        const hasError = Boolean(issue?.errors?.length);
        const hasWarning = !hasError && Boolean(issue?.warnings?.length);
        return (
          <React.Fragment key={`${scope.id}-${key}-${line.idx}`}>
            <div
              style={{
                marginLeft: depth * 18,
                padding: '6px 8px',
                borderLeft: depth > 0 ? `2px solid ${hasError ? 'var(--danger)' : hasWarning ? 'var(--warning, #b45309)' : 'var(--border)'}` : 'none',
                display: 'grid',
                gridTemplateColumns: 'minmax(260px, 1fr) auto auto auto',
                gap: 8,
                alignItems: 'center',
                borderRadius: 6,
                background: hasError ? 'rgba(239, 68, 68, 0.08)' : hasWarning ? 'rgba(245, 158, 11, 0.08)' : 'transparent',
              }}
            >
              <span>{line.componentLabel}</span>
              <span style={{ color: 'var(--subtle)', fontSize: 12 }}>{componentTypeLabelMap.get(line.componentType) ?? line.componentType}</span>
              <span style={{ color: 'var(--subtle)', fontSize: 12 }}>x{Number(line.qtyPerUnit ?? 0)}</span>
              <span style={{ color: 'var(--subtle)', fontSize: 12 }}>{line.normalizedLineKey ? `узел: ${line.normalizedLineKey}` : 'без узла'}</span>
            </div>
            {issue && (issue.errors.length > 0 || issue.warnings.length > 0) ? (
              <div style={{ marginLeft: depth * 18 + 8, marginTop: 2, marginBottom: 4 }}>
                {issue.errors.map((message, messageIdx) => (
                  <div key={`e-${line.idx}-${messageIdx}`} style={{ color: 'var(--danger)', fontSize: 12 }}>
                    - {message}
                  </div>
                ))}
                {issue.warnings.map((message, messageIdx) => (
                  <div key={`w-${line.idx}-${messageIdx}`} style={{ color: 'var(--warning, #b45309)', fontSize: 12 }}>
                    - {message}
                  </div>
                ))}
              </div>
            ) : null}
            {children.map((child) => renderNode(child, depth + 1))}
          </React.Fragment>
        );
      };
      return (
        <div key={scope.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, background: 'var(--surface2)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{scope.title}</div>
          {roots.length === 0 ? (
            <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Нет корневых узлов в этом варианте.</div>
          ) : (
            roots.map((root) => renderNode(root, 0))
          )}
        </div>
      );
    },
    [lineValidation.lineIssues],
  );

  const appendLinkedComponent = useCallback(
    (parentIdx: number, childType: string, childComponentId?: string | null) => {
      setData((prev) => {
        if (!prev) return prev;
        const parent = prev.lines[parentIdx];
        if (!parent) return prev;
        const parentKeyExisting = normalizeNodeKey(String(parent.lineKey ?? '')) || null;
        const generatedParentKey = normalizeNodeKey(`${parent.componentType || 'node'}-${parentIdx + 1}-${Date.now()}`) || `node-${Date.now()}`;
        const parentKey = parentKeyExisting ?? generatedParentKey;
        const lines = [...prev.lines];
        lines[parentIdx] = { ...parent, lineKey: parentKey };
        const normalizedChildComponentId = String(childComponentId ?? '').trim();
        if (normalizedChildComponentId) {
          const alreadyExists = lines.some(
            (line) =>
              String(line.componentNomenclatureId) === normalizedChildComponentId &&
              normalizeNodeKey(String(line.parentLineKey ?? '')) === parentKey &&
              normalizeVariantGroup(line.variantGroup) === normalizeVariantGroup(parent.variantGroup) &&
              String(line.componentType) === String(childType),
          );
          if (alreadyExists) return { ...prev, lines };
        }
        const childKey = normalizeNodeKey(`${childType}-${lines.length + 1}-${Date.now()}`) || `${childType}-${Date.now()}`;
        lines.push({
          id: '',
          componentNomenclatureId: normalizedChildComponentId,
          componentType: childType,
          qtyPerUnit: 1,
          variantGroup: parent.variantGroup ?? null,
          lineKey: childKey,
          parentLineKey: parentKey,
          isRequired: true,
          priority: Math.max(0, Number(parent.priority ?? 100) + 10),
          notes: null,
        });
        return { ...prev, lines };
      });
    },
    [],
  );

  const resetSchemaDraft = useCallback(() => {
    const safe = sanitizeWarehouseBomRelationSchema(bomRelationSchema);
    setSchemaRootTypeDraft(safe.rootTypeId);
    setSchemaNodesDraft(safe.nodes.map((node) => ({ ...node, originTypeId: node.typeId })));
    setSchemaDraftJson(JSON.stringify(safe, null, 2));
    setSchemaStatus('');
  }, [bomRelationSchema]);

  const applySchemaDraftJsonToVisual = useCallback(() => {
    try {
      const parsed = JSON.parse(schemaDraftJson) as unknown;
      const safe = sanitizeWarehouseBomRelationSchema(parsed);
      setSchemaRootTypeDraft(safe.rootTypeId);
      setSchemaNodesDraft(safe.nodes.map((node) => ({ ...node, originTypeId: node.typeId })));
      setSchemaStatus('JSON применен к визуальному редактору.');
    } catch (error) {
      setSchemaStatus(`Ошибка схемы: ${String(error)}`);
    }
  }, [schemaDraftJson]);

  const saveSchemaDraft = useCallback(
    async (safeSchema: WarehouseBomRelationSchema, renames: Array<{ fromTypeId: string; toTypeId: string }>) => {
      const result = await window.matrica.warehouse.assemblyBomSchemaSet({
        schema: safeSchema,
        ...(renames.length > 0 ? { renames } : {}),
      });
      if (!result?.ok) {
        setSchemaStatus(`Ошибка схемы: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      const nextSchema = sanitizeWarehouseBomRelationSchema(result.schema);
      setBomRelationSchema(nextSchema);
      setSchemaRootTypeDraft(nextSchema.rootTypeId);
      setSchemaNodesDraft(nextSchema.nodes.map((node) => ({ ...node, originTypeId: node.typeId })));
      setSchemaDraftJson(JSON.stringify(nextSchema, null, 2));
      const usageResult = await window.matrica.warehouse.assemblyBomSchemaUsageGet();
      if (usageResult?.ok) {
        setSchemaUsageRows((usageResult.rows ?? []) as WarehouseBomRelationTypeUsage[]);
      }
      setSchemaStatus(`Глобальная схема связей сохранена.${Number(result.renamedLineCount ?? 0) > 0 ? ` Переименовано строк BOM: ${Number(result.renamedLineCount)}.` : ''}`);
    },
    [],
  );

  const requestSchemaDraftSave = useCallback(async () => {
    try {
      const renames = schemaNodesDraft
        .map((node) => ({
          fromTypeId: String(node.originTypeId ?? '').trim().toLowerCase(),
          toTypeId: String(node.typeId ?? '').trim().toLowerCase(),
        }))
        .filter((row) => row.fromTypeId && row.toTypeId && row.fromTypeId !== row.toTypeId);
      const safeSchema = sanitizeWarehouseBomRelationSchema({
        format: 'bom_relation_schema_v1',
        rootTypeId: schemaRootTypeDraft,
        nodes: schemaNodesDraft,
      });
      if (renames.length > 0) {
        const stats = renames.reduce(
          (acc, rename) => {
            const usage = schemaUsageByTypeId.get(rename.fromTypeId);
            if (!usage) return acc;
            acc.estimatedAffected += Number(usage.activeLineCount ?? 0) + Number(usage.draftLineCount ?? 0) + Number(usage.archivedLineCount ?? 0);
            acc.activeAffected += Number(usage.activeLineCount ?? 0);
            return acc;
          },
          { estimatedAffected: 0, activeAffected: 0 },
        );
        setPendingSchemaRenameConfirm({ safeSchema, renames, estimatedAffected: stats.estimatedAffected, activeAffected: stats.activeAffected });
        return;
      }
      await saveSchemaDraft(safeSchema, renames);
    } catch (error) {
      setSchemaStatus(`Ошибка схемы: ${String(error)}`);
    }
  }, [saveSchemaDraft, schemaNodesDraft, schemaRootTypeDraft, schemaUsageByTypeId]);

  const saveBom = useCallback(async (): Promise<boolean> => {
    if (!data) return false;
    if (lineValidation.errors.length > 0) {
      setStatus(`Ошибка: исправьте ошибки спецификации (${lineValidation.errors.length}) перед сохранением.`);
      return false;
    }
    setSavingBom(true);
    try {
      const result = await window.matrica.warehouse.assemblyBomUpsert({
        id: data.header.id,
        name: data.header.name,
        engineBrandId: data.header.engineBrandId,
        version: data.header.version,
        status: data.header.status,
        isDefault: data.header.isDefault,
        notes: data.header.notes ?? null,
        lines: data.lines.map((line) => ({
          componentNomenclatureId: line.componentNomenclatureId,
          componentType: line.componentType,
          qtyPerUnit: Number(line.qtyPerUnit ?? 0),
          variantGroup: line.variantGroup ?? null,
          lineKey: normalizeNodeKey(String(line.lineKey ?? '')) || null,
          parentLineKey: normalizeNodeKey(String(line.parentLineKey ?? '')) || null,
          isRequired: line.isRequired !== false,
          priority: Number(line.priority ?? 100),
          notes: line.notes ?? null,
        })),
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return false;
      }
      await refresh();
      setStatus('BOM сохранен.');
      return true;
    } finally {
      setSavingBom(false);
    }
  }, [data, lineValidation.errors.length, refresh]);

  const requestCloseBomCard = useCallback(() => {
    if (!(showSchemaEditor ? isSchemaDirty : isBomDirty)) {
      props.onClose();
      return;
    }
    setCloseConfirmOpen(true);
  }, [isBomDirty, isSchemaDirty, props, showSchemaEditor]);

  const confirmDeleteBom = useCallback(async () => {
    if (!data) return;
    setDeletingBom(true);
    try {
      const result = await window.matrica.warehouse.assemblyBomDelete(data.header.id);
      if (!result?.ok) {
        setStatus(`Ошибка удаления: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setDeleteConfirmOpen(false);
      setStatus('');
      props.onClose();
    } finally {
      setDeletingBom(false);
    }
  }, [data, props]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <CardActionBar
        canEdit={props.canEdit}
        cardLabel={showSchemaEditor ? 'Глобальная схема BOM' : 'BOM двигателя'}
        centerNoWrap
        onPrint={
          !showSchemaEditor && data
            ? () => {
                void (async () => {
                  const printed = await window.matrica.warehouse.assemblyBomPrint(data.header.id);
                  if (!printed?.ok) {
                    setStatus(`Ошибка печати: ${String(printed?.error ?? 'unknown')}`);
                    return;
                  }
                  setStatus('Печатная форма подготовлена (payload получен).');
                })();
              }
            : undefined
        }
        onClose={requestCloseBomCard}
        onDelete={props.canEdit && !showSchemaEditor && data ? () => setDeleteConfirmOpen(true) : undefined}
        deleteLabel="Удалить спецификацию"
        extraActionsLeft={
          showSchemaEditor ? (
            <>
              <Button variant="ghost" onClick={() => setShowSchemaEditor(false)}>
                Выйти из глобальной схемы
              </Button>
              <Button variant="ghost" onClick={resetSchemaDraft}>
                Сбросить черновик
              </Button>
              <Button onClick={() => void requestSchemaDraftSave()}>Сохранить схему</Button>
            </>
          ) : (
            <>
              {props.canEdit ? (
                <Button onClick={() => void (async () => { if (await saveBom()) props.onClose(); })()} disabled={savingBom}>
                  Сохранить и закрыть
                </Button>
              ) : null}
            </>
          )
        }
        extraActionsCenter={
          showSchemaEditor ? null : (
            <>
              <Button
                variant="primary"
                title={viewMode === 'table' ? 'Показать дерево связей' : 'Показать таблицу'}
                onClick={() => setViewMode((m) => (m === 'table' ? 'tree' : 'table'))}
              >
                {viewMode === 'table' ? 'Дерево' : 'Таблица'}
              </Button>
              <Button variant={showTechnicalFields ? 'primary' : 'ghost'} onClick={() => setShowTechnicalFields((prev) => !prev)}>
                {showTechnicalFields ? 'Скрыть техполя' : 'Техполя'}
              </Button>
              <Button variant="ghost" onClick={() => setShowSchemaEditor(true)}>
                Глобальная схема
              </Button>
            </>
          )
        }
      />

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
      {schemaStatus ? <div style={{ color: schemaStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{schemaStatus}</div> : null}
      {showSchemaEditor ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontWeight: 600 }}>Глобальная схема связей компонентов</div>
            <div
              style={{
                fontSize: 12,
                borderRadius: 999,
                padding: '2px 10px',
                border: '1px solid var(--border)',
                background: isSchemaDirty ? 'rgba(245, 158, 11, 0.12)' : 'rgba(16, 185, 129, 0.12)',
                color: isSchemaDirty ? 'var(--warning, #b45309)' : '#047857',
                whiteSpace: 'nowrap',
              }}
              title={isSchemaDirty ? 'В черновике есть несохраненные изменения.' : 'Все изменения глобальной схемы сохранены.'}
            >
              {isSchemaDirty ? 'Есть несохраненные изменения' : 'Сохранено'}
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
            Размещение: раздел BOM двигателя. Оператор может менять типы компонентов и их допустимые связи. Изменения сразу влияют на кнопки и автосвязи при
            составлении новых спецификаций.
          </div>
          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
            Корневой тип редактируется отдельным полем выше. Колонка "Использование в BOM-строках" показывает фактическое использование типа в сохраненных BOM,
            а не наличие связей в графе.
          </div>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(260px, 1fr) auto auto' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Корневой тип (обычно двигатель)</span>
              <SearchSelect
                value={schemaRootTypeDraft}
                options={schemaNodeOptions}
                showAllWhenEmpty
                placeholder="Выберите корневой тип"
                onChange={(value) => setSchemaRootTypeDraft(String(value ?? 'engine'))}
              />
            </label>
            <Button
              variant="ghost"
              onClick={() => {
                const base = `component_${schemaNodesDraft.length + 1}`;
                const nextTypeId = normalizeNodeKey(base) || `component_${Date.now()}`;
                setSchemaNodesDraft((prev) => [
                  ...prev,
                  {
                    typeId: nextTypeId,
                    label: `Компонент ${prev.length + 1}`,
                    isActive: true,
                    childTypeIds: [],
                    sortOrder: (prev.length + 1) * 10,
                    originTypeId: null,
                  },
                ]);
              }}
            >
              + Добавить тип
            </Button>
            <Button variant="ghost" onClick={() => setShowSchemaJsonEditor((prev) => !prev)}>
              {showSchemaJsonEditor ? 'Скрыть JSON' : 'Показать JSON'}
            </Button>
          </div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)' }}>
            <table className="list-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>TypeId</th>
                  <th style={{ textAlign: 'left' }}>Название</th>
                  <th style={{ textAlign: 'left' }}>Активен</th>
                  <th style={{ textAlign: 'left' }}>Порядок</th>
                  <th style={{ textAlign: 'left' }}>Разрешенные дочерние типы</th>
                  <th style={{ textAlign: 'left' }}>Использование в BOM-строках</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {schemaEditableRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                      Нет дополнительных типов компонентов. Корневой тип управляется отдельно.
                    </td>
                  </tr>
                ) : (
                  schemaEditableRows.map(({ node, idx }) => (
                    <tr key={`${node.typeId}-${idx}`}>
                      <td style={{ minWidth: 150 }}>
                        <Input
                          value={node.typeId}
                          onChange={(e) =>
                            setSchemaNodesDraft((prev) => {
                              const next = [...prev];
                              next[idx] = { ...next[idx], typeId: normalizeNodeKey(e.target.value) || '' } as DraftSchemaNode;
                              return next;
                            })
                          }
                        />
                      </td>
                      <td style={{ minWidth: 220 }}>
                        <Input
                          value={node.label}
                          onChange={(e) =>
                            setSchemaNodesDraft((prev) => {
                              const next = [...prev];
                              next[idx] = { ...next[idx], label: e.target.value } as DraftSchemaNode;
                              return next;
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={node.isActive !== false}
                          onChange={(e) =>
                            setSchemaNodesDraft((prev) => {
                              const next = [...prev];
                              next[idx] = { ...next[idx], isActive: e.target.checked } as DraftSchemaNode;
                              return next;
                            })
                          }
                        />
                      </td>
                      <td style={{ minWidth: 90 }}>
                        <Input
                          value={String(node.sortOrder)}
                          onChange={(e) =>
                            setSchemaNodesDraft((prev) => {
                              const next = [...prev];
                              next[idx] = { ...next[idx], sortOrder: Number(e.target.value || 0) } as DraftSchemaNode;
                              return next;
                            })
                          }
                        />
                      </td>
                      <td style={{ minWidth: 260 }}>
                        <MultiSearchSelect
                          values={node.childTypeIds ?? []}
                          options={schemaNodesDraft
                            .filter((candidate, candidateIdx) => candidateIdx !== idx && candidate.typeId)
                            .filter((candidate) => String(candidate.typeId) !== String(schemaRootTypeDraft))
                            .map((candidate) => ({
                              id: candidate.typeId,
                              label: candidate.label || candidate.typeId,
                              hintText: candidate.typeId,
                            }))}
                          onChange={(nextValues) =>
                            setSchemaNodesDraft((prev) => {
                              const next = [...prev];
                              next[idx] = { ...next[idx], childTypeIds: nextValues } as DraftSchemaNode;
                              return next;
                            })
                          }
                          placeholder="Выберите дочерние типы"
                        />
                      </td>
                      <td style={{ minWidth: 180, fontSize: 12, color: 'var(--subtle)' }}>
                        {(() => {
                          const usage = schemaUsageByTypeId.get(String(node.typeId ?? '').trim().toLowerCase());
                          if (!usage) return 'не используется';
                          return `active: ${usage.activeLineCount}, draft: ${usage.draftLineCount}, archived: ${usage.archivedLineCount}`;
                        })()}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              const cloneBase = normalizeNodeKey(`${node.typeId}_copy`) || `copy_${Date.now()}`;
                              let cloneId = cloneBase;
                              const existing = new Set(schemaNodesDraft.map((item) => item.typeId));
                              let counter = 2;
                              while (existing.has(cloneId)) {
                                cloneId = `${cloneBase}_${counter}`;
                                counter += 1;
                              }
                              setSchemaNodesDraft((prev) => [
                                ...prev,
                                {
                                  ...node,
                                  typeId: cloneId,
                                  label: `${node.label} (копия)`,
                                  sortOrder: Math.max(...prev.map((item) => Number(item.sortOrder || 0)), 0) + 10,
                                  originTypeId: null,
                                },
                              ]);
                            }}
                            style={{ padding: '2px 8px', minHeight: 0 }}
                          >
                            Дубль
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              const usage = schemaUsageByTypeId.get(String(node.typeId ?? '').trim().toLowerCase());
                              if ((usage?.activeLineCount ?? 0) > 0) {
                                setSchemaStatus(`Ошибка схемы: тип "${node.typeId}" используется в active BOM (${usage?.activeLineCount}) и не может быть удален.`);
                                return;
                              }
                              if (String(node.typeId) === String(schemaRootTypeDraft)) {
                                setSchemaStatus('Ошибка схемы: нельзя удалить корневой тип.');
                                return;
                              }
                              setSchemaNodesDraft((prev) =>
                                prev
                                  .filter((_, rowIdx) => rowIdx !== idx)
                                  .map((item) => ({
                                    ...item,
                                    childTypeIds: (item.childTypeIds ?? []).filter((childTypeId) => childTypeId !== node.typeId),
                                  })),
                              );
                              setSchemaStatus('');
                            }}
                            style={{ color: 'var(--danger)', padding: '2px 8px', minHeight: 0 }}
                          >
                            Удалить
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'grid', gap: 6 }}>
            <div style={{ fontWeight: 600 }}>Граф связей (визуализация)</div>
            {schemaNodesDraft.length === 0 ? (
              <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Нет узлов для отображения графа.</div>
            ) : (
              schemaNodesDraft
                .slice()
                .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
                .map((node) => (
                  <div key={`graph-${node.typeId}`} style={{ display: 'grid', gridTemplateColumns: '220px auto', gap: 8, alignItems: 'center' }}>
                    <div
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: '4px 8px',
                        background: String(node.typeId) === String(schemaRootTypeDraft) ? 'rgba(59, 130, 246, 0.12)' : 'var(--surface2)',
                      }}
                    >
                      {node.label} ({node.typeId})
                    </div>
                    <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
                      {(node.childTypeIds ?? []).length === 0
                        ? 'без дочерних связей'
                        : (node.childTypeIds ?? [])
                            .map((childId) => {
                              const childNode = schemaNodesDraft.find((candidate) => candidate.typeId === childId);
                              return `-> ${childNode?.label ?? childId}`;
                            })
                            .join(', ')}
                    </div>
                  </div>
                ))
            )}
          </div>
          {showSchemaJsonEditor ? (
            <>
              <textarea
                value={schemaDraftJson}
                onChange={(e) => setSchemaDraftJson(e.target.value)}
                style={{ width: '100%', minHeight: 180, fontFamily: 'Consolas, monospace', fontSize: 12 }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="ghost" onClick={applySchemaDraftJsonToVisual}>
                  Применить JSON к визуальной схеме
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    const safeSchema = sanitizeWarehouseBomRelationSchema({
                      format: 'bom_relation_schema_v1',
                      rootTypeId: schemaRootTypeDraft,
                      nodes: schemaNodesDraft,
                    });
                    setSchemaDraftJson(JSON.stringify(safeSchema, null, 2));
                    setSchemaStatus('Визуальная схема экспортирована в JSON.');
                  }}
                >
                  Обновить JSON из визуальной схемы
                </Button>
              </div>
            </>
          ) : null}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="ghost"
              onClick={resetSchemaDraft}
            >
              Сбросить черновик
            </Button>
            <Button
              onClick={() => void requestSchemaDraftSave()}
            >
              Сохранить схему
            </Button>
          </div>
        </div>
      ) : null}
      {pendingSchemaRenameConfirm ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1200,
            padding: 16,
          }}
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            setPendingSchemaRenameConfirm(null);
            setSchemaStatus('Сохранение отменено: переименование типов не подтверждено.');
          }}
        >
          <div
            style={{
              width: 'min(680px, 100%)',
              maxHeight: '90vh',
              overflow: 'auto',
              borderRadius: 14,
              background: 'var(--surface)',
              boxShadow: '0 24px 64px rgba(2, 6, 23, 0.35)',
              border: '1px solid var(--border)',
              display: 'grid',
              gap: 10,
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 16 }}>Подтверждение переименования типов</div>
            <div style={{ fontSize: 13, color: 'var(--subtle)' }}>
              Будут обновлены строки BOM с прежними типами компонентов. Проверьте список переименований перед сохранением.
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <table className="list-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Старый typeId</th>
                    <th style={{ textAlign: 'left' }}>Новый typeId</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingSchemaRenameConfirm.renames.map((rename) => (
                    <tr key={`${rename.fromTypeId}->${rename.toTypeId}`}>
                      <td>{rename.fromTypeId}</td>
                      <td>{rename.toTypeId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 13 }}>
              Оценка затрагиваемых строк BOM: <strong>{pendingSchemaRenameConfirm.estimatedAffected}</strong>
            </div>
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 10px',
                background: pendingSchemaRenameConfirm.activeAffected > 0 ? 'rgba(239, 68, 68, 0.08)' : 'rgba(148, 163, 184, 0.08)',
                color: pendingSchemaRenameConfirm.activeAffected > 0 ? 'var(--danger)' : 'var(--subtle)',
                fontSize: 13,
              }}
            >
              {pendingSchemaRenameConfirm.activeAffected > 0
                ? `Внимание: будут изменены строки в active BOM (${pendingSchemaRenameConfirm.activeAffected}). Проверьте влияние на текущие спецификации перед подтверждением.`
                : 'В active BOM затронутых строк не обнаружено.'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button
                variant="ghost"
                onClick={() => {
                  setPendingSchemaRenameConfirm(null);
                  setSchemaStatus('Сохранение отменено: переименование типов не подтверждено.');
                }}
              >
                Отмена
              </Button>
              <Button
                onClick={async () => {
                  const pending = pendingSchemaRenameConfirm;
                  setPendingSchemaRenameConfirm(null);
                  if (!pending) return;
                  await saveSchemaDraft(pending.safeSchema, pending.renames);
                }}
              >
                Подтвердить и сохранить
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {closeConfirmOpen ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1200,
            padding: 16,
          }}
        >
          <div
            style={{
              width: 'min(540px, 100%)',
              borderRadius: 14,
              background: 'var(--surface)',
              boxShadow: '0 24px 64px rgba(2, 6, 23, 0.35)',
              border: '1px solid var(--border)',
              display: 'grid',
              gap: 10,
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 16 }}>Закрыть карточку BOM?</div>
            <div style={{ fontSize: 13, color: 'var(--subtle)' }}>
              {showSchemaEditor
                ? 'В режиме глобальной схемы есть несохраненные изменения. Выберите действие перед выходом.'
                : 'В карточке есть несохраненные изменения. Выберите действие перед выходом.'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="ghost" onClick={() => setCloseConfirmOpen(false)}>
                Отмена
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCloseConfirmOpen(false);
                  props.onClose();
                }}
              >
                Выйти без сохранения
              </Button>
              <Button
                onClick={() => {
                  void (async () => {
                    if (showSchemaEditor) {
                      setCloseConfirmOpen(false);
                      await requestSchemaDraftSave();
                      return;
                    }
                    if (await saveBom()) {
                      setCloseConfirmOpen(false);
                      props.onClose();
                    }
                  })();
                }}
                disabled={savingBom}
              >
                {showSchemaEditor ? 'Сохранить схему' : 'Сохранить и выйти'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {deleteConfirmOpen && data ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1200,
            padding: 16,
          }}
        >
          <div
            style={{
              width: 'min(520px, 100%)',
              borderRadius: 14,
              background: 'var(--surface)',
              boxShadow: '0 24px 64px rgba(2, 6, 23, 0.35)',
              border: '1px solid var(--border)',
              display: 'grid',
              gap: 10,
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 16 }}>Удалить спецификацию?</div>
            <div style={{ fontSize: 13, color: 'var(--subtle)' }}>
              Будет удалена спецификация для марки «
              {brandLabelById.get(String(data.header.engineBrandId)) || data.header.engineBrandId}» ({data.header.name}). Действие синхронизируется с
              сервером. Его нельзя отменить из интерфейса.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="ghost" onClick={() => setDeleteConfirmOpen(false)} disabled={deletingBom}>
                Отмена
              </Button>
              <Button tone="danger" onClick={() => void confirmDeleteBom()} disabled={deletingBom}>
                Удалить
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {!showSchemaEditor ? (
        <>
      {lineValidation.errors.length > 0 ? (
        <div style={{ border: '1px solid var(--danger)', background: 'rgba(239, 68, 68, 0.08)', borderRadius: 8, padding: 8 }}>
          <div style={{ fontWeight: 600, color: 'var(--danger)', marginBottom: 4 }}>Ошибки спецификации</div>
          {lineValidation.errors.map((message) => (
            <div key={message} style={{ color: 'var(--danger)', fontSize: 12 }}>
              - {message}
            </div>
          ))}
        </div>
      ) : null}
      {lineValidation.warnings.length > 0 ? (
        <div style={{ border: '1px solid var(--warning, #b45309)', background: 'rgba(245, 158, 11, 0.08)', borderRadius: 8, padding: 8 }}>
          <div style={{ fontWeight: 600, color: 'var(--warning, #b45309)', marginBottom: 4 }}>Предупреждения</div>
          {lineValidation.warnings.map((message) => (
            <div key={message} style={{ color: 'var(--warning, #b45309)', fontSize: 12 }}>
              - {message}
            </div>
          ))}
        </div>
      ) : null}
      {!data ? null : (
        <>
          <div style={{ display: 'grid', gap: 10 }}>
            {warehouseRefsError ? <div style={{ color: 'var(--danger)', fontSize: 12 }}>Справочники склада: {warehouseRefsError}</div> : null}
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>
                Марка двигателя из справочника (семейство). Спецификация и прогнозы ведутся по марке, а не по конкретной номенклатуре или серийному двигателю.
                Для марки, у которой уже есть другая карточка BOM, выбор в списке скрыт.
              </span>
              {props.canEdit ? (
                <SearchSelect
                  value={data.header.engineBrandId || null}
                  options={engineBrandOptionsForHeader}
                  showAllWhenEmpty
                  placeholder="Выберите марку из справочника"
                  onChange={(value) => {
                    const bid = value ? String(value) : '';
                    setData((prev) =>
                      prev
                        ? {
                            ...prev,
                            header: {
                              ...prev.header,
                              engineBrandId: bid,
                              engineNomenclatureId: null,
                              engineNomenclatureCode: null,
                              engineNomenclatureName: null,
                            },
                          }
                        : null,
                    );
                  }}
                />
              ) : (
                <Input
                  value={data.header.engineBrandId ? brandLabelById.get(data.header.engineBrandId) ?? data.header.engineBrandId : '—'}
                  disabled
                />
              )}
            </label>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Название BOM</span>
              <Input
                value={data.header.name}
                onChange={(e) =>
                  setData((prev) =>
                    prev
                      ? {
                          ...prev,
                          header: { ...prev.header, name: e.target.value },
                        }
                      : prev,
                  )
                }
                disabled={!props.canEdit}
                style={{ width: '100%', minWidth: 240, maxWidth: '100%' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, maxWidth: 220 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Версия</span>
              <Input value={String(data.header.version ?? 1)} disabled />
            </label>
          </div>

          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
            Кол-во/двиг. = сколько штук компонента нужно на 1 двигатель. Поля "Группа связки", "Узел" и "Родительский узел" скрыты в обычном режиме и
            показываются только по кнопке "Показать техполя".
          </div>

          {viewMode === 'table' ? (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
              <table className="list-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Тип</th>
                    <th style={{ textAlign: 'left' }}>Компонент</th>
                    <th style={{ textAlign: 'left' }}>Кол-во/двиг.</th>
                    {showTechnicalFields ? <th style={{ textAlign: 'left' }}>Группа связки</th> : null}
                    {showTechnicalFields ? <th style={{ textAlign: 'left' }}>Узел</th> : null}
                    {showTechnicalFields ? <th style={{ textAlign: 'left' }}>Родительский узел</th> : null}
                    <th style={{ textAlign: 'left' }}>Быстрые связи</th>
                    <th style={{ textAlign: 'left' }}>Обяз.</th>
                    <th style={{ textAlign: 'left' }}>Приоритет</th>
                    {props.canEdit ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line, idx) => (
                    <tr
                      key={line.id || `new-${idx}`}
                      style={
                        lineValidation.lineIssues.get(idx)?.errors.length
                          ? { background: 'rgba(239, 68, 68, 0.08)' }
                          : lineValidation.lineIssues.get(idx)?.warnings.length
                            ? { background: 'rgba(245, 158, 11, 0.08)' }
                            : undefined
                      }
                    >
                      <td>
                        <select
                          value={line.componentType}
                          onChange={(e) => patchLine(idx, { componentType: e.target.value })}
                          disabled={!props.canEdit}
                        >
                          {componentTypeOptions.map((option) => (
                            <option key={option} value={option}>
                              {componentTypeLabelMap.get(option) ?? option}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ minWidth: 260 }}>
                        <SearchSelect
                          value={line.componentNomenclatureId}
                          options={(() => {
                            const filtered = componentOptionsByType.get(String(line.componentType ?? '').trim().toLowerCase()) ?? componentOptions;
                            if (!line.componentNomenclatureId) return filtered;
                            if (filtered.some((option) => String(option.id) === String(line.componentNomenclatureId))) return filtered;
                            const selected = componentOptionById.get(String(line.componentNomenclatureId));
                            return selected ? [selected, ...filtered] : filtered;
                          })()}
                          showAllWhenEmpty
                          onChange={(next) => patchLine(idx, { componentNomenclatureId: next ?? '' })}
                          disabled={!props.canEdit}
                        />
                      </td>
                      <td>
                        <Input
                          value={String(line.qtyPerUnit ?? 0)}
                          onChange={(e) => patchLine(idx, { qtyPerUnit: Number(e.target.value || 0) })}
                          disabled={!props.canEdit}
                        />
                      </td>
                      {showTechnicalFields ? (
                        <td>
                          <Input
                            value={line.variantGroup ?? ''}
                            onChange={(e) => patchLine(idx, { variantGroup: e.target.value || null })}
                            placeholder="Например: set-a"
                            disabled={!props.canEdit}
                          />
                        </td>
                      ) : null}
                      {showTechnicalFields ? (
                        <td>
                          <Input
                            value={line.lineKey ?? ''}
                            onChange={(e) => patchLine(idx, { lineKey: normalizeNodeKey(e.target.value) || null })}
                            placeholder="Например: sleeve-a"
                            disabled={!props.canEdit}
                          />
                        </td>
                      ) : null}
                      {showTechnicalFields ? (
                        <td style={{ minWidth: 220 }}>
                          <SearchSelect
                            value={line.parentLineKey ?? null}
                            options={parentOptionsByLineIdx.get(idx) ?? []}
                            placeholder="Без родителя"
                            showAllWhenEmpty
                            onChange={(next) => patchLine(idx, { parentLineKey: next ?? null })}
                            disabled={!props.canEdit}
                          />
                        </td>
                      ) : null}
                      <td style={{ minWidth: 210 }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {(allowedChildrenByType.get(String(line.componentType)) ?? []).length === 0 ? (
                            <span style={{ color: 'var(--subtle)', fontSize: 12 }}>Нет правил</span>
                          ) : (
                            (allowedChildrenByType.get(String(line.componentType)) ?? []).map((childTypeId) => (
                              <Button
                                key={`${idx}-${childTypeId}`}
                                variant="ghost"
                                onClick={() => {
                                  appendLinkedComponent(idx, childTypeId, null);
                                  setStatus('');
                                }}
                                style={{ padding: '2px 8px', minHeight: 0 }}
                                disabled={!props.canEdit}
                              >
                                +{componentTypeLabelMap.get(childTypeId) ?? childTypeId}
                              </Button>
                            ))
                          )}
                        </div>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={line.isRequired !== false}
                          onChange={(e) => patchLine(idx, { isRequired: e.target.checked })}
                          disabled={!props.canEdit}
                        />
                      </td>
                      <td>
                        <Input
                          value={String(line.priority ?? 100)}
                          onChange={(e) => patchLine(idx, { priority: Number(e.target.value || 0) })}
                          disabled={!props.canEdit}
                        />
                      </td>
                      {props.canEdit ? (
                        <td>
                          <Button
                            variant="ghost"
                            onClick={() => removeLine(idx)}
                            style={{ color: 'var(--danger)', padding: '2px 8px', minHeight: 0 }}
                          >
                            Удалить
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8, flex: 1, minHeight: 0, overflow: 'auto' }}>
              {treeScopes.map((scope) => renderScopeTree(scope))}
            </div>
          )}

          {props.canEdit ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                variant="ghost"
                onClick={() =>
                  setData((prev) =>
                    prev
                      ? {
                          ...prev,
                          lines: [
                            ...prev.lines,
                            {
                              id: '',
                              componentNomenclatureId: '',
                              componentType: 'other',
                              qtyPerUnit: 1,
                              variantGroup: null,
                              lineKey: null,
                              parentLineKey: null,
                              isRequired: true,
                              priority: 100,
                            },
                          ],
                        }
                      : prev,
                  )
                }
              >
                Добавить строку
              </Button>
              <Button
                onClick={() => void saveBom()}
                disabled={savingBom}
              >
                Сохранить
              </Button>
            </div>
          ) : null}
        </>
      )}
        </>
      ) : null}
    </div>
  );
}
