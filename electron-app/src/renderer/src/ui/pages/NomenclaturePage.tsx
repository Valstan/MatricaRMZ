import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { NomenclatureItemType, WarehouseNomenclatureListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { lookupToSelectOptions, WAREHOUSE_ITEM_TYPE_OPTIONS } from '../utils/warehouseUi.js';

type SortKey =
  | 'code'
  | 'sku'
  | 'name'
  | 'itemType'
  | 'category'
  | 'group'
  | 'unit'
  | 'warehouse'
  | 'brand'
  | 'serial'
  | 'barcode'
  | 'status';

export function NomenclaturePage(props: {
  onOpen: (id: string) => void;
  canEdit: boolean;
}) {
  const { lookups, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData();
  const [rows, setRows] = useState<WarehouseNomenclatureListItem[]>([]);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [itemType, setItemType] = useState<NomenclatureItemType | ''>('');
  const [directoryKind, setDirectoryKind] = useState<string>('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    setPageIndex(0);
  }, [activeFilter, directoryKind, groupId, itemType, query]);

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
        ...(activeFilter === 'active' ? { isActive: true } : {}),
        ...(activeFilter === 'inactive' ? { isActive: false } : {}),
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
  }, [activeFilter, directoryKind, groupId, itemType, pageIndex, pageSize, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'code') cmp = String(a.code ?? '').localeCompare(String(b.code ?? ''), 'ru');
      else if (sortKey === 'sku') cmp = String(a.sku ?? '').localeCompare(String(b.sku ?? ''), 'ru');
      else if (sortKey === 'name') cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      else if (sortKey === 'itemType') cmp = String(a.itemType ?? '').localeCompare(String(b.itemType ?? ''), 'ru');
      else if (sortKey === 'category') cmp = String(a.category ?? '').localeCompare(String(b.category ?? ''), 'ru');
      else if (sortKey === 'group') cmp = String(a.groupName ?? '').localeCompare(String(b.groupName ?? ''), 'ru');
      else if (sortKey === 'unit') cmp = String(a.unitName ?? '').localeCompare(String(b.unitName ?? ''), 'ru');
      else if (sortKey === 'warehouse') cmp = String(a.defaultWarehouseName ?? '').localeCompare(String(b.defaultWarehouseName ?? ''), 'ru');
      else if (sortKey === 'brand') cmp = String(a.defaultBrandName ?? '').localeCompare(String(b.defaultBrandName ?? ''), 'ru');
      else if (sortKey === 'serial') cmp = Number(a.isSerialTracked ? 1 : 0) - Number(b.isSerialTracked ? 1 : 0);
      else if (sortKey === 'barcode') cmp = String(a.barcode ?? '').localeCompare(String(b.barcode ?? ''), 'ru');
      else if (sortKey === 'status') cmp = Number(a.isActive === false ? 0 : 1) - Number(b.isActive === false ? 0 : 1);
      if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      return cmp * dir;
    });
  }, [rows, sortDir, sortKey]);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'grid',
          gap: 8,
          alignItems: 'center',
          gridTemplateColumns: 'auto minmax(240px, 1fr) minmax(190px, 0.7fr) minmax(190px, 0.8fr) minmax(200px, 0.8fr) auto auto auto',
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
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по коду, наименованию, штрихкоду..." />
        <select value={itemType} onChange={(e) => setItemType((e.target.value || '') as NomenclatureItemType | '')} style={{ minWidth: 180, padding: '8px 10px' }}>
          {WAREHOUSE_ITEM_TYPE_OPTIONS.map((item) => (
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
        <select value={activeFilter} onChange={(e) => setActiveFilter(e.target.value as 'all' | 'active' | 'inactive')} style={{ padding: '8px 10px' }}>
          <option value="active">Только активные</option>
          <option value="all">Все</option>
          <option value="inactive">Только неактивные</option>
        </select>
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
        <Button variant="ghost" onClick={() => void refreshRefs()}>
          Справочники
        </Button>
      </div>

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

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('code')}>{sortLabel('Код', 'code')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('sku')}>{sortLabel('SKU', 'sku')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>{sortLabel('Наименование', 'name')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('itemType')}>{sortLabel('Тип', 'itemType')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('category')}>{sortLabel('Категория', 'category')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('group')}>{sortLabel('Группа', 'group')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('unit')}>{sortLabel('Ед.', 'unit')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('warehouse')}>{sortLabel('Склад по умолчанию', 'warehouse')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('brand')}>{sortLabel('Марка по умолч.', 'brand')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('serial')}>{sortLabel('Серийный учет', 'serial')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('barcode')}>{sortLabel('Штрихкод', 'barcode')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('status')}>{sortLabel('Статус', 'status')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={12} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 14 }}>
                  Нет данных
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(String(row.id))}>
                  <td>{row.code || '—'}</td>
                  <td>{row.sku || row.code || '—'}</td>
                  <td>{row.name || '—'}</td>
                  <td>{WAREHOUSE_ITEM_TYPE_OPTIONS.find((item) => item.id === row.itemType)?.label ?? String(row.itemType ?? '—')}</td>
                  <td>{row.category || '—'}</td>
                  <td>{row.groupName || '—'}</td>
                  <td>{row.unitName || '—'}</td>
                  <td>{row.defaultWarehouseName || '—'}</td>
                  <td>{row.defaultBrandName || '—'}</td>
                  <td>{row.isSerialTracked ? 'Да' : 'Нет'}</td>
                  <td>{row.barcode || '—'}</td>
                  <td>{row.isActive === false ? 'Неактивна' : 'Активна'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
