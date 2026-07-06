import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildGroupedNomenclatureOptions,
  DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA,
  sanitizeWarehouseBomRelationSchema,
  type WarehouseBomRelationNode,
  type WarehouseBomRelationSchema,
  type WarehouseBomRelationTypeUsage,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { GroupedSearchSelect, type GroupedSearchSelectGroup } from '../components/GroupedSearchSelect.js';
import { Input } from '../components/Input.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useRecentSelectOptions } from '../hooks/useRecentSelectOptions.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { formatAssemblyVariantLabel } from '../utils/assemblyVariant.js';
import {
  buildBomSnapshot as buildBomSnapshotShared,
  type EngineBomDetailsForSnapshot,
} from '../utils/engineBomCardLogic.js';
import { escapeHtml, openPrintPreview, type PrintSection } from '../utils/printPreview.js';

type BomDetails = {
  header: {
    id: string;
    name: string;
    engineBrandIds: string[];
    engineNomenclatureId?: string | null;
    engineNomenclatureCode?: string | null;
    engineNomenclatureName?: string | null;
    status: string;
    isDefault: boolean;
    version: number;
    notes?: string | null;
    /** v1.21.3+: маппинг nomenclatureId → ожидаемый componentTypeId по карточке номенклатуры. Для UI-диагностики рассинхрона. */
    componentTypeByNomenclatureId?: Record<string, string | null> | null;
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
    /** Модель «Позиции + варианты»: строки с общим positionKey — взаимозаменяемые варианты одной позиции. */
    positionKey?: string | null;
    /** Имя позиции («Картер верхний»). */
    positionLabel?: string | null;
    /** Основной вариант позиции (идёт в прогноз/сборку). */
    isDefaultOption?: boolean;
  }>;
};
type BomLine = BomDetails['lines'][number];
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

