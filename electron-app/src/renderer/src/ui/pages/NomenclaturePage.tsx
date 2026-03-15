import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { NomenclatureItemType, WarehouseNomenclatureListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { lookupToSelectOptions, WAREHOUSE_ITEM_TYPE_OPTIONS } from '../utils/warehouseUi.js';

export function NomenclaturePage(props: {
  onOpen: (id: string) => void;
  canEdit: boolean;
}) {
  const { lookups, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData();
  const [rows, setRows] = useState<WarehouseNomenclatureListItem[]>([]);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [itemType, setItemType] = useState<NomenclatureItemType | ''>('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('active');

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка...');
      const result = await window.matrica.warehouse.nomenclatureList({
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(itemType ? { itemType } : {}),
        ...(groupId ? { groupId } : {}),
        ...(activeFilter === 'active' ? { isActive: true } : {}),
        ...(activeFilter === 'inactive' ? { isActive: false } : {}),
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setRows((result.rows ?? []) as WarehouseNomenclatureListItem[]);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [activeFilter, groupId, itemType, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const byName = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      if (byName !== 0) return byName;
      return String(a.code ?? '').localeCompare(String(b.code ?? ''), 'ru');
    });
  }, [rows]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'grid',
          gap: 8,
          alignItems: 'center',
          gridTemplateColumns: 'auto minmax(260px, 1.2fr) minmax(220px, 0.8fr) minmax(220px, 0.9fr) auto auto auto',
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

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Код</th>
              <th style={{ textAlign: 'left' }}>Наименование</th>
              <th style={{ textAlign: 'left' }}>Тип</th>
              <th style={{ textAlign: 'left' }}>Группа</th>
              <th style={{ textAlign: 'left' }}>Ед.</th>
              <th style={{ textAlign: 'left' }}>Склад по умолчанию</th>
              <th style={{ textAlign: 'left' }}>Штрихкод</th>
              <th style={{ textAlign: 'left' }}>Статус</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 14 }}>
                  Нет данных
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(String(row.id))}>
                  <td>{row.code || '—'}</td>
                  <td>{row.name || '—'}</td>
                  <td>{WAREHOUSE_ITEM_TYPE_OPTIONS.find((item) => item.id === row.itemType)?.label ?? String(row.itemType ?? '—')}</td>
                  <td>{row.groupName || '—'}</td>
                  <td>{row.unitName || '—'}</td>
                  <td>{row.defaultWarehouseName || '—'}</td>
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
