import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { NomenclatureItemType, WarehouseNomenclatureListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { NomenclaturePropertyEditModal, type NomenclaturePropertyEditRow } from '../components/NomenclaturePropertyEditModal.js';
import {
  NomenclatureTemplateCompositionEditor,
  type NomenclatureTemplateCompositionEditorTemplate,
} from '../components/NomenclatureTemplateCompositionEditor.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { LabelPrintDialog } from '../components/LabelPrintDialog.js';
import type { LabelTarget } from '../utils/qrLabels.js';
import { useRegisterSearchScope } from '../context/globalSearchScope.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { createNomenclatureLineFromPreset } from '../utils/createWarehouseNomenclatureFromDirectory.js';
import { fetchWarehouseNomenclatureAllPages } from '../utils/warehousePagedFetch.js';
import {
  ALL_NOMENCLATURE_CREATE_PRESETS,
  type NomenclatureDirectoryPreset,
} from './nomenclatureDirectoryPresets.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';
import { parseTemplatePropertiesJson } from '../utils/nomenclatureTemplateProperties.js';
import { lookupToSelectOptions, WAREHOUSE_ITEM_TYPE_OPTIONS } from '../utils/warehouseUi.js';

function NomenclatureCollapsePanel(props: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  bodyStyle?: React.CSSProperties;
  rootStyle?: React.CSSProperties;
}) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', ...props.rootStyle }}>
      <button
        type="button"
        onClick={props.onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '10px 12px',
          border: 'none',
          background: 'var(--surface-2)',
          color: 'inherit',
          fontWeight: 700,
          fontSize: 13,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span>{props.title}</span>
        <span style={{ flexShrink: 0, opacity: 0.85 }}>{props.open ? '▾' : '▸'}</span>
      </button>
      {props.open ? (
        <div
          style={{
            padding: 8,
            borderTop: '1px solid var(--border)',
            ...props.bodyStyle,
          }}
        >
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

type SortKey = 'name' | 'code' | 'itemType' | 'group' | 'unit' | 'updatedAt';

type PropertyGovernanceRow = {
  id: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  optionsJson: string;
  description: string;
};

export function NomenclaturePage(props: {
  onOpen: (id: string) => void;
  canEdit: boolean;
}) {
  const GROUP_HEADER_HEIGHT = 38;
  const { lookups, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData();
  const [rows, setRows] = useState<WarehouseNomenclatureListItem[]>([]);
  useRegisterSearchScope(
    useMemo(
      () => ({
        kind: 'nomenclature' as const,
        title: 'Номенклатура',
        rows,
        getId: (r: unknown) => String((r as WarehouseNomenclatureListItem).id ?? ''),
        getLabel: (r: unknown) => {
          const n = r as WarehouseNomenclatureListItem;
          return String(n.name ?? '') || String(n.code ?? '') || String(n.id ?? '');
        },
      }),
      [rows],
    ),
  );
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [itemType, setItemType] = useState<NomenclatureItemType | ''>('');
  const [directoryKind, setDirectoryKind] = useState<string>('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [creatingKind, setCreatingKind] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [newTypeCode, setNewTypeCode] = useState('');
  const [newTypeName, setNewTypeName] = useState('');
  const [propertiesRows, setPropertiesRows] = useState<PropertyGovernanceRow[]>([]);
  const [templatesRows, setTemplatesRows] = useState<
    Array<{ id: string; code: string; name: string; itemTypeCode: string; directoryKind: string; propertiesJson: string }>
  >([]);
  const [propertyEdit, setPropertyEdit] = useState<NomenclaturePropertyEditRow | null>(null);
  const [templateEdit, setTemplateEdit] = useState<NomenclatureTemplateCompositionEditorTemplate | null>(null);
  const [newPropertyCode, setNewPropertyCode] = useState('');
  const [newPropertyName, setNewPropertyName] = useState('');
  const [newPropertyType, setNewPropertyType] = useState('text');
  const [newTemplateCode, setNewTemplateCode] = useState('');
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateItemType, setNewTemplateItemType] = useState('');
  const [newTemplateDirectoryKind, setNewTemplateDirectoryKind] = useState('');
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);
  const [groupCounts, setGroupCounts] = useState<Array<{ groupId: string | null; groupName: string; count: number }>>([]);
  const [panelTypesOpen, setPanelTypesOpen] = useState(false);
  const [panelPropertiesOpen, setPanelPropertiesOpen] = useState(false);
  const [panelTemplatesOpen, setPanelTemplatesOpen] = useState(false);
  const [panelListOpen, setPanelListOpen] = useState(true);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [labelTargets, setLabelTargets] = useState<LabelTarget[]>([]);
  const [labelLoading, setLabelLoading] = useState(false);

  // Печать этикеток: тянем весь каталог (по текущим фильтрам, без привязки к
  // развёрнутой группе — строки `rows` пусты, пока группа не развёрнута), затем
  // открываем диалог. Выбор конкретных позиций — уже внутри диалога.
  const openLabelDialog = useCallback(async () => {
    setLabelLoading(true);
    try {
      const all = await fetchWarehouseNomenclatureAllPages({
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(itemType ? { itemType } : {}),
        ...(directoryKind ? { directoryKind } : {}),
        ...(groupId ? { groupId } : {}),
      });
      setLabelTargets(
        all.map((r) => ({
          id: r.id,
          code: r.code ?? '',
          name: r.name,
          subtitle: [r.groupName, r.unitName].filter(Boolean).join(' · ') || null,
        })),
      );
      setLabelDialogOpen(true);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setLabelLoading(false);
    }
  }, [query, itemType, directoryKind, groupId]);

  const refreshGroupCounts = useCallback(async () => {
    const result = await window.matrica.warehouse.nomenclatureGroupCounts({
      ...(query.trim() ? { search: query.trim() } : {}),
      ...(itemType ? { itemType } : {}),
      ...(directoryKind ? { directoryKind } : {}),
    });
    if (result?.ok) {
      setGroupCounts(
        [...result.rows].sort((a, b) => {
          if (!a.groupId && b.groupId) return 1;
          if (a.groupId && !b.groupId) return -1;
          return a.groupName.localeCompare(b.groupName, 'ru');
        }),
      );
    }
  }, [directoryKind, itemType, query]);

  const refresh = useCallback(async () => {
    // Строки показываются только внутри развёрнутой группы — пока ничего не
    // развёрнуто, грузить нечего (и не тянем весь каталог зря).
    if (expandedGroupKey == null) {
      setRows([]);
      setStatus('');
      return;
    }
    try {
      setStatus('Загрузка...');
      // Грузим ВСЕ позиции группы (а не одну страницу) — тогда клиентская
      // сортировка идёт по полному набору, а не по видимой странице.
      const all = await fetchWarehouseNomenclatureAllPages({
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(itemType ? { itemType } : {}),
        ...(directoryKind ? { directoryKind } : {}),
        ...(groupId ? { groupId } : {}),
      });
      setRows(all);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [directoryKind, expandedGroupKey, groupId, itemType, query]);

  const refreshGovernance = useCallback(async () => {
    if (!props.canEdit) return;
    const [propertiesRes, templatesRes] = await Promise.all([
      window.matrica.warehouse.nomenclaturePropertiesList(),
      window.matrica.warehouse.nomenclatureTemplatesList(),
    ]);
    if (propertiesRes?.ok) {
      setPropertiesRows(
        ((propertiesRes.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id ?? ''),
          code: String(row.code ?? ''),
          name: String(row.name ?? ''),
          dataType: String(row.dataType ?? 'text'),
          isRequired: Boolean(row.isRequired),
          optionsJson: String(row.optionsJson ?? ''),
          description: String(row.description ?? ''),
        })),
      );
    }
    if (templatesRes?.ok) {
      setTemplatesRows(
        ((templatesRes.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id ?? ''),
          code: String(row.code ?? ''),
          name: String(row.name ?? ''),
          itemTypeCode: String(row.itemTypeCode ?? ''),
          directoryKind: String(row.directoryKind ?? ''),
          propertiesJson: String(row.propertiesJson ?? '[]'),
        })),
      );
    }
  }, [props.canEdit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void refreshGroupCounts();
  }, [refreshGroupCounts]);
  useEffect(() => {
    void refreshGovernance();
  }, [refreshGovernance]);

  const sorted = useMemo(() => {
    if (expandedGroupKey == null) return [];
    // Оставляем только позиции развёрнутой группы. Бэкенд фильтрует по groupId
    // лишь для реальной группы; «Без группы» (__none__) приходит как весь набор,
    // поэтому здесь надёжно отбираем по row.groupId на клиенте.
    const targetGroupId = expandedGroupKey === '__none__' ? null : expandedGroupKey;
    const dir = sortDir === 'asc' ? 1 : -1;
    return rows
      .filter((r) => (r.groupId ?? null) === targetGroupId)
      .sort((a, b) => {
        let cmp = 0;
        if (sortKey === 'name') cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
        else if (sortKey === 'code') cmp = String(a.code ?? '').localeCompare(String(b.code ?? ''), 'ru');
        else if (sortKey === 'itemType') cmp = String(a.itemType ?? '').localeCompare(String(b.itemType ?? ''), 'ru');
        else if (sortKey === 'group') cmp = String(a.groupName ?? '').localeCompare(String(b.groupName ?? ''), 'ru');
        else if (sortKey === 'unit') cmp = String(a.unitName ?? '').localeCompare(String(b.unitName ?? ''), 'ru');
        else if (sortKey === 'updatedAt') cmp = Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0);
        if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
        return cmp * dir;
      });
  }, [rows, expandedGroupKey, sortDir, sortKey]);

  useEffect(() => {
    if (groupCounts.length === 0) {
      setExpandedGroupKey(null);
      return;
    }
    if (expandedGroupKey == null) return;
    const stillExists = groupCounts.some((g) => (g.groupId ?? '__none__') === expandedGroupKey);
    if (!stillExists) {
      setExpandedGroupKey(null);
      setGroupId(null);
    }
  }, [expandedGroupKey, groupCounts]);

  function onSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(nextKey);
    setSortDir('asc');
  }

  function sortLabel(label: string, key: SortKey) {
    if (sortKey !== key) return label;
    return `${label} ${sortDir === 'asc' ? '↑' : '↓'}`;
  }

  const itemTypeOptions = useMemo(() => {
    const dynamic = (lookups.nomenclatureItemTypes ?? [])
      .map((row) => ({ id: String(row.code ?? '').trim(), label: String(row.label ?? '').trim() }))
      .filter((row) => row.id && row.label);
    if (dynamic.length === 0) return WAREHOUSE_ITEM_TYPE_OPTIONS;
    return [{ id: '', label: 'Все типы' }, ...dynamic];
  }, [lookups.nomenclatureItemTypes]);

  function itemTypeLabel(itemTypeValue: string | null | undefined): string {
    return itemTypeOptions.find((item) => item.id === itemTypeValue)?.label ?? String(itemTypeValue ?? '—');
  }

  const runCreateWithPreset = useCallback(
    async (preset: NomenclatureDirectoryPreset) => {
      setCreatingKind(preset.directoryKind);
      setStatus(`Создание новой позиции (${preset.createConfig.name})...`);
      try {
        const result = await createNomenclatureLineFromPreset({
          directoryKind: preset.directoryKind,
          createConfig: preset.createConfig,
          displayName: preset.createConfig.name,
        });
        if (!result.ok) {
          if ('duplicateNomenclatureId' in result) {
            await refresh();
            await props.onOpen(result.duplicateNomenclatureId);
            setStatus(`Позиция уже существовала, открыта существующая карточка (${result.duplicateNomenclatureId.slice(0, 8)}...).`);
            return;
          }
          setStatus(`Ошибка: ${result.error}`);
          return;
        }
        await refresh();
        setStatus('');
        setCreateDialogOpen(false);
        props.onOpen(result.nomenclatureId);
      } finally {
        setCreatingKind(null);
      }
    },
    [props.onOpen],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      {props.canEdit ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
          <NomenclatureCollapsePanel
            title="Типы номенклатуры"
            open={panelTypesOpen}
            onToggle={() => setPanelTypesOpen((v) => !v)}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr auto', gap: 8 }}>
              <Input value={newTypeCode} onChange={(e) => setNewTypeCode(e.target.value)} placeholder="Код типа" />
              <Input value={newTypeName} onChange={(e) => setNewTypeName(e.target.value)} placeholder="Название типа" />
              <Button
                type="button"
                onClick={async () => {
                  const codeValue = newTypeCode.trim().toLowerCase();
                  const nameValue = newTypeName.trim();
                  if (!codeValue || !nameValue) {
                    setStatus('Укажите код и название типа.');
                    return;
                  }
                  const up = await window.matrica.warehouse.nomenclatureItemTypeUpsert({ code: codeValue, name: nameValue });
                  if (!up?.ok) {
                    setStatus(`Ошибка: ${String(up?.error ?? 'не удалось сохранить тип')}`);
                    return;
                  }
                  setNewTypeCode('');
                  setNewTypeName('');
                  await refreshRefs();
                  await refreshGovernance();
                }}
              >
                Добавить тип
              </Button>
            </div>
          </NomenclatureCollapsePanel>

          <NomenclatureCollapsePanel
            title="Свойства номенклатуры"
            open={panelPropertiesOpen}
            onToggle={() => setPanelPropertiesOpen((v) => !v)}
          >
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 120px auto', gap: 8 }}>
                <Input value={newPropertyCode} onChange={(e) => setNewPropertyCode(e.target.value)} placeholder="Код" />
                <Input value={newPropertyName} onChange={(e) => setNewPropertyName(e.target.value)} placeholder="Название" />
                <select value={newPropertyType} onChange={(e) => setNewPropertyType(e.target.value)} style={{ padding: '8px 10px' }}>
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="date">date</option>
                  <option value="enum">enum</option>
                  <option value="json">json</option>
                </select>
                <Button
                  type="button"
                  onClick={async () => {
                    const up = await window.matrica.warehouse.nomenclaturePropertyUpsert({
                      code: newPropertyCode.trim().toLowerCase(),
                      name: newPropertyName.trim(),
                      dataType: newPropertyType,
                    });
                    if (!up?.ok) {
                      setStatus(`Ошибка: ${String(up?.error ?? 'не удалось сохранить свойство')}`);
                      return;
                    }
                    setNewPropertyCode('');
                    setNewPropertyName('');
                    await refreshGovernance();
                  }}
                >
                  Добавить свойство
                </Button>
              </div>
              <div style={{ overflow: 'auto', maxHeight: 220, border: '1px solid var(--border)', borderRadius: 8 }}>
                <table className="list-table">
                  <thead>
                    <tr>
                      <th data-col-kind="name">Код</th>
                      <th data-col-kind="name">Наименование</th>
                      <th>Тип</th>
                      <th style={{ width: 110 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {propertiesRows.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ color: 'var(--subtle)', padding: 10, textAlign: 'center' }}>
                          Нет свойств
                        </td>
                      </tr>
                    ) : (
                      propertiesRows.map((row) => (
                        <tr key={row.id}>
                          <td data-col-kind="name">{row.code}</td>
                          <td data-col-kind="name">{row.name}</td>
                          <td>{row.dataType}</td>
                          <td>
                            <Button type="button" variant="ghost" size="sm" onClick={() => setPropertyEdit({ ...row })}>
                              Изменить
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </NomenclatureCollapsePanel>

          <NomenclatureCollapsePanel
            title="Шаблоны номенклатуры"
            open={panelTemplatesOpen}
            onToggle={() => setPanelTemplatesOpen((v) => !v)}
          >
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 140px 140px auto', gap: 8 }}>
                <Input value={newTemplateCode} onChange={(e) => setNewTemplateCode(e.target.value)} placeholder="Код" />
                <Input value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} placeholder="Название" />
                <Input value={newTemplateItemType} onChange={(e) => setNewTemplateItemType(e.target.value)} placeholder="Код типа" />
                <Input value={newTemplateDirectoryKind} onChange={(e) => setNewTemplateDirectoryKind(e.target.value)} placeholder="Источник" />
                <Button
                  type="button"
                  onClick={async () => {
                    const up = await window.matrica.warehouse.nomenclatureTemplateUpsert({
                      code: newTemplateCode.trim().toLowerCase(),
                      name: newTemplateName.trim(),
                      itemTypeCode: newTemplateItemType.trim() || null,
                      directoryKind: newTemplateDirectoryKind.trim() || null,
                      propertiesJson: '[]',
                    });
                    if (!up?.ok) {
                      setStatus(`Ошибка: ${String(up?.error ?? 'не удалось сохранить шаблон')}`);
                      return;
                    }
                    setNewTemplateCode('');
                    setNewTemplateName('');
                    setNewTemplateItemType('');
                    setNewTemplateDirectoryKind('');
                    await refreshGovernance();
                  }}
                >
                  Добавить шаблон
                </Button>
              </div>
              <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
                Состав шаблона (список свойств) настраивается кнопкой «Состав» — без ручного JSON.
              </div>
              <div style={{ overflow: 'auto', maxHeight: 240, border: '1px solid var(--border)', borderRadius: 8 }}>
                <table className="list-table">
                  <thead>
                    <tr>
                      <th data-col-kind="name">Код</th>
                      <th data-col-kind="name">Название</th>
                      <th>Тип / источник</th>
                      <th data-col-kind="num" title="Свойств">Свойств</th>
                      <th style={{ width: 120 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {templatesRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ color: 'var(--subtle)', padding: 10, textAlign: 'center' }}>
                          Нет шаблонов
                        </td>
                      </tr>
                    ) : (
                      templatesRows.map((row) => (
                        <tr key={row.id}>
                          <td data-col-kind="name">{row.code}</td>
                          <td data-col-kind="name">{row.name}</td>
                          <td>
                            {row.itemTypeCode || '—'} / {row.directoryKind || '—'}
                          </td>
                          <td data-col-kind="num">{parseTemplatePropertiesJson(row.propertiesJson).length}</td>
                          <td>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setTemplateEdit({
                                  id: row.id,
                                  code: row.code,
                                  name: row.name,
                                  itemTypeCode: row.itemTypeCode,
                                  directoryKind: row.directoryKind,
                                  propertiesJson: row.propertiesJson,
                                })
                              }
                            >
                              Состав
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </NomenclatureCollapsePanel>
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <NomenclatureCollapsePanel
          title="Список номенклатуры"
          open={panelListOpen}
          onToggle={() => setPanelListOpen((v) => !v)}
          rootStyle={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0, padding: 8, overflow: 'hidden' }}>
            <div
              style={{
                display: 'grid',
                gap: 8,
                alignItems: 'center',
                gridTemplateColumns: 'auto minmax(240px, 1fr) minmax(190px, 0.7fr) minmax(190px, 0.8fr) minmax(200px, 0.8fr) auto auto auto',
                flexShrink: 0,
              }}
            >
              {props.canEdit ? (
                <Button
                  onClick={() => {
                    const kind = directoryKind ? String(directoryKind).trim().toLowerCase() : '';
                    const preset = ALL_NOMENCLATURE_CREATE_PRESETS.find((p) => p.directoryKind === kind);
                    if (preset) {
                      void runCreateWithPreset(preset);
                      return;
                    }
                    setCreateDialogOpen(true);
                  }}
                >
                  Добавить позицию
                </Button>
              ) : null}
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по наименованию, коду, штрихкоду…" />
              <select value={itemType} onChange={(e) => setItemType((e.target.value || '') as NomenclatureItemType | '')} style={{ minWidth: 180, padding: '8px 10px' }}>
                {itemTypeOptions.map((item) => (
                  <option key={item.id || 'all'} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <select value={directoryKind} onChange={(e) => setDirectoryKind(e.target.value)} style={{ minWidth: 180, padding: '8px 10px' }}>
                <option value="">Все источники</option>
                <option value="engine_brand">Марки двигателя</option>
                <option value="part">Детали</option>
                <option value="tool">Инструменты</option>
                <option value="good">Товары</option>
                <option value="service">Услуги</option>
              </select>
              <SearchSelect
                value={groupId}
                options={lookupToSelectOptions(lookups.nomenclatureGroups)}
                placeholder="Группа номенклатуры"
                onChange={setGroupId}
              />
              <Button variant="ghost" onClick={() => void refresh()}>
                Обновить
              </Button>
              <Button variant="ghost" onClick={() => void refreshRefs()}>
                Справочники
              </Button>
              <Button variant="ghost" onClick={() => void openLabelDialog()} disabled={labelLoading}>
                {labelLoading ? 'Загрузка…' : 'Печать этикеток'}
              </Button>
            </div>

            {refsError ? <div style={{ color: 'var(--danger)', flexShrink: 0 }}>Справочники склада: {refsError}</div> : null}
            {status ? (
              <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', flexShrink: 0 }}>{status}</div>
            ) : null}

            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 8 }}>
              {groupCounts.length === 0 && sorted.length === 0 ? (
                <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 14 }}>Нет данных</div>
              ) : (
                groupCounts.map((group) => {
                  const expanded = expandedGroupKey === (group.groupId ?? '__none__');
                  const pageRowsForGroup = expanded ? sorted : [];
                  return (
                    <section key={group.groupId ?? '__none__'} style={{ width: '100%', borderBottom: '1px solid var(--border)' }}>
                      <button
                        type="button"
                        onClick={() => {
                          const key = group.groupId ?? '__none__';
                          if (expandedGroupKey === key) {
                            setExpandedGroupKey(null);
                            setGroupId(null);
                          } else {
                            setExpandedGroupKey(key);
                            setGroupId(group.groupId ?? null);
                          }
                        }}
                        style={{
                          width: '100%',
                          height: GROUP_HEADER_HEIGHT,
                          display: 'grid',
                          gridTemplateColumns: '1fr auto',
                          alignItems: 'center',
                          columnGap: 10,
                          position: 'sticky',
                          top: 0,
                          zIndex: 3,
                          border: 'none',
                          borderBottom: '1px solid var(--border)',
                          background: expanded ? '#1d4ed8' : '#dcfce7',
                          color: expanded ? '#ffffff' : '#14532d',
                          fontWeight: 700,
                          fontSize: 13,
                          textAlign: 'left',
                          cursor: 'pointer',
                          padding: '0 10px',
                          boxSizing: 'border-box',
                        }}
                      >
                        <span
                          style={{
                            minWidth: 0,
                            justifySelf: 'stretch',
                            textAlign: 'left',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {group.groupName}
                        </span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: expanded ? '#dbeafe' : '#166534', flexShrink: 0 }}>
                          <span>{group.count}</span>
                          <span style={{ fontSize: 14 }}>{expanded ? '▾' : '▸'}</span>
                        </span>
                      </button>
                      {expanded ? (
                        <table className="list-table">
                          <thead>
                            <tr>
                              <th
                                data-col-kind="name"
                                style={{ textAlign: 'left', cursor: 'pointer', minWidth: 220, top: GROUP_HEADER_HEIGHT }}
                                onClick={() => onSort('name')}
                              >
                                {sortLabel('Наименование', 'name')}
                              </th>
                              <th
                                data-col-kind="name"
                                style={{ textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap', top: GROUP_HEADER_HEIGHT }}
                                onClick={() => onSort('code')}
                                title="Артикул / код / сборочный номер"
                              >
                                {sortLabel('Артикул', 'code')}
                              </th>
                              <th
                                style={{ textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap', top: GROUP_HEADER_HEIGHT }}
                                onClick={() => onSort('itemType')}
                              >
                                {sortLabel('Тип', 'itemType')}
                              </th>
                              <th
                                style={{ textAlign: 'left', cursor: 'pointer', minWidth: 140, top: GROUP_HEADER_HEIGHT }}
                                onClick={() => onSort('group')}
                              >
                                {sortLabel('Группа', 'group')}
                              </th>
                              <th
                                style={{ textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap', top: GROUP_HEADER_HEIGHT }}
                                onClick={() => onSort('unit')}
                              >
                                {sortLabel('Ед.', 'unit')}
                              </th>
                              <th
                                data-col-kind="date"
                                style={{ textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap', top: GROUP_HEADER_HEIGHT }}
                                onClick={() => onSort('updatedAt')}
                              >
                                {sortLabel('Дата изменения', 'updatedAt')}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {pageRowsForGroup.map((row) => (
                              <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(String(row.id))}>
                                <td data-col-kind="name" style={{ wordBreak: 'break-word' }}>{row.name || '—'}</td>
                                <td data-col-kind="name" style={{ color: 'var(--subtle)', whiteSpace: 'nowrap' }}>{row.code || '—'}</td>
                                <td>{itemTypeLabel(row.itemType)}</td>
                                <td>{row.groupName || '—'}</td>
                                <td>{row.unitName || '—'}</td>
                                <td data-col-kind="date" style={{ whiteSpace: 'nowrap' }}>{row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : null}
                    </section>
                  );
                })
              )}
            </div>
          </div>
        </NomenclatureCollapsePanel>
      </div>

      <NomenclaturePropertyEditModal
        open={propertyEdit != null}
        row={propertyEdit}
        onClose={() => setPropertyEdit(null)}
        onSaved={() => void refreshGovernance()}
      />
      <NomenclatureTemplateCompositionEditor
        open={templateEdit != null}
        template={templateEdit}
        propertyOptions={propertiesRows}
        onClose={() => setTemplateEdit(null)}
        onSaved={() => void refreshGovernance()}
      />
      {createDialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => !creatingKind && setCreateDialogOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface)',
              color: 'inherit',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 16,
              minWidth: 420,
              maxWidth: 'min(640px, 96vw)',
              maxHeight: '85vh',
              overflow: 'auto',
              boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 16 }}>Какую позицию создать?</div>
            <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
              Выберите тип. Код и название можно изменить позже. Откроется карточка номенклатуры.
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {ALL_NOMENCLATURE_CREATE_PRESETS.map((preset) => (
                <button
                  key={preset.directoryKind}
                  type="button"
                  disabled={!!creatingKind}
                  onClick={() => void runCreateWithPreset(preset)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '10px 12px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: creatingKind === preset.directoryKind ? 'var(--surface-2)' : 'var(--surface)',
                    color: 'inherit',
                    cursor: creatingKind ? 'wait' : 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{preset.createButtonText.replace(/^(Добавить|Создать)\s+/i, '')}</div>
                    <div style={{ fontSize: 12, color: 'var(--subtle)' }}>тип: {preset.createConfig.itemType}</div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
                    {creatingKind === preset.directoryKind ? 'Создаём...' : '→'}
                  </div>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="ghost" disabled={!!creatingKind} onClick={() => setCreateDialogOpen(false)}>
                Отмена
              </Button>
            </div>
          </div>
        </div>
      )}

      <LabelPrintDialog
        open={labelDialogOpen}
        title="Печать QR-этикеток номенклатуры"
        targets={labelTargets}
        onClose={() => setLabelDialogOpen(false)}
      />
    </div>
  );
}