function keyValueTable(rows: Array<[string, string]>): string {
  return `<table><tbody>${rows
    .map(([k, v]) => `<tr><th style="width:260px">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function buildBomPrintSections(lines: BomLine[]): PrintSection[] {
  if (!lines.length) {
    return [{ id: 'lines-empty', title: 'Строки спецификации', html: '<div class="muted">Нет строк BOM</div>' }];
  }

  const buildKeyResolver = (chunk: BomLine[]) => {
    const byKey = new Map<string, string>();
    for (const line of chunk) {
      const raw = String(line.lineKey ?? '').trim();
      if (!raw) continue;
      const label = getLineDisplayLabel(line);
      byKey.set(raw, label);
      const normalized = normalizeNodeKey(raw);
      if (normalized && normalized !== raw && !byKey.has(normalized)) {
        byKey.set(normalized, label);
      }
    }
    return (raw: string | null | undefined): string => {
      const key = String(raw ?? '').trim();
      if (!key) return '—';
      return byKey.get(key) ?? byKey.get(normalizeNodeKey(key)) ?? key;
    };
  };

  const renderRows = (chunk: BomLine[]): string => {
    const resolveKey = buildKeyResolver(chunk);
    return [...chunk]
      .sort((a, b) => {
        const ap = Number(a.priority ?? 100);
        const bp = Number(b.priority ?? 100);
        if (ap !== bp) return ap - bp;
        return getLineDisplayLabel(a).localeCompare(getLineDisplayLabel(b), 'ru');
      })
      .map((line) => {
        const type = String(line.componentType ?? '');
        const component = getLineDisplayLabel(line);
        const qty = String(Number(line.qtyPerUnit ?? 0));
        const required = line.isRequired !== false ? 'Да' : 'Нет';
        const priority = String(Number(line.priority ?? 100));
        const parent = resolveKey(line.parentLineKey);
        return `<tr>
          <td>${escapeHtml(type)}</td>
          <td>${escapeHtml(component)}</td>
          <td>${escapeHtml(qty)}</td>
          <td>${escapeHtml(required)}</td>
          <td>${escapeHtml(priority)}</td>
          <td>${escapeHtml(parent)}</td>
        </tr>`;
      })
      .join('');
  };

  const renderTable = (chunk: BomLine[]): string => {
    const rows = renderRows(chunk);
    return `<table>
      <thead>
        <tr>
          <th>Тип</th>
          <th>Компонент</th>
          <th>Кол-во/двиг.</th>
          <th>Обяз.</th>
          <th>Приоритет</th>
          <th>Входит в</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  };

  const baseLines = lines.filter((line) => !String(line.variantGroup ?? '').trim());
  const variantMap = new Map<string, BomLine[]>();
  for (const line of lines) {
    const vg = String(line.variantGroup ?? '').trim();
    if (!vg) continue;
    const arr = variantMap.get(vg) ?? [];
    arr.push(line);
    variantMap.set(vg, arr);
  }
  const variants = Array.from(variantMap.entries()).sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  const sections: PrintSection[] = [];

  if (baseLines.length > 0) {
    sections.push({
      id: 'bom-base',
      title: 'База (общие строки)',
      html: renderTable(baseLines),
      checked: true,
    });
  }

  Array.from(variants).forEach(([variantId, variantOnlyLines], idx) => {
    const merged = [...baseLines, ...variantOnlyLines];
    const safeId = `variant-${variantId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'unnamed'}`;
    sections.push({
      id: safeId,
      title: formatAssemblyVariantLabel(variantId, idx),
      html: renderTable(merged),
      checked: true,
    });
  });

  if (sections.length === 0) {
    return [{ id: 'bom-lines', title: 'Строки спецификации', html: renderTable(lines), checked: true }];
  }
  return sections;
}

// Snapshot для dirty-detection — shared логика в utils/engineBomCardLogic.
// BomDetails имеет дополнительные поля для рендера; для сравнения они не важны,
// поэтому передаём минимальный вариант через type-cast.
function buildBomSnapshot(data: BomDetails | null): string {
  return buildBomSnapshotShared(data as unknown as EngineBomDetailsForSnapshot | null);
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

function variantScopeKeyPrepared(line: PreparedLine): string {
  return line.normalizedVariantGroup || '__base__';
}

function validatePreparedLines(lines: PreparedLine[], relationRules?: Map<string, string[]>): {
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

  const byScope = new Map<string, PreparedLine[]>();
  for (const line of lines) {
    const sk = variantScopeKeyPrepared(line);
    const arr = byScope.get(sk) ?? [];
    arr.push(line);
    byScope.set(sk, arr);
  }

  for (const [scope, scopeLines] of byScope) {
    const keyToIndexes = new Map<string, number[]>();
    const uniqueLineByKey = new Map<string, PreparedLine>();
    for (const line of scopeLines) {
      if (!line.normalizedLineKey) continue;
      const list = keyToIndexes.get(line.normalizedLineKey) ?? [];
      list.push(line.idx);
      keyToIndexes.set(line.normalizedLineKey, list);
    }
    for (const [key, indexes] of keyToIndexes) {
      if (indexes.length <= 1) continue;
      errors.push(`Вариант «${scope}»: дубли ключа узла "${key}" в строках: ${indexes.map((idx) => idx + 1).join(', ')}.`);
      for (const idx of indexes) {
        pushLineIssue(idx, 'error', `Дубликат ключа узла "${key}".`);
      }
    }
    for (const line of scopeLines) {
      if (!line.normalizedLineKey) continue;
      if ((keyToIndexes.get(line.normalizedLineKey)?.length ?? 0) !== 1) continue;
      uniqueLineByKey.set(line.normalizedLineKey, line);
    }
    for (const line of scopeLines) {
      if (!line.componentNomenclatureId) {
        errors.push(`Строка ${line.idx + 1}: не выбран компонент.`);
        pushLineIssue(line.idx, 'error', 'Не выбран компонент.');
      }
      if (line.normalizedParentLineKey && !line.normalizedLineKey) {
        errors.push(`Строка ${line.idx + 1}: для родителя нужно указать ключ узла.`);
        pushLineIssue(line.idx, 'error', 'Для родителя нужно указать ключ узла.');
      }
      if (line.normalizedParentLineKey && !keyToIndexes.has(line.normalizedParentLineKey)) {
        errors.push(
          `Строка ${line.idx + 1}: родительский узел "${line.normalizedParentLineKey}" не найден в этом варианте (вариант «${scope}»).`,
        );
        pushLineIssue(line.idx, 'error', `Родитель "${line.normalizedParentLineKey}" не найден в варианте.`);
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
    for (const line of scopeLines) {
      if (!line.normalizedLineKey || !keyToIndexes.has(line.normalizedLineKey) || keyToIndexes.get(line.normalizedLineKey)!.length !== 1) continue;
      keyToParent.set(line.normalizedLineKey, line.normalizedParentLineKey ?? null);
    }
    for (const key of keyToParent.keys()) {
      const chain = new Set<string>();
      let current: string | null = key;
      while (current) {
        if (chain.has(current)) {
          errors.push(`Вариант «${scope}»: обнаружен цикл в связях BOM: ${Array.from(chain).join(' -> ')} -> ${current}.`);
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
  const { confirm } = useConfirm();
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
  const [lastSaveWarnings, setLastSaveWarnings] = useState<string[]>([]);
  const [nomenclatureMetaRows, setNomenclatureMetaRows] = useState<
    Array<{
      id: string;
      name: string;
      code: string;
      defaultBrandId?: string | null;
      itemType?: string | null;
      category?: string | null;
      componentTypeId: string | null;
    }>
  >([]);
  const { pushRecent, withRecents } = useRecentSelectOptions(`matrica:engine-bom-details-recents:${props.id}`, 8);
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
  const componentTypeLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of relationNodes) map.set(node.typeId, node.label || node.typeId);
    return map;
  }, [relationNodes]);
  const componentGroupedGroups = useMemo<GroupedSearchSelectGroup[]>(
    () =>
      buildGroupedNomenclatureOptions({
        items: nomenclatureMetaRows.map((row) => ({
          id: row.id,
          label: row.name || row.code || row.id,
          ...(row.code ? { hintText: row.code } : {}),
          componentTypeId: row.componentTypeId,
        })),
        schema: bomRelationSchema,
      }),
    [bomRelationSchema, nomenclatureMetaRows],
  );
  const componentItemById = useMemo(() => {
    const map = new Map<string, { id: string; label: string; hintText?: string; componentTypeId: string | null }>();
    for (const group of componentGroupedGroups) {
      for (const item of group.items) map.set(item.id, item);
    }
    return map;
  }, [componentGroupedGroups]);
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
    () => validatePreparedLines(preparedLines, allowedChildrenByType),
    [allowedChildrenByType, preparedLines],
  );
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
    // Марка может быть привязана сразу к нескольким BOM, поэтому фильтр по занятым убран.
    return withRecents('engineBrandId', engineBrandSelectOptions);
  }, [engineBrandSelectOptions, withRecents]);



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
        positionKey: current.positionKey ?? null,
        positionLabel: current.positionLabel ?? null,
        isDefaultOption: current.isDefaultOption !== false,
        ...patch,
      };
      return { ...prev, lines };
    });
  }, []);


  // ── Модель «Позиции + взаимозаменяемые варианты» ─────────────────────────
  const genPositionKey = useCallback(() => `pos-${Math.random().toString(36).slice(2, 9)}`, []);

  // Патч по всем строкам-вариантам одной позиции (label/qty живут на каждом варианте — держим синхронно).
  const patchPositionLines = useCallback((idxs: number[], patch: Partial<BomLine>) => {
    const set = new Set(idxs);
    setData((prev) => (prev ? { ...prev, lines: prev.lines.map((line, i) => (set.has(i) ? { ...line, ...patch } : line)) } : prev));
  }, []);

  const setDefaultOption = useCallback((idxs: number[], chosenIdx: number) => {
    const set = new Set(idxs);
    setData((prev) => (prev ? { ...prev, lines: prev.lines.map((line, i) => (set.has(i) ? { ...line, isDefaultOption: i === chosenIdx } : line)) } : prev));
  }, []);

  const addPosition = useCallback(() => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            lines: [
              ...prev.lines,
              { id: '', componentNomenclatureId: '', componentType: 'other', qtyPerUnit: 1, variantGroup: null, lineKey: null, parentLineKey: null, isRequired: true, priority: 100, positionKey: genPositionKey(), positionLabel: '', isDefaultOption: true },
            ],
          }
        : prev,
    );
  }, [genPositionKey]);

  // Добавить взаимозаменяемый вариант детали в позицию. Если позиция была одиночкой
  // (positionKey пуст — легаси-строка), присваиваем ей сгенерированный ключ, чтобы варианты сгруппировались.
  const addOption = useCallback((idxs: number[]) => {
    setData((prev) => {
      if (!prev) return prev;
      const first = idxs.map((i) => prev.lines[i]).find(Boolean);
      if (!first) return prev;
      let key = String(first.positionKey ?? '').trim();
      let lines = prev.lines;
      if (!key) {
        key = genPositionKey();
        const set = new Set(idxs);
        lines = lines.map((line, i) => (set.has(i) ? { ...line, positionKey: key } : line));
      }
      const newLine = {
        id: '',
        componentNomenclatureId: '',
        componentType: 'other',
        qtyPerUnit: Number(first.qtyPerUnit ?? 1),
        variantGroup: first.variantGroup ?? null,
        lineKey: null,
        parentLineKey: null,
        isRequired: first.isRequired !== false,
        priority: Number(first.priority ?? 100),
        positionKey: key,
        positionLabel: first.positionLabel ?? '',
        isDefaultOption: false,
      };
      return { ...prev, lines: [...lines, newLine] };
    });
  }, [genPositionKey]);

  const removePosition = useCallback((idxs: number[]) => {
    const set = new Set(idxs);
    setData((prev) => (prev ? { ...prev, lines: prev.lines.filter((_, i) => !set.has(i)) } : prev));
  }, []);

  // Удалить один вариант детали. Если удалили основной и в позиции остались варианты — назначаем первый оставшийся основным.
  const removeOption = useCallback((idx: number) => {
    setData((prev) => {
      if (!prev) return prev;
      const removed = prev.lines[idx];
      let lines = prev.lines.filter((_, i) => i !== idx);
      if (removed && removed.isDefaultOption !== false) {
        const key = String(removed.positionKey ?? '').trim();
        if (key) {
          const remaining = lines.findIndex((l) => String(l.positionKey ?? '').trim() === key);
          if (remaining >= 0) lines = lines.map((l, i) => (i === remaining ? { ...l, isDefaultOption: true } : l));
        }
      }
      return { ...prev, lines };
    });
  }, []);


  const refresh = useCallback(async () => {
    setStatus('Загрузка BOM...');
    const result = await window.matrica.warehouse.assemblyBomGet(props.id);
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
      return;
    }
    const nextData = (result.bom ?? null) as unknown as BomDetails | null;
    setData(nextData);
    setSavedBomSnapshot(buildBomSnapshot(nextData));
    setCloseConfirmOpen(false);
    setLastSaveWarnings([]);
    setStatus('');
  }, [props.id]);

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
      setNomenclatureMetaRows(
        rows.map((row) => {
          const rec = row as {
            id?: string;
            name?: string;
            code?: string;
            defaultBrandId?: string | null;
            itemType?: string | null;
            category?: string | null;
            componentTypeId?: string | null;
          };
          return {
            id: String(rec.id ?? ''),
            name: String(rec.name ?? ''),
            code: String(rec.code ?? ''),
            defaultBrandId: rec.defaultBrandId ?? null,
            itemType: rec.itemType ?? null,
            category: rec.category ?? null,
            componentTypeId: rec.componentTypeId ?? null,
          };
        }),
      );
    };
    void loadComponents();
    return () => {
      alive = false;
    };
  }, []);

  // Чистый расчёт «чего не хватает» по глобальной схеме. БЕЗ мутации data.
  // Раньше тут был useEffect, который сам добавлял черновые stub-строки в data при mount/refresh —
  // из-за этого после save→refresh карточка становилась грязной без действий пользователя и могла
  // затереть пользовательский выбор stub-строкой. Теперь карточка только сообщает дельту через
  // warning-баннер с кнопкой «+Добавить» — пользователь решает сам. Логика в utils/engineBomCardLogic.

  // Диагностика рассинхрона componentType ↔ componentTypeId номенклатуры (v1.21.3).
  // Источник истины — карточка номенклатуры (specJson.componentTypeId либо derive по имени).
  // Backend сравнивает с типом строки при upsert и приводит к типу из номенклатуры (auto-fix).
  // Здесь — превентивный баннер: показываем пользователю до save, что строка будет переименована
  // в другой тип. Если у номенклатуры тип не задан (mapping=null) — не считаем рассинхроном,
  // в этом случае backend ничего не меняет (но даёт warning «заполните тип в карточке»).
  const componentTypeMismatchedLines = useMemo(() => {
    if (!data) return [] as Array<{ index: number; lineLabel: string; currentType: string; expectedType: string }>;
    const mapping = (data.header.componentTypeByNomenclatureId ?? null) as Record<string, string | null> | null;
    if (!mapping) return [];
    const out: Array<{ index: number; lineLabel: string; currentType: string; expectedType: string }> = [];
    data.lines.forEach((line, idx) => {
      const nomId = String(line.componentNomenclatureId ?? '').trim();
      if (!nomId) return;
      const expected = mapping[nomId];
      if (!expected) return; // null = у номенклатуры не задан тип, auto-fix не сработает
      const current = String(line.componentType ?? '').trim().toLowerCase();
      if (current === expected) return;
      out.push({
        index: idx,
        lineLabel: String(line.componentNomenclatureName ?? line.componentNomenclatureCode ?? nomId),
        currentType: current || '—',
        expectedType: expected,
      });
    });
    return out;
  }, [data]);

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





  const resortBomLinesBySchema = useCallback(() => {
    if (!props.canEdit || !data) return;
    const sortOrderByType = new Map<string, number>();
    for (const node of bomRelationSchema.nodes ?? []) {
      const typeId = String(node.typeId ?? '').trim().toLowerCase();
      if (!typeId) continue;
      const sortOrder = Number.isFinite(Number(node.sortOrder)) ? Math.trunc(Number(node.sortOrder)) : 100;
      sortOrderByType.set(typeId, sortOrder);
    }
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        lines: prev.lines.map((line) => {
          const typeId = String(line.componentType ?? '').trim().toLowerCase();
          const nextPriority = sortOrderByType.get(typeId) ?? 100;
          return { ...line, priority: nextPriority };
        }),
      };
    });
    setStatus('Priority строк пересортирован по глобальной схеме. Нажмите «Сохранить и закрыть», чтобы применить.');
  }, [bomRelationSchema.nodes, data, props.canEdit]);

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
      const explicitHeaderNom = data.header.engineNomenclatureId && String(data.header.engineNomenclatureId).trim();
      const result = await window.matrica.warehouse.assemblyBomUpsert({
        id: data.header.id,
        name: data.header.name,
        engineBrandIds: data.header.engineBrandIds,
        ...(explicitHeaderNom ? { engineNomenclatureId: explicitHeaderNom } : {}),
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
          positionKey: line.positionKey ?? null,
          positionLabel: line.positionLabel ?? null,
          isDefaultOption: line.isDefaultOption !== false,
        })),
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return false;
      }
      const resultWithWarnings = result as unknown as { warnings?: unknown };
      const savedWarnings = Array.isArray(resultWithWarnings.warnings)
        ? resultWithWarnings.warnings.filter((w): w is string => typeof w === 'string')
        : [];
      await refresh();
      setLastSaveWarnings(savedWarnings);
      setStatus(savedWarnings.length > 0 ? 'BOM сохранен с предупреждениями (см. ниже).' : 'BOM сохранен.');
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
                  const payload = printed.payload as unknown as BomDetails | undefined;
                  const header = payload?.header ?? data.header;
                  const lines = Array.isArray(payload?.lines) ? payload.lines : data.lines;
                  const brandsForPrint = (header.engineBrandIds ?? [])
                    .map((id) => brandLabelById.get(String(id)) ?? String(id))
                    .join(', ') || '—';
                  openPrintPreview({
                    title: 'Спецификация сборки двигателя',
                    subtitle: `${String(header.name ?? 'Без названия')} • марки: ${brandsForPrint} • версия: ${String(header.version ?? 1)}`,
                    sections: [
                      {
                        id: 'summary',
                        title: 'Карточка BOM',
                        html: keyValueTable([
                          ['Название', String(header.name ?? '—')],
                          ['Марки двигателя', brandsForPrint],
                          ['Версия', String(header.version ?? 1)],
                          ['Статус', String(header.status ?? '—')],
                          ['Строк в спецификации', String(lines.length)],
                        ]),
                      },
                      ...buildBomPrintSections(lines),
                    ],
                  });
                  setStatus('');
                })();
              }
            : undefined
        }
        onSave={!showSchemaEditor ? () => void saveBom() : undefined}
        onSaveAndClose={
          !showSchemaEditor
            ? () =>
                void (async () => {
                  if (await saveBom()) props.onClose();
                })()
            : undefined
        }
        onClose={requestCloseBomCard}
        onDelete={props.canEdit && !showSchemaEditor && data ? () => setDeleteConfirmOpen(true) : undefined}
        deleteSkipBuiltInConfirm
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
          ) : null
        }
        extraActionsCenter={
          showSchemaEditor ? null : (
            <>
              <Button
                variant="ghost"
                onClick={resortBomLinesBySchema}
                disabled={!props.canEdit || !data || (data?.lines.length ?? 0) === 0}
                title="Установить priority строк по sortOrder из глобальной схемы. После клика нажмите «Сохранить и закрыть»."
              >
                Пересортировать по схеме
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
                options={withRecents('schemaRootTypeDraft', schemaNodeOptions)}
                showAllWhenEmpty
                placeholder="Выберите корневой тип"
                onChange={(value) => {
                  const next = String(value ?? 'engine');
                  setSchemaRootTypeDraft(next);
                  pushRecent('schemaRootTypeDraft', next);
                }}
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
                  <th style={{ textAlign: 'left' }} data-col-kind="name">ID типа</th>
                  <th style={{ textAlign: 'left' }} data-col-kind="name">Название</th>
                  <th style={{ textAlign: 'left' }} data-col-kind="flag" title="Активен">Активен</th>
                  <th style={{ textAlign: 'left' }} data-col-kind="num" title="Порядок">Порядок</th>
                  <th style={{ textAlign: 'left' }}>Разрешенные дочерние типы</th>
                  <th style={{ textAlign: 'left' }} data-col-kind="text">Использование в BOM-строках</th>
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
                      <td data-col-kind="name" style={{ minWidth: 150 }}>
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
                      <td data-col-kind="name" style={{ minWidth: 220 }}>
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
                      <td data-col-kind="flag">
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
                      <td data-col-kind="num" style={{ minWidth: 90 }}>
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
                      <td data-col-kind="text" style={{ minWidth: 180, fontSize: 12, color: 'var(--subtle)' }}>
                        {(() => {
                          const usage = schemaUsageByTypeId.get(String(node.typeId ?? '').trim().toLowerCase());
                          if (!usage) return 'не используется';
                          return `В работе: ${usage.activeLineCount} · Черновик: ${usage.draftLineCount} · Архив: ${usage.archivedLineCount}`;
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
                              void (async () => {
                                const usage = schemaUsageByTypeId.get(String(node.typeId ?? '').trim().toLowerCase());
                                if ((usage?.activeLineCount ?? 0) > 0) {
                                  setSchemaStatus(`Ошибка схемы: тип "${node.typeId}" используется в active BOM (${usage?.activeLineCount}) и не может быть удален.`);
                                  return;
                                }
                                if (String(node.typeId) === String(schemaRootTypeDraft)) {
                                  setSchemaStatus('Ошибка схемы: нельзя удалить корневой тип.');
                                  return;
                                }
                                const ok = await confirm({
                                  detail: `Будет удалён узел глобальной схемы BOM: «${node.label || node.typeId}» (${node.typeId}).`,
                                });
                                if (!ok) return;
                                setSchemaNodesDraft((prev) =>
                                  prev
                                    .filter((_, rowIdx) => rowIdx !== idx)
                                    .map((item) => ({
                                      ...item,
                                      childTypeIds: (item.childTypeIds ?? []).filter((childTypeId) => childTypeId !== node.typeId),
                                    })),
                                );
                                setSchemaStatus('');
                              })();
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
                    <th style={{ textAlign: 'left' }} data-col-kind="name">Старый ID типа</th>
                    <th style={{ textAlign: 'left' }} data-col-kind="name">Новый ID типа</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingSchemaRenameConfirm.renames.map((rename) => (
                    <tr key={`${rename.fromTypeId}->${rename.toTypeId}`}>
                      <td data-col-kind="name">{rename.fromTypeId}</td>
                      <td data-col-kind="name">{rename.toTypeId}</td>
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
              Будет удалена спецификация «{data.header.name}» (марки:{' '}
              {(data.header.engineBrandIds ?? []).map((id) => brandLabelById.get(id) ?? id).join(', ') || '—'}). Действие синхронизируется с
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
      {componentTypeMismatchedLines.length > 0 ? (
        <div style={{ border: '1px solid var(--warning, #b45309)', background: 'rgba(245, 158, 11, 0.08)', borderRadius: 8, padding: 8, display: 'grid', gap: 6 }}>
          <div style={{ fontWeight: 600, color: 'var(--warning, #b45309)' }}>
            Рассинхрон типа строки и типа номенклатуры ({componentTypeMismatchedLines.length})
          </div>
          <div style={{ fontSize: 12, color: 'var(--warning, #b45309)' }}>
            У этих строк тип не совпадает с «Типом компонента BOM» из карточки номенклатуры. При следующем сохранении тип строки будет приведён к типу из карточки номенклатуры (источник истины).
          </div>
          {componentTypeMismatchedLines.slice(0, 12).map((entry) => (
            <div key={`mismatch-${entry.index}-${entry.lineLabel}`} style={{ fontSize: 12, color: 'var(--warning, #b45309)' }}>
              · «{entry.lineLabel}»: текущий тип «{componentTypeLabelMap.get(entry.currentType) ?? entry.currentType}» → будет «{componentTypeLabelMap.get(entry.expectedType) ?? entry.expectedType}»
            </div>
          ))}
          {componentTypeMismatchedLines.length > 12 ? (
            <div style={{ fontSize: 12, color: 'var(--warning, #b45309)' }}>
              … и ещё {componentTypeMismatchedLines.length - 12}
            </div>
          ) : null}
        </div>
      ) : null}
      {lastSaveWarnings.length > 0 ? (
        <div style={{ border: '1px solid var(--warning, #b45309)', background: 'rgba(245, 158, 11, 0.08)', borderRadius: 8, padding: 8, display: 'grid', gap: 6 }}>
          <div style={{ fontWeight: 600, color: 'var(--warning, #b45309)' }}>
            Предупреждения сохранения ({lastSaveWarnings.length})
          </div>
          {lastSaveWarnings.slice(0, 20).map((message, idx) => (
            <div key={`save-warn-${idx}`} style={{ fontSize: 12, color: 'var(--warning, #b45309)' }}>
              · {message}
            </div>
          ))}
          {lastSaveWarnings.length > 20 ? (
            <div style={{ fontSize: 12, color: 'var(--warning, #b45309)' }}>
              … и ещё {lastSaveWarnings.length - 20}
            </div>
          ) : null}
        </div>
      ) : null}
      {!data ? null : (
        <>
          {warehouseRefsError ? <div style={{ color: 'var(--danger)', fontSize: 12 }}>Справочники склада: {warehouseRefsError}</div> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(280px, 1.2fr) minmax(110px, 160px)', gap: 10, alignItems: 'end' }}>
            <label style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Марки двигателя (можно несколько)</span>
              {props.canEdit ? (
                <MultiSearchSelect
                  values={data.header.engineBrandIds ?? []}
                  options={engineBrandOptionsForHeader}
                  placeholder="Выберите одну или несколько марок"
                  onChange={(values) => {
                    if (values.length > 0) pushRecent('engineBrandId', values[values.length - 1] ?? null);
                    setData((prev) =>
                      prev
                        ? {
                            ...prev,
                            header: {
                              ...prev.header,
                              engineBrandIds: values,
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
                  value={(data.header.engineBrandIds ?? []).map((id) => brandLabelById.get(id) ?? id).join(', ') || '—'}
                  disabled
                />
              )}
            </label>
            <label style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Наименование спецификации</span>
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
                style={{ width: '100%', minWidth: 220, maxWidth: '100%' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Версия</span>
              <Input value={String(data.header.version ?? 1)} disabled />
            </label>
          </div>

          {(() => {
            type PosCard = { posKey: string; label: string; qty: number; typeTag: string; idxs: number[]; defaultIdx: number | null };
            const positions: PosCard[] = [];
            const byKey = new Map<string, number>();
            data.lines.forEach((line, i) => {
              const key = String(line.positionKey ?? '').trim();
              if (key) {
                let pi = byKey.get(key);
                if (pi === undefined) {
                  pi = positions.length;
                  byKey.set(key, pi);
                  positions.push({ posKey: key, label: String(line.positionLabel ?? ''), qty: Number(line.qtyPerUnit ?? 0), typeTag: String(line.componentType ?? ''), idxs: [], defaultIdx: null });
                }
                const card = positions[pi]!;
                card.idxs.push(i);
                if (line.isDefaultOption !== false) {
                  if (card.defaultIdx === null) card.defaultIdx = i;
                  card.label = String(line.positionLabel ?? card.label);
                  card.qty = Number(line.qtyPerUnit ?? card.qty);
                  card.typeTag = String(line.componentType ?? card.typeTag);
                }
              } else {
                positions.push({ posKey: `solo-${i}`, label: String(line.positionLabel ?? ''), qty: Number(line.qtyPerUnit ?? 0), typeTag: String(line.componentType ?? ''), idxs: [i], defaultIdx: i });
              }
            });
            const legacyVariantCount = data.lines.filter((l) => String(l.variantGroup ?? '').trim()).length;
            return (
              <div style={{ display: 'grid', gap: 10, gridAutoRows: 'max-content', alignContent: 'start', flex: 1, minHeight: 0, overflow: 'auto' }}>
                {data.lines.length === 0 ? (
                  <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: 16, background: 'var(--surface2)', display: 'grid', gap: 8, justifyItems: 'center', textAlign: 'center' }}>
                    <div style={{ fontWeight: 600 }}>Спецификация пустая — добавьте позиции</div>
                    <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Позиция — деталь узла (например «Картер верхний»). Если к позиции подходит несколько взаимозаменяемых деталей — добавьте варианты и отметьте основной.</div>
                  </div>
                ) : null}
                {legacyVariantCount > 0 ? (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'rgba(245, 158, 11, 0.08)', fontSize: 12, color: 'var(--subtle)' }}>
                    Спецификация содержит старые «варианты сборки» ({legacyVariantCount} строк с variant-group) — показаны как отдельные позиции. При желании объедините взаимозаменяемые детали в одну позицию через «+ вариант детали».
                  </div>
                ) : null}
                {positions.map((pos) => {
                  const defaultIdx = pos.defaultIdx ?? pos.idxs[0] ?? -1;
                  const typeLabel = componentTypeLabelMap.get(String(pos.typeTag ?? '').trim().toLowerCase()) ?? pos.typeTag ?? '';
                  return (
                    <div key={pos.posKey} style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface2)', padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <Input
                          value={pos.label}
                          placeholder={typeLabel || 'Название позиции'}
                          onChange={(e) => patchPositionLines(pos.idxs, { positionLabel: e.target.value })}
                          disabled={!props.canEdit}
                          style={{ flex: 1, minWidth: 180, fontWeight: 600 }}
                        />
                        <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Кол-во/двиг.</span>
                        <Input
                          value={String(pos.qty)}
                          onChange={(e) => patchPositionLines(pos.idxs, { qtyPerUnit: Number(e.target.value || 0) })}
                          disabled={!props.canEdit}
                          style={{ width: 72 }}
                        />
                        {typeLabel ? (
                          <span style={{ background: 'var(--surface)', color: 'var(--subtle)', fontSize: 12, padding: '3px 8px', borderRadius: 8, border: '1px solid var(--border)' }} title="Тип определяется выбранной деталью">
                            {typeLabel}
                          </span>
                        ) : null}
                        {props.canEdit ? (
                          <Button
                            variant="ghost"
                            style={{ color: 'var(--danger)', padding: '2px 8px', minHeight: 0, marginLeft: 'auto' }}
                            onClick={() => {
                              void (async () => {
                                const ok = await confirm({ detail: `Будет удалена позиция «${pos.label || typeLabel || 'без имени'}» (${pos.idxs.length} вариант(ов)) из спецификации «${data?.header.name ?? ''}».` });
                                if (!ok) return;
                                removePosition(pos.idxs);
                              })();
                            }}
                            title="Удалить позицию целиком"
                          >
                            Удалить позицию
                          </Button>
                        ) : null}
                      </div>
                      <div style={{ display: 'grid', gap: 6, marginTop: 8, marginLeft: 4 }}>
                        {pos.idxs.map((i) => {
                          const line = data.lines[i]!;
                          const isDefault = i === defaultIdx;
                          const issues = lineValidation.lineIssues.get(i);
                          return (
                            <div
                              key={line.id || `opt-${i}`}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                flexWrap: 'wrap',
                                padding: '4px 6px',
                                borderRadius: 8,
                                background: issues?.errors.length ? 'rgba(239, 68, 68, 0.08)' : undefined,
                              }}
                            >
                              <input
                                type="radio"
                                name={`pos-${pos.posKey}`}
                                checked={isDefault}
                                onChange={() => setDefaultOption(pos.idxs, i)}
                                disabled={!props.canEdit}
                                title="Основной вариант — идёт в прогноз и сборку"
                              />
                              <div style={{ flex: 1, minWidth: 240 }}>
                                <GroupedSearchSelect
                                  value={line.componentNomenclatureId || null}
                                  groups={(() => {
                                    const selectedId = String(line.componentNomenclatureId ?? '').trim();
                                    if (!selectedId || componentItemById.has(selectedId)) return componentGroupedGroups;
                                    const orphanLabel = line.componentNomenclatureName || line.componentNomenclatureCode || `(удалено: ${selectedId.slice(0, 8)})`;
                                    const orphanGroup: GroupedSearchSelectGroup = {
                                      groupId: '__orphan__',
                                      groupLabel: 'Текущий выбор (не найден в справочнике)',
                                      items: [
                                        {
                                          id: selectedId,
                                          label: orphanLabel,
                                          ...(line.componentNomenclatureCode ? { hintText: line.componentNomenclatureCode } : {}),
                                          componentTypeId: line.componentType ?? null,
                                        },
                                      ],
                                    };
                                    return [orphanGroup, ...componentGroupedGroups];
                                  })()}
                                  onChange={(nextId, nextTypeId) => {
                                    pushRecent('componentNomenclatureId', nextId ?? null);
                                    patchLine(i, { componentNomenclatureId: nextId ?? '', componentType: nextTypeId ?? line.componentType ?? 'other' });
                                  }}
                                  disabled={!props.canEdit}
                                />
                              </div>
                              {isDefault ? (
                                <span style={{ background: 'rgba(16,185,129,0.12)', color: '#0f6e56', fontSize: 11, padding: '2px 7px', borderRadius: 8 }}>основной</span>
                              ) : null}
                              {props.canEdit ? (
                                <Button
                                  variant="ghost"
                                  onClick={() => {
                                    void (async () => {
                                      const nm = line.componentNomenclatureName || line.componentNomenclatureCode || 'вариант';
                                      const ok = await confirm({ detail: pos.idxs.length > 1 ? `Убрать вариант «${nm}» из позиции?` : `Убрать единственный вариант «${nm}» (позиция станет пустой)?` });
                                      if (!ok) return;
                                      removeOption(i);
                                    })();
                                  }}
                                  style={{ color: 'var(--danger)', padding: '2px 6px', minHeight: 0 }}
                                  title="Убрать этот вариант детали"
                                >
                                  ✕
                                </Button>
                              ) : null}
                            </div>
                          );
                        })}
                        {props.canEdit ? (
                          <div>
                            <Button variant="ghost" onClick={() => addOption(pos.idxs)} style={{ padding: '2px 8px', minHeight: 0 }}>
                              + вариант детали
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {props.canEdit ? (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                alignItems: 'center',
                position: 'sticky',
                bottom: 0,
                zIndex: 5,
                padding: '8px 10px',
                marginTop: 6,
                background: 'var(--surface)',
                borderTop: '1px solid var(--border)',
                boxShadow: '0 -6px 16px rgba(15, 23, 42, 0.08)',
              }}
            >
              <Button variant="ghost" onClick={() => addPosition()}>
                + Добавить позицию
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
