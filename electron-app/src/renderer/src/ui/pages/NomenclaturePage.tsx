import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { NomenclatureItemType, WarehouseNomenclatureListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { lookupToSelectOptions, WAREHOUSE_ITEM_TYPE_OPTIONS } from '../utils/warehouseUi.js';

type SortKey = 'name' | 'itemType' | 'group' | 'unit';

export function NomenclaturePage(props: {
  onOpen: (id: string) => void;
  canEdit: boolean;
}) {
  const GROUP_HEADER_HEIGHT = 38;
  const { lookups, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData();
  const [rows, setRows] = useState<WarehouseNomenclatureListItem[]>([]);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [itemType, setItemType] = useState<NomenclatureItemType | ''>('');
  const [directoryKind, setDirectoryKind] = useState<string>('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [newTypeCode, setNewTypeCode] = useState('');
  const [newTypeName, setNewTypeName] = useState('');
  const [propertiesRows, setPropertiesRows] = useState<Array<{ id: string; code: string; name: string; dataType: string }>>([]);
  const [templatesRows, setTemplatesRows] = useState<Array<{ id: string; code: string; name: string; itemTypeCode: string; directoryKind: string; propertiesJson: string }>>([]);
  const [newPropertyCode, setNewPropertyCode] = useState('');
  const [newPropertyName, setNewPropertyName] = useState('');
  const [newPropertyType, setNewPropertyType] = useState('text');
  const [newTemplateCode, setNewTemplateCode] = useState('');
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateItemType, setNewTemplateItemType] = useState('');
  const [newTemplateDirectoryKind, setNewTemplateDirectoryKind] = useState('');
  const [newTemplatePropertiesJson, setNewTemplatePropertiesJson] = useState('[]');
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);

  useEffect(() => {
    setPageIndex(0);
  }, [directoryKind, groupId, itemType, query]);

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка...');
      const result = await window.matrica.warehouse.nomenclatureList({
        limit: pageSize,
        offset: pageIndex * pageSize,
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(itemType ? { itemType } : {}),
        ...(directoryKind ? { directoryKind } : {}),
        ...(groupId ? { groupId } : {}),
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setRows((result.rows ?? []) as WarehouseNomenclatureListItem[]);
      setHasMore(Boolean(result.hasMore));
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [directoryKind, groupId, itemType, pageIndex, pageSize, query]);

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
    void refreshGovernance();
  }, [refreshGovernance]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      else if (sortKey === 'itemType') cmp = String(a.itemType ?? '').localeCompare(String(b.itemType ?? ''), 'ru');
      else if (sortKey === 'group') cmp = String(a.groupName ?? '').localeCompare(String(b.groupName ?? ''), 'ru');
      else if (sortKey === 'unit') cmp = String(a.unitName ?? '').localeCompare(String(b.unitName ?? ''), 'ru');
      if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      return cmp * dir;
    });
  }, [rows, sortDir, sortKey]);

  const groupedRows = useMemo(() => {
    const map = new Map<string, { key: string; label: string; rows: WarehouseNomenclatureListItem[] }>();
    for (const row of sorted) {
      const groupLabel = String(row.groupName ?? '').trim() || 'Без группы';
      const key = groupLabel.toLowerCase();
      if (!map.has(key)) {
        map.set(key, { key, label: groupLabel, rows: [] });
      }
      map.get(key)?.rows.push(row);
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [sorted]);

  useEffect(() => {
    if (groupedRows.length === 0) {
      setExpandedGroupKey(null);
      return;
    }
    const stillExists = expandedGroupKey != null && groupedRows.some((group) => group.key === expandedGroupKey);
    if (!stillExists) {
      setExpandedGroupKey(groupedRows[0].key);
    }
  }, [expandedGroupKey, groupedRows]);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'grid',
          gap: 8,
          alignItems: 'center',
          gridTemplateColumns: 'auto minmax(240px, 1fr) minmax(190px, 0.7fr) minmax(190px, 0.8fr) minmax(200px, 0.8fr) auto auto',
        }}
      >
        {props.canEdit ? (
          <Button
            onClick={async () => {
              const now = Date.now();
              const code = `NM-${String(now).slice(-8)}`;
              const created = await window.matrica.warehouse.nomenclatureUpsert({
                code,
                name: 'Новая номенклатура',
                itemType: 'material',
                isActive: true,
              });
              if (!created?.ok || !created.id) {
                setStatus(`Ошибка: ${String(!created?.ok && created ? created.error : 'не удалось создать')}`);
                return;
              }
              await refresh();
              props.onOpen(String(created.id));
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
      </div>
      {props.canEdit ? (
        <div style={{ border: '1px solid var(--border)', padding: 8, display: 'grid', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>Типы номенклатуры</div>
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
          <div style={{ fontWeight: 700, marginTop: 4 }}>Свойства номенклатуры</div>
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
          <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
            {propertiesRows.slice(0, 10).map((row) => `${row.code} (${row.dataType})`).join(', ') || 'Свойства не созданы'}
          </div>
          <div style={{ fontWeight: 700, marginTop: 4 }}>Шаблоны номенклатуры</div>
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 140px 140px', gap: 8 }}>
            <Input value={newTemplateCode} onChange={(e) => setNewTemplateCode(e.target.value)} placeholder="Код" />
            <Input value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} placeholder="Название" />
            <Input value={newTemplateItemType} onChange={(e) => setNewTemplateItemType(e.target.value)} placeholder="Код типа" />
            <Input value={newTemplateDirectoryKind} onChange={(e) => setNewTemplateDirectoryKind(e.target.value)} placeholder="Источник" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
            <Input
              value={newTemplatePropertiesJson}
              onChange={(e) => setNewTemplatePropertiesJson(e.target.value)}
              placeholder='JSON свойств шаблона, напр. [{"propertyId":"...","required":true}]'
            />
            <Button
              type="button"
              onClick={async () => {
                const up = await window.matrica.warehouse.nomenclatureTemplateUpsert({
                  code: newTemplateCode.trim().toLowerCase(),
                  name: newTemplateName.trim(),
                  itemTypeCode: newTemplateItemType.trim() || null,
                  directoryKind: newTemplateDirectoryKind.trim() || null,
                  propertiesJson: newTemplatePropertiesJson.trim() || '[]',
                });
                if (!up?.ok) {
                  setStatus(`Ошибка: ${String(up?.error ?? 'не удалось сохранить шаблон')}`);
                  return;
                }
                setNewTemplateCode('');
                setNewTemplateName('');
                setNewTemplateItemType('');
                setNewTemplateDirectoryKind('');
                setNewTemplatePropertiesJson('[]');
                await refreshGovernance();
              }}
            >
              Добавить шаблон
            </Button>
          </div>
          <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
            {templatesRows.slice(0, 10).map((row) => `${row.code} [${row.itemTypeCode || '*'} / ${row.directoryKind || '*'}]`).join(', ') || 'Шаблоны не созданы'}
          </div>
        </div>
      ) : null}

      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <WarehouseListPager
        pageSize={pageSize}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPageIndex(0);
        }}
        pageIndex={pageIndex}
        onPageIndexChange={setPageIndex}
        rowCount={sorted.length}
        hasMore={hasMore}
        disabled={status === 'Загрузка...'}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)', background: 'var(--surface)' }}>
        {groupedRows.length === 0 ? (
          <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 14 }}>Нет данных</div>
        ) : (
          groupedRows.map((group) => {
            const expanded = expandedGroupKey === group.key;
            return (
              <section key={group.key} style={{ borderBottom: '1px solid var(--border)' }}>
                <button
                  type="button"
                  onClick={() => setExpandedGroupKey((prev) => (prev === group.key ? null : group.key))}
                  style={{
                    width: '100%',
                    height: GROUP_HEADER_HEIGHT,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    position: 'sticky',
                    top: 0,
                    zIndex: 3,
                    border: 'none',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--surface-2)',
                    color: 'var(--text)',
                    fontWeight: 700,
                    fontSize: 13,
                    textAlign: 'left',
                    cursor: 'pointer',
                    padding: '0 10px',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.label}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--subtle)', flexShrink: 0 }}>
                    <span>{group.rows.length}</span>
                    <span style={{ fontSize: 14 }}>{expanded ? '▾' : '▸'}</span>
                  </span>
                </button>
                {expanded ? (
                  <table className="list-table">
                    <thead>
                      <tr>
                        <th
                          style={{ textAlign: 'left', cursor: 'pointer', minWidth: 220, top: GROUP_HEADER_HEIGHT }}
                          onClick={() => onSort('name')}
                        >
                          {sortLabel('Наименование', 'name')}
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
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row) => (
                        <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(String(row.id))}>
                          <td style={{ wordBreak: 'break-word' }}>{row.name || '—'}</td>
                          <td>{itemTypeLabel(row.itemType)}</td>
                          <td>{row.groupName || '—'}</td>
                          <td>{row.unitName || '—'}</td>
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
  );
}
