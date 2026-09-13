import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildGroupedNomenclatureOptions,
  DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA,
  sanitizeWarehouseBomRelationSchema,
  type WarehouseBomRelationSchema,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { GroupedSearchSelect, type GroupedSearchSelectGroup } from '../components/GroupedSearchSelect.js';
import { Input } from '../components/Input.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { useRecentSelectOptions } from '../hooks/useRecentSelectOptions.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { formatAssemblyVariantLabel } from '../utils/assemblyVariant.js';
import { BOM_COMPACT_PRINT_CSS, buildBomCompactSections, buildBomFullSections } from '../utils/bomPrint.js';
import {
  BOM_BASE_SCOPE,
  buildBomSnapshot as buildBomSnapshotShared,
  filterBomLineIdxs,
  genBomKitKey,
  groupBomLinesForCard,
  listBomScopes,
  pruneDefaultForBrands,
  toggleDefaultForBrand,
  type EngineBomDetailsForSnapshot,
} from '../utils/engineBomCardLogic.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { BRAND_LABEL_TEXTS, lookupLabel } from '../utils/lookupLabel.js';

type BomDetails = {
  header: {
    id: string;
    name: string;
    engineBrandIds: string[];
    /** Марки, для которых эта BOM — основная (подмножество `engineBrandIds`). */
    defaultForBrandIds?: string[] | null;
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
    /** Норма расхода, % (G8) — round-trip, чтобы сохранение BOM не срезало типизированные нормы. */
    normPercent?: number | null;
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
  const [savedBomSnapshot, setSavedBomSnapshot] = useState('');
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [savingBom, setSavingBom] = useState(false);
  const [deletingBom, setDeletingBom] = useState(false);
  const [lastSaveWarnings, setLastSaveWarnings] = useState<string[]>([]);
  // Вкладка комплекта (база / __kit_*), только что созданные пустые киты и поиск по строкам.
  const [activeScope, setActiveScope] = useState<string>(BOM_BASE_SCOPE);
  const [draftKits, setDraftKits] = useState<string[]>([]);
  const [lineQuery, setLineQuery] = useState('');
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
  const lineValidation = useMemo(
    () => validatePreparedLines(preparedLines, allowedChildrenByType),
    [allowedChildrenByType, preparedLines],
  );
  const brandLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of lookups.engineBrands ?? []) {
      const id = String(b.id ?? '').trim();
      if (!id) continue;
      // Идентификатор в словарь не кладём — он доезжал прямо в чип марки. Следствие,
      // названное осознанно: строки с безымянными марками попадают в один класс сортировки.
      const label = String(b.label ?? '').trim();
      if (label) map.set(id, label);
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
        normPercent: current.normPercent ?? null,
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

  // Новая позиция попадает в открытый комплект (база или вариант).
  const addPosition = useCallback(() => {
    const variantGroup = activeScope === BOM_BASE_SCOPE ? null : activeScope;
    setData((prev) =>
      prev
        ? {
            ...prev,
            lines: [
              ...prev.lines,
              { id: '', componentNomenclatureId: '', componentType: 'other', qtyPerUnit: 1, variantGroup, lineKey: null, parentLineKey: null, isRequired: true, priority: 100, positionKey: genPositionKey(), positionLabel: '', isDefaultOption: true },
            ],
          }
        : prev,
    );
  }, [activeScope, genPositionKey]);

  const addKit = useCallback(() => {
    const key = genBomKitKey();
    setDraftKits((prev) => [...prev, key]);
    setActiveScope(key);
  }, []);

  const scopes = useMemo(() => {
    const fromLines = listBomScopes(data?.lines ?? []);
    return [...fromLines, ...draftKits.filter((k) => !fromLines.includes(k))];
  }, [data?.lines, draftKits]);

  const typeSortOrder = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of bomRelationSchema.nodes ?? []) map.set(String(node.typeId).toLowerCase(), Number(node.sortOrder ?? 100));
    return map;
  }, [bomRelationSchema.nodes]);

  const visibleIdxs = useMemo(
    () => filterBomLineIdxs(data?.lines ?? [], lineQuery, (line) => `${line.componentNomenclatureName ?? ''} ${line.componentNomenclatureCode ?? ''} ${line.positionLabel ?? ''}`),
    [data?.lines, lineQuery],
  );

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
      // Схема больше не редактируется из карточки BOM (редактор удалён), но нужна как
      // словарь типов: группировка пикера компонента + метки-типы позиций.
      const schemaResult = await window.matrica.warehouse.assemblyBomSchemaGet();
      if (!alive) return;
      if (!schemaResult?.ok) {
        setStatus(`Ошибка схемы: ${String(schemaResult?.error ?? 'unknown')}`);
        return;
      }
      setBomRelationSchema(sanitizeWarehouseBomRelationSchema(schemaResult.schema));
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
        // Сервер требует подмножество engineBrandIds; посылаем всегда (в т.ч. пустой массив),
        // иначе снятую галочку не отличить от «поле не пришло» — при `undefined` сервер
        // сохраняет прежний флаг.
        defaultForBrandIds: pruneDefaultForBrands(data.header.defaultForBrandIds, data.header.engineBrandIds),
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
          normPercent: line.normPercent ?? null,
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
    if (!isBomDirty) {
      props.onClose();
      return;
    }
    setCloseConfirmOpen(true);
  }, [isBomDirty, props]);

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
        cardLabel="BOM двигателя"
        centerNoWrap
        onPrint={
          data
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
                    .map((id) => lookupLabel(id, (key) => brandLabelById.get(key), BRAND_LABEL_TEXTS))
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
                      ...buildBomFullSections(lines, componentTypeLabelMap),
                    ],
                  });
                  setStatus('');
                })();
              }
            : undefined
        }
        onSave={() => void saveBom()}
        onSaveAndClose={() =>
          void (async () => {
            if (await saveBom()) props.onClose();
          })()
        }
        onClose={requestCloseBomCard}
        onDelete={props.canEdit && data ? () => setDeleteConfirmOpen(true) : undefined}
        deleteSkipBuiltInConfirm
        deleteLabel="Удалить спецификацию"
        extraActionsCenter={
          <Button
            variant="ghost"
            tone="info"
            disabled={!data}
            title="Компактная печать: базовый комплект, только основные детали, альбомный лист"
            onClick={() => {
              if (!data) return;
              const brandsLabel = (ids: string[]) =>
                ids.map((id) => lookupLabel(id, (key) => brandLabelById.get(key), BRAND_LABEL_TEXTS)).join(', ') || BRAND_LABEL_TEXTS.absent;
              openPrintPreview({
                title: 'Спецификация двигателя — на один лист',
                subtitle: `${String(data.header.name ?? 'Без названия')} • марки: ${brandsLabel(data.header.engineBrandIds ?? [])} • версия: ${String(data.header.version ?? 1)}`,
                sections: buildBomCompactSections(
                  { header: { id: data.header.id, name: data.header.name, engineBrandIds: data.header.engineBrandIds ?? [], version: data.header.version }, lines: data.lines },
                  { brandsLabel, typeLabels: componentTypeLabelMap, typeOrder: typeSortOrder },
                ),
                extraCss: BOM_COMPACT_PRINT_CSS,
              });
            }}
          >
            На один лист
          </Button>
        }
      />

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
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
              В карточке есть несохраненные изменения. Выберите действие перед выходом.
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
                    if (await saveBom()) {
                      setCloseConfirmOpen(false);
                      props.onClose();
                    }
                  })();
                }}
                disabled={savingBom}
              >
                Сохранить и выйти
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
              {(data.header.engineBrandIds ?? [])
                .map((id) => lookupLabel(id, (key) => brandLabelById.get(key), BRAND_LABEL_TEXTS))
                .join(', ') || BRAND_LABEL_TEXTS.absent}). Действие синхронизируется с
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
      {lastSaveWarnings.length > 0 ? (
        <details style={{ border: '1px solid var(--warning, #b45309)', background: 'rgba(245, 158, 11, 0.08)', borderRadius: 8, padding: 8, display: 'grid', gap: 6 }}>
          <summary style={{ fontWeight: 600, color: 'var(--warning, #b45309)', cursor: 'pointer' }}>
            Предупреждения сохранения ({lastSaveWarnings.length}) — развернуть
          </summary>
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
        </details>
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
                              defaultForBrandIds: pruneDefaultForBrands(prev.header.defaultForBrandIds, values),
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
                  value={
                    (data.header.engineBrandIds ?? [])
                      .map((id) => lookupLabel(id, (key) => brandLabelById.get(key), BRAND_LABEL_TEXTS))
                      .join(', ') || BRAND_LABEL_TEXTS.absent
                  }
                  disabled
                />
              )}
              {(data.header.engineBrandIds ?? []).length > 0 ? (
                <div style={{ display: 'grid', gap: 2, marginTop: 2 }}>
                  <span style={{ fontSize: 11, color: 'var(--subtle)' }}>
                    Основная спецификация марки — её берут наряды сборки, когда у марки их несколько
                  </span>
                  {(data.header.engineBrandIds ?? []).map((brandId) => (
                    <label key={brandId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={(data.header.defaultForBrandIds ?? []).includes(brandId)}
                        disabled={!props.canEdit}
                        onChange={(event) => {
                          const on = event.target.checked;
                          setData((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  header: {
                                    ...prev.header,
                                    defaultForBrandIds: toggleDefaultForBrand(prev.header.defaultForBrandIds, brandId, on),
                                  },
                                }
                              : prev,
                          );
                        }}
                      />
                      <span>основная для «{lookupLabel(brandId, (key) => brandLabelById.get(key), BRAND_LABEL_TEXTS)}»</span>
                    </label>
                  ))}
                </div>
              ) : null}
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
            const cellStyle: React.CSSProperties = { padding: '3px 6px', verticalAlign: 'middle', borderBottom: '1px solid var(--border)' };
            const headStyle: React.CSSProperties = { ...cellStyle, fontSize: 12, color: 'var(--subtle)', fontWeight: 500, position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 2 };
            const sections = groupBomLinesForCard(data.lines, activeScope, typeSortOrder, getLineDisplayLabel).map((section) => ({
              ...section,
              positions: section.positions.filter((pos) => !visibleIdxs || [pos.primaryIdx, ...pos.backupIdxs].some((i) => visibleIdxs.has(i))),
            })).filter((section) => section.positions.length > 0);
            const scopeLineCount = (scope: string) => data.lines.filter((l) => (normalizeVariantGroup(l.variantGroup) ?? BOM_BASE_SCOPE) === scope).length;

            const renderPicker = (i: number) => {
              const line = data.lines[i]!;
              const selectedId = String(line.componentNomenclatureId ?? '').trim();
              const groups = !selectedId || componentItemById.has(selectedId)
                ? componentGroupedGroups
                : [
                    {
                      groupId: '__orphan__',
                      groupLabel: 'Текущий выбор (не найден в справочнике)',
                      items: [
                        {
                          id: selectedId,
                          label: line.componentNomenclatureName || line.componentNomenclatureCode || `(удалено: ${selectedId.slice(0, 8)})`,
                          ...(line.componentNomenclatureCode ? { hintText: line.componentNomenclatureCode } : {}),
                          componentTypeId: line.componentType ?? null,
                        },
                      ],
                    } satisfies GroupedSearchSelectGroup,
                    ...componentGroupedGroups,
                  ];
              return (
                <GroupedSearchSelect
                  value={selectedId || null}
                  groups={groups}
                  onChange={(nextId, nextTypeId) => {
                    pushRecent('componentNomenclatureId', nextId ?? null);
                    patchLine(i, { componentNomenclatureId: nextId ?? '', componentType: nextTypeId ?? line.componentType ?? 'other' });
                  }}
                  disabled={!props.canEdit}
                />
              );
            };

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {scopes.map((scope, i) => (
                    <Button
                      key={scope}
                      variant={scope === activeScope ? 'primary' : 'ghost'}
                      size="sm"
                      onClick={() => setActiveScope(scope)}
                      title={scope === BOM_BASE_SCOPE ? 'Строки, общие для всех комплектов' : 'Вариант комплекта: отличия от базового'}
                    >
                      {scope === BOM_BASE_SCOPE ? 'Базовый комплект' : formatAssemblyVariantLabel(scope, i - 1)}
                      <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 11 }}>{scopeLineCount(scope)}</span>
                    </Button>
                  ))}
                  {props.canEdit ? (
                    <Button variant="ghost" size="sm" onClick={addKit} title="Новый вариант комплекта (например, другая комплектация той же марки)">
                      + вариант комплекта
                    </Button>
                  ) : null}
                  <Input
                    value={lineQuery}
                    onChange={(e) => setLineQuery(e.target.value)}
                    placeholder="Поиск по названию или артикулу"
                    style={{ marginLeft: 'auto', width: 260 }}
                  />
                </div>
                {activeScope !== BOM_BASE_SCOPE ? (
                  <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
                    Строки варианта дополняют базовый комплект в прогнозе сборки; в сборочный наряд по этому варианту идут только его строки.
                  </div>
                ) : null}
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)' }}>
                  {sections.length === 0 ? (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--subtle)', fontSize: 12 }}>
                      {data.lines.length === 0
                        ? 'Спецификация пустая — добавьте позиции. Позиция — деталь узла; если подходит несколько взаимозаменяемых деталей, добавьте к ней запасные варианты.'
                        : lineQuery.trim()
                          ? 'Ничего не найдено по запросу.'
                          : 'В этом комплекте пока нет строк.'}
                    </div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ ...headStyle, width: 200 }}>Позиция</th>
                          <th style={headStyle}>Деталь</th>
                          <th style={{ ...headStyle, width: 70, textAlign: 'center' }}>Кол-во</th>
                          <th style={{ ...headStyle, width: 80, textAlign: 'center' }} title="Норма расхода, % — доля двигателей, где деталь меняется">Норма %</th>
                          <th style={{ ...headStyle, width: 220 }}>Примечание</th>
                          <th style={{ ...headStyle, width: props.canEdit ? 150 : 0 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {sections.map((section) => {
                          const typeLabel = componentTypeLabelMap.get(section.typeId) ?? section.typeId;
                          return (
                            <React.Fragment key={section.typeId}>
                              <tr>
                                <td colSpan={6} style={{ ...cellStyle, padding: '8px 6px 3px', fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--subtle)' }}>
                                  {typeLabel} <span style={{ fontWeight: 400 }}>— {section.positions.length}</span>
                                </td>
                              </tr>
                              {section.positions.map((pos) => {
                                const idxs = [pos.primaryIdx, ...pos.backupIdxs];
                                const primary = data.lines[pos.primaryIdx]!;
                                const issues = lineValidation.lineIssues.get(pos.primaryIdx);
                                return (
                                  <React.Fragment key={pos.posKey}>
                                    <tr style={issues?.errors.length ? { background: 'rgba(239, 68, 68, 0.08)' } : undefined}>
                                      <td style={cellStyle}>
                                        <Input
                                          value={String(primary.positionLabel ?? '')}
                                          placeholder={typeLabel}
                                          onChange={(e) => patchPositionLines(idxs, { positionLabel: e.target.value })}
                                          disabled={!props.canEdit}
                                          style={{ width: '100%' }}
                                          title="Название позиции в узле (например «Картер верхний»); пусто = имя детали"
                                        />
                                      </td>
                                      <td style={cellStyle}>{renderPicker(pos.primaryIdx)}</td>
                                      <td style={{ ...cellStyle, textAlign: 'center' }}>
                                        <Input
                                          value={String(Number(primary.qtyPerUnit ?? 0))}
                                          onChange={(e) => patchPositionLines(idxs, { qtyPerUnit: Number(e.target.value || 0) })}
                                          disabled={!props.canEdit}
                                          style={{ width: 56, textAlign: 'center' }}
                                        />
                                      </td>
                                      <td style={{ ...cellStyle, textAlign: 'center' }}>
                                        <Input
                                          value={primary.normPercent == null ? '' : String(primary.normPercent)}
                                          onChange={(e) => {
                                            const raw = e.target.value.replace(',', '.').trim();
                                            const n = raw === '' ? null : Number(raw);
                                            patchLine(pos.primaryIdx, { normPercent: n != null && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null });
                                          }}
                                          disabled={!props.canEdit}
                                          placeholder="—"
                                          style={{ width: 64, textAlign: 'center' }}
                                        />
                                      </td>
                                      <td style={cellStyle}>
                                        <Input
                                          value={String(primary.notes ?? '')}
                                          onChange={(e) => patchLine(pos.primaryIdx, { notes: e.target.value || null })}
                                          disabled={!props.canEdit}
                                          style={{ width: '100%' }}
                                        />
                                      </td>
                                      <td style={{ ...cellStyle, whiteSpace: 'nowrap', textAlign: 'right' }}>
                                        {props.canEdit ? (
                                          <>
                                            <Button variant="ghost" size="sm" onClick={() => addOption(idxs)} title="Добавить взаимозаменяемую деталь — запасной вариант этой позиции" style={{ padding: '2px 6px', minHeight: 0 }}>
                                              + запасной
                                            </Button>
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              style={{ color: 'var(--danger)', padding: '2px 6px', minHeight: 0 }}
                                              title="Удалить позицию со всеми вариантами"
                                              onClick={() => {
                                                void (async () => {
                                                  const ok = await confirm({ detail: `Будет удалена позиция «${primary.positionLabel || getLineDisplayLabel(primary)}»${idxs.length > 1 ? ` (${idxs.length} варианта)` : ''} из спецификации «${data.header.name}».` });
                                                  if (ok) removePosition(idxs);
                                                })();
                                              }}
                                            >
                                              ✕
                                            </Button>
                                          </>
                                        ) : null}
                                      </td>
                                    </tr>
                                    {pos.backupIdxs.map((i) => {
                                      const line = data.lines[i]!;
                                      const backupIssues = lineValidation.lineIssues.get(i);
                                      return (
                                        <tr key={line.id || `backup-${i}`} style={{ background: backupIssues?.errors.length ? 'rgba(239, 68, 68, 0.08)' : 'rgba(148, 163, 184, 0.08)' }}>
                                          <td style={{ ...cellStyle, paddingLeft: 24, fontSize: 12, color: 'var(--subtle)', whiteSpace: 'nowrap' }}>
                                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: props.canEdit ? 'pointer' : 'default' }} title="Сделать основным — именно основной вариант идёт в прогноз и наряд">
                                              <input type="radio" name={`pos-${pos.posKey}`} checked={false} onChange={() => setDefaultOption(idxs, i)} disabled={!props.canEdit} />
                                              запасной
                                            </label>
                                          </td>
                                          <td style={cellStyle}>{renderPicker(i)}</td>
                                          <td style={{ ...cellStyle, textAlign: 'center', color: 'var(--subtle)', fontSize: 12 }}>{Number(line.qtyPerUnit ?? 0)}</td>
                                          <td style={cellStyle} />
                                          <td style={cellStyle} />
                                          <td style={{ ...cellStyle, textAlign: 'right' }}>
                                            {props.canEdit ? (
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                style={{ color: 'var(--danger)', padding: '2px 6px', minHeight: 0 }}
                                                title="Убрать этот запасной вариант"
                                                onClick={() => {
                                                  void (async () => {
                                                    const ok = await confirm({ detail: `Убрать запасной вариант «${getLineDisplayLabel(line)}» из позиции?` });
                                                    if (ok) removeOption(i);
                                                  })();
                                                }}
                                              >
                                                ✕
                                              </Button>
                                            ) : null}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </React.Fragment>
                                );
                              })}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                <details style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', fontSize: 12 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--subtle)' }}>
                    Расширенно: дерево узлов, порядок по схеме, служебные предупреждения
                  </summary>
                  <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={resortBomLinesBySchema}
                        disabled={!props.canEdit || data.lines.length === 0}
                        title="Установить priority строк по sortOrder схемы типов (порядок внутри раздела)."
                      >
                        Пересортировать по схеме
                      </Button>
                      <span style={{ color: 'var(--subtle)' }}>Тип детали задаётся в её карточке номенклатуры; разделы здесь — по нему.</span>
                    </div>
                    {componentTypeMismatchedLines.length > 0 ? (
                      <div style={{ color: 'var(--warning, #b45309)' }}>
                        <div style={{ fontWeight: 600 }}>Тип строки не совпадает с карточкой детали ({componentTypeMismatchedLines.length}) — при сохранении будет приведён к карточке:</div>
                        {componentTypeMismatchedLines.slice(0, 12).map((entry) => (
                          <div key={`mismatch-${entry.index}-${entry.lineLabel}`}>
                            · «{entry.lineLabel}»: «{componentTypeLabelMap.get(entry.currentType) ?? entry.currentType}» → «{componentTypeLabelMap.get(entry.expectedType) ?? entry.expectedType}»
                          </div>
                        ))}
                        {componentTypeMismatchedLines.length > 12 ? <div>… и ещё {componentTypeMismatchedLines.length - 12}</div> : null}
                      </div>
                    ) : null}
                    {lineValidation.warnings.length > 0 ? (
                      <div style={{ color: 'var(--warning, #b45309)' }}>
                        {lineValidation.warnings.map((message) => (
                          <div key={message}>- {message}</div>
                        ))}
                      </div>
                    ) : null}
                    <div>
                      <div style={{ color: 'var(--subtle)', marginBottom: 4 }}>
                        Дерево узлов комплекта «{activeScope === BOM_BASE_SCOPE ? 'Базовый' : formatAssemblyVariantLabel(activeScope, Math.max(0, scopes.indexOf(activeScope) - 1))}»: ключ узла и «входит в» (ключ родителя). Прогноз отбрасывает строки с несуществующим родителем.
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            <th style={{ ...headStyle, position: 'static' }}>Деталь</th>
                            <th style={{ ...headStyle, position: 'static', width: 200 }}>Ключ узла</th>
                            <th style={{ ...headStyle, position: 'static', width: 200 }}>Входит в</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.lines.map((line, i) => {
                            if ((normalizeVariantGroup(line.variantGroup) ?? BOM_BASE_SCOPE) !== activeScope) return null;
                            if (visibleIdxs && !visibleIdxs.has(i)) return null;
                            return (
                              <tr key={line.id || `tree-${i}`}>
                                <td style={cellStyle}>{getLineDisplayLabel(line)}{line.isDefaultOption === false ? <span style={{ color: 'var(--subtle)' }}> (запасной)</span> : null}</td>
                                <td style={cellStyle}>
                                  <Input value={String(line.lineKey ?? '')} onChange={(e) => patchLine(i, { lineKey: e.target.value || null })} disabled={!props.canEdit} style={{ width: '100%' }} />
                                </td>
                                <td style={cellStyle}>
                                  <Input value={String(line.parentLineKey ?? '')} onChange={(e) => patchLine(i, { parentLineKey: e.target.value || null })} disabled={!props.canEdit} style={{ width: '100%' }} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </details>
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
    </div>
  );
}
